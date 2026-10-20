"""Measures of the system for the replay matches, written to docs/MEASURES.md (evaluation only).

    .venv/bin/python scripts/measures.py [--runtime-dir out] [--out docs/MEASURES.md] [M001 M002 ...]

Reads, per match: the AI pack `replays/<match>/stories.json`, the runtime database of the run that
made it (`<runtime-dir>/runtime15-<match>.sqlite`: traces and audit) and, for the first measure only,
the hidden `storylines` table of `data/matches.sqlite` (`STUDIODESK_MATCHES_DB` overrides it). Like
scripts/eval_stories.py, this is an evaluation script: agents, the MCP server and the API never read
the storylines. Nothing is written but the markdown page.
"""
import argparse
import json
import statistics
import sys
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from studiodesk import config, db, mcp_server  # noqa: E402
from studiodesk.agents import rules  # noqa: E402
import eval_stories  # noqa: E402

MATCHES = ["M001", "M002", "M003", "M004"]
RUNTIME = "runtime15-{}.sqlite"  # the run of out/regen15.sh that made the committed packs
# out/live1x.sh: M001 from 5:00 to 20:00 at real speed; the start file holds the wall time it was launched
LIVE = {"match": "M001", "runtime": "live1x-M001.sqlite", "start": "live1x-start.txt", "from_ts": 300.0, "to_ts": 1200.0, "speed": 1.0}

# The verifier's fixed reasons (rules.REASONS) that block a number, and the one that blocks a name.
# Spacing ("unit glued to a number") and fact ids from another moment are not counted as numbers.
NUMBER_REASONS = {rules.REASONS[k] for k in (
    "number not in the facts", "number in words", "garbled numbers", "formation not in the facts",
    "unit not in the facts", "letters glued to a number", "unit mismatch")}
NAME_REASONS = {rules.REASONS["forbidden name (real person or club)"]}


def storylines_found(storylines, stories):
    """(found, planted): the matching rule of scripts/eval_stories.py."""
    rows = eval_stories.evaluate(storylines, stories)
    return sum(bool(r["found_by"]) for r in rows), len(rows)


def note_reasons(note):
    """'Earlier Italian draft: a; b.' -> {'a', 'b'} (the notes are built from rules.REASONS)."""
    return {r.strip().rstrip(".") for r in note.split(": ", 1)[-1].split(";")}


def blocked(stories):
    """Drafts (one story in one language) the verifier sent back or dropped for a number or a name."""
    out = {"numbers": 0, "names": 0}
    for s in stories:
        for note in (s.get("verifier") or {}).get("flagged") or []:
            reasons = note_reasons(note)
            out["numbers"] += bool(reasons & NUMBER_REASONS)
            out["names"] += bool(reasons & NAME_REASONS)
    return out


def on_air(stories):
    """Who wrote the text on air, and the AI lines that passed every check but stayed on the desk."""
    out = {"stories": len(stories), "phrasebook": 0, "template": 0, "ai": 0, "proposals": 0}
    for s in stories:
        v = s.get("verifier") or {}
        out[v.get("on_air") if v.get("on_air") in ("phrasebook", "template") else "ai"] += 1
        out["proposals"] += bool(v.get("proposals"))
    return out


def usage(audit, traces):
    """Model calls, tokens and cost: from audit (one row per model call) and as the traces add them up."""
    calls = [a for a in audit if a["action"] == "model_call"]
    return {"calls": len(calls), "tokens_in": sum(a["tokens_in"] for a in calls),
            "tokens_out": sum(a["tokens_out"] for a in calls), "cost_usd": sum(a["cost_usd"] for a in calls),
            "model_s": sum(json.loads(a["detail"]).get("latency_ms", 0) for a in calls) / 1000,
            "trace_tokens": sum(t["tokens_in"] + t["tokens_out"] for t in traces),
            "trace_cost_usd": sum(t["cost_usd"] for t in traces)}


def at(s):
    return datetime.fromisoformat(s).timestamp()


