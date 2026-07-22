# TASK — Main lobby play strip: 2v2 default position + swipe

**Owner:** agent `lobby` (lock `football-mock:task-lobby-2v2-carousel-position-swipe`)
**Date:** 2026-07-23 (localhost only, committed)

## User request (verbatim intent)
Work on the main lobby. The "play 2v2 / play with friend" row should:
1. Start in the correct position — the **2v2** mode most visible and flush "to the limit" (start edge).
2. Swipe correctly.

## Diagnosis
`#play-strip` (`dir=ltr`, flex row, `overflow-x:auto`) DOM order was:
goal-brawl · tournament · training · play-friends · **arena-2v2 (last)**.
At rest `scrollLeft=0` showed the two "coming soon" pills first; the primary 2v2
button was off-screen to the right. No scroll-snap, no scroll reset.

## Fix (3 edits)
- `public/index.html` — reordered strip children: **arena-2v2 first**, then
  play-friends, training, tournament, goal-brawl (coming-soon last).
- `public/style.css` — added `scroll-snap-type: x proximity` on `#play-strip` and
  `scroll-snap-align: start` on items, so swiping settles on a button.
- `public/client.js` `showScreen()` — on `home`, reset `#play-strip` `scrollLeft=0`
  so it always lands on the 2v2 button.

## Verify
- Served DOM order confirmed via curl :3012 (arena first).
- Files parse. Needs visual/on-device check that swipe reveals friends/training/coming-soon.

## Not touched
Game sim, controls, bomb/wall, other lobby screens — owned by other agents.
