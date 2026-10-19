"""The lines that go on air by themselves: composed by code from pieces written by native commentators.

Every piece of colour carries the fact condition that makes it true ("What a hit!" only for a shot of
100 km/h or more, "strikes again" only for a player's second goal or later). The story finder chooses
the tone (calm or lively) and the focus (where the shot came from, how far out, how hard it was hit);
the code chooses the words. The model's own lines stay on the desk as a proposal.
"""
import math
import re

from . import rules

TONES = ("calm", "lively")
LOUD_SPRINT_KMH = 35.0
GOAL_OF_THE_DAY_M = 20.0   # "What a goal!" from this far out
CHANCE_M = 11.0            # "What a chance!" from this close
SIDE = {"right": ("right", "destra", "derecha"), "left": ("left", "sinistra", "izquierda")}
METRES = ("metres", "metri", "metros")


# --- small pieces ---------------------------------------------------------------------------------

def short(name):
    """A club as a commentator calls it after the first mention: "Harbour Vale", "Redwick"."""
    # shortcut: a fixed list of suffixes, enough for the generated league; extend it with new suffixes
    return re.sub(r"\s+(?:FC|AFC|Town|Borough|Harriers|Wanderers|Sporting Club|United|City|Rovers|Athletic)$", "",
                  name or "")


def team(m, tid, lang, prep=None, start=False, full=False):
    name = m.team_name(tid)
    return rules.club(name if full else short(name), lang, prep, start)


def cap(text):
    return text[:1].upper() + text[1:]


def whole(v):
    return str(math.floor(v + 0.5))


def metres(v, lang):
    return f"{rules.fmt(v, lang) if v < 10 else whole(v)} {METRES[rules.LANGS.index(lang)]}"


def _label(m, ts):
    period = m.period_of(ts)
    mi = rules.minute(ts, period, m.p1 or math.inf)
    return mi, period, mi > (45 if period == 1 else 90), rules.stoppage(mi, period)


def when(m, ts, lang, first=True):
    """The minute of a moment: "in the 41st minute" or "in stoppage time"; "al 41'", "all'81'", "al 90+3'";
    "en el minuto 41". A later minute in the same line is shorter: "by the 45th", "al 45'", "en el 45"."""
    mi, _, extra, label = _label(m, ts)
    if lang == "en":
        if extra:
            return "in stoppage time" if first else f"at {label}'"
        return f"in the {rules.ordinal(mi)} minute" if first else f"by the {rules.ordinal(mi)}"
    if lang == "it":
        return ("all'" if not extra and (mi in (1, 8, 11) or 80 <= mi <= 89) else "al ") + f"{label}'"
    return f"en el minuto {label}" if first else f"en el {label}"


def value(story, kind):
    return next((f["value"] for f in story["facts"] if f["kind"] == kind), None)


def player(m, story):
    return m.required_name(story["player_id"])


# --- shots ----------------------------------------------------------------------------------------

def place_from(place, lang):
    """Where a shot came from, as the start of a "from ..." phrase in lang; None without a place."""
    if not place:
        return None
    i = rules.LANGS.index(lang)
    side = SIDE[place["side"]][i] if place["side"] else None
    zone = place["zone"]
    if zone == "edge" and place["depth"] > 20.0:
        zone = "outside"  # 21 m out is outside the box, not its edge
    if zone == "six_yard":
        return ("from inside the six-yard box", "dall'area piccola", "desde el área pequeña")[i]
    if zone == "byline":
        if place["offset"] <= rules.BOX_HALF_WIDTH:
            return (f"from a tight angle on the {side}", f"da posizione defilata sulla {side}",
                    f"con poco ángulo, desde la {side}")[i]
        return (f"from near the byline on the {side}", f"dalla linea di fondo, sulla {side}",
                f"desde la línea de fondo, por la {side}")[i]
    if zone == "box":
        if not side:
            return ("from the middle of the box", "dal centro dell'area", "desde el centro del área")[i]
        return (f"from the {side} side of the box", f"dalla {side} dell'area", f"desde la {side} del área")[i]
    if zone == "edge":
        return ("from the edge of the box", "dal limite dell'area", "desde la frontal del área")[i]
    base = ("from outside the box", "da fuori area", "desde fuera del área")[i]
    return base + (("", f" on the {side}", f", sulla {side}", f", por la {side}")[i + 1] if side else "")


