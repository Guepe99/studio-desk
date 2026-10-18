"""Calibrate Studio Desk from the public Wyscout event data (Pappalardo et al. 2019).

Run once, offline. It writes three small committed files and nothing else:

- studiodesk/facts/xt_grid.json        16x12 expected-threat grid (contract: "Calibration files")
- studiodesk/sim/wyscout_averages.json every measured average, {"<name>": {"value", "source"}}
- studiodesk/sim/calibration.json      only if it exists: keys in MAPPING get the measured value

socceraction is used only here, in its own venv, never in the project venv:

    python3 -m venv ~/.cache/studiodesk/calib-venv
    ~/.cache/studiodesk/calib-venv/bin/pip install socceraction==1.5.3 ijson==3.3.0 multimethod==1.10
    ~/.cache/studiodesk/calib-venv/bin/python scripts/calibrate.py

Raw files (downloaded here if missing, checked by MD5) stay in
~/progetti/inside-the-game/data/raw/wyscout/, git-ignored. Events are streamed one match at a
time with ijson, so peak memory stays far below loading a 190 MB league file whole.
"""

import argparse
import json
import math
import resource
import urllib.request
import zipfile
from hashlib import md5
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parent.parent
RAW = Path.home() / "progetti/inside-the-game/data/raw/wyscout"
XT_OUT = REPO / "studiodesk/facts/xt_grid.json"
AVG_OUT = REPO / "studiodesk/sim/wyscout_averages.json"
CALIBRATION = REPO / "studiodesk/sim/calibration.json"

# figshare collection 4415000: file id and MD5 of every file we read.
FILES = {
    "events.zip": (14464685, "7c20e8647e7eda58d7838a0c7b1ec6ab"),
    "matches.zip": (14464622, "51d80beb17480919f69a53a0152c2d71"),
    "competitions.json": (15073685, "3dc210a4805dda5337b0ff9f7eaa407a"),
}

# The hackathon is run with the Premier League: we do not reuse its data, so the
# English first division 2017/18 (Wyscout competition 364) is excluded here, in code.
EXCLUDED_COMPETITIONS = {364}

SOURCE = (
    "Wyscout public dataset (Pappalardo et al. 2019), 4 leagues 2017/18 excluding England, "
    "computed by scripts/calibrate.py"
)
L, W = 105.0, 68.0
SHOTS = ("shot", "shot_freekick", "shot_penalty")

# calibration.json key -> wyscout_averages.json key, only where Wyscout measures the same thing
# in the same unit. Keys not listed here keep their literature value.
MAPPING: dict[str, str] = {}


def download():
    RAW.mkdir(parents=True, exist_ok=True)
    for name, (file_id, digest) in FILES.items():
        path = RAW / name
        if not path.exists():
            urllib.request.urlretrieve(f"https://ndownloader.figshare.com/files/{file_id}", path)
        if md5(path.read_bytes()).hexdigest() != digest:
            raise SystemExit(f"{path}: MD5 mismatch, delete it and run again")


def included_leagues():
    """[(competition_id, area name)] for club competitions, England excluded."""
    comps = json.loads((RAW / "competitions.json").read_text())
    out = [(c["wyId"], c["area"]["name"]) for c in comps
           if c["type"] == "club" and c["wyId"] not in EXCLUDED_COMPETITIONS]
    assert out and all(cid not in EXCLUDED_COMPETITIONS for cid, _ in out)
    return out


def stream_matches(area):
    """Yield (match_id, raw events list) from events_<area>.json, one match at a time."""
    import ijson

    with zipfile.ZipFile(RAW / "events.zip") as z, z.open(f"events_{area}.json") as f:
        seen, cur, buf = set(), None, []
        for ev in ijson.items(f, "item", use_float=True):
            if ev["matchId"] != cur:
                if cur is not None:
                    yield cur, buf
                assert ev["matchId"] not in seen, "events are not grouped by match"
                seen.add(cur)
                cur, buf = ev["matchId"], []
            buf.append(ev)
        if cur is not None:
            yield cur, buf


def to_spadl(raw_events, home_team_id):
    """Raw Wyscout events of one match -> SPADL actions, every team attacking towards x = 105."""
    from socceraction.data.wyscout.loader import _convert_events
    from socceraction.spadl import add_names, play_left_to_right
    from socceraction.spadl.wyscout import convert_to_actions

    events = _convert_events(pd.DataFrame(raw_events))
    actions = convert_to_actions(events, home_team_id)
    return add_names(play_left_to_right(actions, home_team_id))


