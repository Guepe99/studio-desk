"""Watch for: storyline forecasts from the fact ledger, by code only (no model calls). docs/forecast.md.

At a replay time ts the model reads only facts with `ts <= now` and gives, for each open storyline, the
probability that it happens by the end of the match:

- second_goal: a player who has scored once scores again (resolves at their `player_goals` fact of 2);
- comeback: a team that trails draws level (at the `score` fact that levels it, as the hidden
  `comeback` storyline: once per deficit);
- clean_sheet: a team that has not conceded keeps it to full time (at the whistle; off at the
  opponent's first `score` fact);
- late_goal: a goal in the last 10 minutes, display minute 81 or later (at that `score` fact).

Goals follow a Poisson process per team. Its rate per minute blends a base rate with the match's own
shots (the `team_shots` facts): r = (K * rate0 + per_shot * shots) / (K + minutes played), scaled by
the stage of the match (six 15-minute blocks, stoppage time in the last block of its half), and by
chase while the team trails. late scales the goals from minute 81; scorer_share is a scorer's share
of his team's goals while he is on the pitch. Expected
goals left = r times the weighted minutes left to the expected end of the match (period lengths are
not known live, so the mean lengths of the calibration set). The parameters are fitted on simulated
matches by scripts/forecast_calibrate.py and stored in forecast_params.json.
"""
import json
import math
from contextlib import closing
from pathlib import Path

KINDS = ("second_goal", "comeback", "clean_sheet", "late_goal")
PARAMS_FILE = Path(__file__).with_name("forecast_params.json")
LATE_MIN = 35.0      # display minute 81 = 35 minutes into the second half
STEP_S = 60.0        # the export's forecast every match minute, and right after each goal
EPS = 1e-6
DEFAULT = {"rate0": 0.0145, "per_shot": 0.1, "prior_min": 45.0, "stage": [1.0] * 6, "scorer_share": 0.3,
           "p1_min": 46.2, "p2_min": 47.0, "chase": 1.0, "late": 1.0}


# On screen a forecast is a word, never a percentage. The model is fitted on simulated matches, where half
# the matches have a planted comeback and goals from minute 81 are rarer than in real football, so before a
# probability becomes a word its odds are moved from the simulator's event rate to a real-football rate
# (prior shift, Saerens, Latinne and Decaestecker 2002). Sources in docs/forecast.md: the team that scores
# first wins 71.1% of Premier League matches (CIES, 2015-2019), so the side behind levels in about 29%;
# 18% of goals came from the 80th minute in 2024/25 at about 2.9 a match, so a late goal in about 40%.
# The words follow the IPCC likelihood scale: unlikely below 1/3, likely from 2/3.
REAL_RATE = {"comeback": 0.29, "late_goal": 0.40}
LEVELS = ((1 / 3, "unlikely"), (2 / 3, "possible"), (math.inf, "likely"))


def load_params(path=PARAMS_FILE):
    if not Path(path).exists():
        return dict(DEFAULT)
    data = json.loads(Path(path).read_text())
    sim = {k: v["base_rate"] for k, v in data.get("evaluation", {}).get("scores", {}).items()}
    return {**DEFAULT, **data["params"], "sim_rate": sim}


def level(kind, p, params):
    """The word for a forecast: unlikely, possible or likely, after the shift to the real-football rate."""
    sim, real = params.get("sim_rate", {}).get(kind), REAL_RATE.get(kind)
    if sim and real and 0 < p < 1:
        odds = p / (1 - p) * (real / (1 - real)) / (sim / (1 - sim))
        p = odds / (1 + odds)
    return next(word for top, word in LEVELS if p < top)


class Game:
    """What the model may know about a match: its facts, teams, period 1 length and team sheet."""

    def __init__(self, facts, home, away, p1=None, lineups=None, end=None):
        self.facts = sorted(facts, key=lambda f: (f["ts"], f["fact_id"]))
        self.home, self.away, self.p1, self.end = home, away, p1, end
        self.lineups = lineups or {}  # player_id -> (on_ts, off_ts or None)

    @classmethod
    def from_db(cls, conn, match_id):
        m = conn.execute("SELECT * FROM matches WHERE match_id = ?", (match_id,)).fetchone()
        facts = [dict(r) for r in conn.execute("SELECT fact_id, kind, ts, period, team_id, player_id, value FROM facts "
                                               "WHERE match_id = ? AND kind IN ('score', 'team_shots', 'player_goals')",
                                               (match_id,))]
        lineups = {r["player_id"]: (r["on_ts"], r["off_ts"]) for r in conn.execute(
            "SELECT player_id, on_ts, off_ts FROM lineups WHERE match_id = ?", (match_id,))}
        return cls(facts, m["home_team_id"], m["away_team_id"], m["period1_s"], lineups, m["period1_s"] + m["period2_s"])

    def other(self, team):
        return self.away if team == self.home else self.home

    def upto(self, ts):
        return [f for f in self.facts if f["ts"] <= ts + EPS]


