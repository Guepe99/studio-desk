import asyncio
from pathlib import Path

import pytest

from studiodesk import mcp_server as srv

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def server_db(match_db, monkeypatch):
    info, _ = match_db
    monkeypatch.setattr(srv, "DB_PATH", info["path"])
    srv.set_clock(None)
    yield info
    srv.set_clock(None)


def test_tools_without_clock(server_db):
    info = server_db
    m = srv.get_match_info("M001")
    assert m["score"] == {"home": 1, "away": 0} and len(m["players"]) == 22
    assert {t["side"] for t in m["teams"]} == {"home", "away"}
    assert "top_speed_kmh" not in m["players"][0]
    assert srv.get_events("M001", 0, 1e9, "shot")[0]["event_id"] == info["goal_event_id"]
    shots = srv.get_facts("M001", kind="shot_speed")
    assert shots and shots[0]["source_event_ids"] == [info["goal_event_id"]]
    assert srv.get_fact("M001", shots[0]["fact_id"])["value"] == shots[0]["value"]
    assert "error" in srv.get_fact("M001", "F-NOPE-000001")
    assert srv.get_player("M001", "T01-9")["team_short"] == "HAR"
    assert len(srv.get_momentum("M001")) == 4 and len(srv.get_momentum("M001", "T02")) == 2
    assert srv.get_facts("M001", team_id="T01", player_id="T01-9", from_ts=100, to_ts=400)


def test_clock_hides_the_future(server_db):
    srv.set_clock(190.0)  # after half-time, before the goal at about 195 s
    assert srv.get_match_info("M001")["score"] == {"home": 0, "away": 0}
    assert not srv.get_events("M001", 0, 1e9, "shot")
    assert max(f["ts"] for f in srv.get_facts("M001")) <= 190.0
    assert len(srv.get_momentum("M001")) == 2
    srv.set_clock(None)
    assert srv.get_match_info("M001")["score"]["home"] == 1


def test_clock_hides_later_lineups_facts_and_period_lengths(server_db, match_db):
    _, conn = match_db
    conn.execute("UPDATE lineups SET off_ts = 300 WHERE player_id = 'T01-9'")
    conn.execute("UPDATE lineups SET on_ts = 250 WHERE player_id = 'T01-10'")
    conn.commit()
    shot = srv.get_facts("M001", kind="shot_speed")[0]
    srv.set_clock(190.0)
    assert "error" in srv.get_fact("M001", shot["fact_id"])
    assert srv.get_player("M001", "T01-9")["lineup"]["off_ts"] is None
    assert srv.get_player("M001", "T01-10")["lineup"] is None
    m = srv.get_match_info("M001")
    assert len(m["players"]) == 21 and m["period1_s"] == 180.0 and m["period2_s"] is None
    srv.set_clock(100.0)
    assert srv.get_match_info("M001")["period1_s"] is None
    srv.set_clock(None)
    assert srv.get_player("M001", "T01-9")["lineup"]["off_ts"] == 300


def test_lists_tools_through_the_sdk(server_db):
    from mcp.shared.memory import create_connected_server_and_client_session

    async def run():
        async with create_connected_server_and_client_session(srv.server) as client:
            tools = (await client.list_tools()).tools
            res = await client.call_tool("get_fact", {"match_id": "M001", "fact_id": "F-SCORE-000001"})
            return {t.name for t in tools}, res

    names, res = asyncio.run(run())
    assert names == {"get_match_info", "get_events", "get_facts", "get_fact", "get_player", "get_momentum", "get_team_totals",
                     "get_scorers"}
    assert not res.isError and "Goal 1-0" in res.content[0].text


def test_never_reads_the_answer_key():
    word = "story" + "lines"
    # the agents and the API too; scripts/measures.py and scripts/eval_stories.py grade against it, so they may
    paths = [ROOT / "studiodesk" / "mcp_server.py", ROOT / "studiodesk" / "api.py",
             *(ROOT / "studiodesk" / "facts").glob("*.py"), *(ROOT / "studiodesk" / "agents").glob("*.py")]
    assert len(paths) > 10
    for path in paths:
        assert word not in path.read_text().lower(), path


def test_get_facts_names_every_kind_the_engine_writes():
    # the model only finds goals if the tool description names kind "score"
    import re
    written = set(re.findall(r'add\("([a-z_]+)"', (ROOT / "studiodesk/facts/engine.py").read_text()))
    doc = srv.get_facts.__doc__.split("kind is one of:")[1]
    assert len(written) > 10 and [k for k in written if not re.search(rf"\b{k}\b", doc)] == []


def test_get_facts_top_gives_the_highest_values_first(server_db):
    every = srv.get_facts("M001", kind="pass_distance")
    top = srv.get_facts("M001", kind="pass_distance", top=2)
    assert len(every) > 2 and [f["value"] for f in top] == sorted((f["value"] for f in every), reverse=True)[:2]
