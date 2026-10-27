// Show proof on the broadcast page (web/js/proof.js), in the browser: one button per graphic on air at a
// moment with two story graphics on air, the panel it opens (the story's facts and nothing else, the
// numbers on screen each with a source, the checks), the focus going in and back, Escape, Space, the
// cited players lit on the 2D pitch (pitch.drawn) and tagged on the 3D view (.cited-tag), and both gone on close;
// the panel never over the picture and no sideways scroll at 1280x720, 390x844 and 320x568, in Italian
// on the phone with reduced motion. Screenshots: out/shots/proof-3d.png (1280x720, 3D, tags on) and
// out/shots/proof-390.png.
//
//   WEBGL=2 MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh proof.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const MATCH = process.env.MATCH ?? "M001";
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();

async function open(view, { width = 1280, height = 720, lang = "en", reduced = false } = {}) {
  // a phone as layout.mjs opens one: two device pixels a pixel and a touch screen (44 px buttons)
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? "reduce" : "no-preference", ...(width < 700 ? { deviceScaleFactor: 2, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);
  page.on("pageerror", (e) => fail(`${view} ${width}: page error ${e.message}`));
  await page.goto(new URL(`index.html?match=${MATCH}&view=${view}&lang=${lang}`, base).href);
  await page.waitForFunction(() => window.studioDesk?.view3d && window.studioDesk.desk.loaded, null, { timeout: 120000 });
  if (view !== "2d") await page.waitForFunction(() => { const v = window.studioDesk.view3d; return v.scene || v.failed; }, null, { timeout: 300000 });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

// the latest moment with the most story graphics on air together, out of the goal replays and the crowd and
// stadium cutaways (the 3D tags, as the carrier's, are for open play; a cutaway follows each goal replay):
// M001, the goal at 81' and the comeback it makes, after the replay and the cutaway
const busiest = (page) => page.evaluate(async () => {
  const sd = window.studioDesk, sheet = sd.desk.sheet(sd.match.cues, sd.state.audience, sd.state.lang).filter((c) => c.story_id);
  const { cutawayPlan } = await import(new URL("js/scene3d/cutaway.js", location.href).href);
  const away = [...(sd.view3d.reps ?? []), ...cutawayPlan(sd.match)];
  let best = null;
  for (const t of [...sheet.map((c) => c.ts + 2), ...away.map((r) => r.to + 1)]) {
    if (away.some((r) => r.from <= t && t < r.to)) continue;
    const n = sheet.filter((x) => x.ts <= t && t < x.ts + x.duration_s).length;
    if (!best || n >= best.n) best = { t, n };
  }
  return best.t;
});

const seekTo = (page, ts) => page.evaluate(async (x) => {
  const sd = window.studioDesk, raf = () => new Promise((r) => requestAnimationFrame(r));
  sd.setPlaying(false);
  sd.seek(x);
  await raf(); await raf();
  await Promise.all([document.fonts.ready, ...[...sd.host.live.values()].map((i) => i.chain)]);
  for (const t0 = performance.now(); performance.now() - t0 < 60000 && sd.view3d.shown !== "2d" && !sd.view3d.ready;) await raf();
  await raf(); await raf();
}, ts);

const raf2 = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// what the page shows: the buttons, the panel, the highlights in both views, the layout
const state = (page) => page.evaluate(() => {
  const sd = window.studioDesk, pr = sd.proof, panel = document.querySelector("#proof"), frame = document.querySelector("#frame").getBoundingClientRect();
  const p = panel.getBoundingClientRect(), live = [...sd.host.live.values()].map((i) => i.cue.cue_id).sort();
  const chips = [...document.querySelectorAll("#proof-bar .proof-chip")];
  const tags = [...document.querySelectorAll(".cited-tag")].filter((t) => !t.hidden).map((t) => t.textContent);
  return {
    live, chips: chips.map((b) => b.dataset.cue).sort(), names: chips.map((b) => b.getAttribute("aria-label")),
    chipWidths: chips.map((b) => Math.round(b.getBoundingClientRect().width)), clipped: chips.filter((b) => b.scrollWidth > b.clientWidth + 1).length, expanded: chips.map((b) => b.getAttribute("aria-expanded")),
    open: !panel.hidden, focus: document.activeElement?.id || document.activeElement?.dataset?.cue || document.activeElement?.tagName,
    title: panel.querySelector("h2")?.textContent ?? "", lang: panel.lang,
    factRows: [...panel.querySelectorAll(".proof-facts tbody tr")].length, storyFacts: pr.proof?.facts.length ?? 0,
    numbers: [...panel.querySelectorAll(".proof-nums li")].map((li) => li.textContent), bad: panel.querySelectorAll(".proof-nums li.bad").length,
    checks: [...panel.querySelectorAll(".proof-checks dd")].map((d) => d.textContent),
    cited: [...(pr.proof?.players ?? [])].sort(), ringed: sd.pitch.drawn.players.filter((x) => x.cited).map((x) => x.id).sort(),
    pitchShown: sd.view3d.shown !== "3d", tags, shot: sd.view3d.scene?.cams.mode ?? "", ts: sd.state.ts, carrier: !document.querySelector("#carrier").hidden,
    overPicture: !panel.hidden && p.left < frame.right && frame.left < p.right && p.top < frame.bottom && frame.top < p.bottom,
    blank: /\b(null|undefined|NaN)\b/.test(panel.textContent), hscroll: document.documentElement.scrollWidth > window.innerWidth, animations: panel.getAnimations({ subtree: true }).length,
  };
});

async function check(page, tag, { threeD = false } = {}) {
  await seekTo(page, await busiest(page));
  let s = await state(page);
  console.log(`${tag}: ${s.live.length} graphics on air, ${s.chips.length} proof buttons (${s.names.join("; ")}), widths ${s.chipWidths}`);
  if (s.chips.join() !== s.live.join() || !s.chips.length) fail(`${tag}: buttons ${s.chips} for the cues on air ${s.live}`);
  if (s.chipWidths.some((w) => w < 24)) fail(`${tag}: a proof button is under 24 px wide`);
  if (s.clipped) fail(`${tag}: ${s.clipped} proof buttons cut their own label`);
  if (s.hscroll) fail(`${tag}: sideways scroll`);
  // open the last one with the keyboard: Enter
  await page.focus(`#proof-bar .proof-chip:last-child`);
  await page.keyboard.press("Enter");
  await raf2(page);
  s = await state(page);
  console.log(`${tag}: open "${s.title}", ${s.factRows} fact rows for ${s.storyFacts} facts; numbers: ${s.numbers.join(" | ")}; checks: ${s.checks.join(" | ")}`);
  console.log(`${tag}: cited ${s.cited}, ringed in 2D ${s.ringed}, 3D tags ${s.tags.join(", ")}`);
  if (!s.open || s.focus !== "proof-title" || !s.expanded.includes("true")) fail(`${tag}: the panel did not open with the focus on its title: ${JSON.stringify(s)}`);
  if (s.factRows !== s.storyFacts || !s.factRows) fail(`${tag}: ${s.factRows} fact rows for ${s.storyFacts} facts`);
  if (s.bad) fail(`${tag}: ${s.bad} numbers on screen without a source`);
  if (s.blank) fail(`${tag}: the panel prints null, undefined or NaN`);
  if (s.overPicture) fail(`${tag}: the panel covers the picture`);
  if (s.hscroll) fail(`${tag}: sideways scroll with the panel open`);
  if (!s.cited.length) fail(`${tag}: no cited player`);
  if (s.pitchShown && s.ringed.join() !== s.cited.filter((id) => s.ringed.includes(id)).join()) fail(`${tag}: 2D rings ${s.ringed} for ${s.cited}`);
  if (s.pitchShown && !s.ringed.length) fail(`${tag}: no 2D ring`);
  if (threeD && (!s.tags.length || s.tags.length > s.cited.length)) fail(`${tag}: ${s.tags.length} 3D tags for ${s.cited.length} cited players (camera ${s.shot}, at ${s.ts})`);
  if (!threeD && s.tags.length) fail(`${tag}: 3D tags on the 2D page`);
  return s;
}

async function close(page, tag) {
  await page.keyboard.press("Escape");
  await raf2(page);
  const s = await state(page);
  if (s.open || !s.chips.includes(s.focus) || s.ringed.length || s.tags.length) fail(`${tag}: after Escape open ${s.open}, focus ${s.focus}, rings ${s.ringed}, tags ${s.tags}`);
  else console.log(`${tag}: Escape closed it, the focus is back on its button, no ring and no tag`);
  // Space on a proof button opens it (not play), and Space on the same button, back on it, closes it
  await page.keyboard.press("Space");
  await raf2(page);
  const t = await state(page), playing = await page.evaluate(() => window.studioDesk.state.playing);
  if (!t.open || playing) fail(`${tag}: Space on a proof button: open ${t.open}, playing ${playing}`);
  await page.focus(`#proof-bar .proof-chip[aria-expanded="true"]`);
  await page.keyboard.press("Space");
  await raf2(page);
  if ((await state(page)).open) fail(`${tag}: a second Space did not close it`);
}

try {
  const p2 = await open("2d");
  await check(p2, "2D 1280x720");
  await close(p2, "2D 1280x720");
  await p2.context().close();

  // the tags go on the large 3D picture only (in split the pitch is the large one, and it gets the rings)
  const p3 = await open("3d");
  if (await p3.evaluate(() => window.studioDesk.view3d.shown !== "3d")) fail("the 3D view did not start");
  await check(p3, "3D 1280x720", { threeD: true });
  await p3.screenshot({ path: path.join(shots, "proof-3d.png") });
  await close(p3, "3D 1280x720");
  await p3.context().close();

  for (const [w, h] of [[390, 844], [320, 568]]) {
    const pp = await open("2d", { width: w, height: h, lang: "it", reduced: true });
    const s = await check(pp, `2D ${w}x${h} it`);
    if (s.lang !== "it" || !s.title.startsWith("Le prove")) fail(`${w}: the panel is not in Italian: ${s.title}`);
    if (s.animations) fail(`${w}: ${s.animations} animations with reduced motion`);
    if (w === 390) await pp.screenshot({ path: path.join(shots, "proof-390.png"), fullPage: true });
    await close(pp, `2D ${w}x${h}`);
    await pp.context().close();
  }
} finally {
  await browser.close();
}
if (failures.length) { console.log(`${failures.length} failure(s)`); process.exit(1); }
console.log("proof ok");
