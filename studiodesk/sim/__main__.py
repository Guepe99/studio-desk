"""python -m studiodesk.sim build --matches 4 --seed 7 | python -m studiodesk.sim report"""
import argparse
import time
from pathlib import Path

from .. import config

ap = argparse.ArgumentParser(prog="python -m studiodesk.sim")
sub = ap.add_subparsers(dest="cmd", required=True)
b = sub.add_parser("build", help="simulate matches into data/matches.sqlite")
b.add_argument("--matches", type=int, default=4)
b.add_argument("--seed", type=int, default=7)
b.add_argument("--minutes", type=float, help="period length override, for quick tests")
b.add_argument("--db", type=Path, default=config.MATCHES_DB)
r = sub.add_parser("report", help="realism report: simulated vs calibration")
r.add_argument("--db", type=Path, default=config.MATCHES_DB)
r.add_argument("--out", type=Path, default=config.ROOT / "docs" / "realism.md")
args = ap.parse_args()

if args.cmd == "build":
    from .build import build
    t0 = time.time()
    res = build(args.matches, args.seed, args.db, args.minutes)
    for m in res:
        print(f"{m['match'][0]}: {m['match'][8]}-{m['match'][9]}, {len(m['events'])} events, "
              f"{len(m['ts'])} frames")
    print(f"built {len(res)} matches into {args.db} in {time.time() - t0:.0f} s")
else:
    from .report import report
    text = report(args.db)
    args.out.write_text(text, encoding="utf-8")
    print(text)
