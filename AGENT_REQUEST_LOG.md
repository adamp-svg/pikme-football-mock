# Agent Request Log — Football Game

> Handoff log so another agent can resume if this session fails.
> Repo: football-mock | Branch: feat/build-bomb-cancel | Rule: work local, commit everything.

## 2026-07-23

- **Req #6** — Task (continuation, same lock). (a) Move the cards/collector badge `#hub-rank` to align directly with the worth chip `#chip-worth`; (b) make `#hub-rank` + hero `#hub-tier` the SAME dimensions — a squarish, slightly-longer box.
  - Impl: both badges → fixed 60×50 (matches chip width 60 = «a bit longer square»), layout switched from row to column (icon over text) so they fill a squarish box. Baked pos: `#hub-rank` left 278 width 60 (exact worth-chip column), `#hub-tier` left 585 width 60 (centred over hero, dropped translateX). style.css shared `.hub-rank,.hub-tier` block + baked-position rules. CSS-only (no HTML/JS change).
  - Verified: server :3010 serves `#hub-rank {left:278 width:60 height:50}` = same left+width as `#chip-worth {left:278 width:60}` (directly aligned column); `#hub-tier {left:585 width:60 height:50}` (same 60×50, centred over hero); `flex-direction: column` + icon `font-size: 22px` present. NOTE: 50px-tall hero badge sits over the hero's upper area — visual glance on localhost may want a top nudge.
  - Committed style.css + this log.
  - Status: DONE

- **Req #5** — Task (continuation of #4, same lock `football-mock:hero-rank-badge`). Make BOTH badges — collector `#hub-rank` («אספן…» over the cards) and hero rank `#hub-tier` — more pixel-art: less box, less text.
  - Approach: unified 8-bit emblem style on `.hub-rank, .hub-tier` — notched pixel corners (`clip-path` L-notch), hard 2-band fill via `--c1/--c2`, raised bevel (inset box-shadows), chunky bottom shadow kept via `filter: drop-shadow` (box-shadow is clipped by clip-path, so must use filter). Icon-forward: `.px-ic` big, tiny `.px-word`/`.px-sub`.
  - Less text: collector drops the «אספן » prefix → icon + one word (מתחיל/נפוץ/נדיר/אדיר/אגדי); hero drops the tier word → icon + sub-rank number only (tier read from icon+colour). `HUB_RANKS` → {ic,word}; renderHubStats + renderHubTier now set innerHTML (px-ic/px-word/px-sub); renderHubTier sets `--c1/--c2` (not inline background).
  - Verified: `node --check` OK; server :3010 boots; `/`+`client.js`=200; CSS has `clip-path: polygon` + `.px-ic` + `filter: drop-shadow(0 3px 0`; JS has {ic,word} HUB_RANKS + px-ic/px-word/px-sub innerHTML + `setProperty('--c1')`; 0 stale (old `.label`, old `box.style.background`). NOTE: pixel-art look (notched corners + bevel + emoji) still wants a browser/device glance — emoji glyphs stay smooth; pixel feel comes from the frame, not the icon.
  - Committed my 4 files only.
  - Status: DONE

- **Req #4** — Task assigned + LOCKED (`football-mock:hero-rank-badge`). Requirement: (a) add a small rank-progress badge ABOVE the hero in the hub, same size + position style as the `אספן אדיר` collector badge (`#hub-rank`) sitting over the cards; (b) each rank has 4 sub-ranks → progression ברונזה 1→ברונזה 2→…→ברונזה 4→כסף 1… (7 tiers × 4).
  - Design: driven by the football level (`window.SALTIZ_XP`/`levelFromXp`, client.js:760). 1 level = 1 sub-rank (Bronze1..4=lvl1..4, Silver1=lvl5, … Master4=lvl28+). Progress bar = XP-into-level `pct` (base=50·L·(L-1), span=100·L). Mirrors `#hub-rank` (worth-derived) pattern.
  - Files: index.html (new `#hub-tier` badge over hero + `data-tier` on rank tiles + subnote), client.js (`RANK_TIERS`/`rankTierFromLevel`/`currentXpState`/`renderHubTier`, call after renderHubXp; rank screen shows current division + highlights active tile), style.css (`.hub-tier` + baked pos over hero + `.rank-tier.on`).
  - Done:
    - Hero badge `#hub-tier` in index.html: pill mirrors `.hub-rank` (same font/padding/shadow) + slim bottom progress bar; baked at `left:615 top:60 translateX(-50%)` = centred over the hero, same top baseline as `#hub-rank` over the cards. Tier gradient set inline per tier.
    - JS: `renderHubTier()` fills icon+`ברונזה N`+bar; called after `renderHubXp()` (line ~711). Rank screen: `#rank-me-div` = live division (from level), `#rank-me-sub` = live global position, active `.rank-tier` gets `.on`; renamed `#rank-me-pos`→`#rank-me-div`, added `#rank-me-ic` (JS updated to match — 0 stale `rank-me-pos` refs).
    - Mapping VERIFIED via node: lvl1→ברונזה1, lvl4→ברונזה4, lvl5→כסף1, lvl28+→אלוף4(clamped). DEV_LOCAL xp1240→lvl5→כסף1.
  - Verified: `node --check` OK; server :3010 boots; `/`+`/client.js`=200; served HTML has `#hub-tier(-lbl/-fill)` + `#rank-me-div/ic/sub` + all 7 `data-tier`; JS has `RANK_TIERS`/`rankTierFromLevel`/`renderHubTier`/`renderRankMeDivision`. NOTE: no headless-DOM tool → visual placement (badge centred over hero, no clip/overlap) still wants a browser/device glance.
  - Committed my 4 files only; left parallel agent's untracked files alone.
  - Status: DONE

