"""Builds web/vendor/players/footballer.glb: a footballer bound to the Quaternius mannequin skeleton.

Source: the male body and hair styles of Quaternius' Universal Base Characters [Standard] (CC0),
which share bone names and hierarchy with the Universal Animation Library but not its rest pose.
Each vertex is moved from the body's bind pose to the mannequin's with its own skin weights
(v' = sum_k w_k * inv(IBM_mannequin[j_k]) * IBM_body[j_k] * v), so the mesh is bound to the
mannequin skeleton exactly and every UAL clip drives it unchanged.

The body is split into kit regions (skin, kit_shirt, kit_shorts, kit_socks, boots, forearms, hands,
eyes), cloth is smoothed and pushed out a little over the skin, shirt, shorts and socks get UVs for
the kit textures the page draws, and a decimated one-draw copy is added for the far view. The clips of mannequin.glb are
copied in unchanged, so the scene loads this file in its place.

    .venv/bin/python scripts/build_footballer.py ~/tools/ubc/"Universal Base Characters[Standard]"

Needs ffmpeg (textures) and npx with @gltf-transform/cli 4.5.1 (simplify, quantize).
"""
import argparse
import base64
import json
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MANNEQUIN = ROOT / "web/vendor/quaternius/mannequin.glb"
OUT = ROOT / "web/vendor/players/footballer.glb"
GLTF_TRANSFORM = ["npx", "-y", "-p", "@gltf-transform/cli@4.5.1", "gltf-transform"]

