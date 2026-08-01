/* RULING 2026-08-01: "make sure the player can remove cards and leave empty slots as well."
 * Loads the hub with an album (seed equips best 3), then removes slot 1 via __loadoutProbe and
 * asserts: the slot goes EMPTY and STAYS empty (no backfill on the next paints), the hole is
 * persisted, and equipping into the hole still works.
 *   node _remove-empty.mjs [port]     # default 3016
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/24a0f464-af08-4018-9ddf-e3fad2a0324f/scratchpad/removeempty'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/profile', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 120000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9435
const ALBUM = [
  { r: 'legendary', n: 5, c: 3, w: 900 }, { r: 'legendary', n: 20, c: 2, w: 800 },
  { r: 'legendary', n: 12, c: 1, w: 700 }, { r: 'epic', n: 7, c: 5, w: 600 },
  { r: 'rare', n: 3, c: 9, w: 400 },
]

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
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.SALTIZ_CARDS = ${JSON.stringify(ALBUM)};
      window.SALTIZ_XP = { xp: 4200, level: 9 };
      try {
        localStorage.setItem('fbTutorialSkipped','1'); localStorage.setItem('fbHubTourDone','1');
        localStorage.setItem('fbHubTourSkipped','1'); localStorage.setItem('fbTuHubSkipped','1');
      } catch (e) {}
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
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness` })
  await sleep(6000)

  const evl = async (expr) => (await send('Runtime.evaluate', { returnByValue: true, expression: expr }))?.result?.value
  const state = async () => evl(`(() => {
    const key = (s) => s && s.r ? s.r + '_' + s.n : null;
    return {
      eff: window.__loadoutProbe.effective().map(key),
      raw: (window.__loadoutProbe.raw() || []).map(key),
      dom: [...document.querySelectorAll('#power-slots .pslot')].map(p => p.classList.contains('pslot-empty') ? 'EMPTY' : ((p.className.match(/rarity-([a-z]+)/)||[])[1]||'?')),
      saved: JSON.parse(localStorage.getItem('pikme-loadout') || 'null'),
      frames: (window.__sent||[]).length,
    };
  })()`)

  const s0 = await state()
  console.log('after load  :', JSON.stringify(s0))
  const seeded = s0.eff.join() === 'legendary_5,legendary_20,legendary_12' && !s0.dom.includes('EMPTY')
  console.log(seeded ? '  ✓ seeded best 3' : '  ✗ SEED BROKEN')

  await evl(`window.__loadoutProbe.remove(1)`)
  await sleep(400)
  const s1 = await state()
  console.log('after remove:', JSON.stringify(s1))
  const removed = s1.eff[1] === null && s1.dom[1] === 'EMPTY' && s1.saved && s1.saved[1] === null
  console.log(removed ? '  ✓ slot 1 emptied + persisted' : '  ✗ REMOVE DID NOT EMPTY')

  await sleep(2500) // let the 700ms poll + any repaint try to backfill it
  const s2 = await state()
  const stays = s2.eff[1] === null && s2.dom[1] === 'EMPTY'
  console.log('2.5s later  :', JSON.stringify({ eff: s2.eff, dom: s2.dom }))
  console.log(stays ? '  ✓ hole survives repaints (no backfill)' : '  ✗ HOLE WAS BACKFILLED')

  await evl(`window.__loadoutProbe.equip(1, { r: 'epic', n: 7 })`)
  await sleep(400)
  const s3 = await state()
  const reequip = s3.eff[1] === 'epic_7' && s3.dom[1] === 'epic'
  console.log('after equip :', JSON.stringify({ eff: s3.eff, dom: s3.dom }))
  console.log(reequip ? '  ✓ equip into the hole works' : '  ✗ EQUIP BROKEN')

  ws.close(); chrome.kill()
  const pass = seeded && removed && stays && reequip
  console.log(pass ? '\n✅ remove-leaves-empty behaves' : '\n❌ FAILED')
  process.exit(pass ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
