"""Event engine: a possession state machine (possession -> action -> outcome) writing SPADL actions.

The engine runs on in-play time `tg` (seconds of ball in play since kick-off). Dead-ball time is
inserted afterwards in `timeline()`, so the action count follows the calibration exactly.
Coordinates handed to `emit` are absolute (docs/CONTRACT.md); decisions use the acting team's
attacking frame, where the team attacks towards x = 105.
"""
import math

import numpy as np

L, W = 105.0, 68.0
FORMATIONS = {  # slot 0 is the goalkeeper; (depth 0..1 from back line to front line, width 0..1)
    "4-4-2": [(0, .5), (0, .12), (0, .38), (0, .62), (0, .88), (.5, .12), (.5, .38), (.5, .62),
              (.5, .88), (1, .38), (1, .62)],
    "4-3-3": [(0, .5), (0, .12), (0, .38), (0, .62), (0, .88), (.45, .25), (.45, .5), (.45, .75),
              (1, .12), (1, .5), (1, .88)],
}
LINES = {"4-4-2": dict(GK=1, DF=4, MF=4, FW=2), "4-3-3": dict(GK=1, DF=4, MF=3, FW=3)}
PASS_TYPES = ("pass", "cross")
SHOT_TYPES = ("shot", "shot_freekick", "shot_penalty")


def shape(d, w, gk, bx, by, poss, line):
    """Shape targets in the team's attacking frame. Every argument broadcasts (numpy)."""
    back = np.where(poss, np.clip(bx - 32, 12, 58), np.clip(bx - 20, 8, 46)) + line
    x = back + d * np.where(poss, 38.0, 26.0)
    y = 34 + (w - .5) * np.where(poss, 54.0, 40.0) + (by - 34) * np.where(poss, .25, .45)
    x = np.where(gk, np.clip(back * .35, 3, 22), x)
    y = np.where(gk, 34 + (by - 34) * .15, y)
    return np.clip(x, .5, L - .5), np.clip(y, .5, W - .5)


def flip(x, y):
    return L - x, W - y


def sigmoid(v):
    return 1 / (1 + math.exp(-v))


def logit(p):
    return math.log(p / (1 - p))


def run_time(dist, v0, a, vmax):
    """Seconds to cover dist from speed v0 with constant acceleration a up to vmax."""
    t1 = (vmax - v0) / a
    d1 = (v0 + vmax) / 2 * t1
    if dist <= d1:
        return (-v0 + math.sqrt(v0 * v0 + 2 * a * dist)) / a
    return t1 + (dist - d1) / vmax


class Team:
    def __init__(self, team_id, squad, formation, home):
        self.id, self.home, self.formation = team_id, home, formation
        self.squad = {p["player_id"]: p for p in squad}
        need = dict(LINES[formation])
        self.slots, self.bench = [], []
        for pos in ("GK", "DF", "MF", "FW"):
            group = [p["player_id"] for p in squad if p["position"] == pos]
            self.slots += group[:need[pos]]
            self.bench += group[need[pos]:]
        self.slot_of = {pid: k for k, pid in enumerate(self.slots)}


