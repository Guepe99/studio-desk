// Goalkeeper reactions for the 3D view: a dive, a catch or a tip for every shot that the keeper
// saves or that goes in, picked from where the drawn ball meets the keeper. A visual layer only.
// Rules and sources: docs/flow3d.md, "Keeper".
//
//   const reactions = planKeeper(match, (ts) => rig.ball(ts), { ballR, body });
//   keeperRoot(r, ts) -> { dx, dy, lift, roll, w, clipT } | null   root offset of reaction r at ts
//
// Pure functions of match time. Contract axes: x along, y across; a yaw is atan2(dx, dy). The
// keeper's right is u = (cos yaw, -sin yaw); a positive roll lays the body towards his left, so a
// dive to the right is a negative roll (the scene's holder.rotation.z, Babylon's left-handed axes).

export const SAVE_EVENTS = new Set(["keeper_save", "keeper_claim", "keeper_punch", "keeper_pick_up"]);
// The clips by reaction kind and side. Procedural poses stand in until real clips with these
// names exist in the player file; they are keyed on CLIP_KEYS (seconds) at the phase marks below.
export const CLIPS = { dive: ["GK_Dive_L", "GK_Dive_R"], low: ["GK_Low_L", "GK_Low_R"], catch: ["GK_Catch", "GK_Catch"], tip: ["GK_Tip", "GK_Tip"] };
export const CLIP_KEYS = [0, 0.5, 0.8, 1.15, 1.95];   // start, contact, landed, lying ends, up
// seconds from first movement to contact, and after contact: fall (or landing), on the ground, getting up
export const TIMING = {
  dive: { pre: 0.5, fall: 0.3, lie: 0.35, rise: 0.8 },
  low: { pre: 0.4, fall: 0.25, lie: 0.35, rise: 0.75 },
  catch: { pre: 0.35, fall: 0.3, lie: 0.2, rise: 0.4 },
  tip: { pre: 0.45, fall: 0.35, lie: 0.1, rise: 0.5 },
};
const REACT = 0.12;          // s after the shot before the keeper moves (none earlier: no anticipation)
const MIN_PRE = 0.15;        // s: a reflex save still shows this much movement before contact
const LATE = 0.25;           // s after the shot: a beaten keeper's first move
const MAX_SHIFT = 2.0;       // m the feet leave the tracked spot, at most
const LIE_LIFT = 0.18;       // m: holder height of a body lying on its side (shoulder half-width)
const DEG = Math.PI / 180;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (u) => { const t = clamp(u, 0, 1); return t * t * (3 - 2 * t); };

// The keeper of the side that did not shoot, on the pitch at ts: entity index or null.
function keeperOf(match, team, ts) {
  for (const p of match.meta.players) {
    if (p.position !== "GK" || p.team_id === team) continue;
    const i = match.index[p.player_id];
    if (i !== undefined && match.at(i, ts)) return i;
  }
  return null;
}

