# Player communication set

The communication system is intentionally text-free and language-independent.
It uses the same chunky pixel language as the rest of the game.

## Recommended in-match wheels

### Tactical wheel — team-only

Keep these eight one gesture away:

1. `call-pass`
2. `call-shoot`
3. `call-defend`
4. `call-attack`
5. `call-left`
6. `call-right`
7. `call-wait`
8. `call-help`

The extended team page holds ready, mark, goalkeeper, spread, group, and
retreat. Tactical calls should never be shown to opponents during active play.

### Social wheel — visible to everyone

Default eight:

1. `emote-wave`
2. `emote-thumbs-up`
3. `emote-clap`
4. `emote-good-game`
5. `emote-sorry`
6. `emote-thanks`
7. `emote-wow`
8. `emote-celebrate`

Laugh, angry, confused, nervous, fire, heart, and MVP belong in the expanded
customizable wheel.

## Display behavior

- Show an emote above the player for about **2.2 seconds**.
- Tactical calls also create a small directional HUD ping for teammates.
- Allow one send every **1.5 seconds**.
- After three sends in six seconds, apply a short cooldown.
- Collapse duplicate team calls instead of stacking them.
- Never cover the ball, goal, score, or aiming controls.
- Mirror left/right calls only when the game camera itself is mirrored.

## Safety and accessibility

- Include one-tap **mute emotes** and per-player block.
- Keep tactical calls available when social emotes are muted.
- Do not attach audio by default; haptics should be subtle and local.
- Preserve semantic IDs for screen-reader labels supplied by the surrounding UI.
- Do not use red/green color alone to distinguish meanings.
- Rate-limit `emote-laugh` and `emote-angry` more aggressively after goals.
