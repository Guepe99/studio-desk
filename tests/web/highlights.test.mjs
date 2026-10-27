// web/js/highlights.js: which moments a highlights reel plays, in which order and for how long, on the four replays.
//   node --test tests/web/highlights.test.mjs
//   (needs the exported packs in web/data, as in the README; without them the file fails, it does not skip)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reel, halfReel, clips, length, caption, usable, offer, AFTER_S, BUDGET_S, HL_STRINGS } from "../../web/js/highlights.js";
import { LEAD_S } from "../../web/js/moments.js";
import { Match } from "../../web/js/match.js";

const load = (id) => {
  const d = (f) => JSON.parse(readFileSync(new URL(`../../web/data/${id}/${f}`, import.meta.url)));
  return { match: new Match(d("meta.json"), d("events.json"), d("facts.json"), [], new Float32Array()), stories: d("stories.json") };
};

// a tiny match: halves of 100 s, a goal at 50 (shot at 49), shots with their shot_distance facts
function tiny() {
  const meta = { period1_s: 100, period2_s: 100, teams: [{ team_id: "A", side: "home", short_name: "AAA", name: "A" }, { team_id: "B", side: "away", short_name: "BBB", name: "B" }],
    players: [{ player_id: "A-9", team_id: "A", name: "Nine" }, { player_id: "B-7", team_id: "B", name: "Seven" }], entities: [] };
  const ev = (id, ts) => ({ event_id: id, ts, type_name: "shot" });
  const events = [ev(1, 10), ev(2, 30), ev(3, 70), ev(4, 49), ev(5, 85), ev(6, 150)];
  const dist = (id, m, out) => ({ kind: "shot_distance", value: m, label_en: `Shot from ${m} m, inside the box, foot, ${out}`, source_event_ids: [id] });
  const facts = [dist(1, 20, "blocked"), dist(2, 25, "wide"), dist(3, 8, "wide"), dist(5, 30, "saved"),
    { kind: "score", ts: 50, team_id: "A", player_id: "A-9", value: 1, source_event_ids: [4], fact_id: "F-SCORE-1" },
    { kind: "score", ts: 150, team_id: "B", player_id: "B-7", value: 1, source_event_ids: [6], fact_id: "F-SCORE-2" }];
  const chance = (id, ts, ev) => ({ story_id: id, kind: "big_chance", ts: ts + 0.5, default_status: "needs_review", evidence_event_ids: [ev], player_id: "B-7", team_id: "B" });
  const stories = [chance("S-1", 10, 1), chance("S-2", 30, 2), chance("S-3", 70, 3), chance("S-5", 85, 5),
    { story_id: "S-9", kind: "top_sprint", ts: 60, default_status: "auto_approved", evidence_event_ids: [] }];
  return { match: new Match(meta, events, facts, [], new Float32Array()), stories };
}

test("clips: back to back in match order, and windows that touch play once", () => {
  const cs = clips([{ start: 50, end: 60 }, { start: 10, end: 20 }, { start: 18, end: 25 }]);
  assert.deepEqual(cs.map((c) => [c.start, c.end, c.moments.length]), [[10, 25, 2], [50, 60, 1]]);
  assert.equal(length(cs), 25);
});

test("a goal plays from 6 s before its shot to 12 s after; a chance 6 s before to 4 s after", () => {
  const { match, stories } = tiny();
  const r = halfReel(match, stories, 1);
  const goal = r.flatMap((c) => c.moments).find((m) => m.kind === "goal");
  assert.deepEqual([goal.start, goal.end], [49 - LEAD_S, 49 + AFTER_S.goal]);
  const s1 = r.flatMap((c) => c.moments).find((m) => m.story_id === "S-1");
  assert.deepEqual([s1.start, s1.end], [10 - LEAD_S, 10 + AFTER_S.big_chance]);
  // only goals and big chances: a sprint is a story but not a highlight
  assert.ok(!r.flatMap((c) => c.moments).some((m) => m.story_id === "S-9"));
});

test("a short half: every goal and every big chance the agents found, in match order", () => {
  const { match, stories } = tiny();
  const r = halfReel(match, stories, 1);
  assert.deepEqual(r.flatMap((c) => c.moments).map((m) => m.story_id ?? m.kind), ["S-1", "S-2", "goal", "S-3", "S-5"]);
  assert.equal(length(r), 4 * (LEAD_S + AFTER_S.big_chance) + LEAD_S + AFTER_S.goal);
});

test("the ranking decides when the half has more chances than the budget", () => {
  const { match } = tiny();
  // 12 chances in the first half, 10 s each: 90 s takes a goal (18 s) and 7 chances (70 s)
  const outs = ["blocked", "wide", "saved", "over", "blocked", "saved", "wide", "blocked", "saved", "wide", "blocked", "over"];
  match.meta.period1_s = 1000; match.duration = 1100; match.goals = match.goals.slice(0, 1);
  match.events = outs.map((_, i) => ({ event_id: 100 + i, ts: 100 + i * 50, type_name: "shot" })).concat([{ event_id: 4, ts: 49 }]);
  match.facts = outs.map((o, i) => ({ kind: "shot_distance", value: 30 - i, label_en: `Shot from x m, foot, ${o}`, source_event_ids: [100 + i] }));
  const stories = outs.map((_, i) => ({ story_id: `S-${i}`, kind: "big_chance", ts: 100 + i * 50, default_status: "needs_review", evidence_event_ids: [100 + i] }));
  const r = halfReel(match, stories, 1);
  assert.ok(length(r) <= BUDGET_S);
  const ids = new Set(r.flatMap((c) => c.moments).map((m) => m.story_id ?? m.kind));
  // the goal, the three saved, then the near misses closest first (11 over from 19 m, 9 wide 21 m, 6 wide 24 m,
  // 3 over 27 m); 1 wide from 29 m and the blocked ones stay out
  assert.deepEqual([...ids].sort(), ["S-11", "S-2", "S-3", "S-5", "S-6", "S-8", "S-9", "goal"].sort());
  // and they play in match order
  assert.deepEqual(r.map((c) => c.start), [...r.map((c) => c.start)].sort((a, b) => a - b));
});

