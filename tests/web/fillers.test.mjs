// The fillers (studiodesk/agents/audiences.py fill_cues) as the page plays them, on the four match packs:
// the desk lists none of them, the 3D view never moves one for a goal replay, and a substitute's sheet
// still says when he comes on.
//   node --test tests/web/fillers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Match, firstCues } from "../../web/js/match.js";
import { holdForReplays, replays } from "../../web/js/view3d.js";
import { Desk, TEXT } from "../../web/js/desk.js";
import { Proof, proofOf } from "../../web/js/proof.js";

const root = new URL("../../", import.meta.url);
const read = (m, f) => JSON.parse(readFileSync(new URL(`web/data/${m}/${f}.json`, root), "utf8"));
const IDS = ["M001", "M002", "M003", "M004"], BUSY = 11.5;
const match = (m) => new Match(read(m, "meta"), read(m, "events"), read(m, "facts"), read(m, "cues"), new Float32Array(0));

// just enough of a document for the desk's constructor; nothing here renders
const node = () => ({ setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {} });
globalThis.document ??= { createElement: node, createElementNS: node };

// the desk of a visitor who never touches it, its stories in as Desk.load() puts them
function desk(m, mt) {
  const d = new Desk(node(), { match: mt, matchId: m, state: { audience: "analyst", lang: "en", ts: mt.duration }, seek() {}, onChange() {} });
  d.stories = read(m, "stories").sort((a, b) => a.ts - b.ts);
  d.byId = new Map([...d.gens, ...d.stories].map((s) => [s.story_id, s]));
  d.loaded = true;
  return d;
}

test("the desk lists no filler, in Needs you or Done; on air one says it is a template graphic, as the proof panel does", () => {
  for (const m of IDS) {
    const mt = match(m), d = desk(m, mt), fillers = d.gens.filter((g) => g.filler);
    assert.ok(fillers.length > 50, `${m}: ${fillers.length} fillers`);
    for (const audience of new Set(fillers.map((g) => g.audience))) {
      d.state.audience = audience;
      assert.deepEqual(d.shown().filter((s) => s.filler).map((s) => s.story_id), [], `${m} ${audience}`);
      assert.equal(d.queue().filter((s) => s.filler).length, 0);
    }
    // the proof panel, with the context the page gives it
    const cue = mt.cues.find((c) => c.payload.filler && c.audience === fillers[0].audience);
    assert.equal(proofOf(cue, Proof.prototype.ctx.call({ desk: d, match: mt }, cue)).approval, "template", m);
    const g = fillers[0];
    d.live = new Set([g.story_id]);
    for (const lang of ["en", "it", "es"]) {
      d.state.lang = lang;
      assert.equal(d.stateLine(g), TEXT[lang].line_live.replace("{by}", TEXT[lang].by_template), `${m} ${lang}`);
    }
  }
});

test("no filler is held for a goal replay: the 3D view plays every one at its own time", () => {
  for (const m of IDS) {
    const mt = match(m), d = desk(m, mt), reps = replays(mt), goals = mt.goals.map((f) => f.ts);
    assert.ok(reps.length, `${m}: no replay`);
    // audiences.py GOAL_BUSY_S: a goal's replay ends this long after it
    assert.ok(reps.every((r) => goals.some((g) => Math.abs(r.to - g - BUSY) < 1e-9)), `${m}: view3d.js REPLAY and audiences.py disagree`);
    for (const audience of new Set(mt.cues.map((c) => c.audience))) {
      const sheet = d.sheet(mt.cues, audience, "en"), held = holdForReplays(sheet, reps);
      const moved = sheet.filter((c, i) => c.payload.filler && held[i] !== c).map((c) => `${c.cue_id} ${c.graphic} ${c.ts}`);
      assert.deepEqual(moved, [], `${m} ${audience}`);
      // nor does one air over a goal and its replay
      const over = sheet.filter((c) => c.payload.filler && goals.some((g) => c.ts < g + BUSY && g < c.ts + c.duration_s)).map((c) => `${c.cue_id} ${c.ts}`);
      assert.deepEqual(over, [], `${m} ${audience}`);
    }
  }
});

test("a substitute's sheet first has something of its own after he comes on, not at the line-ups at 0'", () => {
  let subs = 0;
  for (const m of IDS) {
    const mt = match(m), first = firstCues(mt.cues);
    for (const l of mt.meta.lineups.filter((x) => !x.starter)) {
      const ts = first[`player:${l.player_id}`];
      if (ts === undefined) continue;
      subs++;
      assert.ok(ts >= l.on_ts - 1, `${m} ${l.player_id}: ${ts} before he comes on at ${l.on_ts}`);
    }
  }
  assert.ok(subs >= 3, `only ${subs} substitutes have a sheet`);
});
