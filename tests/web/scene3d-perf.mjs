// Frame rate of the 3D sample, and what each part of the frame costs: the same 1280x720 page,
// measured with all parts on, then with them switched off one after the other.
//
//   [WEBGL=2] scripts/with-lock.sh chromium tests/web/run-smoke.sh scene3d-perf.mjs [low|high]
import { createRequire } from "node:module";
import { homedir } from "node:os";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const quality = process.argv[3] ? `&quality=${process.argv[3]}` : "";
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  await page.goto(new URL(`sample3d.html?match=DEMO&capture=1${quality}`, base).href);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 180000 });
  // a few untimed frames first: switching a part off recompiles shaders, slowly in software
  const fps = () => page.evaluate(async () => {
    for (let k = 0; k < 4; k++) await window.__setTime(3 + k * 0.04);
    let n = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 3000) { await window.__setTime(4 + n * 0.04); n++; }
    return n / ((performance.now() - t0) / 1000);
  });
  console.log(`profile ${await page.evaluate(() => JSON.stringify(window.sample3d.scene.debug))}`);
  console.log(`all on: ${(await fps()).toFixed(2)} fps`);
  const steps = [
    ["sun shadows off", (s) => s.light.dropShadows()],
    ["crowd off", (s) => s.scene.meshes.filter((m) => /^crowd/.test(m.name)).forEach((m) => m.setEnabled(false))],
    ["post effects to minimum", (s) => s.post.drop()],
    ["post pipeline off", (s) => s.post.pipe.dispose()],
    ["stands off", (s) => s.scene.meshes.filter((m) => /^(tier|w|rf|bd|mast|lampHead)/.test(m.name)).forEach((m) => m.setEnabled(false))],
  ];
  for (const [name, fn] of steps) {
    await page.evaluate(`(${fn})(window.sample3d.scene)`);
    console.log(`${name}: ${(await fps()).toFixed(2)} fps`);
  }
} finally {
  await browser.close();
}
