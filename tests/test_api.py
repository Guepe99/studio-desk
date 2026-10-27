import hashlib
import json
import os

import pytest
from fastapi.testclient import TestClient

from studiodesk import api


def test_health_and_model_ping_is_closed_to_visitors(monkeypatch):
    monkeypatch.setattr(api, "ENDPOINT", "")  # a broken check must never reach a paid model
    monkeypatch.setattr(api.httpx, "post", lambda *a, **k: pytest.fail("model called"))
    client = TestClient(api.app)
    assert client.get("/api/health").json()["ok"] is True
    assert client.post("/api/admin/model-ping").status_code == 403
    monkeypatch.setattr(api, "ADMIN_TOKEN", "s3cret")
    assert client.post("/api/admin/model-ping", headers={"x-admin-token": "wrong"}).status_code == 403
    assert client.post("/api/admin/model-ping", headers={"x-admin-token": "café".encode("latin-1")}).status_code == 403
    assert client.get("/openapi.json").status_code == 404 and client.get("/docs").status_code == 404
    assert client.get("/api/health").headers["x-content-type-options"] == "nosniff"



def test_static_files_are_gzipped():
    r = TestClient(api.app).get("/index.html", headers={"accept-encoding": "gzip"})
    assert r.status_code == 200 and r.headers.get("content-encoding") == "gzip"


def test_precompressed_file_is_served_when_present(tmp_path):
    import gzip
    raw = bytes(range(256)) * 64
    (tmp_path / "t.f32").write_bytes(raw)
    (tmp_path / "t.f32.gz").write_bytes(gzip.compress(raw))
    from fastapi import FastAPI
    app = FastAPI()
    app.mount("/", api.PrecompressedStatic(directory=tmp_path))
    client = TestClient(app)
    r = client.get("/t.f32", headers={"accept-encoding": "gzip"})
    assert r.headers["content-encoding"] == "gzip" and r.content == raw
    assert client.get("/t.f32", headers={"accept-encoding": "identity"}).content == raw
    (tmp_path / "lib.js.gz").write_bytes(gzip.compress(b"var x = 1;"))
    assert "javascript" in client.get("/lib.js", headers={"accept-encoding": "gzip"}).headers["content-type"]
    assert "gzip" not in client.get("/t.f32", headers={"accept-encoding": "gzip;q=0"}).headers.get("content-encoding", "")
    etag = r.headers["etag"]
    assert client.get("/t.f32", headers={"accept-encoding": "gzip", "if-none-match": etag}).status_code == 304
    assert client.post("/t.f32", headers={"accept-encoding": "gzip"}).status_code == 405
    assert client.get("/t.f32").headers["vary"] == "Accept-Encoding"
    for enc in ("gzip", "identity"):  # pages, scripts and data change with each deploy: always asked again
        assert client.get("/t.f32", headers={"accept-encoding": enc}).headers["cache-control"] == "no-cache"
    (tmp_path / "vendor" / "lib" / "1.2.3").mkdir(parents=True)
    (tmp_path / "vendor" / "lib" / "1.2.3" / "lib.js").write_bytes(b"var x = 1;")
    (tmp_path / "vendor" / "lib" / "1.2.3" / "lib.js.gz").write_bytes(gzip.compress(b"var x = 1;"))
    for enc in ("gzip", "identity"):
        assert "immutable" in client.get("/vendor/lib/1.2.3/lib.js", headers={"accept-encoding": enc}).headers["cache-control"]


def test_gz_lookup_stays_inside_the_directory(tmp_path):
    import gzip
    (tmp_path / "secret.db.gz").write_bytes(gzip.compress(b"secret"))
    (tmp_path / "web").mkdir()
    static = api.PrecompressedStatic(directory=tmp_path / "web")
    scope = {"type": "http", "method": "GET", "headers": [(b"accept-encoding", b"gzip")]}
    import asyncio
    from starlette.exceptions import HTTPException
    with pytest.raises(HTTPException):
        asyncio.run(static.get_response("../secret.db", scope))


# --- control desk: sessions, decisions, kill switch, audit -----------------------------------------

