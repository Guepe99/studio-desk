// Browser test of the voice-over on the DEMO fixture, static hosting (desk decisions in the tab).
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh voice.mjs   (Playwright image: it decodes MP3)
//
// Writes data/DEMO/voice.json and clips (copied from replays/M001/voice, any speech will do) with
// the text_sha1 of the DEMO stories, then checks at 1440x900: the button is off until pressed;
// at 1x a clip starts when an auto-approved story's cue goes on air; seeking stops it; a held
// story stays silent until approved on the desk, then speaks; the AI switch stops a clip; an
// edited story and 4x stay silent; a stale text_sha1 is never played. Screenshots of the controls
// bar at 1440 and 390 px: out/shots/voice-*.png.
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
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
const mp3 = readdirSync(src).filter((f) => f.endsWith(".en.mp3")).sort();
mkdirSync(path.join(demo, "voice"), { recursive: true });
const story = (kind) => stories.find((s) => s.kind === kind);
const AUTO = story("goal"), HELD = story("key_pass"), STALE = story("comeback"), EDITED = story("momentum_swing");
const manifest = stories.map((s, i) => {
  copyFileSync(path.join(src, mp3[i % mp3.length]), path.join(demo, "voice", `${s.story_id}.en.mp3`));
  const text = s === STALE ? "an older text" : s.texts.en;
  return { story_id: s.story_id, lang: "en", file: `voice/${s.story_id}.en.mp3`, duration_s: 5,
    text_sha1: createHash("sha1").update(text, "utf8").digest("hex"), voice: "test" };
});
writeFileSync(path.join(demo, "voice.json"), JSON.stringify(manifest));
const firstCue = (s) => Math.min(...cues.filter((c) => c.story_id === s.story_id && c.audience === "analyst" && c.lang === "en").map((c) => c.ts));

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
  const a = v.current?.audio;
  return { sid: v.current?.sid ?? null, playing: Boolean(a && !a.paused), t: a?.currentTime ?? 0, ts: window.studioDesk.state.ts };
});
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
expect(await page.evaluate(() => window.studioDesk.voice.clips.size) === stories.length - 1, "clip with a stale text_sha1 is not loaded");
await playFrom(firstCue(AUTO), 1);
expect((await voice()).sid === null, "muted: no clip at the auto-approved cue");

await page.focus("#voice");
await page.keyboard.press("Enter"); // keyboard press is a user gesture too
expect((await page.getAttribute("#voice", "aria-pressed")) === "true", "Enter turns the voice on");
expect(await page.evaluate(() => localStorage.getItem("studiodesk.voice")) === "on", "state remembered in localStorage");

await playFrom(firstCue(AUTO), 1);
let v = await voice();
expect(v.sid === AUTO.story_id && v.playing && v.t > 0.2, `1x: clip of ${AUTO.story_id} plays when its cue goes on air (${JSON.stringify(v)})`);
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
await page.evaluate(() => window.studioDesk.setPlaying(false));

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
if (failures.length) { console.log(`${failures.length} failure(s)`); process.exit(1); }
console.log("voice: all checks passed");
