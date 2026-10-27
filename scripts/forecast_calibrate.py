"""Fit and test the Watch for model (studiodesk/forecast.py) on simulated matches. docs/forecast.md.

    scripts/with-lock.sh build .venv/bin/python scripts/forecast_calibrate.py --fit 400 --test 400 --seed 11

Simulates matches with studiodesk.sim (events only: the model reads no tracking), builds their facts with
the facts engine, fits the parameters on the first set and scores the forecasts on the second, which the
fit never saw. Writes studiodesk/forecast_params.json (parameters and the test scores) and every forecast
with its outcome to data/forecast.sqlite. Prints the tables for docs/forecast.md.
"""
import argparse
import json
import math
import sys
import time
from contextlib import closing
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from studiodesk import config, db, forecast  # noqa: E402
from studiodesk.facts.engine import compute  # noqa: E402
from studiodesk.sim import GENERATOR_VERSION, load_calibration  # noqa: E402
from studiodesk.sim.build import timeline  # noqa: E402
from studiodesk.sim.engine import Engine, Team, plan_match  # noqa: E402
from studiodesk.sim.squads import make_league  # noqa: E402

EVAL_STEP_S = 300.0  # forecasts are scored every 5 minutes of play
K_GRID = (5.0, 15.0, 45.0, 90.0, 180.0, 400.0, 1e6)  # 1e6: shots ignored, the base rate only
FACTOR_GRID = (0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 6.0)
BINS = 10
DB_FILE = config.ROOT / "data" / "forecast.sqlite"
TABLES = """
CREATE TABLE IF NOT EXISTS forecast_runs (run_id INTEGER PRIMARY KEY, created_at TEXT, seed INTEGER, n_fit INTEGER,
  n_test INTEGER, params TEXT);
CREATE TABLE IF NOT EXISTS forecast_samples (run_id INTEGER, set_name TEXT, match_no INTEGER, kind TEXT, item_id TEXT,
  ts REAL, p REAL, hit INTEGER);
CREATE TABLE IF NOT EXISTS forecast_scores (run_id INTEGER, kind TEXT, n INTEGER, n_matches INTEGER, base_rate REAL,
  brier REAL, brier_base REAL, skill REAL);
CREATE TABLE IF NOT EXISTS forecast_reliability (run_id INTEGER, kind TEXT, bin INTEGER, n INTEGER, mean_p REAL,
  observed REAL);
"""


