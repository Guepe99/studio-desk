"""The facts a line depends on, computed by code (club articles, shot place, value paths, defensive line
and width), and the checks that reject words against them. The reviewer's bad lines from the committed
replays must be rejected and a correct line must pass (positive control); those lines and story ids
come from the packs the reviewer read, frozen in tests/review_tappa4, not from today's replays. Tests on the real facts skip
when data/matches.sqlite (or STUDIODESK_MATCHES_DB) is missing, as in test_replays."""
import json
import math
import re
from pathlib import Path

import pytest
from test_agents import INFO, SIDES, _story, fact
from test_replays import _missing

from studiodesk import mcp_server as srv
from studiodesk.agents import rules

REPLAYS = Path(__file__).resolve().parents[1] / "replays"
REVIEWED = Path(__file__).resolve().parent / "review_tappa4"


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
    # a goal inside a momentum story is not a window: 2.6 to 8.6 then 6.9, not "fell to 2"
    swing = [fact("momentum", k, 4800 + 300 * k, v, "/10", f"Momentum {v}/10") for k, v in enumerate((6.8, 2.6, 8.6, 6.9), 1)]
    swing = _story(m, "momentum_swing", swing + [fact("score", 1, 4919, 2, "goal", "Goal 0-2", "T02")])
    assert [f["value"] for f in rules.text_facts(swing)] == [2.6, 8.6, 6.9]
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
    return _packs(REVIEWED)


@pytest.fixture(scope="module")
def live_packs():
    return _packs(REPLAYS)


