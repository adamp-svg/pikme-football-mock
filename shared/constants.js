// Shared game constants — imported by BOTH the server (authoritative sim)
// and the browser client (prediction + rendering). Single source of truth.

// Arena proportions match a Brawl Stars map (~39x21 tiles): 2000x1100 px is
// ~38x21 player-diameters, aspect 1.82:1. Camera follows the player in both axes.
export const FIELD = { W: 2000, H: 1100 };

// Goal net: sits `depth` IN from each end wall (moved to the front). `width` is
// the mouth height. The ball scores when it crosses the goal line into the net.
export const GOAL = { width: 300, depth: 70 };
export const POST_R = 9; // goal-post collision radius — the ball bounces off the posts
// Penalty area in front of each goal: `width` is its vertical extent, `depth` how
// far it reaches into the pitch from the goal line.
export const PENALTY = { width: 620, depth: 360 };
// A player attacking inside the enemy penalty area takes far less knockback.
export const PENALTY_KNOCKBACK_MUL = 0.3;

// 60Hz network rate. (60Hz previously overloaded the mobile WebView because each
// snapshot was ~1.4KB JSON to parse; the compact BINARY wire — see shared/wire.js —
// removes that parse cost, making 60Hz affordable again.) Physics are per-SECOND,
// converted with DT, so feel is identical at any TICK_RATE.
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const SNAPSHOT_RATE = 60; // server -> client state broadcasts per second

export const BALL_RADIUS = 16;
// "fraction of speed kept per second" -> per-tick factor (frame-independent).
export const BALL_FRICTION = Math.pow(0.1134, DT); // ~"quick then slows down"
export const BALL_MIN_SPEED = 18; // below this the ball stops
export const WALL_RESTITUTION = 0.72;

export const RELEASE_PICKUP_CD = 0.35; // seconds a just-released ball can't be re-grabbed

// Charged shot: hold the aim to build power. Tap = weak/slow, ≥ CHARGE_TIME = full.
// A fully-charged bullet also ignores the point-blank rule and pushes even up close.
// A player holding SUPER (overcharge ready) charges TWICE as fast (SUPER_CHARGE_RATE)
// — so their full wind-up is back to the ~1s it was before we doubled the base time.
export const SHOOT_CHARGE_TIME = 2.0; // seconds of hold to reach full power (doubled; super halves it back to ~1s)
export const CHARGE_MIN_MUL = 1 / 4;  // tap power as a fraction of full — used by BULLETS (a quick shot); the ball carrier's tap uses BALL_TAP_SPEED
export const SUPER_CHARGE_RATE = 2;   // super (p.power) fills the charge this much faster (halves the wind-up)
// A carrier's SINGLE QUICK PRESS (charge < QUICK_CHARGE) is a light DRIBBLE TOUCH, not a shot:
// the ball rolls out ~2 ball-lengths (~64px) — fast at first, then friction slows it to a stop.
// Tuned against BALL_FRICTION/BALL_MIN_SPEED (roll ≈ 0.468*(v-18) px); 155 → ~64px.
export const BALL_TAP_SPEED = 155;
export function chargeMul(frac) {
  const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  return CHARGE_MIN_MUL + (1 - CHARGE_MIN_MUL) * f;
}

// Bullet knockback ramps with how far the bullet has travelled:
//   < MIN distance  -> no push (point-blank does nothing)
//   >= FULL distance -> full push
export const BULLET_MIN_DIST = 50;
export const BULLET_FULL_DIST = 300;

export const MATCH_DURATION = 120; // seconds — match ends and returns to lobby
export const KICKOFF_FREEZE = 0.7; // brief reset pause at match start
export const GOAL_RESET = 5;       // post-goal countdown before play resumes
export const GOAL_FREEZE_HOLD = 2; // of GOAL_RESET, hold in the scoring positions this long before snapping to kickoff
export const ENDED_HOLD = 6; // seconds the final score shows before returning to lobby
export const INTRO_PROMO = 4.6; // pre-kickoff promo hold: server freezes stepping so the clock waits while the client plays the card-meteor intro

