// web/js/multiview-logic.js: the link of each multiviewer window, the drift correction and the name strips.
//   node --test tests/web/multiview.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { WINDOWS, DRIFT_S, windowUrl, lagging, drift, umdLabel } from "../../web/js/multiview-logic.js";

test("each window opens the broadcast page with its audience and language, in 2D, its desk the wall's", () => {
  const u = new URL(windowUrl({ match: "M001", t: 590, audience: "team:T02", lang: "it" }), "http://x/");
  assert.equal(u.pathname, "/index.html");
  assert.deepEqual(Object.fromEntries(u.searchParams), { match: "M001", t: "590", audience: "team:T02", lang: "it", view: "2d", speed: "1", wall: "1" });
  assert.equal(new URL(windowUrl({ match: "M001", t: 0, audience: "kids", lang: "en", play: true }), "http://x/").searchParams.get("play"), "1");
});

test("the default wall: four audiences in three languages", () => {
  assert.equal(WINDOWS.length, 4);
  assert.equal(new Set(WINDOWS.map((w) => w.audience)).size, 4);
  assert.deepEqual([...new Set(WINDOWS.map((w) => w.lang))].sort(), ["en", "es", "it"]);
});

test("only windows further than 0.3 s from the reference are corrected; unloaded ones are left alone", () => {
  assert.equal(DRIFT_S, 0.3);
  assert.deepEqual(lagging([600, 600.2, 599.7, 600.31], 600), [3]);
  assert.deepEqual(lagging([600, null, 598, 602], 600), [2, 3]);
  assert.deepEqual(lagging([600, 600.29, 599.71], 600), []);
  assert.deepEqual(lagging([], 600), []);
});

test("drift is the largest gap among loaded windows", () => {
  assert.equal(drift([600, 600.25, null, 599.9], 600).toFixed(2), "0.25");
  assert.equal(drift([null, null], 600), 0);
});

test("the name strip says the audience and the language, a team by its name once known", () => {
  assert.equal(umdLabel({ audience: "kids", lang: "en" }), "Kids · EN");
  assert.equal(umdLabel({ audience: "casual", lang: "es" }), "Casual fan · ES");
  assert.equal(umdLabel({ audience: "team:T02", lang: "it" }), "T02 fan · IT");
  assert.equal(umdLabel({ audience: "team:T02", lang: "it" }, { T02: "Ostwick FC" }), "Ostwick FC fan · IT");
});
