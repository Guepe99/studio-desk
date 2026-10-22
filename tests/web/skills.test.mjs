// web/js/ball3d.js BallPlan._skills: a player keeping a still ball plays small moves with it (sole
// roll, drag-back, step-over, feint), the ball goes back to its tracking point after each, and
// nobody plays with a ball laid down for a set piece. docs/flow3d.md, section 5.
//
//   node --test tests/web/skills.test.mjs        (M001 when exported, else the DEMO fixture)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Match } from "../../web/js/match.js";
import { BallPlan, legPose, LEG_WINDOW } from "../../web/js/ball3d.js";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/data");
function load(id) {
  const dir = path.join(DATA, id);
  if (!existsSync(path.join(dir, "meta.json"))) return null;
  const j = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const buf = readFileSync(path.join(dir, "tracking.f32"));
  return new Match(j("meta.json"), j("events.json"), j("facts.json"), j("cues.json"), new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

const SKILL = new Set(["roll", "drag", "stepover", "feint"]);
const SET = new Set(["freekick_crossed", "freekick_short", "shot_freekick", "shot_penalty", "goalkick", "corner_crossed", "corner_short", "throw_in"]);
const m = load("M001") ?? load("DEMO");
const span = [0, Math.min(m?.duration ?? 0, 1500)];
const plan = m && new BallPlan(m, span, { ballR: 0.11 });
const skills = () => [...plan.actors.entries()].flatMap(([i, A]) => A.legs.filter((l) => SKILL.has(l.kind)).map((l) => ({ i, ...l })));

test("players keeping a still ball play with it, with every kind of move", { skip: !m }, () => {
  const s = skills();
  assert.ok(s.length >= 20, `only ${s.length} moves in ${span[1]} s`);
  for (const k of SKILL) assert.ok(s.some((l) => l.kind === k), `no ${k}`);
  // each one in a stretch where the ball lies still before the same player's own kick
  const ev = [...m.events].sort((a, b) => a.ts - b.ts);
  for (const l of s) {
    const next = ev.find((e) => e.ts > l.t);
    assert.ok(next && m.index[next.player_id] === l.i, `move at ${l.t.toFixed(2)} by ${m.meta.entities[l.i]}, next on the ball ${next?.player_id}`);
    assert.ok(!SET.has(next.type_name), `move at ${l.t.toFixed(2)} before a ${next.type_name}`);
    assert.ok(next.ts - l.t >= 0.5 + LEG_WINDOW[l.kind][1] - 0.45, `move at ${l.t.toFixed(2)} runs into the kick at ${next.ts}`);
  }
});

test("the ball rolls under the foot and comes back, never jumps", { skip: !m }, () => {
  assert.ok(plan.moves.length > 5, `${plan.moves.length} ball moves`);
  for (const mv of plan.moves) {
    const off = (t) => { const d = plan._moved(t); return d ? Math.hypot(...d) : 0; };
    assert.ok(off(mv.t0) < 1e-9 && off(mv.t1 - 1e-6) < 1e-3, `move at ${mv.t0}: ends ${off(mv.t1 - 1e-6)} m off`);
    let prev = plan.ball(mv.t0 - 0.1), most = 0;
    for (let t = mv.t0 - 0.1; t <= mv.t1 + 0.1; t += 1 / 60) {
      const b = plan.ball(t);
      assert.ok(Math.hypot(b.x - prev.x, b.y - prev.y) < 0.05, `ball jumps at ${t.toFixed(3)}`);
      most = Math.max(most, off(t));
      prev = b;
    }
    assert.ok(most > 0.08 && most <= 0.3, `move at ${mv.t0}: ball goes ${most.toFixed(2)} m`);
  }
  assert.ok(plan.check(span[0] + 1, span[1] - 1).worst < 1.5);
});

test("the same moment gets the same moves, and the leg poses are within a joint's range", { skip: !m }, () => {
  const again = new BallPlan(m, span, { ballR: 0.11 });
  assert.deepEqual(again.moves, plan.moves);
  for (const kind of SKILL) {
    const [pre, post] = LEG_WINDOW[kind];
    for (let t = -pre; t <= post; t += 0.02) {
      const { swing: [hip, knee, ankle] } = legPose(kind, t);
      assert.ok(hip > -0.6 && hip < 1.3 && knee >= 0 && knee < 2.4 && Math.abs(ankle) < 0.8, `${kind} at ${t.toFixed(2)}`);
    }
  }
});
