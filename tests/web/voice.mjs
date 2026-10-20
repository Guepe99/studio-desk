// Browser test of the voice-over on the DEMO fixture, static hosting (desk decisions in the tab).
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh voice.mjs   (Playwright image: it decodes MP3)
//
// Writes data/DEMO/voice.json and clips (copied from replays/M001/voice, any speech in the row's
// language will do) with the text_sha1 of the DEMO stories, in English, Italian and Spanish, then checks at 1440x900: the button is off until pressed;
// at 1x a clip starts when an auto-approved story's cue goes on air; seeking stops it; a held
// story stays silent until approved on the desk, then speaks; the AI switch stops a clip; an
// edited story and 4x stay silent; a stale text_sha1 is never played; one Audio element plays every
// clip; a language switch stops the clip; the page plays the clip of the language the viewer picked
// (the .it.mp3 file in Italian, never the English one) and stays silent in a language with no clip;
// a manifest row whose text is another language's is not loaded; a casual-fan card in other words stays silent; a flagged
// story never speaks; a refused play() turns the
// button off; the speaker icon is painted, off and on (convex paths, pixels in the icon colour).
// The fake clips are removed at the end. Screenshots of the controls bar at 1440 and 390 px:
// out/shots/voice-*.png.
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = process.argv[2] ?? "http://127.0.0.1:8000/";
const url = new URL("?match=DEMO", base).href;
const shots = process.env.SHOTS ?? path.join(ROOT, "out/shots");
mkdirSync(shots, { recursive: true });

// ---- fixture: clips for the DEMO stories, one with a stale hash --------------------------------
const demo = path.join(ROOT, "web/data/DEMO");
const stories = JSON.parse(readFileSync(path.join(demo, "stories.json"), "utf8"));
const cues = JSON.parse(readFileSync(path.join(demo, "cues.json"), "utf8"));
const src = path.join(ROOT, "replays/M001/voice");
mkdirSync(path.join(demo, "voice"), { recursive: true });
const story = (kind) => stories.find((s) => s.kind === kind);
const AUTO = story("goal"), HELD = story("key_pass"), STALE = story("comeback"), EDITED = story("momentum_swing");
// English: STALE's clip says an older text. Italian: HELD's row carries the English text (a clip in
// the wrong language), so it is not loaded. Spanish: AUTO has no clip.
const manifest = ["en", "it", "es"].flatMap((lang) => {
  const mp3 = readdirSync(src).filter((f) => f.endsWith(`.${lang}.mp3`)).sort();
  if (!mp3.length) throw new Error(`no ${lang} clips in replays/M001/voice`);
  return stories.filter((s) => !(lang === "es" && s === AUTO)).map((s, i) => {
    copyFileSync(path.join(src, mp3[i % mp3.length]), path.join(demo, "voice", `${s.story_id}.${lang}.mp3`));
    const text = lang === "en" && s === STALE ? "an older text" : lang === "it" && s === HELD ? s.texts.en : s.texts[lang];
    return { story_id: s.story_id, lang, file: `voice/${s.story_id}.${lang}.mp3`, duration_s: 5,
      text_sha1: createHash("sha1").update(text, "utf8").digest("hex"), voice: "test" };
  });
});
writeFileSync(path.join(demo, "voice.json"), JSON.stringify(manifest));
// the fake clips go at the end, also on a crash, so later DEMO runs are silent again
const cleanup = () => {
  rmSync(path.join(demo, "voice.json"), { force: true });
  rmSync(path.join(demo, "voice"), { recursive: true, force: true });
};
process.on("exit", cleanup);
// a story speaks on its card: the why_card that shows the text its clip says
const card = (s, audience = "analyst") => cues.find((c) => c.story_id === s.story_id && c.graphic === "why_card" && c.audience === audience && c.lang === "en");
const firstCue = (s) => card(s).ts;

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const expect = (ok, msg) => { if (!ok) fail(msg); else console.log(`ok   ${msg}`); };

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
// static hosting: the desk's API calls 404 by design
page.on("console", (m) => { if (m.type() === "error" && !m.location().url.includes("/api/")) fail(`console: ${m.text()}`); });
await page.goto(url);
await page.waitForFunction(() => window.studioDesk?.voice, null, { timeout: 15000 });
await page.evaluate(() => document.fonts.ready);

