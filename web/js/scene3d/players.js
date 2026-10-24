// Player animation and the root of each player.
//
// Drivers. Every module that wants to place or turn a player, or ask for a clip, is a driver:
// an object with pose(i, ts) -> null | {
//   dx, dy       metres added to the tracking position (contract axes), e.g. the ball rig's
//                 offset that puts the foot on the ball;
//   dz, roll     metres the body is lifted and its roll (radians about the facing axis, the
//                 holder's rotation.z), summed over the drivers: a keeper's dive (keeper3d.js);
//   yaw, yawW    a facing (radians, atan2(dx, dy) on the pitch) and how much of it to take (0..1);
//   leg          a leg pose for the ball rig (ball3d-rig.js);
//   mode         locomotion mode: "forward" (default), "backpedal", "strafe" or "jockey";
//   emotion      {clip, t, weight, upper}: any clip of the player file played at t seconds, on
//                 the upper body only when upper is true (celebration, dejection) }.
// pose() must be a pure function of (i, ts): the scene asks it at ts and at ts +- 0.05 s (VEL_H).
// Drivers run in priority order, low first; a later facing is blended over the earlier ones and
// the last mode and emotion win. The scene's own drivers: awareness modules 10 (suggested), the
// ball rig 20, the event actions below and the keeper reactions 30 (a slide turns the body to its event point and
// switches the rig's leg pose off while the clip moves the legs).
//
// Clips are sampled with goToFrame from match time, never played. The locomotion phase and the
// clip weights (p.phase, p.lphase, p.ws) integrate dt, so a frame shows the same pose only when it
// is reached by the same sequence of frames: the capture and the stills always set the clock in
// order from a fixed start; a seek in the page can show another stride phase. Action and emotion
// clips are cloned for a player the first time they are needed: idle clips cost animation time
// every frame in Babylon. Only clips with a weight above 0 are sampled: when the first two blended
// values both weigh 0, Babylon divides by zero and the bone turns NaN. Upper-body emotions are not clips at all but a pass after the
// animation step (applyUpper): Babylon clamps an animatable's weight to 1, so a masked clip could
// only blend half way over the locomotion.
const B = window.BABYLON;

// Locomotion clips of the Universal Animation Library: speed (m/s) at which the feet do not
// slide when the clip plays at 1x, and metres per cycle. Measured on the scaled player in the
// scene, as the planted toe's travel per cycle (docs/flow3d.md): the root-motion figures (1.3,
// 5.0, 5.5 m) were for the unscaled file and left the feet sliding about 10% of the speed.
// The jog stride was measured again on the anime player (22/10, docs/flow3d.md): 5.0 m by the
// median slide; its speed, which only places the blend between the loops, stays as measured.
export const LOCO = [
  { name: "Idle_Loop", speed: 0, stride: 0, period: 2.5 },
  { name: "Walk_Loop", speed: 0.93, stride: 1.24 },
  { name: "Jog_Fwd_Loop", speed: 5.9, stride: 5.0 },
  { name: "Sprint_Loop", speed: 9.0, stride: 6.0 },
];
const BLEND_S = 0.08;   // s, time constant of the locomotion weights: no one-frame pops

// People step faster than the loops: [ground speed m/s, steps per second] (docs/flow3d.md section
// 6: PMC3756042, PMC3022995, jssm.org table 2, PMC12047830). The first point is the walk loop at
// its own stride, so slow walks keep the clip as it is.
const CADENCE = [[0.93, 1.5], [1.51, 1.91], [2.9, 2.88], [4.15, 2.88], [5.07, 3.04], [7.32, 3.6], [8.8, 4.58]];
const WARP_MIN = 0.6;   // the leg swing is never cut below 60% of the clip's
// Metres per cycle (two steps) a person runs at ground speed v; null below the table (clip stride).
export function humanStride(v) {
  if (v <= CADENCE[0][0]) return null;
  let k = 0;
  while (k < CADENCE.length - 2 && v > CADENCE[k + 1][0]) k++;
  const [[a, fa], [b, fb]] = [CADENCE[k], CADENCE[k + 1]];
  return (2 * v) / (fa + (fb - fa) * Math.min(1, (v - a) / (b - a)));
}