def _packs(root):
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
        stories = {s["story_id"]: s for s in json.loads((root / mid / "stories.json").read_text())}
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
     "¡Gol de Malik Szabo! El Tarnby Harriers amplía la ventaja, 0-2."),
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
     "Gol di Okowande dentro l'area, da 10,6 m: il Calderholt Borough allunga, 0-2."),
    ("M004", "S-000016", "es", "A bocajarro, remate de Okowande dentro del área a 117,8 km/h y gol; Calderholt Borough 2-0 "
     "en el minuto 57.", "distance word does not fit the shot",
     "¡Gol de Okowande desde dentro del área, a 117,8 km/h! El Calderholt Borough amplía la ventaja, 0-2."),
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
     "1-0.", "calque", "Al minuto 14 Orvanelli porta in vantaggio il Tarnby Harriers, 0-1."),
    ("M001", "S-000015", "it", "Ostwick FC rimonta e pareggia al minuto 81: 2-2.", "club without its article",
     "L'Ostwick FC rimonta e pareggia al minuto 81: 2-2."),
    # --- the native review of 19/10 (tappa 4)
    # keeper words only for a saved shot
    ("M002", "S-000015", "it", "Conclusione di Vellacott dal limite dell'area, potente a 105,7 km/h e da 24,9 m: respinto da "
     "un difensore, il portiere era messo alla prova al minuto 69.", "shot outcome word",
     "Conclusione di Vellacott dal limite dell'area, a 105,7 km/h e da 24,9 m: respinta da un difensore al minuto 69."),
    ("M003", "S-000001", "en", "Orvanelli drills a shot from 27.2 m at 113.1 km/h and the keeper saves comfortably in the "
     "7th minute.", "detail not in the facts",
     "Orvanelli drills a shot from 27.2 m at 113.1 km/h and the keeper saves in the 7th minute."),
    # invented details
    ("M001", "S-000001", "en", "Okowande turns and thumps it from the middle of the box, Redwick Wanderers lead 1-0 in the "
     "10th minute.", "detail not in the facts", "Okowande scores from 17.5 m in the 10th minute, Redwick Wanderers lead 1-0."),
    ("M001", "S-000001", "es", "Disparo de Okowande desde el centro del área, fuerte y colocado: gol. El Redwick Wanderers "
     "pasa por delante, 1-0.", "detail not in the facts",
     "Disparo de Okowande desde 17,5 m a 92,1 km/h: gol. El Redwick Wanderers se pone por delante, 1-0."),
    ("M002", "S-000009", "es", "Cabeceo de Pavic desde el área pequeña, a bocajarro y desviado al lado, lo rozó.",
     "detail not in the facts", "Cabezazo de Pavic desde el área pequeña, a bocajarro, que se marcha desviado; minuto 43."),
    ("M002", "S-000001", "it", "Il Wrenmouth Sporting Club alza l'intensità del pressing: pressione a 5,5/10 tra il minuto 6 "
     "e il 10, sostegno continuo nel giro palla.", "detail not in the facts",
     "Il pressing del Wrenmouth Sporting Club: l'intensità è di 5,5/10 al minuto 10."),
    ("M003", "S-000015", "en", "Dunmarrow rattles a heavy effort from the right side of the box in the 72nd minute, but it "
     "is blocked.", "detail not in the facts",
     "Dunmarrow tries his luck from the right side of the box in the 72nd minute, but it is blocked."),
    ("M002", "S-000016", "en", "Vellacott bends a long-range strike in from distance on the left in the 73rd minute, 2-2.",
     "detail not in the facts", "Vellacott scores from distance on the left in the 73rd minute, 2-2."),
    # one window is not sustained
    ("M002", "S-000001", "en", "A sustained high-intensity press from Wrenmouth Sporting Club in the 10th minute, press "
     "intensity 5.5/10 with an average 8.4 m to the ball.", "trend word against the facts",
     "Wrenmouth Sporting Club's pressing: intensity 5.5/10 in the 10th minute."),
    ("M002", "S-000001", "es", "Inicio sostenido de presión del Wrenmouth Sporting Club, intensidad 5,5/10 entre el minuto 6 "
     "y el 10.", "trend word against the facts",
     "La presión del Wrenmouth Sporting Club: la intensidad es de 5,5/10 en el minuto 10."),
    ("M004", "S-000001", "en", "Calderholt Borough show sustained pressing in the 5th minute, press intensity 5.6/10.",
     "trend word against the facts", "Calderholt Borough's pressing: intensity 5.6/10 in the 5th minute."),
    ("M004", "S-000001", "it", "Al minuto 5 il Calderholt Borough mostra una pressione costante: intensità di pressing "
     "5,6/10.", "trend word against the facts", "Il pressing del Calderholt Borough: l'intensità è di 5,6/10 al minuto 5."),
    # a sprint beats nobody
    ("M003", "S-000003", "en", "Dunmarrow powers clear on an explosive run, hitting 35.8 km/h in the 19th minute.",
     "invented consequence", "Dunmarrow hits 35.8 km/h on an explosive run in the 19th minute."),
    ("M003", "S-000003", "it", "Ilya Dunmarrow scatta a 35,8 km/h e supera la difesa: azione fulminea al minuto 19.",
     "invented consequence", "Ilya Dunmarrow scatta a 35,8 km/h al minuto 19."),
    ("M003", "S-000003", "es", "Gran aceleración de Dunmarrow en el minuto 19: sprinta a 35,8 km/h más allá de la defensa.",
     "invented consequence", "Gran aceleración de Dunmarrow en el minuto 19: esprinta a 35,8 km/h."),
    ("M003", "S-000003", "es", "Gran aceleración de Dunmarrow en el minuto 19: sprinta a 35,8 km/h más allá de la defensa.",
     "calque", "Gran aceleración de Dunmarrow en el minuto 19: esprinta a 35,8 km/h."),
    # central is within 5.5 m of the centre line
    ("M004", "S-000016", "en", "Okowande drills it in from the middle of the box in the 57th minute, Calderholt Borough "
     "lead 2-0.", "distance word does not fit the shot",
     "Okowande drills it in from 10.6 m in the 57th minute, Calderholt Borough lead 2-0."),
    # Italian and Spanish
    ("M003", "S-000004", "it", "Dunmarrow calcia dal centro dell'area, potente tiro da 9,4 m che finisce alto: para la mira "
     "al minuto 19.", "calque", "Dunmarrow calcia da 9,4 m a 113,5 km/h, ma la palla finisce alta al minuto 19."),
    ("M004", "S-000025", "it", "Con il minuto 79, conclusione di Lindqvist da 2,6 m nell'area piccola, alto: l'occasione "
     "clamorosa viene sprecata.", "calque",
     "Al minuto 79 conclusione di Lindqvist da 2,6 m nell'area piccola, alta: l'occasione clamorosa viene sprecata."),
    ("M004", "S-000015", "it", "Testa di Sorensen nell'area piccola al minuto 52, parato dal portiere: colpo da 5,9 m a "
     "72,7 km/h.", "calque",
     "Colpo di testa di Sorensen nell'area piccola al minuto 52, parato dal portiere: da 5,9 m a 72,7 km/h."),
    ("M002", "S-000017", "it", "Recupero del il Brightwater Wanderers: Vellacott riapre la partita al minuto 66 e la pareggia "
     "al minuto 73, 2-2.", "calque",
     "Rimonta del Brightwater Wanderers: Vellacott riapre la partita al minuto 66 e la pareggia al minuto 73, 2-2."),
    ("M003", "S-000006", "it", "L'inerzia sale dal 1,8/10 al 20' al 7,7/10 al 30': il Tarnby Harriers cresce vistosamente tra "
     "il minuto 26 e il 30.", "elision",
     "L'inerzia del Tarnby Harriers sale dall'1,8/10 al minuto 20 al 7,7/10 al 30."),
    ("M004", "S-000004", "it", "L'inerzia sale dall'Harbour Vale: da 2,1/10 al minuto 10 a 7,2/10 al minuto 25.",
     "wrong preposition", "L'inerzia dell'Harbour Vale FC sale: da 2,1/10 al minuto 10 a 7,2/10 al 25."),
    ("M002", "S-000016", "it", "Bomba di Vellacott da fuori area, sulla sinistra: gol, il Brightwater Wanderers pareggia 2-2 "
     "al minuto 73.", "shot power word",
     "Gol di Vellacott da fuori area, sulla sinistra: il Brightwater Wanderers pareggia 2-2 al minuto 73."),
    ("M001", "S-000005", "it", "Duarte da dentro l'area piccola, conclusione a bassa parabola da circa 5,6 m a 82,6 km/h: il "
     "portiere para al minuto 41.", "approximate figure",
     "Duarte calcia dall'area piccola, da 5,6 m a 82,6 km/h: il portiere para al minuto 41."),
    ("M004", "S-000012", "it", "Tiro di Rafael Lindqvist da fuori area, sulla destra: il portiere para; il tentativo "
     "viaggiava a 103,2 km/h da circa 24,7 m al minuto 46.", "approximate figure",
     "Tiro di Rafael Lindqvist da fuori area, sulla destra: il portiere para; viaggiava a 103,2 km/h da 24,7 m al minuto 46."),
    ("M004", "S-000021", "it", "Dalla distanza, Vellacott calcia dal limite dell'area a 110,4 km/h su una conclusione che "
     "finisce a lato al minuto 72.", "said twice",
     "Vellacott calcia dal limite dell'area a 110,4 km/h, a lato al minuto 72."),
    ("M001", "S-000016", "es", "Partido terminado: el Redwick Wanderers se puso 2-0 con Hugo Okowande en el minuto 10 y en el "
     "minuto 13; Tariq Duarte devolvió al Ostwick FC al minuto 50 y empató en el minuto 81, final 2-2.", "calque",
     "Partido terminado: Hugo Okowande marcó en el minuto 10 y en el 13; Tariq Duarte recortó distancias en el 50 y "
     "empató en el 81, final 2-2."),
    ("M001", "S-000013", "es", "Cambio táctico del Redwick: pasa de 4-3-3 (minuto 60) a 4-4-2 (minutos 70-75), con la línea "
     "defensiva a 25,4 m del arco y el equipo más ancho, de 38,7 m a 39,8 m.", "calque",
     "El Redwick Wanderers pasa al 4-4-2, con la línea defensiva a 25,4 m de su portería y el equipo más ancho, de 38,7 m "
     "a 39,8 m."),
    ("M004", "S-000019", "es", "El Calderholt Borough ve cómo su inercia sube: de 2/10 al minuto 50 hasta 9,1/10 en el 60; "
     "seguimiento sostenido en los minutos siguientes.", "calque",
     "El Calderholt Borough ve cómo su inercia sube: de 2/10 en el minuto 50 a 9,1/10 en el 60."),
    ("M002", "S-000017", "es", "El Brightwater Wanderers remontan tras ir perdiendo 0-2: gol de Vellacott al minuto 66 y otro "
     "suyo al minuto 73, 2-2.", "verb number",
     "El Brightwater Wanderers remonta tras ir perdiendo 0-2: gol de Vellacott en el minuto 66 y otro suyo en el 73, 2-2."),
    # English
    ("M001", "S-000005", "en", "Duarte fires a low, close-range effort from in the six-yard box that is saved by the keeper "
     "in the 41st minute.", "calque",
     "Duarte fires a low, close-range effort from the six-yard box that is saved by the keeper in the 41st minute."),
    ("M004", "S-000025", "en", "Lindqvist skies an easy chance from in the six-yard box in the 79th minute, over the bar.",
     "calque", "Lindqvist skies an easy chance from the six-yard box in the 79th minute."),
    ("M002", "S-000002", "en", "Haddad heads from about 3.9 m in the six-yard box and the keeper saves it in the 17th minute.",
     "approximate figure", "Haddad heads from 3.9 m in the six-yard box and the keeper saves it in the 17th minute."),
    ("M003", "S-000010", "en", "From 23.4 m, Dunmarrow fires a 103.6 km/h drive from distance, straight on, saved by the "
     "keeper in the 61st minute.", "said twice",
     "Dunmarrow fires a 103.6 km/h drive from distance, saved by the keeper in the 61st minute."),
    ("M004", "S-000012", "en", "Lindqvist rifles a long-range effort from distance on the right that the keeper saves in the "
     "46th minute.", "said twice",
     "Lindqvist rifles an effort from distance on the right that the keeper saves in the 46th minute."),
    ("M002", "S-000016", "en", "Vellacott bends a long-range strike in from distance on the left in the 73rd minute, 2-2.",
     "said twice", "Vellacott scores from distance on the left in the 73rd minute, 2-2."),
    # the score as on the scoreboard in Italian and Spanish
    ("M003", "S-000002", "it", "Orvanelli da fuori area, in posizione centrale: gol, il Tarnby Harriers passa in vantaggio, "
     "1-0.", "score order", "Orvanelli da fuori area: gol, il Tarnby Harriers passa in vantaggio, 0-1."),
    ("M004", "S-000016", "es", "Remate con el pie de Okowande desde el centro del área: gol al minuto 57, 2-0 para el "
     "Calderholt Borough.", "score order",
     "Gol de Okowande dentro del área en el minuto 57: el Calderholt Borough amplía la ventaja, 0-2."),
    # the analyst's claims
    ("M003", "S-000011", "en", "Kestrel Bay Town’s defensive line moved steadily up the pitch from 15.9 m at minute 50 to "
     "43.1 m by minute 70, showing a clear push forward in the 50-70 period.", "trend word against the facts",
     "Kestrel Bay Town pushed their defensive line up, from 15.9 m in the 51st minute to 43.1 m by the 70th."),
    ("M003", "S-000013", "en", "Momentum swung sharply for Kestrel Bay Town, rising from 1.0/10 in the 56-60 window to "
     "7.3/10 by 66-70, showing a rapid increase in their control of play in that timeframe.", "domination claim",
     "Momentum swung to Kestrel Bay Town, rising from 1.0/10 in the 60th minute to 7.3/10 by the 70th."),
]


