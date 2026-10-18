// Frame rate of the 3D sample at 1280x720: three 3-second runs, each frame finished on the GPU
// (a one-pixel readPixels) so the number is what the renderer completes, not what the page
// queues. With "all" it then switches parts off one after the other, to see what each costs.
// This machine is shared and the renderers are software: compare runs taken back to back.
//
//   [WEBGL=2] scripts/with-lock.sh chromium tests/web/run-smoke.sh scene3d-perf.mjs [low|high|auto [all]]
import { createRequire } from "node:module";
import { homedir } from "node:os";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const quality = ["low", "high"].includes(process.argv[3]) ? `&quality=${process.argv[3]}` : "";
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.setDefaultTimeout(300000);
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  await page.goto(new URL(`sample3d.html?match=DEMO&capture=1${quality}`, base).href);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 180000 });
  const fps = () => page.evaluate(async () => {
    const gl = window.sample3d.scene.engine._gl, px = new Uint8Array(4);
    const frame = async (c) => { await window.__setTime(c); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    for (let k = 0; k < 3; k++) await frame(3.88 + k * 0.04);   // untimed: shaders compile after a change
    let n = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 3000) { await frame(4 + n * 0.04); n++; }
    return n / ((performance.now() - t0) / 1000);
  });
  const median = async () => {
    const runs = [await fps(), await fps(), await fps()].sort((a, b) => a - b);
    return `${runs[1].toFixed(2)} fps (runs ${runs.map((r) => r.toFixed(1)).join(", ")})`;
  };
  console.log(`profile ${await page.evaluate(() => JSON.stringify(window.sample3d.scene.debug ?? "before the overhaul"))}`);
  console.log(`all on: ${await median()}`);
  if (process.argv[4] === "all") {
    const steps = [
      ["sun shadows off", (s) => s.light?.dropShadows()],
      ["crowd off", (s) => s.scene.meshes.filter((m) => /^crowd/.test(m.name)).forEach((m) => m.setEnabled(false))],
      ["post effects to minimum", (s) => s.post?.drop()],
      ["post pipeline off", (s) => { (s.post?.pipe ?? s.pipeline)?.dispose(); s.post?.fxaa?.forEach((f) => f.dispose()); }],
    ];
    for (const [name, fn] of steps) {
      await page.evaluate(`(${fn})(window.sample3d.scene)`);
      console.log(`${name}: ${await median()}`);
    }
  }
} finally {
  await browser.close();
}
