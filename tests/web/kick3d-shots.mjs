// The whole-body kicks (docs/motion3d.md, "Kicks with the whole body"): the first shot, short pass
// and long pass of the clip, saved to out/shots/:
//   motion3d-<kind>-close.png       five moments around contact (-0.3, -0.11, 0, +0.14, +0.32 s) from
//                                   low cameras on the kicker's standing-leg side: from the side (top
//                                   row) and from the front; with BEFORE=1 two more rows show the
//                                   legs-only pose of before
//   motion3d-<kind>-broadcast.png   the broadcast camera at contact, cropped around the kicker
// LOOK=anime uses the anime footballers.
//
//   [LOOK=anime] [BEFORE=1] scripts/with-lock.sh chromium tests/web/run-smoke.sh kick3d-shots.mjs [match]
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const match = process.argv[3] ?? "DEMO";
const look = process.env.LOOK === "anime" ? "anime" : "footballer";
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out");
const tmp = `${out}/kick3d-tmp`;
mkdirSync(tmp, { recursive: true });
mkdirSync(`${out}/shots`, { recursive: true });
const OFFSETS = [-0.3, -0.11, 0, 0.14, 0.32];
const tag = `${match === "DEMO" ? "" : `${match.toLowerCase()}-`}${look === "anime" ? "anime-" : ""}`;

const errors = [];
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
  page.setDefaultTimeout(300000);
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  await page.goto(new URL(`sample3d.html?match=${match}&capture=1&view=3d&players=${look}`, base).href);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 300000 });
  // first contact of each kind in the live part of the clip, with room for the whole window
  const picks = await page.evaluate(() => {
    const s = window.sample3d, from = s.tl.from, end = s.tl.cuts[1] ?? s.LOOP_S, found = {};
    for (const [i, A] of s.scene.rig.plan.actors) for (const l of A.legs) {
      const c = l.t - from;
      if (!["shot", "pass", "long"].includes(l.kind) || c < 0.6 || c > end - 0.6) continue;
      if (!found[l.kind] || c < found[l.kind].c) found[l.kind] = { i, c, kind: l.kind, side: l.side };
    }
    return found;
  });
  console.log(JSON.stringify(picks));
  for (const kind of ["shot", "pass", "long"]) {
    const pick = picks[kind];
    if (!pick) { console.log(`no ${kind} in the live part of ${match}`); continue; }
    const rows = [];
    for (const body of process.env.BEFORE ? [true, false] : [true]) for (const [view, across, ahead] of [["side", 4.8, 0.8], ["front", 3.6, 3.6]]) {
      const files = [];
      for (const [k, off] of OFFSETS.entries()) {
        await page.evaluate(async ({ pick, c, body, across, ahead }) => {
          const s = window.sample3d, B = window.BABYLON, sc = s.scene;
          sc.rig.body = body;
          for (const q of sc.players) q.holder.setEnabled(true);
          await window.__setTime(c - 0.04);
          await window.__setTime(c);
          document.querySelector("#stage").style.visibility = "hidden";
          const me = sc.players.find((q) => q.i === pick.i);
          for (const q of sc.players) if (q !== me) q.holder.setEnabled(false);
          // a low camera on the kicker's standing-leg side, looking at his hips
          const yaw = me.holder.rotation.y, side = pick.side === "l" ? 1 : -1;
          const rx = Math.cos(yaw) * side, rz = -Math.sin(yaw) * side, fx = Math.sin(yaw), fz = Math.cos(yaw);
          const at = me.holder.position.add(new B.Vector3(0, 0.85, 0));
          const cam = sc.cams.replay;
          cam.position.set(at.x + rx * across + fx * ahead, 1.2, at.z + rz * across + fz * ahead);
          cam.setTarget(at);
          cam.fov = 0.6;
          sc.scene.activeCamera = cam;
          sc.scene.render();
        }, { pick, c: pick.c + off, body, across, ahead });
        const f = `${tmp}/${kind}-${body ? "a" : "b"}${view}${k}.png`;
        await page.screenshot({ path: f, clip: { x: 300, y: 30, width: 360, height: 480 } });
        files.push(f);
      }
      const row = `${tmp}/${kind}-${body ? "a" : "b"}${view}.png`;
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...files.flatMap((f) => ["-i", f]), "-filter_complex", `hstack=inputs=${files.length}`, row]);
      rows.push(row);
    }
    const close = `${out}/shots/motion3d-${tag}${kind}-close.png`;
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...rows.flatMap((f) => ["-i", f]), "-filter_complex", `vstack=inputs=${rows.length}`, close]);
    // the broadcast camera at contact, a 480 x 270 window around the kicker scaled to 960 x 540
    const at = await page.evaluate(async ({ pick }) => {
      const s = window.sample3d, sc = s.scene;
      sc.rig.body = true;
      for (const q of sc.players) q.holder.setEnabled(true);
      document.querySelector("#stage").style.visibility = "visible";
      await window.__setTime(pick.c - 0.5);
      for (let c = pick.c - 0.46; c <= pick.c + 0.001; c += 0.04) await window.__setTime(c);
      const { ts } = await window.__setTime(pick.c);
      return sc.project(pick.i, ts);
    }, { pick });
    const full = `${tmp}/${kind}-broadcast.png`;
    await page.screenshot({ path: full });
    const x = Math.round(Math.min(Math.max(at.x / 2 - 240, 0), 480)), y = Math.round(Math.min(Math.max(at.y / 2 - 200, 0), 270));
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", full, "-vf", `crop=480:270:${x}:${y},scale=960:540:flags=lanczos`, `${out}/shots/motion3d-${tag}${kind}-broadcast.png`]);
    console.log(`motion3d-${tag}${kind}: entity ${pick.i}, ${pick.side} foot, clock ${pick.c.toFixed(2)} s`);
  }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
if (errors.length) { console.log(errors.join("\n")); process.exit(1); }
