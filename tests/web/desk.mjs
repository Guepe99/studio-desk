// Browser test of the control desk against the real API (uvicorn), on the DEMO fixture.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh desk.mjs
//
// Runs the same story twice, at 1440x900 (desk docked) and 390x844 (desk in a drawer), each in a
// fresh browser context, so a fresh visitor session. Checks: a held story's graphic is not on air
// until approved and is after; reject takes an auto-approved story off air; an edit replaces the
// why-card body; the AI switch leaves only template graphics; Space inside the desk never toggles
// play; Italian and Spanish texts on the desk and the graphic; decisions survive a reload and do
// not reach another visitor; the audit log lists them. Screenshots: out/shots/desk-*.png.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8000/";
const url = new URL("?match=DEMO", base).href;
const shots = process.env.SHOTS ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });
const stories = await (await fetch(new URL("data/DEMO/stories.json", base))).json();
const cues = await (await fetch(new URL("data/DEMO/cues.json", base))).json();
const story = (kind) => stories.find((s) => s.kind === kind);
const HELD = story("key_pass"), AUTO = story("goal"), SWING = story("momentum_swing");
if (HELD.default_status !== "needs_review" || AUTO.default_status !== "auto_approved") throw new Error("DEMO stories changed: update desk.mjs");
const whyCue = (s, audience = "analyst") => cues.find((c) => c.story_id === s.story_id && c.graphic === "why_card" && c.audience === audience && c.lang === "en");
const TEMPLATE_TS = cues.find((c) => c.story_id === null && c.audience === "analyst" && c.lang === "en" && c.graphic !== "why_card").ts + 1;
const EDIT = "The desk rewrote this line by hand: a quick ball over the top and a clean finish.";

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const expect = (ok, msg) => { if (!ok) fail(msg); };

const live = (page) => page.evaluate(() => [...window.studioDesk.host.live.values()].map((i) => ({
  cue: i.cue.cue_id, story: i.cue.story_id, lang: i.cue.lang, body: i.el.shadowRoot?.querySelector(".body")?.textContent ?? null,
})));
const seekTo = async (page, ts) => {
  await page.evaluate((x) => { window.studioDesk.setPlaying(false); window.studioDesk.seek(x); }, ts);
  await page.waitForTimeout(300);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};
const onAirAt = async (page, s, audience = "analyst") => {
  const c = whyCue(s, audience);
  // a script click: on a phone the open drawer covers the controls
  await page.evaluate((a) => document.querySelector(`[data-audience="${a}"]`).click(), audience);
  await seekTo(page, c.ts + 2);
  return (await live(page)).find((x) => x.story === s.story_id) ?? null;
};
const card = (s) => `#story-${s.story_id}`;
const decide = async (page, s, cls) => {
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/decisions") && r.request().method() === "POST"),
    page.click(`${card(s)} .${cls}`),
  ]);
};

