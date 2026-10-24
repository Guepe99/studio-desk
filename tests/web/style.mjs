// The measurable rules of the page style (docs: the layout checklist, section A), on the real page at
// 1280x720 and 390x844, on the DEMO fixture by default:
// - every visible text outside the canvases, in the page and inside the graphics' shadow roots,
//   reaches 4.5:1 against what is behind it (3:1 for large text: 24 px, or 18.66 px bold)
// - every button, input, select and other focusable control is at least 24 x 24 CSS px
// - every control reached with the Tab key shows a focus outline of at least 2 px that reaches 3:1
//   against what is around it
// - no horizontal scroll, nothing in the page chrome past the right edge
// - the text is set in Urbanist, the vendored font, and the browser loaded it (document.fonts)
// - the page header is there and its text is among the texts measured
// Then screenshots for a viewer's eye: out/shots/style-*.png (2D, 3D, Radar and the desk at 1280x720,
// the page at 844x390 and 390x844, the drawer open at 390x844).
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh style.mjs
//   STYLE_BREAK=1 ...   paints one text green on white first: the run must fail (a check of the check)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const MATCH = process.env.MATCH ?? "DEMO";
const BREAK = process.env.STYLE_BREAK === "1";
const SHOTS = process.env.STYLE_SHOTS !== "0";
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();

async function open(viewport, view) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);   // software WebGL loads and draws slowly
  const tag = `${viewport.width}x${viewport.height}${view ? ` ${view}` : ""}`;
  page.on("console", (m) => { if (m.type() === "error" && !/\/api\/|(voice|booth)\.json/.test(m.location()?.url ?? "")) fail(`${tag} console: ${m.text()} (${m.location()?.url ?? "?"})`); });
  page.on("pageerror", (e) => fail(`${tag} page error: ${e.message}`));
  await page.goto(new URL(`index.html?match=${MATCH}${view ? `&view=${view}` : ""}`, base).href);
  await page.waitForFunction(() => window.studioDesk?.match && window.studioDesk.view3d, null, { timeout: 120000 });
  if (view) await page.waitForFunction(() => { const v = window.studioDesk.view3d; return v.mode === "2d" || v.scene || v.failed; }, null, { timeout: 300000 });
  await page.evaluate(() => document.fonts.ready);
  for (const b of await noSideScroll(page)) fail(`${tag} at load, side scroll: ${b}`);   // before the first moment: the strip's waiting line
  if (BREAK) await page.addStyleTag({ content: ".desk-sum, #time { color: #00ff87 !important; } .desk-head { background: #ffffff !important; }" });
  return page;
}

// Seek and wait until the graphics on air have finished animating in (and, in 3D, the picture is drawn).
const seekTo = (page, ts) => page.evaluate(async (x) => {
  const sd = window.studioDesk, raf = () => new Promise((r) => requestAnimationFrame(r));
  sd.setPlaying(false);
  sd.seek(x);
  await raf(); await raf();
  await Promise.all([document.fonts.ready, ...[...sd.host.live.values()].map((i) => i.chain)]);
  await new Promise((r) => setTimeout(r, 1200));
  for (const t0 = performance.now(); performance.now() - t0 < 60000 && sd.view3d.shown !== "2d" && !sd.view3d.ready;) await raf();
  await raf(); await raf();
}, ts);

// A moment with a graphic on air and its fact chips (the analyst sees them): the first story cue.
const busyMoment = (page) => page.evaluate(() => {
  const cues = window.studioDesk.match.cues.filter((c) => c.lang === "en" && c.audience === "analyst");
  const c = cues.find((x) => x.graphic === "pass_shot") ?? cues[0];
  return c ? c.ts + Math.min(2.5, c.duration_s / 2) : 60;
});

// A moment with no unpinned graphic on air, so the Radar box is out (it yields to those graphics).
const quietMoment = (page) => page.evaluate(() => {
  const cues = window.studioDesk.match.cues.filter((c) => c.graphic !== "nameplate");
  for (let t = 20; t < 3000; t += 5) if (!cues.some((c) => t >= c.ts - 1 && t <= c.ts + c.duration_s + 1)) return t;
  return 5;
});

