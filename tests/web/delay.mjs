// Browser check of the broadcast delay (web/js/delay.js, docs/delay.md) on M001, 2D view.
//
//   WEBGL=0 MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh delay.mjs
//
// At delay=10 the 10' goal's graphic (shot at 595.02, aired at 596.02) lands within 1 s of the shot on the
// picture, and the desk lists the goal before the picture reaches it; at delay=0 it lands as today. The tag
// under the score bug says the delay, in the page language; the settings menu changes it and the page
// reloads at the same moment. A 1920x1080 screenshot with the graphic on goes to out/shots/delay.png.
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
const SHOT = 595.02, GOAL = "S-000002";   // M001: the 10' goal, from events.json and stories.json

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const check = async (name, fn) => { try { await fn(); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); } };

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
const open = async (query) => {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const apiMiss = (m) => /\/api\/|\/(voice|booth)\.json$/.test(m.location()?.url ?? "");
  page.on("console", (m) => { if (m.type() === "error" && !apiMiss(m)) fail(`console: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  await page.goto(new URL(`?match=M001&view=2d&${query}`, base).href);
  await page.waitForFunction(() => window.studioDesk?.match && window.studioDesk.desk.loaded, null, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  return page;
};
// plays from the current time and returns the picture time of the first frame with the goal's first graphic on
const landing = (page) => page.evaluate((goal) => new Promise((resolve, reject) => {
  const sd = window.studioDesk, stop = setTimeout(() => reject(new Error("no goal graphic within 20 s")), 20000);
  sd.setPlaying(true);
  const look = () => {
    const on = [...sd.host.live.values()].find((i) => i.cue.story_id === goal);
    if (on) { clearTimeout(stop); resolve({ ts: sd.state.ts, graphic: on.cue.graphic }); } else requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}), GOAL);
const listed = (page) => page.evaluate((goal) => window.studioDesk.desk.shown().some((s) => s.story_id === goal), GOAL);
const badge = (page) => page.evaluate(() => { const b = document.querySelector("#delay-badge"); return { hidden: b.hidden, text: b.textContent, w: b.offsetWidth }; });

try {
  await check("delay 10", async () => {
    const page = await open("delay=10&t=586");
    if ((await page.evaluate(() => window.studioDesk.delay)) !== 10) fail("delay 10: studioDesk.delay is not 10");
    const b = await badge(page);
    if (b.hidden || b.text !== "Delay 10 s" || !b.w) fail(`delay 10: badge ${JSON.stringify(b)}`);
    if (!(await listed(page))) fail("delay 10: the goal is not on the desk 9 s before the picture reaches it");
    const at = await landing(page);
    console.log(`delay 10: ${at.graphic} on the picture at ${at.ts.toFixed(2)}, shot at ${SHOT} (${(at.ts - SHOT).toFixed(2)} s)`);
    if (Math.abs(at.ts - SHOT) > 1) fail(`delay 10: goal graphic at ${at.ts.toFixed(2)}, more than 1 s from the shot at ${SHOT}`);
    // the screenshot with the graphic fully in, as a viewer sees it
    await page.waitForFunction((s) => window.studioDesk.state.ts >= s + 1.5, SHOT, { timeout: 10000 });
    await page.evaluate(() => window.studioDesk.setPlaying(false));
    await page.screenshot({ path: path.join(shots, "delay.png") });
    // the menu: 15 s reloads at the same moment with the new delay
    await page.click("#settings");
    const before = await page.evaluate(() => window.studioDesk.state.ts);
    await Promise.all([page.waitForURL(/delay=15/), page.click('#settings-menu [data-delay="15"]')]);
    await page.waitForFunction(() => window.studioDesk?.match, null, { timeout: 20000 });
    const after = await page.evaluate(() => ({ ts: window.studioDesk.state.ts, delay: window.studioDesk.delay, checked: document.querySelector('[data-delay="15"]').getAttribute("aria-checked") }));
    if (after.delay !== 15 || after.checked !== "true" || Math.abs(after.ts - before) > 0.2) fail(`menu 15 s: ${JSON.stringify({ before, ...after })}`);
    if ((await badge(page)).text !== "Delay 15 s") fail("menu 15 s: badge text");
    await page.click("#settings");
    await Promise.all([page.waitForURL((u) => !u.search.includes("delay=")), page.click('#settings-menu [data-delay="0"]')]);
    await page.waitForFunction(() => window.studioDesk?.match, null, { timeout: 20000 });
    if (!(await badge(page)).hidden) fail("menu 0 s: the badge still shows");
    await page.context().close();
  });

  await check("delay 0", async () => {
    const page = await open("t=586");
    if (!(await badge(page)).hidden) fail("delay 0: badge shows");
    if (await listed(page)) fail("delay 0: the goal is listed before it happens");
    const at = await landing(page);
    console.log(`delay 0: ${at.graphic} on the picture at ${at.ts.toFixed(2)}, shot at ${SHOT} (${(at.ts - SHOT).toFixed(2)} s)`);
    if (at.ts < 596.02 - 0.05) fail(`delay 0: goal graphic at ${at.ts.toFixed(2)}, before its cue at 596.02`);
    await page.context().close();
  });

  await check("italian", async () => {
    const page = await open("delay=5&lang=it&t=100");
    const b = await badge(page);
    if (b.hidden || b.text !== "Ritardo 5 s") fail(`italian: badge ${JSON.stringify(b)}`);
    await page.context().close();
  });
} finally {
  await browser.close();
}

if (failures.length) { console.log(`${failures.length} failure(s)`); process.exit(1); }
console.log("delay ok");