// Weights of the four clips for a ground speed (two neighbours at a time, summing to 1).
export function clipWeights(v) {
  const w = [0, 0, 0, 0];
  if (v >= LOCO[3].speed) { w[3] = 1; return w; }
  for (let i = 0; i < 3; i++) {
    const a = LOCO[i].speed, b = LOCO[i + 1].speed;
    if (v < b) { const t = Math.max(0, (v - a) / (b - a)); w[i] = 1 - t; w[i + 1] = t; return w; }
  }
  return w;
}

// The UAL Standard packs have no backwards or sideways runs, so the modes are stand-ins built
// from the forward clips: backpedal plays them in reverse, strafe and jockey shorten the step
// (jockey also caps the speed at a walk-to-jog blend). Speed scale and cycle direction:
const MODE_GAIT = { forward: [1, 1], backpedal: [1.25, -1], strafe: [1.4, 1], jockey: [1.8, -1] };
export function gait(mode, v) {
  const [k, dir] = MODE_GAIT[mode] ?? MODE_GAIT.forward;
  const vv = mode === "jockey" ? Math.min(v * k, 3) : v * k;
  return { w: clipWeights(vv), dir, v: vv };
}

// Actions from the events: clip phases [clip, from s, to s] played back to back, and the moment
// of contact (seconds from the start) that lines up with the event time.
export const ACTIONS = {
  slide: { phases: [["Slide_Start", 0, 0.83], ["Slide_Loop", 0, 0.35], ["Slide_Exit", 0, 0.5]], contact: 0.7 },
  header: { phases: [["Jump_Start", 0.5, 1.33], ["Jump_Land", 0, 0.9]], contact: 0.8 },
  // the fouled player goes down and rolls over, from 0.1 s after the contact
  tumble: { phases: [["Roll", 0, 1.47]], contact: -0.1 },
};
const IN_S = 0.15, OUT_S = 0.25;
const TRACKS = new WeakMap();   // asset container -> {clip: upper-body tracks}
const UPPER = /^(spine_0[23]|neck_01|Head|clavicle_[lr]|upperarm_[lr]|lowerarm_[lr]|hand_[lr])$/;
const length = (a) => a.phases.reduce((s, [, f, t]) => s + t - f, 0);
const WARNED = new Set();   // clips asked for that the player file lacks: one warning each
const missing = (name) => { if (!WARNED.has(name)) { WARNED.add(name); console.warn(`3D: no clip ${name} in the player file`); } return null; };
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

// Per player id, the actions the events call for: [{kind, start, end, at}], sorted, never
// overlapping (a later action cuts the earlier one short). `at` is the event's pitch point.
export function scheduleActions(events) {
  const out = {};
  const add = (pid, kind, ts, at) => {
    const a = ACTIONS[kind], start = ts - a.contact;
    (out[pid] ??= []).push({ kind, start, end: start + length(a), at });
  };
  for (const e of events) {
    if (!e.player_id) continue;
    const at = [e.start_x, e.start_y];
    if (e.type_name === "tackle" || e.type_name === "foul") add(e.player_id, "slide", e.ts, at);
    else if (e.bodypart_name === "head") add(e.player_id, "header", e.ts, at);
    if (e.type_name === "foul" && e.related_player_id) add(e.related_player_id, "tumble", e.ts, at);
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < list.length; i++) list[i].end = Math.min(list[i].end, list[i + 1].start);
  }
  return out;
}

// The action playing at ts: the action, its weight (eased in and out), clip and clip time.
export function actionAt(list, ts) {
  if (!list) return null;
  for (const act of list) {
    if (ts < act.start || ts >= act.end) continue;
    const a = ACTIONS[act.kind];
    let u = ts - act.start;
    const w = Math.max(0, Math.min(1, u / IN_S, (act.end - ts) / OUT_S));
    for (let k = 0; k < a.phases.length; k++) {
      const [clip, f, t] = a.phases[k];
      if (u < t - f || k === a.phases.length - 1) return { act, clip, time: Math.min(f + u, t), weight: w };
      u -= t - f;
    }
  }
  return null;
}

// The event actions as a driver (priority 30). match: for the tracking point of the player.
export function actionDriver(match, schedule) {
  return {
    priority: 30,
    pose(i, ts) {
      const a = actionAt(schedule[match.meta.entities[i]], ts);
      if (!a) return null;
      const out = { action: a, actionW: a.weight };
      const here = match.at(i, ts);
      const dx = a.act.at[0] - (here?.[0] ?? 0), dy = a.act.at[1] - (here?.[1] ?? 0);
      if (a.act.kind === "slide" && here && Math.hypot(dx, dy) > 0.5) {
        out.yaw = Math.atan2(dx, dy); out.yawW = a.weight;
      }
      return out;
    },
  };
}