# --- the model -----------------------------------------------------------------------------------

def _poisson(k, lam):
    return math.exp(-lam) * lam ** k / math.factorial(k)


def _block_minutes(a, b, first, mult):
    """Weighted minutes a..b of one half (minutes since its kick-off), blocks of 15 from `first`; the
    last block of the half takes its stoppage time."""
    total = 0.0
    for k in range(3):
        lo, hi = 15.0 * k, (15.0 * (k + 1) if k < 2 else math.inf)
        total += max(0.0, min(b, hi) - max(a, lo)) * mult[first + k]
    return total


def where(g, ts):
    """(period, minutes since the half's kick-off). Period 1 lasts until g.p1, known once it is over."""
    p1 = g.p1 if g.p1 is not None and g.p1 <= ts + EPS else None
    return (2, (ts - p1) / 60.0) if p1 is not None else (1, ts / 60.0)


def exposure(g, ts, params, late=False):
    """Stage-weighted minutes left to the expected end (late: only those from display minute 81)."""
    period, u = where(g, ts)
    mult, p2 = params["stage"], params["p2_min"]
    if period == 1:
        if late:
            return _block_minutes(LATE_MIN, max(p2, LATE_MIN), 3, mult)
        return _block_minutes(u, max(params["p1_min"], u + 0.5), 0, mult) + _block_minutes(0.0, p2, 3, mult)
    start = max(u, LATE_MIN) if late else u
    return _block_minutes(start, max(p2, u + 0.5), 3, mult)


def state(g, ts):
    """Latest facts up to ts: the score (team -> goals), shots (team -> fact) and goals per player."""
    score = {g.home: 0, g.away: 0}
    last = {}
    for f in g.upto(ts):
        if f["kind"] == "score":
            score[f["team_id"]] = int(f["value"])
        key = f["player_id"] if f["kind"] == "player_goals" else f["team_id"]
        last[(f["kind"], key)] = f
    return score, last


def rates(g, ts, params, last):
    """Goals per weighted minute for each team, from the base rate and the team's shots so far."""
    k, played = params["prior_min"], ts / 60.0
    out = {}
    for team in (g.home, g.away):
        f = last.get(("team_shots", team))
        shots = f["value"] if f else 0.0
        out[team] = (k * params["rate0"] + params["per_shot"] * shots) / (k + played)
    return out


def _at_least(lam_a, lam_b, d):
    """P(A - B >= d) for independent Poisson A, B."""
    total, cdf_b = 0.0, 0.0
    for i in range(0, 25):
        if i - d >= 0:
            cdf_b += _poisson(i - d, lam_b)
        total += _poisson(i, lam_a) * cdf_b
    return min(1.0, total)


def deficits(g, ts):
    """team -> the score fact that put it behind in its current deficit (none when not behind)."""
    score, since = {g.home: 0, g.away: 0}, {}
    for f in g.upto(ts):
        if f["kind"] != "score":
            continue
        score[f["team_id"]] = int(f["value"])
        for team in (g.home, g.away):
            behind = score[team] < score[g.other(team)]
            if behind and team not in since:
                since[team] = f
            elif not behind:
                since.pop(team, None)
    return since


def late_goal_by(g, ts):
    for f in g.upto(ts):
        if f["kind"] == "score" and where(g, f["ts"])[0] == 2 and where(g, f["ts"])[1] >= LATE_MIN - EPS:
            return f
    return None


# Hook for season facts (feat/season, after both merge): functions (g, ts, params) -> items in the format of
# forecasts(), for milestone kinds such as a player's 10th goal of the season from his season tally plus the
# second_goal rate. Each new kind also needs a branch in resolve(), TITLES and TEMPLATES.
EXTRA_KINDS = []


