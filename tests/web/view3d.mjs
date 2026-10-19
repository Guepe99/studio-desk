// The 2D, 3D and Split views of the broadcast page (web/js/view3d.js) on a whole match. For each
// view it opens index.html?match=$MATCH&view=<view> and seeks to three moments (a nameplate on air,
// a graphic in the second half, a goal replay), and checks that the 3D players stand where the
// tracking says (the rigs may move a body by a step: the ball rig's reach, a keeper's dive, a
// celebration kept apart), that the 3D ball is the tracking ball within the ball rig's 1.5 m, that
// the graphics on air are the ones the 2D page shows, and that a nameplate sits on its 3D player.
// Then on the 3D page: the frame rate while playing, a seek sweep over the whole match twice (the
// heap and the scene must not grow), and the fall back to 2D under the frame-rate floor; on a page
// without WebGL: the fall back at load and the 2D default. Screenshots of the three views go to
// out/shots/view3d-{2d,3d,split}.png and view3d-replay.png.
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
    if (m.type() === "error" && !quiet && !/\/api\/|voice\.json/.test(m.location()?.url ?? "")) fail(`${tag} console: ${m.text()}`);
  });
  page.on("pageerror", (e) => fail(`${tag} page error: ${e.message}`));
  if (noWebGL) await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return /webgl/i.test(kind) ? null : get.call(this, kind, ...rest); };
  });
  await page.goto(new URL(`index.html?match=${MATCH}${view ? `&view=${view}` : ""}`, base).href);
  await page.waitForFunction(() => window.studioDesk?.view3d, null, { timeout: 120000 });
  await page.waitForFunction(() => { const v = window.studioDesk.view3d; return v.mode === "2d" || v.scene || v.failed; }, null, { timeout: 300000 });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

// Seek, draw, wait for the graphics, place them again (as sample3d.js __setTime does).
const seekTo = (page, ts) => page.evaluate(async (x) => {
  const sd = window.studioDesk, raf = () => new Promise((r) => requestAnimationFrame(r));
  sd.setPlaying(false);
  sd.seek(x);
  await raf(); await raf();
  await Promise.all([...sd.host.live.values()].map((i) => i.chain));
  await raf(); await raf();
  // paused, the 3D picture keeps drawing until every shader it needs has compiled
  for (const t0 = performance.now(); performance.now() - t0 < 60000 && sd.view3d.shown !== "2d" && !sd.view3d.ready;) await raf();
  return sd.view3d.shown === "2d" || sd.view3d.ready;
}, ts);