test("the producer's word: a rejected story is out, a flagged one only once approved; with the AI off, goals only", () => {
  const { match, stories } = tiny();
  const ids = (r) => r.flatMap((c) => c.moments).map((m) => m.story_id ?? m.kind);
  assert.ok(!ids(halfReel(match, stories, 1, { decision: (s) => (s.story_id === "S-2" ? "rejected" : "needs_review") })).includes("S-2"));
  assert.equal(usable({ safety: "flagged" }, "needs_review"), false);
  assert.equal(usable({ safety: "flagged" }, "approved"), true);
  assert.equal(usable({ safety: "passed" }, "needs_review"), true);
  assert.deepEqual(ids(halfReel(match, stories, 1, { aiOff: true })), ["goal"]);
  assert.deepEqual(ids(reel(match, stories, "h2", { aiOff: true })), ["goal"]);
});

test("the strip: the minute and what it is in the page's language, the score only once the goal is in", () => {
  const { match, stories } = tiny();
  const goalAt = { en: "Goal, {who}, {m}'", it: "Gol, {who}, {m}'", es: "Gol, {who}, {m}'" };
  const ms = reel(match, stories, "full").flatMap((c) => c.moments);
  const g = ms.find((m) => m.kind === "goal"), ch = ms.find((m) => m.story_id === "S-1");
  const t = (lang) => (k) => goalAt[lang];
  assert.deepEqual(caption(match, g, "en", t("en"), 49), { what: "Goal, Nine (AAA), 1'", score: "" });
  assert.deepEqual(caption(match, g, "en", t("en"), 50), { what: "Goal, Nine (AAA), 1'", score: "AAA 1-0 BBB" });
  assert.equal(caption(match, ch, "it", t("it"), 10).what, "Grande occasione, Seven (BBB), 1'");
  assert.equal(caption(match, ch, "es", t("es"), 10).what, "Ocasión clara, Seven (BBB), 1'");
  for (const lang of ["it", "es"]) assert.deepEqual(Object.keys(HL_STRINGS[lang]), Object.keys(HL_STRINGS.en));
});

for (const id of ["M001", "M002", "M003", "M004"]) {
  test(`${id}: every goal, within 90 s a half, in match order, inside its half`, (t) => {
    const { match, stories } = load(id);
    const p1 = match.meta.period1_s;
    const h1 = reel(match, stories, "h1"), h2 = reel(match, stories, "h2"), full = reel(match, stories, "full");
    assert.deepEqual(full, [...h1, ...h2]);
    for (const [r, from, to] of [[h1, 0, p1], [h2, p1, match.duration]]) {
      const goals = r.flatMap((c) => c.moments).filter((m) => m.kind === "goal");
      assert.equal(goals.length, match.goals.filter((f) => f.ts > from && f.ts <= to).length);
      assert.ok(length(r) <= BUDGET_S || r.every((c) => c.moments.every((m) => m.kind === "goal")));
      r.forEach((c, i) => {
        assert.ok(c.start >= from && c.end <= to && c.end > c.start);
        if (i) assert.ok(c.start > r[i - 1].end);
      });
    }
    const n = (r) => r.flatMap((c) => c.moments).length;
    t.diagnostic(`${id}: first half ${length(h1)} s (${n(h1)} moments), second half ${length(h2)} s (${n(h2)}), full match ${length(full)} s (${n(full)})`);
  });
}

test("M001 full match: it opens on the 8' chance, and the first goal's clip starts 6 s before Okowande's 10' shot", () => {
  const { match, stories } = load("M001");
  const r = reel(match, stories, "full");
  assert.equal(r[0].start, 470.1 - LEAD_S);
  const firstGoal = r.find((c) => c.moments.some((m) => m.kind === "goal"));
  assert.equal(firstGoal.start, 595.02 - LEAD_S);
  assert.equal(r.indexOf(firstGoal), 1);
});

test("the offer beside the recap: the first half reel while the half-time recap is on, the full match from full time", () => {
  const { match } = tiny();   // no cue sheet: 12 s from half-time, and from full time on
  assert.deepEqual([99, 100, 112, 113, 150, 199, 200].map((ts) => offer(match, ts)), [null, "h1", "h1", null, null, null, "full"]);
  const d = (f) => JSON.parse(readFileSync(new URL(`../../web/data/M001/${f}`, import.meta.url)));
  const m1 = new Match(d("meta.json"), [], [], d("cues.json"), new Float32Array());
  const recaps = m1.cues.filter((c) => c.graphic === "why_card" && c.payload?.kind === "recap");
  assert.ok(recaps.length >= 2, "M001 has its recap cards");
  const p1 = m1.meta.period1_s, end = Math.max(...recaps.filter((c) => Math.abs(c.ts - p1) <= 1).map((c) => c.ts + c.duration_s));
  assert.equal(offer(m1, p1 - 0.5), null);
  assert.equal(offer(m1, p1 + 1), "h1");
  assert.equal(offer(m1, end), "h1");
  assert.equal(offer(m1, end + 0.5), null);
  assert.equal(offer(m1, m1.duration + 1), "full");
});
