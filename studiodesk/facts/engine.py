"""Facts engine: events and tracking of one match -> rows of the fact ledger (docs/CONTRACT.md).

Formulas (all windows are 5 minutes of one period; the last window of a period is shorter):

- pass_difficulty = 10 * (0.35 * min(distance / 40 m, 1)
                         + 0.25 * clip((10 m - mean distance of the 2 nearest opponents
                                        to the passer) / 8 m, 0, 1)
                         + 0.20 * clip(metres gained towards the attacked goal / 30 m, 0, 1)
                         + 0.20 * min(opponents bypassed / 4, 1)).
  Without tracking the pressure and bypass terms are 0.
- press_intensity (team without the ball) = 10 * clip((15 m - d) / 12 m, 0, 1), where d is the
  mean, over the window's frames in which the opponent owns the ball, of the mean distance of
  the 3 nearest pressing players to the carrier: 3 m or closer gives 10, 15 m or more gives 0.
- momentum = 10 * weighted shares of the window, team / (team + opponent), 0.5 when both are 0:
  with an xT grid 0.40 * positive xT added + 0.35 * territory + 0.25 * shots, without one
  0.65 * territory + 0.35 * shots. Territory = share of frames with the ball in the team's
  attacking half (event locations without tracking). The two teams sum to 10.
- line_height = mean over frames of the mean distance from the team's own goal of its 4
  deepest outfield players.
- team_width / team_length = mean over frames of the spread of the team's outfield players across
  (y) and along (x) the pitch.
- formation: the 10 outfield players (on the pitch for at least half of the window) sorted by mean
  distance from their own goal; the two widest gaps split them into three lines, e.g. 4-4-2,
  stored as the value 442. Only when the shape is clear: the second widest gap is at least
  FORMATION_GAP_M and FORMATION_RATIO times the third.
- shot_distance = distance from the shot location to the centre of the goal being attacked. Its label
  adds what the events know: inside or outside the box, the body part and the outcome.
- Sprints: player speed from a 0.5 s centred moving average of the positions, a sprint is
  above 25.2 km/h for at least 1 s; steps above 45 km/h are tracking jumps and are ignored.
"""
import json
import math
from pathlib import Path

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

XT_GRID = Path(__file__).with_name("xt_grid.json")
PASS_TYPES = {"pass", "cross", "throw_in", "freekick_short", "freekick_crossed", "corner_short",
              "corner_crossed", "goalkick"}
SHOT_TYPES = {"shot", "shot_freekick", "shot_penalty"}
MOVE_TYPES = PASS_TYPES | {"dribble"}
LENGTH, WIDTH = 105.0, 68.0
LINE_MARGIN = 0.5  # metres from a goal line at which a goal's ball counts as in
WINDOW_S = 300.0
SPRINT_KMH = 25.2
SMOOTH = 5
RELEASE_FRAMES = 5  # ball speed is read in the first half second after the kick
MAX_PLAYER_KMH = 45.0
MAX_BALL_KMH = 220.0  # faster steps are restarts (ball put back on the spot), not kicks
FORMATION_GAP_M = 6.0
FORMATION_RATIO = 1.5


def half_up(v):
    """The whole number a viewer reads for a stored value: 113.5 is 114, as the phrasebook says it."""
    return math.floor(v + 0.5)


def clip01(v):
    return min(max(v, 0.0), 1.0)


def is_goal(e):
    return (e["type_name"] in SHOT_TYPES and e["result_name"] == "success") or e["result_name"] == "owngoal"


GOAL_Y = (WIDTH / 2 - 3.66, WIDTH / 2 + 3.66)  # the posts
BOX_DEPTH, BOX_HALF_WIDTH = 16.5, 20.16
BODY = {"head": "header", "foot": "foot", "foot_left": "left foot", "foot_right": "right foot"}


def shot_outcome(shot, saves=()):
    """goal, saved (a keeper_save answers it within 5 s), wide or over (it reached the goal line outside
    or between the posts), or blocked (it stopped short)."""
    if is_goal(shot):
        return "goal"
    if any(s.get("related_player_id") == shot["player_id"] and 0 <= s["ts"] - shot["ts"] <= 5 for s in saves):
        return "saved"
    line = LENGTH if shot["end_x"] > LENGTH / 2 else 0.0
    if abs(shot["end_x"] - line) < 0.05:
        return "over" if GOAL_Y[0] <= shot["end_y"] <= GOAL_Y[1] else "wide"
    return "blocked"


