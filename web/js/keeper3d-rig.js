// Babylon side of keeper3d.js: plugs the keeper reactions into the scene as a driver (priority 30,
// like the event actions), builds the dive, catch and tip poses the player file lacks, and after
// the animation step aims the arms at the ball's contact point so the hands meet it.
//
//   const kr = new KeeperRig(scene3d);   // after Scene3D.create and the AwarenessRig
//   kr.reactions                         // planKeeper's list, for the tests
//   kr.hands(i) -> [x, y, h]             // midpoint of entity i's hands, contract metres
//
// Real clips can replace the procedural ones by name (GK_Dive_L, GK_Dive_R, GK_Low_L, GK_Low_R,
// GK_Catch, GK_Tip): a clip already in the file is never overwritten. Such a clip should be in
// place (no root motion) and keyed on keeper3d.CLIP_KEYS; keeperRoot() gives the root curve.
import { planKeeper, keeperRoot, realRoot, CLIP_KEYS, CLIPS, GROUND, clearance } from "./keeper3d.js";
import { nodesOf, chain, aim, turnWorld } from "./awareness-rig.js";
import { THROW } from "./scene3d/players.js";

const B = window.BABYLON;
const HALF_L = 52.5, HALF_W = 34;
const smooth = (u) => { const t = Math.min(1, Math.max(0, u)); return t * t * (3 - 2 * t); };

// the joints _ground reads, each after its parent, so one pass from the pelvis updates them all
export const BONES = ["pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "Head", "clavicle_l", "upperarm_l", "lowerarm_l", "hand_l",
  "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r", "thigh_l", "calf_l", "foot_l", "ball_l", "thigh_r", "calf_r", "foot_r", "ball_r"];
const DOWN = 0.15;   // m the real clip's root is under the grass when he counts as down (body())
// world matrices from the root down to node, without the array chain() builds
const refresh = (n) => { if (n.parent) refresh(n.parent); n.computeWorldMatrix(true); };

export class KeeperRig {
  constructor(s) {
    this.s = s;
    s.keeper = this;
    this.enabled = true;
    this.ground = true;   // keep the body above the grass (_ground); off only to compare
    const probe = s.container.instantiateModelsToScene((n) => `gk-probe-${n}`, false, { doNotInstantiate: true });
    probe.animationGroups.forEach((g) => g.dispose());
    const P = nodesOf(probe.rootNodes[0], "gk-probe-");
    // stand-ins for the clips the file lacks, keyed on the unposed probe (before the measuring)
    buildKeeperClips(s.scene, s.container, P);
    // the retargeted clips (players.js loadMotion) with their root curve; ?motion=procedural or a
    // missing file leaves the procedural poses below
    this.real = {};
    for (const name of new Set(Object.values(CLIPS).flat())) {
      const c = s.motion?.clips?.[name], g = c?.root && s.container.animationGroups.find((a) => a.name === name);
      // measured on the first player's scale: a match without players has no keeper to pose
      if (g && s.players.length) this.real[name] = { ...c, fps: s.motion.fps, ...measureClip(s, probe.rootNodes[0], P, g, c, s.motion.fps, kindOf(name)) };
    }
    probe.rootNodes.forEach((n) => n.dispose());
    probe.skeletons.forEach((k) => k.dispose());
    this.replan(s.span);
    s.addDriver({ priority: 30, pose: (i, ts) => this.pose(i, ts) });
    s.scene.onAfterAnimationsObservable.add(() => this._arms());
    // the awareness layer keeps the others off a keeper lying on the grass after his dive
    if (s.awareness?.aw) s.awareness.aw.bodyOf = (i, ts) => this.body(i, ts);
  }

