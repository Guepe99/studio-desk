"""Retarget generated motion onto the Quaternius UAL skeleton and write web/vendor/motion/clips.glb.

Sources (docs/motion3d.md): NVIDIA Kimodo (SOMA skeleton, 30 fps) NPZ exports, reduced to the joints
we map and committed in scripts/motion/<name>.npz; the manifest scripts/motion/clips.json says which
clips to build, with their prompt, seed and whether they loop.

    .venv/bin/python scripts/retarget_motion.py import NAME RAW.npz   # Kimodo export -> scripts/motion/NAME.npz
    .venv/bin/python scripts/retarget_motion.py build                 # -> web/vendor/motion/clips.glb + clips.json

Method. Kimodo's global joint rotations are the identity in its T-pose, and the UAL mannequin's rest
pose is a T-pose in the same frame (Y up, +Z forward, the left side at +X, metres), so a mapped bone k
of joint j gets the world rotation  G_k(t) = H(t) D_j(t) R_k,  where D_j is the source rotation, R_k the
bone's world rest rotation and H(t) removes the clip's smoothed heading (the tracking owns the facing).
Local rotations follow from the parents. The hips keep their height and their sway around the smoothed
path; the path itself is removed (the tracking owns the root). Clips flagged `root` (the goalkeeper's
dives) instead keep the start heading for the whole clip and leave the pelvis at rest: all the hips'
travel from the start (left, up, forward, metres, in the character's frame) goes to a separate curve
in clips.json, for the scene to move the body away from the tracked spot. Fingers and twist-free bones that are not
mapped are not keyed, so they stay in whatever pose the scene's other clips give them. Loops are cut
where the pose comes back closest to the start and cross-faded over the seam.
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
UAL = ROOT / "web/vendor/quaternius/mannequin.glb"
SRC = ROOT / "scripts/motion"
OUT = ROOT / "web/vendor/motion"
FPS = 30.0

# UAL bone <- SOMA joint
MAP = {
    "pelvis": "Hips", "spine_01": "Spine1", "spine_02": "Spine2", "spine_03": "Chest",
    "neck_01": "Neck1", "Head": "Head",
    "clavicle_l": "LeftShoulder", "upperarm_l": "LeftArm", "lowerarm_l": "LeftForeArm", "hand_l": "LeftHand",
    "clavicle_r": "RightShoulder", "upperarm_r": "RightArm", "lowerarm_r": "RightForeArm", "hand_r": "RightHand",
    "thigh_l": "LeftLeg", "calf_l": "LeftShin", "foot_l": "LeftFoot", "ball_l": "LeftToeBase",
    "thigh_r": "RightLeg", "calf_r": "RightShin", "foot_r": "RightFoot", "ball_r": "RightToeBase",
}
SOMA = list(dict.fromkeys(MAP.values()))   # the joints kept from an export, in this order
# SOMA 77-joint export: index of each kept joint (kimodo/skeleton/definitions.py, SOMASkeleton77)
SOMA77 = {"Hips": 0, "Spine1": 1, "Spine2": 2, "Chest": 3, "Neck1": 4, "Neck2": 5, "Head": 6,
          "LeftShoulder": 11, "LeftArm": 12, "LeftForeArm": 13, "LeftHand": 14,
          "RightShoulder": 39, "RightArm": 40, "RightForeArm": 41, "RightHand": 42,
          "LeftLeg": 67, "LeftShin": 68, "LeftFoot": 69, "LeftToeBase": 70,
          "RightLeg": 72, "RightShin": 73, "RightFoot": 74, "RightToeBase": 75}
SOMA30 = {"Hips": 0, "Spine1": 1, "Spine2": 2, "Chest": 3, "Neck1": 4, "Neck2": 5, "Head": 6,
          "LeftShoulder": 10, "LeftArm": 11, "LeftForeArm": 12, "LeftHand": 13,
          "RightShoulder": 16, "RightArm": 17, "RightForeArm": 18, "RightHand": 19,
          "LeftLeg": 22, "LeftShin": 23, "LeftFoot": 24, "LeftToeBase": 25,
          "RightLeg": 26, "RightShin": 27, "RightFoot": 28, "RightToeBase": 29}


# ---------------------------------------------------------------- quaternions (x, y, z, w)
def q2m(q):
    q = np.asarray(q, float)
    x, y, z, w = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    return np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], -1),
        np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], -1),
        np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1)], -2)


def m2q(m):
    m = np.asarray(m, float)
    t = np.trace(m, axis1=-2, axis2=-1)
    q = np.empty(m.shape[:-2] + (4,))
    # robust per element: pick the largest of w, x, y, z
    cand = np.stack([t, m[..., 0, 0], m[..., 1, 1], m[..., 2, 2]], -1)
    k = np.argmax(cand, -1)
    for c in range(4):
        s = k == c
        if not s.any():
            continue
        M = m[s]
        if c == 0:
            r = np.sqrt(1 + np.trace(M, axis1=-2, axis2=-1)) * 2
            q[s] = np.stack([(M[:, 2, 1] - M[:, 1, 2]) / r, (M[:, 0, 2] - M[:, 2, 0]) / r, (M[:, 1, 0] - M[:, 0, 1]) / r, r / 4], -1)
        else:
            i = c - 1
            j, m2 = (i + 1) % 3, (i + 2) % 3
            r = np.sqrt(1 + M[:, i, i] - M[:, j, j] - M[:, m2, m2]) * 2
            v = np.empty((len(M), 4))
            v[:, i] = r / 4
            v[:, j] = (M[:, j, i] + M[:, i, j]) / r
            v[:, m2] = (M[:, m2, i] + M[:, i, m2]) / r
            v[:, 3] = (M[:, m2, j] - M[:, j, m2]) / r
            q[s] = v
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def continuous(q):
    """Flip signs so consecutive quaternions (axis 0) stay in one hemisphere."""
    q = q.copy()
    for t in range(1, len(q)):
        flip = np.sum(q[t] * q[t - 1], -1) < 0
        q[t][flip] *= -1
    return q


def slerp(a, b, u):
    d = np.sum(a * b, -1, keepdims=True)
    b = np.where(d < 0, -b, b)
    out = a * (1 - u) + b * u   # nlerp is enough for neighbouring poses
    return out / np.linalg.norm(out, axis=-1, keepdims=True)


def roty(a):
    c, s = np.cos(a), np.sin(a)
    z, o = np.zeros_like(a), np.ones_like(a)
    return np.stack([np.stack([c, z, s], -1), np.stack([z, o, z], -1), np.stack([-s, z, c], -1)], -2)


def gauss(x, sigma_frames, axis=0):
    """Gaussian smoothing with edge padding."""
    r = int(3 * sigma_frames) + 1
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma_frames) ** 2)
    k /= k.sum()
    pad = [(0, 0)] * x.ndim
    pad[axis] = (r, r)
    xp = np.pad(x, pad, mode="edge")
    return np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), axis, xp)


# ---------------------------------------------------------------- the UAL skeleton
def read_glb(path):
    b = Path(path).read_bytes()
    n = struct.unpack("<I", b[12:16])[0]
    return json.loads(b[20:20 + n])


class Skeleton:
    def __init__(self, path=UAL):
        j = read_glb(path)
        self.nodes = j["nodes"]
        self.joints = j["skins"][0]["joints"]
        self.name = {nd["name"]: i for i, nd in enumerate(self.nodes)}
        self.parent = {}
        for i, nd in enumerate(self.nodes):
            for c in nd.get("children", []):
                self.parent[c] = i
        self.T = {i: np.array(nd.get("translation", [0, 0, 0]), float) for i, nd in enumerate(self.nodes)}
        self.R = {i: np.array(nd.get("rotation", [0, 0, 0, 1]), float) for i, nd in enumerate(self.nodes)}
        self.S = {i: np.array(nd.get("scale", [1, 1, 1]), float) for i, nd in enumerate(self.nodes)}
        self.armature = next(i for i in self.nodes_up(self.joints[0]) if i not in self.joints)
        self.W = {}
        for i in self.joints:
            self.world(i)

    def nodes_up(self, i):
        out = []
        while i in self.parent:
            i = self.parent[i]
            out.append(i)
        return out

    def local(self, i):
        M = np.eye(4)
        M[:3, :3] = q2m(self.R[i]) * self.S[i]
        M[:3, 3] = self.T[i]
        return M

    def world(self, i):
        if i not in self.W:
            self.W[i] = (self.world(self.parent[i]) @ self.local(i)) if i in self.parent else self.local(i)
        return self.W[i]

    def rot_world(self, i):
        M = self.world(i)[:3, :3]
        return M / np.linalg.norm(M, axis=0)

    def order(self):
        """Joints with parents before children."""
        seen, out = set(), []
        def visit(i):
            if i in seen:
                return
            if i in self.parent and self.parent[i] in self.joints:
                visit(self.parent[i])
            seen.add(i)
            out.append(i)
        for i in self.joints:
            visit(i)
        return out


# ---------------------------------------------------------------- source data
def import_kimodo(name, raw):
    d = np.load(raw, allow_pickle=False)
    G = d["global_rot_mats"]
    idx = SOMA77 if G.shape[1] == 77 else SOMA30 if G.shape[1] == 30 else None
    if idx is None:
        raise SystemExit(f"unexpected joint count {G.shape[1]}")
    sel = [idx[n] for n in SOMA]
    fc = d["foot_contacts"]
    fc = fc[:, [0, 1, 3, 4]] if fc.shape[1] == 6 else fc   # L heel, L toe, R heel, R toe
    SRC.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(SRC / f"{name}.npz", quat=continuous(m2q(G[:, sel])).astype(np.float32),
                        pos=d["posed_joints"][:, sel].astype(np.float32), contacts=fc.astype(bool))
    print(f"{name}: {len(G)} frames, {G.shape[1]} joints -> {len(sel)}")


def load_source(name):
    d = np.load(SRC / f"{name}.npz", allow_pickle=False)
    return {"rot": q2m(d["quat"].astype(float)), "pos": d["pos"].astype(float), "contacts": d["contacts"]}


# ---------------------------------------------------------------- retarget
def retarget(src, sk: Skeleton, loop=False, root=False):
    rot, pos, con = src["rot"], src["pos"], src["contacts"]
    J = {n: k for k, n in enumerate(SOMA)}
    n = len(rot)
    # heading: the hips' forward on the ground, unwrapped and smoothed over 0.5 s
    f = rot[:, J["Hips"]] @ np.array([0, 0, 1.0])
    yaw = np.unwrap(np.arctan2(f[:, 0], f[:, 2]))
    # a root clip keeps its start heading: a dive rolls the hips, and that roll is the motion
    yaw_s = np.full(n, yaw[:int(0.2 * FPS)].mean()) if root else gauss(yaw, 0.5 * FPS)
    H = roty(-yaw_s)
    hips = pos[:, J["Hips"]]
    path = np.broadcast_to(hips[0], hips.shape).copy() if root else gauss(hips, 0.5 * FPS)
    # scale: the target's hip-to-ankle length over the source's
    leg_s = np.linalg.norm(pos[:, J["LeftShin"]] - pos[:, J["LeftLeg"]], axis=-1).mean() + \
        np.linalg.norm(pos[:, J["LeftFoot"]] - pos[:, J["LeftShin"]], axis=-1).mean()
    nm = sk.name
    leg_t = np.linalg.norm(sk.world(nm["calf_l"])[:3, 3] - sk.world(nm["thigh_l"])[:3, 3]) + \
        np.linalg.norm(sk.world(nm["foot_l"])[:3, 3] - sk.world(nm["calf_l"])[:3, 3])
    s = leg_t / leg_s
    # standing hips height of the source: hips-to-ankle drop in the T-pose plus the ankle height on contact
    drop = -(rot[0, J["Hips"]].T @ (pos[0, J["LeftLeg"]] - hips[0]))[1] + leg_s
    ankle = np.concatenate([pos[con[:, 0], J["LeftFoot"], 1], pos[con[:, 2], J["RightFoot"], 1]])
    ankle_h = float(np.median(ankle)) if len(ankle) else 0.08
    stand = drop + ankle_h
    pel_rest = sk.world(nm["pelvis"])[:3, 3]
    off = np.einsum("tij,tj->ti", H, hips - path)
    off[:, 1] = hips[:, 1] - stand
    pel_world = pel_rest + (0 * off if root else off * s)
    root_inv = np.linalg.inv(sk.world(sk.parent[nm["pelvis"]]))
    pel_local = (root_inv[:3, :3] @ pel_world.T).T + root_inv[:3, 3]

    # world rotations of the mapped bones, then locals
    Gw = {}
    for b, j in MAP.items():
        Gw[nm[b]] = H @ rot[:, J[j]] @ sk.rot_world(nm[b])
    local = {}
    for b in MAP:
        k = nm[b]
        p = sk.parent[k]
        Pw = Gw[p] if p in Gw else np.broadcast_to(sk.rot_world(p), Gw[k].shape)
        local[b] = continuous(m2q(np.swapaxes(Pw, -1, -2) @ Gw[k]))
    # ground velocity in the clip's own frame (for loops: the speed at which the feet do not slide)
    v = np.gradient(path, axis=0) * FPS
    v_local = np.einsum("tij,tj->ti", H, v) * s
    out = {"rot": local, "pel": pel_local, "n": n, "scale": s, "contacts": con, "vel": v_local, "H": H}
    if root:
        out["root"] = off * s   # [left, up, forward] of the hips from the start; standing height is up 0
    if loop:
        out = make_loop(out, pos, J)
    return out


def make_loop(c, pos, J):
    """Cut the stretch whose end pose comes back closest to its start, then cross-fade the seam."""
    n = c["n"]
    feat = np.concatenate([c["rot"][b] for b in ("thigh_l", "calf_l", "thigh_r", "calf_r", "pelvis")], -1)
    best = (1e9, 0, n - 1)
    lo, hi = int(0.6 * FPS), int(2.4 * FPS)
    for a in range(int(0.3 * FPS), n // 2):
        for b in range(a + lo, min(n, a + hi)):
            d = 1 - np.abs(np.sum(feat[a].reshape(-1, 4) * feat[b].reshape(-1, 4), -1)).mean()
            if d < best[0]:
                best = (d, a, b)
    _, a, b = best
    k = min(6, (b - a) // 4)
    out = {"n": b - a, "scale": c["scale"], "loop_err": best[0], "cut": (a, b)}
    out["rot"] = {}
    for name, q in c["rot"].items():
        q = q[a:b].copy()
        for i in range(k):   # the last k frames ease towards the first frame
            u = (i + 1) / (k + 1)
            q[b - a - k + i] = slerp(q[b - a - k + i], c["rot"][name][a], u)
        out["rot"][name] = continuous(q)
    p = c["pel"][a:b].copy()
    for i in range(k):
        u = (i + 1) / (k + 1)
        p[b - a - k + i] = p[b - a - k + i] * (1 - u) + c["pel"][a] * u
    out["pel"] = p
    out["contacts"] = c["contacts"][a:b]
    out["vel"] = c["vel"][a:b]
    return out


def fk_feet(c, sk: Skeleton):
    """World positions (clip frame, root in place) of both ankles: the foot-slide check."""
    nm = sk.name
    out = {}
    for side in "lr":
        chain = [nm[x] for x in ("pelvis", f"thigh_{side}", f"calf_{side}", f"foot_{side}")]
        M = np.broadcast_to(sk.world(sk.parent[chain[0]]), (c["n"], 4, 4)).copy()
        for k in chain:
            L = np.broadcast_to(np.eye(4), (c["n"], 4, 4)).copy()
            name = sk.nodes[k]["name"]
            L[:, :3, :3] = q2m(c["rot"][name]) if name in c["rot"] else q2m(sk.R[k])
            L[:, :3, 3] = c["pel"] if name == "pelvis" else sk.T[k]
            M = M @ L
        out[side] = M[:, :3, 3]
    return out


def foot_slide(c, sk, speed_dir=None):
    """Mean horizontal speed (m/s) of a foot while the source marks it planted, after the hips
    travel at the loop's ground speed (zero for in-place clips)."""
    feet = fk_feet(c, sk)
    vals = []
    for side, cols in (("l", [0, 1]), ("r", [2, 3])):
        v = np.gradient(feet[side], axis=0) * FPS
        if speed_dir is not None:
            v = v + speed_dir
        on = c["contacts"][:, cols].any(1)
        if on.any():
            vals.append(np.linalg.norm(v[on][:, [0, 2]], axis=1).mean())
    return float(np.mean(vals)) if vals else 0.0


