// web/js/proof.js: what the "Show proof" panel lists for each graphic of the DEMO and M001 packs.
//   node --test tests/web/proof.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { proofOf, proofWords, numbersIn, onAirText, STRINGS, FACT_KINDS, EVENT_KINDS } from "../../web/js/proof.js";
import { Match } from "../../web/js/match.js";

const root = new URL("../../", import.meta.url);
const read = (m, f) => JSON.parse(readFileSync(new URL(`web/data/${m}/${f}.json`, root), "utf8"));
const LANGS = ["en", "it", "es"];

function pack(m) {
  const match = new Match(read(m, "meta"), read(m, "events"), read(m, "facts"), read(m, "cues"), new Float32Array(0));
  const stories = new Map(read(m, "stories").map((s) => [s.story_id, s]));
  // as desk.js clockText, at the verifier's minute (ts - 1e-6)
  const minute = (ts) => { const c = match.clock(Math.max(0, ts - 1e-6)), b = c.period === 1 ? 45 : 90; return c.minute > b ? `${b}+${c.minute - b}` : String(c.minute); };
  const ctx = (cue) => {
    const story = cue.story_id ? stories.get(cue.story_id) : null;
    return { story, factIndex: new Map(match.facts.map((f) => [f.fact_id, f])), eventIndex: new Map(match.events.map((e) => [e.event_id, e])),
      match, minute, status: story ? (story.safety === "flagged" ? "needs_review" : story.default_status) : null };
  };
  return { match, stories, minute, ctx };
}
const PACKS = Object.fromEntries(["DEMO", "M001"].map((m) => [m, pack(m)]));

// Every digit run the panel may show for a cue, built straight from the ledger: the cited facts' values at
// the roundings the lines use, formation and score digits, "10" of a /10 scale, the minutes of the facts,
// the cited events and the moment.
function allowed({ match, minute }, pr) {
  const ok = new Set(["0"]);
  const add = (s) => { for (const d of String(s).match(/\d+(?:[.,]\d+)?/g) ?? []) ok.add(d); };
  for (const f of pr.facts.filter((x) => !x.missing)) {
    const v = Number(f.value);
    for (const x of [v, v / 1000]) { add(Math.round(x)); add(x.toFixed(1)); add(x.toFixed(1).replace(".", ",")); }
    if (f.unit === "formation") add(String(Math.round(v)).split("").join("-"));
    if (f.unit === "/10") add("10");
    if (f.kind === "score") add(match.score(f.ts).join("-"));
    add(minute(f.ts).replace("+", " "));
  }
  for (const e of [...pr.events, ...(pr.story?.evidence_event_ids ?? []).map((id) => match.events.find((x) => x.event_id === id)).filter(Boolean)]) add(minute(e.ts).replace("+", " "));
  if (pr.story) add(minute(pr.story.ts).replace("+", " "));
  return ok;
}

for (const [m, P] of Object.entries(PACKS)) {
  test(`${m}: the panel lists exactly the facts of the story on air, or of the template graphic`, () => {
    for (const cue of P.match.cues) {
      const pr = proofOf(cue, P.ctx(cue)), p = cue.payload;
      const want = cue.story_id ? P.stories.get(cue.story_id).fact_ids : p.fact_ids ?? (p.fact_id ? [p.fact_id] : []);
      assert.deepEqual(pr.facts.map((f) => f.fact_id), [...new Set(want)], cue.cue_id);
      assert.ok(pr.facts.every((f) => !f.missing), `${cue.cue_id}: a cited fact is not in the ledger`);
    }
  });

  test(`${m}: every number on screen has its source in the story's facts`, () => {
    let n = 0;
    for (const cue of P.match.cues) {
      const pr = proofOf(cue, P.ctx(cue));
      n += pr.numbers.length;
      for (const x of pr.numbers) assert.ok(x.src, `${cue.cue_id} (${cue.lang}): "${x.text}" in "${onAirText(cue)}" has no source`);
      assert.equal(pr.numbersOk, true);
    }
    assert.ok(n > 10, `only ${n} numbers on screen`);
  });

  test(`${m}: every number the panel shows, in every language, comes from the fact ledger`, () => {
    for (const cue of P.match.cues) {
      const pr = proofOf(cue, P.ctx(cue)), ok = allowed(P, pr);
      for (const lang of LANGS) {
        const w = proofWords(pr, { match: P.match, minute: P.minute, lang, what: "" });
        const text = JSON.stringify([w.numbers.map((x) => x.about), w.facts, w.events, w.eventsNote, w.checks]).replace(/\d+\+\d+/g, (s) => s.replace("+", " "));
        for (const d of text.match(/\d+(?:[.,]\d+)?/g) ?? []) assert.ok(ok.has(d), `${cue.cue_id} ${lang}: ${d} is not from the ledger (${text})`);
      }
    }
  });

  test(`${m}: the cited players are the story's, its facts' and its events', all in the match`, () => {
    for (const cue of P.match.cues.filter((c) => c.story_id)) {
      const pr = proofOf(cue, P.ctx(cue)), s = pr.story;
      if (s.player_id) assert.ok(pr.players.has(s.player_id), cue.cue_id);
      for (const id of pr.players) assert.ok(P.match.players[id], id);
      assert.ok(pr.events.length <= 6);
    }
  });
}

