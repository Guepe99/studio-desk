"""Read-only MCP server over matches.sqlite (docs/CONTRACT.md, MCP server).

Run: `python -m studiodesk.mcp_server` (stdio transport).

Clock: when a clock value is set, every tool only returns rows with `ts <= clock`, and match
info hides what has not happened yet (final score, later substitutions). In-process, call
`set_clock(ts)` after each event a `MatchClock` releases (`set_clock(None)` stops filtering);
a separate server process reads its starting value from the env var `STUDIODESK_CLOCK`. Code that
calls the tool functions directly for one request (Ask the studio) uses `clock_at(ts)` instead: it
holds for the current task or thread only and wins over the shared clock.
The database is `DB_PATH` (env `STUDIODESK_MATCHES_DB`, default `data/matches.sqlite`), always
opened read-only.

The tool functions are plain functions: agents and tests can call them directly.
"""
import json
import math
import os
from contextlib import closing, contextmanager
from contextvars import ContextVar
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from . import config, db

DB_PATH = Path(os.environ.get("STUDIODESK_MATCHES_DB", config.MATCHES_DB))
# shortcut: one clock per process, so one live run per process; give each run its own clock when the
# tappa 3 agents run two matches in the same process.
_clock = float(os.environ["STUDIODESK_CLOCK"]) if os.environ.get("STUDIODESK_CLOCK") else None
_local_clock = ContextVar("studiodesk_clock", default=None)  # per request: concurrent visitors at different times


def set_clock(ts):
    global _clock
    _clock = None if ts is None else float(ts)


@contextmanager
def clock_at(ts):
    """Every tool called inside this block, in this task or thread, sees the match up to ts only."""
    token = _local_clock.set(float(ts))
    try:
        yield
    finally:
        _local_clock.reset(token)


def _clock_now():
    local = _local_clock.get()
    return _clock if local is None else local


def _now():
    return math.inf if _clock_now() is None else _clock_now()


def _rows(sql, args=()):
    with closing(db.connect(DB_PATH, readonly=True)) as conn:
        return [dict(r) for r in conn.execute(sql, args)]


def _fact(row):
    row["source_event_ids"] = json.loads(row["source_event_ids"])
    row["source_frames"] = json.loads(row["source_frames"]) if row["source_frames"] else None
    return row


def _hide_future(lineup):
    if lineup["off_ts"] is not None and lineup["off_ts"] > _now():
        lineup["off_ts"] = None
    return lineup


def get_match_info(match_id: str) -> dict:
    """Match, teams with side, score so far and the players on the team sheet so far."""
    m = _rows("SELECT match_id, home_team_id, away_team_id, venue_name, period1_s, period2_s, fps "
              "FROM matches WHERE match_id = ?", (match_id,))
    if not m:
        return {"error": f"unknown match {match_id}"}
    m = m[0]
    sides = {m["home_team_id"]: "home", m["away_team_id"]: "away"}
    teams = _rows("SELECT team_id, name, short_name, color_primary, color_secondary FROM teams "
                  "WHERE team_id IN (?, ?)", (m["home_team_id"], m["away_team_id"]))
    score = {"home": 0, "away": 0}
    # from the score facts (team = the side the goal counts for), stamped when the ball crosses the line
    for g in _rows("SELECT team_id FROM facts WHERE match_id = ? AND kind = 'score' AND ts <= ?", (match_id, _now())):
        score[sides[g["team_id"]]] += 1
    players = _rows("SELECT l.player_id, p.team_id, p.name, p.shirt, p.position, l.starter, l.on_ts, l.off_ts "
                    "FROM lineups l JOIN players p USING (player_id) WHERE l.match_id = ? AND l.on_ts <= ? "
                    "ORDER BY p.team_id, p.shirt", (match_id, _now()))
    # period lengths include stoppage time: unknown until the period is over
    p1, end = m["period1_s"], m["period1_s"] + m["period2_s"]
    m["period1_s"] = p1 if p1 <= _now() else None
    m["period2_s"] = m["period2_s"] if end <= _now() else None
    return {**m, "clock": _clock_now(), "score": score,
            "teams": [{**t, "side": sides[t["team_id"]]} for t in teams],
            "players": [_hide_future(p) for p in players]}


def get_events(match_id: str, from_ts: float, to_ts: float, type_name: str | None = None) -> list[dict]:
    """Events with from_ts <= ts <= to_ts, optionally of one SPADL type."""
    sql = "SELECT * FROM events WHERE match_id = ? AND ts >= ? AND ts <= ? AND ts <= ?"
    args = [match_id, from_ts, to_ts, _now()]
    if type_name:
        sql, args = sql + " AND type_name = ?", args + [type_name]
    return _rows(sql + " ORDER BY ts, event_id", args)