def timing(traces, stories):
    """Per round (the hand-offs that share a match time ts): wall seconds from the start of its first
    model call to the director's cues; per story: match seconds from its event to that round."""
    rounds, by_id = {}, {s["story_id"]: s for s in stories}
    for t in sorted(traces, key=lambda t: t["seq"]):
        rounds.setdefault(t["ts"], []).append(t)
    walls, waits = [], []
    for ts, rs in rounds.items():
        cue = [t for t in rs if t["agent"] == "director"]
        if not cue:
            continue
        walls.append(at(cue[-1]["at"]) - (at(rs[0]["at"]) - rs[0]["latency_ms"] / 1000))
        sids = json.loads(rs[0]["story_ids"]) if isinstance(rs[0]["story_ids"], str) else rs[0]["story_ids"]
        waits += [(by_id[i]["kind"], ts - by_id[i]["ts"]) for i in sids or [] if i in by_id]
    return {"rounds": len(walls), "walls": walls, "wall_median_s": statistics.median(walls), "wall_max_s": max(walls),
            "waits": waits, "wall_total_s": sum(walls)}


def live_delay(traces, stories, start_s, from_ts, speed):
    """(kind, seconds) per story of a real-speed run: wall time from its event, as the clock released it,
    to the director's cues. The clock starts after start_s, so these are upper bounds."""
    by_id, out = {s["story_id"]: s for s in stories}, []
    # each cue trace names its own stories: live, a round's AI tail traces later, among the next rounds
    for t in (t for t in traces if t["agent"] == "director"):
        sids = json.loads(t["story_ids"]) if isinstance(t["story_ids"], str) else t["story_ids"]
        out += [(by_id[i]["kind"], at(t["at"]) - (start_s + (by_id[i]["ts"] - from_ts) / speed))
                for i in sids or [] if i in by_id]
    return out


def measure_live(runtime, start_file):
    if not (runtime.exists() and start_file.exists()):
        return None
    with closing(db.connect(runtime, readonly=True)) as rt:
        traces = [dict(r) for r in rt.execute("SELECT * FROM traces WHERE match_id = ?", (LIVE["match"],))]
        stories = [dict(r) for r in rt.execute("SELECT story_id, ts, kind FROM stories WHERE match_id = ?", (LIVE["match"],))]
        first = rt.execute("SELECT run_id FROM traces WHERE match_id = ? ORDER BY seq LIMIT 1", (LIVE["match"],)).fetchone()
    start = at(start_file.read_text().strip()[:26] + "+00:00")  # date -u +%N: nanoseconds, fromisoformat takes micro
    # the run id carries the second the workflow started (rounded down): the program's start-up before it is left out
    setup = max(datetime.strptime(first[0][2:16], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).timestamp() - start, 0.0) if first else 0.0
    delays = live_delay(traces, stories, start + setup, LIVE["from_ts"], LIVE["speed"])
    return {"delays": delays, "setup_s": setup} if delays else None


def measure(match_id, pack, runtime, mconn):
    stories = json.loads((pack / "stories.json").read_text())
    with closing(db.connect(runtime, readonly=True)) as rt:
        audit = [dict(r) for r in rt.execute("SELECT * FROM audit WHERE match_id = ?", (match_id,))]
        traces = [dict(r) for r in rt.execute("SELECT * FROM traces WHERE match_id = ?", (match_id,))]
    storylines = [dict(r) for r in mconn.execute(
        "SELECT story_id, kind, ts_start, ts_end, team_id, player_id FROM storylines WHERE match_id = ?", (match_id,))]
    p1, p2 = mconn.execute("SELECT period1_s, period2_s FROM matches WHERE match_id = ?", (match_id,)).fetchone()
    found, planted = storylines_found(storylines, stories)
    return {"match_id": match_id, "found": found, "planted": planted, "minutes": (p1 + p2) / 60,
            **blocked(stories), **on_air(stories), **usage(audit, traces), **timing(traces, stories)}


