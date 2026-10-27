// A story waiting in Needs you past its moment is missed by itself, after a time that suits its kind, never airs
// afterwards, is written to the audit with its reason, and waits again when the visitor seeks back before that time.
//   node --test tests/web/desk-expiry.test.mjs
//   (needs the exported packs in web/data, as in the README; without them the file fails, it does not skip)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Match } from "../../web/js/match.js";
import { Desk, MISS_S, tr } from "../../web/js/desk.js";

const root = new URL("../../", import.meta.url);
const read = (m, f) => JSON.parse(readFileSync(new URL(`web/data/${m}/${f}.json`, root), "utf8"));
const node = () => ({ setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {} });
globalThis.document ??= { createElement: node, createElementNS: node };
const mt = new Match(read("M001", "meta"), read("M001", "events"), read("M001", "facts"), read("M001", "cues"), new Float32Array(0));

function desk(edit = (s) => s) {
  const d = new Desk(node(), { match: mt, matchId: "M001", state: { audience: "analyst", lang: "en", ts: 0 }, seek() {}, onChange() {} });
  d.stories = read("M001", "stories").map(edit).sort((a, b) => a.ts - b.ts);
  d.byId = new Map([...d.gens, ...d.stories].map((s) => [s.story_id, s]));
  d.loaded = true;
  return d;
}
const waiting = (d, id) => d.queue().some((s) => s.story_id === id);
const CHANCE = "S-000001"; // M001's big chance at 7'50, held for review, its graphics until 8'13 (493.1 s)

test("a big chance leaves Needs you one minute after its slot, not five", () => {
  const d = desk(), s = d.byId.get(CHANCE);
  assert.equal(s.kind, "big_chance");
  const end = d.slotEnd.get(CHANCE);
  d.state.ts = 480;
  assert.ok(waiting(d, CHANCE), "the producer sees it waiting at 8'");
  d.state.ts = end + MISS_S.big_chance - 1;
  assert.ok(waiting(d, CHANCE), "still waiting just before its minute is up");
  d.state.ts = end + MISS_S.big_chance;
  assert.equal(d.status(s), "expired");
  assert.ok(!waiting(d, CHANCE));
  d.state.ts = 13 * 60; // where it was still waiting, "was due on air at 8'"
  assert.equal(d.status(s), "expired");
  // never on air afterwards: no cue of it on any sheet, in any language
  for (const aud of ["analyst", "casual", "kids"]) for (const l of ["en", "it", "es"]) assert.ok(!d.sheet(mt.cues, aud, l).some((c) => c.story_id === CHANCE));
});

test("a goal or a recap waits longer than a chance; a phase of play in between", () => {
  assert.ok(MISS_S.goal > MISS_S.momentum_swing && MISS_S.momentum_swing > MISS_S.big_chance && MISS_S.recap >= MISS_S.goal);
  // the same held story as a goal: still waiting where the chance is missed
  const d = desk((s) => (s.story_id === CHANCE ? { ...s, kind: "goal" } : s)), end = d.slotEnd.get(CHANCE);
  d.state.ts = 480;
  assert.ok(waiting(d, CHANCE));
  d.state.ts = end + MISS_S.big_chance + 10;
  assert.ok(waiting(d, CHANCE));
  d.state.ts = end + MISS_S.goal;
  assert.equal(d.status(d.byId.get(CHANCE)), "expired");
});

test("the expiry is in the audit with its reason, and seeking back makes the story wait again", () => {
  const d = desk(), end = d.slotEnd.get(CHANCE);
  d.state.ts = 480;
  d.queue();
  assert.deepEqual(d.auditData().mine.filter((r) => r.action === "expired"), []);
  d.state.ts = end + 61;
  const a = d.auditData(), row = a.mine.find((r) => r.story_id === CHANCE);
  assert.ok(row && row.action === "expired" && row.actor === "desk" && /^\d{4}-\d\d-\d\dT/.test(row.at), JSON.stringify(row));
  assert.ok(a.rows.includes(row), "and in the audit table");
  assert.equal(a.humans.length, 0, "it is not counted as one of the visitor's actions");
  assert.equal(row.ts, end + MISS_S.big_chance);
  // the reason, in the three page languages, with the window of its kind
  assert.match(tr("en", "a_expired", row.detail), /within 1 min of its slot/);
  assert.match(tr("it", "a_expired", row.detail), /entro 1 min/);
  assert.match(tr("es", "a_expired", row.detail), /en los 1 min/);
  for (const l of ["en", "it", "es"]) assert.ok(!/[–—]/.test(tr(l, "a_expired", row.detail) + tr(l, "a_expired", {}) + tr(l, "missIn", { s: 5 })));
  d.state.ts = 500; // back before its minute was up
  assert.ok(waiting(d, CHANCE));
  assert.ok(!d.auditData().mine.some((r) => r.story_id === CHANCE), "nothing was missed yet");
});

test("a story the visitor never saw waiting is not logged as missed", () => {
  const d = desk();
  d.state.ts = 13 * 60;
  d.queue();
  assert.ok(!d.auditData().rows.some((r) => r.action === "expired" && r.story_id === CHANCE));
});
