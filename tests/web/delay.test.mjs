// web/js/delay.js: the broadcast delay's timing. The picture runs D seconds behind the desk, and a story
// ready within D seconds of its moment goes on the picture at that moment.
//   node --test tests/web/delay.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DELAYS, delayFrom, storyMoment, storyTimes, shifts, delayCues, delayUrl, DELAY_STRINGS } from "../../web/js/delay.js";

const data = (m, f) => JSON.parse(readFileSync(new URL(`../../web/data/${m}/${f}`, import.meta.url)));
const cue = (cue_id, ts, story_id, graphic = "pass_shot", duration_s = 6) => ({ cue_id, ts, story_id, graphic, duration_s });

test("?delay= takes only the menu's values; anything else is no delay", () => {
  assert.deepEqual(DELAYS, [0, 5, 10, 15]);
  for (const v of ["5", "10", "15", 10]) assert.equal(delayFrom(v), Number(v));
  for (const v of [null, undefined, "", "0", "7", "-5", "1e9", "abc", "10s"]) assert.equal(delayFrom(v), 0);
});

test("a story's moment is its one cited event up to 10 s before it, else its own time", () => {
  const ev = new Map([[1, 470.1], [2, 100], [3, 480]]);
  assert.equal(storyMoment({ ts: 470.6, evidence_event_ids: [1] }, ev), 470.1);
  assert.equal(storyMoment({ ts: 470.6, evidence_event_ids: [2] }, ev), 470.6);   // too far back
  assert.equal(storyMoment({ ts: 470.6, evidence_event_ids: [3] }, ev), 470.6);   // after the story
  assert.equal(storyMoment({ ts: 600, evidence_event_ids: [1, 2] }, ev), 600);     // a window: its end
  assert.equal(storyMoment({ ts: 600, evidence_event_ids: [] }, ev), 600);
  assert.equal(storyMoment({ ts: 600, evidence_event_ids: [99] }, ev), 600);       // unknown event
});

test("a story's cues move earlier by its lead, at most the delay; the code's cues stay; delay 0 is today's sheet", () => {
  const stories = [{ story_id: "S-1", ts: 595.7, evidence_event_ids: [1] }, { story_id: "S-2", ts: 900, evidence_event_ids: [2] }];
  const events = [{ event_id: 1, ts: 595.02 }, { event_id: 2, ts: 880 }];
  const cues = [cue("C-1", 300, null, "momentum"), cue("C-2", 596.02, "S-1"), cue("C-3", 602.02, "S-1", "why_card", 12), cue("C-4", 912, "S-2")];
  assert.equal(delayCues(cues, stories, events, 0), cues);
  assert.deepEqual(shifts(cues, stories, events, 10), new Map([["S-1", 1], ["S-2", 10]]));
  const out = delayCues(cues, stories, events, 10);
  assert.deepEqual(out.map((c) => [c.cue_id, c.ts]), [["C-1", 300], ["C-2", 595.02], ["C-3", 601.02], ["C-4", 902]]);
  assert.equal(out[0], cues[0]);                                  // untouched cue, same object
  assert.equal(cues[1].ts, 596.02);                               // the input is not changed
  // S-2 (ready 32 s after its moment) gains the whole delay and still lands 22 s late; at 5 s, 27 s
  assert.equal(delayCues(cues, stories, events, 5).find((c) => c.cue_id === "C-4").ts, 907);
});

test("a cue never goes before its story's moment nor more than the delay before it reached air", () => {
  for (const m of ["M001", "M002", "M003", "M004"]) {
    const cues = data(m, "cues.json"), stories = data(m, "stories.json"), events = data(m, "events.json");
    const times = new Map(storyTimes(cues, stories, events).map((r) => [r.story_id, r]));
    // every story has a cue, and none airs before it is written: the desk lists it in time on the delayed picture
    assert.equal(times.size, stories.length, m);
    for (const s of stories) assert.ok(s.ts <= times.get(s.story_id).ready + 1e-9, `${m} ${s.story_id}`);
    for (const d of DELAYS) {
      const out = delayCues(cues, stories, events, d), byId = new Map(cues.map((c) => [c.cue_id, c]));
      assert.equal(out.length, cues.length);
      for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].ts <= out[i].ts, `${m} ${d} s sorted`);
      for (const c of out) {
        const was = byId.get(c.cue_id).ts;
        assert.ok(c.ts <= was && c.ts >= was - d - 1e-9, `${m} ${c.cue_id} within the delay`);
        if (c.story_id) assert.ok(c.ts >= was - times.get(c.story_id).lead - 0.006, `${m} ${c.cue_id} not before its moment`);
        else assert.equal(c.ts, was);
      }
    }
  }
});

test("M001 at 10 s: both first-half goals' graphics land on the shot; the 8' big chance too", () => {
  const out = delayCues(data("M001", "cues.json"), data("M001", "stories.json"), data("M001", "events.json"), 10);
  const first = (sid) => Math.min(...out.filter((c) => c.story_id === sid).map((c) => c.ts));
  assert.equal(first("S-000002"), 595.02);   // goal, shot at 595.02, aired at 596.02
  assert.equal(first("S-000003"), 771.5);    // goal, shot at 771.5, aired at 773.5
  assert.equal(first("S-000001"), 470.1);    // big chance, shot at 470.1, aired at 475.1
});

test("the measured numbers in docs/delay.md: stories on their moment at 0, 5, 10 and 15 s", () => {
  const on = { M001: [4, 12, 15, 15], M002: [2, 21, 24, 24], M003: [2, 12, 16, 16], M004: [3, 22, 28, 28] };
  for (const [m, want] of Object.entries(on)) {
    const times = storyTimes(data(m, "cues.json"), data(m, "stories.json"), data(m, "events.json"));
    assert.deepEqual(DELAYS.map((d) => times.filter((r) => r.lead <= d + 1e-6).length), want, m);
  }
});

test("a change of delay reloads at the same moment, with the same language, view, audience, speed and play", () => {
  const state = { ts: 590.27, playing: true, lang: "it", speed: 1, audience: "analyst" };
  assert.equal(delayUrl("?match=M002", 10, state, "2d"), "?match=M002&delay=10&t=590.2&play=1&lang=it&view=2d");
  assert.equal(delayUrl("?delay=10&play=1&speed=4", 0, { ...state, ts: 12, playing: false, speed: 16, audience: "team:T01" }),
    "?speed=16&t=12&lang=it&audience=team%3AT01");
});

test("the delay strings exist in the three languages, with the seconds slot, and no dashes", () => {
  for (const lang of ["en", "it", "es"]) {
    const s = DELAY_STRINGS[lang];
    assert.deepEqual(Object.keys(s).sort(), ["delay", "delayOn", "delayWhy", "whyDelay"]);
    assert.ok(s.delayOn.includes("{s}") && s.delayWhy.includes("{s}"), lang);
    for (const v of Object.values(s)) assert.ok(!/[–—]/.test(v), `${lang}: ${v}`);
  }
});