CTYPE = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class Gltf:
    """Just enough of a glTF 2.0 reader: JSON, buffers, accessors (dense, normalized or not)."""

    def __init__(self, path):
        path = Path(path)
        raw = path.read_bytes()
        if raw[:4] == b"glTF":
            jlen = struct.unpack_from("<I", raw, 12)[0]
            self.j = json.loads(raw[20:20 + jlen])
            off = 20 + jlen
            blen = struct.unpack_from("<I", raw, off)[0]
            self.buffers = [raw[off + 8:off + 8 + blen]]
        else:
            self.j = json.loads(raw)
            self.buffers = []
            for b in self.j["buffers"]:
                uri = b["uri"]
                if uri.startswith("data:"):
                    self.buffers.append(base64.b64decode(uri.split(",", 1)[1]))
                else:
                    self.buffers.append((path.parent / uri).read_bytes())
        self.dir = path.parent

    def acc(self, i):
        a = self.j["accessors"][i]
        v = self.j["bufferViews"][a["bufferView"]]
        dt = np.dtype(CTYPE[a["componentType"]])
        n = NCOMP[a["type"]]
        stride = v.get("byteStride", dt.itemsize * n)
        start = v.get("byteOffset", 0) + a.get("byteOffset", 0)
        buf = self.buffers[v["buffer"]]
        out = np.ndarray((a["count"], n), dt, buf, start, (stride, dt.itemsize)).copy()
        if a.get("normalized"):
            out = out.astype(np.float32) / np.iinfo(dt).max
            if np.issubdtype(dt, np.signedinteger):
                out = np.maximum(out, -1)
        return out

    def joint_names(self, skin=0):
        return [self.j["nodes"][k]["name"] for k in self.j["skins"][skin]["joints"]]

    def ibms(self, skin=0):
        """Inverse bind matrices by joint name, as row-major 4x4 (column vectors)."""
        m = self.acc(self.j["skins"][skin]["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1)
        return dict(zip(self.joint_names(skin), m.astype(np.float64)))

    def bind_matrices(self, skin=0):
        return {k: np.linalg.inv(v) for k, v in self.ibms(skin).items()}

    def mesh(self, name):
        for m in self.j["meshes"]:
            if m.get("name") == name:
                return m
        raise KeyError(name)


# --- moving a skinned mesh onto the mannequin skeleton ------------------------------------------

def rebind(src, prim, skin, target_ibm, target_names):
    """Positions, normals, joints (target indices), weights, uv of one primitive in the target's
    bind pose. Each joint carries the vertex by inv(IBM_target) * IBM_source."""
    a = prim["attributes"]
    pos, nrm = src.acc(a["POSITION"]).astype(np.float64), src.acc(a["NORMAL"]).astype(np.float64)
    jnt, wgt = src.acc(a["JOINTS_0"]).astype(int), src.acc(a["WEIGHTS_0"]).astype(np.float64)
    wgt /= wgt.sum(1, keepdims=True)
    names = src.joint_names(skin)
    src_ibm = src.ibms(skin)
    index = {n: i for i, n in enumerate(target_names)}
    mats = np.stack([np.linalg.inv(target_ibm[n]) @ src_ibm[n] for n in names])   # per source joint
    hp = np.c_[pos, np.ones(len(pos))]
    out_p = np.zeros_like(pos)
    out_n = np.zeros_like(nrm)
    for k in range(4):
        m = mats[jnt[:, k]]
        out_p += wgt[:, k, None] * np.einsum("vij,vj->vi", m, hp)[:, :3]
        out_n += wgt[:, k, None] * np.einsum("vij,vj->vi", m[:, :3, :3], nrm)
    out_n /= np.linalg.norm(out_n, axis=1, keepdims=True)
    remap = np.array([index[n] for n in names])
    uv = src.acc(a["TEXCOORD_0"]) if "TEXCOORD_0" in a else None
    idx = src.acc(prim["indices"]).reshape(-1, 3).astype(np.int64)
    return dict(pos=out_p, nrm=out_n, jnt=remap[jnt], wgt=wgt, uv=uv, tri=idx, names=target_names)


def weld(pos, tol=1e-4):
    """Welded vertex id per vertex: vertices at the same place share normals and smoothing."""
    key = np.round(pos / tol).astype(np.int64)
    _, wid = np.unique(key, axis=0, return_inverse=True)
    return wid.reshape(-1)


def vertex_normals(pos, tri, wid):
    n_w = wid.max() + 1
    fn = np.cross(pos[tri[:, 1]] - pos[tri[:, 0]], pos[tri[:, 2]] - pos[tri[:, 0]])   # area weighted
    acc = np.zeros((n_w, 3))
    for k in range(3):
        np.add.at(acc, wid[tri[:, k]], fn)
    acc /= np.maximum(np.linalg.norm(acc, axis=1, keepdims=True), 1e-12)
    return acc[wid]


def smooth(pos, tri, wid, movable, iterations, lam=0.5):
    """Umbrella smoothing of welded vertices flagged movable (cloth over muscles, toes in boots)."""
    n_w = wid.max() + 1
    wp = np.zeros((n_w, 3))
    wp[wid] = pos
    e = np.concatenate([wid[tri[:, [0, 1]]], wid[tri[:, [1, 2]]], wid[tri[:, [2, 0]]]])
    e = np.unique(np.sort(e, axis=1), axis=0)
    e = e[e[:, 0] != e[:, 1]]
    deg = np.bincount(e.ravel(), minlength=n_w).astype(float)
    for _ in range(iterations):
        s = np.zeros_like(wp)
        np.add.at(s, e[:, 0], wp[e[:, 1]])
        np.add.at(s, e[:, 1], wp[e[:, 0]])
        avg = s / np.maximum(deg, 1)[:, None]
        wp[movable] += lam * (avg[movable] - wp[movable])
    return wp[wid]


# --- kit regions ----------------------------------------------------------------------------------

REGIONS = ["skin", "kit_shirt", "kit_shorts", "kit_socks", "boots", "forearms", "hands"]
SKIN, SHIRT, SHORTS, SOCKS, BOOTS, FOREARMS, HANDS = range(len(REGIONS))
# how far each region stands off the skin, metres
OFFSET = {SKIN: 0.0, SHIRT: 0.016, SHORTS: 0.012, SOCKS: 0.004, BOOTS: 0.007, FOREARMS: 0.002, HANDS: 0.002}


def landmarks(target_ibm):
    return {n: np.linalg.inv(m)[:3, 3] for n, m in target_ibm.items()}


TORSO, NECK = ("pelvis", "spine", "root"), ("neck", "Head")
ARM = ("clavicle", "upperarm", "lowerarm", "hand", "index", "middle", "ring", "pinky", "thumb")
LEG = ("thigh", "calf", "foot", "ball")


def limits(L):
    """Where the kit changes, in the mannequin's bind pose (T-pose, Y up, facing +Z, its left at +x)."""
    hip, knee, ankle = L["thigh_l"][1], L["calf_l"][1], L["foot_l"][1]
    shoulder, elbow, wrist = L["upperarm_l"][0], L["lowerarm_l"][0], L["hand_l"][0]
    return dict(hip=hip, waist=L["pelvis"][1] + 0.05, top=L["neck_01"][1] + 0.005, hem=hip - 0.5 * (hip - knee),
                sock_top=knee - 0.10, boot_top=ankle + 0.035, sleeve=shoulder + 0.5 * (elbow - shoulder), wrist=wrist - 0.005)


def dominant(v):
    names = np.array(v["names"])
    return names[v["jnt"][np.arange(len(v["jnt"])), v["wgt"].argmax(1)]]


def in_group(dom, pats):
    return np.array([any(d.startswith(p) for p in pats) for d in dom])


def classify(pos, dom, lm):
    """Region of each point from its dominant bone and where it sits along that limb."""
    x, y = pos[:, 0], pos[:, 1]
    r = np.full(len(x), SKIN)
    torso, neck, arm, leg = (in_group(dom, g) for g in (TORSO, NECK, ARM, LEG))
    r[torso] = np.where(y[torso] > lm["waist"], SHIRT, SHORTS)
    r[neck] = np.where(y[neck] < lm["top"], SHIRT, SKIN)
    ra = np.select([np.abs(x) < lm["sleeve"], np.abs(x) < lm["wrist"]], [SHIRT, FOREARMS], HANDS)
    r[arm] = ra[arm]
    r[in_group(dom, ("clavicle",))] = SHIRT
    rl = np.select([y > lm["waist"], y > lm["hem"], y > lm["sock_top"], y > lm["boot_top"]], [SHIRT, SHORTS, SKIN, SOCKS], BOOTS)
    r[leg] = rl[leg]
    r[in_group(dom, ("foot", "ball"))] = BOOTS
    return r


def triangle_regions(v, lm):
    """Region of each triangle at its centroid, with the dominant bone most of its corners share.
    After cut_kit_lines no triangle crosses a kit line, so the borders are straight."""
    dom = dominant(v)[v["tri"]]
    tdom = np.where((dom[:, 1] == dom[:, 2]) & (dom[:, 0] != dom[:, 1]), dom[:, 1], dom[:, 0])
    return classify(v["pos"][v["tri"]].mean(1), tdom, lm)


def cut_plane(v, axis, value, near):
    """Splits every triangle that crosses the plane pos[axis] == value and has a corner whose
    dominant bone is in `near`. New vertices are shared per edge, so no crack opens."""
    pos, tri = v["pos"], v["tri"]
    d = pos[:, axis] - value
    d = np.where(np.abs(d) < 1e-7, 0, d)
    s = np.sign(d)
    ts = s[tri]
    hit = (ts.max(1) > 0) & (ts.min(1) < 0) & in_group(dominant(v), near)[tri].any(1)
    if not hit.any():
        return v
    new = {k: [] for k in ("pos", "nrm", "uv", "jnt", "wgt")}
    n0, cache = len(pos), {}

    def point(i, j):
        key = (min(i, j), max(i, j))
        if key not in cache:
            t = d[i] / (d[i] - d[j])
            new["pos"].append(pos[i] + t * (pos[j] - pos[i]))
            nn = v["nrm"][i] + t * (v["nrm"][j] - v["nrm"][i])
            new["nrm"].append(nn / np.linalg.norm(nn))
            if v["uv"] is not None:
                new["uv"].append(v["uv"][i] + t * (v["uv"][j] - v["uv"][i]))
            w = {}
            for idx, f in ((i, 1 - t), (j, t)):
                for jn, wg in zip(v["jnt"][idx], v["wgt"][idx]):
                    w[jn] = w.get(jn, 0) + f * wg
            top = sorted(w.items(), key=lambda kv: -kv[1])[:4] + [(0, 0.0)] * 4
            jw = np.array(top[:4])
            new["jnt"].append(jw[:, 0].astype(int))
            new["wgt"].append(jw[:, 1] / jw[:, 1].sum())
            cache[key] = n0 + len(cache)
        return cache[key]

    out = []
    for a, b, c in tri[hit]:
        sa, sb, sc = s[a], s[b], s[c]
        # rotate (keeps the winding) so that `a` is the corner alone on its side, or the one on the plane
        for _ in range(3):
            if sa == 0 or (sb == sc and sb != sa):
                break
            a, b, c, sa, sb, sc = b, c, a, sb, sc, sa
        if sa == 0:
            p = point(b, c)
            out += [(a, b, p), (a, p, c)]
        else:
            p, q = point(a, b), point(a, c)
            out += [(a, p, q), (p, b, c), (p, c, q)]
    stack = lambda k: np.concatenate([v[k], np.array(new[k], dtype=v[k].dtype).reshape(-1, v[k].shape[1])])
    return dict(v, pos=stack("pos"), nrm=stack("nrm"), jnt=stack("jnt"), wgt=stack("wgt"),
                uv=stack("uv") if v["uv"] is not None else None,
                tri=np.concatenate([tri[~hit], np.array(out, dtype=tri.dtype)]))


def cut_kit_lines(v, lm):
    """Cuts the body along every kit line, so hems, sleeves and boot tops are straight."""
    for axis, value, near in [(1, lm["waist"], TORSO + LEG), (1, lm["top"], NECK + TORSO), (1, lm["hem"], LEG + TORSO),
                              (1, lm["sock_top"], LEG), (1, lm["boot_top"], LEG),
                              (0, lm["sleeve"], ARM), (0, -lm["sleeve"], ARM), (0, lm["wrist"], ARM), (0, -lm["wrist"], ARM)]:
        v = cut_plane(v, axis, value, near)
    return v


def dress(v, L):
    """Splits the body into regions and shapes the cloth. Returns the deformed vertices and the
    region of every triangle."""
    lm = limits(L)
    v = cut_kit_lines(v, lm)
    tr = triangle_regions(v, lm)
    wid = weld(v["pos"])
    n_w = wid.max() + 1
    # every welded vertex: the set of regions around it
    touches = np.zeros((n_w, len(REGIONS)), bool)
    for k in range(3):
        touches[wid[v["tri"][:, k]], tr] = True
    only = lambda *rs: touches[:, list(rs)].any(1) & ~np.delete(touches, list(rs), axis=1).any(1)
    hem = touches[:, SHIRT] & touches[:, SHORTS]
    pos = smooth(v["pos"], v["tri"], wid, only(SHIRT, SHORTS) & ~hem, 6)   # cloth hides the muscles; the hem stays straight
    pos = smooth(pos, v["tri"], wid, only(BOOTS), 10)                    # and the toes
    pos = smooth(pos, v["tri"], wid, only(SOCKS), 2)
    nrm = vertex_normals(pos, v["tri"], wid)
    # offset per welded vertex: the largest of the regions around it, so seams stay closed
    off = np.zeros(n_w)
    for reg, o in OFFSET.items():
        off = np.where(touches[:, reg], np.maximum(off, o), off)
    o = off[wid]
    # shorts flare towards the hem; shirt hangs a little looser at its hem
    y = pos[:, 1]
    flare = np.clip((lm["hip"] - y) / (lm["hip"] - lm["hem"]), 0, 1)
    o = o + np.where(touches[wid, SHORTS] & ~touches[wid, SKIN], 0.02 * flare, 0)
    pos = pos + nrm * o[:, None]
    nrm = vertex_normals(pos, v["tri"], wid)
    out = dict(v, pos=pos, nrm=nrm)
    return out, tr, lm


# kit texture scale, UV units per metre in both directions (web/js/players3d.js draws with it)
UV_PER_M = 0.8


def kit_uv(pos, nrm, top):
    """UV of shirt and shorts, the same scale both ways: u = 0.5 - x * UV_PER_M (the player's
    left at small u), v = 0.5 -/+ (top - y) * UV_PER_M for the back and the front, so the back
    runs upwards from its hem to v = 0.5 at `top` and the front downwards from there. Front and
    back meet at the top and at the sides, away from the numbers."""
    u = 0.5 - pos[:, 0] * UV_PER_M
    d = np.clip((top - pos[:, 1]) * UV_PER_M, 0, 0.5)
    v = np.where(nrm[:, 2] < 0, 0.5 - d, 0.5 + d)
    return np.c_[u, v].astype(np.float32)


def socks_uv(pos, lm):
    """v from 0 at the sock top to 1 at the boot top, for the coloured band."""
    v = np.clip((lm["sock_top"] - pos[:, 1]) / (lm["sock_top"] - lm["boot_top"]), 0, 1)
    return np.c_[np.full_like(v, 0.5), v].astype(np.float32)


# --- textures ---------------------------------------------------------------------------------------

def detail_jpeg(path, size, level):
    """A tintable detail map: the texture divided by its median colour (linear light) times
    `level`, so the page sets the tone with albedoColor = tone / level. JPEG bytes."""
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(path), "-vf", f"scale={size}:{size}:flags=area",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], check=True, capture_output=True).stdout
    img = np.frombuffer(raw, np.uint8).reshape(size, size, 3) / 255.0
    lin = np.where(img <= 0.04045, img / 12.92, ((img + 0.055) / 1.055) ** 2.4)
    lum = lin @ [0.2126, 0.7152, 0.0722]
    med = np.median(lin[lum > np.percentile(lum, 30)], axis=0)    # skip the painted underwear
    out = np.clip(lin / med * level, 0, 1)
    srgb = np.where(out <= 0.0031308, out * 12.92, 1.055 * out ** (1 / 2.4) - 0.055)
    data = (srgb * 255 + 0.5).astype(np.uint8).tobytes()
    return subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{size}x{size}",
                           "-i", "-", "-q:v", "4", "-f", "mjpeg", "-"], input=data, check=True, capture_output=True).stdout


