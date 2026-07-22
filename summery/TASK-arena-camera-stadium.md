# TASK: Arena camera + stadium (agent: arena)

Owner: arena agent. All work LOCAL, commit everything. Handoff so another agent can resume.

## User request (verbatim intent)
Working on the ARENA:
1. When player goes toward the goal, camera pans further to reveal more of the goal and the net.
2. Camera should always pan to show AT MOST half the size of the THIRD row of the stadium.
3. Stadium should have 3 rows of seats. Each seat = size of an audience card.
4. Stadium stands should have the 6 special seats for players' power cards; missing cards => empty seats.

## Region owned
football-mock/public/client.js lines ~2396-2845 (CAM_ZOOM, camera consts, updateCamera,
stadium seating consts, buildAudienceSeats, drawSeat/drawSeatChairs, drawPlayerSeats).
NOT touching lobby/power-slot region (owned by opus-lobby).

## Plan / status  (DONE — committed locally)
- [x] Req3: ROWS 5 -> 3; AUD.seatW/H = 72/92 (= cardW/H). client.js:2418-2419
- [x] Req2: updateCamera clamps X/Y to CAM_BACK/CAM_BAND (2.5*ROW+LANE = wall + half of 3rd row). client.js:2466-2469
- [x] Req1: goal-lead — target pushed toward goal over final 32% of pitch, LEAD_MAX=NET+0.6*CAM_BACK, bounded by clamp. client.js:2456-2467
- [x] Req4: 6 special seats already present (drawPlayerSeats n=3 home loadout + 3 opp empty). No change needed. client.js:2819

## Round 2 — audience (committed locally)
User req: (1) fill ∝ card count assuming 800-seat stadium; (2) audience = players' albums;
(3) rarest cards in front; (4) async jumping + a wave.
Decision (user): keep seats as-is (~228), scale fill as a RATIO vs the conceptual 800.
- [x] audiencePool(): every player's album (matchRoster + mine, no cross-player dedup), 1 seat/card, rarity-first. client.js ~2768
- [x] Fill ratio = cards/800 × actual seats (400 cards => 114/228 ≈ half). client.js ~2836
- [x] Rarest → nearest-pitch seats (front rows). client.js ~2842
- [x] Wave: seat.layer bucketed by world-X; drawAudience adds one-sided travelling crest (Mexican wave) + existing async per-layer bob. client.js ~2830, ~2922
Verified: node -c OK; ratio table 50→400 cards→114 seats (50%).
Note: seat geometry yields ~228 seats total (3 card-sized rows) — 800 is conceptual only.

## Verification
- node -c public/client.js => SYNTAX OK.
- BACK/BAND (full 3-row depth) still drive bgCanvas/renderBackground/drawStands/bakeAudience — only the CAMERA clamp uses CAM_*. Whole bowl still renders; camera just stops at half the 3rd row.
- Visual (canvas) not yet driven on-device; needs a live match to confirm framing feel.

## Notes
- Prior camera goal-lead was reverted once (regressed framing) — re-add conservatively, clamp-bounded.
- Seat size change increases bowl footprint; CAM_BACK/BAND derive from ROW_X/ROW_Y so they track automatically.
