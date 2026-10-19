"""The facts a line depends on, computed by code (club articles, shot place, value paths, defensive line
and width), and the checks that reject words against them. The reviewer's bad lines from the committed
replays must be rejected and a correct line must pass (positive control). Tests on the real facts skip
when data/matches.sqlite (or STUDIODESK_MATCHES_DB) is missing, as in test_replays."""
import json
import math
import re
from pathlib import Path

import pytest
from test_agents import INFO, _story, fact
from test_replays import _missing

from studiodesk import mcp_server as srv
from studiodesk.agents import rules

REPLAYS = Path(__file__).resolve().parents[1] / "replays"


# --- computations, offline -----------------------------------------------------------------------

def test_club_names_take_the_article_a_native_uses():
    assert rules.club("Redwick Wanderers", "it") == "il Redwick Wanderers"
    assert rules.club("Harbour Vale FC", "it") == "l'Harbour Vale FC"
    assert rules.club("Sporting Ostwick", "it") == "lo Sporting Ostwick"
    assert rules.club("Harbour Vale FC", "it", "di") == "dell'Harbour Vale FC"
    assert rules.club("Redwick Wanderers", "it", "a") == "al Redwick Wanderers"
    assert rules.club("Harbour Vale FC", "it", start=True) == "L'Harbour Vale FC"
    assert rules.club("Ostwick FC", "es") == "el Ostwick FC"
    assert rules.club("Ostwick FC", "es", "de") == "del Ostwick FC"
    assert rules.club("Ostwick FC", "en") == "Ostwick FC"


def test_shot_place_from_the_start_point():
    place = lambda x, y: rules.shot_place({"start_x": x, "start_y": y})  # noqa: E731
    assert place(3.1, 59.7)["zone"] == "byline" and place(3.1, 59.7)["side"] == "right"  # M002 EV619
    assert place(6.6, 51.6)["zone"] == "box" and place(6.6, 51.6)["side"] == "right"  # M002 EV1330
    assert place(101.9, 59.7)["side"] == "left"  # towards the other goal the sides swap
    assert place(100.0, 34.0)["zone"] == "six_yard" and place(100.0, 34.0)["side"] is None
    assert place(85.0, 34.0)["zone"] == "edge" and place(75.0, 34.0)["zone"] == "outside"
    assert rules.shot_place(None) is None
    assert rules.place_text(place(6.6, 51.6), "it") == "dentro l'area, defilato sulla destra"


def test_trend_line_and_width_paths():
    assert rules.trend_shape([3.1, 9.2, 6.7]) == "rose_then_fell"
    assert rules.trend_shape([5.0, 2.0, 6.0]) == "fell_then_rose"
    assert (rules.trend_shape([2.0, 5.0]), rules.trend_shape([5.0, 2.0]), rules.trend_shape([5.0, 5.1])) == \
        ("rising", "falling", "steady")
    line = [fact("line_height", k, 2700 + 300 * k, v, "m", f"Line {v} m") for k, v in
            enumerate((30.0, 15.7, 22.0, 49.9, 48.5), 1)]
    width = [fact("team_width", 10 + k, 2700 + 300 * k, v, "m", f"Width {v} m") for k, v in enumerate((38.7, 39.8))]
    shift = {"kind": "tactical_shift", "facts": line + width}
    path = rules.line_path(shift)
    assert path["direction"] == "higher" and (path["from"]["value"], path["to"]["value"]) == (15.7, 48.5)
    assert rules.width_change(shift) == "wider"
    assert rules.width_change({"facts": width[:1]}) is None
    m = rules.Match(INFO)
    say = rules.trend(m, _story(m, "tactical_shift", line), "it")
    assert say["shape"] == "higher" and say["say"].startswith("da 15,7 m al minuto")


