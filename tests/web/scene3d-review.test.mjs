// The 3D scene's review fixes: the drivers are asked once per player and time in a frame and
// the picture is the same, a 64x frame puts the facing spring at rest instead of thousands of
// steps, the keepers' shirts stand apart from both teams and the grass and are the same in 2D and
// 3D, a keeper rig on a match without players and a failed 3D load leave nothing broken behind.
//   node --test tests/web/scene3d-review.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, "../..");
// the real Babylon in node: math, nodes and a NullEngine, nothing drawn
globalThis.window ??= { BABYLON: createRequire(import.meta.url)("../../web/vendor/babylonjs/9.29.0/babylon.js") };
const B = window.BABYLON;
const S3 = await import("../../web/js/scene3d.js"), { Scene3D } = S3;
const P = await import("../../web/js/scene3d/players.js");
const K = await import("../../web/js/players3d.js");
const PT = await import("../../web/js/pitch.js");
const { AwarenessRig } = await import("../../web/js/awareness-rig.js");
const { KeeperRig } = await import("../../web/js/keeper3d-rig.js");
const { CLIPS } = await import("../../web/js/keeper3d.js");
const { BallPlan } = await import("../../web/js/ball3d.js");
const { View3D } = await import("../../web/js/view3d.js");
const { Match } = await import("../../web/js/match.js");
const { smoothMatch } = await import("../../web/js/scene3d/track.js");

