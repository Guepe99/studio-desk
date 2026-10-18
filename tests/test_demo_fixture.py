import importlib.util
import json
import re
from pathlib import Path

import numpy as np

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "make_demo_fixture.py"


def test_demo_fixture_matches_export_shapes(tmp_path):
    spec = importlib.util.spec_from_file_location("make_demo_fixture", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    out = mod.main(tmp_path)  # the script asserts names, cue overlap and tracking shape itself

    meta = json.loads((out / "meta.json").read_text())
    assert meta["entities"][0] == "ball"
    assert {t["side"] for t in meta["teams"]} == {"home", "away"}
    pos = np.fromfile(out / "tracking.f32", "<f4").reshape(meta["frames"], len(meta["entities"]), 3)
    assert meta["frames"] == round((meta["period1_s"] + meta["period2_s"]) * meta["fps"])
    assert np.isfinite(pos[:, 0]).all()

    events = json.loads((out / "events.json").read_text())
    goals = [e for e in events if e["type_name"] == "shot" and e["result_name"] == "success"]
    assert len(goals) == meta["home_score"] + meta["away_score"]

    cues = json.loads((out / "cues.json").read_text())
    assert {c["graphic"] for c in cues} == {"nameplate", "pass_shot", "momentum", "why_card"}
    assert {c["audience"] for c in cues} == {"analyst", "casual"}
    fact_ids = {f["fact_id"] for f in json.loads((out / "facts.json").read_text())}
    for c in cues:
        p = c["payload"]
        assert set(p.get("fact_ids", [p.get("fact_id")])) <= fact_ids
    for name in ("events", "facts", "cues"):
        rows = json.loads((out / f"{name}.json").read_text())
        assert [r["ts"] for r in rows] == sorted(r["ts"] for r in rows)


def _backed(number, cited):
    """True when `number` (as printed) is the value of a cited fact, in its unit or in km for metres."""
    decimals = len(number.split(".")[1]) if "." in number else 0
    for f in cited:
        for v in (f["value"], f["value"] / 1000 if f["unit"] == "m" else None):
            if v is not None and f"{v:.{decimals}f}" == number:
                return True
    return False


def test_demo_fixture_shows_only_fact_values(tmp_path):
    spec = importlib.util.spec_from_file_location("make_demo_fixture", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    out = mod.main(tmp_path)
    facts = {f["fact_id"]: f for f in json.loads((out / "facts.json").read_text())}
    for c in json.loads((out / "cues.json").read_text()):
        p = c["payload"]
        cited = [facts[i] for i in p.get("fact_ids", [p.get("fact_id")])]
        for field in ("title", "body", "quality"):
            text = p.get(field)
            if not isinstance(text, str):
                continue
            # a score line "NBR 1-0 EVA" shows 0 for a team without a goal: there is no fact for it
            # and "/10" is the scale of a difficulty, not a value
            text = re.sub(r"(?<=\d)-0\b|\b0(?=-\d)|/10\b", "", text)
            for number in re.findall(r"\d+(?:\.\d+)?", text):
                assert _backed(number, cited), f"{c['cue_id']} {field}: {number} is not a cited fact value in {text!r}"