def shot_detail(shot, sign, saves=()):
    """What the events know about a shot, as words for its shot_distance label: inside or outside the
    box (from the start position and the attack direction), the body part, the outcome."""
    depth = LENGTH - shot["start_x"] if sign > 0 else shot["start_x"]
    box = "inside the box" if depth <= BOX_DEPTH and abs(shot["start_y"] - WIDTH / 2) <= BOX_HALF_WIDTH \
        else "outside the box"
    body = BODY.get(shot.get("bodypart_name"))
    return ", ".join(w for w in (box, body, shot_outcome(shot, saves)) if w)


def window_label(a, b, period, p1):
    """"min 66-70" for a window from a to b (seconds), minutes as the clock shows them: "min 42-45+1"
    across the end of the first half, "first-half stoppage time" for a window wholly after 45'.
    Rounded first: windows() steps by adding floats, and 1499.99999 s would read as minute 70, not 71."""
    off, cap = (0.0 if period == 1 else p1), 45 * period
    first = int(round(a - off, 6) // 60) + 1 + cap - 45
    last = math.ceil(round(b - off, 6) / 60) + cap - 45
    if first > cap:
        return ("first" if period == 1 else "second") + "-half stoppage time"
    return "min " + "-".join(f"{cap}+{x - cap}" if x > cap else str(x) for x in (first, last))


class Match:
    def __init__(self, conn, match_id, xt_grid=XT_GRID):
        m = conn.execute("SELECT * FROM matches WHERE match_id = ?", (match_id,)).fetchone()
        if m is None:
            raise ValueError(f"unknown match {match_id}")
        self.id, self.home, self.away = match_id, m["home_team_id"], m["away_team_id"]
        self.p1, self.end, self.fps = m["period1_s"], m["period1_s"] + m["period2_s"], m["fps"]
        self.events = [dict(r) for r in conn.execute(
            "SELECT * FROM events WHERE match_id = ? ORDER BY ts, event_id", (match_id,))]
        rows = conn.execute("SELECT player_id, team_id, position FROM players WHERE team_id IN (?, ?)",
                            (self.home, self.away)).fetchall()
        self.team_of = {r["player_id"]: r["team_id"] for r in rows}
        self.gk = {r["player_id"] for r in rows if r["position"] == "GK"}
        self.lineups = {r["player_id"]: (r["on_ts"], r["off_ts"]) for r in conn.execute(
            "SELECT player_id, on_ts, off_ts FROM lineups WHERE match_id = ?", (match_id,))}
        self.grid = None
        if xt_grid and Path(xt_grid).exists():
            self.grid = np.array(json.loads(Path(xt_grid).read_text())["grid"], dtype=float)
        self.entities = [r[0] for r in conn.execute(
            "SELECT entity FROM tracking_entities WHERE match_id = ? ORDER BY idx", (match_id,))]
        frames = conn.execute("SELECT frame, ball_owner, pos FROM tracking_frames WHERE match_id = ? "
                              "ORDER BY frame", (match_id,)).fetchall()
        self.pos = None
        if frames and self.entities:
            n = frames[-1][0] + 1
            self.pos = np.full((n, len(self.entities), 3), np.nan, dtype=np.float32)
            self.owner = np.full(n, -1)
            idx = {e: i for i, e in enumerate(self.entities)}
            for f, o, blob in frames:
                self.pos[f] = np.frombuffer(blob, "<f4").reshape(-1, 3)
                self.owner[f] = idx.get(o, -1)
            self.cols = {t: np.array([i for i, e in enumerate(self.entities) if self.team_of.get(e) == t], dtype=int)
                         for t in (self.home, self.away)}
        self.facts = []

    # geometry and time -----------------------------------------------------
    def sign(self, team, period):
        """+1 when `team` attacks towards x = 105 in `period` (home in period 1), else -1."""
        return 1 if (team == self.home) == (period == 1) else -1

    def period_of(self, ts):
        return 1 if ts < self.p1 else 2

    def frame(self, ts):
        return min(max(round(ts * self.fps), 0), len(self.pos) - 1)

    def other(self, team):
        return self.away if team == self.home else self.home

    def windows(self):
        out = []
        for period, a, b in ((1, 0.0, self.p1), (2, self.p1, self.end)):
            s = a
            while s < b - 1e-9:
                out.append((period, s, min(s + WINDOW_S, b), b))
                s += WINDOW_S
        return out

    def add(self, kind, ts, value, unit, label, team=None, player=None, events=(), frames=None, period=None):
        """`period` is needed for facts at a period end: ts = period1_s alone would read as period 2."""
        if not math.isfinite(value):
            return
        if frames is not None:  # a fact is known only once its last measured frame has happened
            ts = max(ts, frames[1] / self.fps)
        self.facts.append(dict(kind=kind, ts=float(ts), period=period or self.period_of(ts), team_id=team,
                               player_id=player, value=float(value), unit=unit, label_en=label,
                               source_event_ids=[int(e) for e in events],
                               source_frames=None if frames is None else [int(frames[0]), int(frames[1])]))

    # facts -------------------------------------------------------------------
    def build(self):
        self.passes_and_shots()
        self.pass_accuracy()
        self.score()
        if self.pos is not None:
            self.sprints_and_distance()
        self.windows_facts()
        self.facts.sort(key=lambda f: (f["ts"], f["kind"], f["team_id"] or "", f["player_id"] or ""))
        counters = {}
        for f in self.facts:
            counters[f["kind"]] = counters.get(f["kind"], 0) + 1
            f["fact_id"] = f"F-{f['kind'].upper()}-{counters[f['kind']]:06d}"
        return self.facts

    def peak_ball_kmh(self, f0, f1):
        b = self.pos[f0:f1 + 1, 0, :2].astype(float)  # horizontal: a lob's climb is not its speed
        v = np.linalg.norm(np.diff(b, axis=0), axis=1) * self.fps * 3.6
        v = v[np.isfinite(v) & (v <= MAX_BALL_KMH)]
        return float(v.max()) if len(v) else math.nan

    def xt(self, x, y, sign):
        if sign < 0:
            x, y = LENGTH - x, WIDTH - y
        rows, cols = self.grid.shape
        return self.grid[min(max(int(y / WIDTH * rows), 0), rows - 1), min(max(int(x / LENGTH * cols), 0), cols - 1)]

    def passes_and_shots(self):
        for i, e in enumerate(self.events):
            kind = e["type_name"]
            if kind not in PASS_TYPES | SHOT_TYPES | MOVE_TYPES:
                continue
            eid, ts, team, pid = e["event_id"], e["ts"], e["team_id"], e["player_id"]
            sign = self.sign(team, e["period"])
            nxt = self.events[i + 1]["ts"] if i + 1 < len(self.events) else ts + 5
            f0 = self.frame(ts) if self.pos is not None else None
            if self.grid is not None and kind in MOVE_TYPES and e["result_name"] == "success":
                v = self.xt(e["end_x"], e["end_y"], sign) - self.xt(e["start_x"], e["start_y"], sign)
                self.add("xt_added", ts, round(v, 4), "xT", f"xT {v:+.3f}", team, pid, [eid])
            if kind in SHOT_TYPES:
                d = round(math.hypot(e["start_x"] - (LENGTH if sign > 0 else 0.0), e["start_y"] - WIDTH / 2), 1)
                detail = shot_detail(e, sign, self.saves_after(i))
                self.add("shot_distance", ts, d, "m", f"Shot from {half_up(d)} m, {detail}", team, pid, [eid])
            if kind in SHOT_TYPES and f0 is not None:
                f1 = min(self.frame(nxt), f0 + RELEASE_FRAMES)
                v = round(self.peak_ball_kmh(f0, f1), 1)
                self.add("shot_speed", ts, v, "km/h", f"Shot at {half_up(v)} km/h", team, pid, [eid], (f0, f1))
            if kind not in PASS_TYPES:
                continue
            dist = math.hypot(e["end_x"] - e["start_x"], e["end_y"] - e["start_y"])
            self.add("pass_distance", ts, round(dist, 1), "m", f"Pass of {dist:.0f} m", team, pid, [eid])
            gain = (e["end_x"] - e["start_x"]) * sign
            pressure = bypass = 0.0
            frames = None
            if f0 is not None:
                f1 = min(self.frame(nxt), f0 + RELEASE_FRAMES)
                v = self.peak_ball_kmh(f0, f1)
                self.add("ball_speed", ts, round(v, 1), "km/h", f"Pass at {v:.0f} km/h", team, pid, [eid], (f0, f1))
                pressure, bypass = self.pressure_and_bypass(e, f0, sign)
                frames = (f0, f0)
            score = 10 * (0.35 * min(dist / 40, 1) + 0.25 * pressure + 0.2 * clip01(gain / 30) + 0.2 * bypass)
            self.add("pass_difficulty", ts, round(score, 1), "/10", f"Pass difficulty {score:.1f}/10",
                     team, pid, [eid], frames)

    def saves_after(self, i):
        out = []
        for e in self.events[i + 1:]:
            if e["ts"] - self.events[i]["ts"] > 5:
                break
            if e["type_name"] == "keeper_save":
                out.append(e)
        return out

    def pressure_and_bypass(self, e, f, sign):
        opp = self.cols.get(self.other(e["team_id"]), np.array([], int))
        if not len(opp):
            return 0.0, 0.0
        here = self.pos[f]
        me = self.entities.index(e["player_id"]) if e["player_id"] in self.entities else None
        start = here[me, :2] if me is not None and np.isfinite(here[me, 0]) else np.array([e["start_x"], e["start_y"]])
        d = np.sort(np.linalg.norm(here[opp, :2] - start, axis=1))
        d = d[np.isfinite(d)][:2]
        pressure = clip01((10 - d.mean()) / 8) if len(d) else 0.0
        ox = here[[i for i in opp if self.entities[i] not in self.gk], 0]
        a, b = e["start_x"] * sign, e["end_x"] * sign
        bypassed = int(np.sum((ox * sign > a) & (ox * sign < b)))
        return pressure, min(bypassed / 4, 1.0)

    def pass_accuracy(self):
        for period, cp, when in ((1, self.p1, "at half-time"), (2, self.end, "at full time")):
            passes = [e for e in self.events if e["type_name"] in PASS_TYPES and e["period"] <= period]
            groups = {}
            for e in passes:
                groups.setdefault((e["team_id"], None), []).append(e)
                groups.setdefault((e["team_id"], e["player_id"]), []).append(e)
            for (team, pid), es in groups.items():
                ok = sum(e["result_name"] == "success" for e in es)
                pct = 100 * ok / len(es)
                self.add("pass_accuracy", cp, round(pct, 1), "%", f"Pass accuracy {pct:.0f}% ({ok}/{len(es)}) {when}",
                         team, pid, [e["event_id"] for e in es], period=period)

    def score(self):
        goals = {self.home: 0, self.away: 0}
        for e in self.events:
            if not is_goal(e):
                continue
            team = e["team_id"] if e["result_name"] != "owngoal" else self.other(e["team_id"])
            goals[team] += 1
            f = self.line_frame(e["ts"]) if self.pos is not None else None
            self.add("score", e["ts"], goals[team], "goal", f"Goal {goals[self.home]}-{goals[self.away]}",
                     team, e["player_id"], [e["event_id"]], frames=None if f is None else (f, f))

    def line_frame(self, ts):
        """First frame in the 3 s after a goal kick with the ball at a goal line, or None: the goal
        is known when the ball is in, not when it is struck. The simulated ball stops in the net
        about 0.2 m short of the line, hence the margin."""
        f0 = self.frame(ts)
        x = self.pos[f0:f0 + 3 * self.fps + 1, 0, 0].astype(float)
        hit = np.flatnonzero((x <= LINE_MARGIN) | (x >= LENGTH - LINE_MARGIN))
        return f0 + int(hit[0]) if len(hit) else None

    def player_speeds(self):
        """Smoothed speed (km/h) per frame and entity; NaN at gaps, jumps and the half-time switch."""
        n = len(self.pos)
        speed = np.full((n, len(self.entities)), np.nan)
        cut = self.frame(self.p1) if self.p1 * self.fps < n else n
        for a, b in ((0, cut), (cut, n)):
            seg = self.pos[a:b, :, :2].astype(float)
            if len(seg) <= SMOOTH:
                continue
            sm = sliding_window_view(seg, SMOOTH, axis=0).mean(axis=-1)
            v = np.linalg.norm(np.diff(sm, axis=0), axis=-1) * self.fps * 3.6
            v[v > MAX_PLAYER_KMH] = np.nan
            off = a + SMOOTH // 2 + 1  # v[i] is the step ending at the centre of window i + 1
            speed[off:off + len(v)] = v
        speed[:, 0] = np.nan  # idx 0 is the ball
        return speed

    def events_between(self, a, b):
        return [e["event_id"] for e in self.events if a <= e["ts"] <= b]

    def on_pitch(self, pid, ts):
        return self.lineups.get(pid, (math.inf, None))[0] < ts

    def sprints_and_distance(self):
        speed = self.player_speeds()
        checkpoints = ((1, self.p1, "by half-time"), (2, self.end, "in the match"))
        for i, pid in enumerate(self.entities):
            if i == 0 or pid not in self.team_of:
                continue
            team, v = self.team_of[pid], speed[:, i]
            fast = np.concatenate(([0], (np.nan_to_num(v) > SPRINT_KMH).astype(np.int8), [0]))
            edges = np.diff(fast)
            ends = []
            for s, t in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
                if t - s < self.fps:
                    continue
                peak = float(np.max(v[s:t]))
                end_ts = float(t - 1) / self.fps
                ends.append(end_ts)
                self.add("sprint_speed", end_ts, round(peak, 1), "km/h", f"Sprint at {peak:.1f} km/h", team, pid,
                         self.events_between(s / self.fps, end_ts), (s, min(t - 1 + SMOOTH // 2, len(v) - 1)))
            step_m = np.nan_to_num(v) / 3.6 / self.fps
            for period, cp, when in checkpoints:
                if not self.on_pitch(pid, cp):
                    continue
                f = self.frame(cp)
                count = int(sum(t <= cp for t in ends))
                self.add("sprint_count", cp, count, "sprints", f"{count} sprint{'s' * (count != 1)} {when}",
                         team, pid, frames=(0, f), period=period)
                m = float(step_m[:f + 1].sum())
                self.add("distance_covered", cp, round(m, 1), "m", f"{m / 1000:.1f} km covered {when}",
                         team, pid, frames=(0, f), period=period)

    def windows_facts(self):
        for n, (period, a, b, period_end) in enumerate(self.windows(), 1):
            evs = [e for e in self.events if e["period"] == period and a <= e["ts"] and (e["ts"] < b or b == period_end)]
            ids = [e["event_id"] for e in evs]
            mins = window_label(a, b, period, self.p1)
            frames = None
            if self.pos is not None:
                fa, fb = self.frame(a), max(self.frame(b) - 1, self.frame(a))
                frames = (fa, fb)
            self.momentum(period, b, evs, ids, frames, mins)
            if frames is None:
                continue
            sl = slice(frames[0], frames[1] + 1)
            for team in (self.home, self.away):
                self.press(team, period, sl, b, ids, frames, mins)
                self.line(team, period, sl, b, ids, frames, mins)
                self.shape(team, period, sl, b, ids, frames, mins)

    def momentum(self, period, ts, evs, ids, frames, mins):
        def share(h, a):
            return 0.5 if h + a == 0 else h / (h + a)

        shots = {t: sum(e["team_id"] == t and e["type_name"] in SHOT_TYPES for e in evs) for t in (self.home, self.away)}
        sh = self.sign(self.home, period)
        if frames is not None:
            bx = self.pos[frames[0]:frames[1] + 1, 0, 0].astype(float)
            bx = bx[np.isfinite(bx)]
            terr_home = float(np.mean((bx - LENGTH / 2) * sh > 0)) if len(bx) else 0.5
        else:
            xs = [e["start_x"] for e in evs]
            terr_home = float(np.mean([(x - LENGTH / 2) * sh > 0 for x in xs])) if xs else 0.5
        parts = [(0.35 if self.grid is not None else 0.65, terr_home),
                 (0.25 if self.grid is not None else 0.35, share(shots[self.home], shots[self.away]))]
        if self.grid is not None:
            xt = {t: 0.0 for t in (self.home, self.away)}
            for e in evs:
                if e["type_name"] in MOVE_TYPES and e["result_name"] == "success":
                    s = self.sign(e["team_id"], period)
                    xt[e["team_id"]] += max(0.0, self.xt(e["end_x"], e["end_y"], s) - self.xt(e["start_x"], e["start_y"], s))
            parts.append((0.40, share(xt[self.home], xt[self.away])))
        home = 10 * sum(w * v for w, v in parts)
        for team, v in ((self.home, home), (self.away, 10 - home)):
            self.add("momentum", ts, round(v, 1), "/10", f"Momentum {v:.1f}/10, {mins}", team, None, ids, frames, period)

    def press(self, team, period, sl, ts, ids, frames, mins):
        """Mean distance of the 3 nearest `team` players to the opposing carrier -> 0..10."""
        own, opp = self.cols[team], self.cols[self.other(team)]
        owner = self.owner[sl]
        mask = np.isin(owner, opp)
        if not mask.any() or not len(own):
            return
        pos = self.pos[sl][mask].astype(float)
        carrier = pos[np.arange(len(pos)), owner[mask], :2]
        d = np.sort(np.linalg.norm(pos[:, own, :2] - carrier[:, None], axis=-1), axis=1)[:, :3]
        per_frame = np.nanmean(d, axis=1) if d.size else np.array([])
        per_frame = per_frame[np.isfinite(per_frame)]
        if not len(per_frame):
            return
        mean_d = float(per_frame.mean())
        v = 10 * clip01((15 - mean_d) / 12)
        self.add("press_intensity", ts, round(v, 1), "/10",
                 f"Press intensity {v:.1f}/10 ({mean_d:.1f} m to the carrier), {mins}", team, None, ids, frames, period)

    def line(self, team, period, sl, ts, ids, frames, mins):
        cols = [i for i in self.cols[team] if self.entities[i] not in self.gk]
        if not cols:
            return
        x = self.pos[sl][:, cols, 0].astype(float)
        dist = x if self.sign(team, period) > 0 else LENGTH - x
        dist = np.sort(dist, axis=1)[:, :4]  # NaN (off the pitch) sorts last
        ok = np.isfinite(dist).any(axis=1)
        if not ok.any():
            return
        v = float(np.nanmean(dist[ok], axis=1).mean())
        self.add("line_height", ts, round(v, 1), "m", f"Defensive line {v:.1f} m from goal, {mins}",
                 team, None, ids, frames, period)


    def shape(self, team, period, sl, ts, ids, frames, mins):
        """team_width, team_length and, when the lines are clear, formation (module docstring)."""
        cols = [i for i in self.cols[team] if self.entities[i] not in self.gk]
        if not cols:
            return
        x, y = (self.pos[sl][:, cols, k].astype(float) for k in (0, 1))
        depth = x if self.sign(team, period) > 0 else LENGTH - x
        on = np.isfinite(depth).sum(axis=1) >= 2
        if not on.any():
            return
        w = float(np.mean(np.nanmax(y[on], axis=1) - np.nanmin(y[on], axis=1)))
        n = float(np.mean(np.nanmax(depth[on], axis=1) - np.nanmin(depth[on], axis=1)))
        self.add("team_width", ts, round(w, 1), "m", f"Team width {w:.1f} m, {mins}", team, None, ids, frames, period)
        self.add("team_length", ts, round(n, 1), "m", f"Team length {n:.1f} m, {mins}", team, None, ids, frames, period)
        keep = np.isfinite(depth).mean(axis=0) >= 0.5
        if keep.sum() != 10:
            return
        d = np.sort(np.nanmean(depth[:, keep], axis=0))
        gaps = np.diff(d)
        g = np.sort(gaps)[::-1]
        if g[1] < FORMATION_GAP_M or g[1] < FORMATION_RATIO * g[2]:
            return
        a, b = sorted(np.argsort(gaps)[::-1][:2])
        lines = (a + 1, b - a, 9 - b)
        name = "-".join(map(str, lines))
        self.add("formation", ts, float("".join(map(str, lines))), "formation", f"Formation {name}, {mins}",
                 team, None, ids, frames, period)


def formation_name(value):
    """442.0 -> "4-4-2" (the formation fact's value is its lines as digits)."""
    return "-".join(str(int(value)))


def compute(conn, match_id, xt_grid=XT_GRID):
    return Match(conn, match_id, xt_grid).build()


COLUMNS = ("match_id", "fact_id", "kind", "ts", "period", "team_id", "player_id", "value", "unit",
           "label_en", "source_event_ids", "source_frames")


def build(conn, match_id, xt_grid=XT_GRID):
    """Delete and rewrite the facts of `match_id`; returns how many were written."""
    facts = compute(conn, match_id, xt_grid)
    rows = [(match_id, f["fact_id"], f["kind"], f["ts"], f["period"], f["team_id"], f["player_id"], f["value"],
             f["unit"], f["label_en"], json.dumps(f["source_event_ids"]),
             None if f["source_frames"] is None else json.dumps(f["source_frames"])) for f in facts]
    with conn:
        conn.execute("DELETE FROM facts WHERE match_id = ?", (match_id,))
        conn.executemany(f"INSERT INTO facts ({', '.join(COLUMNS)}) VALUES ({', '.join('?' * len(COLUMNS))})", rows)
    return len(rows)