DEMO_META = {"match_id": "DEMO", "period1_s": 2700.0, "home_score": 0, "away_score": 0,
             "teams": [{"team_id": "T01", "name": "Home FC", "side": "home"}, {"team_id": "T02", "name": "Away FC", "side": "away"}],
             "players": [{"player_id": "T02-9", "team_id": "T02", "name": "Tariq Duarte"}]}
DEMO_SHOT = {"fact_id": "F-SHOT_SPEED-000001", "kind": "shot_speed", "ts": 470.6, "period": 1, "team_id": "T02",
             "player_id": "T02-9", "value": 67.2, "unit": "km/h", "label_en": "Shot speed 67.2 km/h", "source_event_ids": [150]}


PROPOSALS = {"en": "A line by the AI", "es": "Una línea", "it": "Una riga"}


@pytest.fixture
def desk(tmp_path, monkeypatch):
    """A client per visitor against an empty runtime.sqlite and a replay with two stories."""
    from studiodesk import config
    monkeypatch.setattr(config, "RUNTIME_DB", tmp_path / "runtime.sqlite")
    demo = tmp_path / "web" / "data" / "DEMO"
    demo.mkdir(parents=True)
    (demo / "stories.json").write_text(json.dumps([{"story_id": "S-000001", "ts": 470.6, "fact_ids": ["F-SHOT_SPEED-000001"]},
                                                   {"story_id": "S-000002", "ts": 900.0, "fact_ids": [], "verifier": {"proposals": PROPOSALS}}]))
    (demo / "meta.json").write_text(json.dumps(DEMO_META))
    (demo / "facts.json").write_text(json.dumps([DEMO_SHOT]))
    monkeypatch.setattr(api, "WEB", tmp_path / "web")
    monkeypatch.setattr(api, "SAFETY_ENDPOINT", "")
    monkeypatch.setattr(api, "_new_sessions", {"day": "", "by_client": {}})
    monkeypatch.setattr(api, "_edit_checks", {"day": "", "all": 0, "by_client": {}})
    monkeypatch.setattr(api, "_decision_events", {"day": "", "all": 0, "by_client": {}})
    return lambda: TestClient(api.app)


def test_session_is_created_by_the_first_post_with_an_http_only_cookie(desk):
    c = desk()
    r = c.get("/api/session")
    assert r.status_code == 200 and r.json() == {"kill_switch": False, "actions_left": api.MAX_ACTIONS_PER_SESSION}
    assert "set-cookie" not in r.headers  # a GET never creates a session
    r = c.post("/api/kill", json={"on": False})
    cookie = r.headers["set-cookie"].lower()
    assert "sd_session=" in cookie and "httponly" in cookie and "samesite=lax" in cookie and "secure" not in cookie
    assert c.get("/api/session").json()["actions_left"] == api.MAX_ACTIONS_PER_SESSION - 1
    assert "set-cookie" not in c.post("/api/kill", json={"on": False}).headers  # the same visitor keeps the session
    for proto in ["https", "https,http", "HTTPS"]:
        tls = desk().post("/api/kill", json={"on": False}, headers={"x-forwarded-proto": proto})
        assert "secure" in tls.headers["set-cookie"].lower(), proto
    plain = desk().post("/api/kill", json={"on": False}, headers={"x-forwarded-proto": "http,https"})
    assert "secure" not in plain.headers["set-cookie"].lower()
    assert "session_id" not in r.json()  # the id stays in the HttpOnly cookie


