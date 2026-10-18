// Babylon side of awareness.js: plugs the awareness driver into the scene (priority 10), turns the
// upper spine, neck and head to where each player looks, and builds the gesture clips that the
// Quaternius packs lack (arms up, clapping, hands on head or hips, appeals, pointing) as keyed poses.
//
//   const aw = new AwarenessRig(scene3d);   // after Scene3D.create; scene3d.awareness = aw
//   aw.enabled = false                      // the scene without the layer (tests, before/after stills)
//   aw.headDir(i) -> {yaw, pitch}           // where entity i's rendered head points (tests)
//
// The layer never moves the legs during a ball action: while the ball rig or an event action holds
// a player, his locomotion mode is left alone, and during an event action the head is too.
//
// Emotion clips go to the scene as driver emotions; players.js applies them on the upper body
// after the animation step (applyUpper), before the look-at here.
import { Awareness, CLIPS, headYaw } from "./awareness.js";

const B = window.BABYLON;
const UP = new B.Vector3(0, 1, 0);
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
// shares of the turn: upper spine, neck, head (R1: the neck does most, the spine adds the rest)
const YAW_SHARE = { spine_03: 0.25, neck_01: 0.35, Head: 0.4 }, PITCH_SHARE = { neck_01: 0.4, Head: 0.6 };
const HEAD_CLIPS = new Set(["Idle_No_Loop"]);   // clips that move the head themselves: no look on top

export class AwarenessRig {
  constructor(s) {
    this.s = s;
    s.awareness = this;
    this.aw = new Awareness(s.match, s.span, { ball: (t) => s.rig.ball(t) });
    this.enabled = true;
    const probe = s.container.instantiateModelsToScene((n) => `aw-probe-${n}`, false, { doNotInstantiate: true });
    const P = nodesOf(probe.rootNodes[0], "aw-probe-");
    chain(P.Head);
    // the head's forward axis in its own frame (the mannequin faces +Z in its holder)
    this.fwdLocal = B.Vector3.TransformNormal(new B.Vector3(0, 0, 1), P.Head.getWorldMatrix().clone().invert()).normalize();
    buildGestures(s.scene, s.container, P);
    probe.rootNodes.forEach((n) => n.dispose());
    probe.animationGroups.forEach((g) => g.dispose());
    probe.skeletons.forEach((k) => k.dispose());
    this.players = new Map(s.players.map((p) => { const n = nodesOf(p.holder, `${p.pid}-`); return [p.i, { p, n, c: new Chain(n.Head) }]; }));
    s.addDriver({ priority: 10, pose: (i, ts) => this.pose(i, ts) });
    s.scene.onAfterAnimationsObservable.add(() => this._post());
  }

  // What the drivers above this one do with player i at ts: a leg pose (ball rig) or an action.
  _held(i, ts) {
    let leg = false, action = false;
    for (const d of this.s.drivers) {
      if ((d.priority ?? 0) <= 10) continue;
      const p = d.pose(i, ts);
      if (p?.leg) leg = true;
      if (p?.action) action = true;
    }
    return { leg, action };
  }

  pose(i, ts) {
    if (!this.enabled) return null;
    const q = this.aw.pose(i, ts);
    if (!q) return null;
    const h = this._held(i, ts);
    if (h.leg || h.action) { const { mode, ...rest } = q; return rest; }
    return q;
  }

  headDir(i, fresh = false) {
    const r = this.players.get(i);
    if (!r) return null;
    if (!fresh) r.c.update(0);
    const f = B.Vector3.TransformNormal(this.fwdLocal, r.c.W.at(-1)).normalize();
    return { yaw: Math.atan2(f.x, f.z), pitch: Math.asin(-f.y) };
  }

  // After the clips and the emotion's upper body (players.js) have posed the bodies: turn
  // spine_03, neck and head so the head points at the look target, clamped to the neck range
  // around the chest (the holder's facing).
  _post() {
    const ts = this.s.ts;
    if (!this.enabled || ts === undefined) return;
    for (const { p, n, c } of this.players.values()) {
      if (!p.holder.isEnabled() || this._held(p.i, ts).action) continue;
      if (HEAD_CLIPS.has(p.upper?.clip)) continue;
      const L = this.aw.look(p.i, ts);
      if (!L) continue;
      const want = headYaw(p.holder.rotation.y, L.yaw);
      const now = this.headDir(p.i);
      const dy = angleDiff(now.yaw, want);
      for (const [bone, w] of Object.entries(YAW_SHARE)) c.turn(bone, UP, dy * w);
      // pitch: about the horizontal axis across the (now turned) look direction
      const cur = this.headDir(p.i, true), dp = L.pitch - cur.pitch;
      const right = new B.Vector3(Math.cos(want), 0, -Math.sin(want));
      for (const [bone, w] of Object.entries(PITCH_SHARE)) c.turn(bone, right, dp * w);
    }
  }
}

