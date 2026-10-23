"""The same story told to each audience on the menu, written by code from the story's facts (no model call).

- analyst: precise, with the metric names and values. Kept in the data; on air the analyst keeps the
  story's own `texts`, the line its voice clip says.
- casual: plain words and the one number that matters.
- kids: short, simple and warm; only true numbers, often none.
- team:<id>: a fan of that club. Partisan, but never "we": the line names the club.
- player:<id>: centred on the player the story is about.

Each audience takes, per language, the first of its lines that passes every check a writer's line
meets (phrasebook.problems). When one language has none, the audience gets no variant and falls back
(text_for): a player or team follower and kids to the casual line, everyone to `texts`.

`apply` adds `texts_by_audience` to the stories, writes each audience's line into its why_card cues,
adds the kids cue sheet (a copy of the casual one), the player check-in cards and the analyst's team shape
panels:

    python -m studiodesk.agents.audiences M001 --pack replays/M001   # rewrites a replay pack in place
"""
import argparse
import json
import math
import re
from contextlib import closing
from pathlib import Path

from . import phrasebook as pb
from . import rules
from .phrasebook import cap, closed, score_clause, team, value, when, where, whole

CHECKIN_KINDS = ("checkin_touches", "checkin_passes", "checkin_distance", "checkin_sprints", "checkin_top_speed")
CHECKIN_S = 8.0       # how long a check-in card stays up
CHECKIN_WAIT_S = 30.0  # how late after its minute a check-in may air
CHECKIN_STEP_S = 0.5
CLOSE_M = 6.0          # a chance from closer than this is told by its distance: "a huge chance, from 2.6 metres"


def _of(m, tid, lang):
    return team(m, tid, lang, {"it": "di", "es": "de"}.get(lang))


def _for(m, tid, lang):
    return team(m, tid, lang, {"it": "per", "es": "para"}.get(lang))


def _key(m, s):
    """What the goal did to the score: up (went ahead), more (extended a lead), level, behind."""
    t, ts = s["team_id"], s["ts"]
    leader, was = m.lead(ts)[0], m.lead(ts - 1e-3)[0]
    return "level" if leader is None else "behind" if leader != t else "up" if was is None else "more"


def _other(m, tid):
    return next((t for t in m.teams if t != tid), None)


def _focus(s):
    opts = pb.focus_options(s)
    return "place" if "place" in opts else opts[0] if opts else None


def _metrics(s, lang):
    """"Shot speed 92.1 km/h, distance 17.5 m", the analyst's opening, from the shot facts; in Spanish
    "Disparo a 92,1 km/h desde 17,5 m"."""
    info, v, d = rules.shot_info(s) or {}, value(s, "shot_speed"), value(s, "shot_distance")
    head = info.get("header")
    if lang == "es":
        parts = ([f"a {rules.fmt(v, lang)} km/h"] if v else []) + ([f"desde {rules.fmt(d, lang)} m"] if d else [])
        return " ".join(["Cabezazo" if head else "Disparo", *parts]) if parts else None
    names = {"en": ("Header speed" if head else "Shot speed", "distance"),
             "it": ("Velocità del colpo di testa" if head else "Velocità del tiro", "distanza")}[lang]
    parts = ([f"{names[0]} {rules.fmt(v, lang)} km/h"] if v else []) + ([f"{names[1]} {rules.fmt(d, lang)} m"] if d else [])
    return cap(", ".join(parts)) if parts else None


def _then(end):
    """A Spanish outcome after the shot: the ball is the subject of a miss, never the player ("..., pero el
    balón se marcha desviado"); the keeper or a defender name themselves ("y lo para el portero")."""
    if end.startswith("se marcha"):
        return f", pero el balón {end}"
    return f" y el balón {end}" if end.startswith("se va ") else f" y {end}"


def _end(m, s, lang):
    """The outcome of a missed shot as the phrasebook says it, in lang."""
    info = rules.shot_info(s)
    out, head = info["outcome"], info["header"]
    if lang == "en" and head and out == "over":
        return ", but it goes over"
    if lang == "it" and head and out == "blocked":
        return "respinge un difensore"
    return pb.outcome(m, s, lang, out, None)


# --- goals and chances ----------------------------------------------------------------------------

