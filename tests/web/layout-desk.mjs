// The desk and the agent strip as a first-time visitor meets them (the desk design is in docs/desk.md; each check
// below has a number that its failure messages repeat), on the real page at 1280x720, 1280x560, 1440x900, 1920x1080,
// 844x390, 390x844, 320x568 and 320x180, static hosting (the desk works offline, in the tab), on the
// DEMO fixture by default:
// - the header is one line: at 1280x720 the desk's head with its tabs is at most 80 px tall, in
//   English, Italian and Spanish; on a phone the sheet leaves at least 40% of the height to the page
// - 5: before any story, the empty Needs you says what the desk is for; a held story has exactly one
//   filled action, "Put on air", and one on air has none; Details says Low, Medium or High risk with
//   an instruction, the score only in its tooltip
// - 9: on a touch screen the Details summary keeps its disclosure triangle (a list item) at 44 px
// - 17: a decision says what it did on air in a status line, and Undo takes it back
// - no fact id (F-...-n) in the desk's text, with every Details open
// - 14: the audit log's last column can be brought into view inside the desk
// - 18: no agent shows as an id with an underscore (audit, traces, strip)
// - 15: Esc closes the drawer with the focus on the page body
// - 13: every agent name in the strip is whole (no ellipsis) and the strip shows no cost per agent
// - 11: in Italian, <html lang> is "it" and the desk, the strip, the radar, the replay badge, the voice
//   button and the graphics' kickers show no English word outside the agents' own output (marked lang="en")
// - 19: the first card's primary action is in view without scrolling the desk (in English, Italian
//   and Spanish); 20: "offline" on the Desk button is not the error colour; docked,
//   the audit table fits the desk without its own sideways scroll and "What" is not one word a line
// - docked, with the Ask panel open over the foot of the desk, no desk button or Details is under it
// Screenshots: out/shots/layout-<size>-{en,audit,strip,it,ask}.png. SIZES='[[320,180]]' runs some sizes only.
// LAYOUT_BREAK=1 makes the audit table 640 px wide: with the scroller the run still passes.
//
//   WEBGL=0 [MATCH=M001] scripts/with-lock.sh chromium tests/web/run-smoke.sh layout-desk.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const MATCH = process.env.MATCH ?? "DEMO";
const PFX = MATCH === "DEMO" ? "layout" : `layout-${MATCH}`;
const SIZES = process.env.SIZES ? JSON.parse(process.env.SIZES) : [[1280, 720], [1280, 560], [1440, 900], [1920, 1080], [844, 390], [390, 844], [320, 568], [320, 180]];
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const expect = (ok, msg) => { if (!ok) fail(msg); };
const ENGLISH = /\b(Approve|Put on air|Keep on air|Take out|Reject|Edit|Held|On air|Off air|Needs you|Done|Next|Risk|Evidence|Stories|Audit log|Traces|Show trace|Low|Medium|High|waiting|Close|Desk|Undo|Details|Swap|voice-over|Loading|Picked|Wrote|Rewrote|Checked|rundown|Your actions)\b|\bS-\d{6}\b/;
const FACT_ID = /F-[A-Z0-9_]+-\d+/;
// the language: a button in the settings menu
const setLang = (page, l) => page.evaluate((x) => document.querySelector(`[data-lang="${x}"]`).click(), l);

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();

// English words in the visible text and the accessible names under `sel`, outside lang="en"
const englishIn = (page, sel) => page.evaluate(([s, re]) => {
  const rx = new RegExp(re), out = [];
  const en = (el) => el.closest("[lang]")?.lang === "en";
  for (const root of document.querySelectorAll(s)) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode());) {
      const p = n.parentElement;
      if (!p || en(p) || !p.checkVisibility({ visibilityProperty: true }) || !rx.test(n.nodeValue)) continue;
      out.push(n.nodeValue.trim().slice(0, 60));
    }
    for (const el of [root, ...root.querySelectorAll("[aria-label],[title]")]) for (const a of ["aria-label", "title"]) {
      const v = el.getAttribute(a);
      if (v && !en(el) && rx.test(v)) out.push(`${a}=${v.slice(0, 60)}`);
    }
  }
  return out;
}, [sel, ENGLISH.source]);

