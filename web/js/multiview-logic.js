// The multiviewer's pure logic (web/multiview.html): the link each window opens, the windows that drifted
// from the reference clock, and the name strip (UMD) under each picture. No DOM here: tests/web/multiview.test.mjs.

// one producer desk, four outputs: the same moment for four audiences in three languages
export const WINDOWS = [
  { audience: "analyst", lang: "en" },
  { audience: "kids", lang: "en" },
  { audience: "team:T02", lang: "it" },
  { audience: "casual", lang: "es" },
];
export const DRIFT_S = 0.3;   // a window further than this from the reference clock is seeked back to it

/** The broadcast page for one window: the existing ?match=&t=&audience=&lang=&view=&speed=&play= link. */
export function windowUrl({ match, t, audience, lang, view = "2d", speed = 1, play = false }) {
  const p = new URLSearchParams({ match, t: String(t), audience, lang, view, speed: String(speed) });
  if (play) p.set("play", "1");
  return `index.html?${p}`;
}

/** Indices of the windows whose clock is more than tol seconds from ref; a window not loaded yet (null) is left alone. */
export function lagging(times, ref, tol = DRIFT_S) {
  return times.flatMap((t, i) => (Number.isFinite(t) && Math.abs(t - ref) > tol ? [i] : []));
}

/** The largest distance from ref among the loaded windows, in seconds (0 with none). */
export function drift(times, ref) {
  return Math.max(0, ...times.filter(Number.isFinite).map((t) => Math.abs(t - ref)));
}

const AUDIENCES = { analyst: "Analyst", casual: "Casual fan", kids: "Kids" };
/** "Kids · EN", "Ostwick FC fan · IT": teams maps a team id to its name (the team id until the match loads). */
export function umdLabel({ audience, lang }, teams = {}) {
  const [kind, id] = audience.split(":");
  const who = kind === "team" ? `${teams[id] ?? id} fan` : AUDIENCES[audience] ?? audience;
  return `${who} · ${lang.toUpperCase()}`;
}
