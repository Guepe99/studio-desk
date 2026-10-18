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
  const split = () => page.evaluate(async () => {
    const s = window.sample3d, sc = s.scene, out = { update: 0, render: 0, sync: 0, engineFrame: 0 };
    for (let n = 0; n < 15; n++) {
      const v = s.tl.at(4 + n * 0.04);
      let t = performance.now(); sc.update(v, 0.04); out.update += performance.now() - t;
      t = performance.now(); sc.render(); sc.engine.getGlInfo && sc.engine._gl.finish(); out.render += performance.now() - t;
      t = performance.now(); s.host.sync(v.ts, false); await Promise.all([...s.host.live.values()].map((i) => i.chain)); out.sync += performance.now() - t;
    }
    for (const k in out) out[k] = +(out[k] / 15).toFixed(1);
    const e = sc.engine;
    out.effects = Object.keys(e._compiledEffects ?? {}).length;
    out.active = sc.scene.getActiveMeshes().length;
    out.meshes = sc.scene.meshes.length;
    out.anims = sc.scene._activeAnimatables?.length;
    out.observers = sc.scene.onAfterAnimationsObservable.observers.length + "/" + sc.scene.onBeforeRenderObservable.observers.length;
    return out;
  });
  console.log(`ms per frame ${JSON.stringify(await split())}`);
  console.log(`all on: ${(await fps()).toFixed(2)} fps`);
  console.log(`ms per frame ${JSON.stringify(await split())}`);
  const steps = [
    ["all on, again", () => {}],
    ["all on, third time", () => {}],
    ["sun shadows off", (s) => s.light.dropShadows()],
    ["crowd off", (s) => s.scene.meshes.filter((m) => /^crowd/.test(m.name)).forEach((m) => m.setEnabled(false))],
    ["post effects to minimum", (s) => s.post.drop()],
    ["post pipeline off", (s) => { s.post.pipe?.dispose(); s.post.fxaa?.forEach((f) => f.dispose()); }],
    ["stands off", (s) => s.scene.meshes.filter((m) => /^(tier|w|rf|bd|mast|lampHead)/.test(m.name)).forEach((m) => m.setEnabled(false))],
  ];
  for (const [name, fn] of steps) {
    await page.evaluate(`(${fn})(window.sample3d.scene)`);
    console.log(`${name}: ${(await fps()).toFixed(2)} fps`);
  }
} finally {
  await browser.close();
}
