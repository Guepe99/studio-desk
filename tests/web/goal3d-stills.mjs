// The goal as a spectator sees it (docs/motion3d.md, "The goal"): frames of the 3D clip at chosen
// clock times, each from the camera the clip uses (top) and from a low camera beside the goal
// (bottom), saved as out/shots/goal3d-<name>.png and goal3d-<name>-goal.png. The clip is stepped at 30 fps from
// the first time, so the cameras' springs are where the video has them.
//
//   CLOCKS=11.0,11.3,11.6,12.0 [QUERY=quality=low] \
//     scripts/with-lock.sh chromium tests/web/run-smoke.sh goal3d-stills.mjs [match] [name]
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const match = process.argv[3] ?? "M001";
const name = process.argv[4] ?? "stills";
const clocks = (process.env.CLOCKS ?? "11.0,11.3,11.6,11.9,12.2,12.6,13.2,14.0").split(",").map(Number).sort((a, b) => a - b);
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out");
const tmp = `${out}/goal3d-tmp-${name}`;
mkdirSync(tmp, { recursive: true });
mkdirSync(`${out}/shots`, { recursive: true });

const errors = [];
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
  page.setDefaultTimeout(600000);
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  await page.goto(new URL(`sample3d.html?match=${match}&capture=1&view=3d&${process.env.QUERY ?? ""}`, base).href);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 600000 });
  const top = [], bottom = [];
  let c = clocks[0] - 1;
  for (const want of clocks) {
    const info = await page.evaluate(async ({ c, want }) => {
      for (let t = c; t < want - 1e-6; t += 1 / 30) await window.__setTime(t);
      const v = await window.__setTime(want), sc = window.sample3d.scene;
      return { ts: v.ts, cam: sc.debug.camera, ball: sc.rig.plan.ball(v.ts), net: sc.rig.plan.net(v.ts) };
    }, { c, want });
    c = want + 1 / 30;
    const f = `${tmp}/a${want}.png`;
    await page.screenshot({ path: f });
    top.push(f);
    // a camera by the goal the ball goes to; GOALCAM=dx,y,z,tdx,ty,tz,fov places it (dx, tdx:
    // metres from the goal line outwards; y, z scene metres); the default looks at the back net
    await page.evaluate((gc) => {
      const s = window.sample3d, B = window.BABYLON, sc = s.scene, ts = sc.ts;
      const b = sc.rig.plan.ball(ts), end = b.x > 52.5 ? 1 : -1, X = end * 52.5;
      const [dx, y, z, tdx, ty, tz, fov] = gc;
      const cam = sc.cams.replay;
      cam.position.set(X + end * dx, y, z);
      cam.setTarget(new B.Vector3(X + end * tdx, ty, tz));
      cam.fov = fov;
      document.querySelector("#stage").style.visibility = "hidden";
      sc.scene.activeCamera = cam;
      sc.scene.render();
    }, (process.env.GOALCAM ?? "4.5,1.1,11,0.8,0.8,0.5,0.75").split(",").map(Number));
    const g = `${tmp}/b${want}.png`;
    await page.screenshot({ path: g });
    bottom.push(g);
    await page.evaluate(() => { document.querySelector("#stage").style.visibility = "visible"; });
    console.log(`clock ${want}: ts ${info.ts.toFixed(2)} camera ${info.cam} ball ${info.ball.x.toFixed(2)},${info.ball.y.toFixed(2)},${info.ball.h.toFixed(2)}${info.net ? ` net ${info.net.plane} ${info.net.depth.toFixed(2)}` : ""}`);
  }
  // one sheet per view, four frames a row
  const grid = (files, f) => {
    const n = files.length, cols = Math.min(4, n);
    const layout = files.map((_, k) => `${(k % cols) * 480}_${Math.floor(k / cols) * 270}`).join("|");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...files.flatMap((x) => ["-i", x]),
      "-filter_complex", `${files.map((_, k) => `[${k}]scale=480:270[s${k}]`).join(";")};${files.map((_, k) => `[s${k}]`).join("")}xstack=inputs=${n}:layout=${layout}:fill=black`, f]);
  };
  grid(top, `${out}/shots/goal3d-${name}.png`);
  grid(bottom, `${out}/shots/goal3d-${name}-goal.png`);
  console.log(`out/shots/goal3d-${name}.png`);
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
if (errors.length) { console.log(errors.join("\n")); process.exit(1); }
