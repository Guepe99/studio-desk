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


def test_lists_tools_through_the_sdk(server_db):
    from mcp.shared.memory import create_connected_server_and_client_session

    async def run():
        async with create_connected_server_and_client_session(srv.server) as client:
            tools = (await client.list_tools()).tools
            res = await client.call_tool("get_fact", {"match_id": "M001", "fact_id": "F-SCORE-000001"})
            return {t.name for t in tools}, res

    names, res = asyncio.run(run())
    assert names == {"get_match_info", "get_events", "get_facts", "get_fact", "get_player", "get_momentum"}
    assert not res.isError and "Goal 1-0" in res.content[0].text


def test_never_reads_the_answer_key():
    word = "story" + "lines"
    for path in [ROOT / "studiodesk" / "mcp_server.py", *(ROOT / "studiodesk" / "facts").glob("*.py")]:
        assert word not in path.read_text().lower(), path