// Throw-ins (Laws of the Game, Law 15: both hands, from behind and over the head, facing the
// field). The taker picks the ball up once he reaches it and slows down (a crouch, THROW.crouch,
// with the body drawn to the ball), carries it at his chest (THROW.carry held at carryT) while the
// tracking walks him to the spot, then raises it over his head (THROW.clip, from lift to up) and
// throws on the event time. A Premier League throw-in waits 15 to 18 s on average
// (docs/flow3d.md, section 5): the wait is the tracking's, the ball is in his hands for it. The
// scene puts the ball between the hands (throwBall). Times: start, raise, end are seconds from
// the throw; down, grab, rise from the pick-up.
export const THROW = {
  clip: "M_celeb_arms_up", lift: 0.55, up: 1.1, start: -1.6, raise: 0.7, end: 0.45,
  carry: "GK_Catch", carryT: 1.6, crouch: "M_crouch_head_down", crouchT: 0.5,
  down: 0.45, grab: 0.15, rise: 0.45,
  near: 1.2,     // m: the taker has reached the ball
  walk: 2.4, still: 1.2,   // m/s: his tracking speed in the second before the pick-up, and through the crouch
  after: 0.35,   // s from reaching the ball to the bottom of the crouch
  look: 30,      // s: how far back the reach is looked for
  reach: 0.35,   // m in front of the body where the hands meet the ball on the grass
  drawIn: 0.75, drawHold: 0.3, drawOut: 1.2,   // s: the draw to the ball eases in from the window's start, holds, eases out
};
const smooth01 = (u) => { const t = Math.min(1, Math.max(0, u)); return t * t * (3 - 2 * t); };

// Per player id, [{ts, yaw, pick, ball}] of his throw-ins: yaw towards where the ball goes, pick
// the time his hands close on the ball, ball where it lies then ([x, y], null without positions).
// match: positions (match.at, match.index) to find when the taker reaches the ball standing at the
// line and has slowed down; without them, or when he never does, the pick-up comes just before
// the raise, where he stands (ball null: no draw).
export function scheduleThrows(events, match = null) {
  const out = {};
  for (const e of events) {
    if (e.type_name !== "throw_in" || !e.player_id) continue;
    const latest = e.ts + THROW.start - THROW.rise - 0.1;
    let pick = latest, ball = null;
    const i = match?.index?.[e.player_id];
    if (i !== undefined) {
      const at = (t) => {
        const p = match.at(i, t), b = match.at(0, t), b2 = match.at(0, t + 0.1);
        if (!p || !b || !b2) return false;
        // the ball lies still at the line and he stands at it
        return Math.hypot(b[0] - e.start_x, b[1] - e.start_y) < 1.5 && Math.hypot(b2[0] - b[0], b2[1] - b[1]) < 0.05 && Math.hypot(p[0] - b[0], p[1] - b[1]) < THROW.near;
      };
      // and has slowed down: at most a walk for the second before the pick-up, nearly still through
      // the crouch (so the crouch stays full body, and the body never moves 5 cm in a 60 Hz frame)
      const speed = (t) => { const a = match.at(i, t - 0.05), c = match.at(i, t + 0.05); return a && c ? Math.hypot(c[0] - a[0], c[1] - a[1]) / 0.1 : Infinity; };
      const calm = (t) => { for (let s = t - 1; s <= t + THROW.rise; s += 0.05) if (speed(s) > (s < t - THROW.down ? THROW.walk : THROW.still)) return false; return true; };
      let first = null;
      for (let t = latest; t > e.ts - THROW.look && at(t); t -= 0.1) first = t;
      for (let t = first ?? Infinity; t <= latest; t += 0.05) {
        if (t < first + THROW.after || !at(t) || !calm(t)) continue;
        const b = match.at(0, t);
        pick = t; ball = [b[0], b[1]];
        break;
      }
    }
    (out[e.player_id] ??= []).push({ ts: e.ts, yaw: Math.atan2(e.end_x - e.start_x, e.end_y - e.start_y), pick, ball });
  }
  return out;
}

// The throw holding ts: {t, u: seconds from the release (negative before), p: seconds from the
// pick-up}, or null.
export function throwAt(list, ts) {
  for (const t of list ?? []) if (ts >= t.pick - THROW.down && ts < t.ts + THROW.end) return { t, u: ts - t.ts, p: ts - t.pick };
  return null;
}