def test_decisions_are_per_visitor(desk):
    a, b = desk(), desk()
    assert a.post("/api/decisions", json={"match_id": "DEMO", "story_id": "S-000001", "decision": "approved"}).status_code == 200
    r = a.post("/api/decisions", json={"match_id": "DEMO", "story_id": "S-000002", "decision": "edited",
                                       "edited_text": {"it": "  Testo nuovo  ", "en": "New text"}})
    assert r.status_code == 200 and r.json()["edited_text"] == {"it": "Testo nuovo", "en": "New text"}
    mine = a.get("/api/decisions", params={"match_id": "DEMO"}).json()
    assert {d["story_id"]: d["decision"] for d in mine["decisions"]} == {"S-000001": "approved", "S-000002": "edited"}
    assert mine["decisions"][1]["edited_text"]["it"] == "Testo nuovo"
    # the other visitor sees a clean replay, before and after having a session of their own
    assert b.get("/api/decisions", params={"match_id": "DEMO"}).json()["decisions"] == []
    b.post("/api/decisions", json={"match_id": "DEMO", "story_id": "S-000001", "decision": "rejected"})
    assert [d["decision"] for d in b.get("/api/decisions", params={"match_id": "DEMO"}).json()["decisions"]] == ["rejected"]
    assert a.get("/api/decisions", params={"match_id": "DEMO"}).json()["decisions"][0]["decision"] == "approved"
    # a later decision replaces the earlier one, and approving drops the edit
    a.post("/api/decisions", json={"match_id": "DEMO", "story_id": "S-000002", "decision": "approved"})
    d2 = a.get("/api/decisions", params={"match_id": "DEMO"}).json()["decisions"][1]
    assert d2["decision"] == "approved" and d2["edited_text"] is None


def test_an_edit_can_change_the_headline(desk):
    c = desk()
    r = c.post("/api/decisions", json={"match_id": "DEMO", "story_id": "S-000001", "decision": "edited",
                                       "edited_text": {"title_es": " Titular nuevo ", "es": "Texto"}})
    assert r.status_code == 200 and r.json()["edited_text"] == {"title_es": "Titular nuevo", "es": "Texto"}
    row = [x for x in c.get("/api/audit", params={"match_id": "DEMO"}).json()["rows"] if x["actor"] == "human"][0]
    assert row["detail"]["langs"] == ["es"] and set(row["detail"]["sha1"]) == {"title_es", "es"}
    title_only = {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"title_en": "x" * 80}}
    assert c.post("/api/decisions", json=title_only).status_code == 200


def _edit(c, text, story="S-000001"):
    return c.post("/api/decisions", json={"match_id": "DEMO", "story_id": story, "decision": "edited", "edited_text": text})


def test_an_edit_meets_the_checks_the_agents_drafts_meet(desk):
    c = desk()
    ok = _edit(c, {"en": "Duarte hits it at 67.2 km/h in the 8th minute (F-SHOT_SPEED-000001).", "title_it": "Duarte, 67,2 km/h"})
    assert ok.status_code == 200
    for text, why in [({"it": "Duarte calcia a 35 km/h."}, "the Italian text has a number the facts do not give (35 km/h)"),
                      ({"title_en": "Three shots in a row"}, "the English headline has a number written in words"),
                      ({"es": "Como en la Premier League."}, "the Spanish text has a real person's or club's name"),
                      ({"en": "See F-SCORE-000001."}, "the English text has a fact from another moment of the match"),
                      ({"en": "A 67.2 km/h shot."}, None)]:
        r = _edit(c, text, "S-000002" if why and "another" in why else "S-000001")
        if why is None:
            assert r.status_code == 200, r.json()
            continue
        assert r.status_code == 422 and r.json()["detail"].startswith(why) and r.json()["detail"].endswith("It stays off air."), r.json()
    # a refused edit is never on air: the story keeps the last decision that passed, and the audit says why
    mine = {d["story_id"]: d for d in c.get("/api/decisions", params={"match_id": "DEMO"}).json()["decisions"]}
    assert mine["S-000001"]["edited_text"] == {"en": "A 67.2 km/h shot."} and "S-000002" not in mine
    rows = [r for r in c.get("/api/audit", params={"match_id": "DEMO"}).json()["rows"] if r["actor"] == "human"]
    refused = [r for r in rows if r["action"] == "edit_refused"]
    assert len(refused) == 4 and refused[-1]["detail"]["langs"] == ["it"] and "35 km/h" in refused[-1]["detail"]["reason"]
    assert c.get("/api/session").json()["actions_left"] == api.MAX_ACTIONS_PER_SESSION - 6  # refused edits count too