def shot_focus(story):
    info = rules.shot_info(story) or {}
    out = ["place"] if info.get("place") else []
    # "from 9.3 metres" reads like a data sheet: a close shot is told by its place
    out += ["distance"] if info.get("dist") is not None and (info["dist"] >= CHANCE_M or not out) else []
    out += ["power"] if not info.get("header") and value(story, "shot_speed") else []
    return out


def where(story, lang, focus):
    """The "from ..." phrase of the focus: the place, the distance, or the speed ("at 104 km/h")."""
    info = rules.shot_info(story)
    if focus == "place":
        return place_from(info["place"], lang)
    if focus == "distance":
        return ("from {} out", "da {}", "desde {}")[rules.LANGS.index(lang)].format(metres(info["dist"], lang))
    return ("at {} km/h", "a {} km/h", "a {} km/h")[rules.LANGS.index(lang)].format(whole(value(story, "shot_speed")))


def closed(w, lang):
    """"da fuori area, sulla destra, all'81'": the side closed by a comma before the minute (Italian, Spanish)."""
    return f"{w}," if lang != "en" and w and "," in w else w


def turn(m, story):
    """How many shots came before this one: rotates the stock words, so two chances in a row differ."""
    return sum(f["ts"] < story["ts"] - 1e-6 for f in m.kind("shot_speed"))


def score_clause(m, story, lang):
    """What the goal did to the score, with the leader named next to it."""
    t, ts = story["team_id"], story["ts"]
    leader, s = m.lead(ts)[0], rules.score_text(m, ts, lang)
    was = m.lead(ts - 1e-3)[0]
    T, L = team(m, t, lang), team(m, leader, lang) if leader else ""
    key = "level" if leader is None else "behind" if leader != t else "up" if was is None else "more"
    return {"en": {"up": f"{T} lead {s}", "more": f"{T} extend their lead to {s}", "level": f"it's {s}",
                   "behind": f"{T} pull one back, but {L} still lead {s}"},
            "it": {"up": f"{T} passa in vantaggio, {s}", "more": f"{T} allunga, {s}", "level": f"{T} pareggia, {s}",
                   "behind": f"{T} accorcia, ma {L} resta avanti, {s}"},
            "es": {"up": f"{T} se pone por delante, {s}", "more": f"{T} amplía la ventaja, {s}",
                   "level": f"{T} empata, {s}", "behind": f"{T} recorta distancias, pero {L} sigue por delante, {s}"},
            }[lang][key]


def earlier_goals(m, story):
    return [f for f in m.kind("score") if f["player_id"] == story["player_id"] and f["ts"] < story["ts"] - 1e-6]


def tried_before(m, story):
    """True when the player had a shot earlier in the match: "tries again" is then true."""
    return any(f["player_id"] == story["player_id"] and f["ts"] < story["ts"] - 1.0 for f in m.kind("shot_speed"))


def goal_line(m, story, lang, tone, focus, opener, form=0):
    """form 0 starts with the player (English, Spanish) or the minute (Italian), form 1 the other way round."""
    if form > 1 or (opener == "again" and form):
        return None
    info, P, at = rules.shot_info(story), player(m, story), when(m, story["ts"], lang)
    w, head, speed = where(story, lang, focus), info["header"], value(story, "shot_speed") or 0.0
    score = score_clause(m, story, lang)
    if lang == "en":
        if opener == "again":
            w = f"with a {whole(speed)} km/h shot" if focus == "power" else f"with a header {w}" if head else w
            return f"{P} strikes again {w} {at}: {score}."
        verb = "heads home" if head else "fires one in" if focus == "power" else \
            "drills one in" if tone == "lively" and speed >= 95 else "scores"
        return f"{P} {verb} {w} {at}: {score}." if not form else f"{cap(at)}, {P} {verb} {w}: {score}."
    if lang == "it":
        w = f"con un tiro a {whole(speed)} km/h" if focus == "power" else w
        verb = f"segna di testa {w}" if head else f"segna {w}"
        if opener == "again":
            return f"Ancora {P}! {cap(at)} {verb}: {score}."
        return f"{cap(at)} {P} {verb}: {score}." if not form else f"{P} {closed(verb, lang)} {at}: {score}."
    w = f"con un disparo a {whole(speed)} km/h" if focus == "power" else w
    what = "Gol de cabeza" if head else "Gol"
    if opener == "again":
        return f"¡Otra vez {P}! {what} {closed(w, lang)} {at}: {score}."
    if form:
        return f"{cap(at)}, {P} marca {'de cabeza ' if head else ''}{w}: {score}."
    if opener == "golazo":  # "¡Qué golazo! Gol de ..." says it twice
        return f"{P} marca {closed(w, lang)} {at}: {score}."
    return f"{what} de {P} {closed(w, lang)} {at}: {score}."


