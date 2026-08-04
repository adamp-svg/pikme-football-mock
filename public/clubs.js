/* Clubs + scoped ranking + the player card, client side.
 *
 * Two different things share the word "club" and the UI must not blur them:
 *   • DERIVED scopes — city / school / class. Come from the player's app profile, read-only, you can
 *     never leave them. Rendered with a 🔒, never with a join or leave control.
 *   • THE CLUB — user created, user named, one per player, 30 max, joinable and leavable.
 *
 * Club mechanics follow Brawl Stars (CLAUDE.md: research the big games): three types — open / invite /
 * closed — a minimum-TROPHY bar shown on every listing, a recommended list with Refresh plus name
 * search, and four ranks (president > vice > senior > member) where each rank accepts and kicks
 * strictly below itself.
 *
 * Boards are scored by top-K placement (clubs/placement.mjs): the sum of a scope's best K members'
 * NATIONAL places, lowest wins — which is why a 3-player town can outrank תל אביב.
 *
 * PRIVACY: the server decides what another player's card may contain. Club and city are public;
 * school / grade / class come back only for an accepted friend. Never re-derive those client-side and
 * never add a "same class as you" badge — the app's frozen profile spec keeps academic details off
 * public rows, and a match sits you next to strangers.
 *
 * FOOTPRINT: this file injects into the friend modal and the profile side pane from the OUTSIDE
 * (MutationObserver), so client.js and profile.js stay almost untouched. Several agents edit those
 * two concurrently — see CLAUDE.md — and a one-line edit was already lost once mid-session.
 */
