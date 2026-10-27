// Browser check of the highlights reel (web/js/highlights.js) on the M001 replay.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh highlights.mjs
//
// 2D, English: More > Highlights: full match starts at the 8' chance, cuts to 6 s before the 10' goal's shot,
// the strip says the goal and then the score, Stop goes back to where the viewer was (0', paused, 4x).
// 3D, Italian: the second half reel starts on the 50' goal with the Italian strip and stops on Stop.
// At half-time a button beside the recap offers the first half reel, at full time the full match.
// Fails on any console error. A 1920x1080 screenshot during the goal goes to out/shots/highlights.png.
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
const ok = (cond, msg) => { if (!cond) { failures.push(msg); console.log(`FAIL ${msg}`); } else console.log(`ok   ${msg}`); };
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();

async function open(query) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  // with static hosting the desk's api/ calls 404, as in smoke.mjs; voice.json and booth.json are optional
  const apiMiss = (m) => /\/api\/|\/(voice|booth)\.json$/.test(m.location()?.url ?? "");
  page.on("console", (m) => { if (m.type() === "error" && !apiMiss(m)) failures.push(`console: ${m.text()} ${m.location()?.url ?? ""}`); });
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  await page.goto(new URL(`?match=M001&${query}`, base).href);
  await page.waitForFunction(() => window.studioDesk?.desk?.loaded, null, { timeout: 60000 });
  return { ctx, page };
}
const sd = (page, fn) => page.evaluate(fn);
// the strip and the Stop button are filled on the next frame
const filled = (page) => page.waitForFunction(() => document.querySelector("#hl-strip .hl-what").textContent, null, { timeout: 10000 });
async function pick(page, part) {
  await page.click("#settings");
  await page.click(`[data-highlights="${part}"]`);
  await filled(page);
}

{
  const { ctx, page } = await open("view=2d");
  ok(await page.locator("#hl-strip").isHidden() && await page.locator("#hl-stop").isHidden(), "2D: nothing of the reel shows before it is used");
  await page.click("#settings");
  await page.click('[data-speed="4"]');
  await page.keyboard.press("Escape");
  await pick(page, "full");
  const s0 = await sd(page, () => ({ ...window.studioDesk.state }));
  ok(Math.abs(s0.ts - (470.1 - 6)) < 1 && s0.playing && s0.speed === 1, `2D: full match starts 6 s before the 8' chance at 1x (ts ${s0.ts.toFixed(1)})`);
  ok(/Big chance, .*8'/.test(await page.locator("#hl-strip .hl-what").textContent()), "2D: the strip says Big chance and the minute");
  ok(/Stop highlights 1\/10/.test(await page.locator("#hl-stop").textContent()), "2D: Stop says 1 of 10");
  // the cut to the first goal: 6 s before Okowande's shot at 595.02
  await page.waitForFunction(() => window.studioDesk.state.ts >= 589 && window.studioDesk.state.ts < 600, null, { timeout: 30000 });
  const what = await page.locator("#hl-strip .hl-what").textContent();
  ok(/^Goal, .*\(RED\), 10'$/.test(what), `2D: after the cut the strip says the goal (${what})`);
  ok(await page.locator("#hl-strip .hl-score").isHidden(), "2D: no score before the ball is in");
  await page.waitForFunction(() => window.studioDesk.state.ts >= 597, null, { timeout: 15000 });
  ok((await page.locator("#hl-strip .hl-score").textContent()) === "RED 1-0 OST", "2D: the score after the goal, from the fact ledger");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shots}/highlights.png` });
  await page.click("#hl-stop");
  const s1 = await sd(page, () => ({ ...window.studioDesk.state }));
  ok(s1.ts === 0 && !s1.playing && s1.speed === 4, "2D: Stop goes back to 0', paused, at 4x");
  ok(await page.locator("#hl-strip").isHidden() && await page.locator("#hl-stop").isHidden(), "2D: Stop takes the strip and the button off");
  await ctx.close();
}

{
  const { ctx, page } = await open("view=3d&lang=it");
  await page.waitForFunction(() => window.studioDesk.view3d?.shown === "3d", null, { timeout: 60000 }).catch(() => {});
  const shown = await sd(page, () => window.studioDesk.view3d?.shown);
  ok(shown === "3d", `3D: the 3D view is on (${shown})`);
  await page.click("#settings");
  ok((await page.locator('[data-highlights="h2"]').textContent()) === "Highlights: secondo tempo", "3D: the menu item in Italian");
  await page.click('[data-highlights="h2"]');
  await filled(page);
  const ts = await sd(page, () => window.studioDesk.state.ts);
  ok(Math.abs(ts - (3051.61 - 6)) < 1, `3D: the second half reel opens 6 s before the 50' goal (ts ${ts.toFixed(1)})`);
  ok(/^Gol, .*50'$/.test(await page.locator("#hl-strip .hl-what").textContent()), "3D: the strip in Italian");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/highlights-3d.png` });
  await page.click("#hl-stop");
  ok(await sd(page, () => window.studioDesk.state.ts) === 0, "3D: Stop goes back to 0'");
  await ctx.close();
}

{
  // the offer beside the recap: at half-time a button for the first half reel, no autoplay; pressing it plays the reel
  const { ctx, page } = await open("view=2d");
  const p1 = await sd(page, () => window.studioDesk.match.meta.period1_s);
  ok(await page.locator("#hl-offer").isHidden(), "offer: no button during play");
  await sd(page, () => window.studioDesk.seek(window.studioDesk.match.meta.period1_s + 1));
  await page.waitForFunction(() => !document.querySelector("#hl-offer").hidden, null, { timeout: 10000 });
  ok((await page.locator("#hl-offer").textContent()) === "Watch the first half highlights", "offer: at half-time the button offers the first half");
  ok(!(await sd(page, () => window.studioDesk.state.playing)), "offer: nothing plays by itself");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/highlights-offer.png` });
  await page.click("#hl-offer");
  await filled(page);
  const s = await sd(page, () => ({ ...window.studioDesk.state }));
  ok(Math.abs(s.ts - (470.1 - 6)) < 1 && s.playing, `offer: the button starts the first half reel (ts ${s.ts.toFixed(1)})`);
  ok(await page.locator("#hl-offer").isHidden(), "offer: the button goes while the reel plays");
  await page.click("#hl-stop");
  ok(Math.abs(await sd(page, () => window.studioDesk.state.ts) - (p1 + 1)) < 0.5, "offer: Stop goes back to half-time");
  await sd(page, () => window.studioDesk.seek(window.studioDesk.match.duration + 1));
  await page.waitForFunction(() => document.querySelector("#hl-offer").textContent === "Watch the match highlights", null, { timeout: 10000 });
  ok(true, "offer: at full time the button offers the full match");
  await ctx.close();
}

await browser.close();
if (failures.length) { console.log(`\n${failures.length} failure(s):\n${failures.join("\n")}`); process.exit(1); }
console.log("\nhighlights: all checks passed");
