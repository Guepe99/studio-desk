// web/js/scene3d/track.js (smooth player paths) and web/js/keeper3d.js (keeper reactions) on the
// DEMO fixture and, when it has been exported, on M001. docs/flow3d.md has the rules.
//
//   node --test tests/web/flow3d.test.mjs        (web/data/DEMO: scripts/make_demo_fixture.py)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Match } from "../../web/js/match.js";
import { BallPlan } from "../../web/js/ball3d.js";
import { smoothMatch } from "../../web/js/scene3d/track.js";
import { planKeeper, keeperRoot, realRoot, solve } from "../../web/js/keeper3d.js";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/data");

function load(id) {
  const dir = path.join(DATA, id);
  if (!existsSync(path.join(dir, "meta.json"))) return null;
  const j = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const buf = readFileSync(path.join(dir, "tracking.f32"));
  const pos = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return new Match(j("meta.json"), j("events.json"), j("facts.json"), j("cues.json"), pos);
}

// shots the keeper saves (a keeper event or the keeper on the ball next, within 3 s) or concedes
function onTarget(m) {
  const ev = [...m.events].sort((a, b) => a.ts - b.ts), gk = new Set(m.meta.players.filter((p) => p.position === "GK").map((p) => p.player_id));
  return ev.filter((e, k) => {
    if (!/^shot/.test(e.type_name)) return false;
    // the score fact comes when the ball crosses the line, after the kick: matched by source event
    if (e.result_name === "success" && m.goals.some((g) => (g.source_event_ids ?? []).includes(e.event_id))) return true;
    const n = ev.slice(k + 1).find((x) => x.period === e.period);
    return n && gk.has(n.player_id) && n.team_id !== e.team_id && n.ts - e.ts <= 3 && n.type_name !== "goalkick";
  });
}

for (const id of ["DEMO", "M001"]) {
  const m = load(id);
  test(`${id}: smooth paths pass through every sample with continuous velocity`, { skip: !m }, () => {
    const sm = smoothMatch(m), fps = m.meta.fps, h = 1e-3;   // float32 metres: a smaller step is noise
    let jumpS = 0, jumpL = 0, n = 0;
    for (let i = 1; i < m.n; i++) {
      for (let f = 5; f < Math.min(m.meta.frames - 5, 3000); f += 7) {
        const t = f / fps, a = m.at(i, t), b = sm.at(i, t);
        if (!a || !b) continue;
        assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-4, `${id} entity ${i} off its sample at ${t}`);
        // velocity right minus left of the sample, at steps h and h/2; 2 J(h/2) - J(h) cancels the
        // part that comes from a smooth acceleration and leaves the true jump
        const v = (q, t0, t1) => { const x = q.at(i, t0), y = q.at(i, t1); return x && y ? [(y[0] - x[0]) / (t1 - t0), (y[1] - x[1]) / (t1 - t0)] : null; };
        const J = (q, s) => { const l = v(q, t - 2 * s, t - s), r = v(q, t + s, t + 2 * s); return l && r ? [r[0] - l[0], r[1] - l[1]] : null; };
        const s1 = J(sm, h), s2 = J(sm, h / 2), l1 = J(m, h), l2 = J(m, h / 2);
        if (!s1 || !s2 || !l1 || !l2) continue;
        jumpS = Math.max(jumpS, Math.hypot(2 * s2[0] - s1[0], 2 * s2[1] - s1[1]));
        jumpL = Math.max(jumpL, Math.hypot(2 * l2[0] - l1[0], 2 * l2[1] - l1[1]));
        n++;
      }
    }
    assert.ok(n > 100, `${id}: only ${n} samples checked`);
    // straight lines jump by up to a full m/s at a sample; the curve by a rounding error
    assert.ok(jumpS < 0.1 && jumpS * 4 < jumpL, `${id}: smooth velocity jumps ${jumpS.toFixed(3)} m/s at a sample`);
    assert.ok(jumpL > 0.2, `${id}: the linear path shows no jump (${jumpL.toFixed(3)}), the check measures nothing`);
    assert.equal(sm.at(0, 10.05).join(), m.at(0, 10.05).join(), "the ball stays on the tracking line");
  });

  test(`${id}: a keeper reaction for every shot on target, within the limits`, { skip: !m }, () => {
    const plan = new BallPlan(m, [0, m.duration], { ballR: 0.11 });
    const rs = planKeeper(m, (t) => plan.ball(t), { ballR: 0.11 });
    const shots = onTarget(m);
    assert.ok(shots.length > 0, `${id}: no shot on target`);
    assert.deepEqual(rs.map((r) => r.shot).sort(), shots.map((e) => e.event_id).sort(), `${id}: reactions ${rs.map((r) => r.shot)} for shots ${shots.map((e) => e.event_id)}`);
    for (const r of rs) {
      const tag = `${id} shot ${r.shot} (${r.kind}${r.goal ? ", goal" : ""})`;
      assert.ok(r.start < r.tc && r.tc < r.end && r.end - r.start < 2.6, `${tag}: phases ${r.start} ${r.tc} ${r.end}`);
      assert.ok(r.goal ? ["dive", "low"].includes(r.kind) : true, `${tag}: a beaten keeper dives`);
      let shift = 0, lift = 0;
      for (let t = r.start; t < r.end; t += 0.01) {
        const k = keeperRoot(r, t);
        shift = Math.max(shift, Math.hypot(k.dx, k.dy));
        lift = Math.max(lift, k.lift);
        assert.ok(Math.abs(k.roll) <= Math.PI / 2 + 1e-9, `${tag}: roll ${k.roll}`);
      }
      assert.ok(shift <= 2.05, `${tag}: feet leave the spot by ${shift.toFixed(2)} m`);
      const last = keeperRoot(r, r.end - 1e-3);
      if (last) assert.ok(Math.hypot(last.dx, last.dy) < 0.05 && last.lift < 0.02 && Math.abs(last.roll) < 0.05 && last.w < 0.02, `${tag}: not back on the spot at the end`);
      if (!r.goal && r.kind !== "catch") assert.ok(lift > 0.1, `${tag}: never leaves the ground`);
    }
    // a beaten keeper is late: he moves no earlier than 0.25 s after the shot
    for (const r of rs.filter((x) => x.goal)) {
      const e = m.events.find((x) => x.event_id === r.shot);
      assert.ok(r.start >= e.ts + 0.25 - 1e-9, `${id} goal ${r.shot}: keeper moves before he could`);
    }
  });
}

