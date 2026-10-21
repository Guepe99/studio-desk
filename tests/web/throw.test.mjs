// web/js/scene3d/players.js: the throw-in driver, arms over the head and facing the throw.
//   node --test tests/web/throw.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= { BABYLON: {} };
const { scheduleThrows, throwAt, throwDriver, THROW } = await import("../../web/js/scene3d/players.js");

const events = [
  { type_name: "pass", player_id: "T01-4", ts: 50, start_x: 50, start_y: 30, end_x: 52, end_y: 68 },
  { type_name: "throw_in", player_id: "T01-5", ts: 69.2, start_x: 52.25, start_y: 68, end_x: 58, end_y: 63 },
];
const match = { meta: { entities: ["ball", "T01-4", "T01-5"] } };

test("only throw-ins are scheduled, facing where the ball goes", () => {
  const s = scheduleThrows(events);
  assert.deepEqual(Object.keys(s), ["T01-5"]);
  assert.ok(Math.abs(s["T01-5"][0].yaw - Math.atan2(5.75, -5)) < 1e-9);
});

test("the thrower raises the ball, holds it over his head and lets go at the event", () => {
  const d = throwDriver(match, scheduleThrows(events));
  assert.equal(d.pose(2, 69.2 + THROW.start - 0.01), null);
  assert.equal(d.pose(1, 69), null);                           // nobody else throws
  const raising = d.pose(2, 69.2 + THROW.start + THROW.raise / 2), held = d.pose(2, 69.1);
  assert.equal(held.emotion.clip, THROW.clip);
  assert.ok(held.emotion.upper && held.emotion.weight === 1 && held.emotion.t === THROW.up);
  assert.ok(raising.emotion.t > 0 && raising.emotion.t < THROW.up);
  const after = d.pose(2, 69.2 + THROW.end / 2);
  assert.ok(after.emotion.weight > 0 && after.emotion.weight < 1);   // the arms come down after the release
  assert.equal(d.pose(2, 69.2 + THROW.end), null);
  assert.equal(throwAt(scheduleThrows(events)["T01-5"], 69.1).u.toFixed(1), "-0.1");
});
