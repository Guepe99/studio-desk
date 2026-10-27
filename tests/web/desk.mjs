// Browser test of the control desk against the real API (uvicorn), on the DEMO fixture.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh desk.mjs
//   MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh desk.mjs   (the structure checks on a real replay)
//
// The design and its sources: docs/desk.md. Runs the same story twice, at 1440x900 (desk docked) and
// 390x844 (a bottom sheet), each in a fresh browser context, so a fresh visitor session. Checks:
// - the desk lists only what the match has reached plus the 60 s look-ahead, marked Next (and on M002:
//   no 17' card at 11', then it appears); three sections, On air now (generated graphics too, with Take out),
//   Needs you and Done, whose counts match their items; at most one filled button per card, exactly
//   one ("Put on air") on a held card, none on a Done row or an on-air row
// - a card shows the kicker, headline and body that air, and an edit of the headline reaches the graphic
// - a held story's graphic is not on air until approved and is after; reject takes an auto-approved
//   story off air; the AI switch leaves only template graphics; Use proposal; Space never toggles play
// - keys A, E, R, J, K, U and ? (the broadcast's key list) work with the focus in the desk and do
//   nothing while typing; after a decision the focus moves to the next waiting card
// - Details is one level (no nested disclosure), built when opened, and the actions stay in view
//   with it open; no fact id anywhere in the desk's text
// - Undo stays with its message until the next decision; the reason chips sit under the message
//   and reach the audit, which lists your actions first in match minutes
// - Italian and Spanish on the desk and the graphic; decisions survive a reload and do not reach
//   another visitor; on a phone the sheet leaves at least 40% of the height to the broadcast
// Screenshots: out/shots/desk-*.png (SHOTS=dir to put them elsewhere).
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8000/";
const MATCH = process.env.MATCH ?? "DEMO";
const url = new URL("?match=DEMO", base).href;
const shots = process.env.SHOTS ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });
const getJson = async (m, f) => (await fetch(new URL(`data/${m}/${f}`, base))).json();
const stories = await getJson("DEMO", "stories.json");
const cues = await getJson("DEMO", "cues.json");
const story = (kind) => stories.find((s) => s.kind === kind);
const HELD = story("key_pass"), AUTO = story("goal"), SWING = story("momentum_swing"), BACK = story("comeback");
if (HELD.default_status !== "needs_review" || AUTO.default_status !== "auto_approved" || BACK.default_status !== "needs_review") throw new Error("DEMO stories changed: update desk.mjs");
const whyCue = (s, audience = "analyst", lang = "en") => cues.find((c) => c.story_id === s.story_id && c.graphic === "why_card" && c.audience === audience && c.lang === lang);
const firstCue = (all, id) => Math.min(...all.filter((c) => c.story_id === id).map((c) => c.ts));
const TEMPLATE_TS = cues.find((c) => c.story_id === null && c.audience === "analyst" && c.lang === "en" && c.graphic !== "why_card").ts + 1;
// a template graphic on screen while the held story waits (the momentum card after the key pass)
const MOMENTUM = cues.find((c) => c.story_id === null && c.graphic === "momentum" && c.audience === "analyst" && c.lang === "en");
const ALL = firstCue(cues, BACK.story_id) + 22; // every story reached, nothing on screen
const LOOKAHEAD = 60;
const EDIT = "The desk rewrote this line by hand: a quick ball over the top and a clean finish.";
const EDIT_TITLE = "A finish from the desk";
const FACT_ID = /F-[A-Z0-9_]+-\d+/;

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const expect = (ok, msg) => { if (!ok) fail(msg); };

const live = (page) => page.evaluate(() => [...window.studioDesk.host.live.values()].map((i) => ({
  cue: i.cue.cue_id, story: i.cue.story_id, lang: i.cue.lang, body: i.el.shadowRoot?.querySelector(".body")?.textContent ?? null,
  title: i.el.shadowRoot?.querySelector(".title")?.textContent ?? null, kicker: i.el.shadowRoot?.querySelector(".kicker")?.textContent ?? null,
})));
const seekTo = async (page, ts) => {
  await page.evaluate((x) => { window.studioDesk.setPlaying(false); window.studioDesk.seek(x); }, ts);
  await page.waitForTimeout(300);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};
const onAirAt = async (page, s, audience = "analyst") => {
  const c = whyCue(s, audience);
  // a script click: on a phone the open sheet covers the controls
  await page.evaluate((a) => document.querySelector(`[data-audience="${a}"]`).click(), audience);
  await seekTo(page, c.ts + 2);
  return (await live(page)).find((x) => x.story === s.story_id) ?? null;
};
// the language: a button in the settings menu
const setLang = (page, l) => page.evaluate((x) => document.querySelector(`[data-lang="${x}"]`).click(), l);
const card = (s) => `#story-${s.story_id}`;
// the desk is connected and no save is in flight: its controls are enabled again
const settled = (page) => page.waitForFunction(() => { const d = window.studioDesk.desk; return d.ready && !d.busy; }, null, { timeout: 5000 });
const posted = (page, method = "POST") => page.waitForResponse((r) => r.url().includes("/api/decisions") && r.request().method() === method);
const decide = async (page, s, cls) => {
  await Promise.all([posted(page), page.click(`${card(s)} .${cls}`)]);
  await settled(page);
};
const active = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.dataset?.focus || document.activeElement?.tagName);

