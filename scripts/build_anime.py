"""Builds web/vendor/players/anime.glb: anime footballers bound to the Quaternius mannequin skeleton.

Source: the VRoid Project's CC0 sample models HairSample_Male.vrm and Base_Male.vrm (VRoid Studio
0.14 exports, via https://opengameart.org/content/vroid-studio-cc0-models). Their face (eyes with
highlights, line mouth, brows, 54 blend shapes), body and hair are moved onto the mannequin's
skeleton, so every clip of the scene drives them unchanged.

The two skeletons differ in proportions (VRoid: long legs, short torso), so each source joint gets
its own map onto the mannequin's matching joint: flip (VRM 0.x faces -Z), turn the bone onto the
target bone, stretch along it to the target length and scale across it by a set factor; a vertex
moves by the weighted sum of its joints' maps, the way skinning would move it. The head gets one
uniform scale, larger than the body's, for anime proportions.

Output meshes, all skinned to the mannequin skeleton:
  anime            body regions as footballer.glb (skin, kit_shirt, kit_shorts, kit_socks, boots,
                   forearms, hands), cloth shaped by build_footballer.dress, the same kit UVs
  anime_face       face_skin (tintable face texture) and face (eyes, brows, lashes, mouth in one
                   atlas, alpha tested), with morph targets for the expressions
  hair_<style>     one per hair style, material hair (greyscale, tinted by the page)
  anime_lod1_<style>  the far body with that hair: one draw, UVs into a 8 x 1 palette
  anime_outline_<style>  body, face skin and that hair merged with smooth normals: the outline hull
                   (web/js/toon3d.js) in one draw

    .venv/bin/python scripts/build_anime.py <path-to-anime-download>

Needs ffmpeg (textures) and npx with @gltf-transform/cli 4.5.1 (simplify, quantize).
"""
import argparse
import importlib.util
import subprocess
import tempfile
from pathlib import Path

import numpy as np

_spec = importlib.util.spec_from_file_location("build_footballer", Path(__file__).with_name("build_footballer.py"))
bf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bf)

ROOT = bf.ROOT
OUT = ROOT / "web/vendor/players/anime.glb"
F = np.diag([-1.0, 1.0, -1.0])          # VRM 0.x faces -Z with its left at -x; the mannequin faces +Z

# --- joint map --------------------------------------------------------------------------------------

FINGERS = (("Thumb", "thumb"), ("Index", "index"), ("Middle", "middle"), ("Ring", "ring"), ("Little", "pinky"))


def joint_map():
    """source joint -> (target joint, source child, target child, radial scale). Children give the
    bone direction; None = no direction (uniform scale)."""
    m = {"J_Bip_C_Hips": ("pelvis", "J_Bip_C_Spine", "spine_01", 1.15),
         "J_Bip_C_Spine": ("spine_01", "J_Bip_C_Chest", "spine_02", 1.2),
         "J_Bip_C_Chest": ("spine_02", "J_Bip_C_UpperChest", "spine_03", 1.25),
         "J_Bip_C_UpperChest": ("spine_03", "J_Bip_C_Neck", "neck_01", 1.3),
         "J_Bip_C_Neck": ("neck_01", "J_Bip_C_Head", "Head", 1.1),
         "J_Bip_C_Head": ("Head", None, None, HEAD_SCALE)}
    for s, d in (("L", "l"), ("R", "r")):
        b = f"J_Bip_{s}_"
        m.update({b + "UpperArm": (f"upperarm_{d}", b + "LowerArm", f"lowerarm_{d}", 1.15),
                  b + "LowerArm": (f"lowerarm_{d}", b + "Hand", f"hand_{d}", 1.1),
                  b + "Hand": (f"hand_{d}", b + "Middle1", f"middle_01_{d}", 1.2),
                  b + "UpperLeg": (f"thigh_{d}", b + "LowerLeg", f"calf_{d}", 1.1),
                  b + "LowerLeg": (f"calf_{d}", b + "Foot", f"foot_{d}", 1.08),
                  b + "Foot": (f"foot_{d}", b + "ToeBase", f"ball_{d}", 1.15),
                  b + "ToeBase": (f"ball_{d}", b + "ToeBase_end", f"ball_leaf_{d}", 1.15)})
        for fs, fd in FINGERS:
            for k in (1, 2, 3):
                nxt = f"{b}{fs}{k + 1}" if k < 3 else f"{b}{fs}3_end"
                m[f"{b}{fs}{k}"] = (f"{fd}_0{k}_{d}", nxt, f"{fd}_0{k + 1}_{d}" if k < 3 else f"{fd}_04_leaf_{d}", 1.2)
    return m


