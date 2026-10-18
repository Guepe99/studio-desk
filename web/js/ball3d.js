// Ball handling for the 3D view: dribble touches, first touch, kicks, a ball that slows down and
// spins. A visual layer only: the 2D page, the export and the facts never see it.
// Criteria and sources: docs/ball3d.md.
//
// Everything is a pure function of match time, planned once for a stretch of the match:
//   const plan = new BallPlan(match, [ts0, ts1], { reach, ballR });
//   plan.ball(ts)    -> { x, y, h, q }   contract metres, h = height of the ball's underside,
//                                        q = rotation [x, y, z, w] in 3D world axes (X along, Y up, Z across)
//   plan.pose(i, ts) -> { dx, dy, yaw, yawW, leg } for entity i: root offset in contract metres,
//                       facing override (yaw as atan2(dx, dy), weight 0..1) and the leg action
//                       { kind, side, t } with t = seconds from foot-ball contact, or null.
//
// The ball is the tracking ball with its clock bent between anchors: it equals the tracking ball at
// every event time (and at every touch), and in between runs ahead or behind on the same path,
// which is what makes it slow down after a kick and run ahead of the player after a touch. Each
// bend is checked against the tracking ball and softened until it stays within TOL metres.
// Players are moved (motion warping) so the foot is on the ball at the moment of contact.

export const TOL = 1.2;          // m: ball distance budget from the tracking ball (the bound is 1.5)
const MAX_WARP = 3.0;            // m: farther than this from the ball, a player does not touch it
const PASS_DECEL = 4.0;          // m/s^2, ground pass: between turf rolling (0.45-1.5) and match fits (7.9)
const LOFT_R = 0.85;             // end/start speed ratio of a lofted ball (air drag only)
const PUSH_R = 0.3;              // end/start speed ratio of the ball between two dribble touches
const SPIN_CAP = 2 * Math.PI * 6;   // rad/s drawn at most: faster reads as a frozen ball at 25 fps
const AIR_SPIN = 2 * Math.PI * 4;   // rad/s of a kicked ball at 20 m/s (straight kicks: 3.6-5.8 rev/s)
const STEP = 0.02;               // s, ball rotation sampling

const KICKS = { pass: "pass", cross: "long", shot: "shot", shot_freekick: "shot", shot_penalty: "shot",
  freekick_crossed: "long", freekick_short: "pass", corner_crossed: "long", corner_short: "pass",
  goalkick: "long", clearance: "long" };
const TOUCHES = { dribble: "touch", take_on: "touch", tackle: "touch", interception: "trap", bad_touch: "touch" };
const HANDS = new Set(["keeper_save", "keeper_claim", "keeper_punch", "keeper_pick_up"]);
// seconds before and after contact that a leg action lasts, and the facing ramps
export const LEG_WINDOW = { shot: [0.5, 0.5], long: [0.5, 0.5], pass: [0.42, 0.4], touch: [0.28, 0.28], trap: [0.42, 0.32] };
const YAW_RAMP = { shot: [0.6, 0.35], long: [0.6, 0.35], pass: [0.55, 0.3], touch: [0.3, 0.25], trap: [0.45, 0.3] };

const smooth = (u) => { const t = Math.min(1, Math.max(0, u)); return t * t * (3 - 2 * t); };
const ramp = (a, b, v) => smooth((v - a) / (b - a));
const angleLerp = (a, b, u) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * u;

// Clock bend of a decelerating ball: position share s(u) for time share u, speed falling linearly
// from v0 to r * v0. s(0) = 0, s(1) = 1.
export function decel(u, r) { return (2 / (1 + r)) * (u - (1 - r) * u * u / 2); }

export class BallPlan {
  constructor(match, span, { reach, ballR = 0.11 } = {}) {
    this.match = match;
    this.reach = reach ?? (() => ({ x: 0, z: 0.45 }));
    this.ballR = ballR;
    this.t0 = span[0] - 1;
    this.t1 = Math.min(span[1] + 1, match.duration);
    this.raw = (ts) => match.at(0, Math.min(Math.max(ts, 0), match.duration));
    // ground level of the export (0, or the ball radius when z is the centre height)
    let zg = Infinity;
    for (let t = this.t0; t <= this.t1; t += 0.1) { const b = this.raw(t); if (b) zg = Math.min(zg, b[2]); }
    this.zGround = Number.isFinite(zg) ? Math.max(0, zg) : 0;
    this.segs = [];      // { t0, t1, r }: clock bends
    this.actors = new Map();   // entity index -> { warp: [], yaw: [], legs: [], face: [] }
    this._plan();
    this._spin();
  }