  // Plans the reactions for the match time [span[0], span[1]] (Scene3D.replan); planFor on a given
  // ball plan, use puts them in place.
  replan(span) { this.use(this.planFor(span, this.s.rig.plan)); }
  planFor(span, plan) { return planKeeper(this.s.match, (t) => plan.ball(t), { ballR: this.s.ballR, span, real: this.real }); }
  use(reactions) {
    this.reactions = reactions;
    this.by = new Map();
    for (const r of this.reactions) (this.by.get(r.i) ?? this.by.set(r.i, []).get(r.i)).push(r);
  }

  // Three points along a keeper lying on the grass after a dive (feet, hips, head), as [x, y, w]
  // in contract metres, or null when he is not down.
  body(i, ts) {
    const r = this.at(i, ts), k = r && (r.real ? realRoot(r, ts) : keeperRoot(r, ts)), p = k && this.s.match.at(i, ts);
    // weight 0..1 as he goes down, so whoever stands there is eased off, not thrown
    const w = !p ? 0 : r.real ? smooth((-k.lift - DOWN) / 0.35) : smooth((Math.abs(k.roll) - 0.3) / 0.6);
    if (w <= 0) return null;
    const n = Math.hypot(k.dx, k.dy), u = n > 0.3 ? [k.dx / n, k.dy / n] : r.u;   // he lies along his dive
    return [-0.8, 0, 0.8].map((a) => [p[0] + k.dx + u[0] * a, p[1] + k.dy + u[1] * a, w]);
  }

  at(i, ts) {
    if (!this.enabled) return null;
    for (const r of this.by.get(i) ?? []) if (ts >= r.set0 && ts < r.end) return r;
    return null;
  }

  pose(i, ts) {
    const r = this.at(i, ts), hd = this.held(i, ts);
    const k = r && (r.real ? realRoot(r, ts) : keeperRoot(r, ts));
    if (!k && !hd) return null;
    const out = k ? { dx: k.dx, dy: k.dy, dz: k.lift, roll: k.roll, yaw: r.yaw, yawW: k.w,
      action: { clip: r.clip, time: k.clipT, weight: k.w }, actionW: k.w } : {};
    // a ball he keeps: carried at the chest like a throw-in taker's, under the reaction while it plays
    if (hd) out.emotion = { kind: "hold", clip: THROW.carry, t: THROW.carryT, weight: hd.arms, upper: true };
    return out;
  }

  // The ball in keeper i's hands at ts (ball3d.js holds): { arms, grip } weights of his carrying
  // pose and of the ball on his hands, or null.
  held(i, ts) {
    if (!this.enabled) return null;
    for (const d of this.s.rig.plan?.holds ?? []) {
      if (d.i !== i || ts < d.t0 - 0.05 || ts >= d.t2) continue;
      const out = 1 - smooth((ts - d.t1) / (d.t2 - d.t1));   // let go for the kick
      return { arms: smooth((ts - d.t0) / 0.3) * out, grip: smooth((ts - d.t0 + 0.05) / 0.2) * out };
    }
    return null;
  }

  // Arms towards the contact point: in from the first move, held through contact, out on landing.
  _arms() {
    const ts = this.s.ts;
    if (ts === undefined) return;
    for (const p of this.s.players) {
      const r = this.at(p.i, ts);
      if (!r || !p.holder.isEnabled()) continue;
      const w = smooth((ts - r.start) / (r.tc - r.start)) * (1 - smooth((ts - r.tc - 0.2) / 0.4));
      if (w <= 0) continue;
      if (r.kind === "catch" && r.h < 0.6) this._stoop(p, r, w);
      const target = (this._target ??= new B.Vector3()).set(r.ball[0] - HALF_L, r.ball[2], r.ball[1] - HALF_W);
      const dir = (this._dir ??= new B.Vector3());   // aimPart reads it and keeps nothing
      for (const side of ["l", "r"]) {
        const up = p.anim.node(`upperarm_${side}`), lo = p.anim.node(`lowerarm_${side}`), hand = p.anim.node(`hand_${side}`);
        if (!up || !lo || !hand) continue;
        chain(lo);
        aimPart(up, lo, target.subtractToRef(up.getAbsolutePosition(), dir), w);
        chain(hand);
        aimPart(lo, hand, target.subtractToRef(lo.getAbsolutePosition(), dir), w);
      }
    }
    for (const p of this.s.players) this._ground(p, ts);   // after the arms, which can reach down
    for (const p of this.s.players) this._grip(p, ts);   // after the arms moved
  }

