import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))  # tests import fixture_match by name

from fixture_match import write_fixture  # noqa: E402
from studiodesk import db  # noqa: E402
from studiodesk.facts import build  # noqa: E402


@pytest.fixture
def match_db(tmp_path):
    """The fixture match with its facts built (no xT grid)."""
    info = write_fixture(tmp_path / "matches.sqlite")
    conn = db.connect(info["path"])
    build(conn, info["match_id"], xt_grid=None)
    yield info, conn
    conn.close()
