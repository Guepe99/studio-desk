// web/js/ask.js: the suggested questions follow the facts up to the replay time.
//   node --test tests/web/ask.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { suggestions } from "../../web/js/ask.js";

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
