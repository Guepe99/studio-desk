"""The rule half of the agents (no AI): candidate moments, number checks, templates, risk, director.

Every number a rule uses comes from a fact the workflow read through the MCP server.
"""
import asyncio
import math
import re
import unicodedata

from .. import config, names
from ..export import DURATION
from ..facts.engine import BOX_DEPTH, BOX_HALF_WIDTH, LENGTH, SAVE_S, WIDTH, WINDOW_S, formation_name, shot_outcome

LANGS = ("en", "it", "es")
MUST_TELL = {"goal", "comeback", "recap"}

# Written rules per story kind. The finder agent reads RULES; the thresholds below decide what
# reaches it as a candidate.
TOP_SPRINT_KMH = 34.0          # the contract's "sprint above 34 km/h"
BIG_CHANCE_KMH = 100.0         # a saved or missed shot this fast is a big chance ...
BIG_CHANCE_DIST_M = 11.0       # ... and so is any shot from this close to goal
BIG_CHANCES_PER_WINDOW = 2     # at most this many big chances in one 5-minute window
# a shot is judged this long after it is hit: its outcome is final by then. Wide, over and blocked are
# in the shot event itself; a save counts within SAVE_S (facts.engine.shot_outcome), and in the four
# matches every save came 0.1 to 1.1 s after its shot. Shot facts are released at most 0.6 s after
# the shot and score facts at most 1.5 s, so a goal is never mistaken for a chance.
SETTLE_S = SAVE_S
SWING = 3.0                    # momentum: mean of the last 2 windows minus the 2 before
PRESS_SPELL = 5.0              # press intensity in one window, or ...
PRESS_PAIR = 4.3               # ... in two windows in a row, not flat (4.6 then 4.6 is no story)
PRESS_MIN_S = 180.0            # no pressing story from a window shorter than this (a stoppage-time stub)
REPEAT_S = 600.0               # no second swing or pressing story for a team within this of its last one
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
    "momentum_swing": ("Momentum swing", "Cambio di inerzia", "Cambio de dinámica"),
    "pressing_spell": ("Pressing", "Pressing", "Presión"),
    "tactical_shift": ("Tactical shift", "Cambio tattico", "Cambio táctico"),
    "ht": ("Half-time", "Fine primo tempo", "Descanso"),
    "ft": ("Full time", "Finale", "Final"),
}
QUALITY = {"en": ("Goal", "No goal"), "it": ("Gol", "Niente gol"), "es": ("Gol", "Sin gol")}
# Scores name the leader next to them, or say level ("2-2"). English writes the leader's goals first
# ("Ostwick FC lead 2-1"); Italian and Spanish write them as the scoreboard shows them, home goals first
# ("il Tarnby Harriers passa in vantaggio, 0-1"): score_text().
# In Italian and Spanish {team}, {leader} and {player} (when it falls back to the team) carry the
# club's article ("il Redwick", "l'Harbour", "el Redwick"); {Team} is the same at the start of a sentence.
TEMPLATES = {
    "goal_up": ("Goal! {player} puts {team} {s} up.", "Gol di {player}: {team} passa in vantaggio, {s}.",
                "¡Gol de {player}! {Team} se pone por delante, {s}."),
    "goal_more": ("Goal! {player} extends the lead for {team}, {s}.", "Gol di {player}: {team} allunga, {s}.",
                  "¡Gol de {player}! {Team} amplía la ventaja, {s}."),
    "goal_level": ("Goal! {player} draws {team} level at {s}.", "Gol di {player}: {team} pareggia, {s}.",
                   "¡Gol de {player}! {Team} empata, {s}."),
    "goal_behind": ("Goal! {player} pulls one back for {team}, but {leader} still lead {s}.",
                    "Gol di {player}: {team} accorcia, ma {leader} resta avanti, {s}.",
                    "¡Gol de {player}! {Team} recorta distancias, pero {leader} sigue por delante, {s}."),
    "comeback_level": ("{team} have come back to level at {s}.", "Rimonta completata: {team} pareggia, {s}.",
                       "Remontada: {team} empata, {s}."),
    "comeback_up": ("{team} have turned it round and lead {s}.", "Rimonta completata: {team} avanti {s}.",
                    "Remontada: {team} se pone por delante, {s}."),
    "big_chance": ("Big chance for {player}: a shot at {v} km/h, {outcome}.",
                   "Grande occasione per {player}: tiro a {v} km/h, {outcome}.",
                   "Ocasión clara para {player}: disparo a {v} km/h, {outcome}."),
    "top_sprint": ("{player} sprints at {v} km/h.", "{player} scatta a {v} km/h.", "{player} esprinta a {v} km/h."),
    "momentum_swing": ("Momentum for {team}: {trend}.", "Inerzia della partita per {team}: {trend}.",
                       "Inercia del partido para {team}: {trend}."),
    # neutral about strength: the path alone says whether the press rose or eased
    "pressing_spell": ("{team}'s pressing: intensity {trend}.", "Il pressing {team_di}: l'intensità {trend}.",
                       "La presión {team_de}: la intensidad {trend}."),
    "tactical_shift": ("{team} hold their defensive line at {v} m from their own goal.",
                       "{Team} tiene la linea difensiva a {v} m dalla propria porta.",
                       "{Team} sitúa su línea defensiva a {v} m de su portería."),
    "line_higher": ("{team} push their defensive line up, {trend}.", "{Team} alza la linea difensiva: {trend}.",
                    "{Team} adelanta su línea defensiva: {trend}."),
    "line_deeper": ("{team} drop their defensive line back, {trend}.", "{Team} abbassa la linea difensiva: {trend}.",
                    "{Team} retrasa su línea defensiva: {trend}."),
    "shape_shift": ("{team} switch from {old} to {new}.", "{Team} passa dal {old} al {new}.",
                    "{Team} pasa del {old} al {new}."),
    "recap_lead": ("{title}: {leader} lead {s}.", "{title}: {leader} in vantaggio, {s}.",
                   "{title}: {leader} por delante, {s}."),
    "recap_win": ("{title}: {leader} win {s}.", "{title}: {leader} vince {s}.", "{title}: {leader} gana {s}."),
    "recap_level": ("{title}: level at {s}.", "{title}: parità, {s}.", "{title}: empate, {s}."),
    "recap_acc": (" Pass completion: {home} {acc_h}%, {away} {acc_a}%.",
                  " Precisione nei passaggi: {home} {acc_h}%, {away} {acc_a}%.",
                  " Precisión en el pase: {home} {acc_h}%, {away} {acc_a}%."),
}
# What happened to a shot, from its events (facts.engine.shot_outcome), in each writer's language.
OUTCOMES = {"goal": ("goal", "gol", "gol"), "saved": ("saved", "parato", "parado por el portero"),
            "wide": ("wide", "a lato", "desviado"), "over": ("over the bar", "alto", "por encima del larguero"),
            "blocked": ("blocked", "respinto da un difensore", "rechazado por un defensa")}
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


# Italian articles by the sound the name starts with, and their merged forms with di, a, da, in, su.
_IT_ART = {"il": {"di": "del", "a": "al", "da": "dal", "in": "nel", "su": "sul"},
           "lo": {"di": "dello", "a": "allo", "da": "dallo", "in": "nello", "su": "sullo"},
           "l'": {"di": "dell'", "a": "all'", "da": "dall'", "in": "nell'", "su": "sull'"}}


def club(name, lang, prep=None, start=False):
    """A club name as a native commentator says it: "il Redwick Wanderers", "l'Harbour Vale FC", "lo
    Sporting", "del Redwick" (prep "di"); "el Redwick", "del Redwick" (prep "de"). English has no article."""
    if not name or lang == "en":
        return name or ""
    if lang == "it":
        art = "l'" if re.match(r"[aeiouhAEIOUH]", name) else \
            "lo" if re.match(r"(?:s[^aeiou]|z|x|gn|ps|y)", name, re.IGNORECASE) else "il"
        word = _IT_ART[art].get(prep, f"{prep} {art}" if prep else art)
    else:
        word = {"de": "del", "a": "al"}.get(prep, f"{prep} el" if prep else "el")
    text = word + name if word.endswith("'") else f"{word} {name}"
    return text[0].upper() + text[1:] if start else text


def shot_place(e):
    """Where a shot was taken from, from its event's start point: the zone (six_yard, box, byline, edge,
    outside), the attacker's side (None when central), the depth from the goal line and the distance
    off the centre line, in m. The shot goes towards the nearer goal; towards x=105 the right is y<34."""
    if not e or e.get("start_x") is None:
        return None
    goal_x = LENGTH if e["start_x"] > LENGTH / 2 else 0.0
    depth, off = abs(goal_x - e["start_x"]), e["start_y"] - WIDTH / 2
    central = abs(off) <= CENTRAL_M
    side = None if central else ("right" if (off < 0) == (goal_x > 0) else "left")
    if abs(off) <= 9.16 and depth <= 5.5:  # the six-yard box itself
        zone = "six_yard"
    elif side and depth <= 6.0:
        zone = "byline"
    elif depth <= BOX_DEPTH and abs(off) <= BOX_HALF_WIDTH:
        zone = "box"
    elif abs(off) <= 12.0 and depth <= 23.0:
        zone = "edge"
    else:
        zone = "outside"
    return {"zone": zone, "side": side if zone != "edge" else None, "depth": round(depth, 1),
            "offset": round(abs(off), 1)}


CENTRAL_M = 5.5  # "central", "middle of the box", "straight on": at most this far off the centre line
_SIDE = {"right": ("right", "destra", "derecha"), "left": ("left", "sinistra", "izquierda")}
PLACES = {  # number-free, and free of outcome words such as "wide"
    "six_yard": ("in the six-yard box", "nell'area piccola", "en el área pequeña"),
    "byline": ("from near the byline on the {side}", "dal fondo, sulla {side}", "desde la línea de fondo, por la {side}"),
    "box": ("from the middle of the box", "dal centro dell'area", "desde el centro del área"),
    "box_side": ("from the {side} side of the box", "dentro l'area, defilato sulla {side}",
                 "dentro del área, escorado a la {side}"),
    "edge": ("from the edge of the box", "dal limite dell'area", "desde la frontal del área"),
    "outside": ("from distance, straight on", "da fuori area, in posizione centrale", "desde fuera del área, por el centro"),
    "outside_side": ("from distance on the {side}", "da fuori area, sulla {side}", "desde fuera del área, por la {side}"),
}


def place_text(place, lang):
    """Where the shot came from, as a commentator says it ("dentro l'area, defilato sulla destra")."""
    if not place:
        return None
    i = LANGS.index(lang)
    key = place["zone"] + ("_side" if place["side"] and place["zone"] in ("box", "outside") else "")
    return PLACES[key][i].format(side=_SIDE[place["side"]][i] if place["side"] else "")


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

    def board(self, ts):
        """The score as the scoreboard shows it, home goals first: "0-1"."""
        score, _ = self.score_at(ts)
        return f"{score[self.home['team_id']]}-{score[self.away['team_id']]}"

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
        names = {p.get("name") or "" for p in self.players.values()}
        surnames = {n.split()[-1] for n in names if n}  # lines name a player by surname (required_name)
        for n in sorted(names | surnames | {t["name"] for t in self.teams.values()}, key=len, reverse=True):
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


def goal_candidates(m, score_fact, event=None):
    """A goal, and a comeback when the scoring team trailed just before this goal and is now level
    (RULES: a team that was behind is now level or ahead). One goal moves the score by one, so a
    comeback fires once per deficit, at the equaliser, and never again on the goals after it.
    `event` is the shot that scored (from get_events), for where it was taken from."""
    shot = [f for kind in ("shot_speed", "shot_distance") for f in m.kind(kind)
            if f["source_event_ids"] == score_fact["source_event_ids"]]
    out = [_cand("goal", score_fact["ts"], [score_fact, *shot], score_fact["team_id"], score_fact["player_id"],
                 note=score_fact["label_en"], outcome="goal", place=shot_place(event))]
    tid = score_fact["team_id"]
    other = next(t for t in m.teams if t != tid)
    now, goals = m.score_at(score_fact["ts"])
    was_behind = now[tid] - 1 < now[other]  # the score just before this goal
    if was_behind and now[tid] >= now[other]:
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


