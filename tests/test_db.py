import sqlite3
from pathlib import Path

import numpy as np
import pytest

from studiodesk import db


def test_cues_take_every_graphic_of_the_contract_and_nothing_else(tmp_path):
    conn = db.connect(tmp_path / "m.sqlite")
    graphics = sorted(p.name for p in (Path(__file__).parents[1] / "web" / "graphics").iterdir() if p.name != "shared")
    assert graphics == ["lineup", "momentum", "nameplate", "pass_shot", "team_stats", "why_card"]  # CONTRACT, Graphics
    for i, g in enumerate(graphics):
        conn.execute("INSERT INTO cues VALUES ('M001', ?, NULL, 0.0, 5.0, ?, 'analyst', 'en', '{}')", (f"C-{i}", g))
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO cues VALUES ('M001', 'C-x', NULL, 0.0, 5.0, 'ticker', 'analyst', 'en', '{}')")


def test_schema_applies_and_tracking_blob_roundtrips(tmp_path):
    conn = db.connect(tmp_path / "m.sqlite")
    pos = np.array([[52.5, 34.0, 0.3], [np.nan] * 3], dtype="<f4")
    conn.execute("INSERT INTO tracking_frames VALUES ('M001', 0, 0.0, NULL, ?)", (pos.tobytes(),))
    blob = conn.execute("SELECT pos FROM tracking_frames").fetchone()[0]
    back = np.frombuffer(blob, "<f4").reshape(-1, 3)
    assert back[0, 0] == np.float32(52.5) and np.isnan(back[1]).all()
