// web/js/booth.js: the booth's plan for M001 from its events and facts, fed one input at a time.
//   node --test tests/web/booth.test.mjs
// The clip manifests are the committed ones (web/booth/booth.json, replays/M001/booth.json); BOOTH_SHARED and
// BOOTH_MATCH point elsewhere while they are being rendered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Booth, planMatch, inputs, shares, studioInputs, pieces, number, clipKey, RULES } from "../../web/js/booth.js";

const root = new URL("../../", import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const lines = read("web/booth/lines.json");
const data = Object.fromEntries(["meta", "events", "facts", "cues", "voice"].map((f) => [f, read(`web/data/M001/${f}.json`)]));
const shared = JSON.parse(readFileSync(process.env.BOOTH_SHARED ?? new URL("web/booth/booth.json", root), "utf8"));
const local = JSON.parse(readFileSync(process.env.BOOTH_MATCH ?? new URL("replays/M001/booth.json", root), "utf8"));
// whole words, accents folded, as studiodesk/names.py compares them
const fold = (s) => ` ${s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[a-z0-9]+/g)?.join(" ") ?? ""} `;
const forbidden = readFileSync(new URL("data/forbidden_names.txt", root), "utf8").split("\n")
  .map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(fold);

function options(lang, seed = 7) {
  const durations = new Map([...shared.clips, ...local.clips].filter((r) => r.lang === lang).map((r) => [r.key, r.duration_s]));
  return { lines, lang, meta: data.meta, names: local.names[lang], durations, seed };
}
const studio = (lang) => studioInputs(data.cues, data.voice, lang, "analyst");
const stream = (lang) => inputs({ ...data, studio: studio(lang) });
const plans = Object.fromEntries(["en", "it", "es"].map((l) => [l, planMatch(options(l), stream(l))]));
const speech = (plan) => plan.filter((it) => it.voice !== "crowd" && (it.until ?? Infinity) > it.t);
const endOf = (it) => Math.min(it.t + it.dur, it.until ?? Infinity);

test("a live run, one input at a time, makes the same plan as the replay", () => {
  for (const lang of ["en", "it"]) {
    const b = new Booth(options(lang));
    const started = [];
    for (const input of stream(lang)) started.push(...b.step(input).map((it) => it.t));
    // nothing starts before the input that made it: every item's start is at or after the clock that fed it
    assert.deepEqual(JSON.stringify(b.plan), JSON.stringify(plans[lang]));
    assert.equal(started.length, plans[lang].length);
  }
});

test("lines start no earlier than the input they come from", () => {
  const b = new Booth(options("en"));
  for (const input of stream("en")) for (const it of b.step(input)) assert.ok(it.t >= input.ts - 1e-9, `${it.kind} at ${it.t} from ${input.ts}`);
});

test("every shot, goal, save and card is called", () => {
  for (const [lang, plan] of Object.entries(plans)) {
    const called = new Set(speech(plan).map((it) => it.event_id));
    const a = data.events.filter((e) => ["shot", "shot_freekick", "keeper_save"].includes(e.type_name)
      || e.result_name === "yellow_card" || e.result_name === "red_card");
    // a save is called as the end of its shot's line, so the shot's or the save's id counts
    const missed = a.filter((e) => !called.has(e.event_id) && !(e.type_name === "shot" && data.events.some((s) =>
      s.type_name === "keeper_save" && s.ts - e.ts < 3 && s.ts > e.ts && called.has(s.event_id))) && !(e.type_name === "keeper_save"
      && data.events.some((s) => s.type_name === "shot" && e.ts - s.ts < 3 && e.ts > s.ts && called.has(s.event_id))));
    assert.deepEqual(missed.map((e) => `${e.event_id} ${e.type_name} ${e.ts}`), [], lang);
  }
});

test("after a goal call the booth holds 9 to 12 s", () => {
  for (const [lang, plan] of Object.entries(plans)) {
    const goals = speech(plan).filter((it) => it.voice === "pbp" && (it.kind === "goal" || it.kind === "goal_noname"));
    assert.equal(goals.length, data.meta.home_score + data.meta.away_score);
    for (const g of goals) {
      const next = speech(plan).find((it) => it.t > g.t);
      // a studio clip in the hold keeps the booth quiet longer (A7)
      const studioIn = studio(lang).some((s) => s.ts >= g.t && s.ts <= g.t + RULES.hold[1]);
      assert.ok(next.t - g.t >= RULES.hold[0] && (studioIn || next.t - g.t <= RULES.hold[1] + 2), `${lang} goal at ${g.t}: next at ${next.t}`);
      if (lang === "en") console.log(`M001 ${lang}: goal at ${g.t}, next line ${(next.t - g.t).toFixed(1)} s later${studioIn ? " (studio clip in the hold)" : ""}`);
    }
  }
});

test("without a studio clip the next line comes 9 to 14 s after the goal call", () => {
  const plan = planMatch(options("en"), inputs({ ...data, studio: [] }));
  const goals = speech(plan).filter((it) => it.voice === "pbp" && it.kind.startsWith("goal"));
  for (const g of goals) {
    const next = speech(plan).find((it) => it.t > g.t), d = next.t - g.t;
    console.log(`M001 en without studio: goal at ${g.t}, next line ${d.toFixed(1)} s later`);
    assert.ok(d >= RULES.hold[0] && d <= RULES.hold[1] + 2, `goal at ${g.t}: next at ${next.t}`);
  }
});

test("lines never overlap, and the same voice leaves at least 1 s", () => {
  for (const [lang, plan] of Object.entries(plans)) {
    const s = speech(plan);
    for (let i = 1; i < s.length; i++) {
      assert.ok(s[i].t >= endOf(s[i - 1]) - 1e-6, `${lang} overlap at ${s[i].t}`);
      const prev = s.slice(0, i).findLast((it) => it.voice === s[i].voice);
      const cut = prev && prev.until !== undefined && prev.until < prev.t + prev.dur;
      const cont = s[i].cont; // a save finishing its shot's sentence, the co's second sentence at the break
      if (prev && !cut && !cont) assert.ok(s[i].t - endOf(prev) >= RULES.gapMin - 1e-6, `${lang} ${s[i].voice} at ${s[i].t}`);
      if (s[i - 1].voice !== s[i].voice && s[i - 1] === prev) continue;
      if (s[i - 1].voice !== s[i].voice && !(s[i - 1].until < s[i - 1].t + s[i - 1].dur)) {
        assert.ok(s[i].t - endOf(s[i - 1]) >= RULES.handover[0] - 1e-6, `${lang} handover at ${s[i].t}`);
      }
    }
  }
});

test("the studio voice has priority: no booth speech while a studio clip plays or 1.5 s after", () => {
  for (const [lang, plan] of Object.entries(plans)) {
    for (const st of studio(lang)) {
      for (const it of speech(plan)) {
        const busy = it.t < st.ts + st.d + RULES.studioAfter && endOf(it) > st.ts;
        assert.ok(!busy, `${lang} ${it.voice} ${it.kind} at ${it.t} during studio ${st.ts}`);
      }
    }
  }
});

test("no player is named twice within 6 s", () => {
  for (const plan of Object.values(plans)) {
    const last = new Map();
    for (const it of speech(plan)) {
      for (const n of it.names.filter((n) => !n.startsWith("T") || n.includes("-"))) {
        assert.ok(it.t - (last.get(n) ?? -1e9) >= RULES.nameS, `${n} again at ${it.t}`);
        last.set(n, it.t);
      }
    }
  }
});

test("the co cites at most one number a turn, only from facts at or before its line", () => {
  const byId = new Map(data.facts.map((f) => [f.fact_id, f]));
  for (const plan of Object.values(plans)) {
    for (const it of speech(plan)) {
      assert.ok(it.fact_ids.length <= 1, `${it.kind} at ${it.t}`);
      for (const id of it.fact_ids) assert.ok(byId.get(id).ts <= it.t, `${id} after ${it.t}`);
      if (it.voice === "pbp") assert.equal(it.fact_ids.length, 0);
    }
  }
});

test("the co speaks 20 to 30 % of the booth's speech; real shares and gaps are printed", () => {
  for (const [lang, plan] of Object.entries(plans)) {
    const s = shares(plan), sp = speech(plan);
    const gaps = sp.slice(1).map((it, i) => it.t - endOf(sp[i])).filter((g) => g < 30).sort((a, b) => a - b);
    const q = (p) => gaps[Math.floor(p * (gaps.length - 1))].toFixed(2);
    console.log(`M001 ${lang}: ${sp.length} lines, pbp ${s.pbp.toFixed(0)} s, co ${s.co.toFixed(0)} s, co share `
      + `${(100 * s.coShare).toFixed(1)} %, gap p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)} s, crowd ${plan.length - sp.length}`);
    assert.ok(s.coShare >= 0.2 && s.coShare <= 0.3, `${lang} co share ${s.coShare}`);
  }
});

test("no variant twice in a row, and no line with a forbidden name or a digit outside a fact", () => {
  for (const [lang, plan] of Object.entries(plans)) {
    const last = new Map();
    for (const it of speech(plan)) {
      const v = it.clips.map((c) => c.key).join("+");
      assert.notEqual(last.get(`${it.voice}|${it.kind}`), v, `${lang} ${it.kind} at ${it.t}`);
      last.set(`${it.voice}|${it.kind}`, v);
      const low = fold(it.text);
      for (const f of forbidden) assert.ok(!low.includes(f), `${f.trim()} in ${it.text}`);
      if (!it.fact_ids.length) assert.doesNotMatch(it.text, /\d/, it.text);
    }
  }
  for (const role of ["pbp", "co"]) for (const lang of ["en", "it", "es"]) {
    for (const [kind, vs] of Object.entries(lines[role][lang])) {
      for (const v of vs.flat()) assert.doesNotMatch(v.replace(/\{[^}]*\}/g, ""), /\d/, `${role} ${lang} ${kind}: ${v}`);
      if (role === "pbp" && !["kickoff", "kickoff2", "half_time", "full_time", "half_time_q", "full_time_q"].includes(kind)) {
        assert.ok(vs.length >= 2, `${lang} ${kind} has ${vs.length} variants`);
      }
    }
    for (const kind of ["pass", "interception", "tackle", "cross", "take_on", "foul"]) {
      if (role === "pbp") assert.ok(lines.pbp[lang][kind].length >= 10, `${lang} ${kind}: ${lines.pbp[lang][kind].length}`);
    }
  }
});

test("every clip a line needs is in the manifests", () => {
  for (const lang of ["en", "it", "es"]) {
    const b = new Booth(options(lang));
    for (const input of stream(lang)) b.step(input);
    assert.deepEqual([...b.missing], [], lang);
  }
});

test("pieces and number match studiodesk/booth.py", () => {
  assert.deepEqual(pieces("{player}, into {receiver}.", "pbp", "en", lines),
    [["name", "player", null, "."], ["text", "into"], ["name", "receiver", null, "."]]);
  assert.deepEqual(pieces("That was {fact:shot_speed}!", "co", "en", lines), [["text", "That was"], ["fact", "shot_speed", "."]]);
  assert.deepEqual(pieces("{team} against {team2}.", "pbp", "en", lines), [["line", "{team} against {team2}."]]);
  assert.equal(number(101.6, "km/h", "en"), "102");
  assert.equal(number(7.26, "/10", "it"), "7,3");
  assert.equal(number(10450, "km", "es"), "10,5");
  assert.equal(number(433, null, "en"), "4-3-3");
  assert.equal(clipKey("co", "Dan."), "co|Dan.");
});
