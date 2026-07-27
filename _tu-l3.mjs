// Quick smoke of level 3 only. Full coverage lives in _tu-verify.mjs.
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
const CDP=9416, PROF='/tmp/tu-l3-'+process.pid;
mkdirSync('_tu-shots',{recursive:true});
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new',`--remote-debugging-port=${CDP}`,`--user-data-dir=${PROF}`,'--no-first-run','--disable-gpu','--hide-scrollbars','about:blank'],{stdio:'ignore'});
const sleep=(m)=>new Promise(r=>setTimeout(r,m));
let url=null; for(let i=0;i<60&&!url;i++){try{const r=await fetch(`http://127.0.0.1:${CDP}/json/list`);const p=(await r.json()).filter(t=>t.type==='page');if(p.length)url=p[0].webSocketDebuggerUrl;}catch{} if(!url)await sleep(250);}
const ws=new WebSocket(url); await new Promise(r=>ws.once('open',r));
let id=0; const pend=new Map();
ws.on('message',(raw)=>{const m=JSON.parse(raw.toString()); if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}});
const cdp=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));setTimeout(()=>{if(pend.has(i)){pend.delete(i);rej(new Error('to '+m));}},20000);});
const ev=async(e)=>(await cdp('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result.value;
const shot=async(n)=>{const{data}=await cdp('Page.captureScreenshot',{format:'png'});writeFileSync(`_tu-shots/${n}.png`,Buffer.from(data,'base64'));console.log('  📸 '+n);};
const touch=(t,x,y)=>cdp('Input.dispatchTouchEvent',{type:t,touchPoints:t==='touchEnd'?[]:[{x,y,id:1}]});
async function drag(sel,dx,dy,ms){const r=await ev(`(()=>{const e=document.querySelector('${sel}');const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};})()`);await touch('touchStart',r.x,r.y);const t0=Date.now();while(Date.now()-t0<ms){await touch('touchMove',r.x+dx,r.y+dy);await sleep(50);}await touch('touchEnd',r.x+dx,r.y+dy);}
let fails=0; const ok=(c,m)=>{console.log((c?'  ✅ ':'  ❌ ')+m); if(!c)fails++;};
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:2,mobile:true});
await cdp('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
await cdp('Page.navigate',{url:'http://localhost:3012/'});
await sleep(3000);
await ev(`localStorage.setItem("fbTuDone","basics,combat")`);
await cdp('Page.navigate',{url:'http://localhost:3012/'});
await sleep(3000);
await ev(`document.getElementById("training-btn").click()`); await sleep(300);
await ev(`document.getElementById("tc-howto").click()`); await sleep(400);
const rows=await ev(`[...document.querySelectorAll("#tu-levels .tu-lv")].map(e=>e.querySelector("b").textContent.trim())`);
ok(rows.length===3, `picker lists three levels (${rows.join(' | ')})`);
await ev(`document.querySelector('#tu-levels .tu-lv[data-level="2"]').click()`); await sleep(3500);
ok((await ev(`document.getElementById("tu-cap").textContent`)).trim()==='תתחבא!', 'level 3 opens on the HIDE step');
ok((await ev(`document.getElementById("tu-nudge").textContent`)).includes('שיח'), 'and shows the standing sub-line about the bush');
ok((await ev(`document.querySelectorAll("#tu-pips i").length`))===2, 'two pips for the tricks level');
await shot('l3-01-hide');
// walk right into the bush
await drag('#stickL',60,0,4000); await sleep(1200);
const cap=(await ev(`document.getElementById("tu-cap").textContent`)).trim();
ok(cap==='הוא לא רואה אותך!'||cap==='תעוף!', `hiding registered (caption now «${cap}»)`);
await shot('l3-02-hidden');
await sleep(2500);
ok((await ev(`document.getElementById("tu-cap").textContent`)).trim()==='תעוף!', 'after the dwell it moves on to the FLY step');
ok(await ev(`getComputedStyle(document.getElementById('special')).display`)!=='none', '💣 is available on the fly step');
ok(await ev(`getComputedStyle(document.getElementById('build')).display`)!=='none', '🧱 too');
await shot('l3-03-fly');
chrome.kill();
console.log(fails? `\n❌ ${fails} FAILED` : '\n✅ level 3 smoke OK');
process.exit(fails?1:0);