def test_a_refused_first_edit_still_gets_its_session_cookie(desk):
    c = desk()
    r = _edit(c, {"en": "35 km/h."})
    assert r.status_code == 422 and "sd_session=" in r.headers["set-cookie"]
    assert c.get("/api/session").json()["actions_left"] == api.MAX_ACTIONS_PER_SESSION - 1


def test_an_edit_the_desk_cannot_check_stays_off_air(desk, tmp_path):
    (tmp_path / "web" / "data" / "DEMO" / "facts.json").write_text("[]")
    r = _edit(desk(), {"en": "New text"})
    assert r.status_code == 422 and r.json()["detail"].startswith("the facts of this story could not be read")
    (tmp_path / "web" / "data" / "DEMO" / "meta.json").unlink()
    assert _edit(desk(), {"en": "New text"}, "S-000002").json()["detail"].startswith("the match data could not be read")
    assert _edit(desk(), {"en": "x"}, "S-000009").status_code == 404


def test_an_edit_goes_through_content_safety_when_the_site_has_it(desk, monkeypatch):
    from studiodesk.agents import safety
    seen = []

    class Fake:
        def __init__(self, endpoint, timeout):
            assert endpoint == "https://cs.example"

        def __call__(self, text):
            seen.append(text)
            if "boom" in text:
                raise OSError("network")
            if "empty" in text:
                return {}
            # a match headline: football words read as violence at the lowest severity, 2
            return {"Hate": 4 if "nasty" in text else 0, "Violence": 6 if "gore" in text else 2 if "close range" in text else 0}

    monkeypatch.setattr(safety, "AzureSafety", Fake)
    c = desk()
    assert _edit(c, {"en": "New text"}).status_code == 200  # not configured: no call
    assert seen == []
    monkeypatch.setattr(api, "SAFETY_ENDPOINT", "https://cs.example")
    monkeypatch.setattr(api, "_edit_safety", None)
    monkeypatch.setattr(api, "EDIT_CHECKS_PER_CLIENT_PER_DAY", 10)  # this test is about the checks, not the cap
    assert _edit(c, {"en": "Kind words", "title_en": "Headline"}).status_code == 200 and seen == ["Kind words\nHeadline"]
    r = _edit(c, {"en": "nasty words"})
    assert r.status_code == 422 and r.json()["detail"] == "content safety flagged the text for hate (severity 4). It stays off air."
    assert _edit(c, {"en": "nasty gore"}).json()["detail"].startswith("content safety flagged the text for hate and violence (severity 6)")
    assert _edit(c, {"en": "empty"}).json()["detail"] == "content safety did not pass the text. It stays off air."
    assert _edit(c, {"title_en": "Duarte heads wide from close range"}).status_code == 200  # severity 2 passes an edit
    assert safety.verdict({"Violence": 2}) == "flagged"  # and still holds an agents' draft
    assert _edit(c, {"en": "boom"}).json()["detail"].startswith("the content safety check could not run")
    assert _edit(c, {"en": "35 km/h"}).json()["detail"].startswith("the English text has a number") and len(seen) == 6
    assert c.get("/api/decisions", params={"match_id": "DEMO"}).json()["decisions"][0]["edited_text"] == {
        "title_en": "Duarte heads wide from close range"}


def test_undo_drops_only_this_visitors_decision(desk):
    a, b = desk(), desk()
    for c in (a, b):
        c.post("/api/decisions", json={"match_id": "DEMO", "story_id": "S-000001", "decision": "rejected"})
    left = a.get("/api/session").json()["actions_left"]
    r = a.delete("/api/decisions", params={"match_id": "DEMO", "story_id": "S-000001"})
    assert r.status_code == 200 and r.json()["decision"] is None
    assert a.get("/api/decisions", params={"match_id": "DEMO"}).json()["decisions"] == []
    assert [d["decision"] for d in b.get("/api/decisions", params={"match_id": "DEMO"}).json()["decisions"]] == ["rejected"]
    assert a.get("/api/session").json()["actions_left"] == left - 1
    assert [x["action"] for x in a.get("/api/audit", params={"match_id": "DEMO"}).json()["rows"] if x["actor"] == "human"][:2] == ["undo", "rejected"]
    assert a.delete("/api/decisions", params={"match_id": "DEMO", "story_id": "S-999999"}).status_code == 404
    assert a.delete("/api/decisions", params={"match_id": "DEMO", "story_id": "S-1"}).status_code == 422


