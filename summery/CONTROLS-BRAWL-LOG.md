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

## Request 4 — Control-layout EDITOR (Brawl "edit controls") — IN PROGRESS
Verbatim intent:
- (0) Current bomb/wall cluster is too far right; should sit to the LEFT of the aim stick.
- (1) Training mode: option to reposition MOVE, AIM, and SKILL (bomb+wall) buttons.
- (2) Once user repositions a control it is LOCKED to that spot — no more floating/appearing anywhere.
- (3) User can change both POSITION and SIZE.
- (4) A semi-translucent button in the TRAINING area that enters edit mode (like Brawl Stars).

Design:
- Persist layout in localStorage key `fbControls` = {move,aim,bomb,wall:{cx,cy(0-1 frac of vw/vh),size(px),locked}}.
- Edit mode overlay (training only): translucent draggable pucks per control + resize handle; Save/Reset.
- Locked control: stick base renders at fixed anchor (touch in its half drives it, delta from anchor); bomb/wall buttons positioned at anchor+size. Unlocked = current floating behavior.
- STICK_MAX scales with stick size.

Files: index.html (edit btn + overlay), style.css (overlay/puck), client.js (layout load/apply, editor drag/resize, locked-stick input).

STATUS: DONE (localhost, syntax-clean). Needs on-DEVICE feel/visual check (touch).
Implementation:
- localStorage `fbControls` {move,aim,bomb,wall:{cx,cy frac, size px, locked}}. loadCtlLayout/saveCtlLayout/applyCtlLayout/ctlPx/stickSize/stickMax/stickLocked. client.js ~2247.
- (0) Default cluster moved LEFT: bomb right 112px, wall right 124px (style.css).
- (1) Training-only #edit-controls-btn (🎛️ בקרות) toggled with train-tag (client.js ~1595). Opens #controls-editor overlay.
- (2) Save marks every control locked:true → sticks stop floating: touchstart snaps locked base to fixed anchor via claimStick()+ctlPx(); floating fallback = screen-half rule.
- (3) Editor pucks: drag body=move (clamped to viewport), drag .ce-resize corner=resize (btn 44-130, stick 80-190). Per-stick knob travel scales (STICK_RATIO); touchL/R.max replaces global STICK_MAX in updateStick+sampleInput.
- (4) Semi-translucent trigger button in training area (.edit-controls-btn, backdrop-blur).
- Reset button wipes fbControls + inline styles → CSS defaults + floating return. resize listener re-applies.
Verify: node --check OK; localhost:3010 serves all new code. NOT device-tested.
TODO/handoff if reworking: aim-from-fixed-anchor feel (aim dir measured from anchor, not touch origin) may want relative-drag instead — revisit on device. Step B (anchor floating aim by default) now moot: user drives it via editor.

## Commits
- 758f19d feat(controls): Brawl right-thumb cluster (bomb=Super glow, wall=Gadget) + Step C glow wiring.
- 3770153 feat(controls): training-mode Brawl-style control-layout editor (req 0-4). client.js/index.html/style.css.
  NOTE: never staged shared/sim.js or scratch-selbest-test.mjs (other agents).
