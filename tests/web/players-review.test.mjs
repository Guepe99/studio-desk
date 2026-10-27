// The players (docs/flow3d.md section 9): speed and smoothing stop at half time,
// the motion loops hold and cross-fade, the head look gives way to the clips by their weight,
// strides scale with the player's height, a seek faces from match time alone, and chained
// celebration variants never dip.
//   node --test tests/web/players-review.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), DATA = path.resolve(HERE, "../../web/data");
// the real Babylon (math only, no engine): awareness-rig.js builds vectors at import
globalThis.window ??= { BABYLON: createRequire(import.meta.url)("../../web/vendor/babylonjs/9.29.0/babylon.js") };
const { Match } = await import("../../web/js/match.js");
const T = await import("../../web/js/scene3d/track.js");
const P = await import("../../web/js/scene3d/players.js");
const { Awareness } = await import("../../web/js/awareness.js");
const { AwarenessRig } = await import("../../web/js/awareness-rig.js");

const MOTION_FILE = path.resolve(HERE, "../../web/vendor/motion/clips.json");
const motion = existsSync(MOTION_FILE) ? JSON.parse(readFileSync(MOTION_FILE, "utf8")) : null;
const D = Math.PI / 180;
const angle = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
function load(id) {
  const dir = path.join(DATA, id);
  if (!existsSync(path.join(dir, "meta.json"))) return null;
  const j = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const buf = readFileSync(path.join(dir, "tracking.f32"));
  return new Match(j("meta.json"), j("events.json"), j("facts.json"), j("cues.json"), new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

// half time: the tracking jumps between the last frame of the first half and the first of the
// second (the players walk off and come back); the scene's speed (+-0.05 s) and root must not
// read the jump as a sprint
for (const id of ["M001", "M002", "M003", "M004"]) {
  const raw = load(id);
  test(`${id}: no speed or root artefact within 0.5 s of half time`, { skip: !raw && !process.env.CI && `no web/data/${id}` }, () => {
    const m = T.smoothMatch(raw), fps = raw.meta.fps, half = raw.meta.period1_s, H = Math.round(half * fps);
    const segV = (i, k) => { const o0 = (k * raw.n + i) * 3, o1 = o0 + raw.n * 3; return Math.hypot(raw.pos[o1] - raw.pos[o0], raw.pos[o1 + 1] - raw.pos[o0 + 1]) * fps; };
    let n = 0, art = 0, worst = 0, off = 0;
    for (let i = 1; i < raw.n; i++) {
      for (let ts = half - 0.5; ts <= half + 0.5; ts += 1 / 60) {
        const now = T.rootAt(m, i, ts, 20);
        if (!now) continue;
        n++;
        const v = Math.hypot(...T.velocityAt(m, (t) => m.at(i, t), ts, 0.05, now));
        // within the speeds of the sample segments around ts, on its own side of the whistle
        const k = Math.floor(ts * fps), side = ts < half ? [0, H - 2] : [H, raw.meta.frames - 2];
        const vs = [k - 1, k, k + 1].map((x) => segV(i, Math.min(side[1], Math.max(side[0], x)))).filter(Number.isFinite);
        const out = Math.max(0, v - Math.max(...vs), Math.min(...vs) - v);
        if (out > 0.5) art++;
        worst = Math.max(worst, out);
        // the samples' own path (the last 0.1 s of the first half has none: it runs into the jump)
        if (!(ts > half - 0.1 && ts < half)) { const l = raw.at(i, ts); if (l) off = Math.max(off, Math.hypot(now[0] - l[0], now[1] - l[1])); }
      }
    }
    assert.ok(n > 1000, `${n} player-frames`);
    assert.equal(art, 0, `${art} of ${n} player-frames with a speed artefact over 0.5 m/s (worst ${worst.toFixed(1)} m/s)`);
    assert.ok(off < 0.05, `the root is ${off.toFixed(3)} m off the samples`);
  });
}

test("a motion loop holds past the diagonal, both ways (hysteresis)", { skip: !motion && !process.env.CI && "no clips.json" }, () => {
  // turn the run in the character's frame from the backward loop's travel to the left sidestep's
  // and back, 0.5 degree a step, and note where the loop changes
  const a0 = Math.atan2(...motion.clips.M_jog_backward.dir), a1 = Math.atan2(...motion.clips.M_sidestep_left.dir);
  const at = (a) => [Math.sin(a), Math.cos(a)];
  const steps = Math.round(Math.abs(angle(a0, a1)) / (0.5 * D)), da = angle(a0, a1) / steps;
  let loop = P.motionLoop(motion, "backpedal", at(a0)), there = null, back = null;
  for (let s = 1; s <= steps; s++) { const l = P.motionLoop(motion, "backpedal", at(a0 + s * da), loop); if (l !== loop && there === null) there = s; loop = l; }
  assert.equal(loop, "M_sidestep_left");
  for (let s = steps - 1; s >= 0; s--) { const l = P.motionLoop(motion, "backpedal", at(a0 + s * da), loop); if (l !== loop && back === null) back = s; loop = l; }
  assert.equal(loop, "M_jog_backward");
  const gap = (there - back) * Math.abs(da) / D;
  assert.ok(gap >= 15, `the loop changes at the same angle both ways (gap ${gap.toFixed(1)} degrees)`);
});

const group = () => ({ from: 0, to: 30, setWeightForAllAnimatables() {}, goToFrame() {} });
function player(h) {
  const cache = {};
  return { h, phase: 0, idle: 0, w: [1, 0, 0, 0], aw: {}, holder: { isEnabled: () => true },
    anim: { loco: [group(), group(), group(), group()], cache, legs: [{}], get: (n) => (cache[n] ??= group()), upper: () => null } };
}

test("a change of motion loop is a cross-fade, never a swap in one frame", { skip: !motion && !process.env.CI && "no clips.json" }, () => {
  const p = player(1), dt = 1 / 60, L = ["M_jog_backward", "M_sidestep_left", "M_sidestep_right"];
  const r = { mode: "backpedal", action: null, emotion: null, runL: motion.clips.M_jog_backward.dir };
  const share = () => { const s = L.reduce((t, n) => t + (p.aw[n] ?? 0), 0); return L.map((n) => (p.aw[n] ?? 0) / s); };
  let prev = null, most = 0;
  for (let k = 0; k < 120; k++) {
    if (k === 60) r.runL = motion.clips.M_sidestep_left.dir;
    P.animatePlayer(p, 2.5, dt, r, motion);
    const s = share();
    if (prev && k > 30) most = Math.max(most, ...s.map((x, j) => Math.abs(x - prev[j])));
    prev = s;
  }
  assert.ok(prev[1] > 0.95, `the new loop is in after 1 s (${prev[1].toFixed(2)})`);
  assert.ok(most < 0.2, `a loop's share moves by ${most.toFixed(2)} in a frame`);
});

test("strides scale with the player's height: a taller player steps less often at the same speed", { skip: !motion && !process.env.CI && "no clips.json" }, () => {
  // cycles per second of the forward run and of the backpedal loop at the same ground speed
  function rate(h, mode) {
    const p = player(h), dt = 1 / 60, r = { mode, action: null, emotion: null, runL: motion.clips.M_jog_backward.dir };
    let cycles = 0;
    for (let k = 0; k < 120; k++) {
      const before = mode === "forward" ? p.phase : p.lphase ?? 0;
      P.animatePlayer(p, mode === "forward" ? 3.66 : 2.0, dt, r, motion);
      if (k >= 60) cycles += ((((mode === "forward" ? p.phase : p.lphase) - before) % 1) + 1) % 1;
    }
    return cycles;
  }
  for (const mode of ["forward", "backpedal"]) {
    const ratio = rate(1.12, mode) / rate(1, mode);
    assert.ok(Math.abs(ratio - 1 / 1.12) < 0.01, `${mode}: a player 12 % taller steps at ${ratio.toFixed(3)} of the cadence, want ${(1 / 1.12).toFixed(3)}`);
  }
});

test("after a seek the facing is a function of match time, whatever was shown before", () => {
  assert.equal(typeof P.wantFacing, "function", "players.js exports wantFacing");
  const ball = [10, 5], at = [10.5, 5];   // the ball at his feet, he is nearly still
  const fresh = { yaw: null }, stale = { yaw: 2, want: 2, running: true };   // he was running elsewhere
  const seek = { v: 0.3, vx: 0.3, vy: 0, mode: "forward", ball, at, dt: 0 };
  const a = P.wantFacing(fresh, seek), b = P.wantFacing(stale, seek), toBall = Math.atan2(ball[0] - at[0], ball[1] - at[1]);
  assert.ok(Math.abs(angle(a, toBall)) < 1e-9 && Math.abs(angle(b, toBall)) < 1e-9, `a seek faces the ball: ${a}, ${b}, want ${toBall}`);
  // no ball: the centre spot
  const c = P.wantFacing({ yaw: 1, want: 1 }, { ...seek, ball: null }), centre = Math.atan2(52.5 - at[0], 34 - at[1]);
  assert.ok(Math.abs(angle(c, centre)) < 1e-9, `${c}, want ${centre}`);
  // playing on, the ball at his feet keeps the facing he had (its bearing swings at random)
  assert.equal(P.wantFacing(stale, { ...seek, dt: 1 / 60, ball: [at[0] + 0.01, at[1]] }), b);
});

test("the run facing has hysteresis: speed noise round the threshold does not flip it", () => {
  const p = { yaw: 0 }, ball = [0, 30], at = [0, 0], run = (v) => P.wantFacing(p, { v, vx: v, vy: 0, mode: "forward", ball, at, dt: 1 / 60 });
  const away = Math.PI / 2, toBall = 0;   // running along +x, the ball along +y
  assert.ok(Math.abs(run(1.2) - away) < 1e-9);
  for (const v of [0.85, 0.75, 0.8, 0.72]) assert.ok(Math.abs(run(v) - away) < 1e-9, `${v} m/s flips to the ball`);
  assert.ok(Math.abs(run(0.5) - toBall) < 1e-9);
  for (const v of [0.75, 0.85, 0.8]) assert.ok(Math.abs(run(v) - toBall) < 1e-9, `${v} m/s flips to the run`);
});

// AwarenessRig._post with a stub chain: the yaw it turns the neck by, for an emotion, an event
// action or a head clip at a given weight
function lookTurn({ emotion = null, actionW = 0, upper = null }) {
  const rig = Object.create(AwarenessRig.prototype);
  let yaw = 0;
  rig.s = { ts: 1, drivers: actionW ? [{ priority: 30, pose: () => ({ action: { clip: "x" }, actionW }) }] : [] };
  rig.enabled = true;
  rig.aw = { emotion: () => emotion, look: () => ({ yaw: 0.6, pitch: 0 }) };
  rig.headDir = () => ({ yaw: 0, pitch: 0 });
  const p = { i: 1, holder: { isEnabled: () => true, rotation: { y: 0 } }, upper };
  rig.players = new Map([[1, { p, c: { turn: (bone, axis, a) => { if (axis.y === 1) yaw += a; } } }]]);
  rig._post();
  return yaw;
}

test("the head look gives way to the clips by their weight, never all at once", () => {
  for (const w of [0, 0.25, 0.5, 0.75, 1]) {
    const want = 0.6 * (1 - w);
    const e = lookTurn({ emotion: { clip: "M_celeb_arms_wide", weight: w } });
    const a = lookTurn({ actionW: w });
    const h = lookTurn({ upper: { clip: "Idle_No_Loop", weight: w } });
    // the head clip fading out under the next gesture as that one comes in by w: the look comes back by w
    const under = lookTurn({ upper: { clip: "SD_HandsOnHips", weight: 1 - w, under: { clip: "Idle_No_Loop", t: 2.5, weight: 1, fadeOut: true } } });
    for (const [what, got] of [["emotion", e], ["action", a], ["head clip", h], ["head clip fading out", under]]) assert.ok(Math.abs(got - want) < 1e-9, `${what} at weight ${w}: the head turns ${got.toFixed(3)}, want ${want.toFixed(3)}`);
  }
  // an SD_ gesture (no head keys) leaves the look alone
  assert.ok(Math.abs(lookTurn({ emotion: { clip: "SD_ArmsUp", weight: 1 } }) - 0.6) < 1e-9);
});

const demo = load("DEMO");
test("chained celebration variants overlap: the emotion never dips between two", { skip: !(demo && motion) && !process.env.CI && "no DEMO or clips.json" }, () => {
  const aw = new Awareness(demo, [0, demo.duration], { motion });
  const by = new Map();
  for (const e of aw.emotions) (by.get(e.i) ?? by.set(e.i, []).get(e.i)).push(e);
  let pairs = 0, low = 1;
  for (const list of by.values()) {
    for (let k = 1; k < list.length; k++) {
      const a = list[k - 1], b = list[k];
      // the next variant of the same window starts by the time the last one ends
      if (a.src !== b.src || a.kind !== b.kind || b.t0 > a.t0 + a.dur + 1e-6) continue;
      pairs++;
      for (let ts = b.t0 - 0.3; ts <= b.t0 + 0.3; ts += 0.01) {
        const at = aw.emotionAt(b.i, ts);
        if (at !== a && at !== b) continue;   // something stronger in between
        const q = aw.emotion(b.i, ts), cover = Math.max(q.weight, q.under?.fadeOut ? q.under.weight : 0);
        low = Math.min(low, cover);
      }
    }
  }
  assert.ok(pairs > 0, "the fixture has chained variants");
  assert.ok(low > 0.99, `the emotion's weight dips to ${low.toFixed(2)} between two of ${pairs} chained variants`);
});