def total(rows):
    keys = ("found", "planted", "numbers", "names", "stories", "phrasebook", "template", "ai", "proposals",
            "calls", "tokens_in", "tokens_out", "cost_usd", "model_s", "trace_tokens", "trace_cost_usd",
            "rounds", "minutes", "wall_total_s")
    return {k: sum(r[k] for r in rows) for k in keys}


def live_section(live):
    if live is None:
        return f"""Not measured: no real-speed run was found (`out/{LIVE['runtime']}`)."""
    goals = [w for k, w in live["delays"] if k == "goal"]
    chances = [w for k, w in live["delays"] if k == "big_chance"]
    rest = [w for k, w in live["delays"] if k not in ("goal", "big_chance")]
    def secs(ws):
        ws = [f"{w:.1f}" for w in ws]
        return " and ".join([", ".join(ws[:-1]), ws[-1]] if len(ws) > 1 else ws)
    said = [f"The {'goal' if len(goals) == 1 else f'{len(goals)} goals'} reached the director's cue {secs(goals)} "
            "seconds after the shot" if goals else "No goal was scored"]
    if chances:
        said.append(f"the {'big chance' if len(chances) == 1 else f'{len(chances)} big chances'} after {secs(chances)} seconds, "
                    "judged once the play had settled for a few seconds")
    if rest:
        said.append(f"the other {'story' if len(rest) == 1 else f'{len(rest)} stories'} after {secs(rest)} seconds, because a story that is not urgent waits on "
                    "purpose for the end of its window to be told with the others")
    return f"""Measured on a real-speed run (`python -m studiodesk.agents run {LIVE['match']} --speed 1 --from-ts
{LIVE['from_ts']:.0f} --to-ts {LIVE['to_ts']:.0f}`): {LIVE['match']} from minute {LIVE['from_ts'] / 60:.0f} to minute
{LIVE['to_ts'] / 60:.0f}, on Azure, the way the desk runs live. {'; '.join(said)}. These are upper bounds: they
count from the second the workflow began, as its run id records it, before the match clock started; the
program's start-up before that, {live['setup_s']:.1f} seconds, is left out. A story that needs a producer then waits for one; a story the director lets
air by itself is on screen at that moment."""


