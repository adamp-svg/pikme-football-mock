# Card Powers (equipped loadout → hero buffs) — Design Spec

**Status:** Approved (2026-07-21). Build in football-mock. Ships in the same deploy batch as the parallel cosmetics/heroes work (shared start-screen files).

## Concept

On the start/home screen, next to the hero and above the card carousel, add **3 fixed power slots**. Each slot is a fixed power; the **rarity of the card placed in it sets the strength**. The player's **top-3 cards auto-fill** on entry; the player **drags a card from the carousel up into a slot** to swap it (evicts the previous card; one card instance per slot). Buffs are **passive, active the whole match, in all matches (ranked included)** — the album-matters call.

During a match, the **3 equipped cards are always shown at the top next to the timer** (small icons, read-only).

## Slots & powers

| # | Slot | Power | Sim hook |
|---|------|-------|----------|
| 0 | ⚡ **Shot** | charge a power shot faster (full power on a shorter press) | `p.chargeRate` (sim.js:360, `_charge += dt/SHOOT_CHARGE_TIME * chargeRate`) |
| 1 | 🏃 **Speed** | move faster | NEW `p.speedBuff` at sim.js:294 (`spd = ch.speed * settings.speedMul * speedBuff`) |
| 2 | 🛡️ **Utility** | faster bomb cooldown **and** faster wall build/reload | `p.cdMul` (sim.js:340 buildReload, :507 specialCd, :549 buildCd) |

## Strength by rarity (user's numbers — "album matters")

| Rarity | % | Shot `chargeRate` | Speed `speedBuff` | Utility `cdMul` |
|--------|---|-------------------|-------------------|-----------------|
| 🟡 Legendary | 20% | `1/(1-.20)=1.25` | `1.20` | `0.80` |
| 🟣 Epic | 12% | `1/(1-.12)=1.136` | `1.12` | `0.88` |
| 🔵 Rare | 7% | `1/(1-.07)=1.075` | `1.07` | `0.93` |
| ⚪ Common | 3% | `1/(1-.03)=1.031` | `1.03` | `0.97` |
| (empty) | 0% | `1.0` | `1.0` | `1.0` |

Reducing a time/cooldown by X% ⇒ multiplier `(1-X)`; speeding charge by "−X% time" ⇒ `chargeRate = 1/(1-X)`. `speedBuff` is a straight `+X%`.

## Data flow (no per-frame wire change)

1. **Client** persists the loadout (3 cards, by `{r,n}` per slot) in `localStorage` (`pikme-loadout`), mirroring how `myCosmetic` persists. Sends it in the `join` message (like `cards`/`cosmetic`) and a live `setLoadout` message when changed in the lobby (mirror `setCosmetic`, server.js:553).
2. **Server** `sanitizeLoadout(raw, memberCards)` — validate each slotted card is present in the member's sanitized `cards`; ignore/blank anything not owned. Store `member.loadout`. Derive per-slot **rarity from the server's own card record** (NEVER trust a client-sent % — the client only says *which card* goes in *which slot*).
3. At **startMatch** (`addPlayer`, server.js:326), compute `{chargeRate, speedBuff, cdMul}` from `member.loadout` and pass into `addPlayer`.
4. **sim.js** `addPlayer` (sim.js:101) accepts an optional `buffs` param and sets `p.chargeRate` / `p.speedBuff` / `p.cdMul` (all default 1). Apply `speedBuff` at line 294. `chargeRate` + `cdMul` are already read by the sim (bots use `cdMul` for difficulty — humans' buff sets it the same way; no conflict since a human's base is 1).

Opponents never receive a loadout — buffs are invisible server-side mechanics; no snapshot/roster change.

## UI

- **Slots** (`index.html` + `client.js` + `style.css`): 3 slot elements by the hero, above `#home-carousel`. Each shows the slotted card art (or an empty frame + power icon), the power icon (⚡/🏃/🛡️), and the current buff % for that card. RTL, consistent with the existing hub styling.
- **Drag-to-slot:** pointer-drag a carousel card up onto a slot drops it in (evict/replace). Must not break the existing carousel swipe (carousel drag is horizontal; slot-drop is a drag onto a slot target). Tap a slot to clear it (optional).
- **Default fill:** top-3 by `rankCards(myCards())` → slots 0,1,2 on first load (and when none saved). Saved loadout (validated against current album) wins.
- **In-match HUD:** 3 small equipped-card icons at the top next to `.timer` (read-only), always visible during play.

## Anti-cheat note (v1 scope)

Buffs are only as trustworthy as the injected album (`window.SALTIZ_CARDS`) — the same trust boundary the audience/top-3 already rely on. Server validates the slotted card is *in* the album and derives rarity itself, so a client can't send an arbitrary %. A determined cheat could still inflate the injected album (pre-existing gap); the real fix is a backend-verified album, out of scope here.

## Build order

1. **Lobby UI first** — slots, default fill, drag-to-slot, persistence, `setLoadout`/join wiring (client + index.html + style.css + server storage/validation).
2. **Wire into the sim** — `addPlayer` buffs + the three application points (server computes buffs at startMatch).
3. **In-match HUD** — equipped cards next to the timer.

Verify headlessly: default fill, drag-swap persists, join carries loadout, server bakes buffs (a legendary-Speed player is measurably faster in a bot sim), carousel swipe still works, no regressions to cosmetics/XP/crowd co-owned code.
