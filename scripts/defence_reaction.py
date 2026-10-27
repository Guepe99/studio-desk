"""Does the defending team in a replay export react to the ball? Numbers for docs/awareness3d.md.

    .venv/bin/python scripts/defence_reaction.py [match_id]     (reads web/data/<match_id>/)

Every measure is printed twice: on the real tracking, and on a control where the ball is taken
from 5 minutes later. A team that reacts to the ball shows a clear gap between the two.
"""
import json
import sys
from pathlib import Path

import numpy as np

L, W = 105.0, 68.0


def load(match_id):
    base = Path(__file__).resolve().parent.parent / "web" / "data" / match_id
    meta = json.loads((base / "meta.json").read_text())
    events = json.loads((base / "events.json").read_text())
    pos = np.fromfile(base / "tracking.f32", "<f4").reshape(meta["frames"], len(meta["entities"]), 3)
    return meta, events, pos


def measures(meta, events, pos, ball):
    fps, F = meta["fps"], meta["frames"]
    ts = np.arange(F) / fps
    team_of = {p: p.split("-")[0] for p in meta["entities"][1:]}  # player_id is <team_id>-<shirt>
    gk = {p["player_id"] for p in meta["players"] if p["position"] == "GK"}
    ents = meta["entities"][1:]
    home = next(t["team_id"] for t in meta["teams"] if t["side"] == "home")
    # team in possession: the team of the last event (only open-play frames, 1 s after it at most 10 s)
    ets = np.array([e["ts"] for e in events])
    k = np.searchsorted(ets, ts, "right") - 1
    ok = (k >= 0) & (k + 1 < len(events))
    k = np.clip(k, 0, len(events) - 1)
    poss = np.array([events[i]["team_id"] for i in k])
    nxt = np.array([events[min(i + 1, len(events) - 1)]["ts"] for i in k])
    ok &= (nxt - ets[k] < 10) & (np.array([events[i]["period"] for i in k]) ==
                                 np.array([events[min(i + 1, len(events) - 1)]["period"] for i in k]))
    xy = pos[:, 1:, :2]
    bxy = ball[:, :2]
    is_home = np.array([team_of[p] == home for p in ents])
    is_gk = np.array([p in gk for p in ents])
    p2 = ts >= meta["period1_s"]
    out = {}
    near_d, cy, by, line, bdist, facing, near_n, run_d, run_close, cf = [], [], [], [], [], [], 0, [], [], []
    vel = np.zeros_like(xy)
    vel[2:-2] = (xy[4:] - xy[:-4]) / (4 / fps)
    for f in range(0, F, 2):
        if not ok[f]:
            continue
        att_home = poss[f] == home
        defn = (is_home != att_home) & ~is_gk & ~np.isnan(xy[f, :, 0])
        att = (is_home == att_home) & ~np.isnan(xy[f, :, 0])
        da = np.hypot(*(xy[f] - bxy[f]).T)
        # carrier: an attacker within 1.5 m of the ball
        ca = np.where(att & (da < 1.5))[0]
        if len(ca):
            c = ca[np.argmin(da[ca])]
            dd = np.hypot(*(xy[f, defn] - xy[f, c]).T)
            near_d.append(dd.min())
            # an attack on the defence: the carrier runs at the defending goal, within 35 m of it
            own0c = (not att_home) != p2[f]
            gxc = 0.0 if own0c else L
            vc = vel[f, c]
            if abs(xy[f, c, 0] - gxc) < 35 and vc[0] * (gxc - xy[f, c, 0]) / max(abs(gxc - xy[f, c, 0]), 1e-6) > 3:
                dn = np.where(defn)[0][np.argmin(dd)]
                to_c = xy[f, c] - xy[f, dn]
                run_d.append(dd.min())
                run_close.append(vel[f, dn] @ to_c / max(np.hypot(*to_c), 1e-6))   # < 0: he drops off
        # block: centroid of the defending outfield players across the pitch, and the back line
        cy.append(np.nanmean(xy[f, defn, 1]))
        cf.append(f)
        by.append(bxy[f, 1])
        # defending team's own goal: home defends x = 0 in period 1
        own0 = (not att_home) != p2[f]   # True when the defending team defends x = 0
        gx = 0.0 if own0 else L
        depth = np.abs(xy[f, defn, 0] - gx)
        line.append(np.sort(depth)[:4].mean())
        bdist.append(abs(bxy[f, 0] - gx))
        # defenders within 15 m of the ball: does their direction of travel point at the ball?
        for p in np.where(defn & (da < 15))[0]:
            v = vel[f, p]
            sp = np.hypot(*v)
            near_n += 1
            if sp < 0.7:
                continue
            to_b = bxy[f] - xy[f, p]
            cosang = (v @ to_b) / (sp * max(np.hypot(*to_b), 1e-6))
            facing.append(cosang)
    near_d, cy, by, line, bdist, facing = map(np.array, (near_d, cy, by, line, bdist, facing))
    out["carrier frames"] = len(near_d)
    out["nearest defender to carrier, median m"] = np.median(near_d)
    out["nearest defender to carrier, p10 / p90 m"] = (np.percentile(near_d, 10), np.percentile(near_d, 90))
    out["share of carrier frames with a defender within 2 m"] = (near_d < 2).mean()
    out["share within 5 m"] = (near_d < 5).mean()
    out["attack runs (carrier > 3 m/s at goal, inside 35 m): frames"] = len(run_d)
    if run_d:
        out["  nearest defender distance, median m"] = float(np.median(run_d))
        out["  nearest defender's speed towards the carrier, median m/s (< 0 drops off)"] = float(np.median(run_close))
    sl = np.polyfit(by, cy, 1)[0]
    out["block shift: slope of defending centroid y on ball y"] = sl
    out["block shift: correlation"] = np.corrcoef(by, cy)[0, 1]
    out["line height: slope of back-four depth on ball depth"] = np.polyfit(bdist, line, 1)[0]
    out["line height: correlation"] = np.corrcoef(bdist, line)[0, 1]
    out["line height: median back-four depth m"] = np.median(line)
    out["defenders within 15 m of the ball, moving > 0.7 m/s"] = f"{len(facing)} of {near_n} samples"
    out["  share travelling within 30 deg of the ball direction"] = (facing > np.cos(np.radians(30))).mean()
    out["  share travelling more than 90 deg away (back to the ball if facing = travel)"] = (facing < 0).mean()
    return out, cy, by, np.array(cf)


