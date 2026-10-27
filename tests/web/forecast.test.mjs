// web/js/forecast.js: only pre-approved prepared lines air, at the event's own time, and each is logged.
//   node --test tests/web/forecast.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Watch, preparedCues, withPrepared, stepAt, PREP_S } from "../../web/js/forecast.js";
import { TEXT, tr } from "../../web/js/desk.js";

const words = (s) => ({ en: s, it: `${s} (it)`, es: `${s} (es)` });
const item = (id, at, hit = true) => ({ id, kind: "second_goal", title: words("Second goal"), template: words("{player} again {minute}"),
  hit, at, trigger_fact_id: hit ? `F-${id}` : null, line: hit ? words(`${id} line`) : null, line_fact_ids: hit ? [`F-${id}`] : [] });
const DATA = { match_id: "M001", steps: [{ ts: 0, items: [] }, { ts: 60, items: [{ id: "A", p: 0.3, reason: words("r") }] }, { ts: 120, items: [] }],
  items: [item("A", 100), item("B", 200), item("C", 300, false), item("D", 200)] };

test("nothing pre-approved: the sheet is the same array, nothing added", () => {
  const sheet = [{ cue_id: "C-1", ts: 101, duration_s: 12, graphic: "why_card", story_id: "S-1" }];
  assert.deepEqual(preparedCues(DATA, new Map(), "analyst", "en"), []);
  assert.equal(withPrepared(sheet, []), sheet);
});

test("a pre-approved line airs at the event, as code's text, in the language on air", () => {
  const cues = preparedCues(DATA, new Map([["A", { ts: 50 }]]), "analyst", "it");
  assert.equal(cues.length, 1);
  const c = cues[0];
  assert.equal(c.ts, 100);
  assert.equal(c.duration_s, PREP_S);
  assert.equal(c.story_id, null);   // the broadcast delay moves only story cues: this one stays on its event
  assert.equal(c.graphic, "why_card");
  assert.deepEqual(c.payload, { kind: "why", title: "Second goal (it)", body: "A line (it)", fact_ids: ["F-A"], prepared: true, forecast_id: "A" });
});

test("never airs: not pre-approved, approved after the event, or an event that did not happen", () => {
  assert.deepEqual(preparedCues(DATA, new Map([["A", { ts: 100 }]]), "analyst", "en"), []);
  assert.deepEqual(preparedCues(DATA, new Map([["A", { ts: 150 }]]), "analyst", "en"), []);
  assert.deepEqual(preparedCues(DATA, new Map([["C", { ts: 10 }]]), "analyst", "en"), []);
});

test("two lines on one event: one card", () => {
  const cues = preparedCues(DATA, new Map([["B", { ts: 1 }], ["D", { ts: 2 }]]), "analyst", "en");
  assert.deepEqual(cues.map((c) => c.cue_id), ["P-B"]);
});

test("a card of the sheet that would start under the prepared one waits for its end", () => {
  const prepared = preparedCues(DATA, new Map([["A", { ts: 50 }]]), "analyst", "en");
  const why = { cue_id: "C-1", ts: 103, duration_s: 12, graphic: "why_card", story_id: "S-1" };
  const shot = { cue_id: "C-2", ts: 100.3, duration_s: 6, graphic: "pass_shot", story_id: null };
  const later = { cue_id: "C-3", ts: 110, duration_s: 12, graphic: "why_card", story_id: "S-2" };
  const out = withPrepared([shot, why, later], prepared);
  assert.deepEqual(out.map((c) => [c.cue_id, c.ts]), [["P-A", 100], ["C-2", 100.3], ["C-1", 100 + PREP_S], ["C-3", 110]]);
  assert.equal(out.find((c) => c.cue_id === "C-1").due, 103);
  assert.equal(out.find((c) => c.cue_id === "C-2"), shot);
});

test("stepAt: the latest step at or before the time", () => {
  assert.equal(stepAt(DATA, 59).ts, 0);
  assert.equal(stepAt(DATA, 60).ts, 60);
  assert.equal(stepAt(null, 60), null);
});

function watch() {
  let changes = 0;
  const desk = { localAudit: [], render() {}, root: null, bodyEl: null };
  const w = new Watch({ desk, state: { ts: 0, lang: "en" }, onChange: () => { changes += 1; } });
  w.data = DATA;
  w.byId = new Map(DATA.items.map((it) => [it.id, it]));
  w.render = () => {};
  return { w, desk, changes: () => changes };
}

