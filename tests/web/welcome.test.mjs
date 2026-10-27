// web/js/welcome.js: when the first visit's welcome shows, and its strings.
//   node --test tests/web/welcome.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY, WELCOME_STRINGS, wantsWelcome } from "../../web/js/welcome.js";

const store = (v) => ({ getItem: (k) => (k === KEY ? v : null) });

test("shows on a plain first visit, or with only the language", () => {
  assert.equal(wantsWelcome("", store(null)), true);
  assert.equal(wantsWelcome("?lang=it", store(null)), true);
});

test("never on a deep link or once dismissed", () => {
  for (const q of ["?match=M001", "?t=590", "?view=2d", "?play=1", "?audience=casual&lang=es"]) assert.equal(wantsWelcome(q, store(null)), false, q);
  assert.equal(wantsWelcome("", store("done")), false);
});

test("blocked storage still shows it", () => {
  assert.equal(wantsWelcome("", { getItem() { throw new Error("SecurityError"); } }), true);
  assert.equal(wantsWelcome("", null), true);
});

test("every language has every key, with no dashes", () => {
  const keys = Object.keys(WELCOME_STRINGS.en).sort();
  for (const [lang, words] of Object.entries(WELCOME_STRINGS)) {
    assert.deepEqual(Object.keys(words).sort(), keys, lang);
    for (const w of Object.values(words)) assert.doesNotMatch(w, /[–—]/, `${lang}: ${w}`);
  }
});