def test_analyst_wording_and_calques():
    for text in ("so it mattered because it showed a chance", "This matters because a strike that powerful",
                 "the score remained Wrenmouth Sporting Club 2-1 Brightwater Wanderers 1",
                 "kept the score at Wrenmouth Sporting Club lead 2-1", "despite the score remaining Tarnby Harriers lead 1-0"):
        assert rules.analysis_issues(text), text
    assert rules.analysis_issues("A 25 m shot at 103.2 km/h, with Calderholt Borough leading 1-0.") == []
    assert rules.calques("Aggiustamento del risultato: al minuto 14 Orvanelli segna.", "it")
    assert rules.calques("Cambio táctico para mayor compactación.", "es")
    assert rules.calques("Al minuto 14 Orvanelli segna.", "it") == []


def test_club_without_article_in_italian_and_spanish():
    m = rules.Match(INFO)
    assert rules.bare_clubs(m, "Ostwick FC rimonta e pareggia.", "it") == ["club without its article: say 'l'Ostwick FC'"]
    assert rules.bare_clubs(m, "L'Ostwick FC rimonta e pareggia.", "it") == []
    assert rules.bare_clubs(m, "Pases completados: Redwick Wanderers 84%, Ostwick FC 80%.", "es") == []
    assert rules.bare_clubs(m, "Ostwick FC level it.", "en") == []


def test_an_article_on_top_of_a_merged_one_is_sent_back():
    doubled = lambda t, lang: [x for x in rules.style_issues(t, lang, "momentum_swing") if x.startswith("article twice")]  # noqa: E731
    for text in ("La inercia del el Wrenmouth Sporting Club sube de 1,8/10 a 7,5/10.",  # M002 S-000004, 19/10
                 "Remate de Lindqvist desde en el área pequeña, a bocajarro.",  # M004 S-000025
                 "Sostuvo la presión el del Harbour Vale: 4,6/10."):  # M004 S-000029
        assert doubled(text, "es"), text
    assert doubled("L'inerzia di il Redwick Wanderers sale.", "it")
    assert doubled("La inercia del Wrenmouth Sporting Club sube, desde el área pequeña.", "es") == []
    assert doubled("L'inerzia del Redwick Wanderers sale, per il Redwick è il momento.", "it") == []


def test_the_crossbar_of_an_over_the_bar_outcome_is_not_invented():
    m = rules.Match(INFO)
    shot = [fact("shot_speed", 2, 3000, 119.2, "km/h", "Shot at 119.2 km/h")]
    over = _story(m, "big_chance", shot, outcome="over")
    text = "Ocasión clara para Rossi: disparo a 119,2 km/h, por encima del larguero."
    assert not [x for x in rules.story_issues(m, over, text, "es") if "larguero" in x]
    saved = _story(m, "big_chance", shot, outcome="saved")
    assert [x for x in rules.story_issues(m, saved, "Disparo de Rossi que se estrella en el larguero.", "es")
            if "larguero" in x]


# --- the reviewer's lines, on the real facts ---------------------------------------------------

@pytest.fixture(scope="module")
def packs():
    if not srv.DB_PATH.exists():
        _missing("data/matches.sqlite not built")
    srv.set_clock(None)
    out = {}
    for mid in ("M001", "M002", "M003", "M004"):
        if not srv.get_facts(mid):
            _missing(f"{mid} not in the matches database")
        m = rules.Match(srv.get_match_info(mid))
        m.facts = {f["fact_id"]: f for f in srv.get_facts(mid)}
        events = {e["event_id"]: e for e in srv.get_events(mid, 0.0, math.inf)}
        stories = {s["story_id"]: s for s in json.loads((REPLAYS / mid / "stories.json").read_text())}
        out[mid] = (m, {sid: rules.pack_story(m, s, events) for sid, s in stories.items()})
    return out


