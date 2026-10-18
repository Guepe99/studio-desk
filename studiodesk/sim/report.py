"""Realism report: simulated values against the calibration, from the stored data only.

It never reads `storylines`: docs/realism.md is public and must not leak the answer key.
"""
import numpy as np

from .. import db
from . import GENERATOR_VERSION, load_calibration
from .engine import PASS_TYPES, SHOT_TYPES


def frames(conn, match_id):
    rows = conn.execute("SELECT pos FROM tracking_frames WHERE match_id=? ORDER BY frame", (match_id,))
    blob = b"".join(r[0] for r in rows)
    n = conn.execute("SELECT COUNT(*) FROM tracking_entities WHERE match_id=?", (match_id,)).fetchone()[0]
    return np.frombuffer(blob, "<f4").reshape(-1, n, 3).astype(float)


def kinematics(pos, fps, boundary):
    """Speed (km/h) and acceleration (m/s^2) per frame and player, NaN across the half-time cut."""
    p = pos[:, 1:, :2]
    v = np.diff(p, axis=0) * fps
    v[boundary - 1] = np.nan
    speed = np.hypot(v[..., 0], v[..., 1]) * 3.6
    a = np.diff(v, axis=0) * fps
    acc = np.hypot(a[..., 0], a[..., 1])
    return speed, acc


def sprints(above, min_frames):
    """Number of runs of at least min_frames consecutive True values, per column."""
    pad = np.vstack([np.zeros((1, above.shape[1]), bool), above, np.zeros((1, above.shape[1]), bool)])
    d = np.diff(pad.astype(int), axis=0)
    out = []
    for col in range(above.shape[1]):
        s, e = np.flatnonzero(d[:, col] == 1), np.flatnonzero(d[:, col] == -1)
        out.append(int(((e - s) >= min_frames).sum()))
    return np.array(out)


def match_metrics(conn, m, cal):
    mid, fps = m["match_id"], m["fps"]
    ev = conn.execute("SELECT * FROM events WHERE match_id=? ORDER BY event_id", (mid,)).fetchall()
    passes = [e for e in ev if e["type_name"] in PASS_TYPES]
    plain = [e for e in passes if e["type_name"] == "pass"]  # like the calibration values: crosses apart
    length = [np.hypot(e["end_x"] - e["start_x"], e["end_y"] - e["start_y"]) for e in plain]
    shots = [e for e in ev if e["type_name"] in SHOT_TYPES]
    pos = frames(conn, mid)
    boundary = int(round(m["period1_s"] * fps))
    speed, acc = kinematics(pos, fps, boundary)
    ents = [r[0] for r in conn.execute("SELECT entity FROM tracking_entities WHERE match_id=? "
                                       "ORDER BY idx", (mid,))][1:]
    pinfo = {r["player_id"]: r for r in conn.execute("SELECT * FROM players")}
    lu = {r["player_id"]: r for r in conn.execute("SELECT * FROM lineups WHERE match_id=?", (mid,))}
    full = np.array([bool(p in lu and lu[p]["starter"] and lu[p]["off_ts"] is None
                          and pinfo[p]["position"] != "GK") for p in ents])
    thr = cal["sprint_threshold_kmh"]["value"]
    n_spr = sprints(np.nan_to_num(speed[:, full]) > thr,
                    int(round(cal["sprint_min_duration_s"]["value"] * fps)))
    dist = np.nansum(speed[:, full], axis=0) / 3.6 / fps
    # consistency: actor distance to the ball at the event start frame
    idx = {p: k for k, p in enumerate(ents)}
    gap = [np.hypot(*(pos[min(len(pos) - 1, int(round(e["ts"] * fps))), idx[e["player_id"]] + 1, :2]
                      - (e["start_x"], e["start_y"]))) for e in ev]
    played = np.isfinite(speed).any(axis=0)
    over = np.nanmax(speed[:, played] - np.array([pinfo[p]["top_speed_kmh"] for p in ents])[played])
    ball = pos[:, 0, :]
    bspeed = np.hypot(*np.diff(ball[:, :2], axis=0).T) * fps * 3.6
    bspeed[boundary - 1] = np.nan
    return {
        "actions_per_team_per_match": len(ev) / 2,
        "pass_share": len(passes) / len(ev),
        "pass_success_rate": np.mean([e["result_name"] == "success" for e in plain]),
        "mean_pass_length_m": float(np.mean(length)),
        "shots_per_match": len(shots),
        "goals_per_match": m["home_score"] + m["away_score"],
        "sprints_per_player": float(np.mean(n_spr)),
        "distance_per_player_m": float(np.mean(dist)),
        "max_player_speed_kmh": float(np.nanmax(speed)),
        "max_speed_over_own_top_kmh": float(np.nanmax(over)),
        "max_accel_ms2": float(np.nanmax(acc)),
        "max_ball_speed_kmh": float(np.nanmax(bspeed)),
        "max_ball_height_m": float(np.nanmax(ball[:, 2])),
        "actor_ball_gap_median_m": float(np.median(gap)),
        "actor_ball_gap_p90_m": float(np.percentile(gap, 90)),
    }