/** What the stories tab shows: the three sections, their counts and items, the filled buttons of each item. */
const sections = (page) => page.evaluate(() => {
  const filled = (b) => { const bg = getComputedStyle(b).backgroundColor; return bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent" && bg !== getComputedStyle(document.body).backgroundColor; };
  return [...document.querySelectorAll("#desk .sec")].map((sec) => ({
    id: sec.className.match(/sec-(\w+)/)?.[1], count: sec.querySelector("h3 .count")?.textContent, empty: sec.querySelector(".empty")?.textContent ?? null,
    items: [...sec.querySelectorAll("[data-item]")].map((el) => ({ id: el.id, row: el.classList.contains("row"), next: !!el.querySelector(".tag"),
      minute: el.querySelector(".minute")?.textContent, filled: [...el.querySelectorAll("button")].filter((b) => b.checkVisibility() && filled(b)).map((b) => b.textContent) })),
  }));
});

/** The checks every replay must pass at a moment: only reached stories, three sections that add up, one filled button at most. */
async function structure(page, all, storyIds, ts, tag) {
  await seekTo(page, ts);
  const secs = await sections(page);
  expect(secs.map((s) => s.id).join() === "air,needs,done", `${tag} @${ts}: sections ${secs.map((s) => s.id)}`);
  // live, a story exists once the match has passed its facts (its ts): a goal is never listed before it is scored
  const tsOf = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, window.studioDesk.desk.byId.get(id)?.ts])), storyIds);
  const want = new Set(storyIds.filter((id) => tsOf[id] <= ts && firstCue(all, id) <= ts + LOOKAHEAD));
  // a story nobody decided on, 5 match minutes past its slot, is listed under Missed, below the three sections
  const missed = await page.$$eval("#desk .missed [data-item]", (n) => n.map((x) => x.id));
  const listed = [...secs.flatMap((s) => s.items).map((i) => i.id), ...missed].filter((i) => i.startsWith("story-S-")).map((i) => i.slice(6));
  // generated graphics (G- ids) go through the desk too, and at most one waits at a time
  const gensWaiting = secs.find((s) => s.id === "needs")?.items.filter((i) => i.id.startsWith("story-G-")).length ?? 0;
  expect(gensWaiting <= 1, `${tag} @${ts}: ${gensWaiting} generated graphics waiting`);
  expect(listed.length === new Set(listed).size && listed.length === want.size && listed.every((id) => want.has(id)),
    `${tag} @${ts}: listed ${JSON.stringify(listed)}, reached ${JSON.stringify([...want])}`);
  const late = await page.evaluate(([ids, now]) => { const d = window.studioDesk.desk; return ids.filter((id) => d.byId.get(id) && d.status(d.byId.get(id)) === "expired"
    && !(now >= (d.slotEnd.get(id) ?? d.firstOf(d.byId.get(id))) + 300)); }, [missed.filter((i) => i.startsWith("story-S-")).map((i) => i.slice(6)), ts]);
  expect(!late.length, `${tag} @${ts}: missed before 5 minutes past the slot ${JSON.stringify(late)}`);
  for (const s of secs) {
    expect(String(s.items.length) === s.count, `${tag} @${ts}: ${s.id} says ${s.count} for ${s.items.length} items`);
    expect(s.items.length ? s.empty === null : (s.empty ?? "").length > 5, `${tag} @${ts}: ${s.id} empty state ${JSON.stringify(s.empty)}`);
    for (const i of s.items) {
      expect(i.filled.length <= 1, `${tag} @${ts}: ${i.id} has ${i.filled.length} filled buttons`);
      if (s.id === "needs") expect(i.filled.length === 1 && /^(Put on air|Approve)/.test(i.filled[0]), `${tag} @${ts}: waiting ${i.id} filled ${JSON.stringify(i.filled)}`);
      else expect(!i.filled.length, `${tag} @${ts}: ${s.id} ${i.id} has a filled button ${JSON.stringify(i.filled)}`);
      // Next: inside the look-ahead, its first graphic still to come
      if (i.id.startsWith("story-S-")) expect(i.next === firstCue(all, i.id.slice(6)) > ts, `${tag} @${ts}: ${i.id} Next tag ${i.next}`);
    }
  }
  // On air now lists every graphic on screen: one row per story or generated graphic
  const onScreen = await page.evaluate(() => [...window.studioDesk.host.live.values()].map(({ cue: c }) =>
    `story-${c.story_id ?? window.studioDesk.desk.genOf.get(`${c.graphic}|${c.ts}|${c.audience}`)?.story_id}`));
  const air = secs[0]?.items.map((i) => i.id) ?? [];
  expect([...new Set(onScreen)].sort().join() === [...air].sort().join(), `${tag} @${ts}: on screen ${JSON.stringify(onScreen)}, On air now ${JSON.stringify(air)}`);
  return secs;
}

/** Opens every Details in the stories tab, then the audit and the traces: no fact id in any text or name a person reads. */
async function noFactIds(page, tag) {
  const text = () => page.evaluate(() => {
    const d = document.querySelector("#desk");
    return [d.innerText, ...[...d.querySelectorAll("[title],[aria-label]")].flatMap((el) => [el.title, el.getAttribute("aria-label") ?? ""])].join("\n");
  });
  await page.evaluate(() => document.querySelector("#tab-stories").click());
  await page.evaluate(() => { for (const d of document.querySelectorAll("#desk details.more")) { d.open = true; d.dispatchEvent(new Event("toggle")); } });
  const nested = await page.$$eval("#desk details details", (n) => n.length);
  expect(!nested, `${tag}: ${nested} disclosures inside Details`);
  const found = [];
  for (const tab of ["stories", "audit", "traces"]) {
    await page.evaluate((t) => document.querySelector(`#tab-${t}`).click(), tab);
    const m = (await text()).match(FACT_ID);
    if (m) found.push(`${tab}: ${m[0]}`);
  }
  expect(!found.length, `${tag}: fact ids in the desk ${JSON.stringify(found)}`);
  await page.evaluate(() => { document.querySelector("#tab-stories").click(); for (const d of document.querySelectorAll("#desk details.more")) d.open = false; });
}

