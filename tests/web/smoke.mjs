// Smoke test of the 2D broadcast page, on the DEMO fixture by default (MATCH=M001 for an export).
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh     (serves web/ and starts the browser)
//   node tests/web/smoke.mjs http://127.0.0.1:8765/          (page already served; CDP_URL to
//                                                             connect to a running Chromium)
//
// Fails on any console error. Checks: every cue of both audiences on screen (the nameplate on its
// player, mapped from tracking by this file); never more than 2 graphics in the DOM, also while
// playing at 16x and 64x, and none past its cue; the real-time path; Space toggling exactly once;
// the clock frozen at the end of each period; the score bug and seek-bar goals against the score
// facts; seek keys and aria-valuetext; shirt-number contrast; the pass bar scale; why-card text
// never cut; reduced motion; a manifest that fails; hostile data; phone landscape and portrait
// (every control reachable, graphic text at least 11 px in portrait). Screenshots go to out/shots/.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const MATCH = process.env.MATCH ?? "DEMO";
const url = new URL(`?match=${MATCH}`, base).href;
const dataUrl = new URL(`data/${MATCH}/`, base).href;
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const check = async (name, fn) => {
  try { await fn(); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
};

// Independent of the page: the data files, and the pitch mapping of web/js/pitch.js written again.
const meta = await (await fetch(`${dataUrl}meta.json`)).json();
const facts = await (await fetch(`${dataUrl}facts.json`)).json();
const pos = new Float32Array(await (await fetch(`${dataUrl}tracking.f32`)).arrayBuffer());
const N = meta.entities.length, P1 = meta.period1_s, DUR = meta.period1_s + meta.period2_s;
const PX = (1080 - 130 - 70) / 68, LEFT = (1920 - 105 * PX) / 2;
function stageAt(entity, ts) {
  const i = meta.entities.indexOf(entity);
  const f = Math.min(Math.max(ts * meta.fps, 0), meta.frames - 1), f0 = Math.floor(f), f1 = Math.min(f0 + 1, meta.frames - 1);
  const a = f - f0, o0 = (f0 * N + i) * 3, o1 = (f1 * N + i) * 3;
  const x = pos[o0] + (pos[o1] - pos[o0]) * a, y = pos[o0 + 1] + (pos[o1 + 1] - pos[o0 + 1]) * a;
  return [LEFT + x * PX, 130 + (68 - y) * PX];
}
function scoreAt(fs, ts) {
  const home = meta.teams.find((t) => t.side === "home").team_id, away = meta.teams.find((t) => t.side === "away").team_id;
  const top = (team) => Math.max(0, ...fs.filter((f) => f.kind === "score" && f.team_id === team && f.ts <= ts).map((f) => f.value));
  return [top(home), top(away)];
}
function minuteAt(ts) {
  const period = ts <= P1 ? 1 : 2, len = period === 1 ? P1 : meta.period2_s;
  const t = Math.min(period === 1 ? ts : ts - P1, len - 1e-6);
  return { period: period === 1 ? "1H" : "2H", minute: `${Math.floor(t / 60) + (period === 2 ? 45 : 0) + 1}'` };
}
const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// In the page: graphics in the DOM (including those animating out), per graphic its visible state.
const GRAPHIC_NODES = "#overlay > *, #deck > *";
const onScreen = (page) => page.evaluate((sel) => {
  const sd = window.studioDesk, frame = document.querySelector("#frame").getBoundingClientRect();
  const k = frame.width / 1920;
  const live = [...sd.host.live.values()].map((inst) => {
    const el = inst.el, root = el.shadowRoot;
    const texts = [...root.querySelectorAll(".name, .title, .big, .team")].filter((n) => n.getBoundingClientRect().width > 0);
    let op = texts.length ? 1 : 0;
    for (let n = texts[0]; n && n !== root; n = n.parentNode) if (n.nodeType === 1) op *= Number(getComputedStyle(n).opacity);
    let ring = null;
    if (inst.cue.graphic === "nameplate") {
      const r = root.querySelector(".ring").getBoundingClientRect();
      ring = [(r.left + r.width / 2 - frame.left) / k, (r.top + r.height / 2 - frame.top) / k];
    }
    return { graphic: inst.cue.graphic, cue: inst.cue.cue_id, mode: inst.mode, step: el.currentStep,
      opacity: op, texts: texts.length, facts: root.querySelectorAll(".facts span").length, ring,
      player: inst.cue.payload.player_id };
  });
  return { live, nodes: document.querySelectorAll(sel).length, ts: sd.state.ts };
}, GRAPHIC_NODES);

const seekTo = async (page, ts) => {
  await page.evaluate((x) => { window.studioDesk.setPlaying(false); window.studioDesk.seek(x); }, ts);
  await page.waitForTimeout(250);
};
const scorebug = (page) => page.evaluate(() => ({
  h: document.querySelector(".sb-h").textContent, a: document.querySelector(".sb-a").textContent,
  minute: document.querySelector(".sb-min").textContent, period: document.querySelector(".sb-period").textContent,
}));
const open = async (browser, opts, { route, ignoreConsole = false } = {}) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  if (!ignoreConsole) page.on("console", (m) => { if (m.type() === "error") fail(`${opts.viewport.width}x${opts.viewport.height} console: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`${opts.viewport.width}x${opts.viewport.height} page error: ${e.message}`));
  if (route) await route(page);
  await page.goto(url);
  await page.waitForFunction(() => window.studioDesk?.match, null, { timeout: 10000 });
  await page.evaluate(() => document.fonts.ready);
  return page;
};

// Playing at `speed` from `from` for `span` match seconds: the most graphics in the DOM, and any
// graphic still there more than one frame step after its cue ended.
const playAt = (page, speed, from, span) => page.evaluate(async ({ speed, from, span, sel }) => {
  const sd = window.studioDesk, layers = [...document.querySelectorAll("#overlay, #deck")];
  const ends = new Map();
  const obs = new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      const inst = [...sd.host.live.values()].find((i) => n.contains(i.el));
      if (inst) ends.set(n, inst.cue.ts + inst.cue.duration_s);
    }
  });
  for (const l of layers) obs.observe(l, { childList: true });
  sd.setPlaying(false);
  sd.seek(from);
  document.querySelector(`[data-speed="${speed}"]`).click();
  sd.setPlaying(true);
  let most = 0, late = null, prev = from;
  await new Promise((done) => {
    const step = () => {
      const ts = sd.state.ts, nodes = document.querySelectorAll(sel);
      most = Math.max(most, nodes.length);
      for (const n of nodes) {
        const end = ends.get(n);
        if (end !== undefined && ts > end + Math.max(ts - prev, 0) + 0.05 && !late) late = { end, ts };
      }
      prev = ts;
      if (ts >= Math.min(from + span, sd.end) || !sd.state.playing) done(); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  obs.disconnect();
  sd.setPlaying(false);
  document.querySelector('[data-speed="1"]').click();
  return { most, late, seen: ends.size };
}, { speed, from, span, sel: GRAPHIC_NODES });

// Every control in #controls fully inside the viewport and the topmost element at its centre.
const unreachable = (page) => page.evaluate(() => [...document.querySelectorAll("#controls button, #controls select, #seek-range")]
  .filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) return true;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(hit && (hit === el || el.contains(hit) || hit.contains(el)));
  }).map((el) => el.id || el.dataset.speed || el.dataset.audience || el.tagName));

// Smallest rendered text (CSS px) inside the graphics on screen.
const smallestText = (page) => page.evaluate((sel) => {
  let min = Infinity, what = "";
  for (const host of [...document.querySelectorAll(sel.replaceAll(">", ""))].filter((n) => n.shadowRoot)) {
    for (const el of host.shadowRoot.querySelectorAll("*")) {
      if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || !el.offsetWidth) continue;
      const px = parseFloat(getComputedStyle(el).fontSize) * (r.width / el.offsetWidth);
      if (px < min) { min = px; what = `${host.tagName.toLowerCase()} .${el.className}`; }
    }
  }
  return { min, what };
}, GRAPHIC_NODES);

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await open(browser, { viewport: { width: 1280, height: 720 } });
  page.on("requestfailed", (r) => fail(`request failed: ${r.url()}`));
  const cues = await page.evaluate(() => window.studioDesk.match.cues);

  await check("cues", async () => {
    const shotFor = {};
    for (const audience of ["analyst", "casual"]) {
      await page.click(`[data-audience="${audience}"]`);
      for (const c of cues.filter((x) => x.audience === audience)) {
        await seekTo(page, c.ts + Math.min(2, c.duration_s / 2));
        const { live, nodes, ts } = await onScreen(page);
        if (nodes > 2) fail(`${c.cue_id}: ${nodes} graphics in the DOM`);
        const g = live.find((x) => x.cue === c.cue_id);
        if (!g) { fail(`${audience} ${c.cue_id} ${c.graphic}: not on screen`); continue; }
        if (g.step !== 0 || g.opacity < 0.9) fail(`${audience} ${c.cue_id} ${c.graphic}: hidden (step ${g.step}, opacity ${g.opacity}, ${g.texts} texts)`);
        if ((audience === "analyst") !== (g.facts > 0)) fail(`${audience} ${c.cue_id}: ${g.facts} fact ids shown`);
        if (g.ring) {
          const [x, y] = stageAt(g.player, ts), off = Math.hypot(g.ring[0] - x, g.ring[1] - y);
          if (off > 3) fail(`${c.cue_id}: nameplate ${off.toFixed(1)} px off its player`);
        }
        const key = audience === "analyst" ? c.graphic : "casual";
        if (!shotFor[key]) {
          shotFor[key] = c.cue_id;
          await page.screenshot({ path: `${shots}/web2d-${key}.png` });
        }
      }
    }
    console.log(`checked ${cues.length} cues`);
  });

  await check("real-time path", async () => {
    await page.click('[data-audience="analyst"]');
    const first = cues.find((c) => c.audience === "analyst");
    await page.evaluate((ts) => { window.studioDesk.seek(ts); window.studioDesk.state.speed = 1; window.studioDesk.setPlaying(true); }, first.ts - 1);
    await page.waitForTimeout(2600);
    const rt = (await onScreen(page)).live.find((x) => x.cue === first.cue_id);
    if (!rt || rt.mode !== "realtime" || rt.step !== 0 || rt.opacity < 0.9) fail(`real-time path: ${JSON.stringify(rt)}`);
    await page.evaluate(() => window.studioDesk.setPlaying(false));
  });

  await check("space", async () => {
    await page.evaluate(() => {
      window.__toggles = 0;
      new MutationObserver(() => window.__toggles++).observe(document.querySelector("#play"), { attributeFilter: ["class"] });
    });
    for (const sel of ["#play", '[data-speed="4"]', "body"]) {
      const before = await page.evaluate(() => [window.__toggles, window.studioDesk.state.speed]);
      if (sel === "body") await page.evaluate(() => document.activeElement.blur()); else await page.focus(sel);
      await page.keyboard.press("Space");
      await page.waitForTimeout(150);
      const after = await page.evaluate(() => [window.__toggles, window.studioDesk.state.speed]);
      if (after[0] - before[0] !== 1) fail(`space on ${sel}: play toggled ${after[0] - before[0]} times`);
      if (after[1] !== before[1]) fail(`space on ${sel}: speed changed to ${after[1]}`);
    }
    await page.evaluate(() => window.studioDesk.setPlaying(false));
  });

  await check("clock", async () => {
    const end = await page.evaluate(() => window.studioDesk.end);
    for (const ts of [P1 - 1, P1, P1 + 1, DUR, end]) {
      await seekTo(page, ts);
      const got = await scorebug(page), want = minuteAt(ts);
      if (got.minute !== want.minute || got.period !== want.period) fail(`clock at ${ts}: ${got.minute} ${got.period}, want ${want.minute} ${want.period}`);
    }
  });

  await check("score", async () => {
    const goals = facts.filter((f) => f.kind === "score");
    for (const ts of [0, ...goals.map((f) => f.ts + 1), DUR]) {
      await seekTo(page, ts);
      const got = await scorebug(page), [h, a] = scoreAt(facts, ts);
      if (got.h !== String(h) || got.a !== String(a)) fail(`score at ${ts}: ${got.h}-${got.a}, facts say ${h}-${a}`);
    }
    const marks = await page.evaluate(() => document.querySelectorAll("#seek-marks .goal").length);
    if (marks !== goals.length) fail(`seek bar: ${marks} goal marks, ${goals.length} score facts`);
  });

  await check("seek keys", async () => {
    await seekTo(page, 600 % DUR);
    await page.focus("#seek-range");
    const t0 = await page.evaluate(() => window.studioDesk.state.ts);
    await page.keyboard.press("ArrowRight");
    const t1 = await page.evaluate(() => window.studioDesk.state.ts);
    await page.keyboard.press("PageDown");
    const t2 = await page.evaluate(() => window.studioDesk.state.ts);
    if (Math.abs(t1 - t0 - 5) > 0.01) fail(`ArrowRight moved ${(t1 - t0).toFixed(2)} s, want 5`);
    if (Math.abs(t1 - t2 - 60) > 0.01) fail(`PageDown moved ${(t1 - t2).toFixed(2)} s, want -60`);
    await page.waitForTimeout(100);
    const text = await page.$eval("#seek-range", (el) => el.getAttribute("aria-valuetext"));
    const want = minuteAt(t2);
    if (!text || !text.includes(want.minute.replace("'", ""))) fail(`aria-valuetext "${text}" does not say minute ${want.minute}`);
  });

  await check("shirt contrast", async () => {
    const colours = [...Array(64).keys()].map((i) => `#${(i * 4).toString(16).padStart(2, "0").repeat(3)}`)
      .concat(["#D7263D", "#F2C14E", "#2E9E4F", "#1F77B4", "#E07B39", "#7F7F7F", "#00A0B0"]);
    const picked = await page.evaluate(async (cs) => {
      const { textOn } = await import(new URL("js/pitch.js", document.baseURI));
      return cs.map((c) => textOn(c));
    }, colours);
    colours.forEach((c, i) => {
      const other = picked[i].toLowerCase() === "#ffffff" ? "#0e1a3d" : "#ffffff";
      if (contrast(c, picked[i]) + 1e-9 < contrast(c, other)) fail(`shirt text on ${c}: ${picked[i]} has less contrast than ${other}`);
    });
  });

  // Graphics rendered on their own, outside the cue sheet.
  const render = (name, data, play = { goto: 0, skipAnimation: true }) => page.evaluate(async ({ name, data, play }) => {
    const g = window.studioDesk.host.graphics[name], el = document.createElement(g.tag);
    el.id = "probe";
    document.querySelector("#frame").append(el);
    await el.load({ data, renderType: "realtime", renderCharacteristics: { resolution: { width: 1920, height: 1080 }, frameRate: 60 } });
    const t0 = performance.now();
    await el.playAction(play);
    return performance.now() - t0;
  }, { name, data, play });
  const unprobe = () => page.evaluate(() => document.querySelector("#probe")?.remove());

  await check("pass bar scale", async () => {
    await render("pass_shot", { mode: "pass", player_id: "T01-4", value: 31.2, unit: "m", quality: { value: 8, max: 10 }, fact_ids: [] });
    const w = await page.evaluate(() => document.querySelector("#probe").shadowRoot.querySelector(".bar").style.width);
    if (w !== "80%") fail(`quality {value: 8, max: 10} drew a ${w} bar, want 80%`);
    await unprobe();
  });

  await check("why card text", async () => {
    const body = "The pass broke two lines and the run behind it was timed to the step, ".repeat(4) + "ending at 34.56 km/h.";
    await render("why_card", { kind: "why", title: "A long story about one move", body, fact_ids: [] });
    const r = await page.evaluate(() => {
      const b = document.querySelector("#probe").shadowRoot.querySelector(".body");
      return { scroll: b.scrollHeight, client: b.clientHeight, font: parseFloat(getComputedStyle(b).fontSize) };
    });
    if (r.scroll > r.client + 1) fail(`why card cuts its body: ${r.scroll} px of text in ${r.client} px`);
    await unprobe();
  });

  await check("reduced motion", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const ms = await render("pass_shot", { mode: "shot", player_id: "T01-9", value: 101, unit: "km/h", quality: "Goal", fact_ids: [] }, { goto: 0 });
    if (ms > 150) fail(`reduced motion: the in animation still ran for ${ms.toFixed(0)} ms`);
    await unprobe();
    await page.emulateMedia({ reducedMotion: "no-preference" });
  });

  await check("aria", async () => {
    const role = await page.$eval("#frame", (el) => el.getAttribute("role"));
    if (!role) fail("#frame has aria-label but no role");
  });

  for (const [speed, span] of [[64, 900], [16, 300]]) {
    await check(`${speed}x`, async () => {
      for (const audience of ["analyst", "casual"]) {
        await page.click(`[data-audience="${audience}"]`);
        // start a little before the audience's first cue, so the window always holds graphics
        const from = Math.max(0, Math.min(...cues.filter((c) => c.audience === audience).map((c) => c.ts)) - 10);
        const r = await playAt(page, speed, from, span);
        if (r.most > 2) fail(`${speed}x ${audience}: ${r.most} graphics in the DOM at once`);
        if (r.late) fail(`${speed}x ${audience}: a graphic of a cue ending at ${r.late.end.toFixed(1)} s still there at ${r.late.ts.toFixed(1)} s`);
        if (!r.seen) fail(`${speed}x ${audience}: no graphic shown`);
      }
    });
  }

  await page.click('[data-audience="analyst"]');
  await seekTo(page, DUR + 4);
  if (!(await onScreen(page)).live.some((x) => x.graphic === "why_card" && x.step === 0)) fail("full-time recap not on screen after the last frame");
  await page.screenshot({ path: `${shots}/web2d-fulltime.png` });
  const shot = cues.find((c) => c.audience === "analyst" && c.graphic === "pass_shot" && c.payload.mode === "shot");
  await seekTo(page, shot.ts + 2);
  await page.screenshot({ path: `${shots}/web-fixes-1280x720.png` });
  await seekTo(page, 40);
  await page.screenshot({ path: `${shots}/web2d-overview.png` });

  // Hostile data: goals only in the facts, a goal of an unknown team, markup in a team colour.
  await check("hostile data", async () => {
    let edited = null;
    const hostile = await open(browser, { viewport: { width: 1280, height: 720 } }, {
      ignoreConsole: true,
      route: async (p) => {
        const edit = (file, fn) => p.route(`**/data/${MATCH}/${file}`, async (route) => {
          const r = await route.fetch();
          route.fulfill({ response: r, json: fn(await r.json()) });
        });
        await edit("meta.json", (m) => { m.teams[0].color_primary = '#123456"><img src=x onerror="window.__xss=1">'; return m; });
        await edit("events.json", (es) => {
          for (const e of es) if (/^shot/.test(e.type_name) && e.result_name === "success") e.type_name = "dribble";
          es.push({ ...es[0], event_id: 999999, type_name: "shot", result_name: "success", team_id: "T99" });
          return es;
        });
        await edit("facts.json", (fs) => {
          fs.push({ ...fs[0], fact_id: "F-SCORE-999999", kind: "score", team_id: "T99", player_id: null, value: 1, ts: 5 });
          edited = fs;
          return fs.sort((a, b) => a.ts - b.ts);
        });
      },
    });
    for (const ts of [0, ...facts.filter((f) => f.kind === "score").map((f) => f.ts + 1), DUR]) {
      await seekTo(hostile, ts);
      const got = await scorebug(hostile), [h, a] = scoreAt(edited, ts);
      if (got.h !== String(h) || got.a !== String(a)) fail(`hostile score at ${ts}: ${got.h}-${got.a}, facts say ${h}-${a}`);
    }
    if (await hostile.evaluate(() => window.__xss)) fail("team colour markup ran as HTML");
    await hostile.context().close();
  });

  await check("manifest failure", async () => {
    const broken = await open(browser, { viewport: { width: 1280, height: 720 } }, {
      ignoreConsole: true, route: (p) => p.route("**/why_card.ograf.json", (r) => r.fulfill({ status: 404, body: "" })),
    });
    const msg = await broken.evaluate(() => { const n = document.querySelector("#notice"); return n && !n.hidden ? n.textContent : ""; });
    if (!/why_card/.test(msg)) fail(`manifest failure: no message on screen ("${msg}")`);
    await broken.context().close();
  });

  for (const [w, h] of [[844, 390], [390, 844]]) {
    await check(`phone ${w}x${h}`, async () => {
      const phone = await open(browser, { viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: true });
      if (await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) fail(`${w}x${h}: horizontal scroll`);
      const lost = await unreachable(phone);
      if (lost.length) fail(`${w}x${h}: controls out of reach: ${lost.join(", ")}`);
      if (h > w) {
        for (const graphic of ["pass_shot", "why_card", "momentum", "nameplate"]) {
          const c = cues.find((x) => x.audience === "analyst" && x.graphic === graphic);
          if (!c) continue;
          await seekTo(phone, c.ts + Math.min(2, c.duration_s / 2));
          const t = await smallestText(phone);
          if (t.min < 11) fail(`${w}x${h} ${graphic}: text at ${t.min.toFixed(1)} px (${t.what})`);
          if (await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) fail(`${w}x${h} ${graphic}: horizontal scroll`);
        }
      }
      await seekTo(phone, shot.ts + 2);
      await phone.screenshot({ path: `${shots}/web-fixes-${w}x${h}.png` });
      await phone.context().close();
    });
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.log(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log("smoke ok");
