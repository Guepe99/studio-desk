"""Committed AI replay packs point only at facts, events, stories and players that the seed rebuild
produces, and every string a visitor can see is clean. CI builds the seed first, so there a missing
database is a failure, not a skip."""
import json
import math
import os
import re
import unicodedata
from pathlib import Path

import pytest

from studiodesk import config, db

REPLAYS = Path(__file__).resolve().parents[1] / "replays"
PACKS = sorted(p for p in REPLAYS.glob("M*") if p.is_dir()) if REPLAYS.exists() else []
DASH = re.compile("[‒-―]")
# same rule the API applies to edited text (studiodesk/api.py): no Cc, Cf, Zl, Zp but newline
def has_control(text):
    return any(c != "\n" and unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") for c in text)


NOTE_MAX = 160


def _missing(why):
    if os.environ.get("CI"):
        pytest.fail(f"{why}: CI must build the seed before the tests")
    pytest.skip(why)


def _ids(match_id):
    if not config.MATCHES_DB.exists():
        _missing("data/matches.sqlite not built")
    conn = db.connect(config.MATCHES_DB, readonly=True)
    try:
        q = lambda sql: {r[0] for r in conn.execute(sql, (match_id,))}  # noqa: E731
        facts = q("SELECT fact_id FROM facts WHERE match_id=?")
        events = q("SELECT event_id FROM events WHERE match_id=?")
        players = q("SELECT player_id FROM lineups WHERE match_id=?")
        fresh = conn.execute("SELECT 1 FROM facts WHERE kind='formation' LIMIT 1").fetchone()
    finally:
        conn.close()
    if not facts:
        _missing(f"{match_id} not in data/matches.sqlite")
    if not fresh:
        _missing("data/matches.sqlite predates the formation facts: rebuild the facts")
    return facts, events, players


def _strings(node, path="$"):
    if isinstance(node, str):
        yield path, node
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from _strings(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _strings(v, f"{path}[{i}]")


@pytest.mark.parametrize("pack", PACKS, ids=[p.name for p in PACKS])
def test_pack_ids_exist_in_the_seed_build(pack):
    facts, events, players = _ids(pack.name)
    stories = json.loads((pack / "stories.json").read_text())
    cues = json.loads((pack / "cues.json").read_text())
    traces = json.loads((pack / "traces.json").read_text())
    assert stories and cues
    story_ids = {s["story_id"] for s in stories}
    for s in stories:
        assert set(s["fact_ids"]) <= facts, s["story_id"]
        assert set(s["evidence_event_ids"]) <= events, s["story_id"]
        assert s.get("player_id") is None or s["player_id"] in players, s["story_id"]
        assert all(len(n) <= NOTE_MAX for n in s["verifier"]["flagged"]), s["story_id"]
    for c in cues:
        p = c["payload"]
        assert set(p.get("fact_ids", [p["fact_id"]] if "fact_id" in p else [])) <= facts, c["cue_id"]
        assert c["story_id"] is None or c["story_id"] in story_ids, c["cue_id"]
        assert p.get("player_id") is None or p["player_id"] in players, c["cue_id"]
    for t in traces:
        assert set(t.get("story_ids") or []) <= story_ids, t["seq"]
        assert set(t.get("fact_ids") or []) <= facts, t["seq"]
    # every string a visitor can see: story texts, why_card bodies, verifier notes, trace summaries
    for name, data in (("stories", stories), ("cues", cues), ("traces", traces)):
        for where, text in _strings(data, name):
            assert not DASH.search(text), f"{pack.name} {where}: dash in {text!r}"
            assert not has_control(text), f"{pack.name} {where}: control character in {text!r}"


@pytest.mark.parametrize("pack", PACKS, ids=[p.name for p in PACKS])
def test_no_graphic_airs_before_the_agents_decided_on_it(pack):
    cues = json.loads((pack / "cues.json").read_text())
    first = {}
    for t in sorted(json.loads((pack / "traces.json").read_text()), key=lambda t: t["ts"]):
        for sid in t.get("story_ids") or []:
            first.setdefault(sid, t["ts"])
    early = [(c["cue_id"], c["story_id"], c["ts"], first.get(c["story_id"])) for c in cues
             if c["story_id"] and not c["ts"] >= first.get(c["story_id"], math.inf) - 1.0]
    assert not early, f"{pack.name}: {len(early)} cues before their story's first trace, e.g. {early[:3]}"


def test_a_missing_seed_fails_in_ci_and_skips_locally(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "MATCHES_DB", tmp_path / "none.sqlite")
    monkeypatch.setenv("CI", "true")
    with pytest.raises(pytest.fail.Exception):
        _ids("M001")
    monkeypatch.delenv("CI")
    with pytest.raises(pytest.skip.Exception):
        _ids("M001")
