// Stills of the anime footballers (?players=anime, docs/anime3d.md), saved to out/shots/:
//   anime3d-compare.png   today's footballers (top) and the anime ones (bottom), front and back
//   anime3d-clips.png     one player: idle, jog, sprint, shot at contact, ball at the foot, celebration
//   anime3d-variants.png  ten players side by side: hair styles, hair and eye colours, heights
//   anime3d-face.png      a face close: determined (sprinting), joy, frustration
//   anime3d-wide.png      the broadcast TV frame
//   anime3d-goal.png      the scorer celebrating, close
// It checks that the anime body is on the mannequin skeleton (clips and rig move its bones) and that
// the faces change, and prints frames/s for the default and the anime players, measured in turns
// (default, anime, default, anime) on fresh pages, as players3d-shots.mjs measures them.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh anime3d-shots.mjs
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out");
const shots = `${out}/shots`, tmp = `${out}/anime3d-tmp`;
mkdirSync(shots, { recursive: true });
mkdirSync(tmp, { recursive: true });

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };

async function open(browser, look) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.setDefaultTimeout(300000);   // the near players' shaders compile on the first close shot, slowly in software
  page.on("console", (m) => { if (m.type() === "error") fail(`console (${look}): ${m.text()}`); });
  page.on("pageerror", (e) => fail(`page error (${look}): ${e.message}`));
  page.on("requestfailed", (r) => fail(`request failed (${look}): ${r.url()}`));
  await page.goto(new URL(`sample3d.html?match=DEMO&capture=1&view=3d${look === "anime" ? "&players=anime" : ""}`, base).href);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 300000 });
  return page;
}

// as players3d-shots.mjs: warm until every shader is compiled, then count __setTime frames for 4 s
const fps = (page) => page.evaluate(async () => {
  const s = window.sample3d.scene.scene;
  for (let k = 0; k < 300 && !s.isReady(); k++) { await window.__setTime(4); await new Promise((r) => setTimeout(r, 50)); }
  for (let k = 0; k < 4; k++) await window.__setTime(3 + k * 0.04);
  const t0 = performance.now();
  let n = 0;
  while (performance.now() - t0 < 4000) { await window.__setTime(4 + n * 0.04); n++; }
  return n / ((performance.now() - t0) / 1000);
});

// as players3d-shots.mjs: a few players at the centre spot, the others hidden, the replay camera on
// them. rows: [{ pid, x, z, yaw, w: clip weights, phase, leg, ball, face: [emotion kind, speed] }]
const stage = (page, { rows, cam, target, fov }) => page.evaluate(async ({ rows, cam, target, fov }) => {
  const s = window.sample3d, sc = s.scene, B = window.BABYLON;
  await window.__setTime(4);
  sc.scene.animationTimeScale = 0;   // the pose set below holds while the shaders compile
  sc.awareness.enabled = false;      // and the head looks where the clip looks, not at the ball
  document.querySelector("#stage").style.visibility = "hidden";
  const byPid = new Map(sc.players.map((p) => [p.pid, p]));
  for (const p of sc.players) { p.holder.setEnabled(false); sc.rig.setLeg(p.i, null); }
  sc.ball.setEnabled(false); sc.ballShadow.setEnabled(false);
  for (const r of rows) {
    const p = byPid.get(r.pid);
    p.holder.setEnabled(true);
    p.holder.position.set(r.x, 0, r.z);
    p.holder.rotation.y = r.yaw;
    p.anim.loco.forEach((g, j) => { g.setWeightForAllAnimatables(r.w[j]); if (r.w[j] > 0) g.goToFrame(g.from + r.phase * (g.to - g.from), true); });
    sc.rig.setLeg(p.i, r.leg ?? null);
    const [kind, v] = r.face ?? [null, 0];
    p.face?.({ emotion: kind ? { kind, weight: 1 } : null }, v, 0.5);
    if (r.ball) {
      const reach = sc.rig.reach[r.leg.kind + r.leg.side], c = Math.cos(r.yaw), sn = Math.sin(r.yaw);
      sc.ball.position.set(r.x + reach.x * c + reach.z * sn, sc.ball.getBoundingInfo().boundingSphere.radius, r.z - reach.x * sn + reach.z * c);
      sc.ball.setEnabled(true);
    }
  }
  const cm = sc.cams.replay;
  if (cam === "face") {
    // close on the first row's face, from where it looks (the clips turn the head)
    sc.scene.render();
    const ms = byPid.get(rows[0].pid).holder.getChildMeshes(false);
    const head = byPid.get(rows[0].pid).holder.getChildTransformNodes(false).find((n) => /-Head$/.test(n.name));
    head.computeWorldMatrix(true);
    const h = head.getAbsolutePosition(), f = ms.find((m) => /anime_face_primitive1$/.test(m.name));
    f.computeWorldMatrix(true);
    const d = f.getPositionData(true, true), c = new B.Vector3();
    for (let i = 0; i < d.length; i += 3) c.addInPlaceFromFloats(d[i], d[i + 1], d[i + 2]);
    const fc = B.Vector3.TransformCoordinates(c.scaleInPlace(3 / d.length), f.getWorldMatrix());
    const dir = fc.subtract(h); dir.y = 0; dir.normalize();
    cam = [fc.x + dir.x * 0.8, fc.y + 0.04, fc.z + dir.z * 0.8]; target = [fc.x, fc.y - 0.02, fc.z];
  }
  cm.position.set(...cam); cm.setTarget(new B.Vector3(...target)); cm.fov = fov;
  sc.scene.activeCamera = cm;
  for (let k = 0; k < 2400 && !sc.scene.isReady(); k++) await new Promise((r) => setTimeout(r, 50));
  sc.scene.render();
  sc.scene.render();
}, { rows, cam, target, fov });

