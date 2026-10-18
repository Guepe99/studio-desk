// Close-up stills for docs/flow3d.md: the 3D frame at match time ts, the replay camera placed
// `dist` metres from a player (or the ball) on the broadcast side, saved to out/shots/<name>.png.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh flow3d-stills.mjs <match> <ts> <name> <pid|ball|keeper> [dist] [query]
// keeper: the keeper of the reaction nearest ts (web/js/keeper3d-rig.js).
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const [base, match, ts, name, who, dist = "5", query = ""] = process.argv.slice(2);
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.setDefaultTimeout(300000);
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  await page.goto(new URL(`sample3d.html?match=${match}&capture=1&from=${Number(ts) - 6}${query ? `&${query}` : ""}`, base).href);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 180000 });
  const info = await page.evaluate(async ({ ts, who, dist }) => {
    const s = window.sample3d, sc = s.scene, B = window.BABYLON;
    const c = ts - s.tl.from;
    await window.__setTime(c - 0.04);
    await window.__setTime(c);
    document.head.insertAdjacentHTML("beforeend", "<style>#stage{display:none!important}</style>");   // no graphics on a close-up
    let at, label = who, h = 0.8, yaw = null;
    const ball = sc.ball.position;
    if (who === "ball") { at = ball.clone(); h = 0.3; }
    else {
      const r = who === "keeper" ? [...(sc.keeper?.reactions ?? [])].sort((a, b) => Math.abs(a.tc - ts) - Math.abs(b.tc - ts))[0] : null;
      const p = sc.players.find((q) => (r ? q.i === r.i : q.pid === who));
      at = r ? p.holder.position.add(new B.Vector3(0, 0.6, 0)) : p.holder.position.add(new B.Vector3(0, 0.25, 0));   // same framing in both trees
      if (!r) h = 0.35;   // a kick: low, at boot and ball height
      else yaw = p.holder.rotation.y + 0.6;   // the keeper from in front, a little to one side
      label = `${p.pid}${r ? ` ${r.kind} ${r.clip}${r.goal ? " goal" : " save"}` : ""}`;
    }
    const cam = sc.cams.replay;
    if (yaw === null) cam.position.set(at.x, at.y + h, at.z - dist);   // from the broadcast side
    else cam.position.set(at.x + Math.sin(yaw) * dist, at.y + h, at.z + Math.cos(yaw) * dist);
    cam.setTarget(at);
    cam.fov = 0.6;
    sc.scene.activeCamera = cam;
    sc.scene.render();
    return label;
  }, { ts: Number(ts), who, dist: Number(dist) });
  await page.locator("#view3d").screenshot({ path: `${shots}/${name}.png` });
  console.log(`${name}.png: ${match} at ${ts} s, ${info}`);
} finally {
  await browser.close();
}