def forecasts(g, ts, params=None):
    """The open forecasts at ts with their probability and the facts behind them. Reads facts <= ts only."""
    params = params or load_params()
    if g.end is not None and ts >= g.end - EPS:
        return []
    score, last = state(g, ts)
    r = rates(g, ts, params, last)
    # chase: a trailing team's push (fitted); it raises its own goals for every kind
    push = {t: params["chase"] if score[t] < score[g.other(t)] else 1.0 for t in r}
    left = {t: push[t] * r[t] * exposure(g, ts, params) for t in r}
    shots = {t: last.get(("team_shots", t)) for t in r}
    out = []

    def add(item_id, kind, p, facts, team=None, player=None):
        p = round(min(max(p, 0.0), 1.0), 4)
        out.append({"id": item_id, "kind": kind, "team_id": team, "player_id": player, "p": p,
                    "level": level(kind, p, params), "fact_ids": [f["fact_id"] for f in facts if f]})

    for (kind, pid), f in sorted(last.items()):
        if kind != "player_goals" or f["value"] != 1:
            continue
        on, off = g.lineups.get(pid, (0.0, None))
        if off is not None and off <= ts + EPS:
            continue  # off the pitch: no second goal
        team = f["team_id"]
        add(f"W-second_goal-{pid}", "second_goal", 1 - math.exp(-params["scorer_share"] * left[team]),
            [f, shots[team]], team, pid)
    for team, f in sorted(deficits(g, ts).items()):
        opp = g.other(team)
        d = score[opp] - score[team]
        goals = [last.get(("score", t)) for t in (g.home, g.away)]
        add(f"W-comeback-{f['fact_id']}", "comeback", _at_least(left[team], left[opp], d), [*goals, shots[team]], team)
    for team in (g.home, g.away):
        opp = g.other(team)
        if score[opp] == 0:
            add(f"W-clean_sheet-{team}", "clean_sheet", math.exp(-left[opp]), [shots[opp]], team)
    if late_goal_by(g, ts) is None:
        lam = params["late"] * sum(push[t] * r[t] for t in r) * exposure(g, ts, params, late=True)
        goals = [last.get(("score", t)) for t in (g.home, g.away)]
        add("W-late_goal", "late_goal", 1 - math.exp(-lam), [*goals, shots[g.home], shots[g.away]])
    for extra in EXTRA_KINDS:
        out += extra(g, ts, params)
    return out


def resolve(g, item):
    """How an item ended, from the whole match (offline only: export and calibration). Returns
    {"hit": bool, "ts": when, "fact": the triggering fact or None}."""
    end = g.end
    kind, team, pid = item["kind"], item["team_id"], item["player_id"]
    after = [f for f in g.facts if f["kind"] in ("score", "player_goals")]
    if kind == "second_goal":
        f = next((f for f in after if f["kind"] == "player_goals" and f["player_id"] == pid and f["value"] == 2), None)
        off = g.lineups.get(pid, (0.0, None))[1]
        return {"hit": True, "ts": f["ts"], "fact": f} if f else {"hit": False, "ts": min(end, off or end), "fact": None}
    if kind == "comeback":
        opened = next(f for f in g.facts if f["fact_id"] == item["id"].removeprefix("W-comeback-"))
        score = {g.home: 0, g.away: 0}
        for f in after:
            if f["kind"] != "score":
                continue
            score[f["team_id"]] = int(f["value"])
            if f["ts"] > opened["ts"] + EPS and score[team] >= score[g.other(team)]:
                return {"hit": True, "ts": f["ts"], "fact": f}
        return {"hit": False, "ts": end, "fact": None}
    if kind == "clean_sheet":
        f = next((f for f in after if f["kind"] == "score" and f["team_id"] == g.other(team)), None)
        return {"hit": False, "ts": f["ts"], "fact": f} if f else {"hit": True, "ts": end, "fact": None}
    f = late_goal_by(g, math.inf)
    return {"hit": True, "ts": f["ts"], "fact": f} if f else {"hit": False, "ts": end, "fact": None}


