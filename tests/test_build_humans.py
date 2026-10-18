"""scripts/build_humans.py: the retarget maths, and the shipped human.glb against the mannequin."""
import importlib.util
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("build_humans", ROOT / "scripts/build_humans.py")
bh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bh)


def test_arc_turns_a_onto_b():
    for a, b in (([1, 0, 0], [0, 1, 0]), ([0, 0, 1], [0.3, -0.2, 0.9]), ([1, 0, 0], [-1, 0, 0])):
        a, b = np.array(a, float), np.array(b, float)
        R = bh.arc(a, b)
        assert np.allclose(R @ a / np.linalg.norm(a), b / np.linalg.norm(b))
        assert np.allclose(R.T @ R, np.eye(3)) and np.isclose(np.linalg.det(R), 1)


def test_canonical_names():
    assert bh.canonical("Root") == "root" and bh.canonical("head") == "Head"
    assert bh.canonical("index_02_l") == "hand_l" and bh.canonical("thumb_03_r") == "hand_r"
    assert bh.canonical("calf_twist_01_l") == "calf_twist_01_l"


def test_retarget_blends_bone_maps_and_keeps_four_weights():
    names = ["root", "pelvis", "hand_l"]
    v = dict(pos=np.array([[1.0, 0, 0], [0, 1.0, 0]]), nrm=np.array([[0, 0, 1.0], [0, 0, 1.0]]), uv=None,
             tri=np.array([[0, 1, 0]]), jnt=np.array([["pelvis", "index_01_l"], ["pelvis", "pelvis"]], dtype=object),
             wgt=np.array([[0.5, 0.5], [1.0, 0.0]]))
    shift = (np.array([0, 0, 1.0]), np.eye(3), np.zeros(3))
    maps = {"pelvis": (np.zeros(3), np.eye(3), np.zeros(3)), "index_01_l": shift}
    out = bh.retarget(v, maps, names)
    assert np.allclose(out["pos"], [[1, 0, 0.5], [0, 1, 0]])
    assert names[out["jnt"][0, 0]] in ("pelvis", "hand_l") and np.allclose(out["wgt"][0, :2], 0.5)   # the finger folds into the hand
    assert np.allclose(out["wgt"].sum(1), 1)


def tri_count(g, prims):
    return sum(g.j["accessors"][p["indices"]]["count"] // 3 for p in prims)


def test_shipped_human_matches_the_mannequin():
    g, man = bh.Gltf(bh.OUT), bh.Gltf(bh.MANNEQUIN)
    assert g.joint_names() == man.joint_names()
    assert {a["name"] for a in g.j["animations"]} == {a["name"] for a in man.j["animations"]}
    meshes = {m["name"]: m for m in g.j["meshes"]}
    assert set(meshes) == {*bh.VARIANTS, "human_lod1"} and len(bh.VARIANTS) >= 6
    mats = [m["name"] for m in g.j["materials"]]
    for name in bh.VARIANTS:
        used = {mats[p["material"]] for p in meshes[name]["primitives"]}
        assert {"skin", "forearms", "hands", "kit_shirt", "kit_shorts", "kit_socks", "boots", "eyes"} <= used
        assert 9000 < tri_count(g, meshes[name]["primitives"]) < 16000    # near budget about 15k
    assert {mats[p["material"]] for p in meshes["human_lod1"]["primitives"]} == {"kit_far"}
    assert tri_count(g, meshes["human_lod1"]["primitives"]) < 5000
    assert bh.OUT.stat().st_size < 4 * 1024 * 1024
