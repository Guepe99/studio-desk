// Smooth player paths for the 3D view. The tracking is sampled at 10 fps and match.js draws straight
// lines between samples, so the velocity jumps every 100 ms: a player's speed is a staircase and
// the acceleration a train of spikes (docs/flow3d.md has the numbers). Here each coordinate is a
// cubic Hermite curve with Catmull-Rom tangents (the central difference of the neighbouring
// samples): it passes exactly through every sample and its velocity is continuous in time.
// Uniform time knots on purpose: centripetal knots (alpha 0.5) avoid cusps in the shape, but with
// samples evenly spaced in time they rescale each segment differently and the speed jumps again.
// The ball stays linear: kicks are real velocity jumps, and ball3d.js bends its clock anyway.
// The 2D page keeps match.at(), so its smoke test sees the same positions as before.
//
//   const sm = smoothMatch(match);   // a Match whose at(i, ts) is smooth for players
export function smoothMatch(match) {
  const sm = Object.create(match);
  sm.at = (i, ts) => (i === 0 ? match.at(i, ts) : hermiteAt(match, i, ts));
  sm.linear = match;
  return sm;
}

export function hermiteAt(match, i, ts) {
  const { pos: p, n } = match, last = match.meta.frames - 1;
  const f = Math.min(Math.max(ts * match.meta.fps, 0), last);
  const f1 = Math.floor(f), f2 = Math.min(f1 + 1, last), u = f - f1;
  const o = (k) => (k * n + i) * 3;
  const a = o(f1), b = o(f2);
  if (Number.isNaN(p[a]) || Number.isNaN(p[b])) return null;
  // neighbours, mirrored at the ends of the data or of the player's time on the pitch
  const z = o(Math.max(f1 - 1, 0)), c = o(Math.min(f2 + 1, last));
  const zOk = f1 > 0 && !Number.isNaN(p[z]), cOk = f2 < last && !Number.isNaN(p[c]);
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const p1 = p[a + k], p2 = p[b + k];
    const p0 = zOk ? p[z + k] : 2 * p1 - p2, p3 = cOk ? p[c + k] : 2 * p2 - p1;
    out[k] = h00 * p1 + h10 * (p2 - p0) / 2 + h01 * p2 + h11 * (p3 - p1) / 2;
  }
  return out;
}
