// The season on the page (web/js/season.js) and its card (web/graphics/season_card): every number is a
// season fact's, the recorded cues are left as they are.
//   node --test tests/web/season.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { withSeason, seasonCard, goalLines, ordinal, loadSeason } from "../../web/js/season.js";

globalThis.HTMLElement ??= class {};
const { default: SeasonCard } = await import("../../web/graphics/season_card/graphic.mjs");
const { default: WhyCard } = await import("../../web/graphics/why_card/graphic.mjs");

const f = (fact_id, kind, value, o = {}) => ({ fact_id, kind, value, ts: 0, team_id: null, player_id: null, source_event_ids: [], detail: null, ...o });
const SEASON = [
  f("F-SEASON_MATCHWEEK-000001", "season_matchweek", 10),
  f("F-SEASON_POSITION-000001", "season_position", 1, { team_id: "T01" }),
  f("F-SEASON_POSITION-000002", "season_position", 6, { team_id: "T02" }),
  f("F-SEASON_POSITION-000003", "season_position", 2, { team_id: "T03" }),
  f("F-SEASON_POINTS-000001", "season_points", 22, { team_id: "T01" }),
  f("F-SEASON_POINTS-000002", "season_points", 10, { team_id: "T02" }),
  f("F-SEASON_GOAL_DIFFERENCE-000001", "season_goal_difference", 9, { team_id: "T01" }),
  f("F-SEASON_GOAL_DIFFERENCE-000002", "season_goal_difference", -4, { team_id: "T02" }),
  f("F-SEASON_FORM-000001", "season_form", 13, { team_id: "T01", detail: { results: ["W", "D", "W", "W", "W"] } }),
  f("F-SEASON_FORM-000002", "season_form", 4, { team_id: "T02", detail: { results: ["L", "D", "L", "W", "L"] } }),
  f("F-SEASON_H2H-000001", "season_h2h", 1, { team_id: "T01", detail: { matchweek: 3, home_team_id: "T02", away_team_id: "T01", meetings: 1 } }),
  f("F-SEASON_H2H-000002", "season_h2h", 2, { team_id: "T02", detail: { matchweek: 3, home_team_id: "T02", away_team_id: "T01", meetings: 1 } }),
  f("F-SEASON_GOALS-000001", "season_goals", 5, { team_id: "T01", player_id: "T01-9" }),
  f("F-SEASON_GOALS-000002", "season_goals", 2, { team_id: "T01", player_id: "T01-7" }),
  f("F-SEASON_GOALS-000003", "season_goals", 0, { team_id: "T02", player_id: "T02-9" }),
  f("F-SEASON_GOALS-000004", "season_goals", 6, { ts: 595.7, team_id: "T01", player_id: "T01-9", source_event_ids: [176] }),
  f("F-SEASON_SCORING_RUN-000001", "season_scoring_run", 3, { ts: 595.7, team_id: "T01", player_id: "T01-9", source_event_ids: [176] }),
  f("F-SEASON_GOALS-000005", "season_goals", 7, { ts: 772.6, team_id: "T01", player_id: "T01-9", source_event_ids: [176, 203] }),
  f("F-SEASON_GOALS-000006", "season_goals", 1, { ts: 900, team_id: "T02", player_id: "T02-9", source_event_ids: [300] }),
];
const MATCH = {
  meta: { match_id: "M001" }, home: { team_id: "T01", side: "home" }, away: { team_id: "T02", side: "away" },
  players: { "T01-9": { name: "Okowande" }, "T01-7": { name: "Lindqvist" } },
  goals: [{ fact_id: "F-SCORE-000001", source_event_ids: [176] }, { fact_id: "F-SCORE-000002", source_event_ids: [203] },
    { fact_id: "F-SCORE-000003", source_event_ids: [300] }],
};
const cue = (cue_id, ts, title, fact_ids, kind = "why") => ({ cue_id, story_id: "S", ts, duration_s: 12, graphic: "why_card", audience: "analyst", lang: "en",
  payload: { kind, title, body: "b", fact_ids } });

test("the card: the two clubs' lines, the last meeting and the top scorers, each number a season fact's", () => {
  const c = seasonCard(SEASON, MATCH);
  assert.equal(c.matchweek, 10);
  assert.deepEqual(c.rows, [{ side: "home", pos: 1, pts: 22, gd: 9, form: ["W", "D", "W", "W", "W"] },
    { side: "away", pos: 6, pts: 10, gd: -4, form: ["L", "D", "L", "W", "L"] }]);
  assert.deepEqual(c.h2h, { matchweek: 3, home: "away", away: "home", home_goals: 2, away_goals: 1 });
  assert.deepEqual(c.scorers, [{ side: "home", name: "Okowande", goals: 5 }], "no scorer for a club with none");
  assert.ok(!c.fact_ids.includes("F-SEASON_POSITION-000003"), "the other clubs are left out");
  assert.equal(new Set(c.fact_ids).size, 12);
});

