"""The rule half of the agents (no AI): candidate moments, number checks, templates, risk, director.

Every number a rule uses comes from a fact the workflow read through the MCP server.
"""
import asyncio
import math
import re
import unicodedata

from .. import config, names
from ..export import DURATION
from ..facts.engine import formation_name

LANGS = ("en", "it", "es")
MUST_TELL = {"goal", "comeback", "recap"}

# Written rules per story kind. The finder agent reads RULES; the thresholds below decide what
# reaches it as a candidate.
TOP_SPRINT_KMH = 34.0          # the contract's "sprint above 34 km/h"
BIG_CHANCE_KMH = 100.0         # a saved or missed shot this fast is a big chance ...
BIG_CHANCE_DIST_M = 11.0       # ... and so is any shot from this close to goal
SWING = 3.0                    # momentum: mean of the last 2 windows minus the 2 before
PRESS_SPELL = 5.0              # press intensity in one window, or ...
PRESS_PAIR = 4.3               # ... in two windows in a row
SHIFT_M = 8.0                  # defensive line: mean of the last 2 windows minus the 3 before
SHIFT_MINUTES = (50, 80)       # "around 60'"
RULES = {
    "goal": "Every goal is a story. Always pick it.",
    "comeback": "A team that was behind is now level or ahead. Always pick it.",
    "recap": "Half-time and full-time recaps. Always pick them.",
    "big_chance": f"A shot without a goal, at {BIG_CHANCE_KMH:.0f} km/h or more, or from {BIG_CHANCE_DIST_M:.0f} m "
                  "or closer. Pick the best one or two, skip a weak one when the batch is busy.",
    "top_sprint": f"A sprint at {TOP_SPRINT_KMH:.0f} km/h or more. Pick it unless the same player had one in "
                  "the last 10 minutes.",
    "momentum_swing": f"A team's momentum (0-10) rose by {SWING:.0f} points or more over the last two 5-minute "
                      "windows. Pick it unless the same team had a swing in the last 10 minutes.",
    "pressing_spell": f"A team pressed hard: intensity {PRESS_SPELL:.0f}/10 in one window or {PRESS_PAIR}/10 in "
                      "two windows in a row. Pick it when it lasts or leads to a chance.",
    "tactical_shift": f"Between minutes {SHIFT_MINUTES[0]} and {SHIFT_MINUTES[1]} a team changed its formation "
                      f"(two windows in a row) or moved its defensive line by {SHIFT_M:.0f} m or more. Pick it: it is "
                      "a coaching decision viewers want explained.",
}
SCORE_KINDS = {"goal", "comeback", "recap"}  # the only stories whose text may say the score

TITLES = {
    "goal": ("Goal", "Gol", "Gol"),
    "comeback": ("Comeback", "Rimonta", "Remontada"),
    "big_chance": ("Big chance", "Grande occasione", "Ocasión clara"),
    "top_sprint": ("Sprint", "Scatto", "Sprint"),
    "momentum_swing": ("Momentum swing", "Cambio di inerzia", "Cambio de inercia"),
    "pressing_spell": ("High press", "Pressing alto", "Presión alta"),
    "tactical_shift": ("Tactical shift", "Cambio tattico", "Cambio táctico"),
    "ht": ("Half-time", "Fine primo tempo", "Descanso"),
    "ft": ("Full time", "Finale", "Final"),
}
QUALITY = {"en": ("Goal", "No goal"), "it": ("Gol", "Niente gol"), "es": ("Gol", "Sin gol")}
# Scores are always written leader first ("2-1"), with the leader named, or as level ("2-2").
TEMPLATES = {
    "goal_up": ("Goal! {player} puts {team} {s} up.", "Gol di {player}: {team} avanti {s}.",
                "¡Gol de {player}! {team} se pone por delante, {s}."),
    "goal_level": ("Goal! {player} draws {team} level at {s}.", "Gol di {player}: {team} pareggia, {s}.",
                   "¡Gol de {player}! {team} empata, {s}."),
    "goal_behind": ("Goal! {player} pulls one back for {team}, {s}.", "Gol di {player}: {team} accorcia, {s}.",
                    "¡Gol de {player}! {team} recorta distancias, {s}."),
    "comeback_level": ("{team} have come back to level at {s}.", "Rimonta completata: {team} pareggia, {s}.",
                       "Remontada: {team} empata, {s}."),
    "comeback_up": ("{team} have turned it round and lead {s}.", "Rimonta completata: {team} avanti {s}.",
                    "Remontada: {team} se pone por delante, {s}."),
    "big_chance": ("Big chance for {player}: a shot at {v} km/h, {outcome}.",
                   "Grande occasione per {player}: tiro a {v} km/h, {outcome}.",
                   "Ocasión clara para {player}: disparo a {v} km/h, {outcome}."),
    "top_sprint": ("{player} sprints at {v} km/h.", "{player} scatta a {v} km/h.", "{player} esprinta a {v} km/h."),
    "momentum_swing": ("{team} take over: momentum {v}/10.", "{team} prende il controllo: momentum {v}/10.",
                       "{team} toma el control: dominio {v}/10."),
    "pressing_spell": ("{team} press high: intensity {v}/10.", "{team} pressa alto: intensità {v}/10.",
                       "{team} presiona arriba: intensidad {v}/10."),
    "tactical_shift": ("{team} move their defensive line to {v} m from goal.",
                       "{team} sposta la linea difensiva a {v} m dalla porta.",
                       "{team} coloca su línea defensiva a {v} m de su portería."),
    "shape_shift": ("{team} switch from {old} to {new}.", "{team} passa dal {old} al {new}.",
                    "{team} pasa del {old} al {new}."),
    "recap_lead": ("{title}: {leader} lead {s}.", "{title}: {leader} avanti {s}.", "{title}: {leader} gana {s}."),
    "recap_win": ("{title}: {leader} win {s}.", "{title}: {leader} vince {s}.", "{title}: {leader} gana {s}."),
    "recap_level": ("{title}: level at {s}.", "{title}: parità, {s}.", "{title}: empate, {s}."),
    "recap_acc": (" Passes completed: {home} {acc_h}%, {away} {acc_a}%.",
                  " Passaggi riusciti: {home} {acc_h}%, {away} {acc_a}%.",
                  " Pases completados: {home} {acc_h}%, {away} {acc_a}%."),
}
# What happened to a shot that did not go in, from its events (shot_outcome); writers get the English word.
OUTCOMES = {"saved": ("saved", "parato", "parado por el portero"), "wide": ("wide", "a lato", "desviado"),
            "over": ("over the bar", "alto", "por encima del larguero"), "blocked": ("blocked", "murato", "bloqueado")}
