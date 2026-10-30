// Crossfog UI. Reads derived state from the engine, turns taps into events,
// and turns the engine's feed into sounds, toasts and animations.
import { buildBoard, initialState, apply, cloneState, queries, COST, PAY, META_ID, rng } from './engine.js';
import { sharedGame, soloGame, fakeSharedGame, uuid } from './sync.js';
import { makeSfx } from './sfx.js';
import CONFIG from '../config.js';

const PAD = 2;
const STEP = 55; // ms between letters in the solve arpeggio and tile pops
const $ = id => document.getElementById(id);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const params = new URLSearchParams(location.search);
const FAKE = params.get('fake') === '1';
const SHARED_READY = FAKE || !!(CONFIG.url && CONFIG.key);

const store = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
};

/* ---------- cosmetics that live on this device ---------- */
const UNLOCKS = [
  { id: 'font-type', name: 'Typewriter letters', need: 'Find 4 groups', stat: 'groups', goal: 4 },
  { id: 'av-critters', name: 'Critter avatars', need: 'Solve 15 clues', stat: 'words', goal: 15 },
  { id: 'font-hand', name: 'Handwritten letters', need: 'Find 10 groups', stat: 'groups', goal: 10 },
  { id: 'av-snacks', name: 'Snack avatars', need: 'Solve 40 clues', stat: 'words', goal: 40 },
  { id: 'tiles-gold', name: 'Gold tiles', need: 'Complete a Key Grid', stat: 'boards', goal: 1 },
];
const FONTS = {
  classic: { name: 'Classic', css: 'var(--f-body)' },
  type: { name: 'Typewriter', css: '"Special Elite", "Courier New", monospace', unlock: 'font-type' },
  hand: { name: 'Handwritten', css: '"Caveat", "Segoe Print", cursive', unlock: 'font-hand' },
};
const TILESETS = { classic: { name: 'Classic' }, gold: { name: 'Gold', unlock: 'tiles-gold' } };
const AVATARS = { critters: { unlock: 'av-critters', list: ['🦊', '🐢', '🦉', '🐝', '🐸', '🦔'] }, snacks: { unlock: 'av-snacks', list: ['🍩', '🥨', '🍓', '🧀', '🌮', '🍙'] } };
const freshMeta = () => ({ unlocked: [], font: 'classic', tiles: 'classic', sound: true, coached: false, games: {} });
let M = Object.assign(freshMeta(), store.get('crossfog.meta.v2') || {});
const saveMeta = () => store.set('crossfog.meta.v2', M);
const SFX = makeSfx(() => M.sound !== false, STEP);

/* ---------- game state ---------- */
let B, net = null, S, q;
let confirmed = [], pending = [];
const seen = new Set();
let unsubscribe = null;
const ui = { cell: null, dir: 'A', cs: 36, tab: 'groups', gsec: null, sel: new Set(), shake: false, flash: { bad: new Set(), pop: new Map() }, arrive: {}, fogFade: {}, armed: null };

const W = () => B.WORDS;
const nameOf = uid => net?.players.get(uid)?.name || 'A teammate';
const seatOf = uid => net?.players.get(uid)?.seat ?? 0;
const isMe = uid => uid === net?.me.id;
const fid = f => `${f.key}:${f.kind}:${f.wi ?? f.gid ?? f.region ?? ''}`;

// The confirmed part of the log only ever grows at the end (except in the rare
// case two moves arrive out of order), so its state is kept and extended
// rather than replayed from scratch on every keystroke. Pending moves, the
// ones still on their way to the server, go on a cheap copy.
let base = null, baseN = 0, feedSeenN = 0, lastSeenSaved = 0;
const confirmedIds = new Set();
function currentState() {
  if (!base || baseN > confirmed.length) { base = initialState(B); baseN = 0; }
  for (; baseN < confirmed.length; baseN++) apply(B, base, confirmed[baseN]);
  if (!pending.length) return base;
  const s = cloneState(base);
  for (const ev of pending) apply(B, s, ev);
  return s;
}
function recompute(initial = false) {
  S = currentState();
  q = queries(B, S);
  const fresh = [];
  for (let i = initial ? S.feed.length : 0; i < S.feed.length; i++) {
    const f = S.feed[i], id = fid(f);
    if (!seen.has(id)) { seen.add(id); fresh.push(f); }
  }
  if (initial) S.feed.forEach(f => seen.add(fid(f)));
  if (fresh.length) effects(fresh);
  if (fresh.length || initial) { trackStats(initial); nudge(initial); }
  const last = confirmed.length ? confirmed[confirmed.length - 1].id : 0;
  if (document.visibilityState === 'visible' && last !== lastSeenSaved) { lastSeenSaved = last; store.set('crossfog.seen.' + net.game.id, last); }
  scheduleRender();
}
function addConfirmed(ev) {
  if (confirmedIds.has(ev.id)) return false;
  confirmedIds.add(ev.id);
  confirmed.push(ev);
  if (confirmed.length > 1 && confirmed[confirmed.length - 2].id > ev.id) {
    confirmed.sort((a, b) => a.id - b.id);
    base = null; // out of order: rebuild once from the top
  }
  return true;
}
function dispatch(t, payload) {
  if (!net || S.done) return;
  const ev = { key: uuid(), uid: net.me.id, at: new Date().toISOString(), t, ...payload };
  pending.push(ev);
  recompute();
  net.send(ev).then(({ id, at }) => {
    pending = pending.filter(p => p.key !== ev.key);
    addConfirmed({ ...ev, id, at });
    recompute();
  }).catch(err => {
    pending = pending.filter(p => p.key !== ev.key);
    toast(err.message || 'That move didn’t save. Check your connection.');
    recompute();
  });
}
function onRemote(evs) {
  let changed = false;
  evs.forEach(e => {
    // our own moves echo back over realtime; they're already confirmed
    if (confirmedIds.has(e.id)) return;
    pending = pending.filter(p => p.key !== e.key);
    changed = addConfirmed(e) || changed;
  });
  if (changed) recompute();
}

/* ---------- feed → sounds, toasts, animation ---------- */
function effects(list) {
  let t = 0;
  for (const f of list) {
    const mine = isMe(f.uid), who = mine ? '' : `${esc(nameOf(f.uid))}: `;
    switch (f.kind) {
      case 'solve': {
        const w = W()[f.wi], root = B.REG[w.region].root;
        w.cells.forEach((k, i) => ui.flash.pop.set(k, Math.round(t * 1000) + i * STEP));
        toast(`${who}${w.answer}${w.meta ? ' named' : ''} <span class="coin"></span>+${f.pay}`);
        SFX.play('solve', root, w.answer.length, t);
        t += Math.max(3, w.answer.length) * STEP / 1000;
        SFX.play('coin', t);
        if (w.meta) { SFX.play('clear', root, t + .15); t += .8; }
        break;
      }
      case 'wrong':
        if (mine) { W()[f.wi].cells.forEach(k => ui.flash.bad.add(k)); SFX.play('wrong', t); }
        break;
      case 'reveal':
        ui.arrive[f.region] = true; ui.fogFade[f.region] = performance.now();
        SFX.play('fog', t + .1); t += .7;
        toast(f.open ? `The fog lifts: ${B.REG[f.region].name}` : `Spotted ${B.REG[f.region].name}. It opens when ${B.REG[B.REG[f.region].parent].name}'s four groups are found`, 'reveal');
        break;
      case 'group': {
        const g = B.GROUPS[f.gid];
        SFX.play('group', B.REG[g.region].root, t);
        B.REGION_WORDS[g.region].forEach(wi => { if (W()[wi].gid === f.gid) W()[wi].cells.forEach((k, i) => ui.flash.pop.set(k, Math.round(t * 1000) + i * 40)); });
        toast(f.auto ? 'The last four fall into place' : `${who}Group found <span class="coin"></span>+${PAY.group}. Name it in the Key Grid`, 'unlock');
        if (mine) ui.sel.clear();
        t += .9;
        break;
      }
      case 'miss':
        if (mine) { ui.shake = true; SFX.play('wrong', t); toast((f.oneAway ? 'One away' : 'Not a group') + (f.fine ? ` <span class="coin"></span>−${f.fine}` : '')); }
        else toast(`${who}${f.oneAway ? 'one away on a group' : 'missed a group'}${f.fine ? ` <span class="coin"></span>−${f.fine}` : ''}`);
        break;
      case 'sectionDone':
        SFX.play('fanfare', t); t += .6;
        toast(`${B.REG[f.region].name} complete`, 'unlock');
        break;
      case 'open':
        SFX.play('unlock', B.REG[f.region].root, t);
        [...B.REGION_CELLS[f.region]].forEach((k, i) => { if (!ui.flash.pop.has(k)) ui.flash.pop.set(k, Math.round(t * 1000) + Math.min(i * 8, 500)); });
        toast(`${B.REG[f.region].name} is open`, 'reveal');
        t += .45;
        break;
      case 'buy':
        SFX.play('spend', f.what === 'word', t);
        if (!mine) toast(`${who}bought ${BUY_LABEL[f.what] || 'a hint'} <span class="coin"></span>−${f.cost}`);
        else if (f.what === 'clue') toast('Key clue bought');
        break;
      case 'reject':
        if (mine) { SFX.play('locked'); toast(`The team needs ${f.cost} coins for that`); }
        break;
      case 'win':
        SFX.play('win', t + .3);
        setTimeout(showWin, reduced ? 0 : 900 + t * 1000);
        break;
    }
  }
}
const BUY_LABEL = { letter: 'a letter', word: 'a word', clue: 'a key clue', pattern: 'the pattern', pair: 'a pair', keyletter: 'a link letter' };