// One player type. `speed`/`radius` are live-tunable via settings multipliers.
//   Holding the ball: it sticks to you; SHOOT releases/passes it.
//   Not holding:      SHOOT fires a bullet. SPECIAL always plants a Bomb.
export const CHARACTERS = {
  player: {
    key: 'player', name: 'Player', speed: 158, radius: 21, emoji: '',
    shootCooldown: 0.2, special: 'bomb', specialCooldown: 2.4,
  },
};
export const DEFAULT_CHAR = 'player';

// Movement is STRICT — velocity snaps to the target each tick (no gliding).
export const MOVE_ACCEL = 1;

// Ammo / reload (Brawl-Stars style). You start with a full mag and can fire it
// fast. While not empty, ammo trickles back 1 round per AMMO_REGEN seconds.
// Emptying the mag triggers a full EMPTY_RELOAD lockout, then refills all.
export const MAG_SIZE = 3;
export const AMMO_REGEN = 1.0;   // seconds to regenerate one round (when not empty)
export const EMPTY_RELOAD = 1.2; // seconds to refill the whole mag after emptying it

// Bullet fired by the right-stick shoot (both characters).
export const PROJECTILE = {
  speed: 336,      // px/s (~30% slower)
  ttl: 1.3,        // seconds before it fizzles (longer, since it flies slower)
  radius: 8,
  knockback: 200,  // impulse on an enemy hit ≈ one sprite-length of pushback
  ballPush: 476,   // impulse added to the ball it hits
};

// Tank bomb.
export const BOMB = {
  fuse: 1.725,     // seconds from plant to blast (was 1.15; +50% per request — more time to react/combo)
  radius: 168,     // blast reaches this far
  power: 820,      // max impulse at the very center (falls off to 0 at edge)
  ballPush: 0.4,   // multiplier for how hard the blast shoves a loose ball
  blastLife: 0.45, // seconds the visual blast ring lives
};

// Knockback velocity decays toward zero (players can still move). Per-second
// retention -> per-tick, so it feels the same at any TICK_RATE.
export const KNOCKBACK_DECAY = Math.pow(0.0108, DT);
export const KNOCKBACK_MIN = 4;
// A bomb launch decays MUCH gentler than a normal hit (~0.3s half-life vs ~0.15s)
// so the flight reads as a smooth arc — fast off the blast, easing down — instead
// of shooting out and stopping dead. Applied while p.launchGlide > 0.
export const BOMB_LAUNCH_DECAY = Math.pow(0.1, DT);
export const BOMB_LAUNCH_GLIDE = 0.9; // seconds a launched player keeps the gentle decay

// Live-tunable settings (adjustable from the in-game pause menu). These override
// the base numbers above at runtime. speedMul/sizeMul are multipliers on each
// character's base speed/radius; the rest are absolute.
export function defaultSettings() {
  return {
    speedMul: 0.9,         // a touch quicker than BS "Normal" for players without the ball
    sizeMul: 1.25,
    carrySpeedMul: 0.9,    // speed multiplier while carrying the ball
    ballSizeMul: 2,
    shotPower: 1400,       // full kick ≈ 647px (~65% of half-court) — was 1850 (over-long); scales with charge
    bulletSpeed: 720,      // full-charge bullet ~5.7x move speed (Colt is 5.5x)
    bulletKnockback: 1500, // full-power bullet knockback (quick shot = 0 push + slow)
    bombPower: 2000,       // base bomb launch — kept modest on purpose; a wall behind and/or STACKING bombs amplify it (see explode)
  };
}

