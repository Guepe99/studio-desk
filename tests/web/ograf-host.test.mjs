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
  // a real load awaits fonts; "bad" (or a payload marked broken) throws as a render() that throws would
  async load(p) {
    await tick();
    if (this.tag === "ograf-bad" || p.data.broken) throw new Error("render failed");
    this.data = p.data;
    return { statusCode: 200 };
  }
  async playAction() { this.played = true; log.push(["play", this.data.id]); return {}; }
  // "stopper" throws at once, before any promise
  stopAction() { if (this.tag === "ograf-stopper") throw new Error("stop failed"); log.push(["stop", this.data.id]); return Promise.resolve({}); }
  async dispose() { if (this.tag === "ograf-sticky") throw new Error("dispose failed"); return {}; }
  async setActionsSchedule() { return {}; }
  async goToTime() { return {}; }
  customAction() { if (this.tag === "ograf-pin") return Promise.reject(new Error("no position")); }
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
  h.setCues([cue("solo", 1, 2)], 0);  // its own id: the first test's late stop of "a" lands in the shared log
  run(h, 0, 1.5);
  const el = h.live.get("solo").el;
  assert.equal(el.attached, true);
  run(h, 1.6, 3);
  assert.equal(h.live.size, 0);
  await tick(20);
  assert.equal(el.attached, false);
  assert.ok(log.some(([k, id]) => k === "stop" && id === "solo"));
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

// runs fn(host, errors) with console.error and unhandled rejections recorded; returns what was recorded
const capture = async (fn) => {
  const unhandled = [], errors = [], logged = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const quiet = console.error;
  console.error = (...a) => logged.push(a);
  try {
    const h = host();
    h.opts.onError = (g, e) => errors.push([g, e.message]);
    await fn(h, errors);
    await tick(30);
  } finally {
    console.error = quiet;
    process.off("unhandledRejection", onUnhandled);
  }
  return { unhandled, errors, logged };
};

test("a graphic that throws on load is reported, taken off, its slot goes to the next cue, and it is not retried", async () => {
  let bad;
  const { unhandled, errors, logged } = await capture(async (h) => {
    h.graphics.bad = { manifest: { id: "bad" }, tag: "ograf-bad", inS: 0, outS: 0 };
    h.setCues([cue("x", 1, 6, "bad"), cue("y", 1.5, 6), cue("w", 2, 3, "strap")], 0);
    run(h, 0, 1.6);
    bad = h.live.get("x").el;
    await tick(30);
    run(h, 1.7, 2.1);
    await tick(30);
    assert.equal(bad.attached, false, "off the screen");
    assert.deepEqual([...h.live.keys()], ["y", "w"], "w takes the failed graphic's slot");
    h.sync(1.6, true); // a seek back into the failed cue: rebuilt without it
    await tick(30);
    assert.deepEqual([...h.live.keys()], ["y"], "the failed cue is not loaded again after a rebuild");
  });
  assert.deepEqual(errors, [["bad", "render failed"]], "named to the page once");
  assert.equal(logged.length, 1, "logged once");
  assert.deepEqual(unhandled, [], "no unhandled rejection");
});

test("a positioned graphic whose first position action rejects is reported, with no unhandled rejection", async () => {
  const { unhandled, errors } = await capture(async (h) => {
    h.graphics.pin = { manifest: { id: "pin", customActions: [{ id: "position" }] }, tag: "ograf-pin", inS: 0, outS: 0 };
    h.setCues([cue("p", 1, 6, "pin")], 0);
    run(h, 0, 1.1); // the load starts; its chain sends the first position, before any frame does
    await tick(30);
  });
  assert.deepEqual(unhandled, [], "no unhandled rejection");
  assert.deepEqual(errors, [["pin", "no position"]]);
});

test("a graphic that aired but fails to dispose is only logged: its cue comes back after a seek", async () => {
  const { errors, logged, unhandled } = await capture(async (h) => {
    h.graphics.sticky = { manifest: { id: "sticky" }, tag: "ograf-sticky", inS: 0, outS: 0 };
    h.setCues([cue("s", 1, 2, "sticky")], 0);
    run(h, 0, 3.2); // on air from 1 s, off at 3 s
    await tick(30);
    h.sync(2, true);
    assert.deepEqual([...h.live.keys()], ["s"], "back on screen after a seek into it");
  });
  assert.deepEqual(errors, [], "not named as a graphic that could not load");
  assert.equal(logged.length, 1, "the dispose failure is logged");
  assert.deepEqual(unhandled, []);
});

