// web/js/ask.js: the suggested questions follow the facts up to the replay time, also as the replay plays.
//   node --test tests/web/ask.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { suggestions, Ask } from "../../web/js/ask.js";

const facts = JSON.parse(readFileSync(new URL("../../web/data/M001/facts.json", import.meta.url)));

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
