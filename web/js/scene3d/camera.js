// Cameras, placed and lensed the way a football outside broadcast does it (docs/broadcast3d.md).
//
// Camera 1, the live wide shot: on the halfway line in the main stand, 34 m back from the near
// touchline and 18 m up, so the line of sight drops 27.9 degrees to that touchline and 14.8 degrees
// to the centre spot (Free TV Australia OP-32, 2.2.2: 30 to 40 m back, 20 to 30 and 12 to 16
// degrees, 60 m at most; UEFA E.2.1: 12 to 15 degrees to the centre spot). From that far away it
// works on a long lens, which flattens depth the way TV pictures do; a near wide-angle camera is
// what makes a match look like a video game. Like an operator it:
// - aims at the ball blended with the centroid of the players near it, plus a lead of where the
//   ball is going (0.7 s of its smoothed velocity), so the frame opens up in the direction of play;
// - follows that aim through a critically damped spring with a dead zone (pan and zoom have
//   inertia, nothing snaps or overshoots);
// - keeps 24 to 42 m of pitch across the frame at the aim point (a horizontal angle of 19 to 33
//   degrees), tighter when play bunches; a small frame (a phone) zooms in further so players stay
//   readable; on an attack inside 30 m of goal it narrows to 30 m and leans towards the goal
//   mouth, so the shot, the keeper and the net read (docs/motion3d.md, "The goal"); on a goal it
//   punches in on the goal mouth from the strike until the cut (PUNCH), on any other shot a little
//   less and only for the strike (SHOT_PUNCH);
// - a hard limit keeps the ball inside the middle 80% of the frame whatever the spring does;
// - around a kick it slides up to 10 m along a rail when another player's head would hide the
//   kicker's foot from the lens (sightline.js).
// Cuts happen only at a stoppage: after a goal the director cuts to camera 2, a pitchside handheld
// on a long lens, for a tight shot of the scorer (CELEBRATION seconds from 1 s after the goal),
// then back to camera 1; the ball rule is off meanwhile. A foul or a keeper's save gets the same
// tight shot (of the fouler, of the keeper) when play really stops: from 1 s after it until 0.5 s
// before the next event, and only if that leaves at least 2 s. Above 4x (view.cuts false) camera 1
// stays on: a 5 s tight shot would last 0.3 s at 16x.
// At other stoppages (throw-ins, goal kicks, corners, free kicks) the director sometimes cuts away
// to the crowd and the stadium (cutaway.js): the fans in the front rows, the fans behind a goal, or
// a beauty shot of the bowl from high in a corner, on the replay camera (free outside replays),
// then back to camera 1 before the restart.
// Replays use one free camera at one of four angles: the goal camera (behind the goal on the long
// axis, line of sight 13.5 degrees, OP-32 2.2.7), a pitch-level camera in line with the 18-yard
// line, the reverse angle from the far stand, and a high tactical view. They are stateless (a
// Gaussian-smoothed ball) so any frame renders alone.
import { railPlan, railAt, hidden } from "./sightline.js";
import { CELEBRATION, REDUCE, scorers, tightStops, cutawayPlan, cutawayShot } from "./cutaway.js";

const B = window.BABYLON;
const HALF_L = 52.5, HALF_W = 34;
const DEG = Math.PI / 180;

