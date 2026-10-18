// Opens web/sample3d.html on the DEMO fixture, fails on console errors, checks that the nameplate
// sits on its player in 3D, and saves three 1280x720 screenshots to out/shots/:
// sample3d-side.png (TV camera), sample3d-nameplate.png, sample3d-replay.png (behind the goal).
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh sample3d-shots.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const url = new URL("sample3d.html?match=DEMO&capture=1", base).href;
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") fail(`console: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  page.on("requestfailed", (r) => fail(`request failed: ${r.url()}`));
  await page.goto(url);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 180000 });
  await page.evaluate(() => document.fonts.ready);
  const tl = await page.evaluate(() => ({ from: window.sample3d.tl.from, goal: window.sample3d.tl.goal, cuts: window.sample3d.tl.cuts }));
  console.log(`timeline: from ${tl.from}, goal ${tl.goal}, cuts ${tl.cuts}`);
  if (tl.goal === null) fail("no goal in the default 20 s");

  // timeline self-check: live before the cut, replay after it, ending just after the goal
  const at = (c) => page.evaluate((x) => window.sample3d.tl.at(x), c);
  const cut = tl.cuts[1];
  const a = await at(cut - 0.01), b = await at(cut + 0.01), e = await at(19.99);
  if (a.replay || !b.replay) fail(`replay flag wrong around the cut: ${JSON.stringify([a, b])}`);
  if (Math.abs(e.ts - (tl.goal + 1.6)) > 0.05) fail(`replay ends at ${e.ts}, expected ${tl.goal + 1.6}`);

  // locomotion blend: weights sum to 1, still is pure idle, a sprint is pure sprint
  const blend = await page.evaluate(async () => {
    const { clipWeights } = await import("./js/scene3d.js");
    return [0, 0.5, 3, 7, 12].map((v) => clipWeights(v));
  });
  if (blend.some((w) => Math.abs(w.reduce((a, b) => a + b, 0) - 1) > 1e-9) || blend[0][0] !== 1 || blend[4][3] !== 1)
    fail(`clip weights wrong: ${JSON.stringify(blend)}`);

  // nameplate: the anchor must be where the 3D projection of its player is
  const nameplate = () => page.evaluate(() => {
    const s = window.sample3d;
    for (const inst of s.host.live.values()) {
      if (inst.cue.graphic !== "nameplate") continue;
      const want = s.host.opts.locate(inst.cue.payload.player_id, s.tl.at(s.state.c).ts);
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(inst.el.shadowRoot.querySelector(".anchor")?.style.transform ?? "");
      return { want, offset: m ? Math.hypot(Number(m[1]) - want.x, Number(m[2]) - want.y) : Infinity };
    }
    return null;
  });

  const nameCue = await page.evaluate(() => window.sample3d.match.cues.find((c) => c.graphic === "nameplate" && c.audience === "analyst"));
  const moments = [
    ["side", 4],
    ["nameplate", nameCue.ts + 2.2 - tl.from],
    ["replay", cut + (20 - cut) * 0.82],
  ];
  for (const [name, c] of moments) {
    const t0 = Date.now();
    // two frames so the camera and the animation blend settle on continuous time
    await page.evaluate((x) => window.__setTime(x - 0.04), c);
    await page.evaluate((x) => window.__setTime(x), c);
    await page.waitForTimeout(100);
    if (name === "nameplate") {
      const np = await nameplate();
      if (!np) fail("nameplate not on screen at its cue");
      else if (!np.want.visible) fail("nameplate player off screen");
      else if (np.offset > 2) fail(`nameplate ${np.offset.toFixed(1)} px off its player`);
      else console.log(`nameplate on its player (offset ${np.offset.toFixed(2)} px at ${np.want.x.toFixed(0)},${np.want.y.toFixed(0)})`);
    }
    await page.screenshot({ path: `${shots}/sample3d-${name}.png` });
    console.log(`sample3d-${name}.png at clock ${c.toFixed(2)} s (${Date.now() - t0} ms)`);
  }
  // frame rate in this (software-rendered) browser, for the record
  const fps = await page.evaluate(async () => {
    const s = window.sample3d, t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < 4000) { await window.__setTime(4 + n * 0.04); n++; }
    return n / ((performance.now() - t0) / 1000);
  });
  console.log(`software WebGL: ${fps.toFixed(2)} frames/s including graphics`);
} finally {
  await browser.close();
}
if (failures.length) { console.log(`${failures.length} failure(s)`); process.exit(1); }
console.log("sample3d shots ok");