OUTCOME = {"en": {"saved": ", but the keeper keeps it out", "wide": ", but it goes wide", "over": ", but it goes over the bar",
                  "blocked": ", but it's blocked"},
           "it": {"saved": "para il portiere", "wide": "a lato", "over": "sopra la traversa",
                  "blocked": "lo mura un difensore"},
           "es": {"saved": "lo para el portero", "wide": "se marcha desviado", "over": "se va por encima del larguero",
                  "blocked": "lo rechaza un defensa"}}
# a save said three ways, in turn; after "Che parata!" / "¡Qué parada!" never "para" again
SAVED = {"en": (", but the keeper keeps it out", ", but it's saved", ", but the keeper is equal to it"),
         "it": ("para il portiere", "il portiere ci arriva", "risponde il portiere"),
         "es": ("lo para el portero", "responde el portero", "se la saca el portero")}
OVER_ES = ("se va por encima del larguero", "se le va alta")
WITH_SHOT = ("with a shot at {} km/h", "con un tiro a {} km/h", "con un disparo a {} km/h")


def outcome(m, story, lang, out, opener):
    k = turn(m, story)
    if out == "saved":
        ways = SAVED[lang][1:] if opener == "save" and lang != "en" else SAVED[lang]
        return ways[k % len(ways)]
    if out == "over" and lang == "es":
        return OVER_ES[k % 2]
    return OUTCOME[lang][out]


def chance_line(m, story, lang, tone, focus, opener, form=0):  # noqa: ARG001 - same signature as the other lines
    """form 0 starts with the player (Italian: the minute), form 1 the other way round, form 2 says the
    player tries again (only when they shot earlier in the match), form 3 names the chance first."""
    info, P, at = rules.shot_info(story), player(m, story), when(m, story["ts"], lang)
    w, head, out = where(story, lang, focus), info["header"], info["outcome"]
    if out not in OUTCOME["en"] or form > 3 or (form == 2 and not tried_before(m, story)) or (form == 3 and opener == "chance"):
        return None
    far = (info["dist"] or 0) >= 16.0 and focus == "place"
    end = outcome(m, story, lang, out, opener)
    # "tries again" and "a chance for" need the shot named: "with a shot at 104 km/h", not ", at 104 km/h"
    shot = WITH_SHOT[rules.LANGS.index(lang)].format(whole(value(story, "shot_speed") or 0)) if focus == "power" else w
    if lang == "en":
        end = ", but it goes over" if head and out == "over" else end
        hits = [v for v in ("hits it", "lets fly", "strikes it") if v != {"hit": "hits it", "strike": "strikes it"}.get(opener)]
        verb = "heads" if head else hits[turn(m, story) % len(hits)] if focus == "power" else \
            "lets fly" if tone == "lively" and far else "shoots"
        if form == 2:
            return f"{P} tries again {'with a header ' if head else ''}{shot} {at}{end}."
        if form == 3:
            return f"A chance for {P} {at}, {'a header ' if head else ''}{shot}{end}."
        return f"{P} {verb} {w} {at}{end}." if not form else f"{cap(at)}, {P} {verb} {w}{end}."
    if lang == "it":
        verb = "colpisce di testa" if head else "ci prova" if tone == "lively" and far else "calcia"
        end = "respinge un difensore" if head and out == "blocked" else end
        if form == 2:
            return f"{cap(at)} ci riprova {P} {'di testa ' if head else ''}{shot}: {end}."
        if form == 3:
            return f"Occasione per {P} {at}, {'di testa ' if head else ''}{shot}: {end}."
        return f"{cap(at)} {P} {verb} {w}: {end}." if not form else f"{P} {verb} {closed(w, lang)} {at}: {end}."
    if form == 2:
        return f"Lo vuelve a intentar {P} {'de cabeza ' if head else ''}{closed(shot, lang)} {at}: {end}."
    if form == 3:
        return f"Ocasión para {P} {at}, {'de cabeza, ' if head else ''}{shot}: {end}."
    verb = "remata de cabeza" if head else "dispara"
    if form == 1:
        return f"{cap(at)}, {P} {verb} {w}: {end}."
    if not head and tone == "lively" and far:
        return f"Lo intenta {P} {closed(w, lang)} {at}: {end}."
    return f"{P} {verb} {closed(w, lang)} {at}: {end}."


# --- the other stories ----------------------------------------------------------------------------

