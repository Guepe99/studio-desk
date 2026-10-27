// The 2D, 3D and minimap (split: 3D large, the 2D pitch in the inset) views of the broadcast page
// (web/js/view3d.js) on a whole match. For each
// view it opens index.html?match=$MATCH&view=<view> and seeks to three moments (a nameplate on air,
// a graphic in the second half, a goal replay), and checks that the 3D players stand where the
// tracking says (the rigs may move a body by a step: the ball rig's reach, a keeper's dive, a
// celebration kept apart), that the 3D ball is the tracking ball within the ball rig's 1.5 m, that
// the graphics on air are the ones the 2D page shows, and that a nameplate sits on its 3D player.
// On the minimap page: the inset hidden while the 3D loads, a click, Enter or Space on it swaps the
// pictures in the same box, its name says what a click does (in each language), the swap icon only on
// hover and focus, the 2D inset see-through (no box fill, the grass at 60 to 75% alpha read from the
// canvas, opaque lines, discs and ball, keylines at 3:1 on a white and a black frame; the 3D inset and the
// large 2D pitch opaque), and the frame rate with the 3D large and with the 3D in the inset against the 3D
// alone (the 3D in the inset draws fewer pixels). Then on the 3D page: the frame rate while playing, a
// seek sweep over the whole match twice (the heap and the scene must not grow), under the frame-rate
// floor the 3D kept with a suggestion of the 2D pitch (never a switch by itself), and the one
// frame-rate beacon to api/perf; on a page without WebGL: the fall back at load, the 2D default and no
// inset. Screenshots of the three views go to out/shots/view3d-{2d,3d,split}.png, view3d-radar-swapped.png
// and view3d-replay.png.
//
//   [WEBGL=2] MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh view3d.mjs
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
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();

async function open(view, { noWebGL = false, quiet = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);   // software WebGL loads and draws slowly
  const tag = `${view ?? "default"}${noWebGL ? " without WebGL" : ""}`;
  // the desk's api/ calls and voice.json 404 on static hosting; without WebGL Babylon says so
  page.on("console", (m) => {
    if (m.type() === "error" && !quiet && !/\/api\/|(voice|booth|season)\.json/.test(m.location()?.url ?? "")) fail(`${tag} console: ${m.text()}`);
  });
  // after the test loses the WebGL context on purpose, Babylon work already under way fails to make textures
  page.on("pageerror", (e) => { if (page.lostOnPurpose && /Unable to create texture/.test(e.message)) console.log(`after the lost context: ${e.stack?.split("\n").slice(0, 4).join(" | ")}`); else fail(`${tag} page error: ${e.message}`); });
  if (noWebGL) await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return /webgl/i.test(kind) ? null : get.call(this, kind, ...rest); };
  });
  await page.goto(new URL(`index.html?match=${MATCH}${view ? `&view=${view}` : ""}`, base).href);
  await page.waitForFunction(() => window.studioDesk?.view3d, null, { timeout: 120000 });
  // while the scene loads the 2D pitch is alone, never beside an empty 3D inset
  page.early = await page.evaluate(() => ({ loading: !window.studioDesk.view3d.scene, radar: !document.querySelector("#radar").hidden }));
  await page.waitForFunction(() => { const v = window.studioDesk.view3d; return v.mode === "2d" || v.scene || v.failed; }, null, { timeout: 300000 });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

// The frame rate playing at 1x for 5 s from 1200 s (the floor is off while measuring), and the 3D picture's drawn size
const playFps = (page) => page.evaluate(async () => {
  const sd = window.studioDesk, e = sd.view3d.scene.engine;
  sd.view3d.floor = 0;
  sd.seek(1200); sd.setPlaying(true);
  await new Promise((r) => setTimeout(r, 2000));
  let n = 0, drawn = 0;
  const o = sd.view3d.scene.scene.onAfterRenderObservable.add(() => drawn++);
  const t0 = performance.now();
  await new Promise((done) => { const f = () => { n++; if (performance.now() - t0 < 5000) requestAnimationFrame(f); else done(); }; requestAnimationFrame(f); });
  sd.setPlaying(false);
  sd.view3d.scene.scene.onAfterRenderObservable.remove(o);
  const c = document.querySelector("#view3d");
  return { fps: n / ((performance.now() - t0) / 1000), drawn: drawn / n, px: e.getRenderWidth() * e.getRenderHeight(), css: c.clientWidth * c.clientHeight,
    profile: sd.view3d.scene.debug.profile, renderer: e.webGLVersion };
});
const fpsLine = (f) => `${f.fps.toFixed(1)} fps, ${(f.drawn * 100).toFixed(0)}% of them drawn, 3D drawn at ${(f.px / 1e3).toFixed(0)}k px (profile ${f.profile}, WebGL ${f.renderer})`;
const fps = {};

