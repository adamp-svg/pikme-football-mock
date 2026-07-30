/* Clubs + scoped ranking, client side.
 *
 * Two different things share the word "club" and the UI must not blur them:
 *   • DERIVED scopes — city / school / class. Come from the player's app profile, read-only, you can
 *     never leave them. Rendered with a lock hint, never with a join or leave button.
 *   • The CLUB — user created, user named, one per player, 30 max, joinable and leavable.
 *
 * Every board is scored by top-K placement (clubs/placement.mjs): the sum of a scope's best K members'
 * NATIONAL places, lowest wins. That is why a 3-player town can outrank תל אביב.
 *
 * Privacy: the server orders "find clubs" and "suggest players" by how close someone is to you, but it
 * never returns anyone else's city/school/grade/class and never says WHY a row ranked high. Do not add
 * a "same class as you" badge here — that is the exact leak his frozen profile spec forbids.
 */
(function () {
  const $ = (s, r = document) => r.querySelector(s)
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n }
  const api = (p, opt) => fetch('/api/clubs' + p, opt).then((r) => r.json())

  const state = { me: null, metric: 'xp', scope: 'city', view: 'home' }

  const METRIC_UNIT = { xp: 'XP', trophies: 'גביעים', goals: 'שערים', wins: 'נצחונות', cards: 'קלפים' }
  const SCOPE_TABS = [['city', 'עיר'], ['school', 'בית ספר'], ['class', 'כיתה'], ['club', 'מועדון']]

  async function refresh() {
    state.me = await api('/me')
    render()
  }

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
    body.append(create, find)
    body.append(myScopesStrip())
    body.append(el('div', 'scope-note', `אתם כבר חלק מהעיר, בית הספר והכיתה שלכם — אלה נקבעים לפי הפרטים
      באפליקציה ואי אפשר לצאת מהם. מועדון הוא הדבר היחיד שאתם בוחרים.`))
  }

  function renderMyClub(body) {
    const c = state.me.club
    body.append(el('div', 'club-card', `<span class="em">${c.emblem}</span>
      <div class="nm"><b>${esc(c.name)}</b><small>${c.isPresident ? '👑 אתם הנשיא' : 'חבר מועדון'}</small></div>
      <div class="club-count">${c.count}/${state.me.maxMembers}<small>חברים</small></div>`))

    const list = el('div', 'member-list')
    c.members.forEach((m, i) => list.append(el('div', 'member',
      `<span class="pos">${i + 1}</span><b>${esc(m.nickName)}</b>
       ${m.role === 'president' ? '<span class="crown">👑</span>' : ''}
       <span class="xp">${m.xp.toLocaleString('he-IL')} XP</span>`)))
    body.append(list)

    const invite = el('button', 'club-cta', '<span class="club-cta-ic">➕</span><b>הזמינו שחקנים</b>')
    invite.onclick = () => { state.view = 'find'; render() }
    body.append(invite)

    const leave = el('button', 'club-ghost', 'עזבו את המועדון')
    leave.onclick = async () => { await api('/leave', { method: 'POST' }); state.view = 'home'; refresh() }
    body.append(leave)
    body.append(myScopesStrip())
  }

  function renderCreate(body) {
    body.append(el('div', 'club-hero', `<span class="club-hero-ic">➕</span><b>צור מועדון</b>
      <small>עד ${state.me.maxMembers} חברים</small>`))
    const form = el('div', 'club-form')
    const input = el('input', 'club-input')
    input.placeholder = 'שם המועדון'
    input.maxLength = 20
    const emblems = ['🏰', '🦁', '⚡', '🦈', '🐪', '🔥', '⭐', '🐉', '👑', '⚽']
    let emblem = '🏰'
    const row = el('div', 'emblem-row')
    emblems.forEach((e) => {
      const b = el('button', 'emblem-pick' + (e === emblem ? ' on' : ''), e)
      b.onclick = () => { emblem = e; [...row.children].forEach((x) => x.classList.remove('on')); b.classList.add('on') }
      row.append(b)
    })
    const err = el('div', 'club-err')
    const go = el('button', 'club-go', 'צור מועדון')
    go.onclick = async () => {
      const name = input.value.trim()
      if (name.length < 2) { err.textContent = 'שם קצר מדי'; return }
      const r = await api('/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, emblem }) })
      if (r.error) { err.textContent = r.error === 'already_in_club' ? 'אתם כבר במועדון' : 'שם לא תקין'; return }
      state.view = 'home'; refresh()
    }
    const back = el('button', 'club-ghost', 'חזרה')
    back.onclick = () => { state.view = 'home'; render() }
    form.append(input, row, err, go)
    body.append(form, back)
    input.focus()
  }

  async function renderFind(body) {
    body.append(el('div', 'club-hero', `<span class="club-hero-ic">🔎</span><b>מועדונים קרובים אליכם</b>
      <small>לפי הכיתה, בית הספר והעיר שלכם</small>`))
    const list = el('div', 'scope-list')
    body.append(list)
    const back = el('button', 'club-ghost', 'חזרה')
    back.onclick = () => { state.view = 'home'; render() }
    body.append(back)

    const { rows } = await api('/find')
    rows.forEach((c) => {
      const row = el('div', 'club-find-row', `<span class="em">${c.emblem}</span>
        <div class="nm"><b>${esc(c.name)}</b><small>${c.count}/${state.me.maxMembers} חברים</small></div>`)
      const join = el('button', 'club-join', c.full ? 'מלא' : 'הצטרף')
      join.disabled = !!c.full
      join.onclick = async () => {
        const r = await api('/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clubId: c.id }) })
        if (!r.error) { state.view = 'home'; refresh() }
      }
      row.append(join)
      list.append(row)
    })
  }

  // The four scopes a player belongs to. City/school/class carry a lock — they are not leaveable.
  function myScopesStrip() {
    const s = state.me.scopes
    const strip = el('div', 'myscopes')
    const cell = (key, em, label, locked) => el('div', 'myscope' + (locked ? ' locked' : ''),
      `<span class="em">${em}</span><b>${label ? esc(label) : '—'}</b><small>${locked ? '🔒 מהאפליקציה' : 'נבחר'}</small>`)
    strip.append(
      cell('city', '🏙️', s.city?.label, true),
      cell('school', '🏫', s.school?.label, true),
      cell('class', '🎒', s.class?.label, true),
      cell('club', s.club ? state.me.club?.emblem || '🏰' : '🏰', s.club?.label, false),
    )
    return strip
  }

  // ── the RANK screen: my city / school / club measured against their own kind ────────────────────
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
      const row = el('div', `scope-row${mine ? ' mine' : ''}${r.rank === 1 ? ' top1' : ''}`,
        `<span class="pos">${r.rank}</span><span class="em">${r.emblem}</span>
         <div class="nm"><b>${esc(r.label)}</b><small>${r.members} שחקנים${r.padded ? ` · חסרים ${r.padded}` : ''}</small></div>
         <div class="sc">${r.score}<small>ניקוד</small></div>`)
      list.append(row)
    })

    list.append(el('div', 'scope-note',
      `הניקוד = סכום המקומות הארציים של ${data.k} השחקנים הטובים ביותר ב${scopeWord(state.scope)} — הנמוך ביותר מנצח.
       ככה יישוב קטן עם ${data.k} שחקנים חזקים מנצח עיר גדולה, ומספר השחקנים לבדו לא קובע.
       (${METRIC_UNIT[state.metric]} · ${data.totalRanked} שחקנים מדורגים)`))
  }

  const scopeWord = (s) => ({ city: 'עיר', school: 'בית ספר', class: 'כיתה', club: 'מועדון' }[s] || s)
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  // Render lazily: the hub opens these screens by toggling .hidden, so hook the same observer the
  // other sub-pages use rather than fetching on load.
  function watch(id, fn) {
    const node = document.getElementById(id)
    if (!node) return
    new MutationObserver(() => { if (!node.classList.contains('hidden')) fn() })
      .observe(node, { attributes: true, attributeFilter: ['class'] })
  }

  window.addEventListener('DOMContentLoaded', async () => {
    await refresh()
    watch('clubs', () => { state.view = 'home'; refresh() })
    watch('rank', renderBoard)
    renderBoard()
  })
})()
