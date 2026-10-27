// The season before the replayed match (docs/CONTRACT.md, Season additions), from season.json: a card at
// kick-off and a line on each goal's card. Every number comes from a season fact; the recorded cues are
// never changed, the sheet gets new cue objects.

export const SEASON_CARD_S = 12;

// The goal card's season lines; it and es for native review (docs/season.md)
export const SEASON_STRINGS = {
  en: { goal: "{n} league goal of the season", first: "First league goal of the season", run: "Scored in {n} league matches in a row" },
  it: { goal: "{n} gol in campionato in questa stagione", first: "Primo gol in campionato in questa stagione", run: "A segno in {n} partite di campionato di fila" },
  es: { goal: "{n} gol en Liga esta temporada", first: "Primer gol en Liga esta temporada", run: "Ha marcado en {n} partidos de liga seguidos" },
};

/** 10 as "10th", "10°" or "10.º". */
export function ordinal(n, lang) {
  if (lang === "it") return `${n}°`;
  if (lang === "es") return `${n}.º`;
  return `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

/** season.json, or null when the replay has none (an export from before the season, the demo fixture). */
export async function loadSeason(base) {
  try {
    const r = await fetch(`${base}/season.json`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** The kick-off card's payload: the two clubs' lines, the last meeting and each club's top scorer on the team sheet. */
export function seasonCard(season, match) {
  const pre = season.filter((f) => f.ts === 0), ids = [];
  const one = (kind, team, player) => {
    const f = pre.find((x) => x.kind === kind && (team === undefined || x.team_id === team) && (player === undefined || x.player_id === player));
    if (f) ids.push(f.fact_id);
    return f;
  };
  const week = one("season_matchweek");
  if (!week) return null;
  const side = (team) => (team === match.home.team_id ? "home" : "away");
  const rows = [match.home, match.away].map((tm) => ({
    side: tm.side, pos: one("season_position", tm.team_id)?.value, pts: one("season_points", tm.team_id)?.value,
    gd: one("season_goal_difference", tm.team_id)?.value, form: one("season_form", tm.team_id)?.detail?.results ?? [],
  }));
  const h = one("season_h2h", match.home.team_id), a = one("season_h2h", match.away.team_id), d = h?.detail;
  const h2h = d && a ? { matchweek: d.matchweek, home: side(d.home_team_id), away: side(d.away_team_id),
    home_goals: d.home_team_id === match.home.team_id ? h.value : a.value, away_goals: d.home_team_id === match.home.team_id ? a.value : h.value } : null;
  const scorers = [match.home, match.away].flatMap((tm) => {
    const best = pre.filter((f) => f.kind === "season_goals" && f.team_id === tm.team_id && f.value > 0)
      .sort((x, y) => y.value - x.value || x.player_id.localeCompare(y.player_id))[0];
    if (!best) return [];
    ids.push(best.fact_id);
    return [{ side: tm.side, name: match.players[best.player_id]?.name ?? "", goals: best.value }];
  });
  return { matchweek: week.value, rows, h2h, scorers, fact_ids: ids };
}

/** The goal card's season lines, in a language: the scorer's tally with this goal, and his scoring run. */
export function goalLines(season, eventId, lang) {
  const s = SEASON_STRINGS[lang] ?? SEASON_STRINGS.en;
  const at = (kind) => season.find((f) => f.kind === kind && f.ts > 0 && f.source_event_ids.at(-1) === eventId);
  const goal = at("season_goals"), run = at("season_scoring_run");
  return [
    goal && (goal.value === 1 ? s.first : s.goal.replace("{n}", ordinal(goal.value, lang))),
    run && s.run.replace("{n}", run.value),
  ].filter(Boolean);
}

/** The sheet with the season: the kick-off card first, and the first "why" card of each goal with its lines. */
export function withSeason(sheet, season, match, lang) {
  if (!season?.length) return sheet;
  const score = new Map(match.goals.map((f) => [f.fact_id, f.source_event_ids.at(-1)]));
  const done = new Set(), lined = new Map();
  for (const c of [...sheet].sort((x, y) => x.ts - y.ts)) {
    if (c.graphic !== "why_card" || c.payload?.kind !== "why") continue;
    const ev = (c.payload.fact_ids ?? []).map((id) => score.get(id)).find((e) => e !== undefined);
    if (ev === undefined || done.has(ev)) continue;
    done.add(ev);
    const lines = goalLines(season, ev, c.lang);
    if (lines.length) lined.set(c, { ...c, payload: { ...c.payload, season: lines } });
  }
  const card = seasonCard(season, match);
  return [
    ...(card ? [{ match_id: match.meta.match_id, cue_id: "SEASON-CARD", story_id: null, ts: 0, duration_s: SEASON_CARD_S,
      graphic: "season_card", audience: sheet[0]?.audience ?? null, lang, payload: card }] : []),
    ...sheet.map((c) => lined.get(c) ?? c),
  ];
}