// body: { shoulder: m from the soles to the shoulders, arm: m from shoulder to hand }.
// real: the motion clips by name, { len, fps, root: [[left, up, forward], ...], contact: s,
// hand: [left, up, forward] } (keeper3d-rig.js measures contact and hand); a reaction whose clip
// is there plays it on its root curve (realRoot), the others the procedural poses (keeperRoot).
export function planKeeper(match, ball, { ballR = 0.11, body = { shoulder: 1.45, arm: 0.62 }, span = [0, match.duration], real = {} } = {}) {
  const ev = [...match.events].sort((a, b) => a.ts - b.ts);
  const goalEvents = new Set(match.goals.flatMap((g) => g.source_event_ids ?? []));   // the score fact comes when the ball is in, after the kick
  const out = [];
  for (let k = 0; k < ev.length; k++) {
    const e = ev[k];
    if (!/^shot/.test(e.type_name) || e.ts < span[0] - 3 || e.ts > span[1] + 1) continue;
    const next = ev.slice(k + 1).find((x) => x.period === e.period);
    const goal = e.result_name === "success" && goalEvents.has(e.event_id);
    const i = keeperOf(match, e.team_id, e.ts);
    if (i === null) continue;
    const kpid = match.meta.entities[i];
    let tc = null;
    if (!goal) {
      // saved: a keeper event, or the keeper on the ball next within 3 s where the shot ended
      if (!next || next.player_id !== kpid || next.ts - e.ts > 3 || next.type_name === "goalkick") continue;
      if (SAVE_EVENTS.has(next.type_name)) tc = next.ts;
      else {
        const K = match.at(i, e.ts);
        if (!K || Math.hypot(e.end_x - K[0], e.end_y - K[1]) > 3) continue;
        tc = closest(ball, e.ts, next.ts, [e.end_x, e.end_y]);
      }
    }
    // facing: towards where the shot came from
    const K0 = match.at(i, e.ts);
    const yaw = Math.atan2(e.start_x - K0[0], e.start_y - K0[1]);
    const u = [Math.cos(yaw), -Math.sin(yaw)], fw = [Math.sin(yaw), Math.cos(yaw)];
    if (goal) {
      // the moment the ball passes the keeper (its forward distance turns negative)
      tc = null;
      for (let t = e.ts; t < e.ts + 3; t += 0.01) {
        const b = ball(t), K = match.at(i, t);
        if (!b || !K) break;
        if ((b.x - K[0]) * fw[0] + (b.y - K[1]) * fw[1] <= 0) { tc = t; break; }
      }
      if (tc === null) continue;
    }
    const K = match.at(i, tc), b = ball(tc);
    if (!K || !b) continue;
    const d = (b.x - K[0]) * u[0] + (b.y - K[1]) * u[1];
    const f = (b.x - K[0]) * fw[0] + (b.y - K[1]) * fw[1];
    const h = b.h + ballR;
    const kind = goal ? (h < 0.6 ? "low" : "dive")
      : h > 2.0 ? "tip" : Math.abs(d) < 0.7 && h >= 0.45 ? "catch" : h < 0.6 && Math.abs(d) < 1.6 ? "low" : "dive";
    const T = TIMING[kind];
    let start = goal ? Math.max(e.ts + LATE, tc - T.pre) : Math.max(e.ts + REACT, tc - T.pre);
    start = Math.min(start, tc - MIN_PRE);
    // a beaten keeper reaches only the share of the dive his late start allows
    const reach = goal ? clamp((tc - start) / 1.0, 0.25, 0.6) : 1;
    const side = d >= 0 ? 1 : -1;   // +1: his right
    const target = { d: d * reach, h: goal ? Math.max(0.3, h * reach) : h, f: Math.max(0, f) };
    const r = { i, pid: kpid, shot: e.event_id, goal, kind, side, clip: CLIPS[kind][side > 0 ? 1 : 0], tc, start,
      end: tc + T.fall + T.lie + T.rise, yaw, u, fw, ball: [b.x, b.y, h], d, h, ...solve(kind, target, body) };
    const c = real[r.clip];
    if (c) fitClip(r, c, { earliest: goal ? e.ts + LATE : e.ts + REACT, want: [-target.d, target.h, f] });
    out.push(r);
  }
  // one at a time per keeper: a later reaction cuts the earlier short
  out.sort((a, b) => a.start - b.start);
  for (let k = 0; k + 1 < out.length; k++) {
    const n = out.slice(k + 1).find((r) => r.i === out[k].i);
    if (n) out[k].end = Math.min(out[k].end, n.start);
  }
  return out;
}

