// Player animation: locomotion blended by ground speed, and one-off actions read from the events
// (slide tackle, header jump, a roll as the keeper's dive, the scorer's celebration).
// Everything is a function of match time: groups stay paused and are sampled with goToFrame, so a
// seek, a replay or a video frame always shows the same pose.
const B = window.BABYLON;

// Locomotion clips of the Universal Animation Library: speed (m/s) at which the feet do not
// slide when the clip plays at 1x, and metres per cycle (measured from the root-motion version).
export const LOCO = [
  { name: "Idle_Loop", speed: 0, stride: 0, period: 2.5 },
  { name: "Walk_Loop", speed: 0.975, stride: 1.3 },
  { name: "Jog_Fwd_Loop", speed: 5.357, stride: 5.0 },
  { name: "Sprint_Loop", speed: 8.25, stride: 5.5 },
];

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

// Actions: clip phases [clip, from s, to s] played back to back, and the moment of contact
// (seconds from the start) that lines up with the event time.
export const ACTIONS = {
  slide: { phases: [["Slide_Start", 0, 0.83], ["Slide_Loop", 0, 0.35], ["Slide_Exit", 0, 0.5]], contact: 0.7 },
  header: { phases: [["Jump_Start", 0.5, 1.33], ["Jump_Land", 0, 0.9]], contact: 0.8 },
  dive: { phases: [["Roll", 0, 1.47]], contact: 0.4 },
  // upper body only, a beat after the ball crosses the line, twice
  celebrate: { phases: [["Yes", 0, 2.5], ["Yes", 0, 2.5]], contact: -0.8, upper: true },
};
export const ACTION_CLIPS = [...new Set(Object.values(ACTIONS).flatMap((a) => a.phases.map((p) => p[0])))];
const IN_S = 0.15, OUT_S = 0.25;
const UPPER = /(spine_0[23]|neck_01|Head|clavicle|upperarm|lowerarm|hand|thumb|index|middle|ring|pinky)/;
const length = (a) => a.phases.reduce((s, [, f, t]) => s + t - f, 0);

// Per player, the actions the events call for: [{kind, start, end, at}], sorted, never
// overlapping (a later action cuts the earlier one short). `at` is the event's pitch point.
// goals: the `score` facts ({ts, team_id}); the scorer is the shooter of that team at that time.
export function scheduleActions(events, goals) {
  const scored = (e) => goals.some((g) => g.team_id === e.team_id && Math.abs(g.ts - e.ts) < 0.5);
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
    if (e.type_name.startsWith("shot") && e.result_name === "success" && scored(e)) add(e.player_id, "celebrate", e.ts, at);
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < list.length; i++) list[i].end = Math.min(list[i].end, list[i + 1].start);
  }
  return out;
}

// The action playing at ts, its weight (eased in and out) and the clip phase and frame.
export function actionAt(list, ts) {
  if (!list) return null;
  for (const act of list) {
    if (ts < act.start || ts >= act.end) continue;
    const a = ACTIONS[act.kind];
    let u = ts - act.start;
    const w = Math.min(1, u / IN_S, (act.end - ts) / OUT_S);
    for (let k = 0; k < a.phases.length; k++) {
      const [clip, f, t] = a.phases[k];
      if (u < t - f || k === a.phases.length - 1) return { act, clip, time: Math.min(f + u, t), weight: Math.max(0, w), upper: !!a.upper };
      u -= t - f;
    }
  }
  return null;
}

// Paused groups for one instantiated player: loco[4] and actions by clip name.
export function setupAnimations(inst) {
  const take = (name) => {
    const g = inst.animationGroups.find((a) => a.name.endsWith(name));
    g.start(true, 1, g.from, g.to);
    g.pause();
    g.setWeightForAllAnimatables(0);
    return g;
  };
  const loco = LOCO.map((c) => take(c.name));
  const actions = Object.fromEntries(ACTION_CLIPS.map((n) => [n, take(n)]));
  // the celebration moves the arms and chest; the legs keep running
  const yes = actions.Yes;
  yes.mask = new B.AnimationGroupMask(yes.targetedAnimations.map((t) => t.target.name).filter((n) => UPPER.test(n)));
  yes.removeUnmaskedAnimations();
  const keep = new Set([...loco, ...Object.values(actions)]);
  for (const g of inst.animationGroups) if (!keep.has(g)) g.dispose();
  return { loco, actions, fps: yes.targetedAnimations[0].animation.framePerSecond };
}

// One frame of animation for player p moving at v m/s; dt is match time since the last frame.
export function animatePlayer(p, v, ts, dt, schedule) {
  const act = actionAt(schedule[p.pid], ts);
  const full = act && !act.upper ? act.weight : 0;
  const w = clipWeights(v);
  const moving = w[1] + w[2] + w[3];
  const stride = moving > 0 ? (w[1] * LOCO[1].stride + w[2] * LOCO[2].stride + w[3] * LOCO[3].stride) / moving : 1;
  p.phase = (p.phase + (v / stride) * dt) % 1;
  p.idle = (p.idle + dt / LOCO[0].period) % 1;
  p.anim.loco.forEach((g, j) => {
    const wj = w[j] * (1 - full);
    if (wj === 0 && p.w[j] === 0) return;
    g.setWeightForAllAnimatables(wj);
    const ph = j === 0 ? p.idle : p.phase;
    g.goToFrame(g.from + ph * (g.to - g.from), true);
    p.w[j] = wj;
  });
  // action groups: only the active clip carries weight; the masked celebration is boosted so it
  // wins over the locomotion on the upper body (weights above 1 in total are normalised)
  for (const [name, g] of Object.entries(p.anim.actions)) {
    const on = act && act.clip === name;
    const wa = on ? (act.upper ? act.weight * 6 : act.weight) : 0;
    if (wa === 0 && !p.aw[name]) continue;
    g.setWeightForAllAnimatables(wa);
    if (on) g.goToFrame(Math.min(g.to, g.from + act.time * p.anim.fps), true);
    p.aw[name] = wa;
  }
  return act;
}

const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

// The one place that decides a player's facing and leg pose, so the clips and the ball rig of
// ball3d-rig.js never fight over the root. Position is always tracking + rig offset (`shown`).
// yaw: the smoothed run or ball facing; around a touch the rig turns the body (pose.yaw with
// weight pose.yawW); a full-body action (slide, dive) turns it towards its event point and
// switches the rig's leg pose off while it plays, since the clip moves the legs itself.
export function resolveRoot(yaw, pose, act, shown) {
  let out = pose?.yawW > 0 ? yaw + angleDiff(yaw, pose.yaw) * pose.yawW : yaw;
  const full = act && !act.upper ? act.weight : 0;
  if (full > 0 && (act.act.kind === "slide" || act.act.kind === "dive")) {
    const dx = act.act.at[0] - shown[0], dy = act.act.at[1] - shown[1];
    if (Math.hypot(dx, dy) > 0.5) out += angleDiff(out, Math.atan2(dx, dy)) * full;
  }
  return { yaw: out, leg: full > 0 ? null : pose?.leg ?? null };
}
