"""Compare the agents' stories with the hidden storylines (evaluation only, never used by the agents).

    .venv/bin/python scripts/eval_stories.py M001 [--runtime out/runtime-M001.sqlite | --pack replays/M001]

A storyline counts as found when a story of the matching kind, for the same team (and player, when
the storyline has one), starts between 60 s before ts_start and 60 s after ts_end.

It also counts the texts the verifier's code checks flag now: numbers not in the ledger, claims the
ledger contradicts (distance words, possession, score order, trend), a missing name or score, and style.
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from studiodesk import config, db, mcp_server  # noqa: E402
from studiodesk.agents import rules  # noqa: E402

KIND = {"tactical_shift": {"tactical_shift"}, "high_press": {"pressing_spell"}, "top_sprint": {"top_sprint"},
        "comeback": {"comeback"}}
SLACK_S = 60.0


def evaluate(storylines, stories):
    rows = []
    for sl in storylines:
        hits = [s for s in stories if s["kind"] in KIND[sl["kind"]] and s["team_id"] == sl["team_id"]
                and (sl["player_id"] is None or s["player_id"] == sl["player_id"])
                and sl["ts_start"] - SLACK_S <= s["ts"] <= sl["ts_end"] + SLACK_S]
        rows.append({**sl, "found_by": [s["story_id"] for s in hits]})
    return rows


def text_checks(match_id, stories):
    """{lang: Counter(check: texts it flags)}, with the code the verifier runs, at full time."""
    mcp_server.set_clock(None)
    m = rules.Match(mcp_server.get_match_info(match_id))
    m.facts = {f["fact_id"]: f for f in mcp_server.get_facts(match_id)}
    out = {lang: Counter() for lang in rules.LANGS}
    for s in stories:
        story = {**s, "facts": [m.facts[i] for i in s["fact_ids"] if i in m.facts],
                 "minute": rules.minute(s["ts"], m.period_of(s["ts"]), m.p1)}
        for lang in rules.LANGS:
            text = s["texts"].get(lang, "")
            found = {"numbers": rules.check_text(m.without_names(text), rules.story_allowed(m, story), lang),
                     "claims": rules.story_issues(m, story, text, lang), "gaps": rules.story_gaps(m, story, text),
                     "style": rules.style_issues(text, lang, s["kind"])}
            out[lang].update(k for k, v in found.items() if v)
            out[lang]["any"] += any(found.values())
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("match_id")
    ap.add_argument("--runtime", type=Path, default=config.RUNTIME_DB)
    ap.add_argument("--pack", type=Path, help="a replays/<match> folder: read its stories.json instead")
    args = ap.parse_args()
    with db.connect(mcp_server.DB_PATH, readonly=True) as mconn:  # STUDIODESK_MATCHES_DB overrides it
        storylines = [dict(r) for r in mconn.execute(
            "SELECT story_id, kind, ts_start, ts_end, team_id, player_id FROM storylines WHERE match_id = ?",
            (args.match_id,))]
    if args.pack:
        stories = json.loads((args.pack / "stories.json").read_text())
    else:
        with db.connect(args.runtime, readonly=True) as rt:
            stories = [dict(r) for r in rt.execute(
                "SELECT story_id, kind, ts, team_id, player_id, fact_ids, texts FROM stories WHERE match_id = ?",
                (args.match_id,))]
        for s in stories:
            s["texts"], s["fact_ids"] = json.loads(s["texts"]), json.loads(s["fact_ids"])
    rows = evaluate(storylines, stories)
    for r in rows:
        print(f"{r['kind']:15s} {r['team_id']} {r['player_id'] or '':7s} {r['ts_start']:7.1f}-{r['ts_end']:7.1f}  "
              f"{'found by ' + ', '.join(r['found_by']) if r['found_by'] else 'MISSED'}")
    print(f"found {sum(bool(r['found_by']) for r in rows)} of {len(rows)} hidden storylines; "
          f"{len(stories)} stories in total")
    true_ids = {i for r in rows for i in r["found_by"]}
    for kind in ("tactical_shift", "pressing_spell"):
        mine = [s["story_id"] for s in stories if s["kind"] == kind]
        print(f"{kind} precision: {sum(i in true_ids for i in mine)} of {len(mine)} stories match a storyline")
    for lang, c in text_checks(args.match_id, stories).items():
        print(f"{lang}: {c['any']} of {len(stories)} texts flagged by the code checks "
              f"(numbers {c['numbers']}, claims {c['claims']}, gaps {c['gaps']}, style {c['style']})")


if __name__ == "__main__":
    main()
