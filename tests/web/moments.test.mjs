// web/js/moments.js and web/js/activity.js: where "Next key moment" lands and which steps the strip shows.
//   node --test tests/web/moments.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { momentTargets, goalTargets, nextTarget, momentKey, isMomentKey } from "../../web/js/moments.js";
import { reached, latestPerAgent, agentName } from "../../web/js/activity.js";

const cue = (ts, story_id, duration_s = 6) => ({ ts, story_id, duration_s });

test("a moment is 3 s before a story cue; templates and a story's follow-up graphic are not moments", () => {
  const sheet = [cue(476.6, "S-2", 12), cue(300, null), cue(470.6, "S-2"), cue(1.5, "S-1"), cue(595.7, "S-3"), cue(900, "S-2")];
  assert.deepEqual(momentTargets(sheet), [0, 467.6, 592.7, 897]);
});

test("a story graphic that starts while another story's graphic is on air is the same moment", () => {
  // M001: the goal (S-000012) and the comeback it makes (S-000013) share one event
  const goal = [cue(4908.1, "S-000012"), cue(4914.1, "S-000012", 12), cue(4914.1, "S-000013", 12)];
  assert.deepEqual(momentTargets(goal), [4905.1]);
  // up to 1 s after the cue before it ends still counts; later is a moment of its own
  assert.deepEqual(momentTargets([cue(100, "S-1"), cue(107, "S-2"), cue(120, "S-3"), cue(127.1, "S-4")]), [97, 117, 124.1]);
});

test("with the AI graphics off a moment is 3 s before each goal, in time order, never before kick-off", () => {
  assert.deepEqual(goalTargets([4908.1, 595.7, 1.2]), [0, 592.7, 4905.1]);
  assert.deepEqual(goalTargets([]), []);
});

test("the button's label: next while the stories load, then none at all, none ahead or next", () => {
  assert.equal(momentKey([], 0, false), "next");
  assert.equal(momentKey([], 0, true), "nokey");
  assert.equal(momentKey([10, 20], 0, true), "next");
  assert.equal(momentKey([10, 20], 20, true), "nonext");
});

test("N works only with focus in the broadcast or its controls, outside text fields, without modifiers", () => {
  // a stand-in for an element: the selectors it is inside
  const at = (...inside) => ({ closest: (sel) => (sel.split(/,\s*/).some((s) => inside.includes(s)) ? {} : null) });
  const frame = at("#frame"), range = at("#controls"), desk = at("#desk"), ask = at("textarea"), select = at("#controls", "select");
  const key = (target, extra = {}) => isMomentKey({ key: "n", target, ...extra });
  assert.equal(key(frame), true);
  assert.equal(key(range), true);
  assert.equal(isMomentKey({ key: "N", target: frame }), true); // Caps Lock: no Shift
  assert.equal(key(at()), false); // the page body
  assert.equal(key(desk), false);
  assert.equal(key(ask), false);
  assert.equal(key(at("input:not([type=range])")), false); // the Ask question box sits outside both anyway
  assert.equal(key(select), false);
  for (const mod of ["shiftKey", "ctrlKey", "altKey", "metaKey", "repeat"]) assert.equal(key(frame, { [mod]: true }), false, mod);
  assert.equal(isMomentKey({ key: "m", target: frame }), false);
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
  const it = { ag_commentator: "Commentatore" };
  assert.equal(agentName("commentator_it", (k) => it[k]), "Commentatore IT");
  assert.equal(agentName("story_finder", (k) => it[k]), "Story finder"); // a missing key falls back to English
});