// Charge tiers for a bullet hitting an enemy:
//   < QUICK_CHARGE  -> quick shot: no knockback, brief slow (SLOW_MUL) instead
//   >= FULL_CHARGE  -> full power: full knockback + can knock the ball loose
//   in between      -> medium: knockback (scaled), cannot detach the ball
export const QUICK_CHARGE = 0.25;
export const FULL_CHARGE = 0.70; // aim-shot charge at/above which a carrier is stripped (0.85→0.80→0.70: reachable in ~1.4s / 0.7s super)
export const DETACH_SIDE = 170; // random sideways ball speed when knocked off a carrier
export const CARRIER_KNOCKBACK_MUL = 1.7; // full-power hit shoves a ball-carrier this much harder
export const SLOW_TIME = 1.5;   // (legacy) seconds a flat quick-shot slow lasted — replaced by stacks below
export const SLOW_MUL = 0.9;    // (legacy) flat slow multiplier — replaced by stacks below
// Cumulative quick-shot slow: each no-aim (quick) hit adds a stack; stacks decay one per second.
// Speed × (1 - SLOW_PER_STACK)^stacks. Caps the debuff so it can't perma-lock a target.
export const SLOW_PER_STACK = 0.12;   // −12% speed per stack
export const SLOW_STACK_MAX = 3;      // cap 3 stacks (≈ −33%)
export const SLOW_STACK_DECAY = 0.6;  // seconds to shed one stack. The shed clock runs CONTINUOUSLY (a
// new hit does NOT refresh it — see addSlowStack) so the debuff lapses once fire drops below ~1.7 hits/s.
// Aimed-shot pushback curve: kb = bulletKnockback × (PUSH_MIN_MUL + (1-PUSH_MIN_MUL)·charge^PUSH_EASE).
// The floor guarantees even a light aimed shot visibly shoves (~1.5 ball-lengths); ease-in makes a
// full hold land harder. Quick (no-aim) shots ignore this — they never push (slow only).
export const PUSH_MIN_MUL = 0.20;
export const PUSH_EASE = 1.2;