function trackStats(initial) {
  const words = W().filter(w => !w.meta && q.isSolved(w.id)).length;
  M.games[net.game.id] = { words, groups: S.found.length, won: S.done };
  const totals = Object.values(M.games).reduce((a, g) => ({ words: a.words + g.words, groups: a.groups + g.groups, boards: a.boards + (g.won ? 1 : 0) }), { words: 0, groups: 0, boards: 0 });
  ui.totals = totals;
  let any = false;
  UNLOCKS.forEach(u => {
    if (!M.unlocked.includes(u.id) && totals[u.stat] >= u.goal) {
      M.unlocked.push(u.id); any = true;
      toast(`Unlocked: ${u.name}`, 'unlock');
    }
  });
  if (any && !initial) SFX.play('fanfare', 1);
  saveMeta();
}
function nudge(initial) {
  const k = 'crossfog.nudged.' + net.game.id;
  const done = store.get(k) || [];
  for (const r of B.SECTIONS) {
    if (q.regionOpen(r) && q.loose(r).length >= 4 && !done.includes(r)) {
      done.push(r); store.set(k, done);
      if (!initial) setTimeout(() => toast('Four answers ready. Tap Groups under the clue to sort them', 'unlock'), reduced ? 0 : 700);
    }
  }
}
function awaySummary(last) {
  if (!last) return;
  const per = {};
  S.feed.forEach(f => {
    if (f.eid == null || f.eid <= last || isMe(f.uid)) return;
    const p = (per[f.uid] ||= { clues: 0, groups: 0, keys: 0 });
    if (f.kind === 'solve') W()[f.wi].meta ? p.keys++ : p.clues++;
    if (f.kind === 'group' && !f.auto) p.groups++;
  });
  const lines = Object.entries(per).map(([uid, p]) => {
    const bits = [];
    if (p.clues) bits.push(`${p.clues} clue${p.clues > 1 ? 's' : ''}`);
    if (p.groups) bits.push(`${p.groups} group${p.groups > 1 ? 's' : ''}`);
    if (p.keys) bits.push(`${p.keys} key${p.keys > 1 ? 's' : ''}`);
    return bits.length ? `<b>${esc(nameOf(uid))}</b> · ${bits.join(' · ')}` : '';
  }).filter(Boolean);
  if (!lines.length) return;
  $('awayText').innerHTML = 'While you were away:<br>' + lines.join('<br>');
  $('away').hidden = false;
}

/* ---------- helpers on the current state ---------- */
const wordAt = (k, dir) => B.CELLS[k].words.find(wi => W()[wi].dir === dir && q.wordVis(wi));
const flip = d => (d === 'A' ? 'D' : 'A');
function activeWord() {
  if (!ui.cell || !B.CELLS[ui.cell]) return undefined;
  let wi = wordAt(ui.cell, ui.dir);
  if (wi === undefined) { ui.dir = flip(ui.dir); wi = wordAt(ui.cell, ui.dir); }
  return wi;
}
const lockMsg = wi => W()[wi].meta
  ? `Find this group in ${B.REG[B.GROUPS[W()[wi].gid].region].name} first`
  : `Find all four groups in ${B.REG[q.parentOf(W()[wi].region)].name} to open these clues`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ---------- input ---------- */
function selectWord(wi) {
  const w = W()[wi];
  ui.dir = w.dir;
  ui.cell = w.cells.find(k => !q.locked(k) && !S.fills[k]) || w.cells.find(k => !q.locked(k)) || w.cells[0];
}
function gotoNext(step) {
  const vis = B.ORDER.filter(q.wordVis);
  if (!vis.length) return;
  const i = vis.indexOf(activeWord());
  for (const ok of [wi => !q.isSolved(wi) && q.playable(wi), wi => !q.isSolved(wi)]) {
    for (let n = 1; n <= vis.length; n++) {
      const wi = vis[((i + step * n) % vis.length + vis.length) % vis.length];
      if (ok(wi)) { selectWord(wi); return; }
    }
  }
  selectWord(vis[((i + step) % vis.length + vis.length) % vis.length]);
}
function type(ch) {
  if (S.done) return;
  const wi = activeWord(); if (wi === undefined) return;
  if (!q.playable(wi)) { SFX.play('locked'); toast(lockMsg(wi)); return; }
  const w = W()[wi];
  let idx = w.cells.indexOf(ui.cell);
  if (q.locked(ui.cell)) {
    let n = -1;
    for (let j = idx + 1; j < w.cells.length; j++) if (!q.locked(w.cells[j])) { n = j; break; }
    if (n < 0) return;
    idx = n; ui.cell = w.cells[n];
  }
  SFX.play('key', seatOf(net.me.id));
  dispatch('fill', { k: ui.cell, ch });
  if (q.isSolved(wi)) gotoNext(1);
  else for (let j = idx + 1; j < w.cells.length; j++) if (!q.locked(w.cells[j])) { ui.cell = w.cells[j]; break; }
  commit();
}
function back() {
  if (S.done) return;
  const wi = activeWord(); if (wi === undefined || !q.playable(wi)) return;
  const w = W()[wi], idx = w.cells.indexOf(ui.cell);
  SFX.play('del');
  if (!q.locked(ui.cell) && S.fills[ui.cell]) { dispatch('erase', { k: ui.cell }); return commit(); }
  for (let j = idx - 1; j >= 0; j--) {
    if (!q.locked(w.cells[j])) { ui.cell = w.cells[j]; if (S.fills[ui.cell]) dispatch('erase', { k: ui.cell }); break; }
  }
  commit();
}
function hint(whole) {
  if (S.done) return;
  const wi = activeWord(); if (wi === undefined) return;
  const w = W()[wi];
  if (w.meta && !q.groupFound(w.gid)) { if (!whole) dispatch('buy', { what: 'clue', gid: w.gid }); return; }
  const cost = whole ? COST.word : COST.letter;
  if (S.coins < cost) { SFX.play('locked'); toast(`The team needs ${cost} coins for that`); return; }
  if (!q.playable(wi)) { SFX.play('locked'); toast(lockMsg(wi)); return; }
  if (whole) { dispatch('buy', { what: 'word', wi }); gotoNext(1); return commit(); }
  const wrongOrEmpty = x => !q.locked(x) && (!S.fills[x] || S.fills[x].ch !== B.CELLS[x].ch);
  const k = wrongOrEmpty(ui.cell) ? ui.cell : (w.cells.find(wrongOrEmpty) || w.cells.find(x => !q.locked(x)));
  if (!k) return;
  dispatch('buy', { what: 'letter', k });
  if (q.isSolved(wi)) gotoNext(1);
  else {
    const idx = w.cells.indexOf(k);
    ui.cell = k;
    for (let j = idx + 1; j < w.cells.length; j++) if (!q.locked(w.cells[j])) { ui.cell = w.cells[j]; break; }
  }
  commit();
}
function tapCell(k) {
  SFX.play('tick');
  if (k === ui.cell) { if (wordAt(k, flip(ui.dir)) !== undefined) ui.dir = flip(ui.dir); }
  else { ui.cell = k; if (wordAt(k, ui.dir) === undefined) ui.dir = flip(ui.dir); }
  commit(false);
}
function moveArrow(dr, dc) {
  const c = B.CELLS[ui.cell];
  const want = dc ? 'A' : 'D';
  if (ui.dir !== want && wordAt(ui.cell, want) !== undefined) { ui.dir = want; commit(false); return; }
  const k = (c.r + dr) + ',' + (c.c + dc);
  if (B.CELLS[k] && q.cellVis(k)) { ui.cell = k; if (wordAt(k, want) !== undefined) ui.dir = want; commit(); }
}
function toggleTile(wi) {
  if (ui.sel.has(wi)) ui.sel.delete(wi);
  else if (ui.sel.size < 4) ui.sel.add(wi);
  SFX.play('tick');
  renderSheet(); renderHud();
}
function submitGroup() {
  if (ui.sel.size !== 4) return;
  const picks = [...ui.sel];
  dispatch('group', { picks });
  if (picks.every(wi => q.groupFound(W()[wi].gid))) ui.sel.clear();
  renderSheet();
}