def simulate(conn, match_no, seed, league, cal, comeback):
    """One match as studiodesk.sim.build.simulate plays it, without tracking: its facts and a forecast.Game."""
    teams, players, venues = league
    rng = np.random.default_rng(seed)
    n = len(teams)
    home_t, away_t = teams[(2 * match_no) % n], teams[(2 * match_no + 1) % n]
    forms = {t["team_id"]: ("4-4-2", "4-3-3")[int(rng.integers(2))] for t in (home_t, away_t)}
    squad = {t["team_id"]: [p for p in players if p["team_id"] == t["team_id"]] for t in (home_t, away_t)}
    home = Team(home_t["team_id"], squad[home_t["team_id"]], forms[home_t["team_id"]], True)
    away = Team(away_t["team_id"], squad[away_t["team_id"]], forms[away_t["team_id"]], False)
    periods = (round(rng.uniform(45.3, 47.0) * 60, 1), round(rng.uniform(46.0, 48.0) * 60, 1))
    start = {home.id: list(home.slots), away.id: list(away.slots)}
    plan = plan_match(rng, cal, home, away, periods, comeback)
    ev = Engine(rng, cal, home, away, plan, periods).play()
    ts, dead, _ = timeline(ev, periods)
    sub_ts = {}
    for s in plan["subs"]:
        if s.get("done"):
            e = s["event"]
            sub_ts[s["off"]] = sub_ts[s["on"]] = float(ts[e] - dead[e] / 2)
    mid = "M001"
    lineups = [(mid, pid, 1, 0.0, sub_ts.get(pid)) for t in (home, away) for pid in start[t.id]]
    lineups += [(mid, s["on"], 0, sub_ts[s["on"]], None) for s in plan["subs"] if s.get("done")]
    events = [(mid, k + 1, e["period"], round(float(ts[k] - (periods[0] if e["period"] == 2 else 0.0)), 2),
               round(float(ts[k]), 2), e["team_id"], e["player_id"], e["type_name"], e["result_name"],
               e["bodypart_name"], round(e["start_x"], 2), round(e["start_y"], 2), round(e["end_x"], 2),
               round(e["end_y"], 2), e["related_player_id"]) for k, e in enumerate(ev)]
    for table in ("events", "lineups", "matches"):
        conn.execute(f"DELETE FROM {table}")
    conn.execute("INSERT INTO matches VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                 (mid, seed, home.id, away.id, venues[home.id], periods[0], periods[1], config.FPS, 0, 0, GENERATOR_VERSION))
    conn.executemany("INSERT INTO lineups VALUES (?,?,?,?,?)", lineups)
    conn.executemany("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", events)
    facts = [f | {"fact_id": f["fact_id"]} for f in compute(conn, mid, xt_grid=None)
             if f["kind"] in ("score", "team_shots", "player_goals")]
    return forecast.Game(facts, home.id, away.id, periods[0], {r[1]: (r[3], r[4]) for r in lineups}, sum(periods))


def simulate_set(n, seed):
    """n matches; half of them with a planted comeback, as the demo build plans them."""
    cal = load_calibration()
    rng = np.random.default_rng(seed)
    league = make_league(rng, cal)
    comebacks = set(rng.choice(n, math.ceil(n / 2), replace=False).tolist())
    conn = db.connect(Path(":memory:"))
    teams, players, _ = league
    conn.executemany("INSERT INTO teams VALUES (:team_id,:name,:short_name,:color_primary,:color_secondary,:crest_svg)", teams)
    conn.executemany("INSERT INTO players VALUES (:player_id,:team_id,:name,:shirt,:position,:top_speed_kmh)", players)
    with closing(conn):
        return [simulate(conn, m, seed * 1000 + m + 1, league, cal, m in comebacks) for m in range(n)]


# --- fit -------------------------------------------------------------------------------------------

def fit(games):
    """Rates in closed form from the fit set; prior_min, chase, the scorer share's scale and late by the
    lowest Brier score on it, in that order."""
    goals = [f for g in games for f in g.facts if f["kind"] == "score"]
    minutes = sum(g.end for g in games) / 60.0
    shots = sum(max((f["value"] for f in g.facts if f["kind"] == "team_shots" and f["team_id"] == t), default=0)
                for g in games for t in (g.home, g.away))
    rate0 = len(goals) / (2 * minutes)
    block_goals, block_min = [0] * 6, [0.0] * 6
    for g in games:
        for k, length in enumerate((g.p1 / 60.0, (g.end - g.p1) / 60.0)):
            block_min[3 * k] += 15.0
            block_min[3 * k + 1] += 15.0
            block_min[3 * k + 2] += max(0.0, length - 30.0)
        for f in g.facts:
            if f["kind"] == "score":
                period, u = forecast.where(g, f["ts"])
                block_goals[3 * (period - 1) + min(int(u // 15), 2)] += 1
    stage = [round((bg / (2 * bm)) / rate0, 4) if bm else 1.0 for bg, bm in zip(block_goals, block_min)]
    later = scored = 0
    for g in games:
        for f in g.facts:
            if f["kind"] != "player_goals" or f["value"] != 1:
                continue
            off = g.lineups.get(f["player_id"], (0, None))[1] or g.end
            team_goals = [x for x in g.facts if x["kind"] == "score" and x["team_id"] == f["team_id"]
                          and f["ts"] + forecast.EPS < x["ts"] <= off]
            later += len(team_goals)
            scored += sum(x["player_id"] == f["player_id"] for x in team_goals)
    params = {"rate0": round(rate0, 6), "per_shot": round(len(goals) / shots, 6), "stage": stage,
              "scorer_share": round(scored / later, 4) if later else forecast.DEFAULT["scorer_share"],
              "p1_min": round(float(np.mean([g.p1 for g in games])) / 60.0, 3),
              "p2_min": round(float(np.mean([g.end - g.p1 for g in games])) / 60.0, 3)}
    params = {**params, "chase": 1.0, "late": 1.0}
    params["prior_min"] = min(K_GRID, key=lambda k: brier(samples(games, {**params, "prior_min": k})))
    params["chase"] = min(FACTOR_GRID, key=lambda x: brier(samples(games, {**params, "chase": x})))  # all kinds
    # the closed-form share counts only minutes on the pitch, which live play cannot know: scaled by its Brier score
    share = params["scorer_share"]
    params["scorer_share"] = round(share * min(FACTOR_GRID, key=lambda x: brier(
        samples(games, {**params, "scorer_share": share * x}, "second_goal"))), 4)
    params["late"] = min(FACTOR_GRID, key=lambda x: brier(samples(games, {**params, "late": x}, "late_goal")))
    return params


def samples(games, params, kind=None):
    """(match_no, kind, item_id, ts, p, hit) for every open forecast every EVAL_STEP_S of play."""
    out = []
    for n, g in enumerate(games):
        ends = {}
        t = EVAL_STEP_S
        while t < g.end:
            for it in forecast.forecasts(g, t, params):
                if kind and it["kind"] != kind:
                    continue
                if it["id"] not in ends:
                    ends[it["id"]] = forecast.resolve(g, it)["hit"]
                out.append((n, it["kind"], it["id"], t, it["p"], int(ends[it["id"]])))
            t += EVAL_STEP_S
    return out


def brier(rows, p=None):
    return float(np.mean([((p if p is not None else r[4]) - r[5]) ** 2 for r in rows])) if rows else math.nan


def evaluate(fit_rows, test_rows):
    """Per kind: Brier score of the model and of the naive forecast (the kind's rate in the fit set), and a
    reliability table in 10 bins of the forecast probability."""
    scores, rel = {}, {}
    for kind in forecast.KINDS:
        tr = [r for r in fit_rows if r[1] == kind]
        te = [r for r in test_rows if r[1] == kind]
        base = float(np.mean([r[5] for r in tr])) if tr else 0.5
        b, bb = brier(te), brier(te, base)
        scores[kind] = {"n": len(te), "n_matches": len({r[0] for r in te}), "base_rate": round(base, 4),
                        "brier": round(b, 4), "brier_base": round(bb, 4), "skill": round(1 - b / bb, 3) if bb else None}
        rel[kind] = []
        for k in range(BINS):
            inside = [r for r in te if min(int(r[4] * BINS), BINS - 1) == k]
            if inside:
                rel[kind].append({"bin": k, "n": len(inside), "mean_p": round(float(np.mean([r[4] for r in inside])), 3),
                                  "observed": round(float(np.mean([r[5] for r in inside])), 3)})
    return scores, rel


def run(n_fit, n_test, seed):
    """Deterministic for a seed: the fit set uses seed, the test set seed + 1 (another league and matches)."""
    fit_games, test_games = simulate_set(n_fit, seed), simulate_set(n_test, seed + 1)
    params = fit(fit_games)
    fit_rows, test_rows = samples(fit_games, params), samples(test_games, params)
    scores, rel = evaluate(fit_rows, test_rows)
    return {"params": params, "seed": seed, "n_fit": n_fit, "n_test": n_test, "scores": scores, "reliability": rel,
            "fit_rows": fit_rows, "test_rows": test_rows}


def save(res, path=DB_FILE):
    with closing(db.connect(path)) as conn:
        conn.executescript(TABLES)
        cur = conn.execute("INSERT INTO forecast_runs (created_at, seed, n_fit, n_test, params) VALUES "
                           "(datetime('now'), ?, ?, ?, ?)", (res["seed"], res["n_fit"], res["n_test"], json.dumps(res["params"])))
        run_id = cur.lastrowid
        for name in ("fit", "test"):
            conn.executemany("INSERT INTO forecast_samples VALUES (?,?,?,?,?,?,?,?)",
                             [(run_id, name, *r) for r in res[f"{name}_rows"]])
        conn.executemany("INSERT INTO forecast_scores VALUES (?,?,?,?,?,?,?,?)",
                         [(run_id, k, s["n"], s["n_matches"], s["base_rate"], s["brier"], s["brier_base"], s["skill"])
                          for k, s in res["scores"].items()])
        conn.executemany("INSERT INTO forecast_reliability VALUES (?,?,?,?,?,?)",
                         [(run_id, k, b["bin"], b["n"], b["mean_p"], b["observed"]) for k, bins in res["reliability"].items()
                          for b in bins])
        conn.commit()
    return run_id


def tables(res):
    lines = ["| kind | forecasts | matches | event rate (fit set) | Brier, model | Brier, naive | skill |", "|---|---|---|---|---|---|---|"]
    for k, s in res["scores"].items():
        lines.append(f"| {k} | {s['n']} | {s['n_matches']} | {s['base_rate']:.3f} | {s['brier']:.4f} | {s['brier_base']:.4f} | {s['skill']:+.3f} |")
    lines += ["", "| kind | forecast | n | mean forecast | observed |", "|---|---|---|---|---|"]
    for k, bins in res["reliability"].items():
        for b in bins:
            lines.append(f"| {k} | {b['bin'] / BINS:.1f}-{(b['bin'] + 1) / BINS:.1f} | {b['n']} | {b['mean_p']:.3f} | {b['observed']:.3f} |")
    return "\n".join(lines)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fit", type=int, default=400)
    ap.add_argument("--test", type=int, default=400)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--params", type=Path, default=forecast.PARAMS_FILE)
    ap.add_argument("--db", type=Path, default=DB_FILE)
    a = ap.parse_args()
    t0 = time.time()
    res = run(a.fit, a.test, a.seed)
    run_id = save(res, a.db)
    a.params.write_text(json.dumps({"params": res["params"], "evaluation": {
        "seed": a.seed, "n_fit": a.fit, "n_test": a.test, "scores": res["scores"],
        "note": "Tested on simulated matches only (scripts/forecast_calibrate.py)."}}, indent=1) + "\n")
    print(json.dumps(res["params"]))
    print(tables(res))
    print(f"run {run_id} in {a.db}, {time.time() - t0:.0f} s")
