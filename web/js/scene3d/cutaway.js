// Crowd and stadium cutaways at stoppages (docs/broadcast3d.md, "Cutaways at stoppages"), and the
// tight-shot stoppages of camera 2 they must not overlap. Pure functions of the match data, no
// Babylon, so node tests can check the plan: the same match always gives the same cutaways, and
// any frame (a seek, a video frame) shows the same shot.
//
// A stoppage is the dead ball between an event and the restart that follows it (throw-in, goal
// kick, corner, free kick, and the kick-off after a goal). The director cuts away once the ball is
// out (after a goal: once the celebration and the replay are over), for one shot of LEN s, and is
// back on camera 1 BEFORE s ahead of the restart, so the viewer sees the restart set up. Every
// stoppage with room for a shot gets one, unless the last cutaway ended under GAP s before; the
// kind of shot follows the restart (a corner gets the fans behind that goal) without repeating the
// previous one.

const HALF_L = 52.5, HALF_W = 34;
const LINE = 0.05;   // metres: a ball this close to a line is on it
export const RESTARTS = new Set(["throw_in", "goalkick", "corner_crossed", "corner_short", "freekick_short", "freekick_crossed", "shot_freekick", "shot_penalty"]);
export const STOP_EVENTS = new Set(["foul", "keeper_save"]);
export const CELEBRATION = [1, 6];    // seconds after the goal: camera 2 on the scorer (view3d.js starts the goal replay at its end)
export const REPLAY_LEN = 5.5;        // seconds of the goal replay (view3d.js REPLAY.len)
// prefers-reduced-motion: camera 1 holds the wide shot throughout: no punch-in, no rail slide, no cut
// to camera 2, no cutaway (camera.js), no goal replay (view3d.js)
export const REDUCE = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
// seconds: after the ball is out, back on camera 1 before the restart (a throw-in's taker picks
// the ball up 1.6 s before it, players.js THROW), shot lengths
export const CUTAWAY = {
  after: 1.5,
  before: { throw_in: 4, other: 3 },
  len: { fans: 4, end: 4.5, stadium: 5 },
  gap: 20,          // match seconds from the end of one cutaway to the next at least: two stoppages in a row both get one
};
// the shots each restart prefers, in order
const KINDS = {
  corner: ["end", "fans", "stadium"], goalkick: ["stadium", "end", "fans"],
  throw_in: ["fans", "stadium", "end"], freekick: ["fans", "end", "stadium"], kickoff: ["fans", "stadium", "end"],
};
const family = (t) => (t.startsWith("corner") ? "corner" : t === "goalkick" ? "goalkick" : t === "throw_in" ? "throw_in" : "freekick");