/* ---------- rendering ---------- */
const board = $('board'), viewport = $('viewport'), tilesEl = $('tiles'), labelsEl = $('labels');
const bgC = $('bgCanvas'), fogC = $('fogCanvas');
// A board-sized canvas is expensive for the phone to keep on screen: it gets
// re-composited on every frame, which made each keystroke lag. So the art is
// drawn on a canvas, turned into a plain image, and the canvas is hidden.
// The canvas only stays visible while the fog is animating away.
const artImg = { bgCanvas: $('bgImg'), fogCanvas: $('fogImg') };
const artGen = { bgCanvas: 0, fogCanvas: 0 };
function freeze(cv) {
  const img = artImg[cv.id], gen = ++artGen[cv.id];
  img.style.width = cv.style.width; img.style.height = cv.style.height;
  cv.toBlob(blob => {
    if (!blob || gen !== artGen[cv.id]) return;
    const url = URL.createObjectURL(blob), old = img.src;
    img.onload = () => {
      if (gen !== artGen[cv.id]) return;
      cv.style.display = 'none'; img.style.visibility = 'visible';
      if (old.startsWith('blob:')) URL.revokeObjectURL(old);
    };
    img.src = url;
  });
}
function thaw(cv) { artGen[cv.id]++; cv.style.display = ''; artImg[cv.id].style.visibility = 'hidden'; }
let drawn = '';