export const BROADCAST_POS = new B.Vector3(0, 18, -HALF_W - 34);   // 70.3 m from the centre spot
export const REPLAY_ANGLES = ["goal", "low", "reverse", "high"];
const BALL_SHARE = 0.65;              // aim = 65% ball + 35% centroid of the nearby players
const NEAR_SIGMA = 18;                // metres: who counts as "near the ball"
const DEPTH = 0.6;                    // across the pitch the aim moves 60% as far as play does
const LEAD_S = 0.7, LEAD_MAX = [7, 3];// seconds of ball velocity the aim runs ahead; cap (along, across)
const DEAD = [2.5, 1.5];              // dead zone half-axes, metres (along, across)
const OMEGA_PAN = 2.4, OMEGA_ZOOM = 1.2;
export const WIDTH = [24, 42];        // metres of pitch across the frame at the aim point
const SAFE = 0.8;                     // the ball stays within +-80% of the frame
// attack on goal: full effect inside 30 - 12 = 18 m of the goal line, none past 30 m; the aim goes
// most of the way to a point 7 m out from the goal, and the frame narrows to 30 m
const ATTACK = [30, 12, 7, 30];
const smooth01 = (u) => { const t = Math.min(1, Math.max(0, u)); return t * t * (3 - 2 * t); };
// camera 2, pitchside: 18 m from the player, 2.2 m up (a handheld at shoulder height on a low
// step), 4.5 m across the frame at him, aimed 0.95 m up: head to feet with room for arms up and a
// team-mate arriving, nearly level, stand behind; the aim is his position averaged over 2 s, so
// the handheld drifts with him instead of chasing each stride
const TIGHT = { dist: 18, height: 2.2, width: 4.5, aim: 0.95, avg: 10 };
const GOAL_CAM = { back: 14, tilt: 13.5 * DEG };   // metres behind the goal line, sight line to the penalty mark
export { CELEBRATION };
// punch-in on a goal: starts `lead` s before it, full after `ramp` s, `width` m across the frame,
// aimed `front` m out from where the ball crosses into the net
const PUNCH = { lead: 1.6, ramp: 1.4, width: 16, front: 4 };
// a shot that is not a goal gets a lighter punch-in, held `hold` s after the strike and let go over `out` s
const SHOT_PUNCH = { width: 22, hold: 1.2, out: 1.2 };
const SHOTS = new Set(["shot", "shot_freekick", "shot_penalty"]);

// Zoom factor for the size of the frame on screen: 1 from 1000 CSS px wide, down to 0.65 on a phone.
export const lensScale = (cssW) => Math.min(1, Math.max(0.65, (cssW || 1000) / 1000));

// The half ts is in, as [first, last] match second: the operator never looks across half time
// (the ball is reset for the kick-off between the two).
export function periodOf(match, ts) {
  const h = match.meta?.period1_s ?? 0;
  return ts < h ? [0, h - 0.1] : [h, match.duration];
}

// Ball position smoothed with a Gaussian over the data around ts, within its half (stateless).
export function smoothBall(match, ts, sigma, lead) {
  let sx = 0, sy = 0, sw = 0;
  const [lo, hi] = periodOf(match, ts);
  for (let k = -18; k <= 8; k++) {
    const p = match.at(0, Math.min(Math.max(ts + k * 0.1, lo), hi));
    if (!p) continue;
    const w = Math.exp(-((k * 0.1 - lead) ** 2) / (2 * sigma * sigma));
    sx += p[0] * w; sy += p[1] * w; sw += w;
  }
  return sw ? [sx / sw, sy / sw] : [HALF_L, HALF_W];
}