test("M001 goal at 10': the numbers, the facts, the event and the checks, in Italian", () => {
  const P = PACKS.M001, cue = P.match.cues.find((c) => c.story_id === "S-000002" && c.graphic === "why_card" && c.lang === "it" && c.audience === "analyst");
  const pr = proofOf(cue, P.ctx(cue)), w = proofWords(pr, { match: P.match, minute: P.minute, lang: "it", what: "Gol 10'" });
  assert.deepEqual(pr.numbers.map((x) => [x.text, x.kind]), [["10'", "minute"], ["92", "value"], ["1-0", "score"]]);
  assert.equal(pr.numbers[1].src.fact.fact_id, "F-SHOT_SPEED-000002");
  assert.equal(w.numbers[1].about, "Velocità del tiro, Chidi Okowande, 92,1 km/h al minuto 10".replace("Chidi Okowande", P.match.players["T01-9"].name));
  assert.equal(w.numbers[2].about, "il risultato dopo il gol al minuto 10");
  assert.deepEqual(w.facts[0], { what: "Risultato, Redwick Wanderers", value: "1-0", minute: "10'" });
  assert.deepEqual(w.events.map((e) => [e.minute, e.kind]), [["10'", "Gol"]]);
  assert.deepEqual(w.checks.map(([k]) => k), ["Scritto da", "Controllo dei numeri (codice)", "Sicurezza", "In onda perché"]);
  assert.equal(w.checks[0][1], "Frasario (codice)");
  assert.equal(w.checks.at(-1)[1], "Approvata dalla regola del rischio");
  assert.ok(pr.players.has("T01-9"));
});

test("M001 recap: hundreds of cited events give the goals only, and say there are more", () => {
  const P = PACKS.M001, cue = P.match.cues.find((c) => c.story_id === "S-000015" && c.lang === "en" && c.audience === "analyst");
  const pr = proofOf(cue, P.ctx(cue));
  assert.equal(pr.more, true);
  assert.deepEqual(pr.events.map((e) => e.event_id), [176, 203, 766, 1204]);
  assert.equal(proofWords(pr, { match: P.match, minute: P.minute, lang: "en", what: "" }).eventsNote, "It also draws on more events of the match.");
});

test("a template graphic is written by code and needs no approval; a producer's edit is checked again", () => {
  const P = PACKS.DEMO, tpl = P.match.cues.find((c) => c.story_id === null && c.graphic === "pass_shot");
  const w = proofWords(proofOf(tpl, P.ctx(tpl)), { match: P.match, minute: P.minute, lang: "es", what: "" });
  assert.deepEqual(w.checks.map(([, v]) => v), ["El código, directamente de los datos, sin IA", "Cada cifra coincide con el registro de datos", "Un gráfico estándar no necesita aprobación"]);
  const cue = P.match.cues.find((c) => c.story_id === "S-000002" && c.lang === "en");
  const edited = { ...cue, payload: { ...cue.payload, body: "Ivo Grieve hit 38 km/h on the way in." } };
  const pr = proofOf(edited, { ...P.ctx(edited), status: "edited" });
  assert.equal(pr.numbersOk, false);
  const ew = proofWords(pr, { match: P.match, minute: P.minute, lang: "en", what: "" });
  assert.equal(ew.numbers.find((x) => x.text === "38").about, "not found in the facts of this story");
  assert.equal(ew.checks.at(-1)[1], "Edited and approved by the producer");
});

test("the numbers in a line: minutes, a /10 scale, a formation, a score and a unit", () => {
  const got = numbersIn("Al 45+2' 8,5/10, the 8th minute, en el minuto 10: 4-3-3 al 4-4-2, 2-1, 1.9 km, 83%, (10', 13')")
    .map(({ text, kind, unit, m }) => [text, kind, unit ?? m ?? ""]);
  assert.deepEqual(got, [["45+2'", "minute", "45+2"], ["8,5/10", "value", "/10"], ["8th minute", "minute", "8"], ["minuto 10", "minute", "10"],
    ["4-3-3", "formation", ""], ["4-4-2", "formation", ""], ["2-1", "score", ""], ["1.9", "value", "km"], ["83", "value", "%"], ["10'", "minute", "10"], ["13'", "minute", "13"]]);
});

test("every string, fact kind and event kind is in the three languages, and the pack's kinds have a name", () => {
  for (const table of [STRINGS, FACT_KINDS, EVENT_KINDS]) for (const lang of ["it", "es"]) assert.deepEqual(Object.keys(table[lang]).sort(), Object.keys(table.en).sort(), lang);
  for (const P of Object.values(PACKS)) {
    for (const f of P.match.facts) assert.ok(FACT_KINDS.en[f.kind], f.kind);
    for (const e of P.match.events) assert.ok(EVENT_KINDS.en[e.type_name], e.type_name);
  }
  // no em dash, and Italian with its accents
  for (const lang of LANGS) assert.ok(!JSON.stringify([STRINGS[lang], FACT_KINDS[lang], EVENT_KINDS[lang]]).includes("—"), lang);
  assert.ok(!/ e' | perche' | piu' /.test(JSON.stringify(STRINGS.it)));
});
