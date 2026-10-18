"""Builds data/matches.sqlite: league, matches, lineups, events, tracking and the hidden storylines."""
import json
import math
import os
from pathlib import Path

import numpy as np

from .. import config, db
from . import GENERATOR_VERSION, load_calibration
from .engine import SHOT_TYPES, Engine, Team, plan_match
from .squads import make_league
from .tracking import track

def timeline(ev, periods):
    """Insert dead-ball time before restarts: returns event ts, dead seconds, and a tg -> ts map."""
    tg = np.array([e["tg"] for e in ev])
    end = tg + np.array([e["dur"] for e in ev])
    per = np.array([e["period"] for e in ev])
    w = np.array([e["dead"] for e in ev])
    ts, dead, parts = np.zeros(len(ev)), np.zeros(len(ev)), []
    for p, length, offset in ((1, periods[0], 0.0), (2, periods[1], periods[0])):
        k = np.flatnonzero(per == p)
        tg0 = tg[k[0]]
        spare = max(0.0, length - (end[k].max() - tg0) - 0.5)
        dead[k] = spare * w[k] / w[k].sum() if w[k].sum() > 0 else 0.0
        cum = np.cumsum(dead[k])
        ts[k] = tg[k] - tg0 + cum + offset
        parts.append((tg0, tg[k], cum, offset))

    def to_ts(x):
        tg0, tgs, cum, offset = parts[1] if x >= parts[1][0] else parts[0]
        i = max(0, int(np.searchsorted(tgs, x, "right")) - 1)
        return float(x - tg0 + cum[i] + offset)

    return ts, dead, to_ts


