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
import { measure } from "./flow3d-measure.mjs";

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
      casters, blobs: s.grounding?.contact.isVisible ?? false,
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
  if (!look.blobs) fail("no contact shadows under the players");
  if (look.debug.profile === "low" && look.debug.shadows !== "blob") fail("low profile without blob shadows");
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
  // Broadcast rules (docs/broadcast3d.md): camera 1 on the halfway line 30 to 40 m back from the
  // near touchline, 12 to 16 degrees down to the centre spot and along its median line of sight; a
  // long lens (19 to 34 degrees across, 24 to 42 m of pitch at the aim); the tight shot of the
  // scorer from camera 2, a pitchside handheld: 2 to 4 m up, 8 to 30 m away, on a long lens (under
  // 16 degrees across), nearly level (3 degrees up to 6 down), still for the shot, with his head and
  // knees in the frame; cuts only at a stoppage (within 8 s after a goal, or inside the
  // camera's own foul and save stoppages).
  const tv = await page.evaluate(async (cut) => {
    const s = window.sample3d, sc = s.scene, out = { worst: 0, moved: false, cams: new Set(), celebration: [], tight: [], tightPitch: [], head: [], cam2: [], hfov: [], width: [], pitch: [], cuts: [] };
    const ndc = (cam, v) => window.BABYLON.Vector3.TransformCoordinates(v, cam.getViewMatrix().multiply(cam.getProjectionMatrix()));
    let first = null, last = null;
    for (let c = 0; c < cut; c += 0.2) {
      const { ts } = await window.__setTime(c);
      sc.engine._gl.readPixels(0, 0, 1, 1, 6408, 5121, new Uint8Array(4));   // let a software GPU keep up
      const cam = sc.scene.activeCamera;
      if (last !== null && cam.name !== last) out.cuts.push({ ts, to: cam.name });
      last = cam.name;
      if (sc.debug.camera === "celebration") {
        const g = sc.cams.goals.find((x) => s.tl.at(c).ts >= x.ts);
        const p = sc.players.find((q) => q.i === g.i).holder.position;
        const q = ndc(cam, p.add(new window.BABYLON.Vector3(0, 1.2, 0)));
        out.celebration.push(+Math.hypot(q.x, q.y).toFixed(2));
        out.tight.push(+window.BABYLON.Vector3.Distance(cam.position, p).toFixed(1));
        const at = cam.getTarget();
        out.tightPitch.push(Math.asin((cam.position.y - at.y) / window.BABYLON.Vector3.Distance(cam.position, at)) * 180 / Math.PI);
        out.head.push([ndc(cam, p.add(new window.BABYLON.Vector3(0, 1.85, 0))).y, ndc(cam, p.add(new window.BABYLON.Vector3(0, 0.5, 0))).y]);
        out.cam2.push([...cam.position.asArray(), 2 * Math.atan(Math.tan(cam.fov / 2) * sc.engine.getAspectRatio(cam)) * 180 / Math.PI]);
        continue;
      }
      const hfov = 2 * Math.atan(Math.tan(cam.fov / 2) * sc.engine.getAspectRatio(cam));
      const aim = cam.getTarget(), dist = window.BABYLON.Vector3.Distance(cam.position, aim);
      out.hfov.push(hfov * 180 / Math.PI);
      out.width.push(2 * dist * Math.tan(hfov / 2));
      out.pitch.push(Math.asin((cam.position.y - aim.y) / dist) * 180 / Math.PI);
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
  const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const spot = Math.atan2(18, 68) * 180 / Math.PI;   // the gantry is fixed at (0, 18, -68), checked above
  const lens = { hfov: [Math.min(...tv.hfov), Math.max(...tv.hfov)].map((v) => +v.toFixed(1)), width: [Math.min(...tv.width), Math.max(...tv.width)].map((v) => +v.toFixed(1)),
    pitch: +med(tv.pitch).toFixed(1), tight: tv.tight.length ? Math.min(...tv.tight) : 0,
    tightPitch: tv.tightPitch.length ? [Math.min(...tv.tightPitch), Math.max(...tv.tightPitch)].map((v) => +v.toFixed(1)) : [],
    framed: tv.head.filter(([h, f]) => h < 0.98 && f > -0.98).length / Math.max(1, tv.head.length),
    height: tv.cam2.length ? [Math.min(...tv.cam2.map((c) => c[1])), Math.max(...tv.cam2.map((c) => c[1]))] : [],
    still: tv.cam2.every((c) => Math.hypot(c[0] - tv.cam2[0][0], c[2] - tv.cam2[0][2]) < 1e-3),
    tightLens: tv.cam2.length ? +Math.max(...tv.cam2.map((c) => c[3])).toFixed(1) : 0 };
  const goalTs = await page.evaluate(() => window.sample3d.match.goals.map((g) => g.ts));
  const stops = await page.evaluate(() => window.sample3d.scene.cams.stops?.map(([a, b]) => [a, b]) ?? []);
  const before = await at(cut - 0.01);
  const cuts = [...tv.cuts, { ts: before.ts, to: "replay" }];
  const atStop = (ts) => goalTs.some((g) => ts >= g && ts <= g + 8) || stops.some(([a, b]) => ts >= a - 0.3 && ts <= b + 0.3);
  console.log(`broadcast rules: centre spot ${spot.toFixed(1)} deg down, median line of sight ${lens.pitch} deg, lens ${lens.hfov} deg across, ${lens.width} m of pitch at the aim, tight shot from ${lens.tight} m and ${lens.height} m up on a ${lens.tightLens} deg lens at ${lens.tightPitch} deg down (knees to head in ${(lens.framed * 100).toFixed(0)}% of frames), cuts at ${cuts.map((x) => `${x.ts.toFixed(1)}->${x.to}`)}`);
  if (spot < 12 || spot > 16 || lens.pitch < 12 || lens.pitch > 16) fail(`camera 1 not 12 to 16 degrees down: ${JSON.stringify(lens)}`);
  if (lens.hfov[0] < 18 || lens.hfov[1] > 34 || lens.width[0] < 23 || lens.width[1] > 43) fail(`camera 1 not on a long lens: ${JSON.stringify(lens)}`);
  if (!(lens.tight >= 8 && Math.max(...tv.tight) <= 30 && lens.height[0] >= 2 && lens.height[1] <= 4 && lens.tightLens < 16 && lens.still)) fail(`tight shot not from a pitchside camera on a long lens: ${JSON.stringify(lens)}`);
  if (!(lens.tightPitch[0] >= -3 && lens.tightPitch[1] <= 6 && lens.framed >= 0.8)) fail(`tight shot not level and knees to head: ${JSON.stringify(lens)}`);
  if (cuts.some((x) => !atStop(x.ts))) fail(`a cut in live play: ${JSON.stringify(cuts)}, goals at ${goalTs}`);

  // grounding (web/js/scene3d/grounding.js), on the rendered pixels: the grass 0.3 m in front of
  // each player's feet, with the layer on against off (median over the players on screen), must
  // darken; the grass 8 m in front of them, beyond every blob, must not change
  const ground = (on) => page.evaluate(async (on) => {
    const s = window.sample3d, sc = s.scene, B = window.BABYLON;
    if (sc.grounding) sc.grounding.enabled = on;   // absent before broadcast3d: on and off match, the check fails
    await window.__setTime(3.96); await window.__setTime(4);
    const eng = sc.engine, gl = eng._gl, w = eng.getRenderWidth(), h = eng.getRenderHeight();
    const cam = sc.scene.activeCamera, px = new Uint8Array(4), tm = cam.getTransformationMatrix(), vp = cam.viewport.toGlobal(w, h);
    const lum = (v) => {
      const p = B.Vector3.Project(v, B.Matrix.IdentityReadOnly, tm, vp);
      if (p.x < 2 || p.y < 2 || p.x > w - 3 || p.y > h - 3 || p.z < 0 || p.z > 1) return null;
      gl.readPixels(Math.round(p.x), Math.round(h - p.y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
    };
    const r = sc.players.filter((p) => p.holder.isEnabled()).map((p) => {
      const q = p.holder.position;
      return [lum(new B.Vector3(q.x, 0, q.z - 0.3)), lum(new B.Vector3(q.x, 0, q.z - 8))];
    });
    if (sc.grounding) sc.grounding.enabled = true;
    return r;
  }, on);
  const gOn = await ground(true), gOff = await ground(false);
  const ratio = (j) => med(gOn.map((v, k) => (v[j] && gOff[k][j] ? v[j] / gOff[k][j] : null)).filter((x) => x !== null));
  const gr = { feet: +ratio(0).toFixed(3), away: +ratio(1).toFixed(3), n: gOn.filter((v) => v[0]).length };
  console.log(`grounding: grass in front of the feet at ${gr.feet} of its brightness without the layer, 8 m away at ${gr.away}, ${gr.n} players`);
  if (!(gr.n >= 8 && gr.feet < 0.9)) fail(`no darkening under the feet: ${JSON.stringify(gr)}`);
  if (!(gr.away > 0.95)) fail(`grounding darkens more than the feet: ${JSON.stringify(gr)}`);

  // the colour grade's lookup table layout (web/js/scene3d/post.js): an identity table must leave
  // the frame as it is without grading, and the broadcast table must change it
  const lut = await page.evaluate(async () => {
    const s = window.sample3d, sc = s.scene, { lutTexture, setGrade } = await import("./js/scene3d/post.js");
    const cfg = sc.post.pipe.imageProcessing.imageProcessingConfiguration;
    const gl = sc.engine._gl, w = sc.engine.getRenderWidth(), h = sc.engine.getRenderHeight();
    const id = lutTexture(sc.scene, (r, g, b) => [r, g, b]);
    await new Promise((ok) => id.isReady() ? ok() : id.onLoadObservable.addOnce(ok));
    const grab = async () => { await window.__setTime(3.96); await window.__setTime(4); const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
    const diff = (a, b) => { let d = 0, n = 0; for (let k = 0; k < a.length; k += 4 * 97) { for (let c = 0; c < 3; c++) d += Math.abs(a[k + c] - b[k + c]); n += 3; } return d / n; };
    setGrade(cfg, id); const ident = await grab();
    setGrade(cfg, null); const plain = await grab();
    setGrade(cfg, sc.post.lut); const graded = await grab();
    id.dispose();
    return { identity: +diff(ident, plain).toFixed(2), graded: +diff(graded, plain).toFixed(2) };
  }).catch((e) => ({ error: e.message.split("\n")[0] }));
  console.log(`colour grade: identity table off by ${lut.identity}/255, broadcast grade ${lut.graded}/255 from the ungraded frame`);
  if (!(lut.identity < 2) || !(lut.graded > 2)) fail(`lookup table layout wrong: ${JSON.stringify(lut)}`);

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

  // flow and keeper (docs/flow3d.md). The ball is real size; every shot the keeper saves or
  // concedes in the clip window has a reaction that moves him (and does not with ?keeper off);
  // the players' paths have no 10 fps velocity steps, the body never snaps round in one frame,
  // and planted feet at a jog barely slide. Limits sit between origin/main and this branch on
  // this DEMO window (acceleration p95 24.2 -> 12.9 m/s2, jog slide median 0.111 -> 0.086 m).
  const kp = await page.evaluate(async () => {
    const s = window.sample3d, sc = s.scene, m = s.match, kr = sc.keeper ?? { reactions: [] }, [a, b] = sc.span;   // none: the check fails, not the page
    const ev = [...m.events].sort((x, y) => x.ts - y.ts), gk = new Set(m.meta.players.filter((p) => p.position === "GK").map((p) => p.player_id));
    const shots = ev.filter((e, k) => {
      if (!/^shot/.test(e.type_name) || e.ts < a || e.ts > b) return false;
      if (e.result_name === "success" && m.goals.some((g) => Math.abs(g.ts - e.ts) < 0.5)) return true;
      const n = ev.slice(k + 1).find((x) => x.period === e.period);
      return n && gk.has(n.player_id) && n.team_id !== e.team_id && n.ts - e.ts <= 3 && n.type_name !== "goalkick";
    }).map((e) => e.event_id);
    const moved = async (on) => {
      kr.enabled = on;
      const out = [];
      for (const r of kr.reactions.filter((x) => shots.includes(x.shot))) {
        const c = r.tc - s.tl.from;
        await window.__setTime(c - 0.04); await window.__setTime(c);
        const p = sc.players.find((q) => q.i === r.i), at = m.at(r.i, r.tc);
        out.push(+Math.hypot(p.holder.position.x + 52.5 - at[0], p.holder.position.z + 34 - at[1], p.holder.position.y).toFixed(2));
      }
      kr.enabled = true;
      return out;
    };
    return { ballR: +(sc.ball.getBoundingInfo().boundingBox.extendSize.x * sc.ball.scaling.x).toFixed(3), shots, planned: kr.reactions.map((r) => r.shot),
      kinds: kr.reactions.map((r) => `${r.kind}${r.real ? "" : " (procedural)"}`), on: await moved(true), off: await moved(false) };
  });
  console.log(`ball radius ${kp.ballR} m; keeper: shots on target ${kp.shots}, reactions ${kp.planned} (${kp.kinds}), body off the tracking at contact ${kp.on} m (${kp.off} m without)`);
  if (Math.abs(kp.ballR - 0.11) > 0.005) fail(`ball radius ${kp.ballR} m, a size 5 ball is 0.11 m`);
  if (!kp.shots.length || kp.shots.some((id) => !kp.planned.includes(id))) fail(`a shot on target without a keeper reaction: ${JSON.stringify(kp)}`);
  if (kp.on.some((d) => d < 0.3) || kp.off.some((d) => d >= 0.3)) fail(`the keeper does not leave his spot for the shot: ${JSON.stringify(kp)}`);
  // the DEMO save (shot at 240 s, the keeper on the ball next): hands on the ball at contact
  const sv = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
  sv.setDefaultTimeout(120000);
  sv.on("pageerror", (e) => fail(`page error (save): ${e.message}`));
  await sv.goto(new URL("sample3d.html?match=DEMO&capture=1&from=232", base).href);
  await sv.waitForFunction(() => window.sample3d?.ready, null, { timeout: 180000 });
  const save = await sv.evaluate(async () => {
    const s = window.sample3d, kr = s.scene.keeper, r = kr?.reactions.find((x) => !x.goal);
    if (!r) return null;
    const at = async (on) => {
      kr.enabled = on;
      await window.__setTime(r.tc - s.tl.from - 0.04); await window.__setTime(r.tc - s.tl.from);
      const h = kr.hands(r.i);
      return +Math.hypot(h[0] - r.ball[0], h[1] - r.ball[1], h[2] - r.ball[2]).toFixed(2);
    };
    return { kind: r.kind, clip: r.clip, real: !!r.real, on: await at(true), off: await at(false) };
  });
  await sv.close();
  console.log(`DEMO save: ${JSON.stringify(save)} (hands to ball, m)`);
  if (!save || !(save.on < 0.5) || save.off < 0.5) fail(`hands not on the ball at the save: ${JSON.stringify(save)}`);

  const flow = await page.evaluate(measure, 8);
  const jogSlide = flow.footSlide.jog.p50;
  console.log(`flow: acceleration p95 ${flow.accelShown.p95} m/s2, ${flow.yawSnaps} facing snaps over 15 deg in a frame, planted foot at a jog slides ${jogSlide} m per step (median of ${flow.footSlide.jog.n})`);
  if (!(flow.accelShown.p95 < 16)) fail(`players' speed still steps every sample: acceleration p95 ${flow.accelShown.p95} m/s2`);
  if (flow.yawSnaps > 0) fail(`facing snaps: ${JSON.stringify(flow.snapList)}`);
  if (!(jogSlide < 0.1)) fail(`feet slide at a jog: ${JSON.stringify(flow.footSlide.jog)}`);

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

  // pitch and crowd (docs/scene3d-research.md, section F), measured on rendered frames with the
  // players and the ball hidden. view(c, cam, pts) renders clock c from cam {pos, target, fov} and
  // returns the mean luminance (0..255) of a 9x9 patch round each world point, and the share of
  // that patch that is sky (bright and clearly blue).
  const view = (c, cam, pts, ts) => page.evaluate(async ({ c, cam, pts, ts }) => {
    const s = window.sample3d, sc = s.scene, B = window.BABYLON;
    await window.__setTime(c - 0.04);
    await window.__setTime(c);
    if (ts !== undefined) sc.update({ ...s.tl.at(c), ts }, 0);
    for (const p of sc.players) p.holder.setEnabled(false);
    sc.ball.setEnabled(false);
    const cm = sc.cams.replay;
    cm.position.set(...cam.pos); cm.setTarget(new B.Vector3(...cam.target)); cm.fov = cam.fov ?? 0.8;
    sc.scene.activeCamera = cm;
    sc.render();
    const cv = sc.engine.getRenderingCanvas();
    const img = new Image();
    img.src = cv.toDataURL();
    await img.decode();
    const g = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height }).getContext("2d");
    g.drawImage(img, 0, 0);
    const vp = cm.viewport.toGlobal(img.width, img.height);
    const wvp = cm.getViewMatrix().multiply(cm.getProjectionMatrix());
    const sky = [];
    const lum = pts.map((p) => {
      const q = B.Vector3.Project(new B.Vector3(...p), B.Matrix.Identity(), wvp, vp);
      const d = g.getImageData(Math.round(q.x) - 4, Math.round(q.y) - 4, 9, 9).data;
      let sum = 0, blue = 0;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        sum += l;
        if (l > 110 && d[i + 2] > d[i] + 35) blue++;
      }
      sky.push(blue / (d.length / 4));
      return sum / (d.length / 4);
    });
    for (const p of sc.players) p.holder.setEnabled(true);
    sc.ball.setEnabled(true);
    return { lum, sky, frame: g.getImageData(0, 0, img.width, img.height).data.filter((_, i) => i % 64 === 0) };
  }, { c, cam, pts, ts });

  // 1. mowing stripes: stripes 8 and 9 (contract x 46.7..52.5 and 52.5..58.3) sampled at 8 points
  // each down y = 4..22. Relative contrast (L8 - L9) / (L8 + L9) from the TV side looking +Z (A),
  // from the far side looking -Z (B) and along the length looking +X (C). Grass patches add the
  // same contrast to every view, so the stripe part is (A - B) / 2 and their part (A + B) / 2.
  const sp = [];
  for (const x of [49.58, 55.42]) for (let y = 4; y <= 22; y += 18 / 7) sp.push([x - 52.5, 0, y - 34]);
  const contrast = (r) => { const h = r.lum.length / 2, a = r.lum.slice(0, h).reduce((x, y) => x + y) / h, b = r.lum.slice(h).reduce((x, y) => x + y) / h; return (a - b) / (a + b); };
  const cA = contrast(await view(4, { pos: [0, 12, -52], target: [0, 0, -21], fov: 0.7 }, sp));
  const cB = contrast(await view(4, { pos: [0, 12, 10], target: [0, 0, -21], fov: 0.7 }, sp));
  const cC = contrast(await view(4, { pos: [-40, 12, -21], target: [0, 0, -21], fov: 0.7 }, sp));
  const stripeAB = (cA - cB) / 2, patches = (cA + cB) / 2, stripeC = cC - patches;
  console.log(`stripes: contrast from the TV side ${cA.toFixed(3)}, from the far side ${cB.toFixed(3)}, along the length ${cC.toFixed(3)}; stripe part ${stripeAB.toFixed(3)} vs ${stripeC.toFixed(3)} along the length`);
  if (Math.sign(cA) === Math.sign(cB) || Math.abs(stripeAB) < 0.02) fail(`stripes do not swap between opposite views: ${cA}, ${cB}`);
  if (Math.abs(stripeC) > 0.12 * Math.abs(stripeAB)) fail(`stripes still show looking along their length: ${stripeC} vs ${stripeAB}`);

  // 3. one bowl: from the centre spot, the four corners just above the stands' back wall (27 m) show
  // roof, not sky (before, the near corners were open and the side stands ended in blank walls)
  const gaps = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pt = [sx * (52.5 + 9 + 11), 27.5, sz * (34 + 9 + 11)];
    const r = await view(4, { pos: [0, 5, 0], target: pt, fov: 0.8 }, [pt]);
    gaps.push(+r.sky[0].toFixed(2));
  }
  console.log(`stadium corners: sky share above the back wall ${gaps.join(", ")} (x-z-, x-z+, x+z-, x+z+)`);
  if (gaps.some((v) => v > 0.2)) fail(`sky shows through a corner of the stadium: ${gaps}`);

  // 2. the crowd behind the goal: the home end (x < 0) celebrates the DEMO home goal at 100 s
  // and is seated again 10.5 s later; the 3D spectators change clip and the frame changes
  const crowd = await page.evaluate(() => {
    const st = window.sample3d.scene.crowd, c3 = st.crowd3d, m = window.sample3d.match;
    const g = st.goals?.find((x) => x.side === "home");
    if (!c3 && st.cheer && g) {   // low profile: cards only, every card of the scoring team follows st.cheer
      const up = (ts, side) => { st.update(ts); return st.cheer.side === side && st.cheer.since < 10 ? 1 : 0; };
      return { cards: true, goal: g.ts, goals: st.goals.length, facts: m.goals.filter((f) => f.value > 0).length, n: st.cards,
        before: up(g.ts - 2, 1), during: up(g.ts + 4, 1), after: up(g.ts + 10.5, 1), awayEnd: up(g.ts + 4, -1) };
    }
    if (!c3) return null;
    const cheering = (ts, end) => {
      const ids = c3.people.map((p, i) => [p, i]).filter(([p]) => p.end === end);
      return ids.filter(([, i]) => !["sit", "sitClap", "stand"].includes(c3.clipAt(i, ts))).length / ids.length;
    };
    return { goal: g?.ts, goals: st.goals.length, facts: m.goals.filter((f) => f.value > 0).length, n: c3.people.length,
      before: g && cheering(g.ts - 2, "home"), during: g && cheering(g.ts + 4, "home"), after: g && cheering(g.ts + 10.5, "home"),
      awayEnd: g && cheering(g.ts + 4, "away") };
  });
  console.log(`crowd: ${JSON.stringify(crowd)}`);
  if (!crowd) fail("no crowd reacting to goals");
  else {
    if (crowd.goals !== crowd.facts) fail(`crowd goals ${crowd.goals} != score facts ${crowd.facts}`);
    if (!(crowd.before === 0 && crowd.during > 0.9 && crowd.after === 0)) fail(`home end does not rise and sit back: ${JSON.stringify(crowd)}`);
    if (!(crowd.awayEnd < 0.3)) fail(`away end celebrates the home goal: ${crowd.awayEnd}`);
    const endCam = { pos: [-45, 5, 0], target: [-65, 6, 0], fov: 0.6 };
    const f0 = (await view(4, endCam, [], crowd.goal - 2)).frame, f1 = (await view(4, endCam, [], crowd.goal + 4)).frame;
    let diff = 0;
    for (let i = 0; i < f0.length; i++) diff += Math.abs(f0[i] - f1[i]);
    diff /= f0.length;
    console.log(`crowd behind the goal: mean pixel change ${diff.toFixed(1)} from 2 s before to 4 s after the goal`);
    if (diff < 8) fail(`the celebrating end looks the same after the goal: ${diff}`);
  }

  // stills of the pitch and the crowd for docs/scene3d-research.md, section F
  const pcShot = async (name, cam, ts) => {
    await view(4, cam, [], ts);
    await page.evaluate(() => { for (const p of window.sample3d.scene.players) p.holder.setEnabled(true); window.sample3d.scene.render(); });
    await page.locator("#view3d").screenshot({ path: `${shots}/pitchcrowd3d-${look.debug.profile}-${name}.png` });
  };
  await page.evaluate((x) => window.__setTime(x), 4);
  await page.locator("#view3d").screenshot({ path: `${shots}/pitchcrowd3d-${look.debug.profile}-wide.png` });
  await pcShot("reverse", { pos: [0, 15, 42], target: [0, 0, -6], fov: 0.9 });
  await pcShot("goalmouth", { pos: [-41, 2.6, -7], target: [-51, 0, -1], fov: 0.7 });
  if (crowd) await pcShot("crowd-goal", { pos: [-45, 5, 0], target: [-65, 6, 0], fov: 0.6 }, crowd.goal + 4);
  console.log(`pitchcrowd3d-${look.debug.profile}-*.png saved`);

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
