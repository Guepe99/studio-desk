// Where a 3D frame's time goes, on the page as a visitor sees it: M001 (or MATCH) played at 1x in the
// 3D view for SECS seconds from FROM, with Babylon's SceneInstrumentation and our own timers around
// the scene update (players, drivers, crowd) and the render. Each frame is finished on the GPU
// (a one-pixel readPixels) so the render time is what the renderer completes. Software renderers
// here: compare runs taken back to back, and read the counts (draw calls, meshes, bones) as they are.
//
//   WEBGL=2 scripts/with-lock.sh chromium tests/web/run-smoke.sh frame-cost.mjs
import { createRequire } from "node:module";
import { homedir } from "node:os";
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");
const base = process.argv[2], M = process.env.MATCH ?? "M001", FROM = +(process.env.FROM ?? 600), SECS = +(process.env.SECS ?? 20);
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: +(process.env.W ?? 1440), height: +(process.env.H ?? 900) } })).newPage();
  page.setDefaultTimeout(600000);
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  await page.goto(`${base}index.html?match=${M}&view=3d${process.env.Q ? `&quality=${process.env.Q}` : ""}`);
  await page.waitForFunction(() => window.studioDesk?.view3d?.scene && window.studioDesk.view3d.ready, null, { timeout: 300000 });
  const out = await page.evaluate(async ([FROM, SECS]) => {
    const d = window.studioDesk, v = d.view3d, s = v.scene, sc = s.scene, B = window.BABYLON;
    v.floor = 0;   // no fallback to 2D while measuring
    const gl = s.engine._gl, px = new Uint8Array(4);
    const inst = new B.SceneInstrumentation(sc);
    for (const k of ["captureFrameTime", "captureActiveMeshesEvaluationTime", "captureRenderTargetsRenderTime", "captureRenderTime", "captureAnimationsTime", "captureCameraRenderTime"]) inst[k] = true;
    const t = { update: 0, render: 0, finish: 0, n: 0 };
    const upd = s.update.bind(s), ren = s.render.bind(s);
    s.update = (...a) => { const t0 = performance.now(); upd(...a); t.update += performance.now() - t0; };
    s.render = () => { const t0 = performance.now(); ren(); const t1 = performance.now(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); t.render += t1 - t0; t.finish += performance.now() - t1; t.n++; };
    d.setPlaying(false); d.seek(FROM); d.setPlaying(true);
    await new Promise((r) => setTimeout(r, 3000));   // shaders after the seek
    for (const k in t) t[k] = 0;
    for (const c of [inst.frameTimeCounter, inst.activeMeshesEvaluationTimeCounter, inst.renderTargetsRenderTimeCounter, inst.renderTimeCounter, inst.animationsTimeCounter, inst.cameraRenderTimeCounter]) c.fetchNewFrame?.();
    const t0 = performance.now(), ts0 = d.state.ts;
    await new Promise((r) => setTimeout(r, SECS * 1000));
    const wall = (performance.now() - t0) / 1000;
    const ms = (c) => +c.average.toFixed(1), per = (x) => +(x / Math.max(1, t.n)).toFixed(1);
    const skinned = sc.meshes.filter((m) => m.skeleton && m.isEnabled());
    return {
      frames: t.n, fps: +(t.n / wall).toFixed(2), matchSecondsPerSecond: +((d.state.ts - ts0) / wall).toFixed(2),
      perFrameMs: { update: per(t.update), renderCpu: per(t.render), gpuWait: per(t.finish) },
      babylonMs: { frame: ms(inst.frameTimeCounter), activeMeshes: ms(inst.activeMeshesEvaluationTimeCounter), renderTargets: ms(inst.renderTargetsRenderTimeCounter), render: ms(inst.renderTimeCounter), animations: ms(inst.animationsTimeCounter), cameraRender: ms(inst.cameraRenderTimeCounter) },
      counts: { drawCalls: inst.drawCallsCounter.current, meshes: sc.meshes.length, active: sc.getActiveMeshes().length, vertices: sc.getTotalVertices(), materials: sc.materials.length,
        skeletons: sc.skeletons.length, skinnedEnabled: skinned.length, bones: sc.skeletons.reduce((a, k) => a + k.bones.length, 0), animatables: sc.getAllAnimatablesByTarget ? undefined : sc.animatables?.length,
        renderTargets: sc.customRenderTargets.length, postProcesses: sc.postProcesses.length + (sc.activeCamera?._postProcesses?.filter(Boolean).length ?? 0),
        render: `${s.engine.getRenderWidth()}x${s.engine.getRenderHeight()}` },
      profile: s.debug,
    };
  }, [FROM, SECS]);
  console.log(JSON.stringify(out, null, 1));
} finally { await browser.close(); }