# ---------------------------------------------------------------- glTF writer
def write_glb(clips, sk: Skeleton, path):
    keep = [sk.armature] + sk.joints
    remap = {old: k for k, old in enumerate(keep)}
    nodes = []
    for old in keep:
        nd = {k: v for k, v in sk.nodes[old].items() if k in ("name", "translation", "rotation", "scale")}
        ch = [remap[c] for c in sk.nodes[old].get("children", []) if c in remap]
        if ch:
            nd["children"] = ch
        nodes.append(nd)
    blob = bytearray()
    views, accs, anims = [], [], []

    def add(arr, comp, typ, normalized=False, minmax=False):
        while len(blob) % 4:
            blob.append(0)
        off = len(blob)
        blob.extend(arr.tobytes())
        views.append({"buffer": 0, "byteOffset": off, "byteLength": arr.nbytes})
        a = {"bufferView": len(views) - 1, "componentType": comp, "count": len(arr), "type": typ}
        if normalized:
            a["normalized"] = True
        if minmax:
            a["min"], a["max"] = [float(arr.min())], [float(arr.max())]
        accs.append(a)
        return len(accs) - 1

    for name, c in clips.items():
        t = (np.arange(c["n"]) / FPS).astype(np.float32)
        ti = add(t, 5126, "SCALAR", minmax=True)
        samplers, channels = [], []
        for b, q in c["rot"].items():
            qi = np.round(np.clip(q, -1, 1) * 32767).astype(np.int16)   # glTF normalized SHORT rotation
            samplers.append({"input": ti, "output": add(qi, 5122, "VEC4", normalized=True), "interpolation": "LINEAR"})
            channels.append({"sampler": len(samplers) - 1, "target": {"node": remap[sk.name[b]], "path": "rotation"}})
        samplers.append({"input": ti, "output": add(c["pel"].astype(np.float32), 5126, "VEC3"), "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": remap[sk.name["pelvis"]], "path": "translation"}})
        anims.append({"name": name, "samplers": samplers, "channels": channels})
    while len(blob) % 4:
        blob.append(0)
    gl = {"asset": {"version": "2.0", "generator": "studiodesk scripts/retarget_motion.py"},
          "scene": 0, "scenes": [{"nodes": [0]}], "nodes": nodes, "animations": anims,
          "buffers": [{"byteLength": len(blob)}], "bufferViews": views, "accessors": accs}
    js = json.dumps(gl, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob))
    out += struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(blob), 0x004E4942) + bytes(blob)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(out)
    return len(out)