# --- glTF writer --------------------------------------------------------------------------------------

class Writer:
    def __init__(self):
        self.bin = bytearray()
        self.j = {"asset": {"version": "2.0", "generator": "studiodesk scripts/build_footballer.py"},
                  "buffers": [], "bufferViews": [], "accessors": [], "meshes": [], "materials": [],
                  "images": [], "textures": [], "samplers": [{"magFilter": 9729, "minFilter": 9987}]}

    def view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            v["target"] = target
        self.bin += data
        self.j["bufferViews"].append(v)
        return len(self.j["bufferViews"]) - 1

    def accessor(self, arr, kind, ctype, target=None, minmax=False):
        arr = np.ascontiguousarray(arr, CTYPE[ctype])
        a = {"bufferView": self.view(arr.tobytes(), target), "componentType": ctype, "count": len(arr), "type": kind}
        if minmax:
            a["min"] = arr.reshape(len(arr), -1).min(0).tolist()
            a["max"] = arr.reshape(len(arr), -1).max(0).tolist()
        self.j["accessors"].append(a)
        return len(self.j["accessors"]) - 1

    def material(self, name, color, roughness, texture=None):
        pbr = {"baseColorFactor": [*color, 1.0], "metallicFactor": 0.0, "roughnessFactor": roughness}
        if texture is not None:
            pbr["baseColorTexture"] = {"index": texture}
        self.j["materials"].append({"name": name, "pbrMetallicRoughness": pbr})
        return len(self.j["materials"]) - 1

    def texture(self, jpeg):
        self.j["images"].append({"bufferView": self.view(jpeg), "mimeType": "image/jpeg"})
        self.j["textures"].append({"sampler": 0, "source": len(self.j["images"]) - 1})
        return len(self.j["textures"]) - 1

    def primitive(self, v, tri, material, uv=None):
        """One primitive from the vertices used by `tri` (compacted)."""
        used, inv = np.unique(tri.ravel(), return_inverse=True)
        attrs = {
            "POSITION": self.accessor(v["pos"][used], "VEC3", 5126, 34962, minmax=True),
            "NORMAL": self.accessor(v["nrm"][used], "VEC3", 5126, 34962),
            "JOINTS_0": self.accessor(v["jnt"][used], "VEC4", 5121, 34962),
            "WEIGHTS_0": self.accessor(v["wgt"][used], "VEC4", 5126, 34962),
        }
        if uv is not None:
            attrs["TEXCOORD_0"] = self.accessor(uv[used], "VEC2", 5126, 34962)
        ctype = 5123 if len(used) < 65536 else 5125
        return {"attributes": attrs, "indices": self.accessor(inv, "SCALAR", ctype, 34963), "material": material}

    def mesh(self, name, prims):
        self.j["meshes"].append({"name": name, "primitives": prims})
        return len(self.j["meshes"]) - 1

    def glb(self):
        self.j["buffers"] = [{"byteLength": len(self.bin)}]
        for k in ("images", "textures", "samplers"):
            if not self.j[k]:
                del self.j[k]
        js = json.dumps(self.j, separators=(",", ":")).encode()
        js += b" " * (-len(js) % 4)
        bn = bytes(self.bin) + b"\0" * (-len(self.bin) % 4)
        total = 12 + 8 + len(js) + 8 + len(bn)
        return (struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
                + struct.pack("<II", len(bn), 0x004E4942) + bn)


