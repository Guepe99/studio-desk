"""scripts/defence_reaction.py lag(): skipped frames are gaps in time, not samples next to each other."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import defence_reaction as dr  # noqa: E402


def test_lag_reads_the_real_frames_across_skipped_stretches():
    fps = 10
    t = np.arange(6000) / fps
    ball = 10 * np.sin(t / 3.1) + 6 * np.sin(t / 1.3 + 1)
    block = np.roll(ball, 10) * 0.3  # the block follows the ball 1.0 s later
    # every other frame, open play only: 4 s kept, 3 s skipped, as measures() samples it
    frames = np.array([f for f in range(20, 6000, 2) if (f // fps) % 7 < 4])
    assert dr.lag(frames, block[frames], ball[frames], fps) == 1.0
