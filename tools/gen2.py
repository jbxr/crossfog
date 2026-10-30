"""Crossfog board generator, Connections edition.

Main board: four sections in a chain. Each section places all 16 of its words.
A section's first word crosses exactly one word of its parent; the rest cross
only their own section, so the section graph is exactly the declared chain.
Key Grid: a separate small crossword of the 16 group keys, placed below the
main board with a clear gap so it never touches section tiles.
"""
import json, random, sys, time
from boards import SECTIONS, META

DIRS = {"A": (0, 1), "D": (1, 0)}
SPREAD = 12
BUDGET_S = float(sys.argv[1]) if len(sys.argv) > 1 else 60


class Board:
    def __init__(self):
        self.cells, self.owner, self.by_region, self.words = {}, {}, {}, []

    def can_place(self, ans, r, c, d, allowed):
        dr, dc = DIRS[d]
        pr, pc = dc, dr
        if (r - dr, c - dc) in self.cells or (r + dr * len(ans), c + dc * len(ans)) in self.cells:
            return None
        crosses = []
        for i, ch in enumerate(ans):
            p = (r + dr * i, c + dc * i)
            if p in self.cells:
                if self.cells[p] != ch: return None
                own = self.owner[p]
                if d in own: return None
                other = next(iter(own.values()))
                if self.words[other]["region"] not in allowed: return None
                crosses.append(other)
            else:
                for s in (1, -1):
                    if (p[0] + pr * s, p[1] + pc * s) in self.cells: return None
        return crosses

    def place(self, w, r, c, d):
        idx = len(self.words)
        dr, dc = DIRS[d]
        for i, ch in enumerate(w["answer"]):
            p = (r + dr * i, c + dc * i)
            self.cells[p] = ch
            self.owner.setdefault(p, {})[d] = idx
            self.by_region.setdefault(w["region"], set()).add(p)
        self.words.append(dict(w, r=r, c=c, dir=d))
        return idx

    def candidates(self, ans, region):
        out = []
        for (r, c) in self.by_region.get(region, ()):
            ch = self.cells[(r, c)]
            for i, a in enumerate(ans):
                if a == ch:
                    for d in "AD":
                        dr, dc = DIRS[d]
                        out.append((r - dr * i, c - dc * i, d))
        return out

    def centroid(self, region):
        ps = self.by_region[region]
        return sum(p[0] for p in ps) / len(ps), sum(p[1] for p in ps) / len(ps)

    def spot(self, ans, src, allowed, target, rnd, bridge=False):
        best = None
        for (r, c, d) in self.candidates(ans, src):
            x = self.can_place(ans, r, c, d, allowed)
            if not x or (bridge and len(x) != 1): continue
            dr, dc = DIRS[d]
            mr, mc = r + dr * (len(ans) - 1) / 2, c + dc * (len(ans) - 1) / 2
            dist = ((mr - target[0]) ** 2 + (mc - target[1]) ** 2) ** .5
            score = -dist + rnd.random() if bridge else -dist * 1.2 + 7 * (len(x) - 1) + rnd.random() * 2.5
            if best is None or score > best[0]:
                best = (score, r, c, d)
        return best


def fill(b, words, rid, target, rnd):
    pending = words
    for _ in range(4):
        left = []
        for w in pending:
            s = b.spot(w["answer"], rid, {rid}, target, rnd)
            if s: b.place(w, s[1], s[2], s[3])
            else: left.append(w)
        pending = left
        if not pending: return True
    return False


def snapshot(b):
    return ({**b.cells}, {k: dict(v) for k, v in b.owner.items()}, {k: set(v) for k, v in b.by_region.items()}, list(b.words))


def restore(b, s):
    b.cells, b.owner, b.by_region, b.words = {**s[0]}, {k: dict(v) for k, v in s[1].items()}, {k: set(v) for k, v in s[2].items()}, list(s[3])


def build_main(seed):
    rnd = random.Random(seed)
    b = Board()
    for sec in SECTIONS:
        snap = snapshot(b)
        for attempt in range(40):
            if attempt: restore(b, snap)
            if place_section(b, sec, rnd): break
        else:
            return None
    return b


