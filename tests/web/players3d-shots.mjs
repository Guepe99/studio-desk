// Stills of the footballers (web/js/players3d.js) in the 3D sample, saved to out/shots/:
//   players3d-clips.png  one player in idle, jog, sprint and a kick (ball at the rig's foot reach)
//   players3d-close.png  both teams' outfield players and a keeper side by side, front and back
//   players3d-hero.png   a captain from the front and a team-mate from behind, close
//   players3d-wide.png   the broadcast TV frame
// It checks the kit logic, that clips and the ball rig drive the footballer's bones, and prints
// frames/s for ?players=mannequin and for the footballers, measured as in sample3d-shots.mjs.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh players3d-shots.mjs
//
// PLAYERS=trellis runs it on ?players=trellis (the TRELLIS.2 trial body) and names the stills
// trellis3d-*.png instead.
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
const shots = `${out}/shots`, tmp = `${out}/players3d-tmp`;
mkdirSync(shots, { recursive: true });
mkdirSync(tmp, { recursive: true });

const look = process.env.PLAYERS ?? "footballer";
const prefix = look === "trellis" ? "trellis3d" : "players3d";
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };

async function open(browser, look) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") fail(`console (${look}): ${m.text()}`); });
  page.on("pageerror", (e) => fail(`page error (${look}): ${e.message}`));
  page.on("requestfailed", (r) => fail(`request failed (${look}): ${r.url()}`));
  await page.goto(new URL(`sample3d.html?match=DEMO&capture=1&view=3d${look === "footballer" ? "" : `&players=${look}`}`, base).href);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 180000 });
  return page;
}

// warm first: until every shader is compiled (slow in software) the players are simply not drawn
const fps = (page) => page.evaluate(async () => {
  const s = window.sample3d.scene.scene;
  for (let k = 0; k < 300 && !s.isReady(); k++) { await window.__setTime(4); await new Promise((r) => setTimeout(r, 50)); }
  for (let k = 0; k < 4; k++) await window.__setTime(3 + k * 0.04);
  const t0 = performance.now();
  let n = 0;
  while (performance.now() - t0 < 4000) { await window.__setTime(4 + n * 0.04); n++; }
  return n / ((performance.now() - t0) / 1000);
});

