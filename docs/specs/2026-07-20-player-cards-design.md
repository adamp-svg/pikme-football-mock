# Player cards in Block Football — design spec

Bring the player's Saltiz album into the football minigame across three surfaces,
on top of the existing name+avatar identity flow. Game-side lives in `football-mock`;
one app-side change in `pikmeTV-tf/app/pages/football.jsx`.

## §0 — Data pipeline (foundation)

The game never calls the cards API (no CORS; keeps PII out). The app already holds
the album in a React Query cache; it hands a compact, non-PII list to the WebView.

**Wire shape** — one entry per owned slot:
```
card = { r: rarity, n: cardNumber, c: copies, w: worth }   // strings/ints, no PII
```

- **App** (`football.jsx`): read `getQueryData(['saltiz-claims', identifier])`, reduce
  via `card_slots[]` (or `recent[]`) to `[{r,n,c,w}]`, and inject as
  `window.SALTIZ_CARDS` through `injectedJavaScriptBeforeContentLoaded`. No new fetch.
- **Game** (`client.js`): `MY_CARDS = window.SALTIZ_CARDS || []` (validated, cap 256);
  send `cards` in the existing `join` message.
- **Server** (`server.js`): sanitize + store `member.cards`; echo in `lobbyPayload`
  members and in a new `matchStart.players[]` roster `{id,name,avatar,team,cards}`.
  Cards are NOT added to the per-tick snapshot (audience is fixed per match).

**Card art** (browser): `https://<supabase>/storage/v1/object/public/cards/{r}/{n}.webp`
— public URLs, loaded as `Image()`; rarity glow colours are the fallback.

## §1 — Entry carousel (`#home`)

Keeps the existing char-card (name + pfp face). Adds a **coverflow carousel** of the
player's cards below it, above the Quick Match / Play with Friends buttons.
- Sorted by worth desc (best card centered on open).
- **5 cards max visible**: center largest, neighbours shrink + fade outward.
- Swipeable/draggable + slow auto-advance. Purely visual (no selection effect).
- Empty state (no cards): carousel hidden, layout unchanged.

## §2 — Team intro (match start)

A `#team-intro` overlay shown on `matchStart` for ~4s (tap to skip), populated from
`matchStart.players[]`. Two team columns; each player row = pfp + name + their
**top 3 cards**. Then fades into kickoff.

**Ranking** = reuse the app's card worth: sort a member's cards by `w` desc
(tiebreak rarity, then copies), take 3. Bots / cardless players show no cards.

## §3 — Album audience (stands)

Split the stands render into **structure** (static, cached) and **occupants**
(dynamic, per-frame — so they can jump):
- `drawStands` keeps the cobblestone terrace structure on all four sides; the mob
  crowd is removed.
- New `drawAudience()` (dynamic loop, culled to visible) lays a seat grid over each
  terrace region and fills it with **card-art seats**, each bobbing
  `sin(t·speed + seed)`.
- **Home side** (left end + home halves of top/bottom) = the local player's album,
  expanded by copies, best-worth first. **Away side** = the opposing team's albums
  pooled. Seats fill from the pool; leftover seats stay empty (cobble shows) — so
  many cards ⇒ full stands, few cards ⇒ gaps. Capacity ≈ 60 seats/side.

## Files touched
- `pikmeTV-tf/app/pages/football.jsx` — inject `window.SALTIZ_CARDS`.
- `public/client.js` — read cards; send in join; entry carousel; team-intro overlay;
  `drawAudience()`; trim `drawFanWall` to structure-only.
- `public/index.html` — carousel container in `#home`; `#team-intro` overlay.
- `public/style.css` — carousel + team-intro styles.
- `server.js` — sanitize/store/relay `member.cards`; `matchStart.players[]`.

## Coordination
`client.js`/`index.html`/`style.css`/`server.js` are co-edited by the waiting-room and
graphics agents. Hold coordination locks while editing; rebase on their pushes (as
`f0cb75d` reconciled). Cards are additive — no changes to physics/sim.

## Out of scope (YAGNI)
Card selection/emblem effects, per-copy art variation, animated card reveals beyond
the bob, sending cards in the per-tick snapshot.
