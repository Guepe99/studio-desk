// 3D broadcast scene (Babylon.js 9, global BABYLON from web/vendor/babylonjs/).
// An evening match under floodlights (?light=day: the daylight stadium), the broadcast cameras of
// camera.js, the graded post chain of post.js, contact shadows of grounding.js,
// footballers on the Quaternius skeleton (players3d.js) driven by tracking.f32 with locomotion
// and event-driven actions.
// The parts live in web/js/scene3d/; docs/scene3d-research.md explains the choices.
// Ball handling (touches, first touch, kicks, ball speed and spin) comes from ball3d-rig.js.
//
// World axes: X = contract x - 52.5 (along the pitch), Z = contract y - 34 (across), Y up.
// The TV camera stands on the y < 0 side, so x grows to the right as on the 2D pitch.
import { pickProfile, detectEnv } from "./scene3d/quality.js";
import { setupLighting, lightMode, pbr } from "./scene3d/lighting.js";
import { Grounding } from "./scene3d/grounding.js";
import { setupPost } from "./scene3d/post.js";
import { buildPitch } from "./scene3d/pitch.js";
import { buildStadium } from "./scene3d/stands.js";
import { Cameras, REPLAY_ANGLES } from "./scene3d/camera.js";
import { setupAnimations, animatePlayer, scheduleActions, actionDriver, scheduleThrows, throwDriver, throwAt, THROW, resolve, facing, offset, applyUpper, settleFeet } from "./scene3d/players.js";
export { clipWeights } from "./scene3d/players.js";
import { BallRig, ballTexture } from "./ball3d-rig.js";
import { loadFootballer, dressFootballer } from "./players3d.js";
import { smoothMatch } from "./scene3d/track.js";
import { GoalNets } from "./scene3d/net.js";
import { buildScreens } from "./scene3d/screen.js";

const B = window.BABYLON;
const HALF_L = 52.5, HALF_W = 34;
const P = (x, y, h = 0) => new B.Vector3(x - HALF_L, h, y - HALF_W);

const PLAYER_H = 1.82;      // metres
export const BALL_R = 0.11; // real size: a size 5 ball is 68-70 cm round (docs/flow3d.md)
const YAW_OMEGA = 12;       // rad/s, the facing spring: critically damped, half a step in 0.14 s
const YAW_RATE_MAX = 8;     // rad/s, cap on the target's own turn rate fed forward to the spring
const VEL_H = 0.05;         // s, half-window of the speed estimate on the smooth path

const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

function canvasTexture(scene, name, w, h, draw, opts = {}) {
  const tex = new B.DynamicTexture(name, { width: w, height: h }, scene, opts.mipmaps ?? true);
  const g = tex.getContext();
  draw(g, w, h);
  tex.update(opts.invertY ?? true);
  tex.hasAlpha = !!opts.alpha;
  tex.anisotropicFilteringLevel = opts.aniso ?? 4;
  return tex;
}

// rough dielectric PBR, the stand-in for the flat materials of the night scene
function flatMat(scene, name, color, emissive = null) {
  return pbr(scene, name, color, { roughness: 0.6, emissive });
}

export class Scene3D {
  static async create(canvas, match, opts) {
    const s = new Scene3D(canvas, match, opts);
    await s._loadPlayers();
    await s.crowd.load().catch((e) => console.warn(`3D crowd not loaded, cards only: ${e.message}`));
    return s;
  }