// Stage a few players at the centre spot, the others hidden, and frame them with the goal camera.
// rows: [{ pid, x, z, yaw, w: clip weights, phase, leg, ball }]
const stage = (page, { rows, cam, target, fov }) => page.evaluate(async ({ rows, cam, target, fov }) => {
  const s = window.sample3d, sc = s.scene, B = window.BABYLON;
  await window.__setTime(4);
  document.querySelector("#stage").style.visibility = "hidden";
  const byPid = new Map(sc.players.map((p) => [p.pid, p]));
  for (const p of sc.players) { p.holder.setEnabled(false); sc.rig.setLeg(p.i, null); }
  sc.ball.setEnabled(false); sc.ballShadow.setEnabled(false);
  for (const r of rows) {
    const p = byPid.get(r.pid);
    p.holder.setEnabled(true);
    p.holder.position.set(r.x, 0, r.z);
    p.holder.rotation.y = r.yaw;
    // only the weighted clips are evaluated, as Scene3D.update does: Babylon 9 blends a quaternion
    // to NaN when the first two clips evaluated in a frame both weigh 0
    p.anim.loco.forEach((g, j) => { g.setWeightForAllAnimatables(r.w[j]); if (r.w[j] > 0) g.goToFrame(g.from + r.phase * (g.to - g.from), true); });
    sc.rig.setLeg(p.i, r.leg ?? null);
    if (r.ball) {
      // the ball centre at the rig's contact point for this kick, in the player's frame
      const reach = sc.rig.reach[r.leg.kind + r.leg.side], c = Math.cos(r.yaw), sn = Math.sin(r.yaw);
      sc.ball.position.set(r.x + reach.x * c + reach.z * sn, sc.ball.getBoundingInfo().boundingSphere.radius, r.z - reach.x * sn + reach.z * c);
      sc.ball.setEnabled(true);
    }
  }
  const cm = sc.cams.replay;
  cm.position.set(...cam); cm.setTarget(new B.Vector3(...target)); cm.fov = fov;
  sc.scene.activeCamera = cm;
  sc.scene.render();
  sc.scene.render();
}, { rows, cam, target, fov });

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
let before = null, after = null;
try {
  const old = await open(browser, "mannequin");
  before = await fps(old);
  await old.context().close();

  const page = await open(browser, look);
  after = await fps(page);

  // kit logic (players3d.js), on the fixture's teams
  const kits = await page.evaluate(async () => {
    const m = await import("./js/players3d.js");
    const t = window.sample3d.match.teams;
    const ids = Object.keys(t);
    const looks = Object.keys(window.sample3d.match.players).map((pid) => m.playerLook(pid));
    return {
      out: ids.map((id) => m.kitColours(t[id], false)), gk: ids.map((id) => m.kitColours(t[id], true)),
      contrast: ids.map((id) => { const k = m.kitColours(t[id], false); return m.contrast(k.shirt, k.number); }),
      same: JSON.stringify(m.playerLook("P01")) === JSON.stringify(m.playerLook("P01")),
      skins: new Set(looks.map((l) => l.skin)).size, hairs: new Set(looks.map((l) => l.hair)).size,
      boots: new Set(looks.map((l) => l.boots)).size,
      readable: ids.flatMap((id) => { const k = m.kitColours(t[id], false); return [m.contrast(k.shorts, k.shortsNumber), m.contrast(k.shirt, k.armband)]; }),
      white: m.kitColours({ side: "home", color_primary: "#ffffff", color_secondary: "#f4f4f4" }, false).number,
    };
  });
  console.log(`kits: ${JSON.stringify(kits.out)}; keepers ${JSON.stringify(kits.gk.map((k) => k.shirt))}`);
  if (kits.contrast.some((c) => c < 2.5)) fail(`shirt number contrast too low: ${kits.contrast}`);
  if (kits.white !== "#111111") fail(`a white shirt with a near-white second colour gets number ${kits.white}`);
  if (kits.readable.some((c) => c < 2.5)) fail(`shorts number or armband contrast too low: ${kits.readable}`);
  if (!kits.same || kits.skins < 3 || kits.hairs < 2 || kits.boots < 3) fail(`looks not varied or not stable: ${JSON.stringify(kits)}`);
  if (kits.gk.some((k, n) => k.shirt === kits.out[n].shirt || !k.gloves)) fail("keeper kit not distinct");

  // the footballer is skinned to the mannequin skeleton: the clips and the rig move its bones
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
    const skinned = p.holder.getChildMeshes(false).filter((m) => m.skeleton && m.isEnabled()).length;
    return { stride: a.subtract(b).length(), kick: b.subtract(c).length(), skinned, footballer: names.some((n) => /footballer/.test(n)) };
  });
  console.log(`bones: sprint moves the right foot ${rig.stride.toFixed(2)} m over half a cycle, the kick pose ${rig.kick.toFixed(2)} m; ${rig.skinned} skinned meshes`);
  if (!rig.footballer) fail("the scene still shows the mannequin");
  if (!(rig.stride > 0.1) || !(rig.kick > 0.02)) fail(`clips or rig do not drive the footballer: ${JSON.stringify(rig)}`);

  const pick = await page.evaluate(() => {
    const m = window.sample3d.match, ids = Object.keys(m.teams);
    const ps = window.sample3d.scene.players.map((p) => ({ pid: p.pid, ...m.players[p.pid] }));
    const of = (t, gk) => ps.filter((p) => p.team_id === t && (p.position === "GK") === gk);
    return { home: of(ids[0], false), away: of(ids[1], false), gk: [...of(ids[0], true), ...of(ids[1], true)] };
  });

  // clips: idle, jog, sprint and a right-foot shot at contact, one tile each
  const tiles = [
    ["idle", { w: [1, 0, 0, 0], phase: 0.3 }], ["jog", { w: [0, 0, 1, 0], phase: 0.25 }],
    ["sprint", { w: [0, 0, 0, 1], phase: 0.25 }], ["kick", { w: [1, 0, 0, 0], phase: 0.3, leg: { kind: "shot", side: "r", t: 0 }, ball: true }],
  ];
  const files = [];
  for (const [name, r] of tiles) {
    await stage(page, { rows: [{ pid: pick.home[0].pid, x: 0, z: 0, yaw: Math.PI / 2, ...r }], cam: [0.6, 1.1, -4.6], target: [0.2, 0.92, 0], fov: 0.5 });
    const f = `${tmp}/clip-${name}.png`;
    await page.screenshot({ path: f });
    files.push(f);
  }
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...files.flatMap((f) => ["-i", f]), "-filter_complex",
    files.map((_, k) => `[${k}]crop=420:720:430:0[c${k}]`).join(";") + ";" + files.map((_, k) => `[c${k}]`).join("") + "hstack=inputs=4",
    `${shots}/${prefix}-clips.png`]);
  console.log(`${prefix}-clips.png: idle, jog, sprint, shot at contact`);

  // close: home front and back, away front and back, keeper front
  const row = (pid, x, yaw) => ({ pid, x, z: 0, yaw, w: [1, 0, 0, 0], phase: 0.2 });
  await stage(page, {
    rows: [row(pick.home[0].pid, -2.4, Math.PI), row(pick.home[1].pid, -1.2, 0), row(pick.gk[0].pid, 0, Math.PI),
      row(pick.away[0].pid, 1.2, Math.PI), row(pick.away[1].pid, 2.4, 0)],
    cam: [0, 1.25, -7.2], target: [0, 0.95, 0], fov: 0.55,
  });
  await page.screenshot({ path: `${shots}/${prefix}-close.png` });
  console.log(`${prefix}-close.png: ${pick.home[0].pid} ${pick.home[1].pid} ${pick.gk[0].pid} ${pick.away[0].pid} ${pick.away[1].pid}`);

  // hero: one home player as captain, front and back, at close range (the contract has no captain
  // field, so the scene never sets the armband: this repaints the shirt with paintShirt)
  const cap = pick.home[0].pid;
  await page.evaluate(async (pid) => {
    const m = await import("./js/players3d.js");
    const s = window.sample3d, pl = s.match.players[pid];
    const tex = s.scene.scene.getMaterialByName(`${pid}-shirt`).albedoTexture;
    m.paintShirt(tex.getContext(), tex.getSize().width, m.kitColours(s.match.teams[pl.team_id], false), pl.shirt, true);
    tex.update(false);
  }, cap);
  await stage(page, {
    rows: [row(cap, -0.55, Math.PI), row(pick.home[1].pid, 0.55, 0)],
    cam: [0, 1.15, -3.6], target: [0, 1.0, 0], fov: 0.55,
  });
  await page.screenshot({ path: `${shots}/${prefix}-hero.png` });
  console.log(`${prefix}-hero.png: ${cap} with the armband, ${pick.home[1].pid} from behind`);

  // wide: the live TV frame, graphics hidden; how many players are on the far LOD
  const lod = await page.evaluate(async () => {
    const s = window.sample3d, sc = s.scene;
    for (const p of sc.players) p.holder.setEnabled(true);
    await window.__setTime(6 - 0.04);
    await window.__setTime(6);
    const cam = sc.scene.activeCamera;
    let near = 0, far = 0;
    for (const m of sc.scene.meshes) if (/footballer_primitive0$/.test(m.name) && m.isEnabled()) (m.getLOD(cam) === m ? near++ : far++);
    return { near, far };
  });
  await page.screenshot({ path: `${shots}/${prefix}-wide.png` });
  console.log(`${prefix}-wide.png: ${lod.far} players on the far body, ${lod.near} on the near one`);
  if (lod.far + lod.near === 0) fail("no footballer in the wide shot");
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`software WebGL: ${before?.toFixed(2)} frames/s with mannequins, ${after?.toFixed(2)} with ${look}`);
if (failures.length) { console.log(`${failures.length} failure(s)`); process.exit(1); }
console.log("players3d shots ok");
