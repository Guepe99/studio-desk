"""Season facts of a replayed match (docs/CONTRACT.md, Season additions), from the season tables.

Before kick-off (ts 0, period 1):
- season_matchweek: the matchweek the match sits in.
- season_position, season_points, season_goal_difference: every club's line of the table after the matchweeks
  before this one. Order: points, goal difference, goals scored, then the short name.
- season_form (the two clubs): points from their last five league matches; detail.results the letters W, D, L,
  oldest first.
- season_h2h (the two clubs): goals each scored in the latest meeting this season; detail its matchweek and sides.
- season_goals (every player on the team sheet): league goals this season before kick-off, own goals not counted.
During the match, at each goal, when the ball crosses the line (the player_goals fact's ts):
- season_goals again, the tally with this goal ("10th league goal of the season").
- season_scoring_run, at the player's first goal of the match, when he also scored in the club's previous
  league match: the matches in a row he has scored in, this one included.
`source_season` names the season rows behind each number; in-match facts also cite the goals' event ids.
"""
import json

COLUMNS = ("match_id", "fact_id", "kind", "ts", "period", "team_id", "player_id", "value", "unit", "label_en",
           "source_event_ids", "source_frames", "source_season", "detail")


def ordinal(n):
    n = int(n)
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def _rows(conn, sql, args=()):
    return [dict(r) for r in conn.execute(sql, args)]


