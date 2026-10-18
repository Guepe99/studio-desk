// Cameras. The main one is the broadcast "camera 1": fixed on the halfway line, 18 m up and 70 m
// from the centre spot, panning and zooming like an operator does:
// - it aims at the ball blended with the centroid of the players near it, so it leads the play
//   instead of chasing every touch;
// - the aim follows through a critically damped spring with a dead zone (small moves of the ball
//   do not move the camera, nothing overshoots);
// - the field of view narrows when play bunches and widens when it spreads;
// - a hard limit keeps the ball inside the middle 80% of the frame whatever the spring does.
// Replays use one free camera at one of three angles: behind the goal, low on the touchline, or
// high and tactical. They are stateless (a Gaussian-smoothed ball) so any frame renders alone.
const B = window.BABYLON;
const HALF_L = 52.5, HALF_W = 34;

export const BROADCAST_POS = new B.Vector3(0, 18, -HALF_W - 34);   // 70.3 m from the centre spot
export const REPLAY_ANGLES = ["goal", "low", "high"];
const BALL_SHARE = 0.65;              // aim = 65% ball + 35% centroid of the nearby players
const NEAR_SIGMA = 18;                // metres: who counts as "near the ball"
const DEPTH = 0.6;                    // across the pitch the aim moves 60% as far as play does
const DEAD = [2.5, 1.5];              // dead zone half-axes, metres (along, across)
const OMEGA_PAN = 2.2, OMEGA_ZOOM = 1.2;
const WIDTH_MIN = 32, WIDTH_MAX = 58; // metres of pitch across the frame at the aim point
const SAFE = 0.8;                     // the ball stays within +-80% of the frame

// Ball position smoothed with a Gaussian over the data around ts (stateless).
export function smoothBall(match, ts, sigma, lead) {
  let sx = 0, sy = 0, sw = 0;
  for (let k = -18; k <= 8; k++) {
    const p = match.at(0, Math.min(Math.max(ts + k * 0.1, 0), match.duration));
    if (!p) continue;
    const w = Math.exp(-((k * 0.1 - lead) ** 2) / (2 * sigma * sigma));
    sx += p[0] * w; sy += p[1] * w; sw += w;
  }
  return sw ? [sx / sw, sy / sw] : [HALF_L, HALF_W];
}