@pytest.mark.parametrize("mid,sid,lang,bad,head,good", BAD, ids=[f"{b[0]}-{b[1]}-{b[2]}-{b[4]}" for b in BAD])
def test_the_reviewers_lines_are_rejected_and_a_correct_line_passes(packs, mid, sid, lang, bad, head, good):
    m, stories = packs[mid]
    story = stories[sid]
    found = lambda text: rules.story_issues(m, story, text, lang) + rules.style_issues(  # noqa: E731
        text, lang, story["kind"], m=m)
    assert any(i.startswith(head) for i in found(bad)), found(bad)
    assert rules.story_issues(m, story, good, lang) == []
    assert not [i for i in found(good) if i.startswith((head, "calque", "club without"))], found(good)
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
    assert rules.template(m3, s3["S-000017"], "es") == "¡Gol de Malik Szabo! El Tarnby Harriers amplía la ventaja, 0-2."
    assert rules.template(m3, s3["S-000017"], "en") == "Goal! Malik Szabo extends the lead for Tarnby Harriers, 2-0."


@pytest.mark.parametrize("which", ["packs", "live_packs"])
def test_every_template_on_the_real_packs_passes_every_check(which, request):
    for mid, (m, stories) in request.getfixturevalue(which).items():
        for sid, s in stories.items():
            for lang in rules.LANGS:
                t = rules.template(m, s, lang)
                # every check a writer's line meets, the style ones included
                bad = (rules.check_text(m.without_names(t), rules.story_allowed(m, s), lang, rules.story_ids(s))
                       + rules.story_issues(m, s, t, lang) + rules.story_gaps(m, s, t)
                       + rules.style_issues(t, lang, s["kind"], m=m))
                if s["kind"] == "pressing_spell":  # neutral about strength: "Il pressing dell'Ostwick FC"
                    assert re.match(r"(?:[A-Z].*'s pressing: intensity |Il pressing d|La presión del )", t) \
                        and not re.search(r"\b(?:hard|intens[oa]|per|para)\b", t), t
                assert bad == [], (mid, sid, lang, t, bad)