def copy_accessor(w, src, i, done):
    """Accessor i of src copied byte for byte (same component type and normalisation)."""
    if i not in done:
        a = dict(src.j["accessors"][i])
        v = src.j["bufferViews"][a.pop("bufferView")]
        dt, n = np.dtype(CTYPE[a["componentType"]]), NCOMP[a["type"]]
        start = v.get("byteOffset", 0) + a.pop("byteOffset", 0)
        raw = np.ndarray((a["count"], n), dt, src.buffers[v["buffer"]], start, (v.get("byteStride", dt.itemsize * n), dt.itemsize))
        a["bufferView"] = w.view(np.ascontiguousarray(raw).tobytes())
        w.j["accessors"].append(a)
        done[i] = len(w.j["accessors"]) - 1
    return done[i]


def copy_clips(w, man):
    """Every animation of the mannequin: the nodes keep their indices, so the channels hold."""
    done = {}
    w.j["animations"] = [dict(an, samplers=[dict(s, input=copy_accessor(w, man, s["input"], done),
                                                 output=copy_accessor(w, man, s["output"], done)) for s in an["samplers"]])
                         for an in man.j.get("animations", [])]


def copy_skeleton(w, man):
    """The mannequin's nodes, scene and skin, without its mesh (clips: copy_clips)."""
    nodes = json.loads(json.dumps(man.j["nodes"]))
    ibm = man.acc(man.j["skins"][0]["inverseBindMatrices"])
    skin = dict(man.j["skins"][0], inverseBindMatrices=w.accessor(ibm, "MAT4", 5126))
    w.j["nodes"], w.j["skins"], w.j["scenes"], w.j["scene"] = nodes, [skin], man.j["scenes"], 0
    armature = next(i for i, n in enumerate(nodes) if n["name"] == "Armature")
    body = next(i for i, n in enumerate(nodes) if "mesh" in n)
    nodes[armature]["children"].remove(body)
    nodes[body] = {"name": "unused"}       # keeps the joint indices; pruned by gltf-transform
    return nodes[armature]


def add_mesh_node(w, armature, name, mesh):
    w.j["nodes"].append({"name": name, "mesh": mesh, "skin": 0})
    armature["children"].append(len(w.j["nodes"]) - 1)


