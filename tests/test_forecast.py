"""Watch for (studiodesk/forecast.py, docs/forecast.md): the model, its export, the MCP tool and the calibration."""
import asyncio
import json
import os
import re
import sys
from contextlib import closing
from pathlib import Path

import pytest

from studiodesk import config, db, forecast
from studiodesk import mcp_server as srv
from studiodesk.names import find_forbidden

ROOT = Path(__file__).resolve().parent.parent
REAL = config.MATCHES_DB.exists()
sys.path.insert(0, str(ROOT / "scripts"))


def fact(fid, kind, ts, team, value, player=None):
    return {"fact_id": fid, "kind": kind, "ts": ts, "period": 1, "team_id": team, "player_id": player, "value": value}


def game(*facts, p1=2760.0):
    """T01 v T02, no shots; facts added to that."""
    base = [fact("F-TEAM_SHOTS-1", "team_shots", 0.0, "T01", 0), fact("F-TEAM_SHOTS-2", "team_shots", 0.0, "T02", 0)]
    return forecast.Game([*base, *facts], "T01", "T02", p1, {}, 5600.0)


def p_of(g, ts, item_id):
    return next((it["p"] for it in forecast.forecasts(g, ts) if it["id"] == item_id), None)


def test_probabilities_in_range_with_their_facts(match_db):
    _, conn = match_db
    g = forecast.Game.from_db(conn, "M001")
    known = {f["fact_id"]: f for f in g.facts}
    steps = forecast.timeline(g)
    assert steps and any(st["items"] for st in steps)
    for st in steps:
        for it in st["items"]:
            assert 0.0 <= it["p"] <= 1.0 and it["kind"] in forecast.KINDS
            assert it["fact_ids"] and all(known[f]["ts"] <= st["ts"] + 1e-6 for f in it["fact_ids"])


def test_monotonic_where_it_should_be():
    goal = [fact("F-SCORE-1", "score", 600.0, "T01", 1, "T01-9"), fact("F-PLAYER_GOALS-1", "player_goals", 600.0, "T01", 1, "T01-9")]
    g = game(*goal)
    times = [700.0 + 300 * k for k in range(16)]
    clean = [p_of(g, t, "W-clean_sheet-T01") for t in times]
    second = [p_of(g, t, "W-second_goal-T01-9") for t in times]
    late = [p_of(g, t, "W-late_goal") for t in times]
    back = [p_of(g, t, "W-comeback-F-SCORE-1") for t in times]
    for seq in (second, late, back):  # no goal: less time left, less chance
        assert all(a >= b - 1e-9 for a, b in zip(seq, seq[1:])), seq
    assert all(a <= b + 1e-9 for a, b in zip(clean, clean[1:])), clean  # keeping it gets likelier
    assert clean[-1] > clean[0] and second[-1] < second[0]
    # two goals behind is harder than one
    two = game(*goal, fact("F-SCORE-2", "score", 900.0, "T01", 2, "T01-7"))
    assert p_of(two, 1000.0, "W-comeback-F-SCORE-1") < p_of(g, 1000.0, "W-comeback-F-SCORE-1")
    # a substituted scorer has no second goal to watch for
    off = forecast.Game(g.facts, "T01", "T02", 2760.0, {"T01-9": (0.0, 1200.0)}, 5600.0)
    assert p_of(off, 1100.0, "W-second_goal-T01-9") is not None and p_of(off, 1300.0, "W-second_goal-T01-9") is None


def test_reads_only_the_facts_up_to_now(match_db):
    _, conn = match_db
    full = forecast.Game.from_db(conn, "M001")
    for ts in (0.0, 100.0, full.p1 - 5, full.p1 + 10, full.end - 30):  # the fixture match lasts 6 minutes
        now = forecast.Game(full.upto(ts), full.home, full.away, full.p1 if full.p1 <= ts else None, full.lineups)
        assert forecast.forecasts(now, ts) == forecast.forecasts(full, ts)


