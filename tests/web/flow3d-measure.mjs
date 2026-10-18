// Flow numbers of the 3D sample (docs/flow3d.md): steps the scene at 60 Hz through the live part
// of the clip without drawing (update + animation pass only) and measures what the eye sees move:
// player velocity jumps, planted-foot slide per step, facing turn rates, camera acceleration, clip
// weight pops and LOD switches; then plays the page live for a few seconds for the frame pacing.
// Prints one JSON object. Run it on the branch before and after a change to compare.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh flow3d-measure.mjs [match] [from] [seconds]
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

// run as a script; tests/web/sample3d-shots.mjs imports measure() for its flow checks
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const match = process.argv[3] ?? "M001";
const from = process.argv[4] ? `&from=${process.argv[4]}` : "";
const seconds = Number(process.argv[5] ?? 12);
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.setDefaultTimeout(600000);
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  await page.goto(new URL(`sample3d.html?match=${match}&capture=1${from}`, base).href);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 180000 });
  const out = await page.evaluate(measure, seconds);
  // live page: rAF intervals, how the clock advances, optimizer steps
  const live = await browser.newContext({ viewport: { width: 1280, height: 720 } }).then((c) => c.newPage());
  await live.goto(new URL(`sample3d.html?match=${match}${from}`, base).href);
  await live.waitForFunction(() => window.sample3d?.ready, null, { timeout: 180000 });
  out.pacing = await live.evaluate(pacing);
  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
}
}