def chance_candidates(m, shots, saves=(), offered=None):
    """Big chances among `shots` (shot events from get_events, each at least SETTLE_S old, so `saves`, the
    keeper_save events up to now, settle its outcome): a shot without a goal at BIG_CHANCE_KMH or more or
    from BIG_CHANCE_DIST_M or closer, the fastest first, at most BIG_CHANCES_PER_WINDOW per 5-minute
    window. `offered` counts the chances already offered per window and is updated in place."""
    offered = {} if offered is None else offered
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
    out = []
    for f, d, e in sorted(chances, key=lambda c: -c[0]["value"]):
        outcome = shot_outcome(e, saves)
        start = m.p1 if e["period"] == 2 and m.p1 is not None else 0.0
        window = (e["period"], math.floor((e["ts"] - start) / WINDOW_S))  # the windows of facts.engine
        if outcome == "goal" or offered.get(window, 0) >= BIG_CHANCES_PER_WINDOW:
            continue
        offered[window] = offered.get(window, 0) + 1
        out.append(_cand("big_chance", f["ts"], [f] + ([d] if d else []), f["team_id"], f["player_id"],
                         note=f["label_en"] + (f", {d['label_en'].lower()}" if d else f", {OUTCOMES[outcome][0]}"),
                         outcome=outcome, header=e.get("bodypart_name") == "head", place=shot_place(e)))
    return out


def window_candidates(m, w0, w, shifted, told=()):
    """Candidates for the 5-minute window (w0, w]: momentum swings, pressing, tactical shift.

    `shifted` is the set of teams that already had a tactical shift story and is updated in place;
    `told` are the stories told so far, so a team's swing or pressing is not told again within REPEAT_S.
    """
    def recent(kind, tid):
        return any(s["kind"] == kind and s["team_id"] == tid and w - s["ts"] <= REPEAT_S for s in told)

    out = []
    period = 2 if m.p1 is not None and w > m.p1 + 1e-6 else 1
    in_period = lambda f: f["period"] == period  # noqa: E731
    swings = []
    for tid in m.teams:
        mom = [f for f in m.kind("momentum", tid) if in_period(f)]
        if len(mom) >= 4 and mom[-1]["ts"] == w:
            rise = (mom[-1]["value"] + mom[-2]["value"] - mom[-3]["value"] - mom[-4]["value"]) / 2
            if rise >= SWING and not recent("momentum_swing", tid):
                swings.append((rise, tid, mom[-4:]))
        press = [f for f in m.kind("press_intensity", tid) if in_period(f)]
        if (press and press[-1]["ts"] == w and w - w0 >= PRESS_MIN_S and not recent("pressing_spell", tid)
                and (press[-1]["value"] >= PRESS_SPELL or (
                    len(press) >= 2 and min(press[-1]["value"], press[-2]["value"]) >= PRESS_PAIR
                    and abs(press[-1]["value"] - press[-2]["value"]) > 0.15))):
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


def pack_story(m, s, events):
    """A story from a replay pack (stories.json) rebuilt with what the checks read: its facts and minute,
    the place of its shot (`events`: event_id -> event), the recap phase and the change of shape."""
    facts = [m.facts[i] for i in s["fact_ids"] if i in m.facts]
    story = {**s, "facts": facts, "minute": minute(s["ts"], m.period_of(s["ts"]), m.p1 or math.inf)}
    shot = next((f for f in facts if f["kind"] == "shot_distance" and f["source_event_ids"]), None)
    if shot:
        story["place"] = shot_place(events.get(shot["source_event_ids"][0]))
    if s["kind"] == "recap":
        story["phase"] = "ht" if m.p1 is not None and abs(s["ts"] - m.p1) < 1.0 else "ft"
    form = [f for f in facts if f["kind"] == "formation"]
    if s["kind"] == "tactical_shift" and form:
        story["shape"] = (formation_name(form[0]["value"]), formation_name(form[-1]["value"]))
    return story


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
# a number starts at any digit that does not continue another number ("No.7" and "x3" are numbers)
_LB = r"(?<!\d)(?<!\d[.,])"
_NUM = re.compile(
    _LB + r"(\d+(?:[.,]\d+)?)(?:st|nd|rd|th|º|ª|°)?\s*("
    + "|".join(sorted(map(re.escape, _UNIT), key=len, reverse=True)).replace(r"/10", r"/\s?10")
    + r")?(?![\w])", re.IGNORECASE)
# a digit run glued to letters ("96kmh") hides its unit from _NUM; only ordinals and known units may touch it
_GLUED = re.compile(_LB + r"\d+(?:[.,]\d+)?([^\W\d_]+)")
# letters glued in front of a number ("x3", "No7"): a count or a shirt number no fact gives
_LEAD_GLUED = re.compile(r"[^\W\d_]+\.?\d")
# a unit the ledger never uses: the number is a claim the code cannot check
_ALIEN = re.compile(_LB + r"\d+(?:[.,]\d+)?\s*(mph|miles?|yards?|yds?|feet|foot|ft|m/s|kmh|km/hr|goals?|goles|"
                    r"seconds?|secs?|segundos?|secondi|shots?|passes|corners?|tiri|tiros|-goal|-man)\b", re.IGNORECASE)
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
_CHAIN = re.compile(_LB + r"\d+(?:-\d+){2,}(?![\w.,]\d)")
_FACT_ID = re.compile(r"F-[A-Z_]+-\d+", re.IGNORECASE)
# the word the model puts before an id ("fact F-SCORE-000001", "fatto F-…"): it goes with the id
_CITED_AS = re.compile(r"\b(?:facts?|fatt[oi]|hechos?)\s*:?\s*(?=F-[A-Z_]+-\d+)", re.IGNORECASE)
_CITATION = re.compile(r"\s*\[\s*F-[A-Z_]+-\d+(?:\s*[,;]\s*F-[A-Z_]+-\d+)*\s*\]", re.IGNORECASE)


def _family(unit):
    return _UNIT[re.sub(r"\s+", " ", unit.lower()).replace("/ 10", "/10")] if unit else None


def _formation(chain):
    """442.0 for "4-4-2"; None when the chain is not a formation (single digits adding up to 10)."""
    parts = chain.split("-")
    return float("".join(parts)) if all(len(p) == 1 for p in parts) and sum(map(int, parts)) == 10 else None


def normalise(text):
    """NFKC (superscript and full-width digits become plain digits) and every decimal digit as ASCII,
    keeping the Spanish ordinals º and ª, which NFKC would turn into letters."""
    text = "".join(ch if ch in "ºª" else unicodedata.normalize("NFKC", ch) for ch in str(text))
    return re.sub(r"\d", lambda mt: str(unicodedata.decimal(mt.group(0), 0)), text)


def minute_word(text, lang):
    """The minute word in the answer's language: the model writes "minuto 10" in English now and then."""
    word = "minute" if lang == "en" else "minuto"
    text = re.sub(r"\bminut[eo](?= \d)", lambda m: word.capitalize() if m.group(0)[0].isupper() else word, text,
                  flags=re.IGNORECASE)
    # the article the model drops: "ai minuto 10 e minuto 13" reads "al minuto 10 e al minuto 13"
    if lang == "it":
        return re.sub(r"\b(?:ai|a|e)(?= minuto \d)", lambda m: "e al" if m.group(0) == "e" else "al", text)
    return re.sub(r"\b(en|y)(?= minuto \d)", r"\1 el", text) if lang == "es" else text


def decimal_comma(text, lang):
    """Italian and Spanish write 32,8: the model copies the facts' 32.8 now and then."""
    return text if lang == "en" else re.sub(r"(?<=\d)\.(?=\d)", ",", text)


def strip_citations(text):
    """Text without fact-id citations ("[F-SHOT_SPEED-000031]"): the ids live in fact_ids, never on the desk."""
    text = _FACT_ID.sub("", _CITATION.sub("", _CITED_AS.sub("", text)))
    text = re.sub(r"\s*[,;]\s*(?=\))", "", text)  # "(minuto 10, )" reads "(minuto 10)"
    return re.sub(r"\s+([.,;:!?])", r"\1", re.sub(r"\(\s*(?:facts?\s*)?\)|\[\s*\]", "", text)).strip()


def allowed_numbers(facts, minutes=()):
    """(value, family) pairs a text about these facts may contain. Family None means a bare number,
    which must match exactly; "formation" is a shape like 4-4-2 (value 442).
    `minutes` are (display minute, period); one in stoppage time is allowed as "45+2" (45 and 2), not as 47."""
    out = []
    for mi, period in minutes:
        out += [(float(x), None) for x in stoppage(mi, period).split("+")]
    for f in facts:
        fam = "formation" if f["unit"] == "formation" else _FAMILY.get(f["unit"])
        out.append((f["value"], fam))
        if fam == "m":
            out.append((f["value"] / 1000, "km"))
        if fam == "ten":
            out.append((10.0, None))
        label = _CHAIN.sub("", _FACT_ID.sub("", display_label(f)))  # a formation in a label is not three numbers
        for mt in _NUM.finditer(label):  # label numbers keep their own unit
            out.append((float(mt.group(1).replace(",", ".")), _family(mt.group(2))))
    return out


def check_numbers(text, allowed, lang="en", ids=(), bare=True):
    """Flags for every number in text that is not in the ledger: a number with a unit within rounding of
    a fact with that unit, a bare number exactly equal to one, a formation exactly one of the story's.
    Also numbers written in words, glued to letters or followed by a unit the ledger does not use, and
    cited fact ids that are not among the story's (`ids`). Every flag starts with a fixed reason.
    With `bare` False no bare number passes: each must carry the unit of its fact (an Ask answer)."""
    text = normalise(text)
    flags = [f"cited fact not in the story: '{mt.group(0)}'" for mt in _FACT_ID.finditer(text)
             if mt.group(0).upper() not in ids]
    text = _FACT_ID.sub("", text)  # cited fact ids are not numbers
    flags += [f"number in words: '{w}' (write digits from the facts)"
              for w in _SPELLED[lang].findall(_NOT_A_NUMBER.sub("", text))]
    shapes = {v for v, fam in allowed if fam == "formation"}
    chains = list(_CHAIN.finditer(text))
    for mt in chains:
        shape = _formation(mt.group(0))
        if shape is None:
            flags.append(f"garbled numbers: '{mt.group(0)}'")
        elif shape not in shapes:
            flags.append(f"formation not in the facts: '{mt.group(0)}'")
    alien = list(_ALIEN.finditer(text))
    flags += [f"unit not in the facts: '{mt.group(0)}'" for mt in alien]
    skip = {mt.start() for mt in alien}
    in_chain = lambda i: any(c.start() <= i < c.end() for c in chains)  # noqa: E731
    flags += [f"unit glued to a number: '{mt.group(0)}'" for mt in _GLUED.finditer(text)
              if mt.start() not in skip and mt.group(1).lower() not in _ORDINAL and mt.group(1).lower() not in _UNIT]
    flags += [f"letters glued to a number: '{mt.group(0)}'" for mt in _LEAD_GLUED.finditer(text)]
    for mt in _NUM.finditer(text):
        if mt.start() in skip or in_chain(mt.start()):
            continue
        raw, unit = mt.group(1), mt.group(2)
        x = float(raw.replace(",", "."))
        decimals = len(raw.split(",")[-1] if "," in raw else raw.split(".")[-1]) if re.search(r"[.,]", raw) else 0
        tol = 0.5 * 10 ** -decimals + 1e-9
        fam = _family(unit)
        if fam is None:  # a bare number claims nothing about what it measures: it must be one of the story's
            if bare and any(f not in ("formation", "km") and abs(x - v) < 1e-6 for v, f in allowed):
                continue
            flags.append(f"number not in the facts: '{mt.group(0).strip()}'")
            continue
        near = [(v, f) for v, f in allowed if abs(x - v) <= tol]
        if any(f == fam for _, f in near):
            continue
        shown = mt.group(0).strip()
        if any(f for _, f in near):
            flags.append(f"unit mismatch: '{shown}' (ledger: {', '.join(sorted({f for _, f in near if f}))})")
        else:
            flags.append(f"number not in the facts: '{shown}'")
    return flags


def check_text(text, allowed, lang="en", ids=(), bare=True):
    """All rule checks on one text: numbers against the ledger, cited fact ids against the story's
    (`ids`), then forbidden real names. The flag never repeats the name, because flags are shown to people."""
    return check_numbers(text, allowed, lang, ids, bare) + ["forbidden name (real person or club)"] * bool(
        names.find_forbidden(text))


