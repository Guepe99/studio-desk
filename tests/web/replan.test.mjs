// The window plans of the 3D view built in slices between frames (slices.js, view3d.js _replan):
// the same plans as built at once, and no slice holds the page for long.
//
//   node --test tests/web/replan.test.mjs        (web/data/M001-M004: the static export)
//
// planning() is Scene3D.planning without Babylon: the ball plan, then the awareness layer and the
// keeper reactions on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Match } from "../../web/js/match.js";
import { smoothMatch } from "../../web/js/scene3d/track.js";
import { BallPlan } from "../../web/js/ball3d.js";
import { Awareness } from "../../web/js/awareness.js";
import { planKeeper } from "../../web/js/keeper3d.js";
import { run, slices, SLICE_MS } from "../../web/js/slices.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = path.join(ROOT, "web/data");
const motion = JSON.parse(readFileSync(path.join(ROOT, "web/vendor/motion/clips.json"), "utf8"));
function load(id) {
  const dir = path.join(DATA, id);
  if (!existsSync(path.join(dir, "meta.json"))) return null;
  const j = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const buf = readFileSync(path.join(dir, "tracking.f32"));
  return smoothMatch(new Match(j("meta.json"), j("events.json"), j("facts.json"), j("cues.json"), new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)));
}
const IDS = ["M001", "M002", "M003", "M004"];
const M = Object.fromEntries(IDS.map((id) => [id, load(id)]));
const skip = IDS.some((id) => !M[id]) && !process.env.CI && "no web/data/M001-M004";

const now = (m, span) => {
  const ball = new BallPlan(m, span, { ballR: 0.11 });
  return { ball, aw: new Awareness(m, span, { ball: (t) => ball.ball(t), motion }), kr: planKeeper(m, (t) => ball.ball(t), { ballR: 0.11, span }) };
};
function* planning(m, span) {
  const ball = new BallPlan(m, span, { ballR: 0.11, sliced: true });
  yield* ball.steps;
  const aw = new Awareness(m, span, { ball: (t) => ball.ball(t), motion, sliced: true });
  yield* aw.steps;
  return { ball, aw, kr: planKeeper(m, (t) => ball.ball(t), { ballR: 0.11, span }) };
}
const sliced = (m, span) => new Promise((ok) => slices(planning(m, span), SLICE_MS, ok));

// Everything the scene reads from the plans, every 0.05 s of the window, and their tables.
function fingerprint(m, span, { ball, aw, kr }) {
  const h = createHash("sha256"), put = (x) => h.update(JSON.stringify(x) ?? "-");
  for (const a of [ball.quats, aw.fy, aw.fw, aw.hy, aw.hp, aw.mode, aw.live]) h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  put([ball.zGround, ball.segs, ball.moves, [...ball.actors], ball.nets, ball.holds, ball.falls, aw.emotions, aw.joins, kr]);
  for (let t = span[0] + 0.013; t < span[1]; t += 0.05) {
    put([ball.ball(t), ball.net(t)]);
    for (let i = 1; i < m.n; i++) put([ball.pose(i, t), aw.pose(i, t), aw.look(i, t)]);
  }
  return h.digest("hex");
}

test("the plans built in slices are the plans built at once, value by value", { skip }, async () => {
  for (const id of IDS) {
    const m = M[id], d = m.duration;
    for (const span of [[0, 105], [585, 705], [3000, 3120], [d - 120, d], [1200, 2160]]) {
      const a = fingerprint(m, span, now(m, span)), b = fingerprint(m, span, await sliced(m, span));
      assert.equal(b, a, `${id} [${span.map((x) => x.toFixed(0))}]: the sliced plan differs`);
      console.log(`${id} [${span.map((x) => x.toFixed(0))}] ${a.slice(0, 16)}`);
    }
  }
});

test("a window plan never holds the page for more than 20 ms at a time", { skip: !M.M001 && !process.env.CI && "no web/data/M001" }, async () => {
  const m = M.M001;
  run(planning(m, [0, 120]));   // the page plans its first window at load, before play: the code is warm
  // A task runs steps until SLICE_MS of wall clock have passed, so it holds the page for at most SLICE_MS plus
  // one step: every step must stay under 20 - SLICE_MS ms. The plan is built five times, keeping each step's
  // fastest on the wall clock: other processes stretch a step at random, never the same one five times. Not the
  // thread's CPU clock: on the build VPS (KVM, no steal accounting) it moves in jumps of about 70 ms.
  const timed = function* (steps, ms) {
    for (let k = 0; ; k++) {
      const w = performance.now(), r = steps.next();
      ms[k] = Math.min(ms[k] ?? Infinity, performance.now() - w);
      if (r.done) return r.value;
      yield;
    }
  };
  for (const span of [[585, 705], [2400, 2520], [4000, 4120]]) {
    const ms = [];
    for (let n = 0; n < 5; n++) await new Promise((ok) => slices(timed(planning(m, span), ms), SLICE_MS, ok));
    const k = ms.indexOf(Math.max(...ms));
    console.log(`M001 [${span}]: ${ms.length} steps, the longest ${ms[k].toFixed(1)} ms (step ${k})`);
    assert.ok(ms[k] < 20 - SLICE_MS, `M001 [${span}]: step ${k} held the page for ${ms[k].toFixed(1)} ms`);
  }
});

test("slices: stop drops the plan, finish builds the rest at once", async () => {
  function* count() { let n = 0; for (let k = 0; k < 1e5; k++) { n += k; yield; } return n; }
  let got = null;
  const job = slices(count(), 1, (v) => { got = v; });
  job.stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got, null);
  const next = slices(count(), 1, (v) => { got = v; });
  await new Promise((r) => setTimeout(r, 5));
  next.finish();
  assert.equal(got, run(count()));
});
