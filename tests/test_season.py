"""The season before the replays (docs/CONTRACT.md, Season additions): the schedule, the generator, the
season facts, get_season's clock and the export's season.json."""
import json
from collections import Counter

import numpy as np
import pytest

from studiodesk import db
from studiodesk import mcp_server as srv
from studiodesk.export import export
from studiodesk.facts import season as sf
from studiodesk.names import is_forbidden
from studiodesk.sim import load_calibration
from studiodesk.sim.season import REPLAY_MATCHWEEK, schedule, simulate_season, write_season
from studiodesk.sim.squads import make_league


def test_schedule_is_a_double_round_robin_around_the_replays():
    for seed in range(5):
        rows = schedule(np.random.default_rng(seed), 8)
        weeks = Counter(w for w, _, _ in rows)
        assert sorted(weeks) == list(range(1, REPLAY_MATCHWEEK)) and set(weeks.values()) == {4}
        for w in weeks:  # every club once a week
            clubs = [c for x, h, a in rows if x == w for c in (h, a)]
            assert sorted(clubs) == list(range(8))
        replays = [(2 * k, 2 * k + 1) for k in range(4)]
        fixtures = Counter((h, a) for _, h, a in rows) + Counter(replays)  # the replays' matchweek too
        assert set(fixtures.values()) == {1} and len(fixtures) == 4 * REPLAY_MATCHWEEK  # no fixture twice
        # the replays' pairings met once, in matchweek 3, the other way round; nothing else in the second leg repeats a week
        for h, a in replays:
            assert [(w, x, y) for w, x, y in rows if {x, y} == {h, a}] == [(REPLAY_MATCHWEEK - 7, a, h)]
        for w, h, a in rows:
            if w > 7:
                assert (w - 7, a, h) in rows
    assert schedule(np.random.default_rng(1), 8) == schedule(np.random.default_rng(1), 8)


@pytest.fixture(scope="module")
def season():
    cal = load_calibration()
    league = make_league(np.random.default_rng(7), cal)
    return league, simulate_season(league, cal, 7, 4, minutes=3.0)


def test_season_is_deterministic_and_consistent(season):
    league, s = season
    teams, players, _ = league
    again = simulate_season(league, load_calibration(), 7, 4, minutes=3.0)
    assert again == s
    assert len(s["matches"]) == 36 and len({m[0] for m in s["matches"]}) == 36
    team_of = {p["player_id"]: p["team_id"] for p in players}
    by_match = {m[0]: m for m in s["matches"]}
    for sid, week, home, away, hs, as_, _ in s["matches"]:
        assert 1 <= week < REPLAY_MATCHWEEK and home != away
        goals = [g for g in s["goals"] if g[0] == sid]
        assert [g[1] for g in goals] == list(range(1, len(goals) + 1))
        assert sum(g[3] == home for g in goals) == hs and sum(g[3] == away for g in goals) == as_
    for sid, _, minute, team, player, own in s["goals"]:
        assert 1 <= minute <= 100 and team in by_match[sid][2:4]
        assert own or team_of[player] == team
    assert not any(is_forbidden(t["name"]) for t in teams)
    assert simulate_season(league, load_calibration(), 7, 3) is None  # three replays are not a whole matchweek


def test_the_season_has_its_own_random_stream(season):
    league, _ = season
    from studiodesk.sim.build import simulate
    cal = load_calibration()
    a = simulate(0, 7, league, cal, False, 1.0)
    simulate_season(league, cal, 7, 4, minutes=1.0)
    assert simulate(0, 7, league, cal, False, 1.0)["events"] == a["events"]


# a hand-made season around the fixture match (T01 at home to T02): three earlier matchweeks
GAMES = [("SM-001", 1, "T01", "T02", 2, 1, 1), ("SM-002", 2, "T02", "T01", 0, 1, 2), ("SM-003", 3, "T02", "T01", 1, 3, 3)]
GOALS = [("SM-001", 1, 10, "T01", "T01-9", 0), ("SM-001", 2, 50, "T01", "T01-9", 0), ("SM-001", 3, 70, "T02", "T02-9", 0),
         ("SM-002", 1, 33, "T01", "T01-11", 0),
         ("SM-003", 1, 5, "T01", "T01-11", 0), ("SM-003", 2, 20, "T01", "T01-9", 0), ("SM-003", 3, 40, "T02", "T02-10", 0),
         ("SM-003", 4, 88, "T01", "T02-4", 1)]


@pytest.fixture
def season_db(match_db):
    info, conn = match_db
    write_season(conn, dict(matches=GAMES, goals=GOALS), [info["match_id"]])
    conn.execute("UPDATE season_fixtures SET matchweek = 4")
    conn.commit()
    assert sf.build(conn, "M001") == len(sf.compute(conn, "M001"))
    return info, conn


def _facts(conn):
    rows = [dict(r) for r in conn.execute("SELECT * FROM season_facts WHERE match_id = 'M001' ORDER BY ts, fact_id")]
    for r in rows:
        r["source_season"], r["source_event_ids"] = json.loads(r["source_season"]), json.loads(r["source_event_ids"])
        r["detail"] = json.loads(r["detail"]) if r["detail"] else None
    return rows