# --- the native review of 19/10, offline ---------------------------------------------------------

def test_score_order_is_the_leaders_in_english_and_the_scoreboards_in_italian_and_spanish():
    m = rules.Match(SIDES)
    m.facts["g"] = fact("score", 1, 2900, 1, "goal", "Goal", "T02")  # the away side leads: 1-0 to them, 0-1 on the board
    goal = _story(m, "goal", [m.facts["g"]], team="T02", player="T02-9", ts=2900)
    order = lambda s, t, lang: [i for i in rules.story_issues(m, s, t, lang) if i.startswith("score order")]  # noqa: E731
    assert [rules.score_text(m, 2900, lang) for lang in rules.LANGS] == ["1-0", "0-1", "0-1"]
    assert "1-0" in rules.number_list(m, goal, "en") and "0-1" in rules.number_list(m, goal, "es")
    assert order(goal, "Kimura puts Ostwick 0-1 up.", "en") and not order(goal, "Kimura puts Ostwick 1-0 up.", "en")
    assert order(goal, "Gol di Kimura: l'Ostwick FC passa in vantaggio, 1-0.", "it")
    assert not order(goal, "Gol di Kimura: l'Ostwick FC passa in vantaggio, 0-1.", "it")
    assert order(goal, "¡Gol de Kimura! El Ostwick FC se pone por delante, 1-0.", "es")
    assert rules.template(m, goal, "it") == "Gol di Tariq Kimura: l'Ostwick FC passa in vantaggio, 0-1."
    assert rules.template(m, goal, "en") == "Goal! Tariq Kimura puts Ostwick FC 1-0 up."
    # the home side ahead: leader first and home first agree, and the other way round is wrong in all three
    for n, ts in ((2, 2950), (3, 2990)):
        m.facts[f"h{n}"] = fact("score", n, ts, 1, "goal", "Goal", "T01")
    late = _story(m, "goal", [m.facts["h3"]], player="T01-9", ts=2990)
    assert {rules.score_text(m, 2990, lang) for lang in rules.LANGS} == {"2-1"}
    for lang, text in (("en", "Okowande scores, Redwick lead 1-2."), ("it", "Gol di Okowande, il Redwick è avanti, 1-2."),
                       ("es", "Gol de Okowande, el Redwick va por delante, 1-2.")):
        assert order(late, text, lang) and not order(late, text.replace("1-2", "2-1"), lang), text


