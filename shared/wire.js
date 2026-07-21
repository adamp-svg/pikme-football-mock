// Binary snapshot wire codec (shared server <-> client). Replaces the ~1.4 KB JSON
// snapshot with a compact little-endian binary frame (~100 B), fully lossless vs the
// current wire: positions are already rounded to 0.1 on the JSON wire so i16 tenths is
// bit-identical; aim already 0.01 -> i8; fracs/fuse already 0.01 -> u8. Constant-per-
// match fields (player name/char/team, wall maxHp, blast radius/maxLife, impact
// maxLife) and dead fields (tick, lastSeq, impact target/team) are NOT sent — team is
// carried once in the `roster` message; the rest are reconstructed on decode.
//
// See docs/specs — synthesized from the snapshot-egress-optimization workflow.
import { BOMB, BUILT_WALL, FRAGILE_HP } from './constants.js';

export const MSG_KEYFRAME = 0x01;
const IMP = ['player', 'ball', 'wall', 'tramp'];
const IMP_IDX = { player: 0, ball: 1, wall: 2, tramp: 3 };
const clampI16 = (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
const u8c = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
// Fade PROGRESS 0..100 (0 = fresh, 100 = gone); the draw path only reads life/maxLife.
const fadeProg = (e) => u8c(Math.round((1 - e.life / e.maxLife) * 100));

const teamBit = (t) => (t === 'B' ? 1 : 0);
const packFlags = (p) => (p.firing ? 1 : 0) | (p.reloading ? 2 : 0) | ((p.ammo & 3) << 2) | ((p.buildAmmo & 3) << 4) | (p.power ? 64 : 0);

// Reused scratch buffer (server-side, single-threaded). Encode returns a fresh slice.
const SCRATCH = new ArrayBuffer(8192);
const EDV = new DataView(SCRATCH);

// slotIds: [id0,id1,id2,id3] (slot index -> player id). rv: rosterVersion (u8).
export function encodeKeyframe(s, slotIds, rv) {
  let o = 0;
  const u8 = (v) => { EDV.setUint8(o, v & 255); o += 1; };
  const i8 = (v) => { EDV.setInt8(o, v < -128 ? -128 : v > 127 ? 127 : v); o += 1; };
  const u16 = (v) => { EDV.setUint16(o, v & 0xffff, true); o += 2; };
  const i16 = (v) => { EDV.setInt16(o, clampI16(v), true); o += 2; };
  const P = (v) => i16(Math.round(v * 10));

  u8(MSG_KEYFRAME); u8(rv);
  u8(s.phase === 'ended' ? 1 : 0);
  u8(Math.min(255, s.elapsed | 0));
  u16(Math.round(s.resetTimer * 100));
  u8(s.score.A); u8(s.score.B);
  u8(s.lastGoal === 'A' ? 1 : s.lastGoal === 'B' ? 2 : 0);
  P(s.ball.x); P(s.ball.y);
  const ownerSlot = s.ball.owner == null ? 0xff : slotIds.indexOf(s.ball.owner);
  u8(ownerSlot < 0 ? 0xff : ownerSlot);

  const byId = new Map(s.players.map((p) => [p.id, p]));
  let mask = 0; const present = [];
  for (let k = 0; k < 4; k++) { const p = byId.get(slotIds[k]); if (p) { mask |= 1 << k; present.push(p); } }
  u8(mask);
  for (const p of present) {
    P(p.x); P(p.y); i16(Math.round(p.vx * 10)); i16(Math.round(p.vy * 10));
    i8(Math.round(p.aimX * 100)); i8(Math.round(p.aimY * 100));
    u8(packFlags(p));
    u8(Math.round(p.reloadFrac * 100)); u8(Math.round(p.buildFrac * 100));
  }
  const sec = (arr, fn) => { u8(arr.length & 255); for (const e of arr) fn(e); };
  sec(s.projectiles, (p) => { u16(p.id); P(p.x); P(p.y); u8(teamBit(p.team)); });
  sec(s.walls, (w) => { u16(w.id); P(w.x); P(w.y); u8(w.w); u8(w.h); u8(teamBit(w.team) | ((Math.min(w.hp, 3)) << 1) | (w.fragile ? 8 : 0)); });
  sec(s.bombs, (b) => { u16(b.id); P(b.x); P(b.y); u8(teamBit(b.team)); u8(Math.round(b.fuse * 100)); });
  sec(s.blasts, (b) => { u16(b.id); P(b.x); P(b.y); u8(fadeProg(b)); });
  sec(s.impacts, (i) => { u16(i.id); u8(IMP_IDX[i.type] ?? 2); P(i.x); P(i.y); i8(Math.round(i.dx * 100)); i8(Math.round(i.dy * 100)); u8(fadeProg(i)); });
  return SCRATCH.slice(0, o);
}

// dv: DataView over the received ArrayBuffer. slotId/slotTeam: slot -> id/team ('A'|'B').
// Returns a full snapshot object of the exact shape the client already consumes, or
// null if the frame's rosterVersion doesn't match (reconnect seam guard).
export function decodeSnapshot(dv, slotId, slotTeam, rosterVersion) {
  let o = 0;
  const u8 = () => { const v = dv.getUint8(o); o += 1; return v; };
  const i8 = () => { const v = dv.getInt8(o); o += 1; return v; };
  const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
  const i16 = () => { const v = dv.getInt16(o, true); o += 2; return v; };
  const P = () => i16() / 10;

  u8(); // msgType (only keyframe for now)
  const rv = u8();
  if (rosterVersion != null && rv !== rosterVersion) return null;
  const phase = u8() ? 'ended' : 'match';
  const elapsed = u8();
  const resetTimer = u16() / 100;
  const score = { A: u8(), B: u8() };
  const lg = u8(); const lastGoal = lg === 1 ? 'A' : lg === 2 ? 'B' : null;
  const ball = { x: P(), y: P(), owner: null };
  const ownerSlot = u8();
  const mask = u8();
  const players = [];
  for (let k = 0; k < 4; k++) {
    if (!(mask & (1 << k))) continue;
    const x = P(), y = P(), vx = i16() / 10, vy = i16() / 10;
    const aimX = i8() / 100, aimY = i8() / 100;
    const flags = u8(); const reloadFrac = u8() / 100, buildFrac = u8() / 100;
    players.push({
      id: slotId[k], char: 'player', team: slotTeam[k],
      x, y, vx, vy, aimX, aimY,
      firing: !!(flags & 1), reloading: !!(flags & 2), ammo: (flags >> 2) & 3, buildAmmo: (flags >> 4) & 3, power: !!(flags & 64),
      reloadFrac, buildFrac,
    });
  }
  ball.owner = ownerSlot === 0xff ? null : slotId[ownerSlot];
  const rd = (fn) => { const c = u8(); const a = []; for (let i = 0; i < c; i++) a.push(fn()); return a; };
  const projectiles = rd(() => ({ id: u16(), x: P(), y: P(), team: u8() ? 'B' : 'A' }));
  const walls = rd(() => { const id = u16(), x = P(), y = P(), w = u8(), h = u8(), f = u8(); const fragile = !!(f & 8); return { id, x, y, w, h, team: (f & 1) ? 'B' : 'A', hp: (f >> 1) & 3, fragile, maxHp: fragile ? FRAGILE_HP : BUILT_WALL.hp }; });
  const bombs = rd(() => ({ id: u16(), x: P(), y: P(), team: u8() ? 'B' : 'A', fuse: u8() / 100 }));
  const blasts = rd(() => { const id = u16(), x = P(), y = P(), lp = u8(); return { id, x, y, radius: BOMB.radius, maxLife: 1, life: 1 - lp / 100 }; });
  const impacts = rd(() => { const id = u16(), t = u8(), x = P(), y = P(), dx = i8() / 100, dy = i8() / 100, lp = u8(); return { id, type: IMP[t] || 'wall', x, y, dx, dy, maxLife: 1, life: 1 - lp / 100 }; });
  return { type: 'snapshot', rv, phase, elapsed, resetTimer, lastGoal, score, ball, players, projectiles, walls, bombs, blasts, impacts };
}