// Rendering is batched to one pass per animation frame, however many state
// changes land in between (a keystroke, the server's confirmation, a
// teammate's move), and tiles are patched in place rather than rebuilt.
let renderQueued = false, scrollQueued = false;
function scheduleRender(scroll = false) {
  scrollQueued = scrollQueued || scroll;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
    if (scrollQueued) { scrollQueued = false; ensureVisible(ui.cell); }
  });
}
function commit(scroll = true) { scheduleRender(scroll); }
const setHTML = (el, html) => { if (el._html !== html) { el._html = html; el.innerHTML = html; } };
const setText = (el, t) => { t = String(t); if (el.textContent !== t) el.textContent = t; };
const setAttr = (el, a, v) => { if (el.getAttribute(a) !== v) el.setAttribute(a, v); };
let lastFont = null, lastGold = null;
function render() {
  if (!S) return;
  if (!ui.cell || !B.CELLS[ui.cell] || !q.cellVis(ui.cell)) {
    const first = B.ORDER.find(wi => q.wordVis(wi) && !q.isSolved(wi) && q.playable(wi)) ?? B.ORDER.find(q.wordVis);
    selectWord(first);
  }
  const gold = M.tiles === 'gold';
  if (gold !== lastGold) { lastGold = gold; document.body.classList.toggle('gold', gold); }
  if (M.font !== lastFont) { lastFont = M.font; document.documentElement.style.setProperty('--f-tile', FONTS[M.font].css); }
  const key = [...S.revealed].join() + '|' + ui.cs + '|' + themeKey();
  if (key !== drawn) { drawn = key; layout(); }
  renderTiles();
  renderLabels();
  renderHud();
  renderClue();
  if (!$('sheet').hidden) renderSheet();
}
const tileEls = new Map();   // cell key -> element
const badUntil = new Map();  // cell key -> time its red "wrong" flash ends
const POP = [{ transform: 'scale(1)' }, { transform: 'scale(1.18)', offset: .4 }, { transform: 'scale(1)' }];
const SHAKE = [{ transform: 'none' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'none' }];
const ARRIVE = [{ transform: 'scale(.3)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }];
function renderTiles() {
  const wi = activeWord();
  const aw = new Set(wi === undefined ? [] : W()[wi].cells);
  const starts = {};
  W().forEach(w => { if (q.wordVis(w.id)) starts[w.cells[0]] = w.num; });
  const now = performance.now();
  for (const k in B.CELLS) {
    if (!q.cellVis(k)) { const gone = tileEls.get(k); if (gone) { gone.remove(); tileEls.delete(k); } continue; }
    const c = B.CELLS[k];
    let el = tileEls.get(k);
    if (!el) {
      el = document.createElement('div');
      el.dataset.k = k;
      tilesEl.appendChild(el);
      tileEls.set(k, el);
    }
    const sw = c.words.find(q.isSolved);
    const reg = sw !== undefined ? W()[sw].region : W()[c.words.find(q.wordVis)].region;
    let cls = 'tile';
    if (sw !== undefined) cls += ' solved';
    if (aw.has(k)) cls += ' word';
    if (k === ui.cell) cls += ' cur';
    if (S.hinted[k]) cls += ' hinted';
    if (c.words.some(x => !q.wordVis(x))) cls += ' edge';
    if (sw === undefined && !c.words.some(x => q.wordVis(x) && q.playable(x))) cls += ' gated';
    const gw = c.words.find(x => !W()[x].meta && q.groupFound(W()[x].gid));
    let gc = '';
    if (gw !== undefined) { cls += ' grouped'; gc = `;--gc:var(--g${B.GROUPS[W()[gw].gid].index})`; }
    if ((badUntil.get(k) || 0) > now) cls += ' bad';
    const f = S.fills[k];
    const style = `--x:${c.c};--y:${c.r};--rt:${B.REG[reg].tint}${gc}${f ? `;--pc:var(--p${seatOf(f.by) + 1})` : ''}`;
    const html = (starts[k] ? `<span class="n">${starts[k]}</span>` : '') + (f ? `<span class="l">${f.ch}</span>` : '');
    if (el.className !== cls) el.className = cls;
    if (el._style !== style) { el._style = style; el.setAttribute('style', style); }
    setHTML(el, html);
    if (!reduced && el.animate) {
      const arriving = ui.arrive[reg] && !c.words.some(y => W()[y].region !== reg && q.isRev(W()[y].region));
      if (arriving) el.animate(ARRIVE, { duration: 550, delay: Math.min(700, [...B.REGION_CELLS[reg]].indexOf(k) * 18), easing: 'cubic-bezier(.2,.9,.3,1.25)', fill: 'backwards' });
      else if (ui.flash.bad.has(k)) el.animate(SHAKE, { duration: 420 });
      else if (ui.flash.pop.has(k)) el.animate(POP, { duration: 500, delay: ui.flash.pop.get(k), easing: 'cubic-bezier(.2,.9,.3,1.4)' });
    }
  }
  if (ui.flash.bad.size) {
    ui.flash.bad.forEach(k => badUntil.set(k, now + 450));
    setTimeout(() => scheduleRender(), 470);
  }
  ui.flash.bad.clear(); ui.flash.pop.clear(); ui.arrive = {};
}
const LABEL_SPOT = {};
function computeLabelSpots() {
  const occupied = k => !!B.CELLS[k];
  const near = (r, c) => { for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (occupied((r + dr) + ',' + (c + dc))) return true; return false; };
  B.DATA.regions.forEach(reg => {
    const ks = [...B.REGION_CELLS[reg.id]].map(k => B.CELLS[k]);
    const rs = ks.map(c => c.r), cs = ks.map(c => c.c);
    const cr = rs.reduce((a, b) => a + b, 0) / ks.length, cc = cs.reduce((a, b) => a + b, 0) / ks.length;
    let best = null;
    for (const span of [5, 4, 3]) {
      for (let r = Math.min(...rs) - 1; r <= Math.max(...rs) + 1; r++) {
        for (let c = Math.min(...cs) - 2; c <= Math.max(...cs) + 1; c++) {
          let ok = c >= -PAD && c + span <= B.DATA.width + PAD;
          for (let i = 0; ok && i < span; i++) if (near(r, c + i)) ok = false;
          if (ok) ok = ks.some(k => Math.abs(k.r - r) <= 1.5 && k.c >= c - 1 && k.c <= c + span);
          if (!ok) continue;
          if (Object.values(LABEL_SPOT).some(s => Math.abs(s.r - r) < 1 && Math.abs(s.c - c) < 6)) continue;
          const dist = Math.hypot(r - cr, (c + span / 2) - cc);
          if (!best || dist < best.dist) best = { r, c, dist };
        }
      }
      if (best) break;
    }
    LABEL_SPOT[reg.id] = best || { r: Math.min(...rs) - 1, c: Math.min(...cs) };
  });
}
function renderLabels() {
  setHTML(labelsEl, B.DATA.regions.map(r => {
    const s = LABEL_SPOT[r.id];
    if (r.id === META_ID) {
      const n = q.keysNamed();
      return `<div class="rlabel" style="--x:${s.c};--y:${s.r}">Key Grid ${n === B.DATA.groups.length ? '<span class="ok">✓</span>' : `<span style="color:var(--muted);font-weight:600">${n}/${B.DATA.groups.length}</span>`}</div>`;
    }
    if (q.isRev(r.id)) {
      const f = q.foundIn(r.id);
      if (!q.regionOpen(r.id)) return `<div class="rlabel gated" style="--x:${s.c};--y:${s.r}">${r.name} <span style="font-weight:600">· locked</span></div>`;
      return `<div class="rlabel" style="--x:${s.c};--y:${s.r}">${r.name} ${f === 4 ? '<span class="ok">✓</span>' : `<span style="color:var(--muted);font-weight:600">${f}/4 groups</span>`}</div>`;
    }
    return `<div class="rlabel fogged" style="--x:${s.c};--y:${s.r}">Uncharted · ${B.REGION_WORDS[r.id].length} clues</div>`;
  }).join(''));
}
const ICON_SOUND_ON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>';
const ICON_SOUND_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';
function avatarHtml(uid) {
  const p = net.players.get(uid), seat = seatOf(uid);
  const name = p?.name || '?';
  return p?.avatar ? `<span class="av emoji" style="--pc:var(--p${seat + 1})">${esc(p.avatar)}</span>`
    : `<span class="av" style="--pc:var(--p${seat + 1})">${esc([...name][0].toUpperCase())}</span>`;
}
const roster = () => [...net.players.entries()].sort((a, b) => a[1].seat - b[1].seat);
function renderHud() {
  setText($('progress'), `${q.keysNamed()}/${B.DATA.groups.length}`);
  setText($('coins'), S.coins);
  const aw = activeWord();
  const open = q.playable(aw);
  const lockedKey = aw !== undefined && W()[aw].meta && !q.groupFound(W()[aw].gid);
  if (lockedKey) {
    const bought = S.clueBought.has(W()[aw].gid);
    $('hlLabel').textContent = bought ? 'Clue bought' : 'Key clue';
    $('hlCost').textContent = COST.clue;
    $('hintLetter').setAttribute('aria-label', `Buy a clue for this key (${COST.clue} coins)`);
    $('hintLetter').disabled = S.done || bought || S.coins < COST.clue;
  } else {
    $('hlLabel').textContent = 'Letter';
    $('hlCost').textContent = COST.letter;
    $('hintLetter').setAttribute('aria-label', `Reveal a letter (${COST.letter} coins)`);
    $('hintLetter').disabled = S.done || !open || S.coins < COST.letter;
  }
  $('hwCost').textContent = COST.word;
  $('hintWord').disabled = S.done || !open || S.coins < COST.word;
  const nLoose = B.SECTIONS.filter(q.regionOpen).reduce((a, r) => a + q.loose(r).length, 0);
  $('groupsBadge').hidden = nLoose < 1;
  setText($('groupsBadge'), `${nLoose} ready`);
  $('groupsBtn').classList.toggle('ready', nLoose >= 4 && !S.done);
  $('groupsBtn').setAttribute('aria-label', `Groups: ${nLoose} solved answers waiting to be grouped`);
  // with three or four players the names don't fit, so chips go to avatar + count
  const compact = net.players.size > 2;
  setHTML($('players'), (compact || net.mode === 'shared' ? '' : '<span class="players-label">Team</span>') + roster().map(([uid, p]) =>
    `<span class="chip${isMe(uid) ? ' you' : ''}" style="--pc:var(--p${p.seat + 1})" title="${esc(p.name)}" aria-label="${esc(p.name)}${isMe(uid) ? ' (you)' : ''}, ${S.by[uid] || 0} solves">${avatarHtml(uid)}${compact ? '' : (isMe(uid) && net.mode === 'shared' ? 'You' : esc(p.name))}<small>${S.by[uid] || 0}</small></span>`).join('')
    + (net.mode === 'shared' && net.players.size < 4 ? '<button class="chip invite-chip" id="inviteChip" aria-label="Invite a teammate" title="Invite a teammate">+</button>' : ''));
  $('coach').hidden = M.coached || S.found.length > 0 || !$('away').hidden;
  setHTML($('coachText'), 'These 16 clues hide four groups of four. Solve clues, then tap <b>Groups</b> under the clue to sort your answers into fours. '
    + 'Each group\'s one-word link goes in the <b>Key Grid</b>. Fill the Key Grid to win.');
  const sb = $('soundBtn');
  sb.setAttribute('aria-pressed', String(M.sound !== false));
  sb.setAttribute('aria-label', M.sound !== false ? 'Mute sound' : 'Turn sound on');
  setHTML(sb, M.sound !== false ? ICON_SOUND_ON : ICON_SOUND_OFF);
}
function renderClue() {
  const wi = activeWord();
  if (wi === undefined) return;
  const w = W()[wi];
  setText($('clueNum'), w.label);
  const open = q.playable(wi);
  $('clueRegion').textContent = open ? B.REG[w.region].name
    : w.meta ? `${w.answer.length} letters · locked`
    : `Locked: find ${B.REG[q.parentOf(w.region)].name}'s groups first`;
  setText($('clueText'), q.clueOf(wi));
  $('clue').classList.toggle('done', q.isSolved(wi));
  $('clue').classList.toggle('gated', !open);
}

/* ---------- canvas ---------- */
let themeCache = null;
function themeKey() { return themeCache ??= css('--fog') + css('--region-alpha'); }
function layout() {
  const cs = ui.cs, Wd = (B.DATA.width + PAD * 2) * cs, H = (B.DATA.height + PAD * 2) * cs;
  board.style.setProperty('--cs', cs + 'px');
  board.style.width = Wd + 'px'; board.style.height = H + 'px';
  // keep each canvas under ~16M pixels so phones don't refuse to draw it
  const dpr = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(16e6 / (Wd * H)));
  [bgC, fogC].forEach(cv => { cv.width = Math.round(Wd * dpr); cv.height = Math.round(H * dpr); cv.style.width = Wd + 'px'; cv.style.height = H + 'px'; cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0); });
  drawBg();
  drawFog();
}
const center = k => { const c = B.CELLS[k]; return [(c.c + PAD + .5) * ui.cs, (c.r + PAD + .5) * ui.cs]; };
function bbox(rid) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  B.REGION_CELLS[rid].forEach(k => { const [x, y] = center(k); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
  const m = ui.cs * 1.6;
  return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
}
const MOTIF = {
  kitchen(ctx, b, cs, m) {
    const s = cs * .5;
    ctx.fillStyle = `rgba(210, 86, 60, ${.14 * m})`;
    for (let x = b.x; x < b.x + b.w; x += s * 2) ctx.fillRect(x, b.y, s, b.h);
    for (let y = b.y; y < b.y + b.h; y += s * 2) ctx.fillRect(b.x, y, b.w, s);
  },
  space(ctx, b, cs, m, rnd) {
    ctx.fillStyle = `rgba(54, 58, 150, ${.2 * m})`; ctx.fillRect(b.x, b.y, b.w, b.h);
    const n = Math.round(b.w * b.h / (cs * cs) * .8);
    for (let i = 0; i < n; i++) {
      const x = b.x + rnd() * b.w, y = b.y + rnd() * b.h, r = cs * (.05 + rnd() * .1);
      ctx.fillStyle = `rgba(255, 255, 255, ${(.55 + rnd() * .4) * m})`;
      ctx.beginPath(); ctx.moveTo(x, y - r * 2); ctx.quadraticCurveTo(x, y, x + r * 2, y); ctx.quadraticCurveTo(x, y, x, y + r * 2); ctx.quadraticCurveTo(x, y, x - r * 2, y); ctx.quadraticCurveTo(x, y, x, y - r * 2); ctx.fill();
    }
    ctx.strokeStyle = `rgba(245, 197, 66, ${.5 * m})`; ctx.lineWidth = cs * .07;
    const px = b.x + b.w * .78, py = b.y + b.h * .2;
    ctx.fillStyle = `rgba(245, 197, 66, ${.35 * m})`; ctx.beginPath(); ctx.arc(px, py, cs * .7, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(px, py, cs * 1.25, cs * .32, -.35, 0, 7); ctx.stroke();
  },
  garden(ctx, b, cs, m, rnd) {
    const n = Math.round(b.w * b.h / (cs * cs) * .38);
    for (let i = 0; i < n; i++) {
      const x = b.x + rnd() * b.w, y = b.y + rnd() * b.h, r = cs * (.14 + rnd() * .1);
      if (rnd() < .4) {
        ctx.fillStyle = `rgba(70, 140, 70, ${.45 * m})`;
        ctx.beginPath(); ctx.ellipse(x, y, r * 1.6, r * .6, rnd() * 3, 0, 7); ctx.fill();
        continue;
      }
      ctx.fillStyle = rnd() < .5 ? `rgba(232, 126, 166, ${.6 * m})` : `rgba(255, 255, 255, ${.7 * m})`;
      for (let p = 0; p < 5; p++) { const a = p / 5 * Math.PI * 2; ctx.beginPath(); ctx.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, r * .72, 0, 7); ctx.fill(); }
      ctx.fillStyle = `rgba(242, 184, 46, ${.85 * m})`; ctx.beginPath(); ctx.arc(x, y, r * .55, 0, 7); ctx.fill();
    }
  },
  ocean(ctx, b, cs, m, rnd) {
    ctx.strokeStyle = `rgba(24, 104, 156, ${.32 * m})`; ctx.lineWidth = cs * .06; ctx.lineCap = 'round';
    const step = cs * .8;
    for (let y = b.y, row = 0; y < b.y + b.h; y += cs * .62, row++) {
      ctx.beginPath();
      for (let x = b.x - (row % 2) * step / 2; x < b.x + b.w; x += step) { ctx.moveTo(x, y); ctx.quadraticCurveTo(x + step / 4, y - cs * .16, x + step / 2, y); }
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(255, 255, 255, ${.55 * m})`;
    for (let i = 0; i < b.w * b.h / (cs * cs) * .12; i++) { ctx.beginPath(); ctx.arc(b.x + rnd() * b.w, b.y + rnd() * b.h, cs * (.06 + rnd() * .08), 0, 7); ctx.fill(); }
  },
  meta(ctx, b, cs, m, rnd) {
    ctx.strokeStyle = `rgba(176, 120, 20, ${.4 * m})`; ctx.lineWidth = cs * .07; ctx.lineCap = 'round';
    const n = Math.round(b.w * b.h / (cs * cs) * .1);
    for (let i = 0; i < n; i++) {
      const x = b.x + rnd() * b.w, y = b.y + rnd() * b.h, s = cs * (.35 + rnd() * .2), a = rnd() * Math.PI * 2;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.beginPath(); ctx.arc(0, 0, s * .45, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s * .45, 0); ctx.lineTo(s * 1.6, 0); ctx.moveTo(s * 1.3, 0); ctx.lineTo(s * 1.3, s * .35); ctx.moveTo(s * 1.55, 0); ctx.lineTo(s * 1.55, s * .3); ctx.stroke();
      ctx.restore();
    }
  },
};
function regionPath(ctx, rid, rad) {
  ctx.beginPath();
  B.REGION_CELLS[rid].forEach(k => { const [x, y] = center(k); ctx.moveTo(x + rad, y); ctx.arc(x, y, rad, 0, Math.PI * 2); });
}
function drawBg() {
  const ctx = bgC.getContext('2d'), cs = ui.cs;
  ctx.clearRect(0, 0, bgC.width, bgC.height);
  const a = parseFloat(css('--region-alpha')) || .5, m = parseFloat(css('--motif-alpha')) || 1;
  B.DATA.regions.forEach(r => {
    if (!q.isRev(r.id)) return;
    const b = bbox(r.id);
    ctx.save();
    regionPath(ctx, r.id, cs * 1.35);
    ctx.clip();
    ctx.globalAlpha = a; ctx.fillStyle = r.tint; ctx.fillRect(b.x, b.y, b.w, b.h); ctx.globalAlpha = 1;
    (MOTIF[r.motif] || (() => {}))(ctx, b, cs, m, rng(r.id));
    ctx.restore();
  });
  freeze(bgC);
}
let fogRaf = 0;
function drawFog() {
  cancelAnimationFrame(fogRaf);
  const ctx = fogC.getContext('2d'), cs = ui.cs, now = performance.now();
  ctx.clearRect(0, 0, fogC.width, fogC.height);
  const fog = css('--fog'), hi = css('--fog-hi');
  let anim = false;
  B.DATA.regions.forEach(r => {
    let alpha = 1;
    if (q.isRev(r.id)) {
      const t0 = ui.fogFade[r.id];
      if (t0 == null || reduced) return;
      alpha = 1 - (now - t0) / 1000;
      if (alpha <= 0) { delete ui.fogFade[r.id]; return; }
      anim = true;
    }
    const rnd = rng('fog' + r.id);
    const shownByOther = k => B.CELLS[k].words.some(x => W()[x].region !== r.id && q.isRev(W()[x].region));
    const puffs = [];
    B.REGION_CELLS[r.id].forEach(k => {
      if (shownByOther(k)) return;
      const [x, y] = center(k);
      for (let i = 0; i < 3; i++) puffs.push([x + (rnd() - .5) * cs * .9, y + (rnd() - .5) * cs * .9, cs * (.7 + rnd() * .5)]);
    });
    const grow = q.isRev(r.id) ? 1 + (1 - alpha) * .5 : 1;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = fog;
    puffs.forEach(([x, y, rad]) => { ctx.beginPath(); ctx.arc(x, y, rad * grow, 0, 7); ctx.fill(); });
    ctx.globalAlpha = alpha * .8;
    ctx.fillStyle = hi;
    puffs.forEach(([x, y, rad], i) => { if (i % 2) return; ctx.beginPath(); ctx.arc(x - rad * .25, y - rad * .3, rad * .42 * grow, 0, 7); ctx.fill(); });
    ctx.globalAlpha = 1;
  });
  if (anim) { thaw(fogC); fogRaf = requestAnimationFrame(drawFog); }
  else freeze(fogC);
}

/* ---------- view ---------- */
function ensureVisible(k) {
  if (!k) return;
  const [x, y] = center(k), m = ui.cs * 1.6;
  const vx = viewport.scrollLeft, vy = viewport.scrollTop, vw = viewport.clientWidth, vh = viewport.clientHeight;
  if (x < vx + m || x > vx + vw - m || y < vy + m || y > vy + vh - m) centerOn(k, true);
}
function centerOn(k, smooth) {
  const [x, y] = center(k);
  viewport.scrollTo({ left: x - viewport.clientWidth / 2, top: y - viewport.clientHeight / 2, behavior: smooth && !reduced ? 'smooth' : 'auto' });
}
function zoom(step) {
  const cs0 = ui.cs, cs1 = Math.max(22, Math.min(60, cs0 + step));
  if (cs0 === cs1) return;
  const cx = (viewport.scrollLeft + viewport.clientWidth / 2) / cs0, cy = (viewport.scrollTop + viewport.clientHeight / 2) / cs0;
  ui.cs = cs1;
  render();
  viewport.scrollLeft = cx * cs1 - viewport.clientWidth / 2;
  viewport.scrollTop = cy * cs1 - viewport.clientHeight / 2;
}

/* ---------- toasts & sheet ---------- */
function toast(html, kind = '') {
  const box = $('toasts');
  while (box.children.length >= 3) box.firstChild.remove();
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.innerHTML = html;
  box.appendChild(t);
  setTimeout(() => t.remove(), kind ? 2800 : 1800);
}
function openSheet(tab) { ui.tab = tab || ui.tab; $('sheet').hidden = false; renderSheet(); }
function closeSheet() { $('sheet').hidden = true; ui.armed = null; }
function defaultSec() {
  const aw = activeWord();
  if (aw !== undefined && !W()[aw].meta && q.regionOpen(W()[aw].region)) return W()[aw].region;
  const open = B.SECTIONS.filter(q.regionOpen);
  return open.find(r => !q.sectionDone(r)) || open[open.length - 1];
}
const inviteUrl = () => `${location.origin}${location.pathname}?g=${net.game.code}${FAKE ? '&fake=1' : ''}`;
function renderSheet() {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab)));
  const body = $('sheetBody');
  if (ui.tab === 'groups') {
    body.innerHTML = groupsHtml();
    ui.shake = false;
  } else if (ui.tab === 'clues') {
    body.innerHTML = B.DATA.regions.map(r => {
      const ids = B.ORDER.filter(wi => W()[wi].region === r.id);
      const done = ids.filter(q.isSolved).length;
      if (!q.isRev(r.id)) return `<section class="sec"><h3>Uncharted <small>${ids.length} clues</small></h3><div class="fogrow">Solve a word with a cloud badge to reveal it.</div></section>`;
      const gate = r.id === META_ID ? '<p class="note">Each key is the one-word link for a group. A key opens once its group is found.</p>'
        : q.regionOpen(r.id) ? '' : `<div class="fogrow">You can read these now. They open when ${B.REG[q.parentOf(r.id)].name}'s four groups are found.</div>`;
      return `<section class="sec"><h3><span><span class="swatch" style="--rt:${r.tint}"></span>${r.name}</span><small>${done}/${ids.length}</small></h3>${gate}<div class="clue-list">`
        + ids.map(wi => { const w = W()[wi], s = q.isSolved(wi); return `<button class="clue-row${s ? ' is-solved' : ''}" data-w="${wi}"><b>${w.meta ? 'K' : ''}${w.num}${w.dir}</b><span>${esc(q.clueOf(wi))}</span><span class="ans">${s ? w.answer : ''}</span></button>`; }).join('')
        + '</div></section>';
    }).join('');
  } else if (ui.tab === 'team') {
    const has = id => !id || M.unlocked.includes(id);
    const T = ui.totals || { words: 0, groups: 0, boards: 0 };
    let h = '';
    if (net.mode === 'shared') {
      h += `<section class="sec"><div class="invite"><h3>Invite <small>${net.players.size}/4 players</small></h3>`
        + `<div class="code" aria-label="Game code">${esc(net.game.code)}</div><div class="url">${esc(inviteUrl())}</div>`
        + `<div class="opts"><button class="opt" data-copy="1">Copy link</button>${navigator.share ? '<button class="opt" data-share="1">Share…</button>' : ''}</div>`
        + '<p class="note">Anyone with the link can join until four people are in. You each play whenever you like; moves sync as they happen.</p></div></section>';
    }
    h += '<section class="sec"><h3>Team</h3><div class="roster">' + roster().map(([uid, p]) =>
      `<div class="prow" style="--pc:var(--p${p.seat + 1})">${avatarHtml(uid)}<span>${esc(p.name)}${isMe(uid) ? ' (you)' : ''}</span><small>${S.by[uid] || 0} solves</small></div>`).join('') + '</div></section>';
    h += `<section class="sec"><div class="wallet"><div class="big"><span class="coin"></span>${S.coins}</div><p>One shared wallet. Solves pay ${PAY.word}, groups pay ${PAY.group}, named keys pay ${PAY.key}. Wrong group guesses cost ${COST.mistake}. Hints spend from it, so decide together.</p></div></section>`;
    h += `<section class="sec"><h3>Your unlocks <small>${T.words} clues · ${T.groups} groups · ${T.boards} grids</small></h3>`
      + UNLOCKS.map(u => { const on = M.unlocked.includes(u.id), pct = Math.min(100, T[u.stat] / u.goal * 100); return `<div class="ms"><div><b>${u.name}</b><div class="need">${u.need}</div></div><span class="tag${on ? ' on' : ''}">${on ? 'Unlocked' : `${Math.min(T[u.stat], u.goal)}/${u.goal}`}</span><div class="bar"><i style="width:${pct}%"></i></div></div>`; }).join('')
      + '</section>';
    h += `<section class="sec"><h3>Letters</h3><div class="opts">${Object.entries(FONTS).map(([id, f]) => `<button class="opt" data-font="${id}" aria-pressed="${M.font === id}" ${has(f.unlock) ? '' : 'disabled'} style="font-family:${f.css.replace(/"/g, '&quot;')}">${f.name}</button>`).join('')}</div></section>`;
    h += `<section class="sec"><h3>Tiles</h3><div class="opts">${Object.entries(TILESETS).map(([id, t]) => `<button class="opt" data-tiles="${id}" aria-pressed="${M.tiles === id}" ${has(t.unlock) ? '' : 'disabled'}>${t.name}</button>`).join('')}</div></section>`;
    h += `<section class="sec"><h3>Your avatar</h3>${avatarRow(has)}</section>`;
    body.innerHTML = h;
  } else {
    body.innerHTML = `<section class="sec"><h3>Sound effects</h3><div class="opts"><button class="opt" data-sound="on" aria-pressed="${M.sound !== false}">On</button><button class="opt" data-sound="off" aria-pressed="${M.sound === false}">Off</button></div></section>`
      + (net.mode === 'shared'
        ? `<section class="sec"><h3>This game</h3><p class="note">Leaving takes you back to the start screen. The game keeps going, and you can rejoin with code ${esc(net.game.code)}.</p><div class="opts"><button class="danger${ui.armed === 'leave' ? ' armed' : ''}" data-leave="1">${ui.armed === 'leave' ? 'Tap again to leave' : 'Leave game'}</button></div></section>`
        : `<section class="sec"><h3>Solo game</h3><p class="note">Starting over clears this board on this phone. Unlocks stay.</p><div class="opts"><button class="danger${ui.armed === 'reset' ? ' armed' : ''}" data-reset="1">${ui.armed === 'reset' ? 'Tap again to start over' : 'Start over'}</button><button class="opt" data-leave="1">Back to start screen</button></div></section>`);
  }
}
function avatarRow(has) {
  const packs = Object.values(AVATARS).filter(p => has(p.unlock));
  if (!packs.length) return '<p class="note">Solve 15 clues to unlock the first avatar pack.</p>';
  const mine = net.players.get(net.me.id)?.avatar || null, seat = seatOf(net.me.id);
  return '<div class="opts">' + `<button class="opt av-opt" data-av="" aria-pressed="${!mine}"><span class="av" style="--pc:var(--p${seat + 1})">${esc([...(net.me.name || '?')][0].toUpperCase())}</span></button>`
    + packs.flatMap(p => p.list).map(a => `<button class="opt av-opt" data-av="${a}" aria-pressed="${mine === a}"><span class="av emoji" style="--pc:var(--p${seat + 1})">${a}</span></button>`).join('') + '</div>';
}
function groupsHtml() {
  const secs = B.SECTIONS.filter(q.isRev);
  if (!ui.gsec || !secs.includes(ui.gsec)) ui.gsec = defaultSec();
  const r = ui.gsec;
  let h = '<div class="sec-chips">' + secs.map(x => `<button class="opt" data-gsec="${x}" aria-pressed="${x === r}">${B.REG[x].name} <small>${q.foundIn(x)}/4</small></button>`).join('') + '</div>';
  if (!q.regionOpen(r)) return h + `<div class="fogrow">Opens when all four groups in ${B.REG[q.parentOf(r)].name} are found.</div>`;
  const found = S.found.filter(gid => B.GROUPS[gid].region === r);
  h += '<section class="sec">';
  if (found.length) {
    h += '<div class="gfound">' + found.map(gid => {
      const g = B.GROUPS[gid], kw = B.KEY_WORD[gid], named = q.isSolved(kw);
      const mem = B.REGION_WORDS[r].filter(wi => W()[wi].gid === gid).map(wi => q.isSolved(wi) ? W()[wi].answer : '?').join(' · ');
      return `<button class="gbar" data-gjump="${kw}" style="--gc:var(--g${g.index})"><b>${named ? g.key : `<span class="blank">${'_'.repeat(g.key.length)}</span>`}</b><span class="mem">${mem}</span><span class="go">${named ? '' : 'Name it ›'}</span></button>`;
    }).join('') + '</div>';
  }
  const rest = B.TRAY_ORDER[r].filter(wi => !q.groupFound(W()[wi].gid));
  [...ui.sel].forEach(wi => { if (!rest.includes(wi) || !q.isSolved(wi)) ui.sel.delete(wi); });
  if (rest.length) {
    const paired = new Set(q.ladderOf(r).pairs.filter(p => !q.groupFound(p.gid)).flatMap(p => p.w));
    h += `<p class="note">Pick four answers that share a hidden link. Wrong guesses cost ${COST.mistake} coins. Dashed tiles are clues nobody has solved yet.</p>`;
    h += '<div class="tray">' + rest.map(wi => q.isSolved(wi)
      ? `<button class="gt${W()[wi].answer.length >= 9 ? ' long' : ''}${paired.has(wi) ? ' paired' : ''}${ui.shake && ui.sel.has(wi) ? ' shake' : ''}" data-gpick="${wi}" aria-pressed="${ui.sel.has(wi)}">${W()[wi].answer}</button>`
      : `<button class="gt unsolved" data-gclue="${wi}" aria-label="Unsolved clue ${W()[wi].label}">${W()[wi].num}${W()[wi].dir}</button>`).join('') + '</div>';
    h += `<div class="gactions"><button class="secondary" data-gclear="1" ${ui.sel.size ? '' : 'disabled'}>Deselect</button><button class="primary" data-gcheck="1" ${ui.sel.size === 4 ? '' : 'disabled'}>Check group (${ui.sel.size}/4)</button></div>`;
    h += ladderHtml(r);
  }
  return h + '</section>';
}
function ladderHtml(r) {
  const L = q.ladderOf(r);
  const coin = n => `<span class="cost"><span class="coin" aria-hidden="true"></span>${n}</span>`;
  let h = '<div class="ladder"><h3>Stuck? <small>Hints spend team coins</small></h3>';
  if (L.pattern) h += `<div class="lrow"><b>Pattern</b><span>${esc(B.REG[r].pattern || '')}</span></div>`;
  L.pairs.filter(p => !q.groupFound(p.gid)).forEach(p => {
    const lettered = L.letters.includes(p.gid);
    h += `<div class="lrow"><b>Pair</b><span>${p.w.map(wi => W()[wi].answer).join(' + ')} belong together.`
      + (lettered ? ` Their link: <span class="kp">${q.keyPattern(p.gid)}</span>` : '') + '</span></div>';
  });
  h += '<div class="lbtns">';
  if (!L.pattern) {
    h += `<button class="opt" data-ladder="pattern" ${S.coins < COST.pattern ? 'disabled' : ''}>Show the pattern ${coin(COST.pattern)}</button>`;
  } else {
    const pc = q.pairCandidate(r), lc = q.letterCandidate(r);
    h += `<button class="opt" data-ladder="pair" ${pc && S.coins >= COST.pair ? '' : 'disabled'}>Show a pair ${coin(COST.pair)}</button>`;
    h += `<button class="opt" data-ladder="keyletter" ${lc && S.coins >= COST.keyletter ? '' : 'disabled'}>Show a link letter ${coin(COST.keyletter)}</button>`;
    if (!pc) h += '<p class="note">Solve more clues to unlock another pair.</p>';
    else if (!lc) h += '<p class="note">A link letter goes with a pair, so buy a pair first.</p>';
  }
  return h + '</div></div>';
}
function showWin() {
  const clues = W().filter(w => !w.meta && q.isSolved(w.id)).length, total = W().filter(w => !w.meta).length;
  const span = S.doneAt && S.firstAt ? (new Date(S.doneAt) - new Date(S.firstAt)) : 0;
  const hrs = span / 36e5;
  const took = hrs >= 24 ? `${Math.round(hrs / 24)} day${Math.round(hrs / 24) === 1 ? '' : 's'}` : hrs >= 1 ? `${Math.round(hrs)} hour${Math.round(hrs) === 1 ? '' : 's'}` : `${Math.max(1, Math.round(span / 6e4))} min`;
  $('winSub').textContent = `All ${B.DATA.groups.length} links named. ${clues} of ${total} clues solved${clues === total ? ', every one' : ''}.`;
  $('winStats').innerHTML = `<div class="stat"><b>${took}</b><span>Start to finish</span></div><div class="stat"><b>${S.mistakes}</b><span>Wrong groups</span></div><div class="stat"><b>${S.hints}</b><span>Hints bought</span></div>`;
  const max = Math.max(1, ...Object.values(S.by));
  $('winContrib').innerHTML = roster().map(([uid, p]) => `<div class="crow" style="--pc:var(--p${p.seat + 1})">${avatarHtml(uid)}<div class="track"><i style="width:${(S.by[uid] || 0) / max * 100}%"></i></div><span>${S.by[uid] || 0}</span></div>`).join('');
  $('winModal').hidden = false;
}

