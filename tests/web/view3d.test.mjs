// The pure parts of the 3D view's clock (web/js/view3d.js): goal replays and what counts as a jump.
//   node --test tests/web/view3d.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Match } from "../../web/js/match.js";
import { replays, viewAt, jumped } from "../../web/js/view3d.js";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/data");
function load(id) {
  const dir = path.join(DATA, id);
  if (!existsSync(path.join(dir, "meta.json"))) return null;
  const j = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const buf = readFileSync(path.join(dir, "tracking.f32"));
  return new Match(j("meta.json"), j("events.json"), j("facts.json"), j("cues.json"), new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

for (const id of ["M001", "M002", "M003", "M004"]) {
  const m = load(id);
  test(`${id}: both angles of every goal replay show the strike and the ball crossing the line`, { skip: !m && `no web/data/${id}` }, () => {
    const reps = replays(m);
    assert.ok(reps.length, "no replay");
    for (const r of reps) {
      // the goal this replay follows (the page window starts 6 s after it), its shot event and the
      // first tracking sample with the ball on the goal line after the shot
      const g = m.goals.find((x) => Math.abs(r.from - 6 - x.ts) < 1e-6);
      const shot = m.events.find((e) => g.source_event_ids.includes(e.event_id) && /shot/.test(e.type_name));
      assert.ok(shot, `goal at ${g.ts}: no shot event`);
      let cross = null;
      for (let t = shot.ts; t < g.ts + 2 && cross === null; t += 0.02) { const b = m.at(0, t); if (b && (b[0] < 0.3 || b[0] > 104.7)) cross = t; }
      assert.ok(cross !== null, `goal at ${g.ts}: the ball never reaches the line`);
      const seen = { goal: [Infinity, -Infinity], low: [Infinity, -Infinity] }, page = { goal: 0, low: 0 };
      for (let t = r.from; t < r.to; t += 0.01) {
        const v = viewAt(reps, t, 1);
        assert.ok(v.replay, `page ${t} inside the replay`);
        seen[v.angle][0] = Math.min(seen[v.angle][0], v.ts);
        seen[v.angle][1] = Math.max(seen[v.angle][1], v.ts);
        page[v.angle] += 0.01;
      }
      for (const [angle, [a, z]] of Object.entries(seen)) {
        assert.ok(a <= shot.ts - 0.2, `goal at ${g.ts}, angle ${angle} starts at ${a.toFixed(2)}, after the strike at ${shot.ts}`);
        // the ball over the line; angle A, at full speed, also shows it in the net
        assert.ok(z >= cross + (angle === "goal" ? 0.5 : 0.15), `goal at ${g.ts}, angle ${angle} ends at ${z.toFixed(2)}, the ball on the line at ${cross.toFixed(2)}`);
      }
      // the slow angle is slow: at most 0.8 of real time
      const rate = (seen.low[1] - seen.low[0]) / page.low;
      assert.ok(rate > 0.45 && rate <= 0.8, `goal at ${g.ts}: angle B at ${rate.toFixed(2)}x`);
    }
  });
}

test("play is never a jump at any speed; a seek, a cut, going back or half time is", () => {
  const at = (ts, replay = false) => ({ ts, replay });
  // a 60 fps frame and a 1 s stall (the page's longest step, app.js tick) at 1x, 16x and 64x
  for (const speed of [1, 16, 64]) for (const real of [1 / 60, 0.25, 1]) {
    assert.equal(jumped(at(600), at(600 + real * speed), false, speed, 2793), false, `${real} s at ${speed}x`);
  }
  assert.equal(jumped(at(600), at(600 + 2), false, 1, 2793), true, "2 s forward at 1x is a seek");
  assert.equal(jumped(at(600), at(700), false, 64, 2793), true, "100 s forward at 64x is a seek");
  assert.equal(jumped(at(600), at(600.02), true, 1, 2793), true, "a seek");
  assert.equal(jumped(at(600), at(590, true), false, 1, 2793), true, "into a replay");
  assert.equal(jumped(at(600), at(599.9), false, 1, 2793), true, "back");
  assert.equal(jumped(at(2792.99), at(2793.01), false, 1, 2793), true, "across half time");
  assert.equal(jumped(null, at(10), false, 1, 2793), true, "the first frame");
});
