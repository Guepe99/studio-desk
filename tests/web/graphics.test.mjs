// The numbers the OGraf graphics write (web/graphics/*): a decimal comma in Italian and Spanish, a point in
// English, as the booth reads them. render() runs on a stand-in stage, without a DOM.
//   node --test tests/web/graphics.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.HTMLElement ??= class {};
const { decimal } = await import("../../web/graphics/shared/sd-graphic.mjs");
const { default: PassShot } = await import("../../web/graphics/pass_shot/graphic.mjs");
const { default: Nameplate } = await import("../../web/graphics/nameplate/graphic.mjs");

// a stage whose querySelector hands out one stand-in element per selector
function render(Graphic, data, lang) {
  const els = {};
  const el = () => ({ textContent: "", innerHTML: "", style: {}, classList: { toggle() {}, add() {}, remove() {} }, scrollWidth: 0, clientWidth: 0, querySelector: () => el() });
  const g = Object.assign(Object.create(Graphic.prototype), { data, lang, players: {}, showFacts: false,
    stage: { querySelector: (s) => (els[s] ??= el()) } });
  g.render();
  return (s) => els[s].textContent;
}

test("decimal: a comma in Italian and Spanish, a point in English", () => {
  assert.equal(decimal(48.24, 1, "en"), "48.2");
  assert.equal(decimal(48.24, 1, "it"), "48,2");
  assert.equal(decimal(48.24, 1, "es"), "48,2");
  assert.equal(decimal(123.4, 0, "it"), "123");
});

test("pass and shot card: the big value and the quality numbers follow the language", () => {
  const data = { mode: "pass", player_id: "p1", value: 48.24, unit: "m", quality: { value: 7.5, max: 10 } };
  for (const [lang, big, q] of [["en", "48.2", "7.5/10"], ["it", "48,2", "7,5/10"], ["es", "48,2", "7,5/10"]]) {
    const text = render(PassShot, data, lang);
    assert.equal(text(".big"), big, lang);
    assert.equal(text(".qval"), q, lang);
  }
  assert.equal(render(PassShot, { ...data, value: 112.6 }, "it")(".big"), "113", "no decimals from 100 up");
  assert.equal(render(PassShot, { ...data, value: 99.96 }, "it")(".big"), "100", "rounded before the 100 test");
  assert.equal(render(PassShot, { ...data, value: 99.94 }, "it")(".big"), "99,9");
  assert.equal(render(PassShot, { ...data, value: 112.45 }, "it")(".big"), "112", "rounded once");
  assert.equal(render(PassShot, { ...data, value: 100.45 }, "it")(".big"), "100", "rounded once");
  assert.equal(render(PassShot, { ...data, value: null }, "it")(".big"), "", "no value, no number");
});

test("name plate: the speed follows the language", () => {
  const data = { player_id: "p1", name: "N", speed_kmh: 33.84 };
  assert.equal(render(Nameplate, data, "en")(".speed"), "33.8 km/h");
  assert.equal(render(Nameplate, data, "it")(".speed"), "33,8 km/h");
  assert.equal(render(Nameplate, data, "es")(".speed"), "33,8 km/h");
});
