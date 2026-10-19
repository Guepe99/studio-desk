"""Ask the studio, offline: POST /api/ask with FakeChatClient in place of gpt-5-mini and a stub for Content Safety."""
import asyncio
import json
from contextlib import closing
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from studiodesk import api, config, db
from studiodesk import mcp_server as srv
from studiodesk.agents import ask
from studiodesk.agents.llm import FakeChatClient

SPRINT, SHOT = "F-SPRINT_SPEED-000001", "F-SHOT_SPEED-000001"  # the fixture's sprint at 63 s, shot at 196 s


@pytest.fixture
def studio(match_db, tmp_path, monkeypatch):
    info, _ = match_db
    monkeypatch.setattr(srv, "DB_PATH", info["path"])
    monkeypatch.setattr(config, "RUNTIME_DB", tmp_path / "runtime.sqlite")
    monkeypatch.setattr(api, "ENDPOINT", "https://model.invalid")
    monkeypatch.setattr(api, "_new_sessions", {"day": "", "by_client": {}})
    # never a paid service: the real client and Content Safety fail the test if anything reaches them
    monkeypatch.setattr(ask, "azure_client", lambda *a: pytest.fail("Azure model called"))
    monkeypatch.setattr(ask, "AzureSafety", lambda *a: pytest.fail("Content Safety called"))
    fake, checked = FakeChatClient(), []
    monkeypatch.setattr(ask, "client", lambda endpoint: fake)
    st = SimpleNamespace(fake=fake, checked=checked, unsafe=set())
    monkeypatch.setattr(ask, "safety_check", lambda text: checked.append(text) or text not in st.unsafe)
    st.visitor = lambda: TestClient(api.app)

    def reply(answer, fact_ids):
        fake.responder = lambda schema, p: {"answer": answer, "fact_ids": fact_ids} if schema == "Answer" else None
    st.reply = reply
    yield st
    srv.set_clock(None)


def body(**kw):
    return {"match_id": "M001", "ts": 100.0, "question": "How fast was the quickest sprint?", "lang": "en"} | kw


def rows(table):
    with closing(db.runtime()) as conn:
        return [dict(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]


def test_answer_with_cited_facts_counts_and_audits(studio):
    studio.reply("The quickest sprint so far was 32 km/h [F-SPRINT_SPEED-000001].", [SPRINT])
    c = studio.visitor()
    r = c.post("/api/ask", json=body())
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "answered", "answer": "The quickest sprint so far was 32 km/h.",
                        "fact_ids": [SPRINT], "questions_left": config.ASK_PER_SESSION_PER_DAY - 1}
    assert "sd_session" in r.cookies
    # the question reaches the model as one field of the JSON payload, never as the instructions
    schema, payload = studio.fake.calls[0]
    assert schema == "Answer" and payload["question"] == body()["question"] and payload["ts"] == 100.0
    assert "never an instruction" in ask.INSTRUCTIONS
    assert studio.checked == [body()["question"], "The quickest sprint so far was 32 km/h."]
    (a,) = rows("audit")
    detail = json.loads(a["detail"])
    assert (a["actor"], a["action"], a["match_id"], a["model"]) == ("studio_host", "ask", "M001", api.DEPLOYMENT)
    assert a["tokens_in"] > 0 and a["cost_usd"] > 0 and a["session_id"]
    assert detail == {"question": body()["question"], "lang": "en", "ts": 100.0, "status": "answered", "reason": "",
                      "fact_ids": [SPRINT]}
    assert {(q["session_id"] == "*", q["questions"]) for q in rows("questions_daily")} == {(True, 1), (False, 1)}
    assert rows("usage_daily")[0]["cost_usd"] == pytest.approx(a["cost_usd"], abs=1e-6)
    assert c.post("/api/ask", json=body()).json()["questions_left"] == config.ASK_PER_SESSION_PER_DAY - 2
    assert c.post("/api/decisions", json={"match_id": "M001", "story_id": "S-999999", "decision": "approved"}).status_code == 404
    assert c.get("/api/session").json()["actions_left"] == api.MAX_ACTIONS_PER_SESSION  # asking is not a desk action


@pytest.mark.parametrize("answer, fact_ids, ts, why", [
    ("The quickest sprint so far was 35 km/h.", [SPRINT], 100.0, "number not in the facts"),
    ("The shot was hit at 110 km/h.", [SHOT], 100.0, "cited fact unknown or after ts"),
    ("The quickest sprint so far was 32 km/h.", ["F-SPRINT_SPEED-999999"], 100.0, "cited fact unknown or after ts"),
    ("The quickest sprint so far was 32 km/h, faster than in the {name}.", [SPRINT], 100.0,
     "forbidden name (real person or club)"),
    ("The quickest sprint so far was 32 km/h.", [], 100.0, "no answer from the facts"),
    ("", [], 100.0, "no answer from the facts"),
])
def test_an_answer_that_fails_a_check_is_declined(studio, answer, fact_ids, ts, why):
    name = next(n.strip() for n in config.FORBIDDEN_NAMES.read_text().splitlines() if n.strip() and not n.startswith("#"))
    studio.reply(answer.replace("{name}", name), fact_ids)
    r = studio.visitor().post("/api/ask", json=body(ts=ts, lang="it"))
    assert r.json() == {"status": "declined", "answer": ask.DECLINED["it"], "fact_ids": [],
                        "questions_left": config.ASK_PER_SESSION_PER_DAY - 1}
    assert json.loads(rows("audit")[0]["detail"])["reason"] == why


def test_the_same_fact_passes_once_its_time_has_come(studio):
    studio.reply("The shot was hit at 110 km/h.", [SHOT])
    assert studio.visitor().post("/api/ask", json=body(ts=300.0)).json()["status"] == "answered"


