"""POST /api/perf: the anonymous 3D frame-rate beacon. Strict types, clamped values, capped, one log line."""
import logging

import pytest
from fastapi.testclient import TestClient

from studiodesk import api

GOOD = {"match_id": "M001", "fps_median": 41.37, "renderer": "ANGLE (Intel, Mesa Intel(R) UHD Graphics)",
        "screen_w": 1280, "screen_h": 720, "dpr": 1.5}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(api, "_perf_sent", {"day": "", "all": 0, "by_client": {}})
    return TestClient(api.app)


def test_a_good_report_is_logged_once_without_address_or_agent(client, caplog):
    with caplog.at_level(logging.INFO, logger="studiodesk.perf"):
        r = client.post("/api/perf", json=GOOD, headers={"x-forwarded-for": "203.0.113.9", "user-agent": "probe/1"})
    assert r.status_code == 204
    lines = [x for x in caplog.records if x.name == "studiodesk.perf"]
    assert len(lines) == 1
    rec = lines[0]
    assert rec.perf_match_id == "M001" and rec.perf_fps_median == 41.4 and rec.perf_dpr == 1.5
    assert rec.perf_screen_w == 1280 and rec.perf_renderer.startswith("ANGLE")
    text = rec.getMessage() + repr(vars(rec))
    assert "203.0.113.9" not in text and "probe/1" not in text


@pytest.mark.parametrize("bad", [
    {"fps_median": "41"},          # a string is no number
    {"screen_w": 12.5},            # a float is no pixel count
    {"screen_w": True},            # nor is a bool
    {"dpr": "2"},
    {"match_id": "M1"},            # not a match id
    {"match_id": "../etc"},
    {"renderer": "x" * 1001},      # no renderer name is this long
    {"renderer": 7},
    {"note": "hello"},             # no free text: unknown fields are refused
])
def test_wrong_types_and_extra_fields_are_refused(client, bad):
    assert client.post("/api/perf", json={**GOOD, **bad}).status_code == 422


def test_missing_renderer_is_fine_and_out_of_range_values_are_clamped(client, caplog):
    body = {**GOOD, "fps_median": 99999.0, "screen_w": -5, "screen_h": 10**9, "dpr": 50.0}
    body.pop("renderer")
    with caplog.at_level(logging.INFO, logger="studiodesk.perf"):
        assert client.post("/api/perf", json=body).status_code == 204
        weird = {**GOOD, "fps_median": -3.0, "dpr": 0.0, "renderer": "GPUé\n\x00" + "y" * 300}
        assert client.post("/api/perf", json=weird).status_code == 204
    a, b = [x for x in caplog.records if x.name == "studiodesk.perf"]
    assert (a.perf_fps_median, a.perf_screen_w, a.perf_screen_h, a.perf_dpr, a.perf_renderer) == (1000.0, 0, 20000, 8.0, None)
    assert (b.perf_fps_median, b.perf_dpr) == (0.0, 0.25)
    assert b.perf_renderer == "GPU" + "y" * (api.PERF_RENDERER_CHARS - 3)  # printable ASCII only, then cut


def test_each_address_and_the_whole_day_are_capped(client, monkeypatch):
    me = {"x-forwarded-for": "198.51.100.1"}
    for _ in range(api.PERF_PER_CLIENT_PER_DAY):
        assert client.post("/api/perf", json=GOOD, headers=me).status_code == 204
    r = client.post("/api/perf", json=GOOD, headers=me)
    assert r.status_code == 429 and r.json()["status"] == "limit"
    assert client.post("/api/perf", json=GOOD, headers={"x-forwarded-for": "198.51.100.2"}).status_code == 204
    monkeypatch.setattr(api, "PERF_PER_DAY", api._perf_sent["all"])
    assert client.post("/api/perf", json=GOOD, headers={"x-forwarded-for": "198.51.100.3"}).status_code == 429
    api._perf_sent["day"] = "2000-01-01"  # a new UTC day opens the caps again
    assert client.post("/api/perf", json=GOOD, headers=me).status_code == 204
