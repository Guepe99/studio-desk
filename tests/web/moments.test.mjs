// web/js/moments.js and web/js/activity.js: where "Next key moment" lands and which steps the strip shows;
// web/js/keys.js: the video player keys; web/js/match.js: the clock as a broadcast says it.
//   node --test tests/web/moments.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { momentTargets, goalTargets, nextTarget, momentKey, isMomentKey, keyCues, Moments } from "../../web/js/moments.js";
import { reached, latestPerAgent, Activity } from "../../web/js/activity.js";
import { agentName, TEXT, tr, riskBand, deskKey } from "../../web/js/desk.js";
import { shortcut } from "../../web/js/keys.js";
import { Match } from "../../web/js/match.js";

const cue = (ts, story_id, duration_s = 6) => ({ ts, story_id, duration_s });

test("a moment is 6 s before a story cue; templates and a story's follow-up graphic are not moments", () => {
  const sheet = [cue(476.6, "S-2", 12), cue(300, null), cue(470.6, "S-2"), cue(1.5, "S-1"), cue(595.7, "S-3"), cue(900, "S-2")];
  assert.deepEqual(momentTargets(sheet), [0, 464.6, 589.7, 894]);
});

test("a shot's card comes up after the shot: the moment is 6 s before the shot, and the stops stay in time order", () => {
  // M001: the big chance's shot at 470.1, its card at 475.1
  const shots = { "S-1": 470.1, "S-2": 595.02 };
  assert.deepEqual(momentTargets([cue(475.1, "S-1"), cue(596.02, "S-2")], (c) => shots[c.story_id]), [464.1, 589.02]);
  // a start after the cue is ignored: never later than 6 s before the card
  assert.deepEqual(momentTargets([cue(100, "S-1")], () => 120), [94]);
});

test("M001 from kick-off: the first stop is the 8' big chance that waits for review, not the 10' goal", () => {
  const data = (f) => JSON.parse(readFileSync(new URL(`../../web/data/M001/${f}`, import.meta.url)));
  const status = new Map(data("stories.json").map((s) => [s.story_id, s.default_status]));
  const mine = data("cues.json").filter((c) => c.audience === "casual" && c.lang === "en");
  const onAir = mine.filter((c) => c.story_id && status.get(c.story_id) === "auto_approved");
  assert.equal(status.get("S-000001"), "needs_review");
  assert.ok(nextTarget(momentTargets(onAir), 0) > 580); // the on-air sheet alone skips it
  const first = nextTarget(momentTargets(keyCues(onAir, mine, (id) => status.get(id) === "needs_review")), 0);
  assert.equal(first, 475.1 - 6);
  // a story this visitor rejected is not a stop
  assert.ok(nextTarget(momentTargets(keyCues(onAir, mine, () => false)), 0) > 580);
});

test("a story graphic that starts while another story's graphic is on air is the same moment", () => {
  // M001: the goal (S-000012) and the comeback it makes (S-000013) share one event
  const goal = [cue(4908.1, "S-000012"), cue(4914.1, "S-000012", 12), cue(4914.1, "S-000013", 12)];
  assert.deepEqual(momentTargets(goal), [4902.1]);
  // up to 1 s after the cue before it ends still counts; later is a moment of its own
  assert.deepEqual(momentTargets([cue(100, "S-1"), cue(107, "S-2"), cue(120, "S-3"), cue(127.1, "S-4")]), [94, 114, 121.1]);
});

test("with the AI graphics off a moment is 6 s before each goal, in time order, never before kick-off", () => {
  assert.deepEqual(goalTargets([4908.1, 595.7, 1.2]), [0, 589.7, 4902.1]);
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

test("the video player keys, scoped as N is", () => {
  const at = (...inside) => ({ closest: (sel) => (sel.split(/,\s*/).some((s) => inside.includes(s)) ? {} : null) });
  const frame = at("#frame"), controls = at("#controls");
  const key = (k, target = frame, extra = {}) => shortcut({ key: k, target, ...extra });
  assert.deepEqual(key("k"), ["play"]);
  assert.deepEqual(key("K"), ["play"]); // Caps Lock
  assert.deepEqual(key("j"), ["step", -10]);
  assert.deepEqual(key("l", controls), ["step", 10]);
  assert.deepEqual(key("ArrowLeft"), ["step", -5]);
  assert.deepEqual(key("ArrowRight", frame, { repeat: true }), ["step", 5]); // held down it keeps moving
  assert.deepEqual(key("0"), ["fraction", 0]);
  assert.deepEqual(key("7"), ["fraction", 0.7]);
  assert.deepEqual(key("m"), ["voice"]);
  assert.deepEqual(key("f"), ["fullscreen"]);
  assert.deepEqual(key("?", frame, { shiftKey: true }), ["keys"]);
  for (const k of ["n", " ", "x", "ArrowUp", "Enter", "Escape"]) assert.equal(key(k), null, k); // N and Space have their own handlers
  for (const target of [at(), at("#desk"), at("#controls", "select"), at("textarea"), at("#controls", "input:not([type=range])"), at("#controls", '[role="menu"]')]) {   // the settings menu: its arrows move through it
    for (const k of ["k", "j", "5", "?", "f"]) assert.equal(key(k, target), null, k);
  }
  for (const mod of ["ctrlKey", "altKey", "metaKey", "shiftKey"]) assert.equal(key("l", frame, { [mod]: true }), null, mod);
  for (const k of ["k", "m", "f", "?"]) assert.equal(key(k, frame, { repeat: true }), null, k);
});

test("the clock says stoppage time as 45+n and 90+n", () => {
  const m = new Match({ entities: [], players: [], teams: [], period1_s: 2793.4, period2_s: 2834.5 }, [], [], [], new Float32Array());
  const label = (ts) => m.clock(ts).label;
  assert.deepEqual([0, 599, 2699, 2700, 2793.4, 2793.5, 2793.4 + 2699, 2793.4 + 2701, 1e9].map(label),
    ["1", "10", "45", "45+1", "45+2", "46", "90", "90+1", "90+3"]);
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
  assert.equal(row("verifier", "check", "rewritten 1"), "didPassRewrite");
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

test("Next key moment on a paused replay jumps to the moment and plays it at 1x", () => {
  globalThis.window ??= { addEventListener() {} };
  const button = { setAttribute() {}, addEventListener() {} }, calls = [];
  const state = { ts: 0, playing: false, speed: 64 };
  const m = new Moments(button, { state, seek: (ts) => { state.ts = ts; calls.push(["seek", ts]); }, setSpeed: (x) => { state.speed = x; calls.push(["speed", x]); },
    play: () => { state.playing = true; calls.push(["play"]); }, t: (k) => k, live: {} });
  m.setSheet([cue(600, "S-1")], true);
  m.go();
  assert.deepEqual(calls, [["speed", 1], ["seek", 594], ["play"]]);
  calls.length = 0;
  m.setSheet([cue(600, "S-1"), cue(900, "S-2")], true);
  m.go(); // already playing: it only jumps
  assert.deepEqual(calls, [["seek", 894]]);
});
