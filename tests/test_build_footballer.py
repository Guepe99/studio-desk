"""scripts/build_footballer.py: plane cuts, kit UVs, and the shipped GLB against the mannequin."""
import importlib.util
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("build_footballer", ROOT / "scripts/build_footballer.py")
bf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bf)


def tri_mesh():
    pos = np.array([[0, -1, 0], [1, 1, 0], [-1, 1, 0]], float)
    return dict(pos=pos, nrm=np.tile([0, 0, 1.0], (3, 1)), uv=None, tri=np.array([[0, 1, 2]]),
                jnt=np.array([[0, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]]), wgt=np.array([[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0.0]]),
                names=["pelvis", "spine_01"])


def test_cut_plane_splits_crossing_triangles_without_cracks():
    v = bf.cut_plane(tri_mesh(), 1, 0.0, bf.TORSO)
    assert len(v["tri"]) == 3 and len(v["pos"]) == 5          # two shared new vertices
    y = v["pos"][v["tri"]][:, :, 1]
    assert not ((y.max(1) > 1e-9) & (y.min(1) < -1e-9)).any()   # nothing crosses the plane
    assert np.allclose(v["wgt"].sum(1), 1)
    new = v["pos"][3:]
    assert np.allclose(new[:, 1], 0) and np.allclose(sorted(new[:, 0]), [-0.5, 0.5])


def test_cut_plane_ignores_other_limbs():
    v = bf.cut_plane(tri_mesh(), 1, 0.0, bf.LEG)
    assert len(v["tri"]) == 1


def test_kit_uv_layout():
    top = 0.6
    pos = np.array([[0, top, 0], [0, top - 0.25, 0.1], [0, top - 0.25, -0.1], [0.3, top, 0]])
    nrm = np.array([[0, 0, 1], [0, 0, 1], [0, 0, -1], [1, 0, 0.0]])
    uv = bf.kit_uv(pos, nrm, top)
    assert np.allclose(uv[0], [0.5, 0.5])                            # collar centre
    assert np.isclose(uv[1, 1], 0.5 + 0.25 * bf.UV_PER_M)            # front runs down from the collar
    assert np.isclose(uv[2, 1], 0.5 - 0.25 * bf.UV_PER_M)            # back runs up to it
    assert uv[3, 0] < 0.5                                            # the player's left at small u


def test_shipped_footballer_matches_the_mannequin():
    fb, man = bf.Gltf(bf.OUT), bf.Gltf(bf.MANNEQUIN)
    assert fb.joint_names() == man.joint_names()
    assert {a["name"] for a in fb.j["animations"]} == {a["name"] for a in man.j["animations"]}
    meshes = {m["name"] for m in fb.j["meshes"]}
    assert {"footballer", "footballer_lod1", "hair_buzzed", "hair_parted", "beard"} <= meshes
    assert bf.OUT.stat().st_size < 3 * 1024 * 1024
