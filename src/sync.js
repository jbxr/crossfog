// Where the event log lives. Every adapter has the same shape:
//   me                       { id, name }
//   game                     { id, code } (code is null for solo)
//   players                  Map uid -> { name, seat, avatar }
//   load()                   -> events in server order
//   send(ev)                 -> { id, at } once stored
//   subscribe(onEvents, onPlayers)
//   catchUp(afterId)         -> events newer than afterId (after a phone sleeps)
//   setAvatar(emoji)
// Events on the wire: { id, key, uid, at, t, ...payload }.

const toEvent = row => ({ id: row.id, key: row.client_id, uid: row.user_id, at: row.created_at, t: row.kind, ...row.payload });
const payloadOf = ev => { const { id, key, uid, at, t, ...p } = ev; return p; };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
}));
export { uuid };

const store = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
};

/* ---------------- Supabase ---------------- */

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
let clientPromise = null;

async function client(cfg) {
  if (!clientPromise) {
    clientPromise = import(SUPABASE_JS).then(({ createClient }) => createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'crossfog-auth' },
      realtime: { params: { eventsPerSecond: 20 } },
    }));
  }
  return clientPromise;
}

async function session(sb) {
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session.user;
  const { data: d, error } = await sb.auth.signInAnonymously();
  if (error) throw new Error(error.message.includes('Anonymous') ? 'Anonymous sign-ins are turned off in Supabase.' : error.message);
  return d.user;
}

const friendly = e => {
  const m = (e && (e.message || e.details)) || String(e);
  if (/full/i.test(m)) return 'That game already has four players.';
  if (/No game/i.test(m)) return 'No game has that code. Check the letters and try again.';
  if (/name required/i.test(m)) return 'Enter a name first.';
  if (/Failed to fetch|NetworkError|network/i.test(m)) return 'Can’t reach the game server. Check your connection.';
  return m;
};

export async function sharedGame(cfg, { code, name, boardId, create }) {
  const sb = await client(cfg);
  const user = await session(sb);
  let g;
  try {
    const { data, error } = create
      ? await sb.rpc('create_game', { p_board: boardId, p_name: name })
      : await sb.rpc('join_game', { p_code: code, p_name: name || '' });
    if (error) throw error;
    g = data;
  } catch (e) { throw new Error(friendly(e)); }

  const players = new Map();
  const loadPlayers = async () => {
    const { data, error } = await sb.from('players').select('user_id,name,seat,avatar').eq('game_id', g.id);
    if (error) throw new Error(friendly(error));
    players.clear();
    data.forEach(p => players.set(p.user_id, { name: p.name, seat: p.seat, avatar: p.avatar }));
  };
  await loadPlayers();
  const me = { id: user.id, name: players.get(user.id)?.name || name };

  const fetchFrom = async afterId => {
    const out = [];
    for (;;) {
      const { data, error } = await sb.from('events').select('*').eq('game_id', g.id)
        .gt('id', out.length ? out[out.length - 1].id : afterId).order('id').limit(1000);
      if (error) throw new Error(friendly(error));
      out.push(...data.map(toEvent));
      if (data.length < 1000) return out;
    }
  };

  // inserts go one at a time so a player's own moves keep their order
  // Moves queue up and go out in order, batched: one request carries every
  // move typed while the previous request was in flight, so fast typing
  // reaches teammates in a few round trips instead of one per letter.
  const queue = [];
  let flushing = false;
  const flush = async () => {
    if (flushing) return;
    flushing = true;
    while (queue.length) {
      const batch = queue.splice(0, 50);
      try {
        const { data, error } = await sb.from('events')
          .insert(batch.map(({ ev }) => ({ game_id: g.id, client_id: ev.key, kind: ev.t, payload: payloadOf(ev) })))
          .select('id,created_at,client_id');
        if (error) throw new Error(friendly(error));
        const byKey = new Map(data.map(r => [r.client_id, r]));
        batch.forEach(({ ev, resolve, reject }) => {
          const r = byKey.get(ev.key);
          r ? resolve({ id: r.id, at: r.created_at }) : reject(new Error('That move didn’t save. Check your connection.'));
        });
      } catch (e) {
        batch.forEach(({ reject }) => reject(e));
      }
    }
    flushing = false;
  };
  const send = ev => new Promise((resolve, reject) => { queue.push({ ev, resolve, reject }); flush(); });

  let channel = null;
  return {
    mode: 'shared', me, players,
    game: { id: g.id, code: g.code },
    load: () => fetchFrom(0),
    catchUp: afterId => fetchFrom(afterId),
    send,
    subscribe(onEvents, onPlayers) {
      channel = sb.channel('game:' + g.id)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events', filter: `game_id=eq.${g.id}` },
          payload => onEvents([toEvent(payload.new)]))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `game_id=eq.${g.id}` },
          async () => { await loadPlayers(); onPlayers(); })
        .subscribe(status => { if (status === 'SUBSCRIBED') onPlayers(); });
      return () => channel && sb.removeChannel(channel);
    },
    async setAvatar(avatar) {
      const { error } = await sb.from('players').update({ avatar }).eq('game_id', g.id).eq('user_id', me.id);
      if (error) throw new Error(friendly(error));
      players.get(me.id).avatar = avatar;
    },
  };
}