def _press(m, values, team="T01"):
    for k, v in enumerate(values, 1):
        m.facts[f"p{team}{k}"] = fact("press_intensity", k + (20 if team == "T02" else 0), 2700 + 300 * k, v, "/10",
                                      f"Press intensity {v}/10", team)
    return 2700 + 300 * len(values)


def test_story_choice_skips_repeats_stoppage_stubs_and_flat_pressing_pairs():
    kinds = lambda m, w, w0=None, told=(): [c["kind"] for c in rules.window_candidates(  # noqa: E731
        m, w - 300 if w0 is None else w0, w, [], set(), told=told)]
    for values, told in (((3.0, 4.6, 4.6), False), ((3.0, 4.4, 4.9), True), ((3.0, 4.6, 5.6), True), ((5.6, 5.6), True)):
        m = rules.Match(INFO)
        assert (kinds(m, _press(m, values)) == ["pressing_spell"]) is told, values
    m = rules.Match(INFO)
    w = _press(m, (3.0, 5.6))
    assert kinds(m, w, w0=w - 60) == [] and kinds(m, w) == ["pressing_spell"]  # a one-minute stub is no spell
    assert kinds(m, w, told=[{"kind": "pressing_spell", "team_id": "T01", "ts": w - 600}]) == []
    assert kinds(m, w, told=[{"kind": "pressing_spell", "team_id": "T02", "ts": w - 300}]) == ["pressing_spell"]
    assert kinds(m, w, told=[{"kind": "pressing_spell", "team_id": "T01", "ts": w - 900}]) == ["pressing_spell"]
    m = rules.Match(INFO)
    for k, v in enumerate((1.0, 1.0, 5.0, 6.0), 1):
        m.facts[f"m{k}"] = fact("momentum", 40 + k, 2700 + 300 * k, v, "/10", f"Momentum {v}/10")
    assert kinds(m, 3900) == ["momentum_swing"]
    assert kinds(m, 3900, told=[{"kind": "momentum_swing", "team_id": "T01", "ts": 3600}]) == []


