import { WebSocket } from 'ws';
const ws = new WebSocket('ws://localhost:3010');
ws.on('open', () => { ws.send(JSON.stringify({type:'join',name:'Repro',avatar:null}));
  setTimeout(()=>ws.send(JSON.stringify({type:'ready'})), 500); });
let snaps=0, lastTick=-1, frozenSince=null, frozenReported=false;
ws.on('message', raw => { const m=JSON.parse(raw);
  if (m.type==='snapshot') { snaps++;
    if (m.tick === lastTick) { if(!frozenSince) frozenSince=Date.now(); }
    else { frozenSince=null; frozenReported=false; }
    lastTick = m.tick;
    if (frozenSince && Date.now()-frozenSince > 3000 && !frozenReported) {
      console.log(`FROZEN: tick stuck at ${m.tick} for >3s (elapsed=${m.elapsed}s, score=${JSON.stringify(m.score)})`);
      frozenReported=true;
    }
  }
});
setInterval(()=>console.log(`t=${process.uptime()|0}s snaps=${snaps} lastTick=${lastTick}`), 20000);
setTimeout(()=>{ console.log('DONE watching'); process.exit(0); }, 200000);
