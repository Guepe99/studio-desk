// web/js/awareness.js on the DEMO fixture and, when it has been exported, on M001.
//
//   node --test tests/web/awareness.test.mjs        (web/data/DEMO: scripts/make_demo_fixture.py)
//
// "before" is what the scene shows without the layer: the chest faces the run (the ball when nearly
// still) and the head looks where the chest does. "after" adds the awareness driver and head look.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Match } from "../../web/js/match.js";
import { Awareness, headYaw, CLIPS, STEP, HEAD_YAW_MAX } from "../../web/js/awareness.js";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/data");
const D = Math.PI / 180;
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

function load(id) {
  const dir = path.join(DATA, id);
  if (!existsSync(path.join(dir, "meta.json"))) return null;
  const j = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const buf = readFileSync(path.join(dir, "tracking.f32"));
  const pos = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return new Match(j("meta.json"), j("events.json"), j("facts.json"), j("cues.json"), pos);
}

// Defenders within 15 m of the ball (team not in possession, outfield), every 0.2 s.
export function measure(match, aw, t0, t1) {
  const ev = [...match.events].sort((a, b) => a.ts - b.ts);
  const r = { n: 0, headBefore: 0, headAfter: 0, backBefore: 0, backAfter: 0, modes: {}, flips: 0, players: 0, turn: [] };
  let e = 0;
  const lastMode = new Map(), lastHead = new Map();
  for (let t = t0; t < t1; t += 0.2) {
    while (e + 1 < ev.length && ev[e + 1].ts <= t) e++;
    const b = aw.ball(t);
    for (let i = 1; i < match.n; i++) {
      const p = match.at(i, t), q = aw.pose(i, t), l = aw.look(i, t);
      if (!p || !q || !b) continue;
      const a = match.at(i, t - 0.2) ?? p, c = match.at(i, t + 0.2) ?? p;
      const vx = (c[0] - a[0]) / 0.4, vy = (c[1] - a[1]) / 0.4, v = Math.hypot(vx, vy);
      const toBall = Math.atan2(b.x - p[0], b.y - p[1]);
      const before = v > 0.7 ? Math.atan2(vx, vy) : toBall;
      const base = before + (q.mode === "backpedal" ? Math.PI : 0);
      const chest = base + angleDiff(base, q.yaw) * q.yawW;
      const head = headYaw(chest, l.yaw);
      // mode switches and head turn speed for everybody (smoothness)
      if (lastMode.has(i) && lastMode.get(i) !== q.mode) r.flips++;
      lastMode.set(i, q.mode);
      if (lastHead.has(i)) r.turn.push(Math.abs(angleDiff(lastHead.get(i), l.yaw)) / 0.2 / D);
      lastHead.set(i, l.yaw);
      const team = match.meta.entities[i].split("-")[0], gk = match.players[match.meta.entities[i]]?.position === "GK";
      if (gk || team === ev[e]?.team_id || Math.hypot(b.x - p[0], b.y - p[1]) > 15) continue;
      r.n++;
      if (Math.abs(angleDiff(before, toBall)) < 30 * D) r.headBefore++;
      if (Math.abs(angleDiff(head, toBall)) < 30 * D) r.headAfter++;
      if (Math.abs(angleDiff(before, toBall)) > 90 * D) r.backBefore++;
      if (Math.abs(angleDiff(chest, toBall)) > 90 * D) r.backAfter++;
      r.modes[q.mode] = (r.modes[q.mode] ?? 0) + 1;
    }
  }
  r.players = lastMode.size;
  r.turn.sort((a, b) => a - b);
  r.turnP99 = r.turn[Math.floor(r.turn.length * 0.99)] ?? 0;
  return r;
}

function report(id, match, aw, t0, t1) {
  const r = measure(match, aw, t0, t1);
  const pct = (x) => `${((100 * x) / r.n).toFixed(1)}%`;
  const min = (t1 - t0) / 60;
  console.log(`${id} [${t0}-${t1.toFixed(0)} s]: ${r.n} defender samples within 15 m of the ball`);
  console.log(`  head within 30 deg of the ball: before ${pct(r.headBefore)}, after ${pct(r.headAfter)}`);
  console.log(`  back to the ball (chest > 90 deg off): before ${pct(r.backBefore)}, after ${pct(r.backAfter)}`);
  console.log(`  modes: ${Object.entries(r.modes).map(([k, v]) => `${k} ${pct(v)}`).join(", ")}`);
  console.log(`  mode switches per player-minute ${(r.flips / r.players / min).toFixed(2)}, look target turn p99 ${r.turnP99.toFixed(0)} deg/s`);
  return r;
}

function emotionsAfterGoals(match, aw) {
  const out = [];
  for (const g of match.goals) {
    const t = g.ts + 1.5;
    const scorerTeam = g.team_id;
    let scorer = 0, mates = 0, conceding = 0, matesOn = 0, concOn = 0;
    for (let i = 1; i < match.n; i++) {
      if (!match.at(i, t)) continue;
      const team = match.meta.entities[i].split("-")[0], e = aw.pose(i, t)?.emotion;
      if (team === scorerTeam) matesOn++; else concOn++;
      if (!e) continue;
      if (aw.emotionAt(i, t)?.kind === "celebrate") scorer++;
      else if (team === scorerTeam) mates++;
      else if (aw.emotionAt(i, t)?.kind === "dejected") conceding++;
    }
    out.push({ ts: g.ts, scorer, mates, matesOn: matesOn - 1, conceding, concOn });
  }
  return out;
}

