// Layout and controls of the broadcast page at the sizes of the style review, on M001 by default
// (its goals have scorers and it has voice clips; MATCH=DEMO works too, without the voice checks).
//
//   MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh layout.mjs
//
// At 1280x720, 1920x1080, 844x390, 390x844, 320x568 and 320x180: the seek bar on its own row as wide
// as the controls with the clock at its end, the buttons on the rows below; no sideways scroll, a page
// that can scroll, every control reachable; the buttons on one row under the seek bar, with speed,
// audience, language and the minimap in a settings menu button (a gear) that opens on screen, moves
// with the arrows, closes on Escape with the focus back on the gear, and says 4x and the audience
// beside the gear when they are not the default; no 2D/3D switch; the half-time mark on the seek bar; graphic text
// at least 11 px for every graphic; the score bug's text at least 11 px and inside the picture; goal
// buttons only once the replay has reached the goal, named "Goal, <player> (<code>), <minute>'" on hover
// too, showing the team code and the minute, 24 px, landing 3 s before the goal, one Tab stop after the
// seek bar and before Play with arrows between them; the open Ask panel off the picture; the Radar only
// with room for it. Then: Next key moment with AI graphics off, goal to goal; disabled pills with a
// solid edge; the empty agent strip one row high; the voice button saying Voice in each language; the
// momentum card on the half away from the ball; the 3D canvas never focused and its loading line a
// status, not an alert. The page header (name, what the page does, the match from meta.json) in one
// band, starting at the picture's left edge; the first screen holding the picture, the scorebug, play, the seek bar and every graphic on
// air at the busiest moment, the frame not moving from 0' to then, nor when Ask opens (also at
// 1280x650, 1366x640, and in Italian); the momentum axis from kick-off to now; no momentum card in a
// goal replay; on M001, no player name cut in any graphic of M001 to M004 at 1280x720, 1920x1080 and 390x844.
// Screenshots: out/shots/layout-*.png.
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
const SIZES = [[1280, 720], [1920, 1080], [844, 390], [390, 844], [320, 568], [320, 180]];
const LEAD_S = 6; // web/js/moments.js: before the goal's shot

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const check = async (name, fn) => {
  // the call log's last lines say what a timed-out click was waiting for
  try { await fn(); } catch (e) { const l = e.message.split("\n"); fail(`${name}: ${[l[0], ...l.slice(-3)].join(" | ")}`); }
};