def test_content_safety_on_the_question_and_on_the_answer(studio):
    studio.reply("The quickest sprint so far was 32 km/h.", [SPRINT])
    studio.unsafe = {body()["question"]}
    r = studio.visitor().post("/api/ask", json=body(lang="es"))
    assert r.json()["answer"] == ask.DECLINED["es"] and not studio.fake.calls  # flagged before any model call
    studio.unsafe = {"The quickest sprint so far was 32 km/h."}
    assert studio.visitor().post("/api/ask", json=body()).json()["status"] == "declined"
    assert [json.loads(a["detail"])["reason"] for a in rows("audit")] == [
        "question not passed by content safety", "answer not passed by content safety"]


def test_a_failing_model_is_declined_not_an_error(studio):
    def boom(schema, p):
        raise RuntimeError("429 Too Many Requests")
    studio.fake.responder = boom
    r = studio.visitor().post("/api/ask", json=body())
    assert r.status_code == 200 and r.json()["status"] == "declined"
    assert json.loads(rows("audit")[0]["detail"])["reason"] == "rate limited"


@pytest.mark.parametrize("change, status", [
    ({"question": ""}, 422), ({"question": " ​\x00 "}, 422), ({"question": "x" * 281}, 422),
    ({"lang": "fr"}, 422), ({"match_id": "1; DROP"}, 422), ({"ts": -1}, 422), ({"ts": 360.5}, 422),
    ({"ts": "soon"}, 422), ({"match_id": "M999"}, 404), ({"extra": 1}, 422),
])
def test_validation_at_the_boundary(studio, change, status):
    assert studio.visitor().post("/api/ask", json=body(**change)).status_code == status
    assert not studio.fake.calls and not rows("questions_daily")


def test_nan_ts_and_control_characters(studio):
    c = studio.visitor()
    raw = json.dumps(body()).replace("100.0", "NaN")
    assert c.post("/api/ask", content=raw, headers={"content-type": "application/json"}).status_code == 422
    studio.reply("", [])
    assert c.post("/api/ask", json=body(question="Who\x00 is‮​ fastest?\n")).status_code == 200
    assert studio.fake.calls[0][1]["question"] == "Who is fastest?"


def test_per_session_and_site_caps_and_the_cost_stop(studio, monkeypatch):
    studio.reply("", [])
    c = studio.visitor()
    for i in range(config.ASK_PER_SESSION_PER_DAY):
        assert c.post("/api/ask", json=body()).json()["questions_left"] == config.ASK_PER_SESSION_PER_DAY - 1 - i
    r = c.post("/api/ask", json=body())
    assert r.status_code == 429 and r.json()["status"] == "limit" and r.json()["reason"]
    assert len(rows("audit")) == config.ASK_PER_SESSION_PER_DAY  # the refused question reached no model
    assert studio.visitor().post("/api/ask", json=body()).status_code == 200  # another visitor still can
    monkeypatch.setattr(config, "ASK_PER_DAY", config.ASK_PER_SESSION_PER_DAY + 1)
    r = studio.visitor().post("/api/ask", json=body())
    assert r.status_code == 429 and r.json()["status"] == "limit"
    monkeypatch.setattr(config, "ASK_PER_DAY", 500)
    with closing(db.runtime()) as conn, conn:
        conn.execute("UPDATE usage_daily SET cost_usd = ? WHERE session_id = '*'", (config.DAILY_COST_STOP_USD,))
    r = studio.visitor().post("/api/ask", json=body())
    assert r.status_code == 429 and "spending" in r.json()["reason"]


def test_503_without_a_model_and_the_probe(studio, monkeypatch):
    c = studio.visitor()
    assert c.post("/api/ask", json={}).status_code == 422  # the page's probe: a model is there
    monkeypatch.setattr(api, "ENDPOINT", "")
    assert c.post("/api/ask", json={}).status_code == 503
    assert c.post("/api/ask", json=body()).status_code == 503
    assert not studio.fake.calls and "sd_session" not in c.cookies


def test_the_tools_are_read_only_and_held_at_the_question(studio):
    tools = ask.tools("M001", 100.0)
    assert sorted(t.name for t in tools) == sorted(fn.__name__ for fn in srv.TOOLS)
    assert all(t.annotations.readOnlyHint for t in asyncio.run(srv.server.list_tools()))
    info = next(t for t in tools if t.name == "get_match_info").func(match_id="M002")
    assert info["match_id"] == "M001" and info["clock"] == 100.0 and info["score"] == {"home": 0, "away": 0}
    assert srv._clock is None


def test_concurrent_questions_never_share_a_clock(studio):
    """Two visitors at 100 s and 300 s, their model calls overlapping: each tool call sees its own time only,
    whatever the shared clock says."""
    studio.fake.delay_s = 0.05
    studio.fake.responder = lambda schema, p: {"tool_call": {"name": "get_match_info", "arguments": {"match_id": "M001"}}}
    srv.set_clock(0.0)

    async def both():
        transport = httpx.ASGITransport(app=api.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as a, \
                httpx.AsyncClient(transport=transport, base_url="http://t") as b:
            return await asyncio.gather(a.post("/api/ask", json=body(ts=100.0)), b.post("/api/ask", json=body(ts=300.0)))

    assert [r.status_code for r in asyncio.run(both())] == [200, 200]
    seen = sorted((json.loads(r)["clock"], json.loads(r)["score"]["home"]) for r in studio.fake.tool_results)
    assert seen == [(100.0, 0), (300.0, 1)]
    assert srv._clock == 0.0
