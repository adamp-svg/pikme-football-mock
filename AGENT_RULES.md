# 👥 Standing Rules — Football Game (Saltiz)

> Read this first. These are the user's standing instructions for EVERY agent working in this repo.
> They override defaults. Last set: 2026-07-25.

## The rules

- **This is the football game for the Saltiz app** (repo `football-mock`, prod https://pikme-football.onrender.com).
- **You are not alone** — several agents work this repo at the same time. Assume a shared file may be mid-edit by someone else.
- **Commit everything locally.** Every finished piece of work gets a local commit. Don't leave work sitting uncommitted.
- **Never push unless the user asks.** No `git push`, no deploy, no Render trigger, unless the user says so in that message.
- **Write down what you were asked.** Log every user request + what you did in [`AGENT_REQUEST_LOG.md`](AGENT_REQUEST_LOG.md), short bullets, newest date on top — so another agent can pick up if your session dies.

## Working with the other agents

- Take an orchestration lock before editing a shared file: `football-mock:<path>`.
- Before you commit, check `git status` / `git diff` — if a file has changes that aren't yours, leave them alone and commit only your own files.
- Keep the test suite green: `for f in test*.mjs; do node $f; done`.
- Test locally on `PORT=3012 node server.js` (`:3010`/`:3011` may be other agents' servers).

## Where things are

- [`AGENT_REQUEST_LOG.md`](AGENT_REQUEST_LOG.md) — request/handoff log (what was asked, what shipped).
- [`OPTIMIZATION_TODO.md`](OPTIMIZATION_TODO.md) — prioritized queue for perf / netcode / lag / 120Hz / WebRTC.
- `docs/MECHANICS.md` — shot / super / bomb / body rules reference.
- `summery/` — deep plans (REACTIVITY_ROADMAP, WEBRTC_TRANSPORT_PLAN, worktree audit).
