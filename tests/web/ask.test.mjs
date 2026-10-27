// web/js/ask.js: the suggested questions follow the facts up to the replay time, also as the replay plays.
//   node --test tests/web/ask.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { suggestions, Ask, answerMoment, canWatch } from "../../web/js/ask.js";
import { LEAD_S } from "../../web/js/moments.js";

const facts = JSON.parse(readFileSync(new URL("../../web/data/M001/facts.json", import.meta.url)));
const events = JSON.parse(readFileSync(new URL("../../web/data/M001/events.json", import.meta.url)));

test("M001 at 2400 s: the shots and control questions are suggested, at most four, from facts up to then", () => {
  const got = suggestions(facts, 2400);
  assert.equal(got.length, 4);
  assert.deepEqual(got.slice(0, 2), ["askSugShots", "askSugControl"]);
});

test("a question waits for the facts that answer it", () => {
  const f = (kind, ts) => ({ kind, ts });
  assert.deepEqual(suggestions([f("team_shots", 0)], 0), ["askSugShots"]);
  assert.deepEqual(suggestions([f("team_shots", 0), f("team_possession", 300), f("score", 600)], 299), ["askSugShots"]);
  assert.deepEqual(suggestions([f("team_shots", 0), f("team_possession", 300), f("score", 600)], 600),
    ["askSugShots", "askSugControl", "askSugGoals"]);
  assert.deepEqual(suggestions([], 5000), []);
});

test("open panel, replay playing: the suggestions appear as their facts come in, rebuilt only then", () => {
  // a stand-in DOM: the panel's parts take listeners; the suggestion box counts its rebuilds
  const node = () => ({ addEventListener() {}, setAttribute() {}, querySelector: () => node(), textContent: "", hidden: false });
  const box = { ...node(), hidden: true, built: 0, chips: [], replaceChildren(head, ...chips) { this.built++; this.chips = chips.map((b) => b.dataset.q); } };
  const panel = { ...node(), hidden: false, querySelector: (s) => (s === "#ask-suggest" ? box : node()) };
  globalThis.document = { querySelector: () => node(), createElement: () => ({ dataset: {} }) };
  const state = { ts: 0, lang: "en" };
  const f = (kind, ts) => ({ kind, ts });
  // suggestions() reads the ledger with one facts.filter per call: counting those counts its calls
  let reads = 0;
  const ledger = [f("team_shots", 120), f("team_shots", 400), f("team_possession", 300)];
  const facts = new Proxy(ledger, { get: (a, k, r) => { if (k === "filter") reads++; return Reflect.get(a, k, r); } });
  const ask = new Ask(panel, { state, t: (k) => k, button: node(), facts, maxTs: 5400 });
  ask.renderSuggestions(); // as opening the panel at 0' does: nothing to suggest yet
  assert.equal(box.hidden, true);
  for (let ts = 0; ts <= 600; ts += 1 / 60) { state.ts = ts; ask.update(); }
  assert.deepEqual(box.chips, ["askSugShots", "askSugControl"]);
  assert.equal(box.hidden, false);
  assert.equal(reads, 3, "the ledger read on opening, at 120 s and at 300 s, not on each of the 36,000 frames");
  assert.equal(box.built, 3, "built on opening, at 120 s and at 300 s, not every frame");
  panel.hidden = true;
  state.ts = 0;
  ask.update();
  assert.equal(box.built, 3, "a closed panel is left alone");
});

test("a page without the suggestion box: update() does not go back to renderSuggestions every frame", () => {
  const node = () => ({ addEventListener() {}, setAttribute() {}, querySelector: () => node(), textContent: "", hidden: false });
  const panel = { ...node(), querySelector: (s) => (s === "#ask-suggest" ? null : node()) };
  globalThis.document = { querySelector: () => node(), createElement: () => ({ dataset: {} }) };
  const state = { ts: 0, lang: "en" };
  const ask = new Ask(panel, { state, t: (k) => k, button: node(), facts: [{ kind: "team_shots", ts: 120 }], maxTs: 5400 });
  let calls = 0;
  const render = ask.renderSuggestions;
  ask.renderSuggestions = function () { calls++; return render.call(this); };
  for (let ts = 0; ts <= 600; ts += 1 / 60) { state.ts = ts; ask.update(); }
  assert.equal(calls, 2, "on the first frame and when the clock crosses 120 s");
});

// "Watch it": the moment an answer is about, chosen by code from the events behind its cited facts
const byFact = new Map(facts.map((f) => [f.fact_id, f])), byEvent = new Map(events.map((e) => [e.event_id, e]));
const pick = (ids, now) => answerMoment(ids, byFact, byEvent, now);

test("M001: a goal's score fact gives that goal, LEAD_S before its shot", () => {
  const m = pick(["F-SCORE-000001"], 600);
  assert.deepEqual(m, { event_id: 176, ts: 595.02, kind: "goal", at: 595.02 - LEAD_S });
});

test("M001: of several cited events the latest of the strongest kind, and never one after the replay time", () => {
  // the player's goal count cites both goals (176 at 595 s, 203 at 771.5 s); a shot fact a later miss
  assert.equal(pick(["F-PLAYER_GOALS-000024", "F-SHOT_SPEED-000004"], 1500).event_id, 203, "the latest goal beats a later miss");
  assert.equal(pick(["F-PLAYER_GOALS-000024"], 700).event_id, 176, "the second goal is after the replay time");
  assert.equal(pick(["F-SHOT_SPEED-000001", "F-SHOT_SPEED-000004"], 1500).kind, "shot");
  assert.equal(pick(["F-SHOT_SPEED-000001", "F-SHOT_SPEED-000004"], 1500).event_id, 347, "the latest of two misses");
  assert.equal(pick(["F-SCORE-000002"], 700), null, "a fact whose only event is later than now gives nothing");
});

test("no event behind the cited facts, or nothing cited: no moment", () => {
  assert.equal(pick([], 5400), null);
  assert.equal(pick(["F-TEAM_POSSESSION-000001", "F-UNKNOWN"], 5400), null);
  const pass = facts.find((f) => f.kind === "pass_difficulty" && f.ts > 100);
  assert.equal(pick([pass.fact_id], 5400), null, "a pass is not a moment to replay");
  const accuracy = facts.find((f) => f.kind === "team_pass_accuracy" && f.source_event_ids.some((id) => byEvent.get(id).type_name === "cross"));
  assert.equal(pick([accuracy.fact_id], 5400), null, "a cross inside a pass count is not a chance");
  const xt = facts.find((f) => f.kind === "xt_added" && f.ts > 100);
  assert.equal(pick([xt.fact_id], 5400).kind, "chance", "the one play an xT fact is about is a chance");
});

test("the button shows from the moment's lead-in on: a rewind before it hides it", () => {
  const m = { ts: 595.02, at: 595.02 - LEAD_S };
  assert.equal(canWatch(m, 900), true);
  assert.equal(canWatch(m, m.at), true, "just pressed: it stays");
  assert.equal(canWatch(m, 300), false);
  assert.equal(canWatch(null, 900), false);
});