def test_keeper_sustained_strength_and_centre_words_follow_the_facts():
    m = rules.Match(SIDES)
    shot = [fact("shot_speed", 2, 3000, 96.0, "km/h", "Shot at 96 km/h"),
            fact("shot_distance", 3, 3000, 12.0, "m", "Shot from 12 m, inside the box, foot")]
    issues = lambda outcome, text, lang="en", **kw: rules.story_issues(  # noqa: E731
        m, _story(m, "big_chance", shot, player="T01-9", outcome=outcome, **kw), text, lang)
    assert issues("wide", "Okowande from 12 m, wide, the keeper watches it go.")
    assert issues("blocked", "Okowande mette alla prova il portiere da 12 m: respinto da un difensore.", "it")
    assert issues("saved", "Okowande from 12 m, and the keeper saves.") == []
    assert issues("goal", "Okowande beats the keeper from 12 m.") == []
    assert issues("saved", "Okowande lets fly, a thunderbolt at 96 km/h, saved.")  # loud words need 100 km/h
    off = {"zone": "box", "side": "right", "depth": 11.0, "offset": 5.6}
    assert issues("saved", "Okowande from the middle of the box, saved.", place=off)
    assert issues("saved", "Okowande from the middle of the box, saved.", place={**off, "offset": 5.5, "side": None}) == []
    press = lambda values, text, lang="en": rules.story_issues(m, _story(m, "pressing_spell", [  # noqa: E731
        fact("press_intensity", 30 + k, 2700 + 300 * k, v, "/10", f"Press intensity {v}/10") for k, v in enumerate(values, 1)]),
        text, lang)
    assert press((4.4, 4.9), "Sustained pressing from Redwick Wanderers, 4.4/10 and then 4.9/10.") == []
    assert press((5.6, 4.6), "Sustained pressing from Redwick Wanderers, 5.6/10 and then 4.6/10.")
    assert press((5.5,), "Il Redwick Wanderers con una pressione costante, 5,5/10.", "it")
    assert press((5.6, 4.6), "Redwick Wanderers press hard, intensity down from 5.6/10 to 4.6/10.")
    assert press((4.4, 4.9), "Redwick Wanderers press hard, intensity up from 4.4/10 to 4.9/10.") == []


def test_italian_and_spanish_grammar_checks():
    m = rules.Match(INFO)
    lang = lambda text, la="it", kind="momentum_swing": rules.language_issues(text, la, kind, m)  # noqa: E731
    assert lang("L'inerzia del Redwick Wanderers sale dall'1,8/10 al minuto 20 a 7,7/10 all'80.") == []
    for text in ("sale dal 1,8/10", "al 80", "dal 8", "nel 11", "del 1"):
        assert lang(f"L'inerzia {text}."), text
    assert lang("Dal 18 al 10 la squadra cala.") == []  # diciotto and dieci start with a consonant
    assert lang("Il Redwick Wanderers rimontano.", kind="comeback") and lang("Il Redwick Wanderers rimonta.") == []
    assert lang("El Ostwick FC empatan.", "es") and lang("El Ostwick FC empata.", "es") == []
    assert lang("Recupero del Redwick Wanderers: pareggia 2-2.", kind="comeback")
    assert lang("Il Redwick Wanderers pareggia nel recupero.", kind="comeback") == []  # stoppage time is fine


