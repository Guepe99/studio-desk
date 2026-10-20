// web/js/moments.js and web/js/activity.js: where "Next key moment" lands and which steps the strip shows.
//   node --test tests/web/moments.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { momentTargets, goalTargets, nextTarget, momentKey, isMomentKey } from "../../web/js/moments.js";
import { reached, latestPerAgent, Activity } from "../../web/js/activity.js";
import { agentName, TEXT, tr, riskBand, deskKey } from "../../web/js/desk.js";

const cue = (ts, story_id, duration_s = 6) => ({ ts, story_id, duration_s });

test("a moment is 3 s before a story cue; templates and a story's follow-up graphic are not moments", () => {
  const sheet = [cue(476.6, "S-2", 12), cue(300, null), cue(470.6, "S-2"), cue(1.5, "S-1"), cue(595.7, "S-3"), cue(900, "S-2")];
  assert.deepEqual(momentTargets(sheet), [0, 467.6, 592.7, 897]);
});

test("a story graphic that starts while another story's graphic is on air is the same moment", () => {
  // M001: the goal (S-000012) and the comeback it makes (S-000013) share one event
  const goal = [cue(4908.1, "S-000012"), cue(4914.1, "S-000012", 12), cue(4914.1, "S-000013", 12)];
  assert.deepEqual(momentTargets(goal), [4905.1]);
  // up to 1 s after the cue before it ends still counts; later is a moment of its own
  assert.deepEqual(momentTargets([cue(100, "S-1"), cue(107, "S-2"), cue(120, "S-3"), cue(127.1, "S-4")]), [97, 117, 124.1]);
});

test("with the AI graphics off a moment is 3 s before each goal, in time order, never before kick-off", () => {
  assert.deepEqual(goalTargets([4908.1, 595.7, 1.2]), [0, 592.7, 4905.1]);
  assert.deepEqual(goalTargets([]), []);
});

test("the button's label: next while the stories load, then none at all, none ahead or next", () => {
  assert.equal(momentKey([], 0, false), "next");
  assert.equal(momentKey([], 0, true), "nokey");
  assert.equal(momentKey([10, 20], 0, true), "next");
  assert.equal(momentKey([10, 20], 20, true), "nonext");
});

test("N works only with focus in the broadcast or its controls, outside text fields, without modifiers", () => {
  // a stand-in for an element: the selectors it is inside
  const at = (...inside) => ({ closest: (sel) => (sel.split(/,\s*/).some((s) => inside.includes(s)) ? {} : null) });
  const frame = at("#frame"), range = at("#controls"), desk = at("#desk"), ask = at("textarea"), select = at("#controls", "select");
  const key = (target, extra = {}) => isMomentKey({ key: "n", target, ...extra });
  assert.equal(key(frame), true);
  assert.equal(key(range), true);
  assert.equal(isMomentKey({ key: "N", target: frame }), true); // Caps Lock: no Shift
  assert.equal(key(at()), false); // the page body
  assert.equal(key(desk), false);
  assert.equal(key(ask), false);
  assert.equal(key(at("input:not([type=range])")), false); // the Ask question box sits outside both anyway
  assert.equal(key(select), false);
  for (const mod of ["shiftKey", "ctrlKey", "altKey", "metaKey", "repeat"]) assert.equal(key(frame, { [mod]: true }), false, mod);
  assert.equal(isMomentKey({ key: "m", target: frame }), false);
});

test("the desk keys work only with focus in the desk, never while typing, and only J and K repeat", () => {
  const at = (...inside) => ({ closest: (sel) => (sel.split(/,\s*/).some((s) => inside.includes(s)) ? {} : null) });
  const desk = at("#desk"), key = (k, target = desk, extra = {}) => deskKey({ key: k, target, ...extra });
  assert.deepEqual(["a", "e", "r", "j", "k", "u", "?"].map((k) => key(k)), ["air", "edit", "reject", "next", "prev", "undo", "keys"]);
  assert.equal(key("A"), "air"); // Caps Lock
  assert.equal(key("a", at("#frame")), null); // outside the desk: the broadcast's own keys
  for (const field of ["input", "textarea", "select", "[contenteditable]"]) assert.equal(key("a", at("#desk", field)), null, field);
  for (const mod of ["ctrlKey", "altKey", "metaKey", "shiftKey"]) assert.equal(key("r", desk, { [mod]: true }), null, mod);
  assert.equal(key("?", desk, { shiftKey: true }), "keys"); // ? is Shift+/ on most layouts
  assert.equal(key("a", desk, { repeat: true }), null);
  assert.equal(key("j", desk, { repeat: true }), "next");
  assert.equal(key("x"), null);
});

test("the next moment is strictly ahead, so a second press moves on", () => {
  const targets = [0, 467.6, 592.7];
  assert.equal(nextTarget(targets, 0), 467.6);
  assert.equal(nextTarget(targets, 467.6), 592.7);
  assert.equal(nextTarget(targets, 470), 592.7);
  assert.equal(nextTarget(targets, 592.7), undefined);
  assert.equal(nextTarget([], 0), undefined);
});