GOAL_Y = (34 - 3.66, 34 + 3.66)  # the posts
MAIN_KIND = {"goal": "shot_speed", "big_chance": "shot_speed", "top_sprint": "sprint_speed",
             "momentum_swing": "momentum", "pressing_spell": "press_intensity", "tactical_shift": "line_height"}


def minute(ts, period, p1):
    """Display minute (docs/CONTRACT.md); a window end at 300.0 s still belongs to minute 5."""
    t = max(ts - (p1 if period == 2 else 0.0) - 1e-6, 0.0)
    return math.floor(t / 60) + (45 if period == 2 else 0) + 1


def stoppage(mi, period):
    """A display minute as people say it: 47 in the first half is "45+2", 93 in the second "90+3"."""
    base = 45 if period == 1 else 90
    return f"{base}+{mi - base}" if mi > base else str(mi)


def display_label(f):
    """A fact label with stoppage-time minutes: "min 44-46" in the first half reads "min 44-45+1", and a
    window wholly in stoppage time ("min 46-47") reads "first-half stoppage time"."""
    period = f.get("period") or 1
    base = 45 if period == 1 else 90

    def window(mt):
        a, b = int(mt[1]), int(mt[2])
        if a > base:
            return ("first" if period == 1 else "second") + "-half stoppage time"
        return f"min {stoppage(a, period)}-{stoppage(b, period)}"

    return re.sub(r"\bmin (\d+)-(\d+)", window, f["label_en"])


def fmt(v, lang="en"):
    text = f"{v:.1f}".rstrip("0").rstrip(".")
    return text if lang == "en" else text.replace(".", ",")


# --- candidates -------------------------------------------------------------------------------

class Match:
    """Teams, sides and players from get_match_info, plus the facts released so far by kind."""

    def __init__(self, info):
        self.update(info)
        self.facts = {}

    def update(self, info):
        self.info = info
        self.home = next(t for t in info["teams"] if t["side"] == "home")
        self.away = next(t for t in info["teams"] if t["side"] == "away")
        self.teams = {t["team_id"]: t for t in info["teams"]}
        self.players = {p["player_id"]: p for p in info["players"]}
        self.p1 = info["period1_s"]

    def kind(self, kind, team_id=None):
        return sorted((f for f in self.facts.values() if f["kind"] == kind and
                       (team_id is None or f["team_id"] == team_id)), key=lambda f: (f["ts"], f["fact_id"]))

    def team_name(self, team_id):
        return self.teams[team_id]["name"] if team_id in self.teams else None

    def player_name(self, player_id):
        return self.players.get(player_id, {}).get("name") if player_id else None

    def minute_of(self, f):
        return minute(f["ts"], f["period"], self.p1 or math.inf)

    def period_of(self, ts):
        return 2 if self.p1 is not None and ts > self.p1 + 1e-6 else 1

    def minute_label(self, ts):
        """The minute as said on air: "41", or "45+2" in stoppage time."""
        period = self.period_of(ts)
        return stoppage(minute(ts, period, self.p1 or math.inf), period)

    def score_at(self, ts):
        goals = [f for f in self.kind("score") if f["ts"] <= ts]
        return {tid: sum(1 for f in goals if f["team_id"] == tid) for tid in self.teams}, goals

    def lead(self, ts):
        """(leading team_id or None when level, the score leader first as "2-1")."""
        score, _ = self.score_at(ts)
        (t_hi, hi), (_, lo) = sorted(score.items(), key=lambda x: -x[1])
        return (None if hi == lo else t_hi), f"{hi}-{lo}"

    def required_name(self, player_id):
        """The word a line about this player must contain: the surname, or the full name when two
        players of the match share it."""
        name = self.player_name(player_id)
        if not name:
            return None
        surname = name.split()[-1]
        shared = sum(p["name"].split()[-1] == surname for p in self.players.values() if p.get("name"))
        return name if shared > 1 else surname

    def without_names(self, text):
        """text with the match's player and team names blanked, so a digit in a name is not a number."""
        for n in sorted({p.get("name") or "" for p in self.players.values()} | {t["name"] for t in self.teams.values()},
                        key=len, reverse=True):
            text = text.replace(n, " ") if n else text
        return text

    def team_word(self, team_id):
        """The word a line about this team must contain: the first word of its name."""
        name = self.team_name(team_id)
        return name.split()[0] if name else None


def _cand(kind, ts, facts, team_id=None, player_id=None, note="", **extra):
    ev = sorted({e for f in facts for e in f["source_event_ids"]})
    return {"kind": kind, "ts": ts, "team_id": team_id, "player_id": player_id, "facts": facts,
            "evidence_event_ids": ev, "note": note, **extra}


def goal_candidates(m, score_fact):
    """A goal, and a comeback when the scoring team had been behind and is now level or ahead."""
    shot = [f for kind in ("shot_speed", "shot_distance") for f in m.kind(kind)
            if f["source_event_ids"] == score_fact["source_event_ids"]]
    out = [_cand("goal", score_fact["ts"], [score_fact, *shot], score_fact["team_id"], score_fact["player_id"],
                 note=score_fact["label_en"], outcome="goal")]
    tid = score_fact["team_id"]
    other = next(t for t in m.teams if t != tid)
    now, goals = m.score_at(score_fact["ts"])
    was_behind = any(m.score_at(g["ts"])[0][tid] < m.score_at(g["ts"])[0][other] for g in goals if g is not score_fact)
    if was_behind and now[tid] - now[other] in (0, 1):
        out.append(_cand("comeback", score_fact["ts"], goals, tid, None,
                         note=f"was behind, now {now[tid]}-{now[other]}"))
    return out


def sprint_candidates(sprint_fact):
    if sprint_fact["value"] < TOP_SPRINT_KMH:
        return []
    return [_cand("top_sprint", sprint_fact["ts"], [sprint_fact], sprint_fact["team_id"], sprint_fact["player_id"],
                  note=sprint_fact["label_en"])]


def _line_delta(line, w):
    """Defensive line: mean of the last 2 windows minus the 3 before, when the last one ends at w."""
    if len(line) < 5 or line[-1]["ts"] != w:
        return None
    return (line[-1]["value"] + line[-2]["value"]) / 2 - sum(f["value"] for f in line[-5:-2]) / 3