// What is on screen at the clock: graphics, and in 3D the players and the ball against the tracking.
const measure = (page) => page.evaluate(() => {
  const sd = window.studioDesk, v = sd.view3d, m = sd.match, frame = document.querySelector("#frame").getBoundingClientRect();
  const graphics = [...sd.host.live.values()].map((inst) => {
    const r = inst.el.getBoundingClientRect();
    const out = { cue: inst.cue.cue_id, graphic: inst.cue.graphic, inFrame: r.right > frame.left && r.left < frame.right && r.bottom > frame.top && r.top < frame.bottom };
    if (inst.cue.graphic === "nameplate") {
      const want = sd.host.opts.locate(inst.cue.payload.player_id, sd.state.ts);
      const t = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(inst.el.shadowRoot.querySelector(".anchor")?.style.transform ?? "");
      out.nameplate = { visible: want.visible, offset: t ? Math.hypot(Number(t[1]) - want.x, Number(t[2]) - want.y) : Infinity };
    }
    return out;
  });
  const res = { ts: sd.state.ts, shown: v.shown, graphics, pitchHidden: document.querySelector("#pitch").hidden,
    pitchIn: document.querySelector("#pitch").parentElement.id, babylon: !!window.BABYLON };
  if (!v.scene || v.shown === "2d") return res;
  const s = v.scene, vts = v.last.ts;
  res.view = { ts: vts, replay: v.last.replay, badge: document.querySelector("#replay-badge").classList.contains("on") };
  const want = new Set();
  for (let i = 1; i < m.n; i++) if (m.at(i, vts)) want.add(i);
  const on = s.players.filter((p) => p.holder.isEnabled());
  res.players = { want: want.size, shown: on.length, missing: [...want].filter((i) => !on.some((p) => p.i === i)).length,
    extra: on.filter((p) => !want.has(p.i)).length,
    off: on.filter((p) => want.has(p.i)).map((p) => { const t = m.at(p.i, vts); return Math.hypot(p.holder.position.x + 52.5 - t[0], p.holder.position.z + 34 - t[1]); }) };
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
  if (pure.defaults.join() !== "3d,2d,2d,2d") fail(`default view rule: ${pure.defaults}`);
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
  for (const view of ["2d", "3d", "split"]) {
    const page = view === "2d" ? page2d : await open(view);
    const t0 = Date.now();
    for (const [name, ts] of moments) {
      if (!(await seekTo(page, ts))) fail(`${view} at ${name}: the paused 3D picture never finished drawing`);
      const r = await measure(page);
      seen[`${view} ${name}`] = r;
      const tag = `${view} at ${name} (${ts.toFixed(1)} s)`;
      if (r.shown !== view) fail(`${tag}: shows ${r.shown}`);
      if (view === "2d" && r.babylon) fail("the 2D view loaded Babylon");
      if (view === "3d" && !r.pitchHidden) fail(`${tag}: 2D pitch still drawn over the 3D frame`);
      if (view === "split" && (r.pitchIn !== "side2d" || r.pitchHidden)) fail(`${tag}: 2D pitch not beside the 3D frame`);
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

    if (view === "3d") {
      // frame rate while playing at 1x (the floor is off while measuring)
      const fps = await page.evaluate(async () => {
        const sd = window.studioDesk;
        sd.view3d.floor = 0;
        sd.seek(1200); sd.setPlaying(true);
        await new Promise((r) => setTimeout(r, 2000));
        let n = 0;
        const t0 = performance.now();
        await new Promise((done) => { const f = () => { n++; if (performance.now() - t0 < 5000) requestAnimationFrame(f); else done(); }; requestAnimationFrame(f); });
        sd.setPlaying(false);
        return { fps: n / ((performance.now() - t0) / 1000), profile: sd.view3d.scene.debug.profile, renderer: sd.view3d.scene.engine.webGLVersion };
      });
      console.log(`3D at 1280x720 playing 1x: ${fps.fps.toFixed(1)} fps (profile ${fps.profile}, WebGL ${fps.renderer})`);

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

      // under the frame-rate floor the page goes back to 2D with a notice; picking 3D again keeps it
      const slow = await page.evaluate(async () => {
        const sd = window.studioDesk, v = sd.view3d;
        v.floor = 1000;
        sd.seek(1200); sd.setPlaying(true);
        const t0 = performance.now();
        while (v.shown !== "2d" && performance.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 200));
        const after = (performance.now() - t0) / 1000, notice = document.querySelector("#notice"), pitch = document.querySelector("#pitch");
        const out = { shown: v.shown, after, notice: notice.hidden ? null : notice.textContent, pitch: !pitch.hidden && pitch.parentElement.id === "stage" };
        document.querySelector('[data-view="3d"]').click();
        await new Promise((r) => setTimeout(r, 12000));
        out.kept = v.shown;
        sd.setPlaying(false);
        return out;
      });
      console.log(`floor at 1000 fps: back to ${slow.shown} after ${slow.after.toFixed(1)} s ("${slow.notice}"); 3D picked again: ${slow.kept}`);
      if (slow.shown !== "2d" || !slow.notice || !slow.pitch) fail(`no fall back under the frame-rate floor: ${JSON.stringify(slow)}`);
      if (slow.kept !== "3d") fail("3D picked by hand after the fall back did not stay");
    }
    if (view !== "2d") await page.context().close();
  }
  await page2d.context().close();

  // without WebGL: the default is 2D and Babylon never loads; asking for 3D falls back with a notice
  for (const view of [null, "3d"]) {
    const page = await open(view, { noWebGL: true, quiet: view === "3d" });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const sd = window.studioDesk, n = document.querySelector("#notice"), c = document.querySelector("#pitch");
      const px = c.getContext("2d").getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
      return { shown: sd.view3d.shown, failed: !!sd.view3d.failed, babylon: !!window.BABYLON, notice: n.hidden ? null : n.textContent,
        disabled: [...document.querySelectorAll("[data-view]")].filter((b) => b.disabled).map((b) => b.dataset.view), drawn: px[3] === 255 && !c.hidden };
    });
    console.log(`without WebGL, ${view ? `?view=${view}` : "no ?view"}: shows ${r.shown}, notice "${r.notice}", disabled ${r.disabled}, 2D pitch drawn ${r.drawn}`);
    if (r.shown !== "2d" || !r.drawn) fail(`without WebGL the page is not on the 2D pitch: ${JSON.stringify(r)}`);
    if (view === null && (r.babylon || r.notice)) fail(`without WebGL the default view loaded the 3D: ${JSON.stringify(r)}`);
    if (view === "3d" && (!r.failed || !r.notice || r.disabled.join() !== "3d,split")) fail(`no fall back without WebGL: ${JSON.stringify(r)}`);
    await page.context().close();
  }
} finally {
  await browser.close();
}
if (failures.length) { console.log(`${failures.length} failure(s)`); process.exit(1); }
console.log("view3d ok");
