// A keeper holding the ball (web/js/ball3d.js holds, web/js/keeper3d-rig.js): the 3D clip is
// stepped at 30 fps through the first hold after <ts> and the ball must sit between his hands,
// within 0.15 m of their midpoint, from 0.2 s after the catch until he lets it go, and never jump
// over 0.5 m a frame. Exits 1 otherwise; saves out/shots/hold3d.png from a camera beside him.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh hold3d.mjs [match] [ts]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const [base, match = "M001", ts = "1295"] = process.argv.slice(2);
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });
const errors = [];
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
let bad = false;
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.setDefaultTimeout(600000);
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  await page.goto(new URL(`sample3d.html?match=${match}&capture=1&from=${Number(ts) - 2}`, base).href);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 600000 });
  const r = await page.evaluate(async (ts) => {
    const s = window.sample3d, sc = s.scene;
    const d = sc.rig.plan.holds.find((h) => h.t0 >= ts);
    if (!d) return { none: true };
    const rows = [];
    let prev = null, jump = 0;
    for (let t = d.t0 - 0.5; t < d.t2 + 0.3; t += 1 / 30) {
      await window.__setTime(t - s.tl.from);
      const b = sc.ball.position, h = sc.keeper.hands(d.i), cur = [b.x, b.y, b.z];
      if (prev) jump = Math.max(jump, Math.hypot(...cur.map((v, k) => v - prev[k])));
      prev = cur;
      if (t >= d.t0 + 0.2 && t <= d.t1) rows.push({ t: +t.toFixed(2), off: Math.hypot(b.x - (h[0] - 52.5), b.y - h[2], b.z - (h[1] - 34)), y: b.y });
    }
    // a still from beside him, mid-hold
    await window.__setTime((d.t0 + d.t1) / 2 - s.tl.from);
    const B = window.BABYLON, cam = sc.cams.replay, b = sc.ball.position;
    document.head.insertAdjacentHTML("beforeend", "<style>#stage{display:none!important}</style>");
    cam.position.set(b.x + (b.x > 0 ? -3 : 3), 1.3, b.z - 2.5);
    cam.setTarget(new B.Vector3(b.x, 0.9, b.z));
    sc.scene.activeCamera = cam;
    sc.scene.render();
    return { hold: d, rows, jump };
  }, Number(ts));
  if (r.none) { console.log(`FAIL no hold after ${ts}`); bad = true; }
  else {
    const worst = r.rows.reduce((a, x) => (x.off > a.off ? x : a), { off: 0 });
    console.log(`hold of entity ${r.hold.i} ${r.hold.t0.toFixed(2)}-${r.hold.t1.toFixed(2)}: ${r.rows.length} frames, ball off the hands at most ${worst.off.toFixed(3)} m (${worst.t}), largest frame step ${r.jump.toFixed(3)} m`);
    if (worst.off > 0.15 || r.jump > 0.5 || r.rows.length < 5) bad = true;
    await page.screenshot({ path: `${shots}/hold3d.png` });
  }
} finally {
  await browser.close();
}
for (const e of errors) console.log(e);
if (bad || errors.length) { console.log("FAIL"); process.exit(1); }
console.log("ok");
