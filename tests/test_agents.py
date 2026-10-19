"""Agents workflow, offline: a fake chat client stands in for gpt-5-mini (no Azure from tests)."""
import asyncio
import json
from pathlib import Path

import pytest
from test_export import PAYLOAD_KEYS

from studiodesk import config, db
from studiodesk import mcp_server as srv
from studiodesk.agents import rules, workflow
from studiodesk.agents.llm import FakeChatClient, cost_usd
from studiodesk.export import export

ROOT = Path(__file__).resolve().parent.parent
AGENTS = ["story_finder", "analyst", "commentator_en", "commentator_it", "commentator_es", "verifier", "director"]


@pytest.fixture
def desk_db(match_db, monkeypatch, tmp_path):
    info, conn = match_db
    monkeypatch.setattr(srv, "DB_PATH", info["path"])
    rt = db.connect(tmp_path / "runtime.sqlite")
    yield info, conn, rt
    rt.close()
    srv.set_clock(None)


def run(rt, client, **kw):
    return asyncio.run(workflow.run_match("M001", client, rt, log=lambda *_: None, **kw))


def rows(rt, table):
    return [dict(r) for r in rt.execute(f"SELECT * FROM {table} ORDER BY rowid")]


def stories(rt):
    out = rows(rt, "stories")
    for s in out:
        for c in ("texts", "verifier", "fact_ids"):
            s[c] = json.loads(s[c])
    return out


# --- verifier rules ------------------------------------------------------------------------------

FACTS = [{"fact_id": "F-SHOT_SPEED-000001", "kind": "shot_speed", "value": 92.3, "unit": "km/h",
          "label_en": "Shot at 92.3 km/h"},
         {"fact_id": "F-LINE_HEIGHT-000001", "kind": "line_height", "value": 31.2, "unit": "m",
          "label_en": "Defensive line 31.2 m from goal, min 51-55"}]
ALLOWED = rules.allowed_numbers(FACTS, minutes=[52])


def test_verifier_passes_ledger_numbers_with_rounding_and_units():
    assert rules.check_text("In minute 52 a shot at 92 km/h [F-SHOT_SPEED-000001].", ALLOWED) == []
    assert rules.check_text("Linea difensiva a 31,2 metri dalla porta al 52'.", ALLOWED) == []
    assert rules.check_text("Disparo a 92.3 km/h, línea a 31 m.", ALLOWED) == []


def test_verifier_catches_wrong_number_unit_mismatch_and_real_name():
    assert rules.check_text("A shot at 97 km/h.", ALLOWED) == ["number not in the facts: '97 km/h'"]
    assert rules.check_text("The line moved to 92.3 m.", ALLOWED)[0].startswith("unit mismatch")
    assert rules.check_text("Harry Kane hits it at 92.3 km/h.", ALLOWED) == ["forbidden name: 'harry kane'"]


def test_on_screen_text_has_no_dashes():
    assert rules.tidy("Minute 50 \u2014 a strike at 96 km/h \u2013 2\u20131.") == "Minute 50, a strike at 96 km/h, 2-1."


def test_risk_maps_to_default_status():
    assert rules.default_status(config.AUTO_APPROVE_RISK - 0.01) == "auto_approved"
    assert rules.default_status(config.AUTO_APPROVE_RISK) == "needs_review"
    clean = {"verifier": {"status": "pass"}, "confidence": 0.9, "fact_ids": ["F-1"], "player_id": None}
    assert rules.default_status(rules.risk(clean)) == "auto_approved"
    assert rules.default_status(rules.risk({**clean, "verifier": {"status": "template"}})) == "needs_review"
    assert rules.default_status(rules.risk({**clean, "fact_ids": []})) == "needs_review"
    assert 0 <= rules.risk({**clean, "verifier": {"status": "template"}, "fact_ids": [], "confidence": 0}) <= 1


def test_cost_from_tokens():
    usage = {"input_token_count": 1_000_000, "cache_read_input_token_count": 200_000, "output_token_count": 100_000}
    assert cost_usd(usage) == pytest.approx(0.8 * 0.25 + 0.2 * 0.025 + 0.1 * 2.00)


# --- the workflow on the fixture match -----------------------------------------------------------

