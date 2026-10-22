// web/js/scene3d/players.js: the throw-in driver. The taker picks the ball up when he reaches it,
// carries it, raises it over his head and throws on the event time.
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

// Positions: the ball rolls out and stops at the line at 54 s; the taker walks to it and stands
// beside it from 56 s, 13.2 s before the throw (a Premier League throw-in waits 15 to 18 s).
const lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
const clamp = (u) => Math.min(1, Math.max(0, u));
const tracked = {
  ...match,
  index: { ball: 0, "T01-4": 1, "T01-5": 2 },
  at(i, t) {
    if (i === 0) return lerp([50, 60], [52.25, 68], clamp((t - 50) / 4));
    if (i === 2) return lerp([40, 60], [52.25, 67.4], clamp((t - 48) / 8));
    return [50, 30];
  },
};

test("only throw-ins are scheduled, facing where the ball goes", () => {
  const s = scheduleThrows(events);
  assert.deepEqual(Object.keys(s), ["T01-5"]);
  assert.ok(Math.abs(s["T01-5"][0].yaw - Math.atan2(5.75, -5)) < 1e-9);
});

test("the thrower raises the ball, holds it over his head and lets go at the event", () => {
  const d = throwDriver(match, scheduleThrows(events));
  assert.equal(d.pose(1, 69), null);                           // nobody else throws
  const raising = d.pose(2, 69.2 + THROW.start + THROW.raise / 2), held = d.pose(2, 69.1);
  assert.equal(held.emotion.clip, THROW.clip);
  assert.ok(held.emotion.upper && held.emotion.weight === 1 && held.emotion.t === THROW.up);
  assert.ok(raising.emotion.t > THROW.lift && raising.emotion.t < THROW.up);
  const after = d.pose(2, 69.2 + THROW.end / 2);
  assert.ok(after.emotion.weight > 0 && after.emotion.weight < 1);   // the arms come down after the release
  assert.equal(d.pose(2, 69.2 + THROW.end), null);
  assert.equal(throwAt(scheduleThrows(events)["T01-5"], 69.1).u.toFixed(1), "-0.1");
});

test("the taker picks the ball up when he reaches it and carries it to the throw", () => {
  const [T] = scheduleThrows(events, tracked)["T01-5"];
  // he stands at the still ball from 56 s: the hands close on it within a second, not at the raise
  assert.ok(T.pick > 56 && T.pick < 57, `pick-up at ${T.pick}`);
  assert.ok(Math.hypot(T.ball[0] - 52.25, T.ball[1] - 68) < 1e-6);
  const d = throwDriver(tracked, scheduleThrows(events, tracked));
  assert.equal(d.pose(2, T.pick - THROW.down - 0.05), null);   // walking to the ball: nothing
  const down = d.pose(2, T.pick);
  assert.equal(down.emotion.clip, THROW.crouch);                // he crouches to the ball
  assert.ok(down.emotion.full && down.emotion.weight > 0.9);
  assert.ok(down.yawW > 0.5 && Math.hypot(down.dx, down.dy) > 0.1);   // drawn to it, facing it
  for (const t of [T.pick + 2, 62, 66, 69.2 + THROW.start - 0.1]) {
    const c = d.pose(2, t);
    assert.equal(c.emotion.clip, THROW.carry, `carry at ${t}`);
    assert.ok(c.emotion.upper && c.emotion.weight === 1 && !c.dx, `carry at ${t}`);
  }
  // the raise blends over the carry, and the throw still leaves on the event time
  const r = d.pose(2, 69.2 + THROW.start + 0.15);
  assert.equal(r.emotion.clip, THROW.clip);
  assert.ok(r.emotion.under.clip === THROW.carry && r.emotion.under.weight === 1);
  assert.ok(throwAt(scheduleThrows(events, tracked)["T01-5"], 69.2 + THROW.end - 0.01).u > 0);
});

test("without positions, or when he never stands at the ball, the pick-up comes just before the raise", () => {
  const late = { ...tracked, at: (i, t) => (i === 2 ? [52.25, 60] : tracked.at(i, t)) };
  for (const m of [null, late]) {
    const [T] = scheduleThrows(events, m)["T01-5"];
    assert.ok(Math.abs(T.pick - (69.2 + THROW.start - THROW.rise - 0.1)) < 1e-9);
  }
});
