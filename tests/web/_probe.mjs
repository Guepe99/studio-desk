// temporary probe: screenshot of the 3D frame at clock c with extra query params
import { createRequire } from "node:module";
import { homedir } from "node:os";
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");
const [base, qs = "", clocks = "4", out = "/tmp/claude-1000/-home-giuseppemercadante/19969fe5-5225-411d-a18e-7e7b912ede03/scratchpad/sc3d/probe"] = process.argv.slice(2);
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") console.log(`console: ${m.text()}`); });
  await page.goto(new URL(`sample3d.html?match=DEMO&capture=1${qs}`, base).href);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 180000 });
  if (process.env.EVAL) console.log(await page.evaluate(process.env.EVAL));
  for (const c of clocks.split(",")) {
    const info = await page.evaluate(async (c) => {
      await window.__setTime(+c);
      const s = window.sample3d.scene, cam = s.scene.activeCamera;
      return { cam: cam.name, pos: cam.position.asArray().map((v) => +v.toFixed(1)), tgt: cam.getTarget().asArray().map((v) => +v.toFixed(1)), fov: +cam.fov.toFixed(3), debug: s.debug };
    }, c);
    console.log(c, JSON.stringify(info));
    await page.locator("#view3d").screenshot({ path: `${out}-${c}.png` });
  }
} finally {
  await browser.close();
}
