// Coalescing client input packets into ONE tick's input.
//
// The client sends at its own rate and edge-flushes on every action (shoot / bomb / build), so
// SEVERAL packets routinely land between two server ticks and have to merge into one input.
// Two kinds of field behave differently in that merge:
//
//   LEVEL signals (moveX/moveY, hold, buildHold) — the newest packet simply wins.
//   EDGES (fire, special, build) — latched STICKY so a press between ticks is never lost.
//
// The trap is that an edge is not just a flag: it carries a PAYLOAD (the aim vector for a shot,
// the lob vector for a bomb, the aim + push distance for a wall). On release the client zeroes
// the stick it was dragging, so the packet right after the edge carries a neutral payload — and
// if the newest packet were allowed to overwrite it, the action would fire with the wrong
// direction. So each edge LOCKS its own payload: the packet that carried the edge owns it until
// the tick consumes it. `fire` and `special` were fixed for this; `build` was missed, which is
// why a dragged wall sometimes appeared in the direction you were RUNNING at the minimum
// distance instead of where you aimed it.
//
// Consuming the edge (consumeEdges, after the sim step) must also clear the payload, or the next
// action inherits the previous one's — a plain tap-build would reuse the last drag's reach.

export function coalesceInput(prev, msg) {
  // Which packet owns each edge's payload: the one that carries the edge, or — when no edge of
  // that kind is pending — the newest packet (ordinary streaming aim).
  const takeBuild = !!msg.build || !prev.build;
  // fire keeps priority over build on the SHARED aim channel: a wall release must never steal a
  // pending shot's direction (the ball would fly where you put the wall).
  const takeAim = !!msg.fire || (!prev.fire && takeBuild);
  const takeLob = !!msg.special || !prev.special;
  return {
    seq: msg.seq,
    moveX: msg.moveX || 0,
    moveY: msg.moveY || 0,
    aimX: takeAim ? (msg.aimX || 0) : prev.aimX,
    aimY: takeAim ? (msg.aimY || 0) : prev.aimY,
    // hold = a level signal (charging now); fire = an EDGE (release), latched sticky until the
    // next tick consumes it so a fire between ticks isn't lost.
    hold: !!msg.hold,
    fire: prev.fire || !!msg.fire,
    aimed: prev.aimed || !!msg.aimed,
    special: prev.special || !!msg.special,
    build: prev.build || !!msg.build,
    buildHold: !!msg.buildHold,
    buildDist: takeBuild ? (msg.buildDist || 0) : (prev.buildDist || 0),
    sax: takeLob ? (msg.sax || 0) : prev.sax,
    say: takeLob ? (msg.say || 0) : prev.say,
  };
}

// Edges are one-shot: clear them (and their payloads) once the sim has stepped. Level signals
// (hold, buildHold, move) persist — they describe what the finger is still doing.
export function consumeEdges(inp) {
  inp.fire = false;
  inp.aimed = false;
  inp.special = false;
  inp.build = false;
  inp.buildDist = 0;
}
