import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:3010');
let started=false, seq=0, frames=0;
ws.on('open', () => ws.send(JSON.stringify({ type:'join', name:'HardSmoke', cards:[] })));
ws.on('message', (d, bin) => {
  if (bin) { frames++; return; }
  const m = JSON.parse(d.toString());
  if (m.type === 'home') ws.send(JSON.stringify({ type:'training' }));
  if (m.type === 'matchStart') { started=true; ws.send(JSON.stringify({ type:'settings', botDifficulty:'hard' })); }
});
const iv = setInterval(() => { if(!started) return; seq++; ws.send(JSON.stringify({ type:'input', seq, moveX:Math.sin(seq/9), moveY:Math.cos(seq/11), aimX:1, aimY:0, hold:false, fire:false })); }, 33);
setTimeout(() => { clearInterval(iv); console.log('started:', started, '| frames:', frames); ws.close(); process.exit(0); }, 5000);
