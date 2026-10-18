"""Builds web/vendor/players/human.glb: MakeHuman footballers bound to the Quaternius mannequin skeleton.

Stage 1 (scripts/humans_blender.py, inside Blender with MPFB 2 and the MakeHuman system assets,
all CC0) makes one body per variant: the MakeHuman base mesh shaped by its macro sliders and face
targets, the game-engine rig with MakeHuman's own weights, eyes, eyebrows, eyelashes, hair and
shoes. Stage 2 (this file, numpy only) does the rest:

1. retarget: every vertex is carried from the MakeHuman rest pose (A-pose) to the mannequin's
   (T-pose) by linear blend skinning with MakeHuman's weights. Each limb bone maps its own head
   onto the mannequin joint of the same name and turns its direction onto the mannequin's; the
   torso follows the hip and shoulder joints instead of the spine joints, which the two rigs
   place at different heights. Weights keep MakeHuman's bone names (Root and head become root and Head);
   finger weights fold into the hand, so the hand keeps MakeHuman's relaxed shape whatever the
   clips do with the finger bones.
2. kit as separate garments: shirt, shorts and socks are shells over the body (copies of its
   triangles, smoothed and pushed out, open at the sleeves, collar, hems and sock tops) with a
   stand-up collar; the shoes are MakeHuman's own. Body triangles under the garments are deleted,
   except a margin inside each opening.
3. one mesh per variant (`human0`..), simplified to the near budget, plus a far body
   (`human_lod1`, one draw on a palette) shared by all variants; the clips of mannequin.glb are
   copied byte for byte.

    .venv/bin/python scripts/build_humans.py --blender ~/tools/bl.sh --work /tmp/humans

Needs ffmpeg (textures) and npx with @gltf-transform/cli 4.5.1 (simplify, quantize).
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_footballer import (GLTF_TRANSFORM, MANNEQUIN, PALETTE, Gltf, Writer, add_mesh_node, copy_clips,  # noqa: E402
                              copy_skeleton, cut_plane, dominant, in_group, landmarks, report, run, smooth,
                              vertex_normals, weld)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web/vendor/players/human.glb"
ASSETS = Path("~/tools/blender-user/extensions/.user/user_default/mpfb/data").expanduser()

EYEBROWS = "eyebrows/{0}/{0}.mhclo"
# Body variants: MakeHuman macro sliders (0..1), face targets, hair (None: shaved) and eyebrows.
# Gender 1 is male; age 0.5 is 25 years. Race weights shape the face; the skin tone is the page's.
VARIANTS = {
    "human0": dict(macro=dict(gender=1.0, age=0.5, muscle=0.72, weight=0.45, proportions=0.8, height=0.55,
                              race=dict(caucasian=0.85, african=0.05, asian=0.1)),
                   targets={"head-oval": 0.4, "chin-prognathism-incr": 0.2}, hair="short02", brows="eyebrow001"),
    "human1": dict(macro=dict(gender=1.0, age=0.45, muscle=0.78, weight=0.5, proportions=0.8, height=0.6,
                              race=dict(caucasian=0.05, african=0.9, asian=0.05)),
                   targets={"head-square": 0.3}, hair="afro01", brows="eyebrow002"),
    "human2": dict(macro=dict(gender=1.0, age=0.48, muscle=0.62, weight=0.42, proportions=0.75, height=0.45,
                              race=dict(caucasian=0.1, african=0.05, asian=0.85)),
                   targets={"head-round": 0.3}, hair="short04", brows="eyebrow003"),
    "human3": dict(macro=dict(gender=1.0, age=0.55, muscle=0.82, weight=0.55, proportions=0.8, height=0.55,
                              race=dict(caucasian=0.5, african=0.45, asian=0.05)),
                   targets={"head-rectangular": 0.4, "chin-bones-incr": 0.3}, hair="short01", brows="eyebrow005"),
    "human4": dict(macro=dict(gender=1.0, age=0.6, muscle=0.68, weight=0.5, proportions=0.75, height=0.5,
                              race=dict(caucasian=0.7, african=0.0, asian=0.3)),
                   targets={"head-square": 0.5, "nose-scale-horiz-incr": 0.3}, hair=None, brows="eyebrow006"),
    "human5": dict(macro=dict(gender=1.0, age=0.42, muscle=0.7, weight=0.4, proportions=0.85, height=0.6,
                              race=dict(caucasian=0.6, african=0.35, asian=0.05)),
                   targets={"head-triangular": 0.3}, hair="short01", brows="eyebrow009"),
}
SHOES = "shoes05"
SKIN_TEX = "skins/young_caucasian_male/young_lightskinned_male_diffuse.png"
EYE_TEX = "eyes/materials/brown_eye.png"


def blender_spec(spec):
    """What humans_blender.py needs for one variant."""
    assets = {"eyes": "eyes/low-poly/low-poly.mhclo", "eyebrows": EYEBROWS.format(spec["brows"]),
              "eyelashes": "eyelashes/eyelashes01/eyelashes01.mhclo", "Clothes": f"clothes/{SHOES}/{SHOES}.mhclo"}
    if spec["hair"]:
        assets["hair"] = f"hair/{spec['hair']}/{spec['hair']}.mhclo"
    return {"macro": spec["macro"], "targets": spec["targets"], "assets": assets}


def stage1(blender, work):
    work.mkdir(parents=True, exist_ok=True)
    (work / "variants.json").write_text(json.dumps({k: blender_spec(v) for k, v in VARIANTS.items()}))
    run([str(blender), "-b", "--factory-startup", "--python", str(ROOT / "scripts/humans_blender.py"), "--",
         str(work), str(work / "variants.json")])


# --- reading a stage-1 body -------------------------------------------------------------------------

def part_kind(node_name):
    """body, eyes, brows, lashes, hair or shoes, from the node names MPFB gives its objects."""
    if "." not in node_name:
        return "body"
    asset = node_name.split(".", 1)[1]
    for prefix, kind in (("eyebrow", "brows"), ("eyelashes", "lashes"), ("low-poly", "eyes"), ("shoes", "shoes")):
        if asset.startswith(prefix):
            return kind
    return "hair"


def read_parts(path):
    g = Gltf(path)
    parts = {}
    for n in g.j["nodes"]:
        if "mesh" not in n or "skin" not in n:
            continue
        p = g.j["meshes"][n["mesh"]]["primitives"][0]
        a = p["attributes"]
        wgt = g.acc(a["WEIGHTS_0"]).astype(np.float64)
        wgt /= np.maximum(wgt.sum(1, keepdims=True), 1e-9)
        names = g.joint_names(n["skin"])
        parts[part_kind(n["name"])] = dict(
            pos=g.acc(a["POSITION"]).astype(np.float64), nrm=g.acc(a["NORMAL"]).astype(np.float64),
            uv=g.acc(a["TEXCOORD_0"]).astype(np.float32), jnt=np.array(names, dtype=object)[g.acc(a["JOINTS_0"]).astype(int)],
            wgt=wgt, tri=g.acc(p["indices"]).reshape(-1, 3).astype(np.int64))
    return parts


# --- retarget onto the mannequin skeleton ------------------------------------------------------------

def arc(a, b):
    """Rotation taking direction a onto direction b by the shortest arc."""
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v, c = np.cross(a, b), float(a @ b)
    if c < -0.9999:
        p = np.cross(a, [1, 0, 0] if abs(a[0]) < 0.9 else [0, 1, 0])
        p /= np.linalg.norm(p)
        return 2 * np.outer(p, p) - np.eye(3)
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + k + k @ k / (1 + c)


def frame(d, across):
    x = d / np.linalg.norm(d)
    z = np.cross(x, across)
    z /= np.linalg.norm(z)
    return np.c_[x, np.cross(z, x), z]


def canonical(name):
    """MakeHuman game-engine bone -> mannequin joint (fingers fold into the hand)."""
    if name == "Root":
        return "root"
    if name == "head":
        return "Head"
    if name.split("_")[0] in ("index", "middle", "ring", "pinky", "thumb"):
        return "hand_" + name[-1]
    return name


# the bone each limb bone aims at, in both rigs
AIM = {"clavicle": "upperarm", "upperarm": "lowerarm", "lowerarm": "hand", "hand": "middle_01", "thigh": "calf",
       "calf": "foot", "foot": "ball"}
STRETCH = ("upperarm", "lowerarm", "thigh", "calf")


def bone_maps(bones, L, Y):
    """Per MakeHuman bone: (P, M, Q) with v' = P + M (v - Q). L: mannequin joint positions,
    Y: mannequin bone directions (the bind matrices' Y axis)."""
    H = {k: np.array(b["head"]) for k, b in bones.items()}
    T = {k: np.array(b["tail"]) for k, b in bones.items()}
    s_t = (L["neck_01"][1] - L["pelvis"][1]) / (H["neck_01"][1] - H["pelvis"][1])
    maps = {}

    def anchor(limb, share=1.0):
        # the torso around a limb pair: their midpoint `share` of the way onto the mannequin's (the rest
        # left to the limb's own map), narrowed or widened to their spacing
        q, p = (H[f"{limb}_l"] + H[f"{limb}_r"]) / 2, (L[f"{limb}_l"] + L[f"{limb}_r"]) / 2
        p = share * p + (1 - share) * (L["pelvis"] + s_t * (q - H["pelvis"]))
        kx = np.clip(abs(L[f"{limb}_l"][0]) / (s_t * abs(H[f"{limb}_l"][0])), 0.75, 1.1)
        return p, s_t * np.diag([kx, 1, 1]), q

    # the spine joints sit at different heights in the two rigs, so the torso follows the hips and the
    # shoulders instead: the lower bones map the thighs, spine_03 the upper arms, spine_02 halfway
    hip, chest = anchor("thigh"), anchor("upperarm", 0.5)   # all the way up, the mannequin's high shoulders hide the neck
    for b in ("Root", "pelvis", "spine_01"):
        maps[b] = hip
    maps["spine_03"] = chest
    maps["spine_02"] = (0.5 * (hip[0] - hip[1] @ hip[2] + chest[0] - chest[1] @ chest[2]), 0.5 * (hip[1] + chest[1]), np.zeros(3))
    maps["neck_01"] = (L["neck_01"], s_t * np.eye(3), H["neck_01"])
    maps["head"] = (L["Head"], s_t * np.eye(3), H["head"])
    for side in "lr":
        for chain in (("clavicle", "upperarm", "lowerarm", "hand"), ("thigh", "calf", "foot", "ball")):
            R = np.eye(3)
            for b in chain:
                n = f"{b}_{side}"
                if b in AIM:
                    child = f"{AIM[b]}_{side}"
                    ds, dm = H[child] - H[n], L[child] - L[n]
                else:   # ball: its own tail, the mannequin's bone axis
                    ds, dm = T[n] - H[n], Y[n]
                if b == "hand":
                    across_s = H[f"index_01_{side}"] - H[f"pinky_01_{side}"]
                    across_m = L[f"index_01_{side}"] - L[f"pinky_01_{side}"]
                    R = frame(dm, across_m) @ frame(ds, across_s).T
                else:
                    R = arc(R @ ds, dm) @ R
                M = R
                if b in STRETCH:
                    d = ds / np.linalg.norm(ds)
                    k = np.clip(np.linalg.norm(dm) / np.linalg.norm(ds), 0.85, 1.2)
                    M = R @ (np.eye(3) + (k - 1) * np.outer(d, d))
                maps[n] = (L[n], M, H[n])
    for n in bones:
        if n not in maps and canonical(n).startswith("hand_"):
            maps[n] = maps[canonical(n)]
    return maps


def retarget(v, maps, target_names):
    """Linear blend skinning of one part from the MakeHuman rest pose to the mannequin's. Returns
    positions, normals, joints (mannequin indices, top 4) and weights."""
    pos, nrm = np.zeros_like(v["pos"]), np.zeros_like(v["nrm"])
    for k in range(v["jnt"].shape[1]):
        w = v["wgt"][:, k:k + 1]
        for name in np.unique(v["jnt"][:, k]):
            sel = v["jnt"][:, k] == name
            P, M, Q = maps.get(name, maps["pelvis"])
            pos[sel] += w[sel] * (P + (v["pos"][sel] - Q) @ M.T)
            nrm[sel] += w[sel] * (v["nrm"][sel] @ M.T)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
    index = {n: i for i, n in enumerate(target_names)}
    dense = np.zeros((len(pos), len(target_names)))
    for k in range(v["jnt"].shape[1]):
        idx = np.array([index[canonical(n)] for n in v["jnt"][:, k]])
        np.add.at(dense, (np.arange(len(pos)), idx), v["wgt"][:, k])
    jnt = np.argsort(-dense, axis=1)[:, :4]
    wgt = np.take_along_axis(dense, jnt, 1)
    wgt /= wgt.sum(1, keepdims=True)
    return dict(pos=pos, nrm=nrm, jnt=jnt, wgt=wgt, uv=v["uv"], tri=v["tri"], names=target_names)


# --- the kit ------------------------------------------------------------------------------------------

TORSO, NECK = ("pelvis", "spine", "root"), ("neck", "Head")
ARM = ("clavicle", "upperarm", "lowerarm", "hand")
LEG = ("thigh", "calf", "foot", "ball")
SHIRT_DROP = 0.05    # the shirt hangs this far below the waist, over the shorts
SHORTS_RISE = 0.0   # the shorts' waistband sits this far above the waist line
MARGIN = {"sleeve": 0.05, "hem": 0.06, "neck": 0.025, "sock": 0.012, "boot": 0.025}
# body regions kept (one primitive each) and the garments
BODY = ["skin", "forearms", "hands", "kit_socks"]


def kit_lines(L):
    hip, knee, ankle = L["thigh_l"][1], L["calf_l"][1], L["foot_l"][1]
    shoulder, elbow, wrist = L["upperarm_l"][0], L["lowerarm_l"][0], L["hand_l"][0]
    return dict(hip=hip, shoulder=shoulder, waist=L["pelvis"][1] + 0.05, top=L["neck_01"][1] + 0.005,
                hem=hip - 0.5 * (hip - knee), sock_top=knee - 0.10, boot_top=ankle + 0.035,
                sleeve=shoulder + 0.5 * (elbow - shoulder), wrist=wrist - 0.005)


def cut_lines(v, lm):
    m = MARGIN
    y_cuts = [(lm["waist"] - SHIRT_DROP, TORSO + LEG), (lm["waist"] + SHORTS_RISE, TORSO + LEG),
              (lm["top"], NECK + TORSO + ARM), (lm["top"] - m["neck"], NECK + TORSO + ARM),
              (lm["hem"], LEG + TORSO), (lm["hem"] + m["hem"], LEG + TORSO),
              (lm["sock_top"], LEG), (lm["sock_top"] - m["sock"], LEG), (lm["boot_top"], LEG)]
    for value, near in y_cuts:
        v = cut_plane(v, 1, value, near)
    for value in (lm["sleeve"], lm["sleeve"] - m["sleeve"], lm["wrist"]):
        v = cut_plane(v, 0, value, ARM)
        v = cut_plane(v, 0, -value, ARM)
    return v


def cover(v, lm):
    """Per triangle: which garment covers it, whether the body stays visible, and the body region."""
    dom = dominant(v)[v["tri"]]
    tdom = np.where((dom[:, 1] == dom[:, 2]) & (dom[:, 0] != dom[:, 1]), dom[:, 1], dom[:, 0])
    c = v["pos"][v["tri"]].mean(1)
    x, y, ax = c[:, 0], c[:, 1], np.abs(c[:, 0])
    torso, neck, arm, leg = (in_group(tdom, g) for g in (TORSO, NECK, ARM, LEG))
    trunk = torso | neck | in_group(tdom, ("clavicle",)) | (arm & (ax < lm["shoulder"]))
    upper = trunk | (arm & (ax < lm["sleeve"]))
    shirt = upper & (y < lm["top"]) & (y > lm["waist"] - SHIRT_DROP) | (leg & (y > lm["waist"] - SHIRT_DROP) & (y < lm["top"]))
    shorts = (torso | leg) & (y > lm["hem"]) & (y < lm["waist"] + SHORTS_RISE)
    socks = leg & (y < lm["sock_top"]) & (y > lm["boot_top"])
    m = MARGIN
    hidden = (shirt & ~(arm & (ax > lm["sleeve"] - m["sleeve"])) & (y < lm["top"] - m["neck"])) \
        | (shorts & ~(leg & (y < lm["hem"] + m["hem"]))) | (socks & (y < lm["sock_top"] - m["sock"])) \
        | (leg & (y < lm["boot_top"] - m["boot"]))   # the foot inside the boot
    region = np.full(len(c), BODY.index("skin"))
    region[arm & (ax > lm["sleeve"] - m["sleeve"])] = BODY.index("forearms")
    region[arm & (ax > lm["wrist"])] = BODY.index("hands")
    region[leg & (y < lm["boot_top"])] = BODY.index("kit_socks")
    return dict(shirt=shirt, shorts=shorts, socks=socks, hidden=hidden, region=region)


def boundary_vertices(tri, wid):
    e = np.concatenate([wid[tri[:, [0, 1]]], wid[tri[:, [1, 2]]], wid[tri[:, [2, 0]]]])
    key, count = np.unique(np.sort(e, axis=1), axis=0, return_counts=True)
    return np.unique(key[count == 1].ravel()), key[count == 1]


def shell(v, sel, offset, iterations):
    """A garment from the body triangles `sel`: its own copy of their vertices (same skin
    weights), smoothed (borders fixed) and pushed out along the normal by offset(pos) metres."""
    used, inv = np.unique(v["tri"][sel].ravel(), return_inverse=True)
    tri = inv.reshape(-1, 3)
    g = {k: v[k][used] for k in ("pos", "nrm", "jnt", "wgt")}
    g["names"] = v["names"]
    wid = weld(g["pos"])
    border, _ = boundary_vertices(tri, wid)
    movable = np.ones(wid.max() + 1, bool)
    movable[border] = False
    pos = smooth(g["pos"], tri, wid, movable, iterations)
    nrm = vertex_normals(pos, tri, wid)
    pos = pos + nrm * offset(pos)[:, None]
    g.update(pos=pos, nrm=vertex_normals(pos, tri, wid), tri=tri, wid=wid)
    return g


def fold(g, src, dst):
    """Moves the weights of bones `src` onto `dst` (the shirt hangs from the neck and hips, not the head and thighs)."""
    names = list(g["names"])
    dense = np.zeros((len(g["jnt"]), len(names)))
    np.add.at(dense, (np.arange(len(g["jnt"]))[:, None], g["jnt"]), g["wgt"])
    for n in src:
        dense[:, names.index(dst)] += dense[:, names.index(n)]
        dense[:, names.index(n)] = 0
    jnt = np.argsort(-dense, axis=1)[:, :4]
    wgt = np.take_along_axis(dense, jnt, 1)
    return dict(g, jnt=jnt, wgt=wgt / wgt.sum(1, keepdims=True))


def boots(shoes, lm):
    """MakeHuman's trainers cut down to a football boot: nothing above the boot line."""
    v = cut_plane(shoes, 1, lm["boot_top"], LEG)
    keep = v["pos"][v["tri"]].mean(1)[:, 1] < lm["boot_top"]
    return v, v["tri"][keep]


def collar(g, lm, height=0.024, lean=0.006):
    """A stand-up collar: a band raised from the shirt's neck opening."""
    _, edges = boundary_vertices(g["tri"], g["wid"])
    first = np.zeros(g["wid"].max() + 1, np.int64)
    first[g["wid"]] = np.arange(len(g["wid"]))
    top = g["pos"][first[edges]].mean(1)[:, 1] > lm["top"] - 0.03
    edges = edges[top]
    ring = np.unique(edges.ravel())
    src = first[ring]
    p = g["pos"][src]
    centre = np.array([0.0, 0.0, p[:, 2].mean()])
    radial = (p - centre) * [1, 0, 1]
    radial /= np.maximum(np.linalg.norm(radial, axis=1, keepdims=True), 1e-9)
    new = p + [0, height, 0] + radial * lean
    n0 = len(g["pos"])
    remap = {w: n0 + i for i, w in enumerate(ring)}
    tri = []
    for a, b in edges:
        a0, b0 = first[a], first[b]
        tri += [(a0, b0, remap[b]), (a0, remap[b], remap[a])]
    g = dict(g)
    g["pos"] = np.concatenate([g["pos"], new])
    g["nrm"] = np.concatenate([g["nrm"], radial])
    g["jnt"] = np.concatenate([g["jnt"], g["jnt"][src]])
    g["wgt"] = np.concatenate([g["wgt"], g["wgt"][src]])
    g["tri"] = np.concatenate([g["tri"], np.array(tri, dtype=np.int64)])
    return g


UV_PER_M = 0.8


def kit_uv(pos, nrm, top):
    """As build_footballer.kit_uv (web/js/players3d.js paints with the same layout)."""
    u = 0.5 - pos[:, 0] * UV_PER_M
    d = np.clip((top - pos[:, 1]) * UV_PER_M, 0, 0.5)
    v = np.where(nrm[:, 2] < 0, 0.5 - d, 0.5 + d)
    return np.c_[u, v].astype(np.float32)


def socks_uv(pos, lm):
    v = np.clip((lm["sock_top"] - pos[:, 1]) / (lm["sock_top"] - lm["boot_top"]), 0, 1)
    return np.c_[np.full_like(v, 0.5), v].astype(np.float32)


def garments(body, lm):
    """Body pieces that stay visible and the garments, as {material: (vertices, triangles, uv)}."""
    body = cut_lines(body, lm)
    c = cover(body, lm)
    out = {}
    keep = ~c["hidden"]
    for r, name in enumerate(BODY):
        t = body["tri"][keep & (c["region"] == r)]
        uv = socks_uv(body["pos"], lm) if name == "kit_socks" else body["uv"]
        if len(t):
            out[name] = (body, t, uv)
    hip, hem, sleeve, shoulder = lm["hip"], lm["hem"], lm["sleeve"], lm["shoulder"]

    def shirt_off(p):
        sleeve_flare = np.clip((np.abs(p[:, 0]) - shoulder) / (sleeve - shoulder), 0, 1)
        hang = np.clip((lm["waist"] - p[:, 1]) / SHIRT_DROP, 0, 1)
        return 0.017 + 0.014 * sleeve_flare + 0.016 * hang

    def shorts_off(p):
        return 0.012 + 0.02 * np.clip((hip - p[:, 1]) / (hip - hem), 0, 1) ** 1.5

    def socks_off(p):
        return 0.004 * np.clip((p[:, 1] - lm["boot_top"]) / 0.05, 0, 1)

    shirt = collar(fold(fold(shell(body, c["shirt"], shirt_off, 12), ("Head",), "neck_01"), ("thigh_l", "thigh_r"), "pelvis"), lm)
    out["kit_shirt"] = (shirt, shirt["tri"], kit_uv(shirt["pos"], shirt["nrm"], lm["top"]))
    shorts = shell(body, c["shorts"], shorts_off, 6)
    out["kit_shorts"] = (shorts, shorts["tri"], kit_uv(shorts["pos"], shorts["nrm"], lm["waist"] + SHORTS_RISE))
    socks = shell(body, c["socks"], socks_off, 2)
    out["kit_socks_shell"] = (socks, socks["tri"], socks_uv(socks["pos"], lm))
    return out


# --- textures -----------------------------------------------------------------------------------------

def load_rgba(path, size):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(path), "-vf", f"scale={size}:{size}:flags=area",
                          "-f", "rawvideo", "-pix_fmt", "rgba", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(size, size, 4) / 255.0


def encode(img, fmt):
    """sRGB float image (h, w, 3 or 4) to JPEG or PNG bytes."""
    h, w, ch = img.shape
    data = (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes()
    pix = "rgba" if ch == 4 else "rgb24"
    args = ["-q:v", "3", "-f", "mjpeg"] if fmt == "jpeg" else ["-f", "image2pipe", "-vcodec", "png", "-compression_level", "9"]
    return subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", pix, "-s", f"{w}x{h}", "-i", "-",
                           *args, "-"], input=data, check=True, capture_output=True).stdout


