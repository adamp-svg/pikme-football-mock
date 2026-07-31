/* Does the MAIN LOBBY show the BEST cards in the power slots ON LOAD?
 *
 * Adam, 2026-08-01: "the main lobby of the football, should have best cards on poer slots when loaded".
 * The 2026-07-31 fix only fills EMPTY slots — a saved loadout holding weaker cards survives untouched.
 * This reproduces that, and is the regression test for whatever replaces it.
 *
 * Seeds a REAL saved loadout of three commons into localStorage, injects an album that also contains
 * legendaries, loads the game, and reads what the lobby actually paints plus what went on the wire.
 *
 *   node _slots-onload.mjs [port]        # default 3016
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/00ddc158-6376-4024-ba10-455d2c7bceff/scratchpad/slotshot'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/profile', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 200000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9433

// An album where "best" is unambiguous: 3 legendaries beat everything else.
const ALBUM = [
  { r: 'legendary', n: 5, c: 3, w: 900 },
  { r: 'legendary', n: 20, c: 2, w: 800 },
  { r: 'legendary', n: 12, c: 1, w: 700 },
  { r: 'epic', n: 7, c: 5, w: 600 },
  { r: 'rare', n: 3, c: 9, w: 400 },
  { r: 'common', n: 1, c: 9, w: 100 },
  { r: 'common', n: 2, c: 8, w: 90 },
  { r: 'common', n: 4, c: 7, w: 80 },
]
const BEST = ['legendary_5', 'legendary_20', 'legendary_12']
// What a player who once picked by hand has sitting in localStorage.
const WEAK_SAVED = [{ r: 'common', n: 1 }, { r: 'common', n: 2 }, { r: 'common', n: 4 }]

async function main() {
  const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run',
    `--user-data-dir=${OUT}/profile`, '--window-size=844,390', 'about:blank'], { stdio: 'ignore' })
  let target
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(t => t.type === 'page') } catch {}
  }
  if (!target) { chrome.kill(); throw new Error('chrome never came up') }
  const { WebSocket } = await import('ws')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(r => ws.on('open', r))
  let id = 0; const pending = new Map()
  const send = (m, p = {}) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method: m, params: p })) })
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } })
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: true })

  // Everything must be in place BEFORE any page script runs: the album is injected pre-load by the
  // app, the saved loadout is already in localStorage, and the tutorial/tour flags are set so a fresh
  // profile does not run the level-0 tutorial and the hub tour — both legitimately show empty slots
  // and would read as the bug.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.SALTIZ_CARDS = ${JSON.stringify(ALBUM)};
      window.SALTIZ_XP = { xp: 4200, level: 9 };
      try {
        localStorage.setItem('fbTutorialSkipped','1');
        localStorage.setItem('fbHubTourDone','1');
        localStorage.setItem('fbTuHubSkipped','1');
        localStorage.setItem('pikme-loadout', JSON.stringify(${JSON.stringify(WEAK_SAVED)}));
      } catch (e) {}
      // Record every setLoadout frame the client actually sends — the screen and the wire are two
      // different claims and the whole bug class here is them disagreeing.
      window.__sent = [];
      const RealWS = window.WebSocket;
      window.WebSocket = function (...a) {
        const s = new RealWS(...a);
        const send = s.send.bind(s);
        s.send = (d) => { try { const m = JSON.parse(d); if (m && m.type === 'setLoadout') window.__sent.push(m.loadout); } catch (e) {} return send(d); };
        return s;
      };
      window.WebSocket.prototype = RealWS.prototype;
    })()`,
  })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await sleep(7000)

  const read = async (label) => {
    const r = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const key = (s) => s && s.r ? s.r + '_' + s.n : null;
        // Read the CLIENT'S OWN answer, not a guess from the DOM: effectiveLoadout() is exactly what
        // renderPowerSlots() paints and what syncLoadout() sends, so it is the single honest source.
        // client.js is a <script type="module">, so nothing is on window — read the PAINTED DOM,
        // which is the only thing the player can actually see anyway. renderPowerSlots() writes the
        // rarity onto the .pslot class and the card art inside it.
        // renderPowerSlots() writes 'pslot rarity-<r>' on the slot and puts the card art inside it.
        // The rarity class is the reliable signal; the card NUMBER is only in the art's url, which
        // differs per rarity, so match any digit run in the whole subtree's markup.
        const slots = [...document.querySelectorAll('.pslot')].map(el => {
          if (el.classList.contains('pslot-empty')) return '(empty)';
          const rar = (el.className.match(/rarity-([a-z]+)/) || [])[1] || '?';
          const html = el.innerHTML;
          const m = html.match(/(?:^|[^0-9])(\d{1,3})(?:\.(?:png|webp|jpg))/i) || html.match(/(\d{1,3})/);
          return rar + '_' + (m ? Number(m[1]) : '?');
        });
        const best = null;
        return {
          painted: slots, best,
          myLoadout: (typeof myLoadout !== 'undefined' && myLoadout) ? myLoadout.map(key) : null,
          saved: (() => { try { return JSON.parse(localStorage.getItem('pikme-loadout') || 'null') } catch(e){ return 'unparsable' } })(),
          sentFrames: (window.__sent || []).map(l => (l||[]).map(key)),
          rawSlotHTML: [...document.querySelectorAll('.pslot')].map(e => e.outerHTML.slice(0,220)),
          lobbyVisible: !document.getElementById('home')?.classList.contains('hidden'),
        };
      })()`,
    })
    return [label, r?.result?.value]
  }

  const [, onLoad] = await read('on load')

  // PHASE 2 — the seed must latch ONCE PER LOAD, or an in-session pick reverts under the player's
  // finger on the next hub arrival and the card picker is a dead control. Overwrite the persisted
  // loadout with commons, bounce away from the hub and back, and assert nothing re-seeded it.
  await send('Runtime.evaluate', {
    expression: `(() => {
      localStorage.setItem('pikme-loadout', JSON.stringify(${JSON.stringify(WEAK_SAVED)}));
      // leave the hub and come back — the trigger that would re-fire a non-latching seed
      document.querySelector('[data-screen="friends"], #friends-btn, .hub-btn')?.click();
    })()`,
  })
  await sleep(900)
  await send('Runtime.evaluate', {
    expression: `document.querySelector('#back-btn, .subpage-back')?.click()`,
  })
  await sleep(1500)
  const [, afterBounce] = await read('after leaving the hub and returning')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.data) writeFileSync(`${OUT}/slots-onload.png`, Buffer.from(shot.data, 'base64'))
  ws.close(); chrome.kill()

  console.log('\nalbum best 3 :', BEST.join(', '))
  console.log('saved loadout:', WEAK_SAVED.map(s => s.r + '_' + s.n).join(', '), '  (three commons)')
  console.log('\nLOBBY ON LOAD')
  console.log('  visible      :', onLoad?.lobbyVisible)
  console.log('  slots painted:', JSON.stringify(onLoad?.painted))
  console.log('  localStorage :', JSON.stringify(onLoad?.saved))
  console.log('  setLoadout   :', JSON.stringify(onLoad?.sentFrames))
  console.log('\nAFTER LEAVING THE HUB AND RETURNING (the seed must NOT re-fire)')
  console.log('  localStorage :', JSON.stringify(afterBounce?.saved))
  console.log('\nshot ->', `${OUT}/slots-onload.png`)

  const painted = onLoad?.painted || []
  const savedNow = (onLoad?.saved || []).map(s => s && s.r ? s.r + '_' + s.n : null)
  const rarities = painted.map(p => String(p).split('_')[0])
  // Two independent witnesses: what the slots PAINT (rarity is enough — commons vs legendaries) and
  // what was PERSISTED. Both must say best, so a green run cannot come from one of them alone.
  const paintedBest = rarities.length === 3 && rarities.every(r => r === 'legendary')
  const savedBest = BEST.every(b => savedNow.includes(b))
  console.log('  painted rarities:', JSON.stringify(rarities), paintedBest ? 'OK' : 'NOT BEST')
  console.log('  persisted       :', JSON.stringify(savedNow), savedBest ? 'OK' : 'NOT BEST')
  const stillWeak = JSON.stringify(afterBounce?.saved) === JSON.stringify(WEAK_SAVED)
  console.log('  seed latched once:', stillWeak ? 'OK — an in-session pick survives' : 'BROKEN — the seed re-fired and would stomp the picker')
  const isBest = paintedBest && savedBest && stillWeak
  console.log(isBest
    ? '\n✅ the lobby loaded with the BEST cards'
    : '\n❌ the lobby did NOT load with the best cards — a saved weaker loadout survived')
  process.exit(isBest ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
