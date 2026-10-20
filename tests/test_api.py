import hashlib
import json

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
    assert "cache-control" not in client.get("/t.f32").headers  # data changes when a match is regenerated
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

@pytest.fixture
def desk(tmp_path, monkeypatch):
    """A client per visitor against an empty runtime.sqlite and a replay with two stories."""
    from studiodesk import config
    monkeypatch.setattr(config, "RUNTIME_DB", tmp_path / "runtime.sqlite")
    (tmp_path / "web" / "data" / "DEMO").mkdir(parents=True)
    (tmp_path / "web" / "data" / "DEMO" / "stories.json").write_text(
        json.dumps([{"story_id": "S-000001"}, {"story_id": "S-000002"}]))
    monkeypatch.setattr(api, "WEB", tmp_path / "web")
    monkeypatch.setattr(api, "_new_sessions", {"day": "", "by_client": {}})
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
    (demo / "stories.json").write_text("not json")
    assert desk().get("/api/audit", params={"match_id": "DEMO"}).json()["rows"] == []


def test_matches_lists_exports(desk, tmp_path):
    meta = {"match_id": "DEMO", "home_score": 1, "away_score": 1,
            "teams": [{"side": "home", "name": "Home FC"}, {"side": "away", "name": "Away FC"}]}
    (tmp_path / "web" / "data" / "DEMO" / "meta.json").write_text(json.dumps(meta))
    (tmp_path / "web" / "data" / "junk").mkdir()
    (tmp_path / "web" / "data" / "junk" / "meta.json").write_text("{}")
    assert desk().get("/api/matches").json() == [{"match_id": "DEMO", "home": "Home FC", "away": "Away FC",
                                                  "home_score": 1, "away_score": 1}]