// A real clip on reaction r: time-warp the clip's run-up so its contact frame lands on r.tc, then
// play it at 1x until the body is down, hold, and blend back to the tracked spot. The root curve's
// sideways travel is scaled so the hands reach the ball sideways; height and depth get a small
// shift around contact. want: the ball from the keeper's spot, [left, up, forward] metres.
const RATE_MAX = 2.5;   // fastest run-up, times the clip's own (a reflex save)
const DOWN_S = 0.9;     // s of clip after contact before the hold
const RISE_S = 0.8;     // s to blend back up onto the tracking
function fitClip(r, c, { earliest, want }) {
  // a dive's contact frame follows the ball's height: on the way down from the hands' highest
  // point to their widest, the first frame the hands are no higher than the ball
  if (c.hands && (r.kind === "dive" || r.kind === "low")) {
    const H = c.hands, sg = Math.sign(c.root.at(-1)[0]) || 1;
    const wide = H.reduce((b, h, j) => (h[0] * sg > H[b][0] * sg ? j : b), 0);
    const k0 = Math.min(wide, Math.round(0.3 * c.fps));   // past the set position
    const top = H.slice(0, wide + 1).reduce((b, h, j) => (j >= k0 && h[1] > H[b][1] ? j : b), k0);
    let k = top;
    while (k < wide && H[k][1] > want[1]) k++;
    c = { ...c, contact: k / c.fps, hand: H[k] };
  }
  // never before the shot: when even the fastest run-up does not fit, the clip starts part way
  // in (c0) and the first frames blend in from the stance
  const start = Math.min(Math.max(earliest, r.tc - c.contact), r.tc - MIN_PRE);
  const rate = Math.min(RATE_MAX, c.contact / (r.tc - start)), c0 = c.contact - rate * (r.tc - start);
  const at = rootAt(c, c.contact);
  const lat = Math.abs(at[0]) > 0.3 ? clamp((want[0] - (c.hand[0] - at[0])) / at[0], 0.4, 1.5) : 1;
  const hold = Math.min(c.len, c.contact + DOWN_S);
  r.start = start;
  r.real = { rate, c0, lat, hold, tHold: r.tc + hold - c.contact, root: c.root, fps: c.fps, contact: c.contact,
    // what the scaled root leaves: sideways only for clips that barely travel (catch, tip)
    shift: Math.abs(at[0]) > 0.3 ? 0 : clamp(want[0] - c.hand[0], -0.8, 0.8),
    up: clamp(want[1] - c.hand[1], -0.4, 0.4), fwd: clamp(want[2] - c.hand[2], -0.3, 0.6) };
  r.end = r.real.tHold + RISE_S;
}

// Root of clip c at clip time t: [left, up, forward], linear between frames.
function rootAt(c, t) {
  const f = clamp(t * c.fps, 0, c.root.length - 1), k = Math.min(Math.floor(f), c.root.length - 2), a = f - k;
  return [0, 1, 2].map((j) => c.root[k][j] + (c.root[k + 1][j] - c.root[k][j]) * a);
}

// Root offset of reaction r with a real clip at ts, like keeperRoot (roll 0: the clip turns the body).
export function realRoot(r, ts) {
  if (ts < r.start || ts >= r.end) return null;
  const q = r.real;
  const clipT = ts < r.tc ? q.c0 + (ts - r.start) * q.rate : Math.min(q.hold, q.contact + ts - r.tc);
  // the shifts come in before contact and stay (so does the travel a late start skipped);
  // everything goes back during the rise
  const g = smooth((ts - r.start) / (r.tc - r.start)), back = 1 - smooth((ts - q.tHold) / RISE_S);
  const skip = rootAt(q, q.c0), [l, u, f] = rootAt(q, clipT).map((x, j) => x - skip[j] * (1 - g));
  const around = g * (1 - smooth((ts - r.tc - 0.2) / 0.4));   // height and depth only near contact
  const left = (l * q.lat + q.shift * g) * back, ahead = (f + q.fwd * around) * back;
  const w = Math.max(0, Math.min(1, (ts - r.start) / 0.1, back));
  return { dx: -r.u[0] * left + r.fw[0] * ahead, dy: -r.u[1] * left + r.fw[1] * ahead, lift: (u + q.up * around) * back, roll: 0, w, clipT };
}