// Bones by plain name under a root whose node names carry a prefix.
export function nodesOf(root, prefix) {
  const out = {};
  for (const n of root.getChildTransformNodes(false)) out[n.name.startsWith(prefix) ? n.name.slice(prefix.length) : n.name] = n;
  return out;
}

// The nodes from the player's holder down to his head, with world matrices kept here: Babylon's
// computeWorldMatrix costs too much bookkeeping to call 14 times per player per frame.
const tq = new B.Quaternion(), tl = new B.Matrix();
class Chain {
  constructor(head) {
    this.nodes = [];
    for (let n = head; n; n = n.parent) this.nodes.unshift(n);
    this.W = this.nodes.map(() => new B.Matrix());
    this.at = Object.fromEntries(this.nodes.map((n, k) => [n.name.replace(/^.*-/, ""), k]));
  }
  update(k0) {
    for (let k = k0; k < this.nodes.length; k++) {
      const n = this.nodes[k];
      const q = n.rotationQuaternion ?? B.Quaternion.FromEulerAnglesToRef(n.rotation.x, n.rotation.y, n.rotation.z, tq);
      B.Matrix.ComposeToRef(n.scaling, q, n.position, k ? tl : this.W[k]);
      if (k) tl.multiplyToRef(this.W[k - 1], this.W[k]);
    }
  }
  // turn a bone about a world axis, then refresh the matrices below it
  turn(name, axisW, angle) {
    const k = this.at[name];
    rotateIn(this.nodes[k], this.W[k - 1], axisW, angle);
    this.update(k);
  }
}

// Update the world matrices from the top of the hierarchy down to node.
export function chain(node) {
  const c = [];
  for (let n = node; n; n = n.parent) c.unshift(n);
  c.forEach((n) => n.computeWorldMatrix(true));
}

// Turn a bone by `angle` about a world axis (pitch: positive turns its forward downwards when the
// axis is the right-hand side). Works in the parent's frame, which may be mirrored (glTF root);
// the parent's world matrix must be up to date.
const qd = new B.Quaternion(), inv = new B.Matrix(), axis = new B.Vector3();
export function turnWorld(bone, axisW, angle) {
  rotateIn(bone, bone.parent.getWorldMatrix(), axisW, angle);
  bone.computeWorldMatrix(true);   // the next bone down reads it
}
function rotateIn(bone, M, axisW, angle) {
  if (Math.abs(angle) > 1e-5) {
    M.invertToRef(inv);
    B.Vector3.TransformNormalToRef(axisW, inv, axis);
    B.Quaternion.RotationAxisToRef(axis.normalize(), M.determinant() < 0 ? -angle : angle, qd);
    qd.multiplyToRef(bone.rotationQuaternion, bone.rotationQuaternion);
  }
}

// Point a bone at a world direction (the direction from its joint to its child's joint).
export function aim(bone, child, dir) {
  chain(child);
  const cur = child.getAbsolutePosition().subtract(bone.getAbsolutePosition()).normalize();
  const d = dir.normalizeToNew();
  const axis = B.Vector3.Cross(cur, d);
  const s = axis.length(), c = B.Vector3.Dot(cur, d);
  if (s < 1e-6) return;
  turnWorld(bone, axis.scale(1 / s), Math.atan2(s, c));
}

