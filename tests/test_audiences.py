"""Each audience's line (studiodesk/agents/audiences.py) meets every check a writer's line meets, in every
language, for every story of the frozen and the live packs; the committed packs carry those lines in
their stories and why cards, a kids sheet and the player check-ins. Tests on the real facts skip when
data/matches.sqlite is missing, as in test_replays."""
import json
import re
from contextlib import closing

import pytest
from test_agents import SIDES
from test_story_checks import REPLAYS, REVIEWED, _packs

from studiodesk import db, export
from studiodesk import mcp_server as srv
from studiodesk.agents import audiences as au
from studiodesk.agents import phrasebook as pb
from studiodesk.agents import rules

WE = {"en": r"\b(we|us|our)\b", "it": r"\b(noi|nostr[oaie])\b", "es": r"\b(nosotros|nuestr[oa]s?)\b"}
PACK_IDS = ("M001", "M002", "M003", "M004")


@pytest.fixture(scope="module", params=["frozen", "live"])
def packs(request):
    return _packs(REVIEWED if request.param == "frozen" else REPLAYS)


def test_every_audience_line_passes_every_check(packs):
    seen = set()
    for mid, (m, stories) in packs.items():
        for sid, s in stories.items():
            lines = au.compose(m, s)
            for aud, texts in lines.items():
                assert set(texts) == set(rules.LANGS), (mid, sid, aud)
                for lang, text in texts.items():
                    assert not pb.problems(m, s, text, lang), (mid, sid, aud, lang, text, pb.problems(m, s, text, lang))
                    if aud.startswith("team:"):
                        assert not re.search(WE[lang], text, re.I), (mid, sid, aud, text)  # partisan, never "we"
                seen.add((s["kind"], aud.split(":")[0]))
            if s["kind"] in ("goal", "big_chance", "recap"):
                want = {"analyst", "casual", "kids"} | {f"team:{t}" for t in m.teams}
                want |= {f"player:{s['player_id']}"} if s["player_id"] and s["kind"] != "recap" else set()
                assert want <= set(lines), (mid, sid, sorted(want - set(lines)))
    for kind in au.LINES:
        assert {(kind, a) for a in ("analyst", "casual", "kids", "team")} <= seen, kind


def test_the_line_on_air_falls_back_to_casual_then_to_the_writers_text():
    s = {"texts": {"en": "writer"}, "texts_by_audience": {"analyst": {"en": "metrics"}, "casual": {"en": "plain"},
                                                          "team:T01": {"en": "fan"}}}
    assert au.text_for(s, "analyst", "en") == "writer"  # the line its voice clip says
    assert au.text_for(s, "team:T01", "en") == "fan"
    assert au.text_for(s, "team:T02", "en") == au.text_for(s, "kids", "en") == "plain"
    assert au.text_for({"texts": {"en": "writer"}}, "kids", "en") == "writer"


def _pack(mid):
    d = REPLAYS / mid
    return json.loads((d / "stories.json").read_text()), json.loads((d / "cues.json").read_text())


def _overlap(a, b):
    return a["ts"] < b["ts"] + b["duration_s"] and b["ts"] < a["ts"] + a["duration_s"]


def test_committed_packs_show_each_audience_its_line():
    packs = _packs(REPLAYS)
    for mid in PACK_IDS:
        stories, cues = _pack(mid)
        m, packed = packs[mid]
        by_id = {s["story_id"]: s for s in stories}
        for s in stories:
            assert s["texts_by_audience"] == au.compose(m, packed[s["story_id"]]), (mid, s["story_id"])  # rerun the CLI
        for c in cues:
            s = by_id.get(c["story_id"])
            if c["graphic"] == "why_card" and s:
                assert c["payload"]["body"] == au.text_for(s, c["audience"], c["lang"]), c["cue_id"]
        shape = lambda c: (c["story_id"], c["ts"], c["graphic"], c["lang"])  # noqa: E731
        assert sorted(map(shape, (c for c in cues if c["audience"] == "kids"))) == \
            sorted(map(shape, (c for c in cues if c["audience"] == "casual")))
        assert len({c["cue_id"] for c in cues}) == len(cues)
        for aud in {c["audience"] for c in cues}:
            for lang in rules.LANGS:
                mine = [c for c in cues if c["audience"] == aud and c["lang"] == lang]
                assert all(sum(_overlap(o, c) and o["ts"] <= c["ts"] for o in mine) <= 2 for c in mine), (mid, aud, lang)