def sprint_line(m, story, lang, tone, focus, opener, form=0):  # noqa: ARG001
    v, P, at = value(story, "sprint_speed"), player(m, story), when(m, story["ts"], lang)
    if v is None or form > 1:
        return None
    before = [f for f in m.kind("sprint_speed") if f["ts"] < story["ts"] - 1e-6]
    ours = [f for f in before if f["team_id"] == story["team_id"]]
    best = "match" if len(before) >= 3 and all(v > f["value"] for f in before) else \
        "team" if len(ours) >= 3 and all(v > f["value"] for f in ours) else None
    kmh = f"{rules.fmt(v, lang)} km/h"
    if lang == "en":
        tail = {"match": ", the fastest sprint of the match so far", "team": ", their fastest sprint so far"}.get(best, "")
        T = team(m, story["team_id"], "en")
        return f"{P} hits {kmh} for {T} {at}{tail}." if not form else f"{cap(at)}, {P} hits {kmh} for {T}{tail}."
    if lang == "it":
        tail = {"match": ", lo scatto più veloce della partita finora",
                "team": f", lo scatto più veloce {team(m, story['team_id'], 'it', 'di')} finora"}.get(best, "")
        return f"{cap(at)} {P} tocca i {kmh}{tail}." if not form else f"{P} tocca i {kmh} {at}{tail}."
    tail = {"match": ", el sprint más rápido del partido hasta ahora",
            "team": f", el sprint más rápido {team(m, story['team_id'], 'es', 'de')} hasta ahora"}.get(best, "")
    return f"{P} alcanza los {kmh} {at}{tail}." if not form else f"{cap(at)}, {P} alcanza los {kmh}{tail}."


def _ten(f, lang):
    return f"{rules.fmt(f['value'], lang)}/10"


def momentum_line(m, story, lang, tone, focus, opener, form=0):  # noqa: ARG001
    """Six forms that differ in their first words, for a match where one team's momentum swings often."""
    tf = [f for f in rules.text_facts(story) if f["kind"] == "momentum"]
    shape = rules.trend_shape([f["value"] for f in tf])
    if len(tf) < 2 or shape not in ("rising", "rose_then_fell") or form > 5 or (form == 2 and shape != "rising"):
        return None  # form 2 has the team as subject: "then drops" would say the team drops
    if shape == "rising":
        tf = [tf[0], tf[-1]]  # a last window as high as the peak: the rise runs to it
    rise = tone == "lively" and tf[1]["value"] - tf[0]["value"] >= 5.0
    fall = len(tf) > 2 and tf[1]["value"] - tf[2]["value"] >= 2.0
    a, b = (f"{_ten(f, lang)} {when(m, f['ts'], lang, i == 0)}" for i, f in enumerate(tf[:2]))
    c = f"{_ten(tf[2], lang)} {when(m, tf[2]['ts'], lang, False)}" if len(tf) > 2 else None
    tid = story["team_id"]
    if form == 4:  # the two minutes first: "Between the 70th and 80th minute, ..."
        return _momentum_between(m, tid, tf, lang, rise, fall, c)
    if lang == "en":
        T = team(m, tid, "en")
        head = (f"{T}'s momentum {'surges' if rise else 'rises'} from", f"{T}'s momentum climbs from",
                f"Momentum builds for {T}, from", f"Momentum swings towards {T}: from", None,
                f"Momentum on the up for {T}, from")[form]
        it = " it" if form in (3, 5) else ""  # "Momentum on the up for Redwick ..., then it drops": the momentum
        return f"{head} {a} to {b}" + (f", then{it} {'drops' if fall else 'eases'} to {c}." if c else ".")
    if lang == "it":
        of = team(m, tid, "it", "di")
        head = (f"L'inerzia {of} {'schizza' if rise else 'sale'} da", f"Cresce l'inerzia {of}: da",
                f"{team(m, tid, 'it', start=True)} prende slancio: inerzia da", f"Sale l'inerzia {of}: da", None,
                f"Inerzia in crescita {team(m, tid, 'it', 'per')}: da")[form]
        return f"{head} {a} a {b}" + (f", poi {'scende' if fall else 'cala'} a {c}." if c else ".")
    of = team(m, tid, "es", "de")  # "empuje": "inercia" is a calque of momentum
    head = (f"El empuje {of} {'se dispara' if rise else 'sube'} de", f"Crece el empuje {of}: de",
            f"{team(m, tid, 'es', start=True)} gana empuje: de", f"Sube el empuje {of}: de", None,
            f"Se viene arriba {team(m, tid, 'es')}: de")[form]
    return f"{head} {a} a {b}" + (f" y luego {'cae' if fall else 'baja'} a {c}." if c else ".")