// The throw-ins as a driver (priority 30): down to the ball, up with it at the chest, arms over
// the head facing the throw.
export function throwDriver(match, schedule) {
  return {
    priority: 30,
    pose(i, ts) {
      const a = throwAt(schedule[match.meta.entities[i]], ts);
      if (!a) return null;
      const { t: T, u, p } = a, out = { leg: null };
      // the arms: the carry from the pick-up, crossfaded into the raise, which fades after the release
      const carry = { clip: THROW.carry, t: THROW.carryT, weight: smooth01((p + THROW.grab) / 0.4) };
      if (u < THROW.start) out.emotion = { kind: "throw", ...carry, upper: true };
      else {
        const t = THROW.lift + Math.min(1, (u - THROW.start) / THROW.raise) * (THROW.up - THROW.lift);
        const w = Math.max(0, Math.min(1, (THROW.end - u) / THROW.end));
        out.emotion = { kind: "throw", clip: THROW.clip, t, weight: w * smooth01((u - THROW.start) / 0.3), upper: true, under: { ...carry, weight: carry.weight * w } };
      }
      // the crouch: full body while he picks the ball up, eased in and out
      const wc = smooth01((p + THROW.down) / 0.3) * (1 - smooth01((p - THROW.rise + 0.3) / 0.3));
      if (wc > 0) out.emotion = { kind: "throw", clip: THROW.crouch, t: THROW.crouchT, weight: wc, full: true, under: carry };
      // drawn to the ball so his hands meet it, facing it; then the facing of the throw
      const here = match.at?.(i, ts);
      // from the window's first frame (no jump), capped at THROW.near, and slow: from within
      // THROW.near it adds under 3 cm a frame at 60 Hz to his own walk
      const wb = smooth01((p + THROW.down) / THROW.drawIn) * (1 - smooth01((p - THROW.drawHold) / THROW.drawOut));
      if (T.ball && here && wb > 0) {
        const dx = T.ball[0] - here[0], dy = T.ball[1] - here[1], d = Math.hypot(dx, dy);
        if (d > 1e-3) {
          const k = (Math.min(THROW.near, Math.max(0, d - THROW.reach)) / d) * wb;
          out.dx = dx * k; out.dy = dy * k;
          out.yaw = Math.atan2(dx, dy); out.yawW = wb;
        }
      }
      const wy = smooth01((u - THROW.start + 0.5) / 0.4) * Math.max(0, Math.min(1, (THROW.end - u) / THROW.end));
      if (wy > (out.yawW ?? 0)) { out.yaw = T.yaw; out.yawW = wy; }
      return out;
    },
  };
}

// Combine the drivers' answers for player i at ts (drivers sorted by priority). The facing
// overrides come back as turns, applied over the scene's own facing with facing().
export function resolve(drivers, i, ts) {
  const out = { dx: 0, dy: 0, dz: 0, roll: 0, turns: [], leg: null, mode: "forward", emotion: null, action: null, actionW: 0 };
  for (const d of drivers) {
    const p = d.pose(i, ts);
    if (!p) continue;
    out.dx += p.dx ?? 0; out.dy += p.dy ?? 0; out.dz += p.dz ?? 0; out.roll += p.roll ?? 0;
    if (p.yawW > 0) out.turns.push([p.yaw, Math.min(1, p.yawW)]);
    if (p.leg !== undefined) out.leg = p.leg;
    if (p.mode) out.mode = p.mode;
    if (p.emotion) out.emotion = p.emotion;
    if (p.action) { out.action = p.action; out.actionW = p.actionW; }
  }
  if (out.actionW > 0) out.leg = null;   // the clip moves the legs itself
  return out;
}

// The facing the scene gives player p before the drivers' turns (radians, atan2(dx, dy)): his run
// once faster than RUN_ON m/s, until he slows under RUN_OFF (away from it when backpedalling);
// nearly still, the ball unless it is at his feet, where its bearing swings at random, and there
// the facing he had. A seek (dt 0) decides from this frame alone, the ball's bearing even at his
// feet (the centre spot without a ball), so what it shows is a function of match time.
// v, vx, vy: his ground speed; at: where he is shown; ball: [x, y] or null.
const RUN_ON = 0.9, RUN_OFF = 0.5;
export function wantFacing(p, { v, vx, vy, mode, ball, at, dt }) {
  const seek = !(dt > 0);
  p.running = v > (seek ? 0.7 : p.running ? RUN_OFF : RUN_ON);
  if (seek) p.want = null;
  const d = ball ? Math.hypot(ball[0] - at[0], ball[1] - at[1]) : 0;
  let want = null;
  if (p.running) want = Math.atan2(vx, vy) + (mode === "backpedal" ? Math.PI : 0);
  else if (ball && (d > 1 || (seek && d > 1e-3))) want = Math.atan2(ball[0] - at[0], ball[1] - at[1]);
  else if (seek) want = Math.atan2(52.5 - at[0], 34 - at[1]);
  if (Number.isFinite(want)) p.want = want;
  return p.want ?? p.yaw ?? 0;
}