HEAD_SCALE = 1.4    # larger than the body's ~1.2: anime head proportions
# VRoid's spine runs near its back, the mannequin's through the middle of the body, and its arms sit
# behind the chest: on the mannequin's clips the anime body stooped. The upper body is tilted back
# about the pelvis by these angles (degrees), so the same clips stand it upright.
TILT = {"J_Bip_C_Spine": 3.0, "J_Bip_C_Chest": 6.0, "J_Bip_C_UpperChest": 8.0, "J_Bip_C_Neck": 8.0, "J_Bip_C_Head": 7.0}
# skinned to the clavicle, but placed with the upper chest: the two rigs' clavicles point differently
SHOULDERS = {"J_Bip_L_Shoulder": "clavicle_l", "J_Bip_R_Shoulder": "clavicle_r"}


def node_world(j):
    """World matrix of every node of a glTF JSON (TRS or matrix)."""
    parent = {c: i for i, n in enumerate(j["nodes"]) for c in n.get("children", [])}
    local = []
    for n in j["nodes"]:
        if "matrix" in n:
            local.append(np.array(n["matrix"], float).reshape(4, 4).T)
            continue
        x, y, z, w = n.get("rotation", [0, 0, 0, 1])
        r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        t = np.eye(4)
        t[:3, :3] = r * np.array(n.get("scale", [1, 1, 1]))
        t[:3, 3] = n.get("translation", [0, 0, 0])
        local.append(t)
    world = {}

    def get(i):
        if i not in world:
            world[i] = (get(parent[i]) if i in parent else np.eye(4)) @ local[i]
        return world[i]
    return {n["name"]: get(i)[:3, 3] for i, n in enumerate(j["nodes"])}


def rotation_between(a, b):
    """Smallest rotation turning unit vector a onto unit vector b."""
    v, c = np.cross(a, b), float(np.dot(a, b))
    if c < -0.999999:
        raise ValueError("opposite bones")
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + k + k @ k / (1 + c)


class BoneMap:
    """The map of one source joint onto its target joint (see the module docstring)."""

    def __init__(self, src, dst, src_child, dst_child, radial):
        self.src, self.dst, self.r = F @ src, dst, radial
        self.T, self.pivot = np.eye(3), np.zeros(3)
        if src_child is None:
            self.u, self.R, self.k, self.len = np.array([0.0, 1.0, 0.0]), np.eye(3), radial, np.inf
            return
        a, b = F @ src_child - self.src, dst_child - dst
        self.len = np.linalg.norm(a)
        self.u = a / self.len
        self.R = rotation_between(self.u, b / np.linalg.norm(b))
        self.k = np.linalg.norm(b) / self.len

    def points(self, p):
        """p (n, 3) in the source's bind pose -> the target's bind pose. Along the bone the stretch
        is k between the joint and its child and the radial scale elsewhere (continuous)."""
        q = p @ F.T - self.src
        t = q @ self.u
        perp = q - t[:, None] * self.u
        tt = np.where(t < 0, t * self.r, np.where(t <= self.len, t * self.k, self.len * self.k + (t - self.len) * self.r))
        out = (tt[:, None] * self.u + self.r * perp) @ self.R.T + self.dst
        return (out - self.pivot) @ self.T.T + self.pivot

    def tilt(self, angle, pivot):
        """Turn the mapped part about the x axis through `pivot` (negative: backwards)."""
        c, s = np.cos(angle), np.sin(angle)
        self.T, self.pivot = np.array([[1, 0, 0], [0, c, -s], [0, s, c]]), pivot

    def linear(self):
        """Linear part between joint and child (for morph target deltas)."""
        uu = np.outer(self.u, self.u)
        return self.T @ self.R @ (self.k * uu + self.r * (np.eye(3) - uu)) @ F


