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
const SPIN_CAP = 2 * Math.PI * 6;   // rad/s drawn at most: faster reads as a frozen ball in the 30 fps capture
const AIR_SPIN = 2 * Math.PI * 4;   // rad/s of a kicked ball at 20 m/s (straight kicks: 3.6-5.8 rev/s)
const STEP = 0.02;               // s, ball rotation sampling
// the goal (contract metres) and its netting: a soft, heavily damped spring that swallows the ball
// in about 0.2 s and gives it back slowly (docs/motion3d.md)
export const PITCH_L = 105, GOAL_W = 7.32, GOAL_H = 2.44, NET_D = 2.2;
const NET_W = 14;                // rad/s, natural frequency of the net on the ball
const NET_Z = 0.7;               // damping ratio: most of the energy stays in the cords
const NET_GRIP = 6;              // 1/s, the cords drag on the ball along the net
const NET_HOLD = 0.4;            // s, the stretched cords sag back slower than the ball rebounds
const ROLL_DECEL = 1.5;          // m/s^2, the ball rolling on the turf inside the goal

const KICKS = { pass: "pass", cross: "long", shot: "shot", shot_freekick: "shot", shot_penalty: "shot",
  freekick_crossed: "long", freekick_short: "pass", corner_crossed: "long", corner_short: "pass",
  goalkick: "long", clearance: "long" };
const TOUCHES = { dribble: "touch", take_on: "touch", tackle: "touch", interception: "trap", bad_touch: "touch" };
const HANDS = new Set(["keeper_save", "keeper_claim", "keeper_punch", "keeper_pick_up"]);
// the ball lies still before these, so nobody plays with it
const SET_PIECES = new Set(["freekick_crossed", "freekick_short", "shot_freekick", "shot_penalty", "goalkick", "corner_crossed", "corner_short", "throw_in"]);
// Moves of a player keeping a still ball at his feet (docs/flow3d.md, section 5): the leg actions
// [kind, seconds from the start] and how the ball rolls [t0, t1, metres along his facing], so it
// ends where it started; len: seconds the move takes; p: how often it is picked. A sole roll (the
// ball out and back under the sole), a drag-back then a touch that puts it back, a step-over, a
// feint with the shoulders.
export const SKILLS = {
  roll: { p: 0.3, len: 1.0, legs: [["roll", 0.3]], ball: [[0.3, 0.48, 0.12], [0.48, 0.66, -0.12]] },
  drag: { p: 0.25, len: 1.33, legs: [["drag", 0.3], ["touch", 1.05]], ball: [[0.3, 0.6, -0.26], [1.05, 1.3, 0.26]] },
  stepover: { p: 0.2, len: 0.8, legs: [["stepover", 0.35]], ball: [] },
  feint: { p: 0.25, len: 0.65, legs: [["feint", 0.3]], ball: [] },
};
// seconds before and after contact that a leg action lasts, and the facing ramps
export const LEG_WINDOW = { shot: [0.5, 0.5], long: [0.5, 0.5], pass: [0.42, 0.4], touch: [0.28, 0.28], trap: [0.42, 0.32],
  roll: [0.3, 0.7], drag: [0.3, 0.45], stepover: [0.35, 0.45], feint: [0.3, 0.35] };
