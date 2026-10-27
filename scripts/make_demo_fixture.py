"""Write web/data/DEMO/: a small invented match in the replay export shapes of docs/CONTRACT.md.

The web page and its tests run on this fixture without the simulated matches or a model run.
Two 3-minute periods at 10 fps, a 4-4-2 each side, passes, a goal for each team, a saved shot and
a cue sheet that uses all four graphics for the analyst and casual audiences, plus team, player and kids cues. Every number in a cue is the value of
a fact it cites; the recaps come from studiodesk/export.py. Stories, their why cards in en, it and
es, and the agent traces come from scripts/demo_stories.py.

    .venv/bin/python scripts/make_demo_fixture.py [out_dir]
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from studiodesk.agents import audiences  # noqa: E402
from studiodesk import forecast  # noqa: E402
from studiodesk.export import recap  # noqa: E402
from studiodesk.names import find_forbidden  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import demo_stories  # noqa: E402


def sheet(cues, audience, lang):
    """The cues web/js/desk.js plays when every story is on air: the language's own cues, plus the
    English template cues (story_id null) when that language has no template cues of its own."""
    mine = [c for c in cues if c["audience"] == audience]
    own = [c for c in mine if c["lang"] == lang]
    if lang != "en" and not any(c["story_id"] is None for c in own):
        own += [c for c in mine if c["lang"] == "en" and c["story_id"] is None]
    return own

MATCH = "DEMO"
FPS = 10
P1_S = P2_S = 180.0
FRAMES = int((P1_S + P2_S) * FPS)
RNG = np.random.default_rng(7)

TEAMS = [
    {"team_id": "T01", "name": "Northbrook Rovers", "short_name": "NBR", "color_primary": "#D7263D",
     "color_secondary": "#FFFFFF", "crest_svg": None, "side": "home"},
    {"team_id": "T02", "name": "Eastvale Athletic", "short_name": "EVA", "color_primary": "#F2C14E",
     "color_secondary": "#14213D", "crest_svg": None, "side": "away"},
]
VENUE = "Saltmarsh Park"
FIRST = ["Ren", "Tobin", "Arlo", "Caspian", "Dario", "Emrys", "Fenn", "Gideon", "Hollis", "Ivo",
         "Jory", "Kael", "Lorcan", "Milo", "Nils", "Osric", "Pim", "Quill", "Rafe", "Soren", "Tamsin",
         "Ulric", "Vane", "Wren", "Yannick", "Zeb", "Alder", "Brannoc", "Corwin", "Desmond", "Elio",
         "Faro", "Gael", "Hale", "Isko", "Jarek"]
LAST = ["Halloway", "Orvanelli", "Okonkwo-Bell", "Strand", "Pellow", "Varga", "Lindqvist", "Ashdown",
        "Corvel", "Tamberlin", "Quayle", "Rosmund", "Fairweather", "Ibarrola", "Kessling", "Dunmore",
        "Petrakis", "Wexford", "Saltire", "Brightwater", "Nakamura-Fox", "Oduya", "Teague", "Morrow",
        "Vellacott", "Harrowgate", "Esterly", "Grieve", "Lannon", "Merriweather", "Pocklington",
        "Rusk", "Sallow", "Thorne", "Underhill", "Yarrow"]
# 4-4-2 for a team attacking towards x = 105; slot i is shirt i + 1. Bench: 12 GK, 13-14 DF, ...
BASE = [(5, 34), (24, 10), (21, 26), (21, 42), (24, 58), (44, 10), (41, 27), (41, 41), (44, 58),
        (60, 29), (60, 40)]
POS = ["GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "MF", "FW", "FW",
       "GK", "DF", "DF", "MF", "MF", "FW", "FW"]
SUB_OFF, SUB_ON = "T02-9", "T02-15"  # half-time substitution, slot of shirt 9
# Scripted shots: (period, t, team index, result). Everything else is random passing.
SHOTS = [(1, 100.0, 0, "success"), (2, 60.0, 1, "fail"), (2, 130.0, 1, "success")]


def attack_dir(team: int, period: int) -> int:
    """+1 when the team attacks towards x = 105 (home in period 1)."""
    return 1 if (team == 0) == (period == 1) else -1


def to_abs(x, y, d):
    return (x, y) if d > 0 else (105 - x, 68 - y)


def build_people():
    players, k = [], 0
    for ti, team in enumerate(TEAMS):
        for shirt in range(1, 19):
            players.append({"player_id": f"{team['team_id']}-{shirt}", "team_id": team["team_id"],
                            "name": f"{FIRST[k]} {LAST[(k * 7) % len(LAST)]}", "shirt": shirt,
                            "position": POS[shirt - 1]})
            k += 1
    lineups = []
    for p in players:
        if p["shirt"] <= 11:
            lineups.append({"player_id": p["player_id"], "starter": 1, "on_ts": 0.0,
                            "off_ts": P1_S if p["player_id"] == SUB_OFF else None})
    lineups.append({"player_id": SUB_ON, "starter": 0, "on_ts": P1_S, "off_ts": None})
    return players, lineups


class Sim:
    def __init__(self, players):
        self.ids = [p["player_id"] for p in players]
        self.n = len(self.ids)
        self.team = np.array([0 if i.startswith("T01") else 1 for i in self.ids])
        self.slot = np.array([int(i.split("-")[1]) - 1 for i in self.ids])
        self.phase = RNG.uniform(0, 2 * math.pi, (self.n, 2))
        self.freq = RNG.uniform(0.15, 0.35, (self.n, 2))
        self.pos = np.full((self.n, 2), np.nan)
        self.events, self.out = [], np.full((FRAMES, 1 + self.n, 3), np.nan, dtype="<f4")
        self.owner_frames = np.full(FRAMES, -1)
        self.shot_info = []  # (event index, flight metres, flight seconds)

    def on_pitch(self, period):
        on = []
        for i, pid in enumerate(self.ids):
            shirt = self.slot[i] + 1
            starter = shirt <= 11
            if pid == SUB_OFF:
                on.append(period == 1)
            elif pid == SUB_ON:
                on.append(period == 2)
            else:
                on.append(starter)
        return np.array(on)

    def formation_slot(self, i):
        # bench players off the pitch stay NaN; their slot only has to exist
        return 8 if self.ids[i] == SUB_ON else self.slot[i] % 11

    def targets(self, period, t, ball, poss, dead):
        tg = np.zeros((self.n, 2))
        for i in range(self.n):
            d = attack_dir(self.team[i], period)
            bx, by = (52.5, 34.0) if dead else ball
            nx, ny = BASE[self.formation_slot(i)]
            shift_x = (bx - 52.5) * d * 0.55 + (6 if poss == self.team[i] else -4)
            shift_y = (by - 34) * 0.35
            if self.formation_slot(i) == 0:
                shift_x, shift_y = shift_x * 0.12, shift_y * 0.15
            wob = 1.6 * np.sin(self.freq[i] * t + self.phase[i])
            x, y = to_abs(nx + shift_x + wob[0], ny + d * shift_y + wob[1], d)
            tg[i] = (x, y)
        return np.clip(tg, [1, 1], [104, 67])

    def step(self, tg, vmax, dt):
        delta = tg - self.pos
        dist = np.linalg.norm(delta, axis=1, keepdims=True)
        speed = np.minimum(dist * 1.6, vmax[:, None])
        self.pos += np.where(dist > 1e-6, delta / np.maximum(dist, 1e-6) * speed * dt, 0)

    def add_event(self, period, t, ts, i, type_name, result, start, end, related=None):
        self.events.append({"match_id": MATCH, "event_id": len(self.events) + 1, "period": period,
                            "t": round(t, 2), "ts": round(ts, 2), "team_id": TEAMS[self.team[i]]["team_id"],
                            "player_id": self.ids[i], "type_name": type_name, "result_name": result,
                            "bodypart_name": "foot", "start_x": round(float(start[0]), 2),
                            "start_y": round(float(start[1]), 2), "end_x": round(float(end[0]), 2),
                            "end_y": round(float(end[1]), 2),
                            "related_player_id": self.ids[related] if related is not None else None})

    def run_period(self, period, kickoff_team):
        on = self.on_pitch(period)
        dt = 1 / FPS
        f0 = 0 if period == 1 else int(P1_S * FPS)
        nframes = int((P1_S if period == 1 else P2_S) * FPS)
        for i in range(self.n):
            if on[i]:
                d = attack_dir(self.team[i], period)
                nx, ny = BASE[self.formation_slot(i)]
                self.pos[i] = to_abs(min(nx, 50), ny, d)
            else:
                self.pos[i] = np.nan
        fw = lambda team, shirt=10: self.ids.index(f"{TEAMS[team]['team_id']}-{shirt}")  # noqa: E731
        owner, ball, z = fw(kickoff_team), np.array([52.5, 34.0]), 0.0
        fly = None  # (start, end, t0, dur, receiver, peak, kind)
        hold, dead_until, sprinter, sprint_goal = 1.0, -1.0, None, None
        shots = [s for s in SHOTS if s[0] == period]
        for k in range(nframes):
            t = k * dt
            ts = (f0 + k) / FPS
            poss = self.team[owner] if owner is not None else (self.team[fly[4]] if fly and fly[4] is not None else -1)
            dead = t < dead_until
            tg = self.targets(period, t, ball, poss, dead)
            vmax = np.full(self.n, 7.0)
            if owner is not None and not dead:
                d = attack_dir(self.team[owner], period)
                tg[owner] = np.clip(self.pos[owner] + (d * 4, 0), 1, 104)
                vmax[owner] = 5.0
            if fly and fly[4] is not None:
                tg[fly[4]] = fly[1]
            if sprinter is not None:
                tg[sprinter], vmax[sprinter] = sprint_goal, 9.4
            # scripted shot sequence: tackle at -6 s, through ball at -4.5 s, shot at 0
            for (p, ts_shot, team, result) in shots:
                if abs(t - (ts_shot - 6)) < dt / 2:
                    if owner is None or self.team[owner] != team:
                        cand = [i for i in range(self.n) if on[i] and self.team[i] == team]
                        j = min(cand, key=lambda i: np.linalg.norm(self.pos[i] - ball))
                        if owner is not None:
                            self.add_event(period, t, ts, j, "tackle", "success", self.pos[j], ball, owner)
                        owner, fly = j, None
                    hold = 10  # keep the ball until the through ball
                if abs(t - (ts_shot - 4.5)) < dt / 2:
                    d = attack_dir(team, period)
                    sprinter = fw(team)
                    sprint_goal = np.array(to_abs(84, 30, d), dtype=float)
                    if owner is not None and owner != sprinter:
                        start = ball.copy()
                        end = np.array(to_abs(80, 31, d), dtype=float)
                        self.add_event(period, t, ts, owner, "pass", "success", start, end, sprinter)
                        fly = (start, end, t, 2.6, sprinter, 2.5, "pass")
                        owner = None
                if abs(t - ts_shot) < dt / 2:
                    shooter = sprinter
                    d = attack_dir(team, period)
                    start = self.pos[shooter].copy()
                    goal = np.array(to_abs(105.6, 36.2, d) if result == "success" else to_abs(103.2, 33.5, d), dtype=float)
                    dur = 0.75 if result == "success" else 0.85
                    self.add_event(period, t, ts, shooter, "shot", result, start, goal)
                    self.shot_info.append((len(self.events) - 1, float(np.linalg.norm(goal - start)), dur))
                    gk = fw(1 - team, 1)
                    fly = (start, goal, t, dur, None if result == "success" else gk, 1.6, "shot")
                    owner, sprinter = None, None
                    if result == "success":
                        dead_until, kickoff_team = t + dur + 5, 1 - team
            # ball
            if fly:
                start, end, t0, dur, rec, peak, kind = fly
                u = min(1.0, (t - t0) / dur)
                ball = start + (end - start) * u
                z = 4 * peak * u * (1 - u)
                if u >= 1:
                    fly, z = None, 0.0
                    if rec is not None:
                        owner, hold = rec, (10 if rec == sprinter else RNG.uniform(0.8, 2.2))
            elif owner is not None:
                d = attack_dir(self.team[owner], period)
                ball = ball + (self.pos[owner] + (d * 0.7, 0.3) - ball) * 0.5
                z = 0.0
                hold -= dt
                if hold <= 0 and not dead:
                    fly = self.choose_pass(period, t, ts, owner, ball, on)
                    owner = None
            elif t >= dead_until and dead_until > 0:
                ball, owner, hold, dead_until = np.array([52.5, 34.0]), fw(kickoff_team), 1.2, -1.0
            if owner is not None:
                self.owner_frames[f0 + k] = owner
            if fly and fly[4] is not None:
                self.owner_frames[f0 + k] = -2 - self.team[fly[4]]  # in flight to a team
            self.step(tg, vmax, dt)
            self.out[f0 + k, 0] = (ball[0], ball[1], z)
            self.out[f0 + k, 1:, :2] = self.pos
            self.out[f0 + k, 1:, 2] = np.where(np.isnan(self.pos[:, 0]), np.nan, 0)

    def choose_pass(self, period, t, ts, owner, ball, on):
        d = attack_dir(self.team[owner], period)
        mates = [i for i in range(self.n) if on[i] and self.team[i] == self.team[owner] and i != owner]
        def score(i):
            v = self.pos[i] - self.pos[owner]
            dist = np.linalg.norm(v)
            return v[0] * d * 0.06 - abs(dist - 17) * 0.06 + RNG.normal(0, 0.5) - (5 if dist < 5 or dist > 42 else 0)
        rec = max(mates, key=score)
        end = self.pos[rec].copy()
        dist = float(np.linalg.norm(end - ball))
        result = "success"
        if RNG.random() < 0.13:
            opp = [i for i in range(self.n) if on[i] and self.team[i] != self.team[owner]]
            rec = min(opp, key=lambda i: np.linalg.norm(self.pos[i] - (ball + end) / 2))
            end, result = (ball + end) / 2 + RNG.normal(0, 1, 2), "fail"
            dist = float(np.linalg.norm(end - ball))
        self.add_event(period, t, ts, owner, "pass", result, ball, end, rec if result == "success" else None)
        return (ball.copy(), end, t, max(0.5, dist / 15), rec, 3.0 if dist > 28 else 0.15, "pass")


def speeds_kmh(out):
    """Per-frame speed of every player, smoothed over 1 s; NaN when off the pitch."""
    p = out[:, 1:, :2].astype(float)
    v = np.linalg.norm(np.diff(p, axis=0), axis=2) * FPS * 3.6
    v = np.vstack([v[:1], v])
    kernel = np.ones(FPS) / FPS
    return np.apply_along_axis(lambda c: np.convolve(np.nan_to_num(c), kernel, "same"), 0, v)


def main(out_dir: Path) -> Path:
    players, lineups = build_people()
    sim = Sim(players)
    sim.run_period(1, 0)
    sim.run_period(2, 1)
    events, out = sim.events, sim.out
    pid = {p["player_id"]: p for p in players}
    short = {t["team_id"]: t["short_name"] for t in TEAMS}

    facts, n = [], [0]

    def fact(kind, ts, team_id, player_id, value, unit, label, src_events=(), frames=None):
        n[0] += 1
        f = {"match_id": MATCH, "fact_id": f"F-{kind.upper()}-{n[0]:06d}", "kind": kind, "ts": round(ts, 2),
             "period": 1 if ts < P1_S else 2, "team_id": team_id, "player_id": player_id,
             "value": round(float(value), 2), "unit": unit, "label_en": label,
             "source_event_ids": list(src_events), "source_frames": frames}
        facts.append(f)
        return f

    # passes
    passes = [e for e in events if e["type_name"] == "pass" and e["result_name"] == "success"]
    pass_facts = []
    for e in passes:
        dist = math.dist((e["start_x"], e["start_y"]), (e["end_x"], e["end_y"]))
        fr = int(round(e["ts"] * FPS))
        opp = out[fr, 1:, :2][[i for i, p in enumerate(players) if p["team_id"] != e["team_id"]]]
        near = int(np.sum(np.linalg.norm(opp - (e["end_x"], e["end_y"]), axis=1) < 6))
        diff = round(10 * min(0.95, dist / 70 + 0.15 * near), 1)  # 0..10, as studiodesk/facts
        fd = fact("pass_distance", e["ts"], e["team_id"], e["player_id"], dist, "m",
                  f"Pass of {dist:.0f} m", [e["event_id"]])
        fq = fact("pass_difficulty", e["ts"], e["team_id"], e["player_id"], diff, "/10",
                  f"Pass difficulty {diff:.1f}/10", [e["event_id"]])
        pass_facts.append((diff, e, fd, fq))
    # shots, goals, score
    shot_facts, score = [], {"T01": 0, "T02": 0}
    for idx, metres, dur in sim.shot_info:
        e = events[idx]
        kmh = metres / dur * 3.6
        fs = fact("shot_speed", e["ts"], e["team_id"], e["player_id"], kmh, "km/h", f"Shot at {kmh:.0f} km/h",
                  [e["event_id"]], [int(e["ts"] * FPS), int((e["ts"] + dur) * FPS)])
        fg = None
        if e["result_name"] == "success":
            score[e["team_id"]] += 1
            fg = fact("score", e["ts"], e["team_id"], None, score[e["team_id"]], "goals",
                      f"{short['T01']} {score['T01']}-{score['T02']} {short['T02']}", [e["event_id"]])
        shot_facts.append((e, fs, fg))
    # sprints: the top speed in the 8 s before each shot, by the shooter
    spd = speeds_kmh(out)
    sprint_facts = []
    for e, fs, fg in shot_facts:
        i = sim.ids.index(e["player_id"])
        f1 = int(e["ts"] * FPS)
        f0 = f1 - 8 * FPS
        k = f0 + int(np.argmax(spd[f0:f1, i]))
        v = spd[k, i]
        sprint_facts.append(fact("sprint_speed", k / FPS, e["team_id"], e["player_id"], v, "km/h",
                                 f"Sprint at {v:.1f} km/h", [], [k - FPS // 2, k + FPS // 2]))
    # momentum: shortcut: the demo halves last 3 minutes, so windows are 60 s, not 5 minutes
    mom = {"T01": [], "T02": []}
    win = int(60 * FPS)
    for w0 in range(0, FRAMES, win):
        own = sim.owner_frames[w0:w0 + win]
        for ti, team in enumerate(("T01", "T02")):
            mine = (np.isin(own, np.where(sim.team == ti)[0])) | (own == -2 - ti)
            share = mine.mean() / max((own != -1).mean(), 1e-6)
            period = 1 if w0 < P1_S * FPS else 2
            d = attack_dir(ti, period)
            bx = out[w0:w0 + win, 0, 0]
            terr = np.mean(((bx - 52.5) * d > 0)[mine]) if mine.any() else 0
            value = round(min(10.0, 10 * (0.65 * share + 0.35 * terr)), 1)
            mom[team].append(fact("momentum", (w0 + win) / FPS, team, None, value, "index",
                                  f"Momentum {value:.1f}", [], [w0, w0 + win - 1]))
    facts.sort(key=lambda f: f["ts"])

    # cue sheet
    cues = []

    def cue(ts, dur, graphic, audience, payload):
        cues.append({"match_id": MATCH, "cue_id": "", "story_id": None, "ts": round(ts, 1), "duration_s": dur,
                     "graphic": graphic, "audience": audience, "lang": "en", "payload": payload})

    both = ("analyst", "casual")

    def nameplate(f):
        p = pid[f["player_id"]]
        return {"player_id": p["player_id"], "name": p["name"], "shirt": p["shirt"],
                "team_short": short[p["team_id"]], "speed_kmh": round(f["value"], 1), "fact_id": f["fact_id"]}

    def momentum_upto(ts):
        h = [f for f in mom["T01"] if f["ts"] <= ts + 0.01]
        a = [f for f in mom["T02"] if f["ts"] <= ts + 0.01]
        return {"home": [f["value"] for f in h], "away": [f["value"] for f in a], "window": len(h),
                "fact_ids": [f["fact_id"] for f in h + a]}

    for (e, fs, fg), fsp in zip(shot_facts, sprint_facts):
        # the shooter's team and the shooter get the same nameplate and shot graphic
        for aud in both + (f"team:{e['team_id']}", f"player:{e['player_id']}"):
            if fsp["value"] >= 25:  # a nameplate only for a real sprint
                cue(fsp["ts"] - 1.0, 5.0, "nameplate", aud, nameplate(fsp))
            cue(e["ts"] + 1.0, 6.0, "pass_shot", aud, {"mode": "shot", "player_id": e["player_id"],
                "value": round(fs["value"], 1), "unit": "km/h", "quality": "Goal" if fg else "No goal",
                "fact_ids": [fs["fact_id"]] + ([fg["fact_id"]] if fg else [])})
        if fg:
            p = pid[e["player_id"]]
            s = fg["label_en"]
            # the score line shows both teams' totals, so the card cites every goal so far
            goals = [f["fact_id"] for f in facts if f["kind"] == "score" and f["ts"] <= fg["ts"]]
            cue(e["ts"] + 8.0, 9.0, "why_card", "analyst", {"kind": "why", "title": f"{s}: the run made it",
                "body": f"{p['name']} hit {fsp['value']:.1f} km/h on the way in and finished at "
                        f"{fs['value']:.0f} km/h.", "fact_ids": [fsp["fact_id"], fs["fact_id"], *goals]})
            cue(e["ts"] + 8.0, 9.0, "why_card", "casual", {"kind": "why", "title": f"Goal! {s}",
                "body": f"{p['name'].split()[0]} sprinted clear and smashed it in.",
                "fact_ids": goals})
    hard = max(pass_facts, key=lambda x: x[0])
    _, e, fd, fq = hard
    cue(e["ts"] + 0.5, 5.0, "pass_shot", "analyst", {"mode": "pass", "player_id": e["player_id"],
        "value": round(fd["value"], 1), "unit": "m", "quality": f"Difficulty {fq['value']:.1f}/10",
        "fact_ids": [fd["fact_id"], fq["fact_id"]]})
    cue(120.5, 8.0, "momentum", "analyst", momentum_upto(120))
    cue(P1_S + 120.5, 8.0, "momentum", "analyst", momentum_upto(P1_S + 120))
    cue(P1_S - 10, 8.0, "momentum", "casual", momentum_upto(P1_S))
    # as studiodesk/export.py: the same recap for both audiences at half-time and full time, 12 s,
    # the full-time one past the last tracking frame
    for end, label in ((P1_S, "Half-time"), (P1_S + P2_S, "Full time")):
        for aud in both + tuple(f"team:{t['team_id']}" for t in TEAMS):
            cue(end, 12.0, "why_card", aud, recap({"teams": TEAMS, "players": players}, facts, end, label))
    cues.sort(key=lambda c: (c["ts"], c["audience"]))
    for i, c in enumerate(cues, 1):
        c["cue_id"] = f"C-{i:06d}"

    meta = {"match_id": MATCH, "venue_name": VENUE, "fps": FPS, "period1_s": P1_S, "period2_s": P2_S,
            "frames": FRAMES, "home_score": score["T01"], "away_score": score["T02"], "teams": TEAMS,
            "players": players, "lineups": lineups, "entities": ["ball"] + sim.ids}
    # what the agents will add: stories, their why cards in three languages, the hand-off traces
    stories, cues, traces = demo_stories.build(meta, events, facts, cues)
    # every audience's line in its why cards and the kids sheet, as studiodesk/export.py does
    stories, cues = audiences.apply(meta, facts, events, stories, cues)

    # self-checks: shapes, names, contract limits
    assert out.shape == (FRAMES, len(meta["entities"]), 3)
    assert not np.isnan(out[:, 0]).any(), "ball must always have a position"
    texts = [c["payload"].get(k, "") for c in cues for k in ("title", "body")] + [s["analysis_en"] for s in stories]
    for text in [VENUE] + [t["name"] for t in TEAMS] + [p["name"] for p in players] + texts + [
            v for s in stories for v in s["texts"].values()]:
        assert not find_forbidden(text), f"real name in fixture: {text}"
    for aud in sorted({c["audience"] for c in cues}):
        for lang in ("en", "it", "es"):
            mine = sheet(cues, aud, lang)
            for c in mine:
                # the most graphics on screen at once is reached at some cue start
                overlap = [o for o in mine if o["ts"] <= c["ts"] < o["ts"] + o["duration_s"]]
                assert len(overlap) <= 2, f"more than 2 cues on screen for {aud} {lang} at {c['ts']}"
                assert 0 <= c["ts"] <= P1_S + P2_S

    out_dir.mkdir(parents=True, exist_ok=True)
    out_dir.joinpath("tracking.f32").write_bytes(out.astype("<f4").tobytes())
    for name, rows in (("meta", meta), ("events", events), ("facts", facts), ("cues", cues),
                       ("stories", stories), ("traces", traces)):
        out_dir.joinpath(f"{name}.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    # Watch for, as studiodesk/export.py writes it (docs/forecast.md)
    out_dir.joinpath("forecast.json").write_text(json.dumps(forecast.export_from(meta, facts), ensure_ascii=False), encoding="utf-8")
    return out_dir


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "web" / "data" / MATCH
    d = main(target)
    print(f"wrote {d}: {FRAMES} frames, score {json.loads((d / 'meta.json').read_text())['home_score']}-"
          f"{json.loads((d / 'meta.json').read_text())['away_score']}, "
          f"{len(json.loads((d / 'cues.json').read_text()))} cues")
