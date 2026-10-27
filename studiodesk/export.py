"""Static replay export (docs/CONTRACT.md, Replay export).

`python -m studiodesk.export M001` writes `web/data/M001/`. Stories, cues and traces come from
runtime.sqlite when it has cues for the match; otherwise a template cue sheet is built from the
fact ledger alone (no AI) and stories.json / traces.json are `[]`.

Template `pass_shot.quality` is display text: "Difficulty 8.1/10" for a pass, "Goal" or
"No goal" for a shot. Every number in a template cue comes from a fact listed in its fact_ids.
"""
import argparse
import json
from contextlib import closing
from pathlib import Path

from . import config, db
from .facts.engine import half_up

DURATION = {"nameplate": 6.0, "pass_shot": 6.0, "momentum": 8.0, "why_card": 12.0}
TOP_SPRINTS = {"analyst": 5, "casual": 3}
HARDEST_PASSES = 5


def _all(conn, sql, args=()):
    return [dict(r) for r in conn.execute(sql, args)]


def _parsed(rows, *cols):
    for r in rows:
        for c in cols:
            r[c] = json.loads(r[c]) if r[c] is not None else None
    return rows


def _dump(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, allow_nan=False, separators=(",", ":")))


def meta(conn, match_id):
    m = _all(conn, "SELECT * FROM matches WHERE match_id = ?", (match_id,))
    if not m:
        raise SystemExit(f"unknown match {match_id}")
    m = m[0]
    sides = {m["home_team_id"]: "home", m["away_team_id"]: "away"}
    teams = _all(conn, "SELECT team_id, name, short_name, color_primary, color_secondary, crest_svg FROM teams "
                 "WHERE team_id IN (?, ?)", tuple(sides))
    teams.sort(key=lambda t: sides[t["team_id"]] != "home")
    return {"match_id": match_id, "venue_name": m["venue_name"], "fps": m["fps"], "period1_s": m["period1_s"],
            "period2_s": m["period2_s"],
            "frames": conn.execute("SELECT count(*) FROM tracking_frames WHERE match_id = ?", (match_id,)).fetchone()[0],
            "home_score": m["home_score"], "away_score": m["away_score"],
            "teams": [{**t, "side": sides[t["team_id"]]} for t in teams],
            "players": _all(conn, "SELECT p.player_id, p.team_id, p.name, p.shirt, p.position FROM players p "
                            "JOIN lineups l USING (player_id) WHERE l.match_id = ? ORDER BY p.team_id, p.shirt",
                            (match_id,)),
            "lineups": _all(conn, "SELECT player_id, starter, on_ts, off_ts FROM lineups WHERE match_id = ? "
                            "ORDER BY player_id", (match_id,)),
            "entities": [r[0] for r in conn.execute(
                "SELECT entity FROM tracking_entities WHERE match_id = ? ORDER BY idx", (match_id,))]}


def recap(match, facts, cp, title):
    """Half-time or full-time why_card payload at cp, from score, pass accuracy, sprint and distance facts."""
    home, away = (t["team_id"] for t in match["teams"])
    short = {t["team_id"]: t["short_name"] for t in match["teams"]}
    players = {p["player_id"]: p for p in match["players"]}
    by_kind = {}
    for f in facts:
        by_kind.setdefault(f["kind"], []).append(f)
    used, parts = [], []
    goals = [f for f in by_kind.get("score", []) if f["ts"] <= cp]
    h = max((f["value"] for f in goals if f["team_id"] == home), default=0)
    a = max((f["value"] for f in goals if f["team_id"] == away), default=0)
    used += [f["fact_id"] for f in goals]
    parts.append(f"{short[home]} {h:.0f}-{a:.0f} {short[away]}.")
    acc = {f["team_id"]: f for f in by_kind.get("pass_accuracy", []) if f["ts"] == cp and f["player_id"] is None}
    if home in acc and away in acc:
        parts.append(f"Pass accuracy: {short[home]} {half_up(acc[home]['value'])}%, {short[away]} {half_up(acc[away]['value'])}%.")
        used += [acc[home]["fact_id"], acc[away]["fact_id"]]
    sprints = [f for f in by_kind.get("sprint_speed", []) if f["ts"] <= cp]
    if sprints:
        top = max(sprints, key=lambda f: f["value"])
        parts.append(f"Fastest sprint: {players.get(top['player_id'], {}).get('name')}, {top['value']:.1f} km/h.")
        used.append(top["fact_id"])
    dist = [f for f in by_kind.get("distance_covered", []) if f["ts"] == cp]
    if dist:
        top = max(dist, key=lambda f: f["value"])
        parts.append(f"Most ground covered: {players.get(top['player_id'], {}).get('name')}, "
                     f"{half_up(top['value'] / 1000 * 10) / 10:.1f} km.")  # as the label and the booth round it
        used.append(top["fact_id"])
    return {"kind": "recap", "title": title, "body": " ".join(parts), "fact_ids": used}


