// Goal netting that bulges where a scored ball presses it (docs/motion3d.md). The ball plan
// (ball3d.js, plan.net(ts)) says which panel the ball presses, where and how deep; here each
// goal's four panels are one grid mesh whose vertices are pushed out along the panel's normal in
// a pocket around the ball: a Gaussian falloff, held at the frame and the pegs.
// Scene axes as scene3d.js: X = x - 52.5, Y up, Z = y - 34.

const STEP = 0.2;        // m between grid vertices
const SIGMA = 0.8;       // m, width of the pocket (wide enough to read from the broadcast camera)
const PIN = 0.5;         // m from the frame over which the cords are free to move
const PIN_PEG = 0.25;    // m, the same at the pegged bottom edge, which sits looser

const smooth = (u) => { const t = Math.min(1, Math.max(0, u)); return t * t * (3 - 2 * t); };

// The four panels of the goal at end s (+1 the x = 105 end), in scene metres: origin o, edge
// vectors U and V, outward normal n, and whether V = 0 is the pegged bottom edge.
export function netPanels(s, halfL, { GW, GH, D }) {
  const x = s * halfL;
  return [
    { name: "back", o: [x + s * D, 0, -GW / 2], U: [0, 0, GW], V: [0, GH * 0.9, 0], n: [s, 0, 0], peg: true },
    { name: "roof", o: [x, GH, -GW / 2], U: [0, 0, GW], V: [s * D, -GH * 0.1, 0], n: [0, 1, 0], peg: false },
    { name: "side", o: [x, 0, -GW / 2], U: [s * D, 0, 0], V: [0, GH, 0], n: [0, 0, -1], peg: true },
    { name: "side", o: [x, 0, GW / 2], U: [s * D, 0, 0], V: [0, GH, 0], n: [0, 0, 1], peg: true },
  ];
}

// Share 0..1 of the press depth at panel point (pu, pv), metres along U and V of a panel lu x lv,
// for a press centred at (cu, cv): full at the ball, nothing at the frame.
export function bulge(pu, pv, lu, lv, cu, cv, peg = false) {
  const pin = (u, v) => smooth(Math.min(u, lu - u, lv - v) / PIN) * smooth(v / (peg ? PIN_PEG : PIN));
  const g = Math.exp(-((pu - cu) ** 2 + (pv - cv) ** 2) / (2 * SIGMA * SIGMA));
  // scaled so the ball's own point is fully pushed even near an edge (the cords stretch there)
  return Math.min(1, (g * pin(pu, pv)) / Math.max(pin(cu, cv), 0.3));
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

export class GoalNets {
  // B: BABYLON; material: the net material (texture tile = 4 cells of `cell` metres)
  constructor(B, scene, material, halfL, dims, cell) {
    this.ends = {};
    for (const s of [-1, 1]) {
      const pos = [], uv = [], nor = [], idx = [], panels = netPanels(s, halfL, dims);
      for (const p of panels) {
        const lu = len(p.U), lv = len(p.V), nu = Math.ceil(lu / STEP), nv = Math.ceil(lv / STEP);
        p.lu = lu; p.lv = lv; p.first = pos.length / 3; p.nu = nu; p.nv = nv;
        for (let j = 0; j <= nv; j++) {
          for (let i = 0; i <= nu; i++) {
            const a = i / nu, b = j / nv;
            for (let k = 0; k < 3; k++) pos.push(p.o[k] + p.U[k] * a + p.V[k] * b);
            uv.push((a * lu) / cell, (b * lv) / cell);
            nor.push(...p.n);
            if (i < nu && j < nv) {
              const v0 = p.first + j * (nu + 1) + i;
              idx.push(v0, v0 + 1, v0 + nu + 2, v0, v0 + nu + 2, v0 + nu + 1);
            }
          }
        }
      }
      const mesh = new B.Mesh(`net${s}`, scene);
      const vd = new B.VertexData();
      vd.positions = pos; vd.uvs = uv; vd.normals = nor; vd.indices = idx;
      vd.applyToMesh(mesh, true);
      mesh.material = material;
      mesh.freezeWorldMatrix();
      this.ends[s] = { mesh, rest: Float32Array.from(pos), now: Float32Array.from(pos), panels, pressed: false };
    }
  }

  // press: plan.net(ts) mapped to scene metres, { end, plane, at: [X, Y, Z], depth } or null
  update(press) {
    for (const s of [-1, 1]) {
      const E = this.ends[s], on = press && press.end === s && Math.abs(press.depth) > 1e-3;
      if (!on && !E.pressed) continue;
      E.now.set(E.rest);
      if (on) {
        // the panel of that kind nearest the ball (the two sides share a name)
        let best = null, bd = Infinity;
        for (const p of E.panels) {
          if (p.name !== press.plane) continue;
          const d = Math.abs(dot([press.at[0] - p.o[0], press.at[1] - p.o[1], press.at[2] - p.o[2]], p.n));
          if (d < bd) { bd = d; best = p; }
        }
        if (best) this._push(E, best, press);
      }
      E.mesh.updateVerticesData("position", E.now);
      E.pressed = on;
    }
  }

  _push(E, p, press) {
    const rel = [press.at[0] - p.o[0], press.at[1] - p.o[1], press.at[2] - p.o[2]];
    const cu = dot(rel, p.U) / p.lu, cv = dot(rel, p.V) / p.lv;
    for (let j = 0; j <= p.nv; j++) {
      for (let i = 0; i <= p.nu; i++) {
        const w = bulge((i / p.nu) * p.lu, (j / p.nv) * p.lv, p.lu, p.lv, cu, cv, p.peg) * press.depth;
        if (Math.abs(w) < 1e-4) continue;
        const v = 3 * (p.first + j * (p.nu + 1) + i);
        for (let k = 0; k < 3; k++) E.now[v + k] += p.n[k] * w;
      }
    }
  }
}
