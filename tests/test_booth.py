"""studiodesk/booth.py: the booth clip build, offline with a fake renderer (no Azure, no Kokoro)."""
import json
import re

import pytest

from studiodesk import booth, config, names

LINES = booth.load_lines()
META = {"teams": [{"team_id": "T01", "name": "Redwick Wanderers"}, {"team_id": "T02", "name": "Ostwick FC"}],
        "players": [{"player_id": "T01-9", "name": "Dan Okafor"}, {"player_id": "T02-9", "name": "Lee Okafor"},
                    {"player_id": "T02-4", "name": "Jo Marrin"}]}


class FakeRender:
    """Writes 6 kB per clip (1 s at 48 kbit/s) and records what it was asked for."""

    def __init__(self):
        self.calls = []

    def __call__(self, jobs, lang, cfg):
        self.calls.append([j["key"] for j in jobs])
        for j in jobs:
            j["path"].write_bytes(b"\0" * 6000)


def test_pieces_cut_a_template_at_its_placeholders():
    assert booth.pieces("{player}, into {receiver}.", "pbp", "en", LINES) == [
        ("name", "player", None, "."), ("text", "into"), ("name", "receiver", None, ".")]
    assert booth.pieces("That was {fact:shot_speed}!", "co", "en", LINES) == [("text", "That was"), ("fact", "shot_speed", ".")]
    assert booth.pieces("{team} against {team2}.", "pbp", "en", LINES) == [("line", "{team} against {team2}.")]
    assert booth.pieces("Okafor{player}...", "pbp", "en", LINES)[-1] == ("name", "player", None, "...")


def test_numbers_are_said_as_the_co_commentator_says_them():
    assert booth.number(101.6, "km/h", "en") == "102"
    assert booth.number(7.26, "/10", "it") == "7,3"
    assert booth.number(10450, "km", "es") == "10,5"
    assert booth.number(8.0, "/10", "en") == "8"
    assert booth.number(433, None, "en") == "4-3-3"


def test_players_sharing_a_surname_are_called_by_full_name():
    assert booth.surnames(META["players"]) == {"T01-9": "Dan Okafor", "T02-9": "Lee Okafor", "T02-4": "Marrin"}
    texts = booth.match_texts(LINES, "en", META)
    assert all(t.startswith(("Dan Okafor", "Lee Okafor", "Marrin")) or "Redwick" in t or "Ostwick" in t
               for _, t in texts.values())


def test_shared_clips_have_no_names_and_digits_only_in_fact_numbers():
    for lang in ("en", "it", "es"):
        texts = booth.shared_texts(LINES, lang)
        assert 450 < len(texts) < 600  # a fact is a number clip and a unit clip, not one clip per value and unit
        for role, t in texts.values():
            assert not names.find_forbidden(t), t
            assert not re.search(r"[{}]", t), t
            if re.search(r"\d", t):  # a fact number ("102", "7,3") or a formation ("4-3-3.")
                assert re.fullmatch(r"\d+([.,]\d)?|\d(-\d){2,3}\.?", t), t
        assert "co|kilometres an hour." in texts or lang != "en"


def test_build_renders_once_and_a_rerun_costs_nothing(tmp_path):
    fake = FakeRender()
    texts = booth.match_texts(LINES, "en", META)
    jobs = booth.build(texts, "en", tmp_path, LINES, render=fake, names_=booth.match_names("en", META), log=lambda s: None)
    assert len(jobs) == len(texts) and len(fake.calls) == 1
    doc = json.loads((tmp_path / "booth.json").read_text())
    assert {r["key"] for r in doc["clips"]} == set(texts)
    assert all(r["duration_s"] == 1.0 and (tmp_path / r["file"]).exists() for r in doc["clips"])
    assert doc["names"]["en"]["players"]["T02-4"] == "Marrin"
    # resumable: files on disk count as done, even without the manifest (a crash before it was written)
    (tmp_path / "booth.json").unlink()
    assert booth.build(texts, "en", tmp_path, LINES, render=fake, log=lambda s: None) == []
    assert len(fake.calls) == 1
    assert {r["key"] for r in json.loads((tmp_path / "booth.json").read_text())["clips"]} == set(texts)


def test_build_keeps_other_languages_and_drops_stale_rows(tmp_path):
    fake = FakeRender()
    booth.build({"pbp|Go.": ("pbp", "Go.")}, "it", tmp_path, LINES, render=fake, log=lambda s: None)
    booth.build({"pbp|Old.": ("pbp", "Old.")}, "en", tmp_path, LINES, render=fake, log=lambda s: None)
    booth.build({"pbp|New.": ("pbp", "New.")}, "en", tmp_path, LINES, render=fake, log=lambda s: None)
    rows = json.loads((tmp_path / "booth.json").read_text())["clips"]
    assert [(r["lang"], r["key"]) for r in rows] == [("en", "pbp|New."), ("it", "pbp|Go.")]


def test_a_forbidden_name_stops_the_build_before_any_synthesis(tmp_path):
    fake = FakeRender()
    with pytest.raises(ValueError, match="forbidden"):
        booth.build({"pbp|x": ("pbp", "Premier League!")}, "en", tmp_path, LINES, render=fake, log=lambda s: None)
    assert fake.calls == [] and not (tmp_path / "booth.json").exists()


def test_dry_run_counts_without_rendering(tmp_path):
    fake = FakeRender()
    jobs = booth.build(booth.shared_texts(LINES, "it"), "it", tmp_path, LINES, render=fake, dry_run=True, log=lambda s: None)
    assert jobs and fake.calls == [] and not list(tmp_path.iterdir())


@pytest.mark.parametrize("root", [config.ROOT / "web" / "booth", *sorted((config.ROOT / "replays").glob("M*/")),
                                  config.ROOT / "tests" / "web" / "booth-demo"], ids=lambda p: p.name)
def test_committed_clips_match_their_manifest(root):
    if not (root / "booth.json").exists():
        pytest.skip("no booth clips here")
    rows = json.loads((root / "booth.json").read_text())["clips"]
    listed = {(root / r["file"]).resolve() for r in rows}
    assert all(p.is_file() for p in listed)
    on_disk = {*root.glob("[a-z][a-z]/*.mp3"), *root.glob("booth/[a-z][a-z]/*.mp3")}  # not the studio voice/
    assert {p.resolve() for p in on_disk} <= listed and len(on_disk) == len(rows)  # no stale clip left behind
    assert not any(names.is_forbidden(r["text"]) for r in rows)
