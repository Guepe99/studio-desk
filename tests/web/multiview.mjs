// Browser check of the producer's multiviewer (web/multiview.html) on the M001 export.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh multiview.mjs   (run-smoke.sh picks the Playwright image: it decodes MP3)
//
// At 1920x1080: the four windows load with their audience and language and show only the picture; the
// keyboard focus stays on this page; Play keeps the four within 0.5 s and a window pushed 3 s away is
// brought back; a goal button moves all four; a click on a window gives it the tally and its sound (the
// booth's audio context running, crowd or lines playing) and silences the others; a second window takes it
// over; the large window shows the 3D view at the same time with its sound, and back in the grid it is 2D again.
// The desk beside the wall: a decision there (Take off on the first goal) reaches the four windows' cue sheets.
// At 1280x720 the desk is docked beside the four windows, all on screen. Then the autoplay rule on a fresh page, read only through CDP until real clicks (Playwright's evaluate
// counts as a user gesture): a control first, an audio context made in a window before any click must stay
// suspended, or the browser does not apply the rule and the check says SKIP; then a click on a window and on
// Play must start that window's sound and no other.
// The 3D checks use ?view=3d: this server has no GPU, so without it the large window stays 2D and says why
// (checked on the page with no parameters). One 3D scene at a time, and a lost context falls back to 2D with
// a line on the picture. Only the docked desk asks the server; Space and K in the desk leave play alone; the
// AI switch reaches the four windows; a decision on another window's own graphic reaches that window; a
// desk edit says what it replaces; window 1 failing still gives a desk from window 2.
// No console errors but the API's 404s and 501s on static hosting. A match that does not exist shows an
// error, not "Loading". Without the M001 and M004 exports in web/data the run says SKIP, and fails under CI.
// Screenshots at 1920x1080, 1280x720 and 390x844: out/shots/multiview-*.png.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const expect = (ok, msg) => { if (!ok) fail(msg); else console.log(`ok   ${msg}`); };