def shot_outcome(shot, saves=()):
    """What happened to a shot that did not go in: saved (a keeper_save answers it), wide or over (it
    reached the goal line outside or between the posts), or blocked (it stopped short)."""
    if any(s.get("related_player_id") == shot["player_id"] and 0 <= s["ts"] - shot["ts"] <= 5 for s in saves):
        return "saved"
    line = 105.0 if shot["end_x"] > 52.5 else 0.0
    if abs(shot["end_x"] - line) < 0.05:
        return "over" if GOAL_Y[0] <= shot["end_y"] <= GOAL_Y[1] else "wide"
    return "blocked"


def window_candidates(m, w0, w, shots, shifted, saves=()):
    """Candidates for the 5-minute window (w0, w]: big chances, momentum swings, pressing, tactical shift.

    `shots` and `saves` are the window's shot and keeper_save events (from get_events); `shifted` is
    the set of teams that already had a tactical shift story and is updated in place.
    """
    out = []
    goal_events = {e for f in m.kind("score") for e in f["source_event_ids"]}
    by_event = {f["source_event_ids"][0]: f for f in m.kind("shot_speed") if f["source_event_ids"]}
    dist_of = {f["source_event_ids"][0]: f for f in m.kind("shot_distance") if f["source_event_ids"]}
    chances = []
    for e in shots:
        f, d = by_event.get(e["event_id"]), dist_of.get(e["event_id"])
        if not f or e["event_id"] in goal_events:
            continue
        if f["value"] >= BIG_CHANCE_KMH or (d and d["value"] <= BIG_CHANCE_DIST_M):
            chances.append((f, d, e))
    for f, d, e in sorted(chances, key=lambda c: -c[0]["value"])[:2]:
        outcome = shot_outcome(e, saves)
        out.append(_cand("big_chance", f["ts"], [f] + ([d] if d else []), f["team_id"], f["player_id"],
                         note=f["label_en"] + (f", {d['label_en'].lower()}" if d else "") + f", {OUTCOMES[outcome][0]}",
                         outcome=outcome, header=e.get("bodypart_name") == "head"))
    period = 2 if m.p1 is not None and w > m.p1 + 1e-6 else 1
    in_period = lambda f: f["period"] == period  # noqa: E731
    swings = []
    for tid in m.teams:
        mom = [f for f in m.kind("momentum", tid) if in_period(f)]
        if len(mom) >= 4 and mom[-1]["ts"] == w:
            rise = (mom[-1]["value"] + mom[-2]["value"] - mom[-3]["value"] - mom[-4]["value"]) / 2
            if rise >= SWING:
                swings.append((rise, tid, mom[-4:]))
        press = [f for f in m.kind("press_intensity", tid) if in_period(f)]
        if press and press[-1]["ts"] == w and (press[-1]["value"] >= PRESS_SPELL or (
                len(press) >= 2 and min(press[-1]["value"], press[-2]["value"]) >= PRESS_PAIR)):
            spell = press[-2:] if len(press) >= 2 and press[-2]["value"] >= PRESS_PAIR else press[-1:]
            out.append(_cand("pressing_spell", w, spell, tid, note=" / ".join(f["label_en"] for f in spell)))
        line = [f for f in m.kind("line_height", tid) if in_period(f)]
        mi = minute(w, period, m.p1 or math.inf)
        shift_time = period == 2 and SHIFT_MINUTES[0] <= mi <= SHIFT_MINUTES[1]
        form = m.kind("formation", tid)
        if tid not in shifted and shift_time and len(form) >= 4 and form[-1]["ts"] == w:
            new, before = form[-1]["value"], form[:-2][-3:]  # two windows of the new shape after 2+ of one old one
            if (form[-2]["value"] == new and len(before) >= 2 and before[-1]["value"] != new
                    and len({f["value"] for f in before}) == 1):
                shifted.add(tid)
                width = [f for f in m.kind("team_width", tid) if f["ts"] in (before[-1]["ts"], w)]
                old_name, new_name = formation_name(before[-1]["value"]), formation_name(new)
                out.append(_cand("tactical_shift", w, [before[-1], form[-2], form[-1], *line[-1:], *width], tid,
                                 note=f"shape from {old_name} to {new_name}", shape=(old_name, new_name)))
        if tid not in shifted and shift_time and (delta := _line_delta(line, w)) is not None:
            other = next(t for t in m.teams if t != tid)
            # a line pushed back while the other team's line moves up by as much is their push, not our choice
            mirror = delta < 0 and (_line_delta([f for f in m.kind("line_height", other) if in_period(f)], w)
                                    or 0) >= SHIFT_M
            if abs(delta) >= SHIFT_M and not mirror:
                shifted.add(tid)
                out.append(_cand("tactical_shift", w, line[-5:], tid,
                                 note=f"line {'higher' if delta > 0 else 'deeper'} by {abs(delta):.0f} m"))
    for rise, tid, facts in sorted(swings, reverse=True)[:1]:
        out.append(_cand("momentum_swing", w, facts, tid, note=f"momentum up {rise:.1f} points"))
    return out


def recap_candidate(m, cp, phase):
    """Half-time ("ht") or full-time ("ft") recap from the score, team pass accuracy, top sprint, distance."""
    _, goals = m.score_at(cp)
    facts = list(goals)
    acc = [f for f in m.kind("pass_accuracy") if f["ts"] == cp and f["player_id"] is None]
    facts += acc
    sprints = [f for f in m.kind("sprint_speed") if f["ts"] <= cp]
    facts += [max(sprints, key=lambda f: f["value"])] if sprints else []
    dist = [f for f in m.kind("distance_covered") if f["ts"] == cp]
    facts += [max(dist, key=lambda f: f["value"])] if dist else []
    return _cand("recap", cp, facts, note=TITLES[phase][0], phase=phase)


# --- verifier: numbers and names ---------------------------------------------------------------

_UNIT = {"km/h": "speed", "kph": "speed", "km": "km", "%": "pct", "/10": "ten"}
_UNIT.update(dict.fromkeys(("m", "metres", "meters", "metre", "meter", "metri", "metro", "metros"), "m"))
_UNIT.update(dict.fromkeys(("kilometres", "kilometers", "kilometre", "kilometer", "chilometri", "chilometro",
                            "kilómetros", "kilómetro"), "km"))