// What the operator wants at ts: aim point (contract metres) and frame width.
export function broadcastGoal(match, ts) {
  const [bx, by] = smoothBall(match, ts, 0.35, 0.1);
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
  const ax = BALL_SHARE * bx + (1 - BALL_SHARE) * cx, ay = BALL_SHARE * by + (1 - BALL_SHARE) * cy;
  return {
    x: Math.min(Math.max(ax - HALF_L, -44), 44),
    z: (ay - HALF_W) * DEPTH,
    width: Math.min(Math.max(18 + 2.4 * spread, WIDTH_MIN), WIDTH_MAX),
  };
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
    this.replay = new B.FreeCamera("replay", new B.Vector3(0, 10, 0), scene);
    this.replay.minZ = 0.3; this.replay.maxZ = 700;
    this.list = [this.tv, this.replay];
    this.state = null;   // {x: [pos, vel], z: [...], w: [...]}
    scene.activeCamera = this.tv;
  }

  // view: {ts, replay, angle?}; dt: match seconds since the last frame (0 after a jump).
  update(view, ts, dt) {
    if (view.replay) this._replay(ts, view.angle ?? this.replayAngle);
    else this._broadcast(ts, dt);
  }

  _step(ts, dt) {
    const g = broadcastGoal(this.match, ts);
    const s = this.state;
    // dead zone: the spring only sees how far the goal is outside the ellipse
    const ex = g.x - s.x[0], ez = g.z - s.z[0];
    const r = Math.hypot(ex / DEAD[0], ez / DEAD[1]);
    const k = r > 1 ? 1 - 1 / r : 0;
    for (let t = dt; t > 1e-6; t -= 0.02) {
      const h = Math.min(0.02, t);
      spring(s.x, s.x[0] + ex * k, OMEGA_PAN, h);
      spring(s.z, s.z[0] + ez * k, OMEGA_PAN, h);
      spring(s.w, g.width, OMEGA_ZOOM, h);
    }
  }

  _broadcast(ts, dt) {
    if (!this.state || dt === 0 || dt > 1) {
      // after a jump, warm up the operator over the previous three seconds
      const g = broadcastGoal(this.match, Math.max(0, ts - 3));
      this.state = { x: [g.x, 0], z: [g.z, 0], w: [g.width, 0] };
      for (let t = Math.max(0, ts - 3) + 0.1; t <= ts + 1e-6; t += 0.1) this._step(t, 0.1);
    } else this._step(ts, dt);
    const s = this.state, cam = this.tv;
    const aspect = this.scene.getEngine().getAspectRatio(cam) || 16 / 9;
    const target = new B.Vector3(s.x[0], 0, s.z[0]);
    const dist = B.Vector3.Distance(BROADCAST_POS, target);
    const tanH = s.w[0] / 2 / dist;
    cam.fov = 2 * Math.atan(tanH / aspect);
    cam.setTarget(target);
    // hard limit: pan until the ball (as drawn, not smoothed) is inside the safe area
    const b = this.match.at(0, Math.min(ts, this.match.duration));
    if (b) {
      for (let pass = 0; pass < 2; pass++) {
        const v = B.Vector3.TransformCoordinates(new B.Vector3(b[0] - HALF_L, Math.max(0, b[2]), b[1] - HALF_W), cam.getViewMatrix(true));
        if (v.z <= 0) break;
        const nx = v.x / v.z / tanH, ny = v.y / v.z / Math.tan(cam.fov / 2);
        const ox = Math.abs(nx) > SAFE ? (nx - Math.sign(nx) * SAFE) * tanH * dist : 0;
        const oy = Math.abs(ny) > SAFE ? (ny - Math.sign(ny) * SAFE) * Math.tan(cam.fov / 2) * dist * 1.6 : 0;
        if (!ox && !oy) break;
        s.x[0] += ox; s.z[0] += oy;
        target.set(s.x[0], 0, s.z[0]);
        cam.setTarget(target);
      }
    }
    this.scene.activeCamera = cam;
  }

  _replay(ts, angle) {
    const [bx, by] = smoothBall(this.match, ts, 0.45, 0.1);
    const cam = this.replay;
    const ball = new B.Vector3(bx - HALF_L, 0.6, by - HALF_W);
    const end = this.goalEnd;
    let aim = ball, width;
    if (angle === "low") {
      // on the near touchline at eye height, a few metres behind the play
      cam.position.set(Math.min(Math.max(ball.x - end * 9, -50), 50), 1.6, -HALF_W - 3.5);
      aim = ball;
      width = 16;
    } else if (angle === "high") {
      // tactical: high above the near touchline, the whole shape of both teams in view
      cam.position.set(Math.min(Math.max(ball.x * 0.5, -20), 20), 48, -HALF_W - 26);
      aim = new B.Vector3(ball.x * 0.75, 0, ball.z * 0.4);
      width = 72;
    } else {
      // raised and off-axis behind the goal, so the net sits below the line of sight
      cam.position.set(end * (HALF_L + 10.5), 7.5, 7);
      const goal = new B.Vector3(end * HALF_L, 1, 0);
      aim = B.Vector3.Lerp(ball, goal, 0.25);
      width = null;
    }
    cam.setTarget(aim);
    const dist = Math.max(1, B.Vector3.Distance(cam.position, aim));
    cam.fov = width === null
      ? Math.min(0.85, Math.max(0.45, 2 * Math.atan(14 / Math.max(B.Vector3.Distance(cam.position, ball), 1))))
      : 2 * Math.atan(width / 2 / dist / (this.scene.getEngine().getAspectRatio(cam) || 16 / 9));
    this.scene.activeCamera = cam;
  }
}
