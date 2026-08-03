/* LOCAL DEMO for the connected-players page (#online).
 *
 * The roster only lists AUTHENTICATED members (onlineByUser), so two guest browser tabs show each
 * other as nobody — opening the page on a plain dev server looks broken when it is working. This
 * parks a few signed-in players on a local server and prints the URL to join them as yourself.
 *
 *   PORT=3016 FOOTBALL_TOKEN_SECRET=demo-local-secret node server.js &
 *   node _online-demo.mjs 3016 demo-local-secret
 *
 * The players idle on the hub forever (they answer pings, accept nothing) until this is killed.
 * ⚠️ The ➕ friend button will FAIL here: it proxies to the real pikme API, which rejects a token
 * signed with a demo secret. The roster, the row states and 👥 (a pure socket message) are real.
 */
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';

const PORT = process.argv[2] || '3016';
const SECRET = process.argv[3] || process.env.FOOTBALL_TOKEN_SECRET || 'demo-local-secret';
const LAN = process.env.LAN_IP || '10.100.102.36';

const PLAYERS = [
  { id: 'demo-dana',   name: 'דנה',   hero: 'ninja',  level: 7, trophies: 2100 },
  { id: 'demo-yonatan', name: 'יונתן', hero: 'wizard', level: 4, trophies: 700 },
  { id: 'demo-shira',  name: 'שירה',  hero: 'robot',  level: 9, trophies: 3900 },
];

const tok = (id, nick) => jwt.sign({ id, nickName: nick, image: null }, SECRET, { expiresIn: '12h' });

for (const p of PLAYERS) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'join', authToken: tok(p.id, p.name), cards: [],
      cosmetic: `${p.hero}:base`, trophies: p.trophies, level: p.level }));
    console.log(`  · ${p.name} is online (רמה ${p.level})`);
  });
  ws.on('error', (e) => console.error(`  ! ${p.name}: ${e.message}`));
  ws.on('close', () => console.log(`  · ${p.name} disconnected`));
}

const me = tok('demo-adam', 'אדם');
console.log(`\nOpen this — you are אדם, and the three above are on the roster:\n`);
console.log(`  http://${LAN}:${PORT}/?ftoken=${me}\n`);
console.log(`Tap the «מחוברים» chip at the top of the hub. Ctrl-C here to take them offline.`);
