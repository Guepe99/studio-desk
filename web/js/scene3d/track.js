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

// The tracking jumps at the half-time whistle (the teams change ends, up to 95 m): frame
// halfFrame (the second half's first, at ts = period1_s) starts a new path, so the curve, the root
// and every speed estimate treat it as a data end. The first half's last 0.1 s carries on at its
// end velocity up to the whistle instead of sliding to the other end of the pitch.
export const halfFrame = (match) => Math.round(match.meta.period1_s * match.meta.fps);
// [from, to] of the half holding ts (the second half starts at period1_s)
export function halfSpan(match, ts) {
  const h = match.meta?.period1_s ?? Infinity;
  return ts < h ? [0, Math.min(match.duration, h - 1e-6)] : [h, match.duration];
}
// Velocity [vx, vy] of a path at(t) -> [x, y] over ts +- h, kept inside ts's half; where at() is
// null (off the pitch) `here` stands in at ts.
export function velocityAt(match, at, ts, h, here) {
  const [lo, hi] = halfSpan(match, ts);
  let t0 = Math.max(lo, ts - h), t1 = Math.min(hi, ts + h), a = at(t0), c = at(t1);
  if (!a) { a = here; t0 = ts; }
  if (!c) { c = here; t1 = ts; }
  return t1 > t0 ? [(c[0] - a[0]) / (t1 - t0), (c[1] - a[1]) / (t1 - t0)] : [0, 0];
}

export function hermiteAt(match, i, ts) {
  const { pos: p, n } = match, last = match.meta.frames - 1, H = halfFrame(match);
  const second = ts >= match.meta.period1_s, end = second ? last : H - 1, start = second ? H : 0;
  const f = Math.min(Math.max(ts * match.meta.fps, start), second ? last : H - 1e-6);
  const f1 = Math.floor(f), f2 = Math.min(f1 + 1, end), u = f - f1;
  const o = (k) => (k * n + i) * 3;
  const a = o(f1), b = o(f2);
  if (Number.isNaN(p[a]) || Number.isNaN(p[b])) return null;
  // neighbours, mirrored at the ends of the data, of a half or of the player's time on the pitch
  const z = o(Math.max(f1 - 1, start)), c = o(Math.min(f2 + 1, end));
  const zOk = f1 > start && !Number.isNaN(p[z]), cOk = f2 < end && !Number.isNaN(p[c]);
  const out = [0, 0, 0];
  if (f2 === f1) {   // the last sample of a half (or of the data, u = 0): on at the end velocity
    for (let k = 0; k < 3; k++) out[k] = p[a + k] + (zOk ? u * (p[a + k] - p[z + k]) : 0);
    return out;
  }
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  for (let k = 0; k < 3; k++) {
    const p1 = p[a + k], p2 = p[b + k];
    const p0 = zOk ? p[z + k] : 2 * p1 - p2, p3 = cOk ? p[c + k] : 2 * p2 - p1;
    out[k] = h00 * p1 + h10 * (p2 - p0) / 2 + h01 * p2 + h11 * (p3 - p1) / 2;
  }
  return out;
}

// The shown root of player i at ts, smoothed by a critically damped spring without its lag. The
// spring's impulse response, omega^2 u e^(-omega u), weighs the path behind the point it reads;
// the whole track is known, so it reads ahead by the response's mean delay (2 / omega) and a
// constant velocity passes unchanged. Under an acceleration a the point moves by about a / omega^2
// (1.25 cm at 5 m/s^2 and omega 20); the acceleration steps of the simulator are spread over the
// response instead of landing in one frame. Stateless: a seek shows the same root as playback.
// omega 0 (or a sample off the pitch) gives the path itself.
const ROOT_K = 9, ROOT_CAP = 0.05;   // samples of the response; metres off the path at most
const KERNELS = new Map();   // omega -> { u: [s], w: [weights summing to 1], lead: s }
function kernel(omega) {
  if (!KERNELS.has(omega)) {
    const u = Array.from({ length: ROOT_K }, (_, j) => ((j + 0.5) / ROOT_K) * (6 / omega));
    const raw = u.map((x) => x * Math.exp(-omega * x)), sum = raw.reduce((a, b) => a + b, 0);
    const w = raw.map((x) => x / sum);
    KERNELS.set(omega, { u, w, lead: u.reduce((a, x, j) => a + x * w[j], 0) });
  }
  return KERNELS.get(omega);
}
export function rootAt(match, i, ts, omega) {
  const now = match.at(i, ts);
  if (!now || !(omega > 0)) return now;
  const { u, w, lead } = kernel(omega), out = [0, 0, 0], [lo, hi] = halfSpan(match, ts);
  for (let j = 0; j < ROOT_K; j++) {
    const q = match.at(i, Math.min(Math.max(ts + lead - u[j], lo), hi));
    if (!q) return now;
    for (let k = 0; k < 3; k++) out[k] += w[j] * q[k];
  }
  // a turn faster than a person can make (the DEMO fixture's zigzags) is rounded by less than
  // ROOT_CAP, through a soft clamp so the root keeps a smooth path; on the simulated matches the
  // offset is 1.3 cm at most and the clamp takes 2% of it
  const d = Math.hypot(out[0] - now[0], out[1] - now[1]);
  if (d > 1e-9) { const f = (ROOT_CAP * Math.tanh(d / ROOT_CAP)) / d; for (let k = 0; k < 2; k++) out[k] = now[k] + (out[k] - now[k]) * f; }
  return out;
}