def bone_maps(vrm, skin, man_pos):
    """Per source joint of `skin`: (BoneMap index, target joint name). Joints outside the map take
    their nearest mapped ancestor (hair, eye and hood joints go with the head or the chest)."""
    jm = joint_map()
    src_pos = {n: np.linalg.inv(m)[:3, 3] for n, m in vrm.ibms(skin).items()}
    src_pos.update({n: p for n, p in node_world(vrm.j).items() if n not in src_pos})
    maps, index = [], {}
    for s, (d, sc, dc, r) in jm.items():
        index[s] = len(maps)
        maps.append(BoneMap(src_pos[s], man_pos[d], src_pos[sc] if sc else None, man_pos[dc] if dc else None, r))
        if s in TILT:
            maps[-1].tilt(-np.radians(TILT[s]), man_pos["pelvis"])
    parent = {c: i for i, n in enumerate(vrm.j["nodes"]) for c in n.get("children", [])}
    by_name = {n["name"]: i for i, n in enumerate(vrm.j["nodes"])}
    out = []
    for n in vrm.joint_names(skin):
        i = by_name[n]
        while vrm.j["nodes"][i]["name"] not in jm and i in parent:
            i = parent[i]
        geo = vrm.j["nodes"][i]["name"]
        if geo not in jm:
            geo = "J_Bip_C_Hips"     # Root, above the hips
        if n in SHOULDERS:
            out.append((index["J_Bip_C_UpperChest"], SHOULDERS[n]))
        else:
            out.append((index[geo], jm[geo][0]))
    return maps, out


def rebind_vrm(vrm, mesh, skin, maps, joints, target_names, morphs=()):
    """The vertices shared by the primitives of `mesh` in the mannequin's bind pose: dict of pos,
    nrm, jnt (target indices), wgt, uv and morph deltas `targets` (one per index in `morphs`)."""
    prim = vrm.j["meshes"][mesh]["primitives"][0]
    a = prim["attributes"]
    pos, nrm = vrm.acc(a["POSITION"]).astype(float), vrm.acc(a["NORMAL"]).astype(float)
    jnt, wgt = vrm.acc(a["JOINTS_0"]).astype(int), vrm.acc(a["WEIGHTS_0"]).astype(float)
    wgt /= wgt.sum(1, keepdims=True)
    geo = np.array([g for g, _ in joints])
    tgt = np.array([target_names.index(t) for _, t in joints])
    lin = [m.linear() for m in maps]
    out_p, out_n = np.zeros_like(pos), np.zeros_like(nrm)
    # each morph is {blend shape index: weight}: one target per expression keeps WebGL 1 in its limit
    deltas = [sum(wk * vrm.acc(prim["targets"][k]["POSITION"]).astype(float) for k, wk in m.items()) for m in morphs]
    out_d = [np.zeros_like(pos) for _ in morphs]
    for k in range(4):
        g = geo[jnt[:, k]]
        for b in np.unique(g[wgt[:, k] > 0]):
            sel = (g == b) & (wgt[:, k] > 0)
            w = wgt[sel, k, None]
            out_p[sel] += w * maps[b].points(pos[sel])
            out_n[sel] += w * (nrm[sel] @ (maps[b].T @ maps[b].R @ F).T)
            for d, od in zip(deltas, out_d):
                od[sel] += w * (d[sel] @ lin[b].T)
    out_n /= np.maximum(np.linalg.norm(out_n, axis=1, keepdims=True), 1e-12)
    # weights per target joint, the four largest
    dense = np.zeros((len(pos), len(target_names)))
    for k in range(4):
        np.add.at(dense, (np.arange(len(pos)), tgt[jnt[:, k]]), wgt[:, k])
    top = np.argsort(-dense, axis=1)[:, :4]
    tw = np.take_along_axis(dense, top, 1)
    tw /= tw.sum(1, keepdims=True)
    return dict(pos=out_p, nrm=out_n, jnt=np.where(tw > 0, top, 0), wgt=tw, uv=vrm.acc(a["TEXCOORD_0"]).astype(float),
                names=target_names, targets=out_d)