export function facing(base, turns) {
  let y = base;
  for (const [yaw, w] of turns) y += angleDiff(y, yaw) * w;
  return y;
}

// Sum of the drivers' position offsets for player i at ts (contract metres).
export function offset(drivers, i, ts) {
  let dx = 0, dy = 0;
  for (const d of drivers) { const p = d.pose(i, ts); if (p) { dx += p.dx ?? 0; dy += p.dy ?? 0; } }
  return [dx, dy];
}

// Paused locomotion groups of one instantiated player, and a lazy cache for every other clip of
// the file. container: the asset container the player was instantiated from; prefix: the name
// prefix of its nodes.
export function setupAnimations(inst, container, prefix) {
  const prep = (g, w = 0) => { g.start(true, 1, g.from, g.to); g.pause(); g.setWeightForAllAnimatables(w); return g; };
  const loco = LOCO.map((c) => prep(inst.animationGroups.find((a) => a.name.endsWith(c.name))));
  for (const g of inst.animationGroups) if (!loco.includes(g)) g.dispose();
  const nodes = new Map();
  for (const root of inst.rootNodes) for (const n of [root, ...root.getDescendants(false)]) nodes.set(n.name, n);
  const cache = {};
  const fps = loco[0].targetedAnimations[0].animation.framePerSecond;
  if (!TRACKS.has(container)) TRACKS.set(container, {});
  const tracks = TRACKS.get(container);
  // the legs of the walk, jog and sprint loops: each bone's node and its mean pose over the cycle
  const legs = [];
  for (const name of WARP_BONES) {
    const node = nodes.get(`${prefix}${name}`);
    if (!node?.rotationQuaternion) continue;
    const means = loco.slice(1).map((g) => {
      const ta = g.targetedAnimations.find((t) => t.target === node && t.animation.targetProperty === "rotationQuaternion");
      return ta ? cycleMean(ta.animation, g.from, g.to) : null;
    });
    if (means.every(Boolean)) legs.push({ node, means });
  }
  return {
    loco, fps, cache, legs,
    node: (name) => nodes.get(`${prefix}${name}`),
    // the group for clip `name`, or null when the file lacks it
    get(name) {
      if (name in cache) return cache[name];
      const src = container.animationGroups.find((a) => a.name === name);
      if (!src) return (cache[name] = missing(name));
      return (cache[name] = prep(src.clone(`${prefix}${name}`, (t) => nodes.get(`${prefix}${t.name}`) ?? t)));
    },
    // the upper-body rotation tracks of clip `name` (shared by all players of the file)
    upper(name) {
      if (name in tracks) return tracks[name];
      return (tracks[name] = upperTracks(container, name) ?? missing(name));
    },
  };
}

// Retargeted motion clips (web/vendor/motion, docs/motion3d.md): added to the player container's
// clips so the lazy cache and the awareness layer find them by name. s.motion = clips.json.
export async function loadMotion(s, base = "vendor/motion/") {
  const [meta, c] = await Promise.all([
    fetch(`${base}clips.json`).then((r) => { if (!r.ok) throw new Error(`clips.json ${r.status}`); return r.json(); }),
    B.LoadAssetContainerAsync(`${base}clips.glb`, s.scene),
  ]);
  for (const g of c.animationGroups) { g.stop(); s.container.animationGroups.push(g); }
  s.motion = meta;
  return meta;
}