# --- Ask the studio: one visitor's answer, held to stricter rules than a story -------------------
# A minute is a minute only when it is written as one; as a bare number "2" or "10" it would pass for a count.
_MINUTE = re.compile(r"\b(?:min|minutes?|minut[oi]s?)\.?\s+(\d+(?:\+\d+)?)(?:\s*-\s*(\d+(?:\+\d+)?))?"
                     r"|" + _LB + r"(\d+(?:\+\d+)?)\s*['’′]", re.IGNORECASE)
_LABEL_MINUTES = re.compile(r",?\s*\bmin (\d+(?:\+\d+)?)-(\d+(?:\+\d+)?)")
# number words on top of _WORDS, in an answer every language's list runs (plurals too: "hundreds", "cientos");
# "uno", "una" and "un" are left out, they are the Italian and Spanish articles
_ASK_WORDS = {
    "en": "zero one half halves single couple pair double triple treble both first second thrice eleventh twelfth "
          "million",
    "it": "zero mezzo metà paio coppia doppio doppia triplo tripla entrambi entrambe ambedue primo secondo seconda "
          "centinaia decine migliaia dozzina dozzine milione milioni undicesimo dodicesimo",
    "es": "cero mitad medio par doble triple ambos ambas primer primero primera segundo segunda cuarto cuarta sexta "
          "séptima octava novena décima docena cientos centenares decenas miles millón millones undécimo duodécimo",
}
# words of another language's list that are ordinary words in the answer's own language
_FALSE_FRIENDS = {"en": {"once", "due", "dues", "miles", "par", "pars"}, "it": {"medio", "medios"}, "es": {"ten"}}
_ASK_SPELLED = re.compile(r"(?<!\w)(?:" + "|".join(sorted({re.escape(w) for lang in LANGS for w in (
    _WORDS[lang] + " " + _ASK_WORDS[lang]).split()}, key=len, reverse=True))
    + "|" + "|".join(f"(?:{t})\\w*" for t in _TENS.values() if t) + r")s?(?!\w)", re.IGNORECASE)
# "il terzo gol" is a fact when the answer cites that goal: its label carries the score after it ("Goal 2-1" is goal 3)
# shortcut: the ordinal is checked against the cited goals, not tied to the minute next to it; tie them if a wrong pairing shows up
_GOAL_ORDINALS = {w: k for words in (
    "first second third fourth fifth sixth seventh eighth ninth tenth",
    "primo secondo terzo quarto quinto sesto settimo ottavo nono decimo",
    "primer segundo tercer cuarto quinto sexto séptimo octavo noveno décimo") for k, w in enumerate(words.split(), 1)}
_GOAL_ORDINALS |= {"primero": 1, "tercero": 3}
_GOAL_ORDINAL = re.compile(r"(?<!\w)(?:" + "|".join(_GOAL_ORDINALS) + r")(?!\w)", re.IGNORECASE)
_GOAL_LABEL = re.compile(r"\bGoal (\d+)-(\d+)\b")
# an equaliser is a claim about the score: the goal at the minute that follows the word must leave it level
_EQUALISER = re.compile(r"\b(?:equali[sz]\w*|pareggi\w*|parit[àa]|empat\w*)", re.IGNORECASE)
_MINUTE_AFTER = re.compile(r"\bmin(?:ut[eo]s?|\.)?\s*(\d+(?:\+\d+)?)|(\d+(?:\+\d+)?)'", re.IGNORECASE)
_ASK_NOT_A_NUMBER = re.compile(
    r"\b(?:first|second)[- ]half\b|\bhalf[- ]time\b|\bhalfway\b|\bfirst[- ]time\b|\bfirst touch\b|"
    r"\bsecond balls?\b|\b(?:first|second) post\b|\bboth (?:teams|sides)\b|"
    r"\bin mezzo\b|\bmetà (?:del )?campo\b|\b(?:prima|seconda) metà\b|\b(?:primo|secondo) (?:tempo|palo)\b|"
    r"\bseconda palla\b|\bsecondo (?:i|il|lo|la|le|gli|l'|me|noi)\b|\bentrambe le squadre\b|"
    r"\b(?:primer|segundo) (?:tiempo|palo)\b|\b(?:primera|segunda) (?:parte|mitad)\b|\bsegunda jugada\b|"
    r"\bmitad del campo\b|\bmitad de (?:la )?cancha\b|\bmedio ?campo\b|\b(?:en|por) medio\b|\blos medios\b|"
    r"\bambos equipos\b|\ba la par\b", re.IGNORECASE)
_ROMAN = re.compile(r"(?<!\w)[IVXLC]{2,}(?!\w)")  # "III", "XI"; a lone "I" is the pronoun
# events the ledger has no fact of: an answer may name one only when it cites a fact of that kind
_EVENT_NOT = re.compile(r"\bpenalty (?:area|box)(?:es)?\b|\baree? di rigore\b|\b[aá]rea de penalti\b|\binjury time\b",
                        re.IGNORECASE)
_EVENTS = {kind: re.compile(rf"(?<!\w)(?:{w})(?!\w)", re.IGNORECASE) for kind, w in {
    "card": r"red cards?|yellow cards?|sent off|sending[- ]off|booked|bookings?|cartellin[oi] (?:ross|giall)[oi]|"
            r"espuls\w*|ammoni\w+|tarjetas? (?:rojas?|amarillas?)|expulsad[oa]s?|expulsi[oó]n|amonestad[oa]s?|"
            r"amonestaci[oó]n",
    "penalty": r"penalt(?:y|ies)|rigor[ei]|penaltis?|penales?",
    "injury": r"injur(?:y|ies|ed)|infortun\w*|lesi[oó]n(?:es)?|lesionad[oa]s?",
    "own_goal": r"own[- ]goals?|autogol\w*|autoret[ei]|propia (?:puerta|meta)",
    "offside": r"offside|off-side|fuori ?gioco|fuera de (?:juego|lugar)",
    "var": r"VAR",
    "substitution": r"substitut\w*|subbed|sostitu\w*|sustitu\w*",
}.items()}
# a link, a domain or an address, also spelled out ("dot com"): the studio never sends a viewer anywhere
_LINK = re.compile(r"https?:|www\.|@|(?<![\w.])[\w-]{2,}\.(?:[a-z]{2,}\.)*[a-z]{2,}(?![\w])|"
                   r"\b(?:dot|punto)\s*(?:com|net|org|io|info|eu|co|uk|it)\b|\bdot\s*es\b|\bdotcom\b|[(\[]\s*dot\s*[)\]]",
                   re.IGNORECASE)
# function words only one of the three languages uses; the answer must have more of its own than of any other
_LANG_WORDS = {lang: re.compile(rf"(?<!\w)(?:{w})(?!\w)", re.IGNORECASE) for lang, w in {
    "en": "the|of|and|was|were|is|are|at|on|with|by|to|has|have|had|his|their|from|after|for|this|that|than|far",
    "it": "il|gli|di|della|dei|delle|degli|nel|nei|nella|sul|dal|alla|alle|agli|è|e|che|per|sono|più|dopo|finora|"
          "hanno|stato|stata",
    "es": "el|los|las|y|de|que|por|para|en|fue|tras|más|es|sus|hasta|ahora|ha sido",
}.items()}
# a score: "2-1", "2 to 1", "2 a 1", never part of a formation or a decimal
_ASK_SCORE = re.compile(r"(?<![\w.,-])(\d{1,2})(?:\s*[-–]\s*|\s+(?:to|a)\s+)(\d{1,2})(?![\w.,-]*\d)", re.IGNORECASE)
# numbers that carry a noun, not a unit: "7 sprints", "xT +0.034", a pass count "228/276" or "228 of 276 passes"
_NOUN_NUMBERS = {
    "sprints": re.compile(_LB + r"(\d+)\s+(?:sprints?|scatt[oi]|esprints?)\b", re.IGNORECASE),
    "xT": re.compile(r"\bxT\s*(?:of|di|de|:)?\s*([+-]?\d+(?:[.,]\d+)?)|" + _LB + r"([+-]?\d+(?:[.,]\d+)?)\s*xT\b"),
}
_PAIR = re.compile(_LB + r"(\d+)\s*/\s*(\d+)(?![\d.,]*\d)|" + _LB
                   + r"(\d+)\s+(?:of|out of|su|de|di)\s+(\d+)\s+(?:passes|passaggi|pases)\b", re.IGNORECASE)
_LABEL_PAIR = re.compile(r"\((\d+)/(\d+)\)")
MAX_ASK_FACTS = 8


def _near(raw, value):
    """A number as written ("0,03") within rounding of a value."""
    decimals = len(re.split(r"[.,]", raw)[1]) if re.search(r"[.,]", raw) else 0
    return abs(float(raw.replace(",", ".")) - value) <= 0.5 * 10 ** -decimals + 1e-9


def _language(text, lang):
    """True unless another language has as many function words in the answer as `lang`, and at least one
    ("Both teams in a 4-3-3." has none of the three and passes)."""
    counts = {k: len(p.findall(text)) for k, p in _LANG_WORDS.items()}
    other = max(n for k, n in counts.items() if k != lang)
    return other == 0 or counts[lang] > other


def check_answer(text, facts, p1, lang, ids, score=None):
    """All checks on an Ask answer about `facts` (the cited ones, all at or before the question's ts).
    `score` is (home, away) at ts; without it no score may be claimed.
    On top of check_text: minutes only as minutes ("2'", "min 2", "45+2'") and only the cited facts' own;
    a score only as the score at ts; every other number with the unit or noun its fact gives it (7 with
    "sprints", 29.3 with "km/h"), never bare; number words of all three languages; no letter-number
    characters ("Ⅲ") or roman numerals; the answer quotes at least one cited fact; no event (card, penalty,
    injury, own goal, offside, VAR, substitution) without a cited fact of that kind; no link; in `lang`."""
    flags = ["number in words: letter-number character"] * any(unicodedata.category(c) == "Nl" for c in text)
    own = {stoppage(minute(f["ts"], f["period"], p1), f["period"]) for f in facts}
    minutes = set(own)
    for f in facts:
        for mt in _LABEL_MINUTES.finditer(display_label(f)):
            minutes |= set(mt.groups())
    quoted = False

    def said(mt):
        nonlocal quoted
        flags.extend(f"minute not in the facts: '{g}'" for g in mt.groups() if g and g not in minutes)
        quoted |= any(g in own for g in mt.groups())  # a cited fact's own minute quotes that fact
        return " "
    rest = _MINUTE.sub(said, normalise(text))

    after_goal = {tuple(map(int, g)): stoppage(minute(f["ts"], f["period"], p1), f["period"])
                  for f in facts if f["kind"] == "score" for g in _GOAL_LABEL.findall(f["label_en"])}

    def at_its_goal(said):
        """A cited goal's own label ("Goal 2-1") is the score right after it, said next to its minute."""
        mi = after_goal.get(said)
        return mi is not None and any(
            re.search(rf"(?<![\d+]){re.escape(mi)}(?![\d+])", text[max(0, o.start() - 40):o.end() + 40])
            for o in re.finditer(rf"(?<!\d){said[0]}\s*-\s*{said[1]}(?!\d)", text))

    def scored(mt):
        nonlocal quoted
        if _NUM.match(rest, mt.start(2)).group(2):  # "from 3 to 5 m" is a range with a unit, not a score
            return mt.group(0)
        said = tuple(map(int, mt.groups()))
        if (score is None or said != tuple(score)) and not at_its_goal(said):  # home first, as on the score bug
            flags.append(f"score not the score at ts: '{mt.group(0)}'")
        quoted |= any(f["kind"] == "score" for f in facts)
        return " "
    rest = _ASK_SCORE.sub(scored, rest)

    def licensed(values):
        def sub(mt):
            nonlocal quoted
            raws = [g for g in mt.groups() if g is not None]
            if any(len(raws) == len(v) and all(_near(r, x) for r, x in zip(raws, v)) for v in values):
                quoted = True
                return " "
            return mt.group(0)  # left for check_text, which declines a bare number
        return sub
    for unit, pattern in _NOUN_NUMBERS.items():
        rest = pattern.sub(licensed([(f["value"],) for f in facts if f["unit"] == unit]), rest)
    pairs = [tuple(map(float, mt.groups())) for f in facts for mt in _LABEL_PAIR.finditer(f["label_en"])]
    rest = _PAIR.sub(licensed(pairs), rest)

    goals = {int(a) + int(b) for f in facts if f["kind"] == "score" for a, b in _GOAL_LABEL.findall(f["label_en"])}
    rest = _GOAL_ORDINAL.sub(lambda mt: " " if _GOAL_ORDINALS[mt.group(0).lower()] in goals else mt.group(0), rest)
    bare = [{**f, "label_en": _LABEL_MINUTES.sub("", f["label_en"])} for f in facts]
    flags += check_text(rest, allowed_numbers(bare), lang, ids, bare=False)
    words = _NOT_A_NUMBER.sub("", _ASK_NOT_A_NUMBER.sub("", _FACT_ID.sub("", rest)))
    flags += [f"number in words: '{w}' (write digits from the facts)" for w in _ASK_SPELLED.findall(words)
              if w.lower() not in _FALSE_FRIENDS[lang]]
    flags += [f"number in words: roman numeral '{w}'" for w in _ROMAN.findall(rest)]
    quoted = quoted or _NUM.search(_FACT_ID.sub("", rest)) or any(display_label(f).lower() in text.lower() for f in facts)
    flags += ["answer quotes no cited fact"] * (not quoted)
    level = {stoppage(minute(f["ts"], f["period"], p1), f["period"]) for f in facts if f["kind"] == "score"
             for a, b in _GOAL_LABEL.findall(f["label_en"]) if a == b}
    for mt in _EQUALISER.finditer(text):
        at = _MINUTE_AFTER.search(text[mt.end():mt.end() + 60])
        if not (level if at is None else (at.group(1) or at.group(2)) in level):
            flags.append(f"equaliser not in the facts: '{mt.group(0)}'")
    kinds, events = {f["kind"] for f in facts}, _EVENT_NOT.sub("", text)
    flags += [f"event not in the facts: {kind}" for kind, p in _EVENTS.items() if kind not in kinds and p.search(events)]
    flags += ["link or address in the answer"] * bool(_LINK.search(text))
    return flags + ["answer not in the visitor's language"] * (not _language(text, lang))


