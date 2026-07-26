// Play-with-friends: the 3v3 option and the team-page chat. Run: node test-party-3v3-chat.mjs
//
// Boots its OWN server on a private port with a matching FOOTBALL_TOKEN_SECRET (same pattern as
// test-party.mjs), so `for f in test*.mjs` passes with nothing set up.
//
// What it pins down:
//   1. a party room seats FOUR by default and SIX once the host picks 3v3 — the pick has to reach the
//      server, because capacity is teamSize x 2 and used to be applied only at match start;
//   2. shrinking back to 2v2 with six seated is REFUSED rather than silently stranding two people;
//   3. only the host may pick;
//   4. an IN-MATCH word and an IN-MATCH emote reach every member as `member.chat`;
//   5. free text is sanitized to 40 code points, and control/bidi characters never survive;
//   6. free text is refused in a PUBLIC room (shared/quick-messages.js FREE_TEXT_ROOMS).
import { WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { spawn } from 'node:child_process';
import { sanitizeFreeText, FREE_TEXT_MAX } from './shared/quick-messages.js';
import { chatById, CHAT_SEND_GAP_MS } from './shared/quick-chat.js';

const SECRET = process.env.FOOTBALL_TOKEN_SECRET || 'testsecret';
const OWN_PORT = 3800 + (process.pid % 90);
let child = null;
if (!process.env.URL) {
  child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(OWN_PORT), FOOTBALL_TOKEN_SECRET: SECRET },
    stdio: 'ignore',
  });
  process.on('exit', () => child?.kill());
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { const res = await fetch(`http://localhost:${OWN_PORT}/`); if (res.ok) break; } catch { /* not up */ }
  }
}
const URL = process.env.URL || `ws://localhost:${OWN_PORT}`;
const tok = (id, nick) => jwt.sign({ id, nickName: nick }, SECRET, { expiresIn: '1h' });

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

function client(id, nick) {
  const ws = new WebSocket(URL);
  const c = { ws, id, nick, msgs: [], memberId: null, lobby: null, errors: [] };
  ws.on('message', (raw) => {
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }   // binary snapshots aren't JSON
    c.msgs.push(m);
    if (m.type === 'welcome') c.memberId = m.id;
    if (m.type === 'lobby') c.lobby = m;
    if (m.type === 'partyError') c.errors.push(m.msg || '');
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.ready = new Promise((res) => ws.on('open', res));
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(40); }
  return false;
}

// ---- three friends, one party ------------------------------------------------------------------
const host = client('u-host', 'Host');
const f1 = client('u-f1', 'Friend1');
const f2 = client('u-f2', 'Friend2');
await Promise.all([host.ready, f1.ready, f2.ready]);
for (const c of [host, f1, f2]) c.send({ type: 'join', authToken: tok(c.id, c.nick), name: c.nick, cards: [], loadout: [null, null, null] });
await until(() => host.memberId && f1.memberId && f2.memberId);
// everyone is friends with everyone (the invite path checks the friends list)
host.send({ type: 'setFriends', friends: [f1.id, f2.id] });
f1.send({ type: 'setFriends', friends: [host.id, f2.id] });
f2.send({ type: 'setFriends', friends: [host.id, f1.id] });
await wait(150);

host.send({ type: 'createRoom' });
await until(() => host.lobby && host.lobby.code);
const code = host.lobby.code;
ok(!!code, `host opened a private room (${code})`);
ok(host.lobby.maxPlayers === 4, `a fresh party seats 4 (${host.lobby.maxPlayers})`);
ok(host.lobby.freeText === true, 'a private room allows free text');

// ---- 1. the 3v3 pick reaches the server and raises capacity ------------------------------------
host.send({ type: 'partyGame', game: '3v3' });
await until(() => host.lobby && host.lobby.maxPlayers === 6);
ok(host.lobby.maxPlayers === 6, `picking 3v3 raises capacity to 6 (${host.lobby.maxPlayers})`);
ok(host.lobby.teamSize === 3, `and teamSize to 3 (${host.lobby.teamSize})`);
ok(host.lobby.game === '3v3', `the pick is published to every member (game=${host.lobby.game})`);

