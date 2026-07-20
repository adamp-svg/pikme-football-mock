// End-to-end smoke: connect, enter training, verify the server wiring.
import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:3010');
const got = { control: [], binary: 0 };
let matchStart = null;

ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name: 'Smoke', cards: [] })));
ws.on('message', (data, isBinary) => {
  if (isBinary) { got.binary++; return; }
  const msg = JSON.parse(data.toString());
  got.control.push(msg.type);
  if (msg.type === 'home') ws.send(JSON.stringify({ type: 'training' }));
  if (msg.type === 'matchStart') matchStart = msg;
});

setTimeout(() => {
  console.log('control msgs:', got.control.join(', '));
  console.log('binary snapshot frames:', got.binary);
  const ok = matchStart
    && matchStart.mode === 'training'
    && matchStart.team === 'A'
    && got.binary > 30            // snapshots are flowing (~60Hz for a few s)
    && got.control.includes('roomJoined');
  console.log('matchStart.mode:', matchStart && matchStart.mode, '| team:', matchStart && matchStart.team);
  console.log(ok ? '✅ SMOKE PASS (training match started, snapshots streaming)' : '❌ SMOKE FAIL');
  ws.close();
  process.exit(ok ? 0 : 1);
}, 3000);
