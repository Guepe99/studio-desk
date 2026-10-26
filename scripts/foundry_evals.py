"""Score the on-air story texts of the replay packs with Microsoft Foundry's built-in evaluators (evaluation only).

    .venv/bin/python scripts/foundry_evals.py [--replays replays] [--db out/foundry-evals.sqlite] [--out docs/MEASURES.md]

One item per story and language: the query asks for the on-screen line of that kind of moment, the response is
the text that went on air (`texts` in `replays/<match>/stories.json`) and the context is what the story cites,
as plain sentences: its facts from the ledger (label, value, unit, what it measures, who, minute) and its
events. Groundedness, relevance, coherence and fluency run on Foundry with gpt-5-mini as the judge, through
the Agent Framework's `FoundryEvals`, one eval run per language.

This script calls Azure and costs tokens; tests only build the items (tests/test_foundry_evals.py).
Per-item results go in the table `foundry_evals` of `--db`; the summary replaces the "Foundry evaluators"
section at the end of `--out`.
"""
import argparse
import asyncio
import json
import math
import os
import random
import statistics
import sys
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from studiodesk import config, db, mcp_server  # noqa: E402
from studiodesk.agents import rules  # noqa: E402
from studiodesk.facts.engine import formation_name  # noqa: E402

PROJECT = os.environ.get("FOUNDRY_PROJECT_ENDPOINT",
                         "https://studiodesk-ai-89965b.services.ai.azure.com/api/projects/studiodesk")
EVALUATORS = ("groundedness", "relevance", "coherence", "fluency")
LANG_NAME = {"en": "English", "it": "Italian", "es": "Spanish"}
MAX_ITEMS, SEED = 400, 20261021
MAX_EVENTS = 5  # a window story cites hundreds of events: past this, only its shots go in the context
HEAD = "## Foundry evaluators"
TABLE = """CREATE TABLE IF NOT EXISTS foundry_evals (
    run_at TEXT NOT NULL, eval_id TEXT NOT NULL, run_id TEXT NOT NULL, match_id TEXT NOT NULL,
    story_id TEXT NOT NULL, kind TEXT NOT NULL, lang TEXT NOT NULL, evaluator TEXT NOT NULL,
    score REAL, passed INTEGER, reason TEXT, tokens_in INTEGER, tokens_out INTEGER,
    PRIMARY KEY (run_id, match_id, story_id, evaluator))"""


def load(match_id, pack):
    """(Match with every fact of the ledger, events by id, the pack's stories), at full time."""
    mcp_server.set_clock(None)
    m = rules.Match(mcp_server.get_match_info(match_id))
    m.facts = {f["fact_id"]: f for f in mcp_server.get_facts(match_id)}
    events = {e["event_id"]: e for e in mcp_server.get_events(match_id, 0.0, math.inf)}
    return m, events, json.loads((Path(pack) / "stories.json").read_text())


def who(m, player_id, team_id):
    player, team = m.player_name(player_id), m.team_name(team_id)
    return f"by {player} of {team}" if player else f"for {team}" if team else "for the match"


def fact_line(m, f):
    """One ledger fact as a sentence; every number in it is the fact's value, its label's or its minute."""
    if f["unit"] == "formation":
        value = formation_name(f["value"])
    elif f["unit"] in ("m", "km/h", "%", "/10"):
        value = f"{rules.fmt(f['value'])} {f['unit']}"  # within the rounding the checks allow
    else:  # xT, sprints, goal: a bare number must equal the value exactly
        value = None if f["unit"] == "goal" else f"{f['value']!r} {f['unit']}"
    measures = f["kind"].replace("_", " ")
    said = f"{rules.display_label(f)}. It measures {measures}" + (f": {value}" if value else "")
    return f"{said}, {who(m, f['player_id'], f['team_id'])}, minute {m.minute_label(f['ts'])}."


def event_line(m, e):
    """One event with no numbers: what, who, how and where (a shot's place as the commentators say it)."""
    parts = [f"{e['type_name'].replace('_', ' ')} {who(m, e['player_id'], e['team_id'])}"]
    if e.get("bodypart_name"):
        parts.append(f"body part {e['bodypart_name']}")
    if e.get("result_name"):
        parts.append(f"result {e['result_name']}")
    if e["type_name"].startswith("shot") and (place := rules.place_text(rules.shot_place(e), "en")):
        parts.append(place)
    return "Event: " + ", ".join(parts) + "."