// Contrast of every visible text node; the colour behind it is composited from its ancestors'
// backgrounds (across shadow roots), over the frame's picture colour inside the frame, else white.
const textContrast = (page) => page.evaluate(() => {
  const parse = (s) => { const m = s.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1]; };
  const lum = ([r, g, b]) => { const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
  const up = (n) => n.parentElement ?? (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null);
  const frameBg = parse(getComputedStyle(document.querySelector("#frame")).backgroundColor);
  const behind = (el) => {
    const chain = [];
    let opacity = 1, inFrame = false;
    for (let n = el; n; n = up(n)) {
      const cs = getComputedStyle(n);
      opacity *= Number(cs.opacity);
      if (cs.visibility === "hidden" || cs.display === "none") return null;
      if (n.id === "frame") inFrame = true;
      chain.push(parse(cs.backgroundColor));
    }
    let bg = inFrame ? frameBg : [255, 255, 255, 1];
    for (const c of chain.reverse()) if (c[3] > 0) bg = over(c, bg);
    return { bg, opacity };
  };
  const roots = [document, ...[...document.querySelectorAll("*")].filter((n) => n.shadowRoot).map((n) => n.shadowRoot)];
  const out = [], skipped = [];
  let n = 0, head = 0;
  for (const root of roots) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      const el = t.parentElement;
      if (!t.textContent.trim() || !el || el.closest("canvas, script, style, option, .sr")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
      const b = behind(el);
      if (!b) continue;
      if (b.opacity < 0.99) { skipped.push(el.className || el.tagName); continue; }   // mid-animation
      const cs = getComputedStyle(el), fg = parse(cs.color);
      const px = parseFloat(cs.fontSize) * (el.offsetWidth ? r.width / el.offsetWidth : 1);
      const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
      const c = ratio(over(fg, b.bg), b.bg);
      n++;
      if (el.closest("#masthead")) head++;
      if (c < (large ? 3 : 4.5)) out.push(`"${t.textContent.trim().slice(0, 30)}" (${el.tagName.toLowerCase()}.${el.className}) ${c.toFixed(2)}:1 at ${px.toFixed(1)} px`);
    }
  }
  return { bad: out, n, head, skipped: skipped.length };
});

// Size of every visible control.
const targets = (page) => page.evaluate(() => {
  const bad = [];
  let n = 0;
  for (const el of document.querySelectorAll("button, input, select, textarea, summary, [role=switch], [role=tab], a[href]")) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === "hidden" || el.closest("[hidden], [inert]")) continue;
    if (r.right < 0 || r.left > innerWidth || r.bottom < 0 || r.top > innerHeight) continue;
    n++;
    if (r.width < 24 || r.height < 24) bad.push(`${el.tagName.toLowerCase()}#${el.id}.${el.className} "${el.textContent.trim().slice(0, 20)}" ${r.width.toFixed(0)}x${r.height.toFixed(0)}`);
  }
  return { bad, n };
});

// Tab from the top of the page: each control reached shows a visible outline (style, width, 3:1).
async function focusRing(page, label, max = 160) {
  await page.evaluate(() => { document.activeElement?.blur(); window.focus(); });
  await page.mouse.click(2, 2);   // a click on the page edge, so Tab starts from the top
  const seen = new Set(), bad = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const parse = (s) => { const m = s.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1]; };
      const lum = ([r, g, b]) => { const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      // what the ring is drawn on: the nearest ancestor with a solid background, the frame's picture, or white
      let bg = [255, 255, 255, 1];
      for (let n = el.parentElement; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0.5) { bg = c; break; } }
      const cs = getComputedStyle(el), rect = el.getBoundingClientRect();
      const id = `${el.tagName.toLowerCase()}#${el.id}.${String(el.className)}[${el.dataset.focus ?? el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 16)}]`;
      const w = parseFloat(cs.outlineWidth), ok = cs.outlineStyle !== "none" && w >= 2;
      return { id, ok, w, c: ok ? ratio(parse(cs.outlineColor), bg) : 0, visible: rect.width > 0 && rect.height > 0 };
    });
    if (!r) continue;
    if (seen.has(r.id)) break;   // back at the start
    seen.add(r.id);
    if (!r.visible) continue;
    if (!r.ok) bad.push(`${r.id}: no outline`);
    else if (r.c < 3) bad.push(`${r.id}: outline ${r.c.toFixed(2)}:1`);
  }
  if (seen.size < 5) fail(`${label}: Tab reached only ${seen.size} controls`);
  for (const b of bad) fail(`${label} focus ${b}`);
  return seen.size;
}

const noSideScroll = (page) => page.evaluate(() => {
  const d = document.documentElement, b = document.body, bad = [];
  if (d.scrollWidth > d.clientWidth + 0.5 || b.scrollWidth > b.clientWidth + 0.5) bad.push(`scrollWidth ${Math.max(d.scrollWidth, b.scrollWidth)} > ${d.clientWidth}`);
  for (const el of document.querySelectorAll("#controls *, #activity *, #ask *, #desk *, #deck > *")) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 1 || cs.visibility === "hidden" || el.closest("[hidden], .sr")) continue;
    if (el.closest("#desk") && !document.body.classList.contains("desk-open") && innerWidth < 1100) continue;   // the closed drawer
    if (r.right > innerWidth + 0.5 || r.left < -0.5) bad.push(`${el.tagName.toLowerCase()}.${el.className} spans ${r.left.toFixed(0)}..${r.right.toFixed(0)}`);
  }
  return bad.slice(0, 8);
});