def _momentum_between(m, tid, tf, lang, rise, fall, c):
    (ma, _, xa, _), (mb, _, xb, _) = _label(m, tf[0]["ts"]), _label(m, tf[1]["ts"])
    if xa or xb:
        return None
    va, vb = _ten(tf[0], lang), _ten(tf[1], lang)  # "fino a": "1,8/10 a 7,5/10" reads as a list
    if lang == "en":
        return (f"Between the {rules.ordinal(ma)} and {rules.ordinal(mb)} minutes, {team(m, tid, 'en')}'s momentum "
                f"{'surges' if rise else 'rises'} from {va} to {vb}") + \
            (f", then {'drops' if fall else 'eases'} to {c}." if c else ".")
    if lang == "it":
        art = [("l'" if when(m, f["ts"], "it").startswith("all'") else "il ") for f in tf[:2]]
        return (f"Tra {art[0]}{ma}' e {art[1]}{mb}' l'inerzia {team(m, tid, 'it', 'di')} "
                f"{'schizza' if rise else 'sale'} da {va} fino a {vb}") + \
            (f", poi {'scende' if fall else 'cala'} a {c}." if c else ".")
    return (f"Entre el minuto {ma} y el {mb}, el empuje {team(m, tid, 'es', 'de')} "
            f"{'se dispara' if rise else 'pasa'} de {va} a {vb}") + \
        (f" y luego {'cae' if fall else 'baja'} a {c}." if c else ".")


def pressing_line(m, story, lang, tone, focus, opener, form=0):  # noqa: ARG001
    """Three forms that differ in their first words."""
    tf = [f for f in rules.text_facts(story) if f["kind"] == "press_intensity"]
    if not tf or form > 2:
        return None
    tid = story["team_id"]
    T, of = team(m, tid, lang, start=True), team(m, tid, lang, {"it": "di", "es": "de"}.get(lang))
    a = f"{_ten(tf[0], lang)} {when(m, tf[0]['ts'], lang)}"
    if len(tf) == 1:
        loud = tone == "lively" and tf[0]["value"] >= rules.PRESS_SPELL
        lines = {"en": (f"An intense press from {T}: {a}." if loud else f"{T}'s press reaches {a}.",
                        f"{T} are pressing, up to {a}.", f"The press from {T} reaches {a}."),
                 "it": (f"Pressing intenso {of}, che arriva a {a}." if loud else f"Il pressing {of} arriva a {a}.",
                        f"{T} spinge col pressing fino a {a}.", f"Si fa sentire il pressing {of}, che tocca quota {a}."),
                 "es": (f"Presión intensa {of}, que llega a {a}." if loud else f"La presión {of} llega a {a}.",
                        f"{T} aprieta con una presión de {a}.", f"Se nota la presión {of}, que llega hasta {a}.")}
        return lines[lang][form]
    b = f"{_ten(tf[1], lang)} {when(m, tf[1]['ts'], lang, False)}"
    shape = rules.trend_shape([f["value"] for f in tf])
    if shape == "steady" and _ten(tf[0], lang) == _ten(tf[1], lang) and (span := _span(m, tf, lang)):
        v = _ten(tf[0], lang)  # "4.6/10 ... and 4.6/10" reads like a template: the value once
        return {"en": (f"{T}'s press holds at {v} {span}.", f"{T} keep their press at {v} {span}.",
                       f"Steady pressing from {T}: {v} {span}."),
                "it": (f"Il pressing {of} resta a {v} {span}.", f"{T} tiene il pressing a {v} {span}.",
                       f"Pressing costante {of}: {v} {span}."),
                "es": (f"La presión {of} se mantiene en {v} {span}.", f"{T} mantiene la presión en {v} {span}.",
                       f"Presión constante {of}: {v} {span}.")}[lang][form]
    up = "turn up the pressure" if tone == "lively" else "step up their press"
    lines = {"en": {"rising": (f"{T} {up}, from {a} to {b}.", f"More pressure from {T}: from {a} to {b}.",
                               f"Pressure building from {T}: from {a} to {b}."),
                    "falling": (f"{T} ease off the press, from {a} to {b}.", f"{T}'s press eases, from {a} to {b}.",
                                f"Less pressure from {T}: from {a} to {b}."),
                    "steady": (f"{T}'s press holds at {a} and {b}.", f"{T} keep the press at {a} and {b}.",
                               f"Steady pressing from {T}: {a} and {b}.")},
             "it": {"rising": (f"{T} alza il pressing: da {a} a {b}.", f"Più pressing {of}: da {a} a {b}.",
                               f"Cresce il pressing {of}: da {a} a {b}."),
                    "falling": (f"{T} allenta il pressing: da {a} a {b}.", f"Cala il pressing {of}: da {a} a {b}.",
                                f"Meno pressing {of}: da {a} a {b}."),
                    "steady": (f"Il pressing {of} resta a {a} e a {b}.", f"{T} tiene il pressing a {a} e a {b}.",
                               f"Pressing costante {of}: {a} e {b}.")},
             "es": {"rising": (f"{T} intensifica la presión: de {a} a {b}.", f"Más presión {of}: de {a} a {b}.",
                               f"Crece la presión {of}: de {a} a {b}."),
                    "falling": (f"{T} afloja la presión: de {a} a {b}.", f"Baja la presión {of}: de {a} a {b}.",
                                f"Menos presión {of}: de {a} a {b}."),
                    "steady": (f"La presión {of} se mantiene: {a} y {b}.", f"{T} mantiene la presión: {a} y {b}.",
                               f"Presión constante {of}: {a} y {b}.")}}
    return lines[lang][shape][form]