def goal(m, s, role, lang):
    P, at, sc, key = pb.player(m, s), when(m, s["ts"], lang), score_clause(m, s, lang), _key(m, s)
    T, sx = team(m, s["team_id"], lang), rules.score_text(m, s["ts"], lang)
    leader = m.lead(s["ts"])[0]
    L = team(m, leader, lang) if leader else ""
    head, w = (rules.shot_info(s) or {}).get("header"), where(s, lang, _focus(s)) if _focus(s) else None
    if role == "analyst":
        mt = _metrics(s, lang)
        return [mt and {"en": f"{mt}: {P} scores {at}, and {sc}.", "it": f"{mt}: {P} segna {at} e {sc}.",
                        "es": f"{mt}: {P} marca {at} y {sc}."}[lang]]
    if role == "casual":
        return [{"en": f"Goal! {P} scores, and {sc}.", "it": f"Gol di {P}! {cap(sc)}.", "es": f"¡Gol de {P}! {cap(sc)}."}[lang]]
    if role == "kids":
        return [{"en": {"up": f"Goal! {P} scores, and now {T} are winning {sx}.", "more": f"Goal! {P} scores, and {T} are winning {sx}.",
                        "level": f"Goal! {P} scores, and it's {sx} now.", "behind": f"Goal! {P} scores and {T} are back in it, {sx}."},
                 "it": {"up": f"Gol di {P}! Adesso {T} sta vincendo, {sx}.", "more": f"Gol di {P}! {cap(T)} sta vincendo, {sx}.",
                        "level": f"Gol di {P}! Adesso è pari, {sx}.", "behind": f"Gol di {P}! {cap(T)} accorcia, {sx}."},
                 "es": {"up": f"¡Gol de {P}! Ahora {T} va ganando, {sx}.", "more": f"¡Gol de {P}! {cap(T)} sigue ganando, {sx}.",
                        "level": f"¡Gol de {P}! Ahora van empatados, {sx}.", "behind": f"¡Gol de {P}! {cap(T)} se acerca, {sx}."}}[lang][key],
                # an away leader must stand next to the score: the scorer's team closes in, the leader still leads
                {"en": f"Goal! {P} scores and {T} are back in it, but {L} still lead {sx}.",
                 "it": f"Gol di {P}! {cap(T)} accorcia, ma {L} è ancora avanti, {sx}.",
                 "es": f"¡Gol de {P}! {cap(T)} se acerca, pero {L} sigue ganando, {sx}."}[lang] if key == "behind" else None]
    if role == "own":
        return [{"en": f"Get in! {P} scores {at}: {sc}.", "it": f"Che gioia! {cap(at)} segna {P}: {sc}.",
                 "es": f"¡Vamos! Marca {P} {at}: {sc}."}[lang]]
    if role == "other":
        fan = _other(m, s["team_id"])
        lead_in = {"en": {"up": "Bad news", "more": "It gets worse", "level": "Pegged back", "behind": "Nervy now"},
                   "it": {"up": "Brutta notizia", "more": "Si fa dura", "level": "Che beffa", "behind": "Ora si soffre"},
                   "es": {"up": f"Malas noticias {_for(m, fan, lang)}", "more": f"Se le complica el partido {team(m, fan, lang, 'a')}",
                          "level": "Llega el empate", "behind": "Toca sufrir"}}[lang][key]
        if lang == "es" and key == "level":  # "y el Ostwick empata" after "Llega el empate" says it twice
            return [f"{lead_in}: {P} marca {at}, {sx}."]
        return [{"en": f"{lead_in}: {P} scores {at}, and {sc}.", "it": f"{lead_in}: {P} segna {at} e {sc}.",
                 "es": f"{lead_in}: {P} marca {at} y {sc}."}[lang]]
    # the player's follower
    again = bool(pb.earlier_goals(m, s))
    w = w or ""
    w = f"{ {'en': 'with a header', 'it': 'di testa', 'es': 'de cabeza'}[lang]} {w}".strip() if head else w
    lead = {"en": (f"Another goal for {P},", f"{P} gets off the mark"),
            # "Doppietta di X" would fit a second goal, but the number check rejects number words
            "it": (f"Ancora lui, {P},", f"{P} trova la via del gol"),
            "es": (f"Otro gol de {P},", f"Primer gol de {P} en el partido,")}[lang][not again]
    if lang == "es":
        w = f"{w}," if w else w  # "Primer gol de X en el partido, desde ..., en el minuto 10"
    elif lang == "it" and w:
        w = closed(w, lang)
    if not w and not (lang == "es" and not again):
        lead = lead.rstrip(",")
    return [" ".join(x for x in (lead, w, f"{at}: {sc}.") if x)]


def chance(m, s, role, lang):
    info = rules.shot_info(s) or {}
    if info.get("outcome") not in pb.OUTCOME["en"]:
        return []
    P, at, end, head = pb.player(m, s), when(m, s["ts"], lang), _end(m, s, lang), info["header"]
    f = _focus(s)
    w = where(s, lang, f) if f else ""
    i = rules.LANGS.index(lang)
    verb = (("heads", "colpisce di testa", "remata de cabeza") if head else ("shoots", "calcia", "dispara"))[i]
    tail = {"en": end, "it": f", {end}", "es": _then(end)}[lang]  # ", but it goes wide" / ", a lato" / ", pero el balón se marcha desviado"
    if role == "analyst":
        mt = _metrics(s, lang)
        # "colpo di testa", "Cabezazo" and "Disparo" are in the metric already
        verb = "conclude" if head and lang == "it" else "remata" if lang == "es" else verb
        return [mt and f"{mt}: {P} {verb} {at}{tail}."]
    if role == "casual":
        v, d = value(s, "shot_speed"), info["dist"]
        if d is not None and d < CLOSE_M:  # from this close the distance is the story, not the speed
            one = (f"{'with a header ' if head else ''}from {pb.metres(d, 'en')} out", f"{'di testa ' if head else ''}da {pb.metres(d, 'it')}",
                   f"{'de cabeza ' if head else ''}desde {pb.metres(d, 'es')}")[i]
            return [{"en": f"A huge chance for {P}, {one}{end}.", "it": f"Occasione enorme per {P}, {one}: {end}.",
                     "es": f"Ocasión clarísima para {P}, {one}: {end}."}[lang]]
        if v and not head:
            one = pb.WITH_SHOT[i].format(whole(v))
        elif d is not None:
            one = (f"{'with a header ' if head else ''}from {pb.metres(d, 'en')} out", f"{'di testa ' if head else ''}da {pb.metres(d, 'it')}",
                   f"{'de cabeza ' if head else ''}desde {pb.metres(d, 'es')}")[i]
        else:
            return []
        return [{"en": f"A chance for {P}, {one}{end}.", "it": f"Occasione per {P}, {one}: {end}.",
                 "es": f"Ocasión para {P}, {one}: {end}."}[lang]]
    if role == "kids":
        # a miss from two metres is no "good try": a line that fits any distance
        return [{"en": f"{P} has a go{end}.", "it": f"Ci prova {P}: {end}.", "es": f"Lo intenta {P}: {end}."}[lang]]
    if role in ("own", "other"):
        T = team(m, s["team_id"] if role == "own" else _other(m, s["team_id"]), lang)
        return [{"en": f"{'Unlucky for' if role == 'own' else 'Let off for'} {T}: {P} {verb} {w} {at}{end}.",
                 "it": f"{'Peccato per' if role == 'own' else 'Pericolo scampato per'} {T}: {P} {verb} {closed(w, lang)} {at}{tail}.",
                 "es": f"{'¡Qué pena para' if role == 'own' else '¡Se salva'} {T}! {P} {verb} {closed(w, lang)} {at}{tail}."}[lang]]
    hw = {"en": f"with a header {w}", "it": f"di testa {w}", "es": f"de cabeza {w}"}[lang].strip() if head else w
    return [{"en": f"{P} has a go {hw} {at}{end}.", "it": f"{P} cerca il gol {closed(hw, lang)} {at}: {end}.",
             "es": f"{P} busca el gol {closed(hw, lang)} {at}: {end}."}[lang]]