const voice = () => page.evaluate(() => {
  const v = window.studioDesk.voice;
  const a = v.current ? v.audio : null;
  return { sid: v.current?.sid ?? null, file: a ? a.src.split("/").pop() : null, playing: Boolean(a && !a.paused), t: a?.currentTime ?? 0, ts: window.studioDesk.state.ts };
});
// two drawn frames: on a loaded machine 300 ms can pass without one (as in smoke.mjs)
const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
// play at speed from half a second before ts until match time passes ts + after (frames are slow here)
const playFrom = async (ts, after, speed = 1) => {
  await page.evaluate(([x, sp]) => {
    const d = window.studioDesk;
    d.setPlaying(false);
    document.querySelector(`[data-speed="${sp}"]`).click();
    d.seek(x);
    d.setPlaying(true);
  }, [ts - 0.5, speed]);
  await page.waitForFunction((x) => window.studioDesk.state.ts >= x, ts + after, { timeout: 20000 });
  await page.waitForTimeout(300);
};

expect(await page.isVisible("#voice") && (await page.getAttribute("#voice", "aria-pressed")) === "false", "voice button shown, off by default");
// The speaker icon must really be drawn. Chromium 131 on ANGLE over software Vulkan (the
// sd-chromium-webgl image) paints nothing for a concave or multi-part path while its box looks
// fine, and this image's Chromium paints them: so every displayed path must be one convex shape
// (sampled along its outline), have a box inside the button, and the button must have pixels in the
// icon colour in a screenshot.
const icon = () => page.$eval("#voice", (b) => {
  const r = b.getBoundingClientRect();
  const convex = (p) => {
    if ((p.getAttribute("d").match(/[Mm]/g) ?? []).length !== 1) return false;
    const n = 48, len = p.getTotalLength(), pts = [...Array(n).keys()].map((i) => p.getPointAtLength((len * i) / n));
    let sign = 0;
    for (let i = 0; i < n; i++) {
      const [a, o, c] = [pts[i], pts[(i + 1) % n], pts[(i + 2) % n]];
      const x = (o.x - a.x) * (c.y - o.y) - (o.y - a.y) * (c.x - o.x);
      if (Math.abs(x) < 1e-3) continue;
      if (sign && Math.sign(x) !== sign) return false;
      sign = Math.sign(x);
    }
    return true;
  };
  return [...b.querySelectorAll("svg path")].filter((p) => getComputedStyle(p).display !== "none").map((p) => {
    const q = p.getBoundingClientRect();
    return { cls: p.getAttribute("class") ?? "speaker", w: q.width, h: q.height, convex: convex(p),
      inside: q.left >= r.left && q.right <= r.right && q.top >= r.top && q.bottom <= r.bottom };
  });
});
const bright = async () => {
  const png = (await page.locator("#voice").screenshot()).toString("base64");
  // pixels nearer the icon colour (the button's `color`, which the paths fill with) than its
  // background: the screenshot's colours are shifted a little, so no exact match
  return page.evaluate(async (s) => {
    const st = getComputedStyle(document.querySelector("#voice"));
    const [fg, bg] = [st.color, st.backgroundColor].map((v) => v.match(/\d+/g).slice(0, 3).map(Number));
    const dist = (d, i, x) => Math.abs(d[i] - x[0]) + Math.abs(d[i + 1] - x[1]) + Math.abs(d[i + 2] - x[2]);
    const img = new Image();
    img.src = `data:image/png;base64,${s}`;
    await img.decode();
    const c = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (dist(d, i, fg) < dist(d, i, bg)) n++;
    return n;
  }, png);
};
const iconOk = (paths) => paths.length === 4 && paths.every((p) => p.w > 1 && p.h > 1 && p.inside && p.convex);
let paths = await icon();
let lit = await bright();
expect(iconOk(paths) && lit > 30, `voice icon drawn when off (${lit} icon pixels, ${JSON.stringify(paths)})`);
expect(await page.evaluate(() => [...window.studioDesk.voice.clips.keys()].sort().join()) ===
  manifest.filter((r) => !(r.story_id === STALE.story_id && r.lang === "en") && !(r.story_id === HELD.story_id && r.lang === "it"))
    .map((r) => `${r.story_id}|${r.lang}`).sort().join(), "clips with a stale or another language's text_sha1 are not loaded");