/* ---------------- Solo, on this device ---------------- */

export function soloGame(boardId) {
  const key = 'crossfog.solo.' + boardId;
  const meta = store.get('crossfog.meta.v1') || {};
  const me = { id: 'me', name: 'You' };
  const players = new Map([['me', { name: 'You', seat: 0, avatar: meta.soloAvatar || null }]]);
  const read = () => store.get(key) || [];
  return {
    mode: 'solo', me, players, game: { id: 'solo', code: null },
    load: async () => read(),
    catchUp: async afterId => read().filter(e => e.id > afterId),
    async send(ev) {
      const log = read();
      const stored = { ...ev, id: (log.length ? log[log.length - 1].id : 0) + 1, at: new Date().toISOString() };
      log.push(stored); store.set(key, log);
      return { id: stored.id, at: stored.at };
    },
    subscribe() { return () => {}; },
    async setAvatar(avatar) { players.get('me').avatar = avatar; const m = store.get('crossfog.meta.v1') || {}; m.soloAvatar = avatar; store.set('crossfog.meta.v1', m); },
    reset() { store.set(key, []); },
  };
}

/* ---------------- Fake shared server for testing in two tabs ---------------- */
// ?fake=1 : the "server" is localStorage, and the storage event plays realtime.
// Each tab gets its own player id through sessionStorage.

export function fakeSharedGame({ code, name, boardId, create }) {
  let uid = sessionStorage.getItem('crossfog.fake.uid');
  if (!uid) { uid = uuid(); sessionStorage.setItem('crossfog.fake.uid', uid); }
  if (create) code = Math.random().toString(36).slice(2, 8).toUpperCase();
  code = String(code || '').toUpperCase();
  const gk = 'crossfog.fake.game.' + code;
  let g = store.get(gk);
  if (!g) {
    if (!create) throw new Error('No game has that code. Check the letters and try again.');
    g = { id: 'fake-' + code, code, board: boardId, players: {}, events: [] };
  }
  if (!g.players[uid]) {
    if (!name) throw new Error('Enter a name first.');
    const seats = Object.values(g.players).map(p => p.seat);
    const seat = [0, 1, 2, 3].find(s => !seats.includes(s));
    if (seat === undefined) throw new Error('That game already has four players.');
    g.players[uid] = { name, seat, avatar: null };
  }
  store.set(gk, g);
  const players = new Map();
  const syncPlayers = () => { players.clear(); Object.entries(store.get(gk).players).forEach(([id, p]) => players.set(id, p)); };
  syncPlayers();
  let lastSeen = 0;
  return {
    mode: 'shared', me: { id: uid, name: g.players[uid].name }, players, game: { id: g.id, code },
    load: async () => store.get(gk).events,
    catchUp: async afterId => store.get(gk).events.filter(e => e.id > afterId),
    async send(ev) {
      const cur = store.get(gk);
      const stored = { ...ev, id: (cur.events.length ? cur.events[cur.events.length - 1].id : 0) + 1, at: new Date().toISOString() };
      cur.events.push(stored); store.set(gk, cur);
      return { id: stored.id, at: stored.at };
    },
    subscribe(onEvents, onPlayers) {
      const h = e => {
        if (e.key !== gk) return;
        const cur = store.get(gk);
        syncPlayers(); onPlayers();
        const fresh = cur.events.filter(x => x.id > lastSeen);
        if (fresh.length) { lastSeen = fresh[fresh.length - 1].id; onEvents(fresh); }
      };
      window.addEventListener('storage', h);
      return () => window.removeEventListener('storage', h);
    },
    async setAvatar(avatar) { const cur = store.get(gk); cur.players[uid].avatar = avatar; store.set(gk, cur); syncPlayers(); },
  };
}
