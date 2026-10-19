"""The rule half of the agents (no AI): candidate moments, number checks, templates, risk, director.

Every number a rule uses comes from a fact the workflow read through the MCP server.
"""
import math
import re

from .. import config, names
from ..export import DURATION

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
    "tactical_shift": f"Between minutes {SHIFT_MINUTES[0]} and {SHIFT_MINUTES[1]} a team moved its defensive "
                      f"line by {SHIFT_M:.0f} m or more. Pick it: it is a coaching decision viewers want explained.",
}

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
TEMPLATES = {
    "goal": ("Goal for {team}! {player} makes it {score}.", "Gol per {team}! {player} firma il {score}.",
             "¡Gol de {team}! {player} pone el {score}."),
    "comeback": ("{team} have come back: {score}.", "Rimonta di {team}: {score}.", "Remontada de {team}: {score}."),
    "big_chance": ("Big chance for {player}: a shot at {v} km/h, no goal.",
                   "Grande occasione per {player}: tiro a {v} km/h, niente gol.",
                   "Ocasión clara para {player}: disparo a {v} km/h, sin gol."),
    "top_sprint": ("{player} sprints at {v} km/h.", "{player} scatta a {v} km/h.", "{player} esprinta a {v} km/h."),
    "momentum_swing": ("{team} take over: momentum {v}/10.", "{team} prende il controllo: momentum {v}/10.",
                       "{team} toma el control: impulso {v}/10."),
    "pressing_spell": ("{team} press high: intensity {v}/10.", "{team} pressa alto: intensità {v}/10.",
                       "{team} presiona arriba: intensidad {v}/10."),
    "tactical_shift": ("{team} move their defensive line to {v} m from goal.",
                       "{team} sposta la linea difensiva a {v} m dalla porta.",
                       "{team} coloca su línea defensiva a {v} m de su portería."),
    "recap": ("{title}: {home} {h}-{a} {away}.", "{title}: {home} {h}-{a} {away}.", "{title}: {home} {h}-{a} {away}."),
    "recap_acc": (" Pass accuracy {acc_h}% and {acc_a}%.", " Precisione nei passaggi {acc_h}% e {acc_a}%.",
                  " Precisión de pase {acc_h}% y {acc_a}%."),
}
MAIN_KIND = {"goal": "shot_speed", "big_chance": "shot_speed", "top_sprint": "sprint_speed",
             "momentum_swing": "momentum", "pressing_spell": "press_intensity", "tactical_shift": "line_height"}


def minute(ts, period, p1):
    """Display minute (docs/CONTRACT.md); a window end at 300.0 s still belongs to minute 5."""
    t = max(ts - (p1 if period == 2 else 0.0) - 1e-6, 0.0)
    return math.floor(t / 60) + (45 if period == 2 else 0) + 1


def fmt(v):
    return f"{v:.1f}".rstrip("0").rstrip(".")


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

    def score_at(self, ts):
        goals = [f for f in self.kind("score") if f["ts"] <= ts]
        return {tid: sum(1 for f in goals if f["team_id"] == tid) for tid in self.teams}, goals


def _cand(kind, ts, facts, team_id=None, player_id=None, note="", **extra):
    ev = sorted({e for f in facts for e in f["source_event_ids"]})
    return {"kind": kind, "ts": ts, "team_id": team_id, "player_id": player_id, "facts": facts,
            "evidence_event_ids": ev, "note": note, **extra}


def goal_candidates(m, score_fact):
    """A goal, and a comeback when the scoring team had been behind and is now level or ahead."""
    shot = [f for f in m.kind("shot_speed") if f["source_event_ids"] == score_fact["source_event_ids"]]
    out = [_cand("goal", score_fact["ts"], [score_fact, *shot], score_fact["team_id"], score_fact["player_id"],
                 note=score_fact["label_en"])]
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


def _goal_x(m, team_id, period):
    return 105.0 if (team_id == m.home["team_id"]) == (period == 1) else 0.0


def window_candidates(m, w0, w, shots, shifted):
    """Candidates for the 5-minute window (w0, w]: big chances, momentum swings, pressing, tactical shift.

    `shots` are the window's shot events (from get_events); `shifted` is the set of teams that already
    had a tactical shift story and is updated in place.
    """
    out = []
    goal_events = {e for f in m.kind("score") for e in f["source_event_ids"]}
    by_event = {f["source_event_ids"][0]: f for f in m.kind("shot_speed") if f["source_event_ids"]}
    chances = []
    for e in shots:
        f = by_event.get(e["event_id"])
        if not f or e["event_id"] in goal_events:
            continue
        dist = math.hypot(e["start_x"] - _goal_x(m, e["team_id"], e["period"]), e["start_y"] - 34.0)
        if f["value"] >= BIG_CHANCE_KMH or dist <= BIG_CHANCE_DIST_M:
            chances.append((f, dist))
    for f, dist in sorted(chances, key=lambda c: -c[0]["value"])[:2]:
        out.append(_cand("big_chance", f["ts"], [f], f["team_id"], f["player_id"],
                         note=f"{f['label_en']}, from {dist:.0f} m"))
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
        if (tid not in shifted and len(line) >= 5 and line[-1]["ts"] == w and period == 2
                and SHIFT_MINUTES[0] <= mi <= SHIFT_MINUTES[1]):
            delta = (line[-1]["value"] + line[-2]["value"]) / 2 - sum(f["value"] for f in line[-5:-2]) / 3
            if abs(delta) >= SHIFT_M:
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
_UNIT.update(dict.fromkeys(("per cent", "percent", "per cento", "por ciento"), "pct"))
_UNIT.update(dict.fromkeys(("out of 10", "su 10", "sobre 10"), "ten"))
_FAMILY = {"km/h": "speed", "m": "m", "%": "pct", "/10": "ten"}
_NUM = re.compile(
    r"(?<![\w.,])(\d+(?:[.,]\d+)?)(?:st|nd|rd|th|º|ª|°)?\s*("
    + "|".join(sorted(map(re.escape, _UNIT), key=len, reverse=True)).replace(r"/10", r"/\s?10")
    + r")?(?![\w])", re.IGNORECASE)
