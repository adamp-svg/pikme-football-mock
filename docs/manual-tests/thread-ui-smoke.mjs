// Browser smoke test for the friend-thread UI (preset messages + shared arenas).
// NOT part of the `test*.mjs` suite: it needs Playwright and a running server, so it lives here
// and is run by hand.
//
//   1. mint a token:  node -e "console.log(require('jsonwebtoken').sign({id:'507f1f77bcf86cd799439099',nickName:'test'},'testsecret',{expiresIn:'6h'}))"
//      and paste it into PIKME_FOOTBALL_TOKEN below (the one in here expires).
//   2. FOOTBALL_TOKEN_SECRET=testsecret PORT=3018 node server.js
//   3. npm i playwright && node docs/manual-tests/thread-ui-smoke.mjs
//
// It stubs the pikme-server REST layer, so it proves the CLIENT works; it does not exercise
// the real /handle-messages endpoints (those have their own unit tests in pikme-server).
// Expect: all 26 checks passed.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3018';
let fails = 0, ran = 0;
const ok = (c, m) => { ran++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); if (!c) fails++; };

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 500 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

// Fake identity + a fake /handle-messages backend, installed BEFORE the app boots.
await page.addInitScript(() => {
  window.PIKME_FOOTBALL_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjUwN2YxZjc3YmNmODZjZDc5OTQzOTA5OSIsIm5pY2tOYW1lIjoi15DXoNeZIiwiaWF0IjoxNzg1MDA3ODM0LCJleHAiOjE3ODUwMjk0MzR9.n046-hwVEWtCHfjNgQSWDdecSqAUDszZPuh_UKlCLuY';
  window.PIKME_API = 'https://fake.pikme.test';
  const FRIEND = { userId: '507f1f77bcf86cd799439011', nickName: 'דני', xp: 100, level: 3 };
  window.__sent = [];
  let msgs = [
    { id: 'm1', fromUserId: FRIEND.userId, toUserId: '507f1f77bcf86cd799439099', kind: 'preset', presetId: 'praise_wd', reactions: [], createdAt: new Date().toISOString(), read: false },
    { id: 'm2', fromUserId: FRIEND.userId, toUserId: '507f1f77bcf86cd799439099', kind: 'arena', arena: { name: 'האצטדיון שלי', field: { version: 1, bushes: [{ x: 1, y: 1, w: 40, h: 40 }], hardWalls: [], dryWalls: [], crates: [] } }, reactions: [], createdAt: new Date().toISOString(), read: false },
  ];
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opt) => {
    const u = String(url);
    if (!u.includes('fake.pikme.test')) return realFetch(url, opt);
    const body = opt && opt.body ? JSON.parse(opt.body) : null;
    if (u.includes('/handle-friends/requests')) return json([]);
    if (u.includes('/handle-friends/rank')) return json({ rank: null });
    if (u.includes('/cards')) return json({ cards: [] });
    if (u.endsWith('/handle-friends')) return json([FRIEND]);
    if (u.includes('/handle-messages/threads')) return json([{ userId: FRIEND.userId, unread: 2, last: msgs[msgs.length - 1] }]);
    if (u.includes('/handle-messages/thread')) return json(msgs);
    if (u.includes('/handle-messages/send')) {
      window.__sent.push(body);
      const m = { id: 'm' + (msgs.length + 1), fromUserId: '507f1f77bcf86cd799439099', toUserId: body.toUserId, kind: body.kind, presetId: body.presetId || null, arena: body.arena || null, reactions: [], createdAt: new Date().toISOString(), read: false };
      msgs.push(m); return json(m);
    }
    if (u.includes('/handle-messages/react')) {
      const m = msgs.find((x) => x.id === body.messageId);
      m.reactions = [{ userId: '507f1f77bcf86cd799439099', emoji: body.emoji }];
      return json(m);
    }
    return json({});
  };
});

await page.goto(BASE, { waitUntil: 'networkidle' });
// MY_USER_ID comes from the WS `welcome`; force it so canMessage() passes in this harness.
await page.waitForTimeout(1500);   // let the WS `welcome` land so MY_USER_ID is set

ok(errors.length === 0, 'the app boots with no page errors' + (errors.length ? ' — ' + errors[0] : ''));

// Open the friends screen.
await page.click('#friends-btn');
await page.waitForTimeout(600);
ok(await page.isVisible('#friends'), 'friends screen opens');

const cards = await page.locator('#friend-list .friend-card').count();
ok(cards > 0, `friend list renders (${cards} cards)`);

