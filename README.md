# ⚽ Football mock

Throwaway prototype to test the **look & feel** of a realtime 2v2 football
minigame before we embed it in the pikmeTV app.

## Architecture (same as the planned app design)

- **`shared/sim.js`** — authoritative football physics (players + ball + goals).
  Pure JS, runs on the **server** (source of truth) and the **client** (to
  predict your own movement so it feels instant).
- **`server.js`** — Node game server. Runs one match room at 30Hz, broadcasts
  state snapshots, fills empty slots with **bots** so you can test solo. Also
  serves the web game statically.
- **`public/`** — the game itself (Phaser-free plain canvas for now): input,
  client prediction, entity interpolation, rendering.

The only thing that changes for the app later: the `public/` game gets loaded
inside a WebView instead of a browser tab. Server + sim stay as-is.

## Run

```bash
cd football-mock
npm install
npm start
```

Then open **http://localhost:3010**

- Play **solo** → the other 3 slots are bots.
- Open the URL in **4 tabs** → 4 real players (bots fill any gap).

## Controls

- **Desktop:** `WASD` move · **mouse** aim · **click / space** shoot.
- **Touch:** left half = move stick · right half = aim stick, **release to shoot**.

## Tuning the feel

Everything lives in `shared/constants.js` — player `speed`/`shot`, `BALL_FRICTION`,
`KICK_RANGE`, `MATCH_DURATION`, etc. Change a number, restart, re-feel.
