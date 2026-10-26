// web/js/proof.js: what the "Show proof" panel lists for each graphic of the DEMO and M001-M004 packs.
//   node --test tests/web/proof.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Proof, proofOf, proofWords, numbersIn, onAirText, STRINGS, FACT_KINDS, EVENT_KINDS } from "../../web/js/proof.js";
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
const PACKS = Object.fromEntries(["DEMO", "M001", "M002", "M003", "M004"].map((m) => [m, pack(m)]));

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

  test(`${m}: each number of a check-in comes from the fact of its own line`, () => {
    for (const cue of P.match.cues.filter((c) => c.payload.kind === "checkin")) {
      const ids = cue.payload.fact_ids, pr = proofOf(cue, P.ctx(cue)), values = pr.numbers.filter((x) => x.kind === "value");
      const want = cue.payload.body.split("\n").map((l, i) => (/\d/.test(l) ? ids[i] : null)).filter(Boolean);
      assert.deepEqual(values.map((x) => x.src.fact.fact_id), want, `${cue.cue_id} ${cue.lang}: ${onAirText(cue)}`);
    }
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
  assert.equal(w.checks.at(-1)[1], "Approvata in automatico (rischio basso)");
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
  // in the page the desk gives a generated graphic its status, so the panel says who put it on air
  const ok = proofWords(proofOf(tpl, { ...P.ctx(tpl), status: "auto_approved" }), { match: P.match, minute: P.minute, lang: "en", what: "" });
  assert.equal(ok.checks.at(-1)[1], "Approved automatically (low risk)");
  const cue = P.match.cues.find((c) => c.story_id === "S-000002" && c.lang === "en");
  const edited = { ...cue, payload: { ...cue.payload, body: "Ivo Grieve hit 38 km/h on the way in." } };
  const pr = proofOf(edited, { ...P.ctx(edited), status: "edited" });
  assert.equal(pr.numbersOk, false);
  const ew = proofWords(pr, { match: P.match, minute: P.minute, lang: "en", what: "" });
  assert.equal(ew.numbers.find((x) => x.text === "38").about, "not found in the facts of this story");
  assert.equal(ew.checks.at(-1)[1], "Edited and approved by the producer");
});

test("on-air text of a pass or shot: the same digits as the graphic, the 100 threshold on the value rounded to tenths", () => {
  const big = (value) => onAirText({ graphic: "pass_shot", payload: { value, unit: "km/h" } }).split(" ")[0];
  assert.equal(big(48.24), "48.2");
  assert.equal(big(99.94), "99.9");
  assert.equal(big(99.96), "100");
  assert.equal(big(112.45), "112");
});

test("M001 team shape: the ten values on screen, each found in the panel's own facts, in Italian with a decimal comma", () => {
  const P = PACKS.M001, cue = P.match.cues.find((c) => c.graphic === "team_stats" && c.lang === "it");
  const pr = proofOf(cue, P.ctx(cue));
  assert.equal(pr.numbers.length, 10);
  assert.deepEqual(pr.numbers.map((x) => x.kind), ["formation", "formation", ...Array(8).fill("value")]);
  assert.ok(pr.numbers.some((x) => /^\d+,\d$/.test(x.text)), onAirText(cue));
  assert.equal(pr.numbersOk, true);
  assert.deepEqual(pr.facts.map((f) => f.fact_id), cue.payload.fact_ids);
  // each value on screen cites its own fact, home then away, even when the two read the same
  assert.deepEqual(pr.numbers.map((x) => x.src.fact.fact_id), cue.payload.fact_ids);
  // the press values are read on their /10 scale, the distances in metres
  assert.deepEqual([...new Set(pr.numbers.slice(2).map((x) => x.unit))].sort(), ["/10", "m"]);
});

test("M001 line-ups: the two formations on screen, each found in its team's start_formation fact; shirt numbers are not numbers", () => {
  const P = PACKS.M001;
  for (const cue of P.match.cues.filter((c) => c.graphic === "lineup")) {
    const pr = proofOf(cue, P.ctx(cue));
    assert.deepEqual(pr.numbers.map((x) => x.kind), ["formation", "formation"], cue.cue_id);
    assert.equal(pr.numbersOk, true, cue.cue_id);
    assert.deepEqual(pr.numbers.map((x) => x.src.fact.kind), ["start_formation", "start_formation"]);
    assert.deepEqual(pr.facts.map((f) => f.fact_id), cue.payload.fact_ids);
  }
  // one per sheet (analyst, casual, kids, the two teams and three players) in en, it and es
  assert.equal(P.match.cues.filter((c) => c.graphic === "lineup").length, 24);
});

