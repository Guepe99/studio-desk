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
# wordings a native reviewer flagged as calques or wrong; none may come back in an audience line
CALQUES = {"it": r"\binerzia (?:del|dell['’]|dello|della [A-Z])|^L'inerzia|Indice di inerzia|Un altro gol per|Bel tentativo|"
                 r"Velocità nello scatto|km/h per (?:il|l['’]|lo)\b",
           "es": r"se le va alta|Mala noticia|Se estrena|Bien jugado|Queda la segunda parte para|Se escapa la ventaja|"
                 r"Qué trabajo|momento para (?:el|la)\b|Velocidad del (?:disparo|cabezazo)|\by se (?:marcha|va por encima)|"
                 r"adelanta a sus|echa atrás a sus|Ahora es \d|km/h para el|pases completados"}


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
                    assert not re.search(CALQUES.get(lang, "$^"), text), (mid, sid, aud, lang, text)
                    if aud.startswith("team:"):
                        assert not re.search(WE[lang], text, re.I), (mid, sid, aud, text)  # partisan, never "we"
                seen.add((s["kind"], aud.split(":")[0]))
            if s["kind"] in ("goal", "big_chance", "recap"):
                want = {"analyst", "casual", "kids"} | {f"team:{t}" for t in m.teams}
                want |= {f"player:{s['player_id']}"} if s["player_id"] and s["kind"] != "recap" else set()
                assert want <= set(lines), (mid, sid, sorted(want - set(lines)))
    for kind in au.LINES:
        assert {(kind, a) for a in ("analyst", "casual", "kids", "team")} <= seen, kind


def test_italian_says_momentum_and_spanish_does_not():
    assert not rules.english_words("Il momentum del Redwick sale a 7,1.", "it")
    assert rules.english_words("El momentum del Redwick sube a 7,1.", "es")
    assert rules._has(rules.MOMENTUM_WORDS, "il momentum del Redwick")  # still the wrong measure in a pressing story
    assert "pases acertados" in au.CHECKIN["es"]["passes"][1] and "alto" in pb.OVER_ES[1]
    speed_only = {"facts": [{"kind": "shot_speed", "value": 92.1}]}  # no distance fact, as in the DEMO fixture
    assert au._metrics(speed_only, "es") == "Disparo a 92,1 km/h" and au._metrics({"facts": []}, "es") is None


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
    assert any(c["graphic"] == "team_stats" for c in cues)  # the team shape panels are rebuilt, not doubled


def _shown(f, lang):
    """A team fact as the team shape panel must show it, written here apart from audiences._stat_text."""
    if f["unit"] == "formation":
        return "-".join(str(int(f["value"])))
    return f"{f['value']:.1f}".rstrip("0").rstrip(".").replace(".", "," if lang != "en" else ".") + \
        (" m" if f["unit"] == "m" else "/10")


def test_team_stats_show_the_facts_of_one_window_alone_on_the_analyst_sheet():
    _packs(REPLAYS)
    srv.set_clock(None)
    for mid in PACK_IDS:
        _, cues = _pack(mid)
        info = srv.get_match_info(mid)
        facts = {f["fact_id"]: f for f in srv.get_facts(mid)}
        home, away = (next(t["team_id"] for t in info["teams"] if t["side"] == s) for s in ("home", "away"))
        p1, end = info["period1_s"], info["period1_s"] + info["period2_s"]
        panels = [c for c in cues if c["graphic"] == "team_stats"]
        assert len(panels) >= 3 * 15, mid  # a panel for most windows, in en, it and es
        for c in panels:
            p = c["payload"]
            assert c["audience"] == "analyst" and c["story_id"] is None and c["duration_s"] == au.STATS_S
            got = [facts[i] for i in p["fact_ids"]]
            assert [f["kind"] for f in got] == [k for k in au.STATS_KINDS for _ in (0, 1)]
            assert [f["team_id"] for f in got] == [home, away] * 5 and len({f["ts"] for f in got}) == 1
            ts = got[0]["ts"]
            assert ts <= c["ts"] <= ts + au.STATS_WAIT_S and c["ts"] + c["duration_s"] <= (p1 if ts <= p1 else end)
            assert [r["stat"] for r in p["rows"]] == list(au.STATS_KINDS)
            for r, h, a in zip(p["rows"], got[::2], got[1::2]):
                assert (r["home"], r["away"]) == (_shown(h, c["lang"]), _shown(a, c["lang"])), (c["cue_id"], r)
                if r["stat"] == "formation":
                    assert r["home_v"] is r["away_v"] is None
                else:
                    assert (r["home_v"], r["away_v"]) == (h["value"], a["value"])
            assert re.fullmatch({"en": r"Min \S+|(First|Second)-half stoppage time",
                                 "it": r"Minuti \S+|Recupero del (primo|secondo) tempo",
                                 "es": r"Minutos \S+|Descuento de la (primera|segunda) parte"}[c["lang"]], p["when"])
            others = [o for o in cues if o["audience"] == "analyst" and o is not c and o["graphic"] != "team_stats"]
            assert not [o for o in others if _overlap(o, c)], c["cue_id"]


