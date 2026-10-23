// Stills of the crowd and stadium cutaways (web/js/scene3d/cutaway.js, docs/broadcast3d.md) on the
// broadcast page: for each kind of shot the first cutaway of the match at its start, middle and end
// of the shot, and camera 1 just before and after it. Saved to out/crowd-cutaways/<tag>-<n>-<kind>-<when>.png.
//
//   WEBGL=2 MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh cutaway3d-stills.mjs <tag> [kinds] [quality]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const [base, tag = "now", kinds = "fans,end,stadium", quality = ""] = process.argv.slice(2);
const MATCH = process.env.MATCH ?? "M001", N = +(process.env.N ?? 1);
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/crowd-cutaways");
mkdirSync(dir, { recursive: true });
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.setDefaultTimeout(300000);
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  await page.goto(new URL(`index.html?match=${MATCH}&view=3d${quality ? `&quality=${quality}` : ""}`, base).href);
  await page.waitForFunction(() => window.studioDesk?.view3d?.scene, null, { timeout: 300000 });
  const plan = await page.evaluate(() => window.studioDesk.view3d.scene.cams.cutaways);
  console.log(`${plan.length} cutaways`);
  const at = (ts) => page.evaluate(async (ts) => {
    const sd = window.studioDesk, v = sd.view3d, raf = () => new Promise((r) => requestAnimationFrame(r));
    v.floor = 0;   // no fallback to 2D on the slow software renderer
    sd.setPlaying(false); sd.seek(ts);
    for (let k = 0; k < 60 && !v.ready; k++) await raf();
    for (let k = 0; k < 3; k++) await raf();
    return v.scene.debug.camera;
  }, ts);
  for (const kind of kinds.split(",")) {
    for (const [n, c] of plan.filter((x) => x.kind === kind).slice(0, N).entries()) {
      const len = c.to - c.from;
      for (const [when, ts] of [["before", c.from - 0.3], ["start", c.from + 0.2], ["mid", c.from + len / 2], ["end", c.to - 0.2], ["after", c.to + 0.3]]) {
        if (process.env.ONLY && !process.env.ONLY.split(",").includes(when)) continue;
        const cam = await at(ts);
        const file = `${dir}/${tag}-${n}-${kind}-${when}.png`;
        await page.locator("#view3d").screenshot({ path: file });
        console.log(`${path.basename(file)} ts ${ts.toFixed(1)} camera ${cam}`);
      }
    }
  }
} finally {
  await browser.close();
}
