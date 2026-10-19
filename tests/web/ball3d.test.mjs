// The kick poses of web/js/ball3d.js: legPose and the whole-body bodyPose (docs/motion3d.md).
//
//   node --test tests/web/ball3d.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { legPose, bodyPose, LEG_WINDOW } from "../../web/js/ball3d.js";

const D = 180 / Math.PI;
const KINDS = Object.keys(LEG_WINDOW);
const span = (kind, step = 1 / 30) => { const [pre, post] = LEG_WINDOW[kind], out = []; for (let t = -pre; t <= post + 1e-9; t += step) out.push(t); return out; };

test("every layer fades in and out with the leg action and is full at contact", () => {
  for (const kind of KINDS) {
    const [pre, post] = LEG_WINDOW[kind];
    for (const t of [-pre, post]) { assert.equal(legPose(kind, t).w, 0, kind); assert.equal(bodyPose(kind, t).w, 0, kind); }
    assert.equal(legPose(kind, 0).w, 1, kind);
    assert.equal(bodyPose(kind, 0).w, 1, kind);
  }
});

// a pop, not a fast kick: the knee of a real kick extends at 1200-1400 deg/s, about 45 degrees a
// frame, and a sprinter's arm swings at about 600 deg/s: the legs may move 45 degrees a frame and
// the trunk and arms 20
test("no joint jumps between two 30 fps frames", () => {
  for (const kind of KINDS) {
    const flat = (t) => { const l = legPose(kind, t), b = bodyPose(kind, t);
      return [...l.swing, ...l.support, b.pelvis, b.shoulders, b.lean, b.bend, ...b.free, ...b.kick].map((v) => v * D); };
    let prev = null;
    for (const t of span(kind)) {
      const cur = flat(t);
      if (prev) cur.forEach((v, j) => assert.ok(Math.abs(v - prev[j]) < (j < 8 ? 45 : 20), `${kind} channel ${j} at ${t.toFixed(2)} s: ${prev[j].toFixed(1)} -> ${v.toFixed(1)}`));
      prev = cur;
    }
  }
});

test("shot, short pass and long ball read as different actions", () => {
  const peak = (kind, f) => Math.max(...span(kind).map((t) => f(t)));
  const at0 = (kind) => bodyPose(kind, 0);
  // the shot has the biggest backswing; the pass the smallest of the kicks
  const back = (kind) => peak(kind, (t) => -legPose(kind, t).swing[0] * D);
  assert.ok(back("shot") > back("long") && back("long") > back("pass") + 10);
  // the pass is a side-foot kick: the kicking thigh turned out much more than in the instep kicks
  assert.ok(legPose("pass", 0).swing[3] * D >= 45 && legPose("shot", 0).swing[3] * D < 15);
  // the free arm goes out wide on the shot and the long ball, stays close on the pass and the touches
  const arm = (kind) => peak(kind, (t) => bodyPose(kind, t).free[0] * D);
  assert.ok(arm("shot") >= 80 && arm("long") >= 80 && arm("pass") < 35 && arm("touch") < 20);
  // trunk over the ball on the shot, back on the long ball, upright on the pass
  assert.ok(at0("shot").lean * D > 5 && at0("long").lean * D < -5 && Math.abs(at0("pass").lean * D) < 8);
  // the tension arc: at the top of the backswing the hips and the shoulders turn opposite ways,
  // after contact both have turned through
  const top = bodyPose("shot", -0.11), after = bodyPose("shot", 0.14);
  assert.ok(top.pelvis < 0 && top.shoulders > 0 && after.pelvis > 0 && after.shoulders < 0);
  // the touches move the arms only through the clips
  assert.equal(bodyPose("touch", 0).wa, 0);
});

test("the plant leg lands ahead of the body and the body rolls over it", () => {
  for (const kind of ["shot", "long", "pass"]) {
    const hip = (t) => legPose(kind, t).support[0] * D;
    assert.ok(hip(-0.12) > hip(0) && hip(0) > hip(0.14), kind);
  }
});
