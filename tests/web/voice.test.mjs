// web/js/voice.js: which story speaks when cards come on air (no audio here: start is recorded).
//   node --test tests/web/voice.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Voice } from "../../web/js/voice.js";

function voice(stories) {
  const byId = new Map(stories.map((s) => [s.story_id, { ...s, texts: { en: s.story_id } }]));
  const cues = stories.map((s) => ({ story_id: s.story_id, ts: s.cue, graphic: "why_card", lang: "en", payload: { body: s.story_id } }));
  const v = new Voice({ host: { cues, live: new Map(cues.map((c, i) => [i, { cue: c }])) },
    desk: { byId, onAir: () => true, decisions: new Map() }, state: { lang: "en", speed: 1, playing: true } });
  v.on = true;
  stories.forEach((s) => v.clips.set(`${s.story_id}|en`, "x.mp3"));
  v.started = [];
  v.start = (sid) => { v.started.push(sid); v.current = { sid, lang: "en" }; };
  return v;
}

test("a goal that is also a comeback speaks once, and again after a seek", () => {
  // M001 81st minute: goal and comeback both at 4908.1, cards at 4915
  const v = voice([{ story_id: "S-13", ts: 4908.1, cue: 4915 }, { story_id: "S-14", ts: 4908.1, cue: 4915 }]);
  v.update(4915.2, 6000);
  v.current = null;
  v.update(4916, 6000);
  assert.deepEqual(v.started, ["S-13"]);
  assert.equal(v.queued, null);
  v.reset();
  v.update(4915.2, 6000);
  assert.deepEqual(v.started, ["S-13", "S-13"]);
});

test("two stories of different moments still queue one after the other", () => {
  const v = voice([{ story_id: "S-1", ts: 590, cue: 600 }, { story_id: "S-2", ts: 598, cue: 600.5 }]);
  v.update(600.6, 6000);
  assert.deepEqual(v.started, ["S-1"]);
  assert.equal(v.queued?.sid, "S-2");
});