// A number in [0, 1) from a string and an integer: the same inputs, the same number.
export function hash01(s, n) {
  let h = 2166136261 ^ n;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// The scorer of each goal fact, as {ts, i} with i the entity index.
export function scorers(match) {
  return match.goals.map((g) => {
    const pid = g.player_id ?? match.events.find((e) => g.source_event_ids?.includes(e.event_id))?.player_id;
    return { ts: g.ts, i: match.meta.entities.indexOf(pid) };
  }).filter((g) => g.i > 0);
}

// Camera 2's tight shots, as [from, to, entity]: goals, then fouls and saves that stop play (from
// 1 s after until 0.5 s before the next event, only if that leaves at least 2 s).
export function tightStops(match, goals = scorers(match)) {
  const idx = (pid) => match.meta.entities.indexOf(pid);
  const stops = goals.map((g) => [g.ts + CELEBRATION[0], g.ts + CELEBRATION[1], g.i]);
  match.events.forEach((e, k) => {
    const next = match.events[k + 1]?.ts ?? match.duration;
    if (STOP_EVENTS.has(e.type_name) && idx(e.player_id) > 0 && next - 0.5 - (e.ts + 1) >= 2) stops.push([e.ts + 1, Math.min(e.ts + 6, next - 0.5), idx(e.player_id)]);
  });
  return stops;
}

// When the ball is dead after event p (the restart r follows): p itself for a foul or a save (the
// whistle), else the first tracking sample with the ball on the ground and on or over a line, or at
// rest. The simulator parks a ball that goes out on the line itself, so the bounds are inclusive.
// Contract metres, 0.1 s steps. Never dead before r: r.ts, which leaves no room for a cutaway.
function outAt(match, p, r) {
  if (STOP_EVENTS.has(p.type_name)) return p.ts;
  let last = null;
  for (let t = p.ts; t < r.ts; t += 0.1) {
    const b = match.at(0, t);
    if (!b) continue;
    const line = b[0] <= LINE || b[0] >= 2 * HALF_L - LINE || b[1] <= LINE || b[1] >= 2 * HALF_W - LINE;
    const still = last && Math.hypot(b[0] - last[0], b[1] - last[1]) < 0.05;
    if (b[2] < 0.5 && (line || still)) return t;
    last = b;
  }
  return r.ts;
}

// The cutaways of a match: [{from, to, kind, x, end, side, restart}] in match seconds, sorted.
// x: contract x of the restart, end: -1 / 1 the goal end nearer it, side: the far stand section
// (scene x) the fans shot looks at. busy: [from, to] windows no cutaway may touch (tight shots).
export function cutawayPlan(match, busy = tightStops(match)) {
  const id = match.meta.match_id ?? "", ev = match.events, goals = match.goals.map((g) => g.ts);
  const out = [];
  let last = -Infinity, prev = null;
  for (let k = 1; k < ev.length; k++) {
    const r = ev[k], p = ev[k - 1];
    if (p.period !== r.period) continue;
    // a goal's stoppage: the celebration (camera 2) and the replay first, then a cutaway before the kick-off
    const goal = goals.find((g) => g >= p.ts - 1 && g <= r.ts);
    if (!RESTARTS.has(r.type_name) && goal === undefined) continue;
    const fam = goal !== undefined ? "kickoff" : family(r.type_name);
    let a = goal !== undefined ? goal + CELEBRATION[1] + REPLAY_LEN : outAt(match, p, r) + CUTAWAY.after;
    const b = r.ts - (CUTAWAY.before[fam] ?? CUTAWAY.before.other);
    let tight = goal !== undefined;   // straight from the goal replay, as from camera 2
    for (const [s, e] of busy) if (e > a && s < b) { a = Math.max(a, e); tight = true; }   // after camera 2's shot, straight from it
    if (a - last < CUTAWAY.gap) continue;
    const prefs = KINDS[fam], start = Math.floor(hash01(id, (r.event_id ?? k) + 7919) * 2);   // the first or the second choice leads
    const order = [...prefs.slice(start), ...prefs.slice(0, start)];
    // not the stadium straight from camera 2: depth of field switched off at that cut by rebuilding
    // the post chain, whose first frames showed stale green where nothing is drawn, the stadium's
    // sky. post.js no longer rebuilds; the plan stays as it was.
    const kind = order.find((q) => q !== prev && b - a >= CUTAWAY.len[q] && !(tight && q === "stadium"));
    if (!kind) continue;
    const x = r.start_x ?? HALF_L, end = x < HALF_L ? -1 : 1;
    // the fans shot: a section of the far stand near the restart, kept off the aisles' edges
    const side = Math.min(Math.max((x - HALF_L) * 0.6 + (hash01(id, k) - 0.5) * 16, -40), 40);
    out.push({ from: a, to: a + CUTAWAY.len[kind], kind, x, end, side, restart: r.ts });
    last = a + CUTAWAY.len[kind]; prev = kind;
  }
  return out;
}

// The shot of cutaway c at ts: {pos, aim} in scene metres (x along, y up, z across, the pitch
// centre at 0), the frame `width` m across at the aim (or `hfov` radians), `focus` true for depth
// of field on the aim. Each shot moves a little over its length, as a handheld or a remote head.
export function cutawayShot(c, ts) {
  const u = Math.min(Math.max((ts - c.from) / (c.to - c.from), 0), 1);
  if (c.kind === "fans") {
    // the front rows of the far stand from the far touchline, 9 m away, a little from the side:
    // a dozen seated fans head and shoulders, scarves, the bowl rising behind; sliding along the row
    const x = c.side + (u - 0.5) * 1.6;
    return { pos: [x - 4.5, 2.3, HALF_W + 3], aim: [x, 3.3, HALF_W + 10.5], width: 7.5, focus: true };
  }
  if (c.kind === "end") {
    // the fans behind the goal: from the pitch, high enough to clear the players, the goal in the
    // foreground and the end stand filling the frame; a slow push in
    const e = c.end;
    return { pos: [e * (HALF_L - 9), 3.4, -13], aim: [e * (HALF_L + 15), 5.5, 1.5], width: 30 - 6 * u, focus: true };
  }
  // stadium: a beauty shot from high in a near corner, under the roof, across the whole bowl to
  // the far corner and its big screen; a slow pan
  const e = -c.end;   // the corner away from the restart, looking towards it
  return { pos: [e * (HALF_L + 10), 21, -(HALF_W + 10)], aim: [-e * (12 + 14 * u), 0, 8], hfov: 1.15, focus: false };
}
