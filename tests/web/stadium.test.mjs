// web/js/countdown.js: when the 3-2-1 shows, what it says when, when the clock starts, the full-time strap;
// web/js/scene3d/screen.js: the big screen's text from match time, and that it changes only with the score or the minute.
//   node --test tests/web/stadium.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsCountdown, countLabel, fullTimeAt, Countdown, COUNT_S, KICKOFF_S, FULL_TIME, WORDS } from "../../web/js/countdown.js";
import { screenText } from "../../web/js/scene3d/screen.js";
import { Match } from "../../web/js/match.js";

test("the count shows only from the very start and up to 4x", () => {
  assert.equal(wantsCountdown(0, 1), true);
  assert.equal(wantsCountdown(0, 4), true);
  assert.equal(wantsCountdown(0, 16), false);
  assert.equal(wantsCountdown(0, 64), false);
  assert.equal(wantsCountdown(0.6, 1), false);   // a seek or a deep link past kick-off
  assert.equal(wantsCountdown(600, 1), false);
});

test("3, 2, 1 a second each, then Kick off, then nothing", () => {
  assert.deepEqual([0, 0.99, 1, 1.5, 2, 2.99].map(countLabel), ["3", "3", "2", "2", "1", "1"]);
  assert.equal(countLabel(COUNT_S), "kickoff");
  assert.equal(countLabel(COUNT_S + KICKOFF_S - 0.01), "kickoff");
  assert.equal(countLabel(COUNT_S + KICKOFF_S), null);
  assert.equal(countLabel(-1), null);
  for (const l of ["en", "it", "es"]) assert.ok(WORDS[l].kickoff && WORDS[l].fulltime && !/[—–]/.test(WORDS[l].kickoff + WORDS[l].fulltime), l);
});

test("full time from 2 s before the final whistle to 4 s after, not at 16x", () => {
  const d = 5627.9;
  assert.equal(fullTimeAt(d - FULL_TIME[0] - 0.01, d, 1), false);
  assert.equal(fullTimeAt(d - FULL_TIME[0], d, 1), true);
  assert.equal(fullTimeAt(d, d, 4), true);
  assert.equal(fullTimeAt(d + FULL_TIME[1], d, 1), false);
  assert.equal(fullTimeAt(d, d, 16), false);
});

const strap = () => {
  const span = { textContent: "" }, cls = new Set();
  return { firstElementChild: span, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) }, span, cls };
};

test("the clock starts on the frame of Kick off, once; a cancel stops the count", () => {
  const el = strap(), c = new Countdown(el, { lang: () => "it", sound: () => false });
  assert.equal(c.start(0, 1, 1000), true);
  assert.equal(c.counting, true);
  const at = (ms) => c.frame(ms, 0, 1, 360);
  assert.equal(at(990), false); assert.equal(c.counting, true);   // a frame begun just before the press
  assert.equal(at(1000), false); assert.equal(el.span.textContent, "3");
  assert.equal(at(2500), false); assert.equal(el.span.textContent, "2");
  assert.ok(el.cls.has("on") && el.cls.has("digit"));
  assert.equal(at(4000), true);  assert.equal(el.span.textContent, "Calcio d'inizio");
  assert.equal(c.counting, false);
  assert.equal(at(4100), false);   // only once
  assert.equal(at(5400), false); assert.equal(el.span.textContent, "Calcio d'inizio");   // 1.5 s of Kick off
  assert.equal(at(5600), false); assert.equal(el.span.textContent, "");
  assert.ok(!el.cls.has("on"));
  // a seek during the count
  assert.equal(c.start(0, 1, 10000), true);
  c.cancel();
  assert.equal(c.frame(14000, 0, 1, 360), false);
  assert.equal(el.span.textContent, "");
  // not past kick-off, not at 16x
  assert.equal(c.start(3, 1, 0), false);
  assert.equal(c.start(0, 16, 0), false);
  // the speed raised to 16x mid count: play at once
  c.start(0, 1, 20000);
  assert.equal(c.frame(20500, 0, 16, 360), true);
  // full time while playing past it
  c.cancel();
  c.frame(30000, 359, 1, 360);
  assert.equal(el.span.textContent, "Fine partita");
});

const meta = {
  period1_s: 2700, period2_s: 2880, frames: 1, fps: 10, entities: ["ball"], players: [],
  teams: [{ team_id: "T1", side: "home", short_name: "NBR" }, { team_id: "T2", side: "away", short_name: "EVA" }],
};
const goals = [{ kind: "score", team_id: "T1", ts: 630, value: 1 }, { kind: "score", team_id: "T2", ts: 3000, value: 1 }];
const match = new Match(meta, [], goals, [], new Float32Array(3));

test("the big screen shows the short names, the score facts and the broadcast minute", () => {
  assert.deepEqual(screenText(match, 0), { home: "NBR", away: "EVA", score: [0, 0], clock: "1'", key: "NBR|0|0|EVA|1'" });
  assert.deepEqual(screenText(match, 629).score, [0, 0]);
  assert.deepEqual(screenText(match, 630).score, [1, 0]);
  assert.equal(screenText(match, 2699).clock, "45'");
  assert.equal(screenText(match, 2701).clock, "46'");
  assert.deepEqual(screenText(match, 3000.5).score, [1, 1]);
  assert.equal(screenText(match, 5410).clock, "90+1'");   // stoppage time as the score bug says it
  assert.equal(screenText(match, 5580).clock, "90+3'");   // the final whistle: the clock stops in the 48th minute of the half
});

test("its text changes only when the score or the minute does: one redraw a minute at most", () => {
  const keys = new Set();
  for (let i = 0; i < 6600; i++) keys.add(screenText(match, i / 10).key);   // 0 to 659.9 s, ten frames a second
  // minutes 1 to 11, and the goal at 630 s splits the 11th: 12 texts in 6600 frames
  assert.equal(keys.size, 12);
});