def run(cmd):
    print("$", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


# --- the build -----------------------------------------------------------------------------------------

HAIR = {"hair_buzzed": "Hair_Buzzed", "hair_parted": "Hair_SimpleParted", "beard": "Hair_Beard"}
LOD1_RATIO = 0.3
PALETTE = 8   # texels in the far body's kit palette
SKIN_UV = ("skin", "forearms", "hands")


def build(ubc, out=OUT, lod_ratio=LOD1_RATIO):
    ubc = Path(ubc).expanduser()
    body_dir = ubc / "Base Characters/Godot - UE"
    hair_dir = ubc / "Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)"
    man = Gltf(MANNEQUIN)
    target_ibm, target_names = man.ibms(), man.joint_names()
    L = landmarks(target_ibm)

    hero = Gltf(body_dir / "Superhero_Male_FullBody.gltf")
    body = rebind(hero, hero.mesh("Sphere.005_Retopology.004")["primitives"][0], 0, target_ibm, target_names)
    eyes = rebind(hero, hero.mesh("Face.001")["primitives"][0], 0, target_ibm, target_names)
    body, tr, lm = dress(body, L)
    kit_uvs = {"kit_shirt": kit_uv(body["pos"], body["nrm"], lm["top"]),
               "kit_shorts": kit_uv(body["pos"], body["nrm"], lm["waist"]), "kit_socks": socks_uv(body["pos"], lm)}
    shirt_u = kit_uvs["kit_shirt"][np.unique(body["tri"][tr == SHIRT]), 0]
    assert 0 < shirt_u.min() and shirt_u.max() < 1, "the shirt UV must stay inside the texture"

    w = Writer()
    armature = copy_skeleton(w, man)
    copy_clips(w, man)
    skin_tex = w.texture(detail_jpeg(ubc / "Base Characters/Textures/T_Superhero_Male_Ligh.png", 512, 0.6))
    skin_rgb = (0.62, 0.42, 0.32)
    mats = {
        "skin": w.material("skin", skin_rgb, 0.6, skin_tex),
        "kit_shirt": w.material("kit_shirt", (0.8, 0.1, 0.1), 0.8),
        "kit_shorts": w.material("kit_shorts", (0.95, 0.95, 0.95), 0.8),
        "kit_socks": w.material("kit_socks", (0.8, 0.1, 0.1), 0.85),
        "boots": w.material("boots", (0.03, 0.03, 0.03), 0.45),
        "forearms": w.material("forearms", skin_rgb, 0.6, skin_tex),
        "hands": w.material("hands", skin_rgb, 0.6, skin_tex),
        "eyes": w.material("eyes", (0.06, 0.04, 0.03), 0.3),
    }

    def region_prims(writer, v, regions):
        prims = []
        for r, name in enumerate(REGIONS):
            t = v["tri"][regions == r]
            if len(t):
                uv = kit_uvs.get(name, v["uv"] if name in SKIN_UV else None)
                prims.append(writer.primitive(v, t, mats[name], uv))
        return prims

    prims = region_prims(w, body, tr) + [w.primitive(eyes, eyes["tri"], mats["eyes"])]
    add_mesh_node(w, armature, "footballer", w.mesh("footballer", prims))

    hair_mats = {}
    for node, src in HAIR.items():
        g = Gltf(hair_dir / f"{src}.gltf")
        prim = g.j["meshes"][0]["primitives"][0]
        tex = g.j["materials"][prim["material"]]["pbrMetallicRoughness"]["baseColorTexture"]["index"]
        img = g.j["images"][g.j["textures"][tex]["source"]]["uri"]
        if img not in hair_mats:
            hair_mats[img] = w.material(f"hair{len(hair_mats) + 1}", (0.05, 0.035, 0.025), 0.75,
                                        w.texture(detail_jpeg(hair_dir / img, 256, 0.5)))
        v = rebind(g, prim, 0, target_ibm, target_names)
        v["nrm"] = vertex_normals(v["pos"], v["tri"], weld(v["pos"]))
        add_mesh_node(w, armature, node, w.mesh(node, [w.primitive(v, v["tri"], hair_mats[img], v["uv"])]))

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        # far view: the body alone, decimated with the region borders locked so seams stay shut
        lw = Writer()
        lw.j["nodes"], lw.j["scenes"], lw.j["scene"] = [{"name": "lod1", "mesh": 0}], [{"nodes": [0]}], 0
        lw.mesh("lod1", region_prims(lw, body, tr))
        lw.j["materials"] = [{"name": m["name"]} for m in w.j["materials"]]
        (tmp / "lod1.glb").write_bytes(lw.glb())
        run(GLTF_TRANSFORM + ["simplify", str(tmp / "lod1.glb"), str(tmp / "lod1s.glb"),
                              "--ratio", str(lod_ratio), "--error", "0.01", "--lock-border", "true"])
        # one primitive (one draw call per far player): each region's UV points at its texel of
        # an 8 x 1 palette the page paints per kit (texel k = REGIONS[k])
        s = Gltf(tmp / "lod1s.glb")
        parts = []
        for p in s.j["meshes"][0]["primitives"]:
            a = p["attributes"]
            r = REGIONS.index(s.j["materials"][p["material"]]["name"])
            v = dict(pos=s.acc(a["POSITION"]), nrm=s.acc(a["NORMAL"]), jnt=s.acc(a["JOINTS_0"]), wgt=s.acc(a["WEIGHTS_0"]))
            v["uv"] = np.tile([(r + 0.5) / PALETTE, 0.5], (len(v["pos"]), 1))
            v["tri"] = s.acc(p["indices"]).reshape(-1, 3).astype(np.int64)
            parts.append(v)
        far = {k: np.concatenate([v[k] for v in parts]) for k in ("pos", "nrm", "jnt", "wgt", "uv")}
        base = np.cumsum([0] + [len(v["pos"]) for v in parts[:-1]])
        far["tri"] = np.concatenate([v["tri"] + b for v, b in zip(parts, base)])
        kit_far = w.material("kit_far", (1.0, 1.0, 1.0), 0.75)
        add_mesh_node(w, armature, "footballer_lod1", w.mesh("footballer_lod1", [w.primitive(far, far["tri"], kit_far, far["uv"])]))

        (tmp / "raw.glb").write_bytes(w.glb())
        out.parent.mkdir(parents=True, exist_ok=True)
        run(GLTF_TRANSFORM + ["prune", str(tmp / "raw.glb"), str(tmp / "pruned.glb"), "--keep-attributes", "true"])  # the shirt UV has no texture until the page draws the number
        run(GLTF_TRANSFORM + ["quantize", str(tmp / "pruned.glb"), str(out), "--quantization-volume", "scene"])
    report(out)


# --- trial: a TRELLIS.2 body on the same skeleton (?players=trellis) ---------------------------------
#
#     .venv/bin/python scripts/build_footballer.py --trellis trellis.glb
#
# The source is the GLB the TRELLIS.2 Space exports from a T-pose image (see docs/players3d.md). It
# is decimated, scaled so its arm line sits on the mannequin's, its arms stretched so the wrist meets
# the hand joint and its legs swung in under the hips; then it takes the skin weights of the nearest
# point of the shipped UBC body, the same kit cuts, and its own texture as detail.

TRELLIS_OUT = OUT.with_name("footballer-trellis.glb")
TRELLIS_RATIO = 0.08       # about 23k triangles, 12k once the inner wall is gone
HAIR = len(REGIONS)        # a region of the TRELLIS body only: its hair is part of the scan


def read_skinned(g, mesh, T):
    """Primitives of a skinned mesh of a quantised GLB, in bind space (T undoes the quantisation,
    which gltf-transform folds into the inverse bind matrices)."""
    out = []
    for p in g.mesh(mesh)["primitives"]:
        a = p["attributes"]
        nrm = g.acc(a["NORMAL"]).astype(np.float64)
        out.append(dict(pos=g.acc(a["POSITION"]).astype(np.float64) @ T[:3, :3].T + T[:3, 3],
                        nrm=nrm / np.linalg.norm(nrm, axis=1, keepdims=True),
                        jnt=g.acc(a["JOINTS_0"]).astype(int), wgt=g.acc(a["WEIGHTS_0"]).astype(np.float64),
                        uv=g.acc(a["TEXCOORD_0"]) if "TEXCOORD_0" in a else None,
                        tri=g.acc(p["indices"]).reshape(-1, 3).astype(np.int64),
                        material=g.j["materials"][p["material"]]["name"]))
    return out


def leg_line(p, side, y0, y1):
    """Centre x of one leg as a + b * y, fitted between the heights y0 and y1."""
    ys, xs = [], []
    for y in np.arange(y0, y1, 0.02):
        sl = p[(np.abs(p[:, 1] - y) < 0.01) & (side * p[:, 0] > 0.02)]
        if len(sl):
            ys.append(y)
            xs.append((sl[:, 0].min() + sl[:, 0].max()) / 2)
    b, a = np.polyfit(ys, xs, 1)
    return a, b


def align_trellis(pos, L, sole):
    """TRELLIS body (Y up, facing +Z, its left at +x, any scale) onto the mannequin's bind pose."""
    p = pos - [0, pos[:, 1].min(), 0]
    ax = np.abs(p[:, 0])
    fore = (ax > 0.6 * ax.max()) & (ax < 0.7 * ax.max())
    arm_y, arm_z = p[fore, 1].mean(), p[fore, 2].mean()
    s = (L["upperarm_l"][1] - sole) / arm_y          # uniform: the arm line on the skeleton's
    p = p * s + [0, sole, 0]
    # depth: the knees over the calf joints
    knee = np.abs(p[:, 1] - L["calf_l"][1]) < 0.02
    p[:, 2] += L["calf_l"][2] - (p[knee, 2].min() + p[knee, 2].max()) / 2
    arm_z = p[fore, 2].mean()
    # arms: the wrist (the thinnest section before the hand) onto the hand joint, the hand unscaled
    arm = p[:, 1] > L["upperarm_l"][1] - 0.25
    ax, xm = np.abs(p[:, 0]), np.abs(p[arm, 0]).max()
    bins = np.arange(0.6 * xm, 0.85 * xm, 0.01)
    thick = [np.ptp(p[arm & (np.abs(ax - b) < 0.005), 1]) if (arm & (np.abs(ax - b) < 0.005)).any() else 9 for b in bins]
    wrist, sh, hand = bins[int(np.argmin(thick))], L["upperarm_l"][0], L["hand_l"][0]
    f = np.interp(ax, [0, sh, wrist], [0, sh, hand]) + np.maximum(ax - wrist, 0)
    p[:, 0] = np.where(arm, np.sign(p[:, 0]) * f, p[:, 0])
    p[:, 2] += np.where(arm, np.clip((ax - sh) / 0.1, 0, 1), 0) * (L["lowerarm_l"][2] - arm_z)
    # legs: swung in about the hip so each one hangs straight down over its thigh joint
    hip = L["thigh_l"][1]
    for side in (1, -1):
        a, b = leg_line(p, side, sole + 0.1, hip - 0.15)
        leg = (side * p[:, 0] > 0) & (p[:, 1] < hip)
        w = np.clip(np.abs(p[:, 0]) / 0.04, 0, 1)
        p[:, 0] -= np.where(leg, w * (b * (p[:, 1] - hip)), 0)
        p[:, 0] -= np.where(leg, w * np.clip((hip - p[:, 1]) / 0.2, 0, 1) * (a + b * hip - side * L["thigh_l"][0]), 0)
    return p


def outer_wall(pos, tri, chunk=128):
    """The Space's mesh is a shell about 1 cm thick: an outer wall facing out and an inner wall
    facing into the body. A ray cast out of an outer triangle crosses walls in fours (another limb:
    outer, inner, inner, outer), out of an inner one it crosses the far inner wall and then the
    outer wall first, so crossings modulo 4 tell them apart. Returns the outer triangles."""
    p0, e1, e2 = pos[tri[:, 0]], pos[tri[:, 1]] - pos[tri[:, 0]], pos[tri[:, 2]] - pos[tri[:, 0]]
    n = np.cross(e1, e2)
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    d = n + [0.0123, 0.0071, -0.0093]            # off the axes, so rays do not graze a seam
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    o = pos[tri].mean(1) + n * 1e-4
    hits = np.zeros(len(tri), int)
    for i in range(0, len(tri), chunk):
        oi, di = o[i:i + chunk, None], d[i:i + chunk, None]          # rays x triangles
        h = np.cross(di, e2[None])
        det = (e1[None] * h).sum(2)
        ok = np.abs(det) > 1e-12
        inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
        sv = oi - p0[None]
        u = (sv * h).sum(2) * inv
        q = np.cross(sv, e1[None])
        v = (di * q).sum(2) * inv
        t = (e2[None] * q).sum(2) * inv
        hits[i:i + chunk] = (ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0)).sum(1)
    return hits % 4 < 2