def get_facts(match_id: str, kind: str | None = None, player_id: str | None = None,
              team_id: str | None = None, from_ts: float | None = None,
              to_ts: float | None = None, top: int | None = None) -> list[dict]:
    """Facts from the ledger, filtered by any of kind, player, team and time range; with top, only the top
    facts by value, highest first (the fastest sprints, the hardest shots).
    kind is one of: score (a goal: player_id the scorer, label "Goal 2-1" home side first), shot_speed,
    shot_distance, sprint_speed, sprint_count, distance_covered, ball_speed, pass_distance, pass_difficulty,
    pass_accuracy, xt_added, momentum, press_intensity, formation, start_formation (the team sheet's, at
    kick-off), line_height, team_length, team_width, and a player's totals since the period's kick-off every 15 minutes: checkin_touches, checkin_passes,
    checkin_distance (km), checkin_sprints, checkin_top_speed; a team's totals since kick-off: team_shots,
    team_shots_on_target, team_corners, team_possession, team_pass_accuracy (get_team_totals gives the latest of
    each); player_goals, a player's goals since kick-off (get_scorers gives the latest per scorer)."""
    sql, args = "SELECT * FROM facts WHERE match_id = ? AND ts <= ?", [match_id, _now()]
    for col, op, val in (("kind", "=", kind), ("player_id", "=", player_id), ("team_id", "=", team_id),
                         ("ts", ">=", from_ts), ("ts", "<=", to_ts)):
        if val is not None:
            sql, args = sql + f" AND {col} {op} ?", args + [val]
    if top:
        return [_fact(r) for r in _rows(sql + " ORDER BY value DESC, ts, fact_id LIMIT ?", args + [max(1, int(top))])]
    return [_fact(r) for r in _rows(sql + " ORDER BY ts, fact_id", args)]


def get_fact(match_id: str, fact_id: str) -> dict:
    """One fact by id."""
    rows = _rows("SELECT * FROM facts WHERE match_id = ? AND fact_id = ? AND ts <= ?", (match_id, fact_id, _now()))
    return _fact(rows[0]) if rows else {"error": f"no fact {fact_id} in {match_id}"}


def get_player(match_id: str, player_id: str) -> dict:
    """A player, their team and their place on the team sheet of this match."""
    rows = _rows("SELECT p.player_id, p.team_id, t.short_name AS team_short, p.name, p.shirt, p.position "
                 "FROM players p JOIN teams t USING (team_id) WHERE p.player_id = ?", (player_id,))
    if not rows:
        return {"error": f"unknown player {player_id}"}
    lineup = _rows("SELECT starter, on_ts, off_ts FROM lineups WHERE match_id = ? AND player_id = ? AND on_ts <= ?",
                   (match_id, player_id, _now()))
    return {**rows[0], "lineup": _hide_future(lineup[0]) if lineup else None}


def get_momentum(match_id: str, team_id: str | None = None) -> list[dict]:
    """Momentum facts (0..10 per team per 5-minute window, ts = end of the window)."""
    return get_facts(match_id, kind="momentum", team_id=team_id)


TEAM_TOTALS = ("team_shots", "team_shots_on_target", "team_corners", "team_possession", "team_pass_accuracy")


def _latest(match_id, kinds, key):
    """The latest fact up to the clock of each of `kinds` per `key` (team_id or player_id)."""
    latest = {}
    for r in _rows(f"SELECT * FROM facts WHERE match_id = ? AND ts <= ? AND kind IN ({', '.join('?' * len(kinds))}) "
                   "ORDER BY ts, fact_id", (match_id, _now(), *kinds)):
        latest[(r["kind"], r[key])] = r  # in ts order: the last one is the latest
    return [_fact(latest[k]) for k in sorted(latest)]


def get_team_totals(match_id: str) -> list[dict]:
    """Each team's totals since kick-off, counted by code: shots, shots on target, corners, possession (the
    share of the ball) and pass accuracy (passes completed of those tried, in the label), the last two at the
    latest 5-minute window end. The latest fact of each kind per team."""
    return _latest(match_id, TEAM_TOTALS, "team_id")


def get_scorers(match_id: str, player_id: str | None = None) -> list[dict]:
    """Goals per player since kick-off, counted by code (own goals not counted): the latest player_goals fact of
    each player who has scored, or with player_id that player's, 0 goals included."""
    latest = _latest(match_id, ("player_goals",), "player_id")
    return [f for f in latest if f["player_id"] == player_id] if player_id else [f for f in latest if f["value"] > 0]


TOOLS = (get_match_info, get_events, get_facts, get_fact, get_player, get_momentum, get_team_totals, get_scorers)
server = FastMCP("studiodesk")
for _fn in TOOLS:
    server.add_tool(_fn, annotations=ToolAnnotations(readOnlyHint=True))

if __name__ == "__main__":
    server.run()