@pytest.mark.skipif(not REAL, reason="no data/matches.sqlite")
@pytest.mark.parametrize("match_id, expected", [
    ("M001", {"W-second_goal-T01-9": (True, 772.6, "F-PLAYER_GOALS-000024"), "W-comeback-F-SCORE-000001": (True, 4908.1, "F-SCORE-000004"),
              "W-late_goal": (True, 4908.1, "F-SCORE-000004"), "W-clean_sheet-T01": (False, 3052.5, "F-SCORE-000003"),
              "W-clean_sheet-T02": (False, 595.7, "F-SCORE-000001")}),
    ("M002", {"W-comeback-F-SCORE-000001": (True, 4462.1, "F-SCORE-000004"), "W-clean_sheet-T04": (False, 1323.3, "F-SCORE-000001")}),
    ("M003", {"W-clean_sheet-T05": (False, 790.2, "F-SCORE-000001"), "W-comeback-F-SCORE-000001": (False, None, None)}),
    ("M004", {"W-clean_sheet-T07": (False, 1825.1, "F-SCORE-000001"), "W-comeback-F-SCORE-000001": (False, None, None)}),
])
def test_resolves_on_the_replays(match_id, expected):
    with closing(db.connect(config.MATCHES_DB, readonly=True)) as conn:
        g = forecast.Game.from_db(conn, match_id)
        data = forecast.export(conn, match_id)
    items = {it["id"]: it for it in data["items"]}
    for item_id, (hit, at, trigger) in expected.items():
        it = items[item_id]
        assert (it["hit"], it["trigger_fact_id"]) == (hit, trigger), item_id
        assert it["at"] == (at if at is not None else round(g.end, 2)), item_id
        assert (it["line"] is not None) == hit
    clean = {it["id"]: it["hit"] for it in data["items"] if it["kind"] == "clean_sheet"}
    assert clean == {"M001": {"W-clean_sheet-T01": False, "W-clean_sheet-T02": False},
                     "M002": {"W-clean_sheet-T03": False, "W-clean_sheet-T04": False},
                     "M003": {"W-clean_sheet-T05": False, "W-clean_sheet-T06": True},
                     "M004": {"W-clean_sheet-T07": False, "W-clean_sheet-T08": True}}[match_id]


@pytest.mark.skipif(not REAL, reason="no data/matches.sqlite")
def test_the_prepared_lines_on_m001():
    with closing(db.connect(config.MATCHES_DB, readonly=True)) as conn:
        data = forecast.export(conn, "M001")
    it = next(i for i in data["items"] if i["id"] == "W-second_goal-T01-9")
    assert re.search(r"\{minute\}.*\{score\}", it["template"]["en"])
    assert it["line"]["en"].startswith(it["template"]["en"].split(" {")[0]) and "13th minute" in it["line"]["en"]
    assert "F-PLAYER_GOALS-000024" in it["line_fact_ids"]


def test_export_words_and_facts(match_db):
    _, conn = match_db
    data = forecast.export(conn, "M001")
    known = {r["fact_id"] for r in conn.execute("SELECT fact_id FROM facts WHERE match_id = 'M001'")}
    text = json.dumps(data, ensure_ascii=False)
    assert "—" not in text and "–" not in text
    for it in data["items"]:
        assert set(it["title"]) == set(it["template"]) == {"en", "it", "es"}
        assert set(it["line_fact_ids"]) <= known
        assert it["trigger_fact_id"] is None or it["trigger_fact_id"] in known
        for s in [*it["template"].values(), *(it["line"] or {}).values()]:
            assert not find_forbidden(s)
        for s in (it["line"] or {}).values():
            assert "{" not in s
    for st in data["steps"]:
        for it in st["items"]:
            assert set(it["reason"]) == {"en", "it", "es"} and all("{" not in r for r in it["reason"].values())


def test_never_reads_the_answer_key():
    word = "story" + "lines"
    for path in (ROOT / "studiodesk" / "forecast.py", ROOT / "web" / "js" / "forecast.js"):
        assert word not in path.read_text().lower(), path


# --- the MCP tool -----------------------------------------------------------------------------------

