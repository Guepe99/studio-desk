// "Same moment, several audiences" box (web/js/audiences.js), on DEMO by default (MATCH=M001 for an export):
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh audiences.mjs
//
// At 1280x720, 390x844 and 320x568, with a goal story on air: the box sits outside the stage, shows one
// card per audience on the menu with that audience's why-card line, scrolls no page sideways, says the
// page language, and a card's button switches the audience from the keyboard with the focus kept on it.
// Screenshots of the box go to out/shots/audiences-<w>x<h>.png.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const MATCH = process.env.MATCH ?? "DEMO";
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
for (const [w, h] of [[1280, 720], [390, 844], [320, 568]]) {
  const tag = `${w}x${h}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => fail(`${tag} page error: ${e.message}`));
  await page.goto(new URL(`?match=${MATCH}`, base).href);
  await page.waitForFunction(() => window.studioDesk?.desk?.loaded, null, { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  // the first goal with a scorer, while its analyst why card is on air
  const at = await page.evaluate(() => {
    const sd = window.studioDesk, s = sd.desk.stories.find((x) => x.kind === "goal" && x.player_id && sd.desk.onAir(x));
    const c = s && sd.match.cues.find((x) => x.story_id === s.story_id && x.graphic === "why_card" && x.audience === "analyst" && x.lang === "en");
    return c && { ts: c.ts + 1, story: s.story_id };
  });
  if (!at) { fail(`${tag}: no goal story on air to show`); await ctx.close(); continue; }
  await page.evaluate((ts) => { window.studioDesk.setPlaying(false); window.studioDesk.seek(ts); }, at.ts);
  await page.waitForFunction((sid) => window.studioDesk.desk.what && document.querySelectorAll("#audiences .aud-card").length > 0, at.story, { timeout: 10000 }).catch(() => {});
  const got = await page.evaluate((sid) => {
    const box = document.querySelector("#audiences"), r = box.getBoundingClientRect(), st = document.querySelector("#stage");
    const sd = window.studioDesk, cards = [...box.querySelectorAll(".aud-card")];
    const why = (aud) => sd.match.cues.find((c) => c.story_id === sid && c.graphic === "why_card" && c.audience === aud && c.lang === "en");
    return { hidden: box.hidden, inStage: st.contains(box), w: r.width, title: box.querySelector(".aud-title").textContent,
      wide: document.documentElement.scrollWidth - innerWidth,
      cards: cards.map((li) => { const b = li.querySelector("button"), cr = li.getBoundingClientRect();
        return { aud: b.dataset.aud, name: b.textContent, text: li.querySelector(".aud-text").textContent.replace(/\u2060/g, ""), right: cr.right,
          want: why(b.dataset.aud)?.payload.body ?? null, pressed: b.getAttribute("aria-pressed"), desc: b.getAttribute("aria-describedby") }; }) };
  }, at.story);
  if (got.hidden || got.inStage) fail(`${tag}: box hidden (${got.hidden}) or on the stage (${got.inStage})`);
  if (got.wide > 0) fail(`${tag}: the page scrolls sideways by ${got.wide}px`);
  if (got.title !== "Same moment, several audiences") fail(`${tag}: title "${got.title}"`);
  for (const k of ["analyst", "casual", "kids"]) if (!got.cards.some((c) => c.aud === k)) fail(`${tag}: no ${k} card`);
  if (got.cards.filter((c) => c.aud.startsWith("team:")).length !== 2) fail(`${tag}: not both team cards`);
  for (const c of got.cards) {
    if (!c.text || !c.name) fail(`${tag}: empty card ${c.aud}`);
    if (c.want !== null && c.text !== c.want) fail(`${tag}: ${c.aud} card "${c.text}" is not its why card "${c.want}"`);
    if (c.right > w + 0.5) fail(`${tag}: ${c.aud} card past the right edge`);
    if (c.pressed !== String(c.aud === "analyst") || c.desc !== "aud-hint") fail(`${tag}: ${c.aud} aria-pressed ${c.pressed}, describedby ${c.desc}`);
  }
  if (new Set(got.cards.map((c) => c.text)).size < 3) fail(`${tag}: fewer than 3 different lines`);
  await page.locator("#audiences").screenshot({ path: path.join(shots, `audiences-${tag}.png`) });

  // the keyboard: Tab-reach the casual button, Enter switches the broadcast, the focus stays on it
  await page.focus('#audiences button[data-aud="casual"]');
  await page.keyboard.press("Enter");
  // a frame can take seconds with software WebGL: wait for the box, not for a fixed time
  await page.waitForFunction(() => document.querySelector("#audiences .aud-card.on button")?.dataset.aud === "casual", null, { timeout: 10000 }).catch(() => {});
  const after = await page.evaluate(() => ({ aud: window.studioDesk.state.audience, focus: document.activeElement?.dataset?.aud,
    pressed: document.querySelector('#audiences button[data-aud="casual"]').getAttribute("aria-pressed"),
    on: document.querySelector("#audiences .aud-card.on button")?.dataset.aud }));
  if (after.aud !== "casual" || after.focus !== "casual" || after.pressed !== "true" || after.on !== "casual")
    fail(`${tag}: Enter on casual gave ${JSON.stringify(after)}`);

  // the page language: Italian title and lines
  await page.evaluate(() => { document.querySelector("#settings").click(); document.querySelector('#settings-menu [data-lang="it"]').click(); });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#audiences").lang === "it", null, { timeout: 10000 }).catch(() => {});
  const it = await page.evaluate(() => ({ lang: document.querySelector("#audiences").lang, title: document.querySelector(".aud-title").textContent,
    texts: [...document.querySelectorAll("#audiences .aud-text")].map((p) => p.lang) }));
  if (it.lang !== "it" || it.title !== "Lo stesso momento, per ogni pubblico" || it.texts.some((l) => l !== "it"))
    fail(`${tag}: Italian box ${JSON.stringify(it)}`);
  console.log(`${tag}: ${got.cards.length} cards (${got.cards.map((c) => c.aud).join(", ")})`);
  await ctx.close();
}
await browser.close().catch(() => {});
console.log(failures.length ? `${failures.length} failure(s)` : "audiences box: all checks passed");
process.exit(failures.length ? 1 : 0);
