// Camera 1 rides a short rail along the touchline so a kick is never hidden behind another
// player's head (docs/motion3d.md). For every kick the smallest slide that clears the line from
// the lens to the kicker's foot is found from the tracking data; the camera eases onto it about a
// second before contact and back off afterwards. Pure: no Babylon, contract metres in, metres out.

export const KICKS = new Set(["pass", "shot", "cross", "clearance", "goalkick", "freekick_short", "freekick_crossed", "corner_crossed", "corner_short"]);
const BODY = { h: 1.85, r: 0.45 };          // a player as a vertical segment, plus the foot's margin
const SLIDES = [0, 2, -2, 4, -4, 6, -6, 8, -8, 10, -10];   // metres along the rail, smallest first
const HOLD = 0.6, EASE = 1.2;               // seconds on the slide either side of contact, then easing

// distance between segment p0-p1 and the vertical segment from (x, 0, z) to (x, h, z), plus where
// along p0-p1 (0..1) the closest point lies; sampled, which is plenty at a 0.45 m margin
function nearSegment(p0, p1, x, z, h) {
  let best = Infinity, at = 0;
  for (let k = 0; k <= 64; k++) {
    const u = k / 64, px = p0[0] + (p1[0] - p0[0]) * u, py = p0[1] + (p1[1] - p0[1]) * u, pz = p0[2] + (p1[2] - p0[2]) * u;
    const d = Math.hypot(px - x, pz - z) + Math.max(0, py - h);
    if (d < best) { best = d; at = u; }
  }
  return [best, at];
}

// true when someone other than the kicker stands between lens and the foot point (x, y contract);
// near: how far along the line (0..1) an obstacle still counts, less than 1 to let team-mates
// crowd round the subject
export function hidden(match, lens, foot, kicker, ts, near = 0.995) {
  const F = [foot[0], 0.15, foot[1]];
  for (let i = 1; i < match.n; i++) {
    if (i === kicker) continue;
    const p = match.at(i, ts);
    if (!p) continue;
    const [d, u] = nearSegment(lens, F, p[0], p[1], BODY.h);
    if (d < BODY.r && u < near) return true;
  }
  return false;
}

// [{ ts, dx }] for every kick in [from, to] that needs the camera moved; lens is the camera
// position in contract metres with height as the middle value: [x, h, y]. Kicks less than GROUP
// seconds apart (a pass and the shot) share one slide when one clears them all, so the camera
// does not swing from side to side between them.
const GROUP = 3;
export function railPlan(match, lens, from = 0, to = match.duration) {
  const kicks = [];
  for (const e of match.events) {
    if (!KICKS.has(e.type_name) || e.ts < from || e.ts > to) continue;
    const i = match.meta.entities.indexOf(e.player_id), b = match.at(0, e.ts);
    if (i < 1 || !b) continue;
    const clear = (dx) => [-0.1, 0, 0.1].every((o) => !hidden(match, [lens[0] + dx, lens[1], lens[2]], b, i, e.ts + o));
    if (!clear(0)) kicks.push({ ts: e.ts, clear });
  }
  const out = [];
  for (let a = 0; a < kicks.length;) {
    let z = a + 1;
    while (z < kicks.length && kicks[z].ts - kicks[z - 1].ts < GROUP) z++;
    const group = kicks.slice(a, z), shared = SLIDES.find((dx) => group.every((k) => k.clear(dx)));
    for (const k of group) {
      const dx = shared ?? SLIDES.find(k.clear);
      if (dx) out.push({ ts: k.ts, dx });   // undefined: nothing clears, stay put
    }
    a = z;
  }
  return out;
}

const smooth = (u) => { const t = Math.min(1, Math.max(0, u)); return t * t * (3 - 2 * t); };

// the rail offset at ts: each kick's slide weighted by its window, blended where two overlap
export function railAt(plan, ts) {
  let s = 0, w = 0;
  for (const k of plan) {
    const d = Math.abs(ts - k.ts);
    if (d >= HOLD + EASE) continue;
    const a = 1 - smooth((d - HOLD) / EASE);
    s += a * k.dx; w += a;
  }
  return w > 1 ? s / w : s;
}