def place_section(b, sec, rnd):
        rid = sec["id"]
        words = [dict(answer=a, clue=cl, region=rid, group=gi) for gi, g in enumerate(sec["groups"]) for a, cl in g["words"]]
        rnd.shuffle(words)
        if sec["parent"] is None:
            target = (0.0, 0.0)
            w = max(words[:4], key=lambda w: len(w["answer"]))
            words.remove(w)
            b.place(w, 0, -(len(w["answer"]) // 2), "A")
        else:
            pr, pc = b.centroid(sec["parent"])
            target = (pr + sec["dir"][0] * SPREAD, pc + sec["dir"][1] * SPREAD)
            opts = []
            for i, w in enumerate(words):
                s = b.spot(w["answer"], sec["parent"], {sec["parent"]}, target, rnd, bridge=True)
                if s: opts.append((s[0], i, s))
            if not opts: return False
            opts.sort(key=lambda o: -o[0])
            _, i, s = opts[min(len(opts) - 1, int(rnd.random() ** 2 * 3))]
            b.place(words.pop(i), s[1], s[2], s[3])
        return fill(b, words, rid, target, rnd)


def build_meta(seed):
    rnd = random.Random(seed)
    b = Board()
    keys = [dict(answer=g["key"], clue=g["hint"], region="meta", gid=f"{s['id']}-{gi}")
            for s in SECTIONS for gi, g in enumerate(s["groups"])]
    rnd.shuffle(keys)
    first = max(keys, key=lambda k: len(k["answer"]) + rnd.random())
    keys.remove(first)
    b.place(first, 0, 0, "A")
    return b if fill(b, keys, "meta", (0.0, 3.0), rnd) else None


def area(b):
    rows = [p[0] for p in b.cells]; cols = [p[1] for p in b.cells]
    return (max(rows) - min(rows) + 1) * (max(cols) - min(cols) + 1), min(rows), min(cols), max(rows), max(cols)


def score(b, wa=.08):
    a = area(b)[0]
    multi = sum(1 for o in b.owner.values() if len(o) == 2)
    return multi * 10 - a * wa


def search(builder, budget, wa):
    t0, best, tried, ok, seed = time.time(), None, 0, 0, 0
    while time.time() - t0 < budget:
        seed += 1; tried += 1
        b = builder(seed)
        if not b: continue
        ok += 1
        sc = score(b, wa)
        if best is None or sc > best[0]: best = (sc, b)
    print(f"{builder.__name__}: tried {tried} ok {ok}", file=sys.stderr)
    return best[1] if best else None


main = search(build_main, BUDGET_S * .8, .08)
meta = search(build_meta, BUDGET_S * .2, .6)
if not main or not meta:
    print("generation failed", file=sys.stderr); sys.exit(1)

_, r0, c0, r1, c1 = area(main)
_, mr0, mc0, mr1, mc1 = area(meta)
W = max(c1 - c0, mc1 - mc0) + 1
# meta sits under the main board, horizontally centred, with a 4-row gap
dy = (r1 - r0) + 5 - mr0
dx = ((c1 - c0) - (mc1 - mc0)) // 2 - mc0
words = []
for w in main.words:
    words.append(dict(w, r=w["r"] - r0, c=w["c"] - c0))
for w in meta.words:
    words.append(dict(w, r=w["r"] + dy, c=w["c"] + dx))
H = max(w["r"] + (len(w["answer"]) if w["dir"] == "D" else 1) for w in words)
W = max(W, max(w["c"] + (len(w["answer"]) if w["dir"] == "A" else 1) for w in words))

# numbering: main board and Key Grid each count from 1
for part in ("main", "meta"):
    ws = [w for w in words if (w["region"] == "meta") == (part == "meta")]
    starts = sorted({(w["r"], w["c"]) for w in ws})
    num = {p: i + 1 for i, p in enumerate(starts)}
    for w in ws: w["num"] = num[(w["r"], w["c"])]

grid = [["." for _ in range(W)] for _ in range(H)]
for w in words:
    dr, dc = DIRS[w["dir"]]
    for i, ch in enumerate(w["answer"]):
        grid[w["r"] + dr * i][w["c"] + dc * i] = ch
print(f"size {W}x{H}, words {len(words)}", file=sys.stderr)
print("\n".join("".join(r) for r in grid), file=sys.stderr)

out = dict(
    width=W, height=H, seedRegion=SECTIONS[0]["id"],
    regions=[dict(id=s["id"], name=s["name"], tint=s["tint"], parent=s["parent"], root=s["root"], motif=s["motif"], pattern=s.get("pattern", "")) for s in SECTIONS]
            + [dict(id=META["id"], name=META["name"], tint=META["tint"], parent=None, root=META["root"], motif=META["motif"])],
    groups=[dict(id=f"{s['id']}-{gi}", region=s["id"], index=gi, key=g["key"], hint=g["hint"],
                 members=[a for a, _ in g["words"]]) for s in SECTIONS for gi, g in enumerate(s["groups"])],
    words=words,
)
json.dump(out, open("board2.json", "w"))