# --- the other stories ----------------------------------------------------------------------------

def sprint(m, s, role, lang):
    v, P, at = value(s, "sprint_speed"), pb.player(m, s), when(m, s["ts"], lang)
    if v is None:
        return []
    kmh, T, per, of = f"{rules.fmt(v, lang)} km/h", team(m, s["team_id"], lang), _for(m, s["team_id"], lang), _of(m, s["team_id"], lang)
    # "35,6 km/h per il Redwick" reads as the team's speed: the club goes with the player or with the cheer
    return [{"analyst": {"en": f"Sprint speed for {P}: {kmh} {at}.", "it": f"Velocità massima di {P}: {kmh} {at}.",
                         "es": f"Velocidad punta de {P}: {kmh} {at}."},
             "casual": {"en": f"{P} sprints at {kmh}.", "it": f"{P} scatta a {kmh}.", "es": f"{P} corre a {kmh}."},
             "kids": {"en": f"Zoom! {P} runs at {kmh}.", "it": f"Che corsa! {P} va a {kmh}.", "es": f"¡Qué carrera! {P} corre a {kmh}."},
             "own": {"en": f"Look at {P} fly: {kmh} for {T}.", "it": f"Vola {P}: {kmh}, che spinta {per}!", "es": f"¡Vuela {P}! Alcanza los {kmh}."},
             "other": {"en": f"Watch {P}: {kmh} for {T}.", "it": f"Occhio a {P} {of}: {kmh}.", "es": f"Ojo con {P}, {of}: {kmh}."},
             "player": {"en": f"{P} at full speed: {kmh} {at}.", "it": f"{P} a tutta velocità: {kmh} {at}.",
                        "es": f"{P} a toda velocidad: {kmh} {at}."}}[role][lang]]


def momentum(m, s, role, lang):
    tf = [f for f in rules.text_facts(s) if f["kind"] == "momentum"]
    shape = rules.trend_shape([f["value"] for f in tf])
    if len(tf) < 2 or shape not in ("rising", "rose_then_fell") or role == "player":
        return []
    if shape == "rising":
        tf = [tf[0], tf[-1]]
    tid = s["team_id"]
    T, of, per = team(m, tid, lang), _of(m, tid, lang), _for(m, tid, lang)
    a, b = (f"{pb._ten(f, lang)} {when(m, f['ts'], lang, i == 0)}" for i, f in enumerate(tf[:2]))
    c = f"{pb._ten(tf[2], lang)} {when(m, tf[2]['ts'], lang, False)}" if len(tf) > 2 else None
    down = bool(c) and tf[2]["value"] < tf[1]["value"]  # a third value is there because it fell back
    vb = pb._ten(tf[1], lang)
    # Italian broadcasters say "il momentum" of a team; "l'inerzia del Wrenmouth" is a calque
    line = {"analyst": {"en": f"{T}'s momentum index goes from {a} to {b}" + (f", then {'drops to ' * down}{c}." if c else "."),
                        "it": f"Momentum {of}: da {a} a {b}" + (f", poi {'scende a ' * down}{c}." if c else "."),
                        "es": f"Índice de empuje {of}: de {a} a {b}" + (f", y luego {'baja a ' * down}{c}." if c else ".")},
            "casual": {"en": f"{T}'s momentum reaches {vb}.", "it": f"Il momentum {of} sale a {vb}.", "es": f"El empuje {of} llega a {vb}."},
            "kids": {"en": f"A great spell for {T}!", "it": f"Che bel momento {per}!", "es": f"¡Qué buen momento {of}!"},
            "own": {"en": f"Come on, {T}! Their momentum reaches {vb}.", "it": f"Bel momento {per}: il momentum sale a {vb}.",
                    "es": f"¡Buen momento {of}! El empuje llega a {vb}."},
            "other": {"en": f"Hold firm: {T}'s momentum reaches {vb}.", "it": f"Bisogna resistere: il momentum {of} sale a {vb}.",
                      "es": f"Toca aguantar: el empuje {of} llega a {vb}."}}[role][lang]
    # "sale" to a peak that fell back is a trend word against the facts: then the momentum "arriva a" the peak
    return [line, line.replace(" sale a ", " arriva a ")] if " sale a " in line else [line]