class Engine:
    def __init__(self, rng, cal, home, away, plan, periods):
        self.rng, self.cal, self.plan = rng, cal, plan
        self.home, self.away = home, away
        self.teams = {home.id: home, away.id: away}
        self.periods = periods
        c = lambda k: cal[k]["value"]  # noqa: E731
        scale = sum(periods) / 5640  # calibration values are per ~94 min match
        self.s_play = c("ball_in_play_share")
        self.T = self.s_play * sum(periods)
        self.n_target = 2 * c("actions_per_team_per_match") * scale
        self.targets = {"shot": c("shots_per_match") * scale / 2, "foul": c("fouls_per_match") * scale,
                        "yellow": c("yellow_cards_per_match") * scale,
                        "offside": c("offside_per_match") * scale,
                        "throw_in": c("throw_ins_per_match") * scale,
                        "goalkick": c("goal_kicks_per_match") * scale,
                        "corner": c("corners_per_match") * scale}
        self.pass_share, self.pass_ok = c("pass_share"), c("pass_success_rate")
        self.mean_pass, self.mean_carry = c("mean_pass_length_m"), c("mean_carry_m")
        self.pass_kmh, self.shot_kmh = c("pass_speed_kmh"), c("shot_speed_kmh")
        self.weights = c("restart_weights")
        self.press_mult = c("high_press_turnover_multiplier")
        self.press_raise = c("high_press_line_raise_m")
        self.base_hold = .5 * self.T / self.n_target
        self.ev, self.count, self.subs = [], {}, []
        self.score = {home.id: 0, away.id: 0}
        self.goals = list(plan["goals"])
        self.pass_bias = self.ok_bias = 0.0
        self.tg, self.dead, self.sprint = 0.0, 0.0, None

    # -- geometry ------------------------------------------------------------
    def other(self, tid):
        return self.away.id if tid == self.home.id else self.home.id

    def flipped(self, tid):  # True when this team attacks towards x = 0 in this period
        return (tid == self.home.id) != (self.period == 1)

    def att(self, tid, x, y):  # absolute <-> attacking frame (the map is its own inverse)
        return flip(x, y) if self.flipped(tid) else (x, y)

    def formation(self, tid):
        sh = self.plan["shift"]
        if sh["team_id"] == tid and sh["variant"] == "shape" and self.tg >= sh["tg"]:
            return sh["to"]
        return self.teams[tid].formation

    def line(self, tid, poss, bx_att):
        sh, pr = self.plan["shift"], self.plan["press"]
        off = sh["line_raise_m"] if sh["team_id"] == tid and sh["variant"] == "line" and self.tg >= sh["tg"] else 0
        if pr["team_id"] == tid and not poss and pr["tg0"] <= self.tg < pr["tg1"] and bx_att > 47:
            off += self.press_raise
        return off

    def positions(self, tid):
        """Shape positions (absolute) of the team's 11 on the pitch, for the current ball."""
        team = self.teams[tid]
        poss = tid == self.team
        bx, by = self.att(tid, *self.ball)
        slots = np.array(FORMATIONS[self.formation(tid)])
        x, y = shape(slots[:, 0], slots[:, 1], np.arange(11) == 0, bx, by, poss,
                     self.line(tid, poss, bx))
        x, y = self.att(tid, x, y)
        return team.slots, np.asarray(x, float), np.asarray(y, float)

    def nearest(self, tid, x, y, exclude=(), keeper=False):
        pids, X, Y = self.positions(tid)
        d = np.hypot(X - x, Y - y)
        for k, pid in enumerate(pids):
            if pid in exclude or (k == 0 and not keeper):
                d[k] = np.inf
        return pids[int(np.argmin(d))]

    def gk(self, tid):
        return self.teams[tid].slots[0]

    def pressing(self, ax):
        """The defending team presses: spell active and ball in the attacking team's own half."""
        pr = self.plan["press"]
        return pr["team_id"] != self.team and pr["tg0"] <= self.tg < pr["tg1"] and ax < 58

    # -- bookkeeping ---------------------------------------------------------
    def emit(self, tid, pid, typ, result, body, s, e, dur=0.0, rel=None, z=0.0, loft=0, carry=False):
        self.ev.append(dict(period=self.period, tg=self.tg, dur=dur, team_id=tid, player_id=pid,
                            type_name=typ, result_name=result, bodypart_name=body,
                            start_x=float(s[0]), start_y=float(s[1]), end_x=float(e[0]),
                            end_y=float(e[1]), related_player_id=rel, z=z, loft=loft, carry=carry,
                            dead=self.dead))
        self.dead = 0.0
        self.pass_bias += .01 * (self.pass_share - (typ in PASS_TYPES))
        keys = (typ, "corner" if typ.startswith("corner") else None,
                "shot" + tid if typ in SHOT_TYPES else None,
                "yellow" if result == "yellow_card" else "offside" if result == "offside" else None)
        for k in keys:
            if k:
                self.count[k] = self.count.get(k, 0) + 1

    def paced(self, key, target, base):
        """Probability nudged so the count of `key` follows target * elapsed share of the match."""
        gap = target * self.tg / self.T - self.count.get(key, 0)
        return float(np.clip(base * math.exp(.6 * gap), 0, .95))

    def hold(self, short=False):
        r = np.clip((self.n_target * self.tg / self.T + 30) / (len(self.ev) + 30), .5, 2)
        m = np.clip(self.base_hold / r ** 2, .2, 6) * (.4 if short else 1)
        return .2 + float(self.rng.gamma(2.0, m / 2))

    def due(self, tid):
        return bool(self.goals) and self.goals[0][1] == tid and self.tg >= self.goals[0][0]

    def give(self, tid, pid, ball):
        self.team, self.carrier, self.ball = tid, pid, (float(ball[0]), float(ball[1]))

    # -- match loop ----------------------------------------------------------
    def play(self):
        for period, length in ((1, self.periods[0]), (2, self.periods[1])):
            self.period = period
            kick = self.home.id if period == 1 else self.away.id
            self.restart = ("kickoff0", kick, (L / 2, W / 2))
            end = self.tg + self.s_play * length
            self.team, self.carrier, self.ball = kick, None, (L / 2, W / 2)
            while self.tg < end:
                if self.restart:
                    self.do_restart()
                else:
                    self.on_ball()
            self.restart = None
        return self.ev

    def on_ball(self):
        rng, T, c = self.rng, self.team, self.carrier
        ax, ay = self.att(T, *self.ball)
        is_gk = c == self.gk(T)
        if self.sprint_ready(ax, is_gk):
            return self.through_ball()
        dist = math.hypot(L - ax, W / 2 - ay)
        if not is_gk and ax > 70 and dist < 32:
            p = self.paced("shot" + T, self.targets["shot"], .3 * math.exp(-dist / 14))
            if rng.random() < (max(.5, min(.95, p * 2.5)) if self.due(T) else p):
                return self.shot("shot", "foot")
        if not is_gk and ax > 76 and (ay < 17 or ay > W - 17) and rng.random() < .35:
            return self.cross("cross")
        if is_gk:
            return self.pass_("pass")
        if ax < 20 and (self.pressing(ax) or rng.random() < .3) and rng.random() < .35:
            return self.clearance("foot")
        if rng.random() < self.cal["take_on_share"]["value"] * (1.8 if ax > 70 else 1):
            return self.take_on()
        if rng.random() < np.clip(.62 + self.pass_bias, .2, .97):
            return self.pass_("pass")
        return self.carry()

    # -- actions -------------------------------------------------------------
    def flight(self, length, loft):
        lo, hi = self.pass_kmh
        kmh = self.rng.normal(62, 8) if loft else self.rng.normal(38 + 1.3 * length, 6)
        dur = length / (np.clip(kmh, lo, hi) / 3.6)
        return float(dur), (float(min(18.0, 9.81 * dur * dur / 8)) if loft else 0.0)

    def pass_(self, typ, body="foot", lmean=None, p=None, to=None):
        """Pass-like action (pass, throw_in, goalkick, freekick_short, corner_short)."""
        rng, T, c = self.rng, self.team, self.carrier
        D = self.other(T)
        ax, ay = self.att(T, *self.ball)
        pressing = self.pressing(ax)
        if to:
            r, (ex, ey) = to
        else:
            pids, X, Y = self.positions(T)
            AX, AY = self.att(T, X, Y)
            want = float(np.clip(rng.gamma(2.5, (lmean or self.mean_pass) / 2.5), 3, 70))
            score = -abs(np.hypot(AX - ax, AY - ay) - want) / 5 + .03 * (AX - ax) + rng.gumbel(size=11)
            score[0] -= 2.5  # back passes to the keeper are rare
            score[pids.index(c)] = -np.inf
            k = int(np.argmax(score))
            r = pids[k]
            ex = float(np.clip(AX[k] + rng.normal(1.5, 2.0), 1, L - 1))
            ey = float(np.clip(AY[k] + rng.normal(0, 2.0), 1, W - 1))
        length = math.hypot(ex - ax, ey - ay)
        loft = length > 32 or typ == "goalkick" and length > 30
        dur, z = self.flight(length, loft)
        if p is None:  # open-play pass: calibrated success with zone and pressure modifiers
            mod = (-.035 * (length - self.mean_pass) - .5 * (ex > 85) + .7 * (ex < ax)
                   - (.5 if rng.random() < .3 else 0) - (math.log(self.press_mult) if pressing else 0))
            p = sigmoid(logit(self.pass_ok) + mod + self.ok_bias)
        ok = rng.random() < p
        if typ in PASS_TYPES:
            self.ok_bias += .02 * (self.pass_ok - ok)
        s_abs = self.ball
        if ok:
            self.emit(T, c, typ, "success", body, s_abs, self.att(T, ex, ey), dur, r, z, int(loft))
            self.tg += dur
            self.give(T, r, self.att(T, ex, ey))
            self.tg += self.hold()
            return
        if (typ == "pass" and ex > 80 and ex > ax + 5
                and rng.random() < self.paced("offside", self.targets["offside"], .25)):
            self.emit(T, c, typ, "offside", body, s_abs, self.att(T, ex, ey), dur, r, z, int(loft))
            self.tg += dur
            return self.set_restart("freekick", D, self.att(T, ex, ey))
        if rng.random() < self.paced("throw_in", self.targets["throw_in"], .2):
            side = 0.0 if ey < W / 2 else W
            return self.out_of_play(typ, body, (float(np.clip(ax + 1.15 * (ex - ax), 1, L - 1)), side), r)
        if ex > 75 and rng.random() < self.paced("goalkick", self.targets["goalkick"], .2):
            return self.out_of_play(typ, body, (L, ey), r)
        who, u = self.lane(D, ax, ay, ex, ey)
        ip = self.att(T, ax + u * (ex - ax), ay + u * (ey - ay))
        self.emit(T, c, typ, "fail", body, s_abs, ip, dur * u, r, z, int(loft))
        self.tg += dur * u
        self.intercept(D, ip, who)

    def lane(self, D, ax, ay, ex, ey):
        """The defender closest to the passing lane, and where along it he meets the ball."""
        pids, X, Y = self.positions(D)
        PX, PY = self.att(self.team, X, Y)  # into the passer's attacking frame
        dx, dy = ex - ax, ey - ay
        u = np.clip(((PX - ax) * dx + (PY - ay) * dy) / max(dx * dx + dy * dy, 1e-6), .35, 1.0)
        d = np.hypot(ax + u * dx - PX, ay + u * dy - PY) + self.rng.exponential(1.5, 11)
        d[0] = np.inf if ax + u[0] * dx < 89 else d[0]  # the keeper only comes for balls into his box
        k = int(np.argmin(d))
        return pids[k], float(u[k])

    def intercept(self, D, ip, who=None):
        who = who or self.nearest(D, *ip, keeper=self.att(D, *ip)[0] < 16)
        self.emit(D, who, "interception", "success", "foot", ip, ip)
        self.give(D, who, ip)
        self.tg += self.hold()

    def out_of_play(self, typ, body, end, r):
        """A failed ball (attacking frame `end`) over a touchline (throw-in) or the far byline."""
        T, D = self.team, self.other(self.team)
        ax, ay = self.att(T, *self.ball)
        length = math.hypot(end[0] - ax, end[1] - ay)
        dur, z = self.flight(length, length > 32)
        e_abs = self.att(T, *end)
        self.emit(T, self.carrier, typ, "fail", body, self.ball, e_abs, dur, r, z, int(length > 32))
        self.tg += dur
        if end[1] in (0.0, W):
            return self.set_restart("throw_in", D, e_abs)
        self.set_restart("goalkick", D, None)

    def carry(self):
        rng, T, c = self.rng, self.team, self.carrier
        ax, ay = self.att(T, *self.ball)
        length = float(np.clip(rng.gamma(2.0, self.mean_carry / 2), 2, 25))
        ang = rng.normal(0, .6) + (.3 if ay < 15 else -.3 if ay > W - 15 else 0)
        ex = float(np.clip(ax + length * math.cos(ang), 1, L - 1))
        ey = float(np.clip(ay + length * math.sin(ang), 1, W - 1))
        dur = math.hypot(ex - ax, ey - ay) / rng.uniform(3.5, 6.0)
        end = self.att(T, ex, ey)
        self.emit(T, c, "dribble", "success", "foot", self.ball, end, dur, carry=True)
        self.tg += dur
        self.ball = end
        p_lose = .05 * (self.press_mult if self.pressing(ax) else 1)
        if rng.random() < p_lose:
            return self.contest(end)
        self.tg += self.hold(short=True)

    def take_on(self):
        rng, T, c = self.rng, self.team, self.carrier
        D = self.other(T)
        ax, ay = self.att(T, *self.ball)
        defender = self.nearest(D, *self.ball)
        p = sigmoid(logit(self.cal["take_on_success_rate"]["value"])
                    - (math.log(self.press_mult) if self.pressing(ax) else 0))
        if rng.random() < p:
            length = rng.uniform(3, 7)
            end = self.att(T, float(min(L - 1, ax + length)), float(np.clip(ay + rng.normal(0, 2), 1, W - 1)))
            dur = length / 6.0
            self.emit(T, c, "take_on", "success", "foot", self.ball, end, dur, defender, carry=True)
            self.tg += dur
            self.ball = end
            self.tg += self.hold(short=True)
            return
        end = self.att(T, float(min(L - 1, ax + 1)), ay)
        self.emit(T, c, "take_on", "fail", "foot", self.ball, end, .4, defender, carry=True)
        self.tg += .4
        self.ball = end
        self.contest(end, defender)

    def contest(self, point, defender=None):
        """The defender wins the ball: a tackle, or a foul (free kick, maybe a card)."""
        T, c = self.team, self.carrier
        D = self.other(T)
        defender = defender or self.nearest(D, *point)
        if self.rng.random() < self.paced("foul", self.targets["foul"], .3):
            card = self.rng.random() < self.paced("yellow", self.targets["yellow"], .12)
            self.emit(D, defender, "foul", "yellow_card" if card else "fail", "foot", point, point, rel=c)
            return self.set_restart("freekick", T, point)
        self.emit(D, defender, "tackle", "success", "foot", point, point, rel=c)
        self.give(D, defender, point)
        self.tg += self.hold()

    def shot(self, typ, body):
        rng, T, c = self.rng, self.team, self.carrier
        D = self.other(T)
        ax, ay = self.att(T, *self.ball)
        dist = math.hypot(L - ax, W / 2 - ay)
        due = self.due(T)
        late = (self.tg - self.goals[0][0]) / 120 if due else 0.0  # an overdue goal gets likelier
        p_goal = float(np.clip(1.3 * math.exp(-dist / 20) + late, .25, .9)) if due else 0.0
        lo, hi = self.shot_kmh if body == "foot" else (55, 80)
        kmh = rng.uniform(lo, hi)
        r = rng.random()
        if rng.random() < p_goal:
            end, zend, res = (L, rng.uniform(30.9, 37.1)), rng.uniform(.1, 2.3), "success"
        elif r < .33:
            end, zend, res = (L - rng.uniform(.3, 2), rng.uniform(31, 37)), rng.uniform(.2, 2.0), "save"
        elif r < .75:
            off_y = rng.choice([rng.uniform(22, 30), rng.uniform(38, 46), rng.uniform(31, 37)])
            end, zend, res = (L, off_y), (rng.uniform(2.6, 4.5) if 30 < off_y < 38 else rng.uniform(.2, 2)), "off"
        else:
            k = min(.6, rng.uniform(2, 5) / max(dist, 1))  # blocked short of the goal line
            end, zend, res = (ax + k * (L - ax), ay + k * (W / 2 - ay)), .3, "block"
        length = math.hypot(end[0] - ax, end[1] - ay)
        dur = length / (kmh / 3.6)
        e_abs = self.att(T, *end)
        self.emit(T, c, typ, "success" if res == "success" else "fail", body, self.ball, e_abs, dur,
                  z=float(zend), loft=2)
        self.tg += dur
        if res == "success":
            self.score[T] += 1
            self.goals.pop(0)
            return self.set_restart("kickoff", D, (L / 2, W / 2))
        if res == "save":
            keeper = self.gk(D)
            self.emit(D, keeper, "keeper_save", "success", "other", e_abs, e_abs, rel=c)
            if rng.random() < .3:
                return self.set_restart("corner", T, self.att(T, L, 0.0 if end[1] < W / 2 else W))
            self.give(D, keeper, e_abs)
            self.tg += self.hold()
            return
        if res == "off":
            return self.set_restart("goalkick", D, None)
        if rng.random() < self.paced("corner", self.targets["corner"], .4):  # blocked behind
            return self.set_restart("corner", T, self.att(T, L, 0.0 if end[1] < W / 2 else W))
        self.give(D, self.nearest(D, *e_abs), e_abs)
        self.clearance("foot")

    def cross(self, typ):
        rng, T, c = self.rng, self.team, self.carrier
        D = self.other(T)
        ex, ey = rng.uniform(94, 103), rng.uniform(25, 43)
        e_abs = self.att(T, ex, ey)
        r = self.nearest(T, *e_abs, exclude=(c,))
        ax, ay = self.att(T, *self.ball)
        dur, z = self.flight(math.hypot(ex - ax, ey - ay), True)
        ok = rng.random() < self.cal["cross_success_rate"]["value"]
        self.emit(T, c, typ, "success" if ok else "fail", "foot", self.ball, e_abs, dur, r, z, 1)
        self.tg += dur
        if ok:
            self.give(T, r, e_abs)
            if rng.random() < .55:
                self.tg += .1
                return self.shot("shot", "head")
            self.tg += self.hold(short=True)
            return
        if rng.random() < self.paced("corner", self.targets["corner"], .25):  # headed behind
            defender = self.nearest(D, *e_abs)
            behind = self.att(T, L, float(np.clip(ey + rng.normal(0, 6), 1, W - 1)))
            hdur = math.dist(self.att(T, *behind), (ex, ey)) / (self.rng.uniform(45, 65) / 3.6)
            self.emit(D, defender, "clearance", "success", "head", e_abs, behind, hdur, z=1.0, loft=1)
            self.tg += hdur
            return self.set_restart("corner", T, self.att(T, L, 0.0 if ey < W / 2 else W))
        if rng.random() < .3:
            keeper = self.gk(D)
            self.emit(D, keeper, "keeper_claim", "success", "other", e_abs, e_abs)
            self.give(D, keeper, e_abs)
            self.tg += self.hold()
            return
        self.give(D, self.nearest(D, *e_abs), e_abs)
        self.clearance("head")

    def clearance(self, body):
        """The carrier's team boots the ball away; the loose ball is won by either side."""
        rng, T, c = self.rng, self.team, self.carrier
        D = self.other(T)
        ax, ay = self.att(T, *self.ball)
        if rng.random() < .2:  # into touch
            ex, ey = float(np.clip(ax + rng.uniform(10, 40), 1, L - 1)), (0.0 if ay < W / 2 else W)
        else:
            ex = float(np.clip(ax + rng.uniform(25, 50), 1, L - 1))
            ey = float(np.clip(ay + rng.normal(0, 15), 1, W - 1))
        dur, z = self.flight(math.hypot(ex - ax, ey - ay), True)
        e_abs = self.att(T, ex, ey)
        self.emit(T, c, "clearance", "success", body, self.ball, e_abs, dur, z=z, loft=1)
        self.tg += dur
        if ey in (0.0, W):
            return self.set_restart("throw_in", D, e_abs)
        self.ball = e_abs
        if rng.random() < .45:
            self.give(T, self.nearest(T, *e_abs), e_abs)
            self.tg += self.hold()
        else:
            self.intercept(D, e_abs)

    # -- restarts and substitutions -----------------------------------------
    def set_restart(self, kind, tid, where):
        self.restart = (kind, tid, where)

    def do_restart(self):
        rng = self.rng
        kind, T, where = self.restart
        self.restart = None
        self.do_subs()
        self.dead = 0.0 if kind == "kickoff0" else self.weights["kickoff" if kind == "kickoff" else kind]
        team = self.teams[T]
        if kind.startswith("kickoff"):
            taker = team.slots[-1]
            self.give(T, taker, where)
            mf = team.slots[6]
            back = (L / 2 - rng.uniform(8, 14), W / 2 + rng.normal(0, 6))  # attacking frame
            return self.pass_("pass", to=(mf, back), p=1.0)
        if kind == "goalkick":
            where = self.att(T, 5.5, W / 2 + rng.choice([-9.16, 9.16]))
            self.give(T, team.slots[0], where)
            long_ = rng.random() < .5
            return self.pass_("goalkick", lmean=50 if long_ else 15, p=.5 if long_ else .95)
        if kind == "throw_in":
            self.give(T, self.nearest(T, *where), where)
            return self.pass_("throw_in", "other", lmean=12, p=.85)
        if kind == "corner":
            self.give(T, team.slots[int(rng.integers(5, 11))], where)
            if rng.random() < .8:
                return self.cross("corner_crossed")
            return self.pass_("corner_short", lmean=8, p=.95)
        # free kick
        self.give(T, self.nearest(T, *where), where)
        ax, ay = self.att(T, *where)
        dist = math.hypot(L - ax, W / 2 - ay)
        if dist < 28 and abs(ay - W / 2) < 18 and rng.random() < .4:
            return self.shot("shot_freekick", "foot")
        if ax > 68:
            return self.cross("freekick_crossed")
        return self.pass_("freekick_short", p=.92)

    def do_subs(self):
        for sub in self.plan["subs"]:
            if sub.get("done") or self.tg < sub["tg"]:
                continue
            team = self.teams[sub["team_id"]]
            k = team.slot_of.pop(sub["off"])
            team.slots[k] = sub["on"]
            team.slot_of[sub["on"]] = k
            sub["done"], sub["event"] = True, len(self.ev)

    # -- planted top sprint --------------------------------------------------
    def sprint_ready(self, ax, is_gk):
        sp = self.plan["sprint"]
        pid = sp["player_id"]
        if self.sprint or is_gk or self.tg < sp["tg"] or self.team != sp["team_id"] \
                or pid == self.carrier or pid not in self.teams[self.team].slot_of or not 10 < ax < 60:
            return False
        pids, X, Y = self.positions(self.team)
        sx, _ = self.att(self.team, X[pids.index(pid)], Y[pids.index(pid)])
        return 96 - sx >= 32

    def through_ball(self):
        """Long ball into space for the fast forward, timed to his sprint (storyline top_sprint)."""
        rng, T, c = self.rng, self.team, self.carrier
        pid = self.plan["sprint"]["player_id"]
        pids, X, Y = self.positions(T)
        sx, sy = self.att(T, X[pids.index(pid)], Y[pids.index(pid)])
        run = float(min(46, 96 - sx))
        ex, ey = sx + run, float(np.clip(sy + rng.normal(0, 4), 10, W - 10))
        top = self.teams[T].squad[pid]["top_speed_kmh"] / 3.6
        t_run = run_time(math.hypot(ex - sx, ey - sy), 2.0, 4.0, top)
        ax, ay = self.att(T, *self.ball)
        length = math.hypot(ex - ax, ey - ay)
        dur, z = self.flight(length, True)
        t0 = self.tg
        self.tg += max(.3, t_run - dur)
        e_abs = self.att(T, ex, ey)
        self.emit(T, c, "pass", "success", "foot", self.ball, e_abs, dur, pid, z, 1)
        self.tg += dur
        far = self.att(T, float(min(L - .5, ex + 12)), ey)
        self.sprint = dict(player_id=pid, team_id=T, tg0=t0, tg1=self.tg, target=far,
                           start=self.att(T, sx, sy))
        self.give(T, pid, e_abs)
        self.tg += .3


