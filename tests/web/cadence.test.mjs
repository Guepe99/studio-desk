// web/js/scene3d/players.js: forward runs step at a person's cadence (stride warping), and the leg
// swing is cut by the same ratio so the planted foot keeps the ground speed.
//   node --test tests/web/cadence.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= { BABYLON: {} };
const P = await import("../../web/js/scene3d/players.js");

const group = () => ({ from: 0, to: 30, setWeightForAllAnimatables() {}, goToFrame() {} });
const player = () => ({
  // one leg bone so the warp is on (warpStride is not called here)
  anim: { loco: [group(), group(), group(), group()], cache: {}, legs: [{}], get: () => null, upper: () => null },
  phase: 0, idle: 0, w: [1, 0, 0, 0], aw: {}, holder: { isEnabled: () => true },
});
// steps per second of the forward loops over 2 s at ground speed v, and the last frame's warp
function run(v, mode = "forward") {
  const p = player(), dt = 1 / 60, r = { mode, action: null, emotion: null };
  let cycles = 0;
  for (let k = 0; k < 120; k++) {
    const before = p.phase;
    P.animatePlayer(p, v, dt, r, null);
    cycles += (((p.phase - before) % 1) + 1) % 1;
  }
  return { steps: (2 * cycles) / 2, warp: p.warp };
}

test("a jog and a run step at a person's cadence", () => {
  // people: 2.88 steps/s at 2.9 and 4.15 m/s, 3.04 at 5.07 m/s (docs/flow3d.md section 6)
  for (const [v, lo, hi] of [[3.66, 2.8, 2.96], [5.07, 2.95, 3.15], [2.9, 2.8, 2.96]]) {
    const { steps, warp } = run(v);
    assert.ok(steps >= lo && steps <= hi, `${v} m/s: ${steps.toFixed(2)} steps/s, want ${lo} to ${hi}`);
    assert.ok(warp && warp.s < 1 && warp.s >= 0.6, `${v} m/s: the leg swing is cut (${warp?.s})`);
  }
});

test("the swing is cut to a person's stride, so the stance foot keeps the ground speed", () => {
  // a person's stride (two steps) = 2 v / cadence: 2.88 steps/s at 2.9 and 4.15 m/s, 3.04 at
  // 5.07 m/s (docs/flow3d.md section 6). The cycle covers it, and the clip's stride (walk 1.24,
  // jog 5.0, sprint 6.0 m) times the warp's s is it too, within 3 %.
  for (const [v, cadence] of [[2.9, 2.88], [4.15, 2.88], [5.07, 3.04]]) {
    const { steps, warp } = run(v), person = (2 * v) / cadence;
    const w = P.clipWeights(v), clip = (w[1] * 1.24 + w[2] * 5.0 + w[3] * 6.0) / (w[1] + w[2] + w[3]);
    assert.ok(Math.abs((2 * v) / steps - person) < 0.03 * person, `${v} m/s: ${((2 * v) / steps).toFixed(2)} m per cycle, a person ${person.toFixed(2)}`);
    assert.ok(Math.abs(clip * warp.s - person) < 0.03 * person, `${v} m/s: the swing covers ${(clip * warp.s).toFixed(2)} m, a person ${person.toFixed(2)}`);
  }
});

test("a mode switch fades the warp and the cadence over frames, never in one", () => {
  const p = player(), dt = 1 / 60, r = { mode: "forward", action: null, emotion: null };
  // the warp's pull (1 - s) g on the legs, and the cadence's share of the cycle rate (1 / s)
  const pull = () => (p.warp ? (1 - p.warp.s) * p.warp.g : 0), speedUp = () => 1 / (p.warp?.s ?? 1);
  let prev = null, most = 0, mostUp = 0;
  for (let k = 0; k < 240; k++) {
    if (k === 120) r.mode = "backpedal";
    if (k === 180) r.mode = "forward";
    P.animatePlayer(p, 3.66, dt, r, null);
    if (prev && k > 60) { most = Math.max(most, Math.abs(pull() - prev[0])); mostUp = Math.max(mostUp, Math.abs(speedUp() - prev[1])); }
    prev = [pull(), speedUp()];
  }
  assert.ok(most < 0.1, `the warp's pull jumps ${most.toFixed(3)} in a frame`);
  assert.ok(mostUp < 0.15, `the cadence speed-up jumps ${mostUp.toFixed(3)} in a frame`);
});

test("without leg bones to warp, the cycle keeps the clip's cadence", () => {
  const p = player(), r = { mode: "forward", action: null, emotion: null };
  p.anim.legs = [];
  for (let k = 0; k < 60; k++) P.animatePlayer(p, 3.66, 1 / 60, r, null);
  assert.equal(p.warp, null);
});

test("slow walks and the stand-in modes keep the clip's cadence", () => {
  assert.equal(run(0.8).warp, null);
  assert.equal(run(3.66, "backpedal").warp, null);
  assert.equal(P.humanStride(0.5), null);
});