def test_the_analysis_fallback_is_plain_english_with_the_team_and_the_player():
    m = rules.Match(SIDES)
    m.facts["g"] = fact("score", 1, 2900, 1, "goal", "Goal", "T02")
    shot = [fact("shot_speed", 2, 2900, 96.4, "km/h", "Shot at 96.4 km/h", "T02"),
            fact("shot_distance", 3, 2900, 17.5, "m", "Shot from 18 m, inside the box, foot, goal", "T02")]
    goal = _story(m, "goal", [m.facts["g"], *shot], team="T02", player="T02-9", ts=2900)
    sprint = _story(m, "top_sprint", [fact("sprint_speed", 4, 3000, 35.8, "km/h", "Sprint at 35.8 km/h")], player="T01-9")
    mom = _story(m, "momentum_swing", [fact("momentum", 40 + k, 2700 + 300 * k, v, "/10", f"Momentum {v}/10")
                                       for k, v in enumerate((1.0, 1.0, 5.0, 6.0), 1)], ts=3900)
    texts = {s["kind"]: rules.analysis_template(m, s) for s in (goal, sprint, mom)}
    assert texts == {
        "goal": "Tariq Kimura of Ostwick FC shot from 17.5 m at 96.4 km/h in the 49th minute, and scored. Ostwick FC lead 1-0.",
        "top_sprint": "Hugo Okowande of Redwick Wanderers sprinted at 35.8 km/h in the 50th minute.",
        "momentum_swing": "Momentum for Redwick Wanderers: up from 1/10 in the 50th minute to 6/10 by the 65th."}
    for s in (goal, sprint, mom):
        t = rules.analysis_template(m, s)
        assert rules.check_text(m.without_names(t), rules.story_allowed(m, s), "en") == [], t
        assert rules.story_issues(m, s, t, "en", on_air=False) == [] and rules.analysis_issues(t) == [], t
    for text in ("At half-time Calderholt Borough lead 1-0, with the score described as with Calderholt Borough leading 1-0.",
                 "Vellacott scored, making the score with Wrenmouth Sporting Club leading 2-1.",
                 "The team led 1-0 at the time, with Calderholt Borough leading 1-0.",
                 "Duarte scored to make it 2-2 for Ostwick FC in the 81st minute, with the score level at 2-2."):
        assert rules.analysis_issues(text), text
    assert rules.analysis_issues("Duarte scored from 31 m in the 81st minute. It is level at 2-2.") == []


def test_desk_notes_speak_plainly():
    assert rules.reason("repeated words (moment): say each thing once") == "a word repeated"
    assert rules.reason("score said 2 times (2-1, 2-1): say it once at most") == "the score said more than once"
    assert rules.reason("number in words: 'three' (write digits from the facts)") == \
        "a number written in words, which the desk does not allow"
    assert rules.desk_notes("rewritten", {"es": ["a word repeated"]}, {}) == ["Earlier Spanish draft: a word repeated."]
    assert rules.desk_notes("template", {}, {"en": [], "it": []}) == []  # no "Fact-only sentence used" line
    m = rules.Match(INFO)
    used = {"loud": {"rips"}, "openings": {"minute what a"}}
    issues = rules.style_issues("Minute 3: what a moment, what a moment, 2-1, 2-1, it rips. Two. Three.", "en",
                                "momentum_swing", used) + rules.style_issues(
        "Recupero del il Redwick Wanderers rimontano dal 8 da circa 5,6 m, sale dal Redwick, Testa di Rossi.", "it",
        "comeback", m=m) + rules.style_issues("Redwick Wanderers from distance, 25 m, about 5.6 m.", "en", "goal")
    assert len(issues) >= 12 and all(rules.reason(i) != "a failed check" for i in issues), \
        [i for i in issues if rules.reason(i) == "a failed check"]