def build():
    manifest = json.loads((SRC / "clips.json").read_text())
    sk = Skeleton()
    clips, meta = {}, {}
    for name, m in manifest["clips"].items():
        c = retarget(load_source(m["source"]), sk, loop=m.get("loop", False), root=m.get("root", False))
        if m.get("loop"):
            v = c["vel"].mean(0)
            speed = float(np.hypot(v[0], v[2]))
            slide = foot_slide(c, sk, speed_dir=v)
            meta[name] = {"len": round(c["n"] / FPS, 4), "loop": True, "speed": round(speed, 3),
                          "dir": [round(float(v[0] / max(speed, 1e-6)), 3), round(float(v[2] / max(speed, 1e-6)), 3)],
                          "stride": round(speed * c["n"] / FPS, 3)}
            extra = f"loop cut {c['cut']} err {c['loop_err']:.4f} speed {speed:.2f} m/s"
        elif m.get("root"):
            # the feet travel with the root: the slide is measured with the root's velocity added
            slide = foot_slide(c, sk, speed_dir=np.gradient(c["root"], axis=0) * FPS)
            meta[name] = {"len": round(c["n"] / FPS, 4), "loop": False, "root": np.round(c["root"], 3).tolist()}
            r = c["root"]
            extra = f"root end left {r[-1, 0]:+.2f} fwd {r[-1, 2]:+.2f}, up {r[:, 1].min():+.2f}..{r[:, 1].max():+.2f} m"
        else:
            slide = foot_slide(c, sk)
            meta[name] = {"len": round(c["n"] / FPS, 4), "loop": bool(m.get("repeat", False))}
            extra = ""
        meta[name]["full"] = bool(m.get("full", False))
        meta[name]["slide"] = round(slide, 3)
        clips[name] = c
        print(f"{name:22s} {c['n'] / FPS:5.2f} s  scale {c['scale']:.3f}  foot slide {slide:.3f} m/s  {extra}")
    size = write_glb(clips, sk, OUT / "clips.glb")
    (OUT / "clips.json").write_text(json.dumps({"fps": FPS, "clips": meta}, indent=1) + "\n")
    print(f"clips.glb {size / 1024:.0f} KB, {len(clips)} clips")


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "import":
        import_kimodo(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 2 and sys.argv[1] == "build":
        build()
    else:
        raise SystemExit(__doc__)
