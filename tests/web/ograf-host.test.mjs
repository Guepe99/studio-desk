// web/js/ograf-host.js scheduling, on a stand-in DOM: at most two graphics at once, a waiting cue
// takes the first free slot, a graphic leaves when its cue ends, and inst.chain settles only once
// the graphic is on screen; and the team colour check of the graphics (shared/sd-graphic.mjs).
//   node --test tests/web/ograf-host.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const log = [];
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
class FakeGraphic {
  constructor(tag) { Object.assign(this, { tag, style: {}, attached: false, played: false }); }
  remove() { this.attached = false; }
  async load(p) { await tick(); this.data = p.data; return { statusCode: 200 }; }   // a real load awaits fonts
  async playAction() { this.played = true; log.push(["play", this.data.id]); return {}; }
  async stopAction() { log.push(["stop", this.data.id]); return {}; }
  async dispose() { return {}; }
  async setActionsSchedule() { return {}; }
  async goToTime() { return {}; }
  customAction() {}
}
globalThis.document = { createElement: (tag) => new FakeGraphic(tag) };
const { OGrafHost } = await import("../../web/js/ograf-host.js");

const host = () => {
  const layer = { append: (el) => { el.attached = true; } };
  const h = new OGrafHost(layer, { resolution: { width: 1920, height: 1080 }, frameRate: 60, locate: () => ({ x: 0, y: 0, visible: true }), vendorParams: () => ({}) });
  // two graphics without out animation, so a cue leaves exactly at its end
  for (const name of ["card", "strap"]) h.graphics[name] = { manifest: { id: name }, tag: `ograf-${name}`, inS: 0, outS: 0 };
  return h;
};
const cue = (id, ts, duration_s, graphic = "card") => ({ cue_id: id, ts, duration_s, graphic, payload: { id } });
const run = (h, from, to, step = 0.1) => { for (let t = from; t <= to + 1e-9; t += step) h.sync(+t.toFixed(3), false, 1); };

test("three overlapping cues: two on screen, the third waits for a slot", async () => {
  const h = host();
  h.setCues([cue("a", 1, 4), cue("b", 2, 6, "strap"), cue("c", 3, 4)], 0);
  run(h, 0, 3.5);
  assert.deepEqual([...h.live.keys()], ["a", "b"]);
  run(h, 3.6, 4.8);
  assert.deepEqual([...h.live.keys()], ["a", "b"], "a is on until 5 s (its stop goes a frame early)");
  run(h, 5, 5.2);
  assert.deepEqual([...h.live.keys()], ["b", "c"], "c takes a's slot when a ends");
  run(h, 5.3, 8.1);
  assert.deepEqual([...h.live.keys()], [], "b ends at 8 s, c at 7 s");
});

test("a graphic is taken off and disposed at its cue end", async () => {
  const h = host();
  h.setCues([cue("a", 1, 2)], 0);
  run(h, 0, 1.5);
  const el = h.live.get("a").el;
  assert.equal(el.attached, true);
  run(h, 1.6, 3);
  assert.equal(h.live.size, 0);
  await tick(20);
  assert.equal(el.attached, false);
  assert.ok(log.some(([k, id]) => k === "stop" && id === "a"));
});

test("chain settles once the graphic has been played, not before", async () => {
  const h = host();
  h.setCues([cue("z", 1, 5)], 0);
  run(h, 0, 1.5);
  const inst = h.live.get("z");
  assert.ok(inst.chain instanceof Promise, "inst.chain is a promise");
  assert.equal(inst.el.played, false, "still loading");
  await inst.chain;
  assert.equal(inst.el.played, true, "played when the chain settles");
});

test("team colours reach a style attribute only as #rgb or #rrggbb", async () => {
  globalThis.HTMLElement ??= class {};
  const { hexColor } = await import("../../web/graphics/shared/sd-graphic.mjs");
  for (const ok of ["#fff", "#c81e2e", "#00ff87"]) assert.equal(hexColor(ok), ok);
  for (const bad of ["red", "#ff", "#ffff", "#12345g", "#fff;background:url(x)", "url(x)", null, undefined, 3]) assert.equal(hexColor(bad), undefined, String(bad));
});