def lag(frames, cy, by, fps, step=2, max_s=12.0):
    """Seconds by which the block's sideways shift trails the ball (best cross-correlation). The samples are
    placed back on their frames, so a stretch skipped out of open play is a gap, never a shorter lag."""
    n = int(max(frames)) + 1
    a, b = np.full(n, np.nan), np.full(n, np.nan)
    a[frames], b[frames] = cy, by

    def corr(s):  # the block at frame f against the ball at frame f - s, where both were sampled
        x, y = a[s:], b[:n - s]
        both = ~np.isnan(x) & ~np.isnan(y)
        return np.corrcoef(x[both], y[both])[0, 1] if both.sum() > 2 else -np.inf
    return max(range(0, int(max_s * fps), step), key=corr) / fps


def main():
    match_id = sys.argv[1] if len(sys.argv) > 1 else "M001"
    meta, events, pos = load(match_id)
    real, cy, by, cf = measures(meta, events, pos, pos[:, 0])
    ctrl, *_ = measures(meta, events, pos, np.roll(pos[:, 0], -300 * meta["fps"], axis=0))
    print(f"{match_id}: real tracking | control (ball from 5 min later)")
    for k, v in real.items():
        fmt = lambda x: (f"{x:.2f}" if isinstance(x, float) else
                         " / ".join(f"{y:.2f}" for y in x) if isinstance(x, tuple) else str(x))  # noqa: E731
        print(f"  {k}: {fmt(v)} | {fmt(ctrl.get(k, '-'))}")
    print(f"  block shift lag behind the ball: {lag(cf, cy, by, meta['fps']):.1f} s")
    # self-check: the control must look like a team that does not react
    assert abs(ctrl["block shift: correlation"]) < real["block shift: correlation"]


if __name__ == "__main__":
    main()
