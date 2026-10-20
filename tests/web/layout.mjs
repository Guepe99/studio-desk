// Layout and controls of the broadcast page at the sizes of the style review, on M001 by default
// (its goals have scorers and it has voice clips; MATCH=DEMO works too, without the voice checks).
//
//   MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh layout.mjs
//
// At 1280x720, 1920x1080, 844x390, 390x844, 320x568 and 320x180: the seek bar on its own row as wide
// as the controls with the clock at its end, the buttons on the rows below; no sideways scroll, a page
// that can scroll, every control reachable; under 700 px wide or 500 px high speed, audience and
// language behind a "Viewing" disclosure that Escape closes with the focus back on it; graphic text
// at least 11 px for every graphic; the score bug's text at least 11 px and inside the picture; goal
// buttons only once the replay has reached the goal, named "Goal, <player> (<code>), <minute>'" on hover
// too, showing the team code and the minute, 24 px, landing 3 s before the goal, one Tab stop after the
// seek bar and before Play with arrows between them; the open Ask panel off the picture; the Radar only
// with room for it. Then: Next key moment with AI graphics off, goal to goal; disabled pills with a
// solid edge; the empty agent strip one row high; the voice button saying Voice in each language; the
// momentum card on the half away from the ball; the 3D canvas never focused and its loading line a
// status, not an alert. Screenshots: out/shots/layout-*.png.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const MATCH = process.env.MATCH ?? "M001";
const url = new URL(`?match=${MATCH}`, base).href;
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });
const SIZES = [[1280, 720], [1920, 1080], [844, 390], [390, 844], [320, 568], [320, 180]];
const LEAD_S = 3;

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const check = async (name, fn) => {
  // the call log's last lines say what a timed-out click was waiting for
  try { await fn(); } catch (e) { const l = e.message.split("\n"); fail(`${name}: ${[l[0], ...l.slice(-3)].join(" | ")}`); }
};

