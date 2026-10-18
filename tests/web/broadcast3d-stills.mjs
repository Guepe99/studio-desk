// Stills for docs/broadcast3d.md, saved to out/shots/broadcast3d-<tag>-<shot>.png: the wide live
// shot, the tight shot at the stoppage after the goal, the goal-camera replay, an establishing
// shot (camera 1 on a wide lens, tilted up to the far roof and masts: the floodlights are outside
// every match framing), the phone page in portrait and landscape, and the wide shot again with
// ?light=day. Run it on the high profile:
//
//   WEBGL=2 scripts/with-lock.sh chromium tests/web/run-smoke.sh broadcast3d-stills.mjs <tag> [match] [query]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const [base, tag = "after", match = "DEMO", query = ""] = process.argv.slice(2);
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
const open = async (qs, ctx = { viewport: { width: 1280, height: 720 } }) => {
  const pg = await (await browser.newContext(ctx)).newPage();
  pg.setDefaultTimeout(300000);
  pg.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  await pg.goto(new URL(`sample3d.html?match=${match}&capture=1${query ? `&${query}` : ""}${qs}`, base).href);
  await pg.waitForFunction(() => window.sample3d?.ready, null, { timeout: 240000 });
  await pg.evaluate(() => document.fonts.ready);
  return pg;
};
const at = async (pg, c) => {
  await pg.evaluate((x) => window.__setTime(x - 0.04), c);
  await pg.evaluate((x) => window.__setTime(x), c);
  return pg.evaluate(() => `${window.sample3d.scene.debug.camera} ${window.sample3d.scene.debug.profile}`);
};
const save = async (pg, shot, c, whole = false) => {
  const what = await at(pg, c);
  const file = `${shots}/broadcast3d-${tag}-${shot}.png`;
  await (whole ? pg.screenshot({ path: file }) : pg.locator("#view3d").screenshot({ path: file }));
  console.log(`${path.basename(file)} at clock ${c.toFixed(2)} s (${what})`);
};
try {
  const pg = await open("");
  const tl = await pg.evaluate(() => ({ from: window.sample3d.tl.from, goal: window.sample3d.tl.goal, cut: window.sample3d.tl.cuts[1] }));
  await save(pg, "wide", 4);
  await save(pg, "tight", tl.goal - tl.from + 1.6);
  await save(pg, "replay", tl.cut + (20 - tl.cut) * 0.6);
  await pg.evaluate(() => {
    const cams = window.sample3d.scene.cams;
    cams.update = function () {
      this.focus = null; this.mode = "establishing";
      this.tv.setTarget(new window.BABYLON.Vector3(0, 8, 20));
      this.tv.fov = 0.72;   // about 70 degrees across at 16:9
      this.scene.activeCamera = this.tv;
    };
  });
  await save(pg, "establishing", 4);
  await pg.close();
  const day = await open("&light=day");
  await save(day, "wide-day", 4);
  await day.close();
  for (const [shot, w, h] of [["phone-portrait", 390, 844], ["phone-landscape", 844, 390]]) {
    const ph = await open("", { viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await save(ph, shot, 4, true);
    await ph.close();
  }
} finally {
  await browser.close();
}