def test_season_facts_before_kick_off(season_db):
    _, conn = season_db
    facts = _facts(conn)
    one = lambda kind, team=None, player=None: [f for f in facts if f["kind"] == kind and f["ts"] == 0  # noqa: E731
                                               and (team is None or f["team_id"] == team) and (player is None or f["player_id"] == player)]
    assert one("season_matchweek")[0]["label_en"] == "Matchweek 4"
    assert [f["value"] for f in one("season_position", "T01") + one("season_position", "T02")] == [1, 2]
    assert one("season_points", "T01")[0]["label_en"] == "9 points from 3 matches"
    assert one("season_goal_difference", "T01")[0]["value"] == 4 and one("season_goal_difference", "T02")[0]["label_en"] == "Goal difference -4"
    form = one("season_form", "T01")[0]
    assert form["detail"]["results"] == ["W", "W", "W"] and form["label_en"] == "Last 3: W W W, 9 points"
    h2h = one("season_h2h", "T01")[0]
    assert h2h["value"] == 3 and h2h["label_en"] == "Matchweek 3: MIL 1-3 HAR" and h2h["detail"]["meetings"] == 3
    assert h2h["source_season"] == ["season_matches:SM-003"]
    # own goals count for the club, never for the player
    assert one("season_goals", player="T01-9")[0]["value"] == 3 and one("season_goals", player="T02-4")[0]["value"] == 0
    assert all(f["period"] == 1 for f in facts if f["ts"] == 0)
    ids = [f["fact_id"] for f in facts]
    assert len(set(ids)) == len(ids) and all(i.startswith("F-SEASON_") for i in ids)


def test_season_facts_at_a_goal_cite_their_rows_and_the_goal(season_db):
    info, conn = season_db
    facts = _facts(conn)
    goal = conn.execute("SELECT * FROM facts WHERE match_id = 'M001' AND kind = 'player_goals' AND value > 0").fetchone()
    assert goal["player_id"] == "T01-11"
    tally = [f for f in facts if f["ts"] > 0 and f["kind"] == "season_goals"]
    assert [(f["value"], f["label_en"], f["ts"]) for f in tally] == [(3, "3rd league goal of the season", goal["ts"])]
    assert tally[0]["source_season"] == ["season_goals:SM-002/1", "season_goals:SM-003/1"]
    assert tally[0]["source_event_ids"][-1] == info["goal_event_id"]
    run = [f for f in facts if f["kind"] == "season_scoring_run"]
    assert [(f["value"], f["label_en"]) for f in run] == [(3, "Scored in 3 league matches in a row")]
    # every cited row is there
    for f in facts:
        for ref in f["source_season"]:
            table, key = ref.split(":")
            if table == "season_goals":
                sid, n = key.split("/")
                assert conn.execute("SELECT 1 FROM season_goals WHERE season_match_id=? AND goal_no=?", (sid, int(n))).fetchone()
            else:
                col = {"season_matches": "season_match_id", "season_fixtures": "match_id"}[table]
                assert conn.execute(f"SELECT 1 FROM {table} WHERE {col}=?", (key,)).fetchone()


def test_ordinal():
    assert [sf.ordinal(n) for n in (1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111)] == \
        ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"]


def test_get_season_sees_up_to_the_clock(season_db, monkeypatch):
    info, _ = season_db
    monkeypatch.setattr(srv, "DB_PATH", info["path"])
    assert srv.get_season in srv.TOOLS
    try:
        goal_ts = srv.get_facts("M001", kind="score")[0]["ts"]
        srv.set_clock(goal_ts - 1)
        before = srv.get_season("M001")
        assert before and all(f["ts"] == 0 for f in before)
        assert srv.get_season("M001", kind="season_scoring_run") == []
        assert srv.get_season("M001", player_id="T01-11", kind="season_goals")[0]["value"] == 2
        srv.set_clock(goal_ts)
        now = srv.get_season("M001", player_id="T01-11", kind="season_goals")
        assert [f["value"] for f in now] == [2, 3] and now[1]["source_season"][0] == "season_goals:SM-002/1"
        with srv.clock_at(0):
            assert len(srv.get_season("M001", team_id="T01", kind="season_position")) == 1
    finally:
        srv.set_clock(None)
    assert srv.get_season("M002") == []


def test_export_adds_season_json_only(season_db, match_db, tmp_path):
    info, conn = season_db
    out = export("M001", conn, tmp_path / "with")
    data = json.loads((out / "season.json").read_text())
    assert [f["fact_id"] for f in data] == [f["fact_id"] for f in _facts(conn)]
    assert isinstance(data[0]["source_season"], list) and data[0]["source_frames"] is None
    # without the season the same files, byte for byte
    conn.execute("DELETE FROM season_facts")
    conn.commit()
    bare = export("M001", conn, tmp_path / "without")
    assert not (bare / "season.json").exists()
    assert sorted(p.name for p in out.iterdir()) == sorted([p.name for p in bare.iterdir()] + ["season.json"])
    for p in bare.iterdir():
        if p.is_file():
            assert p.read_bytes() == (out / p.name).read_bytes(), p.name


def test_export_without_season_tables(match_db, tmp_path):
    info, conn = match_db
    conn.execute("DROP TABLE season_facts")
    out = export("M001", conn, tmp_path / "web")
    assert not (out / "season.json").exists()