@pytest.mark.parametrize("body", [
    {"match_id": "M1", "story_id": "S-000001", "decision": "approved"},
    {"match_id": "DEMO", "story_id": "S-1", "decision": "approved"},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "published"},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited"},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {}},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"fr": "Bonjour"}},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"en": "x" * 601}},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"en": "   "}},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"en": "a\x00b"}},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"en": "a\tb"}},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"en": "a\u0085b"}},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"en": "a​b"}},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"it": "a‮b"}},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"es": "a⁧b"}},
    *({"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"en": f"a{c}b"}}
      for c in "  ﻿⁠؜­᠎"),  # separators, BOM, word joiner, Arabic mark, soft hyphen
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "approved", "edited_text": {"en": "x"}},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"title_en": "x" * 81}},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"title_it": "due\nrighe"}},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"title_fr": "Titre"}},
    {"match_id": "DEMO", "story_id": "S-000001", "decision": "approved", "session_id": "someone"},
])
def test_decision_validation(desk, body):
    assert desk().post("/api/decisions", json=body).status_code == 422


def test_unknown_story_oversized_body_and_bad_query(desk):
    c = desk()
    assert c.post("/api/decisions", json={"match_id": "DEMO", "story_id": "S-999999", "decision": "approved"}).status_code == 404
    assert c.post("/api/decisions", json={"match_id": "M002", "story_id": "S-000001", "decision": "approved"}).status_code == 404
    big = {"match_id": "DEMO", "story_id": "S-000001", "decision": "approved", "pad": "x" * 20000}
    assert c.post("/api/decisions", json=big).status_code == 413
    assert c.get("/api/decisions", params={"match_id": "../etc"}).status_code == 422
    assert c.post("/api/kill", json={"on": "yes"}).status_code == 422
    assert c.post("/api/live").status_code == 501


def test_chunked_body_is_capped_and_errors_carry_the_security_headers(desk):
    c = desk()
    chunks = (b"x" * 4096 for _ in range(1280))  # 5 MB with no Content-Length
    r = c.post("/api/decisions", content=chunks, headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.headers["content-security-policy"].startswith("default-src 'self'")
    r = c.post("/api/decisions", json={"pad": "x" * 20000})
    assert r.status_code == 413 and r.headers["x-content-type-options"] == "nosniff"
    small = (b for b in [b'{"match_id": "DEMO", ', b'"story_id": "S-000001", "decision": "approved"}'])
    assert c.post("/api/decisions", content=small, headers={"content-type": "application/json"}).status_code == 200


def test_non_numeric_content_length_is_a_400():
    import asyncio
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"{}", "more_body": False}

    async def send(message):
        sent.append(message)

    async def app(scope, receive, send):
        pytest.fail("reached the app")

    scope = {"type": "http", "method": "POST", "path": "/api/kill", "headers": [(b"content-length", b"abc")]}
    asyncio.run(api.BodyCap(app)(scope, receive, send))
    assert sent[0]["status"] == 400


def test_using_the_ai_proposal_has_its_own_audit_action(desk):
    c = desk()
    assert _edit(c, dict(PROPOSALS), "S-000002").json()["edited_text"] == PROPOSALS
    assert c.get("/api/decisions", params={"match_id": "DEMO"}).json()["decisions"][0]["decision"] == "edited"  # on air as an edit
    _edit(c, {**PROPOSALS, "en": "A line by the producer"}, "S-000002")
    rows = [r for r in c.get("/api/audit", params={"match_id": "DEMO"}).json()["rows"] if r["actor"] == "human"]
    assert [r["action"] for r in rows] == ["edited", "used_proposal"]
    assert rows[1]["detail"]["langs"] == ["en", "es", "it"]