def context(m, story, events):
    facts = [m.facts[i] for i in story["fact_ids"] if i in m.facts]
    at = max([story["ts"]] + [f["ts"] for f in facts])  # a goal story's score fact can land after its ts
    home, away = m.home["team_id"], m.away["team_id"]
    score, _ = m.score_at(at)
    cited = [events[i] for i in story.get("evidence_event_ids") or [] if i in events]
    if len(cited) > MAX_EVENTS:
        cited = [e for e in cited if e["type_name"].startswith("shot")][:MAX_EVENTS]
    lines = [f"{m.team_name(home)} (home) against {m.team_name(away)} (away).",
             f"The moment is in minute {m.minute_label(story['ts'])}.",
             f"Score at this moment: {m.team_name(home)} {score[home]}, {m.team_name(away)} {score[away]}."]
    return "\n".join(lines + [fact_line(m, f) for f in facts] + [event_line(m, e) for e in cited])


def query(story, lang):
    return (f"Write the on-screen line, in {LANG_NAME[lang]}, for this moment of the match for a TV audience. "
            f"Moment: {story['kind'].replace('_', ' ')}.")


def build_items(match_id, pack):
    m, events, stories = load(match_id, pack)
    return [{"match_id": match_id, "story_id": s["story_id"], "kind": s["kind"], "lang": lang,
             "query": query(s, lang), "response": s["texts"][lang], "context": context(m, s, events)}
            for s in stories for lang in rules.LANGS if s["texts"].get(lang)]


def sample(items, n=MAX_ITEMS, seed=SEED):
    """All items when they fit the budget, else a fixed-seed sample in the original order."""
    if len(items) <= n:
        return items
    keep = set(random.Random(seed).sample(range(len(items)), n))
    return [it for i, it in enumerate(items) if i in keep]


def _get(obj, key):
    return obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)


async def run(items):
    """Rows for the table: one per item and evaluator, one Foundry eval run per language."""
    from agent_framework import EvalItem, Message
    from agent_framework.foundry import FoundryEvals
    from azure.ai.projects.aio import AIProjectClient
    from azure.identity.aio import AzureCliCredential

    run_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows, runs = [], []
    async with AzureCliCredential(process_timeout=120) as cred, AIProjectClient(endpoint=PROJECT, credential=cred) as project:
        evals = FoundryEvals(project_client=project, model=config.MODEL_DEPLOYMENT, evaluators=EVALUATORS,
                             poll_interval=15.0, timeout=3600.0)
        oai = project.get_openai_client()
        for lang in rules.LANGS:
            batch = [it for it in items if it["lang"] == lang]
            if not batch:
                continue
            res = await evals.evaluate([EvalItem(conversation=[Message("user", [it["query"]]),
                                                               Message("assistant", [it["response"]])],
                                                 context=it["context"]) for it in batch],
                                       eval_name=f"Studio Desk stories ({lang})")
            print(f"{lang}: {res.status} {res.result_counts} {res.error or ''}")
            if res.status != "completed":
                raise SystemExit(f"eval run {res.run_id} for {lang}: {res.status} {res.error or ''}")
            runs.append(res)
            # an output item carries only what the judge read: two stories with the same query, text and context
            # each take one of the two results, so neither story is lost and none is scored twice
            by_text = {}
            for it in batch:
                by_text.setdefault((it["query"], it["response"], it["context"]), []).append(it)
            async for oi in await oai.evals.runs.output_items.list(run_id=res.run_id, eval_id=res.eval_id):
                ds = oi.datasource_item or {}
                it = by_text[(ds["query"], ds["response"], ds["context"])].pop(0)
                for r in oi.results or []:
                    s = r.sample or {}
                    usage = _get(s, "usage") or {}
                    reason = getattr(r, "reason", None)  # an extra field of the result, next to score
                    rows.append({"run_at": run_at, "eval_id": res.eval_id, "run_id": res.run_id,
                                 "match_id": it["match_id"], "story_id": it["story_id"], "kind": it["kind"],
                                 "lang": lang, "evaluator": r.name, "score": r.score,
                                 "passed": None if r.passed is None else int(r.passed), "reason": reason,
                                 "tokens_in": _get(usage, "prompt_tokens"), "tokens_out": _get(usage, "completion_tokens")})
    return rows, runs


def summary(rows):
    """{evaluator: {lang or "all": (mean score, passed, scored, items)}}."""
    out = {}
    for ev in EVALUATORS:
        for lang in (*rules.LANGS, "all"):
            rs = [r for r in rows if r["evaluator"] == ev and lang in (r["lang"], "all")]
            scores = [r["score"] for r in rs if r["score"] is not None]
            out.setdefault(ev, {})[lang] = (statistics.mean(scores) if scores else None,
                                            sum(bool(r["passed"]) for r in rs), len(scores), len(rs))
    return out


