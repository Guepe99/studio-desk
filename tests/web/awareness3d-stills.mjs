// Stills of the awareness layer (web/js/awareness-rig.js) on a match, saved as out/shots/:
//   awareness3d-attack-before.png / -after.png  an attack on the defence, layer off and on, seen
//                                                from the defenders' goal (so their faces show)
//   awareness3d-celebration.png                  the scorer and his teammates 2 s after the goal
//   awareness3d-dejected.png                     the conceding side at the same moment
//   awareness3d-near-miss.png                    a shot that misses the frame, 1 s after
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh awareness3d-stills.mjs [match]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const match = process.argv[3] ?? "M001";
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });

const errors = [];
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();

async function open(from) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  await page.goto(new URL(`sample3d.html?match=${match}&capture=1&view=3d${from === undefined ? "" : `&from=${from}`}`, base).href);
  await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 300000 });
  return page;
}

// Draw clock second c with the layer on or off, then frame(ts, scene, match) -> [eye, target],
// both [x, y, h] in contract metres, places the camera, and save the frame. frame runs in the page.
async function still(page, name, c, on, frame) {
  await page.evaluate(async ({ c, on, src }) => {
    const frame = (0, eval)(`(${src})`);
    const s = window.sample3d, B = window.BABYLON, sc = s.scene;
    sc.awareness.enabled = on;
    await window.__setTime(c - 0.04);
    const { ts } = await window.__setTime(c);
    document.querySelector("#stage").style.visibility = "hidden";
    const [eye, at] = frame(ts, sc, s.match);
    const cam = sc.cams.replay;
    cam.position.set(eye[0] - 52.5, eye[2], eye[1] - 34);
    cam.setTarget(new B.Vector3(at[0] - 52.5, at[2], at[1] - 34));
    cam.fov = 0.55;
    sc.scene.activeCamera = cam;
    sc.scene.render();
  }, { c, on, src: frame.toString() });
  await page.screenshot({ path: `${shots}/awareness3d-${name}.png` });
  console.log(`awareness3d-${name}.png at clock ${c.toFixed(2)} s, layer ${on ? "on" : "off"}`);
}

try {
  // the default stretch: the build-up to the first goal, the goal, the reactions
  const page = await open();
  const plan = await page.evaluate(() => {
    const s = window.sample3d, m = s.match, sc = s.scene, aw = sc.awareness.aw, tl = s.tl;
    // an attack: a carrier running at the goal he attacks with the most defenders within 12 m
    let best = null;
    for (let c = 2; c < tl.goal - tl.from - 0.3; c += 0.2) {
      const ts = tl.at(c).ts, b = sc.rig.ball(ts);
      let car = null, cd = 1.5;
      for (const p of sc.players) { const q = m.at(p.i, ts); if (q && Math.hypot(q[0] - b.x, q[1] - b.y) < cd) { cd = Math.hypot(q[0] - b.x, q[1] - b.y); car = p; } }
      if (!car) continue;
      const team = car.pid.split("-")[0], gx = 105 - aw.goalX(team, ts);
      const q = m.at(car.i, ts), q2 = m.at(car.i, ts + 0.3);
      if ((q2[0] - q[0]) * Math.sign(gx - q[0]) / 0.3 < 2.5 || Math.abs(gx - q[0]) > 40) continue;
      const n = sc.players.filter((p) => !p.pid.startsWith(team) && m.at(p.i, ts) && Math.hypot(m.at(p.i, ts)[0] - b.x, m.at(p.i, ts)[1] - b.y) < 12).length;
      if (!best || n > best.n) best = { c, n, gx, pid: car.pid };
    }
    const g = m.goals.find((x) => Math.abs(x.ts - tl.goal) < 1e-6);
    // the first near miss off the frame (not a save) anywhere in the match
    const shotOf = (e) => m.events.find((x) => `event:${x.event_id}` === e.src);
    const near = aw.emotions.find((e) => e.kind === "near_miss" &&
      !m.events.some((x) => x.type_name === "keeper_save" && x.ts >= shotOf(e).ts && x.ts - shotOf(e).ts < 2.5))?.t0;
    return { attack: best, goal: tl.goal - tl.from, team: g.team_id, near };
  });
  console.log(JSON.stringify(plan));
  const a = plan.attack;
  // from the defenders' goal, above the line, looking at the ball
  const attackCam = (ts, sc) => {
    const b = sc.rig.ball(ts), d = Math.sign(window.__gx - b.x);
    return [[b.x + d * 17, b.y + (34 - b.y) * 0.2, 6.5], [b.x + d * 4, b.y, 0.8]];
  };
  await page.evaluate((gx) => { window.__gx = gx; }, a.gx);
  await still(page, "attack-before", a.c, false, attackCam);
  await still(page, "attack-after", a.c, true, attackCam);
  // the scorer's group: from the pitch side of the scorer
  await page.evaluate((team) => { window.__team = team; }, plan.team);
  await still(page, "celebration", plan.goal + 2.0, true, (ts, sc, m) => {
    const mine = sc.players.filter((p) => p.pid.startsWith(window.__team) && m.at(p.i, ts));
    const scorer = m.goals.find((g) => Math.abs(g.ts - window.sample3d.tl.goal) < 1e-6).player_id;
    const at = m.at(m.index[scorer], ts);
    return [[at[0] + (52.5 - at[0]) * 0.18, at[1] + (34 - at[1]) * 0.25 - 7, 3.2], [at[0], at[1], 1.1]];
  });
  await still(page, "dejected", plan.goal + 2.3, true, (ts, sc, m) => {
    const theirs = sc.players.filter((p) => !p.pid.startsWith(window.__team) && m.at(p.i, ts)).map((p) => m.at(p.i, ts));
    const b = sc.rig.ball(ts);
    theirs.sort((p, q) => Math.hypot(p[0] - b.x, p[1] - b.y) - Math.hypot(q[0] - b.x, q[1] - b.y));
    const near = theirs.slice(0, 5), cx = near.reduce((s, p) => s + p[0], 0) / 5, cy = near.reduce((s, p) => s + p[1], 0) / 5;
    return [[cx + Math.sign(52.5 - cx) * 11, cy - 6, 3.5], [cx, cy, 1.0]];
  });
  await page.context().close();

  // a near miss, in a stretch that starts 9 s before it
  const near = plan.near;
  if (near === undefined) errors.push("no near miss in this match");
  else {
    const p3 = await open(Math.max(0, near - 9));
    await p3.evaluate((t0) => { window.__t0 = t0; }, near);
    const c = await p3.evaluate((t0) => t0 - window.sample3d.tl.from + 0.8, near);
    await still(p3, "near-miss", c, true, (ts, sc, m) => {
      const e = sc.awareness.aw.emotions.find((x) => x.kind === "near_miss" && Math.abs(x.t0 - window.__t0) < 1e-6);
      const at = m.at(e.i, ts);
      return [[at[0] + (52.5 - at[0]) * 0.2, at[1] + (34 - at[1]) * 0.3 - 6, 2.6], [at[0], at[1], 1.2]];
    });
  }
} finally {
  await browser.close();
}
if (errors.length) { console.log(errors.join("\n")); process.exit(1); }
console.log("awareness3d stills ok");
