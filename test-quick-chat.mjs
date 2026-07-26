// IN-MATCH QUICK CHAT — the parts that break silently.
//
// The emote cell mapping is the dangerous one. shared/quick-chat.js hardcodes col/row into the
// COMBINED 160-asset sheet, resolved from "the original 96 first, then the 64 expansion". If that
// sheet is ever re-cut or the manifests reordered, every emote silently points at the WRONG ART — a
// wave becomes a crate and nothing errors. So this recomputes the indices from the real manifest
// files and compares.
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { CHAT_WORDS, CHAT_EMOTES, CHAT_SHEET, chatById, isChatId, CHAT_IDS, CHAT_BUBBLE_MS, CHAT_SEND_GAP_MS, CHAT_BURST_N } from './shared/quick-chat.js';

const here = dirname(fileURLToPath(import.meta.url));
const R = (p) => readFileSync(join(here, p), 'utf8');
let failed = 0;
const ok = (l, c, x = '') => { if (!c) failed++; console.log(`  ${c ? '✅' : '❌'} ${l}${x ? ` — ${x}` : ''}`); };

console.log('catalogue');
ok('8 words', CHAT_WORDS.length === 8, String(CHAT_WORDS.length));
ok('8 emotes', CHAT_EMOTES.length === 8, String(CHAT_EMOTES.length));
ok('every id is unique', new Set(CHAT_IDS).size === CHAT_IDS.length);
ok('every word has non-empty Hebrew text', CHAT_WORDS.every((w) => /[֐-׿]/.test(w.text)));
ok('lookup works and is exhaustive', CHAT_IDS.every((id) => !!chatById(id)));
// The server relays on isChatId alone, so anything outside the catalogue must be rejected.
ok('unknown ids are rejected (not defaulted)', !isChatId('nope') && !isChatId('') && chatById(undefined) === null);
ok('word/emote kinds are tagged', chatById(CHAT_WORDS[0].id).kind === 'word' && chatById(CHAT_EMOTES[0].id).kind === 'emote');

console.log('\nemote art actually points at the right cell');
const baseIds = R('public/assets/pixel-icon-system-01/manifest.csv').trim().split('\n').slice(1).map((l) => l.split(',')[0]);
const expIds = R('public/assets/pixel-icon-system-01/expansion-64/manifest.csv').trim().split('\n').slice(1).map((l) => l.split(',')[0]);
const order = [...baseIds, ...expIds];
ok('the combined pack is 96 + 64 = 160', baseIds.length === 96 && expIds.length === 64, `${baseIds.length}+${expIds.length}`);
for (const e of CHAT_EMOTES) {
  const idx = order.indexOf(e.icon);
  const col = idx % CHAT_SHEET.cols, row = Math.floor(idx / CHAT_SHEET.cols);
  ok(`${e.icon} -> col ${e.col} row ${e.row}`, idx >= 0 && col === e.col && row === e.row,
    idx < 0 ? 'NOT IN MANIFEST' : `manifest says col ${col} row ${row}`);
}
const sheet = statSync(join(here, 'public' + CHAT_SHEET.url.split('?')[0]));
ok('the sheet file exists', sheet.size > 0, `${Math.round(sheet.size / 1024)} KB`);
ok('grid x cell covers the sheet (16*128=2048, 10*128=1280)',
  CHAT_SHEET.cols * CHAT_SHEET.cell === 2048 && CHAT_SHEET.rows * CHAT_SHEET.cell === 1280);

console.log('\nthe wire carries an ID, never text');
const client = R('public/client.js');
const server = R('server.js');
ok('client sends { type:chat, id } only', /sendMsg\(\{ type: 'chat', id \}\)/.test(client));
ok('client never puts word TEXT on the wire', !/type: 'chat'[^}]*text/.test(client));
ok('server validates against the shared catalogue before relaying', /isChatId\(msg\.id\)/.test(server));
ok('server relays only { pid, id }', /type: 'chat', pid: member\.id, id: msg\.id/.test(server));
ok('server refuses outside a live match', /r\.phase !== 'match' \|\| !member\.inMatch/.test(server));

console.log('\nanti-spam is enforced SERVER-side, not just in the UI');
ok('per-send gap', /CHAT_SEND_GAP_MS/.test(server) && CHAT_SEND_GAP_MS >= 1000);
ok('burst cap', /CHAT_BURST_N/.test(server) && CHAT_BURST_N === 3);
ok('cooldown after a burst', /chatMuteUntil/.test(server));
ok('the client also self-limits (courtesy, not the rule)', /_chatCoolUntil/.test(client));