def detail(img, level, mask=None):
    """A tintable detail map: colour divided by its median (linear light, over `mask`) times level."""
    rgb = img[..., :3]
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    sel = lin.reshape(-1, 3)[mask.reshape(-1)] if mask is not None else lin.reshape(-1, 3)
    out = np.clip(lin / np.median(sel, axis=0) * level, 0, 1)
    srgb = np.where(out <= 0.0031308, out * 12.92, 1.055 * out ** (1 / 2.4) - 0.055)
    return np.concatenate([srgb, img[..., 3:]], axis=-1) if img.shape[-1] == 4 else srgb


def hair_texture(style):
    folder = ASSETS / "hair" / style
    line = next(x for x in (folder / f"{style}.mhmat").read_text().splitlines() if x.startswith("diffuseTexture"))
    return folder / line.split()[1]


# --- the build -----------------------------------------------------------------------------------------

LOD1_RATIO = 0.15
NEAR_RATIO = 0.36
SKIN_LEVEL, HAIR_LEVEL, BOOT_LEVEL = 0.6, 0.5, 0.6
FAR = ["skin", "kit_shirt", "kit_shorts", "kit_socks", "boots", "forearms", "hands", "hair"]   # palette texels


def simplify(prims, ratio, error, tmp, tag):
    """gltf-transform simplify over [(name, v, tri, uv)], region borders locked; same shape back."""
    lw = Writer()
    lw.j["nodes"], lw.j["scenes"], lw.j["scene"] = [{"name": "m", "mesh": 0}], [{"nodes": [0]}], 0
    names = [p[0] for p in prims]
    lw.j["materials"] = [{"name": n} for n in names]
    lw.mesh("m", [lw.primitive(v, t, k, uv) for k, (_, v, t, uv) in enumerate(prims)])
    src, dst = tmp / f"{tag}.glb", tmp / f"{tag}s.glb"
    src.write_bytes(lw.glb())
    run(GLTF_TRANSFORM + ["simplify", str(src), str(dst), "--ratio", str(ratio), "--error", str(error), "--lock-border", "true"])
    s = Gltf(dst)
    out = []
    for p in s.j["meshes"][0]["primitives"]:
        a = p["attributes"]
        v = dict(pos=s.acc(a["POSITION"]), nrm=s.acc(a["NORMAL"]), jnt=s.acc(a["JOINTS_0"]), wgt=s.acc(a["WEIGHTS_0"]))
        out.append((s.j["materials"][p["material"]]["name"], v, s.acc(p["indices"]).reshape(-1, 3).astype(np.int64),
                    s.acc(a["TEXCOORD_0"]) if "TEXCOORD_0" in a else None))
    return out


