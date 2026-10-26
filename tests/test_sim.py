"""Simulator: determinism, geometry, physics caps, scores, names, planted storylines (short matches)."""
import numpy as np
import pytest

from studiodesk import db
from studiodesk.names import is_forbidden
from studiodesk.sim import load_calibration
from studiodesk.sim.build import build, simulate
from studiodesk.sim.report import frames, kinematics, report
from studiodesk.sim.squads import make_league

MINUTES = 8.0  # per period: short enough for CI, long enough for every planted storyline


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    path = tmp_path_factory.mktemp("sim") / "m.sqlite"
    build(4, 7, path, MINUTES)
    conn = db.connect(path, readonly=True)
    yield path, conn
    conn.close()


def test_same_seed_same_events_and_frames():
    cal = load_calibration()
    runs = [simulate(0, 11, make_league(np.random.default_rng(3), cal), cal, True, 2.0) for _ in range(2)]
    assert runs[0]["events"] == runs[1]["events"]
    assert np.array_equal(runs[0]["pos"], runs[1]["pos"], equal_nan=True)
    assert runs[0]["storylines"] == runs[1]["storylines"]


def test_no_ball_into_the_goal_without_a_goal(built):
    _, conn = built
    rows = conn.execute("SELECT end_x, end_y FROM events WHERE type_name NOT LIKE 'shot%' AND result_name != 'owngoal' "
                        "AND (end_x <= 0 OR end_x >= 105)").fetchall()
    assert rows and not [r for r in rows if abs(r[1] - 34) < 3.66 + 0.11]


def test_coordinates_inside_the_pitch(built):
    _, conn = built
    for r in conn.execute("SELECT start_x, start_y, end_x, end_y FROM events"):
        assert 0 <= r[0] <= 105 and 0 <= r[2] <= 105 and 0 <= r[1] <= 68 and 0 <= r[3] <= 68
    for m in conn.execute("SELECT match_id FROM matches"):
        xy = frames(conn, m[0])[..., :2]
        ok = np.isfinite(xy[..., 0])
        assert (xy[ok][:, 0] >= 0).all() and (xy[ok][:, 0] <= 105).all()
        assert (xy[ok][:, 1] >= 0).all() and (xy[ok][:, 1] <= 68).all()


def test_frame_count(built):
    _, conn = built
    for m in conn.execute("SELECT * FROM matches"):
        n = conn.execute("SELECT COUNT(*) FROM tracking_frames WHERE match_id=?", (m["match_id"],)).fetchone()[0]
        assert n == round((m["period1_s"] + m["period2_s"]) * m["fps"])


def test_speed_and_acceleration_caps(built):
    _, conn = built
    cal = load_calibration()
    top = {r[0]: r[1] for r in conn.execute("SELECT player_id, top_speed_kmh FROM players")}
    for m in conn.execute("SELECT * FROM matches").fetchall():
        pos = frames(conn, m["match_id"])
        speed, acc = kinematics(pos, m["fps"], int(round(m["period1_s"] * m["fps"])))
        ents = [r[0] for r in conn.execute("SELECT entity FROM tracking_entities WHERE match_id=? "
                                           "ORDER BY idx", (m["match_id"],))][1:]
        caps = np.array([top[p] for p in ents])
        assert np.nanmax(speed - caps) <= 0.05
        assert np.nanmax(speed) <= 36.05  # the planted sprint is the only one above 34
        assert np.nanmax(acc) <= cal["max_accel_ms2"]["value"] + 0.05


def test_score_matches_goal_events(built):
    _, conn = built
    for m in conn.execute("SELECT * FROM matches"):
        goals = conn.execute("SELECT team_id, COUNT(*) FROM events WHERE match_id=? AND result_name='success' "
                             "AND type_name IN ('shot','shot_freekick','shot_penalty') GROUP BY team_id",
                             (m["match_id"],)).fetchall()
        g = dict(goals)
        assert (g.get(m["home_team_id"], 0), g.get(m["away_team_id"], 0)) == (m["home_score"], m["away_score"])


