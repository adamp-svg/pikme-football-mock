# CLAUDE.md — Football Game (Saltiz)

> Auto-loaded for every agent in this repo. These are the user's STANDING rules.
> They are permanent, not per-session. The user has repeated them 4× — don't make it 5.

## The rules (short version)

- **This is the football game for the Saltiz app.** Repo `football-mock`, prod https://pikme-football.onrender.com. App side lives in `pikmeTV-app` / `pikmeTV-saltiz` / `pikme-server`.
- **You are not alone.** Several agents work this repo at the same time. Assume any file may be mid-edit by someone else.
- **Commit everything locally.** Every finished piece of work gets a local commit. Never leave work dangling uncommitted.
- **Never push unless the user asks.** No `git push`, no Render deploy, no cloud trigger — only on an explicit "push" / "deploy" in that message.
- **⚠️ NEVER TREAT A PUSH AS "NOT YET A DEPLOY". Measured 2026-07-26 17:1x: prod matched HEAD.** The **API** `srv-chgb1k67avjbbju8aoig` autodeploys — that is confirmed and unchanged (a ~03:00 push was live by 03:11). For the **game** `srv-d9ebcvtaeets73ar91sg` this file said the webhook is dead and a push ships nothing until you run the CLI. What was actually measured today is only this: after a push of `football-mock`, `curl -s https://pikme-football.onrender.com/shared/bot-ai.js | shasum -a 256` came back **byte-identical to local HEAD**, every marker from that day's work live.
  **That proves prod's STATE, not the MECHANISM** — the webhook may be alive again, or somebody may have run `render deploys create`. Nobody has separated the two without touching the Render account, so **do not rewrite this line into either claim.** What follows regardless: the documented assumption "a game push ships nothing" is unsafe, so verify with that curl+shasum instead of trusting any sentence here.
  Also: this repo is pushed **many times a day as a matter of course** — 117 push entries over the eight days to 2026-07-26 — so **a commit typically reaches prod within the hour whether or not the agent that wrote it pushes. The decision point is the COMMIT, not the push.** Manual deploy, still the fallback: `render deploys create srv-d9ebcvtaeets73ar91sg --confirm` (game) / `srv-chgb1k67avjbbju8aoig` (api).
  **And a warning about the evidence in this repo:** commit MESSAGES are not evidence about diffs here. `9339cee` is titled "re-probe the Render webhook" and its diff is match-info / bot-dossier / 3v3 work with nothing webhook-related in it — the staging hazard above means titles and contents come apart routinely. Read the diff.
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

## Icon and emote assets

- **Read
  [`public/assets/pixel-icon-system-01/ASSET_HANDOFF.md`](public/assets/pixel-icon-system-01/ASSET_HANDOFF.md)
  before adding or integrating artwork.**
- `ASSET_REGISTRY.json` is the complete generated inventory: 96 assets are
  `live`; 64 expansion icons/emotes are `future` until runtime mapping exists.
- Never rename an established semantic ID or hand-edit the generated registry.
  Follow `GRAPHIC_LANGUAGE.md` and `NEW_ASSET_TEMPLATE.md`, then run
  `node scripts/validate-icon-assets.mjs --write` and the validator/tests.

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
