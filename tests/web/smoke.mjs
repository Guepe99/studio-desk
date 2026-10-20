// Smoke test of the 2D broadcast page, on the DEMO fixture by default (MATCH=M001 for an export).
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh     (serves web/ and starts the browser)
//   node tests/web/smoke.mjs http://127.0.0.1:8765/          (page already served; CDP_URL to
//                                                             connect to a running Chromium)
//
// Fails on any console error. Checks: every cue of both audiences on screen, and of every team and
// player audience picked in the My team and Player modes (the nameplate on its
// player, mapped from tracking by this file); never more than 2 graphics in the DOM, also while
// playing at 16x and 64x, and none past its cue; the real-time path; Space toggling exactly once;
// the clock frozen at the end of each period; the score bug and seek-bar goals against the score
// facts; seek keys and aria-valuetext; shirt-number contrast; the pass bar scale; why-card text
// never cut; reduced motion; a manifest that fails; hostile data; Ask the studio with its API stubbed;
// phone landscape and portrait (every control reachable, graphic text at least 11 px in portrait, the
// agent strip on one line); Next key moment for analyst and a team; the agent strip after seeks and
// at 64x. Screenshots go to out/shots/.
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
// On air for a visitor who has not touched the desk: template cues and auto-approved stories, in
// English (tests/web/desk.mjs covers the other languages and the desk's decisions).
const storiesRes = await fetch(`${dataUrl}stories.json`);
const autoApproved = new Set((storiesRes.ok ? await storiesRes.json() : []).filter((s) => s.default_status === "auto_approved").map((s) => s.story_id));
const onAir = (c) => c.lang === "en" && (c.story_id === null || autoApproved.has(c.story_id));
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
  // and at least one drawn frame after the seek: on a loaded machine 250 ms can pass without one
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};
const scorebug = (page) => page.evaluate(() => ({
  h: document.querySelector(".sb-h").textContent, a: document.querySelector(".sb-a").textContent,
  minute: document.querySelector(".sb-min").textContent, period: document.querySelector(".sb-period").textContent,
}));
const open = async (browser, opts, { route, ignoreConsole = false } = {}) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  // with static hosting the desk's api/ calls 404 and the desk keeps decisions in the tab
  // voice.json is optional too: a match without clips answers 404
  const apiMiss = (m) => /\/api\/|\/voice\.json$/.test(m.location()?.url ?? "");
  if (!ignoreConsole) page.on("console", (m) => { if (m.type() === "error" && !apiMiss(m)) fail(`${opts.viewport.width}x${opts.viewport.height} console: ${m.text()}`); });
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
  .filter((el) => !el.hidden)   // the voice button stays hidden on a match without clips
  .filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) return true;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(hit && (hit === el || el.contains(hit) || hit.contains(el)));
  }).map((el) => el.id || el.dataset.speed || el.dataset.audience || el.tagName));

