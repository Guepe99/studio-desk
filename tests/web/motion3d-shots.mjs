// The retargeted motion clips (docs/motion3d.md) against the procedural stand-ins, saved to out/shots/:
//   motion3d-sheet.png        every clip next to the pose it replaces, on one body, frozen frames
//   motion3d-celebration.png  the scorer's side 2.5 s after the goal, with the clips (-procedural: without)
//   motion3d-defending.png    the defenders closest to the ball when most of them backpedal, strafe or
//                             jockey, with the clips (-procedural: without)
// It prints frames/s for ?motion=procedural and with the clips, twice each and interleaved, measured as
// in players3d-shots.mjs, and fails when any bone goes NaN (a vanished player) over the 20 s.
// The sheet uses web/vendor/players/footballer.glb when it is there (feat/players3d), else the mannequin.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh motion3d-shots.mjs [match]
import { createRequire } from "node:module";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const match = process.argv[3] ?? "DEMO";
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.resolve(here, "../../out/shots"), tmp = path.resolve(here, "../../out/motion3d-tmp");
mkdirSync(shots, { recursive: true });
mkdirSync(tmp, { recursive: true });
const web = path.resolve(here, "../../web");
const meta = JSON.parse(readFileSync(`${web}/vendor/motion/clips.json`, "utf8"));
const body = existsSync(`${web}/vendor/players/footballer.glb`) ? "vendor/players/footballer.glb" : "vendor/quaternius/mannequin.glb";

const errors = [];
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();

async function open(motion) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console (${motion}): ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`page error (${motion}): ${e.message}`));
  page.on("requestfailed", (r) => errors.push(`request failed (${motion}): ${r.url()}`));
  await page.goto(new URL(`sample3d.html?match=${match}&capture=1&view=3d${motion === "procedural" ? "&motion=procedural" : ""}`, base).href);
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

// a moment of the match, the camera from frame(ts, scene, match) -> [eye, target] in contract metres
async function still(page, name, c, frame) {
  await page.evaluate(async ({ c, src }) => {
    const frame = (0, eval)(`(${src})`);
    const s = window.sample3d, B = window.BABYLON, sc = s.scene;
    await window.__setTime(c - 0.04);
    const { ts } = await window.__setTime(c);
    document.querySelector("#stage").style.visibility = "hidden";
    const [eye, at] = frame(ts, sc, s.match);
    const cam = sc.cams.replay;
    cam.position.set(eye[0] - 52.5, eye[2], eye[1] - 34);
    cam.setTarget(new B.Vector3(at[0] - 52.5, at[2], at[1] - 34));
    cam.fov = 0.55;
    sc.scene.activeCamera = cam;
    sc.scene.render();
  }, { c, src: frame.toString() });
  await page.screenshot({ path: `${shots}/${name}.png`, timeout: 120000 });
  console.log(`${name}.png at clock ${c.toFixed(2)} s`);
}

// the moment with the most outfield players in a non-forward mode within 15 m of the ball
const plan = (page) => page.evaluate(() => {
  const s = window.sample3d, m = s.match, sc = s.scene, aw = sc.awareness.aw, tl = s.tl;
  let best = null;
  for (let c = 1; c < 19.5; c += 0.25) {
    const ts = tl.at(c).ts, b = sc.rig.ball(ts);
    const pts = sc.players.filter((p) => { const q = m.at(p.i, ts); return q && Math.hypot(q[0] - b.x, q[1] - b.y) < 15 && aw.pose(p.i, ts)?.mode && aw.pose(p.i, ts).mode !== "forward"; });
    if (!best || pts.length > best.n) best = { c, n: pts.length };
  }
  // the scorer as the layer found him (the celebrate emotion of this goal)
  const cel = tl.goal === null ? null : aw.emotions.find((e) => e.kind === "celebrate" && e.t0 >= tl.goal && e.t0 - tl.goal < 0.5);
  return { defend: best, goal: cel ? tl.goal - tl.from : null, scorer: cel?.i ?? null };
});
const celebCam = (ts, sc, m) => {
  const at = m.at(window.__scorer, ts);
  return [[at[0] + (52.5 - at[0]) * 0.18, at[1] + (34 - at[1]) * 0.25 - 7, 3.2], [at[0], at[1], 1.1]];
};
const defendCam = (ts, sc, m) => {
  const b = sc.rig.ball(ts), aw = sc.awareness.aw;
  const pts = sc.players.map((p) => [p, m.at(p.i, ts)]).filter(([p, q]) => q && aw.pose(p.i, ts)?.mode && aw.pose(p.i, ts).mode !== "forward" && Math.hypot(q[0] - b.x, q[1] - b.y) < 15).map(([, q]) => q);
  const cx = pts.reduce((s, q) => s + q[0], b.x) / (pts.length + 1), cy = pts.reduce((s, q) => s + q[1], b.y) / (pts.length + 1);
  return [[cx + Math.sign(52.5 - cx) * 12, cy - 9, 4.5], [cx, cy, 0.9]];
};

