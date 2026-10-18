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

  // the clip's span starts at the replay when the replay goes back before the live stretch
  const span = await page.evaluate(async () => {
    const { makeTimeline, clipSpan } = await import("./js/sample3d.js");
    return clipSpan(makeTimeline([105], 1000, 100));
  });
  if (Math.abs(span[0] - 94.1) > 0.01 || Math.abs(span[1] - 120) > 0.01) fail(`clip span ${span}, expected [94.1, 120]`);

  // ball handling (web/js/ball3d.js): the 3D ball is the tracking ball at every event and within
  // 1.5 m in between, there are kicks and touches, and a rolling ball turns the way it goes
  const ball = await page.evaluate(() => {
    const p = window.sample3d.scene.rig.plan, [a, b] = window.sample3d.scene.span;
    const roll = [];
    for (let t = a; t < b; t += 0.1) {
      const q0 = p.ball(t), q1 = p.ball(t + 0.04);
      const vx = (q1.x - q0.x) / 0.04, vy = (q1.y - q0.y) / 0.04;
      if (q0.h > 0.05 || Math.hypot(vx, vy) < 2) continue;
      // the turn from t to t+0.04 (d = q1 * conj(q0), Hamilton) must carry the top of the ball
      // along the velocity; world X is contract x and world Z is contract y
      const [ax, ay, az, aw] = q1.q, [bx, by, bz, bw] = [-q0.q[0], -q0.q[1], -q0.q[2], q0.q[3]];
      const x = aw * bx + ax * bw + ay * bz - az * by, y = aw * by - ax * bz + ay * bw + az * bx;
      const z = aw * bz + ax * by - ay * bx + az * bw, w = aw * bw - ax * bx - ay * by - az * bz;
      const top = [2 * (x * y - w * z), 2 * (y * z + w * x)];   // world x and z of the turned up vector
      roll.push(Math.sign(top[0] * vx + top[1] * vy));
    }
    return { ...p.check(a, b), forward: roll.filter((s) => s > 0).length, rolls: roll.length };
  });
  console.log(`ball plan: worst ${ball.worst.toFixed(2)} m, ${ball.atEvents.toExponential(1)} m off at events, ${ball.legs} leg actions, rolls forward ${ball.forward}/${ball.rolls}`);
  if (!(ball.worst < 1.5) || ball.atEvents > 1e-3 || ball.legs < 5) fail(`ball plan off: ${JSON.stringify(ball)}`);
  if (ball.rolls < 10 || ball.forward < ball.rolls * 0.95) fail(`ball rolls the wrong way: ${ball.forward}/${ball.rolls}`);

  // awareness (web/js/awareness.js, awareness-rig.js), measured on the rendered bones. Each check
  // runs with the layer on and off: on must pass, and off must fail, or the check measures nothing.
  // 1. defenders (side without the ball, outfield) within 15 m of the ball whose head points
  //    within 30 deg of it, every 0.8 s of the live part;
  // 2. 1.5 s after the goal: the scorer, all but 3 teammates and all but 3 of the conceding side
  //    play an emotion clip.
  const aware = (on) => page.evaluate(async ({ on, cut }) => {
    const s = window.sample3d, sc = s.scene, aw = sc.awareness, m = s.match;
    aw.enabled = on;
    const ev = [...m.events].sort((a, b) => a.ts - b.ts);
    const set = async (c) => { await window.__setTime(c - 0.04); return window.__setTime(c); };
    let n = 0, ok = 0;
    for (let c = 1; c < cut - 0.3; c += 0.8) {
      const { ts } = await set(c);
      const b = sc.rig.ball(ts), poss = ev.filter((e) => e.ts <= ts).pop()?.team_id;
      for (const p of sc.players) {
        const at = m.at(p.i, ts);
        if (!at || p.pid.startsWith(poss) || m.players[p.pid]?.position === "GK") continue;
        const dx = b.x - at[0], dy = b.y - at[1];
        if (Math.hypot(dx, dy) > 15) continue;
        const h = aw.headDir(p.i), off = Math.abs(Math.atan2(Math.sin(Math.atan2(dx, dy) - h.yaw), Math.cos(Math.atan2(dx, dy) - h.yaw)));
        n++; if (off < Math.PI / 6) ok++;
      }
    }
    const g = m.goals.find((x) => Math.abs(x.ts - s.tl.goal) < 1e-6);
    const { ts } = await set(s.tl.goal - s.tl.from + 1.5);
    const scorer = g.player_id ?? m.events.find((e) => g.source_event_ids.includes(e.event_id)).player_id;
    const r = { scorer: 0, mates: 0, matesOn: 0, conc: 0, concOn: 0 };
    for (const p of sc.players) {
      if (!m.at(p.i, ts)) continue;
      const emo = Object.entries(p.aw).some(([k, w]) => w > 0 && !/^(Slide|Jump|Roll)/.test(k));
      if (p.pid === scorer) r.scorer = emo ? 1 : 0;
      else if (p.pid.startsWith(g.team_id)) { r.matesOn++; if (emo) r.mates++; }
      else { r.concOn++; if (emo) r.conc++; }
    }
    aw.enabled = true;
    return { n, share: ok / Math.max(n, 1), ...r };
  }, { on, cut });
  const awOn = await aware(true), awOff = await aware(false);
  const lookOk = (r) => r.n >= 20 && r.share >= 0.7;
  const emoOk = (r) => r.scorer === 1 && r.mates >= r.matesOn - 3 && r.conc >= r.concOn - 3;
  for (const [name, r] of [["on", awOn], ["off", awOff]])
    console.log(`awareness ${name}: ${(100 * r.share).toFixed(0)}% of ${r.n} defender heads within 30 deg of the ball; after the goal scorer ${r.scorer}, teammates ${r.mates}/${r.matesOn}, conceding ${r.conc}/${r.concOn}`);
  if (!lookOk(awOn)) fail(`defenders do not watch the ball: ${JSON.stringify(awOn)}`);
  if (lookOk(awOff)) fail(`head check passes without the awareness layer: ${JSON.stringify(awOff)}`);
  if (!emoOk(awOn)) fail(`no reaction to the goal: ${JSON.stringify(awOn)}`);
  if (emoOk(awOff)) fail(`goal check passes without the awareness layer: ${JSON.stringify(awOff)}`);

  // Space toggles play once, also when the Play button has the focus (Chromium already drops the
  // button click once keydown is prevented, so here this does not catch a missing keyup handler)
  const toggles = await page.evaluate(() => {
    const s = window.sample3d, was = s.state.playing;
    document.querySelector("#play").focus();
    return { was };
  });
  await page.keyboard.press("Space");
  const after = await page.evaluate(() => window.sample3d.state.playing);
  if (after === toggles.was) fail("Space did not toggle play exactly once");
  await page.evaluate((w) => window.sample3d.setPlaying(w), toggles.was);

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
  const rate = (on) => page.evaluate(async (on) => {
    const s = window.sample3d, t0 = performance.now();
    s.scene.awareness.enabled = on;
    let n = 0;
    while (performance.now() - t0 < 4000) { await window.__setTime(4 + n * 0.04); n++; }
    s.scene.awareness.enabled = true;
    return n / ((performance.now() - t0) / 1000);
  }, on);
  // interleaved twice, best of each: one pass in order was dominated by warm-up and machine load
  const r = [];
  for (const on of [false, true, false, true]) r.push(await rate(on));
  const fpsOff = Math.max(r[0], r[2]), fps = Math.max(r[1], r[3]);
  console.log(`software WebGL: ${fps.toFixed(2)} frames/s including graphics (${fpsOff.toFixed(2)} without awareness)`);

  // without ?match= the page loads M001, the match shipped in the image (it may be absent here)
  const bare = await page.context().newPage();
  const asked = bare.waitForRequest((r) => r.url().includes("data/M001/meta.json"), { timeout: 30000 }).then(() => true, () => false);
  await bare.goto(new URL("sample3d.html?capture=1", base).href);
  if (!(await asked)) fail("sample3d.html without ?match= did not ask for M001");
  await bare.close();
} finally {
  await browser.close();
}
if (failures.length) { console.log(`${failures.length} failure(s)`); process.exit(1); }
console.log("sample3d shots ok");