test("seeks while a broken graphic loads: logged and named once, and not loaded again", async () => {
  const { errors, logged } = await capture(async (h) => {
    h.graphics.bad = { manifest: { id: "bad" }, tag: "ograf-bad", inS: 0, outS: 0 };
    h.setCues([cue("x", 1, 60, "bad")], 0);
    for (let i = 0; i < 20; i++) { h.sync(1.2 + i * 0.1, true); await tick(1); } // a drag: a seek every frame
    await tick(30);
    for (let i = 0; i < 5; i++) h.sync(4 + i * 0.1, true);
    assert.deepEqual([...h.live.keys()], [], "not loaded again");
  });
  assert.deepEqual(errors, [["bad", "render failed"]], "named once");
  assert.equal(logged.length, 1, "logged once");
});

test("a broken graphic whose cue ends before its load fails is still named", async () => {
  const { errors } = await capture(async (h) => {
    h.graphics.bad = { manifest: { id: "bad" }, tag: "ograf-bad", inS: 0, outS: 0 };
    h.setCues([cue("x", 1, 0.2, "bad")], 0);
    run(h, 0, 1.5); // on at 1 s, off at 1.2 s, all before the load settles
    await tick(30);
  });
  assert.deepEqual(errors, [["bad", "render failed"]]);
});

test("a load that fails after its payload was edited does not mark the edited cue failed", async () => {
  const { errors } = await capture(async (h) => {
    const c = { ...cue("e", 1, 6), payload: { id: "e", broken: true } };
    h.setCues([c], 0);
    run(h, 0, 1.2); // the broken payload starts loading
    h.setCues([{ ...c, payload: { id: "e" } }], 1.3); // edited before that load fails
    await tick(30);
    assert.deepEqual([...h.live.keys()], ["e"]);
    h.sync(1.4, true);
    assert.deepEqual([...h.live.keys()], ["e"], "the edited cue is still tried after a seek");
  });
  assert.deepEqual(errors, [], "nothing named to the page");
});

test("a stop action that throws at once is only logged, with no unhandled rejection", async () => {
  const { errors, logged, unhandled } = await capture(async (h) => {
    h.graphics.stopper = { manifest: { id: "stopper" }, tag: "ograf-stopper", inS: 0, outS: 0 };
    h.setCues([cue("s", 1, 1, "stopper")], 0);
    run(h, 0, 1.1);
    await tick(30);
    run(h, 1.2, 2.5);
    await tick(30);
  });
  assert.deepEqual(unhandled, []);
  assert.deepEqual(errors, []);
  assert.equal(logged.length, 1, "the stop failure is logged");
});

test("a cue that failed is tried again once its payload changes (an edited card)", async () => {
  const { errors } = await capture(async (h) => {
    const c = { ...cue("e", 1, 6), payload: { id: "e", broken: true } };
    h.setCues([c], 0);
    run(h, 0, 1.2);
    await tick(30);
    assert.deepEqual([...h.live.keys()], [], "off after the failure");
    h.setCues([{ ...c, payload: { id: "e" } }], 1.3);
    run(h, 1.3, 1.5);
    await tick(30);
    assert.deepEqual([...h.live.keys()], ["e"], "the edited card goes on air");
  });
  assert.equal(errors.length, 1);
});

test("team colours reach a style attribute only as #rgb or #rrggbb", async () => {
  globalThis.HTMLElement ??= class {};
  const { hexColor } = await import("../../web/graphics/shared/sd-graphic.mjs");
  for (const ok of ["#fff", "#c81e2e", "#00ff87"]) assert.equal(hexColor(ok), ok);
  for (const bad of ["red", "#ff", "#ffff", "#12345g", "#fff;background:url(x)", "url(x)", null, undefined, 3]) assert.equal(hexColor(bad), undefined, String(bad));
});
