"""python -m studiodesk.facts build [--match M001 | --all] [--db PATH] [--xt-grid PATH]"""
import argparse
from pathlib import Path

from .. import config, db
from .engine import XT_GRID, build

ap = argparse.ArgumentParser(prog="python -m studiodesk.facts")
ap.add_argument("command", choices=["build"])
which = ap.add_mutually_exclusive_group(required=True)
which.add_argument("--match")
which.add_argument("--all", action="store_true")
ap.add_argument("--db", type=Path, default=config.MATCHES_DB)
ap.add_argument("--xt-grid", type=Path, default=XT_GRID)
args = ap.parse_args()

conn = db.connect(args.db)
ids = [r[0] for r in conn.execute("SELECT match_id FROM matches ORDER BY match_id")] if args.all else [args.match]
for match_id in ids:
    print(f"{match_id}: {build(conn, match_id, args.xt_grid)} facts")
conn.close()
