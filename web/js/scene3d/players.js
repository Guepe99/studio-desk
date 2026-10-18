// Player animation and the root of each player.
//
// Drivers. Every module that wants to place or turn a player, or ask for a clip, is a driver:
// an object with pose(i, ts) -> null | {
//   dx, dy       metres added to the tracking position (contract axes), e.g. the ball rig's
//                 offset that puts the foot on the ball;
//   yaw, yawW    a facing (radians, atan2(dx, dy) on the pitch) and how much of it to take (0..1);
//   leg          a leg pose for the ball rig (ball3d-rig.js);
//   mode         locomotion mode: "forward" (default), "backpedal", "strafe" or "jockey";
//   emotion      {clip, t, weight, upper}: any clip of the player file played at t seconds, on
//                 the upper body only when upper is true (celebration, dejection) }.
// pose() must be a pure function of (i, ts): the scene asks it at ts and at ts +- 0.2 s.
// Drivers run in priority order, low first; a later facing is blended over the earlier ones and
// the last mode and emotion win. The scene's own drivers: awareness modules 10 (suggested), the
// ball rig 20, the event actions below 30 (a slide or dive turns the body to its event point and
// switches the rig's leg pose off while the clip moves the legs).
//
// Clips are sampled with goToFrame from match time, never played, so a seek, a replay or a video
// frame always shows the same pose. Action and emotion clips are cloned for a player the first
// time they are needed: idle clips cost animation time every frame in Babylon.
const B = window.BABYLON;

// Locomotion clips of the Universal Animation Library: speed (m/s) at which the feet do not
// slide when the clip plays at 1x, and metres per cycle (measured from the root-motion version).
export const LOCO = [
  { name: "Idle_Loop", speed: 0, stride: 0, period: 2.5 },
  { name: "Walk_Loop", speed: 0.975, stride: 1.3 },
  { name: "Jog_Fwd_Loop", speed: 5.357, stride: 5.0 },
  { name: "Sprint_Loop", speed: 8.25, stride: 5.5 },
];
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
  dive: { phases: [["Roll", 0, 1.47]], contact: 0.4 },
};
const IN_S = 0.15, OUT_S = 0.25;
const UPPER = /(spine_0[23]|neck_01|Head|clavicle|upperarm|lowerarm|hand|thumb|index|middle|ring|pinky)/;
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
    else if (e.type_name === "keeper_save") add(e.player_id, "dive", e.ts, at);
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
      if ((a.act.kind === "slide" || a.act.kind === "dive") && here && Math.hypot(dx, dy) > 0.5) {
        out.yaw = Math.atan2(dx, dy); out.yawW = a.weight;
      }
      return out;
    },
  };
}

// Combine the drivers' answers for player i at ts (drivers sorted by priority). The facing
// overrides come back as turns, applied over the scene's own facing with facing().
export function resolve(drivers, i, ts) {
  const out = { dx: 0, dy: 0, turns: [], leg: null, mode: "forward", emotion: null, action: null, actionW: 0 };
  for (const d of drivers) {
    const p = d.pose(i, ts);
    if (!p) continue;
    out.dx += p.dx ?? 0; out.dy += p.dy ?? 0;
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
  return {
    loco, fps, cache,
    // the group for clip `name` (upper body only when upper), or null when the file lacks it
    get(name, upper = false) {
      const key = upper ? `${name}^` : name;
      if (key in cache) return cache[key];
      const src = container.animationGroups.find((a) => a.name === name);
      if (!src) return (cache[key] = null);
      const g = src.clone(`${prefix}${key}`, (t) => nodes.get(`${prefix}${t.name}`) ?? t);
      if (upper) {
        g.mask = new B.AnimationGroupMask(g.targetedAnimations.map((t) => t.target.name).filter((n) => UPPER.test(n)));
        g.removeUnmaskedAnimations();
      }
      return (cache[key] = prep(g));
    },
  };
}

// One frame of animation for player p (ground speed v m/s, dt match seconds since the last
// frame) from the resolved driver answers r.
export function animatePlayer(p, v, dt, r) {
  const full = r.action ? r.actionW : 0;
  const { w, dir, v: vv } = gait(r.mode, v);
  const moving = w[1] + w[2] + w[3];
  const stride = moving > 0 ? (w[1] * LOCO[1].stride + w[2] * LOCO[2].stride + w[3] * LOCO[3].stride) / moving : 1;
  p.phase = (((p.phase + dir * (vv / stride) * dt) % 1) + 1) % 1;
  p.idle = (p.idle + dt / LOCO[0].period) % 1;
  p.anim.loco.forEach((g, j) => {
    const wj = w[j] * (1 - full);
    if (wj === 0 && p.w[j] === 0) return;
    g.setWeightForAllAnimatables(wj);
    const ph = j === 0 ? p.idle : p.phase;
    g.goToFrame(g.from + ph * (g.to - g.from), true);
    p.w[j] = wj;
  });
  // clips other than locomotion: only the ones asked for this frame carry weight. An upper-body
  // emotion is boosted so it wins over the locomotion there (weights over 1 are normalised).
  const want = new Map();
  if (r.action) want.set(r.action.clip, [r.action.time, r.action.weight]);
  const e = r.emotion;
  if (e) {
    const g = p.anim.get(e.clip, !!e.upper);
    if (g) want.set(e.upper ? `${e.clip}^` : e.clip, [e.t, e.upper ? e.weight * 6 : e.weight * (1 - full)]);
  }
  if (r.action) p.anim.get(r.action.clip);
  for (const [key, g] of Object.entries(p.anim.cache)) {
    if (!g) continue;
    const [t, wa] = want.get(key) ?? [0, 0];
    if (wa === 0 && !p.aw[key]) continue;
    g.setWeightForAllAnimatables(wa);
    if (wa > 0) g.goToFrame(Math.min(g.to, g.from + Math.max(0, t) * p.anim.fps), true);
    p.aw[key] = wa;
  }
}