def timeline(g, params=None):
    """Forecast steps for the replay: every STEP_S of match time and at each fact the model reads (a goal, a
    shot), so the panel never lags a graphic already on air, until full time."""
    times = {round(k * STEP_S, 2) for k in range(int(g.end // STEP_S) + 1)}
    times |= {round(f["ts"], 2) for f in g.facts}
    return [{"ts": t, "items": forecasts(g, t, params)} for t in sorted(times) if t < g.end - EPS]


# --- words: reasons, prepared lines ----------------------------------------------------------------

TITLES = {"second_goal": ("Second goal", "Doppietta", "Doblete"),
          "comeback": ("Comeback", "Rimonta", "Remontada"),
          "clean_sheet": ("Clean sheet", "Porta inviolata", "Portería a cero"),
          "late_goal": ("Late goal", "Gol nel finale", "Gol en el tramo final")}
LANGS = ("en", "it", "es")
# The prepared lines: phrasebook wording with slots that code fills at the event, from its facts.
# {player} and {team} are known when the line is prepared; {minute} and {score} wait for the event.
TEMPLATES = {
    "second_goal": ("{player} strikes again {minute}: {score}.", "Ancora {player}! Doppietta {minute}: {score}.",
                    "¡Otra vez {player}! Gol {minute}: {score}."),
    "comeback": ("What a comeback! {Team} have fought all the way back: {score}.", "Che rimonta {team_di}! Di nuovo in parità: {score}.",
                 "¡Qué reacción! {Team} iguala el partido, {score}."),
    "clean_sheet": ("Full time, and {team} keep a clean sheet: {score}.",
                    "Triplice fischio: {team} chiude senza subire gol, {score}.",
                    "Final del partido: {team} deja la portería a cero, {score}."),
    "late_goal": ("Late goal {minute}! {Score}.", "Gol nel finale, {minute}! {Score}.",
                  "¡Gol en el tramo final, {minute}! {Score}."),
}


def _plural(n, one, many):
    n = int(n)
    return one.format(n) if n == 1 else many.format(n)


def reason(m, g, item, ts, lang):
    """One line from the facts behind a forecast, in lang. m: agents.rules.Match with names."""
    from .agents import phrasebook
    i = LANGS.index(lang)
    score, last = state(g, ts)
    shots = lambda t: int(last[("team_shots", t)]["value"]) if ("team_shots", t) in last else 0  # noqa: E731
    shot_words = (("1 shot", "{} shots"), ("1 tiro", "{} tiri"), ("1 tiro", "{} tiros"))[i]
    team = item["team_id"]
    T = phrasebook.team(m, team, lang, start=True) if team else ""
    if item["kind"] == "second_goal":
        P = m.required_name(item["player_id"])
        T = phrasebook.team(m, team, lang)  # mid-sentence: lower-case article in it/es
        n = _plural(shots(team), *shot_words)
        return (f"{P} has scored once; {T} have {n} so far.", f"{P} ha già segnato; finora {n} per {T}.",
                f"{P} ya ha marcado; {T} lleva {n}.")[i]
    if item["kind"] == "comeback":
        s = f"{score[g.home]}-{score[g.away]}"
        n = _plural(shots(team), *shot_words)
        return (f"{T} trail {s}, with {n} so far.", f"{T} è sotto {s}, con {n} finora.",
                f"{T} pierde {s}, con {n} hasta ahora.")[i]
    if item["kind"] == "clean_sheet":
        opp = phrasebook.team(m, g.other(team), lang, start=True)
        n = _plural(shots(g.other(team)), *shot_words)
        return (f"{opp}: {n} and no goal so far.", f"{opp}: {n} e nessun gol finora.",
                f"{opp}: {n} y ningún gol hasta ahora.")[i]
    goals = score[g.home] + score[g.away]
    gw = _plural(goals, *(("1 goal", "{} goals"), ("1 gol", "{} gol"), ("1 gol", "{} goles"))[i])
    n = _plural(shots(g.home) + shots(g.away), *shot_words)
    return (f"{gw} and {n} in the match so far.", f"Finora {gw} e {n} in partita.",
            f"{gw} y {n} en el partido hasta ahora.")[i]


def _slots(m, g, item, lang, ts=None):
    from .agents import phrasebook, rules
    team = item["team_id"]
    s = {"player": m.required_name(item["player_id"]) if item["player_id"] else "",
         "team": phrasebook.team(m, team, lang) if team else "", "Team": phrasebook.team(m, team, lang, start=True) if team else "",
         "team_di": phrasebook.team(m, team, lang, "di") if team else ""}
    if ts is not None:
        s["minute"] = phrasebook.when(m, ts, lang)
        s["Minute"] = phrasebook.cap(s["minute"])
        goal = next((f for f in m.kind("score") if abs(f["ts"] - ts) < EPS), None)
        clause = phrasebook.score_clause(m, {"team_id": goal["team_id"], "ts": ts}, lang) if goal else ""
        s["score"] = clause if item["kind"] == "second_goal" else rules.score_text(m, ts, lang)
        s["Score"] = phrasebook.cap(clause)
    return s


class _Keep(dict):
    def __missing__(self, key):
        return "{" + key + "}"


def template(m, g, item, lang):
    """The prepared line with its live slots still open: "Tarrant strikes again {minute}: {score}."."""
    return TEMPLATES[item["kind"]][LANGS.index(lang)].format_map(_Keep(_slots(m, g, item, lang)))


def fill(m, g, item, ts, lang):
    """The prepared line with every slot filled by code from the facts at the event's time ts."""
    return TEMPLATES[item["kind"]][LANGS.index(lang)].format(**_slots(m, g, item, lang, ts))


# --- export ----------------------------------------------------------------------------------------

USED = ("score", "team_shots", "player_goals")


def export(conn, match_id, params_path=PARAMS_FILE):
    """forecast.json for the page, from the match database."""
    from .export import meta
    facts = [dict(r) for r in conn.execute("SELECT fact_id, kind, ts, period, team_id, player_id, value FROM facts "
                                           "WHERE match_id = ?", (match_id,))]
    return export_from(meta(conn, match_id), facts, params_path)


def export_from(meta, facts, params_path=PARAMS_FILE):
    """forecast.json from a match's meta.json and facts: the steps, and per item its words, how it ended and
    its filled line. The words read every fact, as the phrasebook does (export only: no clock)."""
    from .agents import rules
    params = load_params(params_path)
    side = {t["side"]: t["team_id"] for t in meta["teams"]}
    g = Game([f for f in facts if f["kind"] in USED], side["home"], side["away"], meta["period1_s"],
             {r["player_id"]: (r["on_ts"], r["off_ts"]) for r in meta["lineups"]}, meta["period1_s"] + meta["period2_s"])
    m = rules.Match(meta)
    m.facts = {f["fact_id"]: f for f in facts}
    match_id = meta["match_id"]
    steps = timeline(g, params)
    items = {}
    for st in steps:
        for it in st["items"]:
            it["reason"] = {lang: reason(m, g, it, st["ts"], lang) for lang in LANGS}
            if it["id"] in items:
                continue
            res = resolve(g, it)
            fact_ids = [*it["fact_ids"], *([res["fact"]["fact_id"]] if res["fact"] else [])]
            items[it["id"]] = {"id": it["id"], "kind": it["kind"], "team_id": it["team_id"], "player_id": it["player_id"],
                               "title": dict(zip(LANGS, TITLES[it["kind"]])),
                               "template": {lang: template(m, g, it, lang) for lang in LANGS},
                               "hit": res["hit"], "at": round(res["ts"], 2),
                               "trigger_fact_id": res["fact"]["fact_id"] if res["fact"] else None,
                               "line": {lang: fill(m, g, it, res["ts"], lang) for lang in LANGS} if res["hit"] else None,
                               "line_fact_ids": list(dict.fromkeys(fact_ids)) if res["hit"] else []}
    summary = json.loads(Path(params_path).read_text()).get("evaluation", {}) if Path(params_path).exists() else {}
    return {"match_id": match_id, "kinds": list(KINDS), "step_s": STEP_S, "steps": steps, "items": list(items.values()),
            "evaluation": summary}


def write(conn, match_id, out_dir):
    out = Path(out_dir) / match_id / "forecast.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(export(conn, match_id), ensure_ascii=False, allow_nan=False, separators=(",", ":")))
    return out


if __name__ == "__main__":
    import argparse

    from . import config, db
    ap = argparse.ArgumentParser(prog="python -m studiodesk.forecast", description="write web/data/<match>/forecast.json")
    ap.add_argument("match_ids", nargs="+")
    ap.add_argument("--db", type=Path, default=config.MATCHES_DB)
    ap.add_argument("--out", type=Path, default=config.ROOT / "web" / "data")
    a = ap.parse_args()
    with closing(db.connect(a.db, readonly=True)) as conn:
        for mid in a.match_ids:
            print(write(conn, mid, a.out))
