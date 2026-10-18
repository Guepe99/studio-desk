// Opens web/sample3d.html on the DEMO fixture, fails on console errors, checks that the nameplate
// sits on its player in 3D, and saves three 1280x720 screenshots to out/shots/:
// sample3d-side.png (TV camera), sample3d-nameplate.png, sample3d-replay.png (behind the goal),
// plus the scene3d-*.png stills of the 3D frame (see below). Run it twice: WebGL 1 for the low
// profile, WEBGL=2 for the high one.
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
  page.setDefaultTimeout(120000);   // software WebGL 2 with sun shadows is slow
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

  // the broadcast look (docs/scene3d-research.md): image-based light, sun shadows by profile, and
  // the pure helpers of the profile picker, the crowd, the event actions and the drivers
  const look = await page.evaluate(async () => {
    const s = window.sample3d.scene, sc = s.scene;
    const { pickProfile, PROFILES } = await import("./js/scene3d/quality.js");
    const { seatGrid } = await import("./js/scene3d/stands.js");
    const { scheduleActions, resolve, facing } = await import("./js/scene3d/players.js");
    const env = (v, msaa, coarse, side) => ({ webGLVersion: v, maxMSAA: msaa, coarsePointer: coarse, shortSide: side });
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const seats = seatGrid(40, 20, 1, rnd);
    const sched = scheduleActions([
      { ts: 10, type_name: "tackle", player_id: "A", start_x: 1, start_y: 2 },
      { ts: 10.8, type_name: "pass", bodypart_name: "head", player_id: "A", start_x: 1, start_y: 2 },
      { ts: 20, type_name: "keeper_save", player_id: "K", start_x: 3, start_y: 4 },
    ]);
    const r = resolve([
      { priority: 10, pose: () => ({ dx: 1, yaw: Math.PI / 2, yawW: 1, mode: "backpedal" }) },
      { priority: 20, pose: () => ({ dy: 2, leg: { kind: "kick" } }) },
      { priority: 30, pose: () => ({ action: { clip: "Roll" }, actionW: 0.5 }) },
    ], 0, 0);
    const casters = s.light.csm?.getShadowMap().renderList.length ?? 0;
    return {
      debug: s.debug,
      env: !!sc.environmentTexture && sc.environmentTexture.isReady(),
      envIntensity: sc.environmentIntensity,
      toneMapping: sc.imageProcessingConfiguration.toneMappingType,
      casters, blobs: s.shadows?.isVisible ?? false,
      profiles: [pickProfile(env(2, 4, false, 1080)).name, pickProfile(env(1, 1, false, 1080)).name,
        pickProfile(env(2, 4, true, 390)).name, pickProfile(env(1, 1, false, 1080), "high").name],
      highHasMore: PROFILES.high.shadowMap > 0 && PROFILES.low.shadowMap === 0,
      seats: { n: seats.length, top: Math.max(...seats.map((x) => x[2])), inside: seats.every(([x, d]) => Math.abs(x) < 20 && d > 0 && d < 20) },
      sched: { A: sched.A.map((a) => [a.kind, +a.start.toFixed(2), +a.end.toFixed(2)]), K: sched.K?.map((a) => a.kind) ?? null },
      resolved: { dx: r.dx, dy: r.dy, mode: r.mode, leg: r.leg, actionW: r.actionW, yaw: +facing(0, r.turns).toFixed(3) },
    };
  });
  console.log(`look: ${JSON.stringify(look.debug)}, ${look.casters} shadow casters, profiles ${look.profiles}`);
  if (!look.debug.ibl || !look.env || !(look.envIntensity > 0)) fail("no image-based light");
  if (look.toneMapping !== 2) fail(`tone mapping ${look.toneMapping}, expected KHR PBR Neutral (2)`);
  if (look.debug.profile === "high" && (look.debug.shadows !== "csm" || look.casters < 20)) fail(`high profile without sun shadows: ${look.casters} casters`);
  if (look.debug.profile === "low" && (look.debug.shadows !== "blob" || !look.blobs)) fail("low profile without blob shadows");
  if (look.profiles.join() !== "high,low,low,high" || !look.highHasMore) fail(`profile picker: ${look.profiles}`);
  if (look.seats.n < 500 || !look.seats.inside || look.seats.top > 17) fail(`seat grid: ${JSON.stringify(look.seats)}`);
  // the tackle's slide is cut short by the header 0.8 s later; saves are keeper3d's, not an action
  if (JSON.stringify(look.sched.A.map((a) => a[0])) !== '["slide","header"]' || look.sched.A[0][2] > look.sched.A[1][1] + 1e-9
    || look.sched.K !== null) fail(`actions: ${JSON.stringify(look)}`);
  if (JSON.stringify(look.resolved) !== JSON.stringify({ dx: 1, dy: 2, mode: "backpedal", leg: null, actionW: 0.5, yaw: 1.571 }))
    fail(`drivers resolve to ${JSON.stringify(look.resolved)}`);

  // broadcast camera: fixed on the halfway line 18 m up, the ball always in the middle 90% of the
  // frame through the live stretch, except the close shot of the scorer after the goal (centred
  // on him), then the replay camera after the cut
  const tv = await page.evaluate(async (cut) => {
    const s = window.sample3d, sc = s.scene, out = { worst: 0, moved: false, cams: new Set(), celebration: [] };
    const ndc = (cam, v) => window.BABYLON.Vector3.TransformCoordinates(v, cam.getViewMatrix().multiply(cam.getProjectionMatrix()));
    let first = null;
    for (let c = 0; c < cut; c += 0.2) {
      await window.__setTime(c);
      sc.engine._gl.readPixels(0, 0, 1, 1, 6408, 5121, new Uint8Array(4));   // let a software GPU keep up
      const cam = sc.scene.activeCamera;
      if (sc.debug.camera === "celebration") {
        const g = sc.cams.goals.find((x) => s.tl.at(c).ts >= x.ts);
        const p = sc.players.find((q) => q.i === g.i).holder.position;
        const q = ndc(cam, p.add(new window.BABYLON.Vector3(0, 1.2, 0)));
        out.celebration.push(+Math.hypot(q.x, q.y).toFixed(2));
        continue;
      }
      out.cams.add(cam.name);
      if (Math.abs(cam.position.x) > 1e-6 || Math.abs(cam.position.y - 18) > 1e-6 || Math.abs(cam.position.z + 68) > 1e-6) out.pos = cam.position.asArray();
      const p = ndc(cam, sc.ball.getAbsolutePosition());
      out.worst = Math.max(out.worst, Math.abs(p.x), Math.abs(p.y));
      const t = cam.getTarget().asArray().map((v) => +v.toFixed(1)).join();
      if (first === null) first = t; else if (t !== first) out.moved = true;
    }
    await window.__setTime(cut + 1);
    out.replay = sc.scene.activeCamera.name;
    out.after = sc.debug.camera;
    out.cams = [...out.cams];
    return out;
  }, cut);
  console.log(`broadcast camera: ball within ${(tv.worst * 100).toFixed(0)}% of the half frame, cameras ${tv.cams}, scorer close-up ${tv.celebration.length} frames (off centre ${Math.max(...tv.celebration)}), then ${tv.after}`);
  if (tv.celebration.length < 5 || Math.max(...tv.celebration) > 0.35) fail(`no close shot of the scorer after the goal: ${JSON.stringify(tv.celebration)}`);
  if (tv.cams.join() !== "tv" || tv.pos) fail(`broadcast camera not fixed on the gantry: ${JSON.stringify(tv)}`);
  if (!(tv.worst < 0.9) || !tv.moved) fail(`broadcast camera loses the ball or never pans: ${JSON.stringify(tv)}`);
  if (tv.replay === "tv" || !/^replay/.test(tv.after)) fail(`no replay camera after the cut: ${JSON.stringify(tv)}`);

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
      const emo = Object.entries(p.aw).some(([k, w]) => w > 0 && !/^(Slide|Jump|Roll|GK_)/.test(k));
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
    const gl = s.scene.engine._gl, px = new Uint8Array(4);   // each frame finished, not just queued
    while (performance.now() - t0 < 4000) { await window.__setTime(4 + n * 0.04); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); n++; }
    s.scene.awareness.enabled = true;
    return n / ((performance.now() - t0) / 1000);
  }, on);
  // interleaved twice, best of each: one pass in order was dominated by warm-up and machine load
  const r = [];
  for (const on of [false, true, false, true]) r.push(await rate(on));
  const fpsOff = Math.max(r[0], r[2]), fps = Math.max(r[1], r[3]);
  console.log(`software WebGL: ${fps.toFixed(2)} frames/s including graphics (${fpsOff.toFixed(2)} without awareness)`);

  // scene3d stills, 3D frame only (graded against docs/scene3d-research.md). The low profile run
  // (WebGL 1) saves scene3d-low.png; the high one (WEBGL=2) the wide shot, a replay angle, the
  // tackle close-up and a phone in portrait, which picks the low profile by itself.
  const still = async (pg, name, c) => {
    await pg.evaluate((x) => window.__setTime(x - 0.04), c);
    await pg.evaluate((x) => window.__setTime(x), c);
    await pg.locator("#view3d").screenshot({ path: `${shots}/scene3d-${name}.png` });
    console.log(`scene3d-${name}.png at clock ${c.toFixed(2)} s`);
  };
  const open = async (qs, ctxOpts = { viewport: { width: 1280, height: 720 } }) => {
    const pg = await (await browser.newContext(ctxOpts)).newPage();
    pg.setDefaultTimeout(120000);
    pg.on("console", (m) => { if (m.type() === "error") fail(`console (${qs}): ${m.text()}`); });
    pg.on("pageerror", (e) => fail(`page error (${qs}): ${e.message}`));
    await pg.goto(new URL(`sample3d.html?match=DEMO&capture=1${qs}`, base).href);
    await pg.waitForFunction(() => window.sample3d?.ready, null, { timeout: 180000 });
    await pg.evaluate(() => document.fonts.ready);
    return pg;
  };
  await still(page, `celebration-${look.debug.profile}`, tl.goal - tl.from + 1.5);   // before the replay wipe
  if (look.debug.profile === "low") await still(page, "low", 4);
  else {
    await still(page, "wide", 4);
    const rp = await open("&replay=low");
    await still(rp, "replay-low", cut + (20 - cut) * 0.5);
    if (await rp.evaluate(() => window.sample3d.scene.debug.camera) !== "replay-low") fail("?replay=low did not pick the low angle");
    await rp.close();
    // the DEMO tackle (T02-8 at 304 s) from 6 m, mid-slide
    const tk = await open("&from=296");
    const c = await tk.evaluate(() => 304.25 - window.sample3d.tl.from);
    await tk.evaluate((x) => window.__setTime(x - 0.04), c);
    const pose = await tk.evaluate(async (x) => {
      await window.__setTime(x);
      const s = window.sample3d.scene, B = window.BABYLON;
      const p = s.players.find((q) => q.pid === "T02-8");
      const at = p.holder.position, cam = s.cams.replay;
      cam.position.set(at.x - 4, 1.4, at.z - 4.5);
      cam.setTarget(new B.Vector3(at.x, 0.5, at.z));
      cam.fov = 0.55;
      s.scene.activeCamera = cam;
      s.render();
      return { slide: Object.entries(p.aw).filter(([, w]) => w > 0).map(([k]) => k) };
    }, c);
    if (!pose.slide.some((k) => k.startsWith("Slide"))) fail(`tackle not sliding: ${JSON.stringify(pose)}`);
    await tk.locator("#view3d").screenshot({ path: `${shots}/scene3d-tackle.png` });
    console.log(`scene3d-tackle.png at clock ${c.toFixed(2)} s, clips ${pose.slide}`);
    await tk.close();
    const ph = await open("", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    if (await ph.evaluate(() => window.sample3d.scene.debug.profile) !== "low") fail("a phone did not get the low profile");
    await ph.evaluate((x) => window.__setTime(x), 4);
    await ph.evaluate((x) => window.__setTime(x), 4.04);
    await ph.screenshot({ path: `${shots}/scene3d-phone.png` });
    console.log("scene3d-phone.png at clock 4.04 s (whole page)");
    await ph.close();
  }

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
