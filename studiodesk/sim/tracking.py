"""Tracking at 10 fps, consistent with the events.

The ball follows event start/end points; players follow a team shape around the ball, the next
actor runs to the action point, the nearest defender closes the ball down. A speed- and
acceleration-limited follower turns those targets into positions.
"""
import numpy as np

from .engine import FORMATIONS, L, W, shape

K_GAIN = 1.5  # 1/s: how hard a player runs towards a target he is far from
BALL_R = 0.11


def ball_path(ts, ev):
    """Ball (F, 3), index of the last started event, and the frames where the ball is in flight."""
    ets, dur = ev["ts"], ev["dur"]
    n = len(ets)
    i = np.clip(np.searchsorted(ets, ts, "right") - 1, 0, n - 1)
    j = np.minimum(i + 1, n - 1)
    pre = ts < ets[0]
    fl = (ts >= ets[i]) & (ts < ets[i] + dur[i]) & ~pre
    u = np.clip((ts - ets[i]) / np.maximum(dur[i], 1e-6), 0, 1)
    g0 = ets[i] + dur[i]
    moves = (j > i) & (ev["period"][j] == ev["period"][i])  # no drift across half-time
    v = np.where(moves, np.clip((ts - g0) / np.maximum(ets[j] - g0, 1e-6), 0, 1), 0)
    sx, sy, ex, ey = ev["sx"], ev["sy"], ev["ex"], ev["ey"]
    bx = np.where(fl, sx[i] + u * (ex[i] - sx[i]), ex[i] + v * (sx[j] - ex[i]))
    by = np.where(fl, sy[i] + u * (ey[i] - sy[i]), ey[i] + v * (sy[j] - ey[i]))
    bx, by = np.where(pre, sx[0], bx), np.where(pre, sy[0], by)
    z, loft = ev["z"][i], ev["loft"][i]
    bz = BALL_R + np.where(fl & (loft == 1), 4 * z * u * (1 - u), 0) \
        + np.where(fl & (loft == 2), u * np.maximum(z - BALL_R, 0), 0)
    return np.stack([bx, by, bz], 1), i, j, fl, pre