  // A keeper down after his dive rests on the grass: the whole body is raised until every joint
  // clears its GROUND height (the clip's lying pose, on a smaller or larger player, sank into it).
  // Only while a real clip has him down (its root more than DOWN under the grass, where body()
  // starts easing the others off him): standing, setting or getting up he is never moved.
  _ground(p, ts) {
    if (!this.ground || !p.holder.isEnabled() || p.holder.position.y > -DOWN || !this.at(p.i, ts)?.real) return;
    const y = (this._y ??= {});
    let fresh = false;
    for (const b of BONES) {
      const n = p.anim.node(b);
      if (!n) { y[b] = Infinity; continue; }
      if (fresh) n.computeWorldMatrix(true); else { refresh(n); fresh = true; }   // parents come first in BONES
      y[b] = n.getAbsolutePosition().y;
    }
    const up = clearance(y);
    if (up > 0) { p.holder.position.y += up; p.holder.computeWorldMatrix(true); }
  }

  // A low ball straight at him is gathered stooping: bent forward from the hips, legs straight,
  // until the shoulders are an arm's reach above the ball (80 degrees at most); the arms then aim.
  _stoop(p, r, w) {
    const sp = p.anim.node("spine_01"), a = p.anim.node("upperarm_l"), b = p.anim.node("upperarm_r");
    if (!sp?.parent || !a || !b) return;
    chain(a); chain(b);
    const pivot = sp.getAbsolutePosition().y, L = (a.getAbsolutePosition().y + b.getAbsolutePosition().y) / 2 - pivot;
    if (L < 0.1) return;
    const c = Math.min(1, Math.max(Math.cos((80 * Math.PI) / 180), (r.ball[2] + 0.55 - pivot) / L));
    turnWorld(sp, new B.Vector3(r.u[0], 0, r.u[1]), Math.acos(c) * w);   // about his right: forward and down
  }

  // The held ball sits between his hands wherever the pose puts them (as scene3d.throwBall).
  _grip(p, ts) {
    const hd = this.held(p.i, ts), s = this.s;
    if (!hd || hd.grip <= 0 || !p.holder.isEnabled() || !s.ball.isEnabled()) return;
    const m = this.hands(p.i);
    if (!m) return;
    B.Vector3.LerpToRef(s.ball.position, new B.Vector3(m[0] - HALF_L, m[2], m[1] - HALF_W), hd.grip, s.ball.position);
    s.ballShadow.position.x = s.ball.position.x;
    s.ballShadow.position.z = s.ball.position.z;
    s.ballShadow.material.alpha = 1 / (1 + (s.ball.position.y - s.ballR) * 0.6);
  }

  hands(i) {
    const p = this.s.players.find((q) => q.i === i);
    if (!p) return null;
    const [a, b] = ["l", "r"].map((side) => { const n = p.anim.node(`hand_${side}`); chain(n); return n.getAbsolutePosition(); });
    const m = a.add(b).scale(0.5);
    return [m.x + HALF_L, m.z + HALF_W, m.y];
  }
}

const kindOf = (name) => Object.keys(CLIPS).find((k) => CLIPS[k].includes(name));