def shot_zone(x, y):
    if x >= L - 5.5 and abs(y - W / 2) <= 9.16:
        return "six_yard_box"
    if x >= L - 16.5 and abs(y - W / 2) <= 20.16:
        return "penalty_area"
    return "outside_box"


def match_stats(a, game_id):
    """One row per team for this match, plus pass lengths, possession lengths, shot zones."""
    rows, zones = [], []
    a = a.sort_values(["period_id", "action_id"])
    new_seq = (a.team_id != a.team_id.shift()) | (a.period_id != a.period_id.shift())
    seq = new_seq.cumsum()
    g = a.groupby(seq)
    poss = pd.DataFrame({"n": g.size(), "dur": g.time_seconds.max() - g.time_seconds.min()})
    passes = a[a.type_name == "pass"]
    plen = np.hypot(passes.end_x - passes.start_x, passes.end_y - passes.start_y).to_numpy("f4")
    for team, t in a.groupby("team_id"):
        p = t[t.type_name == "pass"]
        shots = t[t.type_name.isin(SHOTS)]
        rows.append({
            "game_id": game_id,
            "team_id": team,
            "actions": len(t),
            **{f"n_{k}": v for k, v in t.type_name.value_counts().items()},
            "pass_ok": int((p.result_name == "success").sum()),
            "pass_fwd": int((p.end_x > p.start_x).sum()),
            "shots": len(shots),
            "goals": int((shots.result_name == "success").sum()),
            "own_goals_for": 0,
            "yellow": int((t.result_name == "yellow_card").sum()),
            "red": int((t.result_name == "red_card").sum()),
        })
        for s in shots.itertuples():
            pen = s.type_name == "shot_penalty"
            zones.append(("penalty_spot" if pen else shot_zone(s.start_x, s.start_y),
                          s.result_name == "success"))
    # an own goal counts for the other team
    for og in a[a.result_name == "owngoal"].itertuples():
        for r in rows:
            if r["team_id"] != og.team_id:
                r["own_goals_for"] += 1
    return rows, plen, poss, zones


def check_grid(grid):
    """Orientation check for a team attacking towards x = 105: rises along x, peaks at goal centre."""
    g = np.asarray(grid)
    assert g.shape == (12, 16)
    r, c = np.unravel_index(g.argmax(), g.shape)
    assert c >= 14 and 4 <= r <= 7, f"xT peak at row {r}, col {c}"
    cols = g.mean(axis=0)
    assert cols[-1] > cols[8] > cols[0], "xT does not rise towards x = 105"
    assert np.allclose(g, g[::-1], atol=g.max() * 0.35), "xT far from symmetric across y"


def summarise(teams, plens, poss, zones, n_matches):
    def dist(s):
        s = s.astype(float)
        return {"mean": round(s.mean(), 3), "std": round(s.std(), 3),
                "p10": round(s.quantile(0.1), 3), "p50": round(s.quantile(0.5), 3),
                "p90": round(s.quantile(0.9), 3)}

    teams = teams.fillna(0)
    type_cols = sorted(c for c in teams.columns if c.startswith("n_"))
    goals_team = teams.goals + teams.own_goals_for
    goals_match = goals_team.groupby(teams.game_id).sum()
    plen = np.concatenate(plens)
    zone_df = pd.DataFrame(zones, columns=["zone", "goal"])
    zg = zone_df.groupby("zone").goal
    v = {
        "matches": n_matches,
        "team_matches": len(teams),
        "actions_per_team_match": dist(teams.actions),
        "actions_by_type_per_team_match": {c[2:]: round(teams[c].mean(), 3) for c in type_cols},
        "passes_per_team_match": dist(teams.n_pass),
        "pass_success_rate": round(teams.pass_ok.sum() / teams.n_pass.sum(), 4),
        "pass_length_mean_m": round(float(plen.mean()), 2),
        "pass_length_median_m": round(float(np.median(plen)), 2),
        "pass_length_p90_m": round(float(np.quantile(plen, 0.9)), 2),
        "forward_pass_share": round(teams.pass_fwd.sum() / teams.n_pass.sum(), 4),
        "crosses_per_team_match": dist(teams.n_cross + teams.get("n_freekick_crossed", 0)
                                       + teams.get("n_corner_crossed", 0)),
        "open_play_crosses_per_team_match": round(teams.n_cross.mean(), 3),
        "shots_per_team_match": dist(teams.shots),
        "goals_per_shot": round(teams.goals.sum() / teams.shots.sum(), 4),
        "goals_per_team_match": dist(goals_team),
        "goals_per_match": dist(goals_match),
        "fouls_per_team_match": dist(teams.n_foul),
        "yellow_cards_per_team_match": round(teams.yellow.mean(), 3),
        "red_cards_per_team_match": round(teams.red.mean(), 4),
        "possession_sequence_actions": {"mean": round(poss.n.mean(), 2),
                                        "median": float(poss.n.median()),
                                        "p90": float(poss.n.quantile(0.9))},
        "possession_sequence_seconds": {"mean": round(poss.dur.mean(), 2),
                                        "median": round(float(poss.dur.median()), 2)},
        "shot_zone_share": {k: round(n / len(zone_df), 4) for k, n in zg.size().items()},
        "goals_per_shot_by_zone": {k: round(m, 4) for k, m in zg.mean().items()},
    }
    return {k: {"value": val, "source": SOURCE} for k, val in v.items()}