def far_body(body, lm, hair_line):
    """The full body (nothing hidden) painted by region for the far view: palette index per triangle."""
    body = cut_lines(body, lm)
    c = cover(body, lm)
    r = np.where(c["region"] == BODY.index("kit_socks"), FAR.index("boots"), c["region"])   # socks region is the foot
    r = np.where(c["region"] == BODY.index("hands"), FAR.index("hands"), np.where(c["region"] == BODY.index("forearms"), FAR.index("forearms"), np.where(r == FAR.index("boots"), r, 0)))
    r[c["socks"]] = FAR.index("kit_socks")
    r[c["shorts"]] = FAR.index("kit_shorts")
    r[c["shirt"]] = FAR.index("kit_shirt")
    cen = body["pos"][body["tri"]].mean(1)
    dom = dominant(body)[body["tri"][:, 0]]
    r[(dom == "Head") & (cen[:, 1] > hair_line[0]) & (cen[:, 2] < hair_line[1])] = FAR.index("hair")
    return body, r


def build(work, out=OUT):
    man = Gltf(MANNEQUIN)
    target_ibm, target_names = man.ibms(), man.joint_names()
    L = landmarks(target_ibm)
    Y = {n: m[:3, 1] / np.linalg.norm(m[:3, 1]) for n, m in man.bind_matrices().items()}
    lm = kit_lines(L)

    w = Writer()
    armature = copy_skeleton(w, man)
    copy_clips(w, man)
    skin_img = load_rgba(ASSETS / SKIN_TEX, 1024)
    tex = {"skin": w.texture(encode(detail(skin_img[..., :3], SKIN_LEVEL), "jpeg"))}
    shoe_img = load_rgba(ASSETS / f"clothes/{SHOES}/{SHOES}_diffuse.png", 512)
    tex["boots"] = w.texture(encode(detail(shoe_img[..., :3], BOOT_LEVEL), "jpeg"))
    tex["eyes"] = w.texture(encode(load_rgba(ASSETS / EYE_TEX, 128)[..., :3], "jpeg"))
    skin_rgb = (0.62, 0.42, 0.32)
    mats = {
        "skin": w.material("skin", skin_rgb, 0.55, tex["skin"]),
        "forearms": w.material("forearms", skin_rgb, 0.55, tex["skin"]),
        "hands": w.material("hands", skin_rgb, 0.55, tex["skin"]),
        "kit_shirt": w.material("kit_shirt", (0.8, 0.1, 0.1), 0.8),
        "kit_shorts": w.material("kit_shorts", (0.95, 0.95, 0.95), 0.8),
        "kit_socks": w.material("kit_socks", (0.8, 0.1, 0.1), 0.85),
        "boots": w.material("boots", (0.03, 0.03, 0.03), 0.45, tex["boots"]),
        "eyes": w.material("eyes", (1, 1, 1), 0.2, tex["eyes"]),
    }
    for name in ("kit_shirt", "kit_shorts", "kit_socks"):
        w.j["materials"][mats[name]]["doubleSided"] = True
    alpha_mats = {}

    def alpha_material(name, path, size, level, rgb):
        if name not in alpha_mats:
            img = load_rgba(path, size)
            t = w.texture(encode(detail(img, level, img[..., 3] > 0.5), "png"))
            alpha_mats[name] = w.material(name, rgb, 0.8, t)
            w.j["materials"][alpha_mats[name]].update(alphaMode="MASK", alphaCutoff=0.5, doubleSided=True)
        return alpha_mats[name]

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        far_src = None
        for vi, (name, spec) in enumerate(VARIANTS.items()):
            info = json.loads((work / f"{name}.json").read_text())
            maps = bone_maps(info["bones"], L, Y)
            parts = {k: retarget(v, maps, target_names) for k, v in read_parts(work / f"{name}.glb").items()}
            body = parts["body"]
            if far_src is None:
                far_src = body
            prims = [(k, *val) for k, val in garments(body, lm).items()]
            sh, sh_tri = boots(parts["shoes"], lm)
            prims.append(("boots", sh, sh_tri, sh["uv"]))
            prims = simplify(prims, NEAR_RATIO, 0.01, tmp, name)
            mesh_prims = [w.primitive(v, t, mats["kit_socks" if k == "kit_socks_shell" else k], uv) for k, v, t, uv in prims]
            for kind, mat in (("eyes", mats["eyes"]),
                              ("brows", alpha_material("brows", ASSETS / EYEBROWS.format(spec["brows"]).replace(".mhclo", ".png"), 256, 0.5, (0.06, 0.045, 0.035))),
                              ("lashes", alpha_material("lashes", ASSETS / "eyelashes/eyelashes01/eyelashes01.png", 256, 0.5, (0.03, 0.025, 0.02)))):
                p = parts[kind]
                mesh_prims.append(w.primitive(p, p["tri"], mat, p["uv"]))
            if spec["hair"]:
                p = parts["hair"]
                mat = alpha_material(f"hair_{spec['hair']}", hair_texture(spec["hair"]), 256, HAIR_LEVEL, (0.05, 0.035, 0.025))
                mesh_prims.append(w.primitive(p, p["tri"], mat, p["uv"]))
            add_mesh_node(w, armature, name, w.mesh(name, mesh_prims))
            print(name, sum(len(t) for _, _, t, _ in prims), "triangles of body and kit", flush=True)

        # far view: variant 0 with nothing hidden, one draw, UVs on an 8 x 1 palette (texel k = FAR[k])
        head = L["Head"]
        fb, fr = far_body(far_src, lm, (head[1] + 0.06, head[2] + 0.06))
        fprims = [(FAR[r], fb, fb["tri"][fr == r], None) for r in range(len(FAR)) if (fr == r).any()]
        parts = simplify(fprims, LOD1_RATIO, 0.01, tmp, "far")
        allv = []
        for k, v, t, _ in parts:
            v = dict(v, tri=t, uv=np.tile([(FAR.index(k) + 0.5) / PALETTE, 0.5], (len(v["pos"]), 1)).astype(np.float32))
            allv.append(v)
        far = {k: np.concatenate([v[k] for v in allv]) for k in ("pos", "nrm", "jnt", "wgt", "uv")}
        base = np.cumsum([0] + [len(v["pos"]) for v in allv[:-1]])
        far["tri"] = np.concatenate([v["tri"] + b for v, b in zip(allv, base)])
        kit_far = w.material("kit_far", (1.0, 1.0, 1.0), 0.75)
        add_mesh_node(w, armature, "human_lod1", w.mesh("human_lod1", [w.primitive(far, far["tri"], kit_far, far["uv"])]))

        (tmp / "raw.glb").write_bytes(w.glb())
        out.parent.mkdir(parents=True, exist_ok=True)
        run(GLTF_TRANSFORM + ["prune", str(tmp / "raw.glb"), str(tmp / "pruned.glb"), "--keep-attributes", "true"])
        run(GLTF_TRANSFORM + ["quantize", str(tmp / "pruned.glb"), str(out), "--quantization-volume", "scene"])
    report(out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--work", type=Path, required=True, help="folder for the stage-1 bodies")
    ap.add_argument("--blender", help="Blender with MPFB 2 and the MakeHuman system assets; omit to reuse --work")
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()
    if a.blender:
        stage1(a.blender, a.work)
    build(a.work, a.out)