def test_team_stats_wait_for_a_free_slot_or_are_dropped():
    m = rules.Match(SIDES)
    meta = {"match_id": "M001", "period1_s": 2700.0, "period2_s": 2700.0}
    values = {"formation": (433.0, 4231.0, "formation"), "line_height": (30.8, 24.0, "m"), "team_length": (36.4, 35.3, "m"),
              "team_width": (38.0, 36.8, "m"), "press_intensity": (4.2, 0.0, "/10")}
    facts = [{"fact_id": f"F-{k.upper()}-00000{i}", "kind": k, "ts": 600.0, "period": 1, "team_id": t, "player_id": None,
              "value": v[j], "unit": v[2], "label_en": f"{k} {v[j]}, min 6-10"}
             for i, (k, v) in enumerate(values.items(), 1) for j, t in enumerate(("T01", "T02"))]

    def cue(ts, dur, lang="en", aud="analyst"):
        return {"ts": ts, "duration_s": dur, "audience": aud, "lang": lang, "graphic": "momentum", "payload": {}}
    sheet = [cue(600.0, 8.0), cue(600.0, 8.0, "it"), cue(600.0, 8.0, "es"), cue(560.0, 80.0, aud="casual")]
    en, es, it = au.stats_cues(m, meta, facts, sheet)
    assert {c["ts"] for c in (en, es, it)} == {608.0} and [c["lang"] for c in (en, es, it)] == ["en", "es", "it"]
    assert en["graphic"] == "team_stats" and en["story_id"] is None and en["duration_s"] == 10.0
    assert (en["payload"]["when"], it["payload"]["when"], es["payload"]["when"]) == ("Min 6-10", "Minuti 6-10", "Minutos 6-10")
    assert [(r["home"], r["away"]) for r in it["payload"]["rows"]] == [
        ("4-3-3", "4-2-3-1"), ("30,8 m", "24 m"), ("36,4 m", "35,3 m"), ("38 m", "36,8 m"), ("4,2/10", "0/10")]
    assert [(r["home"], r["away"]) for r in en["payload"]["rows"]][1:3] == [("30.8 m", "24 m"), ("36.4 m", "35.3 m")]
    assert es["payload"]["rows"][4] == {"stat": "press_intensity", "home": "4,2/10", "away": "0/10", "home_v": 4.2, "away_v": 0.0}
    assert en["payload"]["fact_ids"] == [f["fact_id"] for f in facts]
    # the English sheet times it: a story card from 605 to 617 pushes it to 617
    assert [c["ts"] for c in au.stats_cues(m, meta, facts, [*sheet, cue(605.0, 12.0)])] == [617.0] * 3
    assert not au.stats_cues(m, meta, facts, [cue(590.0, 80.0)])  # nothing free before 660: dropped
    assert not au.stats_cues(m, meta, [{**f, "ts": 2695.0} for f in facts], sheet)  # would run past half-time
    assert not au.stats_cues(m, meta, facts[:-1], sheet)  # a measure missing for one team: no panel
