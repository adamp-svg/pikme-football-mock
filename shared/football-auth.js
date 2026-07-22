// Verify the short-lived football-token the app injects. pikme-server signs it with
// the SAME FOOTBALL_TOKEN_SECRET. Returns null on any failure (fail closed).
import jwt from 'jsonwebtoken';

export function verifyFootballToken(token, secret) {
  if (!token || !secret) return null;
  try {
    const d = jwt.verify(token, secret);
    if (!d || !d.id) return null;
    return { userId: String(d.id), nickName: d.nickName || 'Player', image: d.image || null };
  } catch {
    return null;
  }
}