def indices(vrm, mesh, material_names):
    """Triangles of the primitives of `mesh` whose material is in material_names."""
    tris = [vrm.acc(p["indices"]).reshape(-1, 3).astype(np.int64) for p in vrm.j["meshes"][mesh]["primitives"]
            if vrm.j["materials"][p["material"]]["name"] in material_names]
    return np.concatenate(tris)


def compact(v, tri):
    """The vertices used by tri only, with tri renumbered."""
    used, inv = np.unique(tri.ravel(), return_inverse=True)
    out = {k: (x[used] if isinstance(x, np.ndarray) and len(x) == len(v["pos"]) else x) for k, x in v.items()}
    out["targets"] = [d[used] for d in v.get("targets", [])]
    out["tri"] = inv.reshape(-1, 3)
    return out


# --- textures --------------------------------------------------------------------------------------

def read_rgba(path, w, h):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(path), "-vf", f"scale={w}:{h}:flags=area",
                          "-f", "rawvideo", "-pix_fmt", "rgba", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(h, w, 4).astype(float) / 255


def encode(img, fmt):
    """PNG (keeps alpha) or JPEG bytes of a float RGBA image."""
    h, w = img.shape[:2]
    data = (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes()
    args = ["-c:v", "png", "-f", "image2pipe"] if fmt == "png" else ["-q:v", "4", "-f", "mjpeg"]
    pix = "rgba" if fmt == "png" else "rgb24"
    if fmt != "png":
        data = (np.clip(img[..., :3], 0, 1) * 255 + 0.5).astype(np.uint8).tobytes()
    return subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", pix, "-s", f"{w}x{h}", "-i", "-",
                           *args, "-"], input=data, check=True, capture_output=True).stdout


def grey(img, level, alpha_min=0.5):
    """A tintable greyscale map: luminance over its median (opaque texels) times level."""
    lum = img[..., :3] @ [0.2126, 0.7152, 0.0722]
    med = np.median(lum[img[..., 3] > alpha_min])
    out = img.copy()
    out[..., :3] = np.clip(lum / med * level, 0, 1)[..., None]
    return out


# face atlas, 1024 x 1024: (texture, x, y, w, h, colour factor or "grey"); y down from the top
ATLAS = [("EyeWhite", 0, 512, 512, 256, None), ("EyeIris", 512, 0, 512, 256, "grey"),
         ("EyeHighlight", 512, 256, 512, 256, None), ("FaceBrow", 512, 512, 512, 128, "grey"),
         ("FaceEyeline", 512, 640, 512, 128, (0.11, 0.06, 0.06)), ("FaceEyelash", 512, 768, 512, 128, (0.11, 0.06, 0.06)),
         ("FaceMouth", 0, 768, 256, 256, None)]
ATLAS_S = 1024
# rectangles the page tints (web/js/toon3d.js), in UV: iris by eye colour, brows by hair colour
TINT_RECTS = {"iris": (0.5, 0.0, 1.0, 0.25), "brow": (0.5, 0.5, 1.0, 0.625)}


def face_atlas(img_dir):
    atlas = np.zeros((ATLAS_S, ATLAS_S, 4))
    for name, x, y, w, h, colour in ATLAS:
        img = read_rgba(next(img_dir.glob(f"*_M00_000_00_{name}_00.png")), w, h)
        if colour == "grey":
            img = grey(img, 0.85, 0.2)
        elif colour is not None:
            img[..., :3] *= colour
        atlas[y:y + h, x:x + w] = img
    return atlas


def atlas_uv(uv, name):
    _, x, y, w, h, _ = next(a for a in ATLAS if a[0] == name)
    u = np.clip(uv, 0.002, 0.998)     # stay inside the rectangle under bilinear filtering
    return np.c_[(x + u[:, 0] * w) / ATLAS_S, (y + u[:, 1] * h) / ATLAS_S]


# --- expressions -----------------------------------------------------------------------------------------

# morph targets baked into anime_face: name -> {VRoid blend shape (Face.M_F00_000_00_Fcl_<name>): weight}.
# Four, because WebGL 1 gives morph targets vertex attributes and runs out after about four.
EXPRESSIONS = {"joy": {"ALL_Joy": 1.0}, "sorrow": {"ALL_Sorrow": 1.0},
               "determined": {"BRW_Angry": 0.9, "EYE_Angry": 0.45}, "blink": {"EYE_Close": 1.0}}


