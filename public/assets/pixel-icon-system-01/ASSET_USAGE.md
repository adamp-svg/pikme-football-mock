# Per-asset usage instructions

Use the semantic ID, not the old emoji, when adding new UI. Runtime classes are
`saltiz-icon si-<id>`. The compatibility layer converts legacy text
automatically, but new code should call `SaltizIcons.icon(id)` or use the class
directly.

## Lobby and navigation

| Asset | Instruction |
| --- | --- |
| `play` | Primary match start, quick match, and generic football-play entry. |
| `shop` | Shop navigation and storefront entry only. |
| `news` | News, announcements, patch notes, and inbox-style updates. |
| `rank` | Generic rank entry; use tier assets for an earned rank. |
| `friends` | Friends list, party, or playing with friends. |
| `club` | Club home, club membership, and club features. |
| `settings` | Settings or pause-settings entry; do not use for builder tools. |
| `cards` | Card collection, deck, album, or card news. |
| `arena` | Game-mode picker, arena picker, or controller-based modes. |
| `training` | Training ground and target practice. |
| `field-builder` | Open the field builder or represent builder news. |
| `tournament` | Tournament, cup, seasonal competition, or best-result mode. |
| `best-loadout` | Auto-equip or calculate the best three-card loadout. |
| `hero-outfit` | Wardrobe, hero appearance, or costume selection. |
| `back` | Return to the previous page; mirror only where RTL direction requires. |
| `close` | Close a sheet/modal or remove a participant; not a destructive clear-all. |

## Gameplay and HUD

| Asset | Instruction |
| --- | --- |
| `bomb` | Bomb special button, bomb cooldown, and bomb configuration. |
| `build-wall` | Player wall power and its cooldown; not a permanent arena wall. |
| `power-kick` | Kick charge, shot power, and kick-enhancing cards. |
| `speed` | Movement-speed power, sprint, or speed cards. |
| `defense` | Defense, recovery, durability, or utility cooldown power. |
| `hidden` | Bush stealth or hidden-player state only. |
| `move-joystick` | Movement control, not the builder object-move tool. |
| `aim` | Aim control, reticle, target lock, or accuracy. |
| `sound-on` | SFX enabled. Pair with `sound-off` for the disabled state. |
| `sound-off` | SFX muted. Do not use for music mute. |
| `music` | Music volume or music enabled state. |
| `controls-edit` | Open or identify the control-layout editor. |
| `reset-ball` | Return the training ball to its start position. |
| `bot` | Bot identity, opponent difficulty, or bot-filled slot. |
| `network` | Connection quality, latency, or transport status. |
| `warning` | Recoverable warning, connection problem, or error notice. |

## Field builder

| Asset | Instruction |
| --- | --- |
| `field-library` | Browse saved fields, duplicate a field, or open field presets. |
| `undo` | Undo the last builder edit. |
| `redo` | Restore the most recently undone builder edit. |
| `mirror-sides` | Mirror across the vertical midfield axis. |
| `mirror-top` | Mirror across the horizontal axis. |
| `mirror-diagonal` | Mirror across a diagonal axis only. |
| `square-joint` | Select square/miter wall joints. |
| `round-joint` | Select rounded wall joints. |
| `field-size` | Field dimensions, capacity, or drafting-scale control. |
| `zoom-in` | Increase builder viewport zoom. |
| `zoom-out` | Decrease builder viewport zoom. |
| `fit-view` | Fit the entire field or reset viewport framing. |
| `hard-wall` | Permanent reinforced steel wall material. |
| `weak-wall` | Breakable dry/cracked wall material. |
| `bush` | Place or represent bush/stealth terrain. |
| `crate` | Place or represent a wooden obstacle crate. |

## Builder and social actions

| Asset | Instruction |
| --- | --- |
| `spawn-red` | Red/team-B starting position. Never recolor it blue at runtime. |
| `spawn-blue` | Blue/team-A starting position. Never recolor it red at runtime. |
| `ball-placement` | Authored ball start point in the builder. |
| `move-tool` | Select and reposition a builder object. |
| `eraser` | Erase one or more builder objects by touch/drag. |
| `clear-all` | Destructive removal of all field objects; require appropriate confirmation. |
| `save` | Save field, save settings, or commit an editable draft. |
| `rename` | Rename a saved field or editable object. |
| `delete` | Permanently delete a saved item; do not use as a modal close. |
| `load` | Load/open a saved field into the builder. |
| `add` | Generic create/add action such as adding a friend or club. |
| `search` | Search users, clubs, fields, or content. |
| `chat` | Message, chat thread, or quick-message entry. |
| `share-field` | Share or send a playable field/stadium. |
| `invite` | Invite a specific player to a room or party. |
| `accept` | Accept, approve, or confirm a positive request. |

## Economy and ranks

| Asset | Instruction |
| --- | --- |
| `decline` | Reject a request or negative confirmation; pair with `accept`. |
| `coins` | Soft currency and coin bundles. |
| `gem` | Premium gem currency; use `rank-diamond` for rank. |
| `gift` | Reward box, starter pack, or claimable gift. |
| `season-star` | Season feature, featured reward, or event highlight. |
| `skin` | Cosmetic skin/outfit shop category. |
| `power` | Generic power shop category; use a specific power asset in gameplay. |
| `season-pass` | Season pass, ticket, or gated seasonal reward track. |
| `rank-bronze` | Earned Bronze rank badge only. |
| `rank-silver` | Earned Silver rank badge only. |
| `rank-gold` | Earned Gold rank badge only. |
| `rank-platinum` | Earned Platinum/Mythic-step badge only. |
| `rank-diamond` | Earned Diamond rank badge only; not premium currency. |
| `rank-champion` | Earned Champion/Master rank badge only. |
| `rank-legend` | Earned Legend rank badge or legendary rank state. |
| `lock` | Locked hero, mode, reward, rank progression, or unavailable feature. |

## Reactions and system states

| Asset | Instruction |
| --- | --- |
| `hello` | Greeting quick message or wave reaction. |
| `goal-celebration` | Goal praise, football reaction, or scored-goal event. |
| `champion-reaction` | “Champion” praise reaction; not the player’s rank badge. |
| `laugh` | Laughing quick reaction. |
| `fire` | Fire/hype quick reaction or hot streak. |
| `thumbs-up` | Approval or sportsmanship reaction. |
| `stadium` | Generic stadium, arena attachment, or field reference. |
| `goal-net` | Goal/net mode such as goal brawl. |
| `notification` | Unread notification or pending update. |
| `online` | Online/available state indicator. |
| `pause` | Pause playback/game flow where pausing is supported. |
| `resume` | Resume paused flow or continue from pause. |
| `confirm` | Generic affirmative confirmation. Use `accept` for social requests. |
| `cancel` | Cancel an in-progress action or drag gesture. |
| `refresh` | Retry, reload, synchronize, or refresh content. |
| `timer` | Match clock, countdown, cooldown duration, or timed event. |

## Production rules

- Prefer the WebP sprite pack; do not load all 96 PNGs in the game.
- The compatibility runtime is for legacy emoji and dynamic `textContent`.
- New markup should use semantic IDs directly so context never determines art.
- Increment the sprite URL version in `icon-system.css` after changing the pack.
- Always verify at the real 18–32px UI size on the phone.