GENERIC = (0.0, 45.0, 90.0)
_FACT_ID = re.compile(r"F-[A-Z_]+-\d+")


def _family(unit):
    return _UNIT[re.sub(r"\s+", " ", unit.lower()).replace("/ 10", "/10")] if unit else None


def allowed_numbers(facts, minutes=()):
    """(value, family) pairs a text about these facts may contain. Family None means unitless only."""
    out = [(v, None) for v in GENERIC] + [(float(mi), None) for mi in minutes]
    for f in facts:
        fam = _FAMILY.get(f["unit"])
        out.append((f["value"], fam))
        if fam == "m":
            out.append((f["value"] / 1000, "km"))
        if fam == "ten":
            out.append((10.0, None))
        for mt in _NUM.finditer(_FACT_ID.sub("", f["label_en"])):  # label numbers keep their own unit
            unit = mt.group(2)
            out.append((float(mt.group(1).replace(",", ".")),
                        _family(unit)))
    return out


def check_numbers(text, allowed):
    """Flags for every number in text that is not in the ledger, with rounding tolerance and units."""
    flags = []
    for mt in _NUM.finditer(_FACT_ID.sub("", text)):  # cited fact ids are not numbers
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


def check_text(text, allowed):
    """All rule checks on one text: numbers against the ledger, then forbidden real names."""
    return check_numbers(text, allowed) + [f"forbidden name: '{n}'" for n in names.find_forbidden(text)]


def story_allowed(m, story):
    """Numbers a text about this story may use: its facts, its minutes and the score at that moment."""
    mins = {m.minute_of(f) for f in story["facts"]} | {story["minute"]}
    _, goals = m.score_at(story["ts"])
    return allowed_numbers(story["facts"] + goals, mins)


def tidy(text):
    """On-screen text uses no em or en dashes (house style): a dash between words becomes a comma."""
    text = re.sub(r"(\d)\s*[\u2014\u2013]\s*(\d)", r"\1-\2", text)  # 2–1, min 46–47
    return re.sub(r"\s*[\u2014\u2013]\s*", ", ", text).strip()


# --- templates ---------------------------------------------------------------------------------

def template(m, story, lang):
    """A sentence from the facts alone, in lang. Used when the AI text cannot be verified."""
    i = LANGS.index(lang)
    kind = story["kind"]
    facts = story["facts"]
    if kind == "recap":
        score, _ = m.score_at(story["ts"])
        h, a = m.home["team_id"], m.away["team_id"]
        text = TEMPLATES["recap"][i].format(title=TITLES[story["phase"]][i], home=m.home["short_name"],
                                             away=m.away["short_name"], h=score[h], a=score[a])
        acc = {f["team_id"]: f["value"] for f in facts if f["kind"] == "pass_accuracy"}
        if h in acc and a in acc:
            text += TEMPLATES["recap_acc"][i].format(acc_h=f"{acc[h]:.0f}", acc_a=f"{acc[a]:.0f}")
        return text
    main = [f for f in facts if f["kind"] == MAIN_KIND.get(kind)]
    v = fmt(main[-1]["value"]) if main else ""
    score, _ = m.score_at(story["ts"])
    t = story["team_id"]
    other = next((x for x in m.teams if x != t), None)
    s = f"{score.get(m.home['team_id'], 0)}-{score.get(m.away['team_id'], 0)}"
    if kind == "comeback" and t and other:
        s = f"{score[t]}-{score[other]}"
    return TEMPLATES[kind][i].format(team=m.team_name(t) or "", player=m.player_name(story["player_id"]) or "",
                                     score=s, v=v)


def analysis_template(story):
    return " ".join(f"{f['label_en']} [{f['fact_id']}]." for f in story["facts"][:4])


# --- risk ----------------------------------------------------------------------------------------

def risk(story):
    """0..1: how much a person should look before this goes on air."""
    r = 0.05
    r += {"pass": 0.0, "rewritten": 0.2, "template": 0.3}[story["verifier"]["status"]]
    r += 0.2 if story.get("unjudged") else 0.0          # claims without numbers not checked by the AI
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