def markdown(rows, live=None):
    t = total(rows)
    n = len(rows)
    head = ("| match | storylines found | numbers blocked | names blocked | on air: phrasebook / template / AI "
            "| proposals on the desk | model calls | tokens in / out | cost (USD) | round, median / max (s) "
            "| model time per match minute (s) |")
    lines = [head, "|" + "---|" * (head.count("|") - 1)]
    for r in rows:
        lines.append(f"| {r['match_id']} | {r['found']} of {r['planted']} | {r['numbers']} | {r['names']} "
                     f"| {r['phrasebook']} / {r['template']} / {r['ai']} | {r['proposals']} | {r['calls']} "
                     f"| {r['tokens_in']:,} / {r['tokens_out']:,} | {r['cost_usd']:.3f} "
                     f"| {r['wall_median_s']:.1f} / {r['wall_max_s']:.1f} | {r['model_s'] / r['minutes']:.1f} |")
    lines.append(f"| all | {t['found']} of {t['planted']} | {t['numbers']} | {t['names']} "
                 f"| {t['phrasebook']} / {t['template']} / {t['ai']} | {t['proposals']} | {t['calls']} "
                 f"| {t['tokens_in']:,} / {t['tokens_out']:,} | {t['cost_usd']:.3f} | | "
                 f"{t['model_s'] / t['minutes']:.1f} |")
    walls = [w for r in rows for w in r["walls"]]
    waits = [w for r in rows for w in r["waits"]]
    goal_max = max((w for k, w in waits if k == "goal"), default=0.0)
    over = t["trace_tokens"] / (t["tokens_in"] + t["tokens_out"])
    traces_note = ("The traces of the agent steps add up to the same tokens." if over == 1 else
                   f"The traces of the agent steps add up to {over:.3f} times those tokens (${t['trace_cost_usd']:.3f}), "
                   "so they do not match the audit, which is the figure to quote.")
    return f"""# Measures

What the system did on the {n} replay matches ({", ".join(r["match_id"] for r in rows)}), computed by
`scripts/measures.py` from the committed AI packs (`replays/<match>/stories.json`) and the runtime
databases of the run that made them (`out/runtime15-<match>.sqlite`, traces and audit). Rerun the
script after a regeneration; every number below comes from it.

{chr(10).join(lines)}

## Hidden storylines found

The simulator plants storylines the agents are never shown (a tactical shift, a spell of high
pressing, a top sprint, a comeback). The agents found {t['found']} of the {t['planted']} planted, with the
rule of `scripts/eval_stories.py`: a story of the matching kind, for the same team (and the same
player, when the storyline names one), within 60 seconds of the storyline. Only this evaluation reads the hidden table.

## Numbers and names blocked by the verifier

Counted from the verifier's notes on each story: one count is one draft (a story in one language)
whose earlier versions the verifier sent back, or dropped, because of a number (not in the fact
ledger, written in words, with the wrong unit or letters stuck to it, a formation the facts do not
give). Spacing slips and fact ids from another moment are not counted. {t['numbers']} drafts were
blocked for a number and {t['names']} for a real person's or club's name. A draft rewritten twice for the
same reason counts once, so these are lower bounds.

## Phrasebook on air, proposals on the desk

Every one of the {t['stories']} stories went on air with code-written text: {t['phrasebook']} from the
commentator phrasebook, {t['template']} from the fact-only template, {t['ai']} with the AI's own line. In
{t['proposals']} stories the AI's line passed every check in all three languages and waits on the desk as
a proposal; it goes on air only when a person edits the story.

## Tokens and cost

{t['calls']} model calls used {t['tokens_in']:,} input and {t['tokens_out']:,} output tokens, ${t['cost_usd']:.3f} in all
(${t['cost_usd'] / n:.3f} a match), counted from the audit table, one row per model call. {traces_note}
The Content Safety checks (one call per story,
{t['stories']} in all) are recorded in neither table and are not counted.

## Delay from event to graphic

{live_section(live)}

The regenerations behind the replays ran with `--speed 0`, so the match clock did not wait for
real time, and the replay places each graphic at its story's moment in the match, not where the
round ended. What their traces measure:
a round (story finder, director, analyst, three commentators, verifier, rewrites) took
{statistics.median(walls):.1f} seconds of wall time at the median, at most {max(walls):.1f} seconds; the {t['rounds']} rounds took {t['wall_total_s'] / t['minutes']:.1f} seconds of wall time per minute
of match. Model calls added up to {t['model_s'] / t['minutes']:.1f} seconds per minute of match (calls in
parallel counted each). Before a round starts, the workflow waits for its trigger: the story's event
was a median of {statistics.median(w for _, w in waits):.1f} seconds of match time before its round (goals at most
{goal_max:.1f} seconds, other stories at most {max(w for _, w in waits):.1f} seconds).
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("matches", nargs="*", default=MATCHES)
    ap.add_argument("--runtime-dir", type=Path, default=config.ROOT / "out")
    ap.add_argument("--replays", type=Path, default=config.ROOT / "replays")
    ap.add_argument("--out", type=Path, default=config.ROOT / "docs" / "MEASURES.md")
    a = ap.parse_args()
    with closing(db.connect(mcp_server.DB_PATH, readonly=True)) as mconn:
        rows = [measure(m, a.replays / m, a.runtime_dir / RUNTIME.format(m), mconn) for m in a.matches]
    live = measure_live(a.runtime_dir / LIVE["runtime"], a.runtime_dir / LIVE["start"])
    a.out.write_text(markdown(rows, live))
    print(a.out.read_text())


if __name__ == "__main__":
    main()