/* ---------- lobby & game lifecycle ---------- */
function lobby(mode, msg) {
  $('lobby').hidden = false;
  const invite = mode === 'join';
  $('lobbyNew').hidden = invite;
  $('lobbyJoin').hidden = !invite;
  $('lobbyIntro').textContent = invite
    ? 'You’ve been invited to a co-op crossword. Solve clues, sort the answers into groups of four, and name every link in the Key Grid. Play whenever you have a minute; your team’s moves show up as they happen.'
    : 'A co-op crossword for up to four people. Solve clues, sort the answers into groups of four, and name every link in the Key Grid. Play together whenever each of you has a minute.';
  $('inviteCode').textContent = invite ? params.get('g').toUpperCase() : '';
  $('nameInput').value = store.get('crossfog.name') || '';
  $('newShared').disabled = !SHARED_READY; $('joinBtn').disabled = !SHARED_READY;
  if (!SHARED_READY) msg = msg || 'Shared games aren’t set up on this server yet. Solo play works.';
  $('lobbyError').hidden = !msg; $('lobbyError').textContent = msg || '';
  $('lobbyBusy').hidden = true;
}
function busy(on) {
  $('lobbyBusy').hidden = !on;
  ['newShared', 'joinBtn', 'joinInvite', 'soloBtn'].forEach(id => { $(id).disabled = on || (!SHARED_READY && id !== 'soloBtn'); });
}
function nameOrComplain() {
  const n = $('nameInput').value.trim();
  if (!n) { $('lobbyError').hidden = false; $('lobbyError').textContent = 'Enter your name first. It’s how your team sees your moves.'; $('nameInput').focus(); return null; }
  store.set('crossfog.name', n);
  return n;
}
async function openShared({ code, name, create }) {
  busy(true);
  try {
    const opts = { code, name, create, boardId: B.id };
    const adapter = FAKE ? fakeSharedGame(opts) : await sharedGame(CONFIG, opts);
    await start(adapter);
    store.set('crossfog.last', { mode: 'shared', code: adapter.game.code });
    if (create) { openSheet('team'); }
  } catch (e) {
    lobby(code && !create ? 'join' : 'new', e.message || String(e));
    if (code && !create && /No game/.test(e.message || '')) { history.replaceState(null, '', location.pathname + (FAKE ? '?fake=1' : '')); lobby('new', e.message); }
  } finally { busy(false); }
}
async function start(adapter) {
  if (unsubscribe) unsubscribe();
  net = adapter;
  confirmed = (await net.load()).slice().sort((a, b) => a.id - b.id);
  confirmedIds.clear(); confirmed.forEach(e => confirmedIds.add(e.id));
  base = null; baseN = 0; lastSeenSaved = 0;
  tileEls.clear(); tilesEl.innerHTML = '';
  pending = []; seen.clear();
  ui.cell = null; ui.sel.clear(); ui.gsec = null; ui.fogFade = {}; ui.arrive = {};
  drawn = '';
  const lastSeen = store.get('crossfog.seen.' + net.game.id) || 0;
  recompute(true);
  $('away').hidden = true;
  awaySummary(lastSeen);
  render();
  const known = new Set(net.players.keys());
  unsubscribe = net.subscribe(onRemote, () => {
    net.players.forEach((p, uid) => { if (!known.has(uid)) { known.add(uid); toast(`${esc(p.name)} joined the game`, 'unlock'); SFX.play('unlock', 67); } });
    render();
  });
  const url = net.mode === 'shared' ? `${location.pathname}?g=${net.game.code}${FAKE ? '&fake=1' : ''}` : location.pathname + (FAKE ? '?fake=1' : '');
  history.replaceState(null, '', url);
  $('lobby').hidden = true; $('winModal').hidden = true;
  requestAnimationFrame(() => centerOn(ui.cell, false));
  if (S.done) setTimeout(showWin, 300);
}
async function catchUp() {
  if (!net) return;
  try {
    const after = confirmed.length ? confirmed[confirmed.length - 1].id : 0;
    const evs = await net.catchUp(after);
    $('offline').hidden = true;
    if (evs.length) onRemote(evs);
  } catch (e) { $('offline').hidden = false; }
}
function leave() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null; net = null; S = null;
  store.set('crossfog.last', null);
  closeSheet();
  history.replaceState(null, '', location.pathname + (FAKE ? '?fake=1' : ''));
  lobby('new');
}

