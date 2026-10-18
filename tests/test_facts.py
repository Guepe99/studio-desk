import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

from fixture_match import FPS, HOME, PASS_MS, write_fixture
from studiodesk import db
from studiodesk.facts import Match, build

KINDS = {"pass_distance", "pass_difficulty", "pass_accuracy", "ball_speed", "shot_speed", "sprint_speed",
         "sprint_count", "distance_covered", "momentum", "press_intensity", "line_height", "score"}


def facts(conn, kind=None):
    sql, args = "SELECT * FROM facts", ()
    if kind:
        sql, args = sql + " WHERE kind = ?", (kind,)
    return [dict(r) for r in conn.execute(sql + " ORDER BY ts", args)]


def test_all_kinds_ids_and_sources(match_db):
    info, conn = match_db
    rows = facts(conn)
    assert {r["kind"] for r in rows} == KINDS  # no xt_added without a grid
    assert len({r["fact_id"] for r in rows}) == len(rows)
    events = {r[0] for r in conn.execute("SELECT event_id FROM events")}
    for r in rows:
        assert re.fullmatch(r"F-[A-Z_]+-\d{6}", r["fact_id"]) and r["fact_id"][2:-7] == r["kind"].upper()
        assert set(json.loads(r["source_event_ids"])) <= events
        assert r["label_en"]
        if r["source_frames"]:
            a, b = json.loads(r["source_frames"])
            assert 0 <= a <= b < info["frames"]
            assert b / FPS <= r["ts"] + 1e-9, r  # never released before the frames it was measured on
    passes = facts(conn, "ball_speed")
    assert passes and all(abs(r["value"] - PASS_MS * 3.6) < 2 for r in passes)


def test_goal_shot_and_sprint(match_db):
    info, conn = match_db
    (score,) = facts(conn, "score")
    assert score["value"] == 1 and score["team_id"] == HOME and score["label_en"] == "Goal 1-0"
    assert json.loads(score["source_event_ids"]) == [info["goal_event_id"]]
    # known when the ball is over the line, not at the kick
    (kick_ts,) = conn.execute("SELECT ts FROM events WHERE event_id = ?", (info["goal_event_id"],)).fetchone()
    f = json.loads(score["source_frames"])[1]
    ball_x = conn.execute("SELECT pos FROM tracking_frames WHERE frame = ?", (f,)).fetchone()[0]
    assert score["ts"] == f / FPS > kick_ts + 0.1 and np.frombuffer(ball_x, "<f4")[0] <= 0.5
    (shot,) = facts(conn, "shot_speed")
    assert abs(shot["value"] - info["shot_kmh"]) < 1.5 and shot["source_frames"]
    (sprint,) = facts(conn, "sprint_speed")
    assert sprint["player_id"] == info["sprinter"] and abs(sprint["value"] - info["sprint_kmh"]) < 1.0
    counts = {(r["player_id"], r["period"]): r["value"] for r in facts(conn, "sprint_count")}
    assert counts[(info["sprinter"], 2)] == 1 and sum(counts.values()) == 2  # same sprint at HT and FT
    dist = {(r["player_id"], r["period"]): r["value"] for r in facts(conn, "distance_covered")}
    assert abs(dist[(info["sprinter"], 1)] - 26.7) < 1.5  # only the 3 s sprint, standing otherwise


def test_direction_flips_in_period_2(match_db):
    info, conn = match_db
    m = Match(conn, info["match_id"], None)
    for eid, period in ((info["forward_p1"], 1), (info["forward_p2"], 2)):
        e = next(e for e in m.events if e["event_id"] == eid)
        assert e["period"] == period and e["team_id"] == HOME
        assert (e["end_x"] - e["start_x"]) * m.sign(HOME, period) > 10
    # same layout rotated at half-time: the line is measured from each team's own goal
    lines = {(r["team_id"], r["period"]): r["value"] for r in facts(conn, "line_height")}
    assert lines == {("T01", 1): info["home_line"], ("T01", 2): info["home_line"],
                     ("T02", 1): info["away_line"], ("T02", 2): info["away_line"]}


def test_windows_for_both_teams(match_db):
    _, conn = match_db
    for kind in ("momentum", "press_intensity"):
        rows = facts(conn, kind)
        assert {(r["team_id"], r["period"]) for r in rows} == {(t, p) for t in ("T01", "T02") for p in (1, 2)}
        assert all(0 <= r["value"] <= 10 and json.loads(r["source_event_ids"]) for r in rows)
    mom = facts(conn, "momentum")
    for ts in {r["ts"] for r in mom}:
        assert abs(sum(r["value"] for r in mom if r["ts"] == ts) - 10) < 0.11
    acc = {(r["team_id"], r["player_id"], r["period"]): r["value"] for r in facts(conn, "pass_accuracy")}
    assert acc[("T01", None, 1)] == 80.0


def test_xt_only_with_a_grid(tmp_path):
    info = write_fixture(tmp_path / "m.sqlite")
    grid = tmp_path / "xt.json"
    grid.write_text(json.dumps({"cols": 16, "rows": 12, "source": "test",
                                "grid": [[c / 50 for c in range(16)] for _ in range(12)]}))
    conn = db.connect(info["path"])
    build(conn, info["match_id"], xt_grid=grid)
    xt = {json.loads(r["source_event_ids"])[0]: r["value"] for r in facts(conn, "xt_added")}
    assert xt[info["forward_p1"]] > 0 and xt[info["forward_p2"]] > 0
    build(conn, info["match_id"], xt_grid=tmp_path / "missing.json")  # the rewrite drops them
    assert not facts(conn, "xt_added")


def test_cli_build(tmp_path):
    info = write_fixture(tmp_path / "m.sqlite")
    root = Path(__file__).resolve().parent.parent
    out = subprocess.run([sys.executable, "-m", "studiodesk.facts", "build", "--all", "--db", str(info["path"])],
                         cwd=root, capture_output=True, text=True, check=True)
    assert out.stdout.startswith("M001: ")