// Gesture poses for the right arm in the character's frame (right, up, forward), mirrored for the
// left; [upper arm direction, forearm direction]. spine: forward bend of the upper spine, degrees.
const sym = (up, low) => ({ r: [up, low], l: [up, low] });
const POSES = {
  SD_ArmsUp: [[0, sym([0.55, 0.8, 0.25], [0.45, 0.85, 0.3])], [0.5, sym([0.62, 0.72, 0.25], [0.58, 0.78, 0.2])]],
  SD_Clap: [[0, sym([0.35, -0.55, 0.75], [-0.1, 0.4, 0.9])], [0.3, sym([0.25, -0.55, 0.8], [-0.6, 0.35, 0.72])]],
  SD_HandsOnHead: [[0, sym([0.6, 0.75, 0.25], [-0.9, 0.35, -0.25])], [1, sym([0.64, 0.72, 0.2], [-0.88, 0.4, -0.2])]],
  SD_HandsOnHips: [[0, sym([0.55, -0.75, -0.3], [-0.5, -0.8, 0.3])], [1, sym([0.58, -0.73, -0.3], [-0.5, -0.8, 0.32])]],
  SD_Dejected: [[0, { ...sym([0.12, -0.98, 0.12], [0.05, -0.95, 0.3]), spine: 14 }], [1, { ...sym([0.1, -0.98, 0.15], [0.05, -0.94, 0.33]), spine: 17 }]],
  SD_Appeal: [[0, sym([0.45, -0.6, 0.65], [0.35, 0.05, 0.93])], [0.6, sym([0.5, -0.5, 0.7], [0.45, 0.15, 0.88])]],
  SD_Palms: [[0, sym([0.75, -0.6, 0.25], [0.2, 0.95, 0.2])], [0.75, sym([0.72, -0.62, 0.3], [0.25, 0.93, 0.25])]],
  SD_ArmUp: [[0, { r: [[0.2, 0.97, 0.1], [0.15, 0.98, 0.1]] }], [0.5, { r: [[0.3, 0.94, 0.1], [0.35, 0.93, 0.05]] }]],
  SD_Point: [
    [0, { r: [[0.45, 0.1, 0.88], [0.4, 0.12, 0.9]], l: [[0.15, -0.98, 0.1], [0.1, -0.97, 0.2]] }],
    [0.8, { r: [[0.45, 0.1, 0.88], [0.4, 0.12, 0.9]], l: [[0.15, -0.98, 0.1], [0.1, -0.97, 0.2]] }],
    [1.0, { r: [[0.15, -0.98, 0.1], [0.1, -0.97, 0.2]], l: [[0.45, 0.1, 0.88], [0.4, 0.12, 0.9]] }],
    [1.8, { r: [[0.15, -0.98, 0.1], [0.1, -0.97, 0.2]], l: [[0.45, 0.1, 0.88], [0.4, 0.12, 0.9]] }],
  ],
};

// Key the poses on an unposed probe and add them to the container as looping animation groups, so
// the players' lazy clip cache (players.js setupAnimations) finds them by name like any clip.
function buildGestures(scene, container, P) {
  const fps = container.animationGroups[0].targetedAnimations[0].animation.framePerSecond;
  chain(P.upperarm_r); chain(P.upperarm_l);
  const R = P.upperarm_r.getAbsolutePosition().subtract(P.upperarm_l.getAbsolutePosition());
  R.y = 0; R.z = 0; R.normalize();   // the character's right is +X or -X, read from the skeleton
  const U = new B.Vector3(0, 1, 0), F = new B.Vector3(0, 0, 1);
  const dir = ([r, u, f], side) => R.scale(side === "l" ? -r : r).add(U.scale(u)).add(F.scale(f));
  const bones = ["spine_03", "upperarm_r", "lowerarm_r", "upperarm_l", "lowerarm_l"];
  const rest = Object.fromEntries(bones.map((b) => [b, P[b].rotationQuaternion.clone()]));
  const byName = new Map(container.transformNodes.map((n) => [n.name, n]));
  for (const [name, keys] of Object.entries(POSES)) {
    const len = CLIPS[name];
    const tracks = {};
    for (const [t, pose] of [...keys, [len, keys[0][1]]]) {
      bones.forEach((b) => P[b].rotationQuaternion.copyFrom(rest[b]));
      if (pose.spine) {
        const a = (pose.spine * Math.PI) / 180;
        aim(P.spine_03, P.neck_01, U.scale(Math.cos(a)).add(F.scale(Math.sin(a))));
      }
      for (const side of ["r", "l"]) {
        if (!pose[side]) continue;
        aim(P[`upperarm_${side}`], P[`lowerarm_${side}`], dir(pose[side][0], side));
        aim(P[`lowerarm_${side}`], P[`hand_${side}`], dir(pose[side][1], side));
      }
      const keyed = [...(pose.spine ? ["spine_03"] : []), ...["r", "l"].filter((s) => pose[s]).flatMap((s) => [`upperarm_${s}`, `lowerarm_${s}`])];
      for (const b of keyed) (tracks[b] ??= []).push({ frame: Math.round(t * fps), value: P[b].rotationQuaternion.clone() });
    }
    bones.forEach((b) => P[b].rotationQuaternion.copyFrom(rest[b]));
    const g = new B.AnimationGroup(name, scene);
    scene.animationGroups.splice(scene.animationGroups.indexOf(g), 1);   // a template, never played itself
    for (const [b, k] of Object.entries(tracks)) {
      const a = new B.Animation(`${name}-${b}`, "rotationQuaternion", fps, B.Animation.ANIMATIONTYPE_QUATERNION, B.Animation.ANIMATIONLOOPMODE_CYCLE);
      a.setKeys(k);
      g.addTargetedAnimation(a, byName.get(b));
    }
    container.animationGroups.push(g);
  }
}