def story_facts(story, cited=True):
    """The story's own facts and the ones the analyst cited (the analysis may quote those; the lines,
    graphics and templates use only the story's own)."""
    return story["facts"] + (story.get("cited", []) if cited else [])


def story_minutes(m, story, cited=False):
    return ({(m.minute_of(f), f["period"]) for f in story_facts(story, cited)}
            | {(story["minute"], m.period_of(story["ts"]))})


def story_allowed(m, story, cited=False):
    """Numbers a text about this story may use: its facts (and, for the analysis, the cited ones), their
    minutes and the score at that moment (also 0-0, which has no goal fact)."""
    _, goals = m.score_at(story["ts"])
    score = [(float(x), None) for x in m.lead(story["ts"])[1].split("-")]
    return allowed_numbers(story_facts(story, cited) + goals, story_minutes(m, story, cited)) + score


def story_ids(story):
    return {f["fact_id"] for f in story_facts(story)}


def text_facts(story):
    """The facts a line should read out: for a momentum swing the low before, the peak and, when it fell
    back, the last window; for a pressing spell its last two windows; for a moved defensive line where
    it started (the lowest or highest of the windows before) and where it ended; otherwise all of them."""
    facts = story["facts"]
    if story["kind"] in ("momentum_swing", "pressing_spell"):  # a goal fact in the story is not a window
        facts = [f for f in facts if f["kind"] in ("momentum", "press_intensity")]
    if story["kind"] == "momentum_swing" and len(facts) >= 4:
        low, peak = min(facts[:2], key=lambda f: f["value"]), max(facts[2:], key=lambda f: f["value"])
        return [low, peak] + ([facts[-1]] if peak is not facts[-1] else [])
    if story["kind"] == "pressing_spell":
        return facts[-2:]
    if (path := line_path(story)) and not story.get("shape"):
        return [path["from"], path["to"]]
    return facts


def trend_shape(values):
    """How a run of values moved: rose_then_fell, fell_then_rose, rising, falling or steady (0.2 slack)."""
    if len(values) < 2:
        return "steady"
    first, last, inner = values[0], values[-1], values[1:-1]
    if inner and max(inner) > max(first, last) + 0.2:
        return "rose_then_fell"
    if inner and min(inner) < min(first, last) - 0.2:
        return "fell_then_rose"
    return "rising" if last > first + 0.2 else "falling" if last < first - 0.2 else "steady"


# a value path as a commentator says it; {0} {1} {2} are "value at minute" in time order
SINGLE_VALUE = ("{}/10", "è di {}/10", "es de {}/10")  # a pressing spell of one window, no path
TREND_WORDS = {
    "rising": ("up from {0} to {1}", "sale da {0} a {1}", "sube de {0} a {1}"),
    "falling": ("down from {0} to {1}", "scende da {0} a {1}", "baja de {0} a {1}"),
    "steady": ("steady, {0} and then {1}", "stabile, {0} e poi {1}", "estable, {0} y luego {1}"),
    "rose_then_fell": ("up from {0} to {1}, then down to {2}", "sale da {0} a {1}, poi scende a {2}",
                       "sube de {0} a {1} y luego baja a {2}"),
    "fell_then_rose": ("down from {0} to {1}, then up to {2}", "scende da {0} a {1}, poi risale a {2}",
                       "baja de {0} a {1} y luego sube a {2}"),
    "higher": ("from {0} to {1}, measured from their own goal", "da {0} a {1}, misurata dalla propria porta",
               "de {0} a {1}, medida desde su portería"),
    "deeper": ("from {0} to {1}, measured from their own goal", "da {0} a {1}, misurata dalla propria porta",
               "de {0} a {1}, medida desde su portería"),
}


def _at(m, f, lang, first):
    """ "in the 65th minute" (first) or "by the 70th"; "al minuto 65" or "al 70" ("all'80"); "en el minuto 65"
    or "en el 70"; stoppage time as "45+2'". A later minute drops the word, so it is not repeated."""
    mi, period = m.minute_of(f), f["period"]
    if mi > (45 if period == 1 else 90):
        return {"en": "at", "it": "al", "es": "en el"}[lang] + f" {stoppage(mi, period)}'"
    if first:
        return {"en": "in the ", "it": "al ", "es": "en el "}[lang] + minute_text(mi, period, lang)
    if lang == "it":
        return f"all'{mi}" if mi in (1, 8, 11) or 80 <= mi <= 89 else f"al {mi}"
    return f"by the {ordinal(mi)}" if lang == "en" else f"en el {mi}"


def trend(m, story, lang="en"):
    """The path of a momentum, pressing or defensive-line story as a ready phrase in lang, with its shape:
    {"shape": "rose_then_fell", "say": "up from 1.9/10 in the 30th minute to 6.7/10 by the 35th, then down
    to 5.8/10 by the 40th"}. None for other stories."""
    if story["kind"] in ("momentum_swing", "pressing_spell"):
        facts = [f for f in text_facts(story) if f["kind"] in ("momentum", "press_intensity")]
        shape = trend_shape([f["value"] for f in facts])
    elif (path := line_path(story)) and not story.get("shape"):
        facts, shape = [path["from"], path["to"]], path["direction"]
    else:
        return None
    if len(facts) < 2:
        return None
    unit = lambda f: f"{fmt(f['value'], lang)}/10" if f["unit"] == "/10" else f"{fmt(f['value'], lang)} m"  # noqa: E731
    points = [f"{unit(f)} {_at(m, f, lang, i == 0)}" for i, f in enumerate(facts)]
    return {"shape": shape, "say": TREND_WORDS[shape][LANGS.index(lang)].format(*points)}


def line_path(story):
    """A defensive line's move in a tactical-shift story: {"direction": "higher" | "deeper", "from": the
    lowest (or highest) window before, "to": the last window}. The value is metres from the team's own
    goal, so a bigger value is a higher line. None without at least two line windows."""
    line = [f for f in story["facts"] if f["kind"] == "line_height"]
    if story["kind"] != "tactical_shift" or len(line) < 2:
        return None
    before, after = (line[:-2], line[-2:]) if len(line) >= 5 else (line[:1], line[-1:])
    delta = sum(f["value"] for f in after) / len(after) - sum(f["value"] for f in before) / len(before)
    higher = delta > 0
    start = (min if higher else max)(before, key=lambda f: f["value"])
    return {"direction": "higher" if higher else "deeper", "from": start, "to": line[-1]}


def width_change(story):
    """"wider", "narrower" or "unchanged" (under 0.5 m) from the first and last team-width facts, or None."""
    width = [f for f in story["facts"] if f["kind"] == "team_width"]
    if len(width) < 2:
        return None
    d = width[-1]["value"] - width[0]["value"]
    return "wider" if d >= 0.5 else "narrower" if d <= -0.5 else "unchanged"


def ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def minute_text(mi, period, lang):
    """A minute as a commentator writes it: "41st minute", "minuto 41", or "45+2'" in stoppage time."""
    if mi > (45 if period == 1 else 90):
        return f"{stoppage(mi, period)}'"
    return f"{ordinal(mi)} minute" if lang == "en" else f"minuto {mi}"


def score_text(m, ts, lang):
    """The score as a commentator in lang writes it: leader first in English ("2-1"), home goals first
    in Italian and Spanish, as on the scoreboard ("1-2")."""
    return m.lead(ts)[1] if lang == "en" else m.board(ts)


def number_list(m, story, lang="en"):
    """The numbers a commentator may write about this story, as strings for the prompt ("96 km/h",
    "6 m", "4-4-2", "41st minute"), with the decimal comma in Italian and Spanish and long distances in km.
    The score is listed only for a story whose point is the score, in lang's order (score_text)."""
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
        out.append(score_text(m, story["ts"], lang))
    return list(dict.fromkeys(out))


# Distance words, the shot distances (m from the goal centre) at which they are true and, when the
# shot's start point is known, the zones where they are true instead. Long-range words also need the
# shot label to say "outside the box" (a shot from 18 m out wide can be inside it).
DISTANCE_WORDS = [
    (r"six[- ]yard|area piccola|área pequeña|área chica", 0.0, 7.0, ("six_yard",)),
    (r"point[- ]blank|bruciapelo|bocajarro|quemarropa", 0.0, 6.0, None),
    (r"close[- ]range|tap[- ]in|ravvicinat\w*|da pochi passi|boca de gol", 0.0, 11.0, None),
    (r"edge of the (?:box|area)|(?:dal|al) limite|limite dell['’]area|borde del área|(?:la )?frontal(?: del área)?",
     14.0, 26.0, ("edge", "box_central")),
]
LONG_RANGE = (r"from (?:distance|range|outside)|long[- ]range|outside the (?:box|area)|da fuori|dalla distanza|"
              r"da lontano|fuori area|fuori dall['’]area|desde fuera|desde lejos|lejano|larga distancia|media distancia|"
              r"fuera del área")
IN_THE_BOX = r"inside the (?:box|area)|in the (?:box|area)|dentro l['’]area|in area|dentro del área|en el área"
# where the ball went, how it was struck and how the chance was made: no fact or event field gives these
INVENTED = {"en": r"near[- ]post|far[- ]post|top corner|bottom corner|corner of the net|top bins|pull[- ]back|cross|"
                  r"crossed|volley\w*|rebound|scramble|deflect\w*|turnovers?|knock[- ]?down|lay[- ]?off|assist\w*|wind|"
                  r"(?:the|a) post|woodwork|behind the (?:defen[cs]e|line|back line)|in behind|forc\w* (?:an )?errors?|"
                  r"side-?foot\w*|instep|outside of (?:the|his|her) (?:boot|foot)|toe-?poke\w*|"
                  r"(?:into|in|inside) the (?:\w+ )?corner|chip\w*|lob\w*|curl\w*|bend\w*|bent|comfortabl\w*|rattl\w*|"
                  r"thump\w*|turns? and|swivel\w*",
            "it": r"primo palo|secondo palo|incrocio|angolino|cross|al volo|tiro-volley|ribattuta|deviazion\w*|"
                  r"palle recuperate|recuper\w+ palla|sponda|assist\w*|vento|palo|traversa|"
                  r"(?:alle spalle|dietro) (?:della|la) difesa|costring\w* (?:all['’])?error\w*|forzando (?:gli )?error\w*|"
                  r"di piatto|piattone|collo pieno|di collo|d['’]esterno|di esterno|con l['’]esterno|di punta|"
                  r"nell['’]angolo|all['’]angolo|a giro|pallonetto|scavetto|cucchiaio|giro palla|sostegno continuo",
            "es": r"primer palo|segundo palo|escuadra|centro al área|volea|rechace|desv[ií]o|p[eé]rdidas?|robos?|asistencia|"
                  r"dejada|viento|poste|palo|larguero|a la espalda de la defensa|forz\w* errores|con el interior|de interior|"
                  r"con el exterior|de exterior|empeine|puntera|punterazo|rincón|vaselina|picad[ao]|de rosca|colocad[ao]|"
                  r"roz\w*"}