def section(rows, n_items, n_all, packs):
    s = summary(rows)
    cols = (*rules.LANGS, "all")
    head = "| evaluator | " + " | ".join(f"{LANG_NAME.get(c, 'all languages')}: mean, passed" for c in cols) + " |"
    lines = [head, "|" + "---|" * (len(cols) + 1)]
    for ev in EVALUATORS:
        cells = [f"{mean:.2f}, {p} of {n}" if mean is not None else f"none, {p} of {n}"
                 for mean, p, _, n in (s[ev][c] for c in cols)]
        lines.append(f"| {ev} | " + " | ".join(cells) + " |")
    failed = [f"{r['match_id']} {r['story_id']} ({r['kind'].replace('_', ' ')}, {LANG_NAME[r['lang']]}, "
              f"{r['evaluator']} {r['score']:.0f})" for r in rows if r["score"] is not None and not r["passed"]]
    failed = (f"Not passed: {'; '.join(sorted(failed))}. The judge's reason for each is in the table named at the end of this section."
              if failed else "Every scored item passed.")
    unscored = sum(r["score"] is None for r in rows)
    tin = sum(r["tokens_in"] or 0 for r in rows)
    tout = sum(r["tokens_out"] or 0 for r in rows)
    p = config.MODEL_PRICE_PER_M
    cost = (tin * p["input"] + tout * p["output"]) / 1e6
    run_at = rows[0]["run_at"][:10] if rows else "never"
    picked = (f"all {n_items} items, every story of {packs} in English, Italian and Spanish" if n_items == n_all else
              f"{n_items} of the {n_all} items, a fixed-seed sample (seed {SEED})")
    return f"""{HEAD}

Computed by `scripts/foundry_evals.py` on {run_at}, not by `scripts/measures.py` (which keeps this section
when it rewrites the page). The on-air text of each story was scored by four of Microsoft Foundry's built-in
evaluators, with gpt-5-mini as the judge, through the Agent Framework's `FoundryEvals` on the Foundry project
`studiodesk`: {picked}, one eval run per language. Each item gives the judge a neutral request ("Write the
on-screen line, in Italian, for this moment of the match for a TV audience", with the kind of moment), the
text that went on air, and, for groundedness, the facts the story cites from the ledger written out as plain
sentences (value, unit, what it measures, who, minute), the score at that moment and the events it cites (for
a story that cites more than {MAX_EVENTS} events, only its shots). Scores run from 1 to 5; an item passes at
3 or more, the evaluators' default threshold.

{chr(10).join(lines)}

{failed} {unscored} of {len(rows)} scores came back empty (the judge failed on that item); they count as not
passed. The judge's calls used {tin:,} input and {tout:,} output tokens, about ${cost:.3f} at the gpt-5-mini price in
`studiodesk/config.py`, as the eval runs report them. Per-item scores, pass flags and the judge's reasons are
in `out/foundry-evals.sqlite`, table `foundry_evals` (git-ignored): one row per story, language and evaluator,
with the run time, the Foundry eval and run ids, the match, story, kind, language, evaluator, score, passed,
reason and tokens in and out.
"""


def write_section(path, text):
    """Replace the Foundry section at the end of the page, or add it there."""
    old = path.read_text() if path.exists() else ""
    path.write_text(old.split("\n" + HEAD)[0].rstrip("\n") + "\n\n" + text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("matches", nargs="*")
    ap.add_argument("--replays", type=Path, default=config.ROOT / "replays")
    ap.add_argument("--db", type=Path, default=config.ROOT / "out" / "foundry-evals.sqlite")
    ap.add_argument("--out", type=Path, default=config.ROOT / "docs" / "MEASURES.md")
    a = ap.parse_args()
    matches = a.matches or sorted(p.name for p in a.replays.glob("M*") if (p / "stories.json").exists())
    items = [it for mid in matches for it in build_items(mid, a.replays / mid)]
    picked = sample(items)
    print(f"{len(picked)} of {len(items)} items from {', '.join(matches)}")
    rows, _ = asyncio.run(run(picked))
    with closing(db.connect(a.db)) as conn, conn:
        conn.execute(TABLE)
        for r in rows:
            db.insert(conn, "foundry_evals", r)
    packs = f"the {len(matches)} replay packs ({', '.join(matches)})"
    text = section(rows, len(picked), len(items), packs)
    write_section(a.out, text)
    print(text)


if __name__ == "__main__":
    main()
