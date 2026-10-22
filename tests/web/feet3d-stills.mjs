// Close stills of one running player's lower boot in the 3D sample, from the side at grass level, so a
// toe in the grass or a hop shows (tests/web/feet3d.mjs measures the same thing). The clock is
// stepped from 0 every STEP seconds, as feet3d.mjs does, so the stride phases match its report;
// frames from FROM to TO go side by side in out/shots/feet3d-<match>-<pid>-<tag>.png.
//
//   [STEP=0.06] [TAG=after] scripts/with-lock.sh chromium tests/web/run-smoke.sh feet3d-stills.mjs [DEMO] [T01-9] [7.62] [7.98] [default|anime]
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const [base, match = "DEMO", pid = "T01-9", from = "7.62", to = "7.98", look = "default"] = process.argv.slice(2);
const STEP = +(process.env.STEP ?? 0.06), TAG = process.env.TAG ?? "now";
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out");
const tmp = `${out}/feet3d-tmp`;
mkdirSync(tmp, { recursive: true });
mkdirSync(`${out}/shots`, { recursive: true });

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
const files = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 640, height: 480 } })).newPage();
  page.setDefaultTimeout(600000);
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto(new URL(`sample3d.html?match=${match}&capture=1&view=3d&players=${look === "anime" ? "anime" : "footballer"}`, base).href);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 600000 });
  await page.evaluate(() => { document.querySelector("#stage").style.visibility = "hidden"; });
  for (let c = 0; c <= +to + 1e-9; c += STEP) {
    const info = await page.evaluate(async ({ c, pid, shoot }) => {
      await window.__setTime(c);
      if (!shoot) return null;
      const sc = window.sample3d.scene, B = window.BABYLON;
      const p = sc.players.find((q) => q.pid === pid);
      const h = p.holder.position, yaw = p.holder.rotation.y;
      // his lower boot from the side, 1.4 m off with the lens 4 cm above the grass: the grass
      // line is nearly flat in the frame, so a toe under it is cut off and a gap under a sole shows
      const [fl, fr] = ["foot_l", "foot_r"].map((n) => p.anim.node(n).getAbsolutePosition());
      const f = fl.y < fr.y ? fl : fr;
      const cm = sc.cams.replay;
      cm.position.set(f.x + 1.4 * Math.cos(yaw), 0.04, f.z - 1.4 * Math.sin(yaw));
      cm.setTarget(new B.Vector3(f.x, 0.06, f.z));
      cm.fov = 0.3;
      sc.scene.activeCamera = cm;
      sc.scene.render();
      return { holderY: +(h.y * 100).toFixed(1), clips: p.ws.map((w) => +w.toFixed(2)) };
    }, { c, pid, shoot: c >= +from - 1e-9 });
    if (!info) continue;
    const f = `${tmp}/f${files.length}.png`;
    await page.screenshot({ path: f });
    files.push(f);
    console.log(`${c.toFixed(2)} s: body ${info.holderY} cm, loop weights ${info.clips}`);
  }
  const name = `${out}/shots/feet3d-${match.toLowerCase()}-${pid}-${TAG}.png`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...files.flatMap((f) => ["-i", f]), "-filter_complex",
    files.map((_, k) => `[${k}]crop=360:240:140:120[c${k}]`).join(";") + ";" + files.map((_, k) => `[c${k}]`).join("") + `hstack=inputs=${files.length}`, name]);
  console.log(name);
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
