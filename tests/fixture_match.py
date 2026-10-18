"""A tiny contract-valid match for tests, written through studiodesk/db.py.

Two teams of 11, two periods of 3 minutes, 10 fps tracking with straight-line movement:
every player jogs across `y` at 1.5 m/s, one forward sprints at 32 km/h for 3 s, the ball is
carried by its owner or flies in a straight line, and the home side scores one goal in period 2
with a shot at 110 km/h. `write_fixture` returns the planted values the tests check.
"""
import math

import numpy as np

from studiodesk import db

MATCH, HOME, AWAY = "M001", "T01", "T02"
FPS, P1, P2 = 10, 180.0, 180.0
SHOT_KMH, SPRINT_KMH, PASS_MS, JOG_MS, JOG_AMP = 110.0, 32.0, 15.0, 1.5, 2.0
SPRINTER, SHOOTER = "T01-9", "T01-11"
HOME_LINE, AWAY_LINE = 25.0, 28.0  # defensive line, metres from own goal
# shirt -> (x, y, position) in period 1 for the home side, attacking x = 105
BASE = {1: (5, 34, "GK"), 2: (25, 10, "DF"), 3: (25, 26, "DF"), 4: (25, 42, "DF"),
        5: (25, 58, "DF"), 6: (45, 12, "MF"), 7: (45, 28, "MF"), 8: (45, 40, "MF"),
        10: (45, 56, "MF"), 9: (60, 30, "FW"), 11: (60, 40, "FW")}
PLAYERS = [f"{t}-{s}" for t in (HOME, AWAY) for s in BASE]


def _p1_spot(pid):
    team, shirt = pid.split("-")
    x, y, _ = BASE[int(shirt)]
    return (x, y) if team == HOME else (105 - x - 3, 68 - y)  # away attacks x = 0 in period 1


def _player_tracks():
    """(frames, 22, 3) positions: jog across y, the sprinter runs along x, period 2 rotated."""
    n1, n = int(P1 * FPS), int((P1 + P2) * FPS)
    out = np.zeros((n, len(PLAYERS), 3))
    for f in range(n):
        period2 = f >= n1
        t = f / FPS - (P1 if period2 else 0)
        u = (JOG_MS * t) % (4 * JOG_AMP)  # triangle wave: straight lines between turns
        jog = u if u <= JOG_AMP else (2 * JOG_AMP - u if u <= 3 * JOG_AMP else u - 4 * JOG_AMP)
        for i, pid in enumerate(PLAYERS):
            x, y = _p1_spot(pid)
            if pid == SPRINTER:
                x += 0 if period2 else SPRINT_KMH / 3.6 * min(max(t - 60, 0), 3)
            else:
                y += jog
            out[f, i, :2] = (105 - x, 68 - y) if period2 else (x, y)
    return out