test("the strip reaches only ts <= now and shows each agent's latest step, oldest first", () => {
  const agents = ["story_finder", "analyst", "commentator_en", "verifier", "commentator_en", "verifier", "director"];
  const rows = agents.map((agent, i) => ({ agent, ts: 100, seq: i + 1 })).concat([{ agent: "story_finder", ts: 200, seq: 8 }]);
  assert.equal(reached(rows, 99.9), 0);
  assert.equal(reached(rows, 100), 7);
  assert.equal(reached(rows, 1e9), 8);
  assert.deepEqual(latestPerAgent(rows, 7).map((i) => rows[i].seq), [1, 2, 5, 6, 7]);
  assert.deepEqual(latestPerAgent(rows, 8).map((i) => rows[i].seq), [2, 5, 6, 7, 8]);
  assert.deepEqual(latestPerAgent(rows, 0), []);
  const many = Array.from({ length: 9 }, (_, i) => ({ agent: `a${i}`, ts: 1, seq: i }));
  assert.equal(latestPerAgent(many, 9).length, 7);
});

test("the strip says what each agent did in a sentence of the page strings, never its ids or step names", () => {
  const story = { story_id: "S-000001", kind: "big_chance", ts: 470 };
  const desk = { byId: new Map([[story.story_id, story]]), traceStories: (r) => r.story_ids ?? [null], minuteText: () => "8" };
  const said = (r) => Activity.prototype.said.call({ desk, t: (k) => (k === "didPick" ? "Picked: {what}" : k) }, r, "en");
  const row = (agent, step, out, ids = [story.story_id]) => said({ agent, step, output_summary: out, story_ids: ids });
  assert.equal(row("story_finder", "pick", "1 story: S-000001 big_chance"), "Picked: big chance, 8'");
  assert.equal(row("story_finder", "pick", "0 stories", []), "didPickAny");
  assert.equal(row("analyst", "analyse", "1 analysis, 1 replaced by the facts"), "didExplain");
  assert.equal(row("commentator_it", "draft", "1 line"), "didWrite");
  assert.equal(row("commentator_es", "rewrite", "1 line"), "didRewrite");
  assert.equal(row("verifier", "check", "pass"), "didPass");
  assert.equal(row("verifier", "check", "rewritten 1"), "didRewritten");
  assert.equal(row("verifier", "check", 'fail: "a 52 m ball", the ledger value differs'), "didRewritten");
  assert.equal(row("verifier", "check", "template 1"), "didTemplate");
  assert.equal(row("verifier", "fallback", "template line from the facts"), "didTemplate");
  assert.equal(row("analyst", "analyse", "analyst fallback: model call failed (429)"), "didFail");
  assert.equal(row("director", "cue", "24 cues for 5 audiences"), "didCue");
  assert.equal(row("someone_new", "x", "y"), "didHand");
});

test("agent names", () => {
  assert.equal(agentName("commentator_it"), "Commentator IT");
  assert.equal(agentName("story_finder"), "Story finder");
  assert.equal(agentName("new_agent"), "new agent");
  assert.equal(agentName("commentator_it", "it"), "Commentatore IT");
  assert.equal(agentName("studio_host"), "Studio host");
  assert.equal(agentName("human", "es"), "Tú");
  assert.equal(agentName("story_finder", "xx"), "Story finder"); // a missing language falls back to English
  // every agent id of the replays has a display name, never the raw id (review finding 18)
  for (const id of ["story_finder", "analyst", "commentator_en", "commentator_it", "commentator_es", "verifier", "director", "human", "auto", "studio_host"]) {
    for (const lang of ["en", "it", "es"]) assert.ok(!agentName(id, lang).includes("_"), `${id} in ${lang}`);
  }
});

test("desk strings: every language has every key, no em dash", () => {
  for (const lang of ["it", "es"]) {
    assert.deepEqual(Object.keys(TEXT[lang]).sort(), Object.keys(TEXT.en).sort(), lang);
  }
  const vars = { n: 2, m: 3, f: 2, e: 1, tok: "1", usd: "$1", s: "1", what: "Goal 10'", label: "x", kind: "Goal", r: "0.1", t: "0.35", a: 1, b: 2, why: "x", name: "x", run: true };
  for (const lang of ["en", "it", "es"]) {
    for (const k of Object.keys(TEXT.en)) assert.ok(!/[\u2014\u2013]/.test(tr(lang, k, vars)), `${lang} ${k}`);
  }
  assert.equal(tr("en", "traceSum", { n: "1", tok: "5", usd: "$0.01", s: "0.2" }), "1 hand-off, 5 tokens, $0.01, 0.2 s");
  assert.equal(tr("it", "traceSum", { n: "2", tok: "5", usd: "$0.01", s: "0,2" }), "2 passaggi di consegne, 5 token, $0.01, 0,2 s");
});

test("risk bands", () => {
  assert.deepEqual([0, 0.34, 0.35, 0.59, 0.6, 1, NaN].map(riskBand), ["low", "low", "mid", "mid", "high", "high", "high"]);
});