def template_cues(match, facts, events):
    """Cue sheet from facts only, audiences analyst and casual, at most 2 overlapping per audience."""
    from .agents import audiences
    home, away = (t["team_id"] for t in match["teams"])
    short = {t["team_id"]: t["short_name"] for t in match["teams"]}
    players = {p["player_id"]: p for p in match["players"]}
    p1, end = match["period1_s"], match["period1_s"] + match["period2_s"]
    by_kind = {}
    for f in facts:
        by_kind.setdefault(f["kind"], []).append(f)
    by_event = {}
    for f in facts:
        if len(f["source_event_ids"]) == 1:
            by_event.setdefault((f["kind"], f["source_event_ids"][0]), f)
    result = {e["event_id"]: e["result_name"] for e in events}

    def nameplate(f):
        p = players.get(f["player_id"], {})
        return {"player_id": f["player_id"], "name": p.get("name"), "shirt": p.get("shirt"),
                "team_short": short.get(f["team_id"]), "speed_kmh": f["value"], "fact_id": f["fact_id"]}

    def shot(f):
        eid = f["source_event_ids"][0]
        goal = by_event.get(("score", eid))
        return {"mode": "shot", "player_id": f["player_id"], "value": f["value"], "unit": f["unit"],
                "quality": "Goal" if goal else "No goal",
                "fact_ids": [f["fact_id"]] + ([goal["fact_id"]] if goal else [])}

    def pass_(f):
        eid = f["source_event_ids"][0]
        dist = by_event[("pass_distance", eid)]
        extra = [g["fact_id"] for g in (by_event.get(("ball_speed", eid)),) if g]
        return {"mode": "pass", "player_id": f["player_id"], "value": dist["value"], "unit": dist["unit"],
                "quality": f"Difficulty {f['value']:.1f}/10", "fact_ids": [dist["fact_id"], f["fact_id"], *extra]}

    momentum = sorted(by_kind.get("momentum", []), key=lambda f: f["ts"])
    window_ends = sorted({f["ts"] for f in momentum})
    cues = []
    for audience in ("analyst", "casual"):
        cands = [(0, p1, "why_card", recap(match, facts, p1, "Half-time")), (0, end, "why_card", recap(match, facts, end, "Full time"))]
        # a goal's shot cue waits for the score fact: "Goal" only once the ball is in
        cands += [(1, max(f["ts"], by_event.get(("score", f["source_event_ids"][0]), f)["ts"]), "pass_shot", shot(f))
                  for f in by_kind.get("shot_speed", [])]
        sprints = sorted(by_kind.get("sprint_speed", []), key=lambda f: -f["value"])[:TOP_SPRINTS[audience]]
        cands += [(2, f["ts"], "nameplate", nameplate(f)) for f in sprints]
        if audience == "analyst":
            for ts in window_ends:
                cands.append((3, ts, "momentum", audiences.momentum_payload(momentum, ts, home, away)))
            ok = [f for f in by_kind.get("pass_difficulty", []) if result.get(f["source_event_ids"][0]) == "success"]
            for f in sorted(ok, key=lambda f: -f["value"])[:HARDEST_PASSES]:
                cands.append((4, f["ts"], "pass_shot", pass_(f)))
        shown = []
        for _, ts, graphic, payload in sorted(cands, key=lambda c: (c[0], c[1])):
            dur = DURATION[graphic]
            # conservative: reject when 2 accepted cues overlap this one, so at most 2 are ever on screen
            if sum(c["ts"] < ts + dur and ts < c["ts"] + c["duration_s"] for c in shown) < 2:
                shown.append({"match_id": match["match_id"], "story_id": None, "ts": ts, "duration_s": dur,
                              "graphic": graphic, "audience": audience, "lang": "en", "payload": payload})
        cues += shown
    cues.sort(key=lambda c: (c["ts"], c["audience"]))
    return [{"cue_id": f"C-{i:06d}", **c} for i, c in enumerate(cues, 1)]


