# CLAUDE.md — Football Game (Saltiz)

> Auto-loaded for every agent in this repo. These are the user's STANDING rules.
> They are permanent, not per-session. The user has repeated them 4× — don't make it 5.

## The rules (short version)

- **This is the football game for the Saltiz app.** Repo `football-mock`, prod https://pikme-football.onrender.com. App side lives in `pikmeTV-app` / `pikmeTV-saltiz` / `pikme-server`.
- **You are not alone.** Several agents work this repo at the same time. Assume any file may be mid-edit by someone else.
- **Commit everything locally.** Every finished piece of work gets a local commit. Never leave work dangling uncommitted.
- **Never push unless the user asks.** No `git push`, no Render deploy, no cloud trigger — only on an explicit "push" / "deploy" in that message.
- **Write down every user request.** Short simple bullets in [`AGENT_REQUEST_LOG.md`](AGENT_REQUEST_LOG.md), newest date on top, so another agent can pick up if your session dies. Log it even if you didn't finish.

## Working alongside the other agents

- Take an orchestration lock before editing a shared file: `football-mock:<path>`.
- `git status` / `git diff` BEFORE you commit. If a file has changes that aren't yours, leave them alone — commit only your own files. Never revert or stomp work you didn't write.
- Say which files you're taking in your log entry.
- Keep the suite green: `for f in test*.mjs; do node $f; done`. Report real output; list pre-existing fails separately.
- Local test server: `PORT=3012 node server.js` (`:3010` is the main dev server, `:3011` may be another agent). Node does NOT hot-reload — **restart** after `server.js` / `shared/` changes.

## Where things are

- [`AGENT_RULES.md`](AGENT_RULES.md) — full version of these rules.
- [`AGENT_REQUEST_LOG.md`](AGENT_REQUEST_LOG.md) — request / handoff log.
- [`OPTIMIZATION_TODO.md`](OPTIMIZATION_TODO.md) — prioritized queue for perf / netcode / lag / fps / 120Hz / WebRTC.
- `docs/MECHANICS.md` — shot / super / bomb / body rules reference.
- `summery/` — deep plans (`REACTIVITY_ROADMAP.md`, `WEBRTC_TRANSPORT_PLAN.md`, worktree audit, handoffs).