def apply_mapping(averages):
    """Write measured values into calibration.json for the keys in MAPPING; leave the rest."""
    if not CALIBRATION.exists():
        print("calibration.json not found: mapping pending")
        return []
    cal = json.loads(CALIBRATION.read_text())
    done = []
    for key, name in MAPPING.items():
        if key in cal:
            value = averages[name]["value"]
            cal[key] = {**cal[key], "value": value["mean"] if isinstance(value, dict) else value,
                        "source": SOURCE}
            done.append(key)
    CALIBRATION.write_text(json.dumps(cal, indent=2) + "\n")
    return done


def peak_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map-only", action="store_true",
                    help="skip the computation; apply MAPPING from the committed averages")
    ap.add_argument("--limit", type=int, default=0, help="matches per league (smoke test)")
    args = ap.parse_args()
    if args.map_only:
        print("mapped:", apply_mapping(json.loads(AVG_OUT.read_text())))
        return

    from socceraction.xthreat import ExpectedThreat

    download()
    team_rows, plens, poss, zones, xt_parts, per_league = [], [], [], [], [], {}
    with zipfile.ZipFile(RAW / "matches.zip") as z:
        for comp_id, area in included_leagues():
            matches = {m["wyId"]: m for m in json.loads(z.read(f"matches_{area}.json"))
                       if m["competitionId"] == comp_id}  # never another competition
            n = 0
            for match_id, raw in stream_matches(area):
                m = matches.get(match_id)
                if m is None:
                    continue
                home = next(int(t) for t, d in m["teamsData"].items() if d["side"] == "home")
                a = to_spadl(raw, home)
                rows, plen, pz, zn = match_stats(a, match_id)
                team_rows += rows
                plens.append(plen)
                poss.append(pz)
                zones += zn
                xt_parts.append(a[["type_id", "result_id", "start_x", "start_y", "end_x", "end_y"]]
                                .astype({"type_id": "i1", "result_id": "i1", "start_x": "f4",
                                         "start_y": "f4", "end_x": "f4", "end_y": "f4"}))
                n += 1
                if n % 50 == 0:
                    print(f"{area}: {n} matches, peak {peak_mb():.0f} MB", flush=True)
                if args.limit and n >= args.limit:
                    break
            per_league[area] = n
            print(f"{area} (competition {comp_id}): {n} matches, peak {peak_mb():.0f} MB", flush=True)

    actions = pd.concat(xt_parts, ignore_index=True)
    del xt_parts
    xt = ExpectedThreat(l=16, w=12).fit(actions)
    # socceraction's matrix has row 0 at the top (y = 68); the contract wants row 0 at y = 0.
    grid = xt.xT[::-1]
    check_grid(grid)
    leagues = ", ".join(f"{k} {v}" for k, v in per_league.items())
    XT_OUT.write_text(json.dumps({
        "cols": 16, "rows": 12,
        "grid": [[round(float(v), 5) for v in row] for row in grid],
        "source": f"socceraction ExpectedThreat(l=16, w=12) fitted on {len(actions)} SPADL actions "
                  f"from the Wyscout public dataset (Pappalardo et al. 2019), 2017/18 club leagues "
                  f"excluding England: {leagues} matches",
    }, indent=1) + "\n")

    averages = summarise(pd.DataFrame(team_rows), plens, pd.concat(poss), zones,
                         sum(per_league.values()))
    averages["matches_by_league"] = {"value": per_league, "source": SOURCE}
    AVG_OUT.parent.mkdir(exist_ok=True)
    AVG_OUT.write_text(json.dumps(averages, indent=2) + "\n")
    print("mapped:", apply_mapping(averages))
    r, c = np.unravel_index(grid.argmax(), grid.shape)
    print(f"xT max {grid.max():.4f} at row {r} col {c}; actions {len(actions)}; "
          f"peak {peak_mb():.0f} MB")


if __name__ == "__main__":
    main()