test("M001 fillers, every one: each number on screen comes from its own fact, in the words of its audience and language", () => {
  const P = PACKS.M001, fill = P.match.cues.filter((c) => c.payload.filler), facts = new Map(P.match.facts.map((f) => [f.fact_id, f]));
  const home = P.match.meta.teams[0].team_id, dec = (v, lang) => (lang === "en" ? v.toFixed(1) : v.toFixed(1).replace(".", ","));
  const Q = { en: "Difficulty {}/10", it: "Difficoltà {}/10", es: "Dificultad {}/10" }, QK = { en: "How hard: {}/10", it: "Quanto era difficile: {}/10", es: "Qué difícil: {}/10" };
  const TOUCH = { en: /^Touched the ball \d+ times?$/, it: /^Ha toccato il pallone \d+ volt[ae]$/, es: /^Ha tocado el balón \d+ ve(z|ces)$/ };
  const kinds = new Set();
  for (const c of fill) {
    const p = c.payload, pr = proofOf(c, P.ctx(c)), at = `${c.cue_id} ${c.audience} ${c.lang}: ${onAirText(c)}`, kids = c.audience === "kids";
    const src = pr.numbers.map((x) => x.src.fact.kind);
    assert.equal(c.story_id, null, at);
    assert.equal(pr.numbersOk, true, at);
    assert.ok(pr.facts.length && pr.facts.every((f) => !f.missing), at);
    kinds.add(`${c.graphic}${kids ? " kids" : ""}`);
    if (c.graphic === "pass_shot") {
      const [d, q] = p.fact_ids.map((id) => facts.get(id));
      assert.deepEqual(src, ["pass_distance", "pass_difficulty"], at);
      assert.deepEqual([d.kind, q.kind, p.mode, p.value], ["pass_distance", "pass_difficulty", "pass", d.value], at);
      assert.equal(p.quality, (kids ? QK : Q)[c.lang].replace("{}", dec(q.value, c.lang)), at);
    } else if (c.graphic === "nameplate") {
      assert.deepEqual(src, ["sprint_speed"], at);
      assert.equal(p.speed_kmh, facts.get(p.fact_id).value, at);
    } else if (c.graphic === "momentum") {
      const win = p.fact_ids.map((id) => facts.get(id));
      assert.ok(win.every((f) => f.kind === "momentum"), at);
      assert.deepEqual([p.home, p.away], [win.filter((f) => f.team_id === home).map((f) => f.value), win.filter((f) => f.team_id !== home).map((f) => f.value)], at);
    } else if (c.graphic === "why_card") {
      assert.equal(p.kind, "checkin", at);
      assert.ok(p.fact_ids.every((id) => facts.get(id).kind.startsWith("checkin_")), at);
      assert.equal(TOUCH[c.lang].test(p.body.split("\n")[0]), kids, at);
    } else {
      assert.equal(c.graphic, "lineup", at);
      assert.deepEqual(src, ["start_formation", "start_formation"], at);
    }
  }
  assert.deepEqual([...kinds].sort(), ["lineup", "lineup kids", "momentum", "momentum kids", "nameplate", "nameplate kids",
    "pass_shot", "pass_shot kids", "why_card", "why_card kids"]);
});

