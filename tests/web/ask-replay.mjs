// Browser test of "Watch it" on an Ask the studio answer (web/js/ask.js), on M001 with api/ask stubbed as
// smoke.mjs does (the static site has no API: no model, no Content Safety, nothing reaches Azure).
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh ask-replay.mjs
//
// Checks, in the 2D view and in the 3D view: a question asked after the first goal gets one "Watch it: goal, 10'"
// button; pressing it lands LEAD_S before the goal's shot and plays; an answer citing no event gets no button;
// a rewind before the moment's lead-in hides the button. Screenshot: out/shots/ask-replay-*.png.
// At 1440x900 the newest answer is scrolled into view in the panel (out/shots/ask-1440-*.png).
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8000/";
const shots = process.env.SHOTS ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

// "goal" cites the first score fact; anything else the first possession fact, which has no event behind it
const stub = (p) => p.route("**/api/ask", async (r) => {
  if (r.request().method() === "GET") return r.fulfill({ json: { available: true } });
  const { question } = JSON.parse(r.request().postData() || "{}");
  const fact = await p.evaluate((kind) => window.studioDesk.match.facts.find((f) => f.kind === kind).fact_id,
    question === "goal" ? "score" : "team_possession");
  return r.fulfill({ json: { status: "answered", answer: "An answer from the facts.", fact_ids: [fact], questions_left: 9 } });
});

async function ask(p, q) {
  const n = await p.locator("#ask-log li").count();
  await p.fill("#ask-q", q);
  await p.press("#ask-q", "Enter");
  await p.waitForFunction((k) => document.querySelectorAll("#ask-log li").length > k, n, { timeout: 5000 });
}

try {
  // at 1440x900 the panel opens at the foot of the desk column and the log sits under the suggestions: the newest
  // answer is scrolled into view, at once under prefers-reduced-motion and smoothly otherwise
  for (const reducedMotion of ["reduce", "no-preference"]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => check(false, `1440 ${reducedMotion}: page error ${e.message}`));
    await stub(p);
    await p.goto(new URL("?match=M001&lang=en&view=2d", base).href);
    await p.waitForFunction(() => window.studioDesk?.match, null, { timeout: 20000 });
    await p.locator("#ask-open").waitFor({ state: "visible", timeout: 20000 });
    await p.evaluate(() => { window.studioDesk.setPlaying(false); window.studioDesk.seek(2400); });
    await p.click("#ask-open");
    for (const q of ["possession", "goal", "possession"]) await ask(p, q);
    if (reducedMotion !== "reduce") await p.waitForTimeout(1200);
    const seen = await p.evaluate(() => {
      const li = document.querySelector("#ask-log li").getBoundingClientRect(), box = document.querySelector("#ask").getBoundingClientRect();
      return li.top >= box.top - 1 && li.bottom <= box.bottom + 1 && li.top >= 0 && li.bottom <= innerHeight + 1;
    });
    check(seen, `1440 ${reducedMotion}: the newest answer is in view in the panel`);
    await p.screenshot({ path: path.join(shots, `ask-1440-${reducedMotion}.png`) });
    await ctx.close();
  }
  for (const view of ["2d", "3d"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => check(false, `${view}: page error ${e.message}`));
    await stub(p);
    await p.goto(new URL(`?match=M001&lang=en&view=${view}`, base).href);
    await p.waitForFunction(() => window.studioDesk?.match, null, { timeout: 20000 });
    await p.locator("#ask-open").waitFor({ state: "visible", timeout: 20000 });
    const goal = await p.evaluate(() => {
      const d = window.studioDesk, f = d.match.facts.find((x) => x.kind === "score");
      const shot = d.match.events.find((e) => e.event_id === f.source_event_ids[0]);
      d.setPlaying(false);
      d.seek(f.ts + 60);
      return { ts: shot.ts, minute: d.match.clock(shot.ts).label };
    });
    await p.click("#ask-open");
    await ask(p, "possession");
    check(await p.locator(".ask-watch").count() === 0, `${view}: an answer with no event behind it has no button`);
    await ask(p, "goal");
    const btn = p.locator("#ask-log li").first().locator("button.ask-watch");
    check(await btn.count() === 1 && await p.locator(".ask-watch").count() === 1, `${view}: one Watch it button, on the goal answer`);
    const label = await btn.textContent();
    check(label === `Watch it: goal, ${goal.minute}'`, `${view}: the button names the moment ("${label}")`);
    check(await p.locator(".ask-a").first().textContent() === "An answer from the facts.", `${view}: the answer text is unchanged`);
    await btn.scrollIntoViewIfNeeded();
    await p.screenshot({ path: path.join(shots, `ask-replay-${view}.png`) });
    await btn.focus();
    await p.keyboard.press("Enter");
    const after = await p.evaluate(() => ({ ts: window.studioDesk.state.ts, playing: window.studioDesk.state.playing }));
    const lead = goal.ts - after.ts;
    check(after.playing && lead > 5 && lead <= 6.5, `${view}: the press plays from ${lead.toFixed(2)} s before the goal's shot`);
    check(await p.evaluate(() => document.activeElement?.classList.contains("ask-watch")), `${view}: the focus stays on the button`);
    await p.evaluate(() => { window.studioDesk.setPlaying(false); window.studioDesk.seek(60); });
    await p.waitForFunction(() => !document.querySelector(".ask-watch"), null, { timeout: 3000 }).catch(() => {});
    check(await p.locator(".ask-watch").count() === 0, `${view}: a rewind before the goal hides the button`);
    await ctx.close();
  }
} catch (e) {
  fails.push(String(e));
  console.error(e);
}
await browser.close();
if (fails.length) { console.error(`ask-replay: ${fails.length} failed`); process.exit(1); }
console.log("ask-replay: all checks passed");
