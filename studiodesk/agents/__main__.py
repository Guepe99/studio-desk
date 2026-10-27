"""`python -m studiodesk.agents run <match_id> [--speed N] [--from-ts S --to-ts S] [--fake] [--no-safety] [--runtime PATH]`
`python -m studiodesk.agents safety <match_id> [--runtime PATH]`

`run` replays the match on the MatchClock (speed 0 = as fast as possible), runs the agents and writes
stories, cues, traces and audit rows to runtime.sqlite. Earlier stories, cues and traces of the
match are replaced; audit rows are kept. Then Azure AI Content Safety checks every story (skipped
with --fake or --no-safety). Prints tokens, cost and latency per agent at the end.
`safety` runs only the Content Safety step on the stories already in runtime.sqlite.
"""
import argparse
import asyncio
import json
import logging
from pathlib import Path

from .. import config, db, telemetry
from . import safety
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
    run.add_argument("--no-safety", action="store_true", help="skip the Content Safety step")
    run.add_argument("--runtime", type=Path, default=config.RUNTIME_DB)
    check = sub.add_parser("safety", help="Content Safety on the stories of a match already in runtime.sqlite")
    check.add_argument("match_id")
    check.add_argument("--runtime", type=Path, default=config.RUNTIME_DB)
    args = ap.parse_args(argv)
    logging.disable(logging.INFO)  # framework, MCP and HTTP chatter; warnings still show
    telemetry.setup()  # spans to Application Insights when APPLICATIONINSIGHTS_CONNECTION_STRING is set

    rt = db.connect(args.runtime)
    try:
        if args.cmd == "safety":
            print(json.dumps({"safety": safety.check_match(rt, args.match_id, safety.AzureSafety())}, indent=2))
            return
        try:
            client = FakeChatClient() if args.fake else azure_client()
        except RuntimeError as e:
            raise SystemExit(str(e)) from None
        # not committed here: the run's own writes commit it, so a run that fails before them keeps the old one
        for table in ("stories", "cues", "traces"):
            rt.execute(f"DELETE FROM {table} WHERE match_id = ?", (args.match_id,))
        summary = asyncio.run(run_match(args.match_id, client, rt, speed=args.speed, from_ts=args.from_ts,
                                        to_ts=args.to_ts, model_name="fake" if args.fake else None))
        if not (args.fake or args.no_safety):
            try:
                summary["safety"] = safety.check_match(rt, args.match_id, safety.AzureSafety())
            except Exception as e:  # noqa: BLE001 - no endpoint or no az: the stories stay not_checked
                summary["safety"] = {"not_checked": summary["stories"], "error": type(e).__name__}
        summary["default_status"] = dict(rt.execute(  # Content Safety decides what may be auto-approved
            "SELECT default_status, COUNT(*) FROM stories WHERE match_id = ? GROUP BY default_status",
            (args.match_id,)).fetchall())
    finally:
        rt.close()
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