// A fast free ball shoves the opponent it runs into (power shots plow through).
export const BALL_BUMP_SPEED = 300; // ball speed above which it bumps an opponent
export const BALL_BUMP_SCALE = 0.5; // knockback = ball speed * this (a bit of a push)
// Two power tiers layered on the charge. FULL (>= FULL_CHARGE, hold-based, anyone) strips a
// carrier; a kicked ball hitting an enemy is MONOTONIC — a weak kick REBOUNDS, a FULL kick
// DRIVES THROUGH, an OVERCHARGE kick breaks through HARDEST (a keeper in their own box
// catches everything except an overcharge kick). OVERCHARGE is earned by forceful hits.
export const OVERCHARGE_TTL = 4;     // seconds the overcharge (once READY) lasts if unused
export const SUPER_USES = 3;         // small super-actions (super-quick strip, body strip) per READY super
// before it's spent; an overcharge bullet/kick spends the whole thing at once. (3 = the # of quick hits that earned it.)
// Overcharge is a CONSUMABLE meter (0..1) earned ONLY by hitting enemies (never by merely
// firing): a FULL-power hit fills it immediately, a QUICK hit fills 1/3 (THREE quick hits =
// one super). Spent on ONE overcharge shot/kick. See earnPower() in sim.js.
export const OVERCHARGE_FULL_GAIN = 1.0;         // a full-power ENEMY HIT / strip / bomb-catch fills the meter now
export const OVERCHARGE_PARTIAL_GAIN = 1 / 3;    // a QUICK enemy hit / bump — THREE of these fill it
export const OVERCHARGE_MUL = 2.0;   // overcharge KICK shoves the enemy this much harder (vs a full kick)
export const FULL_BUMP_MUL = 1.3;    // a FULL kick shoves a little harder than a quick/medium kick
export const OVERCHARGE_BULLET_MUL = 1.4; // an overcharge BULLET pushes/strips harder than full (was 1.6 — trims the cross-court one-shot swing)
export const CARRIER_STRIP_KB_MAX = 3000;  // cap the knockback a stripped carrier takes (~688px) so an overcharge strip can't fling them ~¾ of the pitch
// While a player is in SUPER (p.power ready), EVERY shot they take — quick tap, full, kick or
// bullet — flies this much harder/faster. A quick-in-super then feels ~like today's full shot,
// and the big overcharge kick (OVERCHARGE_MUL) stays the ceiling on top of this.
export const SUPER_SHOT_MUL = 1.5;   // super mode boosts a BULLET's charge by this much
export const SUPER_KICK_MUL = 1.25;  // super boosts a carrier KICK's speed by this (lower than the bullet mult so a
// super full kick ≈ 811px is a reach bonus, not the old 1290px cross-pitch cannon). Kept separate so tuning the
// kick never weakens super bullets (they still use SUPER_SHOT_MUL).
// A QUICK shot fired while in super still isn't a full charged shot — but instead of the usual
// "slow only, no push", it gives the enemy a small, VISIBLE shove (~1.5 ball-lengths).
// SUPER_QUICK_KB is the bullet's knockback velocity; SUPER_QUICK_KICK_SPEED is the ball speed a
// quick KICK gets in super so it clears BALL_BUMP_SPEED and shoves a defender the same amount.
export const SUPER_QUICK_KB = 220;
export const SUPER_QUICK_KICK_SPEED = 440; // > BALL_BUMP_SPEED (300); bump = 440*BALL_BUMP_SCALE = 220 kv, matching the bullet
// A SUPER quick shot can't FULL-strip a carrier, but it JOSTLES the ball loose: it detaches
// and rolls ~half a ball length (BALL_RADIUS ≈ 16px) in the shot direction. Tuned to the
// friction model (roll ≈ 0.468*(v-18) px) so 52 → ~16px = half a ball length.
export const SUPER_QUICK_BALL_POP = 52;
// SUPER body strength: a player in super is physically stronger on contact.
// (1) SUPER_BODY_PUSH = the share of a body overlap the NON-super player absorbs when only one
//     side is super (>0.5 → the super player holds their ground and shoves the other more).
// (2) On body contact with an ENEMY BALL-CARRIER, a super player STRIPS the ball: the carrier is
//     knocked back (SUPER_BODY_STRIP_KB) and the ball pops loose (SUPER_BODY_BALL_POP).
export const SUPER_BODY_PUSH = 0.65;        // non-super player takes 65% of the separation (super only 35%)
export const SUPER_BODY_STRIP_KB = 520;     // shove given to an enemy carrier body-checked by a super player
export const SUPER_BODY_BALL_POP = 300;     // speed the stripped ball pops loose (away from the super player)
export const BALL_WALL_POP_SPEED = 260; // carried ball popped loose when the holder walks it into a wall
// MONOTONIC ball penetration when a kicked ball hits an enemy — harder kick = more roll-through:
//   weak/medium = BLOCKED, rebounds off the defender (keeps this fraction, reversed)
//   FULL        = DRIVES THROUGH with good pace
//   OVERCHARGE  = breaks through HARDEST
export const KICK_BLOCK_REBOUND = 0.40; // weak kick bounces back off a defender (fraction, reversed)
export const FULL_DRIVE_ROLL = 0.50;    // full kick keeps this fraction going forward through the defender
export const OVERCHARGE_ROLL = 0.75;    // overcharge kick keeps the most (breakthrough) — used vs a keeper only
export const OVER_FIELD_ROLL = 0.10;    // overcharge kick vs a FIELD defender: ball only rolls a LITTLE forward and stays in front (not a breakthrough)
export const KEEPER_BREAK_ROLL = 0.45;  // an overcharge kick still gets through a keeper, but reduced
// Bomb mechanics: a planter standing this close to their own bomb gets launched
// (full-shot strength) in their AIM direction ("rocket jump") instead of being
// flung away from center. Enemies in the blast fly away a bit harder.
export const BOMB_CENTER_R = 95;
export const BOMB_ENEMY_MUL = 1.25; // enemies of the bomber fly this much harder
export const BOMB_LAUNCH_TTL = 0.5; // seconds the launched planter can "tackle" an enemy
export const BOMB_TACKLE_KB = 1800; // shove given to an enemy a bomb-LAUNCHED planter tackles
// Any player flung fast (by a blast or knockback) body-checks an enemy it flies into.
export const FLY_HIT_SPEED = 460;   // knockback speed above which a flying body collides with enemies
export const FLY_HIT_SCALE = 0.55;  // enemy knockback = flyer speed * this (a plain fling; a bomb tackle uses BOMB_TACKLE_KB)
// Rocket-jump scaling: on-centre you fly FURTHER; reduced if you're carrying the ball.
export const BOMB_CENTER_LAUNCH_MUL = 0.80; // on-centre self-launch (kept modest — it was flinging half the pitch)
export const BOMB_LAUNCH_MAX = 5200;        // hard cap on the launch — raised so the ULTIMATE combo (2 stacked bombs + steel wall behind + on top) can fling a player across the pitch; single bombs stay well under it
export const BOMB_CARRY_LAUNCH_MUL = 0.6;   // ...but reduced this much if the bomber owns the ball
// Wall cannon: a wall collinear BEHIND the bomb (player -> bomb -> wall) boosts the
// launch in that direction, SCALED BY PROXIMITY (closer wall = more). Any wall qualifies.
export const BOMB_WALL_CANNON_MUL = 2.0; // (legacy) MAX launch multiplier at point-blank; superseded by the split below
// R3: a wall behind the bomb boosts the push. Indestructible +20% at point-blank; a BUILT
// wall +15% at FULL HP, fading toward +0% as it loses HP. Both still scale by proximity.
export const BOMB_WALL_CANNON_STATIC = 1.55; // steel (indestructible) wall behind = a strong cannon at point-blank — the key ingredient of the cross-field combo
export const BOMB_WALL_CANNON_BUILT = 1.15;
export const BOMB_WALL_DIST = 150;       // wall must be within this of the bomb to back it
export const BOMB_WALL_COS = 0.82;       // collinearity: cos(~35°) cone opposite the launch dir
// Multi-bomb: bombs detonating close together COMBINE into one bigger blast — the launch
// (and blast radius) scales with how many stacked. Two players bombing the same spot = big.
export const BOMB_COMBINE_RADIUS = 210;  // bombs within this of the first-to-blow detonate together
export const BOMB_STACK_PER = 0.9;       // each EXTRA bomb adds this to the power multiplier (2 bombs = x1.9) — stacking is a real ingredient of the cross-field combo
export const BOMB_STACK_MAX = 2;         // at most this many bombs combine into one blast
export const BOMB_STACK_RADIUS = 0.30;   // each extra bomb grows the blast radius by this fraction
// Bomb can be LOBBED: a tap plants at your feet (rocket-jump preserved), a drag aims a
// short throw up to BOMB_LOB_RANGE px (offensive plant, no self-launch). See useSpecial.
export const BOMB_LOB_RANGE = 250;      // max distance a lobbed bomb can be placed from the planter