  // --- planning
  _who(pid) { const i = this.match.index[pid]; return i === undefined ? null : i; }
  _actor(i) {
    if (!this.actors.has(i)) this.actors.set(i, { warp: [], yaw: [], legs: [], face: [] });
    return this.actors.get(i);
  }
  _foot(pid) {   // strong foot, one player in five left-footed
    let h = 0;
    for (const ch of pid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % 5 === 0 ? "l" : "r";
  }

  _plan() {
    const m = this.match, fps = m.meta.fps;
    const ev = m.events.filter((e) => e.ts >= this.t0 - 6 && e.ts <= this.t1 + 6).sort((a, b) => a.ts - b.ts);
    for (let k = 0; k < ev.length; k++) {
      const e = ev[k], next = ev[k + 1];
      const tEnd = next && next.period === e.period ? next.ts : Math.min(e.ts + 3, this.t1);
      const kick = KICKS[e.type_name];
      let a = e.ts;   // start of the controlled part of [e.ts, tEnd]
      if (kick || e.type_name === "throw_in") {
        // arrival: the first frame where the tracking ball is (about) as near the end point as it gets
        const near = [];
        for (let f = Math.floor(e.ts * fps) + 1; f / fps < tEnd; f++) {
          const b = this.raw(f / fps);
          near.push([f / fps, b ? Math.hypot(b[0] - e.end_x, b[1] - e.end_y) : Infinity]);
        }
        const dmin = Math.min(...near.map((x) => x[1]));
        const arr = dmin < 1 ? near.find((x) => x[1] < dmin + 0.05)[0] : tEnd;
        let hmax = 0;
        for (let t = e.ts; t <= arr; t += 0.1) hmax = Math.max(hmax, (this.raw(t)?.[2] ?? 0) - this.zGround);
        const dist = Math.hypot(e.end_x - e.start_x, e.end_y - e.start_y), T = Math.max(arr - e.ts, 1e-3);
        const v = dist / T;
        const r = hmax > 1.0 ? LOFT_R : Math.max(0.3, (v - PASS_DECEL * T) / Math.max(v, 1e-3));
        this._bend(e.ts, arr, r);
        if (kick) {
          const i = this._who(e.player_id);
          const kind = kick === "pass" && (hmax > 1.5 || dist > 32) ? "long" : kick;
          if (i !== null) this._action(i, e.ts, kind, this._foot(e.player_id), Math.atan2(e.end_x - e.start_x, e.end_y - e.start_y));
        }
        // the receiver turns to the ball while it travels, then controls it
        const rec = next && !HANDS.has(next.type_name) && next.period === e.period ? this._who(next.player_id) : null;
        if (rec !== null && arr < tEnd - 0.05 && dist > 4) {
          const b0 = this.raw(arr), b1 = this.raw(arr - 0.3);
          const yaw = Math.atan2(b1[0] - b0[0], b1[1] - b0[1]);
          if (this._action(rec, arr, "trap", this._foot(next.player_id), yaw)) this._actor(rec).face.push([e.ts + 0.15, arr]);
        }
        a = arr;
      } else if (TOUCHES[e.type_name]) {
        const i = this._who(e.player_id);
        if (i !== null) this._action(i, e.ts, TOUCHES[e.type_name], this._foot(e.player_id), null);
      }
      if (!next || next.period !== e.period || HANDS.has(e.type_name) || tEnd - a < 0.3 || tEnd - a > 10) continue;
      this._dribble(a, tEnd, this._who(next.player_id), next.player_id);
    }
  }

  // Controlled ball from a to b by entity o: touches every 0.6-1.0 s while the ball moves.
  _dribble(a, b, o, pid) {
    if (o === null) return;
    const pa = this.raw(a), pb = this.raw(b);
    let path = 0, prev = pa;
    for (let t = a + 0.1; t <= b; t += 0.1) {
      const p = this.raw(t);
      const step = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      if (step > 3) return;   // a jump (ball reset after a goal): leave it alone
      path += step; prev = p;
    }
    if (!pa || !pb) return;
    const v = path / (b - a);
    if (v < 1) return;        // a ball standing still: the player just keeps it
    const dt = Math.min(1.0, Math.max(0.6, 0.55 + 0.04 * v));
    const n = Math.max(1, Math.round((b - a) / dt));
    const side = this._foot(pid);
    for (let s = 0; s < n; s++) {
      const t0 = a + (s * (b - a)) / n, t1 = a + ((s + 1) * (b - a)) / n;
      this._bend(t0, t1, PUSH_R);
      if (s > 0) this._action(o, t0, "touch", side, null);
    }
  }

  // Bend the clock on [t0, t1] with speed ratio r, softened until the ball stays within TOL.
  _bend(t0, t1, r) {
    if (t1 - t0 < 0.05) return;
    const dev = (rr) => {
      let d = 0;
      for (let k = 1; k < 24; k++) {
        const t = t0 + ((t1 - t0) * k) / 24;
        const p = this.raw(t), q = this.raw(t0 + (t1 - t0) * decel(k / 24, rr));
        if (p && q) d = Math.max(d, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
      }
      return d;
    };
    if (dev(r) > TOL) {
      let lo = r, hi = 1;
      for (let it = 0; it < 14; it++) { const mid = (lo + hi) / 2; if (dev(mid) > TOL) lo = mid; else hi = mid; }
      r = hi;
    }
    this.segs.push({ t0, t1, r });
    this.segs.sort((p, q) => p.t0 - q.t0);
  }

  // Foot on the ball at time t: warp the player so the contact point of his pose is on the ball.
  _action(i, t, kind, side, yaw) {
    const A = this._actor(i);
    if (A.legs.some((l) => Math.abs(l.t - t) < 0.15)) return false;
    const p = this.match.at(i, t), b = this.ball(t);
    if (!p || !b) return false;
    if (yaw === null) {   // touches: face where the ball goes next, or the ball
      const n = this.ball(t + 0.25);
      yaw = Math.hypot(n.x - b.x, n.y - b.y) > 0.4 ? Math.atan2(n.x - b.x, n.y - b.y) : Math.atan2(b.x - p[0], b.y - p[1]);
    }
    const c = this.reach(kind, side), s = Math.sin(yaw), co = Math.cos(yaw);
    const dx = b.x - (p[0] + c.x * co + c.z * s), dy = b.y - (p[1] - c.x * s + c.z * co);
    if (Math.hypot(dx, dy) > MAX_WARP) return false;
    A.legs.push({ t, kind, side });
    A.warp.push({ t, v: [dx, dy], kind });
    A.yaw.push({ t, v: yaw, kind });
    for (const key of ["legs", "warp", "yaw"]) A[key].sort((p, q) => p.t - q.t);
    return true;
  }

  // Ball rotation, integrated once from the start of the stretch so any frame can be drawn alone.
  _spin() {
    const n = Math.ceil((this.t1 - this.t0) / STEP) + 2;
    this.quats = new Float64Array(4 * n);
    let q = [0, 0, 0, 1], w = [0, 0, 0];
    let prev = this.ball(this.t0);
    this.quats.set(q, 0);
    for (let k = 1; k < n; k++) {
      const cur = this.ball(this.t0 + k * STEP);
      // world axes: X = x, Y = up, Z = y
      const vx = (cur.x - prev.x) / STEP, vz = (cur.y - prev.y) / STEP, v = Math.hypot(vx, vz);
      if (v > 0.05) {
        // rolling: axis = up x direction; in the air the kick's spin carries on (backspin if lofted)
        const ax = [vz / v, 0, -vx / v];
        if (cur.h < 0.05) w = ax.map((c) => c * Math.min(v / this.ballR, SPIN_CAP));
        else if (prev.h < 0.05) w = ax.map((c) => c * AIR_SPIN * Math.min(1.5, v / 20) * (this._lofted(this.t0 + k * STEP) ? -1 : 1));
      } else if (cur.h < 0.05) w = [0, 0, 0];
      const a = Math.hypot(...w) * STEP;
      if (a > 1e-9) {
        const s = Math.sin(a / 2) / (a / STEP), d = [w[0] * s, w[1] * s, w[2] * s, Math.cos(a / 2)];
        q = qmul(d, q);
        const l = Math.hypot(...q); q = q.map((c) => c / l);
      }
      this.quats.set(q, 4 * k);
      prev = cur;
    }
  }
  _lofted(t) { for (let k = 1; k <= 10; k++) if (this.ball(t + k * 0.1).h > 1.2) return true; return false; }

  // --- queries
  // clock bend: the tracking time whose ball is shown at ts
  bent(ts) {
    for (const s of this.segs) if (ts > s.t0 && ts < s.t1) return s.t0 + (s.t1 - s.t0) * decel((ts - s.t0) / (s.t1 - s.t0), s.r);
    return ts;
  }

  ball(ts) {
    const p = this.raw(this.bent(ts));
    if (!p) return null;
    let q = [0, 0, 0, 1];
    if (this.quats) {
      const f = Math.min(Math.max((ts - this.t0) / STEP, 0), this.quats.length / 4 - 1.001);
      const k = Math.floor(f), u = f - k;
      q = nlerp(this.quats.subarray(4 * k, 4 * k + 4), this.quats.subarray(4 * k + 4, 4 * k + 8), u);
    }
    return { x: p[0], y: p[1], h: Math.max(0, p[2] - this.zGround), q };
  }

  pose(i, ts) {
    const A = this.actors.get(i);
    if (!A) return null;
    // root offset: interpolated between close contacts, eased in before and out after the others
    let dx = 0, dy = 0;
    const { a, b } = around(A.warp, ts);
    if (a && b && b.t - a.t <= 1.8) {
      const u = smooth((ts - a.t) / (b.t - a.t));
      dx = a.v[0] + (b.v[0] - a.v[0]) * u; dy = a.v[1] + (b.v[1] - a.v[1]) * u;
    } else {
      const wa = a ? 1 - ramp(a.t, a.t + 0.5, ts) : 0, wb = b ? ramp(b.t - 0.8, b.t, ts) : 0;
      dx = (a ? a.v[0] * wa : 0) + (b ? b.v[0] * wb : 0);
      dy = (a ? a.v[1] * wa : 0) + (b ? b.v[1] * wb : 0);
    }
    // facing
    let yaw = 0, yawW = 0;
    const y = around(A.yaw, ts);
    if (y.a && y.b && y.b.t - y.a.t <= 1.2) { yaw = angleLerp(y.a.v, y.b.v, smooth((ts - y.a.t) / (y.b.t - y.a.t))); yawW = 1; }
    else {
      const wa = y.a ? 1 - ramp(y.a.t, y.a.t + YAW_RAMP[y.a.kind][1], ts) : 0;
      const wb = y.b ? ramp(y.b.t - YAW_RAMP[y.b.kind][0], y.b.t, ts) : 0;
      if (wa >= wb && wa > 0) { yaw = y.a.v; yawW = wa; } else if (wb > 0) { yaw = y.b.v; yawW = wb; }
    }
    for (const [f0, f1] of A.face) {
      if (ts < f0 || ts > f1) continue;
      const p = this.match.at(i, ts), bb = this.ball(ts);
      if (!p || !bb) break;
      const want = Math.atan2(bb.x - p[0] - dx, bb.y - p[1] - dy), wf = ramp(f0, f0 + 0.3, ts);
      yaw = yawW > 0 ? angleLerp(want, yaw, yawW) : want;
      yawW = Math.max(yawW, wf);
      break;
    }
    // leg action: the nearest contact whose window holds ts
    let leg = null;
    for (const l of A.legs) {
      const d = ts - l.t, [pre, post] = LEG_WINDOW[l.kind];
      if (d >= -pre && d <= post && (!leg || Math.abs(d) < Math.abs(leg.t))) leg = { kind: l.kind, side: l.side, t: d };
    }
    return { dx, dy, yaw, yawW, leg };
  }

  // largest distance from the tracking ball over [from, to] and at the event times, for the tests
  check(from = this.t0 + 1, to = this.t1 - 1) {
    let worst = 0, atEvents = 0;
    for (let t = from; t <= to; t += 0.01) {
      const p = this.raw(t), b = this.ball(t);
      if (p && b) worst = Math.max(worst, Math.hypot(p[0] - b.x, p[1] - b.y, p[2] - this.zGround - b.h));
    }
    for (const e of this.match.events) {
      if (e.ts < from || e.ts > to) continue;
      const p = this.raw(e.ts), b = this.ball(e.ts);
      atEvents = Math.max(atEvents, Math.hypot(p[0] - b.x, p[1] - b.y));
    }
    let legs = 0;
    for (const A of this.actors.values()) legs += A.legs.filter((l) => l.t >= from && l.t <= to).length;
    return { worst, atEvents, legs };
  }
}

function around(keys, t) {
  let a = null, b = null;
  for (const k of keys) { if (k.t <= t) a = k; else { b = k; break; } }
  return { a, b };
}

function qmul(a, b) {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}

function nlerp(a, b, u) {
  const sg = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const q = [0, 1, 2, 3].map((k) => a[k] * (1 - u) + sg * b[k] * u);
  const l = Math.hypot(...q);
  return q.map((c) => c / l);
}

// --- leg poses for the actions, as joint angles in degrees on a planar leg:
// hip + = thigh forward, knee + = bent, ankle + = toes pointed down, ext + = toes turned out.
// Keys [t, hip, knee, ankle, ext], t in seconds from foot-ball contact. Kick phases after the
// biomechanics literature (docs/ball3d.md): backswing about 160 ms, cocking 40 ms, then the
// forward swing; peak knee bend just before the forward swing, knee nearly straight at contact.
const LEG_KEYS = {
  shot: [[-0.5, 0, 20, 0, 0], [-0.3, -12, 50, 10, 5], [-0.11, -42, 105, 25, 8], [0, 22, 22, 38, 8], [0.14, 64, 18, 32, 6], [0.32, 42, 35, 15, 0], [0.5, 8, 28, 0, 0]],
  long: [[-0.5, 0, 20, 0, 5], [-0.3, -10, 50, 8, 12], [-0.11, -38, 100, 22, 18], [0, 22, 24, 32, 18], [0.14, 58, 20, 28, 14], [0.32, 38, 35, 12, 5], [0.5, 8, 28, 0, 0]],
  pass: [[-0.42, 0, 22, 0, 5], [-0.24, -8, 42, 0, 25], [-0.1, -24, 72, -5, 42], [0, 16, 24, -10, 42], [0.13, 32, 20, -10, 36], [0.4, 6, 26, 0, 8]],
  touch: [[-0.28, 4, 30, 0, 8], [-0.12, -6, 55, 0, 25], [0, 24, 30, -5, 28], [0.12, 18, 30, 0, 15], [0.28, 4, 30, 0, 4]],
  trap: [[-0.42, 4, 25, 0, 8], [-0.2, 32, 52, -12, 40], [-0.06, 36, 44, -15, 42], [0, 30, 40, -12, 42], [0.12, 18, 36, -5, 25], [0.32, 4, 26, 0, 4]],
};
const SUPPORT = [12, 28, 0, 0];   // the standing leg bends a little while the other one swings
const SUPPORT_W = { shot: 0.8, long: 0.8, pass: 0.7, touch: 0.35, trap: 0.5 };

// { swing: [hip, knee, ankle, ext], support: [..], w, ws } in radians, for leg action kind at t.
export function legPose(kind, t) {
  const keys = LEG_KEYS[kind], [pre, post] = LEG_WINDOW[kind];
  const w = ramp(-pre, -pre + 0.16, t) * (1 - ramp(post - 0.16, post, t));
  let k = 0;
  while (k < keys.length - 2 && t > keys[k + 1][0]) k++;
  const a = keys[k], b = keys[k + 1];
  const u = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))), h = b[0] - a[0];
  const swing = [1, 2, 3, 4].map((j) => {
    // Catmull-Rom tangents: the foot keeps its speed through contact instead of stopping at a key
    const m = (i) => (i <= 0 || i >= keys.length - 1 ? 0 : (keys[i + 1][j] - keys[i - 1][j]) / (keys[i + 1][0] - keys[i - 1][0]));
    const u2 = u * u, u3 = u2 * u;
    const v = (2 * u3 - 3 * u2 + 1) * a[j] + (u3 - 2 * u2 + u) * h * m(k) + (-2 * u3 + 3 * u2) * b[j] + (u3 - u2) * h * m(k + 1);
    return (v * Math.PI) / 180;
  });
  return { swing, support: SUPPORT.map((d) => (d * Math.PI) / 180), w, ws: w * SUPPORT_W[kind] };
}
