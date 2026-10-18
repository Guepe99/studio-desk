"""Thresholds and caps named in docs/CONTRACT.md."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MATCHES_DB = ROOT / "data" / "matches.sqlite"
RUNTIME_DB = ROOT / "data" / "runtime.sqlite"
FORBIDDEN_NAMES = ROOT / "data" / "forbidden_names.txt"

FPS = 10
AUTO_APPROVE_RISK = 0.35
MAX_GRAPHICS_ON_SCREEN = 2
LIVE_RUNS_PER_SESSION_PER_DAY = 2
LIVE_RUNS_PER_DAY = 20
DAILY_COST_STOP_USD = 25.0