// --- Arena obstacles -------------------------------------------------------
// Ball restitution off any wall (static or built) — a touch bouncier than the
// field edges so passes ricochet nicely off cover.
export const WALL_BOUNCE = 0.62;
// Bullets/bombs that reach a built wall chip its HP; static stone is immune.
// Trampoline launch pad.
export const TRAMPOLINE = {
  power: 3200,      // launch impulse (kvx/kvy) — comparable to a bomb rocket-jump
  cooldown: 0.55,   // seconds before the same player can be launched again
  minMove: 45,      // px/s of movement to launch along velocity (else along aim)
};
// Stealth: an enemy in a bush is hidden UNLESS you are within BUSH_REVEAL_DIST,
// they fired within SHOT_REVEAL_TIME, or they are carrying the ball.
export const BUSH_REVEAL_DIST = 110;
export const SHOT_REVEAL_TIME = 0.45;
// Bot VISION: a bot only PERCEIVES an enemy player within roughly its on-screen view
// (~half the visible width) — no seeing/tracking a foe across the whole pitch. The ball
// itself is always known (shared objective); this gates enemy-PLAYER awareness only.
export const VISION_RANGE = 620;
// The ball-CARRIER is a tracked objective — a bot sees them at a longer range (and even
// in a bush), matching what the human client shows, so bots don't go blind mid-build-up.
// Off-ball enemies still use the shorter VISION_RANGE + bush stealth (ambushes still work).
export const BALL_VISION = 950;
// Player-built destructible wall (SPECIAL-style pull-to-build).
export const BUILT_WALL = {
  len: 176,         // long side of the placed segment
  thick: 32,        // short side (thickness)
  offset: 60,       // distance in front of the builder's centre to the wall centre
  hp: 3,            // hits to destroy: full-charge shot = 1, mid = 2, tap = 3; a bomb = instant
  ttl: 0,           // 0 = permanent until destroyed
};
export const BUILD_MAG = 2;       // wall charges a player can hold
export const BUILD_RELOAD = 15;   // seconds to regenerate ONE wall charge (trickle) — avg 1 per 15s, or 2 in 30s
export const BUILD_COOLDOWN = 0.4;// min seconds between placements
export const MAX_BUILT_WALLS = 8; // global safety cap (oldest removed past this)
// Wall build is now a HOLD-TO-CONFIRM windup (mirrors the shot charge): you hold the
// build control for BUILD_WINDUP seconds while a ghost previews, then release to place.
// Releasing early — or aiming on yourself — cancels (no charge spent). Moving while
// winding up is slowed. A knockback/full-power hit above BUILD_INTERRUPT_KV cancels it.
export const BUILD_WINDUP = 0.5;        // seconds of hold to commit a wall
export const BUILD_WINDUP_SLOW = 0.5;   // move-speed multiplier while winding up
export const BUILD_INTERRUPT_KV = 300;  // incoming knockback speed that cancels a windup
// Walls built INSIDE a bush or penalty area are allowed but FRAGILE: hp 1 so any bullet
// (even a quick shot) breaks them, and a fast ball (power kick) smashes straight through.
export const FRAGILE_HP = 1;
// Field-builder DRY WALL: a pre-placed destructible wall (weaker than a player-built wall).
// Seeded into builtWalls each kickoff so it respawns per point and reuses all wall mechanics.
export const DRY_WALL_HP = 2;
export const FRAGILE_PASS_SPEED = 900; // ball faster than this passes through (+ destroys) a fragile wall