# --- hair styles --------------------------------------------------------------------------------------------

def strands(v, tri):
    """Connected pieces of the hair: label per vertex (welded)."""
    wid = bf.weld(v["pos"], 1e-5)
    parent = np.arange(wid.max() + 1)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a, b, c in wid[tri]:
        for p, q in ((a, b), (b, c)):
            rp, rq = find(p), find(q)
            if rp != rq:
                parent[rp] = rq
    return np.array([find(x) for x in wid])


def restyle(pos, label, centre, kind):
    """A new style from the messy one: each strand bent about its root (the vertex nearest the head
    centre). spiky: tips lengthened and lifted; swept: strands turned up and back."""
    out = pos.copy()
    for s in np.unique(label):
        sel = label == s
        p = pos[sel]
        d = np.linalg.norm(p - centre, axis=1)
        root = p[d.argmin()]
        axis = p[d.argmax()] - root
        L = np.linalg.norm(axis)
        if L < 1e-4:
            continue
        t = np.clip((p - root) @ axis / L ** 2, 0, 1)[:, None]
        out_dir = (root - centre) / max(np.linalg.norm(root - centre), 1e-6)
        front = max(0, out_dir[2])   # strands over the forehead
        if kind == "spiky":
            if front > 0.25:          # bangs: shorter and lifted, so the eyes stay clear
                out[sel] = p + t ** 1.2 * (np.array([0, 0.06, 0.02]) - 0.45 * axis)
                continue
            lift = np.array([0, 1.0, -0.5]) * max(0, out_dir[1])   # the crown up and back; the back hangs: not a flame
            out[sel] = p + t ** 1.5 * (0.15 * axis + 0.04 * (out_dir + lift))
        elif kind == "swept":
            out[sel] = p + t ** 1.2 * (np.array([0, 0.07, -0.05]) * (0.3 + front) + 0.02 * out_dir)
    return out


# --- the build -----------------------------------------------------------------------------------------------

PALETTE = 8          # far palette texels: REGIONS, then hair
FAR_HAIR = len(bf.REGIONS)
HAIR_LEVEL = 0.5
# triangle ratios of the near body and of the hair, near (error 0.03) and far (0.05). The near body is
# the VRoid body unsimplified and the near hair keeps 0.45: at 0.62 and 0.2 the silhouette, the hands
# and the toon terminator went polygonal. The far LOD stays as it was: at that size nobody sees facets
BODY_NEAR, HAIR_NEAR, HAIR_FAR = 1.0, 0.45, 0.1
SKIN_LEVEL = 0.6


