// Frame sequences for docs/flow3d.md, section 5: one subject seen by a camera that follows it from the
// broadcast side, a still every STEP seconds of clock time from C0 to C1, tiled COLS to a row into
// out/motion-flow/<name>.png. The clock is stepped from 2 s before C0 at 30 fps, so the springs and
// the gait phase reach each still the way the live page does.
//
//   [STEP=0.1] [COLS=6] [SIZE=400x300] [DIST=6] [H=1.6] scripts/with-lock.sh chromium tests/web/run-smoke.sh motion-flow-stills.mjs \
//       <match> <from> <pid|ball|broadcast> <c0> <c1> <name> [query]
// from: the sample window start (match seconds); c0, c1: clock seconds into it; query: extra page
// parameters, e.g. "players=footballer".
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const [base, match, from, who, c0, c1, name, query = ""] = process.argv.slice(2);
const STEP = +(process.env.STEP ?? 0.1), COLS = +(process.env.COLS ?? 6), DIST = +(process.env.DIST ?? 6), H = +(process.env.H ?? 1.6);
const [W, HT] = (process.env.SIZE ?? "400x300").split("x").map(Number);
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/motion-flow");
const tmp = `${out}/${name}-tmp`;
mkdirSync(tmp, { recursive: true });
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: W, height: HT } })).newPage();
  page.setDefaultTimeout(600000);
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto(new URL(`sample3d.html?match=${match}&capture=1&view=3d&from=${from}${query ? `&${query}` : ""}`, base).href);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 600000 });
  await page.evaluate(() => {
    document.querySelector("#stage").style.visibility = "hidden";
    // query "root=<omega>": the shown root's smoothing (Scene3D.rootOmega), 0 for the path as it is
    const ro = new URLSearchParams(location.search).get("root");
    if (ro !== null && window.sample3d.scene) window.sample3d.scene.rootOmega = Number(ro);
  });
  let n = 0, next = +c0;
  for (let c = Math.max(0, +c0 - 2); c <= +c1 + 1e-9; c += 1 / 30) {
    const shoot = c >= next - 1e-6;
    const info = await page.evaluate(async ({ c, who, shoot, DIST, H }) => {
      await window.__setTime(c);
      if (!shoot) return null;
      const sc = window.sample3d.scene, B = window.BABYLON;
      if (who === "broadcast") return { ts: +sc.ts.toFixed(2) };   // the page's own camera
      const p = who === "ball" ? null : sc.players.find((q) => q.pid === who);
      const at = p ? p.holder.position.clone() : sc.ball.position.clone();
      const cm = sc.cams.replay;
      cm.position.set(at.x, H, at.z - DIST);
      cm.setTarget(new B.Vector3(at.x, 0.8, at.z));
      cm.fov = 0.5;
      sc.scene.activeCamera = cm;
      sc.scene.render();
      return { ts: +sc.ts.toFixed(2) };
    }, { c, who, shoot, DIST, H });
    if (!info) continue;
    await page.screenshot({ path: `${tmp}/f${String(n++).padStart(3, "0")}.png` });
    next += STEP;
  }
  const rows = Math.ceil(n / COLS);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", `${tmp}/f%03d.png`, "-vf", `tile=${COLS}x${rows}`, "-frames:v", "1", `${out}/${name}.png`]);
  console.log(`${out}/${name}.png: ${n} stills of ${who} in ${match} from ${from} + ${c0}..${c1} s`);
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