def pressing(m, s, role, lang):
    tf = [f for f in rules.text_facts(s) if f["kind"] == "press_intensity"]
    if not tf or role == "player":
        return []
    tid = s["team_id"]
    T, Ts, of = team(m, tid, lang), team(m, tid, lang, start=True), _of(m, tid, lang)
    fall = len(tf) > 1 and rules.trend_shape([f["value"] for f in tf]) == "falling"
    v = pb._ten(tf[-1], lang)
    a = f"{pb._ten(tf[0], lang)} {when(m, tf[0]['ts'], lang)}"
    b = f"{pb._ten(tf[1], lang)} {when(m, tf[1]['ts'], lang, False)}" if len(tf) > 1 else None
    goes = {"en": ("drops to", "reaches"), "it": ("scende a", "arriva a"), "es": ("baja a", "llega a")}[lang][0 if fall else 1]
    return [{"analyst": {"en": f"{T}'s press intensity goes from {a} to {b}." if b else f"{T}'s press intensity reaches {a}.",
                         "it": f"Intensità del pressing {of}: da {a} a {b}." if b else f"Intensità del pressing {of}: {a}.",
                         "es": f"Intensidad de la presión {of}: de {a} a {b}." if b else f"Intensidad de la presión {of}: {a}."},
             "casual": {"en": f"{T}'s press {goes} {v}.", "it": f"Il pressing {of} {goes} {v}.", "es": f"La presión {of} {goes} {v}."},
             "kids": {"en": f"{Ts} take a little breather." if fall else f"{Ts} chase the ball to win it back.",
                      "it": f"{Ts} rifiata un po'." if fall else f"{Ts} rincorre la palla per riprenderla.",
                      "es": f"{Ts} se toma un respiro." if fall else f"{Ts} va a por el balón."},
             "own": {"en": f"{Ts} catch their breath: the press {goes} {v}." if fall else f"Great work from {T}: the press {goes} {v}.",
                     "it": f"{Ts} tira il fiato: il pressing {goes} {v}." if fall else f"Che lavoro {of}: il pressing {goes} {v}.",
                     "es": f"{Ts} toma aire: la presión {goes} {v}." if fall else f"¡Cómo aprieta {T}! La presión {goes} {v}."},
             "other": {"en": f"{Ts} ease off: their press {goes} {v}." if fall else f"{Ts} won't let up: their press {goes} {v}.",
                       "it": f"{Ts} rallenta: il pressing {goes} {v}." if fall else f"{Ts} non molla: il pressing {goes} {v}.",
                       "es": f"{Ts} afloja: la presión {goes} {v}." if fall else f"{Ts} no afloja: la presión {goes} {v}."}}[role][lang]]


def shift(m, s, role, lang):
    path = rules.line_path(s)
    if s.get("shape") or not path or role == "player":
        return []  # a change of shape is told by the template, the same words for everyone
    tid, up = s["team_id"], path["direction"] == "higher"
    T, Ts, of = team(m, tid, lang), team(m, tid, lang, start=True), _of(m, tid, lang)
    a = f"{whole(path['from']['value'])} m {when(m, path['from']['ts'], lang)}"
    b = f"{whole(path['to']['value'])} m {when(m, path['to']['ts'], lang, False)}"
    bm = f"{whole(path['to']['value'])} m"
    k = 0 if up else 1
    return [{"analyst": {"en": f"{T}'s defensive line height goes from {a} to {b}.",
                         "it": f"Altezza della linea difensiva {of}: da {a} a {b}.",
                         "es": f"Altura de la línea defensiva {of}: de {a} a {b}."},
             "casual": {"en": (f"{Ts} move their defence higher, up to {bm}.", f"{Ts} drop their defence deeper, back to {bm}.")[k],
                        "it": (f"{Ts} alza la difesa fino a {bm} dalla propria porta.",
                               f"{Ts} abbassa la difesa fino a {bm} dalla propria porta.")[k],
                        "es": (f"{Ts} adelanta la defensa hasta {bm}.", f"{Ts} retrasa la defensa hasta {bm}.")[k]},
             "kids": {"en": (f"{Ts} move their players further forward.", f"{Ts} move their players further back.")[k],
                      "it": (f"{Ts} fa salire i suoi giocatori.", f"{Ts} fa arretrare i suoi giocatori.")[k],
                      "es": (f"{Ts} adelanta sus líneas.", f"{Ts} retrasa sus líneas.")[k]},
             "own": {"en": (f"{Ts} get brave: their defensive line moves up to {bm}.",
                            f"{Ts} sit tight: their defensive line drops back to {bm}.")[k],
                     "it": (f"{Ts} alza il baricentro: linea difensiva fino a {bm} dalla propria porta.",
                            f"{Ts} si compatta: linea difensiva a {bm} dalla propria porta.")[k],
                     "es": (f"{Ts} da un paso adelante: su línea defensiva sube hasta {bm}.",
                            f"{Ts} se repliega: su línea defensiva baja hasta {bm}.")[k]},
             "other": {"en": (f"{Ts} come higher: their defensive line is up to {bm}.",
                              f"{Ts} sit back: their defensive line is down to {bm}.")[k],
                       "it": (f"{Ts} si alza: la sua linea difensiva arriva a {bm} dalla propria porta.",
                              f"{Ts} si abbassa: la sua linea difensiva arretra a {bm} dalla propria porta.")[k],
                       "es": (f"{Ts} adelanta líneas: su defensa llega a {bm}.", f"{Ts} se encierra: su defensa baja hasta {bm}.")[k]}}[role][lang]]


def comeback(m, s, role, lang):
    if m.lead(s["ts"])[0] is not None or role == "player":
        return []
    tid = s["team_id"]
    T, Ts, sx, at = team(m, tid, lang), team(m, tid, lang, start=True), rules.score_text(m, s["ts"], lang), when(m, s["ts"], lang)
    return [{"analyst": {"en": f"{Ts} equalise {at}: it's {sx}.", "it": f"{cap(at)} {T} pareggia i conti: {sx}.", "es": f"{Ts} empata {at}: {sx}."},
             "casual": {"en": f"{Ts} are back on level terms at {sx}.", "it": f"{Ts} torna in parità: {sx}.", "es": f"{Ts} iguala el partido: {sx}."},
             "kids": {"en": f"{Ts} never give up, and now it's {sx}!", "it": f"{Ts} ce la fa: adesso è {sx}!",
                      "es": f"¡{Ts} nunca se rinde! ¡Ya es {sx}!"},
             "own": {"en": f"{Ts} fight back to {sx}!", "it": f"{Ts} non si arrende: {sx}!", "es": f"¡{Ts} no se rinde y empata, {sx}!"},
             "other": {"en": f"The lead is gone: {T} level at {sx}.", "it": f"Vantaggio sfumato: {T} pareggia, {sx}.",
                       "es": f"Se esfuma la ventaja {_of(m, _other(m, tid), lang)}: {T} empata, {sx}."}}[role][lang]]