// The motion loop for a non-forward mode, from the run direction in the character's frame
// (runL: [left, forward] unit vector): backpedal and strafe take the loop whose travel matches
// best, jockey its shuffle. null when the clips are not loaded (the stand-in gaits then play).
// prev, the loop playing, keeps a bonus of LOOP_HOLD on the match: about 14 degrees past the
// diagonal between two loops before the other takes over (animatePlayer cross-fades them).
const LOOPS = ["M_jog_backward", "M_sidestep_left", "M_sidestep_right"];
const LOOP_HOLD = 0.35, LOOP_FADE = 0.15;   // dot-product bonus; s, time constant of the cross-fade
export function motionLoop(motion, mode, runL, prev = null) {
  if (!motion || mode === "forward") return null;
  if (mode === "jockey") return motion.clips.M_jockey_shuffle ? "M_jockey_shuffle" : null;
  let best = null, bd = -Infinity;
  for (const n of LOOPS) {
    const c = motion.clips[n];
    if (!c) continue;
    const d = (n === prev ? LOOP_HOLD : 0) + (runL ? c.dir[0] * runL[0] + c.dir[1] * runL[1] : (n === "M_jog_backward") === (mode === "backpedal") ? 1 : 0);
    if (d > bd) { bd = d; best = n; }
  }
  return best;
}

// {from, list: [[bone, animation]]} of a clip's upper-body rotations, or null without the clip.
function upperTracks(container, name) {
  const g = container.animationGroups.find((a) => a.name === name);
  if (!g) return null;
  const list = g.targetedAnimations.filter((t) => t.animation.targetProperty === "rotationQuaternion" && UPPER.test(t.target.name));
  return { from: g.from, list: list.map((t) => [t.target.name, t.animation]) };
}

// Stride warping (Unreal's pose warping, docs/flow3d.md section 6): the leg bones of the forward
// loops are pulled towards their mean pose over the cycle by the stride ratio s, so the swing
// shrinks with the faster cycle. Hips and knees by s, the ankles left alone: on M001 the jog's
// planted foot then slides 0.059 m a step at the median, against 0.050 m unwarped (less at p95);
// knees by 0, 0.5 or 1.5 of it slid 0.139, 0.094 and 0.109 m (docs/flow3d.md section 6). Runs
// after the animation step and before the ball rig's leg actions and grounding (Scene3D adds it
// first).
const WARP_BONES = ["thigh_l", "thigh_r", "calf_l", "calf_r"];
const WARP_N = 32;   // samples of the cycle for the mean pose
const MEANS = new WeakMap();   // animation -> its mean quaternion over its group's [from, to)
function cycleMean(a, from, to) {
  const got = MEANS.get(a);
  if (got) return got;
  const m = new B.Quaternion(0, 0, 0, 0);
  let first = null;
  for (let j = 0; j < WARP_N; j++) {
    const q = a.evaluate(from + ((to - from) * j) / WARP_N);
    first ??= q.clone();
    const sg = B.Quaternion.Dot(first, q) < 0 ? -1 : 1;
    m.x += sg * q.x; m.y += sg * q.y; m.z += sg * q.z; m.w += sg * q.w;
  }
  m.normalize();
  MEANS.set(a, m);
  return m;
}
let qm = null;
export function warpStride(p) {
  const W = p.warp;
  if (!W || !p.holder.isEnabled()) return;
  qm ??= new B.Quaternion();
  const [, w1, w2, w3] = W.w, n = w1 + w2 + w3;
  for (const { node, means: [a, b, c] } of p.anim.legs) {
    // the loops' means blended by their weights (they lie a few degrees apart)
    const sb = B.Quaternion.Dot(a, b) < 0 ? -1 : 1, sc = B.Quaternion.Dot(a, c) < 0 ? -1 : 1;
    qm.set((w1 * a.x + sb * w2 * b.x + sc * w3 * c.x) / n, (w1 * a.y + sb * w2 * b.y + sc * w3 * c.y) / n,
      (w1 * a.z + sb * w2 * b.z + sc * w3 * c.z) / n, (w1 * a.w + sb * w2 * b.w + sc * w3 * c.w) / n).normalize();
    B.Quaternion.SlerpToRef(qm, node.rotationQuaternion, 1 - (1 - W.s) * W.g, node.rotationQuaternion);
  }
}

// After the animation step: the upper-body emotion of player p at its full weight, over the one
// it fades from (e.under: the throw-in's carry under the raise).
export function applyUpper(p) {
  const e = p.upper;
  if (!e || !p.holder.isEnabled()) return;
  for (const x of e.under?.weight > 0 ? [e.under, e] : [e]) {
    const T = p.anim.upper(x.clip);
    if (!T) continue;
    const f = T.from + Math.max(0, x.t) * p.anim.fps;
    for (const [bone, a] of T.list) {
      const n = p.anim.node(bone);
      if (n?.rotationQuaternion) B.Quaternion.SlerpToRef(n.rotationQuaternion, a.evaluate(f), x.weight, n.rotationQuaternion);
    }
  }
}

