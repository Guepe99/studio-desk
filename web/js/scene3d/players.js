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
// pose() must be a pure function of (i, ts): the scene asks it at ts and at ts +- 0.2 s.
// Drivers run in priority order, low first; a later facing is blended over the earlier ones and
// the last mode and emotion win. The scene's own drivers: awareness modules 10 (suggested), the
// ball rig 20, the event actions below and the keeper reactions 30 (a slide turns the body to its event point and
// switches the rig's leg pose off while the clip moves the legs).
//
// Clips are sampled with goToFrame from match time, never played, so a seek, a replay or a video
// frame always shows the same pose. Action and emotion clips are cloned for a player the first
// time they are needed: idle clips cost animation time every frame in Babylon. Only clips with a
// weight above 0 are sampled: when the first two blended values both weigh 0, Babylon divides by
// zero and the bone turns NaN. Upper-body emotions are not clips at all but a pass after the
// animation step (applyUpper): Babylon clamps an animatable's weight to 1, so a masked clip could
// only blend half way over the locomotion.
const B = window.BABYLON;

// Locomotion clips of the Universal Animation Library: speed (m/s) at which the feet do not
// slide when the clip plays at 1x, and metres per cycle. Measured on the scaled player in the
// scene, as the planted toe's travel per cycle (docs/flow3d.md): the root-motion figures (1.3,
// 5.0, 5.5 m) were for the unscaled file and left the feet sliding about 10% of the speed.
export const LOCO = [
  { name: "Idle_Loop", speed: 0, stride: 0, period: 2.5 },
  { name: "Walk_Loop", speed: 0.93, stride: 1.24 },
  { name: "Jog_Fwd_Loop", speed: 5.9, stride: 5.5 },
  { name: "Sprint_Loop", speed: 9.0, stride: 6.0 },
];
const BLEND_S = 0.08;   // s, time constant of the locomotion weights: no one-frame pops
export const MODES = ["forward", "backpedal", "strafe", "jockey"];

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
};
const IN_S = 0.15, OUT_S = 0.25;
const TRACKS = new WeakMap();   // asset container -> {clip: upper-body tracks}
const UPPER = /^(spine_0[23]|neck_01|Head|clavicle_[lr]|upperarm_[lr]|lowerarm_[lr]|hand_[lr])$/;
const length = (a) => a.phases.reduce((s, [, f, t]) => s + t - f, 0);
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
  return {
    loco, fps, cache,
    node: (name) => nodes.get(`${prefix}${name}`),
    // the group for clip `name`, or null when the file lacks it
    get(name) {
      if (name in cache) return cache[name];
      const src = container.animationGroups.find((a) => a.name === name);
      if (!src) return (cache[name] = null);
      return (cache[name] = prep(src.clone(`${prefix}${name}`, (t) => nodes.get(`${prefix}${t.name}`) ?? t)));
    },
    // the upper-body rotation tracks of clip `name` (shared by all players of the file)
    upper(name) {
      if (name in tracks) return tracks[name];
      return (tracks[name] = upperTracks(container, name));
    },
  };
}

// {from, list: [[bone, animation]]} of a clip's upper-body rotations, or null without the clip.
function upperTracks(container, name) {
  const g = container.animationGroups.find((a) => a.name === name);
  if (!g) return null;
  const list = g.targetedAnimations.filter((t) => t.animation.targetProperty === "rotationQuaternion" && UPPER.test(t.target.name));
  return { from: g.from, list: list.map((t) => [t.target.name, t.animation]) };
}

// After the animation step: the upper-body emotion of player p at its full weight.
export function applyUpper(p) {
  const e = p.upper;
  if (!e || !p.holder.isEnabled()) return;
  const T = p.anim.upper(e.clip);
  if (!T) return;
  const f = T.from + Math.max(0, e.t) * p.anim.fps;
  for (const [bone, a] of T.list) {
    const n = p.anim.node(bone);
    if (n?.rotationQuaternion) B.Quaternion.SlerpToRef(n.rotationQuaternion, a.evaluate(f), e.weight, n.rotationQuaternion);
  }
}

// One frame of animation for player p (ground speed v m/s, dt match seconds since the last
// frame) from the resolved driver answers r.
export function animatePlayer(p, v, dt, r) {
  const full = r.action ? r.actionW : 0;
  const { w: goal, dir, v: vv } = gait(r.mode, v);
  // the weights ease towards the gait's, so a mode switch or a speed spike blends over a few frames
  const k = dt > 0 ? 1 - Math.exp(-dt / BLEND_S) : 1;
  const w = p.ws = goal.map((g, j) => (p.ws ? p.ws[j] + (g - p.ws[j]) * k : g));
  const moving = w[1] + w[2] + w[3];
  const stride = moving > 0 ? (w[1] * LOCO[1].stride + w[2] * LOCO[2].stride + w[3] * LOCO[3].stride) / moving : 1;
  p.phase = (((p.phase + dir * (vv / stride) * dt) % 1) + 1) % 1;
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
  const e = r.emotion;
  // an upper-body emotion waits for applyUpper; a full-body one is a clip like the actions
  p.upper = e?.upper && e.weight * (1 - full) > 0 ? { clip: e.clip, t: e.t, weight: Math.min(1, e.weight * (1 - full)) } : null;
  if (e && !e.upper && p.anim.get(e.clip)) want.set(e.clip, [e.t, e.weight * (1 - full)]);
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