def track(ts, ev, players, periods, story, cal, rng):
    """Positions (F, 1 + N, 3) float32 and the ball owner index per frame (-1 for none).

    `players`: dict of arrays over the N squad players: top_kmh, home, slot, on_ts, off_ts,
    formation (per player, his team's), and `shift_to` (formation after a shape shift, or "").
    `story`: planted storylines with times on the `ts` axis.
    """
    c = lambda k: cal[k]["value"]  # noqa: E731
    F, N = len(ts), len(players["top_kmh"])
    fps = round(1 / (ts[1] - ts[0]))
    ball, i, j, fl, pre = ball_path(ts, ev)
    bx, by = ball[:, 0], ball[:, 1]
    period2 = ts >= periods[0]
    same_period = ev["period"][i] == ev["period"][j]
    actor, carry, dead = ev["actor"], ev["carry"], ev["dead"]

    owner = np.full(F, -1)
    owner = np.where(fl & carry[i], actor[i], owner)
    waiting = ~fl & ~pre & (j > i) & (dead[j] == 0) & same_period
    owner = np.where(waiting, actor[j], owner)
    poss_home = np.where(pre, ev["home"][0], ev["home"][i])

    home, slot = players["home"], players["slot"]
    top = players["top_kmh"] / 3.6
    active = (ts[:, None] >= players["on_ts"]) & (ts[:, None] < players["off_ts"])
    sh, pr, sp = story["shift"], story["press"], story["sprint"]
    tgt = np.zeros((F, N, 2))
    press_on = np.zeros(F, bool)
    wander = c("wander_m")
    burst_rate = c("sprints_per_player") * c("off_ball_run_share") / 5640  # per second on the pitch
    running = np.zeros((F, N), bool)
    # the team shape reacts to a smoothed ball, not to every pass (per half: no blur across the cut)
    sm = np.empty((F, 2))
    kern = np.exp(-np.arange(int(4 * c("shape_lag_s") * fps)) / (c("shape_lag_s") * fps))
    kern /= kern.sum()
    for half in (~period2, period2):
        seg = ball[half, :2]
        padded = np.vstack([np.repeat(seg[:1], len(kern) - 1, 0), seg])
        sm[half] = np.stack([np.convolve(padded[:, k], kern, "valid") for k in (0, 1)], 1)
    sbx, sby = sm[:, 0], sm[:, 1]
    for p in range(N):
        if slot[p] < 0:
            continue
        flipped = home[p] != ~period2  # attacks towards x = 0
        bxp, byp = np.where(flipped, L - sbx, sbx), np.where(flipped, W - sby, sby)
        poss = poss_home == home[p]
        is_shift = players["team"][p] == sh["team_id"]
        after = is_shift & (ts >= sh["ts"])
        line = np.where(after & (sh["variant"] == "line"), sh["line_raise_m"], 0.0)
        if players["team"][p] == pr["team_id"]:
            pressing = (ts >= pr["ts0"]) & (ts < pr["ts1"]) & ~poss & (bxp > 47)
            line = line + np.where(pressing, pr["line_raise_m"], 0.0)
            press_on |= pressing
        d0, w0 = FORMATIONS[players["formation"][p]][slot[p]]
        d, w = np.full(F, float(d0)), np.full(F, float(w0))
        if is_shift and sh["variant"] == "shape":
            d1, w1 = FORMATIONS[sh["to"]][slot[p]]
            d, w = np.where(after, d1, d), np.where(after, w1, w)
        x, y = shape(d, w, slot[p] == 0, bxp, byp, poss, line)
        amp = wander * (.3 if slot[p] == 0 else 1)
        for frac, lo, hi in ((1.0, 25, 45), (.6, 9, 16)):  # slow and medium drift
            ph, per = rng.uniform(0, 2 * np.pi, 2), rng.uniform(lo, hi, 2)
            x = x + frac * amp * np.sin(2 * np.pi * ts / per[0] + ph[0])
            y = y + frac * amp * np.sin(2 * np.pi * ts / per[1] + ph[1])
        if slot[p] > 0:  # off-ball runs: forward when his team has the ball, back otherwise
            n_runs = rng.poisson(burst_rate * (min(players["off_ts"][p], ts[-1]) - players["on_ts"][p]))
            for t0 in rng.uniform(players["on_ts"][p], min(players["off_ts"][p], ts[-1]), n_runs):
                f0 = int(t0 * fps)
                win = slice(f0, f0 + int(4.5 * fps))
                sign = 1.0 if poss[min(f0, F - 1)] else -1.0
                x[win] += sign * 22
                y[win] += rng.normal(0, 5)
                running[win, p] = True
        x, y = np.clip(x, .5, L - .5), np.clip(y, .5, W - .5)
        tgt[:, p, 0] = np.where(flipped, L - x, x)
        tgt[:, p, 1] = np.where(flipped, W - y, y)

    # the nearest defenders close the ball down (two of them, tighter, during a high press)
    dist = np.hypot(tgt[..., 0] - bx[:, None], tgt[..., 1] - by[:, None])
    defending = active & (home[None, :] != poss_home[:, None]) & (slot[None, :] > 0)
    dist = np.where(defending, dist, np.inf)
    near = np.argsort(dist, axis=1)[:, :2]
    rows = np.arange(F)
    for k in (0, 1):
        p_idx = near[:, k]
        use = np.isfinite(dist[rows, p_idx]) & (press_on if k else True)
        flipped = home[p_idx] != ~period2
        gx = np.where(flipped, L, 0.0)  # own goal of the defender
        vx, vy = gx - bx, W / 2 - by
        norm = np.maximum(np.hypot(vx, vy), 1e-6)
        r = np.where(press_on, 1.5, 3.5) if k == 0 else 3.0
        side = 2.0 * k
        tx = np.clip(bx + r * vx / norm - side * vy / norm, .5, L - .5)
        ty = np.clip(by + r * vy / norm + side * vx / norm, .5, W - .5)
        tgt[rows[use], p_idx[use]] = np.stack([tx, ty], 1)[use]

    # the next actor runs to the action point; a carrier stays on the moving ball
    focus = np.zeros((F, N), bool)
    need = np.zeros((F, N))
    n_ev = len(ev["ts"])
    j2 = np.minimum(j + 1, n_ev - 1)
    # the actor after next (a tackler, an interceptor) starts early; then the next actor overrides
    nxt2 = (j2 > j) & (j > i) & (ev["ts"][j2] - ts <= 6) & (dead[j] == 0) & (dead[j2] == 0) \
        & (ev["period"][j2] == ev["period"][i]) & (actor[j2] != actor[j]) & ~pre
    nxt = ((j > i) & ((ev["ts"][j] - ts <= 6) | (dead[j] > 0)) & ~pre) | pre
    for jj, use in ((j2, nxt2), (np.where(pre, 0, j), nxt)):
        a = actor[jj]
        point = np.stack([ev["sx"][jj], ev["sy"][jj]], 1)
        # run only as fast as needed to be there in time (estimated from his shape position)
        away = np.hypot(*(tgt[rows, a] - point).T)
        need[rows[use], a[use]] = (1.25 * away / np.maximum(ev["ts"][jj] - ts, .3))[use]
        tgt[rows[use], a[use]] = point[use]
        focus[rows[use], a[use]] = True
    cr = fl & carry[i]
    vb = np.stack([(ev["ex"] - ev["sx"]) / np.maximum(ev["dur"], 1e-6),
                   (ev["ey"] - ev["sy"]) / np.maximum(ev["dur"], 1e-6)], 1)[i]
    lead = np.clip(ball[:, :2] + vb / K_GAIN, .5, [L - .5, W - .5])
    tgt[rows[cr], actor[i][cr]] = lead[cr]
    focus[rows[cr], actor[i][cr]] = True
    need[rows[cr], actor[i][cr]] = np.inf

    cap = (c("top_sprint_kmh") - .3) / 3.6  # only the planted sprint goes above the threshold
    # off-ball jogging stays below the sprint threshold, also for the fastest players
    jog = np.minimum(c("jog_cap_fraction") * top, (c("sprint_threshold_kmh") - 1) / 3.6)
    fast = c("focus_cap_fraction") * top
    vmax = np.where(focus, np.clip(need, jog, fast), np.where(running, fast, jog))
    vmax = np.minimum(vmax, cap)
    if sp:  # the planted sprinter first takes up the engine's start point, then runs flat out
        pre = (ts >= sp["ts0"] - 4) & (ts < sp["ts0"])
        tgt[pre, sp["idx"]] = sp["start"]
        vmax[pre, sp["idx"]] = np.minimum(fast[sp["idx"]], cap)
        win = (ts >= sp["ts0"]) & (ts <= sp["ts1"])
        tgt[win, sp["idx"]] = sp["target"]
        vmax[win, sp["idx"]] = top[sp["idx"]]

    tgt = np.clip(tgt, .5, [L - .5, W - .5])  # a target on a line would push players off the pitch
    pos = follow(tgt, vmax, active, period2, c("max_accel_ms2"), fps)
    out = np.full((F, N + 1, 3), np.nan, np.float32)
    out[:, 0] = ball
    out[:, 1:, :2] = np.where(active[..., None], pos, np.nan)
    out[:, 1:, 2] = np.where(active, 0.0, np.nan)
    return out, owner


