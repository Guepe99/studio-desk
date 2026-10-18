from fastapi.testclient import TestClient

from studiodesk import api


def test_health_and_model_ping_is_closed_to_visitors(monkeypatch):
    client = TestClient(api.app)
    assert client.get("/api/health").json()["ok"] is True
    assert client.post("/api/admin/model-ping").status_code == 403
    monkeypatch.setattr(api, "ADMIN_TOKEN", "s3cret")
    assert client.post("/api/admin/model-ping", headers={"x-admin-token": "wrong"}).status_code == 403



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