async function run(w, h) {
  const tag = `${w}x${h}`, touch = w < 1100 || h < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/\/api\/|(voice|booth|season)\.json/.test(m.location()?.url ?? "")) fail(`${tag} console: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`${tag} page error: ${e.message}`));
  await page.goto(new URL(`index.html?match=${MATCH}&view=2d`, base).href);
  await page.waitForFunction(() => window.studioDesk?.desk?.ready && window.studioDesk.match, null, { timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  const drawer = await page.$eval("#desk-open", (el) => getComputedStyle(el).display !== "none");
  const openDesk = async () => {
    if (drawer && !(await page.evaluate(() => document.body.classList.contains("desk-open")))) {
      await page.evaluate(() => document.querySelector("#desk-open").click());
      await page.waitForTimeout(300);
    }
  };
  const seek = (ts) => page.evaluate(async (x) => {
    const sd = window.studioDesk, raf = () => new Promise((r) => requestAnimationFrame(r));
    sd.setPlaying(false); sd.seek(x); await raf(); await raf();
    await Promise.all([document.fonts.ready, ...[...sd.host.live.values()].map((i) => i.chain)]);
    await new Promise((r) => setTimeout(r, 800));
  }, ts);
  // a held story when the match has one (DEMO), else one the risk rule put on air (M001)
  const pick = await page.evaluate(() => {
    const d = window.studioDesk.desk, first = (x) => Math.min(...window.studioDesk.match.cues.filter((c) => c.story_id === x?.story_id).map((c) => c.ts));
    // an auto story needs a second between its facts and its graphic, where it is listed as Next (check 9)
    const s = d.stories.find((x) => d.status(x) === "needs_review") ?? d.stories.find((x) => d.status(x) === "auto_approved" && x.ts + 1 < first(x));
    return s && { id: s.story_id, held: d.status(s) === "needs_review", at: first(s), ts: s.ts };
  });
  if (!pick) { fail(`${tag}: no held or auto-approved story in ${MATCH}`); return ctx.close(); }
  const card = `#story-${pick.id}`;
  const want = pick.held ? { act: "act-approved", filled: ["Put on air"], said: /^.+ \d+(\+\d+)?' approved, on air$/, line: /^On air, approved by you$/, undone: /^Waiting for you, /, back: /^Undone: .+ is held again$/ }
    : { act: "act-rejected", filled: [], said: /^.+ \d+(\+\d+)?' rejected, off air$/, line: /^Off air, rejected by you$|^rejected by you$/, undone: /^On air, approved automatically \(low risk\)$/, back: /^Undone: .+ is on air again$/ };
  await openDesk();
  // 5: at kick-off nothing is listed, and the empty Needs you says what the desk is for
  await seek(0);
  const purpose = await page.$eval("#desk .sec-needs .empty", (el) => el.textContent).catch(() => "");
  expect(purpose.length > 40 && !(await page.$("#desk [data-item]")), `${tag} 5: at kick-off the desk lists stories or does not say what it is for ${JSON.stringify(purpose)}`);
  // the header: one line and the tabs, at most 80 px at 1280x720 in the three languages
  if (w === 1280 && h === 720) for (const lang of ["en", "it", "es", "en"]) {
    await setLang(page, lang);
    const head = await page.evaluate(() => {
      const d = document.querySelector("#desk").getBoundingClientRect(), t = document.querySelector("#desk .desk-tabs").getBoundingClientRect();
      return { h: Math.round(t.bottom - d.top), title: Math.round(document.querySelector("#desk .desk-title").getBoundingClientRect().height) };
    });
    expect(head.h <= 80, `${tag} ${lang}: the desk header is ${head.h} px tall ${JSON.stringify(head)}`);
  }
  // on a phone the title, the AI switch and Close share one row in the three languages
  if (w === 390) for (const lang of ["en", "it", "es", "en"]) {
    await setLang(page, lang);
    const rows = await page.evaluate(() => ["#desk .desk-title h2", "#ai-switch", "#desk-close"].map((s) => {
      const r = document.querySelector(s).getBoundingClientRect(); return Math.round(r.top + r.height / 2);
    }));
    expect(Math.max(...rows) - Math.min(...rows) <= 12, `${tag} ${lang}: the desk header wraps on the phone ${JSON.stringify(rows)}`);
  }
  // the phone sheet leaves at least 40% of the height to the broadcast
  if (drawer) {
    const top = await page.$eval("#desk", (el) => el.getBoundingClientRect().top);
    expect(top >= 0.4 * h - 1, `${tag}: the open sheet starts at ${Math.round(top)} px of ${h}`);
  }
  await seek(pick.at + 1);
  // 19: the first card's primary action is on screen without scrolling the desk
  const firstAction = () => page.evaluate(() => {
    const b = document.querySelector("#desk .story .actions button"), desk = document.querySelector("#desk").getBoundingClientRect();
    if (!b) return { none: true };
    const r = b.getBoundingClientRect();
    return { text: b.textContent, top: Math.round(r.top), bottom: Math.round(r.bottom), seen: r.top >= desk.top && r.bottom <= Math.min(desk.bottom, innerHeight) };
  });
  const roomy = h >= 700;   // a short window (a phone on its side) has no room for a whole card under the desk head
  if (roomy) { const a = await firstAction(); expect(a.seen, `${tag} 19: the first card's ${JSON.stringify(a.text)} is below the fold ${JSON.stringify(a)}`); }
  // 20: offline is a state of the desk, not an error
  if (drawer) {
    const off = await page.$eval("#desk-open .off", (el) => ({ hidden: el.hidden, color: getComputedStyle(el).color }));
    expect(!off.hidden && off.color !== "rgb(230, 0, 35)", `${tag} 20: the Desk button's offline word ${JSON.stringify(off)}`);
  }

  // 5. one filled action where a decision waits, risk in words inside Details
  const head = await page.evaluate((c) => {
    const el = document.querySelector(c), more = el.querySelector("details.more");
    const filled = [...el.querySelectorAll(".actions button")].filter((b) => {
      const bg = getComputedStyle(b).backgroundColor;
      return bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent" && bg !== getComputedStyle(document.body).backgroundColor;
    });
    more.open = true;
    more.dispatchEvent(new Event("toggle"));
    const why = el.querySelector(".why"), risk = why?.querySelector(".risk");
    const out = { filled: filled.map((b) => b.firstChild.textContent), risk: risk?.querySelector("b")?.textContent, title: risk?.title ?? "",
      tip: why ? why.textContent.slice(risk.textContent.length).trim() : "" };
    more.open = false;
    return out;
  }, card);
  expect(JSON.stringify(head.filled) === JSON.stringify(want.filled), `${tag} 5: the story's filled actions ${JSON.stringify(head.filled)}`);
  expect(/^(Low|Medium|High) risk$/.test(head.risk) && /^Risk score \d/.test(head.title) && head.tip.length > 10,
    `${tag} 5: risk reads ${JSON.stringify(head.risk)}, tooltip ${JSON.stringify(head.title)}, instruction ${JSON.stringify(head.tip)}`);
  // no fact id in what the desk shows, every Details open
  const fid = await page.evaluate((re) => {
    for (const d of document.querySelectorAll("#desk details.more")) { d.open = true; d.dispatchEvent(new Event("toggle")); }
    const m = document.querySelector("#desk").innerText.match(new RegExp(re));
    for (const d of document.querySelectorAll("#desk details.more")) d.open = false;
    return m?.[0] ?? null;
  }, FACT_ID.source);
  expect(!fid, `${tag}: fact id ${fid} in the desk text`);

  // 9. a touch target that is still a disclosure: Details, and the evidence inside it
  if (touch) {
    // an auto story on air sits in the compact strip, which hides Details on a phone: measure it before its graphic, as Next
    const aired = !!(await page.$(`#desk .sec-air ${card}`));
    if (aired) await seek((pick.ts + pick.at) / 2);
    const sums = await page.evaluate((c) => {
      const more = document.querySelector(`${c} details.more`);
      if (more) more.open = true;
      return [`${c} .more > summary`].map((q) => {
        const s = document.querySelector(q);
        if (!s) return { none: q };
        return { coarse: matchMedia("(pointer: coarse)").matches, display: getComputedStyle(s).display, height: s.getBoundingClientRect().height };
      });
    }, card);
    for (const sum of sums) {
      expect(sum.coarse, `${tag} 9: the touch context does not match (pointer: coarse), the check measures nothing`);
      expect(sum.display === "list-item" && sum.height >= 44, `${tag} 9: disclosure summary ${JSON.stringify(sum)}`);
    }
    await page.evaluate((c) => { const more = document.querySelector(`${c} details.more`); if (more) more.open = false; }, card);
    if (aired) await seek(pick.at + 1);
  }

  // 17. the status line and Undo
  await page.$eval(`${card} .${want.act}`, (b) => b.scrollIntoView({ block: "center" }));
  await page.click(`${card} .${want.act}`);
  const said = await page.$eval("#desk .done-msg", (el) => el.textContent).catch(() => "");
  expect(want.said.test(said), `${tag} 17: after ${want.act} the status line says ${JSON.stringify(said)}`);
  const now = () => page.$eval(card, (el) => (el.querySelector(".tally > span") ?? el.querySelector(".tally") ?? el.querySelector(".outcome"))?.textContent ?? "");
  // the graphic reaches the screen a frame or two after the click: give the card up to 3 s to settle
  const line = async (re) => { for (let i = 0; i < 30 && !re.test(await now()); i++) await page.waitForTimeout(100); return now(); };
  expect(want.line.test(await line(want.line)), `${tag} 17: after ${want.act} the story reads ${JSON.stringify(await now())}`);
  const undo = await page.$("#desk .undo");
  expect(undo && await undo.isVisible(), `${tag} 17: no Undo after a decision`);
  if (undo && await undo.isVisible()) {
    await undo.click();
    expect(want.undone.test(await line(want.undone)), `${tag} 17: after Undo the story reads ${JSON.stringify(await now())}, not ${want.undone}`);
    const back = await page.$eval("#desk .done-msg", (el) => el.textContent);
    expect(want.back.test(back), `${tag} 17: after Undo the status line says ${JSON.stringify(back)}`);
  }
  await shot(page, `${PFX}-${tag}-en.png`);

  // 14 and 18. the audit log: the last column in reach, people's names not ids
  // LAYOUT_BREAK=1 widens the table past any phone (as a narrow window would): the check must still find the last column
  if (process.env.LAYOUT_BREAK === "1") await page.addStyleTag({ content: "#desk table.log { min-width: 640px; }" });
  await page.evaluate(() => document.querySelector("#tab-audit").click());
  await page.waitForTimeout(100);
  const audit = await page.evaluate(() => {
    const t = document.querySelector("#desk table.log");
    if (!t) return { none: true };
    const last = t.querySelector("tr").lastElementChild;
    // scroll every scrollable ancestor to its end, then the last header must be inside all their boxes
    const clips = [];
    for (let a = t.parentElement; a && a !== document.body; a = a.parentElement) {   // the desk's own boxes; the page is style.mjs's
      const o = getComputedStyle(a).overflowX;
      if (o !== "visible") { if (o === "auto" || o === "scroll") a.scrollLeft = a.scrollWidth; clips.push(a); }
    }
    const r = last.getBoundingClientRect();
    const cut = clips.filter((a) => { const b = a.getBoundingClientRect(); return r.right > b.right + 1 || r.left < b.left - 1; }).map((a) => a.id || a.className);
    if (r.right > innerWidth + 1) cut.push("viewport");
    // reaching it by scrolling the whole desk sideways does not count: only the table's own scroller may
    const own = clips[0] === t.parentElement ? clips[0] : null;   // a scroller around the table alone
    const wide = (a) => [...a.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > a.getBoundingClientRect().right + 1 && e.checkVisibility())
      .slice(0, 3).map((e) => `${e.tagName.toLowerCase()}#${e.id}.${String(e.className).split(" ")[0]}`);
    for (const a of clips) if (a !== own && a.scrollWidth > a.clientWidth + 1) cut.push(`${a.id || a.className} scrolls sideways (${wide(a)})`);
    const who = [...t.querySelectorAll("tbody tr")].map((row) => row.cells[1]?.textContent ?? "");
    const wrap = t.closest(".log-wrap"), whatTh = [...t.querySelectorAll("th")].find((x) => x.textContent === "What");
    return { cut, who, cells: t.querySelectorAll("tbody tr").length, side: wrap ? wrap.scrollWidth - wrap.clientWidth : 0, what: Math.round(whatTh?.getBoundingClientRect().width ?? 0) };
  });
  // 14: docked, the table fits the desk as it is, and "What" has room for a few words a line
  if (!drawer && process.env.LAYOUT_BREAK !== "1") expect(audit.side <= 1 && audit.what >= 110, `${tag} 14: docked audit table scrolls ${audit.side} px sideways, "What" is ${audit.what} px wide`);
  expect(!audit.none && audit.cells > 0, `${tag} 14: no audit rows after a decision`);
  expect(!audit.none && !audit.cut?.length, `${tag} 14: the audit log's last column is cut by ${JSON.stringify(audit.cut)}`);
  expect(!audit.who?.some((x) => x.includes("_")), `${tag} 18: audit Who shows ids ${JSON.stringify(audit.who)}`);
  await page.evaluate(() => { const t = document.querySelector("#desk table.log")?.closest(".log-wrap"); if (t) t.scrollLeft = 0; });
  await shot(page, `${PFX}-${tag}-audit.png`);
  await page.evaluate(() => document.querySelector("#tab-traces").click());
  await page.waitForTimeout(100);
  const ids = await page.$$eval("#desk [data-agent] b, #desk .step-head b", (n) => n.map((x) => x.textContent).filter((x) => x.includes("_")));
  expect(!ids.length, `${tag} 18: traces show ids ${JSON.stringify(ids)}`);
  await page.evaluate(() => document.querySelector("#tab-stories").click());

  // 15. Esc closes the drawer wherever the focus is
  if (drawer) {
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    expect(!(await page.evaluate(() => document.body.classList.contains("desk-open"))), `${tag} 15: Esc with the focus on the page did not close the drawer`);
  }

  // 13. the strip: whole names, no cost per agent
  const spill0 = await page.$eval("#activity", (el) => el.scrollWidth - el.clientWidth);
  expect(spill0 <= 1, `${tag} 13: before the first hand-off the strip runs ${spill0} px past its box`);
  const mid = await page.evaluate(() => { const t = window.studioDesk.desk.traces ?? []; return t.length ? t[Math.floor(t.length / 2)].ts + 1 : window.studioDesk.match.duration / 2; });
  await seek(mid);
  const strip = await page.$$eval("#activity .act-name, #activity .act-meta", (n) => n.filter((x) => x.checkVisibility()).map((x) => ({
    cls: x.className, text: x.textContent, w: [x.scrollWidth, x.clientWidth, x.parentElement.clientWidth, document.querySelector("#activity").clientWidth], cut: x.scrollWidth > x.clientWidth + 1 })));
  const spill = await page.$eval("#activity", (el) => el.scrollWidth - el.clientWidth);
  expect(spill <= 1, `${tag} 13: the strip runs ${spill} px past its box`);
  const names = strip.filter((x) => x.cls.includes("act-name"));
  if (!names.length) console.log(`${tag} 13: the strip shows no agent at this size`);
  for (const x of strip) {
    if (x.cls.includes("act-name")) expect(!x.cut && !x.text.includes("_"), `${tag} 13/18: agent name ${JSON.stringify(x.text)} cut or an id ${JSON.stringify(x.w)}`);
    else expect(!/\$|€|token/i.test(x.text), `${tag} 13: the strip shows a cost per agent ${JSON.stringify(x.text)}`);
  }

  await shot(page, `${PFX}-${tag}-strip.png`);

  // 11. Italian everywhere outside the agents' own output
  await setLang(page, "it");
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => document.documentElement.lang) === "it", `${tag} 11: <html lang> stays ${await page.evaluate(() => document.documentElement.lang)}`);
  await openDesk();
  // 19 again in Italian and Spanish, from the top of the desk
  if (roomy) for (const lang of ["it", "es", "it"]) {
    await setLang(page, lang);
    await page.evaluate(() => { for (const el of [document.querySelector("#desk"), document.querySelector("#desk .desk-body")]) el.scrollTop = 0; });
    // the desk re-renders after a language switch: measure once it has settled
    let a = await firstAction();
    for (let i = 0; i < 30 && !a.seen; i++) { await page.waitForTimeout(100); a = await firstAction(); }
    expect(a.seen, `${tag} 19 ${lang}: the first card's ${JSON.stringify(a.text)} is below the fold ${JSON.stringify(a)}`);
  }
  const leftovers = await englishIn(page, "#desk, #activity, #desk-open, #radar, #replay-badge, #voice");
  expect(!leftovers.length, `${tag} 11: English in the Italian page ${JSON.stringify(leftovers.slice(0, 6))}`);
  const kick = await page.evaluate(() => {
    const sd = window.studioDesk, c = sd.desk.sheet(sd.match.cues, sd.state.audience, sd.state.lang).find((x) => x.graphic === "why_card");
    return c?.ts;
  });
  if (kick === undefined) fail(`${tag} 11: no why card on air in Italian`);
  else {
    await seek(kick + 2);
    const k = await page.evaluate(() => [...window.studioDesk.host.live.values()].map((i) => i.el.shadowRoot?.querySelector(".kicker")?.textContent).filter(Boolean));
    expect(k.length && k.every((x) => !/KEY MOMENT|RECAP|SHOT SPEED|PASS SPEED|MOMENTUM/.test(x)), `${tag} 11: Italian kickers ${JSON.stringify(k)}`);
  }
  await openDesk();
  await shot(page, `${PFX}-${tag}-it.png`);

  // docked, the open Ask panel covers the foot of the desk: no visible desk button or Details sits under it
  // (a click there landed on the panel's input), at the end of the match with Done full and the desk scrolled down
  if (!drawer) {
    await seek(await page.evaluate(() => window.studioDesk.match.duration - 1));
    const under = await page.evaluate(async () => {
      document.querySelector("#ask").hidden = false;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      await raf(); await raf();
      for (const d of document.querySelectorAll("#desk details:not(.more)")) d.open = true;
      await raf();
      for (const el of [document.querySelector("#desk"), document.querySelector("#desk .desk-body")]) el.scrollTop = el.scrollHeight;
      await raf(); await raf();
      const out = [];
      let n = 0;
      for (const el of document.querySelectorAll("#desk button, #desk summary")) {
        if (!el.checkVisibility()) continue;
        const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (r.height === 0 || y < 0 || y > innerHeight) continue;
        n++;
        const hit = document.elementFromPoint(x, y);
        // the desk's own sticky head over a scrolled row is scrolling, not covering: only something outside the desk counts
        if (!hit?.closest("#desk")) out.push(`${el.textContent.trim().slice(0, 20)} under ${hit?.closest("[id]")?.id ?? hit?.tagName}`);
      }
      return { n, out, list: document.querySelector("#desk .desk-body").clientHeight };
    });
    await shot(page, `${PFX}-${tag}-ask.png`);
    await page.evaluate(() => { document.querySelector("#ask").hidden = true; });
    // a wide but short window keeps a story row over the panel, with Watch for open too (78 px before ask.css kept 380 px)
    expect(under.list >= 100, `${tag}: with Ask open the story list is ${under.list} px tall`);
    expect(under.n > 0 && !under.out.length, `${tag}: with Ask open, ${under.out.length} of ${under.n} desk controls are covered ${JSON.stringify(under.out.slice(0, 5))}`);
  }
  await ctx.close();
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(shots, name) });
}

try {
  for (const [w, h] of SIZES) { await run(w, h); console.log(`${w}x${h} done`); }
} finally {
  await browser.close();
}
if (failures.length) { console.log(`${failures.length} failure(s)`); process.exit(1); }
console.log("layout-desk: all checks pass");