(function () {
  const $ = (s, r = document) => r.querySelector(s)
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n }
  // REAL backend: pikme-server /handle-clubs/*, authenticated by the football-token the app injects.
  // Routing mirrors client.js's own rule for token-authed calls — on a dev/LAN host pikme-server's CORS
  // allowlist excludes us, so we go through this server's same-origin /dev/clubs passthrough instead.
  const TOKEN = (() => { try { return window.PIKME_FOOTBALL_TOKEN || new URLSearchParams(location.search).get('ftoken') || null } catch { return null } })()
  const DEV_HOST = /^(localhost|10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/.test(location.hostname)
  const BASE = DEV_HOST ? '/dev/clubs' : 'https://server.pikme.tv/handle-clubs'
  const headers = () => Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { 'football-auth': TOKEN } : {})
  const api = (p, opt) => fetch(BASE + p, Object.assign({ headers: headers() }, opt || {}))
    .then((r) => (r.ok ? r.json() : r.json().catch(() => ({ error: 'http_' + r.status }))))
    .catch(() => ({ error: 'offline' }))
  const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body || {}) })

  // Friending is NOT a clubs concern — pikme-server already owns it at /handle-friends/*, and that is
  // the same graph the app's friends list uses. Routed separately so a club never forks the friend model.
  const FRIENDS_BASE = DEV_HOST ? '/dev/friends' : 'https://server.pikme.tv/handle-friends'
  // The game's own confirm dialog (client.js askConfirm), for the destructive club actions. Not
  // window.confirm(): a WebView only shows a native JS dialog if the HOST app implements the confirm
  // panel, which is exactly why "are you sure" never reached the player on unfriend. The fallback
  // exists only for a page that somehow loads clubs.js without client.js.
  const ask = (o) => (window.askConfirm ? window.askConfirm(o) : Promise.resolve(confirm(o.title)))
  const friendReq = (userId) => fetch(`${FRIENDS_BASE}/request`, { method: 'POST', headers: headers(), body: JSON.stringify({ toUserId: userId }) })
    .then((r) => (r.ok ? { ok: true } : { error: 'http_' + r.status })).catch(() => ({ error: 'offline' }))
  const friendDel = (userId) => fetch(`${FRIENDS_BASE}/${encodeURIComponent(userId)}`, { method: 'DELETE', headers: headers() })
    .then((r) => (r.ok ? { ok: true } : { error: 'http_' + r.status })).catch(() => ({ error: 'offline' }))

  // The server ships scope IDs only — never Hebrew names — so a city/school name never travels over the
  // wire attached to a player. Resolve them here from the same bundled directory the app's onboarding
  // uses (572 cities / 5,180 schools, already served by this game server).
  let DIR = null
  const dirReady = fetch('/data/schools-directory.json').then((r) => r.json())
    .then((d) => {
      const CITY_MERGES = { '675414749': '2025178902' }
      const OVERRIDE = { '2025178902': 'תל אביב-יפו' }
      DIR = {
        city: new Map(d.cities.map((c) => [c.id, OVERRIDE[c.id] || c.nameHe])),
        school: new Map(d.schools.map((x) => [x.id, x.displayName || x.nameHe])),
        merges: CITY_MERGES,
      }
    }).catch(() => { DIR = { city: new Map(), school: new Map(), merges: {} } })
  const GRADE_HE = { 1: 'א׳', 2: 'ב׳', 3: 'ג׳', 4: 'ד׳', 5: 'ה׳', 6: 'ו׳', 7: 'ז׳', 8: 'ח׳', 9: 'ט׳', 10: 'י׳', 11: 'י״א', 12: 'י״ב' }
  const cityName = (id) => (DIR && DIR.city.get(String(DIR.merges[id] || id))) || null
  const schoolName = (id) => (DIR && DIR.school.get(String(id))) || null

  // metric defaults to 'trophies', NOT 'xp'. XP and trophies are ONE number — Adam, 2026-07-31:
  // "xp is trophies and ranks is ranked trophies or ranked xp" — so the server collapsed them into a
  // single גביעים metric backed by the xp column and there is no 'xp' key in METRICS any more. It
  // still ACCEPTS ?metric=xp as an input alias forever, but it always echoes 'trophies', so leaving
  // the default as 'xp' would highlight no pill on first paint (the `m.key === state.metric` test
  // below can never match an echo the server will not send).
  // `full` belongs to the PERSONAL board only: false = the podium + my neighbourhood (the default), true
  // = every ranked player, the way the cards app's board works (Adam, 2026-08-03: "so they can see the
  // full leaderboard on press"). Reset when the scope changes, so leaving and re-entering אני starts from
  // the window rather than from whatever the last visit left behind.
  const state = { me: null, labels: {}, metric: 'trophies', scope: 'city', view: 'home', findTerm: '', findSeed: 0, full: false }

  // Short unit words for the footer. Keyed by METRICS key, so it must track the server's table:
  // 'xp' is gone (it IS trophies) and 'ranked' is new (the rankPoints ladder — losable, humans-only,
  // what the tier badge is drawn from). A missing key here renders the literal «undefined».
  // A missing key here renders the literal «undefined», so it must track the server's METRICS table.
  // `views` joined 2026-08-03 — the cards economy's totalPoints, which is what a city gets ranked by.
  const METRIC_UNIT = { trophies: 'גביעים', ranked: 'דירוג', goals: 'שערים', wins: 'נצחונות', cards: 'קלפים', views: 'צפיות' }
  // 'personal' is the fifth scope: you against every player, the way the app's own leaderboard works.
  // The server accepts 'personal' or 'me' and always ECHOES 'personal' — never key anything off the
  // word that was sent.
  // 'grade' added 2026-08-04, together with SCOPE_KINDS server-side. It had to be added SERVER-FIRST:
  // boardScope() falls back to 'city' for an unknown scope, so a grade tab shipped ahead of the server
  // would have silently drawn the CITY board under a שכבות heading.
  const SCOPE_TABS = [['personal', 'אני'], ['city', 'עיר'], ['school', 'בית ספר'], ['grade', 'שכבה'], ['class', 'כיתה'], ['club', 'מועדון']]
  const TYPE_HE = { open: 'פתוח', invite: 'באישור', closed: 'סגור' }
  const ROLE_HE = { president: '👑 נשיא', vice: '🥈 סגן', senior: '⭐ בכיר', member: 'חבר' }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const num = (n) => Number(n || 0).toLocaleString('he-IL')

  // LEAVING THE CLUB — one implementation, two entry points (the «עזוב» action under the chips and
  // the 🚪 on my own roster row), so the reassurance can never exist on one of them and not the other.
  // A president is warned differently: they are not just leaving, they are handing the club over.
  async function leaveClub() {
    const club = state.me && state.me.club
    if (!club) return
    const president = club.myRole === 'president'
    const yes = await ask({
      title: `לצאת מ${club.name}?`,
      body: president
        ? 'אתם הנשיא — ביציאה המועדון עובר לחבר אחר. כדי לחזור תצטרכו לבקש להצטרף מחדש.'
        : 'כדי לחזור תצטרכו לבקש להצטרף מחדש, ומישהו יצטרך לאשר.',
      ok: 'צא מהמועדון', cancel: 'בטל', danger: true,
    })
    if (!yes) return
    await post('/leave')
    state.view = 'home'
    refresh()
  }

  async function refresh() {
    await dirReady
    state.me = await api('/me')
    if (state.me && state.me.scopes) {
      const sc = state.me.scopes
      state.labels = {
        city: sc.city ? cityName(sc.city.id) : null,
        school: sc.school ? schoolName(sc.school.id) : null,
        class: (sc.school && sc.grade != null && sc.classNumber != null)
          ? `${GRADE_HE[sc.grade] || sc.grade}${sc.classNumber} · ${schoolName(sc.school.id) || ''}` : null,
        club: state.me.club ? state.me.club.name : null,
      }
    }
    render()
  }

  // ── the CLUBS screen ────────────────────────────────────────────────────────────────────────────
  function render() {
    const body = $('#clubs .subpage-body')
    if (!body || !state.me) return
    body.innerHTML = ''
    // `.subpage-body` is the scroller for every other sub-screen. The split views manage their own
    // scrolling inside `.club-main`, so hand the height to them and switch the outer scroll off —
    // two nested scrollers on a phone is how you get a screen that moves when you meant to swipe a
    // list. Set as a class rather than `:has()`, which the older WebViews here may not support.
    body.classList.toggle('club-split', state.view !== 'create')
    if (state.view === 'create') return renderCreate(body)
    if (state.view === 'find') return renderFind(body)
    state.me.club ? renderMyClub(body) : renderNoClub(body)
  }

  // No club yet: the same split again, so the landing never scrolls either. Find sits ABOVE create,
  // which is the hierarchy Brawl Stars uses — searching is the common case and creating is the
  // fallback, expressed by order rather than by making one button louder than the other.
  function renderNoClub(body) {
    const grid = el('div', 'club-2col')
    const side = el('div', 'club-side')
    const main = el('div', 'club-main')
    grid.append(side, main)
    body.append(grid)

    side.append(el('div', 'club-hero', `<span class="club-hero-ic">🏰</span><b>הצטרפו למועדון</b>
      <small>שחקו יחד · התחרו מול מועדונים אחרים</small>`))
    const find = el('button', 'club-cta', '<span class="club-cta-ic">🔎</span><b>חפש מועדון</b>')
    find.onclick = () => { state.view = 'find'; render() }
    const create = el('button', 'club-cta', '<span class="club-cta-ic">➕</span><b>צור מועדון</b>')
    create.onclick = () => { state.view = 'create'; render() }
    side.append(find, create)

    main.append(el('div', 'club-band', '<b>השיוכים שלכם</b>'))
    main.append(myScopesStrip())
    main.append(el('div', 'scope-note', `אתם כבר חלק מהעיר, בית הספר והכיתה שלכם — אלה נקבעים לפי הפרטים
      באפליקציה ואי אפשר לצאת מהם. מועדון הוא הדבר היחיד שאתם בוחרים.`))
  }

  // MY CLUB is a TWO-COLUMN screen, not a stack. The game runs landscape (~1212x560), so height is
  // the scarce axis and width is abundant — a single column spent the whole 560px on the header,
  // the title, four rows of members and the buttons, and pushed the rest under the fold. This is the
  // layout Brawl Stars ships for exactly the same reason: a narrow identity/action column on one
  // side (measured at 37% of width there) and the roster taking the rest, scrolling on its own.
  //
  // Three density decisions come straight from that survey and are deliberate:
  //  • The member COUNT lives on the list's header band, not in the club card — it answers "how full
  //    are we" at the point of use, and it means the roster needs no separate title row (~40px back).
  //  • The actions sit at the BOTTOM OF THE SIDE COLUMN, which has spare height below the chips.
  //    In a stack they cost the list real rows; here they cost nothing.
  //  • Only the side column is fixed. `.club-main` scrolls internally, so the page itself never does.
  //
  // Portrait (a browser on a phone held upright, or a narrow window) collapses back to the old
  // single stack via CSS alone — see the `.club-2col` grid in clubs.css.
  function renderMyClub(body) {
    const c = state.me.club
    const grid = el('div', 'club-2col')
    const side = el('div', 'club-side')
    const main = el('div', 'club-main')
    grid.append(side, main)
    body.append(grid)

    side.append(el('div', 'club-card', `<span class="em">${c.emblem}</span>
      <div class="nm"><b>${esc(c.name)}</b><small>${ROLE_HE[c.myRole] || 'חבר'} · ${TYPE_HE[c.type]}${c.minTrophies ? ` · מ־${num(c.minTrophies)} 🏆` : ''}</small></div>`))
    side.append(myScopesStrip())

    // Pending join requests — only a president / vice / senior sees this block at all. It belongs
    // above the roster in the scrolling column: it's transient, and it's about people not yet in it.
    if (c.pending?.length) {
      main.append(el('div', 'club-band', `<b>בקשות הצטרפות</b><span class="club-band-n">${c.pending.length}</span>`))
      const pend = el('div', 'member-list')
      c.pending.forEach((p) => {
        const r = el('div', 'member', `<b>${esc(p.nickName)}</b><span class="xp">${num(p.trophies)} 🏆</span>`)
        const ok = el('button', 'club-join', 'אשר')
        ok.onclick = async () => { await post('/admit', { userId: p.id }); refresh() }
        r.append(ok); pend.append(r)
      })
      main.append(pend)
    }

    main.append(el('div', 'club-band', `<b>חברי המועדון</b><span class="club-band-n">${c.count}/${state.me.maxMembers}</span>`))
    const list = el('div', 'member-list' + (c.members.length < 3 ? ' solo' : ''))
    c.members.forEach((m, i) => {
      const r = el('div', 'member' + (m.isMe ? ' me' : ''),
        `<span class="pos">${i + 1}</span>
         <b class="member-name" data-uid="${m.id}">${esc(m.nickName)}</b>
         <span class="role">${ROLE_HE[m.role] || ''}</span>
         <span class="xp">${num(m.trophies)} 🏆</span>`)
      // Add friend, straight from the club. A member you already befriended shows the state instead.
      if (!m.isMe) {
        if (m.isFriend) r.append(el('span', 'fr-state', '✓ חבר'))
        else if (m.friendPending) r.append(el('span', 'fr-state', 'נשלחה'))
        else {
          const add = el('button', 'fr-add', '➕ חבר')
          // The refresh below is what USED to erase the result: the server never sent friendPending,
          // so the re-rendered row offered ➕ again and the tap looked like it did nothing (reported
          // 2026-08-01, "friend request stopped working in the clubs"). The server sends it now; the
          // button also says so immediately, and says so when it FAILS instead of staying silent.
          add.onclick = async (e) => {
            e.stopPropagation()
            add.disabled = true
            const res = await friendReq(m.id)
            if (res && !res.error) { add.replaceWith(el('span', 'fr-state', 'נשלחה')); refresh() }
            else { add.disabled = false; add.textContent = '➕ חבר · נכשל' }
          }
          r.append(add)
        }
      }
      // MY OWN ROW: the one thing I can do to myself here is leave. Reported 2026-08-02 — "cannot
      // remove myself as a friend in clubs, should be leave club with reassurance": the row offered
      // nothing at all for `isMe`, so the only way out was the small «עזוב» under the chips, which
      // reads as part of the club-browsing actions rather than something about me.
      if (m.isMe) {
        const out = el('button', 'fr-kick', '🚪')
        out.title = 'יציאה מהמועדון'
        out.onclick = (e) => { e.stopPropagation(); leaveClub() }
        r.append(out)
      }
      if (m.canKick) {
        const k = el('button', 'fr-kick', '✕')
        k.title = 'הסר מהמועדון'
        // Confirm first: a kick is instant, it is not undoable by the person kicked, and this ✕ sits
        // on a scrolling touch list right next to the add-friend button (reported 2026-08-02 —
        // "too easy to kick off club"). Naming the member is the point: it makes a mis-tap obvious.
        k.onclick = async (e) => {
          e.stopPropagation()
          const yes = await ask({
            title: `להסיר את ${m.nickName} מהמועדון?`,
            body: 'הוא יוכל לבקש להצטרף שוב, אבל תצטרכו לאשר אותו מחדש.',
            ok: 'הסר', cancel: 'בטל', danger: true,
          })
          if (!yes) return
          k.disabled = true
          await post('/kick', { userId: m.id })
          refresh()
        }
        r.append(k)
      }
      list.append(r)
    })
    main.append(list)

    // The two actions close the side column. They sit below the chips, in space that would otherwise
    // be blank — the roster pays nothing for them.
    const actions = el('div', 'club-actions')
    const invite = el('button', 'club-cta', '<span class="club-cta-ic">🔎</span><b>מועדונים</b>')
    invite.onclick = () => { state.view = 'find'; render() }
    const leave = el('button', 'club-ghost', 'עזוב')
    leave.onclick = () => leaveClub()
    actions.append(invite, leave)
    side.append(actions)
  }

  function renderCreate(body) {
    body.append(el('div', 'club-hero', `<span class="club-hero-ic">➕</span><b>צור מועדון</b>
      <small>עד ${state.me.maxMembers} חברים</small>`))
    const form = el('div', 'club-form')
    const input = el('input', 'club-input'); input.placeholder = 'שם המועדון'; input.maxLength = 20

    const emblems = ['🏰', '🦁', '⚡', '🦈', '🐪', '🔥', '⭐', '🐉', '👑', '⚽']
    let emblem = '🏰'
    const row = el('div', 'emblem-row')
    emblems.forEach((e) => {
      const b = el('button', 'emblem-pick' + (e === emblem ? ' on' : ''), e)
      b.onclick = () => { emblem = e; [...row.children].forEach((x) => x.classList.remove('on')); b.classList.add('on') }
      row.append(b)
    })

    // Brawl Stars' two entry conditions: who may walk in, and the trophy bar.
    let type = 'open'
    const types = el('div', 'scope-tabs')
    ;[['open', 'פתוח'], ['invite', 'באישור'], ['closed', 'סגור']].forEach(([k, label]) => {
      const t = el('button', 'scope-tab' + (k === type ? ' on' : ''), label)
      t.onclick = () => { type = k; [...types.children].forEach((x) => x.classList.remove('on')); t.classList.add('on') }
      types.append(t)
    })
    const minWrap = el('label', 'club-min', '<span>גביעים מינימום</span>')
    const min = el('input', 'club-input club-min-in'); min.type = 'number'; min.value = '0'; min.min = '0'
    minWrap.append(min)

    const err = el('div', 'club-err')
    const go = el('button', 'club-go', 'צור מועדון')
    go.onclick = async () => {
      const name = input.value.trim()
      if (name.length < 2) { err.textContent = 'שם קצר מדי'; return }
      const r = await post('/create', { name, emblem, type, minTrophies: Number(min.value) || 0 })
      if (r.error) { err.textContent = r.error === 'already_in_club' ? 'אתם כבר במועדון' : 'שם לא תקין'; return }
      state.view = 'home'; refresh()
    }
    const back = el('button', 'club-ghost', 'חזרה')
    back.onclick = () => { state.view = 'home'; render() }
    form.append(input, row, el('div', 'club-sec', 'מי יכול להצטרף'), types, minWrap, err, go)
    body.append(form, back)
    input.focus()
  }

  // FIND is the same two-column split as MY CLUB, and for the same reason: the search box, the
  // refresh and the back button are a fixed side panel, and the results get the whole other side
  // with its own scroll. It also matches what Brawl Stars ships today — its JOIN A CLUB screen is
  // ~34% actions / ~66% list, with the search field and CREATE stacked in the narrow column.
  async function renderFind(body) {
    const grid = el('div', 'club-2col')
    const side = el('div', 'club-side')
    const main = el('div', 'club-main')
    grid.append(side, main)
    body.append(grid)

    side.append(el('div', 'club-hero', `<span class="club-hero-ic">🔎</span><b>מועדונים קרובים אליכם</b>
      <small>לפי הכיתה, בית הספר והעיר שלכם</small>`))

    const searchWrap = el('div', 'club-form')
    const search = el('input', 'club-input'); search.placeholder = 'חיפוש לפי שם'; search.value = state.findTerm
    const again = el('button', 'club-ghost', '🔄 רענן רשימה')
    searchWrap.append(search)
    side.append(searchWrap, again)

    const list = el('div', 'scope-list')
    main.append(list)
    const back = el('button', 'club-ghost', 'חזרה')
    back.onclick = () => { state.view = 'home'; state.findTerm = ''; render() }
    side.append(back)

    // Typing refills the LIST only. Re-rendering the whole view on each keystroke rebuilt the input,
    // which on a phone drops the caret and closes the keyboard — and it silently discarded the term
    // when a re-render landed between the keystroke and the debounce.
    let t
    search.oninput = () => { clearTimeout(t); t = setTimeout(() => { state.findTerm = search.value.trim(); fillList() }, 250) }
    again.onclick = () => { state.findSeed++; fillList() }
    await fillList()

    async function fillList() {
      const { rows, myTrophies } = await api(`/find?q=${encodeURIComponent(state.findTerm)}&seed=${state.findSeed}`)
      list.innerHTML = ''
      if (!rows.length) { list.append(el('div', 'scope-note', 'לא נמצאו מועדונים.')); return }
      renderRows(rows, myTrophies, list)
    }
  }

  // Every refusal /join can return, in the player's words. `below_trophies` deliberately reuses the
  // same sentence as the 🔒 tooltip below: both come from ONE server predicate (meetsBar), so the
  // lock and the refusal cannot disagree.
  const JOIN_ERR = {
    below_trophies: '🔒 אין מספיק גביעים',
    club_full: 'המועדון מלא',
    closed: 'המועדון סגור',
    no_club: 'המועדון לא נמצא',
    bad_club: 'מועדון לא תקין',
    no_user: 'צריך להתחבר מחדש',
    server: 'שגיאה, נסו שוב',
    offline: 'אין חיבור',
  }

  function renderRows(rows, myTrophies, list) {
    const LABEL = { join: 'הצטרף', request: 'בקש', locked: '🔒 גביעים', closed: 'סגור', full: 'מלא' }
    rows.forEach((c) => {
      const meta = [`${TYPE_HE[c.type]}`, c.minTrophies ? `מ־${num(c.minTrophies)} 🏆` : 'ללא מינימום', `${c.count}/${state.me.maxMembers}`]
      if (c.friendsInside) meta.push(`${c.friendsInside} חברים שלכם`)
      const row = el('div', 'club-find-row', `<span class="em">${c.emblem}</span>
        <div class="nm"><b>${esc(c.name)}</b><small>${meta.join(' · ')}</small></div>`)
      const btn = el('button', 'club-join', LABEL[c.action])
      btn.disabled = c.action !== 'join' && c.action !== 'request'
      if (c.action === 'locked') btn.title = `צריך ${num(c.minTrophies)} גביעים · יש לכם ${num(myTrophies)}`
      btn.onclick = async () => {
        const r = await post('/join', { clubId: c.id })
        if (r.requested) { btn.textContent = 'נשלחה'; btn.disabled = true; return }
        if (!r.error) { state.view = 'home'; refresh(); return }
        // SAY WHY. This used to be `if (!r.error)` and nothing else, so every refusal was swallowed
        // and the button just did nothing — indistinguishable from a dead tap. It mattered more than
        // it looked: the trophy bar was reading a field that does not exist on FootballStats, so the
        // server answered `below_trophies` to EVERYONE on any club with a minimum and the player was
        // told nothing at all. The server side is fixed; this makes the remaining refusals legible.
        btn.textContent = JOIN_ERR[r.error] || 'לא הצליח'
        btn.disabled = true
      }
      row.append(btn)
      list.append(row)
    })
  }

  function myScopesStrip() {
    const s = state.labels || {}
    const strip = el('div', 'myscopes')
    const cell = (em, label, locked) => el('div', 'myscope' + (locked ? ' locked' : ''),
      `<span class="em">${em}</span><b>${label ? esc(label) : '—'}</b><small>${locked ? '🔒 מהאפליקציה' : 'נבחר'}</small>`)
    strip.append(
      cell('🏙️', s.city, true),
      cell('🏫', s.school, true),
      cell('🎒', s.class, true),
      cell(state.me.club?.emblem || '🏰', s.club, false),
    )
    return strip
  }

  // ── the PLAYER CARD — one surface for "tap any name anywhere" ───────────────────────────────────
  async function openPlayerCard(userId) {
    if (!userId) return
    let modal = $('#player-card')
    if (!modal) {
      modal = el('div', 'pc-back hidden'); modal.id = 'player-card'
      modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden') }
      document.body.appendChild(modal)
    }
    modal.innerHTML = '<div class="pc"><div class="pc-load">טוען…</div></div>'
    modal.classList.remove('hidden')

    const p = await api(`/player/${encodeURIComponent(userId)}`)
    if (p.error) { modal.classList.add('hidden'); return }
    const box = el('div', 'pc')
    box.append(el('div', 'pc-head', `<b>${esc(p.nickName)}</b>
      ${p.friend ? '<span class="pc-friend">✓ חבר שלכם</span>' : ''}
      <small>${num(p.trophies)} 🏆</small>`))

    // The two national placements Adam asked for, side by side.
    box.append(el('div', 'pc-ranks', `
      <div class="pc-rank"><small>גביעים</small><b>#${p.ranks.trophies.place ?? '—'}</b><i>מתוך ${p.ranks.trophies.of}</i></div>
      <div class="pc-rank"><small>דירוג</small><b>#${p.ranks.ranked.place ?? '—'}</b><i>מתוך ${p.ranks.ranked.of}</i></div>`))

    box.append(el('div', 'pc-sec', 'מועדון ושיוך'))
    const strip = el('div', 'myscopes')
    const cell = (em, label, locked, hidden) => el('div', 'myscope' + (locked ? ' locked' : '') + (hidden ? ' hidden-scope' : ''),
      `<span class="em">${em}</span><b>${label ? esc(label) : (hidden ? 'רק לחברים' : '—')}</b><small>${hidden ? '🔒' : locked ? '🔒 מהאפליקציה' : 'נבחר'}</small>`)
    strip.append(
      cell('🏙️', p.scopes.city?.label, true, false),
      cell('🏫', p.scopes.school?.label, true, !p.friend),
      cell('🎒', p.scopes.class?.label, true, !p.friend),
      cell(p.club?.emblem || '🏰', p.club ? `${p.club.name}` : null, false, false),
    )
    box.append(strip)
    if (p.club) box.append(el('div', 'scope-note', `${ROLE_HE[p.club.role] || 'חבר'} · ${p.club.count}/30 חברים`))

    // One card, two states. A friend gets the friend actions — the same gesture the friends list
    // offers, so tapping a name in a club or in a match lands somewhere that behaves identically.
    if (p.friend) {
      // NO message button here, deliberately. client.js's openThread(f) gates on canMessage(f) against
      // the real FRIENDS list, so handing it a synthetic {userId, nickName} silently no-ops — a button
      // that looks live and does nothing. Messaging belongs on this card only once the card is fed by
      // the real friends list (i.e. when this API moves into pikme-server), not before.
      const rm = el('button', 'pc-remove', 'הסר חבר')
      rm.onclick = async () => {
        // Confirm first: unfriending is not undoable, the other side has to re-accept. Same rule AND
        // the same dialog as client.js removeFriend() — window.confirm() is not shown by every
        // WebView host, which is why "are you sure" never reached the player (2026-08-02). Falls
        // back to confirm() only if this card is somehow loaded without client.js.
        const ask = window.askConfirm || ((o) => Promise.resolve(confirm(o.title)))
        const yes = await ask({
          title: `להסיר את ${p.nickName} מרשימת החברים?`,
          body: 'הוא יוסר גם אצלו, ותצטרכו לאשר בקשה חדשה כדי לחזור להיות חברים.',
          ok: 'הסר', cancel: 'בטל', danger: true,
        })
        if (!yes) return
        rm.disabled = true; rm.textContent = 'מסיר…'
        await friendDel(p.id)
        openPlayerCard(p.id)   // re-render: the card flips back to «הוסף כחבר»
      }
      box.append(rm)
    } else {
      const add = el('button', 'club-go', p.friendPending ? 'בקשה נשלחה' : '➕ הוסף כחבר')
      add.disabled = !!p.friendPending
      add.onclick = async () => {
        add.disabled = true
        const res = await friendReq(p.id)
        if (res && !res.error) { add.textContent = 'בקשה נשלחה' }
        else { add.disabled = false; add.textContent = 'השליחה נכשלה · נסו שוב' }
      }
      box.append(add)
    }
    const close = el('button', 'club-ghost', 'סגור')
    close.onclick = () => modal.classList.add('hidden')
    box.append(close)
    modal.innerHTML = ''
    modal.appendChild(box)
  }
  window.openPlayerCard = openPlayerCard

  // Any element carrying data-uid opens that player's card — club member rows today, in-game name
  // plates and scoreboard rows as soon as they carry the attribute.
  document.addEventListener('click', (e) => {
    const n = e.target.closest?.('[data-uid]')
    if (n && n.dataset.uid) { e.stopPropagation(); openPlayerCard(n.dataset.uid) }
  }, true)

  // ── the RANK screen ─────────────────────────────────────────────────────────────────────────────
  async function renderBoard() {
    const host = $('#scope-board')
    if (!host || !state.me) return
    // ⚠️ WAIT FOR THE DIRECTORY, or the board prints RAW IDS instead of names — «1953726605» where the
    // player expects «חיפה». The server ships ids only (it has no directory); the 428KB
    // /data/schools-directory.json resolves them HERE. refresh() has always awaited this, but this
    // function is also reached straight off `watch('rank', renderBoard)`, so opening דירוג before the
    // JSON lands rendered ids — and NOTHING re-rendered when it arrived, so they stayed for the whole
    // session. That is exactly the reported "i still dont see which schools is ranked up and which city
    // is ranked up". Reproduced with a 4s-delayed directory in _rank-full-board.mjs; after the first load
    // this await is a resolved promise and costs nothing.
    await dirReady
    host.innerHTML = ''

    const metrics = el('div', 'scope-metrics')
    state.me.metrics.forEach((m) => {
      const p = el('button', 'metric-pill' + (m.key === state.metric ? ' on' : ''), m.labelHe)
      p.onclick = () => { state.metric = m.key; renderBoard() }
      metrics.append(p)
    })
    const tabs = el('div', 'scope-tabs')
    SCOPE_TABS.forEach(([key, label]) => {
      const t = el('button', 'scope-tab' + (key === state.scope ? ' on' : ''), label)
      t.onclick = () => { state.scope = key; state.full = false; renderBoard() }
      tabs.append(t)
    })
    const list = el('div', 'scope-list')
    host.append(metrics, tabs, list)

    const data = await api(`/board?metric=${state.metric}&scope=${state.scope}${state.full ? '&full=1' : ''}`)
    // The server echoes the CANONICAL scope, so branch on what came back, not on what we asked for
    // (?scope=me is accepted and answered as 'personal').
    if (data.scope === 'personal') return renderPersonal(data, list)
    if (!data.rows.length) { list.append(el('div', 'scope-note', 'עדיין אין מספיק שחקנים כאן.')); return }
    // The unit comes from the metric the SERVER echoed, not from local state: the two diverge whenever the
    // server canonicalises the request (?metric=xp is answered as 'trophies'), and the label must describe
    // the column the numbers actually came from. Falls back to local state for an older server.
    const unit = METRIC_UNIT[data.metric] || METRIC_UNIT[state.metric] || ''
    data.rows.slice(0, 20).forEach((r) => {
      if (!r.label) {
        if (state.scope === 'city') r.label = cityName(r.scopeId)
        else if (state.scope === 'school') r.label = schoolName(r.scopeId)
        // grade + class are ranked INSIDE the caller's own school now (server SCHOOL_SCOPED), so every row
        // on the board shares one school and naming it per row is pure noise. The heading carries it once.
        // ⚠️ The KEY still contains the semel — it is parsed positionally here and the server deliberately
        // kept it so shipped clients cannot break. Read it, just do not print it.
        else if (state.scope === 'grade') {
          const [, g] = String(r.scopeId).split('|')
          r.label = `שכבת ${GRADE_HE[g] || g}`
        }
        else if (state.scope === 'class') {
          const [, g, c] = String(r.scopeId).split('|')
          r.label = `${GRADE_HE[g] || g}${c}`
        }
      }
      r.label = r.label || String(r.scopeId)
      r.emblem = r.emblem || ({ city: '🏙️', school: '🏫', grade: '📚', class: '🎒', club: '🏰' }[state.scope])
      const mine = r.scopeId === data.mineScopeId
      list.append(el('div', `scope-row${mine ? ' mine' : ''}${r.rank === 1 ? ' top1' : ''}`,
        `<span class="pos">${r.rank}</span><span class="em">${r.emblem}</span>
         <div class="nm"><b>${esc(r.label)}</b><small>${r.members} שחקנים</small></div>
         <div class="sc">${num(r.value)}<small>${unit}</small></div>`))
    })
    // ⚠️ THE RULE CHANGED 2026-08-03 (Adam: "ranked simialr to players"): a group's number is the plain
    // SUM of its members' metric and the HIGHEST wins — the same number and the same direction as the
    // player board, which is the whole point. It used to be the sum of the best 3 national PLACES with the
    // lowest winning, and this note used to explain that a small town could beat a big city. It cannot any
    // more: the headcount trade-off is real and accepted until a population fix is chosen (server
    // routes-pikme/leaderboard/placement.js keeps rankScopes for that), so the copy must NOT keep
    // promising fairness the scoring no longer delivers.
    // grade/class are compared WITHIN one school, so the copy must not imply a national table. Saying
    // "every class in the country" when the server ranks only my school would be the same class of lie the
    // top-K note was.
    const myScopeNote = SCHOOL_SCOPED_TABS.indexOf(state.scope) !== -1
      ? `הדירוג הוא בין ה${scopeWord(state.scope)}ות בבית הספר שלך.`
      : ''
    list.append(el('div', 'scope-note',
      `הניקוד = סכום ה${unit} של כל השחקנים ב${scopeWord(state.scope)} — הגבוה ביותר מנצח.
       ${myScopeNote}
       (${data.totalRanked} שחקנים מדורגים)`))
  }
  const scopeWord = (s) => ({ city: 'עיר', school: 'בית ספר', grade: 'שכבה', class: 'כיתה', club: 'מועדון', personal: 'הארץ' }[s] || s)
  // Mirrors SCHOOL_SCOPED in pikme-server routes-pikme/leaderboard/groups.js.
  const SCHOOL_SCOPED_TABS = ['grade', 'class']

  // ── the PERSONAL board: you against every player ────────────────────────────────────────────────
  // A different row shape from the four group boards, so it gets its own renderer rather than more
  // branches inside the group one. A personal row is a PLAYER:
  //     { rank, userId?, nickName, image, club, emblem, value, isMe }
  // and has NO scopeId, score, members or padded. The body also drops `k` and `mineScopeId`, which is
  // why the group footer cannot be reused — it would print «undefined» twice and explain a top-K
  // scoring rule that does not apply here (this board is simply highest-value-wins).
  //
  // Shaped after the app's own leaderboard so the two read as one feature: the window is top 3 + you
  // and your neighbours, your row is highlighted IN PLACE (never pinned, never duplicated), a hairline
  // divider marks wherever the ranks jump, and the standing line is the app's sentence word for word.
  function renderPersonal(data, list) {
    const rows = data.rows || []
    const me = data.me || {}
    if (!rows.length) {
      list.append(el('div', 'scope-note', 'עדיין אין שחקנים מדורגים.'))
      return
    }
    let prev = null
    rows.forEach((r) => {
      // One divider wherever the window skips ranks — the entire "you are far from the top"
      // affordance, same as the app. No ellipsis row, no count of who was skipped.
      if (prev != null && r.rank - prev > 1) list.append(el('div', 'scope-gap'))
      prev = r.rank
      const row = el('div', `scope-row${r.isMe ? ' mine' : ''}${r.rank === 1 ? ' top1' : ''}`,
        `<span class="pos">${r.rank}</span><span class="em">${r.emblem || '⚽'}</span>
         <div class="nm"><b>${esc(r.nickName || 'שחקן')}${r.isMe ? ' · אני' : ''}</b>${r.club ? `<small>${esc(r.club)}</small>` : ''}</div>
         <div class="sc">${num(r.value)}<small>${METRIC_UNIT[state.metric] || ''}</small></div>`)
      // data-uid ONLY when the server actually resolved an identity. It OMITS the key rather than
      // nulling it precisely for this: the string "null" is truthy to the delegate above, so a
      // `data-uid="null"` would open a player card that 400s.
      if (r.userId) row.dataset.uid = r.userId
      list.append(row)
    })
    // The standing line, in the app's words. An unranked caller is never given a fabricated place —
    // the server sends rank null for a zero value and this says so instead of printing «#0».
    list.append(el('div', 'scope-note', me.rank
      ? `אתה במקום ${num(me.rank)} מתוך ${num(data.totalRanked)} שחקנים`
      : `עדיין לא מדורג · ${num(data.totalRanked)} שחקנים`))

    // «כל הטבלה» — the full leaderboard, the way the cards app's board works. Only offered when there is
    // actually more to see: with 6 ranked players the window already IS the whole table, and a button that
    // changes nothing on press is worse than no button.
    // Branch on the server's echoed `full`, never on state.full — the two disagree for the frame between
    // a tap and the response, and the echo is the one that describes the rows on screen.
    const showingAll = data.full || data.totalRanked <= rows.length
    if (!showingAll || data.full) {
      const btn = el('button', 'scope-more', data.full ? 'קרוב אליי' : `כל הטבלה · ${num(data.totalRanked)} שחקנים`)
      btn.onclick = () => { state.full = !data.full; renderBoard() }
      list.append(btn)
    }
  }

  // ── injections into the two screens other agents own ────────────────────────────────────────────
  // The friend modal (client.js) gets a club + memberships block appended; the profile side pane
  // (profile.js) gets the same block under the hero / trophies / cards. Both are done from OUT here
  // so those files keep almost no clubs code — see the FOOTPRINT note at the top.
  // ⚠️ `hostSel` IS A PRIORITY LIST, TRIED IN ORDER — it must NOT be a comma selector.
  // `querySelector('a, b')` returns the first match in DOCUMENT ORDER, not the first selector that
  // matches: with 'modal .fp-card, modal' it always answered the MODAL, because the overlay precedes
  // the card it contains. That is how the rank block ended up beside the card instead of in it, and
  // (once an anchor was added) how insertBefore started throwing NotFoundError — the anchor was a
  // descendant of the card, never a child of the overlay.
  // /player/:id memo. Two reasons, both measured: it takes the network round trip OFF the hot path so
  // a repaint can no longer land in the middle of one (the await collapses to a microtask), and a pane
  // that repaints twice stops costing two identical requests. Short TTL — this is rank/club data on a
  // screen the player opens rarely, so staleness is cheap and a stale read is never wrong for long.
  const _playerMemo = new Map()   // userId -> { at, payload }
  const PLAYER_TTL_MS = 15000
  async function playerCard(userId) {
    const hit = _playerMemo.get(userId)
    if (hit && Date.now() - hit.at < PLAYER_TTL_MS) return hit.payload
    const p = await api(`/player/${encodeURIComponent(userId)}`)
    if (p && !p.error) _playerMemo.set(userId, { at: Date.now(), payload: p })
    return p
  }

  async function injectInto(hostSels, userId, markerCls, beforeSel) {
    const sels = Array.isArray(hostSels) ? hostSels : [hostSels]
    const pick = () => sels.map((s) => $(s)).find(Boolean)
    if (!pick() || pick().querySelector('.' + markerCls)) return
    const p = await playerCard(userId)
    if (!p || p.error) return
    // ⚠️ RE-RESOLVE THE HOST *AFTER* THE AWAIT. Capturing it before was the defect the audit caught:
    // on 100% of measured profile loads the pane captured here had already been thrown away by
    // renderProfile (`root.innerHTML = ''` builds a NEW .pf-side), so the append went into a detached
    // node — it painted nothing and was garbage collected. Recovering afterwards (the retry below in
    // injectMyClubs) hid the symptom but still paid for a dead append and a wasted request every load.
    // `isConnected` is the honest test: a node can match a selector and still be out of the document.
    const host = pick()
    if (!host || !host.isConnected || host.querySelector('.' + markerCls)) return
    const block = el('div', markerCls)
    block.append(el('div', 'pc-sec', 'מועדון ושיוך'))
    const strip = el('div', 'myscopes')
    const cell = (em, label, hidden) => el('div', 'myscope' + (hidden ? ' hidden-scope' : ''),
      `<span class="em">${em}</span><b>${label ? esc(label) : (hidden ? 'רק לחברים' : '—')}</b>`)
    strip.append(
      cell('🏙️', p.scopes.city?.label, false),
      cell('🏫', p.scopes.school?.label, !p.friend),
      cell('🎒', p.scopes.class?.label, !p.friend),
      cell(p.club?.emblem || '🏰', p.club?.name, false),
    )
    block.append(strip)
    block.append(el('div', 'pc-ranks', `
      <div class="pc-rank"><small>גביעים</small><b>#${p.ranks.trophies.place ?? '—'}</b></div>
      <div class="pc-rank"><small>דירוג</small><b>#${p.ranks.ranked.place ?? '—'}</b></div>`))
    // Place it INSIDE the card, above whatever closing control the host has (the friend modal ends
    // with «הסר חבר», and a rank strip below a destructive button reads as part of it).
    // insertBefore demands a DIRECT child, so only use the anchor when it actually is one.
    const anchor = beforeSel && host.querySelector(beforeSel)
    if (anchor && anchor.parentNode === host) host.insertBefore(block, anchor)
    else host.appendChild(block)
  }

  // `init` defaults to watching only the `class` attribute — i.e. "the screen was shown". That is
  // enough for a screen whose content is built BEFORE it is unhidden (the friend modal), and NOT
  // enough for one that repaints itself afterwards — see the profile watcher below.
  // MY OWN profile pane, re-entrant by design: the subtree observer above fires once per DOM change
  // during a repaint (dozens of times), so this has to be cheap and safe to call repeatedly.
  //   • the marker check makes an already-injected pane a no-op;
  //   • `busy` stops two mutations in the same tick from both getting past that check and firing two
  //     /player/:id requests (and appending the block twice);
  //   • injecting appends into .pf-side, which is itself a subtree mutation — the marker check is what
  //     stops that from looping.
  // The player visits this screen rarely, so one request per genuine repaint is the right trade for
  // never showing a pane with the clubs and rank missing.
  let _myClubsBusy = false
  let _myClubsDirty = false
  async function injectMyClubs() {
    // ⚠️ A REPAINT THAT LANDS MID-REQUEST MUST NOT BE DROPPED. Returning early while busy was a
    // residual hole in the re-inject fix: /player/:id takes a network round trip, and if
    // renderProfile #2 replaces .pf-side during that window, the block we are about to append goes
    // into a node that has already been discarded — and the mutation that would have re-triggered us
    // was swallowed by the busy flag. Net effect: the pane ends up with no block at all, i.e. exactly
    // the bug we were fixing, just in a narrower window. So remember the missed tick and retry.
    if (_myClubsBusy) { _myClubsDirty = true; return }
    if (!state.me || !state.me.me) return        // /me failed at boot; nothing to inject yet
    if (!$('.pf-side') || $('.pf-side').querySelector('.pf-clubs')) return
    _myClubsBusy = true
    try {
      // Loop, not a single call: each pass clears the flag first, so a repaint arriving DURING the
      // await is caught by the next iteration. Terminates because the guard below stops as soon as a
      // live pane holds the block — and if no pane exists any more there is nothing left to do.
      for (;;) {
        _myClubsDirty = false
        await injectInto(['.pf-side'], state.me.me.id, 'pf-clubs')
        const pane = $('.pf-side')
        if (!_myClubsDirty || !pane || pane.querySelector('.pf-clubs')) break
      }
    } finally { _myClubsBusy = false }
  }

  function watch(id, fn, init) {
    const node = document.getElementById(id)
    if (!node) return
    new MutationObserver(() => { if (!node.classList.contains('hidden')) fn(node) })
      .observe(node, init || { attributes: true, attributeFilter: ['class'] })
  }

  window.addEventListener('DOMContentLoaded', async () => {
    // The clubs API is now REAL and authenticated (pikme-server /handle-clubs/*). We still bail before
    // touching the DOM when it does not answer — no football-token (game opened outside the app), or
    // the API unreachable — so the «בקרוב» stub stays and nobody sees a half-dead screen.
    state.me = await api('/me').catch(() => null)
    if (!state.me || state.me.error || !state.me.me) {
      // Say WHY, on screen. An empty panel is indistinguishable from a broken one, and the three
      // reasons need completely different fixes — so name the one that actually happened instead of
      // making someone guess from a blank box. Deliberately terse and Hebrew-first; the console line
      // carries the detail for whoever is debugging.
      const why = !TOKEN ? 'פתחו את המשחק מתוך האפליקציה'
        : state.me && /http_401|http_403/.test(state.me.error || '') ? 'ההזדהות פגה — סגרו ופתחו מחדש'
        : 'אין חיבור לשרת כרגע'
      console.log('[clubs] inactive:', { hasToken: !!TOKEN, base: BASE, error: state.me && state.me.error })
      const body = $('#clubs .subpage-body')
      if (body && !body.childElementCount) {
        body.append(el('div', 'club-hero', `<span class="club-hero-ic">🏰</span><b>מועדונים</b><small>${why}</small>`))
      }
      return
    }
    document.getElementById('scope-wrap')?.classList.remove('hidden')
    render()
    watch('clubs', () => { state.view = 'home'; refresh() })
    watch('rank', renderBoard)
    // client.js stamps the friend's id on the modal (one line there); we fill the rest.
    watch('friend-profile-modal', (n) => {
      n.querySelector('.fp-clubs')?.remove()
      const uid = n.dataset.userId
      // ⚠️ THE HOST IS `.fp-card`, NOT THE MODAL — and that one selector was the whole "a friend's
      // profile doesn't show his rank" bug (2026-08-02). This modal has NO `.fp-body`, so the old
      // selector fell through to `#friend-profile-modal`, which is the full-screen overlay:
      // `display:flex; align-items:center; justify-content:center`. The block therefore became a
      // SECOND FLEX CHILD sitting BESIDE the card, not inside it — on a wide iPad there was room so
      // it was visible, on a landscape phone it was squeezed off-screen. Hence "shows on the iPad,
      // missing on the iPhone". `.fp-card` already has `max-height:92vh; overflow-y:auto`, so once
      // the block lands inside it, it scrolls into reach at any height.
      if (uid) injectInto(['#friend-profile-modal .fp-card', '#friend-profile-modal'], uid, 'fp-clubs', '#fp-remove')
    })
    // The profile page's fixed right pane — under hero / trophies / cards.
    //
    // ⚠️ WATCHES childList+subtree, NOT just `class`, AND HAS NO TIMER. Both matter (measured
    // 2026-08-03, _profile-clubs-race.mjs). This used to be
    // `watch('profile', () => setTimeout(() => injectInto(...), 250))`, and openProfile() paints the
    // page TWICE: once from cached numbers, then again after `await fetchOwnStats()` resolves. The
    // second render REBUILDS #profile and destroys whatever was injected into it, and the old
    // class-only observer never fired again — so the clubs strip and the גביעים/דירוג block appeared
    // only when the stats call happened to beat the 250ms timer. Adam saw it "sometimes show and
    // sometimes not"; the deciding call (/handle-friends/rank) measures 166–269ms from prod, i.e. it
    // straddles the threshold, and loses more often on cellular.
    // Watching the subtree means every repaint re-triggers this, so the block cannot be orphaned.
    watch('profile', injectMyClubs, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true })
    renderBoard()
  })
})()
