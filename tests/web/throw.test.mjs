// web/js/scene3d/players.js: the throw-in driver. The taker picks the ball up when he reaches it,
// carries it, raises it over his head and throws on the event time.
//   node --test tests/web/throw.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.window ??= { BABYLON: {} };
const { scheduleThrows, throwAt, throwDriver, THROW, offset, resolve, animatePlayer } = await import("../../web/js/scene3d/players.js");
const { Match } = await import("../../web/js/match.js");
const { smoothMatch, rootAt } = await import("../../web/js/scene3d/track.js");

const events = [
  { type_name: "pass", player_id: "T01-4", ts: 50, start_x: 50, start_y: 30, end_x: 52, end_y: 68 },
  { type_name: "throw_in", player_id: "T01-5", ts: 69.2, start_x: 52.25, start_y: 68, end_x: 58, end_y: 63 },
];
const match = { meta: { entities: ["ball", "T01-4", "T01-5"] } };

// Positions: the ball rolls out and stops at the line at 54 s; the taker walks to it and stands
// beside it from 56 s, 13.2 s before the throw (a top-flight throw-in waits 15 to 18 s).
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
    assert.equal(T.ball, null);   // nothing to draw him to: he picks it up where he stands
  }
  // 8 m from the ball, he is never pulled to it
  const d = throwDriver(late, scheduleThrows(events, late));
  for (let t = 60; t < 69.2; t += 1 / 60) assert.ok(!d.pose(2, t)?.dx, `drawn at ${t.toFixed(2)}`);
});

// The scene's step for the taker at 60 Hz (scene3d.js): the shown root (rootAt) plus the driver's
// offset, and the animation from the shown speed and the tracking's. From p = -1 to the release:
// the largest move in a frame (m) and the largest one-frame change of the crouch's full-body share.
function followTaker(m, th, drv, root = null) {
  const i = m.index[th.pid], dt = 1 / 60, H = 0.05;
  const group = () => ({ from: 0, to: 30, setWeightForAllAnimatables() {}, goToFrame() {} });
  const cache = {};
  const p = { anim: { loco: [group(), group(), group(), group()], cache, legs: [], get: (k) => (cache[k] ??= group()), upper: () => null }, phase: 0, idle: 0, w: [1, 0, 0, 0], aw: {}, holder: { isEnabled: () => true } };
  const at = (t, off = true) => { const q = m.at(i, t), o = off ? offset(drv, i, t) : [0, 0]; return q && [q[0] + o[0], q[1] + o[1]]; };
  const speed = (off) => (t) => { const a = at(t - H, off), c = at(t + H, off); return Math.hypot(c[0] - a[0], c[1] - a[1]) / (2 * H); };
  let prev = null, move = 0, crouch = 0;
  for (let t = th.pick - 2; t <= th.ts; t += dt) {
    const q = root ? root(t) : m.at(i, t), o = offset(drv, i, t), s = [q[0] + o[0], q[1] + o[1]];
    const r = resolve(drv, i, t);
    r.vTrack = speed(false)(t);
    animatePlayer(p, speed(true)(t), dt, r, null);
    const w = 1 - p.w.reduce((a, b) => a + b, 0);
    if (prev && t >= th.pick - 1) { move = Math.max(move, Math.hypot(s[0] - prev[0], s[1] - prev[1])); crouch = Math.max(crouch, Math.abs(w - prev[2])); }
    prev = [s[0], s[1], w];
  }
  return { move, crouch };
}

test("drawn to the ball, the taker never moves 5 cm in a frame and the crouch blends in", () => {
  const sched = scheduleThrows(events, tracked), [T] = sched["T01-5"];
  const { move, crouch } = followTaker(tracked, { ...T, pid: "T01-5" }, [throwDriver(tracked, sched)]);
  assert.ok(move < 0.05, `moves ${move.toFixed(3)} m in a frame`);
  assert.ok(crouch < 0.1, `the crouch's share jumps ${crouch.toFixed(3)} in a frame`);
});

test("a taker who runs to the ball picks it up once he has slowed down", () => {
  // he runs in at 5 m/s, reaches the ball at 56 s and steps 0.2 m beside it at 1 m/s
  const run = { ...tracked, at: (i, t) => (i === 2 ? (t < 56 ? lerp([22.25, 67.4], [52.25, 67.4], clamp((t - 50) / 6)) : lerp([52.25, 67.4], [52.25, 67.6], clamp((t - 56) / 0.2))) : tracked.at(i, t)) };
  const sched = scheduleThrows(events, run), [T] = sched["T01-5"];
  // a second after the run, not THROW.after from reaching the ball
  assert.ok(T.ball && T.pick > 57 && T.pick < 57.5, `pick-up at ${T.pick}`);
  const { move, crouch } = followTaker(run, { ...T, pid: "T01-5" }, [throwDriver(run, sched)]);
  assert.ok(move < 0.05, `moves ${move.toFixed(3)} m in a frame`);
  assert.ok(crouch < 0.1, `the crouch's share jumps ${crouch.toFixed(3)} in a frame`);
});

// On the exported matches: every throw-in, the shown root as the scene draws it.
const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/data");
// under CI the export must be there: a missing match fails instead of shrinking the list
const IDS = ["M001", "M002", "M003", "M004"].filter((id) => process.env.CI || existsSync(path.join(DATA, id, "meta.json")));
test("on the exported matches every taker moves under 5 cm a frame from a second before the pick-up to the release", { skip: !IDS.length }, () => {
  for (const id of IDS) {
    const dir = path.join(DATA, id), j = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    const buf = readFileSync(path.join(dir, "tracking.f32"));
    const m = smoothMatch(new Match(j("meta.json"), j("events.json"), j("facts.json"), j("cues.json"), new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)));
    const sched = scheduleThrows(m.events, m), drv = [throwDriver(m, sched)];
    let n = 0;
    for (const [pid, list] of Object.entries(sched)) for (const th of list) {
      const { move, crouch } = followTaker(m, { ...th, pid }, drv, (t) => rootAt(m, m.index[pid], t, 20));
      assert.ok(move < 0.05, `${id} ${pid} throw at ${th.ts}: moves ${move.toFixed(3)} m in a frame`);
      assert.ok(crouch < 0.1, `${id} ${pid} throw at ${th.ts}: the crouch's share jumps ${crouch.toFixed(3)} in a frame`);
      n++;
    }
    assert.ok(n > 20, `${id}: ${n} throw-ins`);
  }
});
