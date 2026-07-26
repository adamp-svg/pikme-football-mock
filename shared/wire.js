// Binary snapshot wire codec (shared server <-> client). Replaces the ~1.4 KB JSON
// snapshot with a compact little-endian binary frame (~100 B), fully lossless vs the
// current wire: positions are already rounded to 0.1 on the JSON wire so i16 tenths is
// bit-identical; aim already 0.01 -> i8; fracs/fuse already 0.01 -> u8. Constant-per-
// match fields (player name/char/team, blast radius/maxLife, impact
// maxLife) and dead fields (tick, lastSeq, impact target/team) are NOT sent — team is
// carried once in the `roster` message; the rest are reconstructed on decode.
// (wall maxHp IS sent — a per-wall byte — so dry field walls (maxHp 2) aren't
// mistaken for built walls (maxHp 3) and rendered pre-cracked at full HP.)
//
// See docs/specs — synthesized from the snapshot-egress-optimization workflow.
import { BOMB, BUILT_WALL, FRAGILE_HP } from './constants.js';

export const MSG_KEYFRAME = 0x01;
const IMP = ['player', 'ball', 'wall', 'tramp'];
const IMP_IDX = { player: 0, ball: 1, wall: 2, tramp: 3 };
const clampI16 = (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
const u8c = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const u16c = (v) => (v < 0 ? 0 : v > 65535 ? 65535 : v);
// Fade PROGRESS 0..100 (0 = fresh, 100 = gone); the draw path only reads life/maxLife.
const fadeProg = (e) => u8c(Math.round((1 - e.life / e.maxLife) * 100));

const teamBit = (t) => (t === 'B' ? 1 : 0);
// ammo/buildAmmo get 2 bits each and today MAG_SIZE is 3 / BUILD_MAG is 2, so both fit exactly.
// SATURATE rather than mask: if a future card ever raises the mag to 4, `4 & 3` reads back as 0
// and the HUD shows an EMPTY gun on a full one, while min(3,·) shows "full" — wrong by a pip
// instead of wrong by a whole magazine.
// Clamped BOTH ways: a negative count would shift in as a run of 1-bits and corrupt the flags
// byte around it, which is how a 2-bit field turns into a whole-byte bug.
const q2 = (v) => (v > 3 ? 3 : v > 0 ? v | 0 : 0);
const packFlags = (p) => (p.firing ? 1 : 0) | (p.reloading ? 2 : 0) | (q2(p.ammo) << 2) | (q2(p.buildAmmo) << 4) | (p.power ? 64 : 0) | ((p.buildWindup > 0) ? 128 : 0);

// Reused scratch buffer (server-side, single-threaded). Encode returns a fresh slice.
// Sized to hold the LARGEST frame this codec can emit, so a busy tick can never walk a DataView
// past the end and throw inside the server's broadcast loop: 15 B header + 8 players x 17 B +
// FIVE 255-entry sections (projectiles 7 B, walls 15 B, bombs 9 B, blasts 7 B, impacts 10 B, each
// + a count byte) = 12396 B — measured by encoding a saturated frame, not derived on paper.
// A real frame is ~200 B; this is 16 KB allocated once, ever.
const SCRATCH = new ArrayBuffer(16384);
const EDV = new DataView(SCRATCH);

// slotIds: [id0,id1,id2,id3] (slot index -> player id). rv: rosterVersion (u8).
export function encodeKeyframe(s, slotIds, rv) {
  let o = 0;
  // TWO byte writers, deliberately. Conflating them is what produced the wall-AABB bug:
  //   bits() — a byte whose bits were BUILT to fit (flag packs, the slot mask, the 0xff
  //            sentinel, the mod-256 roster tag). Truncation is the DEFINITION here.
  //   u8()   — a MEASURED quantity. It SATURATES, so a value past the field's range clips by
  //            a pixel/point at the edge instead of wrapping to a wildly wrong number. A
  //            600px wall extent through the old masking writer became 88px, which moved the
  //            CLIENT's whole wall 256px off the SERVER's. Never write a measurement through
  //            bits(). (Not "drew where it didn't collide" — client.js wallSlab and arena.js
  //            nearestOnWall both read the same decoded cx/cy, so they agreed with each other
  //            and disagreed with the server: you get blocked by nothing and rubber-banded.)
  const bits = (v) => { EDV.setUint8(o, v & 255); o += 1; };
  const u8 = (v) => { EDV.setUint8(o, u8c(Math.round(v))); o += 1; };
  const i8 = (v) => { EDV.setInt8(o, v < -128 ? -128 : v > 127 ? 127 : v); o += 1; };
  const u16 = (v) => { EDV.setUint16(o, u16c(Math.round(v)), true); o += 2; };
  // Entity ids are IDENTITY, not measurement, so they get the wrapping writer: state._nid is an
  // unbounded `++` and an endless (noClock) training/builder match really does cross 65535 after
  // ~30 min of bot fire. Wrapping only aliases an id with one 65536 spawns older — long dead —
  // whereas SATURATING would give every entity past 65535 the same id 65535 forever and collapse
  // the client's per-id interpolation and per-bullet pierce sets.
  const id16 = (v) => { EDV.setUint16(o, v & 0xffff, true); o += 2; };
  const u32 = (v) => { EDV.setUint32(o, v >>> 0, true); o += 4; };
  const i16 = (v) => { EDV.setInt16(o, clampI16(v), true); o += 2; };
  const P = (v) => i16(Math.round(v * 10));

  bits(MSG_KEYFRAME);
  bits(rv); // MOD-256 roster tag — see the decoder's matching mask (server.js never wraps it)
  bits(s.phase === 'ended' ? 1 : 0);
  u8(s.elapsed | 0); // saturates at 255s: noClock (training/builder) matches run past that
  u16(s.resetTimer * 100);
  u8(s.score.A); u8(s.score.B); // saturate: an endless bot-farm match has no goal ceiling
  bits(s.lastGoal === 'A' ? 1 : s.lastGoal === 'B' ? 2 : 0);
  P(s.ball.x); P(s.ball.y);
  const ownerSlot = s.ball.owner == null ? 0xff : slotIds.indexOf(s.ball.owner);
  bits(ownerSlot < 0 ? 0xff : ownerSlot);

  const byId = new Map(s.players.map((p) => [p.id, p]));
  let mask = 0; const present = [];
  for (let k = 0; k < 8; k++) { const p = byId.get(slotIds[k]); if (p) { mask |= 1 << k; present.push(p); } } // up to 8 slots (mask is a u8) — training runs 5 players (you + 4 enemies)
  bits(mask);
  for (const p of present) {
    P(p.x); P(p.y); i16(Math.round(p.vx * 10)); i16(Math.round(p.vy * 10));
    i8(Math.round(p.aimX * 100)); i8(Math.round(p.aimY * 100));
    bits(packFlags(p));
    u8(p.reloadFrac * 100);
    // buildFrac byte is overloaded: WINDUP progress when winding (flag bit 7), else the
    // usual next-charge reload fraction. The client picks meaning off the winding flag.
    u8((p.buildWindup > 0 ? p.buildWindup : p.buildFrac) * 100);
    u32(p.lastSeq || 0); // last input seq the server applied for this player — client replays inputs AFTER it
  }
  // The count and the payload MUST agree. The old form wrote `length & 255` and then looped the
  // whole array, so a 256-entry list declared 0 records and emitted 256 — every following
  // section (walls, bombs, blasts, impacts) then parsed out of the wrong bytes and the decoder
  // ran off the end of the buffer and THREW, inside the client's ws.onmessage. Truncate for
  // real instead. Nothing reaches 255 today (sim.js caps projectiles at 50, impacts at 30, and
  // MAX_BUILT_WALLS*WALL_BLOCKS + 20 dry walls = 52) — but a codec must not rely on a cap that
  // lives in another file, and the failure mode here is the whole frame, not one field.
  const sec = (arr, fn) => { const n = arr.length > 255 ? 255 : arr.length; u8(n); for (let i = 0; i < n; i++) fn(arr[i]); };
  sec(s.projectiles, (p) => { id16(p.id); P(p.x); P(p.y); bits(teamBit(p.team)); });
  // Built walls can be ANGLED — the orientation (16 steps over a half-turn) rides in the
  // FREE upper nibble of the flags byte (bits 4-7), so no extra bytes on the wire.
  // maxHp rides in its own byte: dry field walls (maxHp 2) must not be mistaken for
  // built walls (maxHp 3), or they render pre-cracked at full HP.
  //
  // w/h/hl are u16 because a wall's SIZE IS NOT A BYTE. w/h are the AABB extents that
  // capsuleAABB() derives as 2*(|cos|hl + |sin|ht) / 2*(|sin|hl + |cos|ht), and server.js's
  // sanitizeField admits hl<=300, ht<=60 — so a vertical dry wall reaches h = 600 and a
  // diagonal one w = 566. Through a byte those became 88 and 54, and since the decoder rebuilds
  // the wall's CENTRE as x + w/2, the client drew and predicted the wall up to 256px from where
  // the server collided with it. hl itself is u16 for the same reason (it was saturating 300
  // -> 255, i.e. a 600px wall rendering 510px long). ht<=60 genuinely is a byte.
  // hp is ROUNDED, not truncated: a mid-charge shot does BUILT_WALL.hp/2 = 1.5 damage, and
  // `1.5 << 1` truncates to hp 1 — a wall at half health drew one crack stage from death.
  // sim.js's own display tier is Math.round(hp) (see the R4 hpTier), so match it.
  sec(s.walls, (w) => { const ai = ((Math.round((w.angle || 0) / (Math.PI / 16)) % 16) + 16) % 16; const hp3 = Math.max(0, Math.min(3, Math.round(w.hp))); id16(w.id); P(w.x); P(w.y); u16(w.w); u16(w.h); bits(teamBit(w.team) | (hp3 << 1) | (w.fragile ? 8 : 0) | (ai << 4)); u8(Math.min(w.maxHp || BUILT_WALL.hp, 3)); u16(w.hl != null ? w.hl : BUILT_WALL.len / 2); u8(w.ht != null ? w.ht : BUILT_WALL.thick / 2); });
  sec(s.bombs, (b) => { id16(b.id); P(b.x); P(b.y); bits(teamBit(b.team)); u8(b.fuse * 100); const os = b.owner == null ? 0xff : slotIds.indexOf(b.owner); bits(os < 0 ? 0xff : os); }); // owner slot → client arcs the throw FROM the planter
  sec(s.blasts, (b) => { id16(b.id); P(b.x); P(b.y); u8(fadeProg(b)); });
  sec(s.impacts, (i) => { id16(i.id); bits(IMP_IDX[i.type] ?? 2); P(i.x); P(i.y); i8(Math.round(i.dx * 100)); i8(Math.round(i.dy * 100)); u8(fadeProg(i)); });
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
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const i16 = () => { const v = dv.getInt16(o, true); o += 2; return v; };
  const P = () => i16() / 10;

  u8(); // msgType (only keyframe for now)
  const rv = u8();
  // The roster tag is ONE byte, so compare mod 256. server.js keeps room.rosterVersion as an
  // unbounded `++` int and sends it RAW in the JSON roster message (which is what the caller
  // passes in here) but masked on this wire — so at the 256th roster change of a room's life the
  // byte said 0 while the client held 256, this guard rejected every frame from then on, and the
  // match froze permanently with no error. A false match now needs the roster to change exactly
  // 256 times while one frame is in flight, which is not physically reachable.
  if (rosterVersion != null && rv !== (rosterVersion & 255)) return null;
  const phase = u8() ? 'ended' : 'match';
  const elapsed = u8();
  const resetTimer = u16() / 100;
  const score = { A: u8(), B: u8() };
  const lg = u8(); const lastGoal = lg === 1 ? 'A' : lg === 2 ? 'B' : null;
  const ball = { x: P(), y: P(), owner: null };
  const ownerSlot = u8();
  const mask = u8();
  const players = [];
  for (let k = 0; k < 8; k++) {
    if (!(mask & (1 << k))) continue;
    const x = P(), y = P(), vx = i16() / 10, vy = i16() / 10;
    const aimX = i8() / 100, aimY = i8() / 100;
    const flags = u8(); const reloadFrac = u8() / 100, buildFrac = u8() / 100; const lastSeq = u32();
    players.push({
      id: slotId[k], char: 'player', team: slotTeam[k],
      x, y, vx, vy, aimX, aimY,
      firing: !!(flags & 1), reloading: !!(flags & 2), ammo: (flags >> 2) & 3, buildAmmo: (flags >> 4) & 3, power: !!(flags & 64),
      winding: !!(flags & 128),
      reloadFrac, buildFrac, lastSeq,
    });
  }
  ball.owner = ownerSlot === 0xff ? null : slotId[ownerSlot];
  const rd = (fn) => { const c = u8(); const a = []; for (let i = 0; i < c; i++) a.push(fn()); return a; };
  const projectiles = rd(() => ({ id: u16(), x: P(), y: P(), team: u8() ? 'B' : 'A' }));
  // Field order must track the encoder byte for byte: id u16, x/y P, w u16, h u16, flags,
  // maxHp, hl u16, ht u8.
  const walls = rd(() => { const id = u16(), x = P(), y = P(), w = u16(), h = u16(), f = u8(), mh = u8(), hl = u16(), ht = u8(); const fragile = !!(f & 8); const angle = ((f >> 4) & 15) * (Math.PI / 16); return { id, x, y, w, h, team: (f & 1) ? 'B' : 'A', hp: (f >> 1) & 3, fragile, maxHp: fragile ? FRAGILE_HP : (mh || BUILT_WALL.hp), angle, cx: x + w / 2, cy: y + h / 2, hl: hl || BUILT_WALL.len / 2, ht: ht || BUILT_WALL.thick / 2 }; });
  const bombs = rd(() => { const id = u16(), x = P(), y = P(), team = u8() ? 'B' : 'A', fuse = u8() / 100, os = u8(); return { id, x, y, team, fuse, owner: os === 0xff ? null : slotId[os] }; });
  const blasts = rd(() => { const id = u16(), x = P(), y = P(), lp = u8(); return { id, x, y, radius: BOMB.radius, maxLife: 1, life: 1 - lp / 100 }; });
  const impacts = rd(() => { const id = u16(), t = u8(), x = P(), y = P(), dx = i8() / 100, dy = i8() / 100, lp = u8(); return { id, type: IMP[t] || 'wall', x, y, dx, dy, maxLife: 1, life: 1 - lp / 100 }; });
  return { type: 'snapshot', rv, phase, elapsed, resetTimer, lastGoal, score, ball, players, projectiles, walls, bombs, blasts, impacts };
}