_UNIT.update(dict.fromkeys(("kilometres per hour", "kilometers per hour", "km per hour", "kilometres an hour",
                            "km an hour", "chilometri orari", "chilometri all'ora", "km orari", "km all'ora",
                            "kilómetros por hora", "km por hora"), "speed"))
_UNIT.update(dict.fromkeys(("per cent", "percent", "per cento", "por ciento"), "pct"))
_UNIT.update(dict.fromkeys(("out of 10", "su 10", "sobre 10"), "ten"))
_FAMILY = {"km/h": "speed", "m": "m", "%": "pct", "/10": "ten"}
_ORDINAL = ("st", "nd", "rd", "th", "º", "ª", "°")
_NUM = re.compile(
    r"(?<![\w.,])(\d+(?:[.,]\d+)?)(?:st|nd|rd|th|º|ª|°)?\s*("
    + "|".join(sorted(map(re.escape, _UNIT), key=len, reverse=True)).replace(r"/10", r"/\s?10")
    + r")?(?![\w])", re.IGNORECASE)
# a digit run glued to letters ("96kmh") hides its unit from _NUM; only ordinals and known units may touch it
_GLUED = re.compile(r"(?<![\w.,])\d+(?:[.,]\d+)?([^\W\d_]+)")
# a unit the ledger never uses: the number is a claim the code cannot check
_ALIEN = re.compile(r"(?<![\w.,])\d+(?:[.,]\d+)?\s*(mph|miles?|yards?|yds?|feet|foot|ft|m/s|kmh|km/hr|goals?|goles|"
                    r"seconds?|secs?|segundos?|secondi)\b", re.IGNORECASE)
# numbers written in words: the code cannot check them, so the writers use digits only
_TENS = {"it": "venti|trenta|quaranta|cinquanta|sessanta|settanta|ottanta|novanta",
         "es": "veint|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa", "en": ""}
_WORDS = {
    "en": """two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen
             eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand dozen third fourth
             fifth sixth seventh eighth ninth tenth twice hat-trick brace""",
    "it": """due tre quattro cinque sei sette otto nove dieci undici dodici tredici quattordici quindici sedici
             diciassette diciotto diciannove cento mille terzo terza quarto quarta quinto quinta sesto sesta settimo
             ottavo nono decimo doppietta tripletta""",
    "es": """dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciséis diecisiete
             dieciocho diecinueve cien ciento mil tercer tercero tercera quinto quinta sexto séptimo octavo noveno
             décimo doblete triplete""",
}
_SPELLED = {lang: re.compile(r"(?<!\w)(?:" + "|".join(map(re.escape, w.split()))
                             + (rf"|(?:{_TENS[lang]})\w*" if _TENS[lang] else "") + r")(?!\w)", re.IGNORECASE)
            for lang, w in _WORDS.items()}
# football words that hold a number word but claim no number
_NOT_A_NUMBER = re.compile(r"\bsix-yard\b|\b(?:final|attacking|defensive|middle) third\b|\bultimo terzo\b", re.IGNORECASE)
# three or more numbers joined by hyphens: a formation (single digits adding up to 10) or a glued mess ("73-2-2")
_CHAIN = re.compile(r"(?<![\w.,])\d+(?:-\d+){2,}(?![\w.,]\d)")
GENERIC = (0.0, 45.0, 90.0)
_FACT_ID = re.compile(r"F-[A-Z_]+-\d+")


def _family(unit):
    return _UNIT[re.sub(r"\s+", " ", unit.lower()).replace("/ 10", "/10")] if unit else None


def allowed_numbers(facts, minutes=()):
    """(value, family) pairs a text about these facts may contain. Family None means unitless only.
    `minutes` are (display minute, period); one in stoppage time is allowed as "45+2" (45 and 2), not as 47."""
    out = [(v, None) for v in GENERIC]
    for mi, period in minutes:
        out += [(float(x), None) for x in stoppage(mi, period).split("+")]
    for f in facts:
        fam = _FAMILY.get(f["unit"])
        out.append((f["value"], fam))
        if fam == "m":
            out.append((f["value"] / 1000, "km"))
        if fam == "ten":
            out.append((10.0, None))
        for mt in _NUM.finditer(_FACT_ID.sub("", display_label(f))):  # label numbers keep their own unit
            out.append((float(mt.group(1).replace(",", ".")), _family(mt.group(2))))
    return out


def check_numbers(text, allowed, lang="en"):
    """Flags for every number in text that is not in the ledger, with rounding tolerance and units,
    and for numbers written in words, glued to letters or followed by a unit the ledger does not use."""
    text = _FACT_ID.sub("", text)  # cited fact ids are not numbers
    flags = [f"number in words: '{w}' (write digits from the facts)"
             for w in _SPELLED[lang].findall(_NOT_A_NUMBER.sub("", text))]
    flags += [f"garbled numbers: '{mt.group(0)}'" for mt in _CHAIN.finditer(text)
              if not (all(len(p) == 1 for p in mt.group(0).split("-")) and sum(map(int, mt.group(0).split("-"))) == 10)]
    alien = list(_ALIEN.finditer(text))
    flags += [f"unit not in the facts: '{mt.group(0)}'" for mt in alien]
    skip = {mt.start() for mt in alien}
    flags += [f"unit glued to a number: '{mt.group(0)}'" for mt in _GLUED.finditer(text)
              if mt.start() not in skip and mt.group(1).lower() not in _ORDINAL and mt.group(1).lower() not in _UNIT]
    for mt in _NUM.finditer(text):
        if mt.start() in skip:
            continue
        raw, unit = mt.group(1), mt.group(2)
        x = float(raw.replace(",", "."))
        decimals = len(raw.split(",")[-1] if "," in raw else raw.split(".")[-1]) if re.search(r"[.,]", raw) else 0
        tol = 0.5 * 10 ** -decimals + 1e-9
        fam = _family(unit)
        near = [(v, f) for v, f in allowed if abs(x - v) <= tol]
        if fam is None and near:
            continue
        if fam is not None and any(f == fam for _, f in near):
            continue
        shown = mt.group(0).strip()
        if fam is not None and any(f for _, f in near):
            flags.append(f"unit mismatch: '{shown}' (ledger: {', '.join(sorted({f for _, f in near if f}))})")
        else:
            flags.append(f"number not in the facts: '{shown}'")
    return flags


