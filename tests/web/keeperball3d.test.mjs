// The ball around the keepers and the goals (web/js/ball3d.js, web/js/keeper3d.js) on M001-M004,
// planned on the scene's windows (view3d.js: 15 s back, 105 s ahead). docs/flow3d.md, "Ball" and
// "Keeper".
//   node --test tests/web/keeperball3d.test.mjs        (web/data is git-ignored: skips without it)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Match } from "../../web/js/match.js";
import { BallPlan } from "../../web/js/ball3d.js";
import { smoothMatch } from "../../web/js/scene3d/track.js";
import { planKeeper } from "../../web/js/keeper3d.js";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/data");
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
const span = (m, ts) => [Math.max(0, ts - 15), Math.min(m.duration, ts + 105)];
const plan = (m, ts) => new BallPlan(m, span(m, ts), { ballR: 0.11 });
const sorted = (m) => [...m.events].sort((a, b) => a.ts - b.ts);
const shotOf = (m, g) => m.events.find((x) => (g.source_event_ids ?? []).includes(x.event_id));

test("a ball the keeper catches stays in his hands until he plays it", { skip }, () => {
  let n = 0;
  for (const id of IDS) {
    const m = M[id], ev = sorted(m);
    ev.forEach((e, k) => {
      const nx = ev[k + 1];
      if (!["keeper_save", "keeper_claim", "keeper_pick_up"].includes(e.type_name) || !nx || nx.period !== e.period || nx.player_id !== e.player_id || nx.ts - e.ts < 1.2) return;
      const p = plan(m, e.ts), i = m.index[e.player_id];
      n++;
      for (let t = e.ts + 0.3; t < nx.ts - 0.6; t += 0.05) {
        const b = p.ball(t), K = m.at(i, t), d = Math.hypot(b.x - K[0], b.y - K[1]);
        assert.ok(b.h > 0.6 && b.h < 1.2 && d < 0.8, `${id} ${e.type_name} at ${e.ts}: ball ${d.toFixed(2)} m from him, ${b.h.toFixed(2)} m up at ${t.toFixed(2)}`);
      }
    });
  }
  assert.ok(n >= 15, `only ${n} catches checked`);
});

// every goal shot with its plan (the scene's window round the shot)
const goals = () => IDS.flatMap((id) => M[id].goals.map((g) => shotOf(M[id], g)).filter(Boolean).map((e) => ({ e, p: plan(M[id], e.ts), tag: `${id} goal at ${e.ts}` })));

test("every goal goes into the net, close-range ones too", { skip }, () => {
  for (const { e, p, tag } of goals()) {
    let inNet = false;
    for (let t = e.ts; t < e.ts + 3 && !inNet; t += 0.02) inNet = !!p.net(t);
    assert.ok(inNet, `${tag}: the ball never reaches the net`);
  }
});

test("a scored ball leaves the net without a jump", { skip }, () => {
  // the tracking ball itself moves under 0.6 m a frame here
  for (const { e, p, tag } of goals()) for (let t = e.ts; t < e.ts + 60; t += 1 / 60) {
    const a = p.ball(t), b = p.ball(t + 1 / 60), d = Math.hypot(a.x - b.x, a.y - b.y, a.h - b.h);
    assert.ok(d < 1, `${tag}: the ball jumps ${d.toFixed(1)} m at ${t.toFixed(2)}`);
  }
});

// the keeper reactions of every match, on a plan of the whole match
const K = skip ? [] : IDS.map((id) => {
  const m = M[id], p = new BallPlan(m, [0, m.duration], { ballR: 0.11 });
  return { id, m, rs: planKeeper(m, (t) => p.ball(t), { ballR: 0.11 }).map((r) => ({ r, e: m.events.find((x) => x.event_id === r.shot) })) };
});

test("the keeper reacts to every goal, a ball past his side too", { skip }, () => {
  for (const { id, m, rs } of K) for (const g of m.goals) {
    const e = shotOf(m, g);
    if (e) assert.ok(rs.some(({ r }) => r.shot === e.event_id), `${id} goal at ${e.ts}: no keeper reaction`);
  }
});

test("the keeper never moves before he could see the shot", { skip }, () => {
  for (const { id, rs } of K) for (const { r, e } of rs)
    assert.ok(r.start >= e.ts + (r.goal ? 0.15 : 0.12) - 1e-9 && r.tc - r.start >= 0.15 - 1e-9, `${id} shot at ${e.ts}: moves at ${r.start}, contact ${r.tc}`);
});

test("the half-time whistle ends a keeper reaction", { skip }, () => {
  // time runs on into the second half: a reaction must not
  for (const { id, m, rs } of K) for (const { r, e } of rs)
    if (e.ts < m.meta.period1_s) assert.ok(r.end <= m.meta.period1_s + 1e-9, `${id} shot at ${e.ts}: reaction runs on to ${r.end}, half time at ${m.meta.period1_s}`);
});

test("a low ball straight at the keeper is gathered, not dived on", { skip }, () => {
  for (const { id, rs } of K) for (const { r, e } of rs)
    if (!r.goal && r.h < 0.6 && Math.abs(r.d) < 0.6) assert.equal(r.kind, "catch", `${id} shot at ${e.ts}: ${r.kind} for a ball ${r.d.toFixed(2)} m to the side`);
});

test("a first-time kick is drawn as a kick, not a trap", { skip }, () => {
  const KICKS = new Set(["pass", "cross", "shot", "shot_freekick", "shot_penalty", "freekick_crossed", "freekick_short", "corner_crossed", "corner_short", "goalkick", "clearance"]);
  for (const id of IDS) {
    const m = M[id], p = new BallPlan(m, [0, m.duration], { ballR: 0.11 });
    for (const e of m.events) {
      const A = KICKS.has(e.type_name) && p.actors.get(m.index[e.player_id]);
      if (!A) continue;
      const trap = A.legs.find((l) => l.kind === "trap" && Math.abs(l.t - e.ts) < 0.15);
      assert.ok(A.legs.some((l) => l.kind !== "trap" && Math.abs(l.t - e.ts) < 0.01) || !trap, `${id} ${e.type_name} at ${e.ts}: a trap at ${trap?.t}`);
    }
  }
});

test("the ball's spin carries on across a replan and a seek", { skip }, () => {
  const ang = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI;
  for (const id of ["M001", "M003"]) {
    const m = M[id];
    // the scene replans 5 s before the window ends (view3d.js)
    let sp = span(m, 0), p = new BallPlan(m, sp, { ballR: 0.11 }), n = 0;
    for (let ts = 0; ts < m.duration && n < 8; ts += 0.1) {
      if (ts + 5 <= sp[1] || sp[1] >= m.duration) continue;
      const q = plan(m, ts);
      assert.ok(ang(p.ball(ts).q, q.ball(ts).q) < 1, `${id}: the ball turns ${ang(p.ball(ts).q, q.ball(ts).q).toFixed(0)} degrees at the replan at ${ts.toFixed(1)}`);
      p = q; sp = span(m, ts); n++;
    }
    for (const t of [600, 1500, 2400, 3300]) {
      const a = plan(m, t).ball(t).q, b = plan(m, t - 50).ball(t).q;
      assert.ok(ang(a, b) < 1, `${id}: ${ang(a, b).toFixed(0)} degrees between two plans at ${t}`);
    }
  }
});
