// The stadium's big screens (web/js/scene3d/screen.js) and the kick-off and full-time moments
// (web/js/countdown.js) on the broadcast page.
// Big screens, on index.html?match=$MATCH&view=3d: the text is the match's score and minute after seeks and
// while playing, and the canvas is drawn again only when it changes; where each camera sees them (a sweep
// of the broadcast camera over the whole match, every replay angle on a goal replay), projected from the
// camera matrices; the cost of a frame with and without them (the same frame drawn alternately, each
// finished with a one-pixel readPixels) and the draw calls they add.
// Moments, on the 2D page (the clock logic does not depend on the view, and the 2D page ticks fast on a
// software renderer): Play at 0 counts 3, 2, 1 with the clock held, the clock starts on "Kick off",
// the strap goes; a second press stops the count, a seek cancels it, nothing at 16x or past kick-off;
// "Full time" before the final whistle; the strap hides under the replay badge (the same test as a graphic).
// Screenshots: out/shots/stadium-broadcast.png, stadium-replay-low.png, countdown-3d.png (1280 x 720),
// countdown-1280.png, countdown-390.png (390 x 844, in Spanish), countdown-fulltime.png.
//
//   WEBGL=2 MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh stadium.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const MATCH = process.env.MATCH ?? "M001";
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const check = (ok, msg) => (ok ? console.log(`ok   ${msg}`) : fail(msg));

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();

