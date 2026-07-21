import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:3010');
let pid = null, seq = 0, frames = 0, started = false;
ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name: 'PlaySmoke', cards: [] })));
ws.on('message', (data, isBinary) => {
  if (isBinary) { frames++; return; }
  const m = JSON.parse(data.toString());
  if (m.type === 'home') ws.send(JSON.stringify({ type: 'training' }));
  if (m.type === 'matchStart') { pid = m.playerId; started = true; }
});
// Drive input ~30Hz: move around, charge (hold) then fire, plus build/special.
const iv = setInterval(() => {
  if (!started) return;
  seq++;
  const hold = seq % 20 < 8;         // charge windows
  const fire = seq % 20 === 8;       // release
  ws.send(JSON.stringify({ type: 'input', seq, moveX: Math.sin(seq/10), moveY: Math.cos(seq/13), aimX: 1, aimY: 0, hold, fire, special: seq % 60 === 0, build: seq % 45 === 0 }));
}, 33);
setTimeout(() => { clearInterval(iv); console.log('started:', started, '| snapshot frames:', frames); ws.close(); process.exit(0); }, 6000);
