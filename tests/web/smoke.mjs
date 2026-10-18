// Smoke test of the 2D broadcast page on the DEMO fixture.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh     (serves web/ and starts the browser)
//   node tests/web/smoke.mjs http://127.0.0.1:8765/          (page already served; CDP_URL to
//                                                             connect to a running Chromium)
//
// Fails on any console error; seeks to every cue of both audiences and checks the graphic is on
// screen (and the nameplate sits on its player); checks the real-time path, the space key and the
// full-time recap after the last frame; saves screenshots to out/shots/web2d-*.png.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const url = new URL("?match=DEMO", base).href;
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") fail(`console: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  page.on("requestfailed", (r) => fail(`request failed: ${r.url()}`));
  await page.goto(url);
  await page.waitForFunction(() => window.studioDesk?.match, null, { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);

  // What is on screen: per graphic, shown (step 0 and opaque), fact chips, nameplate offset.
  const onScreen = () => page.evaluate(() => {
    const sd = window.studioDesk;
    return [...sd.host.live.values()].map((inst) => {
      const el = inst.el, root = el.shadowRoot;
      const texts = [...root.querySelectorAll(".name, .title, .big, .team")].filter((n) => n.getBoundingClientRect().width > 0);
      let op = 1;
      for (let n = texts[0]; n && n !== root; n = n.parentNode) if (n.nodeType === 1) op *= Number(getComputedStyle(n).opacity);
      let offset = null;
      if (inst.cue.graphic === "nameplate") {
        const want = sd.host.opts.locate(inst.cue.payload.player_id, sd.state.ts);
        const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(root.querySelector(".anchor").style.transform);
        offset = m ? Math.hypot(Number(m[1]) - want.x, Number(m[2]) - want.y) : Infinity;
      }
      return { graphic: inst.cue.graphic, cue: inst.cue.cue_id, mode: inst.mode, step: el.currentStep,
        opacity: op, facts: root.querySelectorAll(".facts span").length, offset };
    });
  });

  const setAudience = (a) => page.click(`[data-audience="${a}"]`);
  const seekTo = async (ts) => {
    await page.evaluate((x) => { window.studioDesk.setPlaying(false); window.studioDesk.seek(x); }, ts);
    await page.waitForTimeout(250);
  };

  const cues = await page.evaluate(() => window.studioDesk.match.cues);
  const shotFor = {};
  for (const audience of ["analyst", "casual"]) {
    await setAudience(audience);
    for (const c of cues.filter((x) => x.audience === audience)) {
      await seekTo(c.ts + Math.min(2, c.duration_s / 2));
      const live = await onScreen();
      const g = live.find((x) => x.cue === c.cue_id);
      if (!g) { fail(`${audience} ${c.cue_id} ${c.graphic}: not on screen`); continue; }
      if (g.step !== 0 || g.opacity < 0.9) fail(`${audience} ${c.cue_id} ${c.graphic}: hidden (step ${g.step}, opacity ${g.opacity})`);
      if ((audience === "analyst") !== (g.facts > 0)) fail(`${audience} ${c.cue_id}: ${g.facts} fact ids shown`);
      if (g.offset !== null && g.offset > 2) fail(`${c.cue_id}: nameplate ${g.offset.toFixed(1)} px off its player`);
      if (live.length > 2) fail(`${c.cue_id}: ${live.length} graphics on screen`);
      const key = audience === "analyst" ? c.graphic : "casual";
      if (!shotFor[key]) {
        shotFor[key] = c.cue_id;
        await page.screenshot({ path: `${shots}/web2d-${key}.png` });
      }
    }
  }
  console.log(`checked ${cues.length} cues`);

  // real-time path: play into the first analyst cue at 1x
  await setAudience("analyst");
  const first = cues.find((c) => c.audience === "analyst");
  await page.evaluate((ts) => { window.studioDesk.seek(ts); window.studioDesk.state.speed = 1; window.studioDesk.setPlaying(true); }, first.ts - 1);
  await page.waitForTimeout(2600);
  const rt = (await onScreen()).find((x) => x.cue === first.cue_id);
  if (!rt || rt.mode !== "realtime" || rt.step !== 0 || rt.opacity < 0.9) fail(`real-time path: ${JSON.stringify(rt)}`);
  else console.log("real-time path ok");

  // space toggles play
  const before = await page.evaluate(() => window.studioDesk.state.playing);
  await page.keyboard.press("Space");
  const after = await page.evaluate(() => window.studioDesk.state.playing);
  if (before === after) fail("space did not toggle play");

  // after the last tracking frame: the clock runs on and the full-time recap is on screen
  const dur = await page.evaluate(() => window.studioDesk.match.duration);
  await seekTo(dur + 4);
  const ft = await onScreen();
  if (!ft.some((x) => x.graphic === "why_card" && x.step === 0)) fail("full-time recap not on screen after the last frame");
  await page.screenshot({ path: `${shots}/web2d-fulltime.png` });

  // overview: playing at 1280x720
  await seekTo(40);
  await page.screenshot({ path: `${shots}/web2d-overview.png` });

  // phone in landscape
  const phone = await (await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true })).newPage();
  phone.on("console", (m) => { if (m.type() === "error") fail(`phone console: ${m.text()}`); });
  await phone.goto(url);
  await phone.waitForFunction(() => window.studioDesk?.match, null, { timeout: 15000 });
  const shot = cues.find((c) => c.audience === "analyst" && c.graphic === "pass_shot" && c.payload.mode === "shot");
  await phone.evaluate((ts) => window.studioDesk.seek(ts), shot.ts + 2);
  await phone.waitForTimeout(300);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) fail("phone: horizontal scroll");
  await phone.screenshot({ path: `${shots}/web2d-phone.png` });
} finally {
  await browser.close();
}

if (failures.length) {
  console.log(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log("smoke ok");
