// The season on the broadcast page (web/js/season.js), in the browser: the season card on air at kick-off
// beside the line-ups (never more than 2 graphics), with the matchweek, both clubs and their numbers as the
// season facts give them; in Italian its words; the first goal's card with the scorer's season line.
// Screenshot: out/shots/season.png (1920x1080, at kick-off).
//
//   MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh season.mjs      (VIEW=3d for the 3D picture)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const MATCH = process.env.MATCH ?? "M001", VIEW = process.env.VIEW ?? "2d";
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
const season = await (await fetch(new URL(`data/${MATCH}/season.json`, base))).json();
const meta = await (await fetch(new URL(`data/${MATCH}/meta.json`, base))).json();

async function open(lang) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);
  page.on("pageerror", (e) => fail(`${lang}: page error ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) fail(`${lang}: console error ${m.text()}`); });
  // the static server has no API (session, Ask): anything else missing is a failure
  page.on("response", (r) => { if (r.status() >= 400 && !new URL(r.url()).pathname.startsWith("/api/")) fail(`${lang}: ${r.status()} ${r.url()}`); });
  await page.goto(new URL(`index.html?match=${MATCH}&view=${VIEW}&lang=${lang}`, base).href);
  await page.waitForFunction(() => window.studioDesk?.view3d && window.studioDesk.desk.loaded, null, { timeout: 120000 });
  if (VIEW !== "2d") await page.waitForFunction(() => { const v = window.studioDesk.view3d; return v.scene || v.failed; }, null, { timeout: 300000 });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

// on air now: each graphic's name and the text of its shadow DOM parts
const onAir = (page) => page.evaluate(async () => {
  const sd = window.studioDesk, raf = () => new Promise((r) => requestAnimationFrame(r));
  await raf(); await raf();
  await Promise.all([...sd.host.live.values()].map((i) => i.chain));
  const txt = (el, s) => el.shadowRoot?.querySelector(s)?.textContent ?? null;
  return { dom: document.querySelectorAll("#overlay > *").length, live: [...sd.host.live.values()].map((i) => ({
    graphic: i.cue.graphic, kicker: txt(i.el, ".kicker"), title: txt(i.el, ".title"), table: txt(i.el, ".table"), more: txt(i.el, ".more"), season: txt(i.el, ".season"),
    box: (() => { const r = i.el.shadowRoot?.querySelector(".box")?.getBoundingClientRect(); return r && { x: r.x, y: r.y, w: r.width, h: r.height }; })() })) };
});
const seek = (page, ts) => page.evaluate((x) => { window.studioDesk.setPlaying(false); window.studioDesk.seek(x); }, ts);

const pre = (kind, team) => season.find((f) => f.ts === 0 && f.kind === kind && f.team_id === team);
const [home, away] = ["home", "away"].map((s) => meta.teams.find((t) => t.side === s));

// English, 3 s after kick-off: paused, the graphics run on the match clock, so their in-animations are over
let page = await open("en");
await seek(page, 3);
await page.waitForTimeout(500);
let air = await onAir(page);
const card = air.live.find((g) => g.graphic === "season_card");
if (!card) fail(`no season card at kick-off: ${air.live.map((g) => g.graphic)}`);
else {
  if (card.kicker !== "SEASON SO FAR" || card.title !== "Matchweek 10") fail(`card words: ${card.kicker} / ${card.title}`);
  for (const tm of [home, away]) {
    const pts = String(pre("season_points", tm.team_id).value), gd = pre("season_goal_difference", tm.team_id).value;
    if (!card.table.includes(tm.short_name)) fail(`card: no ${tm.short_name}`);
    if (!card.table.includes(pts) || !card.table.includes(gd > 0 ? `+${gd}` : String(gd))) fail(`card: ${tm.short_name} points or goal difference missing (${card.table})`);
  }
  const met = season.find((f) => f.kind === "season_h2h");
  if (met && !card.more.includes(`Matchweek ${met.detail.matchweek}:`)) fail(`card: no last meeting (${card.more})`);
  if (card.box.x + card.box.w > 1920 || card.box.y < 0) fail(`card off the frame ${JSON.stringify(card.box)}`);
  console.log(`card: ${card.title} | ${card.table} | ${card.more}`);
}
if (!air.live.some((g) => g.graphic === "lineup")) fail("the line-ups are not on air beside the card");
if (air.dom > 2 || air.live.length > 2) fail(`more than 2 graphics: ${air.dom}`);
await page.screenshot({ path: path.join(shots, "season.png") });

// the first goal's key moment card carries the scorer's season line
const goal = await page.evaluate(() => window.studioDesk.host.cues.find((c) => c.graphic === "why_card" && c.payload.season?.length));
if (!goal) fail("no goal card with season lines on this sheet");
else {
  await seek(page, goal.ts + 3);
  await page.waitForTimeout(500);
  air = await onAir(page);
  const why = air.live.find((g) => g.graphic === "why_card" && g.season);
  const tally = season.find((f) => f.kind === "season_goals" && f.ts > 0);
  if (!why || !why.season.includes("league goal of the season")) fail(`goal card season line: ${JSON.stringify(air.live)}`);
  else if (!why.season.includes(String(tally.value))) fail(`goal card tally ${why.season} is not ${tally.value}`);
  else console.log(`goal card at ${goal.ts}: ${why.title} | ${why.season}`);
  await page.screenshot({ path: path.join(shots, "season-goal.png") });
  // and gone after the card: the season card never comes back mid-match
  if (air.live.some((g) => g.graphic === "season_card")) fail("the season card is on air at a goal");
}
await page.context().close();

// Italian: the card's own words
page = await open("it");
await seek(page, 3);
await page.waitForTimeout(500);
air = await onAir(page);
const it = air.live.find((g) => g.graphic === "season_card");
if (!it || it.kicker !== "LA STAGIONE FIN QUI" || it.title !== "10ª giornata" || !it.more.includes("Ultimo confronto")) fail(`Italian card: ${JSON.stringify(it)}`);
await page.context().close();
await browser.close();
console.log(failures.length ? `${failures.length} failure(s)` : "season: all checks passed");
process.exit(failures.length ? 1 : 0);