// a moment of the match with the replay camera close on the scorer (motion3d-shots.mjs celebCam)
const goalShot = (page, c, dist) => page.evaluate(async ({ c, dist }) => {
  const s = window.sample3d, B = window.BABYLON, sc = s.scene, m = s.match;
  sc.scene.animationTimeScale = 1;
  sc.awareness.enabled = true;
  for (const p of sc.players) p.holder.setEnabled(true);
  await window.__setTime(c - 0.04);
  const { ts } = await window.__setTime(c);
  document.querySelector("#stage").style.visibility = "hidden";
  const at = m.at(window.__scorer, ts);
  const eye = [at[0] + (52.5 - at[0]) * 0.18 * dist, at[1] + ((34 - at[1]) * 0.25 - 7) * dist, 1.1 + 2.1 * dist];
  const cam = sc.cams.replay;
  cam.position.set(eye[0] - 52.5, eye[2], eye[1] - 34);
  cam.setTarget(new B.Vector3(at[0] - 52.5, 1.1 + 0.35 * (1 - dist), at[1] - 34));
  cam.fov = 0.55;
  sc.scene.activeCamera = cam;
  sc.scene.render();
}, { c, dist });

const row = (pid, x, yaw, extra = {}) => ({ pid, x, z: 0, yaw, w: [1, 0, 0, 0], phase: 0.2, ...extra });
const crop = (files, w, x, dest) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...files.flatMap((f) => ["-i", f]), "-filter_complex",
  files.map((_, k) => `[${k}]crop=${w}:720:${x}:0[c${k}]`).join(";") + ";" + files.map((_, k) => `[c${k}]`).join("") + `hstack=inputs=${files.length}`, dest]);

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
const rates = { default: [], anime: [] };
try {
  // frames/s in turns on fresh pages; the last anime page stays open for the stills (QUICK=1: one turn)
  let page = null;
  const turns = process.env.QUICK ? ["default", "anime"] : ["default", "anime", "default", "anime"];
  for (const [n, look] of turns.entries()) {
    if (page) await page.context().close();
    page = await open(browser, look);
    rates[look].push(await fps(page));
    console.log(`${look}: ${rates[look].at(-1).toFixed(2)} frames/s`);
    if (n === turns.length - 2) {
      // today's footballers for the comparison, while this page is open
      const pick0 = await page.evaluate(() => {
        const m = window.sample3d.match, id = Object.keys(m.teams)[0];
        return window.sample3d.scene.players.map((p) => ({ pid: p.pid, ...m.players[p.pid] })).filter((p) => p.team_id === id && p.position !== "GK").map((p) => p.pid);
      });
      await stage(page, { rows: [row(pick0[0], -1.8, Math.PI), row(pick0[1], -0.6, Math.PI), row(pick0[2], 0.6, 0), row(pick0[3], 1.8, 0)], cam: [0, 1.2, -5.8], target: [0, 0.95, 0], fov: 0.55 });
      await page.screenshot({ path: `${tmp}/compare-default.png` });
    }
  }

  const info = await page.evaluate(async () => {
    const m = window.sample3d.match, ids = Object.keys(m.teams), sc = window.sample3d.scene;
    const ps = sc.players.map((p) => ({ pid: p.pid, ...m.players[p.pid] }));
    const of = (t, gk) => ps.filter((p) => p.team_id === t && (p.position === "GK") === gk).map((p) => p.pid);
    const pl = await import("./js/players3d.js");
    const looks = Object.fromEntries(ps.map((p) => [p.pid, pl.animeLook(p.pid)]));
    return { home: of(ids[0], false), away: of(ids[1], false), gk: [...of(ids[0], true), ...of(ids[1], true)], looks };
  });

  // the anime body is on the mannequin skeleton: the clips and the rig move its bones
  const rig = await page.evaluate(async () => {
    const sc = window.sample3d.scene, p = sc.players.find((q) => q.anim.loco.length);
    const names = p.holder.getChildMeshes(false).map((m) => m.name);
    const foot = p.holder.getChildTransformNodes(false).find((n) => /foot_r$/.test(n.name));
    const at = () => { sc.scene.render(); foot.computeWorldMatrix(true); return foot.getAbsolutePosition().clone(); };
    const sprint = p.anim.loco[3];
    p.anim.loco.forEach((g, j) => g.setWeightForAllAnimatables(j === 3 ? 1 : 0));
    sprint.goToFrame(sprint.from, true);
    const a = at();
    sprint.goToFrame(sprint.from + 0.5 * (sprint.to - sprint.from), true);
    const b = at();
    sc.rig.setLeg(p.i, { kind: "shot", side: "r", t: 0 });
    const c = at();
    sc.rig.setLeg(p.i, null);
    // faces: the joy weight follows the celebrate emotion
    const fm = p.holder.getChildMeshes(false).find((m) => m.morphTargetManager);
    p.face({ emotion: { kind: "celebrate", weight: 1 } }, 0, 0.5);
    const joy = fm?.morphTargetManager.getTarget(0).influence;
    p.face({ emotion: null }, 7, 0.5);
    const det = fm?.morphTargetManager.getTarget(2).influence;
    const near = p.holder.getChildMeshes(false).filter((m) => m.isEnabled() && !/lod1/.test(m.name));
    const tris = near.filter((m) => !/outline/.test(m.name)).reduce((s, m) => s + m.getTotalIndices() / 3, 0);
    return { stride: a.subtract(b).length(), kick: b.subtract(c).length(), anime: names.some((n) => /-anime/.test(n)), joy, det,
      draws: near.length, tris, targets: fm?.morphTargetManager.numTargets };
  });
  console.log(`bones: sprint moves the right foot ${rig.stride.toFixed(2)} m, the kick ${rig.kick.toFixed(2)} m; face targets ${rig.targets}, joy ${rig.joy}, determined ${rig.det}; near player ${rig.draws} meshes, ${rig.tris} triangles`);
  if (!rig.anime) fail("the scene does not show the anime players");
  if (!(rig.stride > 0.1) || !(rig.kick > 0.02)) fail(`clips or rig do not drive the anime body: ${JSON.stringify(rig)}`);
  if (rig.joy !== 1 || rig.det !== 1) fail(`the face does not follow the emotion: ${JSON.stringify(rig)}`);

  // comparison: the same two places and poses as the default page above
  const h = info.home;
  await stage(page, { rows: [row(h[0], -1.8, Math.PI), row(h[1], -0.6, Math.PI), row(h[2], 0.6, 0), row(h[3], 1.8, 0)], cam: [0, 1.2, -5.8], target: [0, 0.95, 0], fov: 0.55 });
  await page.screenshot({ path: `${tmp}/compare-anime.png` });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", `${tmp}/compare-default.png`, "-i", `${tmp}/compare-anime.png`, "-filter_complex",
    "[0]crop=1280:540:0:90[a];[1]crop=1280:540:0:90[b];[a][b]vstack", `${shots}/anime3d-compare.png`]);
  console.log("anime3d-compare.png: default (top), anime (bottom); front left, back right");

  // clips: idle, jog, sprint, shot at contact, the ball at the foot (trap), then the celebration
  const tiles = [
    ["idle", { w: [1, 0, 0, 0], phase: 0.3 }], ["jog", { w: [0, 0, 1, 0], phase: 0.25 }],
    ["sprint", { w: [0, 0, 0, 1], phase: 0.25, face: [null, 7] }], ["kick", { w: [1, 0, 0, 0], phase: 0.3, leg: { kind: "shot", side: "r", t: 0 }, ball: true, face: [null, 7] }],
    ["ball", { w: [1, 0, 0, 0], phase: 0.3, leg: { kind: "trap", side: "r", t: 0 }, ball: true }],
  ];
  const files = [];
  for (const [name, r] of tiles) {
    await stage(page, { rows: [{ pid: h[0], x: 0, z: 0, yaw: Math.PI * 0.75, ...r }], cam: [0.3, 1.1, -4.4], target: [0.1, 0.92, 0], fov: 0.5 });
    files.push(`${tmp}/clip-${name}.png`);
    await page.screenshot({ path: files.at(-1) });
  }
  const goal = await page.evaluate(() => {
    const s = window.sample3d, sc = s.scene, aw = sc.awareness.aw, tl = s.tl;
    const cel = tl.goal === null ? null : aw.emotions.find((e) => e.kind === "celebrate" && Math.abs(e.t0 - tl.goal - 0.3) < 1e-6);
    window.__scorer = cel?.i ?? null;
    return cel ? tl.goal - tl.from : null;
  });
  if (goal === null) fail("the fixture has no goal to celebrate");
  else {
    await goalShot(page, goal + 2.4, 0.35);
    files.push(`${tmp}/clip-celebration.png`);
    await page.screenshot({ path: files.at(-1) });
  }
  crop(files, 360, 460, `${shots}/anime3d-clips.png`);
  console.log("anime3d-clips.png: idle, jog, sprint, shot, ball at the foot, celebration (the scorer)");

  // variants: ten players with different looks, keepers included
  const seen = new Set(), vs = [];
  for (const pid of [...info.gk, ...info.home, ...info.away]) {
    const l = info.looks[pid], key = `${l.hair}|${l.hairColour}`;
    if (!seen.has(key) || vs.length < 2) { seen.add(key); vs.push(pid); }
    if (vs.length === 10) break;
  }
  await stage(page, { rows: vs.map((pid, k) => row(pid, (k - 4.5) * 0.85, Math.PI * 1.06)), cam: [0, 1.25, -8.4], target: [0, 0.95, 0], fov: 0.7 });
  await page.screenshot({ path: `${shots}/anime3d-variants.png` });
  const styles = new Set(vs.map((p) => info.looks[p].hair)), cols = new Set(vs.map((p) => info.looks[p].hairColour));
  console.log(`anime3d-variants.png: ${vs.length} players, ${styles.size} hair styles, ${cols.size} hair colours, ${seen.size} style and colour pairs`);
  if (seen.size < 8) fail(`only ${seen.size} different looks among the players`);

  // face: the same player determined (sprinting), happy, frustrated
  const faces = [];
  for (const [name, f] of [["determined", [null, 7]], ["joy", ["celebrate", 0]], ["frustration", ["dejected", 0]]]) {
    await stage(page, { rows: [row(h[0], 0, Math.PI, { face: f, phase: 0 })], cam: "face", fov: 0.5 });
    faces.push(`${tmp}/face-${name}.png`);
    await page.screenshot({ path: faces.at(-1) });
  }
  crop(faces, 420, 430, `${shots}/anime3d-face.png`);
  console.log("anime3d-face.png: determined, joy, frustration");

  // wide: the live TV frame; how many players are on the far body
  const lod = await page.evaluate(async () => {
    const s = window.sample3d, sc = s.scene;
    sc.scene.animationTimeScale = 1;
    sc.awareness.enabled = true;
    for (const p of sc.players) p.holder.setEnabled(true);
    sc.ball.setEnabled(true); sc.ballShadow.setEnabled(true);
    await window.__setTime(6 - 0.04);
    await window.__setTime(6);
    const cam = sc.scene.activeCamera;
    let near = 0, far = 0;
    for (const m of sc.scene.meshes) if (/-anime_primitive0$/.test(m.name) && m.isEnabled()) (m.getLOD(cam) === m ? near++ : far++);
    return { near, far };
  });
  await page.screenshot({ path: `${shots}/anime3d-wide.png` });
  console.log(`anime3d-wide.png: ${lod.far} players on the far body, ${lod.near} on the near one`);
  if (lod.far + lod.near === 0) fail("no anime player in the wide shot");

  if (goal !== null) {
    await goalShot(page, goal + 2.4, 1);
    await page.screenshot({ path: `${shots}/anime3d-goal.png` });
    console.log(`anime3d-goal.png at clock ${(goal + 2.4).toFixed(2)} s`);
  }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
console.log(`software WebGL: ${mean(rates.default).toFixed(2)} frames/s with today's footballers, ${mean(rates.anime).toFixed(2)} with the anime ones (${rates.default.map((x) => x.toFixed(2))} / ${rates.anime.map((x) => x.toFixed(2))})`);
if (failures.length) { console.log(`${failures.length} failure(s)`); process.exit(1); }
console.log("anime3d shots ok");