def test_run_writes_stories_cues_traces_and_audit(desk_db):
    _, _, rt = desk_db
    fake = FakeChatClient()
    summary = run(rt, fake)
    st = stories(rt)
    assert summary["stories"] == len(st) and {"goal", "recap"} <= {s["kind"] for s in st}
    for s in st:
        assert set(s["texts"]) == {"en", "it", "es"} and all(s["texts"].values())
        assert s["verifier"]["status"] == "pass" and set(s["verifier"]) == {"status", "attempts", "flagged"}
        assert s["default_status"] == rules.default_status(s["risk"]) and s["fact_ids"]
    # one trace per hand-off, in workflow order, for every batch
    tr = rows(rt, "traces")
    assert [t["seq"] for t in tr] == list(range(1, len(tr) + 1))
    batches = [tr[i:i + len(AGENTS)] for i in range(0, len(tr), len(AGENTS))]
    assert batches and all([t["agent"] for t in b] == AGENTS for b in batches)
    # one audit row per model call, actor = agent name, cost from tokens
    au = rows(rt, "audit")
    assert len(au) == len(fake.calls) == summary["model_calls"]
    assert {a["actor"] for a in au} == set(AGENTS) - {"director"}
    assert sum(a["cost_usd"] for a in au) == pytest.approx(summary["cost_usd"], abs=1e-4)


def test_storylines_are_never_read(desk_db, monkeypatch):
    _, _, rt = desk_db
    seen = []
    real = db.connect

    def watched(*a, **kw):
        conn = real(*a, **kw)
        conn.set_authorizer(lambda op, t, *_: seen.append(t) or 0)
        return conn

    monkeypatch.setattr(db, "connect", watched)
    run(rt, FakeChatClient())
    assert "facts" in seen and "storylines" not in seen
    for path in [ROOT / "studiodesk" / "mcp_server.py", *(ROOT / "studiodesk" / "agents").glob("*.py")]:
        assert "storylines" not in path.read_text(), path


def test_rewrites_at_most_twice_then_template(desk_db):
    _, _, rt = desk_db
    fake = FakeChatClient(lambda schema, p: {"lines": [{"story_id": s["story_id"], "text": "Minuto 1: 999 km/h."}
                                                       for s in p["stories"]]}
                          if schema == "Lines" and p["language"] == "it" else None)
    run(rt, fake)
    it_calls = sum(1 for schema, p in fake.calls if schema == "Lines" and p["language"] == "it")
    finder_calls = sum(1 for schema, _ in fake.calls if schema == "Picks")
    assert it_calls == (1 + config.MAX_REWRITES) * finder_calls
    for s in stories(rt):
        assert s["verifier"]["status"] == "template" and s["verifier"]["attempts"] == 1 + config.MAX_REWRITES
        assert "999" not in s["texts"]["it"] and s["texts"]["en"].startswith("Minute")
        assert any("number not in the facts: '999 km/h'" in f for f in s["verifier"]["flagged"])
        assert s["default_status"] == "needs_review"


def test_one_rewrite_fixes_it(desk_db):
    _, _, rt = desk_db
    fake = FakeChatClient(lambda schema, p: {"lines": [{"story_id": s["story_id"], "text": "Gol a 999 km/h."}
                                                       for s in p["stories"]]}
                          if schema == "Lines" and p["language"] == "es" and "feedback" not in p else None)
    run(rt, fake)
    for s in stories(rt):
        assert s["verifier"]["status"] == "rewritten" and s["verifier"]["attempts"] == 2
        assert "999" not in s["texts"]["es"]


def test_judge_flags_claims_without_numbers(desk_db):
    _, _, rt = desk_db
    calls = []

    def judge(schema, p):
        if schema == "Verdicts":
            calls.append(p)
            return {"verdicts": [{"story_id": t["story_id"], "lang": t["lang"], "ok": t["lang"] != "en",
                                  "issue": "invented claim"} for t in p["texts"]]}
        return None

    run(rt, FakeChatClient(judge))
    assert calls and all(s["verifier"]["status"] == "template" for s in stories(rt))


@pytest.mark.parametrize("failing", ["Picks", "Analyses", "Lines", "Verdicts", "all", "timeout"])
def test_agent_failure_falls_back_and_never_blocks(desk_db, monkeypatch, failing):
    _, _, rt = desk_db

    def responder(schema, p):
        if failing in (schema, "all"):
            raise RuntimeError("model down")
        return None

    if failing == "timeout":
        monkeypatch.setattr(config, "AGENT_TIMEOUT_S", 0.05)
        fake = FakeChatClient(delay_s=1.0)
    else:
        fake = FakeChatClient(responder)
    summary = run(rt, fake)
    st = stories(rt)
    assert {"goal", "recap"} <= {s["kind"] for s in st} and summary["cues"] > 0
    for s in st:
        assert set(s["texts"]) == {"en", "it", "es"} and all(s["texts"].values()) and s["analysis_en"]
        if failing in ("Lines", "all", "timeout"):
            assert s["verifier"]["status"] == "template" and s["default_status"] == "needs_review"
        if failing == "Verdicts":
            assert s["verifier"]["status"] == "pass" and s["risk"] > 0.2  # numbers checked, claims not judged
    if failing != "Verdicts":
        assert any("fallback" in t["output_summary"] for t in rows(rt, "traces"))