# (match, story, lang, the line on air, the check that must reject it, a correct line that passes)
BAD = [
    ("M004", "S-000023", "it", "Difesa del Harbour Vale molto alta tra il minuto 56 e il minuto 60 (15,7 m), poi più "
     "profonda tra il minuto 66 e il minuto 75 (49,9 m e 48,5 m), lasciando spazio alle ripartenze.", "line direction",
     "L'Harbour Vale FC alza la linea difensiva: da 15,7 m al minuto 60 a 48,5 m al 75."),
    ("M004", "S-000023", "en", "Harbour Vale pushed their defensive line from 29.9 m in the 55th minute to 48.5 m by the "
     "75th minute, leaving more space higher up the pitch.", "invented consequence",
     "Harbour Vale push their defensive line up, from 15.7 m in the 60th minute to 48.5 m by the 75th."),
    ("M002", "S-000019", "it", "Brightwater Wanderers prendono il controllo: al minuto 65 inerzia a 3,1/10, poi al minuto "
     "70 schizza a 9,2/10, trend in salita fino al 75.", "trend word against the facts",
     "L'inerzia passa al Brightwater Wanderers: da 3,1/10 al minuto 65 a 9,2/10 al 70, poi scende a 6,7/10 al 75."),
    ("M002", "S-000019", "es", "Brightwater Wanderers pasa de 3,1/10 al 65 a 9,2/10 al 70 y toma el mando en ventana tras "
     "ventana, al minuto 75.", "trend word against the facts",
     "La inercia es del Brightwater Wanderers: sube de 3,1/10 en el minuto 65 a 9,2/10 en el 70 y luego baja a 6,7/10 en el 75."),
    ("M004", "S-000006", "en", "Calderholt Borough surge into the game, momentum up from 1.9/10 in the 30th minute to "
     "6.7/10 in the 35th minute, sweeping control by the 40th minute.", "trend word against the facts",
     "Calderholt Borough's momentum climbs from 1.9/10 in the 30th minute to 6.7/10 by the 35th, then eases to 5.8/10 by the 40th."),
    ("M004", "S-000006", "es", "Calderholt Borough pasa de 1,9/10 en el minuto 30 a 6,7/10 en el minuto 35; el dominio se "
     "dispara y toma el mando del partido al minuto 40.", "domination claim",
     "La inercia es del Calderholt Borough: sube de 1,9/10 en el minuto 30 a 6,7/10 en el 35 y luego baja a 5,8/10 en el 40."),
    ("M003", "S-000001", "en", "Orvanelli smashes in a 27.2 m effort at 113.1 km/h that the keeper saves in the 7th minute.",
     "shot outcome word", "Orvanelli lets fly from 27.2 m at 113.1 km/h and the keeper saves in the 7th minute."),
    ("M004", "S-000028", "it", "Calderholt Borough aumenta l'inerzia della partita: dal 4,8/10 al 5,9/10 tra minuto 80 e "
     "minuto 85, pressione sempre più alta che costringe gli avversari a giocare con meno spazio.", "wrong measure",
     "Pressing intenso del Calderholt Borough: l'intensità sale da 4,8/10 al minuto 80 a 5,9/10 all'85."),
    ("M001", "S-000014", "it", "Botta potentissima di Duarte da fuori area al minuto 81, palla nell’angolo: gol, 2-2.",
     "detail not in the facts", "Botta di Duarte da fuori area al minuto 81: gol, 2-2."),
    ("M004", "S-000032", "en", "Calderholt Borough took the lead in the 31st minute and doubled it in the 57th; pass "
     "accuracy finished Harbour Vale 84.9%, Calderholt Borough 83.6%, final score 2-0.", "score without the leader",
     "Calderholt Borough took the lead in the 31st minute and doubled it in the 57th: Calderholt Borough win 2-0."),
    ("M003", "S-000018", "en", "Tarnby Harriers opened the scoring in the 14th minute through Ricardo Orvanelli and sealed "
     "it in the 82nd minute via Malik Szabo; final score 2-0.", "score without the leader",
     "Ricardo Orvanelli scored in the 14th minute and Malik Szabo in the 82nd: Tarnby Harriers win 2-0."),
    ("M002", "S-000009", "es", "Pavic cabecea desde 5,9 m, cabezazo de cerca a 58,2 km/h que se desvía por encima del palo; "
     "minuto 43.", "shot outcome word", "Cabezazo de Pavic desde 5,9 m, a 58,2 km/h, que se marcha desviado; minuto 43."),
    ("M003", "S-000017", "es", "¡Gol de Malik Szabo! Tarnby Harriers se pone por delante, 2-0.", "lead word",
     "¡Gol de Malik Szabo! El Tarnby Harriers amplía la ventaja, 2-0."),
    ("M002", "S-000008", "it", "Dunmarrow dal limite prova un destro di potenza incredibile, 25,9 m e 114 km/h: palla "
     "respinta al termine dell'azione al minuto 41.", "distance word does not fit the shot",
     "Dunmarrow ci prova dal fondo, sulla destra, a 114 km/h: palla respinta al minuto 41."),
    ("M002", "S-000008", "it", "Dunmarrow prova un destro di potenza incredibile, 114 km/h, al minuto 41.",
     "detail not in the facts", "Dunmarrow ci prova a 114 km/h: palla respinta al minuto 41."),
    ("M001", "S-000013", "it", "Il Redwick Wanderers cambia sistema e passa al 4-4-2, linea difensiva a 25,4 m; al minuto "
     "75 la squadra è più compatta e larga (39,8 m vs 38,7 m al minuto 60).", "width word",
     "Il Redwick Wanderers passa al 4-4-2 e si allarga: da 38,7 m al minuto 60 a 39,8 m al 75."),
    ("M001", "S-000013", "es", "Cambio táctico del técnico: Redwick Wanderers pasa a 4-4-2 para mayor compactación; línea "
     "defensiva a 25,4 m y anchura ahora 39,8 m en el minuto 75.", "width word",
     "El Redwick Wanderers pasa al 4-4-2 y gana anchura: de 38,7 m en el minuto 60 a 39,8 m en el 75."),
    ("M002", "S-000022", "es", "Remate potente de Haddad desde la frontal del área, 18,8 m, 108,9 km/h, y se va por encima "
     "del larguero al minuto 89.", "distance word does not fit the shot",
     "Remate potente de Haddad dentro del área, escorado a la derecha, a 108,9 km/h, y se va por encima; minuto 89."),
    ("M004", "S-000016", "it", "Palla dentro l'area, Okowande la scaglia di piatto da 10,6 m: gol, Calderholt Borough in "
     "vantaggio 2-0 al minuto 57.", "detail not in the facts",
     "Gol di Okowande dentro l'area, da 10,6 m: il Calderholt Borough allunga, 2-0."),
    ("M004", "S-000016", "es", "A bocajarro, remate de Okowande dentro del área a 117,8 km/h y gol; Calderholt Borough 2-0 "
     "en el minuto 57.", "distance word does not fit the shot",
     "¡Gol de Okowande desde dentro del área, a 117,8 km/h! El Calderholt Borough amplía la ventaja, 2-0."),
    ("M002", "S-000014", "en", "Vellacott pounces in the six-yard box and fires home in the 66th minute to make it 2-1.",
     "body part", "Vellacott heads home from the six-yard box in the 66th minute to make it 2-1."),
    ("M002", "S-000011", "it", "Mezzo tempo dominato da Wrenmouth: reti di Rafael Mensah al minuto 23 e di Chidi Haddad "
     "al minuto 32, risultato 2-0.", "domination claim",
     "All'intervallo il Wrenmouth Sporting Club conduce 2-0, con le reti di Rafael Mensah al minuto 23 e di Chidi Haddad al minuto 32."),
    ("M004", "S-000011", "en", "Lindqvist peels away and hits 35.1 km/h on a blistering run in the 50th minute, leaving "
     "Calderholt Borough defenders struggling to cope.", "invented consequence",
     "Lindqvist peels away and hits 35.1 km/h on a blistering run in the 50th minute."),
    ("M004", "S-000017", "en", "Harbour Vale FC press high: intensity 5.2/10.", "press position",
     "Harbour Vale FC press hard, intensity 5.2/10."),
    ("M002", "S-000001", "it", "Wrenmouth Sporting Club pressa alto: intensità 5,5/10.", "press position",
     "Pressing intenso del Wrenmouth Sporting Club: intensità 5,5/10."),
    ("M003", "S-000008", "it", "Aggiustamento del risultato: al minuto 14 Orvanelli porta in vantaggio il Tarnby Harriers, "
     "1-0.", "calque", "Al minuto 14 Orvanelli porta in vantaggio il Tarnby Harriers, 1-0."),
    ("M001", "S-000015", "it", "Ostwick FC rimonta e pareggia al minuto 81: 2-2.", "club without its article",
     "L'Ostwick FC rimonta e pareggia al minuto 81: 2-2."),
]