export async function measure(seconds) {
  const s = window.sample3d, sc = s.scene, m = s.match, B = window.BABYLON;
  const { resolve } = await import("./js/scene3d/players.js");
  const HZ = 60, dt = 1 / HZ;
  const stop = Math.min(seconds, (s.tl.cuts[1] ?? 20) - 0.1);
  const q = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(3); };
  const stat = (arr) => ({ n: arr.length, p50: q(arr, 0.5), p95: q(arr, 0.95), p99: q(arr, 0.99), max: q(arr, 1) });
  const P = sc.players.map((p) => ({ p, prev: null, v: null, yaw: null, base: null, yr: null, feet: {}, lod: null, w: null }));
  const dv = [], dvRaw = [], acc = [], yawRate = [], yawJerk = [], snaps = [], camAcc = [], pops = [], popKeys = {}, slides = { walk: [], jog: [], sprint: [] }, slideSpeed = { walk: [], jog: [], sprint: [] };
  let lodSwitches = 0, lodN = 0, lodFar = 0, cam = null, camV = null, camOff = 0;
  const meshes = new Map(sc.players.map((p) => [p.i, p.holder.getChildMeshes(false).find((x) => x.hasLODLevels)]));
  for (let k = 0; k * dt < stop; k++) {
    const c = k * dt, ts = s.tl.at(c).ts;
    sc.update({ ts, replay: false }, k ? dt : 0);
    sc.scene.animate();
    const camT = sc.cams.tv.getTarget().clone();
    if (cam) { const v = camT.subtract(cam).scale(HZ); if (camV) camAcc.push(v.subtract(camV).length() * HZ); camV = v; }
    cam = camT;
    if (Math.abs(camT.x) > 52.6 || Math.abs(camT.z) > 34.1) camOff++;   // aiming at the stands
    sc.scene.activeCamera.getViewMatrix(true);
    for (const r of P) {
      const h = r.p.holder;
      if (!h.isEnabled()) { r.prev = null; r.v = null; continue; }
      const pos = [h.position.x, h.position.z];
      // raw tracking velocity jumps, without the drivers' offsets
      const t0 = m.at(r.p.i, ts), t1 = m.at(r.p.i, ts + dt), t2 = m.at(r.p.i, ts + 2 * dt);
      if (t0 && t1 && t2) dvRaw.push(Math.hypot(t2[0] - 2 * t1[0] + t0[0], t2[1] - 2 * t1[1] + t0[1]) * HZ);
      if (r.prev) {
        const v = [(pos[0] - r.prev[0]) * HZ, (pos[1] - r.prev[1]) * HZ];
        if (r.v) { const d = Math.hypot(v[0] - r.v[0], v[1] - r.v[1]); dv.push(d); acc.push(d * HZ); }
        r.v = v;
        r.speed = Math.hypot(...v);
      }
      r.prev = pos;
      const y = h.rotation.y;
      if (r.yaw !== null) {
        const d = Math.atan2(Math.sin(y - r.yaw), Math.cos(y - r.yaw)), rate = Math.abs(d) * HZ;
        yawRate.push(rate * 180 / Math.PI);
        if (Math.abs(d) > (15 * Math.PI) / 180) {
          const db = r.base === null ? 0 : Math.atan2(Math.sin(r.p.yaw - r.base), Math.cos(r.p.yaw - r.base));
          snaps.push({ pid: r.p.pid, ts: +ts.toFixed(2), deg: +(d * 180 / Math.PI).toFixed(1), baseDeg: +(db * 180 / Math.PI).toFixed(1) });
        }
        if (r.yr !== null) yawJerk.push(Math.abs(d * HZ - r.yr) * 180 / Math.PI);
        r.yr = d * HZ;
      }
      r.yaw = y; r.base = r.p.yaw;
      // clip weights: largest change of any clip's weight in one frame
      const w = { ...Object.fromEntries(r.p.w.map((x, j) => [`loco${j}`, x])), ...r.p.aw };
      if (r.w) {
        let top = 0, key = null;
        for (const kk of new Set([...Object.keys(w), ...Object.keys(r.w)])) { const d = Math.abs((w[kk] ?? 0) - (r.w[kk] ?? 0)); if (d > top) { top = d; key = kk; } }
        pops.push(top);
        if (top > 0.2) popKeys[key] = (popKeys[key] ?? 0) + 1;
      }
      r.w = w;
      // feet: the lower of the ankle and toe bones of each foot, analysed after the run; the gait
      // mode too, since backpedal, strafe and jockey are stand-ins played from the forward clips
      const mode = resolve(sc.drivers, r.p.i, ts).mode ?? "forward";
      for (const side of ["l", "r"]) {
        const f = r.p.anim.node(`foot_${side}`), t = r.p.anim.node(`ball_${side}`);
        if (!f || !t) continue;
        t.computeWorldMatrix(true);   // walks up the parents
        const a = f.getAbsolutePosition(), b = t.getAbsolutePosition();
        const low = a.y < b.y ? a : b;
        ((r.feet[side] ??= [])).push([low.x, low.y, low.z, r.speed ?? 0, r.p.w[0] > 0.5 || (r.p.aw && Object.values(r.p.aw).some((x) => x > 0.5)), mode]);
      }
      const mesh = meshes.get(r.p.i);
      if (mesh) {
        mesh.computeWorldMatrix(true);
        const lod = mesh.getLOD(sc.scene.activeCamera)?.name ?? null;
        if (r.lod !== null && lod !== r.lod) lodSwitches++;
        lodN++; if (lod && /lod1/.test(lod)) lodFar++;
        r.lod = lod;
      }
    }
  }
  // planted foot: within 2.5 cm of that foot's floor (its 5th percentile height); slide = how far
  // it moves while planted, per step, by the body's mean speed (idle and actions left out; steps
  // in a stand-in mode counted apart)
  const otherModes = [];
  for (const r of P) for (const tr of Object.values(r.feet)) {
    const ys = tr.map((x) => x[1]).sort((a, b) => a - b), floor = ys[Math.floor(ys.length * 0.05)];
    let path = 0, n = 0, sp = 0, skip = false, other = false;
    for (let k = 1; k <= tr.length; k++) {
      const on = k < tr.length && tr[k][1] < floor + 0.025 && tr[k - 1][1] < floor + 0.025;
      if (on) { path += Math.hypot(tr[k][0] - tr[k - 1][0], tr[k][2] - tr[k - 1][2]); sp += tr[k][3]; n++; skip ||= tr[k][4]; other ||= tr[k][5] !== "forward"; continue; }
      if (n >= 4 && !skip) {
        const v = sp / n, band = v < 0.5 ? null : v < 2.2 ? "walk" : v < 5.5 ? "jog" : "sprint";
        if (band && other) otherModes.push(path);
        else if (band) { slides[band].push(path); slideSpeed[band].push(path / (n / HZ)); }
      }
      path = 0; n = 0; sp = 0; skip = false; other = false;
    }
  }
  const players = P.length;
  return {
    window: { from: s.tl.from, seconds: +stop.toFixed(2), hz: HZ, players },
    velocityJumpRaw: stat(dvRaw),
    velocityJumpShown: stat(dv),
    accelShown: stat(acc),
    yawRateDeg: stat(yawRate),
    yawAccelDeg: stat(yawJerk),
    yawSnaps: snaps.length, snapList: snaps.slice(0, 12),
    cameraAccel: stat(camAcc), cameraOffPitchFrames: camOff,
    clipWeightPop: stat(pops), popsOver02: popKeys,
    lodSwitchesPerPlayerMinute: +(lodSwitches / players / (stop / 60)).toFixed(2),
    footSlide: Object.fromEntries(Object.entries(slides).map(([k, v]) => [k, stat(v)])),
    footSlideOtherModes: stat(otherModes),
    footSlideSpeed: Object.fromEntries(Object.entries(slideSpeed).map(([k, v]) => [k, stat(v)])),
    lodFar: +(lodFar / Math.max(1, lodN)).toFixed(2),
  };
}

async function pacing() {
  const s = window.sample3d, dts = [], clock = [];
  let applied = 0;
  s.scene.optimizer?.onNewOptimizationAppliedObservable?.add(() => applied++);
  // warm up: the first frames compile shaders
  for (let k = 0; k < 3; k++) await new Promise((r) => requestAnimationFrame(r));
  const t0 = performance.now();
  let last = null, lastC = s.state.c;
  await new Promise((done) => {
    const tick = (now) => {
      if (last !== null) { dts.push(now - last); clock.push((s.state.c - lastC + 20) % 20); }
      last = now; lastC = s.state.c;
      if (now - t0 < 15000) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  });
  // clock lag: clock seconds advanced against real seconds elapsed
  const real = dts.reduce((a, b) => a + b, 0) / 1000, adv = clock.reduce((a, b) => a + b, 0);
  const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(1); };
  return { frames: dts.length, msP50: q(dts, 0.5), msP95: q(dts, 0.95), msMax: q(dts, 1), clockOverReal: +(adv / real).toFixed(3),
    optimizerSteps: applied, profile: s.scene.debug.profile, shadows: s.scene.debug.shadows };
}