def export(match_id, conn, out_root, runtime=None):
    out = Path(out_root) / match_id
    out.mkdir(parents=True, exist_ok=True)
    m = meta(conn, match_id)
    events = _all(conn, "SELECT * FROM events WHERE match_id = ? ORDER BY ts, event_id", (match_id,))
    facts = _parsed(_all(conn, "SELECT * FROM facts WHERE match_id = ? ORDER BY ts, fact_id", (match_id,)),
                    "source_event_ids", "source_frames")
    has_runtime = runtime is not None and runtime.execute(
        "SELECT 1 FROM cues WHERE match_id = ? LIMIT 1", (match_id,)).fetchone()
    if has_runtime:
        stories, cues, traces = runtime_records(match_id, runtime)
    else:
        stories, traces, cues = [], [], template_cues(m, facts, events)
    from .agents import audiences  # every audience's line, the kids sheet and the player check-ins
    stories, cues = audiences.apply(m, facts, events, stories, cues)
    from . import forecast  # Watch for (docs/forecast.md)
    watch = forecast.export(conn, match_id)
    # everything is built before the first write: a failure above leaves the old folder as it was
    _dump(out / "meta.json", m)
    with open(out / "tracking.f32", "wb") as fh:
        for (blob,) in conn.execute("SELECT pos FROM tracking_frames WHERE match_id = ? ORDER BY frame", (match_id,)):
            fh.write(blob)
    _dump(out / "events.json", events)
    _dump(out / "facts.json", facts)
    _dump(out / "stories.json", stories)
    _dump(out / "cues.json", cues)
    _dump(out / "traces.json", traces)
    _dump(out / "forecast.json", watch)
    index(out_root)
    return out


def index(out_root):
    """matches.json: every replay exported next to this one, for the page's match picker. Team names only:
    the score would spoil the replay."""
    rows = []
    for p in sorted(Path(out_root).glob("*/meta.json")):
        m = json.loads(p.read_text())
        rows.append({"match_id": m["match_id"], "home": m["teams"][0]["name"], "away": m["teams"][1]["name"]})
    _dump(Path(out_root) / "matches.json", rows)


def runtime_records(match_id, runtime):
    """stories, cues and traces of one match from runtime.sqlite, JSON columns parsed."""
    q = "SELECT * FROM {} WHERE match_id = ? ORDER BY ts"
    stories = _parsed(_all(runtime, q.format("stories"), (match_id,)), "fact_ids", "evidence_event_ids",
                      "texts", "verifier")
    cues = _parsed(_all(runtime, q.format("cues"), (match_id,)), "payload")
    traces = _all(runtime, q.format("traces") + ", run_id, seq", (match_id,))
    traces = _parsed(traces, "fact_ids", *(["story_ids"] if traces and "story_ids" in traces[0] else []))
    return stories, cues, traces


def pack(match_id, runtime, out_dir, conn=None):
    """The AI replay pack: stories, cues and traces of a real run, committed under replays/<match_id>/
    and copied over the template export at image build. With the matches database `conn`, the audience
    lines, the kids sheet and the player check-ins are added (studiodesk.agents.audiences)."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for name, rows in zip(("stories", "cues", "traces"), runtime_records(match_id, runtime)):
        if not rows and name != "traces":
            raise SystemExit(f"no {name} for {match_id} in the runtime database")
        _dump(out / f"{name}.json", rows)
    if conn is not None:
        from .agents import audiences
        audiences.apply_pack(match_id, conn, out)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(prog="python -m studiodesk.export")
    ap.add_argument("match_id")
    ap.add_argument("--db", type=Path, default=config.MATCHES_DB)
    ap.add_argument("--out", type=Path, default=config.ROOT / "web" / "data")
    ap.add_argument("--runtime", type=Path, default=config.RUNTIME_DB, help="runtime.sqlite written by the agents")
    ap.add_argument("--pack", type=Path, help="write only stories, cues and traces from --runtime here (replays/M001)")
    args = ap.parse_args()
    if args.pack:
        with closing(db.connect(args.runtime, readonly=True)) as rt, closing(db.connect(args.db, readonly=True)) as conn:
            print(pack(args.match_id, rt, args.pack, conn))
        raise SystemExit(0)
    with closing(db.connect(args.db, readonly=True)) as conn:
        rt = db.connect(args.runtime, readonly=True) if args.runtime.exists() else None
        print(export(args.match_id, conn, args.out, rt))
        if rt:
            rt.close()