test("solve: the body's reach lands on the ball for a full-stretch dive", () => {
  const body = { shoulder: 1.45, arm: 0.62 };
  for (const [d, h] of [[2.5, 1.0], [3, 0.5], [1.8, 1.6]]) {
    const r = solve("dive", { d, h, f: 0 }, body), D = body.shoulder + 0.8 * body.arm;
    // shoulder line from the shifted feet, tilted by roll, plus the lift
    const x = r.s + D * Math.sin(r.roll), y = r.lift + D * Math.cos(r.roll);
    assert.ok(Math.hypot(x - d, y - h) < 0.6, `dive to (${d}, ${h}): body points at (${x.toFixed(2)}, ${y.toFixed(2)})`);
    assert.ok(r.s <= 2.0, `shift ${r.s}`);
  }
});

const clipMatch = load("M001") ?? load("DEMO");   // web/data is git-ignored: skip on a fresh clone
test("real clips: the contact frame lands on the crossing time and the hands on the ball", { skip: !clipMatch }, () => {
  const m = clipMatch;
  // made-up dives: 2 m across in 1.5 s, the body down to the ground, hands 0.5 m past the root at 0.6 s
  const clip = (sg) => ({ len: 2.5, fps: 30, contact: 0.6, hand: [sg * 1.3, 1.1, 0.2],
    root: Array.from({ length: 75 }, (_, f) => [sg * 2 * Math.min(1, f / 45), -0.75 * Math.min(1, f / 40), 0]) });
  const real = { GK_Dive_L: clip(1), GK_Dive_R: clip(-1), GK_Low_L: clip(1), GK_Low_R: clip(-1) };
  const plan = new BallPlan(m, [0, m.duration], { ballR: 0.11 });
  const rs = planKeeper(m, (t) => plan.ball(t), { ballR: 0.11, real }).filter((r) => r.real);
  assert.ok(rs.length > 0, "no reaction took a real clip");
  for (const r of rs) {
    const k = realRoot(r, r.tc), q = r.real, sg = r.clip.endsWith("_L") ? 1 : -1;
    assert.ok(Math.abs(k.clipT - 0.6) < 1e-6, `shot ${r.shot}: clip at ${k.clipT} at contact`);
    assert.ok(q.rate <= 2.5 + 1e-9, `shot ${r.shot}: run-up ${q.rate}x`);
    // hands to the left at contact: the scaled root plus the hands' reach beyond it in the clip
    const hands = -(k.dx * r.u[0] + k.dy * r.u[1]) + sg * 0.5;
    if (!r.goal && q.lat > 0.4 && q.lat < 1.5) assert.ok(Math.abs(hands + r.d) < 0.05, `shot ${r.shot}: hands ${hands.toFixed(2)} m left, ball ${(-r.d).toFixed(2)}`);
    const last = realRoot(r, r.end - 1e-3);
    assert.ok(Math.hypot(last.dx, last.dy) < 0.05 && Math.abs(last.lift) < 0.02 && last.w < 0.02, `shot ${r.shot}: not back at the end`);
  }
});