# which foot: a side is invented unless the shot label names it; an Italian "destro" is a right-foot shot
FOOT = {"en": r"(?:left|right)[- ]foot\w*|weaker foot|with (?:his|her|the) (?:left|right)",
        "it": r"di destro|di sinistro|mancino|col destro|col sinistro|"
              r"(?<!lato )(?<!versante )(?<!settore )(?<!fianco )(?:destro|sinistro)",
        "es": r"zurdazo|derechazo|con (?:la |su )?(?:zurda|diestra|izquierda|derecha)|de zurda|pierna (?:izquierda|derecha)|"
              r"pie (?:izquierdo|derecho)"}
# what happened to the shot: each set is true for one outcome only
SHOT_WORDS = {
    "goal": {"en": r"scores|scored|nets|netted|finds? the net|found the net|smash\w* (?:it |one )?in|fires? home|"
                   r"fired home|slots?(?: it)? (?:home|in)|slotted|tucks?(?: it)? (?:home|in|away)|tucked|buries|buried|"
                   r"into the net|nestl\w*|back of the net|beats? the keeper|slides? under",
             "it": r"segn(?:a|ano|ato|ò|ando|are)|insacc\w*|in rete|va a segno|gonfi\w* la rete|(?:la )?mette dentro|"
                   r"(?:la )?butta dentro",
             "es": r"marca(?:ndo)?(?: el| su)? gol|marcó|anota|anotó|al fondo de la red|la mete|la empuja|perfora\w*"},
    "over": {"en": r"over the (?:bar|crossbar|top)|skie[sd]|blaze[sd]? over|balloon\w*|high and wide|sails? over|flies over|"
                   r"goes over",
             "it": r"alt[ao](?! (?:velocità|intensità|potenza))|sopra la traversa|sopra il set",
             "es": r"por encima|alt[ao](?! velocidad)|a las nubes|se va arriba"},
    "wide": {"en": r"(?<!from )(?<!out )wide(?! (?:on|of the box|position|angle|out|area))|past the post|off target|"
                   r"miss\w* the target",
             "it": r"a lato|sul fondo|di poco fuori|fuori di poco|fuori bersaglio|non inquadra",
             "es": r"desviad\w*|se marcha fuera|se va fuera|fuera por poco"},
}
# the keeper: on the line only for a saved shot; "beats the keeper" is a goal word (SHOT_WORDS)
KEEPER = {"en": r"keeper|goalkeeper|goalie|stopper|saves?|saved|(?:put|puts|putting) (?:\w+ )?to the test",
          "it": r"portiere|estremo difensore|(?:messo|mette|mettere|mettendo) alla prova|para|parat[ao]|parata",
          "es": r"portero|guardameta|arquero|(?:lo|la) (?:para|detiene|ataja)|parad[ao]|parada|atajad[ao]|atajada"}
BEATS_KEEPER = r"beats? the (?:goal)?keeper|batte il portiere|supera il portiere|bate al portero|supera al portero"
# a loud word for a shot: only for a strike of BIG_CHANCE_KMH or more
LOUD_SHOT = {"en": r"thunderbolt|thunder\w*|rocket\w*|piledriver|screamer|missile",
             "it": r"bomba|botta|sassata|cannonata|bordata|siluro|missile",
             "es": r"zambombazo|misil|trallazo|cañonazo|obús|latigazo|bombazo"}
# lasting over time: true only for a path of two or more windows that stays up
SUSTAINED = {"en": r"sustained|constant|continuous|relentless|unrelenting|kept up|maintain\w*",
             "it": r"costante|sostenut[oa]|continu[oa]|incessante|mantenut[oa]|mantiene",
             "es": r"sostenid[oa]|constante|continu[oa]|mantuvo|mantiene|mantenid[oa]"}
# smooth over time: false for a path that went up and down
STEADILY = {"en": r"steadily|gradually|consistently|step by step|steady (?:rise|climb|increase|fall|drop)",
            "it": r"gradualmente|progressivamente|costantemente|passo dopo passo",
            "es": r"gradualmente|progresivamente|constantemente|paso a paso"}
# how hard a team presses: a path that eased is not a hard press
PRESS_HARD = {"en": r"press\w* hard|hard press\w*|intense press\w*|high[- ]intensity",
              "it": r"pressing intenso|pressione intensa|intens[ao]",
              "es": r"presión intensa|presión fuerte|intens[ao]"}
# the middle of the pitch's width: only for a shot at most CENTRAL_M off the centre line
CENTRE = (r"middle of the (?:box|area)|cent(?:re|er) of the (?:box|area)|central(?:ly)?|straight on|dead cent(?:re|er)|"
          r"centro dell['’]area|in posizione centrale|centrale|por el centro|centro del área|centrad[oa]")
OVER_BAR = r"(?:por encima del? |sopra la |over the )(?:larguero|travesaño|traversa|(?:cross)?bar)"
HEAD = {"en": r"header|headed|heads|nods?|nodded|with (?:his|her|the) head",
        "it": r"di testa|colpo di testa|testa|incorna\w*|inzucca\w*", "es": r"cabez\w*|cabece\w*|testarazo|de cabeza"}
KICK = {"en": r"foot\w*|volley\w*|drill\w*|curl\w*|fires?|fired|lash\w*",
        "it": r"piede|destro|sinistro|mancino|piatto|collo|calci\w*|di punta",
        "es": r"pie|zurd\w*|diestr\w*|derechazo|empeine|chut\w*|volea"}
# score-state words: a story whose point is not the score may use them only when they agree with it
LEADING = {"en": r"leading|in front", "it": r"in vantaggio", "es": r"por delante|en ventaja"}
TRAILING = {"en": r"trailing|behind on the scoreboard", "it": r"in svantaggio|sotto nel punteggio",
            "es": r"por detrás en el marcador|en desventaja"}
STILL_PLAYING = {"en": r"(?:leads?|leading) \d+-\d+|in front", "it": r"(?:in vantaggio|avanti|conduce) (?:per )?\d+-\d+",
                 "es": r"(?:manda|mandan|lidera) (?:por )?\d+-\d+"}
# going ahead: true only for a goal that breaks a level score; a team already ahead extends its lead
TAKES_LEAD = {"en": r"tak\w* the lead|took the lead|puts? (?:\w+ ){1,4}(?:ahead|in front)|go(?:es)? ahead|went ahead",
              "it": r"port\w* in vantaggio|va in vantaggio|passa in vantaggio|sblocca\w*",
              "es": r"(?:se )?pone por delante|adelant\w*"}
POSSESSION = r"possession|bossed|kept the ball|possesso|posesión|domina(?:n|ba)? el balón|dominio del balón"
DOMINATION = (r"domin\w*|control of (?:play|the game|the match|the ball)|controllo del gioco|controllo della partita|"
              r"control del juego|control del partido")  # no fact measures domination; momentum is "inerzia"
RISING = {"en": r"rose|rising|rises|climb\w*|surg\w*|grew|growing|cranked up|ramped up|built up|kept up|maintain\w*|"
                r"sustained|held up|on the rise",
          "it": r"sale|salit[oa]|cresc\w*|aument\w*|in crescendo|progress\w*|mantenut[oa]|mantiene|sostenut[oa]|costante|"
                r"sempre più|in salita|schizz\w*",
          "es": r"sube|subió|crec\w*|aument\w*|se dispar\w*|mantuvo|mantiene|sostenid[oa]|constante|al alza|en aumento"}
FALLING = {"en": r"fell|falls?|falling|dropp?\w*|dipp?\w*|slipp?\w*|eas(?:e|ed|es|ing)|fad\w*|down to|back to|declin\w*|"
                 r"tail\w* off",
           "it": r"scend\w*|ridiscend\w*|cal[ao]|calan\w*|calat[oa]|in calo|flessione|ced\w*",
           "es": r"baj\w*|cae|cay\w*|caída|desciend\w*|descend\w*|cede\w*|se enfría"}
# taking over and holding on: false when the last window fell
CONTROL = {"en": r"tak\w* (?:control|over|charge|command)|took (?:control|over|charge|command)|seiz\w*|sweep\w*|"
                 r"in control|in command|(?:until|up to|right up to|all the way to) the \d+\w*(?: minute)?",
           "it": r"prend\w* (?:in mano|il controllo|il comando)|pres[oa] (?:in mano|il controllo|il comando)|in salita|"
                 r"fino al(?: minuto)? \d+",
           "es": r"tom\w* el (?:mando|control)|tomó el (?:mando|control)|se adueñ\w*|hasta el(?: minuto)? \d+|"
                 r"ventana tras ventana|en aumento"}
# the two window measures are different numbers: momentum is not press intensity
MOMENTUM_WORDS = r"momentum|inerzia|inercia|empuje"
PRESS_WORDS = (r"press(?:es|ed|ing)?|pressure|pressione|pressa\w*|pressing|presión|presiona\w*|intensity|intensità|"
               r"intensidad")
# press intensity is how hard a team presses, never where on the pitch
PRESS_HIGH = (r"press\w* high|high[- ]press\w*|high up the pitch|press\w* (?:\w+ ){0,2}up the pitch|in their half|"
              r"opposition half|press\w* alt[ao]|pressing (?:molto )?alto|pression\w* (?:\w+ ){0,2}alt[ao]|"
              r"pressa\w* (?:molto )?in avanti|metà campo avversaria|presion\w* arriba|presi[oó]n (?:\w+ ){0,2}alta|"
              r"presiona\w* alto|presión adelantada|campo rival")
# an effect on the opponent: no pressing, sprint, momentum or line fact measures one
CONSEQUENCE = {
    "en": r"forc\w*|hurr\w*|rush\w*|struggl\w*|cope|coping|pinn\w*|penn\w* (?:\w+ )?in|hemm\w* in|on the back foot|"
          r"squeez\w*|stifl\w*|suffocat\w*|starv\w*|(?:more|creat\w*|carv\w*) (?:\w+ )?(?:chances?|shots?|openings?)|"
          r"(?:leav|left|open)\w* (?:\w+ ){0,3}(?:space|room|gaps?|holes?)|"
          r"(?:left|leav\w*|beat\w*|burn\w*|skin\w*) (?:\w+ ){0,3}(?:defenders?|markers?|for dead|trailing)|"
          r"keep\w* (?:\w+ ){0,2}(?:deep|back|pinned)|controlled|composure|errors?|mistakes?|turnovers?|"
          r"win\w* (?:the )?ball back|regain\w*|counter[- ]?attack\w*|on the break|threat\w*|danger\w*|"
          r"under pressure|maintain\w* (?:\w+ ){0,3}shape|(?:powers?|gets?|got|breaks?|broke|bursts?) clear|"
          r"(?:past|beyond|through|beats?|beating) the (?:defen[cs]e|back line|last man)",
    "it": r"costring\w*|obblig\w*|(?:mette|mettono|mettendo|metteva) in difficoltà|in difficoltà|affann\w*|fretta|"
          r"frettolos\w*|ritmi più \w+|meno spazio|spazi[o]?|chiud\w* (?:gli |ogni )?spazi|soffoc\w*|schiacc\w*|"
          r"ripartenz\w*|contropied\w*|occasion\w*|tiri|conclusion\w*|recuper\w*|error\w*|pericol\w*|minacc\w*|"
          r"marcator\w*|semina\w*|brucia\w*|lascia\w* (?:\w+ ){0,2}(?:indietro|sul posto|alle spalle)|sotto pressione|"
          r"supera\w* (?:la )?difesa|oltre la difesa|salta la difesa",
    "es": r"oblig\w*|forz\w*|apresurad\w*|precipit\w*|prisa|achic\w*|asfixi\w*|ahog\w*|encierr\w*|encerr\w*|"
          r"espacios?|huecos?|contras|contraataques?|contragolpe\w*|ocasion\w*|tiros|disparos|remates|robos?|"
          r"recuper\w*|errores|pérdidas?|peligro\w*|amenaz\w*|defensores|dej\w* atrás|dejando|incomod\w*|"
          r"bajo presión|en apuros|más allá de la defensa|supera\w* a la defensa|super[óa] la defensa"}