// What the operator wants at ts: aim point (contract metres) and frame width.
export function broadcastGoal(match, ts) {
  const [bx, by] = smoothBall(match, ts, 0.35, 0.1);
  // where the ball is going: smoothed velocity over half a second
  const [lo, hi] = periodOf(match, ts);
  const [px, py] = smoothBall(match, Math.max(lo, ts - 0.25), 0.35, 0.1), [nx, ny] = smoothBall(match, Math.min(hi, ts + 0.25), 0.35, 0.1);
  const lx = Math.max(-LEAD_MAX[0], Math.min(LEAD_MAX[0], (nx - px) * 2 * LEAD_S));
  const ly = Math.max(-LEAD_MAX[1], Math.min(LEAD_MAX[1], (ny - py) * 2 * LEAD_S));
  let cx = 0, cy = 0, sw = 0;
  const near = [];
  for (let i = 1; i < match.n; i++) {
    const p = match.at(i, ts);
    if (!p) continue;
    const w = Math.exp(-((p[0] - bx) ** 2 + (p[1] - by) ** 2) / (2 * NEAR_SIGMA * NEAR_SIGMA));
    cx += p[0] * w; cy += p[1] * w; sw += w; near.push([p, w]);
  }
  if (sw > 1e-6) { cx /= sw; cy /= sw; } else { cx = bx; cy = by; }
  let spread = 0;
  for (const [p, w] of near) spread += w * ((p[0] - cx) ** 2 + (p[1] - cy) ** 2);
  spread = sw > 1e-6 ? Math.sqrt(spread / sw) : 10;
  let ax = BALL_SHARE * bx + (1 - BALL_SHARE) * cx + lx, ay = BALL_SHARE * by + (1 - BALL_SHARE) * cy + ly;
  let width = Math.min(Math.max(14 + 2 * spread, WIDTH[0]), WIDTH[1]);
  // an attack on goal: inside about 30 m of a goal line the operator tightens and draws the frame
  // towards the goal mouth, so the shot, the keeper and the net are all in it, large enough to read
  const gx = bx > HALF_L ? 2 * HALF_L : 0, box = smooth01((ATTACK[0] - Math.abs(bx - gx)) / ATTACK[1]) * smooth01((30 - Math.abs(by - HALF_W)) / 8);
  if (box > 0) {
    ax += (gx - Math.sign(gx - HALF_L) * ATTACK[2] - ax) * box * 0.8;
    ay += (HALF_W - ay) * box * 0.3;
    width += (Math.min(width, ATTACK[3]) - width) * box;
  }
  return { x: Math.min(Math.max(ax - HALF_L, -44), 44), z: (ay - HALF_W) * DEPTH, width };
}

// One step of a critically damped spring on [pos, vel] towards target.
function spring(s, target, omega, dt) {
  const a = omega * omega * (target - s[0]) - 2 * omega * s[1];
  s[1] += a * dt;
  s[0] += s[1] * dt;
}

export class Cameras {
  constructor(scene, match, goalEnd) {
    this.scene = scene;
    this.match = match;
    this.goalEnd = goalEnd;
    this.replayAngle = "goal";
    this.tv = new B.FreeCamera("tv", BROADCAST_POS.clone(), scene);
    this.tv.minZ = 2; this.tv.maxZ = 700;
    this.cam2 = new B.FreeCamera("cam2", new B.Vector3(0, TIGHT.height, -HALF_W - 4), scene);
    this.cam2.minZ = 2; this.cam2.maxZ = 700;
    this.replay = new B.FreeCamera("replay", new B.Vector3(0, 10, 0), scene);
    this.replay.minZ = 0.3; this.replay.maxZ = 700;
    this.list = [this.tv, this.cam2, this.replay];
    this.state = null;   // {x: [pos, vel], z: [...], w: [...]}
    this.mode = "broadcast";
    this.focus = null;   // metres to the subject of a tight shot or a replay (depth of field), else null
    // the scorer of each goal fact, as an entity index
    this.goals = scorers(match);
    // stoppages with a tight shot, as [from, to, entity]: goals, then fouls and saves that stop play
    this.stops = tightStops(match, this.goals);
    // crowd and stadium cutaways at the other stoppages, never over a tight shot
    this.cutaways = cutawayPlan(match, this.stops);
    // punch-ins: goals until the cut to camera 2, other shots briefly ({ts, x, y, width, until, out})
    this.punches = this.goals.map((g) => { const b = match.at(0, g.ts); return b && { ts: g.ts, x: b[0], y: b[1], width: PUNCH.width, until: g.ts + CELEBRATION[0], out: 0 }; }).filter(Boolean);
    for (const e of match.events) {
      if (!SHOTS.has(e.type_name) || this.goals.some((g) => g.ts >= e.ts - 0.5 && g.ts - e.ts < 3)) continue;
      this.punches.push({ ts: e.ts, x: e.end_x, y: e.end_y, width: SHOT_PUNCH.width, until: e.ts + SHOT_PUNCH.hold, out: SHOT_PUNCH.out });
    }
    // camera 1's slides along its rail so no kick hides behind a head (sightline.js)
    this.rail = railPlan(match, [HALF_L + BROADCAST_POS.x, BROADCAST_POS.y, HALF_W + BROADCAST_POS.z]);
    scene.activeCamera = this.tv;
  }