const demo = load("DEMO");

test("DEMO: defenders face and watch the ball, emotions after both goals", { skip: !demo && "no web/data/DEMO" }, () => {
  const aw = new Awareness(demo, [0, demo.duration]);
  const r = report("DEMO", demo, aw, 5, demo.duration - 1);
  assert.ok(r.n > 300, `${r.n} samples`);
  assert.ok(r.headAfter / r.n > 0.75, `head share ${r.headAfter / r.n}`);
  assert.ok(r.headAfter / r.n > r.headBefore / r.n + 0.3);
  assert.ok(r.turnP99 <= 401, `look turns at ${r.turnP99} deg/s`);
  assert.ok(r.backAfter / r.n < 0.12, `back share ${r.backAfter / r.n}`);
  for (const g of emotionsAfterGoals(demo, aw)) {
    console.log(`  goal at ${g.ts}: scorer ${g.scorer}, teammates ${g.mates}/${g.matesOn}, conceding ${g.conceding}/${g.concOn}`);
    assert.equal(g.scorer, 1);
    assert.ok(g.mates >= g.matesOn - 3 && g.conceding >= g.concOn - 3, JSON.stringify(g));
  }
});

test("emotions come from facts and events only, and fit the clips", { skip: !demo && "no web/data/DEMO" }, () => {
  for (const m of [demo, load("M001")].filter(Boolean)) {
    const aw = new Awareness(m, [0, 1]);
    const facts = new Set(m.facts.map((f) => f.fact_id)), events = new Set(m.events.map((e) => `event:${e.event_id}`));
    for (const e of aw.emotions) {
      assert.ok(facts.has(e.src) || events.has(e.src), `emotion without a source: ${JSON.stringify(e)}`);
      assert.ok(e.clip in CLIPS, e.clip);
    }
    const kinds = {};
    for (const e of aw.emotions) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    console.log(`${m.meta.match_id}: ${aw.emotions.length} emotion entries ${JSON.stringify(kinds)}`);
  }
});

test("pose and look are pure functions of time and stay in the neck range", { skip: !demo && "no web/data/DEMO" }, () => {
  const a = new Awareness(demo, [90, 110]), b = new Awareness(demo, [95, 110]);
  for (let t = 96; t < 109; t += 0.37) for (let i = 1; i < demo.n; i++) {
    const p = a.pose(i, t), q = b.pose(i, t);
    if (!p) continue;
    // a different span start changes the warm-up only: after 10 s of smoothing the answers agree
    assert.ok(Math.abs(angleDiff(p.yaw, q.yaw)) < 1e-3 && p.mode === q.mode, `${i} ${t}`);
    assert.deepEqual(a.pose(i, t), a.pose(i, t));
    assert.ok(Math.abs(angleDiff(p.yaw, headYaw(p.yaw, a.look(i, t).yaw))) <= HEAD_YAW_MAX + 1e-9);
  }
  assert.equal(STEP, 0.05);
});

// web/vendor/motion (docs/motion3d.md): the same events and facts, played with the real clips
const MOTION = path.resolve(DATA, "../vendor/motion/clips.json");
test("with the motion clips: same sources, real clips, one-shots never outlast their clip", { skip: !(demo && existsSync(MOTION)) && "no DEMO or clips.json" }, () => {
  const motion = JSON.parse(readFileSync(MOTION, "utf8"));
  const plain = new Awareness(demo, [0, 1]), aw = new Awareness(demo, [0, demo.duration], { motion });
  assert.deepEqual(new Set(aw.emotions.map((e) => e.src)), new Set(plain.emotions.map((e) => e.src)));
  let real = 0;
  for (const e of aw.emotions) {
    const mc = motion.clips[e.clip];
    assert.ok(mc || e.clip in CLIPS, e.clip);
    if (!mc) continue;
    real++;
    if (!mc.loop) assert.ok(e.dur <= mc.len + 1e-9, `${e.clip} ${e.dur} > ${mc.len}`);
    const q = aw.emotion(e.i, e.t0 + Math.min(e.dur, mc.len) / 2);
    if (q?.clip === e.clip) assert.ok(q.t >= 0 && q.t <= mc.len && q.full === mc.full, JSON.stringify(q));
  }
  assert.ok(real > aw.emotions.length / 2, `${real} of ${aw.emotions.length} on real clips`);
  for (const g of emotionsAfterGoals(demo, aw)) assert.equal(g.scorer, 1, JSON.stringify(g));
});

const m001 = load("M001");
test("M001: defenders face and watch the ball", { skip: !m001 && "no web/data/M001 (studiodesk.export M001)" }, () => {
  const aw = new Awareness(m001, [0, m001.duration]);
  const r = report("M001", m001, aw, 5, m001.duration - 1);
  assert.ok(r.headAfter / r.n > 0.75 && r.backAfter / r.n < 0.15);
  for (const g of emotionsAfterGoals(m001, aw)) {
    console.log(`  goal at ${g.ts}: scorer ${g.scorer}, teammates ${g.mates}/${g.matesOn}, conceding ${g.conceding}/${g.concOn}`);
    assert.equal(g.scorer, 1);
  }
});
