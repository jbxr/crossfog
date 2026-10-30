// Builds a realistic mid-game event log (typos, erasures, groups) for perf checks.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildBoard, replay, queries } from '../src/engine.js';
const B = buildBoard(JSON.parse(readFileSync(new URL('../board.json', import.meta.url))));
const log = []; let n = 0;
const ev = (t, p) => ({ key: `k${++n}`, id: n, uid: 'me', at: new Date(1e12 + n * 9e3).toISOString(), t, ...p });
const typeWord = wi => B.WORDS[wi].cells.forEach((k, i) => {
  for (let j = 0; j < 2; j++) { log.push(ev('fill', { k, ch: 'Q' })); log.push(ev('erase', { k })); }
  log.push(ev('fill', { k, ch: B.CELLS[k].ch }));
});
for (let round = 0; round < 3; round++) {
  const S = replay(B, log), q = queries(B, S);
  for (const r of B.SECTIONS.slice(0, 3)) {
    if (!q.regionOpen(r)) continue;
    B.REGION_WORDS[r].forEach(wi => { if (!q.isSolved(wi)) typeWord(wi); });
    B.SECTION_GROUPS[r].forEach(gid => log.push(ev('group', { picks: B.REGION_WORDS[r].filter(wi => B.WORDS[wi].gid === gid) })));
  }
}
const S = replay(B, log);
console.log('events', log.length, 'solved', S.solved.size, 'found', S.found.length);
writeFileSync(process.argv[2], JSON.stringify({ boardId: B.id, log }));