def follow(tgt, vmax, active, period2, amax, fps):
    """Speed- and acceleration-limited pursuit of the targets, restarted at each kick-off."""
    F, N, _ = tgt.shape
    dt = 1.0 / fps
    out = np.empty_like(tgt)
    bench = np.array([L / 2, .5])
    entered = active[1:] & ~active[:-1]

    def stop_speed(room, share):  # top speed that still stops within `room`, braking share * amax
        ab = share * amax * dt
        return ab * (np.sqrt(2 * room / (ab * dt) + .25) - .5)

    for f in range(F):
        if f == 0 or period2[f] != period2[f - 1]:
            pos, vel = tgt[f].copy(), np.zeros((N, 2))
        elif entered[f - 1].any():
            pos[entered[f - 1]], vel[entered[f - 1]] = bench, 0.0
        out[f] = pos
        gap = tgt[f] - pos
        d = np.maximum(np.hypot(gap[:, 0], gap[:, 1]), 1e-9)
        # never faster than lets him stop at the target with the braking available
        sp = np.minimum(np.minimum(vmax[f], K_GAIN * d), stop_speed(d, .8))
        want = gap * (sp / d)[:, None]
        # brake in time for the touchlines and bylines too (a moving target can pull him there);
        # half the cap only, the rest is left for turning
        lo, hi = -stop_speed(np.maximum(pos - .2, 0), .5), stop_speed(np.maximum([L - .2, W - .2] - pos, 0), .5)
        want = np.clip(want, lo, hi)
        dv = want - vel
        # braking for a line comes first; turning and the rest share what is left of the cap
        budget = amax * dt
        over = (vel > hi) | (vel < lo)
        dv_wall = np.where(over, dv, 0.0)
        aw = np.hypot(dv_wall[:, 0], dv_wall[:, 1])
        dv_wall *= np.minimum(1.0, budget / np.maximum(aw, 1e-9))[:, None]
        rem = np.sqrt(np.maximum(budget ** 2 - (dv_wall ** 2).sum(1), 0))
        dv_rest = np.where(over, 0.0, dv)
        a = np.hypot(dv_rest[:, 0], dv_rest[:, 1])
        vel = vel + dv_wall + dv_rest * np.minimum(1.0, rem / np.maximum(a, 1e-9))[:, None]
        new = np.clip(pos + vel * dt, [0.0, 0.0], [L, W])
        vel = (new - pos) / dt
        pos = new
    return out