def build(dl, out=OUT):
    dl = Path(dl).expanduser()
    vrm = bf.Gltf(dl / "hairsample_male/HairSample_Male.vrm")
    base = bf.Gltf(dl / "base_male/Base_Male.vrm")
    man = bf.Gltf(bf.MANNEQUIN)
    target_ibm, names = man.ibms(), man.joint_names()
    L = bf.landmarks(target_ibm)
    man_pos = L   # every target joint, leaves included, is in the skin

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        img_dir = tmp / "img"
        img_dir.mkdir()
        for g, tag in ((vrm, "hs"), (base, "base")):
            for im in g.j["images"]:
                v = g.j["bufferViews"][im["bufferView"]]
                o = v.get("byteOffset", 0)
                (img_dir / f"{tag}_{im['name']}.png").write_bytes(g.buffers[0][o:o + v["byteLength"]])

        mesh_id = {m["name"]: i for i, m in enumerate(vrm.j["meshes"])}
        skin_of = {n["mesh"]: n["skin"] for n in vrm.j["nodes"] if "mesh" in n}

        # body: the skin of HairSample_Male, dressed as the footballer
        mb = mesh_id["Body.baked"]
        maps, joints = bone_maps(vrm, skin_of[mb], man_pos)
        allv = rebind_vrm(vrm, mb, skin_of[mb], maps, joints, names)
        body = compact(allv, indices(vrm, mb, {"M00_001_01_Body_00_SKIN"}))
        body, tr, lm = bf.dress(body, L)
        kit_uvs = {"kit_shirt": bf.kit_uv(body["pos"], body["nrm"], lm["top"]),
                   "kit_shorts": bf.kit_uv(body["pos"], body["nrm"], lm["waist"]), "kit_socks": bf.socks_uv(body["pos"], lm)}

        # face: one vertex set, skin and features as two primitives, expressions as morph targets
        mf = mesh_id["Face.baked"]
        tnames = vrm.j["meshes"][mf]["primitives"][0]["extras"]["targetNames"]
        morphs = [{tnames.index(f"Face.M_F00_000_00_Fcl_{s}"): wk for s, wk in e.items()} for e in EXPRESSIONS.values()]
        mapsf, jointsf = bone_maps(vrm, skin_of[mf], man_pos)
        facev = rebind_vrm(vrm, mf, skin_of[mf], mapsf, jointsf, names, morphs)
        face_skin = compact(facev, indices(vrm, mf, {"M00_000_00_Face_00_SKIN"}))
        parts = []
        for name, *_ in ATLAS:
            p = compact(facev, indices(vrm, mf, {f"M00_000_00_{name}_00_{'EYE' if name.startswith('Eye') else 'FACE'}"}))
            p["uv"] = atlas_uv(p["uv"], name)
            parts.append(p)
        features = {k: np.concatenate([p[k] for p in parts]) for k in ("pos", "nrm", "jnt", "wgt", "uv")}
        features["targets"] = [np.concatenate([p["targets"][i] for p in parts]) for i in range(len(morphs))]
        features["tri"] = np.concatenate([p["tri"] + o for p, o in zip(parts, np.cumsum([0] + [len(p["pos"]) for p in parts[:-1]]))])

        # hair: the messy style of HairSample_Male, two styles bent from it, the crop of Base_Male
        mh = mesh_id["Hair001.baked"]
        mapsh, jointsh = bone_maps(vrm, skin_of[mh], man_pos)
        hv = rebind_vrm(vrm, mh, skin_of[mh], mapsh, jointsh, names)
        hair = compact(hv, indices(vrm, mh, {"F00_000_Hair_00_HAIR"}))
        label = strands(hair, hair["tri"])
        centre = np.array([0, L["Head"][1] + 0.07, L["Head"][2] + 0.01])
        styles = {"hair_messy": hair}
        for kind in ("spiky", "swept"):
            styles[f"hair_{kind}"] = dict(hair, pos=restyle(hair["pos"], label, centre, kind))
        bmb = next(i for i, m in enumerate(base.j["meshes"]) if m["name"] == "Body.baked")
        bskin = next(n["skin"] for n in base.j["nodes"] if n.get("mesh") == bmb)
        mapsb, jointsb = bone_maps(base, bskin, man_pos)
        crop = compact(rebind_vrm(base, bmb, bskin, mapsb, jointsb, names), indices(base, bmb, {"M00_000_HairBack_00_HAIR"}))
        crop["pos"] = crop["pos"] + crop["nrm"] * 0.004   # off the scalp a little
        styles["hair_crop"] = crop
        for s in styles.values():
            s["nrm"] = bf.vertex_normals(s["pos"], s["tri"], bf.weld(s["pos"], 1e-5))

        # textures
        skin_tex = bf.detail_jpeg(img_dir / "hs_M00_001_00_Body_00.png", 512, SKIN_LEVEL)
        face_tex = bf.detail_jpeg(img_dir / "hs_M00_000_00_Face_00.png", 512, SKIN_LEVEL)
        hair_img = grey(read_rgba(img_dir / "hs_F00_000_Hair_00.png", 256, 512), HAIR_LEVEL)
        crop_img = grey(read_rgba(img_dir / "base_M00_000_HairBack_00.png", 512, 512), HAIR_LEVEL)
        atlas = face_atlas(img_dir)

        w = bf.Writer()
        w.j["asset"]["generator"] = "studiodesk scripts/build_anime.py"
        armature = bf.copy_skeleton(w, man)
        bf.copy_clips(w, man)
        st = w.texture(skin_tex)
        mats = {
            "skin": w.material("skin", (0.62, 0.42, 0.32), 0.6, st),
            "kit_shirt": w.material("kit_shirt", (0.8, 0.1, 0.1), 0.8),
            "kit_shorts": w.material("kit_shorts", (0.95, 0.95, 0.95), 0.8),
            "kit_socks": w.material("kit_socks", (0.8, 0.1, 0.1), 0.85),
            "boots": w.material("boots", (0.03, 0.03, 0.03), 0.45),
            "forearms": w.material("forearms", (0.62, 0.42, 0.32), 0.6, st),
            "hands": w.material("hands", (0.62, 0.42, 0.32), 0.6, st),
        }
        mats["face_skin"] = w.material("face_skin", (0.62, 0.42, 0.32), 0.6, w.texture(face_tex))
        mats["face"] = w.material("face", (1, 1, 1), 0.6, png_texture(w, encode(atlas, "png")))
        mats["hair"] = w.material("hair", (0.05, 0.035, 0.025), 0.75, png_texture(w, encode(hair_img, "png")))
        mats["hair_crop"] = w.material("hair_crop", (0.05, 0.035, 0.025), 0.75, png_texture(w, encode(crop_img, "png")))
        for k in ("face", "hair", "hair_crop"):
            w.j["materials"][mats[k]].update(alphaMode="MASK", alphaCutoff=0.5)
        w.j["materials"][mats["hair"]]["doubleSided"] = True

        def region_prims(writer, v, regions):
            prims = []
            for r, name in enumerate(bf.REGIONS):
                t = v["tri"][regions == r]
                if len(t):
                    uv = kit_uvs.get(name, v["uv"] if name in bf.SKIN_UV else None)
                    prims.append(writer.primitive(v, t, mats[name], uv))
            return prims

        # near body, simplified with the region borders locked (gltf-transform), then read back
        near = simplify_regions(tmp, region_prims, body, tr, BODY_NEAR)
        bf.add_mesh_node(w, armature, "anime", w.mesh("anime", [w.primitive(p, p["tri"], mats[n], p["uv"]) for n, p in near]))
        face_prims = [morph_primitive(w, face_skin, mats["face_skin"]), morph_primitive(w, features, mats["face"])]
        fm = w.mesh("anime_face", face_prims)
        w.j["meshes"][fm].update(weights=[0.0] * len(EXPRESSIONS), extras={"targetNames": list(EXPRESSIONS)})
        bf.add_mesh_node(w, armature, "anime_face", fm)

        far_body = far_parts(tmp, region_prims, body, tr)
        kit_far = w.material("kit_far", (1.0, 1.0, 1.0), 0.75)
        outline = w.material("outline", (0.0, 0.0, 0.0), 1.0)
        for style, v in styles.items():
            mat = mats["hair_crop" if style == "hair_crop" else "hair"]
            hs = simplify_one(tmp, v, HAIR_NEAR if style != "hair_crop" else 1.0, style)
            bf.add_mesh_node(w, armature, style, w.mesh(style, [w.primitive(hs, hs["tri"], mat, hs["uv"])]))
            # the outline hull of body, face and this hair as one draw, with smooth normals so hard
            # edges do not split it (the face's expressions do not move it)
            ol = merge([dict(v, uv=np.zeros((len(v["pos"]), 2))) for v in [p for _, p in near] + [face_skin, hs]])
            ol["nrm"] = bf.vertex_normals(ol["pos"], ol["tri"], bf.weld(ol["pos"], 1e-4))
            name = f"anime_outline_{style[5:]}"
            bf.add_mesh_node(w, armature, name, w.mesh(name, [w.primitive(ol, ol["tri"], outline)]))
            hf = simplify_one(tmp, v, HAIR_FAR if style != "hair_crop" else 0.5, style + "_far", 0.05)
            hf["uv"] = np.tile([(FAR_HAIR + 0.5) / PALETTE, 0.5], (len(hf["pos"]), 1))
            far = merge(far_body + [hf])
            name = f"anime_lod1_{style[5:]}"
            bf.add_mesh_node(w, armature, name, w.mesh(name, [w.primitive(far, far["tri"], kit_far, far["uv"])]))

        (tmp / "raw.glb").write_bytes(w.glb())
        out.parent.mkdir(parents=True, exist_ok=True)
        bf.run(bf.GLTF_TRANSFORM + ["prune", str(tmp / "raw.glb"), str(tmp / "pruned.glb"), "--keep-attributes", "true"])
        bf.run(bf.GLTF_TRANSFORM + ["quantize", str(tmp / "pruned.glb"), str(out), "--quantization-volume", "scene"])
    bf.report(out)