async function scenario(browser, w, h) {
  const phone = w < 1100, tag = `${w}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone });
  const page = await ctx.newPage();
  // voice.json and booth.json are optional (docs/CONTRACT.md): a match without clips answers 404 and plays silent.
  // api/ask too: the static server here has no API, so the page's GET probe gets a 404 (the real API answers 200).
  const optional = (u) => /\/(voice|booth|season)\.json$/.test(u) || u.endsWith("/api/ask");
  page.on("console", (m) => { if (m.type() === "error" && !optional(m.location().url || "")) fail(`${tag} console: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`${tag} page error: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 400 && !optional(r.url())) fail(`${tag} ${r.status()} ${r.url()}`); });
  await page.goto(url);
  await page.waitForFunction(() => window.studioDesk?.desk?.online, null, { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => document.querySelector('[data-audience="analyst"]').click());
  // in page coordinates: the screenshots below scroll the window to a desk card when the page is taller than the screen
  const frameAt = () => page.$eval("#frame", (el) => { const r = el.getBoundingClientRect(); return [r.left + scrollX, r.top + scrollY, r.width, r.height]; });
  const frameBefore = await frameAt();
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
    if (el) await page.$eval(el, (n) => n.scrollIntoView({ block: "start" })).catch(() => {});
    await page.screenshot({ path: `${shots}/desk-${name}-${tag}.png` });
  };
  const shootAir = async (name) => {
    if (!phone) return; // docked: the broadcast is in the same screenshot
    await closeDesk();
    await page.screenshot({ path: `${shots}/desk-${name}-${tag}-air.png` });
  };
  const ids = stories.map((s) => s.story_id);

  // 0. only what the match has reached: nothing at kick-off, the goal as Next a minute before its graphic
  await seekTo(page, 0);
  expect(await page.$$eval("#desk [data-item]", (n) => n.length) === 0, `${tag}: stories listed at kick-off`);
  if (phone) expect(await page.$eval("#desk-open .count", (el) => el.textContent) === "", `${tag}: Desk badge counts stories the match has not reached`);
  await structure(page, cues, ids, firstCue(cues, AUTO.story_id) - 50, tag);
  await structure(page, cues, ids, MOMENTUM.ts + 1.5, tag); // the momentum template on air, the key pass waiting, the goal done
  await openDesk();
  await shoot("sections", null);
  // Take out a generated graphic, and Undo brings it back
  await page.click(`#story-G-${MOMENTUM.cue_id} .act-rejected`);
  await seekTo(page, MOMENTUM.ts + 1.6);
  expect(!(await live(page)).some((x) => x.cue === MOMENTUM.cue_id), `${tag}: Take out left the momentum card on air`);
  expect(/^Momentum \d+' taken out$/.test(await page.$eval("#desk .done-msg", (el) => el.textContent)), `${tag}: Take out status line`);
  await page.click("#desk .undo");
  await seekTo(page, MOMENTUM.ts + 1.7);
  expect((await live(page)).some((x) => x.cue === MOMENTUM.cue_id), `${tag}: Undo did not bring the momentum card back`);

  await seekTo(page, ALL);
  if (phone) {
    await closeDesk();
    expect(await page.$eval("#desk", (el) => getComputedStyle(el).visibility) === "hidden", `${tag}: sheet open before the Desk button`);
    expect(await page.$eval("#desk-open .count", (el) => el.textContent) === "3", `${tag}: Desk badge does not say 3 waiting`);
    expect(await page.$eval("#desk-open", (el) => el.getAttribute("aria-label")) === "Desk, 3 waiting for review", `${tag}: Desk button name`);
    expect(await page.$eval("#desk-open .off", (el) => el.hidden), `${tag}: Desk button says offline while online`);
    await openDesk();
    // the sheet leaves at least 40% of the height to the broadcast, which shows above it
    const sheet = await page.evaluate(() => ({ top: document.querySelector("#desk").getBoundingClientRect().top, frame: document.querySelector("#frame").getBoundingClientRect().bottom, h: innerHeight }));
    expect(sheet.top >= 0.4 * sheet.h - 1 && sheet.frame <= sheet.top + 1, `${tag}: the sheet leaves the broadcast ${JSON.stringify(sheet)}`);
  }
  // one line: "Control desk · AI graphics on · 3 waiting" (the dots are CSS); on a phone the count gives way to Close
  const head = await page.$eval("#desk .desk-title", (el, last) => [el.querySelector("h2"), el.querySelector("#ai-switch .switch-label"), el.querySelector(last)]
    .map((x) => x && [x.textContent.replace(/\s+/g, " ").trim(), Math.round(x.getBoundingClientRect().top + x.getBoundingClientRect().height / 2)]), phone ? "#desk-close" : ".desk-sum");
  expect(JSON.stringify(head.map((x) => x?.[0])) === `["Control desk","AI graphics on","${phone ? "Close" : "3 waiting"}"]` && head.every((x) => Math.abs(x[1] - head[0][1]) < 12),
    `${tag}: header ${JSON.stringify(head)}`);
  expect(await page.$eval(`${card(HELD)} .act-approved`, (el) => el.getAttribute("aria-label")).then((l) => /^Put on air: Key pass at minute \d+/.test(l)),
    `${tag}: Put on air does not name its story`);
  expect(await page.$eval(`${card(HELD)} .act-approved`, (el) => [el.getAttribute("aria-keyshortcuts"), el.querySelector("kbd")?.textContent].join()) === "A,A",
    `${tag}: Put on air does not show its key`);

  // 1. a waiting card: what will air, one status line, the actions, then Details (closed, built when opened)
  for (const s of [HELD, SWING, BACK]) {
    const c = await page.$eval(card(s), (el) => {
      const more = el.querySelector(":scope > details.more");
      return { parts: [...el.children].map((x) => x.className.split(" ")[0] || x.tagName), open: more?.open ?? null, h: Math.round(el.getBoundingClientRect().height),
        built: more ? more.children.length > 1 : null, headline: el.querySelector(".headline")?.textContent, kicker: el.querySelector(".kicker")?.textContent };
    });
    expect(c.parts.join() === "story-head,tally,kicker,headline,story-text,actions,more" && c.open === false && c.built === false,
      `${tag}: closed card ${s.story_id} ${JSON.stringify(c)}`);
    expect(c.headline === whyCue(s).payload.title && c.kicker === "KEY MOMENT", `${tag}: card ${s.story_id} headline ${JSON.stringify([c.kicker, c.headline])}`);
    if (phone) expect(c.h <= 360, `${tag}: closed card ${s.story_id} is ${c.h} px tall at 390x844`);
  }
  await shoot("closed", null);
  await noFactIds(page, tag);

  // 2. held until approved
  expect(!(await onAirAt(page, HELD)), `${tag}: ${HELD.story_id} needs review but its graphic is on air`);
  expect((await onAirAt(page, AUTO)) !== null, `${tag}: auto-approved ${AUTO.story_id} not on air`);
  if (phone) {
    await openDesk();
    expect(await page.evaluate(() => document.querySelector("#app").inert && document.querySelector("#desk").getAttribute("aria-modal") === "true"),
      `${tag}: open sheet is not modal`);
    await closeDesk();
    expect(await page.evaluate(() => !document.querySelector("#app").inert && !document.querySelector("#desk").hasAttribute("aria-modal")),
      `${tag}: closed sheet leaves the page inert`);
  }
  await seekTo(page, whyCue(HELD).ts + 2);
  await openDesk();
  expect(await page.$$eval(`${card(HELD)} .mini`, (n) => n.length) === 0, `${tag}: pitch map built with Details closed`);
  await page.$eval(card(HELD), (n) => n.scrollIntoView({ block: "start" }));
  await page.click(`${card(HELD)} .more > summary`);
  const det = await page.$eval(card(HELD), (el) => {
    const body = document.querySelector("#desk .desk-body").getBoundingClientRect(), more = el.querySelector("details.more");
    const acts = [...el.querySelectorAll(".actions button")].map((b) => b.getBoundingClientRect());
    return { nested: more.querySelectorAll("details").length, mini: more.querySelectorAll(".mini line.ev").length, facts: more.querySelectorAll(".facts tbody tr").length,
      why: more.querySelector(".why")?.textContent ?? "", riskTitle: more.querySelector(".risk")?.title ?? "", needsReview: /Needs review/.test(more.textContent),
      inView: acts.length > 0 && acts.every((r) => r.top >= body.top && r.bottom <= Math.min(body.bottom, innerHeight)) };
  });
  expect(!det.nested && det.mini > 0 && det.facts > 0, `${tag}: Details is not one level with the evidence in it ${JSON.stringify(det)}`);
  expect(det.inView, `${tag}: the actions leave the view when Details opens`);
  expect(/^(Low|Medium|High) risk/.test(det.why) && /^Risk score \d/.test(det.riskTitle) && !/\d\.\d\d/.test(det.why) && !det.needsReview,
    `${tag}: why it waits ${JSON.stringify(det)}`);
  await shoot("details");
  expect(await page.$eval(`${card(HELD)} .tally`, (el) => el.textContent).then((x) => x.startsWith("Waiting for you, ")), `${tag}: held story not marked Waiting for you`);
  await decide(page, HELD, "act-approved");
  const heldLive = await onAirAt(page, HELD);
  expect(heldLive !== null, `${tag}: ${HELD.story_id} approved but its graphic is not on air`);
  const shown = await page.$eval(card(HELD), (el) => [el.querySelector(".kicker")?.textContent, el.querySelector(".headline")?.textContent, el.querySelector(".story-text")?.textContent]);
  expect(JSON.stringify(shown) === JSON.stringify([heldLive?.kicker, heldLive?.title, heldLive?.body]), `${tag}: card ${JSON.stringify(shown)}, on air ${JSON.stringify(heldLive)}`);
  expect(await page.$eval(`${card(HELD)} .tally`, (el) => el.textContent) === "On air, approved by you", `${tag}: approved story on screen not marked On air`);
  // on air: Take out and Edit, nothing filled, no "Keep on air"
  expect(await page.$$eval(`${card(HELD)} .actions button`, (n) => n.map((b) => b.firstChild.textContent).join()) === "Take out,Edit", `${tag}: on-air actions`);
  await shoot("approved");
  await shootAir("approved");
  // Undo of a first decision: the server drops it and the story is held again
  await openDesk();
  await Promise.all([posted(page, "DELETE"), page.click("#desk .undo")]);
  await settled(page);
  expect(await page.$eval(`${card(HELD)} .tally`, (el) => el.textContent).then((x) => x.startsWith("Waiting for you, ")), `${tag}: undone story not held again`);
  expect(!(await page.evaluate(async () => (await (await fetch("api/decisions?match_id=DEMO")).json()).decisions.length)), `${tag}: the server kept the undone decision`);
  expect(!(await onAirAt(page, HELD)), `${tag}: undone ${HELD.story_id} still on air`);
  await openDesk();
  await decide(page, HELD, "act-approved");

  // 3. an edit replaces the why card's headline and body for this visitor
  await onAirAt(page, AUTO);
  await openDesk();
  await page.click(`${card(AUTO)} .act-edited`);
  const fields = await page.$$eval(`${card(AUTO)} .editor :is(input, textarea)`, (n) => n.map((x) => [x.tagName.toLowerCase(), x.lang, x.value]));
  const wantFields = ["en", "it", "es"].flatMap((l) => [["input", l, whyCue(AUTO, "analyst", l).payload.title], ["textarea", l, whyCue(AUTO, "analyst", l).payload.body]]);
  expect(JSON.stringify(fields) === JSON.stringify(wantFields), `${tag}: editor fields ${JSON.stringify(fields)}`);
  expect(await page.evaluate(() => [document.activeElement?.tagName, document.activeElement?.lang].join()) === "TEXTAREA,en", `${tag}: Edit did not focus the English text`);
  // typing is never a key: A, R and U in a field are letters
  let sentNow = 0;
  const count = (r) => { if (r.url().includes("/api/decisions")) sentNow++; };
  page.on("request", count);
  await page.keyboard.type(" aru");
  await page.waitForTimeout(200);
  expect(!sentNow && (await page.inputValue(`${card(AUTO)} textarea[lang="en"]`)).endsWith(" aru"), `${tag}: keys acted while typing (${sentNow} requests)`);
  page.off("request", count);
  await page.fill(`${card(AUTO)} input[lang="en"]`, EDIT_TITLE);
  await page.fill(`${card(AUTO)} textarea[lang="en"]`, EDIT);
  await Promise.all([posted(page), page.click(`${card(AUTO)} .editor .ctl.primary`)]);
  await settled(page);
  const edited = await onAirAt(page, AUTO);
  expect(edited?.body === EDIT && edited?.title === EDIT_TITLE, `${tag}: edited headline and body not on the graphic ${JSON.stringify(edited)}`);
  expect(JSON.stringify(await page.$eval(card(AUTO), (el) => [el.querySelector(".headline")?.textContent, el.querySelector(".story-text")?.textContent])) === JSON.stringify([EDIT_TITLE, EDIT]),
    `${tag}: edited text not on the card`);
  await shoot("edited", card(AUTO));
  await shootAir("edited");

  // 4. Take out an auto-approved story; the reason chips sit under the message; Undo stays until the next decision
  await openDesk();
  await decide(page, AUTO, "act-rejected");
  expect(!(await onAirAt(page, AUTO)), `${tag}: rejected ${AUTO.story_id} still on air`);
  expect(!(await onAirAt(page, AUTO, "casual")), `${tag}: rejected ${AUTO.story_id} on air for the casual audience`);
  await page.click('[data-audience="analyst"]').catch(() => page.evaluate(() => document.querySelector('[data-audience="analyst"]').click()));
  await openDesk();
  const chips = await page.evaluate(() => {
    const msg = document.querySelector("#desk .done-msg").getBoundingClientRect(), r = document.querySelector("#desk .done .reasons");
    return { under: r.getBoundingClientRect().top >= msg.bottom - 1, b: [...r.querySelectorAll("button")].map((b) => [b.textContent, b.getAttribute("aria-pressed")]) };
  });
  expect(chips.under && chips.b.length === 4 && chips.b.every((c) => c[1] === "false"), `${tag}: reason chips after Reject ${JSON.stringify(chips)}`);
  await page.click("#desk .done .reasons button");
  expect(await page.$eval("#desk .done .reasons button", (b) => b.getAttribute("aria-pressed")) === "true", `${tag}: a reason chip does not stay pressed`);
  await shoot("rejected", null);
  await page.waitForTimeout(10600); // past the old 10 s: the Undo and its message are both still there
  const kept = await page.evaluate(() => ({ msg: document.querySelector("#desk .done-msg").textContent, undo: !document.querySelector("#desk .undo").hidden }));
  expect(/rejected, off air$/.test(kept.msg) && kept.undo, `${tag}: after 10 s the message and its Undo ${JSON.stringify(kept)}`);

  // 5. Space on a desk button presses it and never toggles play; the focus moves on to the next waiting card
  await seekTo(page, ALL);
  await openDesk();
  const playing = await page.evaluate(() => window.studioDesk.state.playing);
  await page.focus(`${card(SWING)} .act-approved`);
  await Promise.all([posted(page), page.keyboard.press("Space")]);
  expect(await page.evaluate(() => window.studioDesk.state.playing) === playing, `${tag}: Space in the desk toggled play`);
  await settled(page);
  expect(await active(page) === `story-${BACK.story_id}`, `${tag}: after a decision the focus is on ${await active(page)}, not the next waiting card`);
  // the next decision replaces the message, and its Undo goes with it
  const after = await page.evaluate(() => ({ msg: document.querySelector("#desk .done-msg").textContent, undo: document.querySelector("#desk .undo").getAttribute("aria-label") }));
  expect(/^Momentum swing \d+' approved, on air$/.test(after.msg) && after.undo === `Undo: ${after.msg.replace(/ approved, on air$/, "")}`, `${tag}: message and Undo ${JSON.stringify(after)}`);
  // approved but not on screen: a Done row, "approved by you", never the red "On air"
  expect(await page.$eval(card(SWING), (el) => [el.classList.contains("row"), el.querySelector(".outcome")?.textContent, el.dataset.tally].join()) === "true,approved by you,approved",
    `${tag}: approved story off screen ${await page.$eval(card(SWING), (el) => el.textContent)}`);
  await seekTo(page, whyCue(SWING).ts + 2);
  const lines = await page.evaluate(([a, b]) => [document.querySelector(`#story-${a} .tally`)?.textContent, document.querySelector(`#story-${b} .outcome`)?.textContent], [SWING.story_id, HELD.story_id]);
  // the key pass, approved in its slot, aired: its row says when; the swing, approved after its slot, claims nothing
  expect(lines[0] === "On air, approved by you" && /^aired at \d+', approved by you$/.test(lines[1]), `${tag}: on screen, the status lines read ${JSON.stringify(lines)}`);

  // 5b. the AI proposal sits in Details; "Use proposal" puts it on air (from its Done row: on a phone the
  // On air now strip is compact, without Details)
  await seekTo(page, ALL);
  await page.click(`${card(SWING)} .more > summary`);
  const proposal = await page.$eval(`${card(SWING)} .proposal-text`, (el) => el.textContent);
  expect(proposal.includes(SWING.verifier.proposals.en) && proposal.includes("not on air"), `${tag}: proposal block ${JSON.stringify(proposal)}`);
  await Promise.all([posted(page), page.click(`${card(SWING)} .proposal button`)]);
  await settled(page);
  expect(await page.evaluate((id) => window.studioDesk.desk.text(window.studioDesk.desk.byId.get(id), "en"), SWING.story_id) === SWING.verifier.proposals.en,
    `${tag}: Use proposal did not put it on air`);
  expect(!(await page.$(`${card(SWING)} .proposal button`)), `${tag}: Use proposal button still there once used`);
  // said and logged as the AI's line, not as an edit; Details says in words what it was before
  const used = await page.evaluate((id) => ({ msg: document.querySelector("#desk .done-msg")?.textContent, was: document.querySelector(`#story-${id} .default`)?.textContent,
    action: window.studioDesk.desk.auditData().humans[0]?.action }), SWING.story_id);
  expect(/: AI proposal on air$/.test(used.msg) && /^Before your decision/.test(used.was ?? "") && used.action === "used_proposal", `${tag}: Use proposal reads ${JSON.stringify(used)}`);

  // 6. the keys, with the focus in the desk
  await seekTo(page, ALL);
  await openDesk();
  await page.focus(card(BACK));
  await page.keyboard.press("j");
  const j = await active(page);
  await page.keyboard.press("k");
  expect(j !== `story-${BACK.story_id}` && /^story-/.test(j) && await active(page) === `story-${BACK.story_id}`, `${tag}: J then K moved the focus to ${j}, then ${await active(page)}`);
  await page.keyboard.press("e");
  expect(await page.evaluate(() => [document.activeElement?.tagName, document.activeElement?.lang].join()) === "TEXTAREA,en", `${tag}: E did not open the editor`);
  // Esc in the headline field cancels the edit and nothing more: on a phone the sheet stays open
  const headline = await page.$(`${card(BACK)} .editor input`);
  await headline?.focus();
  await page.keyboard.press("Escape");
  expect(!(await page.$(`${card(BACK)} .editor`)), `${tag}: Esc did not close the editor`);
  const sheetOpen = () => page.evaluate(() => document.body.classList.contains("desk-open"));
  if (phone) expect(headline && await sheetOpen(), `${tag}: Esc in the headline field closed the sheet too (field ${!!headline})`);
  await page.focus(card(BACK));
  await Promise.all([posted(page), page.keyboard.press("r")]);
  await settled(page);
  expect(await page.evaluate((id) => window.studioDesk.desk.status(window.studioDesk.desk.byId.get(id)), BACK.story_id) === "rejected", `${tag}: R did not reject`);
  await Promise.all([posted(page, "DELETE"), page.keyboard.press("u")]);
  await settled(page);
  expect(await page.evaluate((id) => window.studioDesk.desk.status(window.studioDesk.desk.byId.get(id)), BACK.story_id) === "needs_review"
    && await active(page) === `story-${BACK.story_id}`, `${tag}: U did not undo, or the focus is on ${await active(page)}`);
  await Promise.all([posted(page), page.keyboard.press("a")]);
  await settled(page);
  expect(await page.evaluate((id) => window.studioDesk.desk.status(window.studioDesk.desk.byId.get(id)), BACK.story_id) === "approved", `${tag}: A did not put it on air`);
  expect(await active(page) === "sec-needs", `${tag}: with nothing left waiting the focus is on ${await active(page)}`);
  await page.keyboard.press("?");
  const keys = await page.evaluate(() => { const d = document.querySelector("#keys"); return { open: !!d?.open, desk: d?.querySelector("#keys-desk")?.textContent ?? "" }; });
  expect(keys.open && /Put the story on air/.test(keys.desk) && /Next or previous story/.test(keys.desk), `${tag}: ? did not open the key list with the desk keys ${JSON.stringify(keys)}`);
  if (keys.open) await page.keyboard.press("Escape");
  if (phone) expect(await sheetOpen(), `${tag}: Esc on the key list closed the sheet too`);
  // outside the desk the letters are not the desk's
  await page.evaluate(() => document.activeElement?.blur());
  await page.evaluate(() => document.querySelector("#frame").focus?.());
  sentNow = 0;
  page.on("request", count);
  await page.keyboard.press("u");
  await page.waitForTimeout(200);
  page.off("request", count);
  expect(!sentNow, `${tag}: U outside the desk undid a decision`);

  // 7. AI off: only template graphics
  await openDesk();
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/kill")), page.click("#ai-switch")]);
  await settled(page);
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
  await settled(page);
  expect((await onAirAt(page, HELD)) !== null, `${tag}: AI back on but ${HELD.story_id} not on air`);

  // 8. traces from a story's Details (its Done row: on a phone the On air now strip has no Details)
  await seekTo(page, ALL);
  await openDesk();
  // Details stays open from step 2: the desk keeps it open across renders
  if (!(await page.$eval(`${card(HELD)} .more`, (d) => d.open))) await page.click(`${card(HELD)} .more > summary`);
  await page.click(`${card(HELD)} .more .link`);
  expect(await page.$eval("#tab-traces", (el) => el.getAttribute("aria-selected")) === "true", `${tag}: Show trace did not open Traces`);
  const chain = await page.$$eval(`[data-trace="${HELD.story_id}"] .chain li`, (n) => n.map((x) => x.dataset.agent));
  expect(chain[0] === "story_finder" && chain.at(-1) === "director" && chain.includes("verifier"), `${tag}: trace chain ${chain.join(",")}`);
  // a hand-off shared by several stories counts once over all the groups
  const [byGroup, total] = await page.evaluate(() => {
    const d = window.studioDesk.desk, g = [...d.traceGroups().values()];
    return [g.reduce((n, x) => n + x.sum.cost + x.sum.tokens, 0), d.traces.reduce((n, t) => n + t.cost_usd + t.tokens_in + t.tokens_out, 0)];
  });
  expect(Math.abs(byGroup - total) < 1e-6 * Math.max(1, total), `${tag}: trace groups add up to ${byGroup}, the run to ${total}`);
  await shoot("traces", `[data-trace="${HELD.story_id}"]`);

  // 9. the audit: your actions first, in match minutes, the UTC time in a tooltip; the costs last
  await page.click("#tab-audit");
  const audit = await page.evaluate(() => {
    const a = document.querySelector("#desk .audit"), kids = [...a.children].map((x) => x.className || x.tagName);
    return { kids, mine: [...a.querySelectorAll(".mine li")].map((li) => [li.textContent, li.title]) };
  });
  expect(audit.kids[0] === "audit-head" && audit.kids[1] === "mine" && audit.kids.at(-1) === "totals", `${tag}: audit order ${audit.kids}`);
  for (const a of [/^\d+' Key pass, approved$/, /^\d+' Goal, edited \(en\)$/, /^\d+' Goal, rejected: a number$/, /^AI graphics switched off$/, /^AI graphics switched on$/]) {
    expect(audit.mine.some(([x]) => a.test(x)), `${tag}: your actions have no ${a} row ${JSON.stringify(audit.mine.slice(0, 4))}`);
  }
  expect(audit.mine.every(([, t]) => /^\d\d:\d\d:\d\d UTC$/.test(t)), `${tag}: your actions' UTC tooltips ${JSON.stringify(audit.mine.slice(0, 2))}`);
  // a story by its name and minute, as the desk names it
  const sids = await page.$$eval(".log .sid", (n) => n.map((x) => x.textContent));
  expect(sids.length && sids.every((x) => !/S-\d{6}/.test(x)) && sids.some((x) => /^Goal \d+'$/.test(x)), `${tag}: audit names stories ${JSON.stringify(sids.slice(0, 4))}`);
  expect(await page.$$eval(".log tr.a-agent", (n) => n.length) > 0, `${tag}: audit has no agent rows`);
  expect(await page.$$eval(".log tr.a-human", (n) => n.length) > 0, `${tag}: the audit table leaves out your decisions`);
  // the replay's traces are steps, not calls (M001: 115 steps, 132 calls in MEASURES.md): the total says so
  const steps = await page.evaluate(() => {
    const t = document.querySelector("#desk .totals div"), d = window.studioDesk.desk;
    return { text: t.textContent, tip: t.title, n: d.traces.filter((x) => x.model).length };
  });
  expect(steps.text === `${steps.n} agent steps that used the model` && /more than once/.test(steps.tip), `${tag}: audit total ${JSON.stringify(steps)}`);
  await shoot("audit", null);
  // early in the match neither the audit nor the traces name a story the match has not reached
  await seekTo(page, 30);
  const early = await page.evaluate(async () => {
    const d = window.studioDesk.desk, ahead = (id) => d.byId.has(id) && !d.visible(d.byId.get(id));
    const audit = d.auditData().rows.filter((r) => ahead(r.story_id)).length;
    document.querySelector("#tab-traces").click();
    await new Promise((r) => setTimeout(r, 50));
    const traces = [...document.querySelectorAll("#desk [data-trace]")].filter((x) => ahead(x.dataset.trace)).length;
    return { audit, traces, ahead: d.stories.filter((s) => !d.visible(s)).length };
  });
  expect(early.ahead > 0 && early.audit === 0 && early.traces === 0, `${tag}: spoilers at 0:30 ${JSON.stringify(early)}`);
  await seekTo(page, ALL);
  // Show story, from the last trace group: the desk's list scrolls to the story, the page stays where it was
  if (!phone) {
    const shown = await page.evaluate(async () => {
      document.querySelector("#tab-traces").click();
      await new Promise((r) => setTimeout(r, 50));
      const b = [...document.querySelectorAll('#desk [data-focus$=":show"]')].at(-1);
      if (!b) return null;
      const y = window.scrollY, id = b.dataset.focus.split(":")[0];
      b.click();
      await new Promise((r) => setTimeout(r, 50));
      const r = document.querySelector(`#story-${id}`)?.getBoundingClientRect();
      return { moved: window.scrollY - y, inView: !!r && r.top >= 0 && r.top < window.innerHeight, tab: document.querySelector("#tab-stories")?.getAttribute("aria-selected") };
    });
    expect(shown && shown.moved === 0 && shown.inView && shown.tab === "true", `${tag}: Show story ${JSON.stringify(shown)}`);
  }

  // 10. languages: desk text, headline and graphic
  await page.click("#tab-stories");
  for (const lang of ["it", "es"]) {
    await setLang(page, lang);
    await openDesk();
    const g = await onAirAt(page, HELD);
    const text = await page.$eval(card(HELD), (el) => [el.querySelector(".story-text")?.lang, el.querySelector(".story-text")?.textContent, el.querySelector(".headline")?.textContent, el.querySelector(".kicker")?.textContent]);
    const want = whyCue(HELD, "analyst", lang).payload;
    expect(JSON.stringify(text) === JSON.stringify([lang, want.body, g?.title, g?.kicker]) && g?.body === want.body && g?.lang === lang,
      `${tag} ${lang}: card ${JSON.stringify(text)}, graphic ${JSON.stringify(g)}`);
    // the English edit stays English: the Italian or Spanish line is the original translation
    expect(await page.evaluate(([id, l]) => window.studioDesk.desk.text(window.studioDesk.desk.byId.get(id), l), [AUTO.story_id, lang]) === whyCue(AUTO, "analyst", lang).payload.body,
      `${tag} ${lang}: the edit leaked into ${lang}`);
    await shoot(lang);
    await shootAir(lang);
  }
  await setLang(page, "en");

  // 11. the broadcast never moved
  await closeDesk();
  const frameAfter = await frameAt();
  expect(JSON.stringify(frameBefore) === JSON.stringify(frameAfter), `${tag}: the broadcast frame moved ${JSON.stringify([frameBefore, frameAfter])}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tag}: horizontal scroll`);

  // 12. decisions survive a reload; another visitor sees the original replay
  await page.reload();
  await page.waitForFunction(() => window.studioDesk?.desk?.online, null, { timeout: 15000 });
  const mine = await page.evaluate(() => Object.fromEntries([...window.studioDesk.desk.decisions].map(([k, v]) => [k, v.decision])));
  expect(mine[HELD.story_id] === "approved" && mine[AUTO.story_id] === "rejected" && mine[SWING.story_id] === "edited", `${tag}: after reload ${JSON.stringify(mine)}`);
  const other = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  await other.goto(url);
  await other.waitForFunction(() => window.studioDesk?.desk?.online, null, { timeout: 15000 });
  expect(await other.evaluate(() => window.studioDesk.desk.decisions.size) === 0, `${tag}: another visitor sees decisions`);
  expect(!(await onAirAt(other, HELD)) && (await onAirAt(other, AUTO)) !== null, `${tag}: another visitor's replay changed`);
  await other.context().close();
  await ctx.close();
}

// The look-ahead on a real replay: the 17' big chance of M002 is not listed at 11', nor a minute before its graphic
// (the shot has not happened yet); between the shot and its graphic it is, as Next.
async function lookahead(browser) {
  const m2 = await getJson("M002", "cues.json"), s2 = await getJson("M002", "stories.json");
  const chance = s2.find((s) => s.story_id === "S-000002");
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on("pageerror", (e) => fail(`M002 page error: ${e.message}`));
  await page.goto(new URL("?match=M002&view=2d", base).href);
  await page.waitForFunction(() => window.studioDesk?.desk?.loaded && window.studioDesk.desk.ready, null, { timeout: 90000 });
  const at = firstCue(m2, chance.story_id);
  const minuteOf = await page.evaluate((id) => window.studioDesk.desk.minuteText(window.studioDesk.desk.byId.get(id)), chance.story_id);
  expect(chance.kind === "big_chance" && minuteOf === "17", `M002: S-000002 is ${chance.kind} at ${minuteOf}'`);
  const minutes = async () => page.$$eval("#desk [data-item] .minute", (n) => n.map((x) => x.textContent));
  await structure(page, m2, s2.map((s) => s.story_id), 11 * 60, "M002");
  expect(!(await minutes()).includes("17'") && !(await page.$(card(chance))), `M002 at 11': the 17' story is listed ${JSON.stringify(await minutes())}`);
  await structure(page, m2, s2.map((s) => s.story_id), at - LOOKAHEAD + 5, "M002");
  expect(!(await page.$(card(chance))), "M002 a minute before its graphic: the 17' chance is listed before the shot");
  expect(chance.ts + 1 < at, `M002: the 17' chance has no time between its shot (${chance.ts}) and its graphic (${at})`);
  await structure(page, m2, s2.map((s) => s.story_id), chance.ts + 1, "M002");
  expect(await page.$eval(card(chance), (el) => !!el.querySelector(".tag")).catch(() => false), "M002 after the shot: the 17' story is not listed as Next");
  await structure(page, m2, s2.map((s) => s.story_id), at + 1, "M002");
  // at 22' the held stories whose slot ended 5 minutes before (the 11' pressing spell among them) are missed, not waiting
  const slotEnd = (id) => Math.max(...m2.filter((c) => c.story_id === id).map((c) => c.ts + c.duration_s));
  const stale = s2.filter((s) => s.default_status === "needs_review" && slotEnd(s.story_id) + 300 <= 22 * 60).map((s) => `story-${s.story_id}`);
  await structure(page, m2, s2.map((s) => s.story_id), 22 * 60, "M002");
  const missedAt22 = await page.$$eval("#desk .missed [data-item]", (n) => n.map((x) => x.id));
  const waitingAt22 = await page.$$eval("#desk .sec-needs [data-item]", (n) => n.map((x) => x.id));
  expect(stale.length > 0 && stale.every((id) => missedAt22.includes(id) && !waitingAt22.includes(id)) && /^Missed: \d+$/.test(await page.$eval("#desk .missed > summary", (el) => el.textContent)),
    `M002 at 22': stale ${JSON.stringify(stale)}, missed ${JSON.stringify(missedAt22)}, waiting ${JSON.stringify(waitingAt22)}`);
  await page.screenshot({ path: `${shots}/desk-lookahead-M002.png` });
  await page.context().close();
}

// The structure checks on any replay, at a few moments through the match (MATCH=M001).
async function realReplay(browser, match) {
  const all = await getJson(match, "cues.json"), ss = await getJson(match, "stories.json");
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on("pageerror", (e) => fail(`${match} page error: ${e.message}`));
  await page.goto(new URL(`?match=${match}&view=2d`, base).href);
  await page.waitForFunction(() => window.studioDesk?.desk?.loaded && window.studioDesk.desk.ready, null, { timeout: 90000 });
  const firsts = ss.map((s) => firstCue(all, s.story_id)).filter(Number.isFinite).sort((a, b) => a - b);
  for (const ts of [0, firsts[0] + 2, firsts[Math.floor(firsts.length / 2)] + 2, firsts.at(-1) + 2]) await structure(page, all, ss.map((s) => s.story_id), ts, match);
  await noFactIds(page, match);
  await generated(page, all, match);
  // a generated graphic taken out in English stays out in Italian: the real replays have one cue per language
  const tpl = all.find((c) => c.story_id === null && c.lang === "en");
  const back = await page.evaluate((c) => {
    const { desk, match: m } = window.studioDesk;
    desk.takeOut(c);
    const left = desk.sheet(m.cues, c.audience, "it").filter((x) => x.graphic === c.graphic && x.ts === c.ts).length;
    desk.undo();
    return [left, desk.sheet(m.cues, c.audience, "it").filter((x) => x.graphic === c.graphic && x.ts === c.ts).length];
  }, tpl);
  expect(back[0] === 0 && back[1] > 0, `${match}: a generated graphic taken out in English, cues left in Italian then after Undo ${back}`);
  await page.context().close();
}

// The analyst's team shape panels wait for the visitor: approved one airs, a skipped one does not, and
// one nobody decided on expires into Done once its moment has passed.
async function generated(page, all, match) {
  await page.evaluate(() => document.querySelector('[data-audience="analyst"]').click());
  const panels = all.filter((c) => c.story_id === null && c.graphic === "team_stats" && c.audience === "analyst" && c.lang === "en").sort((a, b) => a.ts - b.ts);
  if (panels.length < 3) return fail(`${match}: ${panels.length} team shape panels, the check needs 3`);
  const gid = (c) => page.evaluate((x) => window.studioDesk.desk.genOf.get(`${x.graphic}|${x.ts}|${x.audience}`).story_id, c);
  const panelOn = (c) => live(page).then((l) => l.some((x) => x.story === null && x.cue && all.find((y) => y.cue_id === x.cue)?.graphic === "team_stats"
    && all.find((y) => y.cue_id === x.cue).ts === c.ts));
  const text = (sel) => page.$eval(sel, (el) => el.textContent).catch(() => null);
  const [a, b, c] = panels, ga = await gid(a), gb = await gid(b), gc = await gid(c);
  // waiting before its slot, held off air at its slot, on air once put on air
  await seekTo(page, a.ts - 2);
  const acts = await page.$$eval(`.sec-needs #story-${ga} .actions button`, (n) => n.map((x) => x.textContent.replace(/[A-Z]$/, "")));
  expect(JSON.stringify(acts) === '["Put on air","Skip"]', `${match}: waiting panel actions ${JSON.stringify(acts)}`);
  await seekTo(page, a.ts + 1);
  expect(!(await panelOn(a)), `${match}: a waiting team shape panel is on air`);
  await page.click(`#story-${ga} .act-approved`);
  await seekTo(page, a.ts + 1.5);
  expect(await panelOn(a), `${match}: an approved team shape panel is not on air`);
  expect(/approved by you/.test(await text(`#story-${ga} .tally`)), `${match}: approved panel says ${await text(`#story-${ga} .tally`)}`);
  // skipped: never on air, and Done says so
  await seekTo(page, b.ts - 2);
  await page.click(`#story-${gb} .act-rejected`);
  expect(/skipped, off air$/.test(await text("#desk .done-msg")), `${match}: skip status line ${await text("#desk .done-msg")}`);
  await seekTo(page, b.ts + 1);
  expect(!(await panelOn(b)), `${match}: a skipped team shape panel is on air`);
  expect(await text(`.sec-done #story-${gb} .outcome`) === "skipped by you", `${match}: skipped row ${await text(`#story-${gb} .outcome`)}`);
  // nobody decided: off air, then missed: counted under Done, its row with no actions left
  const end = await page.evaluate((id) => window.studioDesk.desk.slotEnd.get(id), gc);
  await seekTo(page, c.ts + 1);
  expect(!(await panelOn(c)), `${match}: an undecided team shape panel is on air`);
  await seekTo(page, end + 1);
  const row = await page.$eval(`.missed #story-${gc}`, (el) => [el.querySelector(".outcome").textContent, el.querySelectorAll("button:not(.minute)").length]).catch(() => null);
  expect(JSON.stringify(row) === '["missed, nobody put it on air in time",0]', `${match}: missed panel row ${JSON.stringify(row)}`);
  // opened, the missed list stays open while the desk redraws
  await page.click("#desk .missed > summary");
  await seekTo(page, end + 30);
  expect(await page.$eval("#desk .missed", (el) => el.open), `${match}: the missed list closed itself on a redraw`);
  await page.click("#desk .missed > summary");
  // the risk rule's panel airs by itself and says who put it there
  const mom = all.find((x) => x.story_id === null && x.graphic === "momentum" && x.audience === "analyst" && x.lang === "en");
  await seekTo(page, mom.ts + 1);
  const gm = await gid(mom);
  expect(/approved automatically \(low risk\)/.test(await text(`#story-${gm} .tally`)), `${match}: momentum panel says ${await text(`#story-${gm} .tally`)}`);
}

// Edges at 1440: an API that hangs, a refused edit, a language switch while editing, the on-air
// allow-list, a story flagged by Content Safety, and malformed replay files.
async function edges(browser) {
  const newPage = async () => {
    // bypassCSP: rule() below builds functions from strings; the CSP itself is covered by scenario()
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => fail(`edges page error: ${e.message}`));
    return page;
  };
  const rule = (page, fn, id) => page.evaluate(([f, x]) => { const d = window.studioDesk.desk; return new Function("d", "s", f)(d, d.byId.get(x)); }, [fn, id]);

  // 1. the API never answers: the replay plays at once, the desk goes offline after its timeout
  let page = await newPage();
  await page.route("**/api/**", () => new Promise(() => {}));
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.studioDesk?.desk?.loaded, null, { timeout: 15000 });
  const t1 = Date.now(); // page load alone can pass 4 s under load: time the replay from here
  await page.evaluate(() => window.studioDesk.setPlaying(true));
  await page.waitForFunction(() => window.studioDesk.state.ts > 0.5, null, { timeout: 3000 }).catch(() => {});
  const hang = await page.evaluate(() => [window.studioDesk.state.ts, window.studioDesk.desk.online]);
  expect(hang[0] > 0.5 && !hang[1] && Date.now() - t1 < 3000, `edges: the replay waits for a hanging API (ts ${hang[0]}, online ${hang[1]}, ${Date.now() - t1} ms)`);
  await seekTo(page, firstCue(cues, HELD.story_id) + 2);
  // until the desk knows this visitor's decisions, nothing can be pressed
  expect(await page.$eval("#ai-switch", (el) => el.disabled) && await page.$eval(`${card(HELD)} .act-approved`, (el) => el.disabled),
    "edges: desk controls enabled before the server answered");
  // three tries of 4 s with short pauses between them; the note opens by itself
  await page.waitForFunction(() => { const n = document.querySelector("#desk-note"); return n && !n.hidden && /did not answer in time/.test(n.textContent); }, null, { timeout: 25000 })
    .catch(() => fail("edges: no timeout note in the desk"));
  expect(Date.now() - t0 > 11000, "edges: the desk went offline after a single try");
  expect(!(await page.$eval("#ai-switch", (el) => el.disabled)), "edges: offline desk stays disabled");
  // the info button closes the note that opened by itself, and opens it again
  const note = async () => [await page.$eval("#desk-note", (el) => el.hidden), await page.$eval("#desk-info", (el) => el.getAttribute("aria-expanded"))];
  await page.click("#desk-info");
  expect(JSON.stringify(await note()) === '[true,"false"]', `edges: info did not close the offline note (${JSON.stringify(await note())})`);
  await page.click("#desk-info");
  expect(JSON.stringify(await note()) === '[false,"true"]', `edges: info did not open the note again (${JSON.stringify(await note())})`);
  await page.context().close();

  // 2. a refused edit keeps the editor and the draft, with a readable reason; a draft survives a language switch
  page = await newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.studioDesk?.desk?.online, null, { timeout: 15000 });
  await seekTo(page, ALL);
  // an unchanged save is an approval, not an edit
  let sent = null;
  page.on("request", (r) => { if (r.url().includes("/api/decisions") && r.method() === "POST") sent = r.postDataJSON(); });
  await page.click(`${card(SWING)} .act-edited`);
  await Promise.all([posted(page), page.click(`${card(SWING)} .editor .ctl.primary`)]);
  await settled(page);
  expect(sent?.decision === "approved" && !sent?.edited_text, `edges: unchanged save sent ${JSON.stringify(sent)}`);
  await page.click(`${card(AUTO)} .act-edited`);
  await page.fill(`${card(AUTO)} textarea[lang="en"]`, "Draft in English");
  await page.fill(`${card(AUTO)} textarea[lang="it"]`, "Bozza in italiano");
  await page.fill(`${card(AUTO)} input[lang="es"]`, "Titular nuevo");
  await setLang(page, "es");
  expect(await page.inputValue(`${card(AUTO)} textarea[lang="en"]`) === "Draft in English", "edges: the English draft did not survive a language switch");
  await page.route("**/api/decisions", (r) => (r.request().method() === "POST"
    ? r.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: [{ msg: "pattern" }] }) }) : r.continue()));
  await Promise.all([posted(page), page.click(`${card(AUTO)} .editor .ctl.primary`)]);
  await settled(page);
  expect(await page.inputValue(`${card(AUTO)} textarea[lang="en"]`).catch(() => null) === "Draft in English", "edges: a refused edit lost the editor or the draft");
  // the page is in Spanish here: the desk speaks it too
  expect(/carácter que la realización no acepta/.test(await page.textContent(".banner.warn").catch(() => "")), "edges: a refused edit has no readable reason");
  expect(await rule(page, "return d.status(s)", AUTO.story_id) === "auto_approved", "edges: a refused edit stayed as a decision");
  await page.unroute("**/api/decisions");
  await Promise.all([posted(page), page.click(`${card(AUTO)} .editor .ctl.primary`)]);
  expect(JSON.stringify(sent?.edited_text) === JSON.stringify({ en: "Draft in English", it: "Bozza in italiano", title_es: "Titular nuevo" }),
    `edges: saved texts ${JSON.stringify(sent?.edited_text)}`);
  // the response reaches Playwright before the page has handled it
  expect(await page.waitForSelector(`${card(AUTO)} textarea`, { state: "detached", timeout: 3000 }).then(() => true, () => false),
    "edges: editor still open after a saved edit");

  // 3. the on-air rule is an allow-list, and a flagged story is held until approved
  for (const status of ["pending", null, undefined]) {
    expect(await rule(page, `s.default_status = ${JSON.stringify(status ?? null)}; return d.onAir(s)`, HELD.story_id) === false, `edges: status ${status} goes on air`);
  }
  await rule(page, "d.decisions.delete(s.story_id); s.safety = 'flagged'; d.changed()", SWING.story_id);
  const swing = await rule(page, "return [d.status(s), d.onAir(s)]", SWING.story_id);
  expect(swing[0] === "needs_review" && swing[1] === false || SWING.default_status !== "auto_approved", `edges: flagged story on air by itself ${swing}`);
  await rule(page, "s.default_status = 'auto_approved'; s.safety = 'flagged'; d.changed()", AUTO.story_id);
  await rule(page, "d.decisions.delete(s.story_id); d.changed()", AUTO.story_id);
  expect(JSON.stringify(await rule(page, "return [d.status(s), d.onAir(s)]", AUTO.story_id)) === '["needs_review",false]', "edges: flagged auto-approved story on air by itself");
  expect(await page.$eval(`${card(AUTO)} .tally > span`, (el) => el.textContent) === "Espera tu decisión, marcada por Content Safety", "edges: flagged story not held, in Spanish");
  await page.context().close();

  // 4. malformed replay files: the desk and the traces still render
  page = await newPage();
  await page.route("**/data/DEMO/stories.json", (r) => r.fulfill({ contentType: "application/json",
    body: JSON.stringify([{ story_id: "S-000001", ts: 10, kind: "goal", texts: { en: "x" }, default_status: "auto_approved" }, null, 5]) }));
  await page.route("**/data/DEMO/traces.json", (r) => r.fulfill({ contentType: "application/json",
    body: JSON.stringify([{ seq: 1, agent: "analyst", step: "x", story_ids: "S-000001", fact_ids: "F", input_summary: "", output_summary: "" }]) }));
  await page.goto(url);
  await page.waitForFunction(() => window.studioDesk?.desk?.loaded, null, { timeout: 15000 });
  await seekTo(page, ALL);
  await page.click("#tab-traces");
  await page.click("#tab-stories");
  expect(await page.$$eval("#desk [data-item]", (n) => n.filter((x) => x.id.startsWith("story-S-")).length) === 1, "edges: malformed stories.json broke the list");
  await page.context().close();
}

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  try { await lookahead(browser); } catch (e) { fail(`lookahead: ${e.message.split("\n").slice(0, 8).join(" | ")}`); }
  if (MATCH === "DEMO") {
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      try { await scenario(browser, w, h); } catch (e) { fail(`${w}: ${e.message.split("\n").slice(0, 8).join(" | ")}`); }
    }
    try { await edges(browser); } catch (e) { fail(`edges: ${e.message.split("\n").slice(0, 8).join(" | ")}`); }
  } else {
    try { await realReplay(browser, MATCH); } catch (e) { fail(`${MATCH}: ${e.message.split("\n").slice(0, 8).join(" | ")}`); }
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.log(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log("desk ok");
