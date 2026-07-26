// Authored START POSITIONS + BALL SPOT for a builder field.
//
// WHY THIS FILE EXISTS
// Until now every kickoff position came from one formula (`spawnPos` in sim.js): a fixed fy band
// per slot, mirrored per team. A field author could sculpt the whole pitch but not say WHERE the
// players stand when the whistle blows, and the ball always started glued to one team in the
// middle. Both are layout decisions, so they belong in the layout — which means they travel inside
// the saved field, get sanitized on the server like every other authored coordinate, and fall back
// to the formula when a field doesn't declare them (every pre-existing field, forever).
//
// THE MODEL
//   field.spawns = [{ x, y, team: 'A'|'B' }]   — start slots. Team is STORED, not derived from the
//                                                half: placement guesses it from the half (A defends
//                                                left), but an author may drag a slot across the
//                                                halfway line on purpose (a high press) and that
//                                                choice must survive a save.
//   field.ball   = { x, y } | null              — where the ball starts each kickoff. Authored =>
//                                                the ball sits there LOOSE (Brawl-Stars Brawl Ball:
//                                                both teams race for it) instead of being handed to
//                                                one team. Absent => today's behaviour, untouched.
//
// CAPACITY — "how many players does this map hold?" — is min(#A, #B): a map with 3 A-slots and 1
// B-slot can only seat 1v1 fairly, and claiming 3 would spawn two B players on one spot.
//
// MORE SLOTS THAN PLAYERS is the point of the feature: 6 slots in a 2v2 means each match draws a
// random 2 of them, so the same map plays differently every time. planSpawns does that draw.
import { sizeOf } from './field-sizes.js';

// Per team. A pitch seats at most 5 per side (sHuge.maxTeam), so 6 leaves room for a map that
// offers spare slots to randomize over without letting a corrupt save allocate unbounded markers.
export const MAX_SPAWNS_PER_TEAM = 6;

export const TEAMS = ['A', 'B'];

// The team a slot placed at `x` most likely belongs to: A defends the left goal, B the right.
// Used ONLY at placement/mirror time — never to re-derive a stored team (see the header).
export function teamForX(x, size) {
  return x < size.W / 2 ? 'A' : 'B';
}

const finite = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, hi) => Math.min(hi, Math.max(0, v));

// Sanitize an authored spawn list against a size: drop malformed entries, clamp inside the pitch,
// force a valid team, and cap the count PER TEAM (not overall — a 6+6 map is legal, a 12+0 one
// isn't a map, it's a way to make the other side spawn on the formula).
export function normSpawns(list, size) {
  const S = sizeOf(size && size.id ? size.id : size);
  const out = [];
  const used = { A: 0, B: 0 };
  for (const s of (Array.isArray(list) ? list : [])) {
    if (!s || typeof s !== 'object' || !finite(s.x) || !finite(s.y)) continue;
    const team = s.team === 'B' ? 'B' : 'A';
    if (used[team] >= MAX_SPAWNS_PER_TEAM) continue;
    used[team]++;
    out.push({ x: clamp(s.x, S.W), y: clamp(s.y, S.H), team });
  }
  return out;
}

// Sanitize the authored ball spot. Returns null when absent/malformed => the sim keeps its own
// centre-spot + attach-to-a-team kickoff.
export function normBall(ball, size) {
  const S = sizeOf(size && size.id ? size.id : size);
  if (!ball || typeof ball !== 'object' || !finite(ball.x) || !finite(ball.y)) return null;
  return { x: clamp(ball.x, S.W), y: clamp(ball.y, S.H) };
}

export function spawnCounts(spawns) {
  const c = { A: 0, B: 0 };
  for (const s of (Array.isArray(spawns) ? spawns : [])) if (s && (s.team === 'A' || s.team === 'B')) c[s.team]++;
  return c;
}

// Players per side this layout can seat. 0 => the layout declares nothing and the formula runs.
export function spawnCapacity(spawns) {
  const c = spawnCounts(spawns);
  return Math.min(c.A, c.B);
}

// Draw the slots this match will actually use.
//
// Returns { A: [pt|null × teamSize], B: [...] } indexed BY SLOT, so the caller does
// `plan[team][slot] || formula(...)`. `null` means "this slot has no authored spot" — a map that
// seats fewer players than the format needs still works, it just formation-fills the remainder
// rather than refusing to launch or stacking two players on one marker.
//
// `rnd` is injectable so a seeded harness (and the sim's own state.rng) gets a reproducible draw.
export function planSpawns(spawns, teamSize, rnd = Math.random) {
  const n = Math.max(1, teamSize | 0);
  const plan = { A: [], B: [] };
  for (const team of TEAMS) {
    const pool = (Array.isArray(spawns) ? spawns : []).filter((s) => s && s.team === team).map((s) => ({ x: s.x, y: s.y }));
    // Fisher-Yates on a copy: every slot is equally likely to get any marker, and no marker is
    // handed to two slots (the bug a naive `pool[rnd()*len|0]` per slot would ship).
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1)) % (i + 1);
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    for (let i = 0; i < n; i++) plan[team].push(pool[i] || null);
  }
  return plan;
}