test("the numbers in a line: minutes, a /10 scale, a formation, a score and a unit", () => {
  const got = numbersIn("Al 45+2' 8,5/10, the 8th minute, en el minuto 10: 4-3-3 al 4-4-2, 2-1, 1.9 km, 83%, (10', 13')")
    .map(({ text, kind, unit, m }) => [text, kind, unit ?? m ?? ""]);
  assert.deepEqual(got, [["45+2'", "minute", "45+2"], ["8,5/10", "value", "/10"], ["8th minute", "minute", "8"], ["minuto 10", "minute", "10"],
    ["4-3-3", "formation", ""], ["4-4-2", "formation", ""], ["2-1", "score", ""], ["1.9", "value", "km"], ["83", "value", "%"], ["10'", "minute", "10"], ["13'", "minute", "13"]]);
  // the phrasebook's later minutes drop the word (rules.py _at), and a distance may be spelled out
  const short = numbersIn("to 7.5/10 by the 20th, en el 20, entre el minuto 70 y el 80, al 70, all'80, en el minuto 45+2, from 25 metres, da 26 metri, el 25%")
    .map(({ text, kind, unit, m }) => [text, kind, unit ?? m ?? ""]);
  assert.deepEqual(short, [["7.5/10", "value", "/10"], ["by the 20th", "minute", "20"], ["el 20", "minute", "20"], ["minuto 70", "minute", "70"],
    ["el 80", "minute", "80"], ["al 70", "minute", "70"], ["all'80", "minute", "80"], ["minuto 45+2", "minute", "45+2"], ["25", "value", "m"],
    ["26", "value", "m"], ["25", "value", "%"]]);
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

test("the open panel follows a producer's edit of the graphic on air, and says when it is taken off", () => {
  const el = () => ({ attrs: {}, kids: [], dataset: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, append(...k) { this.kids.push(...k); },
    replaceChildren(...k) { this.kids = k; }, contains: () => false, querySelector: () => null, focus() {} });
  globalThis.document = { createElement: el, createElementNS: el, activeElement: null };
  const P = PACKS.M001, cue = P.match.cues.find((c) => c.graphic === "why_card" && c.story_id && /km\/h/.test(c.payload.body) && c.lang === "en");
  let status = "auto_approved";
  const desk = { byId: P.stories, genFor: () => null, factIndex: P.ctx(cue).factIndex, eventIndex: P.ctx(cue).eventIndex,
    clockText: P.minute, status: () => status, usedProposal: () => false, what: () => "Goal" };
  const pf = new Proof(el(), el(), { desk, match: P.match, state: { lang: "en" }, pitch: {}, view3d: () => null, onLayout() {} });
  pf.update([cue]);
  Object.assign(pf, { openId: cue.cue_id, cue, key: "" });
  pf.update([cue]);
  assert.equal(pf.proof.numbersOk, true);
  // the desk airs the edit as a new cue object under the same id
  const edited = { ...cue, payload: { ...cue.payload, body: cue.payload.body.replace(/\d+(?:\.\d)? km\/h/, "999.9 km/h") } };
  status = "edited";
  pf.update([edited]);
  assert.equal(pf.cue, edited);
  assert.equal(pf.proof.numbersOk, false);
  assert.equal(proofWords(pf.proof, { match: P.match, minute: P.minute, lang: "en", what: "" }).checks.at(-1)[1], STRINGS.en.ap_edited);
  for (const st of ["rejected", "expired"]) {
    status = st;
    pf.update([{ ...edited }]);
    assert.ok(!/ap_/.test(proofWords(pf.proof, { match: P.match, minute: P.minute, lang: "it", what: "" }).checks.at(-1)[1]), st);
  }
  delete globalThis.document;
});

test("a casual or kids line the code wrote from the facts says so, without the verifier of the AI's line", () => {
  const P = PACKS.DEMO, cue = P.match.cues.find((c) => c.cue_id === "C-000013"), s = P.stories.get(cue.story_id);
  assert.notEqual(cue.payload.body, s.texts.en);
  const pr = proofOf(cue, P.ctx(cue));
  assert.deepEqual([pr.writer, pr.verifier], ["phrasebook", null]);
  const ai = P.match.cues.find((c) => c.story_id === cue.story_id && c.audience === "analyst" && c.lang === "en");
  assert.equal(proofOf(ai, P.ctx(ai)).writer, "ai");
});

test("M001 goal at 10' after Use proposal: the AI wrote it and the producer put it on air", () => {
  const P = PACKS.M001, cue = P.match.cues.find((c) => c.story_id === "S-000002" && c.graphic === "why_card" && c.lang === "en" && c.audience === "analyst");
  const pr = proofOf(cue, { ...P.ctx(cue), status: "proposal" }), w = proofWords(pr, { match: P.match, minute: P.minute, lang: "en", what: "" });
  assert.equal(w.checks[0][1], "The AI commentator");
  assert.equal(w.checks.at(-1)[1], "The AI proposal, put on air by the producer");
  assert.ok(!w.checks.some(([k]) => k === "Verifier"));
  for (const lang of ["it", "es"]) assert.notEqual(proofWords(pr, { match: P.match, minute: P.minute, lang, what: "" }).checks.at(-1)[1], "ap_proposal");
});

test("a number on screen is its fact rounded half up: a stored 17.5 is 18, not 17, and 1650 m is 1.7 km, not 1.6", () => {
  const facts = [{ fact_id: "F1", kind: "pass_distance", value: 17.5, unit: "m", source_event_ids: [] },
    { fact_id: "F2", kind: "distance_covered", value: 1650, unit: "m", source_event_ids: [] }];
  const ctx = { story: null, factIndex: new Map(facts.map((f) => [f.fact_id, f])), eventIndex: new Map(), match: { players: {} }, minute: () => "1" };
  const ok = (body) => proofOf({ graphic: "why_card", payload: { title: "", body, fact_ids: ["F1", "F2"] } }, ctx).numbersOk;
  assert.deepEqual(["A pass of 18 m.", "A pass of 17 m.", "He ran 1.7 km.", "He ran 1.6 km."].map(ok), [true, false, true, false]);
});