def write_fixture(path):
    players = _player_tracks()
    pidx = {p: i for i, p in enumerate(PLAYERS)}
    n = len(players)
    ball = np.zeros((n, 3))
    owner = [None] * n
    events = []

    def at(pid, f):
        return players[f, pidx[pid]].copy()

    def hold(pid, f0, f1):
        for f in range(f0, min(f1, n)):
            ball[f], owner[f] = at(pid, f), pid

    def fly(start, end_fn, f0, speed):
        """Straight flight at `speed` m/s from `start`; `end_fn(f)` is the landing point."""
        step = speed / FPS
        steps = max(1, math.ceil(np.linalg.norm(end_fn(f0) - start) / step))
        steps = max(1, math.ceil(np.linalg.norm(end_fn(f0 + steps) - start) / step))  # receiver moved
        end = end_fn(f0 + steps)
        dist = np.linalg.norm(end - start)
        for k in range(steps + 1):
            ball[f0 + k] = start + (end - start) * min(k * step / dist, 1.0)
        return f0 + steps, end

    def event(f, pid, type_name, result, end, related=None):
        ts = f / FPS
        period = 2 if ts >= P1 else 1
        s = ball[f]
        events.append(dict(event_id=len(events) + 1, period=period, t=ts - (P1 if period == 2 else 0),
                           ts=ts, team_id=pid[:3], player_id=pid, type_name=type_name,
                           result_name=result, bodypart_name="foot", start_x=float(s[0]),
                           start_y=float(s[1]), end_x=float(end[0]), end_y=float(end[1]),
                           related_player_id=related))
        return events[-1]["event_id"]

    def chain(f, owner_pid, seq):
        """Each step: hold 2 s, then pass to the next player (fail = an opponent gets it)."""
        ids = []
        for receiver, ok in seq:
            hold(owner_pid, f, f + 2 * FPS)
            f += 2 * FPS
            start = at(owner_pid, f)
            land, end = fly(start, lambda g, r=receiver: at(r, g), f, PASS_MS)
            ids.append(event(f, owner_pid, "pass", "success" if ok else "fail", end,
                             receiver if ok else None))
            f, owner_pid = land, receiver
        return f, owner_pid, ids

    f, last, ids1 = chain(0, "T01-10", [("T01-8", 1), ("T01-4", 1), ("T01-7", 1), ("T01-11", 1),
                                        ("T02-6", 0), ("T02-7", 1), ("T02-10", 1), ("T02-9", 1),
                                        ("T02-11", 1), ("T01-3", 0)])
    hold(last, f, int(P1 * FPS))
    f, last, ids2 = chain(int(P1 * FPS), "T02-10", [("T02-8", 1), ("T01-7", 0), ("T01-10", 1),
                                                    (SHOOTER, 1)])
    hold(last, f, f + 2 * FPS)
    f += 2 * FPS
    goal_xyz = np.array([0.0, 34.0, 1.0])
    shot_f = f
    landed, _ = fly(at(SHOOTER, f), lambda g: goal_xyz, f, SHOT_KMH / 3.6)
    goal_id = event(shot_f, SHOOTER, "shot", "success", goal_xyz)
    ball[landed:landed + 20 * FPS] = goal_xyz  # in the net until the restart
    f, last, ids3 = chain(landed + 20 * FPS, "T02-10", [("T02-8", 1)])
    hold(last, f, n)

    conn = db.connect(path)
    with conn:
        for tid, name, short in ((HOME, "Harbour Town", "HAR"), (AWAY, "Mill Rovers", "MIL")):
            conn.execute("INSERT INTO teams VALUES (?,?,?,?,?,NULL)", (tid, name, short, "#112233", "#ffffff"))
        for pid in PLAYERS:
            shirt = int(pid.split("-")[1])
            conn.execute("INSERT INTO players VALUES (?,?,?,?,?,?)",
                         (pid, pid[:3], f"Player {pid}", shirt, BASE[shirt][2], 33.0))
        conn.execute("INSERT INTO matches VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                     (MATCH, 1, HOME, AWAY, "Test Ground", P1, P2, FPS, 1, 0, "fixture"))
        conn.executemany("INSERT INTO lineups VALUES (?,?,1,0.0,NULL)", [(MATCH, p) for p in PLAYERS])
        conn.executemany("INSERT INTO events VALUES (:m,:event_id,:period,:t,:ts,:team_id,:player_id,"
                         ":type_name,:result_name,:bodypart_name,:start_x,:start_y,:end_x,:end_y,"
                         ":related_player_id)", [dict(e, m=MATCH) for e in events])
        conn.executemany("INSERT INTO tracking_entities VALUES (?,?,?)",
                         [(MATCH, i, e) for i, e in enumerate(["ball", *PLAYERS])])
        pos = np.concatenate([ball[:, None, :], players], axis=1).astype("<f4")
        conn.executemany("INSERT INTO tracking_frames VALUES (?,?,?,?,?)",
                         [(MATCH, f, f / FPS, owner[f], pos[f].tobytes()) for f in range(n)])
    conn.close()
    return dict(path=path, match_id=MATCH, frames=n, entities=len(PLAYERS) + 1, goal_event_id=goal_id,
                forward_p1=ids1[2], forward_p2=ids2[3], shot_kmh=SHOT_KMH, sprint_kmh=SPRINT_KMH,
                sprinter=SPRINTER, home_line=HOME_LINE, away_line=AWAY_LINE)