def nearest(a, b, chunk=2048):
    """Index of the nearest point of b for every point of a (brute force, chunked)."""
    out = np.empty(len(a), np.int64)
    bb = (b * b).sum(1)
    for i in range(0, len(a), chunk):
        d = bb[None, :] - 2 * a[i:i + chunk] @ b.T
        out[i:i + chunk] = d.argmin(1)
    return out


def transfer_weights(pos, tri, ref_pos, ref_jnt, ref_wgt, n_joints, iterations=3):
    """Skin weights of the nearest reference vertex, smoothed over the mesh, the top 4 kept."""
    k = nearest(pos, ref_pos)
    W = np.zeros((len(pos), n_joints))
    for c in range(4):
        np.add.at(W, (np.arange(len(pos)), ref_jnt[k, c]), ref_wgt[k, c])
    wid = weld(pos)
    e = np.concatenate([wid[tri[:, [0, 1]]], wid[tri[:, [1, 2]]], wid[tri[:, [2, 0]]]])
    e = np.unique(np.sort(e, axis=1), axis=0)
    e = e[e[:, 0] != e[:, 1]]
    Ww = np.zeros((wid.max() + 1, n_joints))
    np.add.at(Ww, wid, W)
    Ww /= np.bincount(wid)[:, None]
    deg = np.bincount(e.ravel(), minlength=len(Ww))[:, None]
    for _ in range(iterations):
        s = np.zeros_like(Ww)
        np.add.at(s, e[:, 0], Ww[e[:, 1]])
        np.add.at(s, e[:, 1], Ww[e[:, 0]])
        Ww = 0.5 * Ww + 0.5 * s / np.maximum(deg, 1)
    W = Ww[wid]
    jnt = np.argsort(-W, axis=1)[:, :4]
    wgt = np.take_along_axis(W, jnt, 1)
    return jnt, wgt / wgt.sum(1, keepdims=True)


