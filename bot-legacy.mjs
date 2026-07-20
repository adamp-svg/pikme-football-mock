// Frozen copy of the PREVIOUS bot AI (server.js updateBots @ commit 636fe93),
// ported to a pure `legacyInputs(state, mem)` so the bot-vs-bot eval harness can
// A/B it against the new shared/bot-ai.js. Not used by the game server.
import { FIELD, GOAL } from './shared/constants.js';
import { ARENA } from './shared/arena.js';

const BOT_RADIUS = 30;
const SHOOT_RANGE = 400, GOAL_SHOOT_RANGE = 760, BOMB_STEAL_RANGE = 760;

function avoidWalls(x, y, mx, my) {
  const ax = x + mx * 90, ay = y + my * 90;
  for (const w of ARENA.walls) {
    const nx = Math.max(w.x, Math.min(ax, w.x + w.w));
    const ny = Math.max(w.y, Math.min(ay, w.y + w.h));
    const dx = ax - nx, dy = ay - ny, d = Math.hypot(dx, dy);
    if (d < BOT_RADIUS + 44) {
      if (d > 0.01) { mx += (dx / d) * 1.5; my += (dy / d) * 1.5; }
      else { const ox = mx, oy = my; mx = ox - oy * 1.5; my = oy + ox * 1.5; }
    }
  }
  const l = Math.hypot(mx, my) || 1;
  return [mx / l, my / l];
}
function nearestBush(x, y) {
  let best = null, bd = 1e9;
  for (const g of ARENA.bushes) {
    const cx = g.x + g.w / 2, cy = g.y + g.h / 2, d = Math.hypot(cx - x, cy - y);
    if (d < bd) { bd = d; best = { x: cx, y: cy }; }
  }
  return best;
}
const boxHas = (w, x, y) => x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h;
function laneClear(x0, y0, x1, y1, built) {
  for (let i = 1; i <= 8; i++) {
    const x = x0 + (x1 - x0) * i / 8, y = y0 + (y1 - y0) * i / 8;
    for (const w of ARENA.walls) if (boxHas(w, x, y)) return false;
    if (built) for (const w of built) if (boxHas(w, x, y)) return false;
  }
  return true;
}
function leadAim(px, py, t, speed) {
  const lt = Math.min(0.5, Math.hypot(t.x - px, t.y - py) / Math.max(1, speed));
  const dx = (t.x + (t.vx || 0) * lt) - px, dy = (t.y + (t.vy || 0) * lt) - py, l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

export function legacyInputs(state, mem) {
  const out = {};
  const b = state.ball;
  const carrier = b.owner ? state.players[b.owner] : null;
  const players = Object.values(state.players);
  const bulletSpeed = state.settings.bulletSpeed || 720;

  for (const p of players) {
    if (!p.isBot) continue;
    const oppGoalX = p.team === 'A' ? FIELD.W : 0;
    const ownGoalX = p.team === 'A' ? 0 : FIELD.W;
    const goalY = FIELD.H / 2;
    const mate = players.find((q) => q.team === p.team && q.id !== p.id);
    const enemies = players.filter((q) => q.team !== p.team);
    const focus = carrier || b;
    const distFocus = Math.hypot(focus.x - p.x, focus.y - p.y);
    const mateDistFocus = mate ? Math.hypot(focus.x - mate.x, focus.y - mate.y) : 1e9;
    const isPrimary = distFocus <= mateDistFocus;
    const canShoot = p.ammo > 0 && (p.reloadLock || 0) <= 0;
    const bombReady = (p.specialCd || 0) <= 0;
    const buildReady = p.buildAmmo >= 1 && (p.buildCd || 0) <= 0;

    let moveX = 0, moveY = 0, aimX = p.aimX, aimY = p.aimY, shoot = false, special = false, build = false, charge = 0;

    if (b.owner === p.id) {
      const distGoal = Math.hypot(oppGoalX - p.x, goalY - p.y);
      let blocker = null, bDist = 1e9;
      for (const e of enemies) { const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < bDist) { bDist = d; blocker = e; } }
      const laneToGoal = laneClear(p.x, p.y, oppGoalX, goalY, state.builtWalls);
      const linedUp = Math.abs(p.y - goalY) < GOAL.width / 2 + 200;
      if (distGoal < GOAL_SHOOT_RANGE && linedUp && laneToGoal) {
        aimX = oppGoalX - p.x; aimY = goalY - p.y; shoot = true; charge = 1;
      } else if (mate && bDist < 240) {
        const mateBetter = Math.hypot(oppGoalX - mate.x, goalY - mate.y) < distGoal - 40;
        if (mateBetter && laneClear(p.x, p.y, mate.x, mate.y, state.builtWalls)) {
          aimX = mate.x - p.x; aimY = mate.y - p.y; shoot = true; charge = 0.55;
        }
      }
      if (!shoot && bombReady && bDist < 150 && distGoal < BOMB_STEAL_RANGE && laneToGoal) {
        aimX = oppGoalX - p.x; aimY = goalY - p.y; special = true;
      }
      moveX = oppGoalX - p.x; moveY = goalY - p.y;
      if (blocker && bDist < 220) { moveX += (p.x - blocker.x) * 1.1; moveY += (p.y - blocker.y) * 1.1; }
      if (!shoot && !special) { aimX = oppGoalX - p.x; aimY = goalY - p.y; }
    } else if (carrier && carrier.team === p.team) {
      moveX = (oppGoalX - (p.team === 'A' ? 260 : -260)) - p.x;
      moveY = (goalY + (p.slot === 0 ? -180 : 180)) - p.y;
      if (mate && Math.hypot(mate.x - p.x, mate.y - p.y) < 200) { moveX += (p.x - mate.x); moveY += (p.y - mate.y); }
      aimX = oppGoalX - p.x; aimY = goalY - p.y;
    } else if (carrier) {
      const c = carrier, distC = Math.hypot(c.x - p.x, c.y - p.y);
      const laneToC = laneClear(p.x, p.y, c.x, c.y, state.builtWalls);
      if (isPrimary || distC < 240) {
        moveX = c.x - p.x; moveY = c.y - p.y;
        const [lax, lay] = leadAim(p.x, p.y, c, bulletSpeed); aimX = lax; aimY = lay;
        if (canShoot && laneToC && distC < SHOOT_RANGE) { shoot = true; charge = 1; }
        if (bombReady && distC > 60 && distC < BOMB_STEAL_RANGE && laneToC && Math.random() < 0.05) {
          aimX = c.x - p.x; aimY = c.y - p.y; special = true; shoot = false;
        }
        if (buildReady && Math.abs(c.x - ownGoalX) < FIELD.W * 0.5 &&
            Math.abs(p.x - ownGoalX) <= Math.abs(c.x - ownGoalX) + 90 && Math.random() < 0.02) {
          aimX = c.x - p.x; aimY = c.y - p.y; build = true; shoot = false; special = false;
        }
      } else {
        const coverX = (c.x + ownGoalX * 1.4) / 2.4, coverY = (c.y + goalY) / 2;
        const bush = nearestBush(coverX, coverY);
        moveX = (bush ? bush.x : coverX) - p.x; moveY = (bush ? bush.y : coverY) - p.y;
        aimX = c.x - p.x; aimY = c.y - p.y;
        if (canShoot && laneToC && distC < SHOOT_RANGE * 0.7) { shoot = true; charge = 1; }
      }
    } else {
      if (isPrimary) {
        const lt = Math.min(0.4, distFocus / 900);
        moveX = (b.x + b.vx * lt) - p.x; moveY = (b.y + b.vy * lt) - p.y;
        aimX = oppGoalX - p.x; aimY = goalY - p.y;
      } else {
        const holdX = (b.x + ownGoalX) / 2, holdY = (b.y + goalY) / 2;
        const bush = nearestBush(holdX, holdY);
        moveX = (bush ? bush.x : holdX) - p.x; moveY = (bush ? bush.y : holdY) - p.y;
        aimX = b.x - p.x; aimY = b.y - p.y;
      }
    }

    const mLen = Math.hypot(moveX, moveY) || 1;
    const [mvx, mvy] = avoidWalls(p.x, p.y, moveX / mLen, moveY / mLen);
    let aLen = Math.hypot(aimX, aimY) || 1, ax = aimX / aLen, ay = aimY / aLen;
    if (shoot || special) { const j = (Math.random() - 0.5) * 0.09, cs = Math.cos(j), sn = Math.sin(j), nx = ax * cs - ay * sn; ay = ax * sn + ay * cs; ax = nx; }
    mem[p.id] = (mem[p.id] || 0) + 1;
    out[p.id] = { seq: mem[p.id], moveX: mvx, moveY: mvy, aimX: ax, aimY: ay, shoot, special, build, charge };
  }
  return out;
}