const YAW_RAMP = { shot: [0.6, 0.35], long: [0.6, 0.35], pass: [0.55, 0.3], touch: [0.3, 0.25], trap: [0.45, 0.3],
  roll: [0.4, 0.4], drag: [0.4, 0.4], stepover: [0.4, 0.4], feint: [0.4, 0.4] };

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
    this.moves = [];     // { t0, t1, v, keys }: the ball moved under a still player's foot (skills)
    this.actors = new Map();   // entity index -> { warp: [], yaw: [], legs: [], face: [] }
    this.nets = [];      // { t0, t1, s: samples }: a scored ball carried on into the netting
    this._plan();
    this._nets();
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
      // a ball in a keeper's hands, or a dead ball the next player throws in, is not dribbled
      if (!next || next.period !== e.period || HANDS.has(e.type_name) || next.type_name === "throw_in" || tEnd - a < 0.3 || tEnd - a > 10) continue;
      this._dribble(a, tEnd, this._who(next.player_id), next.player_id, next);
    }
  }

  // Controlled ball from a to b by entity o: touches every 0.6-1.0 s while the ball moves.
  _dribble(a, b, o, pid, next) {
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
    if (v < 1) { this._skills(a, b, o, pid, next); return; }   // a ball standing still: he plays with it
    const dt = Math.min(1.0, Math.max(0.6, 0.55 + 0.04 * v));
    const n = Math.max(1, Math.round((b - a) / dt));
    const side = this._foot(pid);
    for (let s = 0; s < n; s++) {
      const t0 = a + (s * (b - a)) / n, t1 = a + ((s + 1) * (b - a)) / n;
      this._bend(t0, t1, PUSH_R);
      if (s > 0) this._action(o, t0, "touch", side, null);
    }
  }

  // A player keeping a still ball in open play does not stand like a statue: from the end of his
  // control to his next kick he plays small moves (SKILLS), picked by a seeded draw so every frame of
  // the same moment is the same. Only before his own kick, never before a set piece (the ball must
  // lie still for a free kick, a corner or a penalty) and only while he stands at the ball.
  _skills(a, b, o, pid, next) {
    if (!next || SET_PIECES.has(next.type_name) || next.end_x === undefined || next.end_x === null) return;
    const yaw = Math.atan2(next.end_x - next.start_x, next.end_y - next.start_y);
    const f = [Math.sin(yaw), Math.cos(yaw)];
    let h = 2166136261;
    for (const ch of `${pid}@${Math.round(a * 10)}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    const rnd = mulberry(h);
    const names = Object.keys(SKILLS);
    // after the control (the trap's window ends 0.32 s after contact) and before the kick's backswing
    for (let c = a + 0.45; ;) {
      const fit = names.filter((n) => c + SKILLS[n].len <= b - 0.55);
      if (!fit.length) break;
      let r = rnd() * fit.reduce((s, n) => s + SKILLS[n].p, 0), name = fit[0];
      for (const n of fit) { r -= SKILLS[n].p; if (r <= 0) { name = n; break; } }
      const S = SKILLS[name];
      const near = S.legs.every(([, t]) => {
        const p = this.match.at(o, c + t), q = this.ball(c + t);
        return p && q && Math.hypot(q.x - p[0], q.y - p[1]) < 1.5;
      });
      if (near) {
        if (S.ball.length) {
          const keys = [[c, 0]];
          let d = 0;
          for (const [t0, t1, dd] of S.ball) { keys.push([c + t0, d]); d += dd; keys.push([c + t1, d]); }
          this.moves.push({ t0: c, t1: c + S.len, v: f, keys });
        }
        for (const [kind, t] of S.legs) this._action(o, c + t, kind, this._foot(pid), yaw);
      }
      c += S.len + 0.15 + 0.35 * rnd();
    }
  }

  // metres the skills have moved the ball from its tracking point at ts, as [dx, dy]
  _moved(ts) {
    // moves are pushed in event order and never overlap: binary search for the last one started
    let lo = 0, hi = this.moves.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.moves[mid].t0 <= ts) lo = mid + 1; else hi = mid; }
    const m = this.moves[lo - 1];
    if (m && ts < m.t1) {
      let k = 0;
      while (k < m.keys.length - 2 && ts > m.keys[k + 1][0]) k++;
      const [ta, da] = m.keys[k], [tb, db] = m.keys[k + 1];
      const d = da + (db - da) * smooth((ts - ta) / Math.max(tb - ta, 1e-6));
      return [m.v[0] * d, m.v[1] * d];
    }
    return null;
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

  // A scored ball: the tracking ball stops on the line, so from the crossing on the drawn ball keeps
  // its speed and is simulated into the netting (a damped spring per net plane, gravity, a bounce
  // and a roll), then rests in the goal until the next event or the ball's reset.
  _nets() {
    const ids = new Set(this.match.goals.flatMap((g) => g.source_event_ids ?? []));
    const r = this.ballR, H = 1 / 240;
    for (const e of this.match.events) {
      if (!ids.has(e.event_id) || e.ts + 35 < this.t0 || e.ts > this.t1) continue;   // a ball rests in the net up to 30 s after a goal, so a later plan keeps it
      const end = e.end_x > PITCH_L / 2 ? 1 : -1, gx = end > 0 ? PITCH_L : 0;
      let tc = null;
      // take over 2.5 m short of the line: the tracking ball already brakes for its stop there
      for (let t = e.ts; t < e.ts + 4; t += 0.005) { const b = this.ball(t); if (b && (b.x - gx) * end > -2.5) { tc = t; break; } }
      if (tc === null || tc - 0.25 < e.ts) continue;
      const a = this.ball(tc - 0.25), c = this.ball(tc);
      const p = [c.x, c.y, c.h + r], v = [(c.x - a.x) / 0.25, (c.y - a.y) / 0.25, (c.h - a.h) / 0.25];
      if ((v[0] * end) < 3) continue;   // a ball dribbled over the line: nothing to carry
      // the window: up to the next event or a jump of the tracking ball (the reset for the kick-off)
      let t1 = Math.min(tc + 30, this.t1 + 1);
      const next = this.match.events.find((x) => x.ts > tc + 0.05);
      if (next) t1 = Math.min(t1, next.ts);
      for (let t = tc; t < t1; t += 0.1) {
        const q0 = this.raw(t), q1 = this.raw(t + 0.1);
        if (q0 && q1 && Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) > 3) { t1 = t; break; }
      }
      // planes as [axis, sign, position(p)]: the ball's front surface past the plane presses it
      const planes = [
        ["back", (q) => (q[0] - gx) * end + r - NET_D, [end, 0, 0]],
        ["side", (q) => q[1] - (34 + GOAL_W / 2) + r, [0, 1, 0]],
        ["side", (q) => (34 - GOAL_W / 2) - q[1] + r, [0, -1, 0]],
        ["roof", (q) => q[2] + r - (GOAL_H - 0.1 * GOAL_H * Math.min(1, Math.max(0, (q[0] - gx) * end / NET_D))), [0, 0, 1]],
      ];
      const s = [];
      let hit = null, peak = 0, tPeak = 0, released = null;
      for (let k = 0, t = tc; t < t1; k++, t = tc + k * H) {
        if (k % 2 === 0) {
          let depth = 0, plane = hit?.name ?? null, at = hit?.at ?? null;
          if (hit) depth = Math.max(0, hit.d);
          else if (released) {   // the cords spring back past rest and settle
            const u = t - released.t;
            depth = -0.25 * released.peak * Math.exp(-5 * u) * Math.sin(2 * Math.PI * 2.2 * u);
            plane = released.name; at = released.at;
          }
          // the pocket outlasts the ball's push: it billows to the peak and relaxes over NET_HOLD
          if (plane) depth = Math.max(depth, peak * Math.exp(-(t - tPeak) / NET_HOLD));
          s.push([p[0], p[1], Math.max(0, p[2] - r), depth, plane, at]);
        }
        // forces: gravity, the pressed net, the turf
        const f = [0, 0, -9.81];
        let touching = null;
        for (const [name, pen, n] of planes) {
          const d = (p[0] - gx) * end > 0 ? pen(p) : 0;   // the netting starts at the goal line
          if (d <= 0) continue;
          const vn = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
          // per unit mass, along -n; the damping also brakes the way back (the cords hold the ball)
          const fn = NET_W * NET_W * d + 2 * NET_Z * NET_W * vn;
          for (let j = 0; j < 3; j++) f[j] -= fn * n[j] + NET_GRIP * (v[j] - vn * n[j]);
          if (!touching || d > touching.d) touching = { name, d, n };
        }
        if (touching) {
          hit = { name: touching.name, at: [p[0], p[1], p[2]], d: touching.d };   // the pocket follows the ball
          if (touching.d > peak) { peak = touching.d; tPeak = t; }
        } else if (hit) { released = { t, name: hit.name, at: hit.at, peak }; hit = null; }
        for (let j = 0; j < 3; j++) v[j] += f[j] * H;
        if (p[2] - r < 0 && v[2] < 0) {   // bounce, then roll
          p[2] = r; v[2] = -v[2] * 0.5;
          if (v[2] < 0.3) v[2] = 0;
        }
        if (p[2] - r < 0.01 && v[2] === 0) {
          const sp = Math.hypot(v[0], v[1]), dv = Math.min(sp, ROLL_DECEL * H);
          if (sp > 0) { v[0] -= (v[0] / sp) * dv; v[1] -= (v[1] / sp) * dv; }
        }
        for (let j = 0; j < 3; j++) p[j] += v[j] * H;
        if (released && t - released.t > 1.5 && Math.hypot(...v) < 0.02 && p[2] - r < 0.01) { s.push([p[0], p[1], 0, 0, null, null]); break; }
      }
      this.nets.push({ t0: tc, t1, end, s, dt: 2 * H });
    }
  }

  // the net window holding ts and its sample index, or null
  _net(ts) {
    for (const n of this.nets) {
      if (ts < n.t0 || ts >= n.t1) continue;
      const f = Math.min((ts - n.t0) / n.dt, n.s.length - 1), k = Math.min(Math.floor(f), n.s.length - 2);
      return { n, k: Math.max(0, k), u: Math.max(0, Math.min(1, f - k)) };
    }
    return null;
  }

  // the net pressed by a scored ball at ts: { end, plane, at: [x, y, hCentre], depth } or null
  net(ts) {
    const w = this._net(ts);
    if (!w) return null;
    const a = w.n.s[w.k], b = w.n.s[w.k + 1] ?? a;
    if (!a[4]) return null;
    return { end: w.n.end, plane: a[4], at: a[5], depth: a[3] + ((b[4] === a[4] ? b[3] : a[3]) - a[3]) * w.u };
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
    let x, y, h;
    const w = this._net(ts);
    if (w) {
      const a = w.n.s[w.k], b = w.n.s[w.k + 1] ?? a;
      [x, y, h] = [0, 1, 2].map((j) => a[j] + (b[j] - a[j]) * w.u);
    } else {
      const p = this.raw(this.bent(ts));
      if (!p) return null;
      [x, y, h] = [p[0], p[1], Math.max(0, p[2] - this.zGround)];
      const mv = this._moved(ts);
      if (mv) { x += mv[0]; y += mv[1]; }
    }
    let q = [0, 0, 0, 1];
    if (this.quats) {
      const f = Math.min(Math.max((ts - this.t0) / STEP, 0), this.quats.length / 4 - 1.001);
      const k = Math.floor(f), u = f - k;
      q = nlerp(this.quats.subarray(4 * k, 4 * k + 4), this.quats.subarray(4 * k + 4, 4 * k + 8), u);
    }
    return { x, y, h, q };
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

  // largest distance from the tracking ball over [from, to] and at the event times, for the tests;
  // a scored ball in the netting is left out (the tracking ball stops on the line)
  check(from = this.t0 + 1, to = this.t1 - 1) {
    let worst = 0, atEvents = 0;
    for (let t = from; t <= to; t += 0.01) {
      if (this._net(t)) continue;
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
// biomechanics literature (docs/ball3d.md, docs/motion3d.md): backswing about 160 ms, cocking 40 ms,
// then the forward swing; peak knee bend just before the forward swing, knee nearly straight at
// contact. The shot has the biggest backswing; the pass is a side-foot kick (thigh turned out
// about 50 degrees, ankle locked up) with a compact swing; the long ball is an instep kick.
const LEG_KEYS = {
  shot: [[-0.5, 0, 20, 0, 0], [-0.3, -14, 55, 10, 5], [-0.11, -46, 110, 25, 8], [0, 22, 22, 38, 8], [0.1, 64, 14, 32, 6], [0.2, 50, 26, 22, 3], [0.32, 24, 36, 10, 0], [0.5, 8, 28, 0, 0]],
  long: [[-0.5, 0, 20, 0, 5], [-0.3, -10, 50, 8, 12], [-0.11, -40, 100, 22, 18], [0, 24, 30, 26, 18], [0.14, 60, 20, 28, 14], [0.32, 40, 35, 12, 5], [0.5, 8, 28, 0, 0]],
  pass: [[-0.42, 0, 22, 0, 8], [-0.24, -10, 45, -5, 35], [-0.1, -26, 72, -10, 50], [0, 16, 26, -12, 50], [0.13, 40, 18, -10, 42], [0.25, 28, 24, -5, 25], [0.4, 6, 26, 0, 8]],
  touch: [[-0.28, 4, 30, 0, 8], [-0.12, -6, 55, 0, 25], [0, 24, 30, -5, 28], [0.12, 18, 30, 0, 15], [0.28, 4, 30, 0, 4]],
  trap: [[-0.42, 4, 25, 0, 8], [-0.2, 32, 52, -12, 40], [-0.06, 36, 44, -15, 42], [0, 30, 40, -12, 42], [0.12, 18, 36, -5, 25], [0.32, 4, 26, 0, 4]],
  // the skills: the sole up on the ball (toes up), out and back (roll) or pulled back under the body
  // (drag); the step-over circles the leg from inside to outside over the ball; the feint is a
  // short jab of the leg under a shoulder drop (BODY_KEYS)
  roll: [[-0.3, 4, 30, 0, 5], [-0.12, 36, 70, -12, 8], [0, 40, 62, -22, 8], [0.18, 50, 62, -18, 8], [0.36, 40, 62, -22, 8], [0.55, 12, 42, -8, 5], [0.7, 2, 30, 0, 4]],
  drag: [[-0.3, 4, 30, 0, 5], [-0.12, 36, 70, -12, 8], [0, 40, 62, -22, 8], [0.15, 24, 56, -20, 6], [0.3, 8, 46, -12, 5], [0.45, 2, 30, 0, 4]],
  stepover: [[-0.35, 4, 30, 0, 5], [-0.15, 30, 70, 10, -20], [0, 45, 80, 15, 10], [0.15, 30, 62, 10, 45], [0.3, 8, 36, 0, 30], [0.45, 2, 30, 0, 5]],
  feint: [[-0.3, 4, 30, 0, 5], [-0.1, 18, 45, 5, 22], [0, 16, 40, 5, 26], [0.15, 6, 34, 0, 10], [0.35, 2, 30, 0, 4]],
};
// The standing leg. For the kicks it is the plant leg of the last, longer stride: it swings
// through high, reaches out and lands heel first beside the ball about 0.1 s before contact, the
// knee gives under the body, then the body rolls over it. Touches and traps only bend it a little.
const STAND = [[-1, 12, 28, 0, 0], [1, 12, 28, 0, 0]];
const SUPPORT_KEYS = {
  shot: [[-0.5, -14, 45, 10, 0], [-0.3, 26, 72, 0, 0], [-0.14, 32, 18, -5, 0], [-0.07, 24, 24, 0, 0], [0, 14, 34, 0, 0], [0.1, 2, 30, 8, 0], [0.32, -8, 34, 15, 0], [0.5, 4, 30, 0, 0]],
  long: [[-0.5, -14, 45, 10, 0], [-0.3, 26, 70, 0, 0], [-0.14, 34, 18, -5, 0], [-0.07, 26, 24, 0, 0], [0, 16, 34, 0, 0], [0.14, 4, 30, 8, 0], [0.32, -6, 32, 12, 0], [0.5, 4, 30, 0, 0]],
  pass: [[-0.42, -12, 42, 8, 0], [-0.22, 22, 48, 0, 0], [-0.09, 18, 22, 0, 0], [0, 12, 27, 0, 0], [0.13, 6, 27, 0, 0], [0.4, 2, 26, 0, 0]],
  touch: STAND, trap: STAND, roll: STAND, drag: STAND, stepover: STAND,
  // the feint sinks on the standing leg
  feint: [[-0.3, 12, 28, 0, 0], [-0.1, 18, 42, 0, 0], [0.05, 20, 46, 0, 0], [0.35, 12, 28, 0, 0]],
};
const SUPPORT_W = { shot: 0.9, long: 0.9, pass: 0.8, touch: 0.35, trap: 0.5, roll: 0.5, drag: 0.5, stepover: 0.5, feint: 0.6 };

// The rest of the body during a kick, for a kick with the right foot (the rig mirrors a left-foot
// kick). Keys [t, pelvis, shoulders, lean, bend, freeAbd, freeFlex, kickAbd, kickFlex] in degrees:
//   pelvis, shoulders  turn about the vertical, + = towards the standing-leg side (the kicking hip
//                      forward; for the shoulders, the free arm's shoulder back), added to the clips;
//   lean               trunk forward over the ball (+) or back (-), added to the clips;
//   bend               trunk leaning sideways towards the standing leg, added to the clips;
//   freeAbd, freeFlex  the arm opposite the kicking leg, a pose of its own: out from the side
//                      (0 hanging, 90 level with the shoulder), forward (+) or back (-);
//   kickAbd, kickFlex  the arm on the kicking side, the same way.
// The "tension arc" (docs/motion3d.md): at the top of the backswing the kicking hip is back, the
// shoulders turn the other way and the free arm is out wide and back; at release the pelvis turns
// through, the trunk flexes over the ball and the free arm sweeps across. The pass keeps the trunk
// upright with a smaller arc of its own (free arm out to about 50 degrees, then forward); the long ball leans back with the free arm out.
const BODY_KEYS = {
  shot: [[-0.5, 0, 0, 3, 0, 12, 0, 12, 0], [-0.3, -8, 6, 2, 4, 45, -15, 15, 15], [-0.11, -16, 12, -2, 8, 85, -35, 20, 25],
    [0, 4, 2, 8, 10, 75, -15, 22, -5], [0.1, 18, -12, 10, 6, 45, 30, 25, -25], [0.32, 14, -8, 6, 3, 25, 15, 15, -10], [0.5, 0, 0, 3, 0, 12, 0, 12, 0]],
  long: [[-0.5, 0, 0, 2, 0, 12, 0, 12, 0], [-0.3, -7, 5, -2, 5, 48, -15, 15, 12], [-0.11, -14, 10, -8, 10, 90, -30, 25, 15],
    [0, 3, 2, -10, 14, 85, -12, 25, -5], [0.14, 14, -8, -6, 8, 55, 20, 25, -20], [0.32, 10, -5, 0, 3, 28, 12, 15, -10], [0.5, 0, 0, 2, 0, 12, 0, 12, 0]],
  pass: [[-0.42, 0, 0, 3, 0, 12, 0, 12, 0], [-0.24, -6, 4, 3, 3, 32, -12, 14, 10], [-0.1, -10, 8, 4, 6, 52, -22, 16, 14],
    [0, -2, 3, 5, 6, 48, -2, 16, -6], [0.13, 6, -5, 5, 4, 36, 22, 14, -14], [0.25, 4, -3, 4, 2, 24, 12, 12, -6], [0.4, 0, 0, 3, 0, 12, 0, 12, 0]],
  touch: [[-0.28, 0, 0, 2, 0, 12, 0, 12, 0], [-0.1, -2, 2, 4, 2, 14, 0, 12, 0], [0, 0, 0, 5, 3, 15, 0, 12, 0], [0.12, 1, -1, 4, 2, 14, 0, 12, 0], [0.28, 0, 0, 2, 0, 12, 0, 12, 0]],
  trap: [[-0.42, 0, 0, 2, 0, 12, 0, 12, 0], [-0.2, -2, 2, 6, 3, 18, 0, 12, 0], [0, -1, 1, 8, 4, 20, 0, 14, 0], [0.12, 0, 0, 6, 3, 16, 0, 12, 0], [0.32, 0, 0, 2, 0, 12, 0, 12, 0]],
  // the skills: arms a little out for balance; the step-over and the feint dip the shoulders
  // towards the kicking side (bend < 0) and turn the hips with it, the feint deeper and lower
  roll: [[-0.3, 0, 0, 2, 0, 12, 0, 12, 0], [0, -4, 3, -2, 4, 28, 5, 24, -5], [0.36, -2, 2, -1, 3, 26, 3, 22, -3], [0.7, 0, 0, 2, 0, 12, 0, 12, 0]],
  drag: [[-0.3, 0, 0, 2, 0, 12, 0, 12, 0], [0, -4, 3, -2, 4, 30, 5, 25, -5], [0.3, 2, -2, 0, 2, 24, 0, 18, 0], [0.45, 0, 0, 2, 0, 12, 0, 12, 0]],
  stepover: [[-0.35, 0, 0, 2, 0, 12, 0, 12, 0], [-0.1, -10, 6, 4, -6, 30, 0, 25, 0], [0, -16, 10, 5, -10, 38, 5, 30, 0], [0.2, -6, 4, 6, -4, 32, 0, 24, 0], [0.45, 0, 0, 2, 0, 12, 0, 12, 0]],
  feint: [[-0.3, 0, 0, 2, 0, 12, 0, 12, 0], [-0.1, -8, 8, 6, -12, 35, 0, 25, 0], [0.05, -10, 10, 8, -14, 40, 0, 26, 0], [0.2, -4, 4, 5, -5, 25, 0, 18, 0], [0.35, 0, 0, 2, 0, 12, 0, 12, 0]],
};
// How much the arm poses replace the clips' arm swing: a dribble touch keeps the running arms.
const ARM_W = { shot: 1, long: 1, pass: 1, touch: 0, trap: 0.35, roll: 0.5, drag: 0.5, stepover: 0.7, feint: 0.7 };
const ELBOW = [30, 55];   // degrees of elbow bend in the arm poses: free arm, kicking-side arm

// Value j of keys [t, v1, v2, ...] at t, in radians: Catmull-Rom tangents, so the foot keeps its
// speed through contact instead of stopping at a key.
function spline(keys, t, j) {
  let k = 0;
  while (k < keys.length - 2 && t > keys[k + 1][0]) k++;
  const a = keys[k], b = keys[k + 1];
  const u = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))), h = b[0] - a[0];
  const m = (i) => (i <= 0 || i >= keys.length - 1 ? 0 : (keys[i + 1][j] - keys[i - 1][j]) / (keys[i + 1][0] - keys[i - 1][0]));
  const u2 = u * u, u3 = u2 * u;
  const v = (2 * u3 - 3 * u2 + 1) * a[j] + (u3 - 2 * u2 + u) * h * m(k) + (-2 * u3 + 3 * u2) * b[j] + (u3 - u2) * h * m(k + 1);
  return (v * Math.PI) / 180;
}

// Weight of a leg action at t: in over 0.16 s at the start of its window, out over the last 0.16 s.
const actionW = (kind, t) => { const [pre, post] = LEG_WINDOW[kind]; return ramp(-pre, -pre + 0.16, t) * (1 - ramp(post - 0.16, post, t)); };

// { swing: [hip, knee, ankle, ext], support: [..], w, ws } in radians, for leg action kind at t.
export function legPose(kind, t) {
  const w = actionW(kind, t), at = (keys) => [1, 2, 3, 4].map((j) => spline(keys, t, j));
  return { swing: at(LEG_KEYS[kind]), support: at(SUPPORT_KEYS[kind]), w, ws: w * SUPPORT_W[kind] };
}

// { pelvis, shoulders, lean, bend, free: [abd, flex, elbow], kick: [abd, flex, elbow], w, wa } in
// radians, the whole-body layer of leg action kind at t for a right-foot kick (signs as BODY_KEYS),
// with the leg's weight w and the arms' wa.
export function bodyPose(kind, t) {
  const v = [1, 2, 3, 4, 5, 6, 7, 8].map((j) => spline(BODY_KEYS[kind], t, j)), e = ELBOW.map((d) => (d * Math.PI) / 180);
  const w = actionW(kind, t);
  return { pelvis: v[0], shoulders: v[1], lean: v[2], bend: v[3], free: [v[4], v[5], e[0]], kick: [v[6], v[7], e[1]], w, wa: w * ARM_W[kind] };
}

// seeded 0..1 draws (mulberry32): the skills a player plays are the same on every run
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
