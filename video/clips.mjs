// Moving 3D clips of the live site for the submission video: the page runs on Playwright's fake clock and
// each video frame advances it by 1/30 s, so the software renderer's slowness never shows in the clip.
// Needs a Chromium with WebGL 2 on CDP_URL (capture.sh starts one). Usage: node clips.mjs [clip ...]
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const BASE = "https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/";
const FPS = 30;
// name: [replay second to start at, seconds of clip]
const CLIPS = { chance: [466, 5], goal: [592, 6.5], goal2: [598.5, 2.5], test: [465.5, 0.1] };

const browser = await chromium.connectOverCDP(process.env.CDP_URL);
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
page.setDefaultTimeout(240000);
page.on("pageerror", (e) => console.log("page error:", e.message));
// the fake clock from the first script on: a page frame stamped by the real clock after the switch would step the replay back
await page.clock.install();

for (const name of process.argv.slice(2)) {
  const [from, len] = CLIPS[name];
  const out = new URL(`./public/clips/${name}/`, import.meta.url).pathname;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await page.goto(new URL(`?match=M001&t=${from}&view=split`, BASE).href, { waitUntil: "load" });
  await page.waitForFunction(() => window.studioDesk?.view3d?.scene, null, { timeout: 240000 });
  await page.waitForTimeout(8000);
  await page.evaluate(() => document.querySelector("#welcome")?.close());   // the first visit's welcome, if any
  await page.clock.pauseAt(Date.now() + 1000);
  // the first frames on the fake clock see time run backwards (a negative step in the page's tick): let them pass first
  await page.clock.runFor(500);
  // a deep link alone starts play a little earlier; seek after starting puts it where the clip begins
  await page.evaluate((t) => { window.studioDesk.setPlaying(true); window.studioDesk.seek(t); }, from);
  await page.clock.runFor(50);
  console.log(name, "starts at", await page.evaluate(() => window.studioDesk.state.ts));
  const frame = page.locator("#frame");
  const t0 = Date.now();
  for (let i = 0; i < Math.round(len * FPS); i++) {
    await page.clock.runFor(1000 / FPS);
    await frame.screenshot({ path: `${out}${String(i).padStart(4, "0")}.jpg`, type: "jpeg", quality: 90 });
    if (i % 30 === 0) {
      const ts = await page.evaluate(() => window.studioDesk.state.ts);
      console.log(`${name} frame ${i}: replay at ${ts.toFixed(2)} (expected ${(from + i / FPS).toFixed(2)})`);
      if (Math.abs(ts - from - i / FPS) > 0.5) throw new Error(`${name}: replay clock off`);
    }
  }
  const ts = await page.evaluate(() => window.studioDesk.state.ts);
  console.log(`${name}: ${Math.round(len * FPS)} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s, replay now at ${ts.toFixed(2)} (expected ${from + len})`);
}
await browser.close();