def test_no_forbidden_names(built):
    _, conn = built
    texts = [r[0] for r in conn.execute("SELECT name FROM teams UNION ALL SELECT short_name FROM teams "
                                        "UNION ALL SELECT name FROM players UNION ALL SELECT venue_name FROM matches")]
    texts += [v["source"] for v in load_calibration().values()]
    assert texts and not [t for t in texts if is_forbidden(t)]
    names = dict(conn.execute("SELECT player_id, name FROM players"))
    assert names["T05-15"] == "Diego Ekwueme"  # a real footballer's name, moved along LAST


def test_a_listed_player_name_moves_without_shifting_the_random_stream(monkeypatch):
    from studiodesk.sim import squads
    cal = load_calibration()
    rng = np.random.default_rng(7)
    teams, players, venues = make_league(rng, cal)
    after = rng.integers(1 << 62)
    real, listed = squads.is_forbidden, players[0]["name"]
    monkeypatch.setattr(squads, "is_forbidden", lambda t: real(t) or t == listed)
    rng = np.random.default_rng(7)
    teams2, players2, venues2 = make_league(rng, cal)
    assert rng.integers(1 << 62) == after and (teams2, venues2) == (teams, venues)
    # the moved surname may push a later team-mate's along too, but nothing else of the league moves
    assert players2[0]["name"] != listed and listed not in [p["name"] for p in players2]
    strip = lambda ps: [{k: v for k, v in p.items() if k != "name"} for p in ps]  # noqa: E731
    assert strip(players2) == strip(players)


def test_a_listed_short_name_stops_the_build(monkeypatch):
    from studiodesk.sim import squads
    monkeypatch.setattr(squads, "is_forbidden", lambda t: len(t) == 3)
    with pytest.raises(ValueError, match="short name"):
        make_league(np.random.default_rng(7), load_calibration())


def test_no_two_players_of_a_fixture_share_a_surname(built):
    from studiodesk.sim.squads import LAST
    _, conn = built
    for mid, home, away in conn.execute("SELECT match_id, home_team_id, away_team_id FROM matches"):
        surnames = [r[0].rsplit(" ", 1)[1] for r in conn.execute(
            "SELECT name FROM players WHERE team_id IN (?, ?)", (home, away))]
        assert len(surnames) == len(set(surnames)), mid
    old = {"Adeyemi", "Castellanos", "Marchetti", "Benali", "Petrov"}  # real players' surnames, replaced
    assert not old & set(LAST) and not any(is_forbidden(n) for n in LAST)


def test_every_planted_kind_and_two_comebacks(built):
    _, conn = built
    kinds = [r[0] for r in conn.execute("SELECT kind FROM storylines")]
    for kind in ("tactical_shift", "high_press", "top_sprint"):
        assert kinds.count(kind) == 4, kind
    assert kinds.count("comeback") >= 2


def test_calibration_format_and_report(built):
    for name, entry in load_calibration().items():
        assert set(entry) == {"value", "source"} and entry["source"], name
    text = report(built[0])
    assert "actions_per_team_per_match" in text and "storyline" not in text.lower()


def test_sides_switch_at_half_time_and_t_restarts(built):
    _, conn = built
    for m in conn.execute("SELECT * FROM matches").fetchall():
        p1 = m["period1_s"]
        for period, sign in ((1, 1), (2, -1)):
            xs = [r[0] for r in conn.execute(
                "SELECT start_x FROM events WHERE match_id=? AND period=? AND team_id=? AND type_name LIKE 'shot%'",
                (m["match_id"], period, m["home_team_id"]))]
            assert all((x - 52.5) * sign > 0 for x in xs), (m["match_id"], period)  # home shoots at 105, then 0
        for t, ts in conn.execute("SELECT t, ts FROM events WHERE match_id=? AND period=2", (m["match_id"],)):
            assert abs(t - (ts - p1)) <= 0.011  # t is period-relative


def test_ball_has_an_owner_in_open_play(built):
    _, conn = built
    for (mid,) in conn.execute("SELECT match_id FROM matches"):
        owned, total = conn.execute("SELECT COUNT(ball_owner), COUNT(*) FROM tracking_frames WHERE match_id=?",
                                    (mid,)).fetchone()
        assert 0.3 < owned / total < 1, mid
