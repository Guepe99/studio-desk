"""The season before the replays (docs/CONTRACT.md, Season additions).

A double round robin of the same clubs: the replayed matches M001..M00n are one matchweek
(REPLAY_MATCHWEEK), and every matchweek before it is played here by the same event engine, events
only (no tracking). Each pairing of the replays met once before, in the first leg, with home and away
swapped. Its own random stream: the replayed matches come out exactly as without a season.
"""
import numpy as np

from .engine import SHOT_TYPES, Engine, Team, plan_match

REPLAY_MATCHWEEK = 10
SEASON_STREAM = 2026  # second word of the season's seed: [seed, SEASON_STREAM]


def schedule(rng, n_teams):
    """[(matchweek, home, away)] for matchweeks 1..REPLAY_MATCHWEEK-1, clubs as indices 0..n-1. In the
    replays' matchweek club 2k is at home to club 2k+1 (build.simulate pairs them so)."""
    m = n_teams - 1
    reverse = REPLAY_MATCHWEEK - m  # the first-leg week of the replays' pairings
    if not 1 <= reverse <= m:
        raise ValueError(f"matchweek {REPLAY_MATCHWEEK} is not in the second leg of {n_teams} clubs")
    # circle method: round r pairs m with r and r+k with r-k; relabel so round 0 is the replays' pairing
    rounds = [[(m, r)] + [((r + k) % m, (r - k) % m) for k in range(1, n_teams // 2)] for r in range(m)]
    label = {}
    for j, (a, b) in enumerate(rounds[0]):
        label[a], label[b] = 2 * j, 2 * j + 1
    rounds = [[(label[a], label[b]) for a, b in rd] for rd in rounds]
    first = {reverse: [(b, a) for a, b in rounds[0]]}  # the replays' home clubs played away then
    weeks = [w for w in range(1, m + 1) if w != reverse]
    for w, r in zip(weeks, (int(x) + 1 for x in rng.permutation(m - 1))):
        first[w] = [(a, b) if rng.random() < .5 else (b, a) for a, b in rounds[r]]
    out = []
    for w in range(1, REPLAY_MATCHWEEK):
        pairs = first[w] if w <= m else [(b, a) for a, b in first[w - m]]
        out += [(w, h, a) for h, a in pairs]
    return out


def simulate_season(league, cal, seed, n_replays, minutes=None):
    """Rows of season_matches and season_goals, or None when the replays are not one whole matchweek."""
    from .build import timeline  # build imports this module
    teams, players, _ = league
    if 2 * n_replays != len(teams):
        return None
    rng = np.random.default_rng([seed, SEASON_STREAM])
    squad = {t["team_id"]: [p for p in players if p["team_id"] == t["team_id"]] for t in teams}
    matches, goals = [], []
    for k, (week, h, a) in enumerate(schedule(rng, len(teams)), 1):
        sid, mseed = f"SM-{k:03d}", int(rng.integers(2**31))
        r = np.random.default_rng(mseed)
        home, away = (Team(teams[i]["team_id"], squad[teams[i]["team_id"]], ("4-4-2", "4-3-3")[int(r.integers(2))], i == h)
                      for i in (h, a))
        periods = (minutes * 60.0, minutes * 60.0) if minutes else \
            (round(r.uniform(45.3, 47.0) * 60, 1), round(r.uniform(46.0, 48.0) * 60, 1))
        ev = Engine(r, cal, home, away, plan_match(r, cal, home, away, periods, False), periods).play()
        ts, _, _ = timeline(ev, periods)
        score, n = {home.id: 0, away.id: 0}, 0
        for e, t in zip(ev, ts):
            own = e["result_name"] == "owngoal"
            if not own and not (e["type_name"] in SHOT_TYPES and e["result_name"] == "success"):
                continue
            team = e["team_id"] if not own else (away.id if e["team_id"] == home.id else home.id)
            score[team] += 1
            n += 1
            t_in = float(t) - (periods[0] if e["period"] == 2 else 0.0)
            goals.append((sid, n, int(t_in // 60) + (45 if e["period"] == 2 else 0) + 1, team, e["player_id"], int(own)))
        matches.append((sid, week, home.id, away.id, score[home.id], score[away.id], mseed))
    return dict(matches=matches, goals=goals)


def write_season(conn, season, replay_ids):
    conn.executemany("INSERT INTO season_matches VALUES (?,?,?,?,?,?,?)", season["matches"])
    conn.executemany("INSERT INTO season_goals VALUES (?,?,?,?,?,?)", season["goals"])
    conn.executemany("INSERT INTO season_fixtures VALUES (?,?)", [(m, REPLAY_MATCHWEEK) for m in replay_ids])
    conn.commit()