const font = (page) => page.evaluate(() => {
  const loaded = [...document.fonts].filter((f) => f.family.replace(/"/g, "") === "Urbanist" && f.status === "loaded").length;
  const fam = (el) => getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim();
  const els = [document.body, document.querySelector(".ctl"), document.querySelector("#desk h2"), document.querySelector(".sb-name")];
  const host = [...document.querySelectorAll("#overlay > *, #deck > *")].find((n) => n.shadowRoot);
  if (host) els.push(host.shadowRoot.querySelector(".stage"));
  return { loaded, check: document.fonts.check("800 20px Urbanist"), families: els.filter(Boolean).map(fam) };
});

// before a screenshot: no focus ring left from the Tab walk, every scrolled box back at its top
const calm = (page) => page.evaluate(() => {
  document.activeElement?.blur();
  for (const el of document.querySelectorAll("*")) if (el.scrollTop) el.scrollTop = 0;
  window.scrollTo(0, 0);
});

async function rules(page, label) {
  const f = await font(page);
  if (!f.loaded || !f.check) fail(`${label}: Urbanist not loaded (${f.loaded} faces loaded)`);
  for (const fam of f.families) if (fam !== "Urbanist") fail(`${label}: text set in ${fam}, not Urbanist`);
  const c = await textContrast(page);
  for (const b of c.bad) fail(`${label} contrast ${b}`);
  if (!c.head) fail(`${label}: no page header text measured`);   // the header names the page and the match
  const t = await targets(page);
  for (const b of t.bad) fail(`${label} target ${b}`);
  for (const b of await noSideScroll(page)) fail(`${label} side scroll: ${b}`);
  console.log(`${label}: ${c.n} texts (${c.skipped} mid-animation skipped), ${t.n} controls, fonts ${f.families.join("/")}`);
}

try {
  // 1280x720, 2D, a graphic on air
  const wide = await open({ width: 1280, height: 720 });
  await seekTo(wide, await busyMoment(wide));
  await rules(wide, "1280x720");
  console.log(`1280x720: Tab reached ${await focusRing(wide, "1280x720")} controls`);
  if (SHOTS) {
    await seekTo(wide, await busyMoment(wide));
    await calm(wide);
    await wide.screenshot({ path: `${shots}/style-1280-2d.png` });
    // the desk with the Details (evidence) of the first story open
    await wide.locator("#desk .more > summary").first().click().catch(() => {});
    await wide.screenshot({ path: `${shots}/style-1280-desk.png` });
    await wide.click("#tab-traces");
    await wide.screenshot({ path: `${shots}/style-1280-traces.png` });
    await wide.click("#tab-audit");
    await wide.screenshot({ path: `${shots}/style-1280-audit.png` });
  }
  await wide.context().close();

  // 390x844: page, then the drawer open
  const tall = await open({ width: 390, height: 844 });
  await seekTo(tall, await busyMoment(tall));
  await rules(tall, "390x844");
  console.log(`390x844: Tab reached ${await focusRing(tall, "390x844")} controls`);
  if (SHOTS) { await calm(tall); await tall.screenshot({ path: `${shots}/style-390x844.png` }); }
  await tall.click("#desk-open");
  await tall.waitForTimeout(400);
  await rules(tall, "390x844 desk");
  console.log(`390x844 desk: Tab reached ${await focusRing(tall, "390x844 desk")} controls`);
  if (SHOTS) { await calm(tall); await tall.screenshot({ path: `${shots}/style-390x844-desk.png` }); }
  await tall.context().close();

  if (SHOTS) {
    const land = await open({ width: 844, height: 390 });
    await seekTo(land, await busyMoment(land));
    await rules(land, "844x390");
    await land.screenshot({ path: `${shots}/style-844x390.png` });
    await land.context().close();
    for (const view of ["3d", "split"]) {
      const p = await open({ width: 1280, height: 720 }, view);
      await seekTo(p, await busyMoment(p));
      await rules(p, `1280x720 ${view}`);
      if (view === "split") {
        await seekTo(p, await quietMoment(p));
        if (!(await p.evaluate(() => { const r = document.querySelector("#radar"); return r && !r.hidden && getComputedStyle(r).opacity === "1"; }))) fail("split: the Radar box is not shown at a quiet moment");
        await rules(p, "1280x720 split, radar out");
      }
      await p.screenshot({ path: `${shots}/style-1280-${view === "split" ? "radar" : view}.png` });
      await p.context().close();
    }
  }
} finally {
  await browser.close();
}

if (failures.length) { console.log(`style FAILED: ${failures.length}`); process.exit(1); }
console.log("style ok");