await playFrom(firstCue(AUTO), 1);
expect((await voice()).sid === null, "muted: no clip at the auto-approved cue");

await page.focus("#voice");
await page.keyboard.press("Enter"); // keyboard press is a user gesture too
expect((await page.getAttribute("#voice", "aria-pressed")) === "true", "Enter turns the voice on");
expect(await page.evaluate(() => localStorage.getItem("studiodesk.voice")) === "on", "state remembered in localStorage");
await page.mouse.move(0, 0); // no hover colour in the screenshot
paths = await icon();
lit = await bright();
expect(iconOk(paths) && paths.some((p) => p.cls === "i-on") && lit > 30, `voice icon drawn when on (${lit} icon pixels, ${JSON.stringify(paths)})`);

await playFrom(firstCue(AUTO), 1);
let v = await voice();
expect(v.sid === AUTO.story_id && v.file === `${AUTO.story_id}.en.mp3` && v.playing && v.t > 0.2, `1x: English clip of ${AUTO.story_id} plays when its cue goes on air (${JSON.stringify(v)})`);
await page.screenshot({ path: path.join(shots, "voice-1440.png"), clip: await page.$eval("#controls", (el) => { const r = el.getBoundingClientRect(); return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 }; }) });

await page.evaluate(() => window.studioDesk.seek(window.studioDesk.state.ts + 30));
v = await voice();
expect(v.sid === null && !v.playing, "seeking stops the clip");

await playFrom(firstCue(HELD), 1);
expect((await voice()).sid === null, `held story ${HELD.story_id} stays silent`);
await page.click(`#story-${HELD.story_id} .act-approved`);
await playFrom(firstCue(HELD), 1);
v = await voice();
expect(v.sid === HELD.story_id && v.playing, `approved, ${HELD.story_id} speaks (${JSON.stringify(v)})`);
await page.click("#ai-switch");
await page.waitForTimeout(300); // the next frames see the desk change
await frames();
v = await voice();
expect(v.sid === null && !v.playing, "AI switch off stops the clip");
await page.click("#ai-switch");

await playFrom(firstCue(AUTO), 1, 4);
expect((await voice()).sid === null, "4x: silent");

await page.evaluate((id) => { const d = window.studioDesk.desk; return d.decide(d.byId.get(id), "approved"); }, EDITED.story_id);
await page.evaluate((id) => { const d = window.studioDesk.desk; return d.decide(d.byId.get(id), "edited", { en: "Hand-written line." }); }, EDITED.story_id);
await playFrom(firstCue(EDITED), 1);
expect((await voice()).sid === null, "edited story stays silent");
await page.click(`#story-${STALE.story_id} .act-approved`);
await playFrom(firstCue(STALE), 1);
expect((await voice()).sid === null, "stale clip never plays");

// one element for every clip (WebKit unlocks media per element, in the click)
await page.evaluate(() => { window.firstAudio = window.studioDesk.voice.audio; });
await playFrom(firstCue(AUTO), 1);
v = await voice();
expect(v.sid === AUTO.story_id && v.playing && await page.evaluate(() => window.studioDesk.voice.audio === window.firstAudio),
  "the same Audio element plays the next clip");