console.log('\nvisible to EVERYONE, drawn over the sender');
ok('server loops the whole room', /for \(const m of r\.members\)/.test(server.slice(server.indexOf("msg.type === 'chat'"))));
ok('client routes the relay to a bubble', /onChatMessage\(msg\.pid, msg\.id\)/.test(client));
ok('a bubble is drawn per player, in the full-res pass', /for \(const p of players\)/.test(client) && /chatBubbles\.get\(p\.id\)/.test(client));
ok('one bubble per player — a new message replaces, never stacks', /chatBubbles\.set\(pid,/.test(client));
ok(`bubble lasts ~2.2s per the asset spec`, CHAT_BUBBLE_MS >= 1800 && CHAT_BUBBLE_MS <= 2600, String(CHAT_BUBBLE_MS));

console.log('\nHUD chrome is not the pitch');
// Tapping the chat button used to ALSO grab a joystick and start aiming, because the exclusion was a
// hand-listed set of five elements that every new control had to remember to join.
const gi = client.indexOf('HUD CHROME IS NOT THE PITCH');
const stickGuard = gi < 0 ? '' : client.slice(gi, gi + 900);
ok('the guard is a RULE (closest over controls), not a hand-listed set', /closest\(/.test(stickGuard) && /'button, a, input/.test(stickGuard));
ok('it covers the chat sheet', /chat-sheet/.test(stickGuard));
ok('it covers the HUD by ID (#hud) — `.hud` matched nothing and the score kept claiming sticks',
  /#hud/.test(stickGuard));
ok('a plain <button> is covered, so any FUTURE HUD button is too', /button/.test(stickGuard));
ok('it still requires an Element (a touch with no target must not throw)', /instanceof Element/.test(stickGuard));

console.log('\nwords are normal text, not pixel-buffer text');
// The world is rendered into a low-res buffer and blown up x ART_PX with nearest-neighbour, so ANY
// text drawn in that pass comes out chunky. Bubbles must draw in the full-res pass after the blit.
const iBlit = client.indexOf('mainCtx.drawImage(worldBuf');
const iBubbles = client.indexOf('drawChatBubbles(view);');
ok('bubbles draw AFTER the world buffer is blitted (full-res space)', iBlit > 0 && iBubbles > iBlit, `blit@${iBlit} bubbles@${iBubbles}`);
ok('bubbles are NOT drawn inside the world player loop', !/drawChatBubble\(dp\)/.test(client));
const fn = client.slice(client.indexOf('function drawChatBubbles(view)'), client.indexOf('function drawChatBubbles(view)') + 2200);
ok('words use a normal UI sans, not the chunky CELEB_FONT', /system-ui/.test(fn) && !/CELEB_FONT/.test(fn));
ok('word text is smoothed', /imageSmoothingEnabled = true/.test(fn));
ok('emotes keep nearest-neighbour (they ARE pixel art)', /imageSmoothingEnabled = false/.test(fn));
ok('sizes scale with dpr so it is not tiny on a retina phone', /\* dpr/.test(fn));
// `view` is a LOCAL of the frame function; reading it as a free variable threw
// "view is not defined" on the first bubble and the game showed an error banner.
ok('view is passed in, not read as a free variable', /function drawChatBubbles\(view\)/.test(client));

console.log('\nthe button sits with its cluster siblings');
const html = R('public/index.html');
const dom = new JSDOM(html);
const doc = dom.window.document;
const btn = doc.getElementById('chat-btn');
ok('#chat-btn exists', !!btn);
ok('it reuses .edit-controls-btn so the cluster stays visually uniform', btn?.classList.contains('edit-controls-btn'));
ok('it starts hidden (revealed on entering a match)', btn?.classList.contains('hidden'));
ok('it is immediately after the edit-controls button in the DOM',
  doc.getElementById('edit-controls-btn')?.nextElementSibling?.id === 'chat-btn');
ok('the sheet shell exists and is EMPTY (rendered from the catalogue)',
  !!doc.getElementById('chat-words') && doc.getElementById('chat-words').children.length === 0
  && !!doc.getElementById('chat-emotes') && doc.getElementById('chat-emotes').children.length === 0);
const css = R('public/style.css');
ok('.chat-btn only moves it along the row (offset past 🎛️ at 133)', /\.chat-btn \{ right: max\(181px/.test(css));
ok('the emote sprite rule lives in style.css, not icon-system.css (which gets regenerated)',
  /\.qc-emote \{/.test(css) && !/qc-emote/.test(R('public/icon-system.css')));

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