// Contact frame and hand midpoint of a real clip, played on the probe (scaled like the players,
// facing +Z at the origin) plus its root curve: [left, up, forward] metres from the start spot.
// Contact: dives, the first frame the hands are 85% of their widest; catch, 90% of their furthest
// forward in the first 1.2 s; tip, the highest.
function measureClip(s, root, P, src, c, fps, kind) {
  const holder = new B.TransformNode("gk-probe-holder", s.scene);
  root.parent = holder;
  root.scaling.scaleInPlace(s.players[0].holder.getChildren()[0].scaling.x / root.scaling.x);
  const g = src.clone(`gk-probe-${src.name}`, (t) => P[t.name] ?? null);
  g.start(false, 1, g.from, g.to); g.pause(); g.setWeightForAllAnimatables(1);
  const rows = [];
  for (let f = 0; f < c.root.length; f++) {
    g.goToFrame(Math.min(g.to, g.from + (f / fps) * (g.targetedAnimations[0].animation.framePerSecond)));
    s.scene.animate();
    const [a, b] = ["l", "r"].map((side) => { chain(P[`hand_${side}`]); return P[`hand_${side}`].getAbsolutePosition(); });
    const r = c.root[f];
    rows.push([-(a.x + b.x) / 2 + r[0], (a.y + b.y) / 2 + r[1], (a.z + b.z) / 2 + r[2]]);
  }
  g.dispose();
  root.parent = null;
  holder.dispose();
  let k = 0;
  if (kind === "dive" || kind === "low") {
    const sg = Math.sign(c.root.at(-1)[0]) || 1, top = Math.max(...rows.map((h) => h[0] * sg));
    k = rows.findIndex((h) => h[0] * sg >= 0.85 * top);
  } else if (kind === "catch") {
    const early = rows.slice(0, Math.round(1.2 * fps)), top = Math.max(...early.map((h) => h[2]));
    k = early.findIndex((h) => h[2] >= 0.9 * top);
  } else k = rows.reduce((best, h, j) => (h[1] > rows[best][1] ? j : best), 0);
  return { contact: k / fps, hand: rows[k], hands: rows };
}

// Turn a bone part of the way (w) towards pointing its child along dir (world).
function aimPart(bone, child, dir, w) {
  const cur = child.getAbsolutePosition().subtract(bone.getAbsolutePosition()).normalize();
  const d = dir.normalizeToNew();
  const axis = B.Vector3.Cross(cur, d), s = axis.length();
  if (s < 1e-6) return;
  turnWorld(bone, axis.scale(1 / s), Math.atan2(s, B.Vector3.Dot(cur, d)) * w);
}

// Keeper poses in the character's frame (right, up, forward), mirrored for the left; per bone the
// direction from the joint to the next one. The holder's roll and lift lay the body down
// (keeper3d.keeperRoot), so "arms up" here is "arms along the body towards the ball" in a dive.
const sym = (v) => ({ r: v, l: v });
const STANCE = { arm: sym([[0.45, -0.55, 0.7], [0.2, -0.1, 0.97]]), thigh: sym([0.12, -0.9, 0.4]), calf: sym([0.04, -0.92, -0.38]), spine: 15 };
const LANDED = { arm: sym([[0.2, 0.7, 0.68], [0, 0.3, 0.95]]), thigh: sym([0.1, -0.8, 0.58]), calf: sym([0.05, -0.95, -0.3]), spine: 10 };
const STRETCH = { arm: sym([[0.1, 0.95, 0.3], [0.05, 0.95, 0.3]]), thigh: sym([0.08, -0.99, -0.05]), calf: sym([0.06, -0.99, -0.1]), spine: 0 };
const GATHER = { arm: sym([[0.15, 0.45, 0.88], [0, 0.1, 0.99]]), thigh: sym([0.1, -0.9, 0.4]), calf: sym([0.05, -0.95, -0.25]), spine: 5 };
const CATCH = { arm: sym([[0.3, -0.15, 0.94], [-0.25, 0.3, 0.92]]), thigh: STANCE.thigh, calf: STANCE.calf, spine: 20 };
const HUG = { arm: sym([[0.45, -0.75, 0.48], [-0.75, 0.45, 0.48]]), thigh: STANCE.thigh, calf: STANCE.calf, spine: 25 };
const TIP = { arm: { r: [[0.1, 0.98, 0.15], [0.05, 0.98, 0.2]], l: [[0.4, 0.2, 0.85], [0.2, 0.3, 0.9]] },
  thigh: { l: [0.1, -0.45, 0.89], r: [0.08, -0.99, 0] }, calf: { l: [0, -0.97, -0.2], r: [0.06, -0.99, -0.1] }, spine: -5 };