def _span(m, tf, lang):
    """"from the 80th minute to the 85th", "tra l'80' e l'85'", "entre el minuto 80 y el 85"; None in stoppage time."""
    (ma, _, xa, _), (mb, _, xb, _) = _label(m, tf[0]["ts"]), _label(m, tf[1]["ts"])
    if xa or xb:
        return None
    if lang == "en":
        return f"from the {rules.ordinal(ma)} minute to the {rules.ordinal(mb)}"
    if lang == "it":
        art = [("l'" if when(m, f["ts"], "it").startswith("all'") else "il ") for f in tf[:2]]
        return f"tra {art[0]}{ma}' e {art[1]}{mb}'"
    return f"entre el minuto {ma} y el {mb}"


def shift_line(m, story, lang, tone, focus, opener, form=0):  # noqa: ARG001
    if form > 1:
        return None
    path = rules.line_path(story)
    if story.get("shape") or not path:
        return rules.template(m, story, lang)  # a change of shape: the template names both formations
    T, up = team(m, story["team_id"], lang, start=True), path["direction"] == "higher"
    a = f"{whole(path['from']['value'])} m {when(m, path['from']['ts'], lang)}"  # "16 m": the unit said twice
    b = f"{whole(path['to']['value'])} m {when(m, path['to']['ts'], lang, False)}"
    if form:
        of = team(m, story["team_id"], lang, {"it": "per", "es": "para"}.get(lang))
        return {"en": f"The defensive line moves {'up' if up else 'back'} for {T}, from {a} to {b}.",
                "it": f"Linea difensiva {'più alta' if up else 'più bassa'} {of}: da {a} a {b}.",
                "es": f"Línea defensiva más {'adelantada' if up else 'retrasada'} {of}: de {a} a {b}."}[lang]
    return {"en": f"{T} {'push their defensive line up' if up else 'drop their defensive line back'} from {a} to {b}.",
            "it": f"{T} {'alza' if up else 'abbassa'} la linea difensiva: da {a} a {b}.",
            "es": f"{T} {'adelanta' if up else 'retrasa'} su línea defensiva: de {a} a {b}."}[lang]


def deficit(m, story):
    """The most goals the comeback team was behind by before this equaliser."""
    tid, worst, score = story["team_id"], 0, {t: 0 for t in m.teams}
    for f in m.kind("score"):
        if f["ts"] >= story["ts"] - 1e-6:
            break
        score[f["team_id"]] += 1
        worst = max(worst, max(v for t, v in score.items() if t != tid) - score[tid])
    return worst


def comeback_line(m, story, lang, tone, focus, opener, form=0):  # noqa: ARG001
    if form:
        return None
    if m.lead(story["ts"])[0] is not None:
        return None  # one goal moves the score by one: a comeback is told at the equaliser
    T, s, big = team(m, story["team_id"], lang, start=True), rules.score_text(m, story["ts"], lang), opener == "comeback"
    if lang == "en":
        return f"What a comeback! {T} have fought all the way back: {s}." if big else f"{T} have come back to level at {s}."
    if lang == "it":
        return f"Che rimonta {team(m, story['team_id'], 'it', 'di')}! È {s}." if big else f"{T} rimonta e pareggia, {s}."
    # "remontada" is turning the score round; a draw is a "reacción"
    return f"¡Qué reacción! {T} iguala el partido, {s}." if big else f"{T} reacciona y empata, {s}."