def png_texture(w, png):
    w.j["images"].append({"bufferView": w.view(png), "mimeType": "image/png"})
    w.j["textures"].append({"sampler": 0, "source": len(w.j["images"]) - 1})
    return len(w.j["textures"]) - 1


def morph_primitive(w, v, material):
    """A primitive with POSITION morph targets (the deltas of v['targets'])."""
    p = w.primitive(v, v["tri"], material, v["uv"])
    used = np.unique(v["tri"].ravel())
    p["targets"] = [{"POSITION": w.accessor(d[used], "VEC3", 5126, 34962, minmax=True)} for d in v["targets"]]
    return p


def read_prims(path):
    """(material name, vertices) of every primitive of the first mesh of a GLB."""
    s = bf.Gltf(path)
    out = []
    for p in s.j["meshes"][0]["primitives"]:
        a = p["attributes"]
        v = dict(pos=s.acc(a["POSITION"]).astype(float), nrm=s.acc(a["NORMAL"]).astype(float),
                 jnt=s.acc(a["JOINTS_0"]).astype(int), wgt=s.acc(a["WEIGHTS_0"]).astype(float),
                 uv=s.acc(a["TEXCOORD_0"]).astype(float) if "TEXCOORD_0" in a else None,
                 tri=s.acc(p["indices"]).reshape(-1, 3).astype(np.int64))
        out.append((s.j["materials"][p["material"]]["name"], v))
    return out


