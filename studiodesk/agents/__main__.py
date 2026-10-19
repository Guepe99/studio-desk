"""`python -m studiodesk.agents run <match_id> [--speed N] [--from-ts S --to-ts S] [--fake] [--runtime PATH]`

Replays the match on the MatchClock (speed 0 = as fast as possible), runs the agents and writes
stories, cues, traces and audit rows to runtime.sqlite. Earlier stories, cues and traces of the
match are replaced; audit rows are kept. Prints tokens, cost and latency per agent at the end.
"""
import argparse
import asyncio
import json
import logging
from pathlib import Path

from .. import config, db
from .llm import FakeChatClient, azure_client
from .workflow import run_match


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m studiodesk.agents")
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="run the agents over a match")
    run.add_argument("match_id")
    run.add_argument("--speed", type=float, default=0.0, help="match seconds per wall second; 0 = no waiting")
    run.add_argument("--from-ts", type=float, default=None)
    run.add_argument("--to-ts", type=float, default=None)
    run.add_argument("--fake", action="store_true", help="offline fake model, no Azure")
    run.add_argument("--runtime", type=Path, default=config.RUNTIME_DB)
    args = ap.parse_args(argv)
    logging.disable(logging.INFO)  # framework, MCP and HTTP chatter; warnings still show

    client = FakeChatClient() if args.fake else azure_client()
    rt = db.connect(args.runtime)
    for table in ("stories", "cues", "traces"):
        rt.execute(f"DELETE FROM {table} WHERE match_id = ?", (args.match_id,))
    rt.commit()
    try:
        summary = asyncio.run(run_match(args.match_id, client, rt, speed=args.speed, from_ts=args.from_ts,
                                        to_ts=args.to_ts, model_name="fake" if args.fake else None))
    finally:
        rt.close()
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
