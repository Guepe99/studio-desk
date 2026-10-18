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
