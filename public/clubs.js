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
  const api = (p, opt) => fetch('/api/clubs' + p, opt).then((r) => r.json())
  const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })

  const state = { me: null, metric: 'xp', scope: 'city', view: 'home', findTerm: '', findSeed: 0 }

  const METRIC_UNIT = { xp: 'XP', trophies: 'גביעים', goals: 'שערים', wins: 'נצחונות', cards: 'קלפים' }
  const SCOPE_TABS = [['city', 'עיר'], ['school', 'בית ספר'], ['class', 'כיתה'], ['club', 'מועדון']]
  const TYPE_HE = { open: 'פתוח', invite: 'באישור', closed: 'סגור' }
  const ROLE_HE = { president: '👑 נשיא', vice: '🥈 סגן', senior: '⭐ בכיר', member: 'חבר' }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const num = (n) => Number(n || 0).toLocaleString('he-IL')

  async function refresh() { state.me = await api('/me'); render() }

  // ── the CLUBS screen ────────────────────────────────────────────────────────────────────────────
  function render() {
    const body = $('#clubs .subpage-body')
    if (!body || !state.me) return
    body.innerHTML = ''
    if (state.view === 'create') return renderCreate(body)
    if (state.view === 'find') return renderFind(body)
    state.me.club ? renderMyClub(body) : renderNoClub(body)
  }

  function renderNoClub(body) {
    body.append(el('div', 'club-hero', `<span class="club-hero-ic">🏰</span><b>הצטרפו למועדון</b>
      <small>שחקו יחד · התחרו מול מועדונים אחרים</small>`))
    const create = el('button', 'club-cta', '<span class="club-cta-ic">➕</span><b>צור מועדון</b>')
    create.onclick = () => { state.view = 'create'; render() }
    const find = el('button', 'club-cta', '<span class="club-cta-ic">🔎</span><b>חפש מועדון</b>')
    find.onclick = () => { state.view = 'find'; render() }
    body.append(create, find, myScopesStrip())
    body.append(el('div', 'scope-note', `אתם כבר חלק מהעיר, בית הספר והכיתה שלכם — אלה נקבעים לפי הפרטים
      באפליקציה ואי אפשר לצאת מהם. מועדון הוא הדבר היחיד שאתם בוחרים.`))
  }

  function renderMyClub(body) {
    const c = state.me.club
    body.append(el('div', 'club-card', `<span class="em">${c.emblem}</span>
      <div class="nm"><b>${esc(c.name)}</b><small>${ROLE_HE[c.myRole] || 'חבר'} · ${TYPE_HE[c.type]}${c.minTrophies ? ` · מ־${num(c.minTrophies)} 🏆` : ''}</small></div>
      <div class="club-count">${c.count}/${state.me.maxMembers}<small>חברים</small></div>`))

    // Pending join requests — only a president / vice / senior sees this block at all.
    if (c.pending?.length) {
      body.append(el('div', 'club-sec', `בקשות הצטרפות · ${c.pending.length}`))
      const pend = el('div', 'member-list')
      c.pending.forEach((p) => {
        const r = el('div', 'member', `<b>${esc(p.nickName)}</b><span class="xp">${num(p.trophies)} 🏆</span>`)
        const ok = el('button', 'club-join', 'אשר')
        ok.onclick = async () => { await post('/admit', { userId: p.id }); refresh() }
        r.append(ok); pend.append(r)
      })
      body.append(pend)
    }

    body.append(el('div', 'club-sec', 'חברי המועדון'))
    const list = el('div', 'member-list')
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
          add.onclick = async (e) => { e.stopPropagation(); await post('/friend-request', { userId: m.id }); refresh() }
          r.append(add)
        }
      }
      if (m.canKick) {
        const k = el('button', 'fr-kick', '✕')
        k.title = 'הסר מהמועדון'
        k.onclick = async (e) => { e.stopPropagation(); await post('/kick', { userId: m.id }); refresh() }
        r.append(k)
      }
      list.append(r)
    })
    body.append(list)

    const invite = el('button', 'club-cta', '<span class="club-cta-ic">🔎</span><b>מועדונים אחרים</b>')
    invite.onclick = () => { state.view = 'find'; render() }
    const leave = el('button', 'club-ghost', 'עזבו את המועדון')
    leave.onclick = async () => { await post('/leave'); state.view = 'home'; refresh() }
    body.append(invite, leave, myScopesStrip())
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

  async function renderFind(body) {
    body.append(el('div', 'club-hero', `<span class="club-hero-ic">🔎</span><b>מועדונים קרובים אליכם</b>
      <small>לפי הכיתה, בית הספר והעיר שלכם</small>`))

    const searchWrap = el('div', 'club-form')
    const search = el('input', 'club-input'); search.placeholder = 'חיפוש לפי שם'; search.value = state.findTerm
    const again = el('button', 'club-ghost', '🔄 רענן רשימה')
    searchWrap.append(search)
    body.append(searchWrap, again)

    const list = el('div', 'scope-list')
    body.append(list)
    const back = el('button', 'club-ghost', 'חזרה')
    back.onclick = () => { state.view = 'home'; state.findTerm = ''; render() }
    body.append(back)

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
        if (!r.error) { state.view = 'home'; refresh() }
      }
      row.append(btn)
      list.append(row)
    })
  }

  function myScopesStrip() {
    const s = state.me.scopes
    const strip = el('div', 'myscopes')
    const cell = (em, label, locked) => el('div', 'myscope' + (locked ? ' locked' : ''),
      `<span class="em">${em}</span><b>${label ? esc(label) : '—'}</b><small>${locked ? '🔒 מהאפליקציה' : 'נבחר'}</small>`)
    strip.append(
      cell('🏙️', s.city?.label, true),
      cell('🏫', s.school?.label, true),
      cell('🎒', s.class?.label, true),
      cell(state.me.club?.emblem || '🏰', s.club?.label, false),
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
      <small>${num(p.trophies)} 🏆 · ${num(p.xp)} XP</small>`))

    // The two national placements Adam asked for, side by side.
    box.append(el('div', 'pc-ranks', `
      <div class="pc-rank"><small>דירוג גביעים</small><b>#${p.ranks.trophies.place ?? '—'}</b><i>מתוך ${p.ranks.of || p.ranks.trophies.of}</i></div>
      <div class="pc-rank"><small>דירוג XP</small><b>#${p.ranks.xp.place ?? '—'}</b><i>מתוך ${p.ranks.xp.of}</i></div>`))

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
        // Confirm first: unfriending is not undoable, the other side has to re-accept. Same rule as
        // client.js removeFriend().
        if (!confirm(`להסיר את ${p.nickName} מרשימת החברים?`)) return
        rm.disabled = true; rm.textContent = 'מסיר…'
        await post('/friend-remove', { userId: p.id })
        openPlayerCard(p.id)   // re-render: the card flips back to «הוסף כחבר»
      }
      box.append(rm)
    } else {
      const add = el('button', 'club-go', p.friendPending ? 'בקשה נשלחה' : '➕ הוסף כחבר')
      add.disabled = !!p.friendPending
      add.onclick = async () => { await post('/friend-request', { userId: p.id }); add.textContent = 'בקשה נשלחה'; add.disabled = true }
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
      t.onclick = () => { state.scope = key; renderBoard() }
      tabs.append(t)
    })
    const list = el('div', 'scope-list')
    host.append(metrics, tabs, list)

    const data = await api(`/board?metric=${state.metric}&scope=${state.scope}`)
    if (!data.rows.length) { list.append(el('div', 'scope-note', 'עדיין אין מספיק שחקנים כאן.')); return }
    data.rows.slice(0, 20).forEach((r) => {
      const mine = r.scopeId === data.mineScopeId
      list.append(el('div', `scope-row${mine ? ' mine' : ''}${r.rank === 1 ? ' top1' : ''}`,
        `<span class="pos">${r.rank}</span><span class="em">${r.emblem}</span>
         <div class="nm"><b>${esc(r.label)}</b><small>${r.members} שחקנים${r.padded ? ` · חסרים ${r.padded}` : ''}</small></div>
         <div class="sc">${r.score}<small>ניקוד</small></div>`))
    })
    list.append(el('div', 'scope-note',
      `הניקוד = סכום המקומות הארציים של ${data.k} השחקנים הטובים ביותר ב${scopeWord(state.scope)} — הנמוך ביותר מנצח.
       ככה יישוב קטן עם ${data.k} שחקנים חזקים מנצח עיר גדולה, ומספר השחקנים לבדו לא קובע.
       (${METRIC_UNIT[state.metric]} · ${data.totalRanked} שחקנים מדורגים)`))
  }
  const scopeWord = (s) => ({ city: 'עיר', school: 'בית ספר', class: 'כיתה', club: 'מועדון' }[s] || s)

  // ── injections into the two screens other agents own ────────────────────────────────────────────
  // The friend modal (client.js) gets a club + memberships block appended; the profile side pane
  // (profile.js) gets the same block under the hero / trophies / cards. Both are done from OUT here
  // so those files keep almost no clubs code — see the FOOTPRINT note at the top.
  async function injectInto(hostSel, userId, markerCls) {
    const host = $(hostSel)
    if (!host || host.querySelector('.' + markerCls)) return
    const p = await api(`/player/${encodeURIComponent(userId)}`)
    if (p.error) return
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
      <div class="pc-rank"><small>דירוג גביעים</small><b>#${p.ranks.trophies.place ?? '—'}</b></div>
      <div class="pc-rank"><small>דירוג XP</small><b>#${p.ranks.xp.place ?? '—'}</b></div>`))
    host.appendChild(block)
  }

  function watch(id, fn) {
    const node = document.getElementById(id)
    if (!node) return
    new MutationObserver(() => { if (!node.classList.contains('hidden')) fn(node) })
      .observe(node, { attributes: true, attributeFilter: ['class'] })
  }

  window.addEventListener('DOMContentLoaded', async () => {
    // THE GATE, client half. The clubs API 404s off-LAN (see clubs/devapi.mjs), so on prod this
    // bails before touching the DOM: the «בקרוב» stub in index.html stays exactly as it is today and
    // the rank page's scoped block stays hidden. Never render this feature against fake seeded data
    // for real players.
    state.me = await api('/me').catch(() => null)
    if (!state.me || state.me.error || !state.me.me) return
    document.getElementById('scope-wrap')?.classList.remove('hidden')
    render()
    watch('clubs', () => { state.view = 'home'; refresh() })
    watch('rank', renderBoard)
    // client.js stamps the friend's id on the modal (one line there); we fill the rest.
    watch('friend-profile-modal', (n) => {
      n.querySelector('.fp-clubs')?.remove()
      const uid = n.dataset.userId
      if (uid) injectInto('#friend-profile-modal .fp-body, #friend-profile-modal', uid, 'fp-clubs')
    })
    // The profile page's fixed right pane — under hero / trophies / cards.
    watch('profile', () => setTimeout(() => injectInto('.pf-side', state.me.me.id, 'pf-clubs'), 250))
    renderBoard()
  })
})()