test("pre-approving is logged, allowed only before the event, and can be withdrawn", () => {
  const { w, desk, changes } = watch();
  w.toggle("A", 120);   // after the event: nothing
  assert.equal(w.approvals.size, 0);
  assert.equal(desk.localAudit.length, 0);
  w.toggle("A", 60);
  w.toggle("B", 61);
  w.toggle("B", 62);
  assert.deepEqual([...w.approvals.keys()], ["A"]);
  assert.deepEqual(desk.localAudit.map((r) => [r.action, r.story_id, r.ts, r.actor]).reverse(),
    [["prepared_approved", "A", 60, "human"], ["prepared_approved", "B", 61, "human"], ["prepared_withdrawn", "B", 62, "human"]]);
  assert.equal(changes(), 3);
  assert.equal(desk.localAudit[0].detail.prepared, true);
});

test("on air: logged once as prepared text, at the event's time", () => {
  const { w, desk } = watch();
  w.toggle("A", 60);
  const [cue] = w.sheet([], "analyst", "en");
  assert.equal(w.until, 100 + PREP_S);
  w.update(99, []);
  assert.equal(desk.localAudit.filter((r) => r.action === "prepared_aired").length, 0);
  w.update(100.1, [cue]);
  w.update(101, [cue]);
  const aired = desk.localAudit.filter((r) => r.action === "prepared_aired");
  assert.equal(aired.length, 1);
  assert.equal(aired[0].ts, 100);
  assert.deepEqual([aired[0].story_id, aired[0].detail.prepared, aired[0].detail.cue_id], ["A", true, "P-A"]);
});

test("every audit line reads in each language with its title", () => {
  for (const lang of ["en", "it", "es"]) {
    for (const a of ["prepared_approved", "prepared_withdrawn", "prepared_aired"]) {
      const s = tr(lang, `y_${a}`, { title_en: "Second goal", title_it: "Doppietta", title_es: "Doblete" });
      assert.ok(!s.includes("{") && /Second goal|Doppietta|Doblete/.test(s), `${lang} ${a}: ${s}`);
      assert.ok(TEXT[lang][`a_${a}`], `${lang} a_${a}`);
    }
  }
});

test("the panel's words: a level, never a percentage, and slots that read as words, in each language", () => {
  for (const lang of ["en", "it", "es"]) {
    for (const k of ["w_lvl_unlikely", "w_lvl_possible", "w_lvl_likely", "w_slot_minute", "w_slot_score", "w_slot_final", "w_slotTitle", "w_note"]) {
      const s = TEXT[lang][k];
      assert.ok(s && !/[{%\u2013\u2014]|\d/.test(s), `${lang} ${k}: ${s}`);
    }
    assert.ok(TEXT[lang].w_slot_score.includes(" "), `${lang}: the score slot is a phrase, not a bare label`);
  }
});

const M001 = new URL("../../web/data/M001/forecast.json", import.meta.url);
test("M001: the brace at 13' is a prepared line that airs on its goal", { skip: !existsSync(M001) && !process.env.CI && "no web/data/M001/forecast.json" }, () => {
  const data = JSON.parse(readFileSync(M001, "utf8"));
  const it = data.items.find((x) => x.id === "W-second_goal-T01-9");
  assert.equal(it.hit, true);
  assert.equal(it.trigger_fact_id, "F-PLAYER_GOALS-000024");
  assert.ok(stepAt(data, 700).items.some((x) => x.id === it.id && x.p > 0 && x.p < 1));
  const [cue] = preparedCues(data, new Map([[it.id, { ts: 700 }]]), "analyst", "en");
  assert.equal(cue.ts, it.at);
  assert.match(cue.payload.body, /strikes again in the 13th minute/);
  for (const d of data.steps) for (const x of d.items) assert.ok(x.p >= 0 && x.p <= 1 && x.fact_ids.length && ["unlikely", "possible", "likely"].includes(x.level));
  // the panel's facts never lag a graphic: Ostwick's first shot (7:50) is in the step at 7:56
  assert.match(stepAt(data, 476).items.find((x) => x.id === "W-clean_sheet-T01").reason.en, /Ostwick: 1 shot/);
});
