"""Builds web/vendor/crowd/face.png: the anime footballers' face, drawn front-on, for the crowd.

The spectators (web/js/scene3d/crowd.js) are one thin-instanced low-poly mesh, too cheap to carry the
players' face mesh (about 2,000 vertices with morph targets). Instead the face of
web/vendor/players/anime.glb (anime_face: eyes with highlights, brows, lashes, mouth, from its face
atlas) is rasterised here, front-on and orthographic, into a card the spectator's face plate samples.

Layout, 512 x 512, y down: top half the neutral face, bottom half joy (the players' "joy" morph
target); in each half the left square is the colour (alpha = coverage, the skin shows through), the
right square the tint masks (red: iris, tinted by eye colour; green: brows, tinted by hair colour),
as the players' face material tints the same atlas rectangles (build_anime.TINT_RECTS, toon3d.js).

    .venv/bin/python scripts/build_crowd_face.py

Needs ffmpeg (PNG decode and encode), as build_anime.py.
"""
import importlib.util
import subprocess
from pathlib import Path

import numpy as np

_spec = importlib.util.spec_from_file_location("build_anime", Path(__file__).with_name("build_anime.py"))
ba = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ba)
bf = ba.bf

ANIME = bf.ROOT / "web/vendor/players/anime.glb"
OUT = bf.ROOT / "web/vendor/crowd/face.png"
CARD = 256        # px per face
SS = 3            # supersampling per axis
# the square of the face drawn, as shares of the face skin's width: centred across, its centre this far
# below the middle of the features (eyes to mouth), so the chin fits and the fringe line is above
CROP_W = 0.82
CROP_DY = 0.06
LIP = (0.6, 0.26, 0.22)   # the closed mouth, as the players show it


def _image(g, tex):
    """Float RGBA of a glTF texture embedded in the GLB."""
    im = g.j["images"][g.j["textures"][tex]["source"]]
    v = g.j["bufferViews"][im["bufferView"]]
    data = g.buffers[v["buffer"]][v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "-", "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
                         input=data, check=True, capture_output=True).stdout
    side = int(round((len(raw) / 4) ** 0.5))
    if side * side * 4 != len(raw):
        raise ValueError(f"texture {tex} is not square ({len(raw) // 4} pixels)")
    return np.frombuffer(raw, np.uint8).reshape(side, side, 4).astype(float) / 255


def face_parts(g):
    """(features, skin) of anime_face: dicts with pos (n, 3), uv (n, 2), tri (m, 3), targets [(n, 3)]."""
    mesh = next(m for m in g.j["meshes"] if m["name"] == "anime_face")
    out = {}
    for p in mesh["primitives"]:
        name = g.j["materials"][p["material"]]["name"]
        out[name] = {"pos": g.acc(p["attributes"]["POSITION"]), "uv": g.acc(p["attributes"]["TEXCOORD_0"]),
                     "tri": g.acc(p["indices"]).reshape(-1, 3), "targets": [g.acc(t["POSITION"]) for t in p["targets"]],
                     "tex": g.j["materials"][p["material"]]["pbrMetallicRoughness"]["baseColorTexture"]["index"]}
    names = mesh["extras"]["targetNames"]
    return out["face"], out["face_skin"], names


def rasterise(feat, atlas, pos, box, n, skin=None):
    """Front view (+Z towards the viewer) of the features on an n x n grid over box (x0, y0, side):
    colour (n, n, 4) with alpha 0/1 (alpha-tested at 0.5 like the material) and masks (n, n, 2).
    skin: (pos, tri) of the face skin, drawn first into the depth only: it hides the inner mouth and
    teeth of a closed mouth, as on the players."""
    col = np.zeros((n, n, 4)); mask = np.zeros((n, n, 2)); depth = np.full((n, n), -np.inf)
    if skin is not None:
        _draw(skin[0], skin[1], None, None, box, n, col, mask, depth)
    _draw(pos, feat["tri"], feat["uv"], atlas, box, n, col, mask, depth)
    return col, mask