async function scenario(browser, w, h) {
  const phone = w < 1100, tag = `${w}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone });
  const page = await ctx.newPage();
  // voice.json is optional (docs/CONTRACT.md): a match without clips answers 404 and plays silent.
  const optional = (u) => u.endsWith("/voice.json");
  page.on("console", (m) => { if (m.type() === "error" && !optional(m.location().url || "")) fail(`${tag} console: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`${tag} page error: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 400 && !optional(r.url())) fail(`${tag} ${r.status()} ${r.url()}`); });
  await page.goto(url);
  await page.waitForFunction(() => window.studioDesk?.desk?.online, null, { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  await page.click('[data-audience="analyst"]');
  const frameBefore = await page.$eval("#frame", (el) => el.getBoundingClientRect().toJSON());
  const openDesk = async () => {
    if (!phone) return;
    if (!(await page.evaluate(() => document.body.classList.contains("desk-open")))) await page.click("#desk-open");
    await page.waitForTimeout(260);
  };
  const closeDesk = async () => {
    if (!phone || !(await page.evaluate(() => document.body.classList.contains("desk-open")))) return;
    await page.click("#desk-close");
    await page.waitForTimeout(260);
  };
  const shoot = async (name, el = card(HELD)) => {
    await openDesk();
    if (el) await page.$eval(el, (n) => n.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `${shots}/desk-${name}-${tag}.png` });
  };
  const shootAir = async (name) => {
    if (!phone) return; // docked: the broadcast is in the same screenshot
    await closeDesk();
    await page.screenshot({ path: `${shots}/desk-${name}-${tag}-air.png` });
  };

  if (phone) {
    expect(await page.$eval("#desk", (el) => getComputedStyle(el).visibility) === "hidden", `${tag}: drawer open before the Desk button`);
    expect(await page.$eval("#desk-open .count", (el) => el.textContent) === "3", `${tag}: Desk badge does not say 3 waiting`);
  }

  // 1. held until approved
  expect(!(await onAirAt(page, HELD)), `${tag}: ${HELD.story_id} needs review but its graphic is on air`);
  expect((await onAirAt(page, AUTO)) !== null, `${tag}: auto-approved ${AUTO.story_id} not on air`);
  await openDesk();
  await page.click(`${card(HELD)} summary`); // evidence open in the shot
  await seekTo(page, whyCue(HELD).ts + 2);
  await shoot("needs-review");
  expect(await page.$eval(`${card(HELD)} .tally`, (el) => el.textContent) === "Held", `${tag}: held story not marked Held`);
  expect(await page.$$eval(`${card(HELD)} .mini line.ev`, (n) => n.length) > 0, `${tag}: evidence pitch has no event arrow`);
  await decide(page, HELD, "act-approved");
  expect((await onAirAt(page, HELD)) !== null, `${tag}: ${HELD.story_id} approved but its graphic is not on air`);
  await shoot("approved");
  await shootAir("approved");

  // 2. edit replaces the why-card body for this visitor
  await openDesk();
  await page.click(`${card(AUTO)} .act-edited`);
  await page.fill(`${card(AUTO)} textarea`, EDIT);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/decisions") && r.request().method() === "POST"),
    page.click(`${card(AUTO)} .ctl.primary`),
  ]);
  const edited = await onAirAt(page, AUTO);
  expect(edited?.body === EDIT, `${tag}: edited body not on the graphic (${edited?.body})`);
  expect(await page.$eval(`${card(AUTO)} .story-text`, (el) => el.textContent) === EDIT, `${tag}: edited text not on the card`);
  await shoot("edited", card(AUTO));
  await shootAir("edited");

  // 3. reject takes an auto-approved story off air
  await openDesk();
  await decide(page, AUTO, "act-rejected");
  expect(!(await onAirAt(page, AUTO)), `${tag}: rejected ${AUTO.story_id} still on air`);
  expect(!(await onAirAt(page, AUTO, "casual")), `${tag}: rejected ${AUTO.story_id} on air for the casual audience`);
  await shoot("rejected", card(AUTO));

  // 4. Space on a desk button presses it and never toggles play
  await openDesk();
  const playing = await page.evaluate(() => window.studioDesk.state.playing);
  await page.focus(`${card(SWING)} .act-approved`);
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/decisions")), page.keyboard.press("Space")]);
  expect(await page.evaluate(() => window.studioDesk.state.playing) === playing, `${tag}: Space in the desk toggled play`);
  expect(await page.$eval(`${card(SWING)} .act-approved`, (el) => el.getAttribute("aria-pressed")) === "true", `${tag}: Space did not approve`);

  // 5. AI off: only template graphics
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/kill")), page.click("#ai-switch")]);
  expect(!(await onAirAt(page, HELD)), `${tag}: AI off but approved ${HELD.story_id} on air`);
  for (const ts of [whyCue(SWING).ts + 2, TEMPLATE_TS]) {
    await seekTo(page, ts);
    const l = await live(page);
    expect(l.every((x) => x.story === null), `${tag}: AI off but a story cue is on air at ${ts}`);
    if (ts === TEMPLATE_TS) expect(l.length > 0, `${tag}: AI off and no template graphic on air at ${ts} s`);
  }
  expect(await page.$eval("#ai-off", (el) => !el.hidden), `${tag}: no AI off badge on the broadcast`);
  await seekTo(page, TEMPLATE_TS);
  await shoot("kill", null);
  await shootAir("kill");
  await openDesk();
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/kill")), page.click("#ai-switch")]);
  expect((await onAirAt(page, HELD)) !== null, `${tag}: AI back on but ${HELD.story_id} not on air`);

  // 6. traces from a story card
  await openDesk();
  await page.click(`${card(HELD)} .link`);
  expect(await page.$eval("#tab-traces", (el) => el.getAttribute("aria-selected")) === "true", `${tag}: Show trace did not open Traces`);
  const chain = await page.$$eval(`[data-trace="${HELD.story_id}"] .chain li`, (n) => n.map((x) => x.dataset.agent));
  expect(chain[0] === "story_finder" && chain.at(-1) === "director" && chain.includes("verifier"), `${tag}: trace chain ${chain.join(",")}`);
  await shoot("traces", `[data-trace="${HELD.story_id}"]`);

  // 7. audit log
  await page.click("#tab-audit");
  const actions = await page.$$eval(".log tr.a-human td:nth-child(3)", (n) => n.map((x) => x.textContent));
  for (const a of ["approved", "edited", "rejected", "switched AI graphics off", "switched AI graphics on"]) {
    expect(actions.some((x) => x.startsWith(a)), `${tag}: audit has no "${a}" row`);
  }
  expect(await page.$$eval(".log tr.a-agent", (n) => n.length) > 0, `${tag}: audit has no agent rows`);
  await shoot("audit", null);

  // 8. languages: desk text and graphic body
  await page.click("#tab-stories");
  for (const lang of ["it", "es"]) {
    if (phone) await closeDesk();
    await page.selectOption("#lang", lang);
    await openDesk();
    const text = await page.$eval(`${card(HELD)} .story-text`, (el) => [el.lang, el.textContent]);
    expect(text[0] === lang && text[1] === HELD.texts[lang], `${tag} ${lang}: card text ${JSON.stringify(text)}`);
    const g = await onAirAt(page, HELD);
    const want = cues.find((c) => c.story_id === HELD.story_id && c.lang === lang).payload.body;
    expect(g?.lang === lang && g?.body === want, `${tag} ${lang}: graphic ${JSON.stringify(g)}`);
    // the English edit stays English: the Italian/Spanish card shows the original translation
    expect(await page.$eval(`${card(AUTO)} .story-text`, (el) => el.textContent) === AUTO.texts[lang], `${tag} ${lang}: edit leaked into ${lang}`);
    await shoot(lang);
    await shootAir(lang);
  }
  if (phone) await closeDesk();
  await page.selectOption("#lang", "en");

  // 9. the broadcast never moved
  const frameAfter = await page.$eval("#frame", (el) => el.getBoundingClientRect().toJSON());
  expect(JSON.stringify(frameBefore) === JSON.stringify(frameAfter), `${tag}: the broadcast frame moved ${JSON.stringify([frameBefore, frameAfter])}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tag}: horizontal scroll`);

  // 10. decisions survive a reload; another visitor sees the original replay
  await page.reload();
  await page.waitForFunction(() => window.studioDesk?.desk?.online, null, { timeout: 15000 });
  const mine = await page.evaluate(() => Object.fromEntries([...window.studioDesk.desk.decisions].map(([k, v]) => [k, v.decision])));
  expect(mine[HELD.story_id] === "approved" && mine[AUTO.story_id] === "rejected" && mine[SWING.story_id] === "approved", `${tag}: after reload ${JSON.stringify(mine)}`);
  const other = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  await other.goto(url);
  await other.waitForFunction(() => window.studioDesk?.desk?.online, null, { timeout: 15000 });
  expect(await other.evaluate(() => window.studioDesk.desk.decisions.size) === 0, `${tag}: another visitor sees decisions`);
  expect(!(await onAirAt(other, HELD)) && (await onAirAt(other, AUTO)) !== null, `${tag}: another visitor's replay changed`);
  await other.context().close();
  await ctx.close();
}

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    try { await scenario(browser, w, h); } catch (e) { fail(`${w}: ${e.message.split("\n").slice(0, 8).join(" | ")}`); }
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.log(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log("desk ok");