const SEQ = { dive: [STANCE, STRETCH, LANDED, LANDED, STANCE], low: [STANCE, GATHER, LANDED, LANDED, STANCE],
  catch: [STANCE, CATCH, HUG, HUG, STANCE], tip: [STANCE, TIP, LANDED, STANCE, STANCE] };

// Key the poses on an unposed probe and add them to the container as animation groups, so the
// players' lazy clip cache (players.js setupAnimations) finds them by name.
function buildKeeperClips(scene, container, P) {
  const fps = container.animationGroups[0].targetedAnimations[0].animation.framePerSecond;
  chain(P.upperarm_r); chain(P.upperarm_l);
  const R = P.upperarm_r.getAbsolutePosition().subtract(P.upperarm_l.getAbsolutePosition());
  R.y = 0; R.z = 0; R.normalize();
  const U = new B.Vector3(0, 1, 0), F = new B.Vector3(0, 0, 1);
  const dir = ([r, u, f], side) => R.scale(side === "l" ? -r : r).add(U.scale(u)).add(F.scale(f));
  const bones = ["spine_03", "upperarm_r", "lowerarm_r", "upperarm_l", "lowerarm_l", "thigh_r", "calf_r", "thigh_l", "calf_l"];
  const rest = Object.fromEntries(bones.map((b) => [b, P[b].rotationQuaternion.clone()]));
  const byName = new Map(container.transformNodes.map((n) => [n.name, n]));
  const have = new Set(container.animationGroups.map((g) => g.name));
  for (const [kind, names] of Object.entries(CLIPS)) {
    for (const name of new Set(names)) {
      if (have.has(name)) continue;
      const tracks = {};
      SEQ[kind].forEach((pose, k) => {
        bones.forEach((b) => P[b].rotationQuaternion.copyFrom(rest[b]));
        const a = (pose.spine * Math.PI) / 180;
        aim(P.spine_03, P.neck_01, U.scale(Math.cos(a)).add(F.scale(Math.sin(a))));
        for (const side of ["r", "l"]) {
          aim(P[`thigh_${side}`], P[`calf_${side}`], dir(pose.thigh[side], side));
          aim(P[`calf_${side}`], P[`foot_${side}`], dir(pose.calf[side], side));
          aim(P[`upperarm_${side}`], P[`lowerarm_${side}`], dir(pose.arm[side][0], side));
          aim(P[`lowerarm_${side}`], P[`hand_${side}`], dir(pose.arm[side][1], side));
        }
        for (const b of bones) (tracks[b] ??= []).push({ frame: Math.round(CLIP_KEYS[k] * fps), value: P[b].rotationQuaternion.clone() });
      });
      bones.forEach((b) => P[b].rotationQuaternion.copyFrom(rest[b]));
      const g = new B.AnimationGroup(name, scene);
      scene.animationGroups.splice(scene.animationGroups.indexOf(g), 1);   // a template, never played itself
      for (const [b, k] of Object.entries(tracks)) {
        const an = new B.Animation(`${name}-${b}`, "rotationQuaternion", fps, B.Animation.ANIMATIONTYPE_QUATERNION, B.Animation.ANIMATIONLOOPMODE_CONSTANT);
        an.setKeys(k);
        g.addTargetedAnimation(an, byName.get(b));
      }
      container.animationGroups.push(g);
    }
  }
}
