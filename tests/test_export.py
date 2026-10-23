import json

import numpy as np

from studiodesk import db
from studiodesk.export import export

PAYLOAD_KEYS = {"nameplate": {"player_id", "name", "shirt", "team_short", "speed_kmh", "fact_id"},
                "pass_shot": {"mode", "player_id", "value", "unit", "quality", "fact_ids"},
                "momentum": {"home", "away", "window", "fact_ids"},
                "why_card": {"kind", "title", "body", "fact_ids"},
                "lineup": {"teams", "fact_ids"}}


def test_template_export(match_db, tmp_path):
    info, conn = match_db
    out = export("M001", conn, tmp_path / "web")
    data = {n: json.loads((out / f"{n}.json").read_text())
            for n in ("meta", "events", "facts", "stories", "cues", "traces")}
    meta = data["meta"]
    assert meta["frames"] == info["frames"] and meta["entities"][0] == "ball" and len(meta["entities"]) == 23
    assert [t["side"] for t in meta["teams"]] == ["home", "away"] and len(meta["players"]) == 22
    # the match picker's list: names, no score
    assert json.loads((tmp_path / "web" / "matches.json").read_text()) == [
        {"match_id": "M001", "home": meta["teams"][0]["name"], "away": meta["teams"][1]["name"]}]
    raw = (out / "tracking.f32").read_bytes()
    assert len(raw) == info["frames"] * info["entities"] * 3 * 4
    assert np.frombuffer(raw, "<f4").reshape(info["frames"], -1, 3)[0, 0, 2] == 0
    assert data["stories"] == [] and data["traces"] == []
    assert isinstance(data["facts"][0]["source_event_ids"], list)
    for name in ("events", "facts", "cues"):
        assert [r["ts"] for r in data[name]] == sorted(r["ts"] for r in data[name])

    cues = data["cues"]
    fact_ids = {f["fact_id"] for f in data["facts"]}
    assert {c["graphic"] for c in cues} == set(PAYLOAD_KEYS)
    assert {c["audience"] for c in cues} == {"analyst", "casual", "kids"} and {c["lang"] for c in cues} == {"en"}
    assert len({c["cue_id"] for c in cues}) == len(cues)
    for c in cues:
        assert c["story_id"] is None and set(c["payload"]) == PAYLOAD_KEYS[c["graphic"]]
        used = c["payload"].get("fact_ids") or [c["payload"]["fact_id"]]
        assert set(used) <= fact_ids
    for audience in ("analyst", "casual", "kids"):
        mine = [c for c in cues if c["audience"] == audience]
        for c in mine:
            on_screen = [d for d in mine if d["ts"] <= c["ts"] < d["ts"] + d["duration_s"]]
            assert len(on_screen) <= 2
    recap = next(c for c in cues if c["graphic"] == "why_card" and c["payload"]["title"] == "Full time")
    assert recap["payload"]["body"].startswith("HAR 1-0 MIL.")
    shot = next(c for c in cues if c["graphic"] == "pass_shot" and c["payload"]["mode"] == "shot")
    assert shot["payload"]["quality"] == "Goal"


def test_export_uses_runtime_cues_when_present(match_db, tmp_path):
    _, conn = match_db
    rt = db.connect(tmp_path / "runtime.sqlite")
    rt.execute("INSERT INTO cues VALUES ('M001','C-000001',NULL,5.0,6.0,'nameplate','casual','en',?)",
               (json.dumps({"player_id": "T01-9"}),))
    rt.commit()
    out = export("M001", conn, tmp_path / "web", rt)
    cues = json.loads((out / "cues.json").read_text())
    assert cues == [{"match_id": "M001", "cue_id": "C-000001", "story_id": None, "ts": 5.0, "duration_s": 6.0,
                     "graphic": "nameplate", "audience": "casual", "lang": "en", "payload": {"player_id": "T01-9"}},
                    {"match_id": "M001", "cue_id": "C-000002", "story_id": None, "ts": 5.0, "duration_s": 6.0,  # the kids copy
                     "graphic": "nameplate", "audience": "kids", "lang": "en", "payload": {"player_id": "T01-9"}}]