def test_kill_switch_is_per_session_and_audited(desk):
    a, b = desk(), desk()
    assert a.post("/api/kill", json={"on": True}).json() == {"kill_switch": True}
    assert a.get("/api/decisions", params={"match_id": "DEMO"}).json()["kill_switch"] is True
    assert a.get("/api/session").json()["kill_switch"] is True
    assert b.get("/api/session").json()["kill_switch"] is False
    a.post("/api/kill", json={"on": False})
    assert [r["action"] for r in a.get("/api/audit", params={"match_id": "DEMO"}).json()["rows"]] == ["ai_on", "ai_off"]


def test_audit_rows_for_decisions_and_agents(desk):
    from studiodesk import db
    a, b = desk(), desk()
    a.post("/api/decisions", json={"match_id": "DEMO", "story_id": "S-000001", "decision": "rejected"})
    a.post("/api/decisions", json={"match_id": "DEMO", "story_id": "S-000002", "decision": "edited", "edited_text": {"es": "Hola"}})
    b.post("/api/decisions", json={"match_id": "DEMO", "story_id": "S-000002", "decision": "approved"})
    conn = db.runtime()
    with conn:
        conn.execute("INSERT INTO audit (session_id, at, actor, action, match_id, story_id, model, tokens_in, tokens_out, cost_usd) "
                     "VALUES (NULL, '2026-10-19T10:00:00+00:00', 'commentator', 'write', 'DEMO', 'S-000002', 'gpt-5-mini', 900, 120, 0.000465)")
    rows = conn.execute("SELECT session_id, actor, action, story_id FROM audit WHERE actor = 'human'").fetchall()
    conn.close()
    assert len(rows) == 3 and all(r["session_id"] for r in rows)
    mine = a.get("/api/audit", params={"match_id": "DEMO"}).json()["rows"]
    assert [(r["actor"], r["action"], r["story_id"]) for r in mine] == [
        ("commentator", "write", "S-000002"), ("human", "edited", "S-000002"), ("human", "rejected", "S-000001")]
    sha = hashlib.sha1("Hola".encode()).hexdigest()  # the audit can tell which text went on air
    assert mine[1]["detail"] == {"langs": ["es"], "sha1": {"es": sha}} and mine[2]["detail"] == {"langs": []}
    assert "session_id" not in mine[0]
    assert len(desk().get("/api/audit", params={"match_id": "DEMO"}).json()["rows"]) == 1  # no session: agents only


def test_caps(desk, monkeypatch):
    monkeypatch.setattr(api, "MAX_ACTIONS_PER_SESSION", 2)
    c = desk()
    body = {"match_id": "DEMO", "story_id": "S-000001", "decision": "approved"}
    assert [c.post("/api/decisions", json=body).status_code for _ in range(3)] == [200, 200, 429]
    assert c.post("/api/kill", json={"on": True}).status_code == 429
    monkeypatch.setattr(api, "MAX_NEW_SESSIONS_PER_DAY", 2)  # one session exists already
    assert all(desk().get("/api/session").status_code == 200 for _ in range(5))  # cookieless GETs create nothing
    assert desk().post("/api/kill", json={"on": True}).status_code == 200
    r = desk().post("/api/kill", json={"on": True})
    assert r.status_code == 429 and "too many new sessions" in r.json()["detail"]
    assert desk().get("/api/session").status_code == 200  # reading still works for a new visitor
    assert c.get("/api/session").status_code == 200  # an existing visitor is never locked out


def test_new_sessions_are_capped_per_client(desk, monkeypatch):
    monkeypatch.setattr(api, "MAX_NEW_SESSIONS_PER_CLIENT", 2)
    post = lambda fwd: desk().post("/api/kill", json={"on": False}, headers={"x-forwarded-for": fwd}).status_code  # noqa: E731
    # the ingress appends the address it saw: a forged first entry does not buy a new slot
    assert [post(f"{i}.0.0.1, 203.0.113.7") for i in range(3)] == [200, 200, 429]
    assert post("198.51.100.2") == 200  # another visitor is not locked out
    c = desk()
    assert c.post("/api/kill", json={"on": True}).status_code == 200  # no header: the client host counts
    assert c.post("/api/kill", json={"on": False}).status_code == 200  # an existing session never counts again


