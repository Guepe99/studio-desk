// The first visit's welcome (web/js/welcome.js) on the page as a judge opens it: no URL parameters, so M001.
//
//   WEBGL=0 scripts/with-lock.sh chromium tests/web/run-smoke.sh welcome.mjs
//
// Checks: a fresh visit shows the panel with the focus on the first goal button; the button lands within
// 20 s before the first goal of M001 (LEAD_S before its play), playing, with the voice turned on; Escape
// closes it and a reload does not show it again; a deep link never shows it. Screenshot: out/shots/welcome.png.
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
const facts = await (await fetch(new URL("data/M001/facts.json", base))).json();
const goalTs = Math.min(...facts.filter((f) => f.kind === "score").map((f) => f.ts));

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
const open = async (query) => {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const optional = (m) => /\/api\/|\/(voice|booth)\.json$/.test(m.location()?.url ?? "");
  page.on("console", (m) => { if (m.type() === "error" && !optional(m)) fail(`${query} console: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`${query} page error: ${e.message}`));
  await page.goto(new URL(query, base).href);
  await page.waitForFunction(() => window.studioDesk?.match, null, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  return page;
};
const shown = (page) => page.$eval("#welcome", (d) => d.open);

try {
  // fresh visit: the panel, the focus on its primary button, then the first goal with play and sound on
  let page = await open("");
  if (!(await shown(page))) fail("fresh visit: no welcome panel");
  if ((await page.evaluate(() => document.activeElement?.id)) !== "welcome-goal") fail("fresh visit: focus not on the first goal button");
  await page.waitForTimeout(1500);   // the stories and the 2D picture settle behind the backdrop
  await page.screenshot({ path: `${shots}/welcome.png` });
  await page.click("#welcome-goal");
  const s = await page.evaluate(() => ({ ts: window.studioDesk.state.ts, playing: window.studioDesk.state.playing }));
  if (await shown(page)) fail("after the first goal button: the panel is still open");
  if (!(s.ts < goalTs && s.ts >= goalTs - 20)) fail(`first goal button landed at ${s.ts.toFixed(1)} s, first goal at ${goalTs.toFixed(1)} s`);
  if (!s.playing) fail("first goal button: not playing");
  await page.waitForFunction(() => window.studioDesk.voice?.on === true, null, { timeout: 15000 }).catch(() => fail("first goal button: voice not on"));
  console.log(`first goal at ${goalTs.toFixed(1)} s, landed at ${s.ts.toFixed(1)} s, playing ${s.playing}`);
  await page.context().close();

  // Escape closes it, and it does not come back on the next visit in the same browser
  page = await open("");
  await page.keyboard.press("Escape");
  if (await shown(page)) fail("Escape: the panel is still open");
  if (await page.evaluate(() => window.studioDesk.state.playing)) fail("Escape: the replay started");
  await page.reload();
  await page.waitForFunction(() => window.studioDesk?.match, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  if (await shown(page)) fail("second visit: the panel came back");
  await page.context().close();

  // a deep link: no panel
  for (const q of ["?match=M001&t=590", "?match=M002"]) {
    page = await open(q);
    await page.waitForTimeout(300);
    if (await shown(page)) fail(`${q}: the panel showed on a deep link`);
    await page.context().close();
  }
} finally {
  await browser.close();
}
if (failures.length) { console.log(`${failures.length} failure(s)`); process.exit(1); }
console.log("welcome ok");