const MOTION_FILE = path.join(ROOT, "web/vendor/motion/clips.json");
const motion = existsSync(MOTION_FILE) ? JSON.parse(readFileSync(MOTION_FILE, "utf8")) : null;
const meta = (id) => { const f = path.join(ROOT, "web/data", id, "meta.json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; };
function load(id) {
  const dir = path.join(ROOT, "web/data", id);
  if (!existsSync(path.join(dir, "meta.json"))) return null;
  const j = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const buf = readFileSync(path.join(dir, "tracking.f32"));
  return new Match(j("meta.json"), j("events.json"), j("facts.json"), j("cues.json"), new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

// Scene3D.update and render on a real match with the real drivers (ball rig, actions, throw-ins,
// awareness, keeper) and stand-ins for the Babylon objects; render() asks the awareness layer's
// _held once per shown player as its _post does. memo: the drivers go in through addDriver, else
// straight into s.drivers as the scene asked them before. calls counts the drivers' own answers.
function scene(raw, span, memo) {
  const s = Object.create(Scene3D.prototype);
  const match = s.match = smoothMatch(raw);
  s.span = span; s.ballR = 0.11; s.motion = motion; s.rootOmega = 20; s.drivers = []; s.calls = 0;
  const entities = [];
  for (let i = 1; i < match.n; i++) for (let f = 0; f < match.meta.frames; f += 10) if (!Number.isNaN(match.pos[(f * match.n + i) * 3])) { entities.push(i); break; }
  const log = s.log = [];
  const group = (name) => ({ name, from: 0, to: 100, setWeightForAllAnimatables(w) { log.push(["w", name, w]); }, goToFrame(f) { log.push(["f", name, f]); } });
  s.players = entities.map((i, k) => {
    const cache = {};
    const anim = { loco: P.LOCO.map((c) => group(c.name)), fps: 30, cache, legs: [], get(n) { return n in cache ? cache[n] : (cache[n] = group(n)); } };
    const holder = { position: new B.Vector3(), rotation: new B.Vector3(), en: true, setEnabled(e) { this.en = e; }, isEnabled() { return this.en; } };
    return { i, pid: match.meta.entities[i], holder, anim, h: 1, yaw: null, phase: (k * 0.618) % 1, idle: (k * 0.37) % 1, w: [1, 0, 0, 0], aw: {} };
  });
  const plan = new BallPlan(match, span, { ballR: 0.11 });
  s.rig = { plan, players: new Map(), ball: (ts) => plan.ball(ts), pose: (i, ts) => plan.pose(i, ts), setLeg(i, leg) { log.push(["leg", i, leg]); } };
  s.ball = { position: new B.Vector3(), rotationQuaternion: new B.Quaternion(), setEnabled() {}, isEnabled: () => true };
  s.ballShadow = { position: new B.Vector3(), material: { alpha: 1 }, setEnabled() {} };
  s.nets = { update() {} }; s.grounding = { frame() {}, set() {}, commit() {} };
  s.crowd = { update() {} }; s.cams = { update() {}, mode: "wide" }; s.post = { update() {} }; s.debug = {};
  const add = (d) => {
    const counted = { ...d, pose: (i, ts) => { s.calls++; return d.pose(i, ts); } };
    if (memo) s.addDriver(counted);
    else { s.drivers.push(counted); s.drivers.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)); }
  };
  // _loadPlayers' drivers, then the awareness and keeper layers as their constructors plug them in
  add({ priority: 20, pose: (i, ts) => s.rig.pose(i, ts) });
  add(P.actionDriver(match, P.scheduleActions(match.events)));
  s.throws = P.scheduleThrows(match.events, match);
  add(P.throwDriver(match, s.throws));
  const aw = Object.create(AwarenessRig.prototype);
  aw.s = s; s.awareness = aw; aw.use(aw.planFor(span, plan)); aw.enabled = true;
  add({ priority: 10, pose: (i, ts) => aw.pose(i, ts) });
  const kr = Object.create(KeeperRig.prototype);
  kr.s = s; s.keeper = kr; kr.enabled = true; kr.real = {}; kr.use(kr.planFor(span, plan));
  add({ priority: 30, pose: (i, ts) => kr.pose(i, ts) });
  aw.aw.bodyOf = (i, ts) => kr.body(i, ts);
  s.engine = { beginFrame() {}, endFrame() {} };
  s.scene = { render() { for (const p of s.players) if (p.holder.isEnabled()) log.push(["held", p.i, aw._held(p.i, s.ts)]); } };
  return s;
}
const snap = (s) => s.players.map((p) => [p.holder.en, p.holder.position.x, p.holder.position.y, p.holder.position.z, p.holder.rotation.y, p.holder.rotation.z,
  p.yaw, p.yawV, p.target, p.phase, p.lphase, p.idle, p.ws, p.wl, p.lw, p.loop, p.upper, p.aw, p.free, p.fw, p.warpS, p.running, p.want]);

const raw = load("M001");
const T0 = 1540, SPAN = [T0 - 15, T0 + 105];
// a seek, 1 s at 1x and 60 fps, 1.3 s at 4x, 2 s of 4x at 10 fps
const DTS = [0, ...Array(60).fill(1 / 60), ...Array(20).fill(4 / 60), ...Array(5).fill(0.4)];

test("M001: each driver answers a player once per time in a frame, and the frame is the same", { skip: (!raw || !motion) && "no web/data/M001 or motion clips" }, () => {
  const a = scene(raw, SPAN, true), b = scene(raw, SPAN, false);
  let ts = T0, shown = 0;
  for (const dt of DTS) {
    ts += dt;
    for (const s of [a, b]) { s.update({ ts, replay: false }, dt); s.render(); }
    assert.deepEqual(snap(a), snap(b), `players at ${ts}`);
    assert.deepEqual(a.log.splice(0), b.log.splice(0), `clips, weights and held at ${ts}`);
    assert.deepEqual(a.ball.position.asArray(), b.ball.position.asArray(), `ball at ${ts}`);
    shown += a.players.filter((p) => p.holder.en).length;
  }
  // before: resolve 5 + the awareness _held 4, the speed window 2 x 9, render's _held 4 = 31
  const per = a.calls / shown, before = b.calls / shown;
  assert.ok(per <= 15, `${per.toFixed(2)} driver answers per player per frame (${before.toFixed(2)} unkept)`);
  assert.ok(a.poseFrame === null, "the kept answers end with render()");
});

test("M001: frames up to 1 s step the facing spring, a 64x frame puts it at its resting point", { skip: (!raw || !motion) && "no web/data/M001 or motion clips" }, () => {
  const s = scene(raw, SPAN, true);
  // the steps of the facing spring as update() takes them, from the state before the frame
  const stepped = (yaw, yawV, prev, target, dt) => {
    const tv = Math.max(-8, Math.min(8, angleDiff(prev, target) / dt));
    for (let left = dt; left > 1e-6; left -= 0.01) {
      const h = Math.min(0.01, left);
      yawV += (144 * angleDiff(yaw, target) + 24 * (tv - yawV)) * h;
      yaw += yawV * h;
    }
    return yaw;
  };
  let ts = T0, fast = 0, slow = 0;
  for (const dt of [...DTS, ...Array(4).fill(64 / 60), 6.4, 6.4]) {
    const before = s.players.map((p) => ({ yaw: p.yaw, yawV: p.yawV, target: p.target, en: p.holder.en }));
    ts += dt;
    s.update({ ts, replay: false }, dt);
    s.render();
    s.players.forEach((p, k) => {
      const o = before[k];
      if (!dt || o.yaw === null || !o.en || !p.holder.en) return;
      const ref = stepped(o.yaw, o.yawV, o.target, p.target, dt);
      if (dt <= 1) { assert.equal(p.yaw, ref, `player ${p.i} at ${ts}: the steps`); slow++; return; }
      assert.equal(p.yawV, 0, `player ${p.i} at ${ts}: at rest after a ${dt} s frame`);
      assert.ok(Math.abs(angleDiff(p.yaw, ref)) < 1e-3, `player ${p.i} at ${ts}: ${angleDiff(p.yaw, ref)} rad from the steps`);
      fast++;
    });
  }
  assert.ok(slow > 1000 && fast > 30, `${slow} stepped, ${fast} settled`);
});

// every match of web/data, the DEMO fixture too
const MATCHES = existsSync(path.join(ROOT, "web/data")) ? readdirSync(path.join(ROOT, "web/data")).filter((id) => meta(id)) : [];
for (const id of MATCHES) {
  const m = meta(id);
  test(`${id}: each keeper's shirt stands apart from both teams, the other keeper and the grass`, () => {
    const kits = PT.keeperKits(m.teams);
    assert.deepEqual(PT.keeperKits(m.teams), kits, "the same every time");
    const avoid = [...m.teams.flatMap((t) => [t.color_primary, t.color_secondary]), ...PT.GRASS];
    for (const [side, other] of [["home", "away"], ["away", "home"]]) {
      const gap = Math.min(...[...avoid, kits[other]].map((c) => PT.deltaE(kits[side], c)));
      assert.ok(gap >= 25, `${side} keeper ${kits[side]}: ${gap.toFixed(1)} from the nearest`);
      assert.ok(PT.GK_PALETTE.includes(kits[side]));
    }
    const team = m.teams.find((t) => t.side === "home");
    assert.deepEqual(K.kitColours(team, true), K.kitColours(team, true, "#1f9d6b"), "default: the home keeper's old shirt");
  });

  // the 2D pitch (also the minimap over the 3D view) and the 3D kits show the same keeper colour,
  // and _loadPlayers dresses each keeper (footballer or mannequin) from dressOf
  test(`${id}: the 2D pitch and the 3D dress each keeper in the same colour`, () => {
    const match = { players: Object.fromEntries(m.players.map((p) => [p.player_id, p])), teams: Object.fromEntries(m.teams.map((t) => [t.team_id, t])) };
    const flat = PT.keeperColours(m.teams), kits = PT.keeperKits(match.teams);
    const keepers = m.players.filter((p) => p.position === "GK");
    assert.ok(keepers.length >= 2);
    for (const p of keepers) {
      const d = S3.dressOf(match, kits, p.player_id);
      assert.equal(d.gk, true);
      assert.equal(d.keeper, flat[p.team_id], `${p.player_id}: 3D ${d.keeper}, 2D ${flat[p.team_id]}`);
      assert.deepEqual(K.kitColours(d.team, d.gk, d.keeper).shirt, K.kitColours(d.team, true, flat[p.team_id]).shirt);
    }
  });
}

test("team colours that are not #rrggbb are left out of the keepers' pick", () => {
  const teams = [{ team_id: "A", side: "home", color_primary: "#fff", color_secondary: "#c00" }, { team_id: "B", side: "away", color_primary: "#7a3fb8", color_secondary: "navy" }];
  const kits = PT.keeperKits(teams);
  assert.notEqual(kits.home, kits.away);
  assert.ok(PT.GK_PALETTE.includes(kits.home) && PT.GK_PALETTE.includes(kits.away));
  assert.ok(PT.deltaE(kits.away, "#7a3fb8") >= 25, "away keeper apart from the valid away colour");
});

test("a keeper rig on a match without players builds, with the procedural poses", { skip: (!raw || !motion) && "no web/data/M001 or motion clips" }, () => {
  const scene3 = new B.Scene(new B.NullEngine());
  // a probe skeleton with the bones the rig reads, and a clip of every keeper name already there
  const root = new B.TransformNode("gk-probe-root", scene3);
  const bones = { spine_01: [0, 1, 0], spine_03: [0, 1.3, 0], neck_01: [0, 1.5, 0], upperarm_l: [-0.2, 1.4, 0], upperarm_r: [0.2, 1.4, 0],
    lowerarm_l: [-0.45, 1.4, 0], lowerarm_r: [0.45, 1.4, 0], hand_l: [-0.7, 1.4, 0], hand_r: [0.7, 1.4, 0],
    thigh_l: [-0.1, 0.95, 0], thigh_r: [0.1, 0.95, 0], calf_l: [-0.1, 0.5, 0], calf_r: [0.1, 0.5, 0], foot_l: [-0.1, 0.05, 0], foot_r: [0.1, 0.05, 0] };
  for (const [b, at] of Object.entries(bones)) {
    const n = new B.TransformNode(`gk-probe-${b}`, scene3);
    n.parent = root; n.position.fromArray(at); n.rotationQuaternion = B.Quaternion.Identity();
  }
  const names = [...new Set(Object.values(CLIPS).flat())];
  const container = {
    transformNodes: [],
    animationGroups: names.map((name) => ({ name, targetedAnimations: [{ animation: { framePerSecond: 30 } }] })),
    instantiateModelsToScene: () => ({ rootNodes: [root], animationGroups: [], skeletons: [] }),
  };
  const match = smoothMatch(raw), span = [T0, T0 + 30];
  const drivers = [];
  const s = { scene: scene3, container, match, span, ballR: 0.11, players: [], rig: { plan: new BallPlan(match, span, { ballR: 0.11 }) },
    motion: { fps: 30, clips: Object.fromEntries(names.map((n) => [n, { root: [[0, 0, 0]] }])) }, addDriver: (d) => drivers.push(d) };
  const rig = new KeeperRig(s);
  assert.deepEqual(rig.real, {}, "nothing measured without a player to scale by");
  assert.equal(drivers.length, 1);
});

test("a 3D view whose rigs fail to build disposes its engine and passes the error on", async () => {
  const realCreate = Scene3D.create, realFetch = globalThis.fetch, realWarn = console.warn;
  let disposed = 0;
  const s = { engine: { dispose() { disposed++; }, onContextLostObservable: { add() {} } } };   // no container: AwarenessRig throws
  Scene3D.create = async () => s;
  globalThis.fetch = async () => { throw new Error("offline"); };
  console.warn = () => {};
  try {
    const v = Object.create(View3D.prototype);
    v.match = { n: 1, meta: { frames: 0 }, pos: new Float32Array(0), duration: 10 };
    v.els = { canvas: {} };
    v._apply = () => assert.fail("a scene that failed is never shown");
    // AwarenessRig reads s.container of a scene that has none
    await assert.rejects(v._load(), (e) => e instanceof TypeError && /container|undefined/.test(e.message) && /awareness-rig/.test(e.stack));
    assert.equal(disposed, 1, "the engine is disposed");
    assert.equal(v.scene, undefined);
  } finally {
    Scene3D.create = realCreate; globalThis.fetch = realFetch; console.warn = realWarn;
  }
});
