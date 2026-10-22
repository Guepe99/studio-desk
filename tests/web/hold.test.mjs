// web/js/view3d.js holdForReplays: the cards at the foot of the picture wait for a goal replay to end.
//   node --test tests/web/hold.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { holdForReplays } from "../../web/js/view3d.js";

const cue = (cue_id, graphic, ts, duration_s) => ({ cue_id, graphic, ts, duration_s });

test("momentum and team shape due in a replay go on after it, one after the other; other cards keep their time", () => {
  const cues = [cue("a", "momentum", 300, 8), cue("b", "team_stats", 308, 10), cue("c", "why_card", 309, 12), cue("d", "team_stats", 608, 10)];
  const got = holdForReplays(cues, [{ from: 306, to: 311.5 }]);
  assert.deepEqual(got.map((c) => [c.cue_id, c.ts]), [["a", 311.5], ["b", 319.5], ["c", 309], ["d", 608]]);
  assert.equal(cues[0].ts, 300); // the sheet itself is not changed
  assert.equal(got[3], cues[3]);
});

test("without a replay nothing moves", () => {
  const cues = [cue("a", "momentum", 300, 8), cue("b", "team_stats", 308, 10)];
  assert.deepEqual(holdForReplays(cues, []), cues);
});
