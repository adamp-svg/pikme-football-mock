# CLAUDE.md — Football Game (Saltiz)

> Auto-loaded for every agent in this repo. These are the user's STANDING rules.
> They are permanent, not per-session. The user has repeated them 4× — don't make it 5.

## The rules (short version)

- **This is the football game for the Saltiz app.** Repo `football-mock`, prod https://pikme-football.onrender.com. App side lives in `pikmeTV-app` / `pikmeTV-saltiz` / `pikme-server`.
- **You are not alone.** Several agents work this repo at the same time. Assume any file may be mid-edit by someone else.
- **Commit everything locally.** Every finished piece of work gets a local commit. Never leave work dangling uncommitted.
- **Never push unless the user asks.** No `git push`, no Render deploy, no cloud trigger — only on an explicit "push" / "deploy" in that message.
- **Render autodeploy is PER SERVICE — check before you assume.** ⚠️ Corrected 2026-07-26 04:20 after a push went live unreviewed: the **API** service `srv-chgb1k67avjbbju8aoig` has `autoDeploy: yes` and its webhook WORKS, so **pushing `pikme-server` IS an immediate production deploy**. Only the **game** service `srv-d9ebcvtaeets73ar91sg` has a dead webhook and needs the CLI. After an approved push: `render deploys create srv-d9ebcvtaeets73ar91sg --confirm` (game) / `srv-chgb1k67avjbbju8aoig` (api). Older docs that state one blanket rule either way — "push IS the deploy" OR "Render never autodeploys" — are both wrong; it depends on the service.
- **Write down every user request.** Short simple bullets in [`AGENT_REQUEST_LOG.md`](AGENT_REQUEST_LOG.md), newest date on top, so another agent can pick up if your session dies. Log it even if you didn't finish.
- **Test on localhost first**, then push to the app / TestFlight only when the user asks.
- **The user's two test surfaces:** browser at **http://10.100.102.36:3012/** (LAN IP — his phone browser hits it too) and a **TestFlight build on the phone**. Bind the dev server so the LAN IP works, and give him that URL, not `localhost`.
- **Open design question → research the big games.** Check what **Brawl Stars, Roblox and Fortnite** do (controls, feel, progression, UI, netcode) and cite that as the reference instead of guessing.

## Bot AI

- **Read [`summery/BOT_HANDOFF.md`](summery/BOT_HANDOFF.md) before any bot work.** It records what
  changed, the measurement harnesses and — most importantly — the things already **measured and
  refuted** (`decisionHz` in seven variants, `mistakeP`, widening `doubleBomb`'s gate, a kicked ball
  chipping a wall). Re-deriving those costs hours.
- **Verify what is actually LIVE before trusting a bug report:**
  `curl -s https://pikme-football.onrender.com/shared/bot-ai.js | grep -c bodyScreen` — `0` means prod
  is stale and the phone is running old bots.
- Measure, don't assert: seed the harness (`state.rng` / `SEED=`), and use `SEEDS=6` on
  `test-bot-ladder.mjs` before quoting a number. Unseeded runs of identical code have reported
  wall-pinning anywhere from 0.27% to 0.51%.

## Working alongside the other agents

- Take an orchestration lock before editing a shared file: `football-mock:<path>`.
- `git status` / `git diff` BEFORE you commit. If a file has changes that aren't yours, leave them alone — commit only your own files. Never revert or stomp work you didn't write.
- Say which files you're taking in your log entry.
- Keep the suite green: `for f in test*.mjs; do node $f; done`. Report real output; list pre-existing fails separately.
- Local test server: `PORT=3012 node server.js`, reached at **http://10.100.102.36:3012/** (`:3010` is the main dev server, `:3011` may be another agent). Node does NOT hot-reload — **restart** after `server.js` / `shared/` changes.

## Where things are

- [`AGENT_RULES.md`](AGENT_RULES.md) — full version of these rules.
- [`AGENT_REQUEST_LOG.md`](AGENT_REQUEST_LOG.md) — request / handoff log.
- [`OPTIMIZATION_TODO.md`](OPTIMIZATION_TODO.md) — prioritized queue for perf / netcode / lag / fps / WebRTC.
- `docs/MECHANICS.md` — shot / super / bomb / body rules reference.
- `summery/` — deep plans (`REACTIVITY_ROADMAP.md`, `WEBRTC_TRANSPORT_PLAN.md`, worktree audit, handoffs).