  constructor(canvas, match, { capture = false, entities, goalEnd = 1, span = [0, match.duration] }) {
    this.canvas = canvas;
    this.span = span;   // match time the clip shows, for the ball plan
    // players on smooth paths through the tracking samples; the 2D page keeps the straight lines
    this.match = match = smoothMatch(match);
    this.ballR = BALL_R;
    this.goalEnd = goalEnd;
    this.entities = entities;
    // no MSAA on the canvas: every frame goes through the post pipeline, which has its own (post.js)
    const engine = this.engine = new B.Engine(canvas, false, { preserveDrawingBuffer: capture, stencil: false, powerPreference: "high-performance" }, true);
    const scene = this.scene = new B.Scene(engine);
    scene.skipPointerMovePicking = true;
    scene.constantlyUpdateMeshUnderPointer = false;
    const params = new URLSearchParams(location.search);
    this.profile = pickProfile(detectEnv(engine), params.get("quality"));

    this.light = setupLighting(scene, this.profile, lightMode(params.get("light")));
    this.cams = new Cameras(scene, match, goalEnd);
    if (REPLAY_ANGLES.includes(params.get("replay"))) this.cams.replayAngle = params.get("replay");
    this.tv = this.cams.tv;

    buildPitch(scene, this.profile);
    this._goals();
    this.crowd = buildStadium(scene, match, this.profile, mulberry(5));
    this.screen = buildScreens(scene, match, this.profile, this.tv.position);   // the big screens in the far corners
    this.light.shadeStands(scene.meshes.filter((m) => /^(tier|w|rf)_merged$|^crowd/.test(m.name)));
    this._ball();
    this.post = setupPost(scene, this.cams.list, this.profile);
    // for the tests: what the frame is made of
    this.debug = { profile: this.profile.name, ibl: !!scene.environmentTexture, shadows: this.profile.shadows, camera: "broadcast", light: this.light.mode };

    this.resize();
  }

  // Cap the render resolution (profile.maxWidth). No more pixels
  // than the screen shows: in the minimap the canvas sits in the scaled stage, smaller than its layout size.
  resize() {
    const cssW = this.canvas.clientWidth || 1280;
    const dpr = window.devicePixelRatio || 1, onScreen = this.canvas.getBoundingClientRect().width || cssW;
    const maxW = Math.min(this.profile.maxWidth, cssW < 900 ? 1100 : 1920);
    this.engine.setHardwareScalingLevel(Math.max(cssW / (onScreen * dpr), cssW / maxW));
    this.engine.resize();
  }

