// Babylon side of the ball handling: puts the BallPlan of ball3d.js on the mannequins.
// The scene asks it for the ball transform and each player's root offset and facing, and tells it
// which leg action each player is in; the rig poses the legs after the locomotion clips have run,
// then lifts any body whose sole went under the grass (grounding).
//
//   const rig = new BallRig(scene, match, span, probeRoot, scale, ballR);   // probe: an unposed mannequin
//   rig.addPlayer(i, root);  rig.ball(ts) -> {x, y, h, q};  rig.pose(i, ts) -> {dx, dy, yaw, yawW, leg} | null
//   rig.setLeg(i, leg)  (each frame, before the scene renders)
import { BallPlan, legPose } from "./ball3d.js";

const B = window.BABYLON;
const KINDS = ["shot", "long", "pass", "touch", "trap"];

export class BallRig {
  constructor(scene, match, span, probeRoot, scale, ballR) {
    // where the ball centre sits, in the player's own frame, at the contact moment of each action
    this.reach = {};
    const L = legNodes(probeRoot);
    this.soles = solePoints(probeRoot, L);   // before the reach poses below bend the probe's legs
    for (const kind of KINDS) for (const side of ["l", "r"]) {
      poseLegs(L, { kind, side, t: 0 }, true);
      const chain = [];
      for (let n = L[`ball_${side}`]; n; n = n.parent) chain.unshift(n);
      chain.forEach((n) => n.computeWorldMatrix(true));
      const f = L[`foot_${side}`].getAbsolutePosition(), t = L[`ball_${side}`].getAbsolutePosition();
      const c = B.Vector3.Lerp(f, t, 0.65).scale(scale);
      this.reach[kind + side] = { x: c.x, z: c.z + ballR };
    }
    this.plan = new BallPlan(match, span, { reach: (kind, side) => this.reach[kind + side], ballR });
    this.players = new Map();   // entity index -> { legs, leg }
    // leg actions go on top of the locomotion pose, once the animation groups have written it; then
    // the body is grounded
    scene.onAfterAnimationsObservable.add(() => {
      for (const p of this.players.values()) {
        if (p.leg) poseLegs(p.legs, p.leg);
        if (this.soles) ground(p, this.soles);
      }
    });
  }

  addPlayer(i, root) { this.players.set(i, { root, legs: legNodes(root), leg: null }); }
  setLeg(i, leg) { const p = this.players.get(i); if (p) p.leg = leg ?? null; }
  ball(ts) { return this.plan.ball(ts); }
  pose(i, ts) { return this.plan.pose(i, ts); }
}

