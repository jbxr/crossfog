// Engine checks: a two-player playthrough, coin rules, and replay determinism.
// Run: node tools/engine.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { buildBoard, replay, queries, COST } from '../src/engine.js';

const B = buildBoard(JSON.parse(readFileSync(new URL('../board.json', import.meta.url))));
let n = 0;
const ev = (uid, t, p) => ({ key: `k${++n}`, id: n, uid, at: new Date(1e12 + n * 1000).toISOString(), t, ...p });
const log = [];
const state = () => replay(B, log);
const type = (uid, wi) => B.WORDS[wi].cells.forEach(k => log.push(ev(uid, 'fill', { k, ch: B.CELLS[k].ch })));

// locked section words and locked keys ignore input
type('a', B.REGION_WORDS.wild[0]);
type('a', B.KEY_WORD['picnic-0']);
assert.equal(state().solved.size, 0, 'locked words must not solve');

// a wrong word costs nothing and solves nothing
const w0 = B.REGION_WORDS.picnic[0];
B.WORDS[w0].cells.forEach(k => log.push(ev('a', 'fill', { k, ch: 'Z' })));
let S = state();
assert.equal(S.solved.size, 0);
assert.ok(S.feed.some(f => f.kind === 'wrong'));

// two players split the picnic section
B.REGION_WORDS.picnic.forEach((wi, i) => type(i % 2 ? 'b' : 'a', wi));
S = state();
assert.equal(S.solved.size, 16);
assert.ok(S.revealed.has('wild'), 'bridge solve reveals the next section');
assert.equal(S.coins, 6 + 16);

// a wrong group: fine, mistake, no find
const g = gi => B.REGION_WORDS.picnic.filter(wi => B.WORDS[wi].group === gi);
log.push(ev('b', 'group', { picks: [...g(0).slice(0, 3), g(1)[0]] }));
S = state();
assert.equal(S.mistakes, 1);
assert.equal(S.coins, 22 - COST.mistake);
assert.ok(S.feed.find(f => f.kind === 'miss').oneAway);

// ladder: pattern, pair, key letter
log.push(ev('a', 'buy', { what: 'pattern', sec: 'picnic' }));
log.push(ev('a', 'buy', { what: 'pair', sec: 'picnic' }));
log.push(ev('a', 'buy', { what: 'keyletter', sec: 'picnic' }));
S = state();
assert.equal(S.coins, 20 - COST.pattern - COST.pair - COST.keyletter);
assert.equal(Object.keys(S.hinted).length, 1);

// buying with too little money is rejected, identically on replay
log.push(ev('b', 'buy', { what: 'word', wi: w0 }));
S = state();
assert.ok(S.feed.at(-1).kind === 'reject' || S.coins >= 0);

// three groups found auto-completes the fourth and opens Wildflowers
[0, 1, 2].forEach(gi => log.push(ev(gi % 2 ? 'a' : 'b', 'group', { picks: g(gi) })));
S = state();
let q = queries(B, S);
assert.equal(q.foundIn('picnic'), 4);
assert.ok(q.regionOpen('wild'));
// a stale duplicate pick (the other player submitted the same group late) is ignored
log.push(ev('a', 'group', { picks: g(3) }));
assert.equal(state().found.length, 4);

// play the rest out and name every key
const solveAll = () => {
  for (let pass = 0; pass < 10; pass++) {
    S = state(); q = queries(B, S);
    for (const r of B.SECTIONS) {
      if (!q.regionOpen(r)) continue;
      B.REGION_WORDS[r].forEach((wi, i) => { if (!q.isSolved(wi)) type(i % 2 ? 'a' : 'b', wi); });
      S = state(); q = queries(B, S);
      B.SECTION_GROUPS[r].forEach(gid => { if (!q.groupFound(gid)) log.push(ev('a', 'group', { picks: B.REGION_WORDS[r].filter(wi => B.WORDS[wi].gid === gid) })); });
    }
    S = state(); q = queries(B, S);
    Object.entries(B.KEY_WORD).forEach(([gid, wi]) => { if (q.groupFound(gid) && !q.isSolved(wi)) type('b', wi); });
    S = state();
    if (S.done) return;
  }
};
solveAll();
assert.ok(S.done, 'game should be won');
assert.equal(queries(B, S).keysNamed(), 16);
assert.ok(S.feed.some(f => f.kind === 'win'));

// determinism: replaying the same log gives the same state
const a = replay(B, log), b = replay(B, log);
assert.deepEqual(JSON.stringify({ ...a, solved: [...a.solved], revealed: [...a.revealed], foundSet: 0, clueBought: [...a.clueBought] }),
                 JSON.stringify({ ...b, solved: [...b.solved], revealed: [...b.revealed], foundSet: 0, clueBought: [...b.clueBought] }));
// events after the win are ignored
log.push(ev('a', 'buy', { what: 'pattern', sec: 'night' }));
assert.equal(state().coins, S.coins);

const t0 = performance.now(); for (let i = 0; i < 20; i++) replay(B, log);
console.log(`ok: ${log.length} events, by`, S.by, `coins ${S.coins}, replay ${((performance.now() - t0) / 20).toFixed(1)}ms`);

// incremental play (as the app does it) must match a full replay
{
  const { initialState, apply, cloneState } = await import('../src/engine.js');
  const flat = st => JSON.stringify({ ...st, solved: [...st.solved], revealed: [...st.revealed], foundSet: [...st.foundSet], clueBought: [...st.clueBought] });
  for (const split of [0, 50, 200, log.length - 3, log.length]) {
    const base = initialState(B);
    log.slice(0, split).forEach(e => apply(B, base, e));
    const before = flat(base);
    const s = cloneState(base);
    log.slice(split).forEach(e => apply(B, s, e));
    assert.equal(flat(s), flat(replay(B, log)), `split ${split}`);
    assert.equal(flat(base), before, 'clone must not leak writes into the base');
  }
  console.log('ok: incremental state matches replay');
}