const open = async (browser, [width, height], phone) => {
  const ctx = await browser.newContext({ viewport: { width, height }, ...(phone ? { deviceScaleFactor: 2, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  // as in smoke.mjs: no API on the static site, and a match without clips has no voice.json
  const optional = (m) => /\/api\/|\/voice\.json$/.test(m.location()?.url ?? "");
  page.on("console", (m) => { if (m.type() === "error" && !optional(m)) fail(`${width}x${height} console: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`${width}x${height} page error: ${e.message}`));
  // the static site has no API: an empty question answered 422 is the probe that shows the Ask button
  await page.route("**/api/ask", (r) => r.fulfill({ status: 422, json: { detail: [] } }));
  await page.goto(url);
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
const unreachable = (page) => page.evaluate(async () => {
  const lost = [];
  for (const el of document.querySelectorAll("#controls button, #controls select, #seek-range")) {
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
});
const sideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

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
    const { goals, cues, hasVoice } = await page.evaluate(() => {
      const m = window.studioDesk.match;
      return { goals: m.goals.map((f) => ({ ts: f.ts, code: m.teams[f.team_id]?.short_name, label: m.clock(f.ts).label })).sort((a, b) => a.ts - b.ts),
        hasVoice: !document.querySelector("#voice").hidden,
        cues: m.cues.filter((c) => c.lang === "en" && c.audience === "analyst").map((c) => ({ ts: c.ts, d: c.duration_s, graphic: c.graphic })) };
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
      if (!(b.min >= 11)) fail(`${tag}: score bug text at ${b.min.toFixed(1)} px (${b.what})`);
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
        const above = [...c.querySelectorAll(":scope > button, :scope > .seg, :scope > #viewing > *")]
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
      if (await shown(page, "#viewing-open")) await page.click("#viewing-open");
      const lost = await unreachable(page);
      if (lost.length) fail(`${tag}: controls out of reach: ${lost.join(", ")}`);
      if ((await sideScroll(page)) > 0) fail(`${tag} with the Viewing menu open: horizontal scroll`);
      if (await shown(page, "#viewing-open")) await page.click("#viewing-open");
      if (!phone) {
        const tall = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
        if (tall > 1) fail(`${tag}: the page is ${tall} px taller than the window`);
      }
    });

    // 3: the Viewing disclosure on narrow or short screens, everything in the row on wide ones
    await check(`${tag} viewing menu`, async () => {
      const narrow = w < 700 || h <= 500;
      const always = ["#play", "#seek-range", '[data-view="2d"]', '[data-view="3d"]', "#next-moment", ...(w < 1100 ? ["#desk-open"] : []), ...(hasVoice ? ["#voice"] : [])];   // from 1100 px the desk is docked open
      for (const s of always) if (!(await shown(page, s))) fail(`${tag}: ${s} not shown`);
      const inMenu = ['[data-speed="1"]', '[data-audience="analyst"]', "#lang"];
      const seen = async () => (await Promise.all(inMenu.map((s) => shown(page, s)))).filter(Boolean).length;
      if (!narrow) {
        if (await shown(page, "#viewing-open")) fail(`${tag}: a Viewing button on a wide screen`);
        if ((await seen()) !== inMenu.length) fail(`${tag}: speed, audience or language hidden on a wide screen`);
        return;
      }
      if (!(await shown(page, "#viewing-open"))) { fail(`${tag}: no Viewing button`); return; }
      if ((await seen()) !== 0) fail(`${tag}: speed, audience or language shown with the Viewing menu closed`);
      await page.click("#viewing-open");
      if (await page.getAttribute("#viewing-open", "aria-expanded") !== "true" || (await seen()) !== inMenu.length) fail(`${tag}: Viewing does not open`);
      await page.focus('[data-speed="4"]');
      await page.keyboard.press("Escape");
      const st = await page.evaluate(() => ({ exp: document.querySelector("#viewing-open").getAttribute("aria-expanded"), focus: document.activeElement?.id }));
      if (st.exp !== "false" || (await seen()) !== 0) fail(`${tag}: Escape does not close the Viewing menu`);
      if (st.focus !== "viewing-open") fail(`${tag}: after Escape the focus is on ${st.focus}, not on Viewing`);
    });

    // 4: every graphic's text at least 11 px on screen
    await check(`${tag} graphic text`, async () => {
      for (const graphic of ["pass_shot", "why_card", "momentum", "nameplate"]) {
        const c = cues.find((x) => x.graphic === graphic);
        if (!c) continue;
        await seekTo(page, c.ts + Math.min(2, c.d / 2));
        const t = await smallestText(page);
        if (!Number.isFinite(t.min)) fail(`${tag} ${graphic}: not on screen`);
        else if (t.min < 11) fail(`${tag} ${graphic}: text at ${t.min.toFixed(1)} px (${t.what})`);
        if ((await sideScroll(page)) > 0) fail(`${tag} ${graphic}: horizontal scroll`);
        if (graphic === "pass_shot" || graphic === "why_card") await page.screenshot({ path: `${shots}/layout-${graphic}-${tag}.png`, fullPage: true });
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
      for (const [i, b] of bs.entries()) {
        if (!/^Goal, .+ \([A-Z0-9]+\), \d+(\+\d+)?'$/.test(b.label ?? "")) fail(`${tag}: goal button named "${b.label}"`);
        if (b.title !== b.label) fail(`${tag}: goal button hover label "${b.title}", wanted "${b.label}"`);
        // on screen the code and the minute; a 320 px window has room for the codes only
        const want = w > 320 ? `${goals[i].code} ${goals[i].label}'` : goals[i].code;
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
      for (const [i, ts] of at.entries()) if (Math.abs(ts - (goals[i].ts - LEAD_S)) > 0.2) fail(`${tag}: goal ${goals[i].ts} button seeks to ${ts.toFixed(1)}`);
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
      await page.click("#ask-open");
      await frames(page);
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

    // 19: the Radar only where its inset is readable
    await check(`${tag} radar`, async () => {
      const on = await shown(page, '[data-view="split"]');
      const fw = await page.evaluate(() => document.querySelector("#frame").getBoundingClientRect().width);
      if (on && (w < 600 || fw < 560)) fail(`${tag}: Radar offered with a ${fw.toFixed(0)} px frame`);
      if (!on && w >= 1280) fail(`${tag}: no Radar on a wide screen`);
    });

    if (phone && (await shown(page, "#viewing-open"))) {
      await page.click("#viewing-open");
      await page.screenshot({ path: `${shots}/layout-viewing-${tag}.png`, fullPage: true });
    }
    if (w === 320) await page.screenshot({ path: `${shots}/layout-${tag}.png`, fullPage: true });
    await page.context().close();
  }

  const page = await open(browser, [1280, 720]);
  const { goals, moms, hasVoice } = await page.evaluate(() => {
    const m = window.studioDesk.match;
    return { goals: m.goals.map((f) => f.ts).sort((a, b) => a - b), hasVoice: !document.querySelector("#voice").hidden,
      moms: m.cues.filter((c) => c.lang === "en" && c.graphic === "momentum").map((c) => ({ ts: c.ts, audience: c.audience })) };
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
      await page.selectOption("#lang", lang);
      const v = await page.evaluate(() => { const b = document.querySelector("#voice"); return { text: b.textContent.trim(), cut: b.scrollWidth > b.clientWidth + 1 }; });
      if (v.text !== word || v.cut) fail(`voice word ${lang}: "${v.text}"${v.cut ? " cut" : ""}, wanted ${word}`);
    }
    await page.selectOption("#lang", "en");
  });

  // 8 and 21: AI graphics off, Next key moment goes from goal to goal; a disabled pill has a solid edge
  await check("AI off moments", async () => {
    await page.evaluate(() => window.studioDesk.desk.setKill(true));
    await seekTo(page, 0);
    const label = await page.textContent("#next-moment");
    if (label.trim() !== "Next goal") fail(`AI off: the button reads "${label.trim()}", wanted "Next goal"`);
    for (const g of goals) {
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

  // 7 and 16: the 3D canvas never takes the focus, in 3D and back in 2D; loading is a status, failures stay alerts
  await check("3d canvas and loading", async () => {
    await page.evaluate(() => {
      window.__said = { notice: [], status: [] };
      for (const [k, s] of [["notice", "#notice"], ["status", "#view-status"]]) {
        const el = document.querySelector(s);
        if (el) new MutationObserver(() => window.__said[k].push(el.hidden ? "" : el.textContent)).observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
      }
    });
    await page.click('[data-view="3d"]');
    // the software renderer can take over 60 s to show it when other jobs share the machine
    await page.waitForFunction(() => document.body.dataset.shownView === "3d", null, { timeout: 120000 });
    const said = await page.evaluate(() => window.__said);
    if (!said.status.some((t) => /Loading/.test(t))) fail(`3D loading: not said in the status line (${JSON.stringify(said)})`);
    if (said.notice.some((t) => /Loading/.test(t))) fail("3D loading: said in the alert");
    if (await page.evaluate(() => document.querySelector("#view-status")?.getAttribute("role")) !== "status") fail("3D loading: the status line is not role=status");
    for (const view of ["3d", "2d"]) {
      // a script click: with the software 3D renderer busy, Playwright's "stable" wait can time out
      await page.evaluate((v) => document.querySelector(`[data-view="${v}"]`).click(), view);
      await frames(page);
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
} finally {
  await browser.close();
}

if (failures.length) {
  console.log(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log("layout ok");
