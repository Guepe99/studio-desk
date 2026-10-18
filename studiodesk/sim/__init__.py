"""Match simulator and synthetic dataset (builder A). Entry point: python -m studiodesk.sim."""
import json
from pathlib import Path

GENERATOR_VERSION = "sim-0.1.0"
CALIBRATION = Path(__file__).with_name("calibration.json")


def load_calibration(path: Path = CALIBRATION) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))