def test_director_never_shows_more_than_two_graphics(desk_db):
    _, _, rt = desk_db
    m = rules.Match(srv.get_match_info("M001"))
    for f in srv.get_facts("M001"):
        m.facts[f["fact_id"]] = f
    goal = rules.goal_candidates(m, m.kind("score")[0])[0]
    crowd = [{**goal, "story_id": f"S-{i:06d}", "fact_ids": [f["fact_id"] for f in goal["facts"]],
              "texts": {lang: "text" for lang in rules.LANGS}} for i in range(6)]
    cues = rules.Director(m).plan(crowd)
    run(rt, FakeChatClient())
    cues += [{**c, "audience": "run:" + c["audience"]} for c in rows(rt, "cues")]
    assert cues
    for key in {(c["audience"], c["lang"]) for c in cues}:
        mine = [c for c in cues if (c["audience"], c["lang"]) == key]
        for c in mine:
            assert sum(d["ts"] <= c["ts"] < d["ts"] + d["duration_s"] for d in mine) <= config.MAX_GRAPHICS_ON_SCREEN


def test_export_uses_runtime_records_with_contract_shapes(desk_db, tmp_path):
    _, conn, rt = desk_db
    run(rt, FakeChatClient())
    out = export("M001", conn, tmp_path / "web", rt)
    st, cues, tr = (json.loads((out / f"{n}.json").read_text()) for n in ("stories", "cues", "traces"))
    fact_ids = {f["fact_id"] for f in json.loads((out / "facts.json").read_text())}
    assert st and cues and tr
    for rows_ in (st, cues, tr):
        assert [r["ts"] for r in rows_] == sorted(r["ts"] for r in rows_)
    for s in st:
        assert set(s["texts"]) == {"en", "it", "es"} and set(s["fact_ids"]) <= fact_ids
    assert {c["lang"] for c in cues} == {"en", "it", "es"} and {"analyst", "casual"} <= {c["audience"] for c in cues}
    for c in cues:
        assert set(c["payload"]) == PAYLOAD_KEYS[c["graphic"]]
        assert set(c["payload"].get("fact_ids") or [c["payload"]["fact_id"]]) <= fact_ids
        assert c["audience"] in ("analyst", "casual") or c["audience"].split(":")[0] in ("team", "player")
    assert all(isinstance(t["fact_ids"], list) for t in tr)


def test_agents_reach_the_match_through_mcp_tools(desk_db):
    _, _, rt = desk_db
    fact = srv.get_facts("M001", kind="score")[0]

    def responder(schema, p):
        if schema == "Analyses":
            return {"tool_call": {"name": "get_fact", "arguments": {"match_id": "M001", "fact_id": fact["fact_id"]}}}
        return None

    fake = FakeChatClient(responder)
    run(rt, fake)
    got = [str(r) for r in fake.tool_results if fact["fact_id"] in str(r)]
    assert any('"label_en": "Goal 1-0"' in r for r in got)
    assert any("no fact" in r for r in got)  # asked before the goal: the MCP clock hides the future

    async def tool_names():
        async with workflow.mcp_session() as session:
            tool = workflow.InProcessMCPTool(name="studiodesk", session=session, load_prompts=False,
                                             allowed_tools=workflow.AGENT_TOOLS["analyst"])
            await tool.connect()
            return sorted(f.name for f in tool.functions)

    assert asyncio.run(tool_names()) == sorted(workflow.AGENT_TOOLS["analyst"])


def test_window_run_only_sees_its_window(desk_db):
    _, _, rt = desk_db
    run(rt, FakeChatClient(), from_ts=0, to_ts=150)  # before the goal at about 195 s
    assert {s["kind"] for s in stories(rt)} <= {"big_chance", "pressing_spell", "momentum_swing", "top_sprint"}
    assert all(t["ts"] <= 150 for t in rows(rt, "traces"))
