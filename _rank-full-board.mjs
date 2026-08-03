/* The «כל הטבלה» control on the personal (אני) board — cards-app parity for the football leaderboard.
 *
 * Adam 2026-08-03: "make the football leaderboard similar to the cards one, so they can see the full
 * leaderboard on press etc." The board showed only top 3 + me±3; this opens the whole table.
 *
 * The clubs API is stubbed in-page so no token, no Mongo and no live server are needed — the client, the
 * DOM and the handlers are real. ⚠️ TWO GATES that make a naive version of this harness measure nothing:
 *   1. clubs.js BAILS unless /me answers with a `me` key, leaving #scope-wrap hidden and the board empty.
 *   2. the rank screen opens from #rank-btn — there is no [data-open-screen] for it.
 * Both cost a full debug cycle the first time.
 *
 *   node _rank-full-board.mjs        # needs a server on :3016
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', CDP=9443
const OUT='/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/24a0f464-af08-4018-9ddf-e3fad2a0324f/scratchpad/fullbtn'
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
  window.__asked=[];
  const row=(n)=>({rank:n,userId:'u'+n,nickName:'p'+n,image:null,club:null,emblem:null,value:1000-n,isMe:n===5});
  const realFetch=window.fetch;
  window.fetch=(u,o)=>{
    const url=String(u);
    if(url.includes('/dev/clubs')||url.includes('/handle-clubs')){
      window.__asked.push(url.replace(/^https?:\\/\\/[^/]+/,''));
      const J=(b)=>Promise.resolve(new Response(JSON.stringify(b),{status:200,headers:{'Content-Type':'application/json'}}));
      // ⚠️ the boot gate requires state.me.me — without that key clubs.js bails and #scope-wrap stays hidden.
      if(url.includes('/me')) return J({ me:{ userId:'u5', nickName:'אדם', trophies:2500, level:7 },
        club:null, metrics:[{key:'trophies',labelHe:'גביעים'}], scopes:{}, maxMembers:30, k:3 });
      if(url.includes('/board')){
        const full=url.includes('full=1');
        // 40 ranked players; the WINDOW shows 7 of them, the FULL board all 40.
        return J({ metric:'trophies', scope:'personal', full, totalRanked:40,
          me:{rank:5,value:995},
          rows: full ? Array.from({length:40},(_,i)=>row(i+1)) : [1,2,3,4,5,6,7].map(row) });
      }
      return J({});
    }
    return realFetch(u,o);
  };
})()`})
await send('Page.navigate',{url:'http://127.0.0.1:3016/?ftoken=harness'}); await sleep(6000)
const evl=async e=>(await send('Runtime.evaluate',{returnByValue:true,awaitPromise:true,expression:e}))?.result?.value
const results=[]; const check=(l,c,d)=>{results.push(!!c);console.log(`  ${c?'✓':'✗'} ${l}${d!==undefined?'  — '+d:''}`)}

await evl(`document.getElementById('rank-btn').click()`)
await sleep(2500)
// switch to the אני tab
await evl(`[...document.querySelectorAll('#scope-board .scope-tab')].find(b=>b.textContent==='אני')?.click()`)
await sleep(2000)
const read=()=>evl(`(()=>({
  rows:document.querySelectorAll('#scope-board .scope-row').length,
  btn:(document.querySelector('#scope-board .scope-more')||{}).textContent||null,
  note:[...document.querySelectorAll('#scope-board .scope-note')].map(n=>n.textContent),
  asked:window.__asked.filter(u=>u.includes('/board')),
}))()`)
let s=await read()
console.log('\n1) THE WINDOW, WITH A WAY OUT')
check('the window shows only its 7 rows', s.rows===7, `${s.rows} rows`)
check('a «כל הטבלה» button is offered', !!s.btn && s.btn.includes('כל הטבלה'), s.btn)
check('...and it names the population', !!s.btn && s.btn.includes('40'), s.btn)
check('the standing line is present', s.note.some(n=>n.includes('מקום')), s.note[0])

console.log('\n2) PRESS → THE FULL TABLE')
await evl(`document.querySelector('#scope-board .scope-more').click()`)
await sleep(2000)
s=await read()
check('every ranked player is listed', s.rows===40, `${s.rows} rows`)
check('the client asked for full=1', s.asked.some(u=>u.includes('full=1')), s.asked.join(' '))
check('the button now offers the way back', !!s.btn && s.btn.includes('קרוב אליי'), s.btn)

console.log('\n3) PRESS AGAIN → BACK TO THE WINDOW')
await evl(`document.querySelector('#scope-board .scope-more').click()`)
await sleep(2000)
s=await read()
check('back to the 7-row window', s.rows===7, `${s.rows} rows`)
check('and back to offering the full table', !!s.btn && s.btn.includes('כל הטבלה'), s.btn)

const r=await send('Page.captureScreenshot',{format:'png'})
if(r?.data){const {writeFileSync,mkdirSync}=await import('node:fs');mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/personal-window.png`,Buffer.from(r.data,'base64'))}
const pass=results.filter(Boolean).length
console.log(`\n${pass}/${results.length} PASS`)
ws.close(); chrome.kill(); process.exit(pass===results.length?0:1)