def test_server_error_carries_the_security_headers(desk, monkeypatch):
    import sqlite3

    def locked():
        raise sqlite3.OperationalError("database is locked")
    monkeypatch.setattr(api.db, "runtime", locked)
    r = desk().get("/api/session")
    assert r.status_code == 500 and r.json() == {"detail": "internal error"}
    assert r.headers["content-security-policy"] == api.CSP and "camera=()" in r.headers["permissions-policy"]
    assert "blob:" not in api.CSP.split("script-src")[1].split(";")[0]  # blobs only for workers
    assert "frame-ancestors 'self'" in api.CSP  # the multiviewer frames its own pages, no other site may


def test_schema_runs_once_per_version(tmp_path):
    from studiodesk import db
    path = tmp_path / "rt.sqlite"
    conn = db.connect(path)
    assert {"audit_session"} <= {r["name"] for r in conn.execute("PRAGMA index_list(audit)")}
    assert "sessions_created" in {r["name"] for r in conn.execute("PRAGMA index_list(sessions)")}
    conn.execute("DROP INDEX sessions_created")
    conn.close()
    conn = db.connect(path)  # same schema version: not run again, so the dropped index stays dropped
    assert "sessions_created" not in {r["name"] for r in conn.execute("PRAGMA index_list(sessions)")}
    conn.execute("PRAGMA user_version = 0")  # an older schema.sql: it runs again
    conn.close()
    conn = db.connect(path)
    assert "sessions_created" in {r["name"] for r in conn.execute("PRAGMA index_list(sessions)")}
    conn.close()


def test_audit_lists_the_risk_rule_approvals(desk, tmp_path):
    demo = tmp_path / "web" / "data" / "DEMO"
    (demo / "stories.json").write_text(json.dumps([
        {"story_id": "S-000001", "default_status": "auto_approved", "risk": 0.2, "safety": "passed"},
        {"story_id": "S-000002", "default_status": "needs_review", "risk": 0.6},
        {"story_id": "S-000003", "default_status": "auto_approved", "risk": 0.1, "safety": "flagged"}]))
    (demo / "traces.json").write_text(json.dumps([
        {"agent": "director", "at": "2026-10-19T09:00:00+00:00", "story_ids": ["S-000001", "S-000003"]}, "junk"]))
    c = desk()
    c.post("/api/decisions", json={"match_id": "DEMO", "story_id": "S-000001", "decision": "rejected"})
    rows = c.get("/api/audit", params={"match_id": "DEMO"}).json()["rows"]
    assert [(r["actor"], r["action"], r["story_id"]) for r in rows] == [("human", "rejected", "S-000001"), ("auto", "auto_approved", "S-000001")]
    assert rows[1]["at"] == "2026-10-19T09:00:00+00:00" and rows[1]["detail"] == {"risk": 0.2}
    seen = (demo / "stories.json").stat().st_mtime_ns
    (demo / "stories.json").write_text("not json")
    # the replay cache is keyed on the mtime: on a coarse clock the rewrite could keep it, so move it on
    os.utime(demo / "stories.json", ns=(seen, seen + 1_000_000_000))
    assert desk().get("/api/audit", params={"match_id": "DEMO"}).json()["rows"] == []


def test_matches_lists_exports(desk, tmp_path):
    meta = {"match_id": "DEMO", "home_score": 1, "away_score": 1,
            "teams": [{"side": "home", "name": "Home FC"}, {"side": "away", "name": "Away FC"}]}
    (tmp_path / "web" / "data" / "DEMO" / "meta.json").write_text(json.dumps(meta))
    (tmp_path / "web" / "data" / "junk").mkdir()
    (tmp_path / "web" / "data" / "junk" / "meta.json").write_text("{}")
    assert desk().get("/api/matches").json() == [{"match_id": "DEMO", "home": "Home FC", "away": "Away FC",
                                                  "home_score": 1, "away_score": 1}]