// two friends join, then fill to six with invited bots — only possible at teamSize 3
for (const f of [f1, f2]) { host.send({ type: 'inviteFriend', toUserId: f.id }); await wait(120); f.send({ type: 'partyRespond', code, accept: true }); await wait(160); }
await until(() => host.lobby && host.lobby.members.length >= 3);
ok(host.lobby.members.length === 3, `both friends joined (${host.lobby.members.length} members)`);
for (let i = 0; i < 3; i++) { host.send({ type: 'addBot', botId: `bot${i}`, name: `Bot${i}` }); await wait(120); }
await until(() => host.lobby && host.lobby.members.length + 0 >= 3 && (host.lobby.members || []).length >= 6);
ok((host.lobby.members || []).length === 6, `the room seats SIX at 3v3 (${(host.lobby.members || []).length})`);

// ---- 1b. the SETUP flow order: game BEFORE invites --------------------------------------------
// In the setup flow the card is picked before the room exists, so the pick lands from
// applyPartyPicks() instead of from the picker. If it arrived AFTER the invites (or not at all) the
// room would still be seating four and the fifth invitee would bounce on "החדר מלא".
{
  const h2 = client('u-host2', 'Host2');
  const g1 = client('u-g1', 'Guest1');
  await Promise.all([h2.ready, g1.ready]);
  for (const c of [h2, g1]) c.send({ type: 'join', authToken: tok(c.id, c.nick), name: c.nick, cards: [], loadout: [null, null, null] });
  await until(() => h2.memberId && g1.memberId);
  h2.send({ type: 'setFriends', friends: [g1.id] });
  g1.send({ type: 'setFriends', friends: [h2.id] });
  await wait(150);
  h2.send({ type: 'createRoom' });
  await until(() => h2.lobby && h2.lobby.code);
  // what applyPartyPicks() does, in its order: the game, then the invites/bots
  h2.send({ type: 'partyGame', game: '3v3' });
  for (let i = 0; i < 5; i++) h2.send({ type: 'addBot', botId: `sbot${i}`, name: `SBot${i}` });
  await until(() => h2.lobby && (h2.lobby.members || []).length >= 6, 4000);
  ok((h2.lobby.members || []).length === 6, `setup flow: game-then-invites seats six (${(h2.lobby.members || []).length})`);
  ok(h2.lobby.teamSize === 3, 'and the room really is 3v3');
  h2.ws.close(); g1.ws.close();
}

// ---- 2. shrinking with six seated is refused ---------------------------------------------------
host.errors.length = 0;
host.send({ type: 'partyGame', game: '2v2' });
await until(() => host.errors.length > 0);
ok(host.errors.length > 0, `switching to 2v2 with six seated is refused ("${host.errors[0] || ''}")`);
ok(host.lobby.teamSize === 3, 'and the room stays at 3v3 rather than stranding two players');

// ---- 3. only the host may pick -----------------------------------------------------------------
f1.errors.length = 0;
f1.send({ type: 'partyGame', game: '2v2' });
await until(() => f1.errors.length > 0);
ok(f1.errors.length > 0, `a non-host pick is refused ("${f1.errors[0] || ''}")`);

// ---- 4. the in-match vocabulary reaches everyone ----------------------------------------------
// The lobby composer speaks shared/quick-chat.js (the words+emotes the MATCH uses), not the
// friend-thread presets: a team page is the moment before a match.
const chatOf = (c, memberId) => ((c.lobby && c.lobby.members) || []).find((m) => m.id === memberId)?.chat || null;
f1.send({ type: 'partyChat', chatId: 'w_go' });
await until(() => chatOf(host, f1.memberId));
const word = chatOf(host, f1.memberId);
ok(!!word && word.text === chatById('w_go').text, `an in-match WORD reaches the other members (${word && word.text})`);
ok(!!chatOf(f2, f1.memberId), 'and the third member sees it too');