// How far the boxes of #app reach past the room it has (its height less its padding), in px.
const overflow = (page) => page.evaluate(() => {
  const app = document.querySelector("#app"), cs = getComputedStyle(app);
  const boxes = [...app.children].filter((el) => el.getClientRects().length && getComputedStyle(el).position !== "absolute").map((el) => el.getBoundingClientRect());
  const span = Math.max(...boxes.map((r) => r.bottom)) - Math.min(...boxes.map((r) => r.top));
  return span - (app.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
});

// POST api/ask stubbed (the static site has no API): {} is the page's probe, "limit" and "offline" the error paths.
const askStub = (sent = []) => (p) => p.route("**/api/ask", (r) => {
  const b = JSON.parse(r.request().postData() || "{}");
  if (!b.question) return r.fulfill({ status: 422, json: { detail: [] } });
  sent.push(b);
  if (b.question === "limit") return r.fulfill({ status: 429, json: { status: "limit", reason: "questions per visitor" } });
  if (b.question === "offline") return r.abort();
  return r.fulfill({ json: { status: "answered", answer: '<img src=x onerror="window.__xss=2">The quickest sprint was 32 km/h.',
    fact_ids: ["F-SPRINT_SPEED-000001"], questions_left: 9 } });
});
// The Ask panel inside the viewport, its question box the topmost element at its centre.
const askFits = (page) => page.evaluate(() => {
  const r = document.querySelector("#ask").getBoundingClientRect(), q = document.querySelector("#ask-q").getBoundingClientRect();
  const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
  return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && hit?.id === "ask-q";
});

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
  const cues = (await page.evaluate(() => window.studioDesk.match.cues)).filter(onAir);
  // the broadcast has the focus once loaded, so Space and N work at once
  if (await page.evaluate(() => document.activeElement?.id) !== "frame") fail("focus: the broadcast frame does not have the focus after loading");

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

  // My team and Player: the picker offers exactly the audiences of cues.json, and for each one the
  // graphics on screen are that audience's cues and nobody else's.
  await check("modes", async () => {
    const all = await page.evaluate(() => window.studioDesk.match.cues);
    for (const kind of ["team", "player"]) {
      const auds = [...new Set(all.map((c) => c.audience).filter((a) => a.startsWith(`${kind}:`)))].sort();
      if (!auds.length) { fail(`modes: ${MATCH} has no ${kind} cues`); continue; }
      await page.click(`[data-audience="${kind}"]`);
      const offered = (await page.$$eval("#audience-pick option", (os) => os.map((o) => o.value))).sort();
      if (offered.join() !== auds.join()) fail(`${kind}: picker offers ${offered.join()}, cues.json has ${auds.join()}`);
      if (kind === "player") { // each entry ends with the minute of the player's first graphic (late substitutes)
        const wrong = await page.evaluate(() => [...document.querySelectorAll("#audience-pick option")].filter((o) => {
          const sd = window.studioDesk, ts = Math.min(...sd.match.cues.filter((c) => c.audience === o.value).map((c) => c.ts));
          return !o.textContent.endsWith(`, ${sd.match.clock(ts).minute}'`);
        }).map((o) => o.textContent));
        if (wrong.length) fail(`player picker without the first minute: ${wrong.slice(0, 3).join(" | ")}`);
      }
      let seen = 0;
      for (const aud of auds) {
        await page.selectOption("#audience-pick", aud);
        const [got, on] = await page.evaluate((k) => [window.studioDesk.state.audience,
          document.querySelector(`[data-audience="${k}"]`).getAttribute("aria-pressed")], kind);
        if (got !== aud || on !== "true") fail(`${aud}: state ${got}, aria-pressed ${on}`);
        const mine = cues.filter((x) => x.audience === aud), ids = new Set(mine.map((x) => x.cue_id));
        for (const c of mine) {
          await seekTo(page, c.ts + Math.min(2, c.duration_s / 2));
          const { live } = await onScreen(page);
          const g = live.find((x) => x.cue === c.cue_id);
          if (!g) { fail(`${aud} ${c.cue_id} ${c.graphic}: not on screen`); continue; }
          if (g.facts > 0) fail(`${aud} ${c.cue_id}: ${g.facts} fact ids shown`);
          for (const x of live) if (!ids.has(x.cue)) fail(`${aud}: ${x.cue} (${x.graphic}) of another audience on screen`);
          if (!seen++) await page.screenshot({ path: `${shots}/web2d-${kind}.png` });
        }
      }
      if (!seen) fail(`${kind}: no cue on air to check`);
      console.log(`${kind}: ${auds.length} audiences, ${seen} cues checked`);
    }
    // keyboard: Enter on the button, arrows in the picker
    await page.focus('[data-audience="team"]');
    await page.keyboard.press("Enter");
    const before = await page.evaluate(() => window.studioDesk.state.audience);
    await page.focus("#audience-pick");
    const lastTeam = await page.$eval("#audience-pick option:last-child", (o) => o.value);
    await page.keyboard.press(before === lastTeam ? "ArrowUp" : "ArrowDown");
    const after = await page.evaluate(() => [window.studioDesk.state.audience, document.querySelector('[data-audience="team"]').getAttribute("aria-pressed")]);
    if (!before.startsWith("team:") || after[0] === before || !after[0].startsWith("team:") || after[1] !== "true") fail(`keyboard: team ${before} -> ${after.join(" ")}`);
    await page.click('[data-audience="analyst"]');
    if (!(await page.$eval("#audience-pick", (el) => el.hidden))) fail("picker still shown for the analyst audience");
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
    if (await page.$eval("#frame", (el) => el.tabIndex) !== 0) fail("space: the frame is not focusable");
    await page.evaluate(() => {
      window.__toggles = 0;
      new MutationObserver(() => window.__toggles++).observe(document.querySelector("#play"), { attributeFilter: ["class"] });
    });
    // a single-key shortcut only inside the broadcast and its controls (WCAG 2.1.4): not on the page body
    for (const [sel, want] of [["#play", 1], ['[data-speed="4"]', 1], ["#frame", 1], ["body", 0]]) {
      const before = await page.evaluate(() => [window.__toggles, window.studioDesk.state.speed]);
      if (sel === "body") await page.evaluate(() => document.activeElement.blur()); else await page.focus(sel);
      await page.keyboard.press("Space");
      await page.waitForTimeout(150);
      const after = await page.evaluate(() => [window.__toggles, window.studioDesk.state.speed]);
      if (after[0] - before[0] !== want) fail(`space on ${sel}: play toggled ${after[0] - before[0]} times, wanted ${want}`);
      if (after[1] !== before[1]) fail(`space on ${sel}: speed changed to ${after[1]}`);
    }
    await page.click("#frame", { position: { x: 5, y: 5 } });
    if (await page.evaluate(() => document.activeElement?.id) !== "frame") fail("space: a click on the frame does not focus it");
    await page.evaluate(() => window.studioDesk.setPlaying(false));
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

  const nextFrame = (p) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // Next key moment: 3 s before the next story cue on air for the audience (a story graphic that starts
  // while another story graphic is on air, plus 1 s, is the same moment, whatever its story), by button
  // and by the N key; nothing past the last one, with the focus kept and the reason announced.
  const nextBtn = () => page.$eval("#next-moment", (x) => ({ off: x.getAttribute("aria-disabled") === "true", disabled: x.disabled,
    label: x.textContent, lang: x.lang, live: document.querySelector("#moments-live")?.textContent ?? "" }));
  const clock = () => page.evaluate(() => window.studioDesk.state.ts);
  await check("next key moment", async () => {
    const all = await page.evaluate(() => window.studioDesk.match.cues);
    // the team with the most story cues on air (DEMO has none: there the button must stay disabled)
    const storyCount = (a) => cues.filter((c) => c.audience === a && c.story_id).length;
    const team = [...new Set(all.map((c) => c.audience).filter((a) => a.startsWith("team:")))].sort((a, b) => storyCount(b) - storyCount(a))[0];
    const stopsFor = (aud) => {
      const story = cues.filter((c) => c.audience === aud && c.story_id).sort((a, b) => a.ts - b.ts);
      return story.filter((c, i) => !story.slice(0, i).some((p) => c.ts <= p.ts + p.duration_s + 1));
    };
    for (const aud of ["analyst", team]) {
      if (aud === "analyst") await page.click('[data-audience="analyst"]');
      else { await page.click('[data-audience="team"]'); await page.selectOption("#audience-pick", aud); }
      const stops = stopsFor(aud);
      if (!stops.length && aud === "analyst") fail("next analyst: no story cue on air");
      if (MATCH === "M001" && aud === "analyst" && stops.some((c) => c.story_id === "S-000013")) fail("next: the comeback that shares the goal's event is a stop of its own");
      await seekTo(page, 0);
      for (const [i, c] of stops.entries()) {
        const b = await nextBtn();
        if (b.off || b.disabled) { fail(`next ${aud}: disabled before ${c.cue_id}`); break; }
        // the last press is a keyboard press on the button: the focus must stay on it
        if (i === stops.length - 1) { await page.focus("#next-moment"); await page.keyboard.press("Enter"); }
        else if (i % 2) { await page.focus("#frame"); await page.keyboard.press("n"); }
        else await page.click("#next-moment");
        await nextFrame(page);
        const ts = await clock(), want = Math.max(0, c.ts - 3);
        if (Math.abs(ts - want) > 0.01) { fail(`next ${aud}: landed at ${ts.toFixed(2)} s, wanted ${want.toFixed(2)} s for ${c.cue_id}`); break; }
      }
      const at = await clock();
      const b = await nextBtn();
      if (!b.off || b.disabled || b.label !== (stops.length ? "No more key moments" : "No key moments")) fail(`next ${aud}: past the last moment the button is ${JSON.stringify(b)}`);
      if (stops.length && await page.evaluate(() => document.activeElement?.id) !== "next-moment") fail(`next ${aud}: the focus left the button at the last moment`);
      if (!stops.length) await page.focus("#next-moment");
      await page.keyboard.press("Enter");
      await nextFrame(page);
      if ((await nextBtn()).live !== b.label) fail(`next ${aud}: a press past the last moment is not announced`);
      await page.focus("#frame");
      await page.keyboard.press("n");
      await nextFrame(page);
      if (await clock() !== at) fail(`next ${aud}: N moved the clock past the last moment`);
      console.log(`next ${aud}: ${stops.length} moments`);
    }
    // labels and their language
    await page.click('[data-audience="analyst"]');
    await seekTo(page, await page.evaluate(() => window.studioDesk.end));
    for (const [lang, label] of [["it", "Nessun altro momento chiave"], ["es", "No hay más momentos clave"]]) {
      await page.selectOption("#lang", lang);
      await nextFrame(page);
      const b = await nextBtn();
      if (b.label !== label || b.lang !== lang) fail(`next: label ${JSON.stringify(b.label)} lang ${b.lang}, wanted ${label} in ${lang}`);
    }
    await page.click('[data-audience="analyst"]');
    await seekTo(page, 0);
    for (const [lang, label] of [["it", "Prossimo momento chiave"], ["es", "Siguiente momento clave"], ["en", "Next key moment"]]) {
      await page.selectOption("#lang", lang);
      await nextFrame(page);
      const b = await nextBtn();
      if (b.label !== label || b.lang !== lang || b.off) fail(`next at 0: ${JSON.stringify(b)}, wanted ${label} in ${lang}`);
    }
    // N is ignored in the desk, with Shift and on the page body; at 64x a jump comes back to 1x
    await seekTo(page, 0);
    const first = stopsFor("analyst").map((c) => Math.max(0, c.ts - 3))[0];
    await page.focus('#desk [role="tab"]');
    await page.keyboard.press("n");
    await nextFrame(page);
    if (await clock() !== 0) fail("next: N in the desk moved the clock");
    await page.focus("#frame");
    await page.keyboard.press("Shift+N");
    await nextFrame(page);
    if (await clock() !== 0) fail("next: Shift+N moved the clock");
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("n");
    await nextFrame(page);
    if (await clock() !== 0) fail("next: N on the page body moved the clock");
    await page.click('[data-speed="64"]');
    await page.focus("#frame");
    await page.keyboard.press("n");
    await nextFrame(page);
    const sp = await page.evaluate(() => ({ speed: window.studioDesk.state.speed, pressed: document.querySelector('[data-speed="1"]').getAttribute("aria-pressed") }));
    if (sp.speed !== 1 || sp.pressed !== "true") fail(`next: after a jump at 64x the speed is ${JSON.stringify(sp)}, wanted 1x`);
    if (first !== undefined && Math.abs(await clock() - first) > 0.01) fail("next: N with the focus on the frame did not jump");
    await page.click('[data-speed="1"]');

    // the Ask box is outside the broadcast: a typed n is text, not a jump
    const p = await open(browser, { viewport: { width: 1280, height: 720 } }, { route: askStub() });
    await p.waitForSelector("#ask-open:not([hidden])", { timeout: 5000 });
    await p.click("#ask-open");
    await p.keyboard.type("n");
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    if (await p.evaluate(() => window.studioDesk.state.ts) !== 0 || await p.inputValue("#ask-q") !== "n") fail("next: N typed in the Ask box moved the clock");
    await p.context().close();

    // while the stories load: "Next key moment", disabled; a replay without stories: "No key moments"
    let release;
    const held = new Promise((r) => { release = r; });
    const empty = await open(browser, { viewport: { width: 1280, height: 720 } }, {
      route: (q) => q.route(`**/data/${MATCH}/stories.json`, async (r) => { await held; r.fulfill({ json: [] }); }),
    });
    const loading = await empty.$eval("#next-moment", (x) => ({ off: x.getAttribute("aria-disabled"), label: x.textContent }));
    if (loading.off !== "true" || loading.label !== "Next key moment") fail(`next while loading: ${JSON.stringify(loading)}`);
    release();
    await empty.waitForFunction(() => window.studioDesk.desk.loaded);
    await empty.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const none = await empty.$eval("#next-moment", (x) => ({ off: x.getAttribute("aria-disabled"), label: x.textContent }));
    if (none.off !== "true" || none.label !== "No key moments") fail(`next without stories: ${JSON.stringify(none)}`);
    await empty.context().close();
  });

  // Agent activity: each agent's latest step with ts <= now; while a story graphic is on air (the latest
  // cue wins, a tie goes to the later cue id), the chain of that story instead. After seeks both ways and
  // while playing at 64x with a handful of DOM changes (one per view, not one per frame).
  await check("agent activity", async () => {
    const rows = (await page.evaluate(() => window.studioDesk.desk.traces)).sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    if (!rows.length) { fail("activity: no traces in this replay"); return; }
    const traceIds = (r) => (r.story_ids?.length ? r.story_ids : r.story_id ? [r.story_id] : []);
    const storyCues = cues.filter((c) => c.audience === "analyst" && c.story_id);
    const storyAt = (ts) => storyCues.filter((c) => c.ts <= ts && ts < c.ts + c.duration_s)
      .sort((x, y) => y.ts - x.ts || (y.cue_id > x.cue_id ? 1 : -1))[0]?.story_id ?? null;
    const chainOf = (story) => (story ? rows.filter((r) => traceIds(r).includes(story)).sort((a, b) => a.seq - b.seq) : []);
    const latest = (src) => {
      const seen = new Set(), out = [];
      for (const r of [...src].reverse()) if (!seen.has(r.agent) && out.length < 7) { seen.add(r.agent); out.unshift(r.seq); }
      return out.join();
    };
    const want = (ts) => { const chain = chainOf(storyAt(ts)); return latest(chain.length ? chain : rows.filter((x) => x.ts <= ts)); };
    const money = (v) => `$${v.toFixed(v >= 0.1 ? 2 : 4)}`;
    const sumWant = (ts) => {
      const chain = chainOf(storyAt(ts));
      if (chain.length) { // the Traces tab's totals: a hand-off shared by n stories counts 1/n
        const tok = chain.reduce((a, r) => a + ((r.tokens_in || 0) + (r.tokens_out || 0)) / traceIds(r).length, 0);
        const usd = chain.reduce((a, r) => a + (r.cost_usd || 0) / traceIds(r).length, 0);
        return `How the graphic on air was made: ${chain.length} hand-offs, ${Math.round(tok).toLocaleString("en-US")} tokens, ${money(usd)}`;
      }
      const got = rows.filter((x) => x.ts <= ts);
      if (!got.length) return "";
      const tok = got.reduce((a, r) => a + (r.tokens_in || 0) + (r.tokens_out || 0), 0), usd = got.reduce((a, r) => a + (r.cost_usd || 0), 0);
      return `Hand-offs so far: ${got.length}, ${tok.toLocaleString("en-US")} tokens, ${money(usd)}`;
    };
    const strip = () => page.evaluate(() => ({ seqs: [...document.querySelectorAll("#activity li[data-seq]")].map((l) => l.dataset.seq).join(),
      sum: document.querySelector(".act-sum").textContent, title: document.querySelector(".act-title").textContent,
      empty: document.querySelector(".act-empty")?.textContent ?? "", lang: document.querySelector("#activity").lang }));
    const shown = async () => (await strip()).seqs;
    const mid = rows[Math.floor(rows.length / 2)].ts, last = rows.at(-1).ts;
    // every story graphic on air, 1 s in, and the times between them
    const times = [last + 1, mid, mid - 0.01, rows[0].ts - 1, mid, last + 1, ...storyCues.map((c) => c.ts + 1)];
    if (!storyCues.some((c) => chainOf(c.story_id).length)) fail("activity: no story graphic on air has a chain of traces");
    for (const ts of times) {
      await seekTo(page, ts);
      const got = await strip();
      if (got.seqs !== want(ts)) fail(`activity at ${ts} s (story on air ${storyAt(ts)}): shows ${got.seqs || "nothing"}, wanted ${want(ts) || "nothing"}`);
      if (got.sum !== sumWant(ts)) fail(`activity at ${ts} s: summary "${got.sum}", wanted "${sumWant(ts)}"`);
    }
    // the waiting line, and the strip in three languages, by the clock and on a story graphic
    const before = rows[0].ts - 1, quiet = rows.find((r) => !storyAt(r.ts + 0.5))?.ts + 0.5, onAir = storyCues.find((c) => chainOf(c.story_id).length);
    if (!storyAt(before)) {
      await seekTo(page, before);
      const got = await strip();
      if (got.empty !== "No agent hand-offs yet at this point of the match") fail(`activity: waiting line "${got.empty}"`);
    }
    for (const [lang, title, sum, made] of [["it", "Gli agenti al lavoro", "Passaggi di consegne finora: ", "Come è nata la grafica in onda: "],
      ["es", "Los agentes en acción", "Relevos hasta ahora: ", "Cómo se hizo el gráfico en pantalla: "], ["en", "Agents at work", "Hand-offs so far: ", "How the graphic on air was made: "]]) {
      await page.selectOption("#lang", lang);
      for (const [ts, start] of [[quiet, sum], [onAir?.ts + 1, made]]) {
        if (!Number.isFinite(ts)) continue;
        await seekTo(page, ts);
        const got = await strip();
        if (got.title !== title || got.lang !== lang || !got.sum.startsWith(start)) fail(`activity in ${lang} at ${ts} s: ${JSON.stringify(got)}`);
      }
    }
    const failed = rows.find((r) => r.step === "fallback" || /(^| )fallback: /.test(r.output_summary));
    if (failed) {
      await seekTo(page, failed.ts);
      const mark = await page.evaluate((seq) => document.querySelector(`#activity li[data-seq="${seq}"]`)?.className, failed.seq);
      if (mark !== undefined && !/fallback/.test(mark)) fail(`activity: fallback step ${failed.seq} not marked`);
    }
    const from = Math.max(0, rows[0].ts - 20);
    await page.evaluate(() => {
      window.__actMuts = 0;
      new MutationObserver((ms) => { window.__actMuts += ms.length; }).observe(document.querySelector("#activity"), { childList: true, subtree: true, characterData: true });
    });
    await playAt(page, 64, from, 900);
    const end = await page.evaluate(() => window.studioDesk.state.ts);
    const batches = new Set(rows.filter((r) => r.ts > from && r.ts <= end).map((r) => r.ts)).size;
    const graphics = storyCues.filter((c) => c.ts > from && c.ts <= end).length; // each one on air and off again
    const muts = await page.evaluate(() => window.__actMuts);
    if (muts > 4 * (batches + 2 * graphics + 1)) fail(`activity at 64x: ${muts} DOM changes for ${batches} batches of traces and ${graphics} story graphics`);
    if (await shown() !== want(end)) fail(`activity at 64x: stale at ${end.toFixed(1)} s`);
    if (await page.$eval("#activity", (el) => !!(el.closest("[aria-live]") || el.querySelector("[aria-live]")))) fail("activity: a live region");
    await seekTo(page, mid + 1);
    await page.screenshot({ path: `${shots}/web-activity-1280x720.png` });
    if (onAir) {
      await seekTo(page, onAir.ts + 1);
      await page.screenshot({ path: `${shots}/web-activity-graphic-1280x720.png` });
    }

    // WCAG 1.4.12 text spacing: a clamped summary ends on a whole line, never half a line
    const spacing = await page.addStyleTag({ content: "* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }" });
    await seekTo(page, mid + 1);
    const cut = await page.evaluate(() => [...document.querySelectorAll("#activity .act-out")].map((el) => el.clientHeight / parseFloat(getComputedStyle(el).lineHeight))
      .filter((lines) => Math.abs(lines - Math.round(lines)) > 0.15));
    if (cut.length) fail(`activity with text spacing: summaries cut mid-line (${cut.map((x) => x.toFixed(2)).join(", ")} lines)`);
    if (await overflow(page) > 1) fail(`activity with text spacing: the page overflows by ${await overflow(page)} px`);
    await page.screenshot({ path: `${shots}/web-activity-spacing-1280x720.png` });
    await spacing.evaluate((el) => el.remove());
    await seekTo(page, mid + 1);
  });

  // The page fits the window: the frame, the strip and the controls (the overflow is clipped, so
  // scrollHeight cannot see it). 1600x720 is a window where the height sets the frame size.
  await check("layout fits", async () => {
    if (await overflow(page) > 1) fail(`1280x720: the page overflows by ${await overflow(page)} px`);
    const wide = await open(browser, { viewport: { width: 1600, height: 720 } });
    await wide.waitForFunction(() => window.studioDesk.desk.loaded);
    await wide.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const px = await overflow(wide);
    if (px > 1) fail(`1600x720: the page overflows by ${px.toFixed(1)} px`);
    await wide.context().close();
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
  const shotAt = shot ? shot.ts + 2 : 40;  // a match whose shot stories all wait for review has no shot on air
  await seekTo(page, shotAt);
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
        await edit("traces.json", (ts) => { if (ts.length) ts.at(-1).output_summary = '<img src=x onerror="window.__xss=1">'; return ts; });
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
    await seekTo(hostile, await hostile.evaluate(() => window.studioDesk.end));
    if (await hostile.evaluate(() => window.__xss)) fail("team colour or trace summary markup ran as HTML");
    if (await hostile.evaluate(() => window.studioDesk.desk.traces.length && !document.querySelector("#activity").textContent.includes("<img"))) fail("activity: a summary with markup not shown as text");
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

  await check("ask the studio", async () => {
    if (!(await page.evaluate(() => document.querySelector("#ask-open").hidden))) fail("ask: button shown without a model behind it");
    const sent = [];
    const p = await open(browser, { viewport: { width: 1280, height: 720 } }, { route: askStub(sent) });
    await p.waitForSelector("#ask-open:not([hidden])", { timeout: 5000 });
    await seekTo(p, 125.37);
    await p.click("#ask-open");
    if (!(await p.evaluate(() => document.activeElement?.id === "ask-q"))) fail("ask: focus not on the question box");
    if (!(await askFits(p))) fail("ask: panel out of the viewport or covered");
    await p.keyboard.type("Who is the fastest so far?");
    if (await p.evaluate(() => window.studioDesk.state.playing)) fail("ask: a typed space toggled play");
    await p.keyboard.press("Enter");
    await p.waitForSelector("#ask-log li", { timeout: 5000 });
    const b = sent.at(-1);
    if (b.match_id !== MATCH || b.ts !== 125.3 || b.lang !== "en" || b.question !== "Who is the fastest so far?") fail(`ask: sent ${JSON.stringify(b)}`);
    const seen = () => p.evaluate(() => ({ img: !!document.querySelector("#ask img"), xss: window.__xss,
      you: document.querySelector(".ask-you").textContent, answer: document.querySelector(".ask-a").textContent,
      live: document.querySelector("#ask-live").textContent, facts: document.querySelector(".ask-facts")?.textContent ?? "",
      status: document.querySelector("#ask-status").textContent, title: document.querySelector("#ask-title").textContent }));
    let got = await seen();
    if (got.img || got.xss) fail("ask: the answer ran as markup");
    if (!got.answer.startsWith("<img") || got.live !== got.answer) fail(`ask: answer "${got.answer}", live region "${got.live}"`);
    if (!got.you.endsWith("Who is the fastest so far?")) fail(`ask: question echo "${got.you}"`);
    if (!got.facts.includes("F-SPRINT_SPEED-000001")) fail(`ask: no fact ids in Analyst mode ("${got.facts}")`);
    if (!/9/.test(got.status)) fail(`ask: questions left not shown ("${got.status}")`);
    await p.click('[data-audience="casual"]');
    if ((await seen()).facts) fail("ask: fact ids shown to the casual fan");
    await p.click('[data-audience="analyst"]');
    await p.selectOption("#lang", "it");
    if ((await seen()).title !== "Chiedi allo studio") fail(`ask: Italian title "${(await seen()).title}"`);
    await p.selectOption("#lang", "en");
    for (const [q, msg] of [["limit", /limit is reached/], ["offline", /could not be reached/]]) {
      await p.fill("#ask-q", q);
      await p.press("#ask-q", "Enter");
      await p.waitForFunction((src) => new RegExp(src).test(document.querySelector("#ask-status").textContent), msg.source, { timeout: 5000 })
        .catch(() => fail(`ask ${q}: no plain message`));
    }
    await p.screenshot({ path: `${shots}/web-ask-1280x720.png` });
    await p.press("#ask-q", "Escape");
    if (!(await p.evaluate(() => document.querySelector("#ask").hidden && document.activeElement?.id === "ask-open"))) fail("ask: Escape did not close the panel back to its button");
    await p.context().close();
  });

  for (const [w, h] of [[844, 390], [390, 844]]) {
    await check(`phone ${w}x${h}`, async () => {
      const phone = await open(browser, { viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: true }, { route: askStub() });
      await phone.waitForSelector("#ask-open:not([hidden])", { timeout: 5000 }); // the Ask button counts among the controls
      // the voice button and the desk's offline label are shown by now, and the layout has followed them
      await phone.waitForFunction(() => window.studioDesk?.voice && window.studioDesk.desk.ready);
      await phone.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const tall = await phone.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
      if (tall > 1) fail(`${w}x${h}: the page is ${tall} px taller than the screen`);
      if (await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) fail(`${w}x${h}: horizontal scroll`);
      const over = await overflow(phone);
      if (over > 1) fail(`${w}x${h}: the page overflows by ${over.toFixed(1)} px`);
      const lost = await unreachable(phone);
      if (lost.length) fail(`${w}x${h}: controls out of reach: ${lost.join(", ")}`);
      await seekTo(phone, shotAt);
      const strip = await phone.evaluate(() => {
        const r = document.querySelector("#activity").getBoundingClientRect();
        return { h: r.height, bottom: r.bottom, items: [...document.querySelectorAll("#activity li")].filter((l) => l.offsetHeight).length };
      });
      if (strip.h > 24 || strip.bottom > h || strip.items > 1) fail(`${w}x${h}: agent strip ${JSON.stringify(strip)}, wanted one line on screen`);
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
      // the Player picker, the widest the controls get, still fits
      await phone.click('[data-audience="player"]');
      await phone.waitForTimeout(100);
      const lostPick = await unreachable(phone);
      if (lostPick.length) fail(`${w}x${h} player mode: controls out of reach: ${lostPick.join(", ")}`);
      if (await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) fail(`${w}x${h} player mode: horizontal scroll`);
      await phone.screenshot({ path: `${shots}/web-modes-${w}x${h}.png` });
      await phone.click("#ask-open");
      if (!(await askFits(phone))) fail(`${w}x${h}: Ask panel out of the viewport or covered`);
      await phone.screenshot({ path: `${shots}/web-ask-${w}x${h}.png` });
      await phone.press("#ask-q", "Escape");
      await phone.click('[data-audience="analyst"]');
      await seekTo(phone, shotAt);
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
