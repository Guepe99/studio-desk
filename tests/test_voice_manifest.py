"""Voice manifests match the committed packs without a database: every row speaks the current
story text (text_sha1), every listed clip exists, and every clip on disk is listed, and each clip is in its row's language (file name, voice locale and
text). Every eligible story has a clip in each of the three languages."""
import hashlib
import json
from pathlib import Path

import pytest

REPLAYS = Path(__file__).resolve().parents[1] / "replays"
PACKS = sorted(p for p in REPLAYS.glob("M*") if (p / "voice.json").exists()) if REPLAYS.exists() else []


@pytest.mark.parametrize("pack", PACKS, ids=[p.name for p in PACKS])
def test_voice_manifest_matches_the_pack(pack):
    from studiodesk import voice
    texts = {s["story_id"]: s["texts"] for s in json.loads((pack / "stories.json").read_text())}
    rows = json.loads((pack / "voice.json").read_text())
    for r in rows:
        text = texts.get(r["story_id"], {}).get(r["lang"])
        assert text is not None, f"{r['story_id']} {r['lang']}: no such story text"
        assert r["text_sha1"] == hashlib.sha1(text.encode("utf-8")).hexdigest(), f"{r['story_id']} {r['lang']}: stale clip"
        said = hashlib.sha1(voice.spoken(text, r["lang"]).encode("utf-8")).hexdigest()
        assert r.get("spoken_sha1") == said, f"{r['story_id']} {r['lang']}: voiced before a pronunciation rule changed"
        assert (pack / r["file"]).is_file(), r["file"]
        # a clip in the wrong language: its file, voice and text must all be the row's language
        assert r["file"] == f"voice/{r['story_id']}.{r['lang']}.mp3", f"{r['file']}: not the {r['lang']} clip"
        assert r["voice"].startswith(f"{r['lang']}-"), f"{r['story_id']} {r['lang']}: voice {r['voice']}"
    listed = {(pack / r["file"]).resolve() for r in rows}
    on_disk = {p.resolve() for p in pack.rglob("*.mp3")}
    assert on_disk <= listed, sorted(str(p.relative_to(pack.resolve())) for p in on_disk - listed)


@pytest.mark.parametrize("pack", PACKS, ids=[p.name for p in PACKS])
def test_every_language_is_voiced(pack):
    from studiodesk import voice
    stories = json.loads((pack / "stories.json").read_text())
    rows = {(r["story_id"], r["lang"]) for r in json.loads((pack / "voice.json").read_text())}
    for lang in ("en", "it", "es"):
        want = {(s["story_id"], lang) for s in voice.eligible(stories, lang)}
        assert want <= rows, f"{lang}: no clip for {sorted(want - rows)[:5]}"
        extra = {r for r in rows if r[1] == lang} - want
        assert not extra, f"{lang}: clip for a story that is not eligible: {sorted(extra)[:5]}"