def check_text(text, allowed, lang="en"):
    """All rule checks on one text: numbers against the ledger, then forbidden real names. The flag
    never repeats the name, because flags are shown to people."""
    return check_numbers(text, allowed, lang) + ["forbidden name (real person or club)"] * bool(names.find_forbidden(text))


def story_minutes(m, story):
    return {(m.minute_of(f), f["period"]) for f in story["facts"]} | {(story["minute"], m.period_of(story["ts"]))}


def story_allowed(m, story):
    """Numbers a text about this story may use: its facts, its minutes and the score at that moment."""
    _, goals = m.score_at(story["ts"])
    return allowed_numbers(story["facts"] + goals, story_minutes(m, story))


def text_facts(story):
    """The facts a line should read out: for a momentum swing the low before and the peak after, for
    a pressing spell its last two windows; otherwise all of them."""
    facts = story["facts"]
    if story["kind"] == "momentum_swing" and len(facts) >= 4:
        return [min(facts[:2], key=lambda f: f["value"]), max(facts[-2:], key=lambda f: f["value"])]
    if story["kind"] == "pressing_spell":
        return facts[-2:]
    return facts


def ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def minute_text(mi, period, lang):
    """A minute as a commentator writes it: "41st minute", "minuto 41", or "45+2'" in stoppage time."""
    if mi > (45 if period == 1 else 90):
        return f"{stoppage(mi, period)}'"
    return f"{ordinal(mi)} minute" if lang == "en" else f"minuto {mi}"


def number_list(m, story, lang="en"):
    """The numbers a commentator may write about this story, as strings for the prompt ("96 km/h",
    "6 m", "4-4-2", "41st minute"), with the decimal comma in Italian and Spanish and long distances in km.
    The score is listed only for a story whose point is the score, leader first."""
    out = [minute_text(mi, p, lang) for mi, p in sorted(story_minutes(m, story), key=lambda x: (x[1], x[0]))]
    for f in text_facts(story):
        u, v = f["unit"], f["value"]
        if u == "m" and v >= 1000:
            u, v = "km", v / 1000
        if u == "formation":
            out.append(formation_name(v))
        elif u in ("%", "/10"):
            out.append(fmt(v, lang) + u)
        elif u and f["kind"] != "score":
            out.append(f"{fmt(v, lang)} {u}")
    if story["kind"] in SCORE_KINDS:
        out.append(m.lead(story["ts"])[1])
    return list(dict.fromkeys(out))


# Distance words and the shot distances (m from the goal centre) at which they are true.
DISTANCE_WORDS = [
    (r"six[- ]yard|area piccola|área pequeña|área chica", 0.0, 7.0),
    (r"close[- ]range|point[- ]blank|tap[- ]in|ravvicinat\w*|bruciapelo|da pochi passi|bocajarro|quemarropa|boca de gol",
     0.0, 11.0),
    (r"edge of the (?:box|area)|dal limite|limite dell'area|borde del área|frontal del área", 14.0, 26.0),
    (r"from (?:distance|range|outside)|long[- ]range|outside the (?:box|area)|da fuori|dalla distanza|da lontano|"
     r"fuori area|fuori dall'area|desde fuera|desde lejos|lejano|larga distancia|media distancia|fuera del área",
     16.5, 999.0),
]
# where the ball went and how the chance was made: no fact or event field gives these, so they are invented
INVENTED = {"en": r"near[- ]post|far[- ]post|top corner|bottom corner|corner of the net|top bins|pull[- ]back|cross|"
                  r"crossed|volley\w*|rebound|scramble|deflect\w*|turnovers?|knock[- ]?down|lay[- ]?off|assist\w*|wind",
            "it": r"primo palo|secondo palo|incrocio|angolino|cross|al volo|tiro-volley|ribattuta|deviazion\w*|"
                  r"palle recuperate|recuper\w+ palla|sponda|assist\w*|vento",
            "es": r"primer palo|segundo palo|escuadra|centro al área|volea|rechace|desv[ií]o|p[eé]rdidas?|robos?|asistencia|dejada|viento"}
STILL_PLAYING = {"en": r"(?:leads?|leading) \d+-\d+|in front", "it": r"(?:in vantaggio|avanti|conduce) (?:per )?\d+-\d+",
                 "es": r"(?:manda|mandan|lidera) (?:por )?\d+-\d+"}
POSSESSION = r"possession|bossed|kept the ball|possesso|posesión|domina(?:n|ba)? el balón|dominio del balón"
RISING = {"en": r"rose|rising|rises|climb\w*|surg\w*|grew|growing|cranked up|ramped up|built up|kept up|maintain\w*|"
                r"sustained|held up",
          "it": r"sale|salit[oa]|cresc\w*|aument\w*|in crescendo|progress\w*|mantenut[oa]|mantiene|sostenut[oa]|costante",
          "es": r"sube|subió|crec\w*|aument\w*|se dispar\w*|mantuvo|mantiene|sostenid[oa]|constante"}
_TEN = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:/\s?10|out of 10|su 10|sobre 10)", re.IGNORECASE)


def _has(pattern, text):
    return re.search(rf"(?<!\w)(?:{pattern})(?!\w)", text, re.IGNORECASE)


def story_issues(m, story, text, lang, on_air=True):
    """Claims the ledger contradicts: distance words against the shot distance, pass accuracy told as
    possession, a score with the trailing side first, and momentum or press values out of order, more
    than two of them, or a rising word for a falling trend."""
    out = []
    dist = next((f["value"] for f in story["facts"] if f["kind"] == "shot_distance"), None)
    for pattern, lo, hi in DISTANCE_WORDS:
        if (hit := _has(pattern, text)) and (dist is None or not lo <= dist <= hi):
            out.append(f"'{hit.group(0)}' does not fit " + (f"a shot from {fmt(dist)} m" if dist is not None
                                                            else "the facts (no shot distance)"))
    if hit := _has(POSSESSION, text):
        out.append(f"'{hit.group(0)}': there is no possession fact, and pass accuracy is not possession")
    if hit := _has(INVENTED.get(lang, INVENTED["en"]), text):
        out.append(f"'{hit.group(0)}' is not in the facts")
    if on_air and story["kind"] == "recap" and story.get("phase") == "ft" and (hit := _has(STILL_PLAYING[lang], text)):
        out.append(f"'{hit.group(0)}' at full time: the match is over, say who won or that it ended level")
    leader, s = m.lead(story["ts"])
    hi, lo = s.split("-")
    if leader and story["kind"] in SCORE_KINDS and f"{lo}-{hi}" in [x.replace(" ", "") for x in score_mentions(text)]:
        out.append(f"write the score leader first: {s}, not {lo}-{hi}")
    if story["kind"] in ("momentum_swing", "pressing_spell"):
        values = [float(v.replace(",", ".")) for v in _TEN.findall(text)]
        order = [next((i for i, f in enumerate(story["facts"]) if abs(f["value"] - v) <= 0.051), None) for v in values]
        if len(values) > 2:
            out.append(f"{len(values)} values out of 10: give two at most, the start and the end")
        elif None not in order and order != sorted(order):
            out.append("the values are not in time order")
        tf = text_facts(story)
        if len(tf) >= 2 and tf[-1]["value"] < tf[0]["value"] - 0.2 and (hit := _has(RISING[lang], text)):
            out.append(f"'{hit.group(0)}' but the value fell from {fmt(tf[0]['value'])} to {fmt(tf[-1]['value'])}")
    return out