// the casual fan's card says the story in other words: the clip would not match it, so silence
const casual = card(AUTO, "casual");
if (casual?.payload.body === AUTO.texts.en) throw new Error("DEMO casual card now says the story text: update voice.mjs");
await page.click('[data-audience="casual"]');
await playFrom(casual.ts, 1);
expect((await voice()).sid === null, "casual audience: a card in other words stays silent");
await page.click('[data-audience="analyst"]');

// a language switch stops the clip; in Italian the Italian clip plays, in Spanish (no clip) silence
await page.selectOption("#lang", "it");
await page.waitForTimeout(300);
await frames();
v = await voice();
expect(v.sid === null && !v.playing, "switching to Italian stops the English clip");
await playFrom(firstCue(AUTO), 1);
v = await voice();
expect(v.sid === AUTO.story_id && v.file === `${AUTO.story_id}.it.mp3` && v.playing, `Italian: the Italian clip plays (${JSON.stringify(v)})`);
await page.selectOption("#lang", "es");
await page.waitForTimeout(300);
await frames();
v = await voice();
expect(v.sid === null && !v.playing, "switching to Spanish stops the Italian clip");
await playFrom(firstCue(AUTO), 1);
expect((await voice()).sid === null, "Spanish: no clip for this story, silent (never another language's)");
await page.selectOption("#lang", "en");

// a story flagged by Content Safety is held on the desk and never speaks, even once approved
await page.evaluate((id) => { const d = window.studioDesk.desk; d.byId.get(id).safety = "flagged"; d.changed(); }, AUTO.story_id);
expect(await page.evaluate((id) => { const d = window.studioDesk.desk; return d.status(d.byId.get(id)); }, AUTO.story_id) === "needs_review",
  "flagged story held for review");
await page.click(`#story-${AUTO.story_id} .act-approved`);
await playFrom(firstCue(AUTO), 1);
expect((await voice()).sid === null, "flagged story stays silent after approval");
await page.evaluate(() => window.studioDesk.setPlaying(false));

// a browser that refuses to play (WebKit without a gesture) turns the button back off
const strict = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const p3 = await strict.newPage();
await p3.addInitScript(() => {
  HTMLMediaElement.prototype.play = function () { return Promise.reject(new DOMException("no gesture", "NotAllowedError")); };
});
await p3.goto(url);
await p3.waitForFunction(() => window.studioDesk?.voice, null, { timeout: 15000 });
await p3.click("#voice");
await p3.waitForFunction(() => document.querySelector("#voice").getAttribute("aria-pressed") === "false", null, { timeout: 3000 }).catch(() => {});
expect((await p3.getAttribute("#voice", "aria-pressed")) === "false", "NotAllowedError sets the button back to off");
await strict.close();

const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
const p2 = await phone.newPage();
await p2.goto(url);
await p2.waitForFunction(() => window.studioDesk?.voice, null, { timeout: 15000 });
await p2.evaluate(() => document.fonts.ready);
const bar = () => p2.$eval("#controls", (el) => { const r = el.getBoundingClientRect(); return { x: 0, y: Math.max(0, r.y - 8), width: 390, height: r.height + 16 }; });
// a fresh context: no stored choice, so the button starts off
expect((await p2.getAttribute("#voice", "aria-pressed")) === "false", "390 px: fresh visitor starts with the voice off");
await p2.screenshot({ path: path.join(shots, "voice-390-off.png"), clip: await bar() });
await p2.tap("#voice");
await p2.screenshot({ path: path.join(shots, "voice-390.png"), clip: await bar() });
const box = await p2.$eval("#voice", (el) => el.getBoundingClientRect().toJSON());
expect(box.right <= 390 && box.width >= 30, `390 px: button inside the screen (${Math.round(box.width)} px wide)`);

await browser.close();
cleanup();
if (failures.length) { console.log(`${failures.length} failure(s)`); process.exit(1); }
console.log("voice: all checks passed");
