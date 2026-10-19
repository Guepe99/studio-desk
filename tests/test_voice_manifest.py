"""Voice manifests match the committed packs without a database: every row speaks the current
story text (text_sha1), every listed clip exists, and every clip on disk is listed."""
import hashlib
import json
from pathlib import Path

import pytest

REPLAYS = Path(__file__).resolve().parents[1] / "replays"
PACKS = sorted(p for p in REPLAYS.glob("M*") if (p / "voice.json").exists()) if REPLAYS.exists() else []


@pytest.mark.parametrize("pack", PACKS, ids=[p.name for p in PACKS])
def test_voice_manifest_matches_the_pack(pack):
    texts = {s["story_id"]: s["texts"] for s in json.loads((pack / "stories.json").read_text())}
    rows = json.loads((pack / "voice.json").read_text())
    for r in rows:
        text = texts.get(r["story_id"], {}).get(r["lang"])
        assert text is not None, f"{r['story_id']} {r['lang']}: no such story text"
        assert r["text_sha1"] == hashlib.sha1(text.encode("utf-8")).hexdigest(), f"{r['story_id']} {r['lang']}: stale clip"
        assert (pack / r["file"]).is_file(), r["file"]
    listed = {(pack / r["file"]).resolve() for r in rows}
    on_disk = {p.resolve() for p in pack.rglob("*.mp3")}
    assert on_disk <= listed, sorted(str(p.relative_to(pack.resolve())) for p in on_disk - listed)