def story_gaps(m, story, text):
    """What a viewer needs and the line leaves out: the player or team it is about, and the score in a recap."""
    out = []
    if story["player_id"] and (name := m.required_name(story["player_id"])):
        if name.lower() not in text.lower():
            out.append(f"name the player: {name}")
    elif story["team_id"] and (word := m.team_word(story["team_id"])) and word.lower() not in text.lower():
        out.append(f"name the team: {m.team_name(story['team_id'])}")
    if story["kind"] == "recap":
        hi, lo = m.lead(story["ts"])[1].split("-")
        if not {f"{hi}-{lo}", f"{lo}-{hi}"} & {x.replace(" ", "") for x in score_mentions(text)}:
            out.append(f"give the score: {hi}-{lo}")
    return out


# an issue that takes itself back ("... wait, header true so OK"): the judge reasoned aloud and gave no verdict
_RETRACTS = re.compile(r"\bwait\b|\b(?:so|which|this|that|it)(?: is|'s)? (?:ok|okay|fine|acceptable|correct)\b|"
                       r"\bacceptable\b|\bthis matches\b|\bmatches the facts?\b|\bprimary issue: none\b|\bno issue\b",
                       re.IGNORECASE)


def retracts(issue):
    """True when a 'not ok' verdict argues itself out of the problem it names. Such a verdict neither
    passes the text nor sends it back: the text stays unjudged, so its story goes to review."""
    return bool(_RETRACTS.search(issue or ""))


_NO_ISSUE = re.compile(r"^\W*(none|n/?a|ok|okay|fine|correct|no (factual )?(issues?|problems?|errors?)( found)?)\W*$",
                       re.IGNORECASE)


def no_issue(issue):
    """True when a judge's "not ok" verdict is only a short "none" or "no issue": the judge contradicting
    itself. Anything longer may name a real problem and stands."""
    issue = (issue or "").strip()
    return len(issue) < 40 and bool(_NO_ISSUE.match(issue))


_DASH = r"[‒–—―⸺⸻︱︲﹘]"


def tidy(text):
    """Every string the agents put in front of people: no em or en dashes (house style; a dash between
    words becomes a comma), no control or invisible format characters (bidi overrides, soft hyphens),
    plain hyphens, single spaces."""
    text = "".join(" " if unicodedata.category(ch) == "Cc" else "" if unicodedata.category(ch) == "Cf" else ch
                   for ch in str(text))
    text = re.sub(r"[‐‑]", "-", text)
    text = re.sub(rf"(\d)\s*{_DASH}\s*(\d)", r"\1-\2", text)  # a score or a range keeps a hyphen
    text = re.sub(rf"\s*{_DASH}\s*", ", ", text)
    text = re.sub(r"\s*,\s*([.!?;:])", r"\1", text)  # "minuto 81, ." reads "minuto 81."
    text = re.sub(r"\b(in|during) the ((?:first|second)-half stoppage time)", r"\1 \2", text, flags=re.I)
    text = re.sub(r"\bin the (\d+\+\d+')", r"at \1", text)  # "in the 90+2'" reads "at 90+2'"
    return re.sub(r"\s+", " ", text).strip(" ,")


NOTE_CHARS = 160


def note(text):
    """A verifier note for the desk: tidy, one sentence, at most NOTE_CHARS characters.

    Short prefixes such as "en: claim: " stay in front of the sentence."""
    rest, prefix = tidy(text), ""
    while (mt := re.match(r"([\w ]{1,12}): ", rest)) and len(mt.group(1).split()) <= 2:
        prefix, rest = prefix + mt.group(0), rest[mt.end():]
    first = re.split(r"(?<=[.!?])\s+(?=[A-Z\"'(])", rest, maxsplit=1)[0]
    room = NOTE_CHARS - len(prefix)
    if len(first) > room:
        first = first[:room - 1].rsplit(" ", 1)[0].rstrip(",;: ") + "…"
    return prefix + first


def brief_error(e):
    """A failure as people read it in a trace or a note: never the raw exception text."""
    text = f"{type(e).__name__} {e}".lower()
    if isinstance(e, (asyncio.TimeoutError, TimeoutError)) or "timeout" in text or "timed out" in text:
        return "timed out"
    if "429" in text or "rate limit" in text or "too many requests" in text:
        return "rate limited"
    if "budget" in text:
        return "run budget reached"
    if "validation" in text or "json" in text:
        return "unreadable reply"
    return "model error"


# --- style: what a TV commentator would not say -------------------------------------------------

STOP = {
    "en": set("""that this with from into have they them their there then than when what which while were been being
              after before about over just also more most only some such will would could should still where here
              make makes made""".split()),
    "it": set("""della delle dello degli dalla dalle dallo dagli nella nelle nello negli alla alle allo agli sulla
              sulle sullo sugli come dopo anche ancora sono stato stata questo questa quello quella quando mentre
              prima però perché più ogni tutto tutti tutta loro dove fino senza verso contro""".split()),
    "es": set("""para como pero desde tras antes este esta esto estos estas cuando sobre entre hasta porque más
              todo todos toda donde mientras luego contra hacia sido está están tiene tienen""".split()),
}
# Loud words a commentator uses once a match at most, and words that are never broadcast copy.
RATIONED = {
    "en": r"rips?|ripped|lash\w*|thunder\w*|rattl\w*|crank\w*|screamer|top-class|rifl\w*|unleash\w*|smash\w*|"
          r"blast\w*|hammer\w*|concerted",
    "it": r"che botta|bordat\w*|silur\w*|sassat\w*|cannonat\w*|missile",
    "es": r"obliga al portero a estirarse|parada espectacular|trallazo|zapatazo|latigazo|misil|cañonazo|obús",
}
BANNED = (r"heel-to-toe|bossed|according to the data|minuziosamente|[^\W\d_]{2,}/[^\W\d_]{2,}|"
          r"carriers?|ball-holders?|portatore di palla|portador del balón|rushed exits|rapid exits")


