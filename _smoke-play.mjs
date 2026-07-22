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
// Drive input ~30Hz: move, charge→fire, and exercise the NEW build/bomb paths.
// Wall build is now a HOLD-TO-CONFIRM windup: hold buildHold ~0.6s (18 ticks) then
// release the build edge — a bare build edge no longer places anything. Bomb is now
// aimable: send a sax/say offset with the special edge to lob it.
const iv = setInterval(() => {
  if (!started) return;
  seq++;
  const hold = seq % 20 < 8;             // charge windows
  const fire = seq % 20 === 8;           // release
  const phase = seq % 60;                // 60-tick cycle for the build windup
  const buildHold = phase >= 20 && phase < 38;  // hold the build control for 18 ticks (~0.6s > BUILD_WINDUP)
  const build = phase === 38;                    // release/commit at the end of the windup
  const special = seq % 90 === 0;                // occasional bomb
  const sax = special ? 0.8 : 0, say = special ? 0 : 0; // lob it forward (0.8 of range)
  ws.send(JSON.stringify({ type: 'input', seq, moveX: Math.sin(seq/10), moveY: Math.cos(seq/13), aimX: 1, aimY: 0, hold, fire, special, build, buildHold, sax, say }));
}, 33);
setTimeout(() => { clearInterval(iv); console.log('started:', started, '| snapshot frames:', frames); ws.close(); process.exit(0); }, 6000);
