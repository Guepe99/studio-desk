"""Compare the agents' stories with the hidden storylines (evaluation only, never used by the agents).

    .venv/bin/python scripts/eval_stories.py M001 [--runtime out/runtime-M001.sqlite]

A storyline counts as found when a story of the matching kind, for the same team (and player, when
the storyline has one), starts between 60 s before ts_start and 60 s after ts_end.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from studiodesk import config, db  # noqa: E402

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("match_id")
    ap.add_argument("--runtime", type=Path, default=config.RUNTIME_DB)
    args = ap.parse_args()
    with db.connect(config.MATCHES_DB, readonly=True) as mconn, db.connect(args.runtime, readonly=True) as rt:
        storylines = [dict(r) for r in mconn.execute(
            "SELECT story_id, kind, ts_start, ts_end, team_id, player_id FROM storylines WHERE match_id = ?",
            (args.match_id,))]
        stories = [dict(r) for r in rt.execute(
            "SELECT story_id, kind, ts, team_id, player_id FROM stories WHERE match_id = ?", (args.match_id,))]
    rows = evaluate(storylines, stories)
    for r in rows:
        print(f"{r['kind']:15s} {r['team_id']} {r['player_id'] or '':7s} {r['ts_start']:7.1f}-{r['ts_end']:7.1f}  "
              f"{'found by ' + ', '.join(r['found_by']) if r['found_by'] else 'MISSED'}")
    print(f"found {sum(bool(r['found_by']) for r in rows)} of {len(rows)} hidden storylines; "
          f"{len(stories)} stories in total")


if __name__ == "__main__":
    main()
