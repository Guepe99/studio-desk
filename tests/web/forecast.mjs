// Watch for on the broadcast page (web/js/forecast.js), in the browser, on M001: closed until the visitor opens
// it (at 1920x1080 and at 1440x900, where it must not lie over the stories), opened at 12', after the first
// goal and before the same player's second (13'). Not pre-approved, nothing prepared airs on the goal. Then the
// producer pre-approves the "Second goal" line, the match plays on, and at the goal the prepared line is on
// air as a why_card with the minute and score filled, logged in the audit trail as prepared text.
// Screenshot (1920x1080): out/shots/forecast.png, with the card on air and the panel open.
//
//   WEBGL=0 MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh forecast.mjs
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
const ID = "W-second_goal-T01-9", CUE = `P-${ID}`, GOAL = 772.6;
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
page.setDefaultTimeout(120000);
page.on("pageerror", (e) => check(false, `page error ${e.message}`));
await page.goto(new URL("index.html?match=M001&view=2d&lang=en&t=700", base).href);
await page.waitForFunction(() => window.studioDesk?.desk.loaded && window.studioDesk.watch);
await page.evaluate(() => document.fonts.ready);

// play from `from` until the clock passes `to`
async function playThrough(from, to) {
  await page.evaluate((t) => { window.studioDesk.seek(t); window.studioDesk.setPlaying(true); }, from);
  await page.waitForFunction((t) => window.studioDesk.state.ts > t, to, { timeout: 60000 });
}
const onAir = () => page.evaluate((id) => {
  const i = window.studioDesk.host.live.get(id);
  return i ? { ts: i.cue.ts, text: i.el.shadowRoot?.textContent ?? "", prepared: i.cue.payload.prepared } : null;
}, CUE);

check(await page.evaluate(() => document.querySelector(".watch").open === false), "closed until the visitor opens it");
await page.locator(".watch > summary").click();
const item = page.locator(`.watch [data-watch="${ID}"]`).first();
check(await item.isVisible(), "the panel lists the second goal to watch for");
const word = await item.locator(".w-p").textContent();
check(word === "Unlikely" && !/%/.test(await page.locator(".watch").innerText()), `with a word, no percentage on screen: "${word}"`);
const line = await item.locator(".w-line").textContent();
check((await item.locator(".w-slot").count()) === 2 && /in the minute it comes: the new score\.$/.test(line),
  `and its prepared line as a sentence, the two slots underlined words: "${line}"`);
// Ostwick's first shot is at 7:50: paused at 7:56 the panel already counts it
await page.evaluate(() => { window.studioDesk.setPlaying(false); window.studioDesk.seek(476); });
await page.waitForFunction(() => /Ostwick: 1 shot/.test(document.querySelector(".watch").textContent));
check(true, "paused at 7:56: \"Ostwick: 1 shot\", not a step behind");

// not pre-approved: the goal comes and nothing prepared airs
await playThrough(GOAL - 3, GOAL + 1.5);
check((await onAir()) === null, "not pre-approved: nothing prepared on air at the goal");
await page.evaluate(() => window.studioDesk.setPlaying(false));

// back before the goal, pre-approve, play through it
await page.evaluate(() => window.studioDesk.seek(700));
await page.waitForFunction((id) => document.querySelector(`.watch button[data-watch="${id}"]`), ID);
await page.locator(`.watch button[data-watch="${ID}"]`).click();
// the panel redraws on the next frame (Watch.update), not inside the click
const pressed = await page.waitForFunction((id) => document.querySelector(`.watch button[data-watch="${id}"]`)?.getAttribute("aria-pressed") === "true", ID, { timeout: 5000 })
  .then(() => true, () => false);
check(pressed, "pre-approved: the button says so (aria-pressed)");
await playThrough(GOAL - 3, GOAL + 2);
const card = await onAir();
check(!!card && card.prepared === true && Math.abs(card.ts - GOAL) < 0.01, `pre-approved: on air at the goal's own time (${card?.ts})`);
check(/strikes again in the 13th minute/.test(card?.text ?? ""), `with the minute and score filled: "${(card?.text ?? "").trim().slice(0, 120)}"`);
await page.evaluate(() => window.studioDesk.setPlaying(false));
const audit = await page.evaluate((id) => window.studioDesk.desk.localAudit.filter((r) => r.story_id === id).map((r) => [r.action, r.ts, r.detail.prepared]), ID);
check(audit.some(([a, ts, p]) => a === "prepared_aired" && Math.abs(ts - GOAL) < 0.01 && p === true), `logged as prepared text at the goal: ${JSON.stringify(audit)}`);
check(audit.some(([a]) => a === "prepared_approved"), "and the pre-approval before it");
check(await page.locator(`.watch .w-done[data-watch="${ID}"] .w-out`).textContent() === "Prepared line on air", "the panel says it went on air");
await page.locator(".watch").scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(shots, "forecast.png") });

// the audit tab lists it in words
await page.evaluate(() => { const d = window.studioDesk.desk; d.tab = "audit"; d.render(); });
check(await page.locator(".audit .mine li", { hasText: "Prepared text on air: Second goal" }).count() === 1, "the audit tab: \"Prepared text on air: Second goal\"");

await ctx.close();

// 1440x900, the panel open and a story's Details open: no heading of the stories lies under the panel
const small = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const p2 = await small.newPage();
await p2.goto(new URL("index.html?match=M001&view=2d&lang=en&t=700", base).href);
await p2.waitForFunction(() => window.studioDesk?.desk.loaded && window.studioDesk.watch && document.querySelector(".watch summary"));
check(await p2.evaluate(() => document.querySelector(".watch").open === false), "1440x900: closed by default");
await p2.evaluate(() => { document.querySelector(".watch").open = true; document.querySelector("#desk-body details, .desk-body details")?.setAttribute("open", ""); });
await p2.waitForTimeout(300);
const covered = await p2.evaluate(() => [...document.querySelectorAll("#desk .sec > h3")].filter((hd) => {
  const b = hd.getBoundingClientRect(), w = document.querySelector(".watch").getBoundingClientRect();
  return b.height && b.bottom > w.top && b.top < w.bottom;
}).map((hd) => hd.textContent.trim()));
check(covered.length === 0, `1440x900, panel and Details open: no section heading under the panel ${JSON.stringify(covered)}`);
await small.close();
await browser.close();
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
