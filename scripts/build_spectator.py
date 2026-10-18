"""Builds web/vendor/crowd/spectator.glb: the low-poly spectator of the 3D crowd.

The far body of web/vendor/players/footballer.glb (`footballer_lod1`, one primitive whose UVs point
at an 8 x 1 region palette: skin, shirt, shorts, socks, boots, forearms, hands, eyes), decimated by
gltf-transform to a few hundred triangles, on the same skeleton, with four clips: Idle_Loop from
the footballer file and M_clap, M_celeb_arms_up, M_celeb_jump_fist from web/vendor/motion/clips.glb
(channels re-targeted by node name). The page bakes the poses into a vertex animation texture
(web/js/scene3d/crowd.js).

    .venv/bin/python scripts/build_spectator.py

Needs npx with @gltf-transform/cli 4.5.1 (prune, simplify), as scripts/build_footballer.py.
"""
import argparse
import json
import struct
import tempfile
from pathlib import Path

import numpy as np

from build_footballer import CTYPE, GLTF_TRANSFORM, NCOMP, ROOT, Gltf, report, run

FOOTBALLER = ROOT / "web/vendor/players/footballer.glb"
CLIPS = ROOT / "web/vendor/motion/clips.glb"
OUT = ROOT / "web/vendor/crowd/spectator.glb"
KEEP = {"Idle_Loop"}
MOTION = ("M_clap", "M_celeb_arms_up", "M_celeb_jump_fist")
RATIO = 0.085   # about 360 of the 4,288 triangles


def glb(j, bin_):
    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    bin_ = bytes(bin_) + b"\0" * (-len(bin_) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_)
    return (struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
            + struct.pack("<II", len(bin_), 0x004E4942) + bin_)


def merge(src, clips):
    """src's document with only the far body, Idle_Loop, and the MOTION clips of `clips`."""
    j = json.loads(json.dumps(src.j))
    bin_ = bytearray(src.buffers[0])
    for n in j["nodes"]:
        if "mesh" in n and n.get("name") != "footballer_lod1":
            n.pop("mesh"), n.pop("skin", None)
    body = next(n for n in j["nodes"] if n.get("name") == "footballer_lod1")
    j["materials"][j["meshes"][body["mesh"]]["primitives"][0]["material"]]["name"] = "spectator"
    j["animations"] = [a for a in j["animations"] if a["name"] in KEEP]
    node_of = {n["name"]: i for i, n in enumerate(j["nodes"]) if "name" in n}

    def copy(i, done={}):
        """Accessor i of clips appended to bin_ (tightly packed)."""
        if i not in done:
            a = dict(clips.j["accessors"][i])
            v = clips.j["bufferViews"][a.pop("bufferView")]
            dt, n = np.dtype(CTYPE[a["componentType"]]), NCOMP[a["type"]]
            start = v.get("byteOffset", 0) + a.get("byteOffset", 0)
            raw = np.ndarray((a["count"], n), dt, clips.buffers[v["buffer"]], start,
                             (v.get("byteStride", dt.itemsize * n), dt.itemsize)).copy()   # bytes as they are
            a.pop("byteOffset", None)
            while len(bin_) % 4:
                bin_.append(0)
            j["bufferViews"].append({"buffer": 0, "byteOffset": len(bin_), "byteLength": raw.nbytes})
            bin_.extend(raw.tobytes())
            a["bufferView"] = len(j["bufferViews"]) - 1
            j["accessors"].append(a)
            done[i] = len(j["accessors"]) - 1
        return done[i]

    for an in clips.j["animations"]:
        if an["name"] not in MOTION:
            continue
        chans = [c for c in an["channels"] if clips.j["nodes"][c["target"]["node"]]["name"] in node_of]
        samplers, remap = [], {}
        for c in chans:
            if c["sampler"] not in remap:
                s = an["samplers"][c["sampler"]]
                samplers.append(dict(s, input=copy(s["input"]), output=copy(s["output"])))
                remap[c["sampler"]] = len(samplers) - 1
        j["animations"].append({"name": an["name"], "samplers": samplers, "channels": [
            {"sampler": remap[c["sampler"]], "target": {"node": node_of[clips.j["nodes"][c["target"]["node"]]["name"]],
                                                        "path": c["target"]["path"]}} for c in chans]})
    missing = set(MOTION) - {a["name"] for a in j["animations"]}
    assert not missing, f"clips not found: {missing}"
    j["buffers"] = [{"byteLength": len(bin_)}]
    return j, bin_


def build(out=OUT, ratio=RATIO):
    j, bin_ = merge(Gltf(FOOTBALLER), Gltf(CLIPS))
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "raw.glb").write_bytes(glb(j, bin_))
        run(GLTF_TRANSFORM + ["prune", str(tmp / "raw.glb"), str(tmp / "pruned.glb"), "--keep-attributes", "true"])
        out.parent.mkdir(parents=True, exist_ok=True)
        run(GLTF_TRANSFORM + ["simplify", str(tmp / "pruned.glb"), str(out), "--ratio", str(ratio), "--error", "0.02"])
    report(out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--ratio", type=float, default=RATIO)
    a = ap.parse_args()
    build(a.out, a.ratio)