def compute(conn, match_id):
    fx = conn.execute("SELECT matchweek FROM season_fixtures WHERE match_id = ?", (match_id,)).fetchone()
    if fx is None:
        return []
    week = fx[0]
    home, away = conn.execute("SELECT home_team_id, away_team_id FROM matches WHERE match_id = ?", (match_id,)).fetchone()
    games = _rows(conn, "SELECT * FROM season_matches WHERE matchweek < ? ORDER BY matchweek, season_match_id", (week,))
    goals = _rows(conn, "SELECT g.* FROM season_goals g JOIN season_matches s USING (season_match_id) "
                        "WHERE s.matchweek < ? ORDER BY s.matchweek, g.season_match_id, g.goal_no", (week,))
    short = {r["team_id"]: r["short_name"] for r in _rows(conn, "SELECT team_id, short_name FROM teams")}
    facts = []

    def add(kind, value, unit, label, team=None, player=None, season=(), detail=None, ts=0.0, period=1, events=()):
        facts.append(dict(kind=kind, ts=float(ts), period=period, team_id=team, player_id=player, value=float(value),
                          unit=unit, label_en=label, source_event_ids=[int(e) for e in events], source_frames=None,
                          source_season=list(season), detail=detail))

    mref = lambda g: f"season_matches:{g['season_match_id']}"  # noqa: E731
    gref = lambda g: f"season_goals:{g['season_match_id']}/{g['goal_no']}"  # noqa: E731
    add("season_matchweek", week, "matchweek", f"Matchweek {week}", season=[f"season_fixtures:{match_id}"])

    # the table: each club's games with (goals for, goals against)
    played = {}
    for g in games:
        played.setdefault(g["home_team_id"], []).append((g, g["home_score"], g["away_score"]))
        played.setdefault(g["away_team_id"], []).append((g, g["away_score"], g["home_score"]))
    pts = lambda f, a: 3 if f > a else int(f == a)  # noqa: E731
    line = {t: (sum(pts(f, a) for _, f, a in ps), sum(f - a for _, f, a in ps), sum(f for _, f, a in ps))
            for t, ps in played.items()}
    order = sorted(line, key=lambda t: (-line[t][0], -line[t][1], -line[t][2], short[t]))
    for pos, t in enumerate(order, 1):
        p, gd, _ = line[t]
        n = len(played[t])
        add("season_position", pos, "position", f"{ordinal(pos)} in the table before kick-off", t,
            season=[mref(g) for g in games])
        add("season_points", p, "points", f"{p} point{'s' * (p != 1)} from {n} match{'es' * (n != 1)}", t,
            season=[mref(g) for g, _, _ in played[t]])
        add("season_goal_difference", gd, "goals", f"Goal difference {gd:+d}" if gd else "Goal difference 0", t,
            season=[mref(g) for g, _, _ in played[t]])

    for t in (home, away):
        last = played.get(t, [])[-5:]
        if last:
            letters = ["W" if f > a else "D" if f == a else "L" for _, f, a in last]
            p = sum(pts(f, a) for _, f, a in last)
            add("season_form", p, "points", f"Last {len(last)}: {' '.join(letters)}, {p} point{'s' * (p != 1)}", t,
                season=[mref(g) for g, _, _ in last], detail={"results": letters})
    met = [g for g in games if {g["home_team_id"], g["away_team_id"]} == {home, away}]
    if met:
        g = met[-1]
        score = f"{short[g['home_team_id']]} {g['home_score']}-{g['away_score']} {short[g['away_team_id']]}"
        for t in (home, away):
            add("season_h2h", g["home_score"] if t == g["home_team_id"] else g["away_score"], "goals",
                f"Matchweek {g['matchweek']}: {score}", t, season=[mref(g)],
                detail={"matchweek": g["matchweek"], "home_team_id": g["home_team_id"], "away_team_id": g["away_team_id"],
                        "meetings": len(met)})

    # scorers: the tally before kick-off for everyone on the team sheet, then one at each goal
    sheet = _rows(conn, "SELECT l.player_id, p.team_id FROM lineups l JOIN players p USING (player_id) "
                        "WHERE l.match_id = ? ORDER BY l.player_id", (match_id,))
    prior = {s["player_id"]: [g for g in goals if g["player_id"] == s["player_id"] and not g["own_goal"]] for s in sheet}
    for s in sheet:
        n = len(prior[s["player_id"]])
        add("season_goals", n, "goals", f"{n} league goal{'s' * (n != 1)} this season before kick-off", s["team_id"],
            s["player_id"], season=[gref(g) for g in prior[s["player_id"]]])
    for f in _rows(conn, "SELECT * FROM facts WHERE match_id = ? AND kind = 'player_goals' AND value > 0 "
                         "ORDER BY ts, fact_id", (match_id,)):
        pid, team, events = f["player_id"], f["team_id"], json.loads(f["source_event_ids"])
        before = prior.get(pid, [])
        total = len(before) + int(f["value"])
        add("season_goals", total, "goals", f"{ordinal(total)} league goal of the season", team, pid,
            season=[gref(g) for g in before], ts=f["ts"], period=f["period"], events=events)
        if f["value"] == 1:  # the run counts matches, so only the first goal of this one extends it
            run = []
            for g, _, _ in reversed(played.get(team, [])):
                mine = [x for x in before if x["season_match_id"] == g["season_match_id"]]
                if not mine:
                    break
                run.append(mine)
            if run:
                add("season_scoring_run", len(run) + 1, "matches", f"Scored in {len(run) + 1} league matches in a row",
                    team, pid, season=[gref(x) for m in reversed(run) for x in m], ts=f["ts"], period=f["period"],
                    events=events[-1:])

    facts.sort(key=lambda f: (f["ts"], f["kind"], f["team_id"] or "", f["player_id"] or ""))
    counters = {}
    for f in facts:
        counters[f["kind"]] = counters.get(f["kind"], 0) + 1
        f["fact_id"] = f"F-{f['kind'].upper()}-{counters[f['kind']]:06d}"
    return facts


def build(conn, match_id):
    """Delete and rewrite the season facts of `match_id` (run after the match's facts); returns how many."""
    facts = compute(conn, match_id)
    rows = [(match_id, f["fact_id"], f["kind"], f["ts"], f["period"], f["team_id"], f["player_id"], f["value"], f["unit"],
             f["label_en"], json.dumps(f["source_event_ids"]), None, json.dumps(f["source_season"]),
             None if f["detail"] is None else json.dumps(f["detail"])) for f in facts]
    with conn:
        conn.execute("DELETE FROM season_facts WHERE match_id = ?", (match_id,))
        conn.executemany(f"INSERT INTO season_facts ({', '.join(COLUMNS)}) VALUES ({', '.join('?' * len(COLUMNS))})", rows)
    return len(rows)
