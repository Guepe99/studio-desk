"""scripts/retarget_motion.py: SOMA -> UAL retarget and the clip file it writes."""
import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("retarget_motion", ROOT / "scripts/retarget_motion.py")
rm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rm)

SK = rm.Skeleton()
MANIFEST = json.loads((rm.SRC / "clips.json").read_text())["clips"]


def tpose_source(n=40):
    """A source standing still in the SOMA T-pose (identity global rotations, Kimodo rest offsets)."""
    J = {k: i for i, k in enumerate(rm.SOMA)}
    pos = np.zeros((n, len(rm.SOMA), 3))
    hips = np.array([0, 0.995, 0])
    pos[:, J["Hips"]] = hips
    for side, sx in (("Left", 1), ("Right", -1)):
        leg = hips + [sx * 0.1004, -0.0843, 0.026]
        pos[:, J[f"{side}Leg"]] = leg
        pos[:, J[f"{side}Shin"]] = leg + [0, -0.4322, 0]
        pos[:, J[f"{side}Foot"]] = leg + [0, -0.4322 - 0.4216, 0]
    rot = np.broadcast_to(np.eye(3), (n, len(rm.SOMA), 3, 3)).copy()
    return {"rot": rot, "pos": pos, "contacts": np.ones((n, 4), bool)}


def test_rest_pose_round_trip():
    c = rm.retarget(tpose_source(), SK)
    assert set(c["rot"]) == set(rm.MAP)
    for b, q in c["rot"].items():
        rest = SK.R[SK.name[b]]
        assert np.abs(np.abs(q @ rest) - 1).max() < 1e-6, b   # same rotation up to the quaternion sign
    assert np.allclose(c["pel"], SK.T[SK.name["pelvis"]], atol=1e-6)


def test_ual_skeleton_has_65_joints():
    assert len(SK.joints) == 65
    assert all(b in SK.name for b in rm.MAP)


@pytest.mark.parametrize("name", sorted(MANIFEST))
def test_committed_clip_retargets_cleanly(name):
    m = MANIFEST[name]
    c = rm.retarget(rm.load_source(m["source"]), SK, loop=m.get("loop", False), root=m.get("root", False))
    assert len(c["rot"]) == len(rm.MAP) == 22
    for q in c["rot"].values():
        assert np.isfinite(q).all() and np.allclose(np.linalg.norm(q, axis=-1), 1, atol=1e-5)
    assert np.isfinite(c["pel"]).all()
    assert abs(c["pel"][:, 1] - SK.T[SK.name["pelvis"]][1]).max() < 2.0   # no runaway root


def fk(c, sk):
    """World matrices (T, 4, 4) of every UAL joint for a retargeted clip."""
    W = {}
    for k in sk.order():
        name = sk.nodes[k]["name"]
        L = np.broadcast_to(sk.local(k), (c["n"], 4, 4)).copy()
        if name in c["rot"]:
            L[:, :3, :3] = rm.q2m(c["rot"][name]) * sk.S[k]
        if name == "pelvis":
            L[:, :3, 3] = c["pel"]
        p = sk.parent.get(k)
        W[k] = (W[p] if p in W else sk.world(p)) @ L if p is not None else L
    return W


SEGMENTS = [("upperarm_l", "lowerarm_l", "LeftArm", "LeftForeArm"), ("lowerarm_l", "hand_l", "LeftForeArm", "LeftHand"),
            ("upperarm_r", "lowerarm_r", "RightArm", "RightForeArm"), ("lowerarm_r", "hand_r", "RightForeArm", "RightHand"),
            ("thigh_l", "calf_l", "LeftLeg", "LeftShin"), ("calf_r", "foot_r", "RightShin", "RightFoot"),
            ("spine_01", "neck_01", "Spine1", "Neck1")]


@pytest.mark.parametrize("name", sorted(n for n, m in MANIFEST.items() if not m.get("loop")))
def test_limbs_point_where_the_source_points(name):
    """Each limb of the retargeted body points the same way as the source limb (heading removed):
    a mirrored side or a wrong axis shows up as tens of degrees."""
    src = rm.load_source(MANIFEST[name]["source"])
    c = rm.retarget(src, SK, root=MANIFEST[name].get("root", False))
    W, J = fk(c, SK), {k: i for i, k in enumerate(rm.SOMA)}
    for a, b, sa, sb in SEGMENTS:
        t = W[SK.name[b]][:, :3, 3] - W[SK.name[a]][:, :3, 3]
        s = np.einsum("tij,tj->ti", c["H"], src["pos"][:, J[sb]] - src["pos"][:, J[sa]])
        cos = np.sum(t * s, -1) / np.linalg.norm(t, axis=-1) / np.linalg.norm(s, axis=-1)
        ang = np.degrees(np.arccos(np.clip(cos, -1, 1)))
        assert np.percentile(ang, 95) < 12, f"{a}->{b}: {np.percentile(ang, 95):.1f} deg"


ROOTED = sorted(n for n, m in MANIFEST.items() if m.get("root"))


@pytest.mark.parametrize("name", ROOTED)
def test_root_curve_carries_the_hips(name):
    """A root clip leaves the pelvis at rest and its curve is the source hips' travel from the start,
    in the start frame, scaled: the pelvis plus the curve puts the hips back where the source had them."""
    src = rm.load_source(MANIFEST[name]["source"])
    c = rm.retarget(src, SK, root=True)
    assert np.allclose(c["pel"], c["pel"][0], atol=1e-9)
    hips = src["pos"][:, rm.SOMA.index("Hips")]
    d = np.einsum("ij,tj->ti", c["H"][0], hips - hips[0]) * c["scale"]
    assert np.allclose(c["root"][:, [0, 2]], d[:, [0, 2]], atol=1e-6)
    assert np.allclose(np.diff(c["root"][:, 1]), np.diff(d[:, 1]), atol=1e-6)


def test_goalkeeper_clips_go_the_way_their_names_say():
    """glTF frame: +X is the character's left. A dive ends well to its side, a catch stays put, a tip
    jumps."""
    meta = json.loads((rm.OUT / "clips.json").read_text())["clips"]
    end = {n: np.array(meta[n]["root"][-1]) for n in ROOTED}
    up = {n: max(r[1] for r in meta[n]["root"]) for n in ROOTED}
    assert set(end) == {"GK_Dive_L", "GK_Dive_R", "GK_Low_L", "GK_Low_R", "GK_Catch", "GK_Tip"}
    assert end["GK_Dive_L"][0] > 1.0 and end["GK_Dive_R"][0] < -1.0
    assert end["GK_Low_L"][0] > 0.5 and end["GK_Low_R"][0] < -0.5
    assert abs(end["GK_Catch"][0]) < 0.5 and abs(end["GK_Tip"][0]) < 0.5
    assert up["GK_Tip"] > 0.15


def test_glb_bones_and_channels(tmp_path):
    names = sorted(MANIFEST)[:2]
    clips = {n: rm.retarget(rm.load_source(MANIFEST[n]["source"]), SK) for n in names}
    rm.write_glb(clips, SK, tmp_path / "c.glb")
    j = rm.read_glb(tmp_path / "c.glb")
    assert len(j["nodes"]) == 1 + 65                      # the armature and every UAL joint, by name
    assert {nd["name"] for nd in j["nodes"][1:]} == {SK.nodes[i]["name"] for i in SK.joints}
    for a in j["animations"]:
        paths = [(j["nodes"][ch["target"]["node"]]["name"], ch["target"]["path"]) for ch in a["channels"]]
        assert len(paths) == 22 + 1 and ("pelvis", "translation") in paths
