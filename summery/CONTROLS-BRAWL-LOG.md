# Task: Brawl-Stars-like controls (agent: opus-controls)

**Branch:** feat/build-bomb-cancel · **Scope (locked):** public/style.css, public/client.js, public/index.html
**Do NOT touch:** shared/sim.js (other agent). Commit ONLY my 3 files. Localhost only.

## Requests (verbatim intent, newest last)
1. Research the football game's control positions; compare to Brawl Stars. Want a better location for bomb & wall. — DONE: moved 💣/🧱 from top-right corner to bottom-right thumb cluster (style.css).
2. "i want like brawlstar" — research what BS does, explain, suggest how to match. — DONE (research delivered): BS = movement joystick left (lockable); attack = anchored button, tap=auto-aim / drag=manual; super = button beside attack, glows when charged; gadget = smaller button above; all clustered on right-thumb arc, nothing in corners.
3. Take a locked task, other agents concurrent, all changes localhost, commit everything, keep this log for handoff.

## Plan (Brawl parity) — status
- [x] A. CSS cluster: bomb=Super (82px round, ready-glow pulse), wall=Gadget (58px round, above+inset). style.css L124-150.
- [ ] B. Anchor aim/shoot stick to fixed bottom-right ring (client.js touchstart ~2232). Input change — needs on-device feel check. NOT STARTED.
- [x] C. Bomb .ready glow toggle wired to cooldown (client.js ~3701).

## Verified
- node --check client.js OK; localhost:3010 GET / 200; style.css+client.js serve the new code.
- NOT verified: touch ergonomics/feel (needs device). Step B intentionally deferred.

## Handoff notes
- Lock via agent-orchestration MCP on the 3 files; refresh every <5min (auto-expire 300s).
- Current relevant state: bomb .special-btn / wall .build-btn already moved to right-edge bottom cluster (right:14px; bottom:96/180px).
- If I fail: continue from unchecked box above; commit only public/* files touched.

## Commits
(none yet)