  _goals() {
    const scene = this.scene;
    const white = flatMat(scene, "post", new B.Color3(0.95, 0.95, 0.95), new B.Color3(0.25, 0.25, 0.25));
    const netTex = canvasTexture(scene, "netTex", 128, 128, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.strokeStyle = "#fff"; g.lineWidth = 3;
      for (let i = 0; i <= 128; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); }
    }, { alpha: true });
    netTex.wrapU = netTex.wrapV = B.Texture.WRAP_ADDRESSMODE;
    const net = new B.StandardMaterial("net", scene);
    net.diffuseTexture = netTex;
    net.useAlphaFromDiffuseTexture = true;
    net.transparencyMode = B.Material.MATERIAL_ALPHATEST;
    net.alphaCutOff = 0.3;
    net.backFaceCulling = false;
    // unlit white: the texture's transparent texels are black and darken lit, filtered cords
    net.disableLighting = true;
    net.diffuseColor = new B.Color3(0, 0, 0);
    net.emissiveColor = new B.Color3(0.82, 0.82, 0.82);
    const GW = 7.32, GH = 2.44, D = 2.2, cell = 0.12 * 4;   // one texture tile = 4 net cells
    const posts = [];
    for (const s of [-1, 1]) {
      const x = s * HALF_L;
      for (const z of [-GW / 2, GW / 2]) {
        const p = B.MeshBuilder.CreateCylinder("p", { diameter: 0.12, height: GH, tessellation: 10 }, scene);
        p.position.set(x, GH / 2, z); posts.push(p);
      }
      const bar = B.MeshBuilder.CreateCylinder("b", { diameter: 0.12, height: GW + 0.12, tessellation: 10 }, scene);
      bar.rotation.x = Math.PI / 2; bar.position.set(x, GH, 0); posts.push(bar);
    }
    const mp = B.Mesh.MergeMeshes(posts, true); mp.material = white; mp.freezeWorldMatrix();
    // one grid per goal, so a scored ball can push a pocket into it (scene3d/net.js)
    this.nets = new GoalNets(B, scene, net, HALF_L, { GW, GH, D }, cell);
  }

  _ball() {
    const scene = this.scene;
    this.ball = B.MeshBuilder.CreateSphere("ball", { diameter: BALL_R * 2, segments: 12 }, scene);
    const m = flatMat(scene, "ballMat", new B.Color3(1, 1, 1), new B.Color3(0.1, 0.1, 0.1));
    m.roughness = 0.45;
    m.albedoTexture = ballTexture(scene);
    this.ball.material = m;
    this.ball.rotationQuaternion = B.Quaternion.Identity();
    this.light.addCaster(this.ball);
    this.ballShadow = B.MeshBuilder.CreateGround("ballShadow", { width: BALL_R * 3, height: BALL_R * 3 }, scene);
    this.ballShadow.material = this._blobMat("ballShadowMat");   // contact shadow, every profile
  }

  // soft round contact shadow, darker in the middle (the sun is high, so it stays under the body)
  _blobMat(name) {
    this.blobTex ??= canvasTexture(this.scene, "blob", 128, 128, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      r.addColorStop(0, "rgba(0,0,0,0.6)"); r.addColorStop(0.45, "rgba(0,0,0,0.35)"); r.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = r; g.fillRect(0, 0, w, h);
    }, { alpha: true });
    const m = new B.StandardMaterial(name, this.scene);
    m.diffuseTexture = this.blobTex; m.useAlphaFromDiffuseTexture = true;
    m.disableLighting = true; m.emissiveColor = B.Color3.Black(); m.disableDepthWrite = true;
    m.zOffset = -2;
    return m;
  }

  async _loadPlayers() {
    const scene = this.scene, match = this.match;
    // cel-shaded anime footballers on the mannequin skeleton with the same clips (players3d.js);
    // ?players=footballer the earlier realistic body, ?players=mannequin the plain mannequin
    const look = new URLSearchParams(location.search).get("players");
    const lib = look === "mannequin" ? null : await loadFootballer(scene, { anime: look !== "footballer" });
    const container = lib?.container ?? await B.LoadAssetContainerAsync("vendor/quaternius/mannequin.glb", scene);
    // kit materials: primary on the body, secondary on the joints; goalkeepers in their own kit
    const kits = {};
    const kit = (team, gk) => {
      const id = `${team.team_id}${gk ? "gk" : ""}`;
      if (!kits[id]) {
        const body = pbr(scene, `${id}-body`, gk ? (team.side === "home" ? "#1f9d6b" : "#7a3fb8") : team.color_primary, { roughness: 0.7 });
        const joints = pbr(scene, `${id}-joints`, gk ? "#15171f" : team.color_secondary, { roughness: 0.6 });
        kits[id] = { body, joints };
      }
      return kits[id];
    };
    // measure the model once to scale it to PLAYER_H
    const probe = container.instantiateModelsToScene((n) => `probe-${n}`, false, { doNotInstantiate: true });
    const { min, max } = probe.rootNodes[0].getHierarchyBoundingVectors(true);
    const scale = PLAYER_H / (max.y - min.y);
    this.rig = new BallRig(scene, this.match, this.span, probe.rootNodes[0], scale, BALL_R);
    probe.rootNodes.forEach((n) => n.dispose());
    probe.animationGroups.forEach((g) => g.dispose());
    probe.skeletons.forEach((s) => s.dispose());

    this.players = [];
    for (const i of this.entities) {
      const pid = match.meta.entities[i];
      const pl = match.players[pid], team = match.teams[pl.team_id];
      const inst = lib ? dressFootballer(lib, pid, { team, gk: pl.position === "GK", shirt: pl.shirt })
        : container.instantiateModelsToScene((n) => `${pid}-${n}`, false, { doNotInstantiate: true });
      const holder = new B.TransformNode(`player-${pid}`, scene);
      const root = inst.rootNodes[0];
      root.parent = holder;
      root.scaling.scaleInPlace(scale * (inst.height ?? 1));
      if (!lib) {
        const k = kit(team, pl.position === "GK");
        for (const m of root.getChildMeshes()) {
          m.material = /joint/i.test(m.material?.name ?? "") ? k.joints : k.body;
          m.alwaysSelectAsActiveMesh = true;   // the bind-pose bounding box is wrong once animated
        }
      }
      for (const m of inst.casters ?? root.getChildMeshes()) this.light.addCaster(m);
      const anim = setupAnimations(inst, container, `${pid}-`);
      this.rig.addPlayer(i, root);
      this.players.push({ i, pid, holder, anim, yaw: null, phase: (this.players.length * 0.618) % 1, idle: (this.players.length * 0.37) % 1, w: [1, 0, 0, 0], aw: {}, face: inst.face });
    }
    // the container is not disposed: the clones share its geometry and lazy clips come from it
    this.container = container;
    this.drivers = [];
    this.addDriver({ priority: 20, pose: (i, ts) => this.rig.pose(i, ts) });
    this.addDriver(actionDriver(match, scheduleActions(match.events)));
    this.throws = scheduleThrows(match.events);
    this.addDriver(throwDriver(match, this.throws));
    scene.onAfterAnimationsObservable.add(() => { for (const p of this.players) { applyUpper(p); settleFeet(p, this.rig.players.get(p.i)?.sole); } this.throwBall(); });

    // contact darkening under every player, and blob shadows for the lights without a shadow map
    this.grounding = new Grounding(scene, this.players.length, this.light);
  }

  // --- per frame
  // view: {ts, replay}; dt: seconds of match time since the last call (0 after a jump).
  update(view, dt) {
    const { match } = this;
    const ts = this.ts = Math.min(view.ts, match.duration);
    const bp = this.rig.ball(ts), b = bp && [bp.x, bp.y, bp.h];
    if (b) {
      const z = b[2];
      this.ball.position.copyFrom(P(b[0], b[1], z + BALL_R));
      this.ball.rotationQuaternion.set(...bp.q);
      this.ballShadow.position.copyFrom(P(b[0], b[1], 0.03));
      this.ballShadow.material.alpha = 1 / (1 + z * 0.6);
    }
    this.ball.setEnabled(!!b);
    this.ballShadow.setEnabled(!!b);
    const np = this.rig.plan.net(ts);   // a scored ball pressing the netting
    this.nets.update(np && { end: np.end, plane: np.plane, at: [np.at[0] - HALF_L, np.at[2], np.at[1] - HALF_W], depth: np.depth });

    const gr = this.grounding;
    gr.frame();
    this.players.forEach((p, k) => {
      const now = match.at(p.i, ts);
      if (!now) { p.holder.setEnabled(false); gr.set(k, 0, 0, false); return; }
      p.holder.setEnabled(true);
      // shown position: tracking plus the drivers' offsets (the ball rig puts the foot on the ball)
      const r = resolve(this.drivers, p.i, ts);
      const at = (t) => { const q = match.at(p.i, t); if (!q) return q; const o = offset(this.drivers, p.i, t); return [q[0] + o[0], q[1] + o[1]]; };
      const shown = [now[0] + r.dx, now[1] + r.dy];
      // velocity of the shown point (the path is smooth, so a short window is enough)
      const a = at(Math.max(0, ts - VEL_H)) ?? shown, c = at(Math.min(match.duration, ts + VEL_H)) ?? shown;
      const vx = (c[0] - a[0]) / (2 * VEL_H), vy = (c[1] - a[1]) / (2 * VEL_H), v = Math.hypot(vx, vy);
      p.holder.position.copyFrom(P(shown[0], shown[1], r.dz));
      p.holder.rotation.z = r.roll;
      p.free = !r.action && !r.leg && Math.abs(r.dz) < 1e-3 && !r.emotion?.full;
      // face the run (away from it when backpedalling); when nearly still, face the ball unless it
      // is at his feet, where its bearing swings at random
      let want = p.want ?? p.yaw;
      if (v > 0.7) want = Math.atan2(vx, vy) + (r.mode === "backpedal" ? Math.PI : 0);
      else if (b && Math.hypot(b[0] - shown[0], b[1] - shown[1]) > 1) want = Math.atan2(b[0] - shown[0], b[1] - shown[1]);
      p.want = want;
      // the drivers turn the body over that facing, in priority order (players.js); the result goes
      // through a critically damped spring that also follows the target's own turn rate, so it
      // never snaps and does not lag a steady turn
      const target = facing(want ?? 0, r.turns);
      if (p.yaw === null || dt === 0) { p.yaw = target; p.yawV = 0; }
      else {
        const tv = Math.max(-YAW_RATE_MAX, Math.min(YAW_RATE_MAX, angleDiff(p.target, target) / dt));
        for (let left = dt; left > 1e-6; left -= 0.01) {
          const h = Math.min(0.01, left);
          p.yawV += (YAW_OMEGA * YAW_OMEGA * angleDiff(p.yaw, target) + 2 * YAW_OMEGA * (tv - p.yawV)) * h;
          p.yaw += p.yawV * h;
        }
      }
      p.target = target;
      p.holder.rotation.y = p.yaw;
      this.rig.setLeg(p.i, r.leg);
      // run direction in the character's frame [left, forward] (the motion loops pick by it);
      // the glTF character's left is local -X in Babylon, so left = (-cos yaw, sin yaw) in x/z
      const yw = p.holder.rotation.y;
      if (v > 0.2) r.runL = [(-vx * Math.cos(yw) + vy * Math.sin(yw)) / v, (vx * Math.sin(yw) + vy * Math.cos(yw)) / v];
      animatePlayer(p, v, dt, r, this.motion);
      p.face?.(r, v, ts);   // anime faces: expression from the emotion and the speed
      gr.set(k, p.holder.position.x, p.holder.position.z, true);
    });
    gr.commit();

    this.crowd.update(ts);
    this.screen.update(ts);
    this.cams.update(view, ts, dt);
    this.post.update(this.cams);
    this.debug.camera = this.cams.mode;
  }

  // A throw-in: the ball goes from the grass to the thrower's hands as he picks it up, stays between
  // them over his head, and after the release eases back onto the drawn flight (players.js THROW).
  throwBall() {
    const ts = this.ts;
    for (const p of this.players) {
      const a = ts === undefined ? null : throwAt(this.throws[p.pid], ts);
      if (!a || !p.holder.isEnabled() || !this.ball.isEnabled()) continue;
      const hands = ["hand_l", "hand_r"].map((name) => {
        const c = [];
        for (let n = p.anim.node(name); n; n = n.parent) c.unshift(n);
        c.forEach((n) => n.computeWorldMatrix(true));
        return c.at(-1)?.getAbsolutePosition();
      });
      if (!hands[0] || !hands[1]) return;
      const grip = hands[0].add(hands[1]).scaleInPlace(0.5);
      grip.y += BALL_R * 0.6;   // the hand bones are the wrists: the ball sits in the palms, above them
      const k = a.u < 0 ? (a.u - THROW.start) / 0.4 : 1 - a.u / THROW.end, u = Math.min(1, Math.max(0, k));
      B.Vector3.LerpToRef(this.ball.position, grip, u * u * (3 - 2 * u), this.ball.position);
      this.ballShadow.position.x = this.ball.position.x;
      this.ballShadow.position.z = this.ball.position.z;
      this.ballShadow.material.alpha = 1 / (1 + (this.ball.position.y - BALL_R) * 0.6);
      return;
    }
  }

  // Plans the ball, the awareness layer and the keepers for another stretch of match time: the
  // broadcast page keeps a window around its clock, so a whole match never sits in memory.
  replan(span) {
    this.span = span;
    this.rig.replan(span);
    this.awareness?.replan(span);
    this.keeper?.replan(span);
  }

  // the page drives frames from its own requestAnimationFrame: beginFrame and endFrame let Babylon
  // measure the real frame rate, which the fps readout reads (else 60 forever)
  render() { this.engine.beginFrame(); this.scene.render(); this.engine.endFrame(); }

  // Plug a driver in: {priority, pose(i, ts)}, see web/js/scene3d/players.js. Awareness modules
  // take priority 10, so the ball rig (20) and the event actions (30) win over them.
  addDriver(d) {
    this.drivers.push(d);
    this.drivers.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  }

  // Screen position, in 1920 x 1080 stage pixels, of a player's feet (or of the point `above` metres over them).
  project(entityIndex, ts, above = 0) {
    const p = this.match.at(entityIndex, Math.min(ts, this.match.duration));
    if (!p) return { x: 0, y: 0, visible: false };
    const o = offset(this.drivers, entityIndex, Math.min(ts, this.match.duration));
    const cam = this.scene.activeCamera;
    const world = P(p[0] + o[0], p[1] + o[1], above);
    const w = this.engine.getRenderWidth(), h = this.engine.getRenderHeight();
    const view = cam.getViewMatrix();
    if (B.Vector3.TransformCoordinates(world, view).z <= 0) return { x: 0, y: 0, visible: false };
    const s = B.Vector3.Project(world, B.Matrix.IdentityReadOnly, cam.getTransformationMatrix(), cam.viewport.toGlobal(w, h));
    const x = (s.x / w) * 1920, y = (s.y / h) * 1080;
    return { x, y, visible: x > -200 && x < 2120 && y > -200 && y < 1280 };
  }
}

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