def recap_line(m, story, lang, tone, focus, opener, form=0):  # noqa: ARG001
    if form:
        return None
    ts, phase = story["ts"], story["phase"]
    leader, s = m.lead(ts)[0], rules.score_text(m, ts, lang)
    L = team(m, leader, lang, full=True) if leader else ""
    ft = phase == "ft"
    head = {"en": (f"Full time: {L} win {s}." if ft else f"Half-time: {L} lead {s}.") if leader else
                  (f"Full time: it ends {s}." if ft else f"Half-time: it's {s}."),
            "it": (f"Finisce {s} per {L}." if ft else f"Fine primo tempo: {s} per {L}.") if leader else
                  (f"Finisce {s}." if ft else f"Fine primo tempo: {s}."),
            "es": (f"Final del partido: {L} gana {s}." if ft else f"Descanso: {L} gana {s}.") if leader else
                  (f"Final del partido: empate, {s}." if ft else f"Descanso: empate, {s}.")}[lang]
    goals = [f for f in m.score_at(ts)[1] if f["player_id"]]
    scorers = {}
    for f in goals:
        scorers.setdefault(m.required_name(f["player_id"]), []).append(f"{m.minute_label(f['ts'])}'")
    if scorers:
        parts = [f"{name} ({', '.join(mins)})" for name, mins in scorers.items()]
        joined = ", ".join(parts[:-1]) + (" {} ".format(("and", "e", "y")[rules.LANGS.index(lang)]) if len(parts) > 1 else "") + parts[-1]
        many = len(goals) > 1
        head += " " + {"en": "Scorers: " if many else "Scorer: ", "it": "Marcatori: " if many else "Marcatore: ",
                       "es": "Goles: " if many else "Gol: "}[lang] + joined + "."
    acc = {f["team_id"]: mt.group(1) for f in story["facts"]
           if f["kind"] == "pass_accuracy" and (mt := re.search(r"(\d+)%", f["label_en"]))}
    h, a = m.home["team_id"], m.away["team_id"]
    if h in acc and a in acc:
        head += rules.TEMPLATES["recap_acc"][rules.LANGS.index(lang)].format(
            home=m.team_name(h), away=m.team_name(a), acc_h=acc[h], acc_a=acc[a])
    return head


FORMS = 6  # the most forms any line has; a line returns None past its own

LINES = {"goal": goal_line, "big_chance": chance_line, "top_sprint": sprint_line, "momentum_swing": momentum_line,
         "pressing_spell": pressing_line, "tactical_shift": shift_line, "comeback": comeback_line, "recap": recap_line}


# --- openers: a commentator's exclamation, each with its condition, at most once a match --------------

def _stoppage(m, story):
    return _label(m, story["ts"])[2]


def _struck(s):
    info = rules.shot_info(s) or {}
    return not info.get("header") and info.get("outcome") in ("goal", "saved")


OPENERS = [  # (id, kinds, condition, (en, it, es)); the first that holds and is not spent wins
    ("again", {"goal"}, lambda m, s: bool(earlier_goals(m, s)), None),  # a variant of the line, not a prefix
    ("comeback", {"comeback"}, lambda m, s: deficit(m, s) >= 2, None),
    ("late", {"goal"}, lambda m, s: _stoppage(m, s) and m.period_of(s["ts"]) == 2 and abs(
        (lambda sc: sc[m.home["team_id"]] - sc[m.away["team_id"]])(m.score_at(s["ts"])[0])) <= 1,
     ("Late drama!", "In pieno recupero!", "¡En el descuento!")),
    ("break", {"goal"}, lambda m, s: _stoppage(m, s) and m.period_of(s["ts"]) == 1,
     ("Right on half-time!", "Allo scadere del primo tempo!", "¡Al filo del descanso!")),
    ("save", {"big_chance"}, lambda m, s: (rules.shot_info(s) or {}).get("outcome") == "saved" and (
        (value(s, "shot_speed") or 0) >= rules.BIG_CHANCE_KMH or (value(s, "shot_distance") or 99) <= CHANCE_M),
     ("What a save!", "Che parata!", "¡Qué parada!")),
    ("strike", {"goal", "big_chance"}, lambda m, s: _struck(s) and
     (value(s, "shot_speed") or 0) >= 110.0, ("What a strike!", "Che sassata!", "¡Qué misil!")),
    ("hit", {"goal", "big_chance"}, lambda m, s: _struck(s) and
     (value(s, "shot_speed") or 0) >= rules.BIG_CHANCE_KMH, ("What a hit!", "Che botta!", "¡Qué zapatazo!")),
    ("golazo", {"goal"}, lambda m, s: not (rules.shot_info(s) or {}).get("header") and
     (value(s, "shot_distance") or 0) >= GOAL_OF_THE_DAY_M, ("What a goal!", "Che gol!", "¡Qué golazo!")),
    ("chance", {"big_chance"}, lambda m, s: (value(s, "shot_distance") or 99) <= CHANCE_M,
     ("What a chance!", "Che occasione!", "¡Qué ocasión!")),
    ("pace", {"top_sprint"}, lambda m, s: (value(s, "sprint_speed") or 0) >= LOUD_SPRINT_KMH,
     ("What pace!", "Che velocità!", "¡Qué velocidad!")),
]
REUSABLE = {"again"}  # a player's next goal may say it again


