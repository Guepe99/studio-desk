"""scripts/build_crowd_face.py: the crowd's face card is the footballers' face, and the shipped one is current."""
import importlib.util
import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("build_crowd_face", ROOT / "scripts/build_crowd_face.py")
cf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cf)


def _png(path):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(2 * cf.CARD, 2 * cf.CARD, 4).astype(float) / 255


def test_card_has_two_eyes_brows_and_a_joy_face(tmp_path):
    page = cf.build(out=tmp_path / "face.png")
    C = cf.CARD
    neutral, joy = page[:C, :C], page[C:, :C]
    iris = page[:C, C:, 0] > 0.5
    # two irises, one each side of the middle, in the upper half of the face
    rows, cols = np.nonzero(iris)
    assert (cols < C / 2).sum() > 100 and (cols >= C / 2).sum() > 100
    assert rows.mean() < 0.55 * C
    assert (page[:C, C:, 1] > 0.5).sum() > 50          # brows, tinted by hair colour
    # the closed mouth's teeth stay behind the skin: almost nothing drawn under the eyes in the neutral face
    assert neutral[int(0.55 * C):, :, 3].mean() < 0.02
    # joy: the mouth opens (more ink low on the face) and the irises close
    assert joy[int(0.55 * C):, :, 3].mean() > 3 * neutral[int(0.55 * C):, :, 3].mean()
    assert (page[C:, C:, 0] > 0.5).sum() < 0.5 * iris.sum()
    assert np.allclose(_png(tmp_path / "face.png"), page, atol=1 / 255 + 1e-6)


def test_shipped_card_is_current(tmp_path):
    page = cf.build(out=tmp_path / "face.png")
    assert np.abs(_png(cf.OUT) - page).max() <= 1 / 255 + 1e-6, "run scripts/build_crowd_face.py"