@pytest.fixture
def server_db(match_db, monkeypatch):
    info, _ = match_db
    monkeypatch.setattr(srv, "DB_PATH", info["path"])
    srv.set_clock(None)
    yield info
    srv.set_clock(None)


def test_mcp_tool_is_held_at_the_clock(server_db, monkeypatch):
    seen = []
    real = db.connect

    def watched(*a, **kw):
        conn = real(*a, **kw)
        conn.set_authorizer(lambda op, t, *_: seen.append(t) or 0)
        return conn
    monkeypatch.setattr(db, "connect", watched)
    goal = srv.get_facts("M001", kind="score")[0]
    srv.set_clock(goal["ts"] - 1)
    before = srv.get_forecasts("M001", ts=1e9)   # asking later than the clock gives the clock
    assert before["ts"] == goal["ts"] - 1
    assert all(srv.get_fact("M001", f)["ts"] <= goal["ts"] - 1 for it in before["items"] for f in it["fact_ids"])
    assert not any(it["kind"] == "comeback" for it in before["items"])
    assert srv.get_forecasts("M001", ts=10.0)["ts"] == 10.0   # an earlier minute is fine
    srv.set_clock(goal["ts"] + 1)
    after = srv.get_forecasts("M001")
    assert any(it["kind"] == "comeback" for it in after["items"])   # the other side now trails
    with srv.clock_at(5.0):
        assert srv.get_forecasts("M001", ts=100.0)["ts"] == 5.0
    assert "error" in srv.get_forecasts("M999")
    assert "facts" in seen and ("story" + "lines") not in seen


def test_mcp_tool_served_over_stdio(server_db):
    """The real server process lists get_forecasts, read-only, and holds it at its clock."""
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    params = StdioServerParameters(command=sys.executable, args=["-m", "studiodesk.mcp_server"], cwd=str(ROOT),
                                   env={**os.environ, "STUDIODESK_MATCHES_DB": str(server_db["path"]), "STUDIODESK_CLOCK": "300"})

    async def run():
        async with stdio_client(params) as (r, w), ClientSession(r, w) as s:
            await s.initialize()
            tools = {t.name: t for t in (await s.list_tools()).tools}
            res = await s.call_tool("get_forecasts", {"match_id": "M001", "ts": 4000})
            return tools, json.loads(res.content[0].text)

    tools, out = asyncio.run(run())
    assert tools["get_forecasts"].annotations.readOnlyHint
    assert out["ts"] == 300.0 and out["items"]


# --- calibration --------------------------------------------------------------------------------------

def test_calibration_is_reproducible(tmp_path):
    import forecast_calibrate as cal
    a, b = cal.run(3, 3, seed=5), cal.run(3, 3, seed=5)
    assert a["params"] == b["params"] and a["scores"] == b["scores"] and a["test_rows"] == b["test_rows"]
    assert a["test_rows"] != cal.run(3, 3, seed=6)["test_rows"]
    assert all(0 <= r[4] <= 1 and r[5] in (0, 1) for r in a["test_rows"])
    run_id = cal.save(a, tmp_path / "forecast.sqlite")
    with closing(db.connect(tmp_path / "forecast.sqlite", readonly=True)) as conn:
        n = conn.execute("SELECT COUNT(*) FROM forecast_samples WHERE run_id = ? AND set_name = 'test'", (run_id,)).fetchone()[0]
        kinds = {r[0] for r in conn.execute("SELECT kind FROM forecast_scores WHERE run_id = ?", (run_id,))}
    assert n == len(a["test_rows"]) and kinds == set(forecast.KINDS)


def test_shipped_parameters_come_from_the_calibration():
    saved = json.loads(forecast.PARAMS_FILE.read_text())
    assert set(saved["params"]) == set(forecast.DEFAULT)
    assert saved["evaluation"]["n_fit"] >= 100 and saved["evaluation"]["n_test"] >= 100
    assert set(saved["evaluation"]["scores"]) == set(forecast.KINDS)
    assert "simulated" in saved["evaluation"]["note"]