ROWS = [  # (metric, calibration key or None, format)
    ("actions_per_team_per_match", "actions_per_team_per_match", "{:.0f}"),
    ("pass_share", "pass_share", "{:.2f}"),
    ("pass_success_rate", "pass_success_rate", "{:.2f}"),
    ("mean_pass_length_m", "mean_pass_length_m", "{:.1f}"),
    ("shots_per_match", "shots_per_match", "{:.1f}"),
    ("goals_per_match", "goals_per_match", "{:.2f}"),
    ("sprints_per_player", "sprints_per_player", "{:.1f}"),
    ("distance_per_player_m", "distance_per_player_m", "{:.0f}"),
    ("max_player_speed_kmh", None, "{:.1f}"),
    ("max_speed_over_own_top_kmh", None, "{:+.2f}"),
    ("max_accel_ms2", "max_accel_ms2", "{:.2f}"),
    ("max_ball_speed_kmh", None, "{:.0f}"),
    ("max_ball_height_m", None, "{:.1f}"),
    ("actor_ball_gap_median_m", None, "{:.1f}"),
    ("actor_ball_gap_p90_m", None, "{:.1f}"),
]


def report(path) -> str:
    cal = load_calibration()
    conn = db.connect(path, readonly=True)
    ms = conn.execute("SELECT * FROM matches ORDER BY match_id").fetchall()
    res = {m["match_id"]: match_metrics(conn, m, cal) for m in ms}
    ids = list(res)
    out = ["# Simulator realism report", "",
           f"Generated by `python -m studiodesk.sim report` ({GENERATOR_VERSION}, {len(ids)} matches). "
           "Calibration values and their sources are in `studiodesk/sim/calibration.json`. "
           "Pass share counts SPADL `pass` and `cross`; pass success and length count `pass` only; sprints and distance are for outfield players who "
           "played the whole match; the actor-ball gap is the distance between the acting player and "
           "the event start point in the tracking frame of the event.", "",
           "| metric | calibration | " + " | ".join(ids) + " | mean |",
           "|---|---|" + "---|" * (len(ids) + 1)]
    for name, key, fmt in ROWS:
        vals = [res[i][name] for i in ids]
        ref = fmt.format(cal[key]["value"]) if key else ""
        if name == "max_accel_ms2":
            ref = "cap " + ref
        out.append(f"| {name} | {ref} | " + " | ".join(fmt.format(v) for v in vals)
                   + f" | {fmt.format(float(np.mean(vals)))} |")
    scores = ", ".join(f"{m['match_id']} {m['home_score']}-{m['away_score']}" for m in ms)
    out += ["", f"Final scores: {scores}.", ""]
    return "\n".join(out)