// The real friend (not a bot) should carry the unread chip from /threads.
const unread = await page.locator('#friend-list .fc-unread').first().textContent().catch(() => null);
ok(unread === '2', `unread chip shows the count (got ${unread})`);
ok(await page.locator('#friends-unread:not(.hidden)').count() === 1, 'hub friends button shows an unread badge');

// Tap the card → thread opens (the avatar is the profile, tested after).
await page.locator('#friend-list .friend-card:not(.is-bot)').first().click();
await page.waitForTimeout(600);
ok(await page.isVisible('#thread'), 'tapping a friend card opens the thread');
ok((await page.textContent('#th-name')) === 'דני', 'thread header shows the friend name');

const bubbles = await page.locator('#th-msgs .th-bub').count();
ok(bubbles === 2, `both messages render (${bubbles})`);
ok((await page.locator('#th-msgs .th-bub').first().textContent()).includes('כל הכבוד'), 'a preset id renders as its Hebrew phrase');
ok(await page.locator('.th-arena-name').count() === 1, 'the shared arena renders as a card');
ok((await page.textContent('.th-arena-sub')).includes('1'), 'the arena card shows its element count');

// Unread should clear once the thread is read.
ok(await page.locator('#friends-unread.hidden').count() === 1, 'unread badge clears after reading the thread');

// Send a preset.
await page.click('#th-say');
await page.waitForTimeout(300);
ok(await page.isVisible('#th-sheet'), 'the phrase sheet opens');
const tabs = await page.locator('.th-sheet-tab').count();
ok(tabs === 4, `phrase groups render as tabs (${tabs})`);
await page.locator('.th-phrase').first().click();
await page.waitForTimeout(400);
const sent = await page.evaluate(() => window.__sent);
ok(sent.length === 1 && sent[0].kind === 'preset' && /^[a-z0-9_]{1,24}$/.test(sent[0].presetId), 'sending a phrase posts a valid preset id: ' + JSON.stringify(sent[0]));
ok(await page.locator('#th-msgs .th-row.mine').count() === 1, 'the sent phrase appears as my own bubble');

// Share an arena from the saved library.
await page.evaluate(() => localStorage.setItem('pikme-fields', JSON.stringify([{ id: 'f1', name: 'מגרש בדיקה', field: { version: 1, bushes: [{ x: 1, y: 1, w: 40, h: 40 }], hardWalls: [], dryWalls: [], crates: [] } }])));
await page.click('#th-share');
await page.waitForTimeout(300);
ok(await page.isVisible('#th-arena-sheet'), 'the arena picker opens');
ok(await page.locator('#th-arena-list .th-phrase').count() === 1, 'the saved field is listed');
await page.locator('#th-arena-list .th-phrase').first().click();
await page.waitForTimeout(400);
const sent2 = await page.evaluate(() => window.__sent);
ok(sent2.length === 2 && sent2[1].kind === 'arena' && sent2[1].arena.name === 'מגרש בדיקה', 'sharing posts the arena payload');

// Save a RECEIVED arena into the library — must not overwrite the existing one.
await page.locator('.th-arena-btn.ghost').first().click();
await page.waitForTimeout(300);
const lib = await page.evaluate(() => JSON.parse(localStorage.getItem('pikme-fields')));
ok(lib.length === 2, `saving a received arena appends to the library (${lib.length} entries)`);
ok(lib.some((s) => s.name === 'מגרש בדיקה'), 'the pre-existing field survives the save');
ok(lib.some((s) => s.name === 'האצטדיון שלי'), 'the received arena is saved under its own name');

// Long-press → reaction bar.
const bub = page.locator('#th-msgs .th-bub').first();
const box = await bub.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.waitForTimeout(600);
await page.mouse.up();
ok(await page.isVisible('#th-react'), 'long-pressing a bubble opens the reaction bar');
await page.locator('.th-react-btn').first().click();
await page.waitForTimeout(400);
ok(await page.locator('.th-reacts').count() >= 1, 'the reaction lands on the message');

// The avatar still opens the profile modal.
await page.click('#th-back');
await page.waitForTimeout(400);
await page.locator('#friend-list .friend-card:not(.is-bot) .fc-pfp').first().click();
await page.waitForTimeout(400);
ok(await page.isVisible('#friend-profile-modal'), 'tapping the avatar still opens the profile modal');

const late = errors.filter((e) => !e.includes('WebSocket') && !e.includes('favicon'));
ok(late.length === 0, 'no runtime errors during the flow' + (late.length ? ' — ' + late.join(' | ') : ''));

await browser.close();
console.log(fails ? `\n${fails} of ${ran} FAILED` : `\nall ${ran} checks passed`);
process.exit(fails ? 1 : 0);
