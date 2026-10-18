"""scripts/build_anime.py: the joint map, and the shipped anime.glb against the mannequin."""
import importlib.util
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("build_anime", ROOT / "scripts/build_anime.py")
ba = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ba)
bf = ba.bf


def test_bone_map_takes_joint_and_child_to_the_target_bone():
    src, child = np.array([0.1, 1.0, 0.0]), np.array([0.1, 1.5, 0.0])
    dst, dchild = np.array([0.2, 0.9, 0.0]), np.array([0.2, 0.9, 0.6])
    m = ba.BoneMap(src, dst, child, dchild, 1.2)
    # the source is in VRM space (faces -Z): the map flips it first, so feed the joints flipped back
    out = m.points(np.array([src, child]))
    assert np.allclose(out, [dst, dchild])
    # across the bone: the radial scale; the linear part agrees with points()
    side = src + np.array([0.0, 0.25, 0.05])
    assert np.isclose(np.linalg.norm(m.points(side[None])[0] - m.points(np.array([src + [0, 0.25, 0]]))[0]), 0.05 * 1.2)
    assert np.allclose(m.points(side[None])[0] - m.points(src[None])[0], m.linear() @ (side - src))


def test_shipped_anime_matches_the_mannequin():
    a, man = bf.Gltf(ba.OUT), bf.Gltf(bf.MANNEQUIN)
    assert a.joint_names() == man.joint_names()
    assert {x["name"] for x in a.j["animations"]} == {x["name"] for x in man.j["animations"]}
    assert ba.OUT.stat().st_size < 5 * 1024 * 1024
    meshes = {m["name"]: m for m in a.j["meshes"]}
    mats = {x["name"] for x in a.j["materials"]}
    assert {"skin", "kit_shirt", "kit_shorts", "kit_socks", "boots", "forearms", "hands", "face_skin", "face",
            "hair", "hair_crop", "kit_far"} <= mats
    tris = {n: sum(a.j["accessors"][p["indices"]]["count"] // 3 for p in m["primitives"]) for n, m in meshes.items()}
    face = meshes["anime_face"]
    assert face["extras"]["targetNames"] == list(ba.EXPRESSIONS)
    assert all(len(p["targets"]) == len(ba.EXPRESSIONS) <= 4 for p in face["primitives"])   # WebGL 1 limit
    for style in ("messy", "spiky", "swept", "crop"):
        near = tris["anime"] + tris["anime_face"] + tris[f"hair_{style}"]
        assert near <= 10_000, (style, near)
        assert tris[f"anime_lod1_{style}"] < 4_000
        assert len(meshes[f"anime_lod1_{style}"]["primitives"]) == 1
    # every mesh node is skinned
    assert all("skin" in n for n in a.j["nodes"] if "mesh" in n)