test("goal lines: the tally with this goal, the run, a first goal; in three languages", () => {
  assert.deepEqual(goalLines(SEASON, 176, "en"), ["6th league goal of the season", "Scored in 3 league matches in a row"]);
  assert.deepEqual(goalLines(SEASON, 203, "it"), ["7° gol in campionato in questa stagione"]);
  assert.deepEqual(goalLines(SEASON, 300, "es"), ["Primer gol en liga esta temporada"]);
  assert.deepEqual(goalLines(SEASON, 999, "en"), []);
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 111].map((n) => ordinal(n, "en")),
    ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "111th"]);
});

test("the sheet: the card at kick-off, lines on the first why card of each goal, the recorded cues untouched", () => {
  const sheet = [cue("C-2", 602, "Goal", ["F-SCORE-000001"]), cue("C-3", 610, "Comeback", ["F-SCORE-000001"]),
    cue("C-1", 480, "Big chance", ["F-SHOT_SPEED-000001"]), cue("C-4", 780, "Recap", ["F-SCORE-000002"], "recap")];
  const before = JSON.stringify(sheet);
  const out = withSeason(sheet, SEASON, MATCH, "en");
  assert.equal(JSON.stringify(sheet), before, "the sheet's cues are not changed");
  assert.equal(out.length, sheet.length + 1);
  const card = out.find((c) => c.graphic === "season_card");
  assert.deepEqual([card.ts, card.duration_s, card.story_id, card.audience], [0, 12, null, "analyst"]);
  const by = Object.fromEntries(out.map((c) => [c.cue_id, c]));
  assert.deepEqual(by["C-2"].payload.season, ["6th league goal of the season", "Scored in 3 league matches in a row"]);
  assert.equal(by["C-3"].payload.season, undefined, "one card per goal");
  assert.equal(by["C-4"].payload.season, undefined, "a recap is not a goal card");
  assert.equal(by["C-1"], sheet[2], "a card without a goal is the same object");
  assert.equal(withSeason(sheet, null, MATCH, "en"), sheet, "no season, the sheet as it was");
});

test("no season.json: null", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  try { assert.equal(await loadSeason("data/DEMO"), null); } finally { globalThis.fetch = real; }
});

function render(Graphic, data, lang) {
  const els = {};
  const el = () => ({ textContent: "", innerHTML: "", style: {}, classList: { toggle() {}, add() {}, remove() {} }, scrollHeight: 0, querySelector: () => el() });
  const g = Object.assign(Object.create(Graphic.prototype), { data, lang, showFacts: false, players: {},
    teams: { home: { short: "RED", color: "#ff0000" }, away: { short: "OST", color: "#0000ff" } },
    stage: { querySelector: (s) => (els[s] ??= el()), classList: { contains: () => false } } });
  g.render();
  return (s) => els[s];
}

test("season card: words, ordinals and form letters follow the language", () => {
  const data = seasonCard(SEASON, MATCH);
  for (const [lang, kicker, title, pos, form, met] of [
    ["en", "SEASON SO FAR", "Matchweek 10", "1st", ">W<", "Matchweek 3: OST 2-1 RED"],
    ["it", "LA STAGIONE FIN QUI", "10ª giornata", "1°", ">V<", "3ª giornata: OST 2-1 RED"],
    ["es", "LA TEMPORADA HASTA AHORA", "Jornada 10", "1.º", ">G<", "Jornada 3: OST 2-1 RED"]]) {
    const $ = render(SeasonCard, data, lang);
    assert.equal($(".kicker").textContent, kicker);
    assert.equal($(".title").textContent, title);
    const table = $(".table").innerHTML;
    for (const s of [pos, ">22<", ">+9<", ">-4<", form, "RED", "OST"]) assert.ok(table.includes(s), `${lang} ${s}`);
    assert.ok($(".more").innerHTML.includes(met), `${lang} last meeting`);
    assert.ok($(".more").innerHTML.includes("Okowande"), lang);
  }
});

test("season card: a last meeting or a scorer without its numbers prints no null", () => {
  const data = seasonCard(SEASON, MATCH);
  data.h2h = { ...data.h2h, away_goals: null };
  data.scorers = data.scorers.map((s) => ({ ...s, goals: undefined }));
  const more = render(SeasonCard, data, "en")(".more").innerHTML;
  assert.ok(!more.includes("null") && !more.includes("undefined") && !more.includes("Last meeting"), more);
  assert.ok(more.includes("Okowande"), more);
});

test("why card: the season lines under the body, escaped; none without them", () => {
  const $ = render(WhyCard, { kind: "why", title: "Goal", body: "b", fact_ids: [], season: ["6th league goal <b>", "Scored in 3"] }, "en");
  assert.equal($(".season").innerHTML, "<div>6th league goal &#60;b&#62;</div><div>Scored in 3</div>");
  assert.equal(render(WhyCard, { kind: "why", title: "Goal", body: "b", fact_ids: [] }, "en")(".season").innerHTML, "");
});
