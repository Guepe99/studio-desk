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
// the video player keys (K, J, L, arrows, 0 to 9, ?, F, and none of them in a select or on the body);
// the clock frozen at the end of each period, stoppage time as 45+n, the Italian period label; the score
// bug against the score facts, no goal dots on the track; seek keys and aria-valuetext with the score; shirt-number contrast; the 2D pitch (players and ball on
// the tracking, disc colours, the players named on air lit, draw time); the pass bar scale; why-card text
// never cut; reduced motion; a manifest that fails; hostile data; Ask the studio with its API stubbed;
// the settings menu (speed, audience, language, each beside the gear when not the default);
// a link to a moment (?t=, audience, speed, play); phone landscape and portrait (every control reachable by scrolling, with the settings menu open,
// graphic text at least 11 px in portrait, the agent strip on one line); Next key moment for analyst and a team; the agent strip after seeks and
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
// a check the replay gives nothing to test: not a failure, but the summary says so
const skips = [];
const skip = (msg) => { skips.push(msg); console.log(`SKIP ${msg}`); };
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
const stories = storiesRes.ok ? await storiesRes.json() : [];
const autoApproved = new Set(stories.filter((s) => s.default_status === "auto_approved").map((s) => s.story_id));
// Next key moment also stops at a story that waits for the producer (M001: the 8' big chance)
const heldIds = new Set(stories.filter((s) => s.default_status === "needs_review").map((s) => s.story_id));
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
// the minute as a broadcast says it: stoppage time is 45+n and 90+n
function minuteAt(ts) {
  const period = ts <= P1 ? 1 : 2, len = period === 1 ? P1 : meta.period2_s;
  const t = Math.min(period === 1 ? ts : ts - P1, len - 1e-6);
  const m = Math.floor(t / 60) + (period === 2 ? 45 : 0) + 1, base = period * 45;
  return { period: period === 1 ? "1H" : "2H", minute: `${m > base ? `${base}+${m - base}` : m}'` };
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
// a settings item, as a visitor picks it: the gear opens the menu, a click picks, Escape closes the menu
// the generated graphics that wait for the visitor (team shape, check-ins: docs/desk.md), put on air as a
// producer would, so every cue can be checked on screen
const approveWaiting = (page) => page.evaluate(() => {
  const d = window.studioDesk.desk;
  for (const g of d.gens) if (d.status(g) === "needs_review") d.decisions.set(g.story_id, { story_id: g.story_id, decision: "approved" });
  d.changed();
});
const pick = async (page, sel) => {
  if (await page.$eval("#settings-menu", (m) => m.hidden)) await page.click("#settings");
  await page.click(`#settings-menu ${sel}`);
  if (!(await page.$eval("#settings-menu", (m) => m.hidden))) await page.keyboard.press("Escape");
};
const setLang = (page, lang) => pick(page, `[data-lang="${lang}"]`);
const scorebug = (page) => page.evaluate(() => ({
  h: document.querySelector(".sb-h").textContent, a: document.querySelector(".sb-a").textContent,
  minute: document.querySelector(".sb-min").textContent, period: document.querySelector(".sb-period").textContent,
}));
const open = async (browser, opts, { route, ignoreConsole = false, query = "" } = {}) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  // with static hosting the desk's api/ calls 404 and the desk keeps decisions in the tab
  // voice.json, booth.json and season.json are optional too: a match without clips or a season answers 404
  const apiMiss = (m) => /\/api\/|\/(voice|booth|season)\.json$/.test(m.location()?.url ?? "");
  if (!ignoreConsole) page.on("console", (m) => { if (m.type() === "error" && !apiMiss(m)) fail(`${opts.viewport.width}x${opts.viewport.height} console: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`${opts.viewport.width}x${opts.viewport.height} page error: ${e.message}`));
  if (route) await route(page);
  await page.goto(url + query);
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

// Every control in #controls, scrolled into view (the page scrolls), fully inside the viewport and the
// topmost element at its centre. Controls behind the closed settings menu are not counted: open it and
// pass its items, since the open menu covers the row under it.
const unreachable = (page, sel = "#controls button:not(#settings-menu *), #controls select, #seek-range") => page.evaluate(async (sel) => {
  const lost = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.hidden || !el.getClientRects().length) continue;   // the voice button stays hidden on a match without clips
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    await new Promise((r) => requestAnimationFrame(r));
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (r.width < 1 || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight
      || !(hit && (hit === el || el.contains(hit) || hit.contains(el)))) lost.push(el.id || el.dataset.speed || el.dataset.audience || el.getAttribute("aria-label") || el.tagName);
  }
  scrollTo(0, 0);
  return lost;
}, sel);

// How far the boxes of #app reach past the room it has (its height less its padding), in px.
const overflow = (page) => page.evaluate(() => {
  const app = document.querySelector("#app"), cs = getComputedStyle(app);
  const boxes = [...app.children].filter((el) => el.getClientRects().length && getComputedStyle(el).position !== "absolute").map((el) => el.getBoundingClientRect());
  const span = Math.max(...boxes.map((r) => r.bottom)) - Math.min(...boxes.map((r) => r.top));
  return span - (app.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
});

// api/ask stubbed (the static site has no API): GET is the page's probe; "limit", "offline", "broken" (500)
// and "gone" (503) the error paths; "paused" Content Safety out of quota; "slow" answers after a second.
// The answer cites the match's first sprint fact: fact ids differ from match to match.
const SPRINT = () => window.studioDesk.match.facts.find((f) => f.fact_id.startsWith("F-SPRINT_SPEED"));
const askStub = (sent = []) => (p) => p.route("**/api/ask", async (r) => {
  if (r.request().method() === "GET") return r.fulfill({ json: { available: true } });
  const b = JSON.parse(r.request().postData() || "{}");
  if (!b.question) return r.fulfill({ status: 422, json: { detail: [] } });
  sent.push(b);
  if (b.question === "limit") return r.fulfill({ status: 429, json: { status: "limit", reason: "questions per visitor" } });
  if (b.question === "offline") return r.abort();
  if (b.question === "broken") return r.fulfill({ status: 500, json: { detail: "internal error" } });
  if (b.question === "gone") return r.fulfill({ status: 503, json: { detail: "no model on this site" } });
  if (b.question === "paused") return r.fulfill({ json: { status: "paused", answer: "", fact_ids: [], questions_left: 5 } });
  if (b.question === "slow") await new Promise((done) => setTimeout(done, 1000));
  return r.fulfill({ json: { status: "answered", answer: '<img src=x onerror="window.__xss=2">The quickest sprint was 32 km/h.',
    fact_ids: [await p.evaluate(SPRINT).then((f) => f?.fact_id)], questions_left: 9 } });
});
// The Ask panel inside the viewport (the page scrolls to it, give or take a pixel of rounding), its question
// box the topmost element at its centre: "" when it is, else what is wrong.
const askFits = (page) => page.evaluate(async () => {
  for (let k = 0; k < 2; k++) await new Promise((res) => requestAnimationFrame(res)); // ask.js scrolls the panel in on the next frame
  const r = document.querySelector("#ask").getBoundingClientRect(), q = document.querySelector("#ask-q").getBoundingClientRect();
  const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
  const ok = r.left >= 0 && r.top > -2 && r.right <= innerWidth && r.bottom < innerHeight + 2 && hit?.id === "ask-q";
  return ok ? "" : `panel at ${[r.left, r.top, r.right, r.bottom].map(Math.round)} in ${innerWidth}x${innerHeight}, ${hit?.id || hit?.className || "nothing"} on the question box`;
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
  // a momentum or team shape card due during a goal replay goes on air at the replay's end (app.js refreshCues)
  const dueTs = new Map(await page.evaluate(async (cs) => {
    const v = await import("./js/view3d.js"), reps = v.replays(window.studioDesk.match);
    return [...new Set(cs.map((c) => c.audience))].flatMap((a) => v.holdForReplays(cs.filter((c) => c.audience === a), reps).map((c) => [c.cue_id, c.ts]));
  }, cues));
  const due = (c) => dueTs.get(c.cue_id) ?? c.ts;
  // the broadcast has the focus once loaded, so Space and N work at once
  if (await page.evaluate(() => document.activeElement?.id) !== "frame") fail("focus: the broadcast frame does not have the focus after loading");

  await check("cues", async () => {
    await approveWaiting(page);
    const shotFor = {};
    for (const audience of ["analyst", "casual"]) {
      await pick(page, `[data-audience="${audience}"]`);
      for (const c of cues.filter((x) => x.audience === audience)) {
        await seekTo(page, due(c) + Math.min(2, c.duration_s / 2));
        const { live, nodes, ts } = await onScreen(page);
        if (nodes > 2) fail(`${c.cue_id}: ${nodes} graphics in the DOM`);
        const g = live.find((x) => x.cue === c.cue_id);
        if (!g) { fail(`${audience} ${c.cue_id} ${c.graphic}: not on screen`); continue; }
        if (g.step !== 0 || g.opacity < 0.9) fail(`${audience} ${c.cue_id} ${c.graphic}: hidden (step ${g.step}, opacity ${g.opacity}, ${g.texts} texts)`);
        if (g.facts > 0) fail(`${audience} ${c.cue_id}: ${g.facts} fact ids on air (they belong in the desk evidence)`);
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
    await approveWaiting(page);
    const all = await page.evaluate(() => window.studioDesk.match.cues);
    for (const kind of ["team", "player"]) {
      const auds = [...new Set(all.map((c) => c.audience).filter((a) => a.startsWith(`${kind}:`)))].sort();
      if (!auds.length) { fail(`modes: ${MATCH} has no ${kind} cues`); continue; }
      const offered = (await page.$$eval(`#settings-menu [data-audience^="${kind}:"]`, (os) => os.map((o) => o.dataset.audience))).sort();
      if (offered.join() !== auds.join()) fail(`${kind}: the menu offers ${offered.join()}, cues.json has ${auds.join()}`);
      if (kind === "player") { // each entry ends with the minute of the player's first graphic of his own, not a filler (late substitutes)
        const wrong = await page.evaluate(() => [...document.querySelectorAll('#settings-menu [data-audience^="player:"]')].filter((o) => {
          const sd = window.studioDesk, ts = Math.min(...sd.match.cues.filter((c) => c.audience === o.dataset.audience && !c.payload?.filler).map((c) => c.ts));
          return !o.textContent.endsWith(`, ${sd.match.clock(ts).label}'`);
        }).map((o) => o.textContent));
        if (wrong.length) fail(`player picker without the first minute: ${wrong.slice(0, 3).join(" | ")}`);
      }
      let seen = 0;
      for (const aud of auds) {
        await pick(page, `[data-audience="${aud}"]`);
        const [got, on, badge] = await page.evaluate((a) => [window.studioDesk.state.audience,
          document.querySelector(`[data-audience="${a}"]`).getAttribute("aria-checked"), document.querySelector("#settings-state").textContent], aud);
        const short = await page.$eval(`[data-audience="${aud}"]`, (b) => b.dataset.short);
        if (got !== aud || on !== "true") fail(`${aud}: state ${got}, aria-checked ${on}`);
        if (badge !== short) fail(`${aud}: beside the gear "${badge}", want "${short}"`);
        const mine = cues.filter((x) => x.audience === aud), ids = new Set(mine.map((x) => x.cue_id));
        for (const c of mine) {
          await seekTo(page, due(c) + Math.min(2, c.duration_s / 2));
          const { live } = await onScreen(page);
          const g = live.find((x) => x.cue === c.cue_id);
          if (!g) { fail(`${aud} ${c.cue_id} ${c.graphic}: not on screen`); continue; }
          if (g.facts > 0) fail(`${aud} ${c.cue_id}: ${g.facts} fact ids shown`);
          // SEASON-CARD is added by the page for every audience (docs/CONTRACT.md, season), not recorded in cues.json
          for (const x of live) if (!ids.has(x.cue) && x.cue !== "SEASON-CARD") fail(`${aud}: ${x.cue} (${x.graphic}) of another audience on screen`);
          if (!seen++) await page.screenshot({ path: `${shots}/web2d-${kind}.png` });
        }
      }
      if (!seen) fail(`${kind}: no cue on air to check`);
      console.log(`${kind}: ${auds.length} audiences, ${seen} cues checked`);
    }
    // keyboard: the gear, the arrows to a team, Enter picks it
    await page.focus("#settings");
    await page.keyboard.press("Enter");
    const team = await page.$eval('#settings-menu [data-audience^="team:"]', (b) => b.dataset.audience);
    let steps = 0;
    while (steps++ < 40 && (await page.evaluate(() => document.activeElement?.dataset.audience)) !== team) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const after = await page.evaluate((a) => [window.studioDesk.state.audience, document.querySelector(`[data-audience="${a}"]`).getAttribute("aria-checked")], team);
    if (after[0] !== team || after[1] !== "true") fail(`keyboard: team ${team} -> ${after.join(" ")}`);
    // the way back to the general view: Enter on the checked team again clears it, and Both teams is checked
    if (await page.$eval("#settings-menu", (m) => m.hidden)) { await page.focus("#settings"); await page.keyboard.press("Enter"); }
    await page.focus(`#settings-menu [data-audience="${team}"]`);
    await page.keyboard.press("Enter");
    const cleared = await page.evaluate(() => [window.studioDesk.state.audience === window.studioDesk.state.base, document.querySelector('[data-clear="team"]').getAttribute("aria-checked")]);
    if (cleared.join() !== "true,true") fail(`keyboard: Enter on the checked team again -> ${cleared.join(" ")}`);
    await page.keyboard.press("Escape");
    // Both teams and Everyone go back to the audience the pick was made from, and clear the link's ?audience=
    const qs = () => page.evaluate(() => new URLSearchParams(location.search).get("audience"));
    await pick(page, '[data-audience="casual"]');
    await page.evaluate(() => { const p = new URLSearchParams(location.search); p.set("audience", "casual"); history.replaceState(null, "", `${location.pathname}?${p}`); });
    await pick(page, `[data-audience="${team}"]`);
    if (await qs() !== team) fail(`?audience= is ${await qs()} after picking ${team}`);
    await pick(page, '[data-clear="team"]');
    const both = await page.evaluate((a) => [window.studioDesk.state.audience, document.querySelector(`[data-audience="${a}"]`).getAttribute("aria-checked")], team);
    if (both.join() !== "casual,false" || await qs() !== "casual") fail(`Both teams: ${both.join(" ")}, ?audience=${await qs()}`);
    const player = await page.$eval('#settings-menu [data-audience^="player:"]', (b) => b.dataset.audience);
    await pick(page, `[data-audience="${player}"]`);
    await pick(page, '[data-clear="player"]');
    const everyone = await page.evaluate(() => [window.studioDesk.state.audience, document.querySelector('[data-clear="player"]').getAttribute("aria-checked")]);
    if (everyone.join() !== "casual,true") fail(`Everyone: ${everyone.join(" ")}`);
    await pick(page, `[data-audience="${player}"]`);
    await pick(page, `[data-audience="${player}"]`);
    if (await page.evaluate(() => window.studioDesk.state.audience) !== "casual") fail("a click on the checked player again did not clear it");
    await pick(page, '[data-audience="analyst"]');
    if (!(await page.$eval("#settings-state", (el) => el.hidden))) fail("something beside the gear for the analyst audience at 1x");
  });

  await check("real-time path", async () => {
    await page.evaluate(() => document.querySelector('[data-audience="analyst"]').click());
    const first = cues.find((c) => c.audience === "analyst" && c.ts >= 1); // played into, so not the line-ups at 0'
    await page.evaluate((ts) => { window.studioDesk.seek(ts); window.studioDesk.state.speed = 1; window.studioDesk.setPlaying(true); }, first.ts - 1);
    await page.waitForTimeout(2600);
    const rt = (await onScreen(page)).live.find((x) => x.cue === first.cue_id);
    if (!rt || rt.mode !== "realtime" || rt.step !== 0 || rt.opacity < 0.9) fail(`real-time path: ${JSON.stringify(rt)}`);
    // the same sheet again (the desk reached or approved another story) leaves the graphic on air as it was
    const kept = await page.evaluate((id) => {
      const h = window.studioDesk.host, el = h.live.get(id)?.el;
      h.setCues(h.cues.slice(), window.studioDesk.state.ts);
      return !!el && h.live.get(id)?.el === el && h.live.get(id).mode === "realtime";
    }, first.cue_id);
    if (!kept) fail("real-time path: an unchanged cue sheet rebuilt the graphic on air");
    await page.evaluate(() => window.studioDesk.setPlaying(false));
  });

  await check("space", async () => {
    if (await page.$eval("#frame", (el) => el.tabIndex) !== 0) fail("space: the frame is not focusable");
    await page.evaluate(() => {
      window.__toggles = 0;
      new MutationObserver(() => window.__toggles++).observe(document.querySelector("#play"), { attributeFilter: ["class"] });
    });
    // a single-key shortcut only inside the broadcast and its controls (WCAG 2.1.4): not on the page body
    // on the gear Space opens the settings menu, in the menu it picks the item (a menu button)
    for (const [sel, want] of [["#play", 1], ["#settings", 0], ["#frame", 1], ["body", 0], ['[data-speed="1"]', 0]]) {
      const before = await page.evaluate(() => [window.__toggles, window.studioDesk.state.speed]);
      if (sel === "body") await page.evaluate(() => document.activeElement.blur());
      else if (sel.startsWith("[")) { await page.click("#settings"); await page.focus(`#settings-menu ${sel}`); }
      else await page.focus(sel);
      await page.keyboard.press("Space");
      await page.waitForTimeout(150);
      const after = await page.evaluate(() => [window.__toggles, window.studioDesk.state.speed]);
      if (after[0] - before[0] !== want) fail(`space on ${sel}: play toggled ${after[0] - before[0]} times, wanted ${want}`);
      if (after[1] !== before[1]) fail(`space on ${sel}: speed changed to ${after[1]}`);
      if (sel === "#settings" && await page.evaluate(() => document.querySelector("#settings-menu").hidden || document.activeElement?.dataset.speed !== "1")) fail("space on the gear: the menu did not open on its first item");
      if (sel !== "#play" && sel !== "#frame" && sel !== "body") await page.keyboard.press("Escape");
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
      if ((await page.textContent("#time")) !== want.minute) fail(`clock at ${ts}: the seek row says ${await page.textContent("#time")}, want ${want.minute}`);
    }
    // in Italian the period is 1°T, never "1T" (read as the language code)
    await setLang(page, "it");
    await seekTo(page, 1);
    const it = await scorebug(page);
    await setLang(page, "en");
    if (it.period !== "1°T") fail(`Italian period label "${it.period}", want 1°T`);
  });

  await check("score", async () => {
    const goals = facts.filter((f) => f.kind === "score");
    for (const ts of [0, ...goals.map((f) => f.ts + 1), DUR]) {
      await seekTo(page, ts);
      const got = await scorebug(page), [h, a] = scoreAt(facts, ts);
      if (got.h !== String(h) || got.a !== String(a)) fail(`score at ${ts}: ${got.h}-${got.a}, facts say ${h}-${a}`);
    }
    // the goals are buttons above the bar: a dot on the track would sit under the thumb
    const marks = await page.evaluate(() => document.querySelectorAll("#seek-marks .goal").length);
    if (marks) fail(`seek bar: ${marks} goal dots on the track`);
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
    const want = minuteAt(t2), [h, a] = scoreAt(facts, t2), [home, away] = ["home", "away"].map((sd) => meta.teams.find((x) => x.side === sd).name);
    if (!text || !text.includes(want.minute.replaceAll("'", ""))) fail(`aria-valuetext "${text}" does not say minute ${want.minute}`);
    if (!text?.endsWith(`${home} ${h}, ${away} ${a}`)) fail(`aria-valuetext "${text}" does not say the score ${home} ${h}, ${away} ${a}`);
  });

  // K, J, L, arrows, 0 to 9, ? and F, scoped as Space: in the broadcast and its controls, not in a select or on the body
  await check("shortcuts", async () => {
    const end = await page.evaluate(() => window.studioDesk.end);
    const st = () => page.evaluate(() => ({ ts: window.studioDesk.state.ts, playing: window.studioDesk.state.playing }));
    await seekTo(page, 600 % DUR);
    await page.focus("#frame");
    for (const [k, d] of [["l", 10], ["j", -10], ["ArrowRight", 5], ["ArrowLeft", -5]]) {
      const t0 = (await st()).ts;
      await page.keyboard.press(k);
      const t1 = (await st()).ts;
      if (Math.abs(t1 - t0 - d) > 0.05) fail(`key ${k}: moved ${(t1 - t0).toFixed(2)} s, want ${d}`);
    }
    await page.keyboard.press("5");
    if (Math.abs((await st()).ts - end / 2) > 0.05) fail(`key 5: at ${(await st()).ts.toFixed(1)}, want ${(end / 2).toFixed(1)}`);
    await page.keyboard.press("0");
    if ((await st()).ts !== 0) fail(`key 0: at ${(await st()).ts}`);
    // at 0:00 K starts the kick-off count (the clock waits for it), a second K stops it
    const going = () => page.evaluate(() => window.studioDesk.state.playing || window.studioDesk.countdown.counting);
    await page.keyboard.press("k");
    const on = await going();
    await page.keyboard.press("k");
    if (!on || (await going())) fail(`key K: playing or counting ${on}, then ${await going()}`);
    // in the seek bar the arrows stay the bar's own (5 s), L still works
    await seekTo(page, 600 % DUR);
    await page.focus("#seek-range");
    const r0 = (await st()).ts;
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("l");
    if (Math.abs((await st()).ts - r0 - 15) > 0.05) fail(`seek bar: ArrowRight then L moved ${((await st()).ts - r0).toFixed(2)} s, want 15`);
    // never in the settings menu, never on the page body
    for (const where of ["menu", "body"]) {
      await seekTo(page, 600 % DUR);
      if (where === "body") await page.evaluate(() => document.activeElement.blur());
      else { await page.click("#settings"); await page.focus('#settings-menu [data-lang="en"]'); }
      for (const k of ["l", "5", "k"]) await page.keyboard.press(k);
      const s1 = await st();
      if (Math.abs(s1.ts - 600 % DUR) > 0.01 || s1.playing) fail(`keys on ${where}: moved to ${s1.ts.toFixed(1)}, playing ${s1.playing}`);
      if (where === "menu") await page.keyboard.press("Escape");
    }
    // ?: the list in a modal dialog, in the page's language; Escape closes it and gives the focus back
    await page.focus("#frame");
    await page.keyboard.press("Shift+Slash");
    const dlg = await page.evaluate(() => { const d = document.querySelector("#keys"); return { open: d.open, modal: d.matches(":modal"), rows: d.querySelectorAll("dd").length, focus: document.activeElement?.closest("#keys") !== null }; });
    if (!dlg.open || !dlg.modal || dlg.rows < 8) fail(`key ?: dialog ${JSON.stringify(dlg)}`);
    await page.screenshot({ path: `${shots}/web-keys-1280x720.png` });
    await page.keyboard.press("Escape");
    const back = await page.evaluate(() => ({ open: document.querySelector("#keys").open, focus: document.activeElement?.id }));
    if (back.open || back.focus !== "frame") fail(`key ?: after Escape open ${back.open}, focus on ${back.focus}`);
    // F: the broadcast column full screen, F again leaves it
    await page.keyboard.press("f");
    await page.waitForTimeout(300);
    const full = await page.evaluate(() => document.fullscreenElement?.id ?? null);
    if (full !== "app") fail(`key F: full screen element ${full}, want app`);
    await page.keyboard.press("f");
    await page.waitForTimeout(300);
    if (await page.evaluate(() => document.fullscreenElement)) fail("key F: still full screen after the second press");
    await seekTo(page, 0);
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

  // The 2D pitch: every player and the ball where the tracking puts them (within 0.5 px of the
  // mapping written again above), each isolated disc in its kit or keeper colour, and the players
  // named by the graphics on air (payload.player_id, or the players of the facts they cite) lit.
  await check("pitch", async () => {
    await pick(page, '[data-audience="analyst"]');
    const factPlayer = new Map(facts.filter((f) => f.player_id).map((f) => [f.fact_id, f.player_id]));
    const moments = ["nameplate", "pass_shot", "why_card"].flatMap((g) => cues.filter((c) => c.audience === "analyst" && c.graphic === g).slice(0, 3))
      .map((c) => c.ts + Math.min(2, c.duration_s / 2));
    let lit = 0, coloured = 0, isolated = 0;
    for (const ts0 of [...moments, 30]) {
      await seekTo(page, ts0);
      const r = await page.evaluate(async () => {
        const sd = window.studioDesk, c = document.querySelector("#pitch"), k = c.width / 1920, g = c.getContext("2d");
        const { keeperColours } = await import(new URL("js/pitch.js", document.baseURI));
        const keeper = keeperColours(sd.match.meta.teams);
        const players = sd.pitch.drawn.players.map(({ id, x, y, r, focus }) => {
          const pl = sd.match.players[id], px = g.getImageData(Math.round(x * k), Math.round((y - 0.55 * r) * k), 1, 1).data;
          return { id, x, y, r, focus, px: [...px.slice(0, 3)],
            want: pl.position === "GK" ? keeper[pl.team_id] : sd.match.teams[pl.team_id].color_primary };
        });
        return { ts: sd.state.ts, players, ball: sd.pitch.drawn.ball, live: [...sd.host.live.values()].map((i) => i.cue) };
      });
      const want = meta.entities.slice(1).filter((e) => { const p = stageAt(e, r.ts); return !Number.isNaN(p[0]) && meta.players.some((x) => x.player_id === e); });
      const got = r.players.map((p) => p.id);
      if (want.sort().join() !== [...got].sort().join()) fail(`pitch at ${r.ts}: drew ${got.length} players, tracking has ${want.length}`);
      for (const p of r.players) {
        const [x, y] = stageAt(p.id, r.ts), off = Math.hypot(p.x - x, p.y - y);
        if (!(off <= 0.5)) fail(`pitch at ${r.ts.toFixed(1)}: ${p.id} drawn ${off.toFixed(2)} px off the tracking`);
        // colour under the disc, for a player nobody else (or a lit halo, or the ball) can cover
        const near = r.players.some((o) => o !== p && Math.hypot(o.x - p.x, o.y - p.y) < 3 * p.r + (o.focus ? 2.6 * o.r : 0))
          || p.focus || (r.ball && Math.hypot(r.ball[0] - p.x, r.ball[1] - p.y) < 30 * PX);
        if (near) continue;
        isolated++;
        const hex = p.want.slice(1).match(/../g).map((h) => parseInt(h, 16));
        if (hex.every((v, i) => Math.abs(v - p.px[i]) <= 10)) coloured++;
        else fail(`pitch at ${r.ts.toFixed(1)}: ${p.id} shows rgb(${p.px}) where its disc should be ${p.want}`);
      }
      const [bx, by] = stageAt("ball", r.ts);
      if (!Number.isNaN(bx) && !(r.ball && Math.hypot(r.ball[0] - bx, r.ball[1] - by) <= 0.5)) fail(`pitch at ${r.ts.toFixed(1)}: ball drawn at ${r.ball}, tracking ${bx.toFixed(1)},${by.toFixed(1)}`);
      const named = new Set();
      for (const c of r.live) for (const id of [c.payload.player_id, ...[c.payload.fact_id, ...(c.payload.fact_ids ?? [])].map((f) => factPlayer.get(f))]) if (id) named.add(id);
      const on = r.players.filter((p) => p.focus).map((p) => p.id).sort();
      const drawnNamed = [...named].filter((id) => got.includes(id)).sort();
      if (on.join() !== drawnNamed.join()) fail(`pitch at ${r.ts.toFixed(1)}: lit ${on.join() || "nobody"}, the graphics on air name ${drawnNamed.join() || "nobody"}`);
      lit += on.length;
    }
    if (!lit) fail("pitch: no moment had a lit player, the highlight was never checked");
    if (isolated < 10) fail(`pitch: only ${isolated} isolated discs, the colour check measures nothing`);
    console.log(`pitch: ${moments.length + 1} moments, ${lit} lit players, ${coloured}/${isolated} isolated discs in their colour`);
    // draw time at 64x over 300 frames (the page draws at every frame)
    const ms = await page.evaluate(() => {
      const sd = window.studioDesk, t = [], live = [...sd.host.live.values()].map((i) => i.cue);
      for (let f = 0; f < 300; f++) {
        const t0 = performance.now();
        sd.pitch.draw(sd.match, 600 + f * 64 / 60, live);
        t.push(performance.now() - t0);
      }
      return t.sort((a, b) => a - b)[150];
    });
    console.log(`pitch: median draw ${ms.toFixed(2)} ms at 1280x720`);
    // measured 0.1 to 0.2 ms in software Chromium: the median of 300 draws needs a 40x slowdown to reach 8 ms
    if (ms > 8) fail(`pitch: median draw ${ms.toFixed(2)} ms, over half a 60 Hz frame`);
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
    // the full in animation lasts 1120 ms (the bar: 520 ms delay, 600 ms run); 500 ms leaves a loaded machine room
    if (ms > 500) fail(`reduced motion: the in animation still ran for ${ms.toFixed(0)} ms`);
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
      const story = all.filter((c) => c.lang === "en" && c.audience === aud && (autoApproved.has(c.story_id) || heldIds.has(c.story_id))).sort((a, b) => a.ts - b.ts);
      return story.filter((c, i) => !story.slice(0, i).some((p) => c.ts <= p.ts + p.duration_s + 1));
    };
    // web/js/moments.js: 6 s before the play the story is about (its last evidence event up to 10 s before the cue)
    const { evidence, evTs } = await page.evaluate(() => ({
      evidence: Object.fromEntries([...window.studioDesk.desk.byId.values()].map((s) => [s.story_id, s.evidence_event_ids ?? []])),
      evTs: Object.fromEntries(window.studioDesk.match.events.map((e) => [e.event_id, e.ts])) }));
    const target = (c) => {
      const t = (evidence[c.story_id] ?? []).map((i) => evTs[i]).filter((x) => x !== undefined && x <= c.ts && x >= c.ts - 10);
      return Math.max(0, (t.length ? Math.max(...t) : c.ts) - 6);
    };
    // M001's comeback, found by kind: its id moves when a regeneration tells one more story before it
    const comeback = MATCH === "M001" && (await page.evaluate(() => fetch("data/M001/stories.json").then((r) => r.json())))
      .find((s) => s.kind === "comeback")?.story_id;
    if (MATCH === "M001" && !comeback) fail("next: no comeback in M001's stories");
    for (const aud of ["analyst", team]) {
      await pick(page, `[data-audience="${aud}"]`);
      const stops = stopsFor(aud);
      if (!stops.length && aud === "analyst") fail("next analyst: no story cue on air");
      if (MATCH === "M001" && aud === "analyst" && stops.some((c) => c.story_id === comeback)) fail("next: the comeback that shares the goal's event is a stop of its own");
      await seekTo(page, 0);
      for (const [i, c] of stops.entries()) {
        const b = await nextBtn();
        if (b.off || b.disabled) { fail(`next ${aud}: disabled before ${c.cue_id}`); break; }
        // the last press is a keyboard press on the button: the focus must stay on it
        if (i === stops.length - 1) { await page.focus("#next-moment"); await page.keyboard.press("Enter"); }
        else if (i % 2) { await page.focus("#frame"); await page.keyboard.press("n"); }
        else await page.click("#next-moment");
        await nextFrame(page);
        // it plays from the moment at 1x: paused at once, the clock is a frame or two past it, and the clock keeps
        // real time, so with software WebGL (frames up to about 1 s apart) that can be 2 s
        const [ts, playing] = await page.evaluate(() => { const s = window.studioDesk.state, p = s.playing; window.studioDesk.setPlaying(false); return [s.ts, p]; });
        const want = target(c);
        if (ts < want - 0.01 || ts > want + 2 || !playing) { fail(`next ${aud}: landed at ${ts.toFixed(2)} s (playing ${playing}), wanted ${want.toFixed(2)} s for ${c.cue_id}`); break; }
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
    await pick(page, '[data-audience="analyst"]');
    await seekTo(page, await page.evaluate(() => window.studioDesk.end));
    for (const [lang, label] of [["it", "Nessun altro momento chiave"], ["es", "No hay más momentos clave"]]) {
      await setLang(page, lang);
      await nextFrame(page);
      const b = await nextBtn();
      if (b.label !== label || b.lang !== lang) fail(`next: label ${JSON.stringify(b.label)} lang ${b.lang}, wanted ${label} in ${lang}`);
    }
    await pick(page, '[data-audience="analyst"]');
    await seekTo(page, 0);
    for (const [lang, label] of [["it", "Prossimo momento chiave"], ["es", "Siguiente momento clave"], ["en", "Next key moment"]]) {
      await setLang(page, lang);
      await nextFrame(page);
      const b = await nextBtn();
      if (b.label !== label || b.lang !== lang || b.off) fail(`next at 0: ${JSON.stringify(b)}, wanted ${label} in ${lang}`);
    }
    // N is ignored in the desk, with Shift and on the page body; at 64x a jump comes back to 1x
    await seekTo(page, 0);
    const first = stopsFor("analyst").map(target)[0];
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
    await pick(page, '[data-speed="64"]');
    await page.focus("#frame");
    await page.keyboard.press("n");
    await nextFrame(page);
    const sp = await page.evaluate(() => ({ speed: window.studioDesk.state.speed, pressed: document.querySelector('[data-speed="1"]').getAttribute("aria-checked") }));
    if (sp.speed !== 1 || sp.pressed !== "true") fail(`next: after a jump at 64x the speed is ${JSON.stringify(sp)}, wanted 1x`);
    // the jump plays from the moment: paused at once, the clock is a frame or two past it (2 s on software WebGL)
    const landed = await page.evaluate(() => { window.studioDesk.setPlaying(false); return window.studioDesk.state.ts; });
    if (first !== undefined && (landed < first - 0.01 || landed > first + 2)) fail("next: N with the focus on the frame did not jump");
    await pick(page, '[data-speed="1"]');

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
      await setLang(page, lang);
      for (const [ts, start] of [[quiet, sum], [onAir?.ts + 1, made]]) {
        if (!Number.isFinite(ts)) { skip(`activity in ${lang}: no ${start === sum ? "quiet time" : "story graphic with a chain"} to check the strip at`); continue; }
        await seekTo(page, ts);
        const got = await strip();
        if (got.title !== title || got.lang !== lang || !got.sum.startsWith(start)) fail(`activity in ${lang} at ${ts} s: ${JSON.stringify(got)}`);
        // one plain sentence per agent in the page language: no story or fact ids, no step names, nothing cut
        const said = await page.$$eval("#activity .act-out", (n) => n.map((el) => ({ text: el.textContent, lang: el.closest("[lang]")?.lang,
          cut: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1, title: el.closest("li").title })));
        if (!said.length) fail(`activity in ${lang} at ${ts} s: no agent sentence on the strip to check`);
        const english = /\b(Picked|Explained|Wrote|Rewrote|Asked|Checked|Put it|Used|Passed|story|stories|line|lines|cues?|rewritten|analysis|pass|fail|fallback)\b/;
        for (const x of said) {
          if (/\b[SF]-[A-Z_]*\d{6}\b|[a-z]_[a-z]/.test(x.text + x.title) || x.cut || x.lang !== lang || (lang !== "en" && english.test(x.text)))
            fail(`activity in ${lang} at ${ts} s: strip says ${JSON.stringify(x)}`);
        }
      }
    }
    // a fallback step on the strip at its own time carries the mark
    const fallbacks = rows.filter((r) => r.step === "fallback" || /(^| )fallback: /.test(r.output_summary));
    const failed = fallbacks.find((r) => want(r.ts).split(",").includes(String(r.seq)));
    if (!failed) skip(`activity: ${fallbacks.length ? "no fallback step is on the strip at its own time" : "no fallback step in the traces"}, the mark is not checked`);
    else {
      await seekTo(page, failed.ts);
      const mark = await page.evaluate((seq) => document.querySelector(`#activity li[data-seq="${seq}"]`)?.className, failed.seq);
      if (!/fallback/.test(mark ?? "")) fail(`activity: fallback step ${failed.seq} ${mark === undefined ? "not on the strip" : "not marked"}`);
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
        await pick(page, `[data-audience="${audience}"]`);
        // start a little before the audience's first cue, so the window always holds graphics
        const from = Math.max(0, Math.min(...cues.filter((c) => c.audience === audience).map((c) => c.ts)) - 10);
        const r = await playAt(page, speed, from, span);
        if (r.most > 2) fail(`${speed}x ${audience}: ${r.most} graphics in the DOM at once`);
        if (r.late) fail(`${speed}x ${audience}: a graphic of a cue ending at ${r.late.end.toFixed(1)} s still there at ${r.late.ts.toFixed(1)} s`);
        if (!r.seen) fail(`${speed}x ${audience}: no graphic shown`);
      }
    });
  }

  await pick(page, '[data-audience="analyst"]');
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
    // the strip says what each agent did in page strings: a summary's markup never reaches it, as text or as HTML
    if (await hostile.evaluate(() => { const a = document.querySelector("#activity"); return a.querySelector("img") || a.textContent.includes("<img"); })) fail("activity: a trace summary's markup reached the strip");
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

  // a link to a moment opens the replay there, for that audience, at that speed, playing; values the
  // menu does not offer are ignored
  await check("deep link", async () => {
    const aud = await page.evaluate(() => window.studioDesk.match.cues.find((c) => c.audience.startsWith("team:")).audience);
    const at = await open(browser, { viewport: { width: 1280, height: 720 } }, { query: `&t=200&audience=${aud}&speed=4&play=1` });
    const s = await at.evaluate(() => { const x = window.studioDesk.state; return { ts: x.ts, audience: x.audience, speed: x.speed, playing: x.playing }; });
    if (s.ts < 200 || s.ts > 240 || s.audience !== aud || s.speed !== 4 || !s.playing) fail(`deep link: ${JSON.stringify(s)}`);
    await at.context().close();
    const bad = await open(browser, { viewport: { width: 1280, height: 720 } }, { query: "&t=x&audience=nobody&speed=3" });
    const b = await bad.evaluate(() => { const x = window.studioDesk.state; return { ts: x.ts, audience: x.audience, speed: x.speed, playing: x.playing }; });
    if (b.ts !== 0 || b.audience !== "analyst" || b.speed !== 1 || b.playing) fail(`deep link with bad values: ${JSON.stringify(b)}`);
    await bad.context().close();
  });

  await check("ask the studio", async () => {
    if (!(await page.evaluate(() => document.querySelector("#ask-open").hidden))) fail("ask: button shown without a model behind it");
    const sent = [];
    const p = await open(browser, { viewport: { width: 1280, height: 720 } }, { route: askStub(sent) });
    await p.waitForSelector("#ask-open:not([hidden])", { timeout: 5000 });
    await seekTo(p, 125.37);
    await p.click("#ask-open");
    if (!(await p.evaluate(() => document.activeElement?.id === "ask-q"))) fail("ask: focus not on the question box");
    { const why = await askFits(p); if (why) fail(`ask: ${why}`); }
    await p.keyboard.type("Who is the fastest so far?");
    if (await p.evaluate(() => window.studioDesk.state.playing)) fail("ask: a typed space toggled play");
    await p.keyboard.press("Enter");
    await p.waitForSelector("#ask-log li", { timeout: 5000 });
    await p.waitForFunction(() => document.querySelector("#ask-live").textContent, null, { timeout: 2000 }).catch(() => {});
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
    // in Analyst mode the cited facts by their label, never as raw ids
    const cited = await p.evaluate(SPRINT).then((f) => f?.label_en);
    if (!cited || !got.facts.includes(cited) || /F-[A-Z_]+-\d+/.test(got.facts)) fail(`ask: Analyst facts "${got.facts}", wanted the label "${cited}"`);
    if (!/9/.test(got.status)) fail(`ask: questions left not shown ("${got.status}")`);
    await pick(p, '[data-audience="casual"]');
    if ((await seen()).facts) fail("ask: fact ids shown to the casual fan");
    await pick(p, '[data-audience="analyst"]');
    await setLang(p, "it");
    if ((await seen()).title !== "Chiedi allo studio") fail(`ask: Italian title "${(await seen()).title}"`);
    const langs = () => p.evaluate(() => ["#ask", "#ask-open", "#ask-live"].map((s) => document.querySelector(s).lang).join(" "));
    if (await langs() !== "it it en") fail(`ask: lang attributes in Italian "${await langs()}"`);
    await p.fill("#ask-q", "Chi è il più veloce?");
    await p.press("#ask-q", "Enter");
    await p.waitForFunction(() => document.querySelector("#ask-live").lang === "it" && document.querySelector("#ask-live").textContent, null, { timeout: 5000 })
      .catch(() => fail("ask: the Italian answer is not announced in Italian"));
    await setLang(p, "es");
    if (await langs() !== "es es it") fail(`ask: lang attributes in Spanish "${await langs()}"`);
    await setLang(p, "en");
    // Send pressed with the mouse: focus stays on it while the studio works, and a second press sends nothing
    await p.fill("#ask-q", "slow");
    const before = sent.length;
    await p.click('#ask [type="submit"]');
    await p.waitForFunction(() => /checking/.test(document.querySelector("#ask-status").textContent), null, { timeout: 2000 }).catch(() => {});
    const busy = await p.evaluate(() => ({ focus: document.activeElement?.type, aria: document.querySelector('#ask [type="submit"]').getAttribute("aria-disabled") }));
    if (busy.focus !== "submit" || busy.aria !== "true") fail(`ask: while busy focus on "${busy.focus}", aria-disabled "${busy.aria}"`);
    await p.click('#ask [type="submit"]');
    await p.waitForFunction(() => document.querySelector("#ask-log li:nth-child(3)"), null, { timeout: 5000 }).catch(() => fail("ask: the slow answer never came"));
    if (sent.length !== before + 1) fail(`ask: ${sent.length - before} questions sent by a double press`);
    for (const [q, msg] of [["limit", /limit has been reached/], ["offline", /could not be reached/], ["broken", /had a problem/]]) {
      await p.fill("#ask-q", q);
      await p.press("#ask-q", "Enter");
      await p.waitForFunction((src) => new RegExp(src).test(document.querySelector("#ask-status").textContent), msg.source, { timeout: 5000 })
        .catch(() => fail(`ask ${q}: no plain message`));
    }
    // Content Safety out of quota: the questions are paused, not declined, and the page says so
    await p.fill("#ask-q", "paused");
    await p.press("#ask-q", "Enter");
    await p.waitForFunction(() => /paused/.test(document.querySelector(".ask-a").textContent)
      && /paused/.test(document.querySelector("#ask-live").textContent), null, { timeout: 5000 })
      .catch(() => fail("ask paused: no paused message in the log and the live region"));
    await p.screenshot({ path: `${shots}/web-ask-1280x720.png` });
    // the panel closed while a question is pending: the answer is still announced
    await p.fill("#ask-q", "slow");
    await p.press("#ask-q", "Enter");
    await p.press("#ask-q", "Escape");
    await p.waitForFunction(() => /32 km\/h/.test(document.querySelector("#ask-live").textContent), null, { timeout: 5000 })
      .catch(() => fail("ask: an answer that came after the panel was closed was not announced"));
    if (await p.evaluate(() => !!document.querySelector("#ask-live").closest("#ask"))) fail("ask: the live region is inside the panel");
    await p.click("#ask-open");
    await p.press("#ask-q", "Escape");
    if (!(await p.evaluate(() => document.querySelector("#ask").hidden && document.activeElement?.id === "ask-open"))) fail("ask: Escape did not close the panel back to its button");
    // the model goes away while the panel is open: no box, no button, and the focus on the settings
    await p.click("#ask-open");
    await p.fill("#ask-q", "gone");
    await p.press("#ask-q", "Enter");
    await p.waitForFunction(() => document.querySelector("#ask-open").hidden, null, { timeout: 5000 }).catch(() => {});
    const off = await p.evaluate(() => ({ panel: document.querySelector("#ask").hidden, button: document.querySelector("#ask-open").hidden,
      focus: document.activeElement?.id || document.activeElement?.tagName }));
    if (!off.panel || !off.button || off.focus !== "settings") fail(`ask 503: panel hidden ${off.panel}, button hidden ${off.button}, focus on ${off.focus}`);
    await p.waitForFunction(() => /not available/.test(document.querySelector("#ask-live").textContent), null, { timeout: 2000 })
      .catch(() => fail("ask 503: the box went without a message"));
    await p.context().close();
  });

  for (const [w, h] of [[844, 390], [390, 844]]) {
    await check(`phone ${w}x${h}`, async () => {
      const phone = await open(browser, { viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: true }, { route: askStub() });
      await phone.waitForSelector("#ask-open:not([hidden])", { timeout: 5000 }); // the Ask button counts among the controls
      // the voice button and the desk's offline label are shown by now, and the layout has followed them
      await phone.waitForFunction(() => window.studioDesk?.voice && window.studioDesk.desk.ready);
      await phone.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      // the page may be taller than the screen (it scrolls), never wider; speed, audience and language sit in the settings
      if (await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) fail(`${w}x${h}: horizontal scroll`);
      const lost = await unreachable(phone);
      await phone.click("#settings");
      lost.push(...await unreachable(phone, "#settings-menu button"));
      if (lost.length) fail(`${w}x${h}: controls out of reach: ${lost.join(", ")}`);
      await phone.click("#settings");
      await seekTo(phone, shotAt);
      const strip = await phone.evaluate(() => {
        const r = document.querySelector("#activity").getBoundingClientRect();
        return { h: r.height, bottom: r.bottom, items: [...document.querySelectorAll("#activity li")].filter((l) => l.offsetHeight).length };
      });
      if (strip.h > 24 || strip.bottom > h || strip.items > 1) fail(`${w}x${h}: agent strip ${JSON.stringify(strip)}, wanted one line on screen`);
      if (h > w) {
        for (const graphic of ["lineup", "pass_shot", "why_card", "momentum", "team_stats", "nameplate"]) {
          const c = cues.find((x) => x.audience === "analyst" && x.graphic === graphic);
          if (!c) continue;
          await seekTo(phone, c.ts + Math.min(2, c.duration_s / 2));
          const t = await smallestText(phone);
          if (t.min < 11) fail(`${w}x${h} ${graphic}: text at ${t.min.toFixed(1)} px (${t.what})`);
          if (await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) fail(`${w}x${h} ${graphic}: horizontal scroll`);
        }
      }
      // a player and 64x, the longest the note beside the gear gets, still fit
      await pick(phone, '[data-audience^="player:"]');
      await pick(phone, '[data-speed="64"]');
      await phone.waitForTimeout(100);
      const lostPick = await unreachable(phone);
      if (lostPick.length) fail(`${w}x${h} player mode: controls out of reach: ${lostPick.join(", ")}`);
      if (await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) fail(`${w}x${h} player mode: horizontal scroll`);
      await phone.screenshot({ path: `${shots}/web-modes-${w}x${h}.png` });
      await phone.click("#ask-open");
      { const why = await askFits(phone); if (why) fail(`${w}x${h}: Ask ${why}`); }
      await phone.screenshot({ path: `${shots}/web-ask-${w}x${h}.png` });
      await phone.press("#ask-q", "Escape");
      await pick(phone, '[data-audience="analyst"]');
      await pick(phone, '[data-speed="1"]');
      await seekTo(phone, shotAt);
      await phone.screenshot({ path: `${shots}/web-fixes-${w}x${h}.png` });
      await phone.context().close();
    });
  }
} finally {
  await browser.close();
}

if (skips.length) console.log(`${skips.length} check(s) skipped:\n${skips.map((m) => `  ${m}`).join("\n")}`);
if (failures.length) {
  console.log(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log("smoke ok");
