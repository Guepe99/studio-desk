// web/js/scene3d/crowd.js reaction(): when a 3D spectator rises, cheers and goes back, seated or
// standing.
//   node --test tests/web/crowd3d.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { installBabylon } from "./babylon-stub.mjs";

installBabylon();
const { reaction, RISE_S, SIT_S, CHEERS } = await import("../../web/js/scene3d/crowd.js");

const goal = [{ ts: 100, side: "home" }];
const fan = (o) => ({ fan: "home", end: "side", base: "sit", delay: 0.5, stay: 7, cheer: "armsUp", ...o });
const at = (p, t) => reaction(p, goal, 100 + p.delay + t);

test("only the scoring side's fans and its end react", () => {
  assert.equal(at(fan({ fan: "away" }), 2), null);
  assert.equal(at(fan({ fan: null, end: "away" }), 2), null);
  assert.equal(at(fan({ fan: null, end: "home" }), 2)?.clip, "armsUp");
  assert.equal(reaction(fan(), goal, 100.4), null);   // before the delay
  assert.equal(at(fan(), 7 + SIT_S + 0.01), null);    // over: back to the base loop
});

test("a seated fan rises, cheers whole loops, and blends back to his seat", () => {
  const p = fan();
  assert.deepEqual(at(p, 0.25), { clip: "rise", t: 0.25 / RISE_S });
  assert.equal(at(p, RISE_S + 0.01).clip, "armsUp");
  // the cheer is stretched to whole loops: it ends at the end of a loop, where the blend starts
  const len = CHEERS.armsUp[1], end = at(p, p.stay - 1e-6).t;
  assert.ok(Math.abs(end / len - Math.round(end / len)) < 1e-4, `cheer ends ${end} s in, loop ${len} s`);
  assert.ok(Math.abs(end / (p.stay - RISE_S) - 1) < 0.25, "the cheer plays at near its own speed");
  assert.deepEqual(at(p, p.stay), { clip: "armsUpSit", t: 0 });
  assert.ok(Math.abs(at(p, p.stay + SIT_S / 2).t - 0.5) < 1e-9);
});

test("a standing fan cheers from standing and goes back to standing", () => {
  const p = fan({ base: "stand", cheer: "clap" });
  for (const t of [0, 0.1, 0.3, RISE_S, 3, p.stay - 0.01]) {
    const r = at(p, t);
    assert.equal(r.clip, "clap", `at ${t} s: ${JSON.stringify(r)}`);   // never the seated frame of "rise"
  }
  assert.equal(at(p, p.stay + 0.1).clip, "clapStand");
});