// After the animation step: a run loop's flight phase lifts both feet well clear of the grass
// while the contact shadow stays on it, so the runner seemed to float. A player on the ground
// (p.free: no action, no ball contact, no lift) drops until his lower ankle is FLIGHT_MAX up, but
// never further than his lowest sole point (sole, metres above the grass, from the ball rig's
// grounding): at the jog's toe-off the foot points 77 to 89 degrees down and its tip is 0.23 m
// below the ankle, so an ankle-only drop put the toes 3.3 cm into the grass (docs/flow3d.md).
// shortcut: lowers the whole body instead of retiming the loops' flight, fine at broadcast range.
const FLIGHT_MAX = 0.2;   // m: the ankle bone stands about 0.1 m up
export function settleFeet(p, sole = Infinity) {
  if (!p.free) return;
  let low = Infinity;
  for (const name of ["foot_l", "foot_r"]) {
    const c = [];
    for (let n = p.anim.node(name); n; n = n.parent) c.unshift(n);
    if (!c.length) return;
    c.forEach((n) => n.computeWorldMatrix(true));
    low = Math.min(low, c.at(-1).getAbsolutePosition().y);
  }
  const drop = Math.min(low - FLIGHT_MAX, sole);
  if (drop > 0) p.holder.position.y -= drop;
}

