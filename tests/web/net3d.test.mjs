// The goal net: a scored ball carries on into the netting (web/js/ball3d.js, BallPlan.net) and the
// netting bulges round it (web/js/scene3d/net.js). docs/motion3d.md, "The goal".
//   node --test tests/web/net3d.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Match } from "../../web/js/match.js";
import { BallPlan, PITCH_L, GOAL_W, GOAL_H, NET_D } from "../../web/js/ball3d.js";
import { netPanels, bulge } from "../../web/js/scene3d/net.js";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/data");
function load(id) {
  const dir = path.join(DATA, id);
  if (!existsSync(path.join(dir, "meta.json"))) return null;
  const j = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const buf = readFileSync(path.join(dir, "tracking.f32"));
  return new Match(j("meta.json"), j("events.json"), j("facts.json"), j("cues.json"), new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

const m = load("M001");
test("M001: a scored ball keeps its speed over the line, presses the net and stays in the goal", { skip: !m && !process.env.CI && "no web/data/M001" }, () => {
  const g = m.goals[0], plan = new BallPlan(m, [g.ts - 12, g.ts + 10], { ballR: 0.11 });
  const at = (t) => plan.ball(t), end = at(g.ts).x > PITCH_L / 2 ? 1 : -1, line = end > 0 ? PITCH_L : 0;
  // the tracking ball stops short of the netting; the drawn one crosses the line at speed
  let tLine = null;
  for (let t = g.ts - 1.5; t < g.ts + 1; t += 0.005) if ((at(t).x - line) * end > 0) { tLine = t; break; }
  assert.ok(tLine, "the ball never crosses the line");
  const v = Math.abs(at(tLine).x - at(tLine - 0.05).x) / 0.05;
  assert.ok(v > 10, `ball at ${v.toFixed(1)} m/s on the line`);
  // it reaches the netting and pushes it out
  let peak = 0;
  for (let t = tLine; t < tLine + 1; t += 0.01) { const n = plan.net(t); if (n) peak = Math.max(peak, n.depth); }
  assert.ok(peak > 0.3, `net pushed ${peak.toFixed(2)} m`);
  // and comes to rest inside the goal, on the ground, not back on the pitch (then it eases out
  // onto the tracking ball, carried back for the kick-off)
  const n = plan.nets.find((x) => x.t0 > g.ts - 5 && x.t0 <= g.ts + 1);
  assert.ok(n && n.th - n.t0 >= 3 - 1e-9, "no rest in the net");
  const rest = at(n.th - 0.1), inside = (rest.x - line) * end;
  assert.ok(inside > 0.3 && inside < NET_D + 0.5 && Math.abs(rest.y - 34) < GOAL_W / 2 && rest.h < 0.2,
    `ball at rest at ${rest.x.toFixed(2)}, ${rest.y.toFixed(2)}, ${rest.h.toFixed(2)}`);
  // the tracking check leaves the net window out and still holds elsewhere
  assert.ok(plan.check(g.ts - 11, g.ts - 1).worst < 1.5);
});

test("the four panels close the goal behind the line, normals outwards", () => {
  for (const s of [1, -1]) {
    const P = netPanels(s, 52.5, { GW: GOAL_W, GH: GOAL_H, D: NET_D });
    assert.deepEqual(P.map((p) => p.name).sort(), ["back", "roof", "side", "side"]);
    const back = P.find((p) => p.name === "back");
    assert.equal(back.o[0], s * (52.5 + NET_D));
    assert.equal(back.n[0], s);
    // every corner of every panel lies on or behind the goal line
    for (const p of P) for (const k of [0, 1]) for (const l of [0, 1]) assert.ok(s * (p.o[0] + k * p.U[0] + l * p.V[0]) >= 52.5 - 1e-9, p.name);
  }
});

test("the pocket: full at the ball, nothing at the frame, falls off with distance", () => {
  assert.equal(bulge(3.66, 1.2, 7.32, 2.2, 3.66, 1.2, true), 1);
  for (const [u, v] of [[0, 1.2], [7.32, 1.2], [3.66, 0], [3.66, 2.2]]) assert.ok(bulge(u, v, 7.32, 2.2, 3.66, 1.2, true) < 1e-9, `frame at ${u}, ${v}`);
  assert.ok(bulge(4.2, 1.2, 7.32, 2.2, 3.66, 1.2) > bulge(5, 1.2, 7.32, 2.2, 3.66, 1.2));
  // near an edge the ball's own point is still fully pushed (the cords stretch there)
  assert.equal(bulge(0.3, 1.2, 7.32, 2.2, 0.3, 1.2), 1);
});