await wait(CHAT_SEND_GAP_MS + 200);
f1.send({ type: 'partyChat', chatId: 'e_thumbsup' });
await until(() => (chatOf(host, f1.memberId) || {}).chatId === 'e_thumbsup');
const emo = chatOf(host, f1.memberId);
ok(!!emo && emo.chatId === 'e_thumbsup', `an EMOTE travels as an id so the client can draw the sprite (${emo && emo.chatId})`);
ok(!!emo && emo.text === '', 'an emote carries no words');

// an id this build does not know is ignored rather than rendered blank
await wait(CHAT_SEND_GAP_MS + 200);
f1.send({ type: 'partyChat', chatId: 'w_not_a_real_id' });
await wait(250);
ok((chatOf(host, f1.memberId) || {}).chatId === 'e_thumbsup', 'an unknown chat id is ignored (the last message stands)');

// ---- 5. free text is sanitized ----------------------------------------------------------------
await wait(6200);                                     // clear the burst window (3 in 6s) too
const long = 'ש'.repeat(60);
f2.send({ type: 'partyChat', text: long });
await until(() => chatOf(host, f2.memberId));
const cut = chatOf(host, f2.memberId);
ok(cut && Array.from(cut.text).length === FREE_TEXT_MAX, `free text is cut to ${FREE_TEXT_MAX} characters (got ${cut && Array.from(cut.text).length})`);

await wait(CHAT_SEND_GAP_MS + 200);
const dirty = 'a b\u202egone\u200b c';
f2.send({ type: 'partyChat', text: dirty });
await until(() => (chatOf(host, f2.memberId) || {}).text !== cut.text);
const clean = chatOf(host, f2.memberId);
ok(clean && !/[\u0000-\u001f\u202e\u200b]/.test(clean.text), `control and bidi characters never survive ("${clean && clean.text}")`);
ok(clean && clean.text === sanitizeFreeText(dirty), 'the server applies the SAME shared sanitizer the composer counts with');

// ---- 6. the rate limit holds ------------------------------------------------------------------
const before = (chatOf(host, f2.memberId) || {}).text;
f2.send({ type: 'partyChat', text: 'spam one' });
f2.send({ type: 'partyChat', text: 'spam two' });
await wait(300);
const after = (chatOf(host, f2.memberId) || {}).text;
ok(after !== 'spam two' || before === 'spam one', `two sends inside ${CHAT_SEND_GAP_MS}ms do not both land (last: "${after}")`);

// ---- 7. free text is refused in a PUBLIC room -------------------------------------------------
const pub = client('u-pub', 'Pub');
await pub.ready;
pub.send({ type: 'join', authToken: tok(pub.id, pub.nick), name: pub.nick, cards: [], loadout: [null, null, null] });
await until(() => pub.memberId);
pub.send({ type: 'quickMatch', diffLevel: 3 });
await until(() => pub.lobby && pub.lobby.mode === 'quick');
ok(pub.lobby && pub.lobby.freeText === false, 'a public matchmade room reports freeText: false');
pub.errors.length = 0;
pub.send({ type: 'partyChat', text: 'hello strangers' });
await until(() => pub.errors.length > 0, 1500);
ok(pub.errors.length > 0, `free text in a public room is refused ("${pub.errors[0] || ''}")`);
pub.send({ type: 'partyChat', chatId: 'w_nice' });
await until(() => ((pub.lobby && pub.lobby.members) || []).some((m) => m.chat), 1500);
ok(((pub.lobby && pub.lobby.members) || []).some((m) => m.chat), 'but an in-match WORD still works there');

for (const c of [host, f1, f2, pub]) c.ws.close();
console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