def simulate(match_no, seed, league, cal, comeback, minutes=None):
    """One match: rows for every sim table plus the tracking array."""
    teams, players, venues = league
    rng = np.random.default_rng(seed)
    n = len(teams)
    home_t, away_t = teams[(2 * match_no) % n], teams[(2 * match_no + 1) % n]
    forms = {t["team_id"]: ("4-4-2", "4-3-3")[int(rng.integers(2))] for t in (home_t, away_t)}
    squad = {t["team_id"]: [p for p in players if p["team_id"] == t["team_id"]] for t in (home_t, away_t)}
    home = Team(home_t["team_id"], squad[home_t["team_id"]], forms[home_t["team_id"]], True)
    away = Team(away_t["team_id"], squad[away_t["team_id"]], forms[away_t["team_id"]], False)
    if minutes:
        periods = (minutes * 60.0, minutes * 60.0)
    else:
        periods = (round(rng.uniform(45.3, 47.0) * 60, 1), round(rng.uniform(46.0, 48.0) * 60, 1))
    start_slots = {home.id: list(home.slots), away.id: list(away.slots)}
    plan = plan_match(rng, cal, home, away, periods, comeback)
    eng = Engine(rng, cal, home, away, plan, periods)
    ev = eng.play()
    ts, dead, to_ts = timeline(ev, periods)
    match_id = f"M{match_no + 1:03d}"
    fps = config.FPS
    total = periods[0] + periods[1]

    # lineups and entity order (ball, home squad, away squad)
    sub_ts = {}
    for s in plan["subs"]:
        if s.get("done"):
            e = s["event"]
            sub_ts[s["off"]] = sub_ts[s["on"]] = float(ts[e] - dead[e] / 2)
    ents = [p["player_id"] for t in (home, away) for p in squad[t.id]]
    idx = {pid: k for k, pid in enumerate(ents)}
    slot = np.full(len(ents), -1)
    on_ts, off_ts = np.full(len(ents), np.inf), np.full(len(ents), np.inf)
    lineups = []
    for t in (home, away):
        for k, pid in enumerate(start_slots[t.id]):
            slot[idx[pid]], on_ts[idx[pid]] = k, 0.0
            off = sub_ts.get(pid)
            off_ts[idx[pid]] = off if off is not None else np.inf
            lineups.append((match_id, pid, 1, 0.0, off))
    for s in plan["subs"]:
        if s.get("done"):
            slot[idx[s["on"]]] = slot[idx[s["off"]]]
            on_ts[idx[s["on"]]] = sub_ts[s["on"]]
            lineups.append((match_id, s["on"], 0, sub_ts[s["on"]], None))
    by_id = {p["player_id"]: p for p in players}
    pl = dict(top_kmh=np.array([by_id[p]["top_speed_kmh"] for p in ents]),
              home=np.array([by_id[p]["team_id"] == home.id for p in ents]),
              team=np.array([by_id[p]["team_id"] for p in ents]), slot=slot, on_ts=on_ts,
              off_ts=off_ts, formation=[forms[by_id[p]["team_id"]] for p in ents])

    # planted storylines on the ts axis
    sh, pr = plan["shift"], plan["press"]
    story = dict(shift=dict(sh, ts=to_ts(sh["tg"])),
                 press=dict(pr, ts0=to_ts(pr["tg0"]), ts1=to_ts(pr["tg1"])), sprint=None)
    if eng.sprint:
        s = eng.sprint
        story["sprint"] = dict(idx=idx[s["player_id"]], ts0=to_ts(s["tg0"]), ts1=to_ts(s["tg1"]),
                               target=np.array(s["target"]), start=np.array(s["start"]),
                               player_id=s["player_id"])

    arr = lambda k: np.array([e[k] for e in ev])  # noqa: E731
    eva = dict(ts=ts, dur=arr("dur"), sx=arr("start_x"), sy=arr("start_y"), ex=arr("end_x"),
               ey=arr("end_y"), z=arr("z"), loft=arr("loft"), carry=arr("carry"), dead=dead,
               actor=np.array([idx[e["player_id"]] for e in ev]), period=arr("period"),
               home=np.array([e["team_id"] == home.id for e in ev]))
    frames_ts = np.arange(int(round(total * fps))) / fps
    pos, owner = track(frames_ts, eva, pl, periods, story, cal, rng)

    events = []
    for k, e in enumerate(ev):
        t = float(ts[k] - (periods[0] if e["period"] == 2 else 0.0))
        events.append((match_id, k + 1, e["period"], round(t, 2), round(float(ts[k]), 2), e["team_id"],
                       e["player_id"], e["type_name"], e["result_name"], e["bodypart_name"],
                       round(e["start_x"], 2), round(e["start_y"], 2), round(e["end_x"], 2),
                       round(e["end_y"], 2), e["related_player_id"]))
    goals = [(float(ts[k]), e["team_id"]) for k, e in enumerate(ev)
             if e["type_name"] in SHOT_TYPES and e["result_name"] == "success"]
    score = {home.id: sum(g[1] == home.id for g in goals), away.id: sum(g[1] == away.id for g in goals)}
    storylines = storyline_rows(match_id, story, plan, goals, pos, frames_ts, cal, total, home.id, away.id, periods[0])
    match = (match_id, seed, home.id, away.id, venues[home.id], periods[0], periods[1], fps,
             score[home.id], score[away.id], GENERATOR_VERSION)
    owners = [ents[o] if o >= 0 else None for o in owner]
    return dict(match=match, lineups=lineups, events=events, entities=["ball"] + ents, pos=pos,
                owners=owners, ts=frames_ts, storylines=storylines)