def decode_image(data, size):
    """Any image ffmpeg reads (WebP here) as float RGB in 0..1, size x size."""
    with tempfile.NamedTemporaryFile(suffix=".img") as f:
        f.write(data)
        f.flush()
        raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", f.name, "-vf", f"scale={size}:{size}:flags=area",
                              "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(size, size, 3) / 255.0


def encode_jpeg(img):
    size = img.shape[0]
    data = (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes()
    return subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{size}x{size}",
                           "-i", "-", "-q:v", "4", "-f", "mjpeg", "-"], input=data, check=True, capture_output=True).stdout


def texel_regions(uv, tri, regions, size):
    """Region of every texel of the atlas (-1 where no triangle maps), by rasterising the UV
    triangles; empty texels then take the region of a neighbour, so filtering stays inside."""
    out = np.full((size, size), -1, np.int64)
    t = uv[tri] * size - 0.5                     # texel centres at integers
    lo = np.floor(t.min(1)).astype(int).clip(0, size - 1)
    hi = np.ceil(t.max(1)).astype(int).clip(0, size - 1)
    for k in range(len(tri)):
        (x0, y0), (x1, y1) = lo[k], hi[k]
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        a, b, c = t[k]
        den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(den) < 1e-12:
            continue
        l1 = ((b[1] - c[1]) * (gx - c[0]) + (c[0] - b[0]) * (gy - c[1])) / den
        l2 = ((c[1] - a[1]) * (gx - c[0]) + (a[0] - c[0]) * (gy - c[1])) / den
        inside = (l1 >= -0.02) & (l2 >= -0.02) & (1 - l1 - l2 >= -0.02)
        out[gy[inside], gx[inside]] = regions[k]
    for _ in range(8):                           # grow into the padding
        empty = out < 0
        if not empty.any():
            break
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            nb = np.roll(out, (dy, dx), (0, 1))
            out = np.where(empty & (out < 0) & (nb >= 0), nb, out)
    return out


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.clip(c, 0, None) ** (1 / 2.4) - 0.055)


def trellis_atlases(tex, texreg, size):
    """From the TRELLIS base colour: (1) a tintable atlas, each region's texels divided by that
    region's median and set to the level the page assumes (skin 0.6, hair 0.5, boots 0.9), sRGB;
    (2) a grey detail map for the kit, linear, 1 at the brightest cloth, read as occlusion."""
    lin = srgb_to_linear(tex)
    out = np.zeros_like(lin)
    for regs, level in (((SKIN, FOREARMS, HANDS), 0.6), ((HAIR,), 0.5), ((BOOTS,), 0.9)):
        m = np.isin(texreg, regs)
        if m.any():
            out[m] = lin[m] / np.median(lin[m], axis=0) * level
    lum = lin @ [0.2126, 0.7152, 0.0722]
    occ = np.ones(lum.shape)
    for r in (SHIRT, SHORTS, SOCKS):
        m = texreg == r
        if m.any():
            occ[m] = 0.55 + 0.45 * np.clip(lum[m] / np.percentile(lum[m], 90), 0, 1)   # folds, not stains
    return linear_to_srgb(np.clip(out, 0, 1)), np.repeat(occ[:, :, None], 3, 2)


KIT, SKINC, DARK = 1, 2, 3   # what the scan's texture shows under a triangle


def texture_class(v, tex):
    """Per triangle, from the colour at its centroid: light grey kit, skin, dark (boots, hair) or 0."""
    cuv = v["uv"][v["tri"]].mean(1)
    S = tex.shape[0]
    rgb = tex[np.clip((cuv[:, 1] * S).astype(int), 0, S - 1), np.clip((cuv[:, 0] * S).astype(int), 0, S - 1)]
    mx, mn = rgb.max(1), rgb.min(1)
    sat = (mx - mn) / np.maximum(mx, 1e-6)
    return np.select([mx < 0.2, (sat < 0.12) & (mx > 0.35), (sat > 0.18) & (rgb[:, 0] >= rgb[:, 1]) & (rgb[:, 1] >= rgb[:, 2])],
                     [DARK, KIT, SKINC], 0)


def fit_line(c, above):
    """Threshold t on c that best splits `above` (true where c > t), by counting the errors."""
    o = np.argsort(c)
    a = above[o].astype(int)
    err = np.concatenate([[0], np.cumsum(a)]) + np.concatenate([np.cumsum((1 - a)[::-1])[::-1], [0]])
    k = int(np.argmin(err))
    return c[o][max(k - 1, 0)] if k == len(c) else (c[o][k] + c[o][max(k - 1, 0)]) / 2


def scan_kit_lines(v, tex, lm):
    """The kit lines where the scan's own sleeve, shorts, socks and boots end, so the team
    colours land on the matching cloth. Waist, collar and wrist keep the mannequin's lines (on the
    head the light texels are hair highlights and ears, not cloth)."""
    cls = texture_class(v, tex)
    dom = dominant(v)[v["tri"][:, 0]]
    c = v["pos"][v["tri"]].mean(1)
    x, y = np.abs(c[:, 0]), c[:, 1]
    leg, arm = in_group(dom, LEG), in_group(dom, ARM)
    out = dict(lm)

    def fit(key, mask, coord, above, lo, hi, kinds):
        m = mask & np.isin(cls, kinds) & (coord > lo) & (coord < hi)
        if m.sum() > 20:
            out[key] = fit_line(coord[m], above[m])

    # top down, each line bounded by the one fitted before it
    fit("hem", leg, y, cls == KIT, lm["sock_top"] - 0.05, lm["waist"], (KIT, SKINC))
    fit("sock_top", leg, y, cls == SKINC, lm["boot_top"], out["hem"] - 0.02, (KIT, SKINC))
    fit("boot_top", leg, y, cls == KIT, lm["boot_top"] - 0.08, out["sock_top"] - 0.02, (KIT, DARK))
    fit("sleeve", arm, x, cls == SKINC, lm["sleeve"] - 0.12, lm["wrist"], (KIT, SKINC))
    return out, cls


def hair_triangles(v, cls, L):
    """Triangles of the scanned hair: texels that are not skin, on the head above the brows or behind the ears."""
    c = v["pos"][v["tri"]].mean(1)
    head = L["Head"]
    up = (c[:, 1] > head[1] + 0.09) | ((c[:, 1] > head[1] + 0.02) & (c[:, 2] < head[2] - 0.02))
    return up & (cls != SKINC)


