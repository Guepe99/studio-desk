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


def test_transfer_weights_takes_the_nearest_reference_and_stays_normalised():
    ref = np.array([[0, 0, 0], [0, 1, 0.0]])
    rj, rw = np.array([[0, 0, 0, 0], [1, 0, 0, 0]]), np.array([[1, 0, 0, 0], [1, 0, 0, 0.0]])
    pos = np.array([[0, -0.1, 0], [0.1, -0.1, 0], [0, 1.1, 0], [0.1, 1.1, 0]])
    tri = np.array([[0, 1, 2], [1, 3, 2]])
    jnt, wgt = bf.transfer_weights(pos, tri, ref, rj, rw, 2, iterations=0)
    assert (jnt[[0, 1], 0] == 0).all() and (jnt[[2, 3], 0] == 1).all()
    assert np.allclose(wgt.sum(1), 1)


def test_texel_regions_fill_triangles_and_padding():
    uv = np.array([[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]])
    reg = bf.texel_regions(uv, np.array([[0, 1, 2], [1, 3, 2]]), np.array([3, 5]), 16)
    assert reg[2, 2] == 3 and reg[13, 13] == 5 and (reg >= 0).all()


def test_shipped_trellis_footballer_matches_the_mannequin():
    fb, man = bf.Gltf(bf.TRELLIS_OUT), bf.Gltf(bf.MANNEQUIN)
    assert fb.joint_names() == man.joint_names()
    assert {a["name"] for a in fb.j["animations"]} == {a["name"] for a in man.j["animations"]}
    mats = {fb.j["materials"][p["material"]]["name"] for m in fb.j["meshes"] for p in m["primitives"]}
    assert set(bf.REGIONS) | {"hair1", "kit_far"} <= mats    # what dressFootballer recolours
    assert bf.TRELLIS_OUT.stat().st_size < 3 * 1024 * 1024


def test_fit_line_splits_at_the_colour_change_despite_noise():
    c = np.linspace(0, 1, 101)
    above = c > 0.3
    above[[10, 80]] = ~above[[10, 80]]                      # two stray texels
    assert abs(bf.fit_line(c, above) - 0.3) < 0.011



def test_outer_wall_drops_the_inner_side_of_a_shell():
    def box(r, out):            # a cube of half-size r, 12 triangles facing out (or in)
        v = np.array([[x, y, z] for x in (-r, r) for y in (-r, r) for z in (-r, r)], float)
        f = np.array([[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
                      [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]])
        return v, (f if out else f[:, ::-1])
    vo, fo = box(1.0, True)
    vi, fi = box(0.9, False)
    pos, tri = np.concatenate([vo, vi]), np.concatenate([fo, fi + 8])
    c = pos[tri].mean(1)
    n = np.cross(pos[tri[:, 1]] - pos[tri[:, 0]], pos[tri[:, 2]] - pos[tri[:, 0]])
    assert ((n * c).sum(1)[:12] > 0).all()                  # the outer cube faces out
    keep = bf.outer_wall(pos, tri)
    assert keep[:12].all() and not keep[12:].any()
