import json
import math
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

from fixture_match import FPS, HOME, PASS_MS, write_fixture
from studiodesk import db
from studiodesk.facts import Match, build
from studiodesk.facts.engine import formation_name, shot_detail

KINDS = {"pass_distance", "pass_difficulty", "pass_accuracy", "ball_speed", "shot_speed", "sprint_speed",
         "sprint_count", "distance_covered", "momentum", "press_intensity", "line_height", "score",
         "shot_distance", "team_width", "team_length", "formation", "start_formation"}


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


def test_shot_distance_and_team_shape(match_db):
    info, conn = match_db
    (shot,) = facts(conn, "shot_distance")
    (eid, x, y), = conn.execute("SELECT event_id, start_x, start_y FROM events WHERE type_name = 'shot'")
    assert json.loads(shot["source_event_ids"]) == [eid] and shot["unit"] == "m"
    assert abs(shot["value"] - math.hypot(x - 0.0, y - 34.0)) < 0.06  # home attack x = 0 in period 2
    assert re.fullmatch(r"Shot from \d+ m, (inside|outside) the box(, [a-z ]+)?, (goal|saved|wide|over|blocked)",
                        shot["label_en"]), shot["label_en"]
    header = {"start_x": 95.0, "start_y": 34.0, "end_x": 105.0, "end_y": 30.0, "bodypart_name": "head",
              "type_name": "shot", "result_name": "fail", "player_id": "P", "ts": 10.0}
    assert shot_detail(header, 1) == "inside the box, header, wide"
    assert shot_detail({**header, "start_x": 80.0, "bodypart_name": "foot_left"}, 1,
                       [{"related_player_id": "P", "ts": 11.0}]) == "outside the box, left foot, saved"
    # the fixture's 4-4-2: clear lines whenever nobody leaves them (the sprinter breaks T01's in period 1)
    forms = {(r["team_id"], r["period"]): (r["value"], r["unit"], r["label_en"]) for r in facts(conn, "formation")}
    assert set(forms) == {("T02", 1), ("T01", 2), ("T02", 2)}
    assert all(v == 442.0 and u == "formation" and "4-4-2" in lab for v, u, lab in forms.values())
    assert formation_name(442.0) == "4-4-2" and formation_name(4231.0) == "4-2-3-1"
    assert {r["value"] for r in facts(conn, "team_width")} == {48.0}  # y from 10 to 58
    assert {(r["team_id"], r["period"]): r["value"] for r in facts(conn, "team_length")}[("T02", 1)] == 35.0


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


def test_window_labels_never_overlap_and_name_stoppage_time():
    from studiodesk.facts.engine import window_label
    p1 = 2763.4
    # windows() adds 300.0 s steps: the sixth second-half window starts 1499.9999999999995 s into the half
    a = p1
    for _ in range(5):
        a += 300.0
    assert a - p1 < 1500.0
    assert window_label(a, a + 300.0, 2, p1) == "min 71-75"
    assert window_label(p1 + 1200.0, p1 + 1500.0, 2, p1) == "min 66-70"
    assert window_label(2400.0, 2700.0, 1, p1) == "min 41-45"
    assert window_label(2700.0, p1, 1, p1) == "first-half stoppage time"
    assert window_label(2580.0, 2760.0, 1, p1) == "min 44-45+1"
    assert window_label(p1 + 2700.0, p1 + 2880.0, 2, p1) == "second-half stoppage time"


def test_player_checkins_count_from_kick_off(tmp_path, monkeypatch):
    """Check-ins every CHECKIN_S of a period (900 s in a match; 60 s on the 3-minute fixture): touches,
    passes completed, km, sprints and top speed so far, for each player on the pitch; other kinds unchanged."""
    from studiodesk.facts import engine
    info = write_fixture(tmp_path / "matches.sqlite")
    conn = db.connect(info["path"])
    build(conn, info["match_id"], xt_grid=None)
    before = facts(conn)
    monkeypatch.setattr(engine, "CHECKIN_S", 60.0)
    build(conn, info["match_id"], xt_grid=None)
    rows = facts(conn)
    assert [r for r in rows if not r["kind"].startswith("checkin_")] == before  # new kinds only: ids unchanged
    got = {(r["kind"], r["player_id"], r["ts"]): r for r in rows if r["kind"].startswith("checkin_")}
    assert {ts for _, _, ts in got} == {60.0, 120.0, 240.0, 300.0}  # 180 and 360 are period ends
    events = [dict(r) for r in conn.execute("SELECT * FROM events")]
    for pid in (info["sprinter"], "T02-7"):
        for cp in (60.0, 120.0, 240.0, 300.0):
            mine = [e for e in events if e["player_id"] == pid and e["ts"] <= cp and e["type_name"] != "foul"]
            ok = [e for e in mine if e["type_name"] in engine.PASS_TYPES and e["result_name"] == "success"]
            assert got[("checkin_touches", pid, cp)]["value"] == len(mine)
            assert got[("checkin_passes", pid, cp)]["value"] == len(ok)
            assert sorted(json.loads(got[("checkin_passes", pid, cp)]["source_event_ids"])) == sorted(e["event_id"] for e in ok)
    s = info["sprinter"]
    assert got[("checkin_sprints", s, 60.0)]["value"] == 0 and ("checkin_top_speed", s, 60.0) not in got
    assert got[("checkin_sprints", s, 120.0)]["value"] == 1
    assert abs(got[("checkin_top_speed", s, 120.0)]["value"] - info["sprint_kmh"]) < 1.0
    assert got[("checkin_top_speed", s, 120.0)]["label_en"].startswith("Top speed ")
    # a jogger covers 1.5 m/s: 0.18 km by 2 minutes, a bit under 0.45 km by 5 (the half-time switch is not measured)
    assert got[("checkin_distance", "T02-7", 120.0)]["value"] == 0.2
    assert got[("checkin_distance", "T02-7", 300.0)]["value"] == 0.4
    assert got[("checkin_distance", "T02-7", 120.0)]["unit"] == "km"
    conn.close()
