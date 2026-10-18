// Babylon side of the ball handling: puts the BallPlan of ball3d.js on the mannequins.
// The scene asks it for the ball transform and each player's root offset and facing, and tells it
// which leg action each player is in; the rig poses the legs after the locomotion clips have run.
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
    // leg actions go on top of the locomotion pose, once the animation groups have written it
    scene.onAfterAnimationsObservable.add(() => {
      for (const p of this.players.values()) if (p.leg) poseLegs(p.legs, p.leg);
    });
  }

  addPlayer(i, root) { this.players.set(i, { legs: legNodes(root), leg: null }); }
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
