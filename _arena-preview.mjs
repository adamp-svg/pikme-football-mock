/* Draw every built-in arena to a PNG so a human can see the layout before it ships.
 * The fairness test proves the numbers are legal; only eyes can tell whether a field is fun.
 *
 *   node _arena-preview.mjs        -> one PNG per preset + a contact sheet
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { FIELD_PRESETS } from './shared/field-presets.js'
import { FIELD, GOAL } from './shared/constants.js'
import { formationSlot } from './shared/field-spawns.js'

const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/24a0f464-af08-4018-9ddf-e3fad2a0324f/scratchpad/arenas'
mkdirSync(OUT, { recursive: true })

const wallBox = (w) => {
  const horizontal = Math.abs(Math.sin(w.angle)) < 0.5
  const halfW = horizontal ? w.hl : w.ht
  const halfH = horizontal ? w.ht : w.hl
  return { x: w.cx - halfW, y: w.cy - halfH, w: halfW * 2, h: halfH * 2 }
}

function svg(preset) {
  const f = preset.field
  const parts = []
  parts.push(`<rect width="${FIELD.W}" height="${FIELD.H}" fill="#2f7a34"/>`)
  // pitch furniture
  parts.push(`<line x1="${FIELD.W / 2}" y1="0" x2="${FIELD.W / 2}" y2="${FIELD.H}" stroke="#ffffff" stroke-opacity=".45" stroke-width="6"/>`)
  parts.push(`<circle cx="${FIELD.W / 2}" cy="${FIELD.H / 2}" r="150" fill="none" stroke="#ffffff" stroke-opacity=".45" stroke-width="6"/>`)
  for (const gx of [0, FIELD.W - GOAL.depth]) {
    parts.push(`<rect x="${gx}" y="${FIELD.H / 2 - GOAL.width / 2}" width="${GOAL.depth}" height="${GOAL.width}" fill="#ffffff" fill-opacity=".22" stroke="#fff" stroke-width="4"/>`)
  }
  for (const b of f.bushes || []) parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="14" fill="#1f5f2a" fill-opacity=".92"/>`)
  for (const c of f.crates || []) parts.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="#8a6234" stroke="#5c3f20" stroke-width="6"/>`)
  for (const w of f.hardWalls || []) { const b = wallBox(w); parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#8d949a" stroke="#5a6166" stroke-width="4"/>`) }
  for (const w of f.dryWalls || []) { const b = wallBox(w); parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#c9a06a" stroke="#6f4f28" stroke-width="4" stroke-dasharray="18 10"/>`) }
  for (const team of ['A', 'B']) for (let s = 0; s < 2; s++) {
    const p = formationSlot(team, s, 2, FIELD)
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="34" fill="${team === 'A' ? '#e04b4b' : '#4b7fe0'}" stroke="#fff" stroke-width="5"/>`)
  }
  parts.push(`<text x="24" y="60" font-family="Arial Black" font-size="46" fill="#fff">${preset.name}  ·  ${preset.id}</text>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FIELD.W}" height="${FIELD.H}" viewBox="0 0 ${FIELD.W} ${FIELD.H}">${parts.join('')}</svg>`
}

const cards = FIELD_PRESETS.map((p) => `<figure><img src="${p.id}.svg"><figcaption>${p.name} · ${p.id}</figcaption></figure>`).join('')
for (const p of FIELD_PRESETS) writeFileSync(`${OUT}/${p.id}.svg`, svg(p))
writeFileSync(`${OUT}/index.html`, `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#111;color:#eee;font:14px system-ui">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:14px">${cards}</div>
<style>figure{margin:0}img{width:100%;display:block;border:2px solid #444}figcaption{padding:6px 2px}</style></body>`)

// Render the contact sheet to PNG so it can be looked at directly.
const CDP = 9441
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [`--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run', `--user-data-dir=${OUT}/prof`, 'about:blank'], { stdio: 'ignore' })
let t
for (let i = 0; i < 40 && !t; i++) { await sleep(250); try { t = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(x => x.type === 'page') } catch {} }
const { WebSocket } = await import('ws')
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.on('open', r))
let id = 0; const pend = new Map()
const send = (m, q = {}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method: m, params: q })) })
ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) } })
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1700, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `file://${OUT}/index.html` })
await sleep(2500)
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
if (shot?.data) writeFileSync(`${OUT}/all-arenas.png`, Buffer.from(shot.data, 'base64'))
ws.close(); chrome.kill()
console.log('arena previews ->', `${OUT}/all-arenas.png`)
