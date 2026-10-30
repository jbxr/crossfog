// Crossfog rules engine. Pure: no DOM, no network, no clock.
// Game state is never stored; it is rebuilt by replaying the ordered event log.
// Every client replays the same log in the same order (server id order), so
// every client derives the same board. Invalid events (not enough coins, a
// locked cell, a stale group pick) are ignored during replay, the same way on
// every client.

export const META_ID = 'meta';
export const START_COINS = 6;
export const COST = { letter: 4, word: 10, clue: 5, mistake: 2, pattern: 3, pair: 5, keyletter: 8 };
export const PAY = { word: 1, group: 3, key: 2 };

export function rng(seed) {
  let a = 0;
  for (const ch of seed) a = (a * 31 + ch.charCodeAt(0)) | 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Static lookups derived once from board.json. */
export function buildBoard(DATA) {
  const REG = {}; DATA.regions.forEach(r => { REG[r.id] = r; });
  const GROUPS = {}, SECTION_GROUPS = {};
  DATA.groups.forEach(g => { GROUPS[g.id] = g; (SECTION_GROUPS[g.region] ||= []).push(g.id); });
  const SECTIONS = DATA.regions.filter(r => r.id !== META_ID).map(r => r.id);
  const CELLS = {};
  const WORDS = DATA.words.map((w, i) => {
    const dr = w.dir === 'A' ? 0 : 1, dc = w.dir === 'A' ? 1 : 0, cells = [];
    for (let k = 0; k < w.answer.length; k++) {
      const r = w.r + dr * k, c = w.c + dc * k, key = r + ',' + c;
      if (!CELLS[key]) CELLS[key] = { r, c, key, ch: w.answer[k], words: [] };
      CELLS[key].words.push(i);
      cells.push(key);
    }
    const meta = w.region === META_ID;
    return { ...w, id: i, cells, meta, gid: meta ? w.gid : `${w.region}-${w.group}`, label: (meta ? 'Key ' : '') + w.num + (w.dir === 'A' ? ' Across' : ' Down') };
  });
  const KEY_WORD = {}; WORDS.forEach(w => { if (w.meta) KEY_WORD[w.gid] = w.id; });
  const ORDER = WORDS.slice().sort((a, b) => (a.meta - b.meta) || a.num - b.num || (a.dir < b.dir ? -1 : 1)).map(w => w.id);
  const REGION_WORDS = {}, REGION_CELLS = {};
  WORDS.forEach(w => {
    (REGION_WORDS[w.region] ||= []).push(w.id);
    const s = (REGION_CELLS[w.region] ||= new Set());
    w.cells.forEach(k => s.add(k));
  });
  // a fixed, shuffled tile order per section so every player sees the same tray
  const TRAY_ORDER = {};
  SECTIONS.forEach(r => {
    const rnd = rng('tray' + r);
    TRAY_ORDER[r] = REGION_WORDS[r].map(wi => [rnd(), wi]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  });
  const id = `${WORDS.length}:${DATA.width}x${DATA.height}`;
  return { id, DATA, REG, GROUPS, SECTION_GROUPS, SECTIONS, CELLS, WORDS, KEY_WORD, ORDER, REGION_WORDS, REGION_CELLS, TRAY_ORDER };
}

export function initialState(B) {
  return {
    fills: {}, hinted: {},
    solved: new Set(), solvedBy: {},
    revealed: new Set([B.DATA.seedRegion, META_ID]),
    found: [], foundSet: new Set(),
    clueBought: new Set(),
    ladder: {},
    coins: START_COINS, mistakes: 0, hints: 0, spent: 0,
    by: {}, done: false, firstAt: null, lastAt: null, doneAt: null,
    feed: [],
  };
}

/** Read-only questions about one state. */
export function queries(B, S) {
  const { CELLS, WORDS, REG, GROUPS, SECTION_GROUPS, KEY_WORD, REGION_WORDS, TRAY_ORDER } = B;
  const isRev = r => S.revealed.has(r);
  const wordVis = wi => isRev(WORDS[wi].region);
  const cellVis = k => CELLS[k].words.some(wordVis);
  const isSolved = wi => S.solved.has(wi);
  const locked = k => !!S.hinted[k] || CELLS[k].words.some(isSolved);
  const parentOf = r => REG[r].parent;
  const groupFound = gid => S.foundSet.has(gid);
  const foundIn = r => (SECTION_GROUPS[r] || []).filter(groupFound).length;
  const sectionDone = r => foundIn(r) === 4;
  const regionOpen = r => r === META_ID || (isRev(r) && (!parentOf(r) || sectionDone(parentOf(r))));
  const playable = wi => wi !== undefined && wi !== null && (WORDS[wi].meta ? groupFound(WORDS[wi].gid) : regionOpen(WORDS[wi].region));
  const keysNamed = () => WORDS.filter(w => w.meta && isSolved(w.id)).length;
  const loose = r => REGION_WORDS[r].filter(wi => isSolved(wi) && !groupFound(WORDS[wi].gid));
  const ladderOf = r => S.ladder[r] || { pattern: false, pairs: [], letters: [] };
  const pairCandidate = r => {
    const L = ladderOf(r);
    for (const gid of SECTION_GROUPS[r]) {
      if (groupFound(gid) || L.pairs.some(p => p.gid === gid)) continue;
      const sol = TRAY_ORDER[r].filter(wi => WORDS[wi].gid === gid && isSolved(wi));
      if (sol.length >= 2) return { gid, w: sol.slice(0, 2) };
    }
    return null;
  };
  const letterCandidate = r => {
    const L = ladderOf(r);
    const p = L.pairs.find(p => !groupFound(p.gid) && !L.letters.includes(p.gid) && WORDS[KEY_WORD[p.gid]].cells.some(k => !locked(k)));
    return p ? p.gid : null;
  };
  const keyPattern = gid => WORDS[KEY_WORD[gid]].cells.map(k => locked(k) && S.fills[k] ? S.fills[k].ch : '_').join(' ');
  const clueOf = wi => {
    const w = WORDS[wi];
    if (!w.meta) return w.clue;
    const g = GROUPS[w.gid];
    const bought = S.clueBought.has(w.gid) ? `“${g.hint}”` : '';
    if (groupFound(w.gid)) return g.members.join(' · ') + (bought ? `  ${bought}` : '');
    return bought ? `${bought} (a group in ${REG[g.region].name})` : `A group in ${REG[g.region].name}, not found yet`;
  };
  return { isRev, wordVis, cellVis, isSolved, locked, parentOf, groupFound, foundIn, sectionDone, regionOpen, playable, keysNamed, loose, ladderOf, pairCandidate, letterCandidate, keyPattern, clueOf };
}

/**
 * Apply one event. Mutates S (replay builds a fresh S each time).
 * ev = { key, id, uid, at, t, ...payload }
 *   t: 'fill' {k, ch} | 'erase' {k} | 'group' {picks:[4 word ids]}
 *      'buy' {what:'letter', k} | {what:'word', wi} | {what:'clue', gid}
 *            {what:'pattern'|'pair'|'keyletter', sec}
 * Notable results are pushed to S.feed for the UI to turn into sounds and toasts.
 */
export function apply(B, S, ev) {
  const { CELLS, WORDS, GROUPS, SECTION_GROUPS, KEY_WORD, REGION_WORDS, REG } = B;
  const q = queries(B, S);
  const src = { key: ev.key, eid: ev.id ?? null, uid: ev.uid, at: ev.at };
  const note = (kind, data = {}) => S.feed.push({ ...src, n: S.feed.length, kind, ...data });
  if (S.done) return;
  S.firstAt ||= ev.at; S.lastAt = ev.at;

  const touching = wi => {
    const out = [];
    WORDS[wi].cells.forEach(k => CELLS[k].words.forEach(x => {
      const r = WORDS[x].region;
      if (!q.isRev(r) && !out.includes(r)) out.push(r);
    }));
    return out;
  };
  const solve = wi => {
    const w = WORDS[wi];
    const pay = w.meta ? PAY.key : PAY.word;
    S.solved.add(wi); S.solvedBy[wi] = ev.uid; S.coins += pay;
    S.by[ev.uid] = (S.by[ev.uid] || 0) + 1;
    note('solve', { wi, pay });
    if (!w.meta) touching(wi).forEach(r => { S.revealed.add(r); note('reveal', { region: r, open: q.regionOpen(r) }); });
    if (w.meta && q.keysNamed() === B.DATA.groups.length) { S.done = true; S.doneAt = ev.at; note('win'); }
  };
  const check = keys => {
    const ws = new Set();
    keys.forEach(k => CELLS[k].words.forEach(wi => { if (q.playable(wi) && !q.isSolved(wi)) ws.add(wi); }));
    ws.forEach(wi => {
      if (q.isSolved(wi)) return;
      const w = WORDS[wi];
      if (!w.cells.every(k => S.fills[k])) return;
      if (w.cells.every(k => S.fills[k].ch === CELLS[k].ch)) solve(wi);
      else note('wrong', { wi });
    });
  };
  const findGroup = (gid, auto) => {
    const g = GROUPS[gid], r = g.region;
    S.found.push(gid); S.foundSet.add(gid); S.coins += PAY.group;
    note('group', { gid, auto });
    check(WORDS[KEY_WORD[gid]].cells);
    const left = SECTION_GROUPS[r].filter(x => !q.groupFound(x));
    if (left.length === 1) { findGroup(left[0], true); return; }
    if (q.sectionDone(r)) {
      note('sectionDone', { region: r });
      [...S.revealed].filter(x => REG[x].parent === r).forEach(x => note('open', { region: x }));
    }
  };
  const inPlayableWord = k => CELLS[k].words.some(wi => q.wordVis(wi) && q.playable(wi));
  const pay = cost => {
    if (S.coins < cost) { note('reject', { reason: 'coins', cost }); return false; }
    S.coins -= cost; S.spent += cost; S.hints++;
    return true;
  };

  switch (ev.t) {
    case 'fill': {
      const k = ev.k, ch = String(ev.ch || '').toUpperCase();
      if (!CELLS[k] || !/^[A-Z]$/.test(ch) || q.locked(k) || !inPlayableWord(k)) return;
      S.fills[k] = { ch, by: ev.uid };
      check([k]);
      return;
    }
    case 'erase': {
      if (CELLS[ev.k] && !q.locked(ev.k)) delete S.fills[ev.k];
      return;
    }
    case 'group': {
      const picks = Array.isArray(ev.picks) ? [...new Set(ev.picks.map(Number))] : [];
      if (picks.length !== 4 || picks.some(wi => !WORDS[wi] || WORDS[wi].meta || !q.isSolved(wi) || q.groupFound(WORDS[wi].gid))) return;
      const r = WORDS[picks[0]].region;
      if (picks.some(wi => WORDS[wi].region !== r) || !q.regionOpen(r)) return;
      const counts = {};
      picks.forEach(wi => { counts[WORDS[wi].gid] = (counts[WORDS[wi].gid] || 0) + 1; });
      const best = Math.max(...Object.values(counts));
      if (best === 4) { findGroup(WORDS[picks[0]].gid, false); return; }
      const fine = Math.min(COST.mistake, S.coins);
      S.coins -= fine; S.mistakes++;
      note('miss', { oneAway: best === 3, fine, picks });
      return;
    }
    case 'buy': {
      const what = ev.what;
      if (what === 'letter') {
        const k = ev.k;
        if (!CELLS[k] || q.locked(k) || !inPlayableWord(k)) return;
        if (!pay(COST.letter)) return;
        S.fills[k] = { ch: CELLS[k].ch, by: ev.uid }; S.hinted[k] = true;
        note('buy', { what, cost: COST.letter });
        check([k]);
      } else if (what === 'word') {
        const wi = Number(ev.wi), w = WORDS[wi];
        if (!w || !q.playable(wi) || q.isSolved(wi)) return;
        const keys = w.cells.filter(k => !q.locked(k));
        if (!keys.length || !pay(COST.word)) return;
        keys.forEach(k => { S.fills[k] = { ch: CELLS[k].ch, by: ev.uid }; S.hinted[k] = true; });
        note('buy', { what, cost: COST.word });
        check(keys);
      } else if (what === 'clue') {
        const gid = ev.gid;
        if (!GROUPS[gid] || q.groupFound(gid) || S.clueBought.has(gid)) return;
        if (!pay(COST.clue)) return;
        S.clueBought.add(gid);
        note('buy', { what, cost: COST.clue, gid });
      } else if (what === 'pattern' || what === 'pair' || what === 'keyletter') {
        const r = ev.sec;
        if (!SECTION_GROUPS[r] || !q.regionOpen(r)) return;
        const L = (S.ladder[r] ||= { pattern: false, pairs: [], letters: [] });
        if (what === 'pattern') {
          if (L.pattern || !pay(COST.pattern)) return;
          L.pattern = true;
        } else if (what === 'pair') {
          const c = L.pattern && q.pairCandidate(r);
          if (!c || !pay(COST.pair)) return;
          L.pairs.push(c);
        } else {
          const gid = q.letterCandidate(r);
          if (!gid || !pay(COST.keyletter)) return;
          L.letters.push(gid);
          const k = WORDS[KEY_WORD[gid]].cells.find(x => !q.locked(x));
          S.fills[k] = { ch: CELLS[k].ch, by: ev.uid }; S.hinted[k] = true;
        }
        note('buy', { what, cost: COST[what], sec: r });
      }
      return;
    }
    default:
      return;
  }
}

/** A copy that apply() can mutate without touching the original. */
export function cloneState(S) {
  return {
    ...S,
    fills: { ...S.fills }, hinted: { ...S.hinted },
    solved: new Set(S.solved), solvedBy: { ...S.solvedBy },
    revealed: new Set(S.revealed),
    found: [...S.found], foundSet: new Set(S.foundSet),
    clueBought: new Set(S.clueBought),
    ladder: JSON.parse(JSON.stringify(S.ladder)),
    by: { ...S.by }, feed: [...S.feed],
  };
}

export function replay(B, events) {
  const S = initialState(B);
  for (const ev of events) apply(B, S, ev);
  return S;
}