def test_again_is_said_only_with_the_earlier_goal_or_shot_cited():
    assert pb.says_again("Ancora Okowande! Al 13' segna", "it") and pb.says_again("Al 70' ci riprova Haddad", "it")
    assert not pb.says_again("Gol di Duarte! Il Redwick sta ancora vincendo, 2-1.", "it")  # "still"
    assert pb.says_again("Lo vuelve a intentar Haddad", "es") and pb.says_again("Another goal for Okowande", "en")
    packs, seen = _packs(REPLAYS), 0
    for mid in PACK_IDS:
        stories, cues = _pack(mid)
        m = packs[mid][0]
        for s in stories:
            earlier = {f["fact_id"] for f in pb.backing(m, s)}
            backed = earlier & set(s["fact_ids"])
            said = [(lang, t) for tx in (s["texts"], *s["texts_by_audience"].values()) for lang, t in tx.items()
                    if pb.says_again(t, lang)]
            assert not said or backed, (mid, s["story_id"], said)
            assert all(m.facts[i]["ts"] < s["ts"] and m.facts[i]["player_id"] == s["player_id"] for i in backed)
            seen += bool(said)
            for c in cues:
                if c["story_id"] == s["story_id"] and c["graphic"] == "why_card" and pb.says_again(c["payload"]["body"], c["lang"]):
                    assert backed & set(c["payload"]["fact_ids"]), c["cue_id"]
    assert seen >= 6  # goals that say "again" and chances that say "tries again"


def test_checkins_air_alone_with_the_numbers_of_their_facts():
    _packs(REPLAYS)  # skips without the matches database
    srv.set_clock(None)
    total = 0
    for mid in PACK_IDS:
        _, cues = _pack(mid)
        info = srv.get_match_info(mid)
        facts = {f["fact_id"]: f for f in srv.get_facts(mid)}
        p1, end = info["period1_s"], info["period1_s"] + info["period2_s"]
        cards = [c for c in cues if c["payload"].get("kind") == "checkin"]
        total += len(cards)
        assert len({(c["audience"], c["payload"]["title"], c["lang"]) for c in cards}) == len(cards)
        for c in cards:
            got = [facts[f] for f in c["payload"]["fact_ids"]]
            assert {f["kind"] for f in got} >= set(au.CHECKIN_KINDS) - {"checkin_top_speed"}, c["cue_id"]
            assert {f["player_id"] for f in got} == {c["audience"].split(":", 1)[1]}
            assert len({f["ts"] for f in got}) == 1
            ts = got[0]["ts"]
            assert ts <= c["ts"] <= ts + au.CHECKIN_WAIT_S and c["ts"] + c["duration_s"] <= (p1 if ts <= p1 else end)
            body = c["payload"]["body"]
            for f in got:
                said = au.CHECKIN[c["lang"]]["none"] if f["kind"] == "checkin_sprints" and not f["value"] else rules.fmt(f["value"], c["lang"])
                assert said in body, (c["cue_id"], f["kind"], body)
            assert not [o for o in cues if o["audience"] == c["audience"] and o is not c
                        and o["payload"].get("kind") != "checkin" and _overlap(o, c)], c["cue_id"]
    assert total > 0


def test_a_checkin_waits_for_a_free_slot_or_is_dropped():
    m = rules.Match({**SIDES, "period2_s": 2700.0})
    meta = {"match_id": "M001", "period1_s": 2700.0, "period2_s": 2700.0}
    values = {"checkin_touches": 31, "checkin_passes": 18, "checkin_distance": 1.9, "checkin_sprints": 1, "checkin_top_speed": 31.4}
    facts = [{"fact_id": f"F-{k.upper()}-00000{i}", "kind": k, "ts": 900.0, "period": 1, "team_id": "T01",
              "player_id": "T01-9", "value": v} for i, (k, v) in enumerate(values.items(), 1)]

    def cue(ts, dur, aud="player:T01-9"):
        return {"ts": ts, "duration_s": dur, "audience": aud, "lang": "it", "payload": {}}
    (card,) = au.checkin_cues(m, meta, facts, [cue(895.0, 12.0), cue(880.0, 60.0, "casual")])
    assert card["ts"] == 907.0 and card["lang"] == "it" and card["story_id"] is None
    assert card["payload"] == {"kind": "checkin", "title": "Hugo Okowande al 15'",  # two Okowande: the full name
                               "body": "31 tocchi\n18 passaggi riusciti\n1,9 km percorsi\n1 scatto\nVelocità massima 31,4 km/h",
                               "fact_ids": [f["fact_id"] for f in facts]}
    assert not au.checkin_cues(m, meta, facts, [cue(899.0, 34.0)])  # nothing free before 930: dropped
    late = [{**f, "ts": 2697.0} for f in facts]
    assert not au.checkin_cues(m, meta, late, [cue(100.0, 6.0)])  # would run past half-time


def test_apply_is_idempotent_on_a_committed_pack():
    _packs(REPLAYS)
    with closing(db.connect(srv.DB_PATH, readonly=True)) as conn:
        meta = export.meta(conn, "M001")
        events = export._all(conn, "SELECT * FROM events WHERE match_id = 'M001' ORDER BY ts, event_id")
        facts = export._parsed(export._all(conn, "SELECT * FROM facts WHERE match_id = 'M001' ORDER BY ts, fact_id"),
                               "source_event_ids", "source_frames")
    stories, cues = _pack("M001")
    assert au.apply(meta, facts, events, stories, cues) == (stories, cues)