  _aspect(cam) { return this.scene.getEngine().getAspectRatio(cam) || 16 / 9; }

  // vertical fov (what Babylon takes) for `width` metres across the frame at `dist` metres
  _fovFor(cam, width, dist) { return 2 * Math.atan(width / 2 / Math.max(dist, 1) / this._aspect(cam)); }

  // view: {ts, replay, angle?}; dt: match seconds since the last frame (0 after a jump).
  update(view, ts, dt) {
    this.focus = null;
    if (REDUCE.matches) {
      this._broadcast(ts, dt, false);
      this.mode = "broadcast";
      return;
    }
    if (view.replay) {
      const angle = view.angle ?? this.replayAngle;
      this._replay(ts, angle);
      this.mode = `replay-${angle}`;
      return;
    }
    const cut = view.cuts !== false && this.cutaways.find((c) => ts >= c.from && ts < c.to);
    if (cut) {
      this._cutaway(ts, cut);
      this.state = null;
      this.mode = `crowd-${cut.kind}`;
      return;
    }
    const stop = view.cuts !== false && this.stops.find(([a, b]) => ts >= a && ts < b);
    if (stop && this._celebrate(ts, stop)) {
      this.state = null;   // the wide shot warms up again afterwards
      this.mode = "celebration";
      return;
    }
    this._broadcast(ts, dt, true, view.cuts !== false);
    this.mode = "broadcast";
  }

  // Camera 2 on the player at a stoppage: a pitchside handheld that stands where the player was
  // when the stoppage began, seen from the near touchline side and a little towards the halfway
  // line (never on the pitch beyond 4 m from its lines), so the far stand is behind him. It stays
  // put for the shot; the aim follows his position averaged over two seconds. Depth of field on the
  // high profile, as on a long lens.
  _celebrate(ts, [from, to, i]) {
    const avg = (t) => {
      let x = 0, y = 0, n = 0;
      for (let k = -TIGHT.avg; k <= TIGHT.avg; k++) {
        const p = this.match.at(i, Math.min(Math.max(t + k * 0.1, 0), this.match.duration));
        if (p) { x += p[0]; y += p[1]; n++; }
      }
      return n ? [x / n - HALF_L, y / n - HALF_W] : null;
    };
    const now = avg(ts), start = avg(from);
    if (!now || !start) return false;
    // the operator steps round, up to 45 degrees, until nobody walks between him and the player
    // more than 3 m in front of him during the shot (sightline.js); chosen once per stoppage
    if (this.cam2For !== from) {
      const base = Math.atan2(-Math.sign(start[0]) * 0.35, -1), place = (a) => [
        Math.min(Math.max(start[0] + Math.sin(a) * TIGHT.dist, -HALF_L - 4), HALF_L + 4),
        Math.max(start[1] + Math.cos(a) * TIGHT.dist, -HALF_W - 4)];
      const clear = (a) => {
        const [x, z] = place(a), lens = [x + HALF_L, TIGHT.height, z + HALF_W];
        for (let t = from; t <= to; t += 0.25) {
          const p = this.match.at(i, Math.min(t, this.match.duration));
          if (p && hidden(this.match, lens, p, i, t, 1 - 3 / Math.hypot(lens[0] - p[0], lens[2] - p[1]))) return false;
        }
        return true;
      };
      const a = [0, 15, -15, 30, -30, 45, -45].map((d) => base + d * DEG).find(clear) ?? base;
      this.cam2For = from; this.cam2At = place(a);
    }
    const cam = this.cam2;
    cam.position.set(this.cam2At[0], TIGHT.height, this.cam2At[1]);
    const aim = new B.Vector3(now[0], TIGHT.aim, now[1]);
    cam.setTarget(aim);
    const dist = B.Vector3.Distance(cam.position, aim);
    // no phone zoom: already knees up; capped under 16 degrees across when the scorer runs at the camera
    cam.fov = Math.min(this._fovFor(cam, TIGHT.width, dist), 2 * Math.atan(Math.tan(7.9 * DEG) / this._aspect(cam)));
    this.focus = dist;
    this.scene.activeCamera = cam;
    return true;
  }

