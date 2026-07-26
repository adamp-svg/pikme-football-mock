// Authored START POSITIONS for a builder field, and THE formation formula both the match and the
// builder read.
//
// WHY THIS FILE EXISTS
// Until now every kickoff position came from one formula living privately in sim.js. A field author
// could sculpt the whole pitch but not say WHERE the players stand when the whistle blows — and,
// worse, the builder had no way to DRAW the formula, so a field with no authored slots showed an
// empty pitch while the match quietly used invisible positions. So the formula moved here
// (`formationSlot`): the match and the builder now compute start spots from the same code, and
// authored slots are an override that travels inside the saved field and is sanitized on the server
// like every other authored coordinate.
//
// THE MODEL
//   field.spawns = [{ x, y, team: 'A'|'B' }]   — start slots. Team is STORED, not derived from the
//                                                half: placement guesses it from the half (A defends
//                                                left), but an author may drag a slot across the
//                                                halfway line on purpose (a high press) and that
//                                                choice must survive a save.
//
// THE BALL IS NOT IN THE MODEL. Per the user's rule (2026-07-26) it always starts at the CENTRE
// spot, and after a goal it starts attached to a player of the team that CONCEDED — one rule for
// every field and format, decided by attachBall() in sim.js. `normBall` below is kept only to
// sanitize a `field.ball` point from a pre-rule save; nothing in the sim consults its result.
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

// THE DEFAULT FORMATION — the single source of truth for "where does a player start?".
//
// This used to live as a private `spawnPos` inside sim.js, which meant the arena builder could not
// show it: a field with no authored slots displayed an EMPTY pitch while the match quietly used the
// hidden formula. An author could not see, let alone adjust, where players actually stand (user,
// 2026-07-26: "put the players position, like the one in the arena builder, in the correct place").
// It lives here now so the builder seeds real, draggable markers from the same maths the sim uses —
// what you see is what you get — and so the two can never drift apart.
//
// Size-aware: the fractions are relative, so a bigger stadium spreads the same shape.
//   fy  1 player  -> centre lane. 2 -> .36/.64 (the long-standing 2v2 kickoff, unchanged).
//       3+        -> evenly across .18….82
//   fx  0.15 of the pitch from your OWN goal, and the CENTRE lane starts 0.05 further upfield
//       because it contests the kickoff. Flat for 1v1 and 2v2, so neither changes.
export function formationSlot(team, slot, n, size) {
  const S = sizeOf(size && size.id ? size.id : size);
  const k = Math.max(1, n | 0);
  const i = Math.min(Math.max(slot | 0, 0), k - 1);
  let fy;
  if (k === 1) fy = 0.5;
  else if (k === 2) fy = i === 0 ? 0.36 : 0.64;
  else fy = 0.18 + (0.64 * i) / (k - 1);
  const centred = k > 2 ? 1 - Math.abs((2 * i) / (k - 1) - 1) : 0;
  const fx = 0.15 + 0.05 * centred;
  const x = team === 'A' ? S.W * fx : S.W * (1 - fx);
  return { x, y: S.H * fy };
}

/** The whole default formation for a team size, as authorable {x,y,team} slots. */
export function defaultSpawns(n, size) {
  const k = Math.max(1, n | 0);
  const out = [];
  for (const team of TEAMS) for (let i = 0; i < k; i++) out.push({ ...formationSlot(team, i, k, size), team });
  return out;
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
