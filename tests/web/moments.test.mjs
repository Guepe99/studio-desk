// web/js/moments.js and web/js/activity.js: where "Next key moment" lands and which steps the strip shows.
//   node --test tests/web/moments.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { momentTargets, nextTarget } from "../../web/js/moments.js";
import { reached, latestPerAgent, agentName } from "../../web/js/activity.js";

const cue = (ts, story_id, duration_s = 6) => ({ ts, story_id, duration_s });

test("a moment is 3 s before a story cue; templates and a story's follow-up graphic are not moments", () => {
  const sheet = [cue(476.6, "S-2", 12), cue(300, null), cue(470.6, "S-2"), cue(1.5, "S-1"), cue(595.7, "S-3"), cue(900, "S-2")];
  assert.deepEqual(momentTargets(sheet), [0, 467.6, 592.7, 897]);
});

test("the next moment is strictly ahead, so a second press moves on", () => {
  const targets = [0, 467.6, 592.7];
  assert.equal(nextTarget(targets, 0), 467.6);
  assert.equal(nextTarget(targets, 467.6), 592.7);
  assert.equal(nextTarget(targets, 470), 592.7);
  assert.equal(nextTarget(targets, 592.7), undefined);
  assert.equal(nextTarget([], 0), undefined);
});

test("the strip reaches only ts <= now and shows each agent's latest step, oldest first", () => {
  const agents = ["story_finder", "analyst", "commentator_en", "verifier", "commentator_en", "verifier", "director"];
  const rows = agents.map((agent, i) => ({ agent, ts: 100, seq: i + 1 })).concat([{ agent: "story_finder", ts: 200, seq: 8 }]);
  assert.equal(reached(rows, 99.9), 0);
  assert.equal(reached(rows, 100), 7);
  assert.equal(reached(rows, 1e9), 8);
  assert.deepEqual(latestPerAgent(rows, 7).map((i) => rows[i].seq), [1, 2, 5, 6, 7]);
  assert.deepEqual(latestPerAgent(rows, 8).map((i) => rows[i].seq), [2, 5, 6, 7, 8]);
  assert.deepEqual(latestPerAgent(rows, 0), []);
  const many = Array.from({ length: 9 }, (_, i) => ({ agent: `a${i}`, ts: 1, seq: i }));
  assert.equal(latestPerAgent(many, 9).length, 7);
});

test("agent names", () => {
  assert.equal(agentName("commentator_it"), "Commentator IT");
  assert.equal(agentName("story_finder"), "Story finder");
  assert.equal(agentName("new_agent"), "new agent");
});