// First time in [a, b] the drawn ball comes nearest to point p.
function closest(ball, a, b, p) {
  let best = a, dmin = Infinity;
  for (let t = a; t <= b; t += 0.02) {
    const q = ball(t);
    if (!q) continue;
    const dd = Math.hypot(q.x - p[0], q.y - p[1]);
    if (dd < dmin - 1e-3) { dmin = dd; best = t; }
  }
  return best;
}

// Body at contact: roll (rad, towards the ball), lift (m) and feet shift across (s) and forward
// (fwd), so the shoulders end up about 0.8 arm lengths short of the ball along the body; the arms
// then reach the rest of the way (keeper3d-rig.js aims them at the ball).
export function solve(kind, { d, h, f }, { shoulder, arm }) {
  const ad = Math.abs(d), D = shoulder + 0.8 * arm;
  let roll = 0, lift = 0, s = 0;
  if (kind === "catch") {
    s = clamp(ad, 0, 0.8);
    roll = Math.min(15 * DEG, Math.atan2(Math.max(0, ad - s), shoulder));
  } else if (kind === "tip") {
    lift = clamp(h - D + 0.1, 0.2, 0.55);
    s = clamp(ad * 0.5, 0, 1);
    roll = Math.atan2(ad - s, h - lift);
  } else {
    lift = kind === "low" ? LIE_LIFT : 0.3;
    roll = Math.acos(clamp((h - lift) / D, 0, 0.995));   // flat at most: a ball below the hip is reached by the arms
    s = clamp(ad - D * Math.sin(roll), -0.6, MAX_SHIFT);
  }
  const fwd = kind === "catch" || kind === "tip" ? 0 : clamp(f - 0.3, 0, 0.5);
  return { roll, lift, s, fwd };
}

// Root offset of reaction r at ts, or null outside it. dx, dy contract metres; lift metres;
// roll radians for holder.rotation.z; w the weight of the whole reaction; clipT the clip time.
export function keeperRoot(r, ts) {
  if (ts < r.start || ts >= r.end) return null;
  const T = TIMING[r.kind];
  const marks = [r.start, r.tc, r.tc + T.fall, r.tc + T.fall + T.lie, r.tc + T.fall + T.lie + T.rise];
  // clip time: piecewise linear between the phase marks
  let k = 0;
  while (k < 3 && ts > marks[k + 1]) k++;
  const a = (ts - marks[k]) / Math.max(1e-6, marks[k + 1] - marks[k]);
  const clipT = CLIP_KEYS[k] + (CLIP_KEYS[k + 1] - CLIP_KEYS[k]) * clamp(a, 0, 1);
  const lying = r.kind === "dive" || r.kind === "low";
  const rollLie = lying ? 90 * DEG : 0, liftLie = lying ? LIE_LIFT : 0;
  let g, roll, lift;   // g: share of the feet shift
  if (ts < r.tc) {
    const p = (ts - r.start) / (r.tc - r.start);
    g = smooth(p); roll = r.roll * smooth(p);
    lift = r.lift * Math.sin((Math.PI / 2) * clamp(p * 1.15 - 0.15, 0, 1));
  } else if (ts < marks[2]) {
    const p = smooth((ts - r.tc) / T.fall);
    g = 1; roll = r.roll + (rollLie - r.roll) * p; lift = r.lift + (liftLie - r.lift) * p;
  } else {
    const p = smooth((ts - marks[3]) / T.rise);
    g = 1 - p; roll = rollLie * (1 - p); lift = liftLie * (1 - p);
  }
  const w = Math.min(1, (ts - r.start) / 0.1, (r.end - ts) / 0.3);
  const across = r.s * g * r.side, ahead = r.fwd * g;
  return {
    dx: r.u[0] * across + r.fw[0] * ahead, dy: r.u[1] * across + r.fw[1] * ahead,
    lift, roll: -r.side * roll, w: Math.max(0, w), clipT,
  };
}