POWER = {"strike", "hit"}  # "What a hit!" before a blocked shot, or with no speed on the line, rings false


def openers(m, story, spent=()):
    return [o for o in OPENERS if story["kind"] in o[1] and (o[0] in REUSABLE or o[0] not in spent) and o[2](m, story)]


# --- the model's choice and the composer -------------------------------------------------------------

def focus_options(story):
    return shot_focus(story) if story["kind"] in ("goal", "big_chance") else []


def default_choice(story):
    """The tone and focus when the finder gives none: goals and comebacks lively, a big chance lively when
    it was fast or close, the rest calm; a hard shot told by its power, a far one by its distance."""
    kind, speed, dist = story["kind"], value(story, "shot_speed") or 0, value(story, "shot_distance")
    lively = kind in ("goal", "comeback") or (kind == "big_chance" and (speed >= rules.BIG_CHANCE_KMH or (dist or 99) <= 6))
    opts = focus_options(story)
    focus = next((f for f, ok in (("power", speed >= rules.BIG_CHANCE_KMH), ("distance", (dist or 0) >= 20.0),
                                  ("place", True)) if ok and f in opts), opts[0] if opts else "")
    return ("lively" if lively else "calm"), focus


def problems(m, story, text, lang, used=None):
    """Every check a model's line meets, run on a composed line."""
    return (rules.check_text(m.without_names(text), rules.story_allowed(m, story), lang, rules.story_ids(story))
            + rules.story_issues(m, story, text, lang) + rules.story_gaps(m, story, text)
            + rules.style_issues(text, lang, story["kind"], used, m))


def variants(m, story, tone, focus, spent=()):
    """(opener id or None, focus, tone) in the order the composer tries them: the finder's choice first."""
    opts = focus_options(story) or [""]
    focuses = [focus] + [f for f in opts if f != focus] if focus in opts else opts
    tones = [tone] + [t for t in TONES if t != tone] if tone in TONES else ["calm", "lively"]
    out = []
    for t in tones:
        for f in focuses:
            ops = [o[0] for o in openers(m, story, spent) if o[0] not in POWER or f == "power"] if t == "lively" else []
            out += [(o, f, t) for o in ops] + [(None, f, t)]
    return list(dict.fromkeys(out))


def compose_one(m, story, lang, tone, focus, opener, form=0):
    line = LINES.get(story["kind"])
    if not line or (story["player_id"] and not player(m, story)):
        return None
    text = line(m, story, lang, tone, focus, opener, form)
    piece = next((o[3] for o in OPENERS if o[0] == opener), None)
    return f"{piece[rules.LANGS.index(lang)]} {text}" if text and piece else text


def compose(m, story, tone=None, focus=None, spent=(), used=None):
    """The three on-air lines, {"en", "it", "es"}, and the opener id they share, or (None, None) when no
    variant passes every check in every language (the story then falls back to the template).
    `spent` are the opener ids already on air in this match; `used` is lang -> {"loud", "openings"}.
    Each language takes the first of its forms that passes, so one language's used opening does not
    cost the others their line."""
    d_tone, d_focus = default_choice(story)
    for opener, f, t in variants(m, story, tone or d_tone, focus or d_focus, spent):
        texts = {}
        for lang in rules.LANGS:
            texts[lang] = next((x for form in range(FORMS) if (x := compose_one(m, story, lang, t, f, opener, form))
                                and not problems(m, story, x, lang, (used or {}).get(lang))), None)
            if not texts[lang]:
                break
        else:
            return texts, opener
    return None, None
