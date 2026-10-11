# ♞ CHESS-IO

**You vs. the world-champion chess engine — right in your browser.**

CHESS-IO pits you against **Stockfish 10**, the legendary chess AI that crushes grandmasters. Four difficulties take you from friendly learning games to a grandmaster-killer that will humble you.

Live: `https://amanxdev0.github.io/chess-io/` (after Pages is enabled)

## Features

- **Real Stockfish AI** — the actual world-champion engine (WASM build) thinking in your browser, not a toy minimax
- **4 difficulties**: 😊 Easy → 🙂 Medium → 😠 Hard → 💀 Impossible (full-strength Stockfish)
- **Full chess rules** — castling, en passant, promotion picker, check/checkmate/stalemate, 50-move rule, threefold repetition, insufficient material
- **Play as White or Black**, flip board anytime
- **Chess clocks** — 5 / 10 / 15 min or untimed, with low-time warnings
- **Undo** (takes back your last move + the AI's reply), **Hint** (Stockfish suggests a move), **Resign**
- Move history in standard notation, captured pieces, live material count
- Legal-move dots, last-move + check highlights
- Retro sound effects (WebAudio, zero assets) · mobile-friendly tap controls
- **Offline-safe**: if the engine can't load, a built-in local AI keeps the game playable

## How the AI works

Your move is sent to Stockfish as a FEN position; it replies with its chosen move via the UCI protocol. Difficulty maps to Stockfish's `Skill Level` (0–20) plus search depth:

| Difficulty | Skill | Depth | What it feels like |
|---|---|---|---|
| Easy | 3 | 6 | Learning mode — beatable, makes human-ish mistakes |
| Medium | 9 | 10 | Solid club player |
| Hard | 15 | 14 | Expert — punishes every slip |
| Impossible | 20 | 22 | Full Stockfish. Good luck. |

The engine loads from CDN at runtime (`stockfish.js` is GPLv3 — this repo ships no engine code, only links to it). Game rules are handled by `chess.js` (MIT).

## Run locally

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then open `http://localhost:8000`. (Needs internet on first load for the CDN libraries + engine.)

## Structure

```
index.html       — board, side panel, modals
css/style.css    — dark arena theme
js/game.js       — UI + clocks + Stockfish wiring + fallback AI
```

## License

MIT © 2026 Aman Singh