def recap(m, s, role, lang, fan=None):
    full = pb.recap_line(m, s, lang, "calm", "", None)
    if role == "analyst":
        return [full]
    if role == "casual":
        return [full.split(". ")[0].rstrip(".") + "."]
    if role == "player":
        return []
    ft, (leader, _) = s["phase"] == "ft", m.lead(s["ts"])
    sx = rules.score_text(m, s["ts"], lang)
    L, Ls = (team(m, leader, lang, full=True), team(m, leader, lang, full=True, start=True)) if leader else ("", "")
    if role == "kids":
        r = ("ft" if ft else "ht") + ("_win" if leader else "_level")
        return [{"en": {"ft_win": f"Full time! {L} win {sx}. Well played, everyone!", "ft_level": f"Full time! It ends {sx}. Well played, everyone!",
                        "ht_win": f"Half-time! {L} lead {sx}. Time for a rest.", "ht_level": f"Half-time! It's {sx}. Time for a rest."},
                 "it": {"ft_win": f"È finita! Vince {L}, {sx}. Bravi tutti!", "ft_level": f"È finita {sx}. Bravi tutti!",
                        "ht_win": f"Intervallo! {Ls} è avanti, {sx}. Ora si riposa.", "ht_level": f"Intervallo! È {sx}. Ora si riposa."},
                 "es": {"ft_win": f"¡Se acabó! Gana {L}, {sx}. ¡Buen partido!", "ft_level": f"¡Se acabó! Empate, {sx}. ¡Buen partido!",
                        "ht_win": f"¡Descanso! {Ls} va ganando, {sx}. Ahora toca reponer fuerzas.",
                        "ht_level": f"¡Descanso! Van empatados, {sx}. Ahora toca reponer fuerzas."}}[lang][r]]
    T, Ts, per = team(m, fan, lang, full=True), team(m, fan, lang, full=True, start=True), _for(m, fan, lang)
    r = ("ft" if ft else "ht") + ("_draw" if not leader else "_win" if leader == fan else "_loss")
    return [{"en": {"ft_win": f"Full time: {T} win {sx}. What a day!", "ft_loss": f"Full time: {L} win {sx}. A tough day for {T}.",
                    "ft_draw": f"Full time: it ends {sx}, a point for {T}.", "ht_win": f"Half-time: {T} lead {sx}. Keep it going!",
                    "ht_loss": f"Half-time: {L} lead {sx}. Still time for {T}.", "ht_draw": f"Half-time: it's {sx}, and {T} are still in it."},
             "it": {"ft_win": f"Finisce {sx} per {T}: che giornata!", "ft_loss": f"Finisce {sx} per {L}: giornata amara {per}.",
                    "ft_draw": f"Finisce {sx}: un punto {per}.", "ht_win": f"Fine primo tempo: {sx} per {T}, avanti così!",
                    "ht_loss": f"Fine primo tempo: {sx} per {L}. {Ts} ha tutta la ripresa per rimediare.",
                    "ht_draw": f"Fine primo tempo: {sx}. Per {T} è tutto aperto."},
             "es": {"ft_win": f"Final del partido: {T} gana {sx}. ¡Qué alegría!", "ft_loss": f"Final del partido: {L} gana {sx}. Día duro {per}.",
                    "ft_draw": f"Final del partido: empate, {sx}. Un punto {per}.", "ht_win": f"Descanso: {T} gana {sx}. ¡A seguir así!",
                    "ht_loss": f"Descanso: {L} gana {sx}. {team(m, fan, lang, 'a', start=True)} le queda la segunda parte para remontar.", "ht_draw": f"Descanso: empate, {sx}. Todo abierto {per}."}}[lang][r]]


LINES = {"goal": goal, "big_chance": chance, "top_sprint": sprint, "momentum_swing": momentum,
         "pressing_spell": pressing, "tactical_shift": shift, "comeback": comeback, "recap": recap}


def roles(m, s):
    """(audience, role, fan team) for every audience this story has a line for."""
    out = [("analyst", "analyst", None), ("casual", "casual", None), ("kids", "kids", None)]
    for t in m.teams:
        if s["kind"] == "recap":
            out.append((f"team:{t}", "fan", t))
        elif s["team_id"]:
            out.append((f"team:{t}", "own" if t == s["team_id"] else "other", t))
    if s["player_id"]:
        out.append((f"player:{s['player_id']}", "player", None))
    return out


def candidates(m, s, role, lang, fan=None):
    line = LINES.get(s["kind"])
    if not line or (s["player_id"] and not pb.player(m, s)):
        return []
    got = line(m, s, role, lang, fan) if s["kind"] == "recap" else line(m, s, role, lang)
    return [x for x in got if x]


def compose(m, s):
    """{audience: {en, it, es}}: each audience whose line passes every check in all three languages."""
    out = {}
    for aud, role, fan in roles(m, s):
        texts = {}
        for lang in rules.LANGS:
            texts[lang] = next((x for x in candidates(m, s, role, lang, fan) if not pb.problems(m, s, x, lang)), None)
            if not texts[lang]:
                break
        else:
            out[aud] = texts
    return out


def text_for(story, audience, lang):
    """The line an audience sees on air: its own, else the casual one (not for the analyst), else `texts`."""
    own = story.get("texts_by_audience") or {}
    if audience != "analyst":
        for k in (audience, "casual"):
            if lang in own.get(k, {}):
                return own[k][lang]
    return story["texts"][lang]


# --- player check-ins --------------------------------------------------------------------------------

CHECKIN = {  # (one, many) per line; a count of 0 sprints is said in words
    "en": {"touches": ("{} touch", "{} touches"), "passes": ("{} pass completed", "{} passes completed"),
           "distance": "{} km covered", "sprints": ("{} sprint", "{} sprints"), "none": "No sprints yet",
           "top": "Top speed {} km/h", "title": "{}, {}'"},
    "it": {"touches": ("{} tocco", "{} tocchi"), "passes": ("{} passaggio riuscito", "{} passaggi riusciti"),
           "distance": "{} km percorsi", "sprints": ("{} scatto", "{} scatti"), "none": "Ancora nessuno scatto",
           "top": "Velocità massima {} km/h", "title": "{} al {}'"},
    "es": {"touches": ("{} toque", "{} toques"), "passes": ("{} pase acertado", "{} pases acertados"),
           "distance": "{} km recorridos", "sprints": ("{} sprint", "{} sprints"), "none": "Todavía sin sprints",
           "top": "Velocidad máxima {} km/h", "title": "{}, minuto {}"},
}


