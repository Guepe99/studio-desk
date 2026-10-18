import json
from pathlib import Path

import numpy as np

GRID = Path(__file__).resolve().parent.parent / "studiodesk/facts/xt_grid.json"


def test_committed_xt_grid_shape_and_orientation():
    d = json.loads(GRID.read_text())
    g = np.array(d["grid"], dtype=float)
    assert (d["cols"], d["rows"]) == (16, 12) and g.shape == (12, 16)
    assert d["source"] and np.isfinite(g).all() and (g >= 0).all() and g.max() < 1
    # attacking towards x = 105: threat rises along x and peaks in front of the goal centre
    r, c = np.unravel_index(g.argmax(), g.shape)
    assert c >= 14 and 4 <= r <= 7
    cols = g.mean(axis=0)
    assert cols[-1] > cols[8] > cols[0]
    # the two touchlines carry similar threat: catches a transposed or scrambled grid
    assert np.allclose(g, g[::-1], atol=g.max() * 0.35)
