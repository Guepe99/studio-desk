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
  async load(p) {   // a real load awaits fonts; "bad" throws as a render() that throws would
    await tick();
    if (this.tag === "ograf-bad") throw new Error("render failed");
    this.data = p.data;
    return { statusCode: 200 };
  }
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

test("a graphic that throws on load is reported, taken off, and its slot goes to the next cue", async () => {
  const unhandled = [], errors = [], logged = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const quiet = console.error;
  console.error = (...a) => logged.push(a);
  try {
    const h = host();
    h.opts.onError = (g, e) => errors.push([g, e.message]);
    h.graphics.bad = { manifest: { id: "bad" }, tag: "ograf-bad", inS: 0, outS: 0 };
    h.setCues([cue("x", 1, 6, "bad"), cue("y", 1.5, 6), cue("w", 2, 3, "strap")], 0);
    run(h, 0, 1.6);
    const bad = h.live.get("x").el;
    await tick(30);
    run(h, 1.7, 2.1);
    await tick(30);
    assert.deepEqual(errors, [["bad", "render failed"]], "named to the page once");
    assert.equal(logged.length, 1, "logged once");
    assert.equal(bad.attached, false, "off the screen");
    assert.deepEqual([...h.live.keys()], ["y", "w"], "w takes the failed graphic's slot");
    assert.deepEqual(unhandled, [], "no unhandled rejection");
  } finally {
    console.error = quiet;
    process.off("unhandledRejection", onUnhandled);
  }
});

test("team colours reach a style attribute only as #rgb or #rrggbb", async () => {
  globalThis.HTMLElement ??= class {};
  const { hexColor } = await import("../../web/graphics/shared/sd-graphic.mjs");
  for (const ok of ["#fff", "#c81e2e", "#00ff87"]) assert.equal(hexColor(ok), ok);
  for (const bad of ["red", "#ff", "#ffff", "#12345g", "#fff;background:url(x)", "url(x)", null, undefined, 3]) assert.equal(hexColor(bad), undefined, String(bad));
});
