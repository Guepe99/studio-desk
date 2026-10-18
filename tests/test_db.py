import numpy as np

from studiodesk import db


def test_schema_applies_and_tracking_blob_roundtrips(tmp_path):
    conn = db.connect(tmp_path / "m.sqlite")
    pos = np.array([[52.5, 34.0, 0.3], [np.nan] * 3], dtype="<f4")
    conn.execute("INSERT INTO tracking_frames VALUES ('M001', 0, 0.0, NULL, ?)", (pos.tobytes(),))
    blob = conn.execute("SELECT pos FROM tracking_frames").fetchone()[0]
    back = np.frombuffer(blob, "<f4").reshape(-1, 3)
    assert back[0, 0] == np.float32(52.5) and np.isnan(back[1]).all()
