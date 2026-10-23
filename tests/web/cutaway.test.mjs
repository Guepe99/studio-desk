// Crowd and stadium cutaways at stoppages (web/js/scene3d/cutaway.js, docs/broadcast3d.md section 1).
//   node --test tests/web/cutaway.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Match } from "../../web/js/match.js";
import { cutawayPlan, cutawayShot, tightStops, CUTAWAY, RESTARTS } from "../../web/js/scene3d/cutaway.js";
import { replays } from "../../web/js/view3d.js";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/data");
function load(id) {
  const dir = path.join(DATA, id);
  if (!existsSync(path.join(dir, "meta.json"))) return null;
  const j = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const buf = readFileSync(path.join(dir, "tracking.f32"));
  return new Match(j("meta.json"), j("events.json"), j("facts.json"), j("cues.json"), new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

const m = load("M001");
test("M001: cutaways only in dead time, never over a tight shot or a replay, back before the restart", { skip: !m && "no web/data/M001" }, () => {
  const plan = cutawayPlan(m), again = cutawayPlan(load("M001"));
  assert.deepEqual(plan, again, "the same match gives the same plan");
  const half = m.meta.period1_s, per = [plan.filter((c) => c.from < half).length, plan.filter((c) => c.from >= half).length];
  // regularly, not once a half, and not at every stoppage
  const stoppages = m.events.filter((e) => RESTARTS.has(e.type_name)).length;
  assert.ok(per.every((n) => n >= 8), `cutaways per half ${per}`);
  assert.ok(plan.length < stoppages * 0.7, `${plan.length} cutaways for ${stoppages} stoppages`);
  assert.ok(new Set(plan.map((c) => c.kind)).size >= 3, "at least three kinds of shot");
  const busy = [...tightStops(m).map(([a, b]) => [a, b]), ...replays(m).map((r) => [r.from, r.to])];
  for (const [k, c] of plan.entries()) {
    // no event inside the shot: the ball is dead throughout
    assert.ok(!m.events.some((e) => e.ts >= c.from && e.ts <= c.to), `event during the cutaway at ${c.from}`);
    const next = m.events.find((e) => e.ts > c.from);
    assert.ok(RESTARTS.has(next.type_name) && next.ts === c.restart, `the next event at ${c.from} is the restart`);
    // the numbers of docs/broadcast3d.md, not the module's own: 4 s before a throw-in, 3 s before the rest
    assert.ok(next.ts - c.to >= (next.type_name === "throw_in" ? 4 : 3) - 1e-9,
      `back ${(next.ts - c.to).toFixed(2)} s before the ${next.type_name}`);
    // the ball is off the pitch or a foul was whistled before the cut
    const prev = m.events.filter((e) => e.ts < c.from).at(-1);
    const b = m.at(0, c.from), off = b[0] < 0 || b[0] > 105 || b[1] < 0 || b[1] > 68;
    assert.ok(off || ["foul", "keeper_save"].includes(prev.type_name) || c.from - prev.ts >= 2 + CUTAWAY.after - 1e-9, `ball in play at ${c.from}`);
    for (const [a, z] of busy) assert.ok(c.to <= a || c.from >= z, `cutaway ${c.from}-${c.to} overlaps ${a}-${z}`);
    // the stadium shot never comes straight from a depth-of-field shot (its sky flashes green)
    if (c.kind === "stadium") assert.ok(!busy.some(([, z]) => Math.abs(z - c.from) < 1e-6), `stadium straight from a tight shot at ${c.from}`);
    if (k) assert.ok(c.from - plan[k - 1].to >= CUTAWAY.gap[0] - 1e-9 && c.kind !== plan[k - 1].kind, `spacing and variety at ${c.from}`);
    // the shot is defined over its whole length and moves only a little
    const s0 = cutawayShot(c, c.from), s1 = cutawayShot(c, c.to);
    assert.ok([...s0.pos, ...s0.aim, ...s1.pos, ...s1.aim].every(Number.isFinite));
    assert.ok(Math.hypot(...s1.pos.map((v, i) => v - s0.pos[i])) < 3, "the camera stays nearly put");
  }
});

test("a throw-in too soon after the ball goes out gets no cutaway", () => {
  // the ball goes out at 10.6 s and the throw comes at 18: 18 - 4 - (10.6 + 1.5) = 1.9 s, shorter
  // than any shot (cutting back only 0.5 s before the throw would leave room for one)
  const ev = [
    { event_id: 1, period: 1, ts: 10, type_name: "pass", start_x: 50, start_y: 60 },
    { event_id: 2, period: 1, ts: 18, type_name: "throw_in", start_x: 50, start_y: 68 },
    { event_id: 3, period: 1, ts: 100, type_name: "pass", start_x: 50, start_y: 60 },
    { event_id: 4, period: 1, ts: 130, type_name: "throw_in", start_x: 50, start_y: 68 },
  ];
  const fake = (ev) => ({ meta: { match_id: "X", entities: ["ball"] }, events: ev, goals: [], duration: 200,
    at: (i, t) => [50, t % 90 > 10.5 ? 69 : 60, 0] });
  const plan = cutawayPlan(fake(ev), []);
  assert.equal(plan.length, 1);
  assert.ok(plan[0].from > 100 && plan[0].to <= 130 - CUTAWAY.before.throw_in);
});
