"""examples/studio_assistant.py against the MCP server over stdio, on the fixture match: no model, no Azure."""
import asyncio
import importlib.util
from pathlib import Path

import mcp.client.stdio  # noqa: F401 - binds stdio_client's errlog default to the session's stderr, not to one test's capture
import pytest

from studiodesk.agents.llm import FakeChatClient

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("studio_assistant", ROOT / "examples" / "studio_assistant.py")
example = importlib.util.module_from_spec(spec)
spec.loader.exec_module(example)


@pytest.fixture
def fixture_db(match_db, monkeypatch):
    info, _ = match_db
    monkeypatch.setenv("STUDIODESK_MATCHES_DB", str(info["path"]))  # forwarded to the server process
    return info


def test_dry_run_lists_tools_and_holds_the_clock(fixture_db, capfd):  # capfd: the stdio client hands the child a real stderr
    late = asyncio.run(example.dry_run("M001", 5))  # the fixture match is 6 minutes long: everything
    out = capfd.readouterr().out
    assert "tools: get_match_info, get_events, get_facts, get_fact, get_player, get_momentum, get_team_totals" in out
    assert late and all(f["ts"] <= 300 for f in late) and f"[{late[0]['fact_id']}]" in out
    early = asyncio.run(example.dry_run("M001", 1))
    assert all(f["ts"] <= 60 for f in early) and len(early) <= len(late)


def test_second_half_minute_counts_from_the_first_half_length(fixture_db):
    assert asyncio.run(example.clock_for("M001", 30)) == 1800.0
    assert asyncio.run(example.clock_for("M001", 47)) == 180.0 + 120.0  # the fixture's first half is 180 s


def test_agent_reads_through_the_mcp_tools(fixture_db):
    fake = FakeChatClient(lambda schema, p: {"tool_call": {"name": "get_scorers", "arguments": {"match_id": p["match_id"]}}})
    answer, calls = asyncio.run(example.ask("Who has scored so far?", "M001", 5, client=fake))
    assert calls == [("get_scorers", {"match_id": "M001"})]
    assert fake.calls[0][1] == {"match_id": "M001", "minute": 5, "question": "Who has scored so far?"}
    assert "player_goals" in str(fake.tool_results)  # the goal came back from the server
    assert answer.fact_ids == []
