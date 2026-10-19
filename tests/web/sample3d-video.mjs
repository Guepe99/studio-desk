// Renders the 20 s 3D sample to out/shots/<name>.mp4 (default sample3d, on DEMO): the page clock is driven frame by frame
// (window.__setTime, 30 fps), one screenshot per frame, then ffmpeg (libx264, yuv420p, crf 23).
// The frames are deleted afterwards. About 6 minutes with software WebGL, so run it detached:
//
//   [WEBGL=2 for quality=high] [START=12 SECONDS=3 CRF=32] scripts/with-lock.sh chromium tests/web/run-smoke.sh sample3d-video.mjs [match] [name] [query]
// query: extra page parameters, e.g. "from=97.5&motion=procedural". START and SECONDS cut a short
// clip out of the 20 s (clock seconds), CRF lowers the quality for a quick look.
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const FPS = 30, START = +(process.env.START ?? 0), SECONDS = +(process.env.SECONDS ?? 20), CRF = process.env.CRF ?? "23";
const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const match = process.argv[3] ?? "DEMO", name = process.argv[4] ?? "sample3d";   // [match] [output name]
const query = process.argv[5] ? `&${process.argv[5]}` : "";
const url = new URL(`sample3d.html?match=${match}&capture=1&view=3d${query}`, base).href;
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out");
const frames = `${out}/${name}-frames`;
mkdirSync(frames, { recursive: true });
mkdirSync(`${out}/shots`, { recursive: true });

const errors = [];
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 180000 });
  await page.evaluate(() => document.fonts.ready);
  // a short clip starts from a warm scene: the springs (facing, gait weights) run up to START
  for (let c = Math.max(0, START - 0.5); c < START - 1e-6; c += 1 / FPS) await page.evaluate((x) => window.__setTime(x), c);
  const t0 = Date.now();
  for (let f = 0; f < FPS * SECONDS; f++) {
    await page.evaluate((c) => window.__setTime(c), START + f / FPS);
    await page.screenshot({ path: `${frames}/frame${String(f).padStart(4, "0")}.jpg`, type: "jpeg", quality: 95 });
    if (f % 50 === 0) console.log(`frame ${f} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
} finally {
  await browser.close();
}
if (errors.length) { console.log(errors.join("\n")); process.exit(1); }
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", `${frames}/frame%04d.jpg`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", CRF, "-s", "1280x720", `${out}/shots/${name}.mp4`], { stdio: "inherit" });
rmSync(frames, { recursive: true, force: true });
console.log(`${name}.mp4 written (${FPS * SECONDS} frames)`);
