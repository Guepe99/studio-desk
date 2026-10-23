// web/js/scene3d/track.js rootAt: the shown root, smoothed by a critically damped spring read
// ahead by its delay. No lag on a steady run, a small offset under acceleration, and less jerk on
// the simulator's paths (DEMO fixture, and M001 when it has been exported).
//   node --test tests/web/root.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Match } from "../../web/js/match.js";
import * as T from "../../web/js/scene3d/track.js";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/data");
function load(id) {
  const dir = path.join(DATA, id);
  if (!existsSync(path.join(dir, "meta.json"))) return null;
  const j = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const buf = readFileSync(path.join(dir, "tracking.f32"));
  return new Match(j("meta.json"), j("events.json"), j("facts.json"), j("cues.json"), new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}
const OMEGA = 20;

test("a steady run passes without lag, an acceleration moves the root by about a / omega^2", () => {
  assert.equal(typeof T.rootAt, "function", "track.js exports rootAt");
  const steady = { at: (i, t) => [6 * t, 2 - t, 0], duration: 100 };
  const [x, y] = T.rootAt(steady, 1, 40, OMEGA);
  assert.ok(Math.abs(x - 240) < 1e-9 && Math.abs(y + 38) < 1e-9, `steady run off by ${x - 240}, ${y + 38}`);
  const acc = { at: (i, t) => [2.5 * t * t, 0, 0], duration: 100 };   // 5 m/s^2
  const off = T.rootAt(acc, 1, 40, OMEGA)[0] - 2.5 * 1600;
  assert.ok(off > 0 && off < 1.5 * 5 / OMEGA ** 2, `offset ${off} m under 5 m/s^2`);
});

// jerk of a coordinate sampled at 60 Hz: third difference
function jerks(f, i, from, to) {
  const dt = 1 / 60, out = [];
  let prev = [];
  for (let t = from; t <= to; t += dt) {
    const p = f(i, t);
    if (!p) { prev = []; continue; }
    prev.push(p);
    if (prev.length > 4) prev.shift();
    if (prev.length === 4) {
      const [a, b, c, d] = prev;
      out.push(Math.hypot(d[0] - 3 * c[0] + 3 * b[0] - a[0], d[1] - 3 * c[1] + 3 * b[1] - a[1]) / dt ** 3);
    }
  }
  return out.sort((x, y) => x - y);
}
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];

for (const id of ["DEMO", "M001"]) {
  test(`${id}: the root keeps to the path and its jerk drops`, { skip: !load(id) && `web/data/${id} missing` }, () => {
    const m = T.smoothMatch(load(id)), from = id === "DEMO" ? 5 : 480, to = from + 60;
    const raw = [], sm = [];
    let worst = 0;
    for (let i = 1; i <= Math.min(22, m.n - 1); i++) {
      raw.push(...jerks((j, t) => m.at(j, t), i, from, to));
      sm.push(...jerks((j, t) => T.rootAt(m, j, t, OMEGA), i, from, to));
      for (let t = from; t <= to; t += 0.05) {
        const a = m.at(i, t), b = T.rootAt(m, i, t, OMEGA);
        if (a && b) worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]));
      }
    }
    raw.sort((x, y) => x - y); sm.sort((x, y) => x - y);
    const r95 = pct(raw, 0.95), s95 = pct(sm, 0.95), r99 = pct(raw, 0.99), s99 = pct(sm, 0.99);
    assert.ok(worst <= 0.0501, `root ${worst.toFixed(3)} m off the path`);
    // DEMO's zigzags reverse 12 m/s in 0.1 s, faster than a person: the soft cap bends those, so
    // there only the bulk (p95) is asked to drop; the simulated match must drop at p99 too
    const tail = id === "DEMO" || s99 < 0.6 * r99;
    assert.ok(s95 < 0.6 * r95 && tail, `jerk p95 ${r95.toFixed(1)} -> ${s95.toFixed(1)}, p99 ${r99.toFixed(1)} -> ${s99.toFixed(1)} m/s^3`);
  });
}