def storyline_rows(match_id, story, plan, goals, pos, ts, cal, total, home_id, away_id, period1_s):
    rows = []

    def add(kind, t0, t1, team=None, player=None, **params):
        rows.append((match_id, f"S-{len(rows) + 1:06d}", kind, round(t0, 1), round(t1, 1), team, player,
                     json.dumps(params)))

    sh, pr, sp = story["shift"], story["press"], story["sprint"]
    shift = dict(variant=sh["variant"])
    if sh["variant"] == "line":
        shift["line_raise_m"] = round(sh["line_raise_m"], 1)
    else:
        shift.update(from_formation=sh["frm"], to_formation=sh["to"])
    add("tactical_shift", sh["ts"], total, sh["team_id"], **shift)
    add("high_press", pr["ts0"], pr["ts1"], pr["team_id"], line_raise_m=pr["line_raise_m"],
        turnover_multiplier=pr["turnover_multiplier"], pressers=2)
    if sp:
        thr = cal["top_sprint_kmh"]["value"]
        fps = round(1 / (ts[1] - ts[0]))
        p = pos[:, sp["idx"] + 1, :2].astype(float)
        speed = np.r_[0, np.hypot(*np.diff(p, axis=0).T) * fps * 3.6]
        speed[np.searchsorted(ts, period1_s)] = 0  # players are moved at the 2nd-half restart
        win = (ts >= sp["ts0"] - 1) & (ts <= sp["ts1"] + 2)
        above = win & (speed > thr)
        if above.any():
            f = np.flatnonzero(above)
            add("top_sprint", ts[f[0]], ts[f[-1]], plan["sprint"]["team_id"], sp["player_id"],
                peak_kmh=round(float(np.nanmax(speed[win])), 2), seconds_above=round(len(f) / fps, 1),
                threshold_kmh=thr)
    diff, behind_since = {home_id: 0, away_id: 0}, {}
    for t, team in goals:  # comeback: a team that was behind draws level or goes ahead
        other = away_id if team == home_id else home_id
        diff[team] += 1
        diff[other] -= 1
        if diff[other] < 0 and other not in behind_since:
            behind_since[other] = t
        if diff[team] >= 0 and team in behind_since:
            add("comeback", behind_since.pop(team), t, team, planned=plan["comeback"],
                score_after=f"{diff[team]:+d}")
    return rows


def write(conn, league, results):
    teams, players, _ = league
    conn.executemany("INSERT INTO teams VALUES (:team_id,:name,:short_name,:color_primary,"
                     ":color_secondary,:crest_svg)", teams)
    conn.executemany("INSERT INTO players VALUES (:player_id,:team_id,:name,:shirt,:position,"
                     ":top_speed_kmh)", players)
    for r in results:
        mid = r["match"][0]
        conn.execute("INSERT INTO matches VALUES (?,?,?,?,?,?,?,?,?,?,?)", r["match"])
        conn.executemany("INSERT INTO lineups VALUES (?,?,?,?,?)", r["lineups"])
        conn.executemany("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", r["events"])
        conn.executemany("INSERT INTO tracking_entities VALUES (?,?,?)",
                         [(mid, k, e) for k, e in enumerate(r["entities"])])
        conn.executemany("INSERT INTO tracking_frames VALUES (?,?,?,?,?)",
                         ((mid, f, round(float(r["ts"][f]), 1), r["owners"][f], r["pos"][f].astype("<f4").tobytes())
                          for f in range(len(r["ts"]))))
        conn.executemany("INSERT INTO storylines VALUES (?,?,?,?,?,?,?,?)", r["storylines"])
    conn.commit()


def _simulate_with_comeback(match_no, seed, league, cal, comeback, minutes):
    # A planned goal only goes in if its team reaches a shooting position in time, which short
    # matches do not always allow: replay with another seed until the planted comeback shows.
    for attempt in range(8):
        r = simulate(match_no, seed + attempt * 100_000, league, cal, comeback, minutes)
        if not comeback or any("comeback" in row for row in r["storylines"]):
            return r
    raise RuntimeError(f"match {match_no}: planned comeback missing after 8 seeds")


def build(n_matches=4, seed=7, path: Path = config.MATCHES_DB, minutes=None):
    """Rebuild the file from scratch. Facts (builder B) must be recomputed after a rebuild."""
    cal = load_calibration()
    rng = np.random.default_rng(seed)
    league = make_league(rng, cal)
    comebacks = set(rng.choice(n_matches, math.ceil(n_matches / 2), replace=False).tolist())
    results = [_simulate_with_comeback(m, seed * 1000 + m + 1, league, cal, m in comebacks, minutes)
               for m in range(n_matches)]
    # written beside the old file and swapped in at the end: a failed write keeps the old database
    tmp = Path(f"{path}.tmp")
    for suffix in ("", "-wal", "-shm"):
        Path(f"{tmp}{suffix}").unlink(missing_ok=True)
    conn = db.connect(tmp)
    write(conn, league, results)
    conn.close()
    for suffix in ("-wal", "-shm"):
        Path(f"{path}{suffix}").unlink(missing_ok=True)
    os.replace(tmp, path)
    return results