def test_content_safety_on_edits_is_capped_before_the_call(desk, monkeypatch):
    from studiodesk.agents import safety
    seen = []

    class Fake:
        def __init__(self, endpoint, timeout):
            pass

        def __call__(self, text):
            seen.append(text)
            return {"Hate": 0}

    monkeypatch.setattr(safety, "AzureSafety", Fake)
    monkeypatch.setattr(api, "SAFETY_ENDPOINT", "https://cs.example")
    monkeypatch.setattr(api, "_edit_safety", None)
    monkeypatch.setattr(api, "EDIT_CHECKS_PER_CLIENT_PER_DAY", 2)
    monkeypatch.setattr(api, "EDIT_CHECKS_PER_DAY", 3)
    for _ in range(2):  # a fresh cookie each time does not reset the address's count
        assert _edit(desk(), {"en": "Kind words"}).status_code == 200
    r = _edit(desk(), {"en": "Kind words"})
    assert r.status_code == 422 and "reached today's limit" in r.json()["detail"] and len(seen) == 2
    assert _edit(desk(), {"en": "35 km/h"}).json()["detail"].startswith("the English text has a number")  # no call spent
    api._edit_checks["by_client"].clear()  # another address: the day's cap for everyone still holds
    assert _edit(desk(), {"en": "Kind words"}).status_code == 200
    assert "reached today's limit" in _edit(desk(), {"en": "Kind words"}).json()["detail"] and len(seen) == 3


def test_an_edit_with_a_lone_surrogate_is_refused_not_a_500(desk):
    raw = json.dumps({"match_id": "DEMO", "story_id": "S-000001", "decision": "edited", "edited_text": {"en": "ab"}})
    r = desk().post("/api/decisions", content=raw.replace('"ab"', '"a\\ud800b"'), headers={"content-type": "application/json"})
    assert r.status_code == 422


def test_decision_events_are_capped_per_client_and_per_day(desk, monkeypatch, caplog):
    import logging
    monkeypatch.setattr(api, "DECISION_EVENTS_PER_CLIENT_PER_DAY", 2)
    monkeypatch.setattr(api, "DECISION_EVENTS_PER_DAY", 3)
    kill = lambda c, fwd: c.post("/api/kill", json={"on": True}, headers={"x-forwarded-for": fwd}).status_code  # noqa: E731
    a, b = desk(), desk()
    with caplog.at_level(logging.INFO, logger="studiodesk.decision"):
        assert [kill(a, "203.0.113.7") for _ in range(3)] == [200] * 3  # over a cap the action still works
        assert [kill(b, "198.51.100.2") for _ in range(2)] == [200] * 2
    events = [r for r in caplog.records if r.name == "studiodesk.decision"]
    assert len(events) == 3  # two for the first address, then the day's cap
    assert len(a.get("/api/audit", params={"match_id": "DEMO"}).json()["rows"]) == 3  # every action is still audited


def test_frame_rate_counters_hold_under_concurrent_requests(monkeypatch):
    import threading
    import time
    from types import SimpleNamespace

    class Slow(dict):  # a thread switch between reading a count and writing it back, as a busy pool can make
        def get(self, *a):
            value = super().get(*a)
            time.sleep(0.001)
            return value
    monkeypatch.setattr(api, "_perf_sent", {"day": api._now()[:10], "all": 0, "by_client": Slow()})
    monkeypatch.setattr(api._perf_log, "info", lambda *a, **k: None)
    p = api.Perf(match_id="M001", fps_median=40.0, screen_w=1280, screen_h=720, dpr=1.0)
    request = SimpleNamespace(headers={"x-forwarded-for": "203.0.113.9"}, client=None)  # what _client reads
    threads = [threading.Thread(target=lambda: [api.post_perf(p, request) for _ in range(4)]) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert api._perf_sent["by_client"]["203.0.113.9"] == api.PERF_PER_CLIENT_PER_DAY == 20  # 20 sent, none lost