  // A cutaway (cutaway.js) on the replay camera; depth of field on the fans, none on the bowl.
  _cutaway(ts, c) {
    const { pos, aim, width, hfov, focus } = cutawayShot(c, ts), cam = this.replay;
    cam.position.set(...pos);
    const target = new B.Vector3(...aim);
    cam.setTarget(target);
    const dist = B.Vector3.Distance(cam.position, target);
    cam.fov = hfov ? 2 * Math.atan(Math.tan(hfov / 2) / this._aspect(cam)) : this._fovFor(cam, width, dist);
    if (focus) this.focus = dist;
    this.scene.activeCamera = cam;
  }

  _zoom() { return lensScale(this.scene.getEngine().getRenderingCanvas()?.clientWidth); }

  // dt s of the operator up to ts, in sub-steps of 0.02 s; the goal is read again every 0.1 s of
  // match time and at ts, so a long frame (16x, 64x) follows play as short frames do
  _step(ts, dt) {
    const s = this.state;
    let g = null, at = -Infinity;
    for (let left = dt; left > 1e-6; left -= 0.02) {
      const h = Math.min(0.02, left), t = ts - left + h;
      if (t - at > 0.1 - 1e-6 || left <= 0.02 + 1e-6) { g = broadcastGoal(this.match, t); at = t; }
      // dead zone: the spring only sees how far the goal is outside the ellipse, from where the camera is now
      const ex = g.x - s.x[0], ez = g.z - s.z[0], r = Math.hypot(ex / DEAD[0], ez / DEAD[1]), k = r > 1 ? 1 - 1 / r : 0;
      spring(s.x, s.x[0] + ex * k, OMEGA_PAN, h);
      spring(s.z, s.z[0] + ez * k, OMEGA_PAN, h);
      spring(s.w, g.width, OMEGA_ZOOM, h);
    }
  }

  // full: the punch-ins and the rail (off under prefers-reduced-motion); cuts: camera 2 takes the
  // goal from the punch-in (else camera 1 lets the punch-in go itself)
  _broadcast(ts, dt, full = true, cuts = true) {
    if (!this.state || dt === 0 || dt > 3) {
      // after a jump, warm up the operator over the previous three seconds of the same half (also
      // for a frame of over 3 s at 16x or 64x: the springs forget anything older, and it costs less)
      const t0 = Math.max(periodOf(this.match, ts)[0], ts - 3), g = broadcastGoal(this.match, t0);
      this.state = { x: [g.x, 0], z: [g.z, 0], w: [g.width, 0] };
      for (let t = t0 + 0.1; t <= ts + 1e-6; t += 0.1) this._step(t, 0.1);
    } else this._step(ts, dt);
    const s = this.state, cam = this.tv, [px, pz, pw] = full ? this._punch(ts, s, cuts) : [s.x[0], s.z[0], s.w[0]];
    const target = new B.Vector3(px, 0, pz);
    cam.position.set(BROADCAST_POS.x + (full ? railAt(this.rail, ts) : 0), BROADCAST_POS.y, BROADCAST_POS.z);
    const dist = B.Vector3.Distance(cam.position, target);
    const tanH = pw * this._zoom() / 2 / dist;
    cam.fov = 2 * Math.atan(tanH / this._aspect(cam));
    cam.setTarget(target);
    // hard limit: pan until the ball (as drawn, not smoothed) is inside the safe area; a lofted
    // ball counts at 3 m at most, as an operator lets a clearance leave the top of the frame
    const b = this.match.at(0, Math.min(ts, this.match.duration));
    if (b) {
      for (let pass = 0; pass < 2; pass++) {
        const v = B.Vector3.TransformCoordinates(new B.Vector3(b[0] - HALF_L, Math.min(Math.max(0, b[2]), 3), b[1] - HALF_W), cam.getViewMatrix(true));
        if (v.z <= 0) break;
        const nx = v.x / v.z / tanH, ny = v.y / v.z / Math.tan(cam.fov / 2);
        const ox = Math.abs(nx) > SAFE ? (nx - Math.sign(nx) * SAFE) * tanH * dist : 0;
        const oy = Math.abs(ny) > SAFE ? (ny - Math.sign(ny) * SAFE) * Math.tan(cam.fov / 2) * dist * 1.6 : 0;
        if (!ox && !oy) break;
        // the aim never leaves the pitch for the stands
        const tx = Math.max(-HALF_L, Math.min(HALF_L, target.x + ox)), tz = Math.max(-HALF_W, Math.min(HALF_W, target.z + oy));
        s.x[0] += tx - target.x; s.z[0] += tz - target.z;
        target.set(tx, 0, tz);
        cam.setTarget(target);
      }
    }
    this.scene.activeCamera = cam;
  }