@pytest.mark.parametrize("mid,sid,lang,bad,head,good", BAD, ids=[f"{b[0]}-{b[1]}-{b[2]}-{b[4]}" for b in BAD])
def test_the_reviewers_lines_are_rejected_and_a_correct_line_passes(packs, mid, sid, lang, bad, head, good):
    m, stories = packs[mid]
    story = stories[sid]
    found = lambda text: rules.story_issues(m, story, text, lang) + rules.style_issues(  # noqa: E731
        text, lang, story["kind"], m=m)
    assert any(i.startswith(head) for i in found(bad)), found(bad)
    assert rules.story_issues(m, story, good, lang) == []
    assert not [i for i in found(good) if i.startswith(("calque", "club without"))], found(good)
    assert rules.check_text(m.without_names(good), rules.story_allowed(m, story), lang) == [], good


def test_the_real_facts_give_the_paths_the_writers_follow(packs):
    m2, s2 = packs["M002"]
    assert rules.trend(m2, s2["S-000019"])["shape"] == "rose_then_fell"
    assert s2["S-000008"]["place"]["zone"] == "byline" and s2["S-000008"]["place"]["side"] == "right"
    assert s2["S-000022"]["place"]["zone"] == "box" and s2["S-000022"]["place"]["side"] == "right"
    m4, s4 = packs["M004"]
    assert rules.trend(m4, s4["S-000006"])["shape"] == "rose_then_fell"
    path = rules.line_path(s4["S-000023"])
    assert path["direction"] == "higher" and (path["from"]["value"], path["to"]["value"]) == (15.7, 48.5)
    assert rules.width_change(packs["M001"][1]["S-000013"]) == "wider"
    m3, s3 = packs["M003"]
    assert rules.template(m3, s3["S-000017"], "es") == "¡Gol de Malik Szabo! El Tarnby Harriers amplía la ventaja, 2-0."


def test_every_template_on_the_real_packs_passes_every_check(packs):
    for mid, (m, stories) in packs.items():
        for sid, s in stories.items():
            for lang in rules.LANGS:
                t = rules.template(m, s, lang)
                bad = (rules.check_text(m.without_names(t), rules.story_allowed(m, s), lang, rules.story_ids(s))
                       + rules.story_issues(m, s, t, lang) + rules.story_gaps(m, s, t) + rules.jargon(t)
                       + rules.english_words(t, lang) + rules.calques(t, lang) + rules.bare_clubs(m, t, lang)
                       + [x for x in rules.style_issues(t, lang, s["kind"]) if x.startswith("article twice")])
                if s["kind"] == "pressing_spell" and lang != "en":
                    assert re.match(r"(?:Pressing intenso d|Presión intensa del )", t) and " per " not in t \
                        and " para " not in t, t  # "dell'Ostwick FC", "del Ostwick FC"
                assert bad == [], (mid, sid, lang, t, bad)
