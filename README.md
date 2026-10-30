# Crossfog

A co-op crossword for one to four players. Each section of the board hides a
Connections puzzle: solve the clues, sort the answers into four groups of four,
and name each group's one-word link in the Key Grid. Fill the Key Grid to win.

Players can be on different phones at different times. Moves sync live when
two people are on at once, and a "while you were away" note sums up what
your teammates did since you last looked.

## How it fits together

Static site, no build step. GitHub Pages serves it; Supabase stores games.

| Path | What it is |
| --- | --- |
| `index.html`, `styles.css` | The page and its look |
| `src/engine.js` | The rules. Pure functions, no DOM or network |
| `src/app.js` | The UI: board, Groups tray, Key Grid, lobby |
| `src/sync.js` | Where moves are stored: Supabase, solo (this device), or a fake two-tab server for testing |
| `src/sfx.js` | Synthesized sound effects |
| `board.json` | The puzzle: layout, clues, groups and keys |
| `config.js` | Supabase URL and publishable key |
| `supabase/schema.sql` | Tables, row-level security and join functions |
| `tools/` | Puzzle content (`boards.py`), board generator (`gen2.py`), engine tests |

### Why an event log

The server never stores the board. It stores an append-only list of moves per
game: letters typed, letters erased, group guesses, hint purchases. Every
client replays the list in server order to rebuild the same board, wallet and
fog. That means two people typing at once can't overwrite each other, and
rules like "you can't spend coins you don't have" are applied the same way on
every phone. A full game is a few thousand small rows and replays in a few
milliseconds.

## Setup

1. **Supabase.** Create a project. Under Authentication → Sign In / Providers,
   turn on *Allow anonymous sign-ins*. Run `supabase/schema.sql` in the SQL
   editor. Put the project URL and publishable key in `config.js`.
2. **GitHub Pages.** Settings → Pages → Deploy from a branch → `main`, `/ (root)`.

Players never make an account. The first visit signs them in anonymously, and
that identity lives in the browser. Clearing site data or switching browsers
makes them a new player, so they'd rejoin with the game code and take a new seat.

## Testing locally

```sh
python3 -m http.server 8765
# solo:            http://localhost:8765/
# two-tab shared:  http://localhost:8765/?fake=1   (no Supabase needed)
node tools/engine.test.mjs
```

## Making a new board

Edit the groups in `tools/boards.py`, then run `python3 tools/gen2.py 90` from
`tools/` and copy the resulting `board2.json` over `board.json`. A board's id is
derived from its size, so a new board starts every game fresh.