def checkin_payload(m, pid, facts, lang):
    """The card for one player at one check-in, from its checkin_* facts (kind -> fact)."""
    w = CHECKIN[lang]
    n = lambda k, v: w[k][v != 1].format(whole(v))  # noqa: E731
    lines = [n("touches", facts["checkin_touches"]["value"]), n("passes", facts["checkin_passes"]["value"]),
             w["distance"].format(rules.fmt(facts["checkin_distance"]["value"], lang))]
    sprints = facts["checkin_sprints"]["value"]
    lines.append(n("sprints", sprints) if sprints else w["none"])
    if "checkin_top_speed" in facts:
        lines.append(w["top"].format(rules.fmt(facts["checkin_top_speed"]["value"], lang)))
    f = facts["checkin_touches"]
    mi = rules.minute(f["ts"], f["period"], m.p1 or math.inf)
    title = w["title"].format(m.required_name(pid) or m.player_name(pid), mi)
    return {"kind": "checkin", "title": title, "body": "\n".join(lines),
            "fact_ids": [facts[k]["fact_id"] for k in CHECKIN_KINDS if k in facts]}


def checkin_cues(m, meta, facts, cues):
    """A check-in card for each followed player at 15', 30', 45', 60', 75', 90', in the first slot of the
    next 30 s where nothing else of that audience is on screen and the card ends before the period does."""
    p1, end = meta["period1_s"], meta["period1_s"] + meta["period2_s"]
    by = {}
    for f in facts:
        if f["kind"] in CHECKIN_KINDS:
            by.setdefault((f["player_id"], f["ts"]), {})[f["kind"]] = f
    out = []
    for aud in sorted({c["audience"] for c in cues if c["audience"].startswith("player:")}):
        pid = aud.split(":", 1)[1]
        mine = [c for c in cues if c["audience"] == aud]
        for (p, ts), group in sorted(by.items(), key=lambda x: x[0][1]):
            if p != pid or "checkin_touches" not in group:
                continue
            stop = p1 if ts <= p1 else end
            t = next((t for k in range(int(CHECKIN_WAIT_S / CHECKIN_STEP_S) + 1)
                      if (t := round(ts + k * CHECKIN_STEP_S, 1)) + CHECKIN_S <= stop
                      and not any(c["ts"] < t + CHECKIN_S and t < c["ts"] + c["duration_s"] for c in mine)), None)
            if t is None:
                continue  # no free slot: the card is dropped, never stacked
            langs = sorted({c["lang"] for c in mine}) or ["en"]
            for lang in langs:
                out.append({"match_id": meta["match_id"], "cue_id": "", "story_id": None, "ts": t, "duration_s": CHECKIN_S,
                            "graphic": "why_card", "audience": aud, "lang": lang,
                            "payload": checkin_payload(m, pid, group, lang)})
    return out


STATS_KINDS = ("formation", "line_height", "team_length", "team_width", "press_intensity")  # the rows, in order
STATS_S = 10.0        # how long the team shape panel stays up
STATS_WAIT_S = 60.0   # how late after its window it may air
# The window of the facts as the panel's header says it; display_label gives "min 6-10" or a stoppage time.
WINDOW = {"en": ("Min {}", "First-half stoppage time", "Second-half stoppage time"),
          "it": ("Minuti {}", "Recupero del primo tempo", "Recupero del secondo tempo"),
          "es": ("Minutos {}", "Descuento de la primera parte", "Descuento de la segunda parte")}


def _window_text(f, lang):
    label, w = rules.display_label(f), WINDOW.get(lang, WINDOW["en"])
    if "stoppage time" in label:
        return w[1] if label.endswith("first-half stoppage time") else w[2]
    return w[0].format(re.search(r"\bmin (\S+)$", label).group(1))


def _stat_text(f, lang):
    """A team fact as the panel shows it: "4-3-3", "30,8 m", "4,2/10"."""
    if f["unit"] == "formation":
        return "-".join(str(round(f["value"])))
    return rules.fmt(f["value"], lang) + (" m" if f["unit"] == "m" else f["unit"])


def stats_payload(m, group, lang):
    """The team shape panel for one window from its team facts ((team_id, kind) -> fact)."""
    home, away = m.home["team_id"], m.away["team_id"]
    rows = [{"stat": k, "home": _stat_text(group[home, k], lang), "away": _stat_text(group[away, k], lang),
             "home_v": None if k == "formation" else group[home, k]["value"],
             "away_v": None if k == "formation" else group[away, k]["value"]} for k in STATS_KINDS]
    return {"when": _window_text(group[home, STATS_KINDS[1]], lang), "rows": rows,
            "fact_ids": [group[t, k]["fact_id"] for k in STATS_KINDS for t in (home, away)]}


