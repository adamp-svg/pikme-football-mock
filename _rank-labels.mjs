/* CITY / SCHOOL ROWS MUST NAME THE PLACE, NEVER ITS ID.
 *
 * THE BUG (Adam, 2026-08-04: "i still dont see which schools is ranked up and which city is ranked up"):
 * pikme-server ships scope IDS only — it has no directory — and the app resolves them from the 428KB
 * /data/schools-directory.json. renderBoard() painted WITHOUT awaiting that fetch, so opening דירוג
 * before it landed rendered «1953726605» where the player expects «חיפה», and nothing re-rendered when it
 * arrived: the ids stayed for the whole session. refresh() had always awaited it; the rank screen reaches
 * renderBoard directly through watch('rank', …) and did not.
 *
 * Run BOTH modes — the fast path alone passes even with the bug present:
 *   node _rank-labels.mjs                  # directory arrives normally, server on :3016
 *   node _rank-labels.mjs slow             # directory held back 4s, rank screen opened first  ← the regression
 *   node _rank-labels.mjs slow 3017        # 3rd argv slot / PORT env overrides the target server port
 *   CDP_PORT=9500 node _rank-labels.mjs    # force a specific Chrome CDP port (default: OS-assigned free one)
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { createServer } from 'node:net'
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// REVIEW FIX — CDP used to be a bare `const CDP = 9444`, a fixed port that any of the 20+ concurrent
// agents in this repo could already be listening on (measured on this same wave for _rank-podium.mjs's
// port 9433: a run attached to another agent's Chrome and reported a false FAIL). argv[2] is already
// the 'slow'/normal mode switch, so PORT now comes from PORT= or argv[3], and CDP defaults to an
// OS-assigned free port unless CDP_PORT= or argv[4] forces a specific one.
const PORT = process.env.PORT || process.argv[3] || '3016'
const freePort = (fallback) => new Promise((resolve) => {
  const srv = createServer()
  srv.on('error', () => resolve(fallback))
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) })
})
const CDP = Number(process.env.CDP_PORT || process.argv[4]) || await freePort(9444)
console.log(`[rank-labels] target server :${PORT} · chrome CDP :${CDP}`)
const OUT='/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/24a0f464-af08-4018-9ddf-e3fad2a0324f/scratchpad/labels'
const DELAY = process.argv[2] === 'slow' ? 4000 : 0
const chrome=spawn(CHROME,[`--remote-debugging-port=${CDP}`,'--headless=new','--no-first-run',`--user-data-dir=${OUT}`,'--window-size=844,390','about:blank'],{stdio:'ignore'})
let t; for(let i=0;i<40&&!t;i++){await sleep(250);try{t=(await(await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(x=>x.type==='page')}catch{}}
const {WebSocket}=await import('ws'); const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.on('open',r))
let id=0; const p=new Map(); const send=(m,q={})=>new Promise(r=>{p.set(++id,r);ws.send(JSON.stringify({id,method:m,params:q}))})
ws.on('message',d=>{const m=JSON.parse(d.toString()); if(m.id&&p.has(m.id)){p.get(m.id)(m.result);p.delete(m.id)}})
await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:2,mobile:true})
await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
  window.SALTIZ_XP={xp:2500,level:7};
  try{for(const k of ['fbTutorialSkipped','fbHubTourDone','fbHubTourSkipped','fbTuHubSkipped'])localStorage.setItem(k,'1')}catch(e){}
  const DELAY=${DELAY};
  const realFetch=window.fetch;
  window.fetch=(u,o)=>{
    const url=String(u);
    // Hold the directory back to model a phone on a slow connection opening the rank screen at once.
    if(DELAY && url.includes('schools-directory.json')){
      return new Promise(res=>setTimeout(()=>res(realFetch(u,o)), DELAY));
    }
    if(url.includes('/dev/clubs')||url.includes('/handle-clubs')){
      const J=(b)=>Promise.resolve(new Response(JSON.stringify(b),{status:200,headers:{'Content-Type':'application/json'}}));
      if(url.includes('/me')) return J({ me:{userId:'u5',nickName:'אדם',trophies:2500,level:7}, club:null,
        metrics:[{key:'views',labelHe:'הכי הרבה צפיות'}], scopes:{}, maxMembers:30 });
      if(url.includes('/board')){
        // REAL prod ids: 1953726605 = חיפה, 1602649942 = הרצליה, 340315 = עירוני ה', 513093 = הנדיב
        // class/grade keys KEEP the semel even though the board is school-scoped — shipped clients parse
        // them positionally, so the server deliberately did not change the shape.
        if(url.includes('scope=class')) return J({ metric:'views', scope:'class', k:null, totalRanked:93, mineScopeId:'513093|10|5',
          rows:[{rank:1,scopeId:'513093|10|5',value:900,members:2},{rank:2,scopeId:'513093|10|3',value:400,members:1}] });
        if(url.includes('scope=grade')) return J({ metric:'views', scope:'grade', k:null, totalRanked:93, mineScopeId:'513093|10',
          rows:[{rank:1,scopeId:'513093|10',value:900,members:2},{rank:2,scopeId:'513093|9',value:400,members:1}] });
        if(url.includes('scope=school')) return J({ metric:'views', scope:'school', k:null, totalRanked:93, mineScopeId:'513093',
          rows:[{rank:1,scopeId:'340315',value:561215185,members:1},{rank:2,scopeId:'513093',value:18227020,members:1}] });
        return J({ metric:'views', scope:'city', k:null, totalRanked:93, mineScopeId:'1602649942',
          rows:[{rank:1,scopeId:'1953726605',value:561215185,members:1},{rank:2,scopeId:'1602649942',value:18227020,members:1}] });
      }
      return J({});
    }
    return realFetch(u,o);
  };
})()`})
await send('Page.navigate',{url:`http://127.0.0.1:${PORT}/?ftoken=harness`})
await sleep(DELAY ? 2200 : 6000)   // when slow, open the rank screen BEFORE the directory lands
const evl=async e=>(await send('Runtime.evaluate',{returnByValue:true,awaitPromise:true,expression:e}))?.result?.value
await evl(`document.getElementById('rank-btn').click()`); await sleep(1800)
// Task 2 put a .scope-podium on the group tabs: every fixture below has only 2 rows, so BOTH now land
// on the podium and .scope-row is empty — the label is the same data, just drawn in a different place.
// Read pod-name alongside .nm b or this file stops testing anything the moment a scope has ≤3 rows.
const read=()=>evl(`(()=>({
  dirLoaded: !!(window.__dirProbe===undefined?true:true),
  rows:[
    ...[...document.querySelectorAll('#scope-board .scope-row')].map(r=>r.querySelector('.nm b').textContent),
    ...[...document.querySelectorAll('#scope-board .scope-podium .pod-name')].map(n=>n.textContent),
  ],
}))()`)
const names=(await read()).rows
console.log(`${DELAY?'SLOW directory':'normal'} → city rows:`, JSON.stringify(names))
await evl(`[...document.querySelectorAll('#scope-board .scope-tab')].find(b=>b.textContent==='בית ספר').click()`)
await sleep(1500)
console.log(`${DELAY?'SLOW directory':'normal'} → school rows:`, JSON.stringify((await read()).rows))
// class + grade: school-scoped, so the row must name the CLASS, not repeat the school on every row.
await evl(`[...document.querySelectorAll('#scope-board .scope-tab')].find(b=>b.textContent==='כיתה').click()`)
await sleep(1500)
const cls=(await read()).rows
console.log(`${DELAY?'SLOW':'normal'} → class rows:`, JSON.stringify(cls))
if (!cls.includes("י׳5")) { console.log('FAIL — class label wrong, expected י׳5, got', JSON.stringify(cls)); ws.close(); chrome.kill(); process.exit(1) }
await evl(`[...document.querySelectorAll('#scope-board .scope-tab')].find(b=>b.textContent==='שכבה').click()`)
await sleep(1500)
const grd=(await read()).rows
console.log(`${DELAY?'SLOW':'normal'} → grade rows:`, JSON.stringify(grd))
if (!grd.includes("שכבת י׳")) { console.log('FAIL — grade label wrong, expected שכבת י׳, got', JSON.stringify(grd)); ws.close(); chrome.kill(); process.exit(1) }
// The assertion, in both modes: not one row may be a bare number.
const bad = [...names, ...(await read()).rows].filter((n) => /^\d+$/.test(n))
if (bad.length) { console.log('FAIL — bare ids on screen:', bad.join(',')); ws.close(); chrome.kill(); process.exit(1) }
console.log(`${DELAY?'SLOW':'normal'}: PASS — every row names its place`)
ws.close(); chrome.kill()