def plan_match(rng, cal, home, away, periods, comeback):
    """What the match will contain: goals in order, the planted storylines, substitutions."""
    c = lambda k: cal[k]["value"]  # noqa: E731
    s = c("ball_in_play_share")
    T = s * sum(periods)
    mu = c("goals_per_match") * sum(periods) / 5640
    hs = c("home_goal_share")
    if comeback:
        trail, lead = (home, away) if rng.random() < .5 else (away, home)
        n_lead = 1 + int(rng.random() < .3)
        n_trail = n_lead + int(rng.integers(0, 2))
        goals = [(rng.uniform(.06, .42) * T, lead.id) for _ in range(n_lead)]
        goals += [(rng.uniform(.5, .82) * T, trail.id) for _ in range(n_trail)]
    else:
        goals = [(rng.uniform(.03, .88) * T, home.id) for _ in range(rng.poisson(mu * hs))]
        goals += [(rng.uniform(.03, .88) * T, away.id) for _ in range(rng.poisson(mu * (1 - hs)))]
    goals.sort()
    # fast forward of this match: the quickest starting forward
    fwds = [(t.squad[p]["top_speed_kmh"], p, t.id) for t in (home, away) for p in t.slots
            if t.squad[p]["position"] == "FW"]
    top, sprinter, sprint_team = max(fwds)
    shift_team = home if rng.random() < .5 else away
    variant = "line" if rng.random() < .5 else "shape"
    shift = dict(team_id=shift_team.id, variant=variant, tg=s * (periods[0] + rng.uniform(.21, .42) * periods[1]),
                 line_raise_m=float(rng.uniform(*c("tactical_shift_line_raise_m"))) if variant == "line" else 0.0,
                 frm=shift_team.formation, to="4-3-3" if shift_team.formation == "4-4-2" else "4-4-2")
    press_team = home if rng.random() < .5 else away
    p0 = rng.uniform(.12, .75) * T
    press = dict(team_id=press_team.id, tg0=p0, tg1=p0 + rng.uniform(5, 10) * 60 * s,
                 line_raise_m=c("high_press_line_raise_m"), turnover_multiplier=c("high_press_turnover_multiplier"))
    sprint = dict(player_id=sprinter, team_id=sprint_team, top_speed_kmh=top, tg=rng.uniform(.15, .7) * T)
    subs = []
    for t in (home, away):
        bench = list(t.bench)
        cands = [p for p in t.slots[1:] if p != sprinter]
        times = sorted(s * (periods[0] + rng.uniform(.2, .9) * periods[1]) for _ in range(c("subs_per_team")))
        for tg in times:
            pos_free = {t.squad[b]["position"] for b in bench}
            opts = [p for p in cands if t.squad[p]["position"] in pos_free]
            if not opts:
                break
            off = opts[int(rng.integers(len(opts)))]
            on = next(b for b in bench if t.squad[b]["position"] == t.squad[off]["position"])
            bench.remove(on)
            cands.remove(off)
            subs.append(dict(team_id=t.id, off=off, on=on, tg=tg))
    return dict(goals=goals, comeback=comeback, shift=shift, press=press, sprint=sprint, subs=subs)