def stats_cues(m, meta, facts, cues):
    """The analyst's team shape panel at the end of every 5-minute window with all five measures for both
    teams: the first slot of the next 60 s where no other analyst cue is on screen (timed on the English
    sheet) and the panel ends before the period does, else dropped. One cue per analyst language."""
    p1, end = meta["period1_s"], meta["period1_s"] + meta["period2_s"]
    teams = (m.home["team_id"], m.away["team_id"])
    by = {}
    for f in facts:
        if f["kind"] in STATS_KINDS and f["player_id"] is None:
            by.setdefault(f["ts"], {})[f["team_id"], f["kind"]] = f
    analyst = [c for c in cues if c["audience"] == "analyst"]
    timing = [c for c in analyst if c["lang"] == "en"]
    langs = sorted({c["lang"] for c in analyst})
    out = []
    for ts, group in sorted(by.items()):
        if not all((t, k) in group for t in teams for k in STATS_KINDS):
            continue
        stop = p1 if ts <= p1 else end
        t = next((t for k in range(int(STATS_WAIT_S / CHECKIN_STEP_S) + 1)
                  if (t := round(ts + k * CHECKIN_STEP_S, 1)) + STATS_S <= stop
                  and not any(c["ts"] < t + STATS_S and t < c["ts"] + c["duration_s"] for c in timing)), None)
        if t is None:
            continue  # no free slot: the panel is dropped, never stacked
        cue = {"match_id": meta["match_id"], "cue_id": "", "story_id": None, "ts": t, "duration_s": STATS_S,
               "graphic": "team_stats", "audience": "analyst"}
        out += [{**cue, "lang": lang, "payload": stats_payload(m, group, lang)} for lang in langs]
        timing.append(cue)
    return out


# --- no empty minutes ---------------------------------------------------------------------------------

LINEUP_S = 15.0       # the starting line-ups at kick-off
MOMENTUM_S = 8.0      # as the template momentum cue (export.DURATION)
FILL_WAIT_S = 60.0    # how late after its facts a filler may air
# The longest stretch of play an audience may go with nothing on screen (docs/desk.md, "No empty minutes"):
# the analyst gets the team measures of every 5-minute window, the casual and kids sheets one window plus a
# minute for a free slot.
MAX_GAP_S = {"analyst": 300.0, "casual": 360.0, "kids": 360.0}
LINES_ORDER = ("GK", "DF", "MF", "FW")


def gaps(cues, meta, audience, lang="en"):
    """[(from, to)]: the stretches of play, kick-off to half-time and the second half to full time, with no
    cue of `audience` in `lang` on screen."""
    p1, end = meta["period1_s"], meta["period1_s"] + meta["period2_s"]
    iv = sorted((c["ts"], c["ts"] + c["duration_s"]) for c in cues if c["audience"] == audience and c["lang"] == lang)
    out = []
    for a, b in ((0.0, p1), (p1, end)):
        t = a
        for s, e in iv:
            if e > t and s < b:
                if s > t:
                    out.append((t, s))
                t = max(t, e)
        if t < b:
            out.append((t, b))
    return out


def momentum_payload(momentum, ts, home, away):
    """The momentum graphic at a window end: every window so far, home and away (the template cue's payload)."""
    so_far = [f for f in momentum if f["ts"] <= ts]
    return {"home": [f["value"] for f in so_far if f["team_id"] == home],
            "away": [f["value"] for f in so_far if f["team_id"] == away],
            "window": len({f["ts"] for f in so_far}), "fact_ids": [f["fact_id"] for f in so_far]}


def lineup_payload(m, meta, facts):
    """The starting line-ups: per team its team-sheet formation (the start_formation fact) and its starters
    by line, keeper first, each line by shirt. None when a team has no start_formation fact."""
    form = {f["team_id"]: f for f in facts if f["kind"] == "start_formation"}
    starters = {x["player_id"] for x in meta["lineups"] if x["starter"]}
    teams = []
    for t in (m.home, m.away):
        f = form.get(t["team_id"])
        if not f:
            return None
        ps = sorted((p for p in meta["players"] if p["team_id"] == t["team_id"] and p["player_id"] in starters),
                    key=lambda p: p["shirt"])
        teams.append({"side": t["side"], "formation": _stat_text(f, "en"),
                      "lines": [[{"player_id": p["player_id"], "shirt": p["shirt"], "name": m.required_name(p["player_id"])}
                                 for p in ps if p["position"] == k] for k in LINES_ORDER]})
    return {"teams": teams, "fact_ids": [form[m.home["team_id"]]["fact_id"], form[m.away["team_id"]]["fact_id"]]}


def _fillers(m, meta, facts):
    """(ts, graphic, duration, payload by lang) that may fill a quiet spell, in time order: the momentum of every
    5-minute window, and at every check-in the card of the player with the most touches so far."""
    home, away = m.home["team_id"], m.away["team_id"]
    momentum = sorted((f for f in facts if f["kind"] == "momentum"), key=lambda f: f["ts"])
    out = [(ts, "momentum", MOMENTUM_S, lambda lang, ts=ts: momentum_payload(momentum, ts, home, away))
           for ts in sorted({f["ts"] for f in momentum})]
    by = {}
    for f in facts:
        if f["kind"] in CHECKIN_KINDS:
            by.setdefault(f["ts"], {}).setdefault(f["player_id"], {})[f["kind"]] = f
    for ts, players in sorted(by.items()):
        full = {p: g for p, g in players.items() if all(k in g for k in CHECKIN_KINDS[:4])}
        if full:  # most touches, then the lower player id: the same card on every run
            pid = min(full, key=lambda p: (-full[p]["checkin_touches"]["value"], p))
            out.append((ts, "why_card", CHECKIN_S, lambda lang, pid=pid, g=full[pid]: checkin_payload(m, pid, g, lang)))
    return sorted(out, key=lambda x: (x[0], x[1]))