/* ---------- wiring ---------- */
function buildKeyboard() {
  const rows = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
  $('kbd').innerHTML = rows.map((r, i) => `<div class="krow">${i === 2 ? '<button class="key wide" data-key="dir" aria-label="Switch direction">⇄</button>' : ''}${[...r].map(ch => `<button class="key" data-key="${ch}">${ch}</button>`).join('')}${i === 2 ? '<button class="key wide" data-key="back" aria-label="Delete">⌫</button>' : ''}</div>`).join('');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copied'); }
  catch (e) { toast('Couldn’t copy. Press and hold the link to copy it.'); }
}
function wire() {
  const live = fn => (...a) => { if (net && S) fn(...a); };
  // Keys fire on touch-down, not on release: a click on a phone only arrives
  // after the finger lifts, which makes fast typing feel sticky. A click
  // (keyboard Enter, a mouse, a screen reader) still works on its own.
  const pressKey = b => {
    const k = b.dataset.key;
    if (k === 'back') back();
    else if (k === 'dir') tapCell(ui.cell);
    else type(k);
  };
  let lastDown = 0;
  $('kbd').addEventListener('pointerdown', live(e => {
    const b = e.target.closest('[data-key]'); if (!b || e.button > 0) return;
    e.preventDefault();
    lastDown = performance.now();
    b.classList.add('down');
    pressKey(b);
  }));
  const up = e => { const b = e.target.closest && e.target.closest('[data-key]'); if (b) b.classList.remove('down'); };
  $('kbd').addEventListener('pointerup', up);
  $('kbd').addEventListener('pointercancel', up);
  $('kbd').addEventListener('pointerleave', e => { document.querySelectorAll('.key.down').forEach(k => k.classList.remove('down')); });
  $('kbd').addEventListener('click', live(e => {
    const b = e.target.closest('[data-key]'); if (!b) return;
    if (performance.now() - lastDown < 800) return; // already handled on pointerdown
    pressKey(b);
  }));
  tilesEl.addEventListener('click', live(e => { const t = e.target.closest('[data-k]'); if (t) tapCell(t.dataset.k); }));
  $('clue').addEventListener('click', live(() => tapCell(ui.cell)));
  $('prevClue').addEventListener('click', live(() => { gotoNext(-1); commit(); }));
  $('nextClue').addEventListener('click', live(() => { gotoNext(1); commit(); }));
  $('groupsBtn').addEventListener('click', live(() => { ui.gsec = defaultSec(); SFX.play('tick'); openSheet('groups'); }));
  $('keyGridBtn').addEventListener('click', live(() => {
    SFX.play('tick');
    const keys = B.ORDER.filter(wi => W()[wi].meta);
    selectWord(keys.find(wi => q.playable(wi) && !q.isSolved(wi)) ?? keys.find(wi => !q.isSolved(wi)) ?? keys[0]);
    commit(false); centerOn(ui.cell, true);
  }));
  $('hintLetter').addEventListener('click', live(() => hint(false)));
  $('hintWord').addEventListener('click', live(() => hint(true)));
  $('zoomIn').addEventListener('click', live(() => zoom(6)));
  $('zoomOut').addEventListener('click', live(() => zoom(-6)));
  $('menuBtn').addEventListener('click', live(() => { ui.gsec = defaultSec(); openSheet('groups'); }));
  $('walletBtn').addEventListener('click', live(() => openSheet('team')));
  $('players').addEventListener('click', live(e => { if (e.target.closest('#inviteChip')) openSheet('team'); }));
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', e => { if (e.target === $('sheet')) closeSheet(); });
  $('coachClose').addEventListener('click', () => { M.coached = true; saveMeta(); render(); });
  $('awayClose').addEventListener('click', () => { $('away').hidden = true; render(); });
  $('soundBtn').addEventListener('click', () => {
    M.sound = M.sound === false;
    if (M.sound) { SFX.play('coin'); toast('Sound on'); } else { SFX.mute(); toast('Sound off'); }
    saveMeta(); render();
  });
  // browsers only allow audio after a tap or key press, so warm it up on the first one
  const warm = () => SFX.wake();
  document.addEventListener('pointerdown', warm, true);
  document.addEventListener('keydown', warm, true);
  document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { ui.tab = b.dataset.tab; ui.armed = null; renderSheet(); } });
  $('sheetBody').addEventListener('click', live(e => {
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    if (d.w != null) { selectWord(+d.w); closeSheet(); commit(); return; }
    if (d.gsec) { if (ui.gsec !== d.gsec) ui.sel.clear(); ui.gsec = d.gsec; SFX.play('tick'); renderSheet(); return; }
    if (d.gpick != null) { toggleTile(+d.gpick); return; }
    if (d.gclear) { ui.sel.clear(); renderSheet(); return; }
    if (d.gcheck) { submitGroup(); return; }
    if (d.ladder) { dispatch('buy', { what: d.ladder, sec: ui.gsec }); return; }
    if (d.gclue != null || d.gjump != null) { selectWord(+(d.gclue ?? d.gjump)); closeSheet(); commit(false); centerOn(ui.cell, true); return; }
    if (d.copy) { copyText(inviteUrl()); return; }
    if (d.share) { navigator.share({ title: 'Crossfog', text: `Join my Crossfog game. Code ${net.game.code}`, url: inviteUrl() }).catch(() => {}); return; }
    if (d.font) M.font = d.font;
    if (d.tiles) M.tiles = d.tiles;
    if (d.av != null) { net.setAvatar(d.av || null).then(() => render()).catch(err => toast(err.message)); }
    if (d.sound) { M.sound = d.sound === 'on'; if (M.sound) SFX.play('coin'); else SFX.mute(); }
    if (d.leave) {
      if (net.mode === 'shared' && ui.armed !== 'leave') { ui.armed = 'leave'; renderSheet(); return; }
      leave(); return;
    }
    if (d.reset) {
      if (ui.armed !== 'reset') { ui.armed = 'reset'; renderSheet(); return; }
      ui.armed = null; net.reset(); closeSheet(); start(net); toast('Fresh board'); return;
    }
    saveMeta(); render();
  }));
  $('winClose').addEventListener('click', () => { $('winModal').hidden = true; });
  $('winAgain').addEventListener('click', () => { $('winModal').hidden = true; if (net.mode === 'solo') { net.reset(); start(net); } else leave(); });

  // lobby
  $('newShared').addEventListener('click', () => { const n = nameOrComplain(); if (n) openShared({ name: n, create: true }); });
  $('joinBtn').addEventListener('click', () => {
    const n = nameOrComplain(); if (!n) return;
    const c = $('codeInput').value.trim().toUpperCase();
    if (c.length < 4) { $('lobbyError').hidden = false; $('lobbyError').textContent = 'Enter the game code your friend sent you.'; return; }
    openShared({ code: c, name: n });
  });
  $('lobbyForm').addEventListener('submit', e => {
    e.preventDefault();
    if ($('lobbyJoin').hidden) return; // Enter in the start screen does nothing; pick a button
    const n = nameOrComplain(); if (!n) return;
    openShared({ code: params.get('g'), name: n });
  });
  $('notMine').addEventListener('click', () => { history.replaceState(null, '', location.pathname + (FAKE ? '?fake=1' : '')); lobby('new'); });
  $('soloBtn').addEventListener('click', async () => { store.set('crossfog.last', { mode: 'solo' }); await start(soloGame(B.id)); });

  document.addEventListener('keydown', e => {
    if (!net || !S || !$('lobby').hidden) return;
    if (!$('sheet').hidden || !$('winModal').hidden) { if (e.key === 'Escape') { closeSheet(); $('winModal').hidden = true; } return; }
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input')) return;
    const k = e.key;
    if (/^[a-z]$/i.test(k)) { type(k.toUpperCase()); e.preventDefault(); }
    else if (k === 'Backspace') { back(); e.preventDefault(); }
    else if (k === ' ') { tapCell(ui.cell); e.preventDefault(); }
    else if (k === 'Tab' || k === 'Enter') { gotoNext(e.shiftKey ? -1 : 1); commit(); e.preventDefault(); }
    else if (k === 'ArrowRight') { moveArrow(0, 1); e.preventDefault(); }
    else if (k === 'ArrowLeft') { moveArrow(0, -1); e.preventDefault(); }
    else if (k === 'ArrowDown') { moveArrow(1, 0); e.preventDefault(); }
    else if (k === 'ArrowUp') { moveArrow(-1, 0); e.preventDefault(); }
  });
  const redraw = () => { drawn = ''; themeCache = null; scheduleRender(); };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
  // phones drop sockets in the background; fetch anything missed on return
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') catchUp(); });
  window.addEventListener('online', catchUp);
  setInterval(() => { if (net && net.mode === 'shared' && document.visibilityState === 'visible') catchUp(); }, 30000);
}

async function boot() {
  const DATA = await (await fetch('board.json', { cache: 'no-cache' })).json();
  B = buildBoard(DATA);
  ui.cs = window.innerWidth < 600 ? 34 : 40;
  computeLabelSpots();
  buildKeyboard();
  wire();
  const code = params.get('g');
  const name = store.get('crossfog.name');
  const last = store.get('crossfog.last');
  if (code) {
    if (name && SHARED_READY) openShared({ code, name });
    else lobby('join');
  } else if (last?.mode === 'shared' && last.code && name && SHARED_READY) {
    openShared({ code: last.code, name });
  } else if (last?.mode === 'solo') {
    await start(soloGame(B.id));
  } else {
    lobby('new');
  }
}
// test hook, only with ?fake=1 or ?debug
if (FAKE || params.has('debug')) window.__cf = { S: () => S, q: () => q, B: () => B, net: () => net, type, selectWord, submit: picks => { ui.sel = new Set(picks); submitGroup(); }, ui };
boot().catch(e => { console.error(e); lobby('new', 'Something went wrong loading the game. Try refreshing.'); });