def jargon(text):
    """Analyst jargon a viewer should never read: a style issue first, a fallback to the template in the last round."""
    return [f"'{hit.group(0)}' is not broadcast copy"] if (hit := _has(BANNED, text)) else []


# English football words copied into an Italian or Spanish line
ENGLISH = r"close[- ]range|six[- ]yard|edge of the box|from distance|wide|header|keeper|the box|strike|shot|away"
_SCORE = re.compile(r"(?<![\w.,/+-])\d{1,2}\s?-\s?\d{1,2}(?![\d/]|[.,]\d|-\d)")
_WORD = re.compile(r"[^\W\d_]+")


def score_mentions(text):
    """Scores like 2-1 in text; minute ranges (min 41-45) and formations (4-4-2) are not scores."""
    return [mt.group(0) for mt in _SCORE.finditer(text)
            if not re.search(r"min\w*\.?\s*$", text[max(0, mt.start() - 10):mt.start()], re.IGNORECASE)]


def repeated_words(text, lang, limit=2):
    """Content words (4+ letters, not function words) used `limit` times or more in one text."""
    words = [w.lower() for w in _WORD.findall(text)]
    stems = [w[:-1] if lang != "it" and w.endswith("s") and len(w) > 4 else w
             for w in words if len(w) >= 4 and w not in STOP.get(lang, ())]
    return sorted({w for w in stems if stems.count(w) >= limit})


def opening(text):
    return " ".join(w.lower() for w in _WORD.findall(text)[:3])


def loud_words(text, lang):
    return {w.lower() for w in re.findall(rf"(?<!\w)(?:{RATIONED[lang]})(?!\w)", text, re.IGNORECASE)}


def style_issues(text, lang, kind, used=None):
    """What a TV commentator would not do: say the score twice, or where it is not the point of the
    story; use the same word twice; run past two sentences; reuse a loud word or an opening already
    on air in this match (`used` = {"loud": set, "openings": set}). A recap may run to three
    sentences and name a team twice."""
    out = []
    scores = score_mentions(text)
    if len(scores) > 1:
        out.append(f"score said {len(scores)} times ({', '.join(scores)}): say it once at most")
    elif scores and kind not in SCORE_KINDS:
        out.append(f"the score {scores[0]} is not the point of a {kind.replace('_', ' ')} story: leave it out")
    longest = 3 if kind == "recap" else 2
    if rep := repeated_words(text, lang, longest):
        out.append(f"repeated words ({', '.join(rep)}): say each thing once")
    sentences = len([x for x in re.split(r"(?<=[.!?])\s+", text) if x.strip()])
    if sentences > longest:
        out.append(f"{sentences} sentences: keep it to {longest}")
    out += jargon(text)
    if lang != "en" and (hit := _has(ENGLISH, text)):
        out.append(f"'{hit.group(0)}' is English: say it in your language")
    if lang == "en" and (hit := re.search(r"(?<!\bthe )\b\d+(?:st|nd|rd|th) minute\b", text)):
        out.append(f"'{hit.group(0)}' without 'the': say 'in the {hit.group(0)}'")
    tail = [p for p in re.split(r"[,;:]", text.rstrip(" .!"))][-2:]
    if len(tail) == 2 and all(re.search(r"\d", p) and len(p.split()) <= 3 for p in tail) and kind != "recap":
        out.append("numbers listed at the end: work them into the sentence")
    used = used or {}
    if again := loud_words(text, lang) & used.get("loud", set()):
        out.append(f"'{sorted(again)[0]}' already used in this match: find another word")
    if opening(text) in used.get("openings", set()):
        out.append(f"another line already starts '{opening(text)}': start differently")
    return out


# --- templates ---------------------------------------------------------------------------------

def template(m, story, lang):
    """A sentence from the facts alone, in lang. Used when the AI text cannot be verified. Scores are
    leader first; a missing player name falls back to the team, never to an empty slot."""
    i = LANGS.index(lang)
    kind = story["kind"]
    facts = story["facts"]
    leader, s = m.lead(story["ts"])
    if kind == "recap":
        title = TITLES[story["phase"]][i]
        if leader is None:
            text = TEMPLATES["recap_level"][i].format(title=title, s=s)
        else:
            key = "recap_win" if story["phase"] == "ft" else "recap_lead"
            text = TEMPLATES[key][i].format(title=title, leader=m.team_name(leader), s=s)
        acc = {f["team_id"]: f["value"] for f in facts if f["kind"] == "pass_accuracy"}
        h, a = m.home["team_id"], m.away["team_id"]
        if h in acc and a in acc:
            text += TEMPLATES["recap_acc"][i].format(home=m.team_word(h), away=m.team_word(a),
                                                     acc_h=f"{acc[h]:.0f}", acc_a=f"{acc[a]:.0f}")
        return text
    t = story["team_id"]
    team = m.team_name(t) or ""
    if kind == "tactical_shift" and story.get("shape"):
        old, new = story["shape"]
        return TEMPLATES["shape_shift"][i].format(team=team, old=old, new=new)
    main = [f for f in text_facts(story) if f["kind"] == MAIN_KIND.get(kind)]
    v = fmt(main[-1]["value"], lang) if main else ""
    player = m.player_name(story["player_id"]) or team
    if kind == "goal":
        kind = "goal_level" if leader is None else "goal_up" if leader == t else "goal_behind"
    elif kind == "comeback":
        kind = "comeback_level" if leader is None else "comeback_up"
    outcome = OUTCOMES.get(story.get("outcome"), ("",) * 3)[i]
    return TEMPLATES[kind][i].format(team=team, player=player, s=s, v=v, outcome=outcome)


def analysis_template(story):
    return " ".join(f"{display_label(f)} [{f['fact_id']}]." for f in story["facts"][:4])