const open = async (browser, [width, height], phone, query = `?match=${MATCH}`) => {
  const ctx = await browser.newContext({ viewport: { width, height }, ...(phone ? { deviceScaleFactor: 2, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  // as in smoke.mjs: no API on the static site, and a match without clips has no voice.json
  const optional = (m) => /\/api\/|\/(voice|booth|season)\.json$/.test(m.location()?.url ?? "");
  page.on("console", (m) => { if (m.type() === "error" && !optional(m)) fail(`${width}x${height} console: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`${width}x${height} page error: ${e.message}`));
  // the static site has no API: the probe (GET api/ask) answered available shows the Ask button
  await page.route("**/api/ask", (r) => r.fulfill({ json: { available: true } }));
  await page.goto(new URL(query, base).href);
  await page.waitForFunction(() => window.studioDesk?.match && window.studioDesk.desk.ready, null, { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);   // the voice and Ask buttons have appeared and the layout followed
  return page;
};
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const seekTo = async (page, ts) => {
  await page.evaluate((x) => { window.studioDesk.setPlaying(false); window.studioDesk.seek(x); }, ts);
  await page.waitForTimeout(250);
  await frames(page);
};
const shown = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0; }, sel);

// Each visible control scrolled into view, then inside the viewport and topmost at its centre.
// sel: the controls to try; the open settings menu covers what is under it, so the menu items are tried apart
const unreachable = (page, sel = "#controls button:not(#settings-menu *), #controls select, #seek-range") => page.evaluate(async (sel) => {
  const lost = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.hidden || !el.getClientRects().length) continue;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    await new Promise((r) => requestAnimationFrame(r));
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (r.width < 1 || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight
      || !(hit && (hit === el || el.contains(hit) || hit.contains(el)))) lost.push(el.id || el.dataset.speed || el.dataset.audience || el.dataset.view || el.tagName);
  }
  scrollTo(0, 0);
  return lost;
}, sel);
const sideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

// The first screen holds the show: with the page at its top, the frame, the scorebug, play, the seek
// bar and every graphic on air (on the pitch or in the deck) inside the window.
const firstScreen = (page) => page.evaluate(() => {
  const out = [], fmt = (r) => `[${[r.left, r.top, r.width, r.height].map((v) => Math.round(v)).join(",")}]`;
  const inside = (r) => r.width > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
  if (scrollY > 0) out.push(`the page is scrolled ${scrollY} px`);
  for (const s of ["#frame", "#scorebug", "#play", "#seek-range"]) {
    const r = document.querySelector(s).getBoundingClientRect();
    if (!inside(r)) out.push(`${s} at ${fmt(r)}`);
  }
  const live = [...window.studioDesk.host.live.values()].filter((i) => !i.positioned);
  for (const i of live) {
    const r = (i.node !== i.el ? i.node : i.el.shadowRoot.querySelector(".stage")?.firstElementChild)?.getBoundingClientRect();
    if (!r || !inside(r)) out.push(`${i.cue.graphic} at ${r ? fmt(r) : "nowhere"}`);
  }
  return { out, graphics: live.map((i) => i.cue.graphic), frame: fmt(document.querySelector("#frame").getBoundingClientRect()) };
});
// The moment with the most graphics on air for the analyst in English, a pass or shot among them if it can.
const busiest = (cues) => {
  let best = null;
  for (const c of cues.filter((x) => x.graphic !== "nameplate")) {
    const t = c.ts + Math.min(2.5, c.d / 2), n = cues.filter((x) => x.graphic !== "nameplate" && t >= x.ts && t < x.ts + x.d).length + (c.graphic === "pass_shot" ? 0.5 : 0);
    if (!best || n > best.n) best = { t, n };
  }
  return best?.t ?? 60;
};
// every story and generated graphic waiting for the visitor (docs/desk.md) put on air, as a producer would:
// these checks are about where the cards sit, and a card left waiting is never on screen
const approveWaiting = (page) => page.evaluate(() => {
  const d = window.studioDesk.desk;
  // every agents' story that waits by default, also one already missed at this minute: the checks seek back to it
  for (const s of d.stories) if (!d.decisions.has(s.story_id) && d.defaultStatus(s) === "needs_review") d.decisions.set(s.story_id, { story_id: s.story_id, decision: "approved", ts: 0 });
  for (const s of d.gens) if (d.status(s) === "needs_review") d.decisions.set(s.story_id, { story_id: s.story_id, decision: "approved" });
  d.changed();
});
const showFirst = async (page, tag, cues) => {
  await approveWaiting(page);   // the busiest screen
  await seekTo(page, 0);
  const quiet = await page.evaluate(() => document.querySelector("#frame").getBoundingClientRect().toJSON());
  await seekTo(page, busiest(cues));
  await page.waitForTimeout(1200);   // the graphics have finished coming in
  const r = await firstScreen(page);
  const busy = await page.evaluate(() => document.querySelector("#frame").getBoundingClientRect().toJSON());
  if (!r.graphics.length) fail(`${tag}: no graphic on air at the busy moment`);
  for (const o of r.out) fail(`${tag} first screen: ${o}`);
  // the picture keeps its place and size when the strip fills and the graphics come on
  if (["x", "y", "width", "height"].some((k) => Math.abs(quiet[k] - busy[k]) > 1)) fail(`${tag}: the frame moves from [${[quiet.x, quiet.y, quiet.width, quiet.height].map(Math.round)}] at 0' to ${r.frame} with graphics on air`);
  console.log(`${tag}: frame ${r.frame} with ${r.graphics.join(", ")} on air`);
};

// Smallest rendered text (CSS px) inside the graphics on screen, as in smoke.mjs.
const smallestText = (page) => page.evaluate(() => {
  let min = Infinity, what = "";
  for (const host of [...document.querySelectorAll("#overlay *, #deck *")].filter((n) => n.shadowRoot)) {
    for (const el of host.shadowRoot.querySelectorAll("*")) {
      if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || !el.offsetWidth) continue;
      const px = parseFloat(getComputedStyle(el).fontSize) * (r.width / el.offsetWidth);
      if (px < min) { min = px; what = `${host.tagName.toLowerCase()} .${el.className}`; }
    }
  }
  return { min, what };
});

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  for (const size of SIZES) {
    const [w, h] = size, tag = `${w}x${h}`, phone = Math.min(w, h) < 600;
    const page = await open(browser, size, phone);
    await page.waitForFunction(() => window.studioDesk.desk.loaded);
    const { goals, cues, hasVoice } = await page.evaluate(() => {
      const m = window.studioDesk.match;
      const shot = (f) => m.events.find((e) => e.event_id === f.source_event_ids?.[0] && e.ts <= f.ts && e.ts >= f.ts - 10)?.ts ?? f.ts;
      return { goals: m.goals.map((f) => ({ ts: f.ts, shot: shot(f), code: m.teams[f.team_id]?.short_name, label: m.clock(f.ts).label })).sort((a, b) => a.ts - b.ts),
        hasVoice: !document.querySelector("#voice").hidden,
        // the cues on air for the analyst: a story that waits for a person (a big chance) is not
        cues: window.studioDesk.desk.sheet(m.cues, "analyst", "en").map((c) => ({ ts: c.ts, d: c.duration_s, graphic: c.graphic })) };
    });

    // N8: no spoilers, a goal's button appears when the replay reaches the goal and stays after a seek back
    await check(`${tag} goals revealed`, async () => {
      const shownGoals = () => page.evaluate(() => [...document.querySelectorAll("#goals button")].filter((b) => b.getClientRects().length).map((b) => Number(b.dataset.ts)));
      const at0 = await shownGoals();
      if (at0.length) fail(`${tag}: at kick-off ${at0.length} goal buttons shown`);
      for (const [i, g] of goals.entries()) {
        await seekTo(page, g.ts - 1);
        if ((await shownGoals()).length !== i) fail(`${tag}: 1 s before goal ${i + 1}, ${(await shownGoals()).length} goal buttons shown, want ${i}`);
        await seekTo(page, g.ts);
        if ((await shownGoals()).length !== i + 1) fail(`${tag}: at goal ${i + 1}, ${(await shownGoals()).length} goal buttons shown, want ${i + 1}`);
      }
      await seekTo(page, 0);
      if ((await shownGoals()).length !== goals.length) fail(`${tag}: back at kick-off the goals already seen are gone`);
    });

    // N4: the score bug readable at every size: its smallest text at least 11 px, inside the picture
    await check(`${tag} score bug`, async () => {
      const b = await page.evaluate(() => {
        let min = Infinity, what = "";
        for (const el of document.querySelectorAll("#scorebug span")) {
          if (!el.textContent.trim() || !el.getClientRects().length) continue;
          const px = parseFloat(getComputedStyle(el).fontSize) * (el.getBoundingClientRect().height / el.offsetHeight);
          if (px < min) { min = px; what = el.className; }
        }
        const r = document.querySelector("#scorebug").getBoundingClientRect(), f = document.querySelector("#frame").getBoundingClientRect();
        return { min, what, inside: r.left >= f.left && r.top >= f.top && r.right <= f.right && r.bottom <= f.bottom, w: r.width / f.width };
      });
      // offsetHeight is a whole number of pixels, so the measured size can be a few hundredths short
      if (!(b.min >= 10.95)) fail(`${tag}: score bug text at ${b.min.toFixed(1)} px (${b.what})`);
      console.log(`${tag} score bug: smallest text ${b.min.toFixed(1)} px (${b.what}), ${(b.w * 100).toFixed(0)}% of the picture's width`);
      // a 160 px picture (320x180, 400% zoom) needs most of its width for 11 px text: readable wins there
      if (!b.inside || (b.w > 0.6 && h > 180)) fail(`${tag}: score bug ${b.inside ? "" : "out of the picture, "}${(b.w * 100).toFixed(0)}% of its width`);
    });

    // 1: the seek bar alone on the first row of the controls, the clock at its end
    await check(`${tag} seek row`, async () => {
      const r = await page.evaluate(() => {
        const box = (s) => document.querySelector(s)?.getBoundingClientRect();
        const c = document.querySelector("#controls"), cs = getComputedStyle(c);
        const inner = c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const seek = box("#seek-range"), time = box("#time");
        const above = [...c.querySelectorAll(":scope > button, :scope > #settings-wrap")]
          .filter((el) => el.getClientRects().length && el.getBoundingClientRect().top < seek.bottom - 1).map((el) => el.id || el.className);
        return { inner, seek: seek.width, time: time.width, sameRow: Math.abs((time.top + time.bottom) / 2 - (seek.top + seek.bottom) / 2) < 12,
          after: time.left >= seek.right - 1, above };
      });
      if (r.seek < r.inner - r.time - 40) fail(`${tag}: seek track ${r.seek.toFixed(0)} px of ${r.inner.toFixed(0)} px of controls`);
      if (!r.sameRow || !r.after) fail(`${tag}: the clock is not at the end of the seek row`);
      if (r.above.length) fail(`${tag}: buttons beside or above the seek bar: ${r.above.join(", ")}`);
    });

    // 2: a page that scrolls when it must, never sideways, every control reachable; a desktop window needs no scroll
    await check(`${tag} reach`, async () => {
      const over = await sideScroll(page);
      if (over > 0) fail(`${tag}: ${over} px of horizontal scroll`);
      const clip = await page.evaluate(() => [document.documentElement, document.body].map((el) => getComputedStyle(el).overflowY).filter((o) => o === "hidden" || o === "clip"));
      if (clip.length) fail(`${tag}: the page cannot scroll (overflow ${clip.join(", ")})`);
      const lost = await unreachable(page);
      await page.click("#settings");
      lost.push(...await unreachable(page, "#settings-menu button"));
      if (lost.length) fail(`${tag}: controls out of reach: ${lost.join(", ")}`);
      if ((await sideScroll(page)) > 0) fail(`${tag} with the settings open: horizontal scroll`);
      await page.keyboard.press("Escape");
      if (!phone) {
        // a desktop window needs no scroll for the show; a short one may leave the agent strip, whole, under
        // the fold (app.js keeps the graphics on the pitch first); the audiences box always sits below it
        const r = await page.evaluate(() => {
          const kids = [...document.querySelectorAll("#app > *")].filter((el) => !["activity", "audiences"].includes(el.id) && el.getClientRects().length);
          const strip = document.querySelector("#activity").getBoundingClientRect();
          return { tall: document.documentElement.scrollHeight - innerHeight, show: Math.max(...kids.map((el) => el.getBoundingClientRect().bottom)) - innerHeight,
            stripUnder: strip.top >= innerHeight - 1 || strip.bottom <= innerHeight + 1 };  // under the fold or whole above it
        });
        if (r.show > 1) fail(`${tag}: the show ends ${r.show.toFixed(0)} px under the window`);
        else if (r.tall > 1 && !r.stripUnder) fail(`${tag}: the page is ${r.tall} px taller than the window, with the agent strip cut by the fold`);
        else if (r.tall > 1) console.log(`${tag}: ${r.tall} px of scroll under the show (agent strip, audiences box)`);
      }
    });

    // the page header: the name, what the page does and the match from meta.json, in one band
    await check(`${tag} header`, async () => {
      const r = await page.evaluate(() => {
        const h = document.querySelector("#masthead"), m = window.studioDesk.match, b = h?.getBoundingClientRect();
        return h && { top: b.top + scrollY, h: b.height, title: h.querySelector("h1")?.textContent, text: h.innerText,
          names: [m.home.name, m.away.name, m.meta.venue_name], frameTop: document.querySelector("#frame").getBoundingClientRect().top + scrollY,
          lefts: [...h.querySelectorAll("h1, .mh-match, .mh-sub")].filter((el) => el.getClientRects().length).map((el) => el.getBoundingClientRect().left),
          frameLeft: document.querySelector("#frame").getBoundingClientRect().left,
          pick: (({ value, selectedOptions: [o] = [], offsetWidth }) => ({ value, label: o?.text, w: offsetWidth }))(h.querySelector("select#mh-teams") ?? {}), id: m.meta.match_id };
      });
      if (!r) { fail(`${tag}: no page header`); return; }
      const short = h <= 500, narrow = w <= 700, most = short ? 30 : narrow ? 72 : 56;
      if (r.title !== "Studio Desk") fail(`${tag}: the header title is "${r.title}"`);
      if (r.top < 0 || r.h < 16 || r.h > most) fail(`${tag}: the header is ${r.h.toFixed(0)} px high at ${r.top.toFixed(0)}, wanted at most ${most}`);
      if (r.frameTop < r.top + r.h) fail(`${tag}: the picture starts at ${r.frameTop.toFixed(0)}, inside the header`);
      // the name, the match line and the subtitle start at the frame's left edge (the match line sits beside
      // the name on a wide screen: only the lines that start a row count)
      const rowStarts = [r.lefts[0], ...r.lefts.slice(1).filter((x) => x < r.lefts[0] + 40)];
      if (rowStarts.some((x) => Math.abs(x - r.frameLeft) > 1)) fail(`${tag}: the header starts at ${rowStarts.map((x) => x.toFixed(0)).join(", ")}, the picture at ${r.frameLeft.toFixed(0)}`);
      if (!short && !/football replay/.test(r.text)) fail(`${tag}: the header does not say what the page is: "${r.text}"`);
      if (!short && !narrow) for (const n of r.names) if (!r.text.includes(n)) fail(`${tag}: "${n}" missing from the header match line`);
      // the match picker: on this match, named by its teams, and on screen wherever the match line is
      if (r.pick.value !== r.id || r.pick.label !== `${r.names[0]} vs ${r.names[1]}`) fail(`${tag}: the match picker shows ${JSON.stringify(r.pick)} on ${r.id}`);
      if (!short && !r.pick.w) fail(`${tag}: the match picker is not on screen`);
    });

    // C9: the first screen holds the picture, the graphics and the controls, at a quiet and a busy moment
    if (w >= 390 && h >= 390) await check(`${tag} first screen`, () => showFirst(page, tag, cues));

    // 3: one row of buttons under the seek bar, the rest in the settings menu
    await check(`${tag} settings menu`, async () => {
      const always = ["#play", "#seek-range", "#next-moment", "#settings", ...(w < 1100 ? ["#desk-open"] : []), ...(hasVoice ? ["#voice"] : [])];   // from 1100 px the desk is docked open
      for (const s of always) if (!(await shown(page, s))) fail(`${tag}: ${s} not shown`);
      if (await page.$("[data-view]")) fail(`${tag}: a 2D/3D switch on the page`);
      const row = () => page.evaluate(() => {
        const items = [...document.querySelectorAll("#controls > button, #settings")].filter((el) => el.getClientRects().length);
        const mid = (el) => { const r = el.getBoundingClientRect(); return (r.top + r.bottom) / 2; };
        // a 320 px window has no room for the Desk button on the row: it alone may go under
        const m0 = mid(document.querySelector("#play")), narrow = innerWidth < 360;
        return { off: items.filter((el) => Math.abs(mid(el) - m0) > 4 && !(narrow && el.id === "desk-open")).map((el) => el.id), cut: items.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.id) };
      });
      const r0 = await row();
      if (r0.off.length) fail(`${tag}: the buttons wrap: ${r0.off.join(", ")} off the row of Play`);
      if (r0.cut.length) fail(`${tag}: button text cut: ${r0.cut.join(", ")}`);
      if (!(await page.$("#seek-marks .half"))) fail(`${tag}: no half-time mark on the seek bar`);
      // a menu button: closed, then open on screen with the focus on its first item, arrows, Home and End move, Escape closes
      const g = await page.evaluate(() => { const b = document.querySelector("#settings"); return [b.getAttribute("aria-haspopup"), b.getAttribute("aria-expanded"), b.getAttribute("aria-controls"), document.querySelector("#settings-menu").getAttribute("role")]; });
      if (g.join() !== "menu,false,settings-menu,menu") fail(`${tag}: gear ${g.join()}`);
      if (await shown(page, '[data-speed="1"]')) fail(`${tag}: settings shown with the menu closed`);
      await page.focus("#settings");
      await page.keyboard.press("Enter");
      const m = await page.evaluate(() => {
        const el = document.querySelector("#settings-menu"), r = el.getBoundingClientRect(), items = [...el.querySelectorAll("button")].filter((b) => b.getClientRects().length);
        const groups = [...el.querySelectorAll('[role="group"]')].filter((x) => !x.hidden);
        return { exp: document.querySelector("#settings").getAttribute("aria-expanded"), focus: document.activeElement?.dataset.speed,
          rect: [r.left, r.top, r.right, r.bottom].map(Math.round), on: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
          roles: items.filter((b) => !/^menuitem(radio|checkbox)?$/.test(b.getAttribute("role")) || b.tabIndex !== -1).length,
          loose: items.filter((b) => b.getAttribute("role") === "menuitemradio" && !b.closest('[role="group"]')).length,
          unnamed: groups.filter((x) => !document.getElementById(x.getAttribute("aria-labelledby"))?.textContent.trim()).length,
          names: ["speed", "audience", "lang", "minimap"].map((k) => !!el.querySelector(k === "minimap" ? "#minimap" : `[data-${k}]`)).join(),
          mv: ((b) => b.top >= r.top && b.bottom <= r.bottom)(document.querySelector("#multiview-open").getBoundingClientRect()) };
      });
      if (m.exp !== "true" || m.focus !== "1") fail(`${tag}: Enter on the gear: expanded ${m.exp}, focus on speed ${m.focus}`);
      if (!m.on) fail(`${tag}: the menu ${m.rect.join(",")} is not all on the ${w}x${h} screen`);
      // on a wide screen Multiview is in view as the menu opens, not under a scroll (the menu once spread over the desk)
      if (w >= 1200 && !m.mv) fail(`${tag}: Multiview is not in view in the open menu`);
      if (m.roles || m.loose || m.unnamed || m.names !== "true,true,true,true") fail(`${tag}: menu items ${JSON.stringify(m)}`);
      if ((await row()).off.length) fail(`${tag}: the open menu moves the buttons`);
      await page.screenshot({ path: `${shots}/layout-menu-${tag}.png` });
      const at = () => page.evaluate(() => document.activeElement?.dataset.speed ?? document.activeElement?.id);
      await page.keyboard.press("ArrowDown");
      const down = await at();
      await page.keyboard.press("End");
      const endAt = await at();
      await page.keyboard.press("ArrowDown");
      const wrap = await at();
      if (down !== "4" || endAt !== "keys-open" || wrap !== "1") fail(`${tag}: menu arrows: ArrowDown ${down}, End ${endAt}, then ArrowDown ${wrap}`);
      await page.keyboard.press("Escape");
      const st = await page.evaluate(() => ({ exp: document.querySelector("#settings").getAttribute("aria-expanded"), hidden: document.querySelector("#settings-menu").hidden, focus: document.activeElement?.id }));
      if (st.exp !== "false" || !st.hidden || st.focus !== "settings") fail(`${tag}: Escape: ${JSON.stringify(st)}`);
      await page.keyboard.press("ArrowUp");
      if ((await at()) !== "keys-open") fail(`${tag}: ArrowUp on the gear opens on ${await at()}, not the last item`);
      await page.keyboard.press("Escape");
      // what is not the default shows by the gear (beside it, or on its edge on a phone) and the row holds: 4x, then the audience
      await page.evaluate(() => { document.querySelector('[data-speed="4"]').click(); document.querySelector('[data-audience="casual"]').click(); });
      const b = await page.evaluate(() => { const s = document.querySelector("#settings-state"), r = s.getBoundingClientRect(), gr = document.querySelector("#settings").getBoundingClientRect();
        return { text: s.textContent, shown: !!s.getClientRects().length, near: r.left < gr.right + 16 && r.right > gr.left && r.top < gr.bottom + 16 && r.bottom > gr.top - 16, on: r.right <= document.documentElement.clientWidth }; });
      const r1 = await row();
      await page.screenshot({ path: `${shots}/layout-badge-${tag}.png` });
      await page.evaluate(() => { document.querySelector('[data-speed="1"]').click(); document.querySelector('[data-audience="analyst"]').click(); });
      if (b.text !== "4x · Casual fan" || !b.shown || !b.near || !b.on) fail(`${tag}: beside the gear ${JSON.stringify(b)}`);
      if (r1.off.length) fail(`${tag}: with 4x and Casual fan beside the gear the buttons wrap: ${r1.off.join(", ")}`);
      if (await shown(page, "#settings-state")) fail(`${tag}: something beside the gear at 1x for the analyst`);
    });

    // 4: every graphic's text at least 11 px on screen
    await check(`${tag} graphic text`, async () => {
      for (const graphic of ["lineup", "pass_shot", "why_card", "momentum", "team_stats", "nameplate"]) {
        const c = cues.find((x) => x.graphic === graphic);
        if (!c) continue;
        await seekTo(page, c.ts + Math.min(2, c.d / 2));
        const t = await smallestText(page);
        if (!Number.isFinite(t.min)) fail(`${tag} ${graphic}: not on screen`);
        else if (t.min < 11) fail(`${tag} ${graphic}: text at ${t.min.toFixed(1)} px (${t.what})`);
        if ((await sideScroll(page)) > 0) fail(`${tag} ${graphic}: horizontal scroll`);
        if (graphic === "lineup" || graphic === "pass_shot" || graphic === "why_card" || graphic === "team_stats") await page.screenshot({ path: `${shots}/layout-${graphic}-${tag}.png`, fullPage: true });
      }
    });
    if (w === 390 || w === 844 || w === 1280 || w === 1920) {
      await page.screenshot({ path: `${shots}/layout-${tag}.png`, fullPage: true });
    }

    // 6: goal buttons, all shown once the replay has been to the end
    await check(`${tag} goal buttons`, async () => {
      await seekTo(page, await page.evaluate(() => window.studioDesk.end));
      const bs = await page.evaluate(() => [...document.querySelectorAll("#goals button")].filter((b) => b.getClientRects().length).map((b) => {
        const r = b.getBoundingClientRect();
        return { ts: Number(b.dataset.ts), label: b.getAttribute("aria-label"), title: b.title, text: b.innerText, r: { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height } };
      }));
      if (bs.length !== goals.length) { fail(`${tag}: ${bs.length} goal buttons for ${goals.length} goals`); return; }
      const tight = await page.$eval("#goals", (el) => el.classList.contains("tight"));
      for (const [i, b] of bs.entries()) {
        if (!/^Goal, .+ \([A-Z0-9]+\), \d+(\+\d+)?'$/.test(b.label ?? "")) fail(`${tag}: goal button named "${b.label}"`);
        if (b.title !== b.label) fail(`${tag}: goal button hover label "${b.title}", wanted "${b.label}"`);
        // on screen the code and the minute; a bar without room for them all (a 320 px window) shows the codes only
        const want = w > 320 || !tight ? `${goals[i].code} ${goals[i].label}'` : goals[i].code;
        if (b.text !== want) fail(`${tag}: goal button text "${b.text}", wanted ${want}`);
        if (b.r.w < 24 || b.r.h < 24) fail(`${tag}: goal button ${b.r.w.toFixed(0)}x${b.r.h.toFixed(0)} px`);
        const o = bs.slice(i + 1).find((x) => x.r.l < b.r.r && b.r.l < x.r.r && x.r.t < b.r.b && b.r.t < x.r.b);
        if (o) fail(`${tag}: goal buttons at ${b.ts} and ${o.ts} overlap`);
      }
      await page.evaluate(() => window.studioDesk.setPlaying(false));
      const at = [];
      for (let i = 0; i < bs.length; i++) {
        await page.locator("#goals button").nth(i).click();
        at.push(await page.evaluate(() => window.studioDesk.state.ts));
      }
      for (const [i, ts] of at.entries()) if (Math.abs(ts - Math.max(0, goals[i].shot - LEAD_S)) > 0.2) fail(`${tag}: goal ${goals[i].ts} button seeks to ${ts.toFixed(1)}`);
      if (w !== 1280 || bs.length < 2) return;
      // N18: Tab goes seek bar, one goal, Play; the arrows move between the goals and do not seek
      await page.focus("#seek-range");
      const order = [];
      for (let i = 0; i < 2; i++) {
        await page.keyboard.press("Tab");
        order.push(await page.evaluate(() => document.activeElement.closest("#goals") ? "goal" : document.activeElement.id));
      }
      if (order.join() !== "goal,play") fail(`${tag}: Tab after the seek bar goes ${order.join(", ")}, want goal, play`);
      await page.keyboard.press("Shift+Tab");
      const t0 = await page.evaluate(() => window.studioDesk.state.ts);
      await page.keyboard.press("End");
      await page.keyboard.press("ArrowLeft");
      const f = await page.evaluate(() => ({ i: [...document.querySelectorAll("#goals button")].indexOf(document.activeElement), ts: window.studioDesk.state.ts }));
      if (f.i !== bs.length - 2 || f.ts !== t0) fail(`${tag}: End then ArrowLeft in the goals: focus on goal ${f.i}, time ${t0} -> ${f.ts}`);
    });

    // 10: the open Ask panel never covers the picture
    await check(`${tag} ask`, async () => {
      if (!(await shown(page, "#ask-open"))) { fail(`${tag}: no Ask button`); return; }
      await seekTo(page, goals[0]?.ts ?? 60);
      const before = await page.evaluate(() => document.querySelector("#frame").getBoundingClientRect().toJSON());
      await page.click("#ask-open");
      await frames(page);
      await page.waitForTimeout(300);   // ask.js scrolls the panel into view after a frame
      // the open panel leaves the picture where it was; on a landscape window the show stays on screen
      const moved = await page.evaluate((b) => {
        const f = document.querySelector("#frame").getBoundingClientRect();
        return ["x", "y", "width", "height"].some((k) => Math.abs(f[k] - b[k]) > 1) ? `[${[f.x, f.y, f.width, f.height].map(Math.round)}]` : "";
      }, before);
      if (moved && w > h && w >= 600) fail(`${tag}: opening Ask moves the picture to ${moved}`);
      if (w > h && w >= 600) for (const o of (await firstScreen(page)).out) fail(`${tag} with Ask open: ${o}`);
      const r = await page.evaluate(() => {
        const a = document.querySelector("#ask").getBoundingClientRect(), f = document.querySelector("#frame").getBoundingClientRect();
        return Math.max(0, Math.min(a.right, f.right) - Math.max(a.left, f.left)) * Math.max(0, Math.min(a.bottom, f.bottom) - Math.max(a.top, f.top));
      });
      if (r > 1) fail(`${tag}: the Ask panel covers ${r.toFixed(0)} px² of the picture`);
      const q = await page.evaluate(() => {
        const el = document.querySelector("#ask-q");
        el.scrollIntoView({ block: "nearest" });
        const b = el.getBoundingClientRect();
        return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.id;
      });
      if (q !== "ask-q") fail(`${tag}: the question box is covered or out of reach`);
      if ((await sideScroll(page)) > 0) fail(`${tag} with Ask open: horizontal scroll`);
      await page.screenshot({ path: `${shots}/layout-ask-${tag}.png`, fullPage: true });
      await page.press("#ask-q", "Escape");
      await page.evaluate(() => scrollTo(0, 0));
    });

    // 19: the minimap at every size, its inset magnified to stay readable on a small frame (at least 120 px wide), inside the frame
    await check(`${tag} minimap`, async () => {
      const r = await page.evaluate(() => {
        const el = document.querySelector("#radar"), was = el.hidden;
        el.hidden = false;
        const b = el.getBoundingClientRect(), f = document.querySelector("#frame").getBoundingClientRect();
        el.hidden = was;
        return { w: b.width, inside: b.left >= f.left - 1 && b.right <= f.right + 1 && b.bottom <= f.bottom + 1 && b.top >= f.top - 1,
          item: document.querySelector("#minimap")?.getAttribute("aria-disabled") };
      });
      if (r.item !== "false") fail(`${tag}: the minimap item is ${r.item == null ? "missing" : `aria-disabled=${r.item}`}`);
      if (!(r.w >= 119.5) || !r.inside) fail(`${tag}: the minimap inset ${r.w.toFixed(0)} px wide${r.inside ? "" : ", out of the frame"}`);
    });
    if (w === 320) await page.screenshot({ path: `${shots}/layout-${tag}.png`, fullPage: true });
    await page.context().close();
  }

  // C9 on short laptop windows, and in Italian (longer labels, more rows of controls)
  for (const [size, lang] of [[[1280, 650], "en"], [[1366, 640], "en"], [[1280, 720], "it"], [[844, 390], "it"]]) {
    const tag = `${size.join("x")} ${lang}`, p = await open(browser, size, size[1] < 600);
    await check(`${tag} first screen`, async () => {
      await p.evaluate((l) => document.querySelector(`[data-lang="${l}"]`).click(), lang);
      await frames(p);
      const cues = await p.evaluate(() => window.studioDesk.match.cues.filter((c) => c.lang === "en" && c.audience === "analyst").map((c) => ({ ts: c.ts, d: c.duration_s, graphic: c.graphic })));
      await showFirst(p, tag, cues);
      await p.screenshot({ path: `${shots}/layout-first-${size.join("x")}-${lang}.png` });
    });
    await p.context().close();
  }

  const page = await open(browser, [1280, 720]);
  const { goals, goalShots, moms, hasVoice } = await page.evaluate(async () => {
    const m = window.studioDesk.match, reps = (await import("./js/view3d.js")).replays(m);
    // a card due during a goal replay goes on air at its end (app.js refreshCues)
    const due = (c) => reps.find((r) => c.ts < r.to && c.ts + c.duration_s > r.from)?.to ?? c.ts;
    const shot = (f) => m.events.find((e) => e.event_id === f.source_event_ids?.[0] && e.ts <= f.ts && e.ts >= f.ts - 10)?.ts ?? f.ts;
    return { goals: m.goals.map((f) => f.ts).sort((a, b) => a - b), goalShots: m.goals.map(shot).sort((a, b) => a - b), hasVoice: !document.querySelector("#voice").hidden,
      moms: m.cues.filter((c) => c.lang === "en" && c.graphic === "momentum").map((c) => ({ ts: due(c), audience: c.audience })) };
  });

  // 22: the strip one row high before anything happened
  await check("empty strip", async () => {
    await seekTo(page, 0);
    const s = await page.evaluate(() => ({ empty: !!document.querySelector("#activity .act-empty"), h: document.querySelector("#activity").getBoundingClientRect().height }));
    if (!s.empty) fail("empty strip: the strip is not empty at 0'");
    else if (s.h > 34) fail(`empty strip: ${s.h.toFixed(0)} px high`);
  });

  // 23: the word next to the voice icon, in each language
  await check("voice word", async () => {
    if (!hasVoice) { console.log(`voice word: ${MATCH} has no voice clips, not checked`); return; }
    for (const [lang, word] of [["en", "Voice"], ["it", "Voce"], ["es", "Voz"]]) {
      await page.evaluate((l) => document.querySelector(`[data-lang="${l}"]`).click(), lang);
      const v = await page.evaluate(() => { const b = document.querySelector("#voice"); return { text: b.textContent.trim(), cut: b.scrollWidth > b.clientWidth + 1 }; });
      if (v.text !== word || v.cut) fail(`voice word ${lang}: "${v.text}"${v.cut ? " cut" : ""}, wanted ${word}`);
    }
    await page.evaluate(() => document.querySelector('[data-lang="en"]').click());
  });

  // 8 and 21: AI graphics off, Next key moment goes from goal to goal; a disabled pill has a solid edge
  await check("AI off moments", async () => {
    await page.evaluate(() => window.studioDesk.desk.setKill(true));
    await seekTo(page, 0);
    const label = await page.textContent("#next-moment");
    if (label.trim() !== "Next goal") fail(`AI off: the button reads "${label.trim()}", wanted "Next goal"`);
    for (const g of goalShots) {
      // a script click: a pill that is wrongly disabled must fail the check, not stall it
      await page.evaluate(() => document.querySelector("#next-moment").click());
      await page.waitForTimeout(100);
      const ts = await page.evaluate(() => window.studioDesk.state.ts);
      if (Math.abs(ts - (g - LEAD_S)) > 0.3) fail(`AI off: Next goal went to ${ts.toFixed(1)}, wanted ${(g - LEAD_S).toFixed(1)}`);
      await page.evaluate(() => window.studioDesk.setPlaying(false));
    }
    await seekTo(page, goals.at(-1) + 5);
    const end = await page.evaluate(() => {
      const b = document.querySelector("#next-moment"), cs = getComputedStyle(b);
      return { text: b.textContent.trim(), off: b.getAttribute("aria-disabled"), style: cs.borderTopStyle, width: parseFloat(cs.borderTopWidth) };
    });
    if (end.text !== "No more goals" || end.off !== "true") fail(`AI off after the last goal: "${end.text}", aria-disabled ${end.off}`);
    if (end.style !== "solid" || end.width < 1) fail(`disabled pill: border ${end.width}px ${end.style}, wanted solid`);
    await page.screenshot({ path: `${shots}/layout-aioff-1280x720.png` });
    await page.evaluate(() => window.studioDesk.desk.setKill(false));
  });

  // 20: the momentum card on the half away from the ball
  await check("momentum side", async () => {
    let seen = 0, left = 0;
    await approveWaiting(page);   // a momentum story that needs review (M002) is off air until approved
    for (const c of moms) {
      await page.evaluate((a) => document.querySelector(`[data-audience="${a}"]`).click(), c.audience);
      await seekTo(page, c.ts - 20);
      await seekTo(page, c.ts + 0.3);
      const r = await page.evaluate(() => {
        const sd = window.studioDesk, inst = [...sd.host.live.values()].find((i) => i.cue.graphic === "momentum");
        if (!inst) return null;
        const p = sd.match.at(sd.match.index.ball, sd.state.ts), box = inst.el.shadowRoot.querySelector(".box").getBoundingClientRect();
        const f = document.querySelector("#frame").getBoundingClientRect();
        return { ballX: p?.[0], boxMid: (box.left + box.right) / 2 - f.left, frameW: f.width, third: [...sd.host.live.values()].some((i) => i.cue.graphic === "pass_shot") };
      });
      if (!r) { fail(`momentum ${c.ts}: not on screen`); continue; }
      if (r.ballX === undefined || Number.isNaN(r.ballX) || Math.abs(r.ballX - 52.5) < 2 || r.third) continue;
      seen++;
      const boxLeft = r.boxMid < r.frameW / 2, ballRight = r.ballX > 52.5;
      if (boxLeft) left++;
      if (boxLeft !== ballRight) fail(`momentum ${c.ts}: the ball at ${r.ballX.toFixed(1)} m and the card on the ${boxLeft ? "left" : "right"}`);
      if (boxLeft && left === 1) await page.screenshot({ path: `${shots}/layout-momentum-left-1280x720.png` });
    }
    console.log(`momentum side: ${seen} cues checked, ${left} on the left`);
    if (!seen) fail("momentum side: no momentum cue to check");
  });
  await page.evaluate(() => document.querySelector('[data-audience="analyst"]').click());

  // N16: early in the match the momentum axis runs from kick-off to now: the bars fill it, the labels apart
  await check("momentum axis", async () => {
    await page.evaluate(() => document.querySelector('[data-audience="analyst"]').click());
    const first = moms.filter((c) => c.audience === "analyst")[0];
    if (!first) { fail("momentum axis: no momentum cue"); return; }
    await seekTo(page, first.ts - 20);
    await seekTo(page, first.ts + 3);
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => {
      const inst = [...window.studioDesk.host.live.values()].find((i) => i.cue.graphic === "momentum");
      if (!inst) return null;
      const q = (s) => [...inst.el.shadowRoot.querySelectorAll(s)].map((e) => e.getBoundingClientRect());
      const bars = q(".home .bar"), mid = q(".mid")[0], foot = q(".foot span");
      return { n: bars.length, span: (bars.at(-1).right - bars[0].left) / mid.width, apart: foot[1].left - foot[0].right };
    });
    if (!r) { fail(`momentum axis: no momentum card at ${first.ts + 3}`); return; }
    console.log(`momentum axis: ${r.n} windows fill ${(r.span * 100).toFixed(0)}% of the axis`);
    if (r.span < 0.9) fail(`momentum axis: ${r.n} windows fill ${(r.span * 100).toFixed(0)}% of the line from kick-off to now`);
    if (r.apart < 8) fail(`momentum axis: the kick-off and now labels are ${r.apart.toFixed(0)} px apart`);
  });

  // N11: no momentum or team shape card during a goal replay (in 3D its card sat over the net), at any speed the replay plays at
  await check("momentum in replays", async () => {
    const reps = await page.evaluate(async () => (await import("./js/view3d.js")).replays(window.studioDesk.match));
    for (const rep of reps) for (const t of [rep.from + 0.3, (rep.from + rep.to) / 2, rep.to - 0.3]) {
      await seekTo(page, t);
      const on = await page.evaluate(() => [...window.studioDesk.host.live.values()].some((i) => ["momentum", "team_stats"].includes(i.cue.graphic)));
      if (on) fail(`momentum in replays: a momentum or team shape card on air at ${t.toFixed(1)}, in the replay ${rep.from.toFixed(1)} to ${rep.to.toFixed(1)}`);
    }
    console.log(`momentum in replays: ${reps.length} replays checked`);
  });

  // 7 and 16: the 3D canvas never takes the focus, in 3D and back in 2D; loading is a status, failures stay alerts
  await check("3d canvas and loading", async () => {
    await page.evaluate(() => {
      window.__said = { notice: [], status: [] };
      for (const [k, s] of [["notice", "#notice"], ["status", "#view-status"]]) {
        const el = document.querySelector(s);
        if (el) new MutationObserver(() => window.__said[k].push(el.hidden ? "" : el.textContent)).observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
      }
    });
    // the minimap item turns the 3D on, with the 2D pitch in the inset
    await page.click("#settings");
    await page.click("#minimap");
    await page.keyboard.press("Escape");
    // the software renderer can take over 60 s to show it when other jobs share the machine
    await page.waitForFunction(() => document.body.dataset.shownView === "split", null, { timeout: 120000 });
    const said = await page.evaluate(() => window.__said);
    if (!said.status.some((t) => /Loading/.test(t))) fail(`3D loading: not said in the status line (${JSON.stringify(said)})`);
    if (said.notice.some((t) => /Loading/.test(t))) fail("3D loading: said in the alert");
    if (await page.evaluate(() => document.querySelector("#view-status")?.getAttribute("role")) !== "status") fail("3D loading: the status line is not role=status");
    // the 3D large, then swapped into the inset, then the minimap off (the 2D pitch alone)
    for (const view of ["3d", "3d in the inset", "2d"]) {
      // script clicks: with the software 3D renderer busy, Playwright's "stable" wait can time out
      if (view === "3d in the inset") await page.evaluate(() => document.querySelector("#radar").click());
      if (view === "2d") await page.evaluate(() => document.querySelector("#minimap").click());
      await frames(page);
      const now = await page.evaluate(() => `${window.studioDesk.view3d.shown} ${window.studioDesk.view3d.main}`);
      if (now !== { "3d": "split 3d", "3d in the inset": "split 2d", "2d": "2d 2d" }[view]) fail(`${view}: the page shows ${now}`);
      await page.focus("#frame");
      const hits = [];
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press("Tab");
        const id = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
        if (id === "view3d" || id === "CANVAS") hits.push(i);
      }
      if (hits.length) fail(`${view}: the 3D canvas took the focus at Tab ${hits.join(", ")}`);
    }
    const c = await page.evaluate(() => { const el = document.querySelector("#view3d"); return { inert: el.inert, tab: el.tabIndex }; });
    if (!c.inert || c.tab !== -1) fail(`3D canvas: inert ${c.inert}, tabIndex ${c.tab}`);
  });
  await page.context().close();

  // N17: a player's name is never cut, in any story graphic of the four matches, on a laptop and a
  // phone (the compact variant) and on a large screen (the full one), in every language and audience
  if (MATCH === "M001") for (const id of ["M001", "M002", "M003", "M004"]) for (const size of [[1280, 720], [1920, 1080], [390, 844]]) {
    const p = await open(browser, size, size[0] < 600, `?match=${id}`);
    await check(`${id} ${size.join("x")} names`, async () => {
      const r = await p.evaluate(async () => {
        const sd = window.studioDesk, host = sd.host, bad = [];
        // each distinct graphic once per language: the same payload draws the same name
        const keys = new Set(), list = [];
        for (const c of sd.match.cues) { const k = `${c.graphic}|${c.lang}|${JSON.stringify(c.payload)}`; if (host.graphics[c.graphic] && !keys.has(k)) { keys.add(k); list.push(c); } }
        const layer = document.querySelector("#overlay");
        for (let i = 0; i < list.length; i += 16) {
          await Promise.all(list.slice(i, i + 16).map(async (c) => {
            const box = layer.appendChild(document.createElement("div"));
            box.style.cssText = "position:absolute;inset:0;visibility:hidden";
            box.lang = c.lang;
            const el = box.appendChild(document.createElement(host.graphics[c.graphic].tag));
            await el.load({ data: structuredClone(c.payload), renderType: "realtime", renderCharacteristics: { resolution: { width: 1920, height: 1080 } }, ...host.opts.vendorParams() });
            for (const n of el.shadowRoot.querySelectorAll(".name, .team")) {
              const text = n.textContent;
              if (n.scrollWidth > n.clientWidth + 1 || text.trim().endsWith("…")) bad.push(`${c.graphic} ${c.lang} "${text}" ${n.scrollWidth}/${n.clientWidth} px (${c.cue_id})`);
            }
            await el.dispose();
            box.remove();
          }));
        }
        return { n: list.length, bad, compact: host.opts.vendorParams().v_compact };
      });
      console.log(`${id} ${size.join("x")} names: ${r.n} graphics${r.compact ? " (compact)" : ""}, ${r.bad.length} cut`);
      for (const b of r.bad.slice(0, 10)) fail(`${id} ${size.join("x")} name cut: ${b}`);
      if (r.bad.length > 10) fail(`${id} ${size.join("x")}: ${r.bad.length - 10} more names cut`);
    });
    await p.context().close();
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.log(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log("layout ok");