def build_trellis(src, out=TRELLIS_OUT, ratio=TRELLIS_RATIO):
    src = Path(src).expanduser()
    man = Gltf(MANNEQUIN)
    target_ibm, target_names = man.ibms(), man.joint_names()
    L = landmarks(target_ibm)
    cur = Gltf(OUT)
    T = np.linalg.inv(target_ibm["root"]) @ cur.ibms()["root"]
    ref = [p for p in read_skinned(cur, "footballer", T) if p["material"] != "eyes"]
    ref_pos = np.concatenate([p["pos"] for p in ref])
    ref_jnt, ref_wgt = np.concatenate([p["jnt"] for p in ref]), np.concatenate([p["wgt"] for p in ref])
    far = read_skinned(cur, "footballer_lod1", T)[0]

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        run(GLTF_TRANSFORM + ["weld", str(src), str(tmp / "w.glb")])
        run(GLTF_TRANSFORM + ["simplify", str(tmp / "w.glb"), str(tmp / "s.glb"), "--ratio", str(ratio), "--error", "0.01"])
        g = Gltf(tmp / "s.glb")
    p = g.j["meshes"][0]["primitives"][0]
    a = p["attributes"]
    img = g.j["images"][g.j["materials"][p["material"]]["pbrMetallicRoughness"]["baseColorTexture"]["index"]]
    view = g.j["bufferViews"][img["bufferView"]]
    tex = decode_image(g.buffers[0][view.get("byteOffset", 0):view.get("byteOffset", 0) + view["byteLength"]], 1024)

    pos = align_trellis(g.acc(a["POSITION"]).astype(np.float64), L, ref_pos[:, 1].min())
    tri = g.acc(p["indices"]).reshape(-1, 3).astype(np.int64)
    tri = tri[outer_wall(pos, tri)]
    # the scan's hand is a flat mitten: finger bones would curl it into a claw, so it follows the hand
    hand = np.array([target_names.index("hand_" + n[-1]) if n.startswith(("index", "middle", "ring", "pinky", "thumb")) else i
                     for i, n in enumerate(target_names)])
    jnt, wgt = transfer_weights(pos, tri, ref_pos, hand[ref_jnt], ref_wgt, len(target_names))
    v = dict(pos=pos, nrm=vertex_normals(pos, tri, weld(pos)), jnt=jnt, wgt=wgt,
             uv=g.acc(a["TEXCOORD_0"]).astype(np.float64), tri=tri, names=target_names)
    lm, _ = scan_kit_lines(v, tex, limits(L))
    v = cut_kit_lines(v, lm)
    v["nrm"] = vertex_normals(v["pos"], v["tri"], weld(v["pos"]))
    tr = triangle_regions(v, lm)
    cls = texture_class(v, tex)
    tr[hair_triangles(v, cls, L) & (tr == SKIN)] = HAIR
    # the scan's shoulders rise above the mannequin's collar line: grey cloth under the ears, and
    # anything wider than the head, is shirt
    c = v["pos"][v["tri"]].mean(1)
    tr[(tr == SKIN) & (c[:, 1] > lm["waist"]) & (((cls == KIT) & (c[:, 1] < L["Head"][1] - 0.05)) | (np.abs(c[:, 0]) > 0.1))] = SHIRT
    texreg = texel_regions(v["uv"], v["tri"], tr, 1024)
    atlas, occ = trellis_atlases(tex, texreg, 1024)
    occ = occ[::2, ::2]                       # the folds are soft, half size is enough

    kit_uvs = {SHIRT: kit_uv(v["pos"], v["nrm"], lm["top"]), SHORTS: kit_uv(v["pos"], v["nrm"], lm["waist"]),
               SOCKS: socks_uv(v["pos"], lm)}
    w = Writer()
    armature = copy_skeleton(w, man)
    copy_clips(w, man)
    atlas_tex, occ_tex = w.texture(encode_jpeg(atlas)), w.texture(encode_jpeg(occ))
    names = REGIONS + ["hair1"]
    mats = {}
    for r, name in enumerate(names):
        if r in kit_uvs:
            mats[r] = w.material(name, (0.8, 0.1, 0.1), 0.85)
            # the scan's folds and seams over the team colour, from the second UV set
            w.j["materials"][mats[r]]["occlusionTexture"] = {"index": occ_tex, "texCoord": 1}
        else:
            rough = {BOOTS: 0.45, HAIR: 0.75}.get(r, 0.6)
            mats[r] = w.material(name, (0.62, 0.42, 0.32) if r != BOOTS else (0.03, 0.03, 0.03), rough, atlas_tex)
    prims = []
    for r in range(len(names)):
        t = v["tri"][tr == r]
        if len(t):
            prim = w.primitive(v, t, mats[r], kit_uvs.get(r, v["uv"]))
            used = np.unique(t.ravel())
            prim["attributes"]["TEXCOORD_1"] = w.accessor(v["uv"][used], "VEC2", 5126, 34962)
            prims.append(prim)
    add_mesh_node(w, armature, "footballer", w.mesh("footballer", prims))
    kit_far = w.material("kit_far", (1.0, 1.0, 1.0), 0.75)
    add_mesh_node(w, armature, "footballer_lod1", w.mesh("footballer_lod1", [w.primitive(far, far["tri"], kit_far, far["uv"])]))

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "raw.glb").write_bytes(w.glb())
        run(GLTF_TRANSFORM + ["prune", str(tmp / "raw.glb"), str(tmp / "pruned.glb"), "--keep-attributes", "true"])
        run(GLTF_TRANSFORM + ["quantize", str(tmp / "pruned.glb"), str(out), "--quantization-volume", "scene"])
    report(out)


def report(path):
    g = Gltf(path)
    for m in g.j["meshes"]:
        tris = sum(g.j["accessors"][p["indices"]]["count"] // 3 for p in m["primitives"])
        print(f"{m['name']:18s} {tris:6d} triangles  {[g.j['materials'][p['material']]['name'] for p in m['primitives']]}")
    print(f"{path}: {path.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("ubc", nargs="?", help='folder "Universal Base Characters[Standard]" of the unzipped pack')
    ap.add_argument("--trellis", type=Path, help="GLB from the TRELLIS.2 Space: builds footballer-trellis.glb instead")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    if args.trellis:
        build_trellis(args.trellis, args.out or TRELLIS_OUT)
    elif args.ubc:
        build(args.ubc, args.out or OUT)
    else:
        ap.error("give the UBC folder or --trellis")