// --- Cover: a wall shields whoever stands behind it from blasts & shots ----------
// Bombs: a STATIC (indestructible) wall between the blast and a player blocks the push
// entirely; a BUILT wall softens it by its remaining HP. BLAST_WALL_PASS_MIN is the
// fraction of knockback that leaks through a FULL-HP built wall (strong wall -> minor
// push); a weaker wall passes more, ramping up to ~1.0 as its HP -> 0.
export const BLAST_WALL_PASS_MIN = 0.25; // R2: a FULL-HP built wall lets 25% of the blast through; leak ramps to 100% as HP -> 0
// Shots: a built wall in the bullet's path absorbs ~one shot TIER per remaining HP as it
// passes through (super -> full -> half -> blocked as HP climbs from 0 to full). Static
// stone always blocks a shot outright. Tiers: 0 quick, 1 half/medium, 2 full, 3 super.
export const COVER_PAD = 28; // body-radius forgiveness on the LOS test (blast + shot): a player clearly behind a wall is shielded even if the centre-to-centre ray grazes the wall's edge (was 8 → residual push when tucked behind a 120px wall)

export const TEAM = {
  A: { key: 'A', name: 'Blue', color: '#3b82f6', attacksRight: true },
  B: { key: 'B', name: 'Red', color: '#ef4444', attacksRight: false },
};

export const MAX_PLAYERS = 4; // 2 per team

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
