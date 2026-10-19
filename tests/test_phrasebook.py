"""The phrasebook: each piece of colour only when its fact is true, every composed line passes every check
a writer's line meets, the three languages share the opener, and whole matches compose without falling
back to the template. Tests on the real facts skip when data/matches.sqlite is missing, as in test_replays."""
import re
from collections import defaultdict

import pytest
from test_story_checks import REPLAYS, REVIEWED, _packs

from studiodesk.agents import phrasebook as pb
from studiodesk.agents import rules


@pytest.fixture(scope="module", params=["frozen", "live"])
def packs(request):
    return _packs(REVIEWED if request.param == "frozen" else REPLAYS)


def _variants(m, s, spent=()):
    for opener, focus, tone in pb.variants(m, s, "lively", None, spent):
        for form in range(pb.FORMS):
            texts = {lang: pb.compose_one(m, s, lang, tone, focus, opener, form) for lang in rules.LANGS}
            if any(texts.values()):
                yield opener, form, texts


def test_every_variant_passes_every_check_in_every_language(packs):
    for mid, (m, stories) in packs.items():
        for sid, s in stories.items():
            for opener, form, texts in _variants(m, s):
                assert all(texts.values()), (mid, sid, opener, form, texts)  # a form exists in all three or none
                for lang, text in texts.items():
                    assert pb.problems(m, s, text, lang) == [], (mid, sid, lang, text)


def test_colour_only_when_its_fact_is_true(packs):
    seen = set()
    for m, stories in packs.values():
        for s in stories.values():
            ids = {o[0] for o in pb.openers(m, s)}
            seen |= ids
            speed = pb.value(s, "shot_speed") or 0.0
            assert ("hit" not in ids or speed >= 100) and ("strike" not in ids or speed >= 110)
            assert "again" not in ids or pb.earlier_goals(m, s)  # "Ancora": from a player's second goal
            assert "golazo" not in ids or (pb.value(s, "shot_distance") or 0) >= pb.GOAL_OF_THE_DAY_M
            assert not ids & pb.POWER or rules.shot_info(s)["outcome"] in ("goal", "saved")  # no "What a hit!" on a block
            for opener, form, texts in _variants(m, s):
                assert opener not in pb.POWER or "km/h" in texts["en"], texts["en"]  # the line gives the speed
                if form == 2 and s["kind"] == "big_chance":
                    assert pb.tried_before(m, s), texts["en"]  # "tries again" only after an earlier shot
                if "fastest sprint of the match" in texts["en"]:
                    before = [f["value"] for f in m.kind("sprint_speed") if f["ts"] < s["ts"] - 1e-6]
                    assert len(before) >= 3 and pb.value(s, "sprint_speed") > max(before)
    assert {"hit", "again", "save"} <= seen  # the conditions above were exercised


def test_a_condition_switches_its_colour_off(packs):
    """Positive control: lower the speed under 100 km/h and "Che botta!" goes; the first goal is not "again"."""
    m, stories = next(iter(packs.values()))
    for s in stories.values():
        ids = {o[0] for o in pb.openers(m, s)}
        if "hit" in ids or "strike" in ids:
            slow = {**s, "facts": [{**f, "value": 99.0} if f["kind"] == "shot_speed" else f for f in s["facts"]]}
            assert not {"hit", "strike"} & {o[0] for o in pb.openers(m, slow)}
        if s["kind"] == "goal" and not pb.earlier_goals(m, s):
            assert "again" not in ids


def test_the_three_languages_share_the_opener(packs):
    pieces = {o[0]: o[3] for o in pb.OPENERS}
    for m, stories in packs.values():
        for s in stories.values():
            texts, opener = pb.compose(m, s)
            if texts and pieces.get(opener):  # "again" and "comeback" are inside the line, not in front of it
                for i, lang in enumerate(rules.LANGS):
                    assert texts[lang].startswith(pieces[opener][i] + " "), (opener, texts[lang])


def test_whole_matches_compose_without_the_template(packs):
    """As the desk does it: openers once a match, openings and loud words rationed."""
    for mid, (m, stories) in packs.items():
        spent, used = set(), defaultdict(lambda: {"loud": set(), "openings": set()})
        for sid, s in sorted(stories.items(), key=lambda kv: kv[1]["ts"]):
            texts, opener = pb.compose(m, s, spent=spent, used=used)
            assert texts, (mid, sid, s["kind"])
            if opener and opener not in pb.REUSABLE:
                assert opener not in spent
                spent.add(opener)
            for lang, t in texts.items():
                used[lang]["openings"].add(rules.opening(t))
                used[lang]["loud"] |= rules.loud_words(t, lang)


def test_the_finder_choice_leads(packs):
    for m, stories in packs.values():
        for s in stories.values():
            opts = pb.focus_options(s)
            if s["kind"] == "big_chance" and "distance" in opts and "power" in opts:
                calm, _ = pb.compose(m, s, "calm", "distance")
                loud, _ = pb.compose(m, s, "lively", "power")
                assert re.search(r"\d metres", calm["en"]) and "km/h" in loud["en"]
                return
    pytest.skip("no big chance with both a distance and a speed")


def test_the_recap_airs_after_the_stories_of_its_moment():
    stories = [{"ts": 2700.0, "kind": "recap"}, {"ts": 2700.0, "kind": "momentum_swing"}, {"ts": 2600.0, "kind": "goal"}]
    assert [s["kind"] for s in sorted(stories, key=rules.air_order)] == ["goal", "momentum_swing", "recap"]
