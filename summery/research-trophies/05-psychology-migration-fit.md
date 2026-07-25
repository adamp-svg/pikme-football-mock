# Research Agent 5 — Retention psychology of losable trophies vs monotonic XP, and migration/fit for Saltiz Football

Scope: (a) loss-aversion psychology of trophies, (b) honest case against trophies for THIS product,
(c) the two-track standard answer, (d) seasons at small scale, (e) RTL/Hebrew UI, (f) migration of
live users, (g) exact cross-repo plumbing changes. Ground truth read: `summery/HANDOFF-stats-xp-prefs.md`,
`pikme-server/data/football-xp.js`, `pikme-server/data/footballstats.js`, `public/client.js`
(`renderHubXp`/`playXpReveal`/`postMatchResult`), `summery/HANDOFF-friends-rank.md`.

## 1. Loss aversion & the psychology of losable points

- Kahneman & Tversky's prospect theory: losses are felt roughly 2x as intensely as equivalent gains.
  Applied directly to games — a losable number creates far more per-match emotional stakes than a
  number that only ever goes up. [Prospect Theory / Loss Aversion primer](https://yukaichou.com/behavioral-analysis/prospect-theory-loss-aversion-kahneman-tversky/), [Loss Aversion in UX/games](https://learningloop.io/plays/psychology/loss-aversion)
- HCI research specifically testing loss aversion in games ("Risking Treasure") confirms players
  strongly avoid losses even when the lost resource is virtual/temporary and worthless outside the
  game — the aversion is about the *feeling* of losing, not the resource's real value.
  [Risking Treasure: Testing Loss Aversion in an Adventure Game (ACM CHI PLAY)](https://dl.doi.org/10.1145/3410404.3414250) / [ResearchGate copy](https://www.researchgate.net/publication/345198400_Risking_Treasure_Testing_Loss_Aversion_in_an_Adventure_Game)
- Design-pattern framing: designers deliberately make players build up something (a streak, a
  collection, a rank) and then make the *threat* of losing it visible right when engagement would
  otherwise dip — this is why losable trophies out-pull monotonic XP for session-to-session pull.
  Same mechanism as Duolingo's streak flame. [Loss Aversion — highlight what users stand to lose](https://learningloop.io/plays/psychology/loss-aversion)

**The documented downside — real, not hypothetical:**
- "Ranked anxiety" is a named, widely-discussed phenomenon: players describe being unable to make
  themselves queue into ranked modes because of the dread of losing rank, with physical symptoms
  (shaking, dropped confidence) reported in community discussion.
  [Ranked Anxiety: Fear in Competitive Games (Medium)](https://midnightsps.medium.com/ranked-anxiety-fear-in-competitive-games-9ccc1bf6b0a6), [substack: A conversation with myself about Ladder Anxiety](https://mattd.substack.com/p/ladder-anxiety-conversation)
- "Quit while you're ahead" / stopping-for-the-day-after-a-win is a well-known pattern in losable-rank
  games — once you've banked a good result players avoid a follow-up match specifically to protect the
  number, which is the opposite of what you want from an engagement/session-count metric.
- Peer-reviewed: esports players show measurable **cortisol** (stress hormone) elevation tied to
  perceived match importance and rank stakes — anticipatory competitive stress is physiological, not
  just anecdotal. [Cortisol response in official esports competition (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC8000917/), [Influence of Esports on stress: systematic review (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC8188925/)
- Directly on teens: adolescents report anxiety specifically tied to losing rank/status in online
  games, and playing "to win" (vs. to relax) correlates with materially higher anxiety levels —
  relevant because Saltiz's audience is Israeli teens/young players, exactly the group most studied here.
  [Playing to win vs. to relax — anxiety difference (PsyPost)](https://www.psypost.org/playing-video-games-to-win-is-associated-with-higher-anxiety-levels-2026-03-20/)

## 2. The honest case AGAINST trophies for Saltiz Football

Be genuinely critical, as asked:
- **This is a minigame inside a bigger collectible-card app, not the main product.** The app's core
  loop is cards/leaderboard/friends; football is one activity among several. A losable number in a
  side-activity risks punishing exactly the casual, drop-in sessions this surface is built for
  (Fortnite/OW-style ranked anxiety is tolerable in a game people chose FOR the competition; it's a
  much worse trade in a game people opened for 10 minutes between card sessions).
- **Small playerbase (hundreds).** Skill-based ranked matchmaking needs volume to keep queues fast and
  fair; multiple sources confirm rank-based matchmaking "requires a much bigger player-base and is
  simply not possible with current smaller populations" for small titles, and indie titles routinely
  skip ranked entirely for this reason. [Matchmaking discussion — small playerbases](https://forums.ea.com/discussions/apex-legends-feedback-en/sbmm-skill-based-matchmaking-can-accelerate-the-decline-of-online-video-games/8738470)
- **Existing anti-bot-farm tier gates already assume monotonic XP.** `tierFromStats()` in
  `football-xp.js` gates Platinum+/Champion+ on `winsVsHuman` counts that only accumulate — a losable
  trophy number and a monotonic win-count gate pulling in different directions is confusing (you could
  lose trophies while still being gated toward a higher tier by your win history, or vice versa).
- **The existing UX (meteor + confetti + starburst XP reveal) is built entirely for a number that only
  goes up.** Every animation primitive in `playXpReveal`/`xpBigNum`/`fillWithLevels` assumes
  `toXp > fromXp` (guarded explicitly: `if (... || toXp <= fromXp) return;`). A losable number needs an
  entirely new "down" reveal state, or the existing reveal has to be suppressed on a loss — real net-new
  UI work, not a reskin.
- **Losers/drawers are still paid XP today** ("anti-rage-quit": `base = win?100:draw?50:30`) — a
  deliberate design choice to keep losers engaged. Trophies invert this: a loss must cost something,
  which directly fights the anti-rage-quit intent already built into `computeMatchXp`.
- **What WOULD make trophies worth it here**: only if the goal is specifically a skill-signaling
  status object for the small core of repeat 2v2 players (the ones already fighting for the Platinum/
  Champion/Legend tiers), not a mechanic for the whole userbase — i.e., trophies as a *layer on top of*
  XP for the enthusiast segment, not a replacement for the mainstream reveal.

## 3. The both-at-once answer (why every big competitive game runs two tracks)

- **Brawl Stars**: Trophies (losable, per-brawler and account-total, drives Trophy Road unlocks and a
  separate Ranked mode) + a monotonic Mastery/leveling track that only goes up and funds long-term
  power progress. Design intent explicitly divides labor — "pushing Mastery helps you upgrade your
  Brawlers, which helps you push trophies faster." [Brawl Stars trophies (Fandom)](https://brawlstars.fandom.com/wiki/Trophies), [Leveling guide](https://skycoach.gg/blog/brawl-stars/articles/brawlers-leveling-guide). Note: Supercell is mid-transition — Mastery is being
  retired in favor of folding its function into a reworked Trophy Road (Oct 2024 update: 50 tiers, gain/
  loss smoothed below 1000 trophies), which is itself a live "replace monotonic with losable" migration
  worth watching. [Brawl Stars new Trophy System explained](https://sportskeeda.com/mobile-games/brawl-stars-new-trophy-system-explained), [Mastery leaving Brawl Stars](https://wowvendor.com/media/brawl-stars/mastery-event-begins/)
- **Rocket League**: Competitive **Rank/MMR is losable per-playlist** (3v3/2v2/1v1 pools are fully
  separate) and resets each season; a separate **Season Reward Level is monotonic within the season** —
  it locks in on wins-at-a-tier, not peak rank, so a bad losing streak late in a season can't take back
  reward progress already earned. [Rocket League ranks & Season Reward explained](https://www.theloadout.com/rocket-league/ranks), [Ranks/MMR guide](https://www.egaminghq.com/rocket-league-ranks-guide/)
- **Fortnite**: Ranked (losable, replaced the old 3-tier Arena system on May 16 2023 with an 8-tier
  Bronze→Unreal ladder) runs alongside the fully separate, monotonic Battle Pass XP/level track — one
  is "how good are you this act," the other is "how much have you played/paid this season."
  [Fortnite Ranked explained](https://earlygame.com/fortnite/ranked-new-ranking-system-explained), [Ranked wiki](https://fortnite.fandom.com/wiki/Ranked)
- **Why split labor works**: one track (trophies/MMR/rank) carries the *tension* — it's allowed to hurt,
  because hurting is what makes a win feel earned. The other (XP/level/mastery/battle pass) carries
  *guaranteed progress* — it's what keeps a losing session from feeling like a wasted session. Multiple
  design write-ups frame this explicitly as addressing different player motivations (skill/competitive
  vs. time/seasonal) simultaneously so neither system has to do both jobs badly.
  [Battle Pass design analysis (Deconstructor of Fun)](https://www.deconstructoroffun.com/blog/2022/6/4/battle-passes-analysis)
- **How they present both without confusing players**: consistently, the losable ladder gets the
  competitive iconography (shield/rank badge, division pips, per-season reset messaging) and lives in a
  "Ranked/Competitive" surface, while the monotonic track gets the warm/cosmetic iconography (level
  number, XP bar, road/path visual) and lives in the main hub — i.e. **two different visual languages in
  two different places**, never the same bar doing both jobs.

## 4. Do we need seasons at hundreds-of-users scale?

- Season lengths in the wild cluster at **~2–3 months** for AAA/large-scale titles (Rocket League,
  Overwatch competitive seasons), with mobile titles like Brawl Stars trending toward **shorter,
  ~1-month seasons** after community pressure for more frequent resets/rewards.
  [Brawl Stars season length changes](https://sportskeeda.com/esports/news-supercell-reveals-new-upcoming-changes-brawl-stars-brawl-pass-season-length-and-more)
- **What breaks at hundreds of users**: skill-based ranked matchmaking "requires a much bigger
  player-base and is simply not possible with current smaller populations" — confirmed by multiple
  indie-dev matchmaking postmortems; small titles end up mixing skill tiers just to fill queues, or
  skip ranked matchmaking entirely. [SBMM + small playerbase discussion](https://forums.ea.com/discussions/apex-legends-feedback-en/sbmm-skill-based-matchmaking-can-accelerate-the-decline-of-online-video-games/8738470) A hard season **reset** on a
  playerbase this size additionally risks an empty top-of-ladder for weeks (nobody left to play against
  at the new season's bronze floor) and a demoralizing "everyone dropped to 0 at once" moment with no
  matchmaking depth to recover through.
- **Recommendation logic (not a citation, a synthesis)**: given hundreds of users, skip hard resets
  entirely at launch. If a season cadence is wanted later for content/marketing cadence (not
  matchmaking), a **soft reset** (compress everyone toward the median, e.g. `new = old*0.5 + floor`) at
  ~3-month cadence is far safer than a Rocket-League-style hard reset, and should ship only after the
  playerbase is large enough that the ladder isn't emptied by it.

## 5. UI/UX for trophies — RTL/Hebrew specifics

- **Existing precedent in this exact codebase**: `public/client.js:841-847` already has a Hebrew rank
  ladder for the **card-collection** side (`HUB_RANKS`): `מתחיל` (beginner) → `נפוץ` (common) →
  `נדיר` (rare) → `אדיר` (mighty/epic) → `אגדי` (legendary), each with an emoji icon (🌱🃏⭐💎🏆).
  **Reuse this exact vocabulary register for football trophies** so the two systems in the same app
  read as one design language, e.g.: tier words `ברונזה/כסף/זהב/פלטינה/יהלום/אלוף/אגדה` (the existing
  `TIERS` in `football-xp.js` already are bronze/silver/gold/platinum/diamond/champion/legend — these
  translate cleanly and idiomatically).
- **Naming for "trophies" itself**: **גביעים** (literal "trophies/cups," used by Brawl Stars' own
  Hebrew localization and the most recognizable term to this exact demographic since both games are
  played by the same Israeli teen audience) is the safest choice over more abstract alternatives —
  **נקודות** ("points") reads as too generic/low-stakes, **דירוג**/**דרגה** ("ranking"/"rank") read
  correctly as the *tier name* but not the losable currency itself. Recommended split:
  **גביעים** = the losable number, **דרגה** = the named tier band it falls into (mirrors Brawl Stars'
  own trophies-vs-league distinction and Overwatch's SR-vs-tier distinction).
- **RTL layout pitfalls to flag for whoever builds this**:
  - Directional elements (progress bars, "gain" arrows, meteor-drop trajectories) should mirror for
    RTL — but linear progress-bar fill direction has documented **exceptions for Hebrew** specifically
    in some RTL guidance (unlike Arabic, Hebrew progress indicators are sometimes kept LTR-filling by
    convention) — this needs a design decision, not an assumption; verify against how the existing
    `hub-xp-bar` already fills (check its CSS `direction`) and match it rather than introducing a second
    convention. [Bidirectionality & RTL (Material Design 3)](https://m3.material.io/foundations/layout/bidirectionality-rtl), [Designing for RTL in mobile apps](https://www.translatedright.com/blog/designing-for-rtl-languages-in-mobile-apps-a-complete-guide-to-right-to-left-development/)
  - Non-directional elements — clock/refresh icons, circular meters, rank badge artwork itself — should
    **NOT** be mirrored; only flip elements that encode "forward/backward" or "before/after."
    [RTL localization — inclusive interfaces](https://poeditor.com/blog/rtl-localization/)
  - Badge/number placement: in RTL a badge that sits at the "leading edge" moves from top-left to
    top-right; anywhere the current code hardcodes `left:` positioning (the rank button CSS in
    `HANDOFF-friends-rank.md`, e.g. `left:95 top:240`) needs an RTL-aware equivalent (`right:`/logical
    `inset-inline-start`) if a trophy badge is added near it.
- **The "you lost trophies" moment — how games soften it**:
  - **Clash Royale's arena/trophy floor** is the single best pattern for this product: once you cross
    into a new arena/tier, a losing streak **cannot** drop you back below that tier's floor — trophies
    inside the band can wobble, but the unlocked tier itself never regresses.
    [Clash Royale trophy gates](https://www.zleague.gg/theportal/clash-royale-will-you-drop-out-of-legendary-arena-after-losing-a-match/) — this maps directly onto the existing `TIERS` ladder in
    `football-xp.js`: make tier itself a floor (never demote below a tier once reached), only the raw
    trophy count inside a tier is volatile.
  - **Loss/rank protection mechanics** (seen in Mobile Legends and similar mobile titles): one-loss
    grace when freshly promoted, reduced point-loss vs. point-gain asymmetry (lose less than you'd gain
    for an equivalent win), and loss-streak protection after N consecutive losses.
  - **Tone**: keep the anti-rage-quit intent already in `computeMatchXp` (losers still get *something*)
    — pair a trophy loss with a **separate, still-positive** XP/mastery gain shown in the same screen
    (this is exactly the two-track split from §3): "−6 גביעים" next to a still-climbing "+30 XP" bar so
    the screen is never 100% negative. Use a slower/lower-energy animation for the loss number (no
    meteor/confetti) versus the existing celebratory treatment reserved for XP gains.

## 6. Migration of live users with existing XP + career stats

- **What real games have done when replacing a progression system**, and what players hated:
  - **Overwatch 1→2, SR→Tier/Division**: Blizzard removed the visible numeric SR value entirely and
    replaced it with Tier+Division (explicitly to "relieve the sense of being stuck" on a raw number),
    initially updating rank only every 7 wins/20 losses instead of every game — **players hated the
    reduced feedback frequency** (losing visibility into per-match progress) badly enough that Season 9
    reverted to per-match updates with visible gain/loss. Lesson: don't strip per-match feedback when
    you migrate the underlying number's shape. [Overwatch 2 competitive rework, Season 9 walkback](https://kotaku.com/overwatch-2-new-ranked-system-competitive-season-9-1851239386), [Blizzard's original SR→tier announcement](https://overwatch.blizzard.com/en-us/news/23857518/)
  - **Fortnite Arena→Ranked (2023)**: replaced a 3-tier Arena/Hype-point system with an 8-tier ladder;
    reception was mixed-positive ("delighted many competitive players... even if opinions remained
    mixed") but a real complaint was that the new scoring (elimination value scaled by opponent rank)
    changed the *incentive structure* enough that some players felt it rewarded passive/camping play
    over the old aggressive Arena meta. Lesson: a system swap that changes what behavior gets rewarded
    will provoke complaints even if the ladder itself is well-received.
    [Fortnite Ranked reception](https://earlygame.com/fortnite/ranked-new-ranking-system-explained)
  - **Brawl Stars 2023-2024 trophy/season rework**: complaints centered less on the mechanic change
    itself and more on **reward pacing** — players felt the milestones after the grind (10k+ trophies)
    weren't worth reaching post-rework. Lesson: when you re-carve a ladder, re-examine the reward curve
    at the same time, or the new ladder inherits the old one's staleness complaints.
    [Brawl Stars trophy rework community reaction](https://www.zleague.gg/theportal/brawl-stars-players-demand-trophy-road-rework-community-reactions-feedback/)
- **Concrete migration proposal for Saltiz Football**, given the current schema
  (`footballstats.js`: `xp`, `level`, `tier`, `wins/losses/winsVsHuman/winsVsBot`, `streak`/`bestStreak`):
  1. **Don't zero anyone out.** A hard reset to 0 trophies for existing players is the single most
     resented move in every case above (implicit in the OW1→2 and Arena→Ranked backlash) — it reads as
     erasing earned status.
  2. **Seed trophies from the existing `tier` + `xp`**, not from raw XP directly (raw XP is already
     gated by the anti-bot-farm rules in `tierFromStats()`, so it reflects "legitimate" skill signal
     better than XP alone). Concretely: give every player a **starting trophy floor** equal to a fixed
     value per current `tier` (e.g. bronze=0, silver=500, gold=1500, platinum=3000, diamond=5000,
     champion=8000, legend=12000 — exact numbers are a balancing exercise, not this doc's job), then add
     a small variable amount within that band derived from position-within-tier (`xp` minus the tier's
     XP floor, scaled). This mirrors the Clash Royale arena-floor concept directly: your *tier never
     regresses below its seed*, only the in-band number is freshly volatile.
  3. **Grandfather badge, not grandfather trophies**: consider a one-time cosmetic ("founding tier"
     badge/frame) for anyone migrated at Diamond+ before the cutover, so long-time high performers keep
     a status marker even through the mechanic change — cheaper to build than a perfect XP→trophy
     formula and directly addresses the "my grind got erased" resentment pattern.
  4. **Keep the old XP/level system running underneath, unchanged**, as the monotonic half of the
     two-track split (§3) — this is both the honest product answer and the cheapest migration: nothing
     about `computeMatchXp`, `levelFromXp`, or the existing reveal UI needs to change at all; trophies
     are purely additive.
  5. **Announce the mechanic**, don't silently swap it — the Overwatch and Fortnite cases both show that
     surprise changes to what a familiar number *means* generate more backlash than the change itself.

## 7. The plumbing — exact changes per repo

Given the shipped contract (game → `postMessage('matchResult')` → app `services/saltizFootball.js
recordMatch` → backend `POST /football/record-match` → `computeMatchXp` → `footballstats` → app injects
`window.SALTIZ_XP` back), adding a **second, additive, losable trophies field** touches all three repos:

- **football-mock (game)**:
  - `public/client.js`: read a new `window.SALTIZ_TROPHIES = {trophies, tier}` injected value (mirror
    the existing `window.SALTIZ_XP` pattern at line ~919/941/2621/3561) — add a small trophy chip next
    to (not replacing) `renderHubXp()`'s XP bar.
    - Add a **new, separate** reveal function (`playTrophyReveal(fromT, toT)`) that can go **down** —
      the existing `playXpReveal` hard-guards `toXp <= fromXp` and returns early, so it structurally
      cannot show a loss; do not try to reuse it for negative deltas.
    - `postMatchResult()` (line ~510) already sends `result`/`stats`; no new outbound field is strictly
      required if the server computes trophy delta server-side from `result`+`vsHuman` the same way it
      computes XP — keeps the client honest (never trust a client-sent trophy number, same principle
      already documented in `football-xp.js`'s header comment).
  - Because the **app only ships `window.SALTIZ_TROPHIES` in a NEW TestFlight build**, gate all new game
    UI behind `typeof window.SALTIZ_TROPHIES !== 'undefined'` (exactly like the existing `DEV_LOCAL`
    fallback pattern for `SALTIZ_XP`) so the game **degrades silently to XP-only on every currently
    installed app build** — no broken UI, no visible trophies chip, until the user updates.
- **pikme-server (backend)**:
  - `data/football-xp.js`: add `computeTrophyDelta({result, vsHuman, currentTier, ...})` alongside
    `computeMatchXp` — same file, same "pure function, no I/O" convention. Implement the Clash-Royale
    style floor: delta can be negative, but clamp so `newTrophies` never falls below the seeded floor of
    `tier`.
  - `data/footballstats.js`: add `trophies: {type: Number, default: 0, index:true}` (a second sort key
    for a trophies-specific leaderboard, separate from the existing `xp`-sorted one) and optionally
    `trophyTier` if it's allowed to diverge from the XP-derived `tier`. Keep `xp`/`level`/`tier` schema
    fields completely unchanged — additive only.
  - `routes-pikme/user.js`: in `/football/record-match`, call the new delta function alongside
    `computeMatchXp`, `$inc` (or `$set` with clamped floor) `trophies`, and return it in the response
    payload next to the existing xp/level so the app has something to forward.
  - Migration script (one-off, run once): backfill `trophies`/seed floor for every existing
    `footballstats` doc from current `tier`+`xp` per the §6 formula.
- **pikmeTV-app (RN app shell, `feat/football-store` branch pattern)**:
  - `services/saltizFootball.js` `recordMatch`: read the new `trophies`/`tier` fields off the
    record-match response alongside the existing xp/level read.
  - `app/pages/football.jsx`: inject `window.SALTIZ_TROPHIES = {trophies, tier}` on load and after
    `matchResult`, same place/pattern as the existing `SALTIZ_XP` injection.
  - **This is the one repo where nothing works until a new build ships** — per the HANDOFF doc, the
    existing XP/stats/prefs pipeline already has app-side code sitting unshipped since commit `7022af9`
    waiting on a TestFlight build; trophies would ride the same wait. Because the game already
    degrades gracefully (see above), there is **no urgency to rush a build** — old app builds keep
    working exactly as today, they just never render the trophies chip until the user updates.

---

## RECOMMENDATION FOR SALTIZ FOOTBALL

**Verdict: don't replace XP with trophies — add trophies as a second, optional layer on top of the
existing (unchanged) XP system.** The loss-aversion research is real and trophies do produce more
per-match tension than a monotonic number — but the same research shows the cost (ranked anxiety,
quit-while-ahead, teen-specific anxiety correlating with "playing to win") lands hardest on exactly the
kind of casual, drop-in-for-10-minutes audience this minigame serves inside a bigger card-collection
app. Every major game that uses losable ranks (Brawl Stars, Rocket League, Fortnite, Overwatch) also
runs a parallel monotonic track precisely so a bad session never feels like a wasted session — that's
the pattern to copy, not the losable half in isolation.

**Two-track split to ship**: keep `xp`/`level` exactly as-is (monotonic, drives the existing meteor/
confetti reveal, still pays losers something — don't touch `computeMatchXp`). Add `trophies` as a new,
purely additive field with its own delta function, its own (new, can-go-down) reveal animation, and a
Clash-Royale-style **tier floor** so a tier once reached never regresses — only the in-band trophy count
is volatile. This directly reuses the existing `TIERS` ladder in `football-xp.js` as the floor bands.

**Hebrew naming**: **גביעים** for the losable number (matches Brawl Stars' own Hebrew localization and
this exact demographic's existing vocabulary), **דרגה** for the named tier it falls into, keeping the
existing tier words (ברונזה/כסף/זהב/פלטינה/יהלום/אלוף/אגדה) and reusing the icon+word visual convention
already shipped for card rarity (`HUB_RANKS` in `client.js:841`) so the two systems read as one design
language, not two competing ones.

**Post-match UX when trophies drop**: never show a 100%-negative screen. Pair "−N גביעים" (slow,
low-energy, no confetti) in the same frame as the still-positive "+N XP" (the existing celebratory
treatment, untouched) — the loss is real but never the whole story. Never let a loss cross a tier floor.

**Migration**: don't zero existing players. Seed `trophies` from current `tier`+`xp` (tier sets the
floor band, in-tier XP position sets the exact seed within it), and consider a one-time cosmetic
"founding tier" badge for anyone migrated at Diamond+ so long-time grinders keep a visible status marker
through the mechanic change — the OW1→2 and Fortnite Arena→Ranked cases both show that silent or
erasing-feeling migrations generate the most backlash, while additive/floor-preserving ones don't.

**Seasons**: skip hard resets at this playerbase size (hundreds) — skill-matchmaking and post-reset
ladders both need volume this game doesn't have yet. If a season cadence is wanted for content/
marketing reasons later, use a soft compression-toward-median reset, not a hard wipe, and only once
population supports it.

**Graceful degradation**: gate every new trophies UI element behind the presence of
`window.SALTIZ_TROPHIES`, mirroring the existing `DEV_LOCAL`/`SALTIZ_XP` fallback pattern — the app side
of this can only ship in a new TestFlight build, and the game/backend already have unshipped app-side
work waiting (per `HANDOFF-stats-xp-prefs.md`, commit `7022af9`). Because degradation is silent (no
trophies chip, everything else identical), there's no pressure to rush a build just for this feature —
it can ride along with whatever build eventually ships.
