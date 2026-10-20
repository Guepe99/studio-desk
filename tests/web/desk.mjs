// Browser test of the control desk against the real API (uvicorn), on the DEMO fixture.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh desk.mjs
//
// Runs the same story twice, at 1440x900 (desk docked) and 390x844 (desk in a drawer), each in a
// fresh browser context, so a fresh visitor session. Checks: a held story's graphic is not on air
// until approved and is after; reject takes an auto-approved story off air; an edit replaces the
// why-card body; the AI switch leaves only template graphics; Space inside the desk never toggles
// play; Italian and Spanish texts on the desk and the graphic; decisions survive a reload and do
// not reach another visitor; the audit log lists them; the editor shows all three languages and an
// unchanged save is an approval; Undo of a first decision holds the story again; controls are disabled while a save is in flight; the Approve, Edit
// and Reject buttons name their story. A closed card shows only the moment, one status line, the text
// and the actions, with everything else in Details before the actions; the status line says "On air"
// only for the story on screen; a rejected story offers reason chips that reach the audit log, which
// names stories by kind and minute. Screenshots: out/shots/desk-*.png.
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
// the desk is connected and no save is in flight: its controls are enabled again
const settled = (page) => page.waitForFunction(() => { const d = window.studioDesk.desk; return d.ready && !d.busy; }, null, { timeout: 5000 });
const decide = async (page, s, cls) => {
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/decisions") && r.request().method() === "POST"),
    page.click(`${card(s)} .${cls}`),
  ]);
  await settled(page);
};

