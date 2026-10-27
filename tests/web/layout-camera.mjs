// Reduced motion holds the TV camera: with prefers-reduced-motion the 3D
// view stays on camera 1's wide shot through a crowd cutaway, a goal's punch-in, the tight shot of
// the scorer and the goal replay (none plays), and camera 1 does not slide along its rail; without it
// the same moments cut and slide (a check that the check sees them).
//
//   MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh layout-camera.mjs
import { createRequire } from "node:module";
import { homedir } from "node:os";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const MATCH = process.env.MATCH ?? "M001";
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();

async function shots(reducedMotion) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion });
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);   // software WebGL loads and draws slowly
  page.on("pageerror", (e) => fail(`${reducedMotion} page error: ${e.message}`));
  await page.goto(new URL(`index.html?match=${MATCH}&view=3d`, base).href);
  await page.waitForFunction(() => { const v = window.studioDesk?.view3d; return v && (v.mode === "2d" || v.scene || v.failed); }, null, { timeout: 300000 });
  const out = await page.evaluate(async () => {
    const sd = window.studioDesk, v = sd.view3d, s = v.scene, raf = () => new Promise((r) => requestAnimationFrame(r));
    if (!s) return null;
    const { replays } = await import("./js/view3d.js");
    const cut = s.cams.cutaways[0], goal = s.cams.goals[0], stop = s.cams.stops.find((x) => x[0] >= goal.ts), rep = replays(sd.match)[0];
    const at = async (ts) => {
      sd.setPlaying(false); sd.seek(ts);
      for (let k = 0; k < 4; k++) await raf();
      return { ts, camera: s.debug.camera, active: s.scene.activeCamera.name, fov: s.cams.tv.fov, replay: !!v.last?.replay, x: s.cams.tv.position.x };
    };
    // the rail: the moment camera 1 is furthest along it (camera.js railAt)
    const { railAt } = await import("./js/scene3d/sightline.js"), { BROADCAST_POS } = await import("./js/scene3d/camera.js");
    let slide = 0;
    for (let t = 0; t < sd.match.duration; t += 1) if (Math.abs(railAt(s.cams.rail, t)) > Math.abs(railAt(s.cams.rail, slide))) slide = t;
    return { cutaway: await at((cut.from + cut.to) / 2), punch: await at(goal.ts - 0.3), tight: await at((stop[0] + stop[1]) / 2), replay: rep ? await at(rep.from + 3) : null,
      rail: await at(slide), home: BROADCAST_POS.x };
  });
  await ctx.close();
  return out;
}

try {
  const still = await shots("reduce"), moving = await shots("no-preference");
  if (!still || !moving) fail("no 3D scene: run with WebGL (WEBGL=1, the default for this script)");
  else {
    console.log(JSON.stringify({ still, moving }));
    for (const k of ["cutaway", "punch", "tight", "replay"]) {
      if (!still[k]) { fail(`${k}: no such moment in ${MATCH}`); continue; }
      if (still[k].camera !== "broadcast" || still[k].active !== "tv") fail(`reduced motion at the ${k}: camera ${still[k].camera} (${still[k].active})`);
      if (still[k].replay) fail(`reduced motion at the ${k}: the goal replay plays`);
    }
    if (Math.abs(still.rail.x - still.home) > 1e-6) fail(`reduced motion: camera 1 slides along its rail (x ${still.rail.x} against ${still.home})`);
    if (!(Math.abs(moving.rail.x - moving.home) > 0.5)) fail(`no-preference: camera 1 does not slide on its rail at ${moving.rail.ts} (x ${moving.rail.x} against ${moving.home})`);
    // the check of the check: without the preference the same moments do cut and punch in
    if (moving.tight.camera !== "celebration" && !moving.tight.camera.startsWith("replay")) fail(`no-preference tight shot: ${moving.tight.camera}`);
    if (!moving.cutaway.camera.startsWith("crowd-")) fail(`no-preference cutaway: ${moving.cutaway.camera}`);
    if (moving.replay && !moving.replay.camera.startsWith("replay")) fail(`no-preference replay: ${moving.replay.camera}`);
    if (!(moving.punch.fov < still.punch.fov - 1e-3)) fail(`punch-in: fov ${moving.punch.fov} moving, ${still.punch.fov} still; the moving camera should be tighter`);
  }
} finally {
  await browser.close();
}
if (failures.length) { console.log(`${failures.length} failure(s)`); process.exit(1); }
console.log("layout-camera: reduced motion holds the TV camera");