def _draw(pos, tris, uvs, atlas, box, n, col, mask, depth):
    x0, y0, side = box
    px = (pos[:, 0] - x0) / side * n            # columns grow with +x: the character's left, the viewer's right
    py = (y0 + side - pos[:, 1]) / side * n     # rows grow downwards
    z = pos[:, 2]
    (ix0, iy0, ix1, iy1), (bx0, by0, bx1, by1) = ba.TINT_RECTS["iris"], ba.TINT_RECTS["brow"]
    for a, b, c in tris:
        xs, ys = px[[a, b, c]], py[[a, b, c]]
        c0, c1 = max(int(np.floor(xs.min())), 0), min(int(np.ceil(xs.max())), n - 1)
        r0, r1 = max(int(np.floor(ys.min())), 0), min(int(np.ceil(ys.max())), n - 1)
        if c0 > c1 or r0 > r1:
            continue
        gx, gy = np.meshgrid(np.arange(c0, c1 + 1) + 0.5, np.arange(r0, r1 + 1) + 0.5)
        d = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2])
        if abs(d) < 1e-12:
            continue
        w0 = ((ys[1] - ys[2]) * (gx - xs[2]) + (xs[2] - xs[1]) * (gy - ys[2])) / d
        w1 = ((ys[2] - ys[0]) * (gx - xs[2]) + (xs[0] - xs[2]) * (gy - ys[2])) / d
        w2 = 1 - w0 - w1
        ins = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not ins.any():
            continue
        zz = w0 * z[a] + w1 * z[b] + w2 * z[c]
        if uvs is None:   # occluder: depth only
            win = ins & (zz > depth[r0:r1 + 1, c0:c1 + 1])
            depth[r0:r1 + 1, c0:c1 + 1][win] = zz[win]
            continue
        A = atlas.shape[0]
        uv = w0[..., None] * uvs[a] + w1[..., None] * uvs[b] + w2[..., None] * uvs[c]
        tex = atlas[np.clip((uv[..., 1] * A).astype(int), 0, A - 1), np.clip((uv[..., 0] * A).astype(int), 0, A - 1)]
        win = ins & (tex[..., 3] >= 0.5) & (zz > depth[r0:r1 + 1, c0:c1 + 1])
        depth[r0:r1 + 1, c0:c1 + 1][win] = zz[win]
        col[r0:r1 + 1, c0:c1 + 1][win] = np.c_[tex[win][:, :3], np.ones(win.sum())]
        u, v = uv[..., 0][win], uv[..., 1][win]
        mask[r0:r1 + 1, c0:c1 + 1][win] = np.c_[(u >= ix0) & (u < ix1) & (v >= iy0) & (v < iy1),
                                                (u >= bx0) & (u < bx1) & (v >= by0) & (v < by1)]


def down(img, k, weight=None):
    """Box filter by k; with weight, a weighted mean (colour over coverage, so no dark fringe)."""
    h, w, c = img.shape
    if weight is None:
        return img.reshape(h // k, k, w // k, k, c).mean((1, 3))
    s = (img * weight[..., None]).reshape(h // k, k, w // k, k, c).sum((1, 3))
    ws = weight.reshape(h // k, k, w // k, k).sum((1, 3))[..., None]
    return np.where(ws > 0, s / np.maximum(ws, 1e-9), 0)


def build(src=ANIME, out=OUT):
    g = bf.Gltf(src)
    feat, skin, names = face_parts(g)
    atlas = _image(g, feat["tex"])
    # the crop square, from the neutral face
    fx = skin["pos"][:, 0]
    side = CROP_W * (fx.max() - fx.min())
    fy = feat["pos"][:, 1]
    cy = (fy.min() + fy.max()) / 2 - CROP_DY * side
    box = ((fx.max() + fx.min()) / 2 - side / 2, cy - side / 2, side)
    page = np.zeros((2 * CARD, 2 * CARD, 4))
    for row, expr in enumerate([None, "joy"]):
        k = names.index(expr) if expr else None
        pos = feat["pos"] + (feat["targets"][k] if expr else 0)
        spos = skin["pos"] + (skin["targets"][k] if expr else 0)
        col, mask = rasterise(feat, atlas, pos, box, CARD * SS, (spos, skin["tri"]))
        a = col[..., 3]
        rgb = down(col[..., :3], SS, a)
        cov = down(a[..., None], SS)
        if not expr:
            # the closed mouth: a hairline, near white in the atlas, that the players' lip shading reddens;
            # drawn here in lip red, three times as dense and a row thicker, so it reads at crowd size
            low = (np.arange(CARD) > CARD * 0.55)[:, None, None]
            thick = np.clip(np.maximum(cov, np.roll(cov, 1, 0)) * 3, 0, 1)
            cov = np.where(low, thick, cov)
            rgb = np.where(low & (cov > 0), LIP, rgb)
        m = down(mask, SS, a)
        page[row * CARD:(row + 1) * CARD, :CARD] = np.c_[rgb.reshape(-1, 3), cov.reshape(-1, 1)].reshape(CARD, CARD, 4)
        page[row * CARD:(row + 1) * CARD, CARD:, :2] = m
        # the masks' alpha stays 0: the plate's edge filters across the seam into this square, and an
        # opaque one there would draw a dark rim on every face (Babylon uploads without premultiplying)
    Path(out).write_bytes(ba.encode(page, "png"))
    return page


if __name__ == "__main__":
    p = build()
    print(f"{OUT.relative_to(bf.ROOT)}: {p.shape[1]}x{p.shape[0]}, neutral coverage {p[:CARD, :CARD, 3].mean():.3f}")
