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
    assert {c["audience"] for c in cues} >= {"analyst", "casual", "team:T01", "team:T02"}
    assert any(c["audience"].startswith("player:") for c in cues)
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
            for number in _numbers(text):
                assert _backed(number, cited), f"{c['cue_id']} {field}: {number} is not a cited fact value in {text!r}"
    for s in json.loads((out / "stories.json").read_text()):
        for lang, text in s["texts"].items():
            for number in _numbers(text):
                assert _backed(number, [facts[i] for i in s["fact_ids"]]), f"{s['story_id']} {lang}: {number} in {text!r}"


def _numbers(text):
    # it and es write 33,8; a score line "NBR 1-0 EVA" shows 0 for a team without a goal (no fact
    # for it); "/10" is the scale of a difficulty, not a value
    text = re.sub(r"(?<=\d),(?=\d)", ".", text)
    text = re.sub(r"(?<=\d)-0\b|\b0(?=-\d)|/10\b", "", text)
    return re.findall(r"\d+(?:\.\d+)?", text)


def test_demo_stories_cues_and_traces_follow_the_contract(tmp_path):
    spec = importlib.util.spec_from_file_location("make_demo_fixture", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    out = mod.main(tmp_path)
    load = lambda name: json.loads((out / f"{name}.json").read_text())  # noqa: E731
    stories, cues, traces, events = load("stories"), load("cues"), load("traces"), load("events")
    facts = {f["fact_id"] for f in load("facts")}
    event_ids = {e["event_id"] for e in events}
    assert [s["ts"] for s in stories] == sorted(s["ts"] for s in stories)
    assert {s["default_status"] for s in stories} == {"auto_approved", "needs_review"}
    for s in stories:
        assert re.fullmatch(r"S-\d{6}", s["story_id"]) and 0 <= s["risk"] <= 1
        assert (s["default_status"] == "auto_approved") == (s["risk"] < 0.35)
        assert set(s["texts"]) == {"en", "it", "es"} and s["verifier"]["status"] in {"pass", "rewritten", "template"}
        notes = s["verifier"]["flagged"]  # plain sentences, as the agents write them (docs/CONTRACT.md)
        assert all(isinstance(n, str) and n.endswith(".") and len(n) <= 160 for n in notes) and bool(notes) == (s["verifier"]["status"] != "pass")
        assert "_drafts" not in s
        assert s["safety"] in {"passed", "flagged", "not_checked"}
        assert set(s["fact_ids"]) <= facts and set(s["evidence_event_ids"]) <= event_ids
        assert len(set(s["evidence_event_ids"])) == len(s["evidence_event_ids"])
        mine = [c for c in cues if c["story_id"] == s["story_id"]]
        assert mine and {c["lang"] for c in mine} == {"en", "it", "es"}
        chain = [t["agent"] for t in traces if t["story_id"] == s["story_id"]]
        assert chain[:3] == ["story_finder", "analyst", "commentator"] and chain[-1] == "director" and "verifier" in chain
    assert {c["story_id"] for c in cues} - {None} == {s["story_id"] for s in stories}
    assert [t["ts"] for t in traces] == sorted(t["ts"] for t in traces)
    assert [t["seq"] for t in traces] == list(range(1, len(traces) + 1))
    for t in traces:
        assert (t["model"] is None) == (t["tokens_in"] == 0) and set(t["fact_ids"]) <= facts