def fill_cues(m, meta, facts, cues, held=()):
    """The starting line-ups at kick-off for the analyst, casual and kids sheets, then, while a stretch of play
    longer than MAX_GAP_S has nothing of that audience on screen, the filler that starts latest within MAX_GAP_S
    of the stretch's start (no earlier than its facts, at most FILL_WAIT_S after them), in the first slot that
    overlaps no cue of the audience and ends before the period's end. The stretches count only what airs
    untouched: the cues of `held` stories (waiting for the producer) may never air, so they leave a stretch
    open, yet a filler keeps clear of them. One cue per language of the audience's sheet, timed on the
    English one."""
    p1, end = meta["period1_s"], meta["period1_s"] + meta["period2_s"]
    lineup, fillers = lineup_payload(m, meta, facts), _fillers(m, meta, facts)
    out = []
    for aud, most in MAX_GAP_S.items():
        mine = [c for c in cues if c["audience"] == aud]
        if not mine:
            continue
        langs = sorted({c["lang"] for c in mine})
        timing = [c for c in mine if c["lang"] == "en"]
        aired = {(c["graphic"], c["ts"]) for c in timing}

        def add(ts, graphic, dur, payload):
            cue = {"match_id": meta["match_id"], "cue_id": "", "story_id": None, "ts": ts, "duration_s": dur,
                   "graphic": graphic, "audience": aud}
            out.extend({**cue, "lang": lang, "payload": payload(lang)} for lang in langs)
            timing.append({**cue, "lang": "en"})

        def slot(f, a):  # the first free start for filler f in the stretch from a, or None
            t, last, stop = max(f[0], a), min(a + most, f[0] + FILL_WAIT_S), p1 if f[0] < p1 else end
            while t <= last and t + f[2] <= stop:
                if not any(c["ts"] < t + f[2] and t < c["ts"] + c["duration_s"] for c in timing):
                    return round(t, 1)
                t += CHECKIN_STEP_S
            return None

        if lineup and not any(c["ts"] < LINEUP_S for c in timing):
            add(0.0, "lineup", LINEUP_S, lambda lang: lineup)
        left = [f for f in fillers if (f[1], f[0]) not in aired]
        while True:
            pick = None
            for a, b in gaps([c for c in timing if c["story_id"] not in held], meta, aud):
                if b - a <= most:
                    continue
                ok = [(t, f) for f in left if (f[0] < p1) == (a < p1) and (t := slot(f, a)) is not None]
                if ok:
                    pick = max(ok, key=lambda x: x[0])
                    break
            if not pick:
                break
            t, f = pick
            left.remove(f)
            add(t, f[1], f[2], f[3])
    return out


# --- applying it to a replay -------------------------------------------------------------------------

def _generated(c):
    return (c["audience"] == "kids" or c["payload"].get("kind") == "checkin" or c["graphic"] in ("team_stats", "lineup")
            or (c["graphic"] == "momentum" and c["story_id"] is None and c["audience"] != "analyst"))


def apply(meta, facts, events, stories, cues):
    """Stories with `texts_by_audience`, and the cue sheet with each audience's line in its why_card
    cues, a kids sheet copied from the casual one, the player check-ins and the analyst's team shape panels.
    Idempotent: the kids, check-in and team shape cues of an earlier run are rebuilt, the other cue ids are kept."""
    m = rules.Match(meta)
    m.facts = {f["fact_id"]: f for f in facts}
    ev = {e["event_id"]: e for e in events}
    stories = [{**s, "texts_by_audience": compose(m, rules.pack_story(m, s, ev))} for s in stories]
    for s in stories:  # an "again" in any line cites the earlier goal or shot it means
        pb.cite_again(m, s, s["texts"], *s["texts_by_audience"].values())
    by_id = {s["story_id"]: s for s in stories}
    base = [c for c in cues if not _generated(c)]

    def worded(c, audience):
        s = by_id.get(c["story_id"])
        if c["graphic"] != "why_card" or not s or c["lang"] not in s["texts"]:
            return {**c, "audience": audience}
        cited = [f["fact_id"] for f in pb.backing(m, s) if f["fact_id"] in s["fact_ids"]]  # what an "again" means
        ids = list(dict.fromkeys([*c["payload"].get("fact_ids", []), *cited]))
        return {**c, "audience": audience, "payload": {**c["payload"], "body": text_for(s, audience, c["lang"]), "fact_ids": ids}}

    base = [worded(c, c["audience"]) for c in sorted(base, key=lambda c: c["cue_id"])]  # same ids on a rerun
    extra = [worded(c, "kids") for c in base if c["audience"] == "casual"]
    extra += checkin_cues(m, meta, facts, base)
    extra += stats_cues(m, meta, facts, base)
    held = {s["story_id"] for s in stories if s.get("default_status") != "auto_approved"}  # may never air
    extra += fill_cues(m, meta, facts, base + extra, held)
    n = max((int(c["cue_id"][2:]) for c in base if c["cue_id"].startswith("C-")), default=0)
    for i, c in enumerate(extra, n + 1):
        c["cue_id"] = f"C-{i:06d}"
    return stories, sorted(base + extra, key=lambda c: (c["ts"], c["audience"], c["lang"], c["cue_id"]))


def apply_pack(match_id, conn, pack_dir):
    """Rewrite replays/<match_id>/stories.json and cues.json in place, offline, from the matches database."""
    from .. import export
    meta = export.meta(conn, match_id)
    events = export._all(conn, "SELECT * FROM events WHERE match_id = ? ORDER BY ts, event_id", (match_id,))
    facts = export._parsed(export._all(conn, "SELECT * FROM facts WHERE match_id = ? ORDER BY ts, fact_id", (match_id,)),
                           "source_event_ids", "source_frames")
    d = Path(pack_dir)
    stories, cues = apply(meta, facts, events, json.loads((d / "stories.json").read_text()),
                          json.loads((d / "cues.json").read_text()))
    for name, rows in (("stories", stories), ("cues", cues)):
        export._dump(d / f"{name}.json", rows)
    return stories, cues


if __name__ == "__main__":
    from .. import config, db
    ap = argparse.ArgumentParser(prog="python -m studiodesk.agents.audiences")
    ap.add_argument("match_id")
    ap.add_argument("--db", type=Path, default=config.MATCHES_DB)
    ap.add_argument("--pack", type=Path, required=True, help="the replay pack to rewrite, e.g. replays/M001")
    args = ap.parse_args()
    with closing(db.connect(args.db, readonly=True)) as conn:
        st, cu = apply_pack(args.match_id, conn, args.pack)
    print(f"{args.pack}: {sum(len(s['texts_by_audience']) for s in st)} audience lines over {len(st)} stories, {len(cu)} cues")