def simplify_file(tmp, writer_fn, name, ratio, lock, error=0.01):
    lw = bf.Writer()
    lw.j["nodes"], lw.j["scenes"], lw.j["scene"] = [{"name": name, "mesh": 0}], [{"nodes": [0]}], 0
    lw.mesh(name, writer_fn(lw))
    (tmp / f"{name}.glb").write_bytes(lw.glb())
    if ratio >= 1:
        return read_prims(tmp / f"{name}.glb")
    bf.run(bf.GLTF_TRANSFORM + ["simplify", str(tmp / f"{name}.glb"), str(tmp / f"{name}s.glb"),
                                "--ratio", str(ratio), "--error", str(error), "--lock-border", "true" if lock else "false"])
    return read_prims(tmp / f"{name}s.glb")


def simplify_regions(tmp, region_prims, body, tr, ratio):
    def fn(lw):
        prims = region_prims(lw, body, tr)
        lw.j["materials"] = [{"name": n} for n in bf.REGIONS]
        names = [n for r, n in enumerate(bf.REGIONS) if (tr == r).any()]
        for p, n in zip(prims, names):
            p["material"] = bf.REGIONS.index(n)
        return prims
    return simplify_file(tmp, fn, "near", ratio, True)


def simplify_one(tmp, v, ratio, name, error=0.03):
    def fn(lw):
        lw.j["materials"] = [{"name": "m"}]
        return [lw.primitive(v, v["tri"], 0, v["uv"])]
    return simplify_file(tmp, fn, name, ratio, False, error)[0][1]


def far_parts(tmp, region_prims, body, tr):
    out = []
    for name, v in simplify_regions(tmp, region_prims, body, tr, bf.LOD1_RATIO * 0.75):
        v["uv"] = np.tile([(bf.REGIONS.index(name) + 0.5) / PALETTE, 0.5], (len(v["pos"]), 1))
        out.append(v)
    return out


def merge(parts):
    v = {k: np.concatenate([p[k] for p in parts]) for k in ("pos", "nrm", "jnt", "wgt", "uv")}
    base = np.cumsum([0] + [len(p["pos"]) for p in parts[:-1]])
    v["tri"] = np.concatenate([p["tri"] + b for p, b in zip(parts, base)])
    return v


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("dl", help="folder with hairsample_male/HairSample_Male.vrm and base_male/Base_Male.vrm")
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()
    build(a.dl, a.out)
