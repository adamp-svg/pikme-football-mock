import assert from 'assert';
import jwt from 'jsonwebtoken';
import { verifyFootballToken } from './shared/football-auth.js';

const SECRET = 'test-secret-123';
const good = jwt.sign({ id: 'u1', nickName: 'Adam', image: 'x.jpg' }, SECRET, { expiresIn: '12h' });

const ok = verifyFootballToken(good, SECRET);
assert.ok(ok && ok.userId === 'u1' && ok.nickName === 'Adam' && ok.image === 'x.jpg', 'valid token → identity');
assert.strictEqual(verifyFootballToken(good, 'wrong-secret'), null, 'wrong secret → null');
assert.strictEqual(verifyFootballToken('garbage', SECRET), null, 'garbage → null');
assert.strictEqual(verifyFootballToken(null, SECRET), null, 'no token → null');
assert.strictEqual(verifyFootballToken(good, undefined), null, 'no secret → null');
const expired = jwt.sign({ id: 'u1' }, SECRET, { expiresIn: -10 });
assert.strictEqual(verifyFootballToken(expired, SECRET), null, 'expired → null');
console.log('✅ verifyFootballToken PASS');
