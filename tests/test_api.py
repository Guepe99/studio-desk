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
    return lambda: TestClient(api.app)


def test_session_cookie_is_http_only_and_secure_behind_https(desk):
    c = desk()
    r = c.get("/api/session")
    assert r.status_code == 200 and r.json() == {"kill_switch": False, "actions_left": api.MAX_ACTIONS_PER_SESSION}
    cookie = r.headers["set-cookie"].lower()
    assert "sd_session=" in cookie and "httponly" in cookie and "samesite=lax" in cookie and "secure" not in cookie
    assert "set-cookie" not in c.get("/api/session").headers  # the same visitor keeps the session
    tls = desk().get("/api/session", headers={"x-forwarded-proto": "https"})
    assert "secure" in tls.headers["set-cookie"].lower()
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
    assert mine[1]["detail"] == {"langs": ["es"]} and "session_id" not in mine[0]
    assert len(desk().get("/api/audit", params={"match_id": "DEMO"}).json()["rows"]) == 1  # no session: agents only


def test_caps(desk, monkeypatch):
    monkeypatch.setattr(api, "MAX_ACTIONS_PER_SESSION", 2)
    c = desk()
    body = {"match_id": "DEMO", "story_id": "S-000001", "decision": "approved"}
    assert [c.post("/api/decisions", json=body).status_code for _ in range(3)] == [200, 200, 429]
    assert c.post("/api/kill", json={"on": True}).status_code == 429
    monkeypatch.setattr(api, "MAX_NEW_SESSIONS_PER_DAY", 2)  # one session exists already
    assert desk().get("/api/session").status_code == 200
    assert desk().get("/api/session").status_code == 429
    assert c.get("/api/session").status_code == 200  # an existing visitor is never locked out


def test_matches_lists_exports(desk, tmp_path):
    meta = {"match_id": "DEMO", "home_score": 1, "away_score": 1,
            "teams": [{"side": "home", "name": "Home FC"}, {"side": "away", "name": "Away FC"}]}
    (tmp_path / "web" / "data" / "DEMO" / "meta.json").write_text(json.dumps(meta))
    (tmp_path / "web" / "data" / "junk").mkdir()
    (tmp_path / "web" / "data" / "junk" / "meta.json").write_text("{}")
    assert desk().get("/api/matches").json() == [{"match_id": "DEMO", "home": "Home FC", "away": "Away FC",
                                                  "home_score": 1, "away_score": 1}]