// One frame of animation for player p (ground speed v m/s, dt match seconds since the last
// frame) from the resolved driver answers r. r.runL: the run direction in the character's frame
// (motion loops). motion: the loaded clips.json, or null for the procedural stand-ins. p.h: the
// player's height over the measured one (Scene3D scales his body by it, so his strides too).
export function animatePlayer(p, v, dt, r, motion = null) {
  let full = r.action ? r.actionW : 0;
  const e = r.emotion, h = p.h ?? 1;
  // a full-body clip (crouch, knee slide) only while the player is nearly still; running, it is
  // upper body only so the legs keep the locomotion (the tracking owns the root)
  // (the tracking's speed, r.vTrack: a driver drawing him to the ball does not count)
  const still = !r.action && (r.vTrack ?? v) < 1.5;
  const eFull = !!(e && e.full && still);
  // a chained emotion fading in over the one before (awareness.js, under.fadeOut): a full-body clip
  // before keeps the legs it covers until this one is in
  const hand = e?.under?.fadeOut ? e.under : null;
  const uw = hand?.full && still ? hand.weight * (1 - e.weight) : 0;
  if (eFull || uw > 0) full = Math.max(full, (eFull ? e.weight : 0) + uw);
  const loop = motionLoop(motion, r.mode, r.runL, p.loop);
  const lm = loop && motion.clips[loop];
  let wl = 0;
  if (lm) {
    // the loop's phase follows the ground speed (no foot slide at its own speed); the jockey
    // shuffle keeps stepping when nearly still
    const jockey = loop === "M_jockey_shuffle";
    const rate = jockey ? Math.min(1.5, Math.max(0.6, v / Math.max(lm.speed * h, 0.3))) / lm.len : v / Math.max(lm.stride * h, 0.3);
    p.lphase = ((p.lphase ?? 0) + rate * dt) % 1;
    wl = jockey ? 1 : Math.min(1, v / 0.8);
  }
  const { w: goal, dir, v: vv } = gait(lm ? "forward" : r.mode, v);
  if (wl > 0) for (let j = 0; j < 4; j++) goal[j] *= 1 - wl;
  // the weights (four loops and the motion loop) ease towards the gait's, so a mode switch or a
  // speed spike blends over a few frames; they keep summing to 1
  const k = dt > 0 ? 1 - Math.exp(-dt / BLEND_S) : 1;
  const w = p.ws = goal.map((g, j) => (p.ws ? p.ws[j] + (g - p.ws[j]) * k : g));
  if (lm) p.loop = loop;
  wl = p.wl = p.wl === undefined || k === 1 ? wl : p.wl + (wl - p.wl) * k;
  // the motion loops' shares of wl: the one picked eases in over LOOP_FADE and the others out, so
  // a change of loop is a cross-fade; a seek, or the loops faded out, start from the one picked
  const kl = dt > 0 ? 1 - Math.exp(-dt / LOOP_FADE) : 1;
  p.lw ??= {};
  if (kl === 1 || wl < 1e-3) for (const n in p.lw) delete p.lw[n];   // no allocation per frame
  if (p.loop && wl >= 1e-3) {
    let sum = 0;
    p.lw[p.loop] ??= 0;
    for (const n in p.lw) sum += p.lw[n] += ((n === p.loop ? 1 : 0) - p.lw[n]) * kl;
    for (const n in p.lw) if ((p.lw[n] /= sum) < 1e-3) delete p.lw[n];
  }
  const moving = w[1] + w[2] + w[3];
  const stride = h * (moving > 0 ? (w[1] * LOCO[1].stride + w[2] * LOCO[2].stride + w[3] * LOCO[3].stride) / moving : 1);
  // stride warping, forward runs only: the cycle runs at a person's cadence and warpStride swings
  // the legs by the same ratio, so the planted foot still moves back at the ground speed. The
  // forward share fw eases like the weights, so leaving or entering "forward" fades the warp
  // (and the cadence with it) instead of dropping it in a frame; no leg bones, no warp.
  const human = r.mode === "forward" && moving > 0 ? h * humanStride(vv) : null;   // a taller player strides further
  if (r.mode === "forward") p.warpS = human ? Math.max(WARP_MIN, Math.min(1, human / stride)) : 1;
  const fw = p.fw = (p.fw ?? 0) + ((r.mode === "forward" ? 1 : 0) - (p.fw ?? 0)) * k;
  const s = p.anim.legs?.length && p.warpS ? 1 - (1 - p.warpS) * fw : 1;
  p.phase = (((p.phase + dir * (vv / (stride * s)) * dt) % 1) + 1) % 1;
  p.warp = s < 1 ? { s, g: moving * (1 - full) * (1 - wl), w } : null;
  p.idle = (p.idle + dt / LOCO[0].period) % 1;
  p.anim.loco.forEach((g, j) => {
    const wj = w[j] * (1 - full);
    if (wj !== p.w[j]) g.setWeightForAllAnimatables(wj);
    p.w[j] = wj;
    if (wj > 0) g.goToFrame(g.from + (j === 0 ? p.idle : p.phase) * (g.to - g.from), true);
  });
  // clips other than locomotion: only the ones asked for this frame carry weight
  const want = new Map();
  if (r.action) want.set(r.action.clip, [r.action.time, r.action.weight]);
  // the motion loops by their shares (wl fades the last one out)
  if (wl > 1e-3) for (const n in p.lw) if (p.anim.get(n)) want.set(n, [p.lphase * motion.clips[n].len, wl * p.lw[n] * (1 - full)]);
  // an upper-body emotion waits for applyUpper; a full-body one is a clip like the actions (a
  // full-body motion clip only while nearly still, eFull; otherwise its upper body)
  const up = !!e?.upper && !eFull;
  p.upper = up && e.weight * (1 - full) > 0 ? { clip: e.clip, t: e.t, weight: Math.min(1, e.weight * (1 - full)), under: e.under } : null;
  // a full-body emotion fading in over a chained one: its upper body over the other's
  if (!p.upper && hand && eFull && e.weight > 0) p.upper = { clip: e.clip, t: e.t, weight: Math.min(1, e.weight), under: hand };
  // the arms' pose under a full-body emotion or a raise not yet started (the throw-in's carry)
  else if (!p.upper && e?.under?.weight > 0) p.upper = { clip: e.under.clip, t: e.under.t, weight: Math.min(1, e.under.weight) };
  if (e && !up && p.anim.get(e.clip)) want.set(e.clip, [e.t, eFull ? e.weight : e.weight * (1 - full)]);
  if (uw > 0 && p.anim.get(hand.clip)) want.set(hand.clip, [hand.t, uw]);
  if (r.action) p.anim.get(r.action.clip);
  for (const [key, g] of Object.entries(p.anim.cache)) {
    if (!g) continue;
    const [t, wa] = want.get(key) ?? [0, 0];
    if (wa !== (p.aw[key] ?? 0)) g.setWeightForAllAnimatables(wa);
    p.aw[key] = wa;
    if (wa > 0) g.goToFrame(Math.min(g.to, g.from + Math.max(0, t) * p.anim.fps), true);
  }
  if (p.upper) p.aw[`${p.upper.clip}^`] = p.upper.weight;   // what the tests read
  for (const k of Object.keys(p.aw)) if (k.endsWith("^") && (!p.upper || k !== `${p.upper.clip}^`)) p.aw[k] = 0;
}
