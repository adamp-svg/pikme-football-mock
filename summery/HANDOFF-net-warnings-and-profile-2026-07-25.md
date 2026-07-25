# HANDOFF (tracked copy / pointer) — connection warnings + profile, 2026-07-25

**Agent:** `rules-scribe-4` · **Full handoff:** `../../summery/HANDOFF-net-warnings-and-profile-2026-07-25.md`
(that is `pikeme/summery/`, the cross-repo folder — it is NOT a git repo, so this tracked copy exists
so the information survives inside the repo.)

All my work is committed **locally on `main`**. **Nothing pushed.**

## Done

- **`CLAUDE.md`** (`7906647`) — standing agent rules now auto-load. Root cause of the user having to
  repeat them four times: they lived only in `AGENT_RULES.md` / `AGENT_REQUEST_LOG.md`, which nothing
  loads automatically.
- **Connection / lag warnings — SHIPPED, suite was 38/38 at commit time.**
  `public/net-quality.js` (pure classifier + anti-strobe hysteresis) · `public/net-hud.js`
  (self-injecting HUD) · `test-net-quality.mjs` (46 assertions) · `test-net-hud.mjs` (jsdom) ·
  **+11 lines in `public/client.js`**. Commits `5e39910`, `7514944`, `d309005`, `1409a5e`.
  Spec + plan in `docs/superpowers/`.

## Not started (deliberately)

- **Player profile screen.** Most of it **already exists** (agent `handoff-audit`):
  Mongo db **`production`**, collection **`footballstats`** (`pikme-server/data/footballstats.js:266`),
  endpoints `/handle-user/football/stats` + `/handle-friends/rank`, and
  `pikmeTV-saltiz/app/pages/football-profile.jsx`. **Do not rebuild it.**
  Real gaps: top hero (no per-hero play counter), card stats, current bot level, friends count.
  **Blocked on two user answers:** what "total score" means, and whether rank should sort by trophies
  instead of `xp`.

## Read before shipping

1. **The warning's markup and CSS are inside `public/net-hud.js`**, not `index.html`/`style.css` —
   those were lock-held by other agents, so the HUD injects its own DOM and `<style>` (`.nq-*`, no
   collisions). Deviation from the written plan, on purpose.
2. **Do NOT add a packet-loss %.** WebSocket is TCP; loss is retransmitted, never missing. It surfaces
   as jitter and gaps, which is what the classifier uses. Only WebRTC/UDP would make a loss number real.
3. **`net-hud.js` uses z-index 6/7** while the rest of `style.css` uses 80–9999 — the bars may be
   hidden behind overlays/modals. **Needs a visual check** (`?netsim=fair|poor|stalled`, `?debug=net`).
4. **Thresholds are estimates**, not measured against real player traffic — retune `NET_T` in
   `public/net-quality.js`.
5. **`shared/trophies.js` → `shared/rank.js`** and `public/hub-trophies.js` → `public/hub-rank.js`
   (renamed by another agent mid-session). Older docs referencing the old paths are stale.
6. **Suite is currently 40 pass / 2 fail — neither failure is mine.** `test-hub-rank.mjs` did not exist
   at my last commit (another agent's unfinished work); `test-mode-format.mjs` needs a server on
   `:3013` and passed in my run. Verify both before shipping.
