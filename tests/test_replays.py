"""Committed AI replay packs point only at facts and events that the seed rebuild produces."""
import json
import re
from pathlib import Path

import pytest

from studiodesk import config, db

REPLAYS = Path(__file__).resolve().parents[1] / "replays"
PACKS = sorted(p for p in REPLAYS.glob("M*") if p.is_dir()) if REPLAYS.exists() else []
DASH = re.compile("[\u2012-\u2015]")


def _ids(match_id):
    if not config.MATCHES_DB.exists():
        pytest.skip("data/matches.sqlite not built")
    conn = db.connect(config.MATCHES_DB)
    try:
        facts = {r[0] for r in conn.execute("SELECT fact_id FROM facts WHERE match_id=?", (match_id,))}
        events = {r[0] for r in conn.execute("SELECT event_id FROM events WHERE match_id=?", (match_id,))}
        fresh = conn.execute("SELECT 1 FROM facts WHERE kind='formation' LIMIT 1").fetchone()
    finally:
        conn.close()
    if not facts:
        pytest.skip(f"{match_id} not in data/matches.sqlite")
    if not fresh:
        pytest.skip("data/matches.sqlite predates the formation facts: rebuild the facts")
    return facts, events


@pytest.mark.parametrize("pack", PACKS, ids=[p.name for p in PACKS])
def test_pack_ids_exist_in_the_seed_build(pack):
    facts, events = _ids(pack.name)
    stories = json.loads((pack / "stories.json").read_text())
    cues = json.loads((pack / "cues.json").read_text())
    traces = json.loads((pack / "traces.json").read_text())
    assert stories and cues
    for s in stories:
        assert set(s["fact_ids"]) <= facts, s["story_id"]
        assert set(s["evidence_event_ids"]) <= events, s["story_id"]
        for text in [*s["texts"].values(), s["analysis_en"]]:
            assert not DASH.search(text), text
        assert all(len(n) <= 161 for n in s["verifier"]["flagged"]), s["story_id"]
    for c in cues:
        p = c["payload"]
        assert set(p.get("fact_ids", [p["fact_id"]] if "fact_id" in p else [])) <= facts, c["cue_id"]
    story_ids = {s["story_id"] for s in stories}
    for t in traces:
        assert set(t.get("story_ids") or []) <= story_ids