CONSEQUENCE_KINDS = {"pressing_spell", "top_sprint", "momentum_swing", "tactical_shift"}
# a defensive line's direction (the value is metres from the team's own goal: bigger is higher)
HIGH_LINE = {"en": r"high(?:er)?|push\w*(?: \w+){0,3} up|up the pitch|further (?:up|forward)|step\w* up|advanc\w*",
             "it": r"alt[ao]|alz\w*|avanz\w*|sal[ei]|salit[ao]|in avanti|più su",
             "es": r"alt[ao]|adelant\w*|sub\w*|avanz\w*|más arriba"}
DEEP_LINE = {"en": r"deep(?:er)?|drop\w*(?: \w+){0,3} back|drop\w* deep|sit\w* deep|retreat\w*|lower|further back",
             "it": r"bass[ao]|abbass\w*|profond\w*|arretr\w*|indietr\w*",
             "es": r"baj[ao]|más baja|retras\w*|retroced\w*|hund\w*|repleg\w*|atrás"}
WIDER = {"en": r"wider|widen\w*|stretch\w*|more width", "it": r"più larg[ao]|allarg\w*|larg[ao]",
         "es": r"más anch[ao]|anch[ao]|amplitud|ensanch\w*|abre el campo"}
NARROWER = {"en": r"narrow\w*|compact\w*|tighter|squeez\w*", "it": r"compatt\w*|strett[ao]|restring\w*|stringe",
            "es": r"compact\w*|estrech\w*|más junt[ao]|cerrad[ao]"}
_TEN = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:/\s?10|out of 10|su 10|sobre 10)", re.IGNORECASE)


def _has(pattern, text):
    return re.search(rf"(?<!\w)(?:{pattern})(?!\w)", text, re.IGNORECASE)


def _last(patterns, text):
    """The pattern key whose last match comes last in text, with that match, or (None, None)."""
    best = (None, None)
    for key, pattern in patterns.items():
        for mt in re.finditer(rf"(?<!\w)(?:{pattern})(?!\w)", text, re.IGNORECASE):
            if best[1] is None or mt.start() >= best[1].start():
                best = (key, mt)
    return best


def shot_info(story):
    """What the events say about the story's shot: outcome, header, distance, label and place; None
    without a shot. The shot_distance label ends "..., foot|header, goal|saved|wide|over|blocked"."""
    shot = next((f for f in story["facts"] if f["kind"] == "shot_distance"), None)
    if not shot and not story.get("outcome"):
        return None
    parts = [p.strip() for p in (shot["label_en"] if shot else "").split(",")]
    return {"outcome": story.get("outcome") or next((p for p in parts if p in OUTCOMES), None),
            "header": "header" in parts or bool(story.get("header")), "dist": shot["value"] if shot else None,
            "label": shot["label_en"] if shot else "", "place": story.get("place")}


def _named_near(text, start, end, word):
    """True when word (a team's first word) stands next to the score at text[start:end]: in the same
    clause, with no other number between them."""
    stops = [mt.start() for mt in re.finditer(r"[.!?;](?!\d)", text)]  # a decimal point ends no clause
    lo = max((i for i in stops if i < start), default=-1) + 1
    before, after = text[lo:start].lower(), text[end:min((i for i in stops if i >= end), default=len(text))].lower()
    w = word.lower()
    return (w in before and not re.search(r"\d", before[before.rfind(w) + len(w):])) or \
        (w in after and not re.search(r"\d", after[:after.find(w)]))


def story_issues(m, story, text, lang, on_air=True):
    """Claims the ledger or the events contradict: distance, place and box words against the shot, what
    happened to the shot and the body part, a foot side or technique no fact names, pass accuracy told
    as possession, domination, effects on the opponent no fact shows, score words against the score, a
    score with the trailing side first or without the leader, going ahead when already ahead, formations
    in the wrong order, values out of order or too many, trend and take-over words against the values,
    momentum and pressing mixed up, a defensive line or team width moving the other way.
    Every issue starts with a fixed reason."""
    out = []
    info = shot_info(story)
    dist, label, place = (info["dist"], info["label"], info["place"]) if info else (None, "", None)
    where = (f"a shot from {fmt(dist)} m" if dist is not None else "no shot distance in the facts") + \
        (f", {place_text(place, 'en')}" if place else "")
    for pattern, lo, hi, zones in DISTANCE_WORDS:
        if not (hit := _has(pattern, text)):
            continue
        if place and zones:
            ok = place["zone"] in zones or ("box_central" in zones and place["zone"] == "box" and not place["side"]
                                            and place["depth"] >= 14.0)
        else:
            ok = dist is not None and lo <= dist <= hi
        if not ok:
            out.append(f"distance word does not fit the shot: '{hit.group(0)}', {where}")
    if (hit := _has(LONG_RANGE, text)) and (dist is None or dist < 16.5 or "inside the box" in label):
        out.append(f"distance word does not fit the shot: '{hit.group(0)}', {where}"
                   + (", inside the box" if "inside the box" in label else ""))
    if (hit := _has(IN_THE_BOX, text)) and "outside the box" in label:
        out.append(f"distance word does not fit the shot: '{hit.group(0)}', the shot was outside the box")
    if place and place["offset"] > CENTRAL_M and (hit := _has(CENTRE, text)):
        out.append(f"distance word does not fit the shot: '{hit.group(0)}', the shot was {fmt(place['offset'])} m "
                   f"off the centre line")
    speed = next((f["value"] for f in story["facts"] if f["kind"] == "shot_speed"), None)
    if (hit := _has(LOUD_SHOT[lang], text)) and (speed is None or speed < BIG_CHANCE_KMH):
        out.append(f"shot power word: '{hit.group(0)}' needs a shot of {fmt(BIG_CHANCE_KMH)} km/h or more"
                   + (f", this one was {fmt(speed)} km/h" if speed is not None else ""))
    if info and info["outcome"]:
        for outcome, words in SHOT_WORDS.items():
            if outcome != info["outcome"] and (hit := _has(words[lang], text)):
                out.append(f"shot outcome word: '{hit.group(0)}' but the shot was {OUTCOMES[info['outcome']][0]}")
        unsaved = re.sub(BEATS_KEEPER, "", text, flags=re.IGNORECASE) if info["outcome"] == "goal" else text
        if info["outcome"] != "saved" and (hit := _has(KEEPER[lang], unsaved)):
            out.append(f"shot outcome word: '{hit.group(0)}' but the shot was {OUTCOMES[info['outcome']][0]}, "
                       "the keeper did not save it")
        body = (KICK, "it was a header") if info["header"] else (HEAD, "it was not a header")
        if hit := _has(body[0][lang], text):
            out.append(f"body part: '{hit.group(0)}' but {body[1]}")
    if (hit := _has(FOOT[lang], text)) and not re.search(r"left foot|right foot", label):
        out.append(f"detail not in the facts: '{hit.group(0)}' (the facts do not say which foot)")
    if hit := _has(POSSESSION, text):
        out.append(f"possession claim: '{hit.group(0)}', there is no possession fact and pass accuracy is not possession")
    elif hit := _has(DOMINATION, text):
        out.append(f"domination claim: '{hit.group(0)}', no fact measures domination")
    # the crossbar is named by the over-the-bar outcome itself ("por encima del larguero")
    scan = re.sub(OVER_BAR, "", text, flags=re.IGNORECASE) if info and info["outcome"] == "over" else text
    if hit := _has(INVENTED.get(lang, INVENTED["en"]), scan):
        out.append(f"detail not in the facts: '{hit.group(0)}'")
    if hit := _has(PRESS_HIGH, text):
        out.append(f"press position: '{hit.group(0)}', press intensity says how hard a team presses, not where")
    if story["kind"] in CONSEQUENCE_KINDS and (hit := _has(CONSEQUENCE[lang], text)):
        out.append(f"invented consequence: '{hit.group(0)}', no fact shows an effect on the opponent")
    if on_air and story["kind"] == "recap" and story.get("phase") == "ft" and (hit := _has(STILL_PLAYING[lang], text)):
        out.append(f"lead at full time: '{hit.group(0)}', the match is over, say who won or that it ended level")
    leader, s = m.lead(story["ts"])
    if story["kind"] not in SCORE_KINDS and story["team_id"]:
        state = f"{m.team_name(leader)} lead {s}" if leader else f"it is level at {s}"
        if (hit := _has(LEADING[lang], text)) and leader != story["team_id"]:
            out.append(f"score word against the score: '{hit.group(0)}' but {state}")
        elif (hit := _has(TRAILING[lang], text)) and leader in (story["team_id"], None):
            out.append(f"score word against the score: '{hit.group(0)}' but {state}")
    spans = score_spans(text)
    right = score_text(m, story["ts"], lang)
    wrong = "-".join(reversed(right.split("-")))
    if leader and story["kind"] in SCORE_KINDS and wrong in [x.replace(" ", "") for x, _, _ in spans]:
        out.append(f"score order: write {right}, not {wrong} (" + ("the leader first)" if lang == "en" else
                                                                  "the home side first, as on the scoreboard)"))
    # an away lead (and any lead in a recap) reads as the home side's unless the leader stands next to it
    if leader and story["kind"] in SCORE_KINDS and (leader == m.away["team_id"] or story["kind"] == "recap"):
        word = m.team_word(leader)
        if any(not _named_near(text, a, b, word) for _, a, b in spans):
            out.append(f"score without the leader: name {m.team_name(leader)} next to {right}")
    if story["kind"] in ("goal", "comeback") and (hit := _has(TAKES_LEAD[lang], text)):
        was = m.lead(story["ts"] - 1e-3)[0]
        if was is not None or leader != story["team_id"]:
            out.append(f"lead word: '{hit.group(0)}' but " + (f"{m.team_name(was)} already led" if was == story["team_id"]
                                                              else f"the score is {s}"))
    if story.get("shape"):
        old, new = story["shape"]
        if old in text and new in text and text.index(new) < text.index(old):
            out.append(f"formation order: the change is from {old} to {new}")
    if story["kind"] == "momentum_swing" and (hit := _has(PRESS_WORDS, text)):
        out.append(f"wrong measure: '{hit.group(0)}' in a momentum story, the values are momentum, not pressing")
    if story["kind"] == "pressing_spell" and (hit := _has(MOMENTUM_WORDS, text)):
        out.append(f"wrong measure: '{hit.group(0)}' in a pressing story, the values are press intensity")
    if story["kind"] in ("momentum_swing", "pressing_spell"):
        tf = text_facts(story)
        values = [float(v.replace(",", ".")) for v in _TEN.findall(text)]
        order = [next((i for i, f in enumerate(story["facts"]) if abs(f["value"] - v) <= 0.051), None) for v in values]
        if len(values) > max(len(tf), 2):
            out.append(f"too many values out of 10: {len(values)}, give {max(len(tf), 2)} at most, in time order")
        elif None not in order and order != sorted(order):
            out.append("time order: the values are not in time order")
        shape = trend_shape([f["value"] for f in tf])
        fell = f"the value fell at the end, to {fmt(tf[-1]['value'])}" if len(tf) >= 2 else ""
        if shape in ("falling", "rose_then_fell") and (hit := _has(CONTROL[lang], text)):
            out.append(f"trend word against the facts: '{hit.group(0)}' but {fell}")
        elif shape == "falling" and (hit := _has(RISING[lang], text)):
            out.append(f"trend word against the facts: '{hit.group(0)}' but the value fell from "
                       f"{fmt(tf[0]['value'])} to {fmt(tf[-1]['value'])}")
        elif shape == "rose_then_fell" and (hit := _has(RISING[lang], text)) and not _has(FALLING[lang], text):
            out.append(f"trend word against the facts: '{hit.group(0)}' but {fell}")
        elif shape == "rising" and (hit := _has(FALLING[lang], text)) and not _has(RISING[lang], text):
            out.append(f"trend word against the facts: '{hit.group(0)}' but the value rose from "
                       f"{fmt(tf[0]['value'])} to {fmt(tf[-1]['value'])}")
        vals = [f["value"] for f in story["facts"] if f["kind"] in ("momentum", "press_intensity")]
        floor = PRESS_PAIR if story["kind"] == "pressing_spell" else 5.0
        if (hit := _has(SUSTAINED[lang], text)) and not (len(vals) >= 2 and min(vals[-2:]) >= floor
                                                          and vals[-1] >= vals[-2] - 0.2):
            out.append(f"trend word against the facts: '{hit.group(0)}' needs two or more windows that stay up, "
                       f"the values are {', '.join(fmt(v) for v in vals)}")
        if story["kind"] == "pressing_spell" and shape in ("falling", "rose_then_fell") and (
                hit := _has(PRESS_HARD[lang], text)):
            out.append(f"trend word against the facts: '{hit.group(0)}' but {fell}")
    path = [f["value"] for f in story["facts"] if f["kind"] == MAIN_KIND.get(story["kind"])]
    steps = [y - x for x, y in zip(path, path[1:])]
    if any(d > 0.2 for d in steps) and any(d < -0.2 for d in steps) and (hit := _has(STEADILY[lang], text)):
        out.append(f"trend word against the facts: '{hit.group(0)}' but the values went up and down, "
                   f"{', '.join(fmt(v) for v in path)}")
    if story["kind"] == "tactical_shift":
        if path := line_path(story):
            key, hit = _last({"higher": HIGH_LINE[lang], "deeper": DEEP_LINE[lang]}, text)
            if key and key != path["direction"]:
                out.append(f"line direction: '{hit.group(0)}' but the line went {path['direction']}, from "
                           f"{fmt(path['from']['value'])} m to {fmt(path['to']['value'])} m from its own goal")
        change = width_change(story)
        for name, pattern in (("wider", WIDER[lang]), ("narrower", NARROWER[lang])):
            if (hit := _has(pattern, text)) and change != name:
                out.append(f"width word: '{hit.group(0)}' but " + (f"the team got {change}" if change in ("wider", "narrower")
                           else "the width did not change" if change else "no fact gives the team width"))
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