- **Req #3** — Task assigned + LOCKED (`football-mock:lobby-element-basis`). Requirement: for each main-lobby element (clubs, shop, news, rank) build the BASIS/scaffold UI, researched from how Brawl Stars / Fortnite / Roblox structure these screens. Features not yet available → label `בקרוב`. Also fix `#select-best-btn` ("בחר הכי טוב") which clips its text in its 110×32 box — shorten text / shrink / icon-only.
  - Context: fixed 900×415 logical-px hub stage (`public/style.css` "BAKED LOBBY LAYOUT" §1308+). Sub-screens `#news/#shop/#clubs/#arena` live in `public/index.html:159+` but were bare `.subpage-note` placeholders. Screen routing = `showScreen()` (client.js:569) + `[data-open-screen]` binders (client.js:1418). Rank = `#rank-btn` (client.js:1491) previously only toasted `/handle-friends/rank`; no screen.
  - Research (WebSearch): SHOP = BrawlStars/Fortnite → wallet + daily-deal(24h timer) + featured bundle + category tiles. CLUBS = BrawlStars → «not-in-club» landing (create/find) + preview of chat/club-league(2wk)/roles(נשיא·סגן·בכיר·חבר). NEWS = Fortnite → featured MOTD banner + feed of update cards. RANK = BrawlStars trophy/ranked → live global position + tier ladder Bronze→כסף→זהב→יהלום→מיתי→אגדי→אלוף.
  - Done:
    - `#select-best-btn` text `בחר הכי טוב`→`הכי טוב` (fits 110×32 box; title attr keeps full meaning). index.html.
    - Rebuilt `#news`,`#shop`,`#clubs` subpage bodies + NEW `#rank` screen in index.html (RTL, all-`בקרוב` where unbuilt; 16 `בקרוב` pills total).
    - client.js: registered `rank` screen (line ~1414 loop); `#rank-btn` now `showScreen('rank')` + fills live `#rank-me-pos/#rank-me-sub` from `/handle-friends/rank`; added shop daily-deal countdown ticker to next local midnight (`#shop-daily-timer`).
    - style.css: new "LOBBY SUB-SCREEN BASIS" block after `.subpage-note` — `.soon-pill` + news/shop/clubs/rank component styles, matching the chunky dark-green pixel language.
  - Verified: `node --check` public/client.js + server.js OK; server boots :3010; `/ /client.js /style.css` = 200; served HTML has all 4 screen ids + `#shop-daily-timer` + `#rank-me-pos` + `<b>הכי טוב</b>`. NOTE: no headless-DOM tool here (smoke tests are WS-only) → the visual/no-clip pass still wants a browser/device check.
  - Committed only my 4 files (index.html, client.js, style.css, this log); left parallel agent's untracked `_test-dismiss.mjs` alone.
  - Status: DONE

- **Req #2** — Task assigned + LOCKED (`football-mock:hero-cosmetic-drag`). Requirement: hero outfit must be changeable by dragging a card (1) from the carousel and (2) from a power slot onto the hero; a power-slot card dropped on the hero changes the outfit but must NOT be removed from its slot.
  - Findings: 3 gesture binders in public/client.js — carousel `bindCarouselSwipe` (~839), album fan `bindFanDrag` (~1068), power slots `bindSlotDrag` (~1137). Hero re-skin = `setHeroSkinByRarity(rarity)` (line 63).
  - Carousel→hero ALREADY works (client.js:900). Power-slot→hero was BROKEN: dropping a slot card anywhere outside a slot (incl. the hero) hit `setSlotCard(srcSlot,null)` and REMOVED it (client.js:1180).
  - Fix: teach `bindSlotDrag` about the hero drop zone → re-skin + keep the card; only remove when dropped off both slots AND hero.
  - Change applied to public/client.js (`bindSlotDrag`, ~1141/1174/1185): added `heroBtn`+`heroUnder`, hover highlight `hub-hero-over`, suppressed remove-ghost over hero, and on release drop-on-hero → `setHeroSkinByRarity(srcCard.r)` WITHOUT `setSlotCard(srcSlot,null)`.
  - Verified: `node --check` OK; server boots on :3010; `/` and `/client.js` return 200. Carousel→hero path unchanged (already worked, client.js:900). NOTE: pointer-drag gesture itself still wants a manual browser check (drag a filled power slot onto the big hero → outfit changes, card remains).
  - ⚠️ COLLISION: a parallel agent (`opus-build78`) ran `git add -A` at 16:19 and swept my uncommitted client.js edits into THEIR commit **95d2f9e** ("fix(field-builder)…"). My full hero-drag change IS committed and intact in HEAD — verified via `git show 95d2f9e -- public/client.js` — just under a misleading message. Did NOT rewrite history (opus-build78 still active). If a clean standalone commit is wanted later, cherry-pick just the `bindSlotDrag` hunk.
  - Status: DONE (code live on branch feat/build-bomb-cancel @ 95d2f9e)

- **Req #1** — Session start. Ground rules set: work in localhost, commit everything, log every request here for handoff, short-bullet answers. Task not yet assigned; awaiting task, will lock it on receipt.
  - State at start: branch `feat/build-bomb-cancel`, working tree clean.
  - Status: WAITING FOR TASK
