// web/js/scene3d/sightline.js: camera 1's rail keeps every kick in sight.
//   node --test tests/web/sightline3d.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { hidden, railPlan, railAt } from "../../web/js/scene3d/sightline.js";

// a made-up match: the ball and the kicker at (60, 30), a defender 7 m nearer the stand camera,
// where his head covers the kicker's foot from 18 m up and 64 m back
function fake(defX) {
  const pos = { 0: [60, 30, 0.11], 1: [60.3, 30, 0], 2: [defX, 23, 0] };
  return {
    n: 3, duration: 20,
    meta: { entities: ["ball", "A-1", "B-1"] },
    events: [{ ts: 10, type_name: "shot", player_id: "A-1" }, { ts: 15, type_name: "dribble", player_id: "A-1" }],
    at: (i) => pos[i],
  };
}
const LENS = [52.5, 18, -34];

test("a head on the line of sight hides the kick, the rail clears it", () => {
  // the head at 1.85 m covers the ground 1.85 / 18 * distance behind him: the defender must stand
  // on the line from the lens to the foot, which crosses y = 23 at x = 60 - 7 * 7.5 / 64
  const onLine = 60 - (7 * 7.5) / 64;
  const m = fake(onLine);
  assert.ok(hidden(m, LENS, [60, 30], 1, 10), "the check sees nothing");
  const plan = railPlan(m, LENS);
  assert.equal(plan.length, 1, "only the kick moves the camera");
  const { dx } = plan[0];
  assert.ok(dx !== 0 && Math.abs(dx) <= 10);
  assert.ok(!hidden(m, [LENS[0] + dx, LENS[1], LENS[2]], [60, 30], 1, 10), "still hidden after the slide");
  // on the slide at contact, back home well away from it, eased in between
  assert.equal(railAt(plan, 10), dx);
  assert.equal(railAt(plan, 12), 0);
  const mid = railAt(plan, 11.2);
  assert.ok(Math.abs(mid) > 0 && Math.abs(mid) < Math.abs(dx));
});

test("a clear line leaves the camera where it is", () => {
  const m = fake(45);
  assert.ok(!hidden(m, LENS, [60, 30], 1, 10));
  assert.deepEqual(railPlan(m, LENS), []);
  assert.equal(railAt([], 10), 0);
});