for (const m of ["M001", "M004"]) {
  if ((await fetch(new URL(`data/${m}/meta.json`, base)).catch(() => null))?.ok) continue;
  console.log(`SKIP web/data/${m} is missing: export it (README) to run the multiview checks`);
  process.exit(process.env.CI ? 1 : 0);
}

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  // after the test loses a WebGL context on purpose, Babylon work already under way fails to compile or make textures
  let lostOnPurpose = false;
  page.on("pageerror", (e) => { if (lostOnPurpose && /Unable to create texture/.test(e.message)) console.log(`     after the lost context: ${e.message}`); else fail(`page error: ${e.message}`); });
  // static hosting: the desk's and Ask's API calls (api/...) 404 by design, and the 3D view's POST to api/perf
  // gets 501 (the static server takes no POST); any other error fails
  const apiMiss = (m) => /\b(404|501)\b/.test(m.text()) && new URL(m.location().url || "x:", base).pathname.startsWith("/api/");
  const afterLoss = (m) => lostOnPurpose && /\/babylonjs\//.test(m.location().url ?? "");
  page.on("console", (m) => { if (m.type() === "error" && !apiMiss(m) && !afterLoss(m)) fail(`console: ${m.text()} (${m.location().url})`); });

  const sessions = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/session") sessions.push(r.frame().parentFrame() ? "window" : "wall"); });
  const t0 = Date.now();
  await page.goto(new URL("multiview.html?match=M001&view=3d", base).href);
  // loaded: every window has its match and its voice (the voice comes last in app.js)
  await page.waitForFunction(() => window.multiview?.wins.every((w) => window.multiview.sd(w)?.match && window.multiview.sd(w)?.voice), null, { timeout: 90000 });
  console.log(`     four windows loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // the booth's crowd and lines are MP3: a browser that cannot decode them plays nothing, whatever the page does
  const mp3 = await page.evaluate(async () => {
    const W = window.multiview.wins[0].frame.contentWindow;
    try { return (await new W.OfflineAudioContext(1, 1, 44100).decodeAudioData(await (await W.fetch("vendor/crowd-audio/kick.mp3")).arrayBuffer())).duration > 0; }
    catch (e) { return String(e); }
  });
  expect(mp3 === true, `this browser decodes the booth's MP3 (${mp3}); without it no window can play`);
  const times = () => page.evaluate(() => window.multiview.wins.map((w) => window.multiview.sd(w).state.ts));
  const spread = (ts) => Math.max(...ts) - Math.min(...ts);

  const setup = await page.evaluate(() => window.multiview.wins.map((w) => {
    const doc = w.frame.contentDocument, d = window.multiview.sd(w);
    return { audience: d.state.audience, lang: d.state.lang, ts: d.state.ts, controls: getComputedStyle(doc.querySelector("#controls")).display,
      desk: getComputedStyle(doc.querySelector("#desk")).display, frameW: doc.querySelector("#frame").offsetWidth, umd: w.name.textContent };
  }));
  console.log(JSON.stringify(setup));
  const want = [["analyst", "en"], ["kids", "en"], ["team:T02", "it"], ["casual", "es"]];   // T02: M001's away team
  expect(setup.every((s, i) => s.audience === want[i][0] && s.lang === want[i][1]), "each window has its audience and language");
  expect(setup.every((s) => Math.abs(s.ts - 590) < 0.01), "each window starts at t=590");
  expect(setup.every((s) => s.controls === "none" && s.desk === "none"), "inside a window: no controls, no desk");
  expect(setup.every((s) => s.frameW === 960), "each picture fills its 960 px window");
  expect(setup[2].umd === "Ostwick FC fan · IT", `the name strip names the team: ${setup[2].umd}`);
  expect(await page.evaluate(() => !document.activeElement || document.activeElement.tagName !== "IFRAME"), "the keyboard focus stays on the multiviewer");
  expect((await page.locator("#mv-goals button").count()) === 4, "four goal buttons");
  await page.waitForFunction(() => window.multiview.desk?.ready && window.multiview.wins.every((w) => w.shared), null, { timeout: 30000 });
  const deskBox = await page.evaluate(() => { const r = document.querySelector("#desk").getBoundingClientRect(), wall = document.querySelector("#mv-wall").getBoundingClientRect();
    return { visible: getComputedStyle(document.querySelector("#desk")).visibility === "visible", beside: r.left >= wall.right - 1, needs: !!document.querySelector("#desk .sec-needs"), w: r.width }; });
  expect(deskBox.visible && deskBox.beside && deskBox.needs, `the desk is docked beside the wall with Needs you (${JSON.stringify(deskBox)})`);
  expect(await page.evaluate(() => window.multiview.wins.every((w) => window.multiview.sd(w).desk.decisions === window.multiview.desk.decisions)), "the four windows share the desk's decisions");
  expect(sessions.join() === "wall", `only the docked desk asks the server for its session (${sessions.join() || "none"})`);

  // play: the four stay together
  await page.click("#mv-play");
  await page.waitForTimeout(3000);
  // the sound: a click on window 3 gives it the tally and the audio, the others stay quiet
  await page.click(".mv-win:nth-child(3) .mv-hit");
  // the large window builds its 3D scene: in software WebGL the page stalls for a while (tens of seconds)
  const up3d = (i) => page.waitForFunction((i) => { const v = window.multiview.sd(window.multiview.wins[i]).view3d; return v.shown === "3d" || v.failed || v.lost; }, i, { timeout: 180000, polling: 1000 });
  const t3 = Date.now();
  await up3d(2);
  console.log(`     window 3's 3D view up in ${((Date.now() - t3) / 1000).toFixed(1)} s`);
  // all four play: read on the page's own clocks, since a software-WebGL stall stretches wall time
  const moved = await page.waitForFunction(() => window.multiview.wins.every((w) => window.multiview.sd(w).state.playing && window.multiview.sd(w).state.ts >= 593),
    null, { timeout: 60000, polling: 200 }).then(() => true, () => false);
  let ts = await times();
  console.log(`     playing: ${ts.map((x) => x.toFixed(2)).join(" ")}`);
  expect(moved, "all four play: each window's clock 3 s past its start");
  expect(spread(ts) <= 0.5, `the four within 0.5 s while playing (${spread(ts).toFixed(3)} s)`);
  // the clock keeps real time through the 3D build, so window 3 now draws the first goal (595.7): in software
  // WebGL its frames come 10 to 20 s apart, past Playwright's 30 s default for a screenshot
  await page.screenshot({ path: path.join(shots, "multiview-1920.png"), timeout: 120000 });

  // a window pushed away is brought back
  await page.evaluate(() => { const d = window.multiview.sd(window.multiview.wins[2]); d.seek(d.state.ts + 3); });
  // window 3 is large and in 3D: in software WebGL the seek replans its scene, and a frame can take over 500 ms
  await page.waitForFunction(() => { const t = window.multiview.wins.map((w) => window.multiview.sd(w).state.ts); return Math.max(...t) - Math.min(...t) <= 0.5; }, null, { timeout: 5000, polling: 100 }).catch(() => {});
  ts = await times();
  expect(spread(ts) <= 0.5, `a window 3 s away is brought back (${spread(ts).toFixed(3)} s)`);

  const audio = () => page.evaluate(() => window.multiview.wins.map((w) => {
    const d = window.multiview.sd(w);
    return { tally: w.fig.classList.contains("mv-tally"), on: d.voice.on, ctx: d.booth?.ctx?.state ?? "none", ...(d.booth?.status ?? {}) };
  }));
  let a = await audio();
  console.log(JSON.stringify(a));
  expect(a.map((x) => x.tally).join() === "false,false,true,false", "window 3 has the tally");
  expect(a.map((x) => x.on).join() === "false,false,true,false", "only window 3 has its sound on");
  expect(a[2].ctx === "running", `window 3's audio context is running (${a[2].ctx})`);
  expect(a[2].crowd + a[2].lines > 0, `window 3 plays the crowd or a line (crowd ${a[2].crowd}, lines ${a[2].lines})`);
  // the meter follows the mix: its highest reading over up to 5 s (a software-WebGL frame can hold the page's frames)
  let bar = 0;
  for (let k = 0; k < 50 && bar <= 0.1; k++) { bar = Math.max(bar, await page.evaluate(() => Number(/scaleY\(([\d.]+)\)/.exec(window.multiview.wins[2].bar.style.transform)?.[1] ?? 0))); await page.waitForTimeout(100); }
  expect(bar > 0.1, `window 3's meter moves (up to ${bar})`);

  await page.click(".mv-win:nth-child(1) .mv-hit");
  // window 1 builds its 3D scene meanwhile: in software WebGL that stalls the page for seconds
  await page.waitForTimeout(3000);
  await page.waitForFunction(() => { const s = window.multiview.sd(window.multiview.wins[0]).booth?.status; return s && s.crowd + s.lines > 0; },
    null, { timeout: 30000, polling: 500 }).catch(() => {});
  a = await audio();
  console.log(JSON.stringify(a));
  expect(a.map((x) => x.tally).join() === "true,false,false,false", "the tally moves to window 1");
  expect(a.map((x) => x.on).join() === "true,false,false,false", "only window 1 has its sound on");
  expect(a[0].ctx === "running" && a[0].crowd + a[0].lines > 0, `window 1 plays (ctx ${a[0].ctx}, crowd ${a[0].crowd}, lines ${a[0].lines})`);
  expect(a[2].crowd + a[2].lines === 0, `window 3 is silent (crowd ${a[2].crowd}, lines ${a[2].lines})`);
  ts = await times();
  expect(spread(ts) <= 0.5, `still within 0.5 s with the reference on window 1 (${spread(ts).toFixed(3)} s)`);
  // the live window is the large one, the other three small in a column beside it, all on screen
  const box = () => page.$$eval(".mv-pic", (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, b: r.bottom }; }));
  let bx = await box();
  console.log(JSON.stringify(bx));
  expect(bx[0].w > 2 * bx[1].w && bx[1].w === bx[2].w && bx[2].w === bx[3].w && Math.abs(bx[0].y - bx[1].y) < 1, "window 1 large, the others small, tops aligned");
  expect(bx.slice(1).every((r) => r.x > bx[0].x + bx[0].w) && Math.max(...bx.map((r) => r.b)) <= 1080, "the small ones beside it, all on screen");
  // the large window in 3D, the small ones in 2D, at the same time and with its sound on
  const views = () => page.evaluate(() => window.multiview.wins.map((w) => window.multiview.sd(w).view3d.shown));
  const in3d = await up3d(0).then(() => true, () => false);
  let vs = await views();
  expect(in3d && vs.join() === "3d,2d,2d,2d", `the large window shows the 3D view, the others 2D (${vs.join()})`);
  const scenes = () => page.evaluate(() => window.multiview.wins.map((w) => (window.multiview.sd(w).view3d.scene ? 1 : 0)).join(""));
  expect(await scenes() === "1000", `one 3D scene: window 3's was freed when it left the large slot (${await scenes()})`);
  ts = await times();
  a = await audio();
  expect(spread(ts) <= 0.5 && a[0].on, `in 3D it keeps its time and its sound (${spread(ts).toFixed(3)} s, voice ${a[0].on})`);
  await page.screenshot({ path: path.join(shots, "multiview-focus.png"), timeout: 120000 });   // 3D in software, as above
  await page.click(".mv-win:nth-child(1) .mv-hit");
  await page.waitForTimeout(1000);
  // a software-WebGL frame of the large window can hold the page's next frame for a few seconds
  await page.waitForFunction(() => window.multiview.wins.every((w) => window.multiview.sd(w).view3d.shown === "2d"), null, { timeout: 15000, polling: 250 }).catch(() => {});
  bx = await box();
  expect(bx.every((r) => r.w === bx[0].w), "clicked again: all four the same size");
  vs = await views();
  expect(vs.every((v) => v === "2d"), `back in the grid, all four in 2D (${vs.join()})`);
  expect(await scenes() === "0000", `and no 3D scene is left (${await scenes()})`);
  await page.click(".mv-win:nth-child(1) .mv-hit");   // back to window 1 live for the checks below
  await up3d(0);
  await page.waitForTimeout(1000);

  // a goal button moves all four
  await page.locator("#mv-goals button").nth(2).click();
  await page.waitForTimeout(400);
  ts = await times();
  expect(ts.every((x) => x > 2900 && x < 3060) && spread(ts) <= 0.5, `the third goal button moves all four (${ts.map((x) => x.toFixed(1)).join(" ")})`);

  // pause stops all four
  await page.click("#mv-play");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.multiview.wins.every((w) => !window.multiview.sd(w).state.playing)), "pause stops all four");

  // a decision on the desk reaches the four windows: the first goal's story taken off air at 600, in every window's sheet
  await page.evaluate(() => window.multiview.desk.seek(600));
  const goalCues = () => page.evaluate(() => window.multiview.wins.map((w) => window.multiview.sd(w).host.cues.filter((c) => c.story_id === "S-000002").length));
  const before = await goalCues();
  expect(before.every((n) => n > 0), `before: every window has the goal story's cues (${before.join()})`);
  await page.locator("#story-S-000002 [data-key=r]").click();
  await page.waitForTimeout(300);
  const after = await goalCues();
  const decided = await page.evaluate(() => window.multiview.wins.map((w) => window.multiview.sd(w).desk.decisions.get("S-000002")?.decision));
  expect(after.every((n) => n === 0) && decided.every((d) => d === "rejected"), `Take off on the desk: the goal story leaves all four windows (${after.join()}; ${decided.join()})`);
  expect(await page.evaluate(() => window.multiview.wins.every((w) => ![...window.multiview.sd(w).host.live.values()].some((i) => i.cue.story_id === "S-000002"))), "and none of the four shows it");

  // Space and K with the focus in the desk belong to the desk: play stays as it was
  const playState = () => page.evaluate(() => [window.multiview.playing, ...window.multiview.wins.map((w) => window.multiview.sd(w).state.playing)].join());
  const was = await playState();
  await page.locator("#story-S-000002").focus();
  await page.keyboard.press("k");
  await page.waitForTimeout(300);
  const afterK = await playState();
  await page.locator("#story-S-000002").focus();
  await page.keyboard.press(" ");
  await page.waitForTimeout(300);
  const afterSpace = await playState();
  // each key alone: two toggles in a row would cancel out
  expect(afterK === was && afterSpace === was, `Space and K in the desk do not toggle play (${was} -> K ${afterK} -> Space ${afterSpace})`);

  // the AI switch on the desk reaches the four windows, and back
  const kills = () => page.evaluate(() => window.multiview.wins.map((w) => window.multiview.sd(w).desk.kill).join());
  await page.locator("#desk #ai-switch").click();
  await page.waitForTimeout(300);
  const off = await kills(), storyCues = await page.evaluate(() => window.multiview.wins.map((w) => window.multiview.sd(w).host.cues.filter((c) => c.story_id).length).join());
  await page.locator("#desk #ai-switch").click();
  await page.waitForTimeout(300);
  expect(off === "true,true,true,true" && /^0,0,0,0$/.test(storyCues) && await kills() === "false,false,false,false",
    `the AI switch turns the AI graphics off in all four windows and back on (${off}; story cues ${storyCues}; then ${await kills()})`);

  // a generated graphic of another window's audience (window 2, 3 or 4) on screen: taken off on the desk, it leaves that window
  const gen = await page.evaluate(async () => {
    const mv = window.multiview, dk = mv.desk;
    for (const j of [1, 2, 3]) {
      const aud = mv.sd(mv.wins[j]).state.audience;
      for (const g of dk.gens.filter((g) => g.audience === aud && dk.firstOf(g) > 600).slice(0, 4)) {
        dk.seek(dk.firstOf(g) + 0.5);
        await new Promise((r) => setTimeout(r, 600));
        if (document.querySelector(`#desk .sec-air #story-${g.story_id}`)) return { id: g.story_id, j, aud };
      }
    }
    return null;
  });
  const genCues = () => page.evaluate((id) => window.multiview.wins.map((w) => { const d = window.multiview.sd(w); return d.host.cues.filter((c) => d.desk.genFor(c)?.story_id === id).length; }).join(), gen?.id);
  const genBefore = gen && await genCues();
  if (gen) await page.locator(`#desk #story-${gen.id} [data-key=r]`).click();
  await page.waitForTimeout(300);
  const genAfter = gen && await genCues();
  const there = (n) => gen && new RegExp(`^${[0, 1, 2, 3].map((k) => (k === gen.j ? n : "0")).join(",")}$`);
  expect(Boolean(gen) && there("[1-9]\\d*").test(genBefore) && there("0").test(genAfter),
    `Take off on a ${gen?.aud} graphic (${gen?.id}) takes it out of window ${gen ? gen.j + 1 : "?"} (${genBefore} -> ${genAfter})`);

  // an edit on the desk says whose wording it shows and that the line changes in all four windows
  await page.evaluate(() => window.multiview.desk.seek(600));
  await page.waitForTimeout(300);
  await page.locator("#story-S-000002 [data-key=e]").click();
  const note = await page.locator("#story-S-000002 .edit-note").textContent({ timeout: 5000 }).catch(() => null);
  expect(/Analyst · EN/.test(note ?? "") && /all four windows/.test(note ?? ""), `the editor says what an edit replaces (${note})`);
  await page.keyboard.press("Escape");

  // window 4 large: window 1's scene is freed; then window 4's context is lost: 2D, and a line on its picture says so
  await page.click(".mv-win:nth-child(4) .mv-hit");
  const in3d4 = await up3d(3).then(() => true, () => false);
  await page.waitForTimeout(500);
  expect(in3d4 && await scenes() === "0001", `window 4 large in 3D, the only scene (${await scenes()})`);
  lostOnPurpose = true;
  await page.evaluate(() => window.multiview.sd(window.multiview.wins[3]).view3d.scene.engine._gl.getExtension("WEBGL_lose_context").loseContext());
  const lost = await page.waitForFunction(() => { const w = window.multiview.wins[3]; return window.multiview.sd(w).view3d.shown === "2d" && !w.note.hidden && w.note.textContent; },
    null, { timeout: 10000 }).then((h) => h.jsonValue(), () => null);
  expect(Boolean(lost) && /lost/.test(lost), `a lost 3D context: the large window back in 2D, and it says so (${lost})`);
  await page.click(".mv-win:nth-child(4) .mv-hit");   // all four the same size

  // 1280x720: the desk docked beside the wall, the four windows on screen, nothing sideways
  await page.setViewportSize({ width: 1280, height: 720 });
  // the layout follows a ResizeObserver, which runs only in a rendering frame: in software WebGL those can be seconds apart
  await page.waitForFunction(() => Math.max(...[...document.querySelectorAll(".mv-pic")].map((e) => e.getBoundingClientRect().bottom)) <= innerHeight, null, { timeout: 30000, polling: 250 }).catch(() => {});
  const mid = await page.evaluate(() => { const d = document.querySelector("#desk").getBoundingClientRect(), pics = [...document.querySelectorAll(".mv-pic")].map((e) => e.getBoundingClientRect());
    return { desk: [Math.round(d.left), Math.round(d.right), Math.round(d.bottom)], picsRight: Math.round(Math.max(...pics.map((r) => r.right))), picsBottom: Math.round(Math.max(...pics.map((r) => r.bottom))),
      sideways: document.documentElement.scrollWidth > innerWidth };
  });
  expect(mid.desk[1] <= 1280 && mid.desk[2] <= 720 && mid.picsRight <= mid.desk[0] && mid.picsBottom <= 720 && !mid.sideways, `1280x720: desk docked, four windows beside it on screen (${JSON.stringify(mid)})`);
  await page.screenshot({ path: path.join(shots, "multiview-1280.png") });

  // a phone: one column, no sideways scroll
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector("#mv-wall").classList.contains("one-col"), null, { timeout: 30000, polling: 250 }).catch(() => {});   // as above
  await page.waitForTimeout(800);
  const phone = await page.evaluate(() => ({ cols: getComputedStyle(document.querySelector("#mv-wall")).gridTemplateColumns.split(" ").length,
    sideways: document.documentElement.scrollWidth > innerWidth }));
  expect(phone.cols === 1 && !phone.sideways, `phone: one column, no sideways scroll (${JSON.stringify(phone)})`);
  await page.click("#desk-open");
  await page.waitForTimeout(400);
  const drawer = await page.evaluate(() => { const r = document.querySelector("#desk").getBoundingClientRect(); return { open: getComputedStyle(document.querySelector("#desk")).visibility === "visible", left: r.left, right: r.right }; });
  expect(drawer.open && drawer.left >= 0 && drawer.right <= 390, `phone: the Desk button opens the desk as a sheet (${JSON.stringify(drawer)})`);
  await page.screenshot({ path: path.join(shots, "multiview-390-desk.png") });
  await page.keyboard.press("Escape");
  await page.screenshot({ path: path.join(shots, "multiview-390.png"), fullPage: true });

  // The autoplay rule, on a fresh page. Playwright's evaluate counts as a user gesture, so until the clicks this
  // part reads the page only through CDP with userGesture false. Only real clicks on this page (a window, then
  // Play) may start the sound in the window's own document.
  const p2 = await ctx.newPage();
  p2.on("pageerror", (e) => fail(`page error: ${e.message}`));
  const cdp = await ctx.newCDPSession(p2);
  const raw = async (expression) => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, userGesture: false })).result.value;
  await p2.setViewportSize({ width: 1920, height: 1080 });
  await p2.goto(new URL("multiview.html?match=M001", base).href);
  for (let k = 0; k < 180 && !(await raw("!!window.multiview?.wins.every((w) => window.multiview.sd(w)?.voice && window.multiview.sd(w)?.booth)")); k++) await p2.waitForTimeout(500);
  const win = "window.multiview.wins[1].frame.contentWindow";
  expect(await raw(`!navigator.userActivation.hasBeenActive && !${win}.navigator.userActivation.hasBeenActive`), "fresh page: no user gesture yet, here or in window 2");
  const gated = await raw(`(() => { const c = new ${win}.AudioContext(); const s = c.state; c.close(); return s; })()`);
  const rule = gated === "suspended";
  if (rule) console.log("ok   before any click a new audio context in a window stays suspended: this browser applies the autoplay rule");
  else console.log(`SKIP this browser plays sound without a gesture (a new audio context is ${gated}): the autoplay rule is not tested in this run`);
  await p2.click(".mv-win:nth-child(2) .mv-hit");
  await p2.waitForTimeout(300);
  await p2.click("#mv-play");
  // the crowd bed is fetched and decoded on the first play: up to 10 s for a sound
  let heard;
  for (let k = 0; k < 20; k++) {
    await p2.waitForTimeout(500);
    heard = await raw(`window.multiview.wins.map((w) => { const b = window.multiview.sd(w).booth; return { ctx: b.ctx?.state ?? "none", ...b.status, active: w.frame.contentWindow.navigator.userActivation.hasBeenActive }; })`);
    if (heard[1].crowd + heard[1].lines > 0) break;
  }
  console.log(JSON.stringify(heard));
  expect(heard[1].active, "the click on this page reaches window 2's document as a user gesture");
  expect(heard[1].ctx === "running" && heard[1].crowd + heard[1].lines > 0, `${rule ? "under the autoplay rule, " : ""}window 2 plays after the clicks (ctx ${heard[1].ctx}, crowd ${heard[1].crowd}, lines ${heard[1].lines})`);
  expect(heard.every((h, i) => i === 1 || h.crowd + h.lines === 0), "the other three are silent");

  // with no parameters: the default match, its own away team in window 3, and 6 s before its own first goal
  const p3 = await ctx.newPage();
  p3.on("pageerror", (e) => fail(`page error: ${e.message}`));
  await p3.goto(new URL("multiview.html", base).href);
  await p3.waitForFunction(() => window.multiview?.wins.every((w) => window.multiview.sd(w)?.match), null, { timeout: 90000 });
  const dflt = await p3.evaluate(() => window.multiview.wins.map((w) => ({ match: window.multiview.sd(w).match.meta.match_id, audience: window.multiview.sd(w).state.audience, ts: window.multiview.sd(w).state.ts })));
  const goal4 = Math.min(...(await (await fetch(new URL("data/M004/facts.json", base))).json()).filter((f) => f.kind === "score").map((f) => f.ts));
  console.log(JSON.stringify(dflt));
  expect(dflt.every((d) => d.match === "M004") && dflt[2].audience === "team:T08", `no parameters: M004, window 3 for its away team T08 (${dflt[2].audience})`);
  expect(dflt.every((d) => Math.abs(d.ts - (Math.round(goal4) - 6)) < 0.01), `no parameters: the four start 6 s before M004's first goal (${dflt[0].ts})`);
  // this server draws in software: the large window stays 2D, and a line on it says why
  await p3.click(".mv-win:nth-child(2) .mv-hit");
  await p3.waitForTimeout(1500);
  const refused = await p3.evaluate(() => { const w = window.multiview.wins[1]; return { mode: window.multiview.sd(w).view3d.mode, scene: !!window.multiview.sd(w).view3d.scene, note: w.note.hidden ? null : w.note.textContent }; });
  expect(refused.mode === "2d" && !refused.scene && /2D only/.test(refused.note ?? ""), `no GPU: the large window stays 2D and says why (${JSON.stringify(refused)})`);

  // window 1 does not load: the desk is built on window 2, and the page keeps running
  // (multiview.js awaits meta and facts at top level, so window.multiview may come after the load event)
  const p5 = await ctx.newPage();
  p5.on("pageerror", (e) => fail(`page error with window 1 down: ${e.message}`));
  await p5.route((u) => u.pathname.endsWith("/index.html") && u.searchParams.get("audience") === "analyst", (r) => r.abort());
  await p5.goto(new URL("multiview.html?match=M001", base).href);
  const deskUp = await p5.waitForFunction(() => window.multiview?.desk?.ready && window.multiview.desk.state === window.multiview.sd(window.multiview.wins[1]).state, null, { timeout: 60000 })
    .then(() => true, () => false);
  expect(deskUp && await p5.locator("#desk .sec-needs").count() === 1, "window 1 down: the desk is built on window 2");
  await p5.close();

  // a match that is not there: an error on the wall, not "Loading" for ever (its 404s are expected here)
  const p4 = await ctx.newPage();
  await p4.goto(new URL("multiview.html?match=M999", base).href);
  const nf = await p4.waitForFunction(() => document.querySelector(".mv-error")?.textContent, null, { timeout: 10000 }).then((h) => h.jsonValue(), () => null);
  const clock = await p4.textContent("#mv-clock");
  expect(Boolean(nf) && clock !== "Loading", `a missing match says so (${nf}; clock ${clock})`);
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : "\nall multiview checks passed");
process.exit(failures.length ? 1 : 0);