# What a desk note may say about a problem: plain words for its fixed reason (the head before the first
# colon of a flag). Never the judge's words, the rejected text (a model wrote both) or a fact id.
REASONS = {
    "cited fact not in the story": "a fact from another moment of the match",
    "number in words": "a number written in words, which the desk does not allow",
    "garbled numbers": "numbers run together", "formation not in the facts": "a formation the facts do not give",
    "unit not in the facts": "a unit the desk does not use, such as miles",
    "unit glued to a number": "a unit with no space after its number",
    "letters glued to a number": "letters stuck to a number", "number not in the facts": "a number the facts do not give",
    "unit mismatch": "a number with the wrong unit", "forbidden name (real person or club)": "a real person's or club's name",
    "distance word does not fit the shot": "a distance or place that does not fit the shot",
    "shot outcome word": "the wrong ending for the shot", "body part": "the wrong body part for the shot",
    "detail not in the facts": "a detail the facts do not give",
    "invented consequence": "an effect on the opponent that no fact shows",
    "press position": "a pitch position that press intensity does not measure",
    "domination claim": "domination, which no fact measures", "wrong measure": "momentum and pressing mixed up",
    "possession claim": "pass accuracy told as possession",
    "lead at full time": "a team still leading after the match had ended",
    "score word against the score": "a score word that contradicts the score",
    "score order": "the score written in the wrong order", "score without the leader": "a score without the leading team",
    "lead word": "going ahead when the team was already ahead", "formation order": "the formations in the wrong order",
    "too many values out of 10": "too many values in one line", "time order": "values out of time order",
    "trend word against the facts": "a trend the values do not show",
    "line direction": "the defensive line moving the wrong way", "width word": "a team width the values do not show",
    "name the player": "the player left out", "name the team": "the team left out", "give the score": "the score left out",
    "jargon": "a word that does not belong in commentary", "English word": "an English word",
    "calque": "a phrase a native commentator would not use", "elision": "an article that should drop its vowel",
    "wrong preposition": "the wrong preposition", "approximate figure": "\"about\" before an exact figure",
    "said twice": "the same thing said twice", "verb number": "a plural verb after a club",
    "shot power word": "a loud word for a shot that was not that fast",
    "claim": "a claim the facts do not support", "no text": "no draft came back", "no rewrite": "no draft came back",
    "rewrite failed": "no draft came back", "workflow error": "the AI writers were not available",
}


# style issues carry their numbers in the head ("score said 2 times (2-1, 2-1): ..."): matched by pattern
STYLE_REASONS = ((r"score said", "the score said more than once"),
                 (r"the score .* is not the point", "a score in a line that is not about the score"),
                 (r"repeated words", "a word repeated"), (r"\d+ sentences", "too many sentences"),
                 (r"article twice", "an article doubled"), (r"club without its article", "a club without its article"),
                 (r".* without 'the'", "a minute without 'the'"),
                 (r"numbers listed at the end", "numbers listed at the end of the line"),
                 (r".* already used in this match", "a loud word already used in this match"),
                 (r"another line already starts", "the same opening as an earlier line"))


def reason(problem, story=None):  # noqa: ARG001 - story kept for callers; notes no longer carry fact ids
    """The desk's plain words for one problem: "a distance or place that does not fit the shot"."""
    head = problem.split(":", 1)[0].strip()
    return REASONS.get(head) or next((r for p, r in STYLE_REASONS if re.match(p, problem)), "a failed check")


def desk_notes(status, earlier, final):
    """The notes under a story on the desk, about the text on screen: none when it passed first time;
    for a rewrite, what the earlier drafts got wrong; for the fact-only sentence, why the drafts were not
    used. earlier and final map a language to plain reasons (from reason())."""
    if status == "pass":
        return []
    lines = []
    for lang, reasons in (earlier if status == "rewritten" else final).items():
        if reasons := list(dict.fromkeys(reasons)):
            what = "Earlier {} draft" if status == "rewritten" else "{} draft not used"
            lines.append(note(f"{what.format(LANGUAGES[lang])}: {'; '.join(reasons)}."))
    return lines


LANGUAGES = {"en": "English", "it": "Italian", "es": "Spanish"}


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
    return [f"jargon: '{hit.group(0)}' is not broadcast copy"] if (hit := _has(BANNED, text)) else []


# English football words copied into an Italian or Spanish line ("pressing" is Italian too)
ENGLISH = (r"close[- ]range|six[- ]yard|edge of the box|from distance|wide|header|keeper|the box|strike|shot|away|"
           r"wins?|blocked|pass accuracy|momentum")


def english_words(text, lang):
    """English words in an Italian or Spanish line: a style issue first, a fallback to the template in the last round."""
    if lang == "en":
        return []
    hit = _has(ENGLISH + ("|pressing" if lang == "es" else ""), text)
    return [f"English word: '{hit.group(0)}', say it in your language"] if hit else []


# Openers and calques a native commentator would not use (from the native review of the replays)
CALQUES = {"en": r"this matters because|it matter(?:s|ed) because|from in the",
           "it": r"aggiustamento del risultato|spinta da fuori|palla dalla distanza|sul minuto|vs\.?|mezzo tempo|"
                 r"compattazione|para la mira|con il minuto",
           "es": r"lanzó|y parad[oa]|y rechazad[oa]|compactación|vs\.?|sprint(?:a|ó|an|aba|ando)|devolvi[óo] al|"
                 r"seguimiento sostenido|arco"}
# Italian elides the article before a number said with a vowel: "dall'1,8", "all'8", "all'11", "dell'80"
ELISION = re.compile(r"\b(?:del|al|dal|nel|sul) (?:11|8\d?|1)(?:,\d+)?(?![\d'’])", re.IGNORECASE)
# "about" before a figure with a decimal: the ledger's figure is exact
ROUGHLY = {"en": r"about|around|roughly|approximately|nearly|almost|some",
           "it": r"circa|quasi|più o meno|intorno a(?:i|gli)?|poco più di|poco meno di",
           "es": r"unos|unas|cerca de|casi|alrededor de|aproximadamente|más o menos"}
# "from distance" with a distance already given in the same sentence
FROM_DISTANCE = {"en": r"from distance", "it": r"dalla distanza", "es": r"desde lejos|de lejos"}
DISTANCE_GIVEN = (r"long[- ]range|\d+(?:[.,]\d+)? ?m\b|edge of the (?:box|area)|limite dell['’]area|frontal|"
                  r"da fuori(?: area)?|desde fuera")
# a club is singular in Italian and Spanish: "il Brightwater rimonta", "el Brightwater remonta"
PLURAL_VERBS = {"it": r"rimontano|pareggiano|vincono|perdono|pressano|segnano|conducono|passano|vanno|sono|hanno|"
                      r"allungano|accorciano|alzano|abbassano|chiudono|spingono|tengono",
                "es": r"remontan|empatan|ganan|pierden|presionan|marcan|mandan|lideran|pasan|van|son|están|tienen|"
                      r"amplían|recortan|adelantan|retrasan|cierran|aprietan|mantienen"}


def calques(text, lang):
    """A phrase a native would not say: a style issue first, a fallback to the template in the last round."""
    return [f"calque: '{hit.group(0)}' is not what a native commentator says"] if (hit := _has(CALQUES[lang], text)) else []


def language_issues(text, lang, kind=None, m=None):
    """Grammar and wording a native commentator would get right: calques, the Italian elision before a
    number, "Testa di X" for a header, "Recupero" for a comeback, the wrong preposition after a rising or
    falling momentum, "about" before an exact figure, "from distance" with the distance given, and a
    plural verb after a club (singular in Italian and Spanish). Like calques: style first, then a fallback."""
    out = calques(text, lang)
    if lang == "it":
        if hit := ELISION.search(text):
            out.append(f"elision: '{hit.group(0)}', the article drops its vowel before this number (dall'1,8, all'80)")
        if hit := re.search(r"(?<!\bdi )\b[Tt]esta di [A-Z]", text):
            out.append(f"calque: '{hit.group(0)}' is not what a native commentator says, write 'Colpo di testa di'")
        if kind == "comeback" and (hit := re.search(r"(?:^|[.!?:]\s+)Recupero\b|\brecupero (?:del|dell['’]|dello)", text)):
            out.append(f"calque: '{hit.group(0).strip(' .!?:')}' is stoppage time, a comeback is 'Rimonta'")
    if hit := re.search(r"\b(?:sale|scende|cresce|cala|aumenta|sube|baja|crece)\s+(?:dal|dall['’]|dallo|del)\s*[A-Z]", text):
        out.append(f"wrong preposition: '{hit.group(0)}', a value goes up or down from a number, not from a team")
    if hit := re.search(rf"(?<!\w)(?:{ROUGHLY[lang]})\s+\d+[.,]\d", text, re.IGNORECASE):
        out.append(f"approximate figure: '{hit.group(0)}', the figure is exact, drop the word before it")
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if (hit := _has(FROM_DISTANCE[lang], sentence)) and _has(DISTANCE_GIVEN, sentence.replace(hit.group(0), "")):
            out.append(f"said twice: '{hit.group(0)}' with the distance already given, say it once")
            break
    if lang in PLURAL_VERBS and m is not None:
        for t in m.teams.values():
            name = r"\s+".join(map(re.escape, t["name"].split()))
            first = re.escape(t["name"].split()[0])
            verb = rf"(?:{name}|{first})(?:\s+(?:non|no|ya|si|se|lo|la|le|li))?\s+(?:{PLURAL_VERBS[lang]})(?!\w)"
            if hit := re.search(verb, text):
                out.append(f"verb number: '{hit.group(0)}', a club takes a singular verb")
                break
    return out


_ARTICLE = re.compile(r"(?:\b(?:il|lo|del|dello|al|allo|dal|dallo|nel|nello|sul|sullo|el|los)\s+|"
                      r"\b(?:l|dell|all|dall|nell|sull)['’]\s*)$", re.IGNORECASE)