# --- risk ----------------------------------------------------------------------------------------

def risk(story):
    """0..1: how much a person should look before this goes on air. A story whose claims the AI judge
    did not check always goes to review."""
    r = 0.05
    r += {"pass": 0.0, "rewritten": 0.05 if story.get("style_only") else 0.2,
          "template": 0.3}[story["verifier"]["status"]]  # a rewrite for style alone fixed no fact
    r += config.AUTO_APPROVE_RISK if story.get("unjudged") else 0.0  # claims without numbers not checked
    r += 0.1 if story["player_id"] else 0.0              # claims about one person
    r += 0.25 * (1 - min(max(story.get("confidence", 0.5), 0.0), 1.0))
    r += 0.3 if not story["fact_ids"] else 0.0
    return round(min(r, 1.0), 2)


def default_status(r):
    return "auto_approved" if r < config.AUTO_APPROVE_RISK else "needs_review"


# --- director ------------------------------------------------------------------------------------

_ALL_WHY = dict.fromkeys(("analyst", "casual", "own", "other"), ("why_card",))
PLAN = {
    "goal": dict.fromkeys(("analyst", "casual", "own", "other"), ("pass_shot", "why_card")),
    "comeback": _ALL_WHY,
    "recap": _ALL_WHY,
    "big_chance": {"analyst": ("pass_shot", "why_card"), "casual": ("pass_shot",), "own": ("pass_shot", "why_card"),
                   "other": ("pass_shot",)},
    "top_sprint": {"analyst": ("nameplate", "why_card"), "casual": ("nameplate",), "own": ("nameplate", "why_card"),
                   "other": ("nameplate",)},
    "momentum_swing": {"analyst": ("momentum", "why_card"), "casual": ("why_card",), "own": ("momentum", "why_card"),
                       "other": ()},
    "pressing_spell": {"analyst": ("why_card",), "casual": (), "own": ("why_card",), "other": ()},
    "tactical_shift": _ALL_WHY,
}
MAX_DELAY_S = 30.0  # a graphic that cannot start within this many seconds of its moment is dropped


class Director:
    """Picks graphic, time and duration per audience; never more than MAX_GRAPHICS_ON_SCREEN at once."""

    def __init__(self, m):
        self.m = m
        self.placed = {}  # audience -> [(start, end)]
        self.audiences = ["analyst", "casual"] + [f"team:{t}" for t in m.teams]

    def _slot(self, audience, ts, dur):
        placed = self.placed.setdefault(audience, [])
        for start in sorted({ts} | {e for _, e in placed if ts < e <= ts + MAX_DELAY_S}):
            if sum(s < start + dur and start < e for s, e in placed) < config.MAX_GRAPHICS_ON_SCREEN:
                placed.append((start, start + dur))
                return start
        return None

    def _role(self, audience, story):
        if audience in ("analyst", "casual"):
            return audience
        who, _, ident = audience.partition(":")
        mine = story["team_id"] == ident if who == "team" else story["player_id"] == ident
        if mine:
            return "own"
        if who == "player" and story["kind"] not in MUST_TELL:
            return None
        return "other"

    def payload(self, story, graphic, lang):
        m, facts = self.m, story["facts"]
        if graphic == "why_card":
            title = TITLES[story["phase"] if story["kind"] == "recap" else story["kind"]][LANGS.index(lang)]
            return {"kind": "recap" if story["kind"] == "recap" else "why", "title": title,
                    "body": story["texts"][lang], "fact_ids": story["fact_ids"]}
        if graphic == "pass_shot":
            shot = next((f for f in facts if f["kind"] == "shot_speed"), None)
            if not shot:
                return None
            goal = [f["fact_id"] for f in facts if f["kind"] == "score"]
            return {"mode": "shot", "player_id": shot["player_id"], "value": shot["value"], "unit": shot["unit"],
                    "quality": QUALITY[lang][0 if goal else 1], "fact_ids": [shot["fact_id"], *goal]}
        if graphic == "nameplate":
            sp = next((f for f in facts if f["kind"] == "sprint_speed"), None)
            if not sp:
                return None
            p = m.players.get(sp["player_id"], {})
            return {"player_id": sp["player_id"], "name": p.get("name"), "shirt": p.get("shirt"),
                    "team_short": m.teams.get(sp["team_id"], {}).get("short_name"), "speed_kmh": sp["value"],
                    "fact_id": sp["fact_id"]}
        if graphic == "momentum":
            return self.momentum(story["ts"])
        raise ValueError(graphic)

    def momentum(self, ts):
        so_far = [f for f in self.m.kind("momentum") if f["ts"] <= ts]
        if not so_far:
            return None
        return {"home": [f["value"] for f in so_far if f["team_id"] == self.m.home["team_id"]],
                "away": [f["value"] for f in so_far if f["team_id"] == self.m.away["team_id"]],
                "window": len({f["ts"] for f in so_far}), "fact_ids": [f["fact_id"] for f in so_far]}

    def plan(self, stories):
        """Cues (without cue_id) for every audience and language. Player audiences start with their first story."""
        for s in stories:
            if s["player_id"] and f"player:{s['player_id']}" not in self.audiences:
                self.audiences.append(f"player:{s['player_id']}")
        cues = []
        for s in sorted(stories, key=lambda s: s["ts"]):
            for audience in self.audiences:
                role = self._role(audience, s)
                t = s["ts"]
                for graphic in PLAN[s["kind"]].get(role, ()) if role else ():
                    if self.payload(s, graphic, "en") is None:
                        continue
                    start = self._slot(audience, t, DURATION[graphic])
                    if start is None:
                        continue
                    t = start + DURATION[graphic]  # the next graphic of the story follows this one
                    cues += [{"story_id": s["story_id"], "ts": start, "duration_s": DURATION[graphic],
                              "graphic": graphic, "audience": audience, "lang": lang,
                              "payload": self.payload(s, graphic, lang)} for lang in LANGS]
        return cues

    def window_cue(self, ts):
        """The analyst's momentum bars at the end of every 5-minute window, without a story."""
        p = self.momentum(ts)
        if p is None or (start := self._slot("analyst", ts, DURATION["momentum"])) is None:
            return []
        return [{"story_id": None, "ts": start, "duration_s": DURATION["momentum"], "graphic": "momentum",
                 "audience": "analyst", "lang": lang, "payload": p} for lang in LANGS]
