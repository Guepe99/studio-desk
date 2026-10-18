// Close-ups of the ball handling in the 3D sample: one dribble touch, one received pass, one kick.
// Each still is a strip of four moments around the foot-ball contact (-0.2, -0.1, 0, +0.15 s),
// seen from a low side camera, saved as out/shots/ball3d-<what>.png.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh ball3d-stills.mjs [match]
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
const url = new URL(`sample3d.html?match=${match}&capture=1&view=3d`, base).href;
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out");
const tmp = `${out}/ball3d-tmp`;
mkdirSync(tmp, { recursive: true });
mkdirSync(`${out}/shots`, { recursive: true });
const OFFSETS = [-0.2, -0.1, 0, 0.15];

const errors = [];
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 180000 });
  // first contact of each kind in the live part of the clip
  const picks = await page.evaluate(() => {
    const s = window.sample3d, from = s.tl.from, end = s.tl.cuts[1] ?? s.LOOP_S;
    const found = {};
    const want = { dribble: ["touch"], receive: ["trap"], kick: ["shot", "long", "pass"] };
    for (const [i, A] of s.scene.rig.plan.actors) for (const l of A.legs) {
      const c = l.t - from;
      if (c < 0.5 || c > end - 0.5) continue;
      for (const [name, kinds] of Object.entries(want)) {
        const rank = kinds.indexOf(l.kind);
        if (rank < 0) continue;
        const cur = found[name];
        if (!cur || rank < cur.rank || (rank === cur.rank && c < cur.c)) found[name] = { i, c, kind: l.kind, side: l.side, rank, pid: s.match.meta.entities[i] };
      }
    }
    return found;
  });
  console.log(JSON.stringify(picks));
  for (const [name, pick] of Object.entries(picks)) {
    const files = [];
    for (const [k, off] of OFFSETS.entries()) {
      await page.evaluate(async ({ pick, c }) => {
        const s = window.sample3d, B = window.BABYLON, sc = s.scene;
        await window.__setTime(c - 0.04);
        await window.__setTime(c);
        // a close-up: only this player and the ball, no graphics
        document.querySelector("#stage").style.visibility = "hidden";
        const me = sc.players.find((q) => q.i === pick.i);
        for (const q of sc.players) if (q !== me) q.holder.setEnabled(false);
        // low camera on the kicking-foot side of the player, a little ahead, looking at his feet and the ball
        const ts = s.tl.at(c).ts, p = sc.match.at(pick.i, ts), o = sc.rig.plan.pose(pick.i, ts), b = sc.rig.plan.ball(ts);
        const px = p[0] + (o?.dx ?? 0), py = p[1] + (o?.dy ?? 0);
        const mid = new B.Vector3((px + b.x) / 2 - 52.5, 0.55, (py + b.y) / 2 - 34);
        const yaw = me.holder.rotation.y, side = pick.side === "l" ? -1 : 1;
        const rx = Math.cos(yaw) * side, rz = -Math.sin(yaw) * side, fx = Math.sin(yaw), fz = Math.cos(yaw);
        const cam = sc.goalCam;
        cam.position.set(mid.x + rx * 4.5 + fx * 1.5, 1.0, mid.z + rz * 4.5 + fz * 1.5);
        cam.setTarget(mid);
        cam.fov = 0.5;
        sc.scene.activeCamera = cam;
        sc.scene.render();
      }, { pick, c: pick.c + off });
      const f = `${tmp}/${name}-${k}.png`;
      await page.screenshot({ path: f });
      files.push(f);
    }
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...files.flatMap((f) => ["-i", f]),
      "-filter_complex", "[0][1][2][3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0", `${out}/shots/ball3d-${name}.png`]);
    console.log(`ball3d-${name}.png: ${pick.kind} by ${pick.pid} at clock ${pick.c.toFixed(2)} s`);
  }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
if (errors.length) { console.log(errors.join("\n")); process.exit(1); }
