/* RULING 2026-08-01 (evening): "i want the user last chosen her, and suit and power slot cards to be
 * the ones when enetering the football lobby game."
 *
 * Three scenarios, all on the REAL client:
 *   A  REMEMBERED  — a deliberate WEAKER loadout + a non-default hero:skin are in localStorage while
 *                    the album also holds better cards. Both must survive the load untouched (this is
 *                    the exact case the old every-load reseed destroyed).
 *   B  FIRST TIME  — nothing saved at all. The best three must be equipped and persisted, so a new
 *                    player never sees an empty lobby.
 *   C  EMPTY RE-INJECT — the app pushes `window.SALTIZ_CARDS = []` after load (buildCompactCards of an
 *                    unresolved claims query, which it really does on a cold cache). The remembered
 *                    loadout and hero must NOT be wiped or demoted by that.
 *
 *   node _remember-last.mjs [port]        # default 3016
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/24a0f464-af08-4018-9ddf-e3fad2a0324f/scratchpad/rememberlast'
mkdirSync(OUT, { recursive: true })
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 240000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9436

// Album with three legendaries — so "best" is unambiguous and clearly different from the saved pick.
const ALBUM = [
  { r: 'legendary', n: 5, c: 3, w: 900 }, { r: 'legendary', n: 20, c: 2, w: 800 },
  { r: 'legendary', n: 12, c: 1, w: 700 }, { r: 'epic', n: 7, c: 5, w: 600 },
  { r: 'rare', n: 3, c: 9, w: 400 }, { r: 'common', n: 1, c: 9, w: 100 },
  { r: 'common', n: 2, c: 8, w: 90 }, { r: 'common', n: 4, c: 7, w: 80 },
  // 21 distinct cards total keeps several heroes unlocked (7 distinct per hero), so a saved
  // non-striker hero is legitimately unlocked and must not be demoted.
  ...Array.from({ length: 13 }, (_, i) => ({ r: 'rare', n: 40 + i, c: 1, w: 200 })),
]
const BEST3 = 'legendary_5,legendary_20,legendary_12'
// A DELIBERATE, DELIBERATELY WORSE pick: three commons while legendaries sit in the album.
const CHOSEN = [{ r: 'common', n: 1 }, { r: 'common', n: 2 }, { r: 'common', n: 4 }]
const CHOSEN_KEYS = 'common_1,common_2,common_4'
const CHOSEN_HERO = 'robot:sig'      // hero + SUIT (skin tier), both non-default

let chrome, ws, send, id = 0
async function open() {
  chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run',
    `--user-data-dir=${OUT}/profile`, '--window-size=844,390', 'about:blank'], { stdio: 'ignore' })
  let target
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(t => t.type === 'page') } catch {}
  }
  if (!target) { chrome.kill(); throw new Error('chrome never came up') }
  const { WebSocket } = await import('ws')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(r => ws.on('open', r))
  const pending = new Map()
  send = (m, p = {}) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method: m, params: p })) })
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } })
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true })
}

// `saved`/`hero` = what is already in localStorage before the page runs (null = a first-time player).
// `injLoadout`/`injHero` = the SERVER-SAVED values the shipped app injects as window.SALTIZ_LOADOUT /
// SALTIZ_COSMETIC (verified present in release/tf-94 + tf-95 app/pages/football.jsx). Those WIN over
// localStorage by design — that is what makes the choice follow the player to a new phone — so they
// are the values that actually decide what a real player sees.
// ⚠️ Page.addScriptToEvaluateOnNewDocument ACCUMULATES: without removing the previous scenario's
// script every later navigation also replays it, so scenario C's "set the album to []" kept firing
// inside D and read as a D failure. Each load owns exactly one init script.
let _initScript = null
async function load({ saved, hero, lateEmpty, injLoadout, injHero }) {
  if (_initScript) { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: _initScript }); _initScript = null }
  const added = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.SALTIZ_CARDS = ${JSON.stringify(ALBUM)};
      window.SALTIZ_XP = { xp: 4200, level: 9 };
      ${injLoadout ? `window.SALTIZ_LOADOUT = ${JSON.stringify(injLoadout)};` : ''}
      ${injHero ? `window.SALTIZ_COSMETIC = ${JSON.stringify(injHero)};` : ''}
      try {
        localStorage.clear();
        localStorage.setItem('fbTutorialSkipped','1'); localStorage.setItem('fbHubTourDone','1');
        localStorage.setItem('fbHubTourSkipped','1'); localStorage.setItem('fbTuHubSkipped','1');
        ${saved ? `localStorage.setItem('pikme-loadout', ${JSON.stringify(JSON.stringify(saved))});` : ''}
        ${hero ? `localStorage.setItem('pikme_cosmetic', ${JSON.stringify(hero)});` : ''}
      } catch (e) {}
      // THE APP'S REAL RE-INJECT: buildCompactCards(undefined) === [] pushed after load.
      if (${!!lateEmpty}) setTimeout(() => { window.SALTIZ_CARDS = []; }, 2500);
    })()`,
  })
  _initScript = added?.identifier || null
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?cb=${id}` })
  await sleep(lateEmpty ? 7000 : 5000)
}

const read = async () => (await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const key = (s) => s && s.r ? s.r + '_' + s.n : null;
    return {
      eff: window.__loadoutProbe.effective().map(key).join(','),
      savedNow: (JSON.parse(localStorage.getItem('pikme-loadout') || 'null') || []).map(key).join(','),
      // The LIVE hero, not the localStorage copy: window.SALTIZ_COSMETIC (the app's server-saved
      // inject) legitimately wins over localStorage, so reading storage alone reports the wrong
      // value. __hubPrefs.cosmetic() is the module's own seam onto myCosmetic.
      cosmetic: window.__hubPrefs.cosmetic(),
      cosmeticStored: localStorage.getItem('pikme_cosmetic'),
      dom: [...document.querySelectorAll('#power-slots .pslot')].map(p =>
        p.classList.contains('pslot-empty') ? 'EMPTY' : ((p.className.match(/rarity-([a-z]+)/)||[])[1]||'?')).join(','),
      album: (window.SALTIZ_CARDS||[]).length,
    };
  })()`,
}))?.result?.value

const results = []
function check(label, cond, detail) {
  results.push(cond)
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`)
}

async function main() {
  await open()

  console.log('\nA  REMEMBERED — a deliberate weaker pick + non-default hero:suit')
  await load({ saved: CHOSEN, hero: CHOSEN_HERO })
  let s = await read()
  console.log('   ', JSON.stringify(s))
  check('power slots are the LAST CHOSEN cards, not the best three', s.eff === CHOSEN_KEYS, s.eff)
  check('localStorage was not overwritten with the best three', s.savedNow === CHOSEN_KEYS, s.savedNow)
  check('hero + suit restored exactly', s.cosmetic === CHOSEN_HERO, String(s.cosmetic))
  check('the slots actually PAINT the chosen (common) cards', s.dom === 'common,common,common', s.dom)

  console.log('\nB  FIRST TIME — nothing saved: the best three must be equipped + persisted')
  await load({ saved: null, hero: null })
  s = await read()
  console.log('   ', JSON.stringify(s))
  check('best three equipped', s.eff === BEST3, s.eff)
  check('and persisted, so it becomes the remembered choice', s.savedNow === BEST3, s.savedNow)
  check('no empty slot in the lobby', !s.dom.includes('EMPTY'), s.dom)

  console.log('\nC  EMPTY RE-INJECT — the app pushes SALTIZ_CARDS = [] after load')
  await load({ saved: CHOSEN, hero: CHOSEN_HERO, lateEmpty: true })
  s = await read()
  console.log('   ', JSON.stringify(s))
  check('album really did go empty (the hazard was exercised)', s.album === 0, 'album=' + s.album)
  check('remembered loadout NOT wiped by the empty album', s.savedNow === CHOSEN_KEYS, s.savedNow)
  check('remembered hero NOT demoted to striker', s.cosmetic === CHOSEN_HERO, String(s.cosmetic))
  check('slots still PAINT the remembered cards during the empty window', s.dom === 'common,common,common', s.dom)

  console.log('\nD  THE APP\'S REAL PATH — server-saved choice injected as SALTIZ_LOADOUT/SALTIZ_COSMETIC')
  // This is what a real phone does: the app reads footballStats.loadout/.cosmetic (saved under the
  // player\'s phone) and injects them before the game\'s scripts run. They must be restored as-is even
  // though the album holds three legendaries, and even though localStorage says something different —
  // the server copy is the one that follows the player across devices.
  await load({ saved: [{ r: 'rare', n: 3 }, null, null], hero: 'striker:base', injLoadout: CHOSEN, injHero: CHOSEN_HERO })
  s = await read()
  console.log('   ', JSON.stringify(s))
  check('the SERVER-saved pick is what the lobby shows', s.eff === CHOSEN_KEYS, s.eff)
  check('not the best three, and not the local copy', s.eff !== BEST3 && s.eff !== 'rare_3,,', s.eff)
  check('server-saved hero + suit restored', s.cosmetic === CHOSEN_HERO, String(s.cosmetic))
  check('...and mirrored into localStorage, so a load without the inject still remembers it',
    s.cosmeticStored === CHOSEN_HERO, String(s.cosmeticStored))
  check('...same for the loadout', s.savedNow === CHOSEN_KEYS, s.savedNow)
  check('slots paint the server-saved cards', s.dom === 'common,common,common', s.dom)

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.data) writeFileSync(`${OUT}/remember-last.png`, Buffer.from(shot.data, 'base64'))
  ws.close(); chrome.kill()

  const pass = results.every(Boolean)
  console.log(pass
    ? '\n✅ the lobby restores the last chosen hero, suit and power cards'
    : `\n❌ ${results.filter(r => !r).length} of ${results.length} checks failed`)
  process.exit(pass ? 0 : 1)
}
main().catch(e => { console.error(e); try { ws?.close(); chrome?.kill() } catch {} process.exit(1) })