// One row of the sheet: the old pose and the new clip at three moments, on one body each.
async function sheetRow(page, row) {
  return page.evaluate(async ({ row, body }) => {
    const s = window.sample3d, sc = s.scene, B = window.BABYLON;
    if (!window.__fb) {
      for (const p of sc.players) p.holder.setEnabled(false);
      sc.ball.setEnabled(false); sc.ballShadow.setEnabled(false);
      document.querySelector("#stage").style.visibility = "hidden";
      sc.awareness.enabled = false;
      const c = await B.LoadAssetContainerAsync(body, sc.scene);
      window.__fb = [0, 1, 2, 3].map((k) => {
        const inst = c.instantiateModelsToScene((n) => `fb${k}-${n}`, false);
        inst.animationGroups.forEach((g) => g.dispose());
        const nodes = new Map();
        for (const r of inst.rootNodes) for (const n of [r, ...r.getDescendants(false)]) nodes.set(n.name, n);
        const holder = new B.TransformNode(`fb${k}`, sc.scene);
        inst.rootNodes.forEach((r) => { r.parent = holder; });
        holder.position.set(2.4 - 1.6 * k, 0, 0); // the camera looks down -z: +x is on the left
        // the rest pose, put back before every row (a clip leaves the bones it does not key alone)
        const rest = [...nodes.values()].filter((n) => n.rotationQuaternion).map((n) => [n, n.rotationQuaternion.clone(), n.position.clone()]);
        return { k, holder, nodes, rest, groups: [] };
      });
    }
    for (const f of window.__fb) {
      f.groups.forEach((g) => g.dispose());
      f.groups = [];
      for (const [n, q, x] of f.rest) { n.rotationQuaternion.copyFrom(q); n.position.copyFrom(x); }
      f.holder.position.y = row.up?.[f.k] ?? 0;
      const spec = row.cells[f.k];
      for (const [name, t, w] of spec) {
        const src = sc.container.animationGroups.find((a) => a.name === name) ?? sc.container.animationGroups.find((a) => a.name.endsWith(name));
        if (!src) throw new Error(`no clip ${name}`);
        const g = src.clone(`fb${f.k}-${name}`, (tg) => f.nodes.get(`fb${f.k}-${tg.name}`) ?? tg);
        g.start(true, 1, g.from, g.to); g.pause(); g.setWeightForAllAnimatables(w);
        const fps = g.targetedAnimations[0].animation.framePerSecond;
        g.goToFrame(Math.min(g.to, g.from + t * fps), true);
        f.groups.push(g);
      }
    }
    const cam = sc.cams.replay;
    cam.position.set(0.4, 1.3, 7.2); cam.setTarget(new B.Vector3(0.0, 0.85, 0)); cam.fov = 0.6;
    sc.scene.activeCamera = cam;
    sc.scene.render(); sc.scene.render();
  }, { row, body });
}