// Seek, draw, wait for the graphics, place them again (as sample3d.js __setTime does).
const seekTo = (page, ts) => page.evaluate(async (x) => {
  const sd = window.studioDesk, raf = () => new Promise((r) => requestAnimationFrame(r));
  sd.setPlaying(false);
  sd.seek(x);
  await raf(); await raf();
  await Promise.all([document.fonts.ready, ...[...sd.host.live.values()].map((i) => i.chain)]);
  await raf(); await raf();
  // paused, the 3D picture keeps drawing until every shader it needs has compiled
  for (const t0 = performance.now(); performance.now() - t0 < 60000 && sd.view3d.shown !== "2d" && !sd.view3d.ready;) await raf();
  return sd.view3d.shown === "2d" || sd.view3d.ready;
}, ts);

// What is on screen at the clock: graphics, and in 3D the players and the ball against the tracking.
const measure = (page) => page.evaluate(() => {
  // the Radar box against the graphics on the pitch: where it is, what it covers, and which of its
  // three spots along the foot of the frame (centre, right, left; view3d.css, app.js) are free
  const radarRoom = () => {
    const el = document.querySelector("#radar"), f = document.querySelector("#frame").getBoundingClientRect(), k = f.width / 1920;
    const boxes = [...window.studioDesk.host.live.values()].filter((i) => !i.positioned && i.node === i.el)
      .map((i) => i.el.shadowRoot.querySelector(".stage")?.firstElementChild?.getBoundingClientRect()).filter(Boolean);
    const hit = (a) => boxes.some((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom);
    const spots = [740, 1440, 40].map((x) => ({ left: f.left + x * k, right: f.left + (x + 440) * k, top: f.top + 769 * k, bottom: f.top + 1060 * k }));
    const r = el.getBoundingClientRect();
    return { yields: document.body.classList.contains("radar-yield"), hidden: el.hidden, covered: !el.hidden && hit(r), free: spots.filter((p) => !hit(p)).length, boxes: boxes.length };
  };
  const sd = window.studioDesk, v = sd.view3d, m = sd.match, frame = document.querySelector("#frame").getBoundingClientRect();
  const graphics = [...sd.host.live.values()].map((inst) => {
    const r = inst.el.getBoundingClientRect();
    const out = { cue: inst.cue.cue_id, graphic: inst.cue.graphic, inFrame: r.right > frame.left && r.left < frame.right && r.bottom > frame.top && r.top < frame.bottom };
    if (inst.cue.graphic === "nameplate") {
      const want = sd.host.opts.locate(inst.cue.payload.player_id, sd.state.ts);
      const t = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(inst.el.shadowRoot.querySelector(".anchor")?.style.transform ?? "");
      // a magnified nameplate (a small frame, ograf-host.js) draws its own stage scaled by its width over 1920
      const k = (inst.el.clientWidth || 1920) / 1920;
      out.nameplate = { visible: want.visible, offset: t ? Math.hypot(Number(t[1]) * k - want.x, Number(t[2]) * k - want.y) : Infinity };
    }
    return out;
  });
  const res = { ts: sd.state.ts, shown: v.shown, graphics, pitchHidden: document.querySelector("#pitch").hidden,
    pitchIn: document.querySelector("#pitch").parentElement.id, babylon: !!window.BABYLON,
    radar: radarRoom() };
  if (!v.scene || v.shown === "2d") return res;
  const s = v.scene, vts = v.last.ts;
  res.view = { ts: vts, replay: v.last.replay, badge: ((b) => b.classList.contains("on") && b.textContent === "Replay")(document.querySelector("#replay-badge")) };
  const want = new Set();
  for (let i = 1; i < m.n; i++) if (m.at(i, vts)) want.add(i);
  const on = s.players.filter((p) => p.holder.isEnabled());
  res.players = { want: want.size, shown: on.length, missing: [...want].filter((i) => !on.some((p) => p.i === i)).length,
    extra: on.filter((p) => !want.has(p.i)).length,
    // a team-mate running over to a scorer (awareness.js JOIN) leaves his track on purpose: measured against that run
    off: on.filter((p) => want.has(p.i)).map((p) => { const t = m.at(p.i, vts), j = s.awareness?.aw?._join(p.i, vts) ?? { dx: 0, dy: 0 };
      return Math.hypot(p.holder.position.x + 52.5 - t[0] - j.dx, p.holder.position.z + 34 - t[1] - j.dy); }) };
  const b = m.at(0, vts), bp = s.ball.position;
  res.ball = s.rig.plan._net(vts) || !b ? null : Math.hypot(bp.x + 52.5 - b[0], bp.z + 34 - b[1]);
  return res;
});

try {
  // ---- pure parts: the default view, the goal replays and the 3D clock
  const page2d = await open("2d");
  const pure = await page2d.evaluate(async () => {
    const { defaultView, replays, viewAt } = await import("./js/view3d.js");
    const m = window.studioDesk.match, reps = replays(m);
    return {
      defaults: [{ webgl2: true, phone: false, software: false }, { webgl2: true, phone: true, software: false },
        { webgl2: false, phone: false, software: false }, { webgl2: true, phone: false, software: true }].map(defaultView),
      reps, goals: m.goals.map((g) => g.ts),
      at: reps.map((r) => [viewAt(reps, r.from - 0.01, 1), viewAt(reps, r.from + 1, 4), viewAt(reps, r.from + 1, 16), viewAt(reps, r.to, 1)]),
    };
  });
  console.log(`default views ${pure.defaults}; ${pure.reps.length} goal replays for ${pure.goals.length} goals`);
  if (pure.defaults.join() !== "split,2d,2d,2d") fail(`default view rule: ${pure.defaults}`);
  pure.at.forEach(([before, in1, in16, after], k) => {
    const r = pure.reps[k];
    if (before.replay || !in1.replay || in16.replay || after.replay || Math.abs(in1.ts - (r.src + 1)) > 1e-9) fail(`replay clock ${k}: ${JSON.stringify([before, in1, in16, after])}`);
  });

  // three moments: a nameplate on air, a graphic of the second half, a goal replay
  const pick = await page2d.evaluate(() => {
    const sd = window.studioDesk, sheet = sd.desk.sheet(sd.match.cues, sd.state.audience, sd.state.lang), P1 = sd.match.meta.period1_s;
    const np = sheet.find((c) => c.graphic === "nameplate" && c.ts > 60), g2 = sheet.find((c) => c.graphic !== "nameplate" && c.ts > P1 + 600);
    return [np.ts + 1.5, g2.ts + 2];
  });
  const moments = [["nameplate", pick[0]], ["second half", pick[1]]];
  if (pure.reps.length) moments.push(["replay", pure.reps[0].from + 3]);
  else fail("no goal replay fits this match");

  const seen = {};
  for (const view of ["2d", "split", "3d"]) {   // split before 3d: the 3D page compares their frame rates
    const page = view === "2d" ? page2d : await open(view);
    if (view === "split" && (!page.early.loading || page.early.radar)) fail(`split while the 3D loads: ${JSON.stringify(page.early)}, wanted the inset hidden`);
    const t0 = Date.now();
    for (const [name, ts] of moments) {
      if (!(await seekTo(page, ts))) fail(`${view} at ${name}: the paused 3D picture never finished drawing`);
      if (view === "split") await page.waitForTimeout(500);   // the radar box slides to its spot
      const r = await measure(page);
      seen[`${view} ${name}`] = r;
      const tag = `${view} at ${name} (${ts.toFixed(1)} s)`;
      if (r.shown !== view) fail(`${tag}: shows ${r.shown}`);
      if (view === "2d" && r.babylon) fail("the 2D view loaded Babylon");
      if (view === "3d" && !r.pitchHidden) fail(`${tag}: 2D pitch still drawn over the 3D frame`);
      if (view === "split" && (r.pitchIn !== "radar" || r.pitchHidden || r.radar.hidden)) fail(`${tag}: 2D pitch not in the radar box`);
      // N10: the radar stays in view under a graphic's free spot; it steps aside only when all three are covered
      if (view === "split" && r.radar.yields && r.radar.free) fail(`${tag}: the radar steps aside with ${r.radar.free} free spot(s) for it`);
      if (view === "split" && !r.radar.yields && r.radar.covered) fail(`${tag}: the radar sits under a graphic`);
      if (view === "split") console.log(`${tag}: radar ${r.radar.yields ? "aside" : "shown"}, ${r.radar.boxes} graphic(s) on the pitch, ${r.radar.free} free spot(s)`);
      if (!r.graphics.length && name !== "replay") fail(`${tag}: no graphic on air`);
      if (r.graphics.some((g) => !g.inFrame)) fail(`${tag}: a graphic outside the frame: ${JSON.stringify(r.graphics)}`);
      for (const g of r.graphics) if (g.nameplate && g.nameplate.visible && !(g.nameplate.offset < 2)) fail(`${tag}: nameplate ${g.nameplate.offset.toFixed(1)} px off its player`);
      if (view !== "2d") {
        const two = seen[`2d ${name}`].graphics.map((g) => g.cue).sort().join();
        if (r.graphics.map((g) => g.cue).sort().join() !== two) fail(`${tag}: graphics ${r.graphics.map((g) => g.cue)} but the 2D page shows ${two}`);
        const p = r.players, worst = Math.max(...p.off), mid = med(p.off);
        console.log(`${tag}: view ts ${r.view.ts.toFixed(2)}${r.view.replay ? " (replay)" : ""}, ${p.shown}/${p.want} players, median ${mid.toFixed(3)} m and worst ${worst.toFixed(2)} m off the tracking, ball ${r.ball === null ? "in the net" : `${r.ball.toFixed(2)} m`} off, graphics ${r.graphics.map((g) => g.graphic)}`);
        if (p.missing || p.extra || p.want < 20) fail(`${tag}: players ${JSON.stringify({ ...p, off: undefined })}`);
        if (!(mid < 0.1 && worst < 2.5)) fail(`${tag}: players off the tracking, median ${mid.toFixed(3)} m, worst ${worst.toFixed(2)} m`);
        if (r.ball !== null && !(r.ball < 1.5)) fail(`${tag}: ball ${r.ball.toFixed(2)} m off the tracking`);
        if ((name === "replay") !== r.view.replay || r.view.replay !== r.view.badge) fail(`${tag}: replay ${r.view.replay}, badge ${r.view.badge}`);
        if (name !== "replay" && Math.abs(r.view.ts - ts) > 1e-6) fail(`${tag}: 3D at ${r.view.ts}, clock at ${ts}`);
      } else console.log(`${tag}: graphics ${r.graphics.map((g) => g.graphic)}`);
      if (name === "nameplate") await page.screenshot({ path: `${shots}/view3d-${view}.png` });
      if (name === "replay" && view === "3d") await page.screenshot({ path: `${shots}/view3d-replay.png` });
    }
    console.log(`${view}: three moments in ${((Date.now() - t0) / 1000).toFixed(0)} s, screenshot out/shots/view3d-${view}.png`);

    if (view === "split") {
      // a click on the minimap swaps the pictures in the same box: the 2D pitch fills the frame, the 3D
      // goes in the box, and the graphics follow the 2D pitch; Enter and Space swap them back and again
      const box = () => page.evaluate(() => {
        const r = document.querySelector("#radar").getBoundingClientRect(), v = window.studioDesk.view3d;
        return { main: v.main, pitchIn: document.querySelector("#pitch").parentElement.id, canvasIn: document.querySelector("#view3d").parentElement.id,
          label: document.querySelector("#radar").getAttribute("aria-label"), box: [r.left, r.top, r.width, r.height].map(Math.round).join(),
          icon: getComputedStyle(document.querySelector("#radar .swap")).display !== "none" };
      });
      // the 2D minimap is see-through like a game's radar: the box has no fill, the grass is drawn at
      // pitch.js SEE_THROUGH, lines, discs and ball are opaque, and each disc has a dark keyline inside a
      // white one, which stand out (3:1) on the grass over a white and over a black 3D frame
      const see = () => page.evaluate(() => {
        const cv = document.querySelector("#pitch"), g = cv.getContext("2d"), sd = window.studioDesk, k = sd.pitch.k;
        const bg = getComputedStyle(document.querySelector("#radar")).backgroundColor;
        const boxAlpha = /rgba/.test(bg) ? Number(bg.split(",")[3].replace(")", "")) : 1;
        const d = g.getImageData(0, 0, cv.width, cv.height).data, hist = new Map();
        for (let i = 3; i < d.length; i += 4 * 7) hist.set(d[i], (hist.get(d[i]) ?? 0) + 1);
        const grass = [...hist].sort((a, b) => b[1] - a[1])[0][0];
        let gi = 3; while (d[gi] !== grass) gi += 4;
        const px = (x, y) => { const i = (Math.round(y) * cv.width + Math.round(x)) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
        const lum = ([r, gg, b]) => [r, gg, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
          .reduce((s, v, j) => s + v * [0.2126, 0.7152, 0.0722][j], 0);
        const ps = sd.pitch.drawn.players, R = ps[0]?.r ?? 0, keylines = [];
        for (const p of ps) {
          if (p.focus || ps.some((q) => q !== p && Math.hypot(q.x - p.x, q.y - p.y) < 4 * R)) continue;   // a lit disc has its signal ring
          const ray = [];
          for (let a = 0; a < 8; a++) for (let r = R * k; r < R * k * 1.8 + 6; r += 0.5) ray.push(px(p.x * k + r * Math.cos(a * Math.PI / 4), p.y * k + r * Math.sin(a * Math.PI / 4)));
          keylines.push({ center: px(p.x * k, p.y * k)[3], white: ray.some((c) => c[3] > 245 && lum(c) > 0.6), dark: ray.some((c) => c[3] > 245 && lum(c) < 0.03) });
        }
        const b = sd.pitch.drawn.ball;
        return { boxAlpha, grass: grass / 255, grassRGB: [d[gi - 3], d[gi - 2], d[gi - 1]], opaque: hist.get(255) ?? 0,
          ball: b ? px(b[0] * k, b[1] * k)[3] : 255, keylines };
      });
      const contrast = (a, b) => { const l = (c) => c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, j) => s + v * [0.2126, 0.7152, 0.0722][j], 0);
        const [x, y] = [l(a), l(b)].sort((p, q) => p - q); return (y + 0.05) / (x + 0.05); };
      const over = (rgb, a, back) => rgb.map((v) => a * v + (1 - a) * back);
      await seekTo(page, moments[0][1]);
      await page.mouse.move(5, 5);
      const before = await box();
      const st = await see();
      console.log(`minimap see-through: box alpha ${st.boxAlpha}, grass alpha ${st.grass.toFixed(3)}, keylines ${JSON.stringify(st.keylines.slice(0, 3))}`);
      if (st.boxAlpha !== 0 || !(st.grass >= 0.45 && st.grass <= 0.55)) fail(`minimap: not see-through, box alpha ${st.boxAlpha}, grass alpha ${st.grass}`);
      if (!st.opaque || st.ball !== 255 || !st.keylines.length || st.keylines.some((q) => q.center !== 255 || !q.white || !q.dark)) fail(`minimap: lines, discs or ball not opaque or a disc without its keylines ${JSON.stringify(st)}`);
      const onWhite = contrast([4, 10, 22], over(st.grassRGB, st.grass, 255)), onBlack = contrast([255, 255, 255], over(st.grassRGB, st.grass, 0));
      if (!(onWhite >= 3 && onBlack >= 3)) fail(`minimap keylines: dark ${onWhite.toFixed(2)}:1 on a white frame, white ${onBlack.toFixed(2)}:1 on a black one`);
      if (before.main !== "3d" || before.pitchIn !== "radar" || before.label !== "Show the 2D pitch large" || before.icon) fail(`minimap: ${JSON.stringify(before)}`);
      await page.hover("#radar");
      if (!(await box()).icon) fail("minimap: no swap icon on hover");
      fps.split = await playFps(page);
      await page.click("#radar");
      await seekTo(page, moments[0][1]);
      const sw = await box();
      const r = await measure(page);
      if (sw.main !== "2d" || sw.pitchIn !== "stage" || sw.canvasIn !== "radar" || sw.label !== "Show the 3D view large") fail(`minimap swap: ${JSON.stringify(sw)}`);
      if (sw.box !== before.box) fail(`minimap swap: the box moved from ${before.box} to ${sw.box}`);
      const st2 = await see();
      if (st2.boxAlpha !== 1 || st2.grass !== 1) fail(`minimap swap: the 3D inset or the large 2D pitch not opaque, box alpha ${st2.boxAlpha}, grass alpha ${st2.grass}`);
      if (r.radar.covered) fail("minimap swap: the inset sits under a graphic");
      for (const g of r.graphics) if (g.nameplate && g.nameplate.visible && !(g.nameplate.offset < 2)) fail(`radar swap: nameplate ${g.nameplate.offset.toFixed(1)} px off its player on the 2D pitch`);
      await page.screenshot({ path: `${shots}/view3d-radar-swapped.png` });
      fps.swapped = await playFps(page);
      await seekTo(page, moments[0][1]);
      // in Italian the name says it in Italian
      await page.evaluate(() => document.querySelector('[data-lang="it"]').click());
      const it = await page.getAttribute("#radar", "aria-label");
      await page.evaluate(() => document.querySelector('[data-lang="en"]').click());
      if (it !== "Mostra in grande la vista 3D") fail(`minimap name in Italian: "${it}"`);
      // keyboard: the minimap is a button; the icon shows on focus; Space swaps and does not play
      await page.mouse.move(5, 5);
      await page.focus("#frame");
      await page.keyboard.press("Tab");
      for (let i = 0; i < 30 && (await page.evaluate(() => document.activeElement?.id)) !== "radar"; i++) await page.keyboard.press("Tab");
      const focusIcon = (await box()).icon;
      await page.keyboard.press("Enter");
      const back = await box();
      if (back.main !== "3d" || back.pitchIn !== "radar" || !focusIcon) fail(`minimap swap back with Enter: ${JSON.stringify(back)}, icon on focus ${focusIcon}`);
      await page.keyboard.press("Space");
      await page.waitForTimeout(150);
      const sp = await page.evaluate(() => ({ main: window.studioDesk.view3d.main, playing: window.studioDesk.state.playing }));
      if (sp.main !== "2d" || sp.playing) fail(`Space on the minimap: ${JSON.stringify(sp)}, wanted a swap and no play`);
      await page.keyboard.press("Space");
      await page.screenshot({ path: `${shots}/view3d-split-focus.png` });
    }

    if (view === "3d") {
      // frame rate while playing at 1x: the 3D alone, then with the minimap (3D large) and swapped (3D in the inset)
      fps["3d"] = await playFps(page);
      for (const [k, f] of Object.entries(fps)) {
        console.log(`${{ "3d": "3D alone", split: "minimap, 3D large", swapped: "minimap swapped, 3D in the inset" }[k]} at 1280x720 playing 1x: ${fpsLine(f)}`);
        if (!(f.drawn > 0.9)) fail(`${k} playing, the 3D picture was drawn in only ${(f.drawn * 100).toFixed(0)}% of the page frames`);
      }
      // the 3D in the inset is a fraction of the size of the 3D alone; with the 3D large it is the same size
      if (fps.swapped && !(fps.swapped.px < fps["3d"].px / 4)) fail(`the 3D in the inset draws ${fps.swapped.px} px, the 3D alone ${fps["3d"].px}`);
      if (fps.split && fps.split.css !== fps["3d"].css) fail(`the 3D with the minimap is ${fps.split.css} px, the 3D alone ${fps["3d"].css}`);
      const fps3d = fps["3d"];

      // the 3D canvas is no tab stop; a pause ends a run of play for the frame-rate watch (a pause
      // inside the window must not read as a slow frame rate)
      const pause = await page.evaluate(async (floor) => {
        const sd = window.studioDesk, v = sd.view3d, wait = (ms) => new Promise((r) => setTimeout(r, ms));
        Object.assign(v, { floor, warmup: 0 });
        sd.seek(1500); sd.setPlaying(true); await wait(6000);
        sd.setPlaying(false); await wait(3000);
        sd.setPlaying(true); await wait(6000);
        const out = { tab: document.querySelector("#view3d").tabIndex, shown: v.shown, notice: v.notice, hint: !document.querySelector("#slow-hint").hidden };
        sd.setPlaying(false); v.floor = 0;
        return out;
      }, fps3d.fps * 0.6);
      console.log(`pause and resume: ${JSON.stringify(pause)}`);
      if (pause.tab !== -1) fail(`the 3D canvas is a tab stop (tabIndex ${pause.tab})`);
      if (pause.shown !== "3d" || pause.notice || pause.hint) fail(`a 3 s pause read as a slow 3D view: ${JSON.stringify(pause)}`);

      // the 3D notice gives the page's own notice back when it clears
      const kept = await page.evaluate(() => {
        const v = window.studioDesk.view3d, n = document.querySelector("#notice");
        n.textContent = "page notice"; n.hidden = false;
        v._notice(() => "Loading the 3D view"); v._notice(null);
        const out = n.hidden ? null : n.textContent;
        n.textContent = ""; n.hidden = true; v.prior = "";
        return out;
      });
      if (kept !== "page notice") fail(`the 3D notice wiped the page's notice (now ${JSON.stringify(kept)})`);
      // a 3D notice on screen follows a change of language
      const relang = await page.evaluate(async () => {
        const v = window.studioDesk.view3d, n = document.querySelector("#notice"), lang = (l) => document.querySelector(`[data-lang="${l}"]`).click();
        v._notice(() => v.t("lost3d"));
        // an alert region is read out when words come into it: it shows empty, then gets them
        const first = { shown: !n.hidden, text: n.textContent };
        await new Promise((r) => setTimeout(r, 200));
        const en = n.textContent;
        lang("it");
        await new Promise((r) => setTimeout(r, 50));
        const it = n.textContent;
        lang("en");
        v._notice(null);
        return [en, it, first];
      });
      if (!relang[0] || relang[0] === relang[1]) fail(`the 3D notice kept its language: ${JSON.stringify(relang)}`);
      if (!relang[2].shown || relang[2].text) fail(`the 3D notice did not show empty before its words: ${JSON.stringify(relang[2])}`);

      // seek sweep over the whole match, twice: after the first (players clone their motion clips
      // lazily, scene3d/players.js) the second must leave the heap and the scene the same size
      const cdp = await page.context().newCDPSession(page);
      const heap = async () => { await cdp.send("HeapProfiler.collectGarbage"); return (await cdp.send("Runtime.getHeapUsage")).usedSize / 1e6; };
      const census = () => page.evaluate(() => {
        const s = window.studioDesk.view3d.scene, sc = s.scene;
        return { meshes: sc.meshes.length, materials: sc.materials.length, textures: sc.textures.length, groups: sc.animationGroups.length,
          observers: [sc.onAfterAnimationsObservable, sc.onBeforeRenderObservable, sc.onAfterRenderObservable].map((o) => o.observers?.length ?? o._observers.length).join(), drivers: s.drivers.length };
      });
      const sweep = async () => {
        const end = await page.evaluate(() => window.studioDesk.end);
        let replans = 0;
        for (let ts = 0; ts <= end; ts += 120) {
          await seekTo(page, ts);
          replans += await page.evaluate(() => { const v = window.studioDesk.view3d, k = v.scene.span.join(); const n = k !== v._lastSpan ? 1 : 0; v._lastSpan = k; return n; });
        }
        return replans;
      };
      const h0 = await heap(), c0 = await census();
      const n1 = await sweep(); const h1 = await heap(), c1 = await census();
      const n2 = await sweep(); const h2 = await heap(), c2 = await census();
      console.log(`seek sweep: heap ${h0.toFixed(1)} MB before, ${h1.toFixed(1)} after one sweep, ${h2.toFixed(1)} after two (${n1} and ${n2} replans); scene ${JSON.stringify(c2)}`);
      if (n1 < 20) fail(`the sweep replanned only ${n1} times: it measures nothing`);
      if (!(h2 - h1 < 5)) fail(`heap grew ${(h2 - h1).toFixed(1)} MB over the second sweep`);
      console.log(`scene before ${JSON.stringify(c0)}, after one sweep ${JSON.stringify(c1)}`);
      if (JSON.stringify(c1) !== JSON.stringify(c2)) fail(`scene grew over the second sweep: ${JSON.stringify(c1)} -> ${JSON.stringify(c2)}`);

      // under the frame-rate floor the 3D view stays and a line suggests the 2D pitch, once: "Keep 3D"
      // hides it for good, "Switch to 2D" switches, the minimap item brings the 3D back. Meanwhile the
      // beacon goes once, after its seconds of 3D play, with the fields api.py takes.
      const perf = [];
      await page.route("**/api/perf", (r) => { perf.push({ body: r.request().postDataJSON(), type: r.request().headers()["content-type"] }); r.fulfill({ status: 204 }); });
      const slow = await page.evaluate(async () => {
        const sd = window.studioDesk, v = sd.view3d, hint = document.querySelector("#slow-hint"), wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const until = async (ok, s) => { const t0 = performance.now(); while (!ok() && performance.now() - t0 < s * 1000) await wait(200); return (performance.now() - t0) / 1000; };
        Object.assign(v, { floor: 1000, warmup: v.played + 2, beaconAt: v.played + 3, beaconSent: false, gaps: [] });
        sd.seek(1200); sd.setPlaying(true);
        const after = await until(() => !hint.hidden, 60);
        const status = hint.querySelector("[role=status]"), early = status?.textContent;
        await wait(300);   // the words come into the live region once it shows
        const [go, keep] = hint.querySelectorAll("button");
        const out = { after, shown: v.shown, notice: v.notice, text: status?.textContent, go: go.textContent, keep: keep.textContent };
        keep.focus(); keep.click();
        out.focusAfterKeep = document.activeElement?.id;
        await wait(12000);
        Object.assign(out, { keptHidden: hint.hidden, keptShown: v.shown, early });
        v.suggested = false;   // the line again, for its other button
        await until(() => !hint.hidden, 60);
        go.focus(); go.click();
        out.focusAfterGo = document.activeElement?.id;
        await wait(500);
        const pitch = document.querySelector("#pitch");
        Object.assign(out, { switched: v.shown, hintAfterSwitch: !hint.hidden, pitch: !pitch.hidden && pitch.parentElement.id === "stage" });
        document.querySelector("#minimap").click();
        await wait(12000);
        out.kept = v.shown;
        sd.setPlaying(false);
        return out;
      });
      console.log(`floor at 1000 fps: the suggestion after ${slow.after.toFixed(1)} s ("${slow.text}"), the view ${slow.shown}; ${JSON.stringify(slow)}; beacon ${JSON.stringify(perf)}`);
      if (slow.shown !== "3d" || slow.notice || !/frames a second/.test(slow.text)) fail(`under the floor the 3D view did not stay with the suggestion: ${JSON.stringify(slow)}`);
      if (slow.go !== "Switch to 2D" || slow.keep !== "Keep 3D") fail(`the suggestion's buttons read ${slow.go} / ${slow.keep}`);
      if (slow.focusAfterKeep !== "frame" || slow.focusAfterGo !== "frame") fail(`the suggestion's buttons left the focus on ${slow.focusAfterKeep} / ${slow.focusAfterGo}, not the frame`);
      if (!slow.keptHidden || slow.keptShown !== "3d") fail(`"Keep 3D" did not keep the 3D without the line: ${JSON.stringify(slow)}`);
      if (slow.switched !== "2d" || slow.hintAfterSwitch || !slow.pitch) fail(`"Switch to 2D" did not switch: ${JSON.stringify(slow)}`);
      if (slow.kept !== "split") fail(`the minimap turned on by hand after the switch did not stay (${slow.kept})`);
      const b = perf[0]?.body;
      if (perf.length !== 1) fail(`the beacon went ${perf.length} times, not once`);
      else if (perf[0].type !== "application/json" || Object.keys(b).sort().join() !== "dpr,fps_median,match_id,renderer,screen_h,screen_w"
        || b.match_id !== MATCH || !(b.fps_median > 0) || !(b.screen_w > 0 && b.screen_h > 0 && b.dpr > 0) || !(b.renderer === null || typeof b.renderer === "string"))
        fail(`the beacon is not what api/perf takes: ${JSON.stringify(perf[0])}`);

      // a lost WebGL context: back to the 2D pitch with a notice, the minimap item off
      page.lostOnPurpose = true;
      const lost = await page.evaluate(async () => {
        const v = window.studioDesk.view3d;
        v.scene.engine._gl.getExtension("WEBGL_lose_context").loseContext();
        await new Promise((r) => setTimeout(r, 500));
        const pitch = document.querySelector("#pitch"), n = document.querySelector("#notice");
        return { shown: v.mode, pitch: !pitch.hidden && pitch.parentElement.id === "stage", notice: n.hidden ? null : n.textContent,
          disabled: document.querySelector("#minimap").getAttribute("aria-disabled") };
      });
      console.log(`context lost: ${JSON.stringify(lost)}`);
      if (lost.shown !== "2d" || !lost.pitch || !lost.notice || lost.disabled !== "true") fail(`no fall back after a lost WebGL context: ${JSON.stringify(lost)}`);
    }
    if (view !== "2d") await page.context().close();
  }
  await page2d.context().close();

  // without WebGL: the default is 2D and Babylon never loads; asking for 3D or the minimap falls back with a notice, no inset
  for (const view of [null, "3d", "split"]) {
    const page = await open(view, { noWebGL: true, quiet: !!view });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const sd = window.studioDesk, n = document.querySelector("#notice"), c = document.querySelector("#pitch");
      const px = c.getContext("2d").getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
      return { shown: sd.view3d.shown, failed: !!sd.view3d.failed, babylon: !!window.BABYLON, notice: n.hidden ? null : n.textContent,
        disabled: document.querySelector("#minimap").getAttribute("aria-disabled"), radar: !document.querySelector("#radar").hidden, drawn: px[3] === 255 && !c.hidden };
    });
    console.log(`without WebGL, ${view ? `?view=${view}` : "no ?view"}: shows ${r.shown}, notice "${r.notice}", disabled ${r.disabled}, 2D pitch drawn ${r.drawn}`);
    if (r.shown !== "2d" || !r.drawn || r.radar) fail(`without WebGL the page is not on the 2D pitch: ${JSON.stringify(r)}`);
    if (view === null && (r.babylon || r.notice)) fail(`without WebGL the default view loaded the 3D: ${JSON.stringify(r)}`);
    if (view && (!r.failed || !r.notice || r.disabled !== "true")) fail(`no fall back without WebGL: ${JSON.stringify(r)}`);
    await page.context().close();
  }
} finally {
  await browser.close();
}
if (failures.length) { console.log(`${failures.length} failure(s)`); process.exit(1); }
console.log("view3d ok");
