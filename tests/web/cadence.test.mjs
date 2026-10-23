// web/js/scene3d/players.js: forward runs step at a person's cadence (stride warping), and the leg
// swing is cut by the same ratio so the planted foot keeps the ground speed.
//   node --test tests/web/cadence.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= { BABYLON: {} };
const P = await import("../../web/js/scene3d/players.js");

const group = () => ({ from: 0, to: 30, setWeightForAllAnimatables() {}, goToFrame() {} });
const player = () => ({
  anim: { loco: [group(), group(), group(), group()], cache: {}, legs: [], get: () => null, upper: () => null },
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

test("the swing is cut by the cadence ratio, so the stance foot keeps the ground speed", () => {
  // metres per cycle travelled = v / cycle rate; the clip's own stride times s
  const v = 3.66, { steps, warp } = run(v);
  const perCycle = (2 * v) / steps;
  const w = P.clipWeights(v), clip = (w[1] * 1.24 + w[2] * 5.0 + w[3] * 6.0) / (w[1] + w[2] + w[3]);
  assert.ok(Math.abs(perCycle - clip * warp.s) < 0.05, `${perCycle.toFixed(2)} m per cycle against ${(clip * warp.s).toFixed(2)}`);
});

test("slow walks and the stand-in modes keep the clip's cadence", () => {
  assert.equal(run(0.8).warp, null);
  assert.equal(run(3.66, "backpedal").warp, null);
  assert.equal(P.humanStride(0.5), null);
});