def bare_clubs(m, text, lang):
    """An Italian or Spanish line that names a club without its article ("per Harbour Vale FC"); a name
    followed by a number (a list of pass accuracy) needs none."""
    if lang == "en" or m is None:
        return []
    for t in m.teams.values():
        first, *rest = t["name"].split()
        listed = re.compile(rf"(?:\s+{re.escape(' '.join(rest))})?\s+\d" if rest else r"\s+\d")
        for mt in re.finditer(rf"(?<!\w){re.escape(first)}(?!\w)", text):
            if not _ARTICLE.search(text[:mt.start()]) and not listed.match(text, mt.end()):
                return [f"club without its article: say '{club(t['name'], lang)}'"]
    return []


_SCORE = re.compile(r"(?<![\w.,/+-])\d{1,2}\s?-\s?\d{1,2}(?![\d/]|[.,]\d|-\d)")
_WORD = re.compile(r"[^\W\d_]+")


def score_spans(text):
    """(score, start, end) for scores like 2-1 in text; minute ranges (min 41-45) and formations (4-4-2)
    are not scores."""
    return [(mt.group(0), mt.start(), mt.end()) for mt in _SCORE.finditer(text)
            if not re.search(r"min\w*\.?\s*$", text[max(0, mt.start() - 10):mt.start()], re.IGNORECASE)]


def score_mentions(text):
    return [x for x, _, _ in score_spans(text)]


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


# an article on top of a merged one: "del el Wrenmouth", "desde en el área", "di il Redwick"
DOUBLED = {"it": r"(?:di|a|da|in|su|del|al|dal|nel|sul|il|lo) (?:il|lo|l['’])|(?:dell|all|dall|nell|sull)['’]\s*(?:il|lo)",
           "es": r"(?:del|al|de|a|el) el|el del|desde en(?: el)?"}


def style_issues(text, lang, kind, used=None, m=None):
    """What a TV commentator would not do: say the score twice, or where it is not the point of the
    story; use the same word twice; run past two sentences; reuse a loud word or an opening already
    on air in this match (`used` = {"loud": set, "openings": set}). A recap may run to three
    sentences and name a team twice. With the match `m`, a club named without its article in Italian
    or Spanish."""
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
    out += jargon(text) + english_words(text, lang) + language_issues(text, lang, kind, m) + bare_clubs(m, text, lang)
    if lang in DOUBLED and (hit := _has(DOUBLED[lang], text)):
        out.append(f"article twice: '{hit.group(0)}', the club's article merges with the word before")
    if lang == "en" and (hit := re.search(r"(?<!\bthe )\b\d+(?:st|nd|rd|th) minute\b", text)):
        out.append(f"'{hit.group(0)}' without 'the': say 'in the {hit.group(0)}'")
    tail = re.split(r"[;:]|,(?!\d)", text.rstrip(" .!"))[-2:]  # "7,5/10": a decimal comma splits nothing
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
    in lang's order (score_text) with the leader named; a missing player name falls back to the team, never to an empty
    slot; Italian and Spanish clubs take their article."""
    i = LANGS.index(lang)
    kind = story["kind"]
    facts = story["facts"]
    leader, s = m.lead(story["ts"])[0], score_text(m, story["ts"], lang)
    lead_name = club(m.team_name(leader), lang)
    if kind == "recap":
        title = TITLES[story["phase"]][i]
        if leader is None:
            text = TEMPLATES["recap_level"][i].format(title=title, s=s)
        else:
            key = "recap_win" if story["phase"] == "ft" else "recap_lead"
            text = TEMPLATES[key][i].format(title=title, leader=lead_name, s=s)
        # the label's own whole percent: value 82.5 can be "83%" in the label, and the two must agree
        acc = {f["team_id"]: mt.group(1) for f in facts
               if f["kind"] == "pass_accuracy" and (mt := re.search(r"(\d+)%", f["label_en"]))}
        h, a = m.home["team_id"], m.away["team_id"]
        if h in acc and a in acc:
            text += TEMPLATES["recap_acc"][i].format(home=m.team_word(h), away=m.team_word(a),
                                                     acc_h=acc[h], acc_a=acc[a])
        return text
    t = story["team_id"]
    team = club(m.team_name(t), lang)
    s = score_text(m, story["ts"], lang)
    names = {"team": team, "Team": team[:1].upper() + team[1:], "leader": lead_name, "s": s,
             "team_di": club(m.team_name(t), lang, "di"), "team_de": club(m.team_name(t), lang, "de")}
    if kind == "tactical_shift" and story.get("shape"):
        old, new = story["shape"]
        return TEMPLATES["shape_shift"][i].format(old=old, new=new, **names)
    main = [f for f in text_facts(story) if f["kind"] == MAIN_KIND.get(kind)]
    v = fmt(main[-1]["value"], lang) if main else ""
    path = trend(m, story, lang)
    if kind == "tactical_shift" and path:
        kind = "line_" + path["shape"]
    player = m.player_name(story["player_id"]) or team
    if kind == "goal":
        was = m.lead(story["ts"] - 1e-3)[0]
        kind = "goal_level" if leader is None else "goal_behind" if leader != t else \
            "goal_up" if was is None else "goal_more"
    elif kind == "comeback":
        kind = "comeback_level" if leader is None else "comeback_up"
    outcome = OUTCOMES.get(story.get("outcome"), ("",) * 3)[i]
    return TEMPLATES[kind][i].format(player=player, v=v, outcome=outcome, trend=path["say"] if path else SINGLE_VALUE[i].format(v), **names)


ANALYSIS_OUTCOME = {"goal": "and scored", "saved": "and the keeper saved it", "wide": "wide", "over": "over the bar",
                    "blocked": "blocked by a defender"}


def analysis_template(m, story):
    """The analyst's note from the facts alone, when its own cannot be used: one or two plain English
    sentences that name the team and the player (the ids live in fact_ids)."""
    kind, team = story["kind"], m.team_name(story["team_id"])
    if kind == "recap" or not team:
        return template(m, story, "en")
    period = m.period_of(story["ts"])
    mi = minute(story["ts"], period, m.p1 or math.inf)
    when = ("at " if mi > (45 if period == 1 else 90) else "in the ") + minute_text(mi, period, "en")
    who = f"{m.player_name(story['player_id'])} of {team}" if m.player_name(story["player_id"]) else team
    value = {f["kind"]: f["value"] for f in text_facts(story)}
    if kind in ("goal", "big_chance"):
        where = f" from {fmt(value['shot_distance'])} m" if "shot_distance" in value else ""
        speed = f" at {fmt(value['shot_speed'])} km/h" if "shot_speed" in value else ""
        outcome = ANALYSIS_OUTCOME.get(story.get("outcome") or ("goal" if kind == "goal" else ""), "")
        text = f"{who} shot{where}{speed} {when}" + (f", {outcome}." if outcome else ".")
        if kind == "goal":
            leader, s = m.lead(story["ts"])
            text += f" {m.team_name(leader)} lead {s}." if leader else f" It is level at {s}."
        return text
    if kind == "top_sprint" and "sprint_speed" in value:
        return f"{who} sprinted at {fmt(value['sprint_speed'])} km/h {when}."
    if kind in ("momentum_swing", "pressing_spell") and (path := trend(m, story, "en")):
        return f"{'Momentum' if kind == 'momentum_swing' else 'Press intensity'} for {team}: {path['say']}."
    return template(m, story, "en")


# The analyst's own failure modes: its prompt's wording, and a score garbled from "<Team> lead 2-1"
ANALYSIS_BAD = re.compile(r"\b(?:this|it|that) matter(?:s|ed) because\b|\bmatter(?:s|ed) because\b|"
                          r"\b\d+-\d+ (?:[A-Z][\w']+ ){1,4}\d+\b|"
                          r"\b(?:remain\w*|stay\w*|stood|kept the score at|score at) (?:[A-Z][\w']+ ){1,4}(?:lead )?\d+-\d+|"
                          r"\bscore (?:\w+ )?described as\b|\bmaking the score\b|\bscore (?:was |is )?with\b|"
                          r"\b(?:led|lead|leads|leading) \d+-\d+[^.]*\bwith \w+(?: \w+){0,3} leading\b|"
                          r"\bIt (?:is|was) (?:(?:[A-Z][\w']+ ){1,4}leads?\b|Level\b)|"  # "It is Tarnby lead 1-0"
                          r"[\[\]]|\b(?:developer|citations?|mistakenly|need to fix)\b")  # the model's own reasoning


def analysis_issues(text):
    """Prompt wording or a garbled score in an analyst's note, or the same score said twice: the note falls
    back to the facts."""
    if hit := ANALYSIS_BAD.search(text):
        return [f"jargon: '{hit.group(0)}'"]
    scores = [x.replace(" ", "") for x in score_mentions(text)]
    return [f"jargon: the score {x} said twice"] if (x := next((x for x in scores if scores.count(x) > 1), None)) else []


# --- risk ----------------------------------------------------------------------------------------

def risk(story):
    """0..1: how much a person should look before this goes on air. A story whose claims the AI judge
    did not check always goes to review."""
    r = 0.05
    if story["verifier"].get("on_air") == "phrasebook":  # every claim on air comes with its fact condition
        return round(r + (0.3 if not story["fact_ids"] else 0.0), 2)
    if story.get("kind") == "recap" and story["verifier"]["status"] == "template":
        return r  # the score and pass accuracy written by code: the half-time and full-time card always airs
    r += {"pass": 0.0, "rewritten": 0.05 if story.get("style_only") else 0.2,
          "template": 0.3, "pending": 0.3}[story["verifier"]["status"]]  # pending: on air, not yet verified  # a rewrite for style alone fixed no fact
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
# the longest run of graphics a story gets; a story that is not a must and would still be on screen at
# the whistle is not told, so "Half-time" and "Full time" air at once and nothing follows them
LAST_WORD_S = max(sum(DURATION[g] for g in gs) for p in PLAN.values() for gs in p.values())


def before_the_whistle(cands):
    """The candidates without those too close to a recap in the same batch (LAST_WORD_S)."""
    whistles = [c["ts"] for c in cands if c["kind"] == "recap"]
    return [c for c in cands if c["kind"] in MUST_TELL or not any(0 <= w - c["ts"] < LAST_WORD_S for w in whistles)]


def air_order(story):
    """Match time, and at the same moment the recap last: nothing follows "Half-time" or "Full time"."""
    return story["ts"], story["kind"] == "recap"


class Director:
    """Picks graphic, time and duration per audience; never more than MAX_GRAPHICS_ON_SCREEN at once."""

    def __init__(self, m):
        self.m = m
        self.placed = {}  # audience -> [(start, end)]
        self.whistles = []  # the recaps planned so far: a story from before one never airs after it
        self.audiences = ["analyst", "casual"] + [f"team:{t}" for t in m.teams]

    def _slot(self, audience, ts, dur, by=math.inf):
        placed = self.placed.setdefault(audience, [])
        for start in sorted({ts} | {e for _, e in placed if ts < e <= ts + MAX_DELAY_S}):
            if start + dur > by:
                return None
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
                    "body": story["texts"][lang], "fact_ids": [f["fact_id"] for f in facts]}
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

    def plan(self, stories, now):
        """Cues (without cue_id) for every audience and language. Player audiences start with their first story.
        No graphic starts before `now`, when the desk decided on these stories: a story keeps the time of its
        moment, its graphics air from the decision on. The must-tell stories and the recaps take their slots
        first; any other graphic must end by the next whistle, so it can neither delay "Half-time" or
        "Full time" nor follow it."""
        for s in stories:
            if s["player_id"] and f"player:{s['player_id']}" not in self.audiences:
                self.audiences.append(f"player:{s['player_id']}")
        cues = []
        self.whistles = sorted({*self.whistles, *(s["ts"] for s in stories if s["kind"] == "recap")})
        for s in sorted(stories, key=lambda s: (s["kind"] not in MUST_TELL, air_order(s))):
            by = math.inf if s["kind"] in MUST_TELL else next((w for w in self.whistles if w >= s["ts"]), math.inf)
            for audience in self.audiences:
                role = self._role(audience, s)
                t = max(s["ts"], now)
                for graphic in PLAN[s["kind"]].get(role, ()) if role else ():
                    if self.payload(s, graphic, "en") is None:
                        continue
                    start = self._slot(audience, t, DURATION[graphic], by)
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
