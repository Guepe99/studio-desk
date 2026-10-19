"""Measures of the system for the replay matches, written to docs/MEASURES.md (evaluation only).

    .venv/bin/python scripts/measures.py [--runtime-dir out] [--out docs/MEASURES.md] [M001 M002 ...]

Reads, per match: the AI pack `replays/<match>/stories.json`, the runtime database of the run that
made it (`<runtime-dir>/runtime11-<match>.sqlite`: traces and audit) and, for the first measure only,
the hidden `storylines` table of `data/matches.sqlite` (`STUDIODESK_MATCHES_DB` overrides it). Like
scripts/eval_stories.py, this is an evaluation script: agents, the MCP server and the API never read
the storylines. Nothing is written but the markdown page.
"""
import argparse
import json
import statistics
import sys
from contextlib import closing
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from studiodesk import config, db, mcp_server  # noqa: E402
from studiodesk.agents import rules  # noqa: E402
import eval_stories  # noqa: E402

MATCHES = ["M001", "M002", "M003", "M004"]
RUNTIME = "runtime11-{}.sqlite"  # the run of out/regen11.sh that made the committed packs

# The verifier's fixed reasons (rules.REASONS) that block a number, and the one that blocks a name.
NUMBER_REASONS = {rules.REASONS[k] for k in (
    "number not in the facts", "number in words", "garbled numbers", "formation not in the facts",
    "unit not in the facts", "unit glued to a number", "letters glued to a number", "unit mismatch",
    "cited fact not in the story")}
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


def markdown(rows):
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
    return f"""# Measures

What the system did on the {n} replay matches ({", ".join(r["match_id"] for r in rows)}), computed by
`scripts/measures.py` from the committed AI packs (`replays/<match>/stories.json`) and the runtime
databases of the run that made them (`out/runtime11-<match>.sqlite`, traces and audit). Rerun the
script after a regeneration; every number below comes from it.

{chr(10).join(lines)}

## Hidden storylines found

The simulator plants storylines the agents are never shown (a tactical shift, a spell of high
pressing, a top sprint, a comeback). The agents found {t['found']} of the {t['planted']} planted, with the
rule of `scripts/eval_stories.py`: a story of the matching kind, for the same team and player,
within 60 seconds of the storyline. Only this evaluation reads the hidden table.

## Numbers and names blocked by the verifier

Counted from the verifier's notes on each story: one count is one draft (a story in one language)
whose earlier versions the verifier sent back, or dropped, because of a number (not in the fact
ledger, written in words, wrong unit, a formation the facts do not give). {t['numbers']} drafts were
blocked for a number and {t['names']} for a real person's or club's name. A draft rewritten twice for the
same reason counts once, so these are lower bounds.

## Phrasebook on air, proposals on the desk

Every one of the {t['stories']} stories went on air with code-written text: {t['phrasebook']} from the
commentator phrasebook, {t['template']} from the fact-only template, {t['ai']} with the AI's own line. In
{t['proposals']} stories the AI's line passed every check in all three languages and waits on the desk as
a proposal; it goes on air only when a person edits the story.

## Tokens and cost

{t['calls']} model calls used {t['tokens_in']:,} input and {t['tokens_out']:,} output tokens, ${t['cost_usd']:.3f} in all
(${t['cost_usd'] / n:.3f} a match), counted from the audit table, one row per model call. The traces
add up to {over:.2f} times as many tokens (${t['trace_cost_usd']:.3f}): the three commentators run at the
same time and each trace takes the difference of a shared counter, so it also counts the calls of the
others. The audit is the figure to quote; the traces need fixing. The Content Safety checks (one call per story,
{t['stories']} in all) are recorded in neither table and are not counted.

## Delay from event to graphic

Not measured. The regenerations ran with `--speed 0`, so the match clock did not wait for real
time, and the replay places each graphic at its story's moment in the match, not where the round
ended. What the traces do measure:
a round (story finder, analyst, three commentators, verifier, rewrites, director) took
{statistics.median(walls):.1f} seconds of wall time at the median, at most {max(walls):.1f} seconds; the {t['rounds']} rounds took {t['wall_total_s'] / t['minutes']:.1f} seconds of wall time per minute
of match. Model calls added up to {t['model_s'] / t['minutes']:.1f} seconds per minute of match (calls in
parallel counted each). Before a round starts, the desk waits for its trigger: the story's event
was a median of {statistics.median(w for _, w in waits):.1f} seconds of match time before its round (goals at most
{goal_max:.1f} seconds, other stories batched for up to {max(w for _, w in waits) / 60:.1f} minutes). At 1x a graphic would come
roughly that wait plus the round after its event; no 1x run has measured it.
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
    a.out.write_text(markdown(rows))
    print(a.out.read_text())


if __name__ == "__main__":
    main()