async function scenario(browser, w, h) {
  const phone = w < 1100, tag = `${w}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone });
  const page = await ctx.newPage();
  // voice.json is optional (docs/CONTRACT.md): a match without clips answers 404 and plays silent.
  // api/ask too: the page probes it with an empty body (422 with a model behind it, 503 without, as here).
  const optional = (u) => u.endsWith("/voice.json") || u.endsWith("/api/ask");
  page.on("console", (m) => { if (m.type() === "error" && !optional(m.location().url || "")) fail(`${tag} console: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`${tag} page error: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 400 && !optional(r.url())) fail(`${tag} ${r.status()} ${r.url()}`); });
  await page.goto(url);
  await page.waitForFunction(() => window.studioDesk?.desk?.online, null, { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => document.querySelector('[data-audience="analyst"]').click());
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
    expect(await page.$eval("#desk-open", (el) => el.getAttribute("aria-label")) === "Desk, 3 waiting for review", `${tag}: Desk button name`);
    expect(await page.$eval("#desk-open .off", (el) => el.hidden), `${tag}: Desk button says offline while online`);
  }
  expect(await page.$eval(`${card(HELD)} .act-approved`, (el) => el.getAttribute("aria-label")).then((l) => /^Put on air: Key pass at minute \d+/.test(l)),
    `${tag}: Put on air does not name its story`);

  // 0. a closed card: the moment, one status line, the text, Details, the actions; nothing is lost, only moved
  await openDesk();
  for (const s of [HELD, AUTO, SWING]) {
    const c = await page.$eval(card(s), (el) => {
      const more = el.querySelector(":scope > details.more"), primary = el.querySelector(".actions .primary");
      return { parts: [...el.children].map((x) => x.className.split(" ")[0] || x.tagName), open: more?.open ?? null, h: Math.round(el.getBoundingClientRect().height),
        outside: [...el.querySelectorAll(".story-meta, .risk, .risk-tip, .proposal, .checks, .flagged, .evidence, .link")].filter((x) => !more?.contains(x)).map((x) => x.className),
        inside: [".risk b", ".risk-tip", ".checks", ".evidence summary", ".link"].filter((q) => more?.querySelector(q)).length,
        // D9: the Details (and the evidence in it) come before the primary in the tab order
        first: !primary || !!(more && more.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING) };
    });
    expect(c.parts.join() === "story-head,tally,story-text,more,actions" && c.open === false && !c.outside.length && c.inside === 5 && c.first,
      `${tag}: closed card ${s.story_id} ${JSON.stringify(c)}`);
    if (phone) expect(c.h <= 330, `${tag}: closed card ${s.story_id} is ${c.h} px tall at 390x844`);
  }
  if (await page.$(`${card(SWING)} .proposal`)) expect(await page.$eval(`${card(SWING)} .proposal`, (el) => !!el.closest("details.more")), `${tag}: the AI proposal is not in Details`);

  // 1. held until approved
  expect(!(await onAirAt(page, HELD)), `${tag}: ${HELD.story_id} needs review but its graphic is on air`);
  expect((await onAirAt(page, AUTO)) !== null, `${tag}: auto-approved ${AUTO.story_id} not on air`);
  if (phone) {
    await openDesk();
    expect(await page.evaluate(() => document.querySelector("#app").inert && document.querySelector("#desk").getAttribute("aria-modal") === "true"),
      `${tag}: open drawer is not modal`);
    await closeDesk();
    expect(await page.evaluate(() => !document.querySelector("#app").inert && !document.querySelector("#desk").hasAttribute("aria-modal")),
      `${tag}: closed drawer leaves the page inert`);
  }
  await openDesk();
  expect(await page.$$eval(`${card(HELD)} .mini`, (n) => n.length) === 0, `${tag}: pitch map built with the evidence closed`);
  await page.click(`${card(HELD)} .more > summary`);
  await page.click(`${card(HELD)} .evidence summary`); // evidence open in the shot
  await seekTo(page, whyCue(HELD).ts + 2);
  await shoot("needs-review");
  expect(await page.$eval(`${card(HELD)} .tally`, (el) => el.textContent).then((x) => x.startsWith("Waiting for you, ")), `${tag}: held story not marked Waiting for you`);
  expect(await page.$$eval(`${card(HELD)} .mini line.ev`, (n) => n.length) > 0, `${tag}: evidence pitch has no event arrow`);
  await decide(page, HELD, "act-approved");
  expect((await onAirAt(page, HELD)) !== null, `${tag}: ${HELD.story_id} approved but its graphic is not on air`);
  expect(await page.$eval(`${card(HELD)} .tally`, (el) => el.textContent) === "On air, approved by you", `${tag}: approved story on screen not marked On air`);
  await shoot("approved");
  await shootAir("approved");
  // Undo of a first decision: the server drops it and the story is held again
  await openDesk();
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/decisions") && r.request().method() === "DELETE"), page.click("#desk .undo")]);
  await settled(page);
  expect(await page.$eval(`${card(HELD)} .tally`, (el) => el.textContent).then((x) => x.startsWith("Waiting for you, ")), `${tag}: undone story not held again`);
  expect(!(await page.evaluate(async () => (await (await fetch("api/decisions?match_id=DEMO")).json()).decisions.length)), `${tag}: the server kept the undone decision`);
  expect(!(await onAirAt(page, HELD)), `${tag}: undone ${HELD.story_id} still on air`);
  await openDesk();
  await decide(page, HELD, "act-approved");

  // 2. edit replaces the why-card body for this visitor
  await openDesk();
  await page.click(`${card(AUTO)} .act-edited`);
  const areas = await page.$$eval(`${card(AUTO)} textarea`, (n) => n.map((x) => [x.lang, x.value]));
  expect(JSON.stringify(areas) === JSON.stringify(["en", "it", "es"].map((l) => [l, AUTO.texts[l]])), `${tag}: editor languages ${JSON.stringify(areas)}`);
  expect(await page.evaluate(() => document.activeElement?.lang) === "en", `${tag}: Edit did not focus the English text`);
  await page.fill(`${card(AUTO)} textarea[lang="en"]`, EDIT);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/decisions") && r.request().method() === "POST"),
    page.click(`${card(AUTO)} .ctl.primary`),
  ]);
  await settled(page);
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
  // D7: what was wrong, one tap; kept in the tab and named in the audit log (step 7)
  await openDesk();
  const chips = await page.$$eval(`${card(AUTO)} .reasons button`, (n) => n.map((b) => [b.textContent, b.getAttribute("aria-pressed")]));
  expect(chips.length === 4 && chips.every((c) => c[1] === "false"), `${tag}: reason chips after Reject ${JSON.stringify(chips)}`);
  await page.click(`${card(AUTO)} .reasons button`);
  expect(await page.$eval(`${card(AUTO)} .reasons button`, (b) => b.getAttribute("aria-pressed")) === "true", `${tag}: a reason chip does not stay pressed`);
  await shoot("rejected", card(AUTO));

  // 4. Space on a desk button presses it and never toggles play
  await openDesk();
  const playing = await page.evaluate(() => window.studioDesk.state.playing);
  await page.focus(`${card(SWING)} .act-approved`);
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/decisions")), page.keyboard.press("Space")]);
  expect(await page.evaluate(() => window.studioDesk.state.playing) === playing, `${tag}: Space in the desk toggled play`);
  await settled(page);
  // N6: approved but not on screen now is "Approved", never the red "On air"
  expect(await page.$eval(`${card(SWING)} .tally`, (el) => [el.textContent, el.closest(".story").dataset.tally]).then(([x, d]) => x === "Approved by you" && d === "approved"),
    `${tag}: Space did not approve, or a story off screen reads On air (${await page.$eval(`${card(SWING)} .tally`, (el) => el.textContent)})`);
  await seekTo(page, whyCue(SWING).ts + 2);
  const lines = await page.evaluate(([a, b]) => [a, b].map((id) => document.querySelector(`#story-${id} .tally`).textContent), [SWING.story_id, HELD.story_id]);
  expect(lines[0] === "On air, approved by you" && lines[1] === "Approved by you", `${tag}: on screen, the status lines read ${JSON.stringify(lines)}`);

  // 4b. the AI proposal sits in Details; "Use proposal" puts it on air
  await page.click(`${card(SWING)} .more > summary`);
  const proposal = await page.$eval(`${card(SWING)} .proposal-text`, (el) => el.textContent);
  expect(proposal.includes(SWING.verifier.proposals.en) && proposal.includes("not on air"), `${tag}: proposal block ${JSON.stringify(proposal)}`);
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/decisions")), page.click(`${card(SWING)} .proposal button`)]);
  expect(await page.$eval(`${card(SWING)} .story-text`, (el) => el.textContent) === SWING.verifier.proposals.en, `${tag}: Use proposal did not put it on air`);
  expect(!(await page.$(`${card(SWING)} .proposal button`)), `${tag}: Use proposal button still there once used`);

  // 5. AI off: only template graphics
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

  // 6. traces from a story card
  await openDesk();
  await page.click(`${card(HELD)} .link`);
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

  // 7. audit log
  await page.click("#tab-audit");
  const actions = await page.$$eval(".log tr.a-human td:nth-child(3)", (n) => n.map((x) => x.textContent));
  for (const a of ["approved", "edited", "rejected: a number", "switched AI graphics off", "switched AI graphics on"]) {
    expect(actions.some((x) => x.startsWith(a)), `${tag}: audit has no "${a}" row`);
  }
  // N20: a story by its name and minute, as the desk names it; the id only in the tooltip
  const sids = await page.$$eval(".log .sid", (n) => n.map((x) => x.textContent));
  expect(sids.length && sids.every((x) => !/S-\d{6}/.test(x)) && sids.some((x) => /^Goal \d+'$/.test(x)), `${tag}: audit names stories ${JSON.stringify(sids.slice(0, 4))}`);
  expect(await page.$$eval(".log tr.a-agent", (n) => n.length) > 0, `${tag}: audit has no agent rows`);
  await shoot("audit", null);

  // 8. languages: desk text and graphic body
  await page.click("#tab-stories");
  for (const lang of ["it", "es"]) {
    if (phone) await closeDesk();
    await page.evaluate((l) => document.querySelector(`[data-lang="${l}"]`).click(), lang);
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
  await page.evaluate((l) => document.querySelector(`[data-lang="${l}"]`).click(), "en");

  // 9. the broadcast never moved
  const frameAfter = await page.$eval("#frame", (el) => el.getBoundingClientRect().toJSON());
  expect(JSON.stringify(frameBefore) === JSON.stringify(frameAfter), `${tag}: the broadcast frame moved ${JSON.stringify([frameBefore, frameAfter])}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tag}: horizontal scroll`);

  // 10. decisions survive a reload; another visitor sees the original replay
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
  await page.evaluate(() => window.studioDesk.setPlaying(true));
  await page.waitForFunction(() => window.studioDesk.state.ts > 0.5, null, { timeout: 3000 }).catch(() => {});
  expect(await page.evaluate(() => window.studioDesk.state.ts > 0.5 && !window.studioDesk.desk.online) && Date.now() - t0 < 4000,
    "edges: the replay waits for a hanging API");
  // until the desk knows this visitor's decisions, nothing can be pressed
  expect(await page.$eval("#ai-switch", (el) => el.disabled) && await page.$eval(`${card(AUTO)} .act-rejected`, (el) => el.disabled),
    "edges: desk controls enabled before the server answered");
  // three tries of 4 s with short pauses between them
  await page.waitForFunction(() => /did not answer in time/.test(document.querySelector(".desk-foot")?.textContent ?? ""), null, { timeout: 25000 })
    .catch(() => fail("edges: no timeout note in the desk footer"));
  expect(Date.now() - t0 > 11000, "edges: the desk went offline after a single try");
  expect(!(await page.$eval("#ai-switch", (el) => el.disabled)), "edges: offline desk stays disabled");
  await page.context().close();

  // 2. a refused edit keeps the editor and the draft, with a readable reason; a draft survives a language switch
  page = await newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.studioDesk?.desk?.online, null, { timeout: 15000 });
  // an unchanged save is an approval, not an edit
  let sent = null;
  page.on("request", (r) => { if (r.url().includes("/api/decisions") && r.method() === "POST") sent = r.postDataJSON(); });
  await page.click(`${card(SWING)} .act-edited`);
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/decisions") && r.request().method() === "POST"), page.click(`${card(SWING)} .ctl.primary`)]);
  await settled(page);
  expect(sent?.decision === "approved" && !sent?.edited_text, `edges: unchanged save sent ${JSON.stringify(sent)}`);
  await page.click(`${card(AUTO)} .act-edited`);
  await page.fill(`${card(AUTO)} textarea[lang="en"]`, "Draft in English");
  await page.fill(`${card(AUTO)} textarea[lang="it"]`, "Bozza in italiano");
  await page.evaluate((l) => document.querySelector(`[data-lang="${l}"]`).click(), "es");
  expect(await page.inputValue(`${card(AUTO)} textarea[lang="en"]`) === "Draft in English", "edges: the English draft did not survive a language switch");
  await page.route("**/api/decisions", (r) => (r.request().method() === "POST"
    ? r.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: [{ msg: "pattern" }] }) }) : r.continue()));
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/decisions") && r.request().method() === "POST"), page.click(`${card(AUTO)} .ctl.primary`)]);
  await settled(page);
  expect(await page.inputValue(`${card(AUTO)} textarea[lang="en"]`).catch(() => null) === "Draft in English", "edges: a refused edit lost the editor or the draft");
  // the page is in Spanish here: the desk speaks it too
  expect(/carácter que la mesa no acepta/.test(await page.textContent(".banner.warn").catch(() => "")), "edges: a refused edit has no readable reason");
  expect(await rule(page, "return d.status(s)", AUTO.story_id) === "auto_approved", "edges: a refused edit stayed as a decision");
  await page.unroute("**/api/decisions");
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/decisions") && r.request().method() === "POST"), page.click(`${card(AUTO)} .ctl.primary`)]);
  expect(sent?.edited_text?.en === "Draft in English" && sent?.edited_text?.it === "Bozza in italiano" && !("es" in sent.edited_text),
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
  expect(await page.$eval(`${card(AUTO)} .tally`, (el) => el.textContent) === "Espera tu decisión, marcada por Content Safety", "edges: flagged story not held, in Spanish");
  await page.context().close();

  // 4. malformed replay files: the desk and the traces still render
  page = await newPage();
  await page.route("**/data/DEMO/stories.json", (r) => r.fulfill({ contentType: "application/json",
    body: JSON.stringify([{ story_id: "S-000001", ts: 10, kind: "goal", texts: { en: "x" }, default_status: "auto_approved" }, null, 5]) }));
  await page.route("**/data/DEMO/traces.json", (r) => r.fulfill({ contentType: "application/json",
    body: JSON.stringify([{ seq: 1, agent: "analyst", step: "x", story_ids: "S-000001", fact_ids: "F", input_summary: "", output_summary: "" }]) }));
  await page.goto(url);
  await page.waitForFunction(() => window.studioDesk?.desk?.loaded, null, { timeout: 15000 });
  await page.click("#tab-traces");
  await page.click("#tab-stories");
  expect(await page.$$eval(".story", (n) => n.length) === 1, "edges: malformed stories.json broke the list");
  await page.context().close();
}

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    try { await scenario(browser, w, h); } catch (e) { fail(`${w}: ${e.message.split("\n").slice(0, 8).join(" | ")}`); }
  }
  try { await edges(browser); } catch (e) { fail(`edges: ${e.message.split("\n").slice(0, 8).join(" | ")}`); }
} finally {
  await browser.close();
}
if (failures.length) {
  console.log(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log("desk ok");