  // The operator's punch-in on a shot: from 1.6 s before it he zooms in towards the goal mouth
  // where the ball ends up, so the strike, the keeper and the net read large; on a goal PUNCH.width
  // across, held until the cut to camera 2; on any other shot SHOT_PUNCH, let go after the strike,
  // the way a game camera leans in on a shot; a goal's too when there is no cut to camera 2 (above
  // 4x). Returns the shown [x, z, width].
  _punch(ts, s, cuts = true) {
    const out = (q) => q.out || (cuts ? 0 : SHOT_PUNCH.out);
    const g = this.punches.find((q) => ts > q.ts - PUNCH.lead && ts < q.until + out(q));
    if (!g) return [s.x[0], s.z[0], s.w[0]];
    const p = smooth01((ts - g.ts + PUNCH.lead) / PUNCH.ramp) * (out(g) ? 1 - smooth01((ts - g.until) / out(g)) : 1);
    const end = Math.sign(g.x - HALF_L) || 1;
    const ax = g.x - HALF_L - end * PUNCH.front, az = (g.y - HALF_W) * DEPTH;
    return [s.x[0] + (ax - s.x[0]) * p, s.z[0] + (az - s.z[0]) * p, s.w[0] + (Math.min(s.w[0], g.width) - s.w[0]) * p];
  }

  _replay(ts, angle) {
    const [bx, by] = smoothBall(this.match, ts, 0.45, 0.1);
    const cam = this.replay;
    const ball = new B.Vector3(bx - HALF_L, 0.6, by - HALF_W);
    const end = this.goalEnd;
    let aim = ball, width;
    if (angle === "low") {
      // pitch level on the near side, in line with the 18-yard line, on a long lens
      cam.position.set(end * (HALF_L - 16.5), 1.5, -HALF_W - 3);
      width = 13;
    } else if (angle === "reverse") {
      // the far stand, facing camera 1: the reverse angle
      cam.position.set(Math.min(Math.max(ball.x * 0.4, -20), 20), 18, HALF_W + 22);
      width = 22;
    } else if (angle === "high") {
      // tactical: high above the near touchline, the whole shape of both teams in view
      cam.position.set(Math.min(Math.max(ball.x * 0.5, -20), 20), 48, -HALF_W - 26);
      aim = new B.Vector3(ball.x * 0.75, 0, ball.z * 0.4);
      width = 72;
    } else {
      // the goal camera: behind the goal on the long axis, high enough that the line of sight to
      // the penalty mark clears the crossbar at 13.5 degrees; framed on the ball and the goal
      cam.position.set(end * (HALF_L + GOAL_CAM.back), Math.tan(GOAL_CAM.tilt) * (GOAL_CAM.back + 11), 0);
      aim = B.Vector3.Lerp(ball, new B.Vector3(end * HALF_L, 1, 0), 0.3);
      width = 17;
    }
    cam.setTarget(aim);
    const dist = B.Vector3.Distance(cam.position, aim);
    // never wider than 55 degrees across, whatever the distance
    cam.fov = Math.min(this._fovFor(cam, width * (angle === "high" ? 1 : this._zoom()), dist), 2 * Math.atan(Math.tan(27.5 * DEG) / this._aspect(cam)));
    if (angle !== "high") this.focus = B.Vector3.Distance(cam.position, ball);
    this.scene.activeCamera = cam;
  }
}