async function open(query, viewport = { width: 1280, height: 720 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);
  page.on("console", (m) => { if (m.type() === "error" && !/\/api\/|(voice|booth)\.json/.test(m.location()?.url ?? "")) fail(`console: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  await page.goto(new URL(`index.html?match=${MATCH}${query}`, base).href);
  await page.waitForFunction(() => window.studioDesk?.view3d, null, { timeout: 120000 });
  await page.waitForFunction(() => { const v = window.studioDesk.view3d; return v.mode === "2d" || v.scene || v.failed; }, null, { timeout: 300000 });
  await page.evaluate(() => { window.studioDesk.view3d.floor = 0; return document.fonts.ready; });
  if (/view=3d/.test(query)) await page.waitForFunction(() => { const v = window.studioDesk.view3d; return v.failed || v.ready; }, null, { timeout: 300000 });
  return page;
}
// For the stills: the count held e seconds after the press (frame() is given that time) until released.
const hold = (page, e) => page.evaluate((e) => { const c = window.studioDesk.countdown; c._frame ??= c.frame; c.frame = (now, ...a) => c._frame(c.t0 === null ? now : c.t0 + e * 1000, ...a); }, e);
const release = (page) => page.evaluate(() => { const c = window.studioDesk.countdown; if (c._frame) c.frame = c._frame; });
const frames = (page, n = 2) => page.evaluate((n) => new Promise((done) => { let k = 0; const f = () => (++k >= n ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

// --- the big screens
{
  let page = await open("&view=3d");
  const has3d = await page.evaluate(() => !!window.studioDesk.view3d.scene);
  check(has3d, "the 3D scene loads");
  if (has3d) {
    // the text after seeks, and one draw per change
    for (const ts of [0, 1500, 2793, 4000, 5620]) {
      await page.evaluate((ts) => window.studioDesk.seek(ts), ts);
      await frames(page);
      const r = await page.evaluate(() => {
        const sd = window.studioDesk, s = sd.view3d.scene, ts = s.ts;
        const [h, a] = sd.match.score(ts), want = `${sd.match.home.short_name}|${h}|${a}|${sd.match.away.short_name}|${sd.match.clock(ts).label}'`;
        return { ts, key: s.screen.key, want };
      });
      check(r.key === r.want, `screen at ${r.ts.toFixed(1)} s says ${r.key} (match data: ${r.want})`);
    }
    const play = await page.evaluate(async () => {
      const sd = window.studioDesk, s = sd.view3d.scene, render = s.render;
      s.render = () => {};   // not drawn: a software frame takes seconds, and the screen's text is set in update
      sd.seek(1190); await new Promise((r) => requestAnimationFrame(r));
      const d0 = s.screen.draws, t0 = s.ts;
      sd.state.speed = 4; sd.setPlaying(true);
      await new Promise((r) => { const f = () => (sd.state.ts >= 1390 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
      sd.setPlaying(false); sd.state.speed = 1;
      await new Promise((r) => requestAnimationFrame(r));
      s.render = render;
      const t1 = s.ts, minutes = Math.floor(t1 / 60) - Math.floor(t0 / 60);
      const goals = sd.match.goals.filter((g) => g.ts > t0 && g.ts <= t1).length;
      return { from: t0, to: t1, draws: s.screen.draws - d0, minutes, goals };
    });
    check(play.draws <= play.minutes + play.goals && (play.minutes === 0 || play.draws >= 1),
      `playing ${play.from.toFixed(0)} to ${play.to.toFixed(0)} s: ${play.draws} canvas draws for ${play.minutes} minute changes and ${play.goals} goals`);

    // where the cameras see the screens: the share of the frame each covers, from the camera matrices
    // (the scene is not drawn meanwhile, so the sweep is quick on a software renderer)
    await page.evaluate(() => {
      const s = window.studioDesk.view3d.scene;
      s._render = s.render; s.render = () => {};
      window.screenSeen = () => {
        const B = window.BABYLON, cam = s.scene.activeCamera, e = s.engine;
        const w = e.getRenderWidth(), h = e.getRenderHeight();
        const m = cam.getViewMatrix(true).multiply(cam.getProjectionMatrix(true));
        const vp = cam.viewport.toGlobal(w, h), id = B.Matrix.Identity();
        return [-1, 1].map((sx) => {
          // the four corners of the face, turned to camera 1 as screen.js turns it (SIZE, BOTTOM, SPOT there)
          const x = sx * 58.4, z = 40.6, tv = s.tv.position, yaw = Math.atan2(-(tv.x - x), -(tv.z - z));
          const pts = [[-3.2, 1], [3.2, 1], [-3.2, 4.2], [3.2, 4.2]].map(([d, y]) => new B.Vector3(x + Math.cos(yaw) * d, y, z - Math.sin(yaw) * d));
          if (pts.some((p) => B.Vector3.TransformCoordinates(p, cam.getViewMatrix()).z <= 0)) return 0;
          const q = pts.map((p) => B.Vector3.Project(p, id, m, vp));
          const xs = q.map((p) => p.x), ys = q.map((p) => p.y), full = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
          const x0 = Math.max(0, Math.min(...xs)), x1 = Math.min(w, Math.max(...xs)), y0 = Math.max(0, Math.min(...ys)), y1 = Math.min(h, Math.max(...ys));
          const inside = x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0;
          // how much of the face nothing hides (a player close to the lens): rays from the camera to a 3 x 3 grid on it
          let clear = 0;
          if (inside / full >= 0.95) for (const u of [-2.4, 0, 2.4]) for (const y of [1.5, 2.6, 3.7]) {
            const p = new B.Vector3(x + Math.cos(yaw) * u, y, z - Math.sin(yaw) * u), dir = p.subtract(cam.globalPosition), len = dir.length();
            const hit = s.scene.pickWithRay(new B.Ray(cam.globalPosition, dir.normalize(), len + 1));
            if (hit?.hit && s.screen.meshes.includes(hit.pickedMesh)) clear += 1 / 9;
          }
          // players do not pick (their bounding boxes are the bind pose): a 0.8 x 2 m box at each one, projected
          const hidden = s.players.some(({ holder }) => {
            const o = holder.getAbsolutePosition();
            if (B.Vector3.TransformCoordinates(o, cam.getViewMatrix()).z <= 0) return false;
            const b = [[-0.4, 0], [0.4, 0], [-0.4, 2], [0.4, 2]].map(([d, y]) => B.Vector3.Project(new B.Vector3(o.x + d, y, o.z), id, m, vp));
            return Math.min(...b.map((v) => v.x)) < x1 && Math.max(...b.map((v) => v.x)) > x0 && Math.min(...b.map((v) => v.y)) < y1 && Math.max(...b.map((v) => v.y)) > y0;
          });
          if (hidden) clear = 0;
          // and whether a graphic on air or the replay badge covers it, in page pixels
          const c = e.getRenderingCanvas().getBoundingClientRect(), fx = c.width / w, fy = c.height / h;
          const r = [c.left + x0 * fx, c.top + y0 * fy, c.left + x1 * fx, c.top + y1 * fy];
          const over = [...window.studioDesk.host.live.values()].map((i) => i.el.shadowRoot?.querySelector(".stage")?.firstElementChild)
            .concat(document.querySelector("#replay-badge.on")).filter((b) => b?.offsetWidth).map((b) => b.getBoundingClientRect())
            .some((b) => b.left < r[2] && b.right > r[0] && b.top < r[3] && b.bottom > r[1]);
          return { area: inside / (w * h), whole: inside / full, top: y0 / h, left: x0 / w, clear, covered: over };
        });
      };
    });
    const sweep = await page.evaluate(async () => {
      const sd = window.studioDesk, s = sd.view3d.scene, out = [];
      for (let ts = 30; ts < sd.match.duration - 30; ts += 120) {
        sd.seek(ts - 2); sd.setPlaying(true);
        await new Promise((r) => { const f = () => (sd.state.ts >= ts ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });   // two seconds of play: the camera spring settles
        sd.setPlaying(false);
        await new Promise((r) => requestAnimationFrame(r));
        out.push({ ts: s.ts, mode: s.cams.mode, seen: window.screenSeen() });
      }
      return out;
    });
    const wide = sweep.filter((f) => f.mode === "broadcast");
    const count = (i, min) => wide.filter((f) => f.seen[i]?.area > 0 && f.seen[i].whole >= min).length;
    const whole = (f) => Math.max(...f.seen.map((v) => (v && v.whole >= 0.95 ? v.area : 0)));
    // the still: the largest whole screen that nothing hides, else the largest whole one
    const unhidden = (f) => Math.max(...f.seen.map((v) => (v && v.whole >= 0.95 && v.clear > 0.99 && !v.covered ? v.area : 0)));
    const best = wide.reduce((b, f) => (whole(f) > whole(b) ? f : b), wide[0]);
    const still = wide.some((f) => unhidden(f) > 0) ? wide.reduce((b, f) => (unhidden(f) > unhidden(b) ? f : b), wide[0]) : best;
    console.log(`broadcast sweep: ${wide.length} frames of the wide shot; the left screen in ${count(0, 0)} (whole in ${count(0, 0.95)}), the right in ${count(1, 0)} (whole in ${count(1, 0.95)}); largest whole ${(whole(best) * 100).toFixed(2)}% of the frame at ${best.ts.toFixed(0)} s`);
    for (const f of wide) for (const [i, v] of f.seen.entries()) if (v?.area > 0) console.log(`  ${f.ts.toFixed(0)} s ${i ? "right" : "left"}: ${(v.area * 100).toFixed(2)}% of the frame, ${(v.whole * 100).toFixed(0)}% of it in frame, top at ${(v.top * 100).toFixed(0)}%, left at ${(v.left * 100).toFixed(0)}%${v.whole >= 0.95 ? `, ${v.clear > 0.99 ? "nothing in front" : "a player or the ground in front"}${v.covered ? ", under a graphic" : ""}` : ""}`);
    const left = count(0, 0), right = count(1, 0);
    check(left + right > 0, "the broadcast camera shows a big screen at times");

    // the replay angles on the first goal replay
    const reps = await page.evaluate(() => window.studioDesk.view3d.reps.map((r) => ({ from: r.from, to: r.to, end: r.end })));
    if (!reps.length) fail("no goal replay in this match");
    const rep = reps[0];
    const angles = await page.evaluate(async (rep) => {
      const sd = window.studioDesk, s = sd.view3d.scene, out = {};
      for (const a of ["goal", "low", "reverse", "high"]) {
        s.cams.replayAngle = a;
        let most = [0, 0], at = [0, 0], free = [0, 0], freeAt = [null, null];
        for (let k = 0.5; k < rep.to - rep.from; k += 1) {
          sd.seek(rep.from + k);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const all = window.screenSeen(), seen = all.map((v) => (v && v.whole >= 0.95 ? v.area : 0));
          seen.forEach((v, i) => { if (v > most[i]) { most[i] = v; at[i] = k; } });
          seen.forEach((v, i) => { if (v > free[i] && all[i].clear > 0.99 && !all[i].covered) { free[i] = v; freeAt[i] = k; } });
          out[a] = { mode: s.cams.mode, most, at, free, freeAt };
        }
      }
      s.cams.replayAngle = "goal";
      return out;
    }, rep);
    for (const [a, r] of Object.entries(angles)) console.log(`replay ${a} (${r.mode}): whole in frame, the left screen up to ${(r.most[0] * 100).toFixed(2)}% of it, the right up to ${(r.most[1] * 100).toFixed(2)}%`);
    const endSide = rep.end < 0 ? 0 : 1;
    check(angles.low.most[endSide] > 0, `the low replay angle shows the screen at its end (goal end ${rep.end})`);

    // the screenshots, drawn for real on a fresh page (it also keeps one 3D page open at a time): after minutes of undrawn play the players' skinning
    // is stale on the first drawn frames (stretched limbs), which no viewer sees since the page always draws
    await page.context().close();
    page = await open("&view=3d");
    await page.evaluate(async (ts) => {
      const sd = window.studioDesk;
      sd.seek(ts - 2); sd.state.speed = 4; sd.setPlaying(true);   // the same two seconds of play as the sweep, drawn
      await new Promise((r) => { const f = () => (sd.state.ts >= ts ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
      sd.setPlaying(false); sd.state.speed = 1;
      sd.view3d.ready = false;   // paused at an unchanged time the page skips the draw: draw this frame
    }, still.ts);
    await frames(page);
    await page.screenshot({ path: path.join(shots, "stadium-broadcast.png") });
    console.log(`stills: broadcast at ${still.ts.toFixed(0)} s (${unhidden(still) > 0 ? "nothing in front of the screen" : "the largest, partly hidden"}), low replay at ${(angles.low.freeAt[endSide] ?? angles.low.at[endSide]).toFixed(1)} s into the replay (${angles.low.freeAt[endSide] !== null ? "nothing in front" : "the largest, partly hidden"})`);
    await page.evaluate(() => { window.studioDesk.view3d.scene.cams.replayAngle = "low"; });
    // the low angle's frame where its end's screen is largest and whole
    await page.evaluate(([rep, k]) => window.studioDesk.seek(rep.from + k), [rep, angles.low.freeAt[endSide] ?? angles.low.at[endSide]]);
    await frames(page, 3);
    await page.screenshot({ path: path.join(shots, "stadium-replay-low.png") });

    // the cost: the same frame drawn with the screens and without, alternately, each finished on the GPU
    await page.evaluate((ts) => { const sd = window.studioDesk; sd.view3d.scene.cams.replayAngle = "goal"; sd.seek(ts); }, best.ts);
    await frames(page);
    const cost = await page.evaluate(() => {
      const B = window.BABYLON, s = window.studioDesk.view3d.scene, gl = s.engine._gl, px = new Uint8Array(4);
      const inst = new B.SceneInstrumentation(s.scene); inst.captureFrameTime = true;
      const draw = () => { const t0 = performance.now(); s.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return performance.now() - t0; };
      const t = { on: [], off: [] }, calls = {};
      draw();   // warm
      for (let k = 0; k < 6; k++) for (const on of k % 2 ? [false, true] : [true, false]) {
        s.screen.meshes.forEach((m) => m.setEnabled(on));
        t[on ? "on" : "off"].push(draw());
        calls[on ? "on" : "off"] = inst.drawCallsCounter.current;
      }
      s.screen.meshes.forEach((m) => m.setEnabled(true));
      // one canvas draw and upload, the work of a minute change
      const t0 = performance.now(), n = 5;
      for (let k = 0; k < n; k++) { s.screen.key = null; s.screen.update(s.ts); }
      const redraw = (performance.now() - t0) / n;
      inst.dispose();
      const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
      return { on: med(t.on), off: med(t.off), calls, redraw, profile: s.debug.profile, size: `${s.engine.getRenderWidth()}x${s.engine.getRenderHeight()}`, webgl: s.engine.webGLVersion };
    });
    console.log(`frame cost (profile ${cost.profile}, WebGL ${cost.webgl}, ${cost.size}): median ${cost.on.toFixed(1)} ms with the screens, ${cost.off.toFixed(1)} ms without (6 frames each, alternated); draw calls ${cost.calls.on} with, ${cost.calls.off} without; one canvas redraw and upload ${cost.redraw.toFixed(2)} ms`);
    check(cost.calls.on - cost.calls.off <= 2, `the screens add ${cost.calls.on - cost.calls.off} draw calls`);

    // the count on the 3D page, for the eye: held at "3" (a software frame takes seconds, the count three)
    await page.evaluate(() => window.studioDesk.seek(0));
    await frames(page);
    await hold(page, 0.5);   // before the click: a stalled frame after it could end the count first
    await page.click("#play");
    await frames(page);
    await page.screenshot({ path: path.join(shots, "countdown-3d.png") });
    await release(page);
    await page.evaluate(() => window.studioDesk.setPlaying(false));
  }
  await page.context().close();
}

// --- the kick-off count and the full-time strap
{
  const page = await open("&view=2d");
  const strap = () => page.evaluate(() => { const m = document.querySelector("#moment"), sd = window.studioDesk;
    return { text: m.textContent, on: m.classList.contains("on"), covered: m.classList.contains("covered"), playing: sd.state.playing, ts: sd.state.ts,
      counting: sd.countdown.counting, button: document.querySelector("#play").classList.contains("playing"), role: m.getAttribute("role") }; });
  const waitText = (re, ms = 20000) => page.waitForFunction((re) => new RegExp(re).test(document.querySelector("#moment").textContent), re, { timeout: ms, polling: 100 });

  // every change of the strap with the clock at that moment (a loaded machine ticks the page every second or two,
  // so a label may be skipped; the order and the held clock are what must hold)
  await page.evaluate(() => {
    const sd = window.studioDesk, m = document.querySelector("#moment");
    window.momentLog = [];
    new MutationObserver(() => { const l = window.momentLog, t = m.textContent; if (l.at(-1)?.text !== t) l.push({ text: t, playing: sd.state.playing, ts: sd.state.ts }); })
      .observe(m, { subtree: true, childList: true, characterData: true });
    sd.seek(0);
  });
  await page.click("#play");
  let s = await strap();
  check(s.counting && !s.playing && s.ts === 0 && s.button && s.role === "status", `Play at 0: counting, clock held at ${s.ts}, the button shows Pause, role ${s.role}`);
  await page.waitForFunction(() => window.studioDesk.state.playing && !document.querySelector("#moment").classList.contains("on"), null, { timeout: 60000, polling: 100 });
  const log = await page.evaluate(() => window.momentLog);
  console.log(`the strap: ${log.map((e) => `"${e.text}" (${e.playing ? "playing" : "held"} at ${e.ts.toFixed(2)})`).join(", ")}`);
  const digits = log.filter((e) => /^\d$/.test(e.text)), kick = log.find((e) => e.text === "Kick off");
  check(digits.length > 0 && digits.every((e, i) => !e.playing && e.ts === 0 && (i === 0 || Number(e.text) < Number(digits[i - 1].text))), "3, 2, 1 in order, the clock held at 0 throughout");
  check(!kick || (kick.playing && kick.ts < 0.5 && log.indexOf(kick) > log.indexOf(digits.at(-1))), kick ? `"Kick off" after the count, the clock running from ${kick.ts.toFixed(2)} s` : "Kick off skipped by a long frame gap; the clock runs");
  s = await strap();
  check(s.playing && !s.on && s.ts < 10, `the strap goes after Kick off, the match at ${s.ts.toFixed(2)} s`);
  await page.evaluate(() => { window.studioDesk.setPlaying(false); window.studioDesk.seek(0); });
  await hold(page, 0.5);
  await page.click("#play");
  await frames(page);
  await page.screenshot({ path: path.join(shots, "countdown-1280.png") });
  await release(page);

  // a second press stops the count; a seek cancels it
  await page.evaluate(() => { window.studioDesk.setPlaying(false); window.studioDesk.seek(0); });
  await page.click("#play");
  await page.click("#play"); await frames(page);
  s = await strap();
  check(!s.on && !s.playing && !s.button && s.ts === 0, "a press during the count stops it");
  await page.click("#play");
  await page.evaluate(() => window.studioDesk.seek(0.2)); await frames(page);
  s = await strap();
  check(!s.on && !s.playing && !s.button, "a seek during the count cancels it");
  await page.waitForTimeout(3500);
  s = await strap();
  check(!s.playing && !s.on, "and the clock does not start later");

  // past kick-off and at 16x: play at once
  await page.evaluate(() => window.studioDesk.seek(10));
  await page.click("#play");
  s = await strap();
  check(s.playing && !s.counting, "Play past kick-off plays at once");
  await page.evaluate(() => { const sd = window.studioDesk; sd.setPlaying(false); sd.seek(0); sd.state.speed = 16; });
  await page.click("#play");
  s = await strap();
  check(s.playing && !s.counting, "Play at 16x plays at once, no count");
  await page.evaluate(() => { const sd = window.studioDesk; sd.setPlaying(false); sd.state.speed = 4; sd.seek(0); });
  await hold(page, 0.5);
  await page.click("#play");
  s = await strap();
  check(s.counting && !s.playing, "at 4x the count shows");

  // under the replay badge (or a graphic on air) at the top centre: hidden, still read out
  await page.evaluate(() => { const b = document.querySelector("#replay-badge"); b.textContent = "Replay"; b.classList.add("on"); });
  await frames(page);
  s = await strap();
  check(s.covered && s.on, "the strap hides under the replay badge");
  await page.evaluate(() => { const b = document.querySelector("#replay-badge"); b.textContent = ""; b.classList.remove("on"); });
  await frames(page);
  s = await strap();
  check(!s.covered, "and shows again when it goes");
  await release(page);
  await page.evaluate(() => { const sd = window.studioDesk; sd.setPlaying(false); sd.state.speed = 1; });

  // full time
  const d = await page.evaluate(() => window.studioDesk.match.duration);
  await page.evaluate((d) => { const sd = window.studioDesk; sd.seek(d - 3); sd.setPlaying(true); }, d);
  await waitText("^Full time$");
  s = await strap();
  check(s.ts >= d - 2.1, `"Full time" from ${s.ts.toFixed(1)} s (the whistle at ${d.toFixed(1)} s)`);
  await page.screenshot({ path: path.join(shots, "countdown-fulltime.png") });
  await page.context().close();
}

// --- the phone, in Spanish
{
  const page = await open("&view=2d&lang=es", { width: 390, height: 844 });
  await page.evaluate(() => window.studioDesk.seek(0));
  await hold(page, 3.5);   // "Kick off", held for the still
  await page.click("#play");
  await page.waitForFunction(() => document.querySelector("#moment").textContent === "Saque inicial", null, { timeout: 20000, polling: 100 });
  const box = await page.evaluate(() => { const r = document.querySelector("#moment").getBoundingClientRect(), f = document.querySelector("#frame").getBoundingClientRect();
    return { inside: r.left >= f.left && r.right <= f.right && r.top >= f.top, h: r.height, w: r.width }; });
  check(box.inside && box.h >= 20, `390 x 844: the strap inside the picture, ${box.w.toFixed(0)} x ${box.h.toFixed(0)} px`);
  await page.screenshot({ path: path.join(shots, "countdown-390.png") });
  await page.context().close();
}

await browser.close();
console.log(failures.length ? `${failures.length} failures` : "all stadium checks passed");
process.exit(failures.length ? 1 : 0);
