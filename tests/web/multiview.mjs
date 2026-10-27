// Browser check of the producer's multiviewer (web/multiview.html) on the M001 export.
//
//   WEBGL=2 scripts/with-lock.sh chromium tests/web/run-smoke.sh multiview.mjs   (Playwright image: it decodes MP3)
//
// At 1920x1080: the four windows load with their audience and language and show only the picture; the
// keyboard focus stays on this page; Play keeps the four within 0.5 s and a window pushed 3 s away is
// brought back; a goal button moves all four; a click on a window gives it the tally and its sound (the
// booth's audio context running, crowd or lines playing) and silences the others; a second window takes it
// over. Then the autoplay rule on a fresh page, read only through CDP until real clicks (Playwright's evaluate
// counts as a user gesture): a control first, an audio context made in a window before any click must stay
// suspended, or the browser does not apply the rule and the check says SKIP; then a click on a window and on
// Play must start that window's sound and no other.
// No console errors. Screenshots
// at 1920x1080 and 390x844: out/shots/multiview-*.png.
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

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
// static hosting: the desk's API calls 404 by design
page.on("console", (m) => { if (m.type() === "error" && !m.location().url.includes("/api/") && !/404/.test(m.text())) fail(`console: ${m.text()}`); });

const t0 = Date.now();
await page.goto(new URL("multiview.html", base).href);
// loaded: every window has its match and its voice (the voice comes last in app.js)
await page.waitForFunction(() => window.multiview?.wins.every((w) => window.multiview.sd(w)?.match && window.multiview.sd(w)?.voice), null, { timeout: 90000 });
console.log(`     four windows loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const times = () => page.evaluate(() => window.multiview.wins.map((w) => window.multiview.sd(w).state.ts));
const spread = (ts) => Math.max(...ts) - Math.min(...ts);

const setup = await page.evaluate(() => window.multiview.wins.map((w) => {
  const doc = w.frame.contentDocument, d = window.multiview.sd(w);
  return { audience: d.state.audience, lang: d.state.lang, ts: d.state.ts, controls: getComputedStyle(doc.querySelector("#controls")).display,
    desk: getComputedStyle(doc.querySelector("#desk")).display, frameW: doc.querySelector("#frame").offsetWidth, umd: w.name.textContent };
}));
console.log(JSON.stringify(setup));
const want = [["analyst", "en"], ["kids", "en"], ["team:T02", "it"], ["casual", "es"]];
expect(setup.every((s, i) => s.audience === want[i][0] && s.lang === want[i][1]), "each window has its audience and language");
expect(setup.every((s) => Math.abs(s.ts - 590) < 0.01), "each window starts at t=590");
expect(setup.every((s) => s.controls === "none" && s.desk === "none"), "inside a window: no controls, no desk");
expect(setup.every((s) => s.frameW === 960), "each picture fills its 960 px window");
expect(setup[2].umd === "Ostwick FC fan · IT", `the name strip names the team: ${setup[2].umd}`);
expect(await page.evaluate(() => !document.activeElement || document.activeElement.tagName !== "IFRAME"), "the keyboard focus stays on the multiviewer");
expect((await page.locator("#mv-goals button").count()) === 4, "four goal buttons");

// play: the four stay together
await page.click("#mv-play");
await page.waitForTimeout(3000);
// the sound: a click on window 3 gives it the tally and the audio, the others stay quiet
await page.click(".mv-win:nth-child(3) .mv-hit");
await page.waitForTimeout(3000);
let ts = await times();
console.log(`     after 6 s of play: ${ts.map((x) => x.toFixed(2)).join(" ")}`);
expect(ts.every((x) => x > 594), "all four play");
expect(spread(ts) <= 0.5, `the four within 0.5 s while playing (${spread(ts).toFixed(3)} s)`);
await page.screenshot({ path: path.join(shots, "multiview-1920.png") });

// a window pushed away is brought back
await page.evaluate(() => { const d = window.multiview.sd(window.multiview.wins[2]); d.seek(d.state.ts + 3); });
await page.waitForTimeout(500);
ts = await times();
expect(spread(ts) <= 0.5, `a window 3 s away is brought back (${spread(ts).toFixed(3)} s)`);

const audio = () => page.evaluate(() => window.multiview.wins.map((w) => {
  const d = window.multiview.sd(w);
  return { tally: w.fig.classList.contains("tally"), on: d.voice.on, ctx: d.booth?.ctx?.state ?? "none", ...(d.booth?.status ?? {}) };
}));
let a = await audio();
console.log(JSON.stringify(a));
expect(a.map((x) => x.tally).join() === "false,false,true,false", "window 3 has the tally");
expect(a.map((x) => x.on).join() === "false,false,true,false", "only window 3 has its sound on");
expect(a[2].ctx === "running", `window 3's audio context is running (${a[2].ctx})`);
expect(a[2].crowd + a[2].lines > 0, `window 3 plays the crowd or a line (crowd ${a[2].crowd}, lines ${a[2].lines})`);
// the meter follows the mix: its highest reading over 1 s
let bar = 0;
for (let k = 0; k < 10; k++) { bar = Math.max(bar, await page.evaluate(() => Number(/scaleY\(([\d.]+)\)/.exec(window.multiview.wins[2].bar.style.transform)?.[1] ?? 0))); await page.waitForTimeout(100); }
expect(bar > 0.1, `window 3's meter moves (up to ${bar})`);

await page.click(".mv-win:nth-child(1) .mv-hit");
await page.waitForTimeout(3000);
a = await audio();
console.log(JSON.stringify(a));
expect(a.map((x) => x.tally).join() === "true,false,false,false", "the tally moves to window 1");
expect(a.map((x) => x.on).join() === "true,false,false,false", "only window 1 has its sound on");
expect(a[0].ctx === "running" && a[0].crowd + a[0].lines > 0, `window 1 plays (ctx ${a[0].ctx}, crowd ${a[0].crowd}, lines ${a[0].lines})`);
expect(a[2].crowd + a[2].lines === 0, `window 3 is silent (crowd ${a[2].crowd}, lines ${a[2].lines})`);
ts = await times();
expect(spread(ts) <= 0.5, `still within 0.5 s with the reference on window 1 (${spread(ts).toFixed(3)} s)`);

// a goal button moves all four
await page.locator("#mv-goals button").nth(2).click();
await page.waitForTimeout(400);
ts = await times();
expect(ts.every((x) => x > 2900 && x < 3060) && spread(ts) <= 0.5, `the third goal button moves all four (${ts.map((x) => x.toFixed(1)).join(" ")})`);

// pause stops all four
await page.click("#mv-play");
await page.waitForTimeout(300);
expect(await page.evaluate(() => window.multiview.wins.every((w) => !window.multiview.sd(w).state.playing)), "pause stops all four");

// a phone: one column, no sideways scroll
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
const phone = await page.evaluate(() => ({ cols: getComputedStyle(document.querySelector("#mv-wall")).gridTemplateColumns.split(" ").length,
  sideways: document.documentElement.scrollWidth > innerWidth }));
expect(phone.cols === 1 && !phone.sideways, `phone: one column, no sideways scroll (${JSON.stringify(phone)})`);
await page.screenshot({ path: path.join(shots, "multiview-390.png"), fullPage: true });

// The autoplay rule, on a fresh page. Playwright's evaluate counts as a user gesture, so until the clicks this
// part reads the page only through CDP with userGesture false. Only real clicks on this page (a window, then
// Play) may start the sound in the window's own document.
const p2 = await ctx.newPage();
p2.on("pageerror", (e) => fail(`page error: ${e.message}`));
const cdp = await ctx.newCDPSession(p2);
const raw = async (expression) => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, userGesture: false })).result.value;
await p2.setViewportSize({ width: 1920, height: 1080 });
await p2.goto(new URL("multiview.html", base).href);
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

await browser.close();
console.log(failures.length ? `\n${failures.length} failure(s)` : "\nall multiview checks passed");
process.exit(failures.length ? 1 : 0);