let before = null, after = null, again = null, again2 = null;
try {
  // procedural: frames/s and the two stills
  const old = await open("procedural");
  before = await fps(old);
  const p0 = await plan(old);
  console.log(JSON.stringify(p0));
  await old.evaluate((p) => { window.__scorer = p.scorer; }, p0);
  if (p0.goal !== null) await still(old, "motion3d-celebration-procedural", p0.goal + 2.4, celebCam);
  await still(old, "motion3d-defending-procedural", p0.defend.c, defendCam);
  await old.context().close();

  const page = await open("motion");
  after = await fps(page);
  const loaded = await page.evaluate(() => Object.keys(window.sample3d.scene.motion?.clips ?? {}).length);
  if (loaded !== Object.keys(meta.clips).length) errors.push(`${loaded} motion clips loaded, ${Object.keys(meta.clips).length} in clips.json`);
  const p1 = await plan(page);
  await page.evaluate((p) => { window.__scorer = p.scorer; }, p1);
  if (p1.goal !== null) await still(page, "motion3d-celebration", p1.goal + 2.4, celebCam);
  await still(page, "motion3d-defending", p1.defend.c, defendCam);
  // the emotions the scene plays now are motion clips, from the same facts and events
  const used = await page.evaluate(() => {
    const aw = window.sample3d.scene.awareness.aw;
    return [...new Set(aw.emotions.map((e) => e.clip))];
  });
  console.log(`emotion clips in play: ${used.join(", ")}`);
  // no bone may go NaN (Babylon's blend divides 0 by 0 when the first two registered weights are 0)
  const nan = await page.evaluate(async () => {
    const sc = window.sample3d.scene, bad = new Set();
    for (let c = 1; c < 19.5; c += 0.08) {
      await window.__setTime(c);
      for (const p of sc.players) if (p.holder.getDescendants(false).some((n) => n.rotationQuaternion && !Number.isFinite(n.rotationQuaternion.w))) bad.add(`${p.i}@${c.toFixed(2)}`);
    }
    return [...bad];
  });
  if (nan.length) errors.push(`NaN bones: ${nan.slice(0, 10).join(" ")}${nan.length > 10 ? ` (+${nan.length - 10})` : ""}`);
  else console.log("no NaN bones over the clip");

  // the sheet: [label, old cell, three new cells]; a cell is [[clip, seconds, weight], ...]
  const OLD = { celeb: "SD_ArmsUp", join: "SD_ArmsUp", dejected_hips: "SD_HandsOnHips", crouch_head_down: "SD_Dejected",
    hands_on_head: "SD_HandsOnHead", appeal_arms_out: "SD_Appeal", palms_shrug: "SD_Palms", clap: "SD_Clap",
    point_forward: "SD_ArmUp", call_ball: "SD_ArmUp", keeper_organise: "SD_Point" };
  const LOCO_OLD = { jog_backward: "backpedal: Jog_Fwd_Loop in reverse", sidestep_left: "strafe: Jog_Fwd_Loop, short step",
    sidestep_right: "strafe: Jog_Fwd_Loop, short step", jockey_shuffle: "jockey: Walk/Jog blend in reverse" };
  const rows = Object.entries(meta.clips).map(([name, c]) => {
    const short = name.replace(/^M_/, "");
    const key = Object.keys(OLD).find((k) => short.startsWith(k));
    const loco = LOCO_OLD[short];
    const gk = !!c.root;   // a goalkeeper clip: the keeper had no dive before, only the idle
    const old = loco ? (short === "jockey_shuffle" ? [["Walk_Loop", 0.3, 0.5], ["Jog_Fwd_Loop", 0.3, 0.5]] : [["Jog_Fwd_Loop", 0.25, 1]])
      : gk ? [["Idle_Loop", 0.5, 1]] : [[OLD[key], 0.5, 1]];
    const at = (u) => [[name, u * c.len, 1]];
    // root clips: the body is lifted or lowered by the clip's up curve; the sideways travel is printed
    const up = (u) => (gk ? c.root[Math.min(c.root.length - 1, Math.round(u * c.len * meta.fps))][1] : 0);
    const end = gk ? c.root[c.root.length - 1] : null;
    return { name, label: `${short} (${c.len.toFixed(1)} s${c.loop ? ", loop" : ""}${c.full ? ", full body" : ""}${gk ? `, travel left ${end[0].toFixed(2)} m, forward ${end[2].toFixed(2)} m` : ""})`,
      oldLabel: loco ?? (gk ? "Idle_Loop (no dive)" : OLD[key]), cells: [old, at(0.2), at(0.5), at(0.8)], up: [0, up(0.2), up(0.5), up(0.8)] };
  });
  const imgs = [];
  for (const r of rows) {
    await sheetRow(page, r);
    const f = `${tmp}/${r.name}.png`;
    await page.screenshot({ path: f, timeout: 120000, clip: { x: 160, y: 120, width: 960, height: 520 } });
    imgs.push({ ...r, src: `data:image/png;base64,${readFileSync(f).toString("base64")}` });
  }
  await page.context().close();
  // both again, so the order of the pages (cold shaders) does not decide the comparison
  const old2 = await open("procedural");
  again = await fps(old2);
  await old2.context().close();
  const new2 = await open("motion");
  again2 = await fps(new2);
  await new2.context().close();
  const sheet = await (await browser.newContext({ viewport: { width: 1980, height: 800 } })).newPage();
  await sheet.setContent(`<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:16px;background:#f3f3f1;font:14px system-ui,sans-serif;color:#222}
    h1{font-size:18px;margin:0 0 4px} p{margin:0 0 12px;color:#555}
    .g{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .r{background:#fff;border:1px solid #ddd;padding:6px}
    .r img{width:100%;display:block} .l{display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px}
    .l b{font-weight:600}</style>
    <h1>Motion clips (Kimodo, retargeted) next to the poses they replace</h1>
    <p>Each row: leftmost body = the old procedural pose or stand-in gait; the other three = the new clip at 20%, 50% and 80% of its length. Body: ${body.split("/").pop()}. Root motion removed (the tracking owns it), except on the goalkeeper rows: there the body is raised or lowered by the clip's root curve and the sideways travel is in the label.</p>
    <div class="g">${imgs.map((r) => `<div class="r"><div class="l"><b>${r.label}</b><span>old: ${r.oldLabel}</span></div><img src="${r.src}"></div>`).join("")}</div>`);
  await sheet.screenshot({ path: `${shots}/motion3d-sheet.png`, fullPage: true });
  console.log(`motion3d-sheet.png: ${rows.length} rows`);
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`frames/s: procedural ${before?.toFixed(1)}, motion clips ${after?.toFixed(1)}, procedural again ${again?.toFixed(1)}, motion clips again ${again2?.toFixed(1)}`);
if (errors.length) { console.log(errors.join("\n")); process.exit(1); }
console.log("motion3d shots ok");