// A white ball with twelve dark patches at the vertices of an icosahedron, so its spin shows.
export function ballTexture(scene) {
  const phi = (1 + Math.sqrt(5)) / 2;
  const ico = [[0, 1, phi], [0, -1, phi], [0, 1, -phi], [0, -1, -phi], [1, phi, 0], [-1, phi, 0], [1, -phi, 0], [-1, -phi, 0],
    [phi, 0, 1], [-phi, 0, 1], [phi, 0, -1], [-phi, 0, -1]].map((v) => v.map((c) => c / Math.hypot(...v)));
  const w = 256, h = 128;
  const tex = new B.DynamicTexture("ballTex", { width: w, height: h }, scene, true);
  const g = tex.getContext(), img = g.createImageData(w, h);
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const th = ((px + 0.5) / w) * 2 * Math.PI, ph = ((py + 0.5) / h) * Math.PI;
    const d = [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
    const near = Math.max(...ico.map((v) => v[0] * d[0] + v[1] * d[1] + v[2] * d[2]));
    const c = near > 0.935 ? 30 : near > 0.925 ? 120 : 245;
    const o = 4 * (py * w + px);
    img.data[o] = img.data[o + 1] = img.data[o + 2] = c; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  tex.update(true);
  tex.anisotropicFilteringLevel = 4;
  return tex;
}

// The leg bones of one mannequin (Quaternius UAL1 names), with their rest rotations.
function legNodes(root) {
  const out = { rest: {} };
  for (const n of root.getChildTransformNodes(false)) {
    const m = /(thigh|calf|foot|ball)_([lr])$/.exec(n.name);
    if (m) { out[`${m[1]}_${m[2]}`] = n; out.rest[`${m[1]}_${m[2]}`] = n.rotationQuaternion.clone(); }
  }
  return out;
}

// A few points on each sole, in the frame of the bone they move with (foot, or ball for the toes):
// the boot vertices within 1 cm of the lowest one in the rest pose, the outermost in eight
// directions. null when the player file has no boots part (the plain mannequin).
function solePoints(root, L) {
  const nodes = [root, ...root.getChildTransformNodes(false)];
  nodes.forEach((n) => n.computeWorldMatrix(true));
  const boots = root.getChildMeshes(false).find((m) => m.material?.name === "boots");
  if (!boots?.skeleton) return null;
  boots.skeleton.prepare(true);
  const pos = boots.getPositionData(true, false), W = boots.computeWorldMatrix(true);
  const pts = [];
  for (let k = 0; k < pos.length; k += 3) pts.push(B.Vector3.TransformCoordinatesFromFloatsToRef(pos[k], pos[k + 1], pos[k + 2], W, new B.Vector3()));
  const out = {};
  for (const side of ["l", "r"]) {
    const F = L[`foot_${side}`].getAbsolutePosition(), T = L[`ball_${side}`].getAbsolutePosition();
    const O = L[`foot_${side === "l" ? "r" : "l"}`].getAbsolutePosition();
    const mine = pts.filter((q) => B.Vector3.DistanceSquared(q, F) < B.Vector3.DistanceSquared(q, O));
    const lo = Math.min(...mine.map((q) => q.y));
    const sole = mine.filter((q) => q.y < lo + 0.01);
    const fwd = new B.Vector3(T.x - F.x, 0, T.z - F.z).normalize(), lat = new B.Vector3(fwd.z, 0, -fwd.x);
    const toe = B.Vector3.Dot(T, fwd);
    out[side] = [];
    for (let a = 0; a < 8; a++) {
      const d = fwd.scale(Math.cos(a * Math.PI / 4)).add(lat.scale(Math.sin(a * Math.PI / 4)));
      const q = sole.reduce((m, x) => (B.Vector3.Dot(x, d) > B.Vector3.Dot(m, d) ? x : m), sole[0]);
      const bone = B.Vector3.Dot(q, fwd) > toe ? "ball" : "foot";
      out[side].push({ bone, at: B.Vector3.TransformCoordinates(q, L[`${bone}_${side}`].getWorldMatrix().clone().invert()) });
    }
  }
  return out;
}

// Grounding: the clips, their blends and the leg poses can put a sole under the grass (a straight
// support leg while the jog's pelvis is low, a keeper's dive). The root is lifted by that depth,
// set afresh each frame, so a body above the grass is never moved.
const sv = new B.Vector3();
function ground(p, soles) {
  const { root, legs } = p;
  root.position.y = 0;
  if (!root.parent?.isEnabled()) return;
  let low = Infinity;
  for (const side of ["l", "r"]) {
    const chain = [];
    for (let n = legs[`ball_${side}`]; n; n = n.parent) chain.unshift(n);
    chain.forEach((n) => n.computeWorldMatrix(true));
    for (const { bone, at } of soles[side]) {
      B.Vector3.TransformCoordinatesToRef(at, legs[`${bone}_${side}`].getWorldMatrix(), sv);
      low = Math.min(low, sv.y);
    }
  }
  if (low < 0) root.position.y = -low;
}

const AX = new B.Vector3(1, 0, 0), AY = new B.Vector3(0, 1, 0);
const qa = new B.Quaternion(), qb = new B.Quaternion(), qc = new B.Quaternion();
// Joint angles of ball3d.legPose on this skeleton: every leg joint bends about its parent's X axis
// (the leg is planar in the rest pose); hip flexion is a negative X turn, knee bend a positive one.
// absolute: write the pose itself (to measure it) instead of blending it over the locomotion.
function poseLegs(L, leg, absolute = false) {
  const { swing, support, w, ws } = legPose(leg.kind, leg.t);
  const apply = (side, [hip, knee, ankle, ext], wt) => {
    if (wt <= 0) return;
    const set = (bone, q) => {
      const n = L[`${bone}_${side}`];
      if (absolute) n.rotationQuaternion.copyFrom(q);
      else B.Quaternion.SlerpToRef(n.rotationQuaternion, q, wt, n.rotationQuaternion);
    };
    B.Quaternion.RotationAxisToRef(AX, -hip, qa);
    B.Quaternion.RotationAxisToRef(AY, side === "l" ? ext : -ext, qb);   // toes out
    qa.multiplyToRef(qb, qc);
    set("thigh", qc.multiply(L.rest[`thigh_${side}`]));
    B.Quaternion.RotationAxisToRef(AX, knee, qa);
    set("calf", qa.multiply(L.rest[`calf_${side}`]));
    B.Quaternion.RotationAxisToRef(AX, ankle, qa);
    set("foot", qa.multiply(L.rest[`foot_${side}`]));
  };
  apply(leg.side, swing, absolute ? 1 : w);
  if (!absolute) apply(leg.side === "l" ? "r" : "l", support, ws);
}
