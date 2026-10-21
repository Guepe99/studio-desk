// Top-down pitch on a canvas, in 1920x1080 stage pixels. Pitch 105 x 68 m, origin bottom-left.
// Drawn like a broadcast tactical view: team discs with a ring and the shirt number, the home team
// round and the away team square (so the teams differ in shape, not only in colour), keepers in their
// own colour, a pointer for the direction of run, the ball with a one-second trail and a ring when it
// is in the air, and the players named by the graphics on air lit in the house accent. Every mark sits
// exactly where the tracking puts it; nothing animates except the data.

export const STAGE_W = 1920, STAGE_H = 1080;
const TOP = 130, BOTTOM = 70;
export const S = (STAGE_H - TOP - BOTTOM) / 68;          // pixels per metre
const LEFT = (STAGE_W - 105 * S) / 2;

export const toStage = (x, y) => [LEFT + x * S, TOP + (68 - y) * S];

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(hex) {
  const c = rgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
// Text colour for a fill: white or the house ink, whichever has the higher WCAG contrast ratio.
const INK = "#0e1a3d", L_INK = luminance(INK);
export const textOn = (hex) => {
  const l = luminance(hex);
  return (l + 0.05) / (L_INK + 0.05) > 1.05 / (l + 0.05) ? INK : "#ffffff";
};

const TRAIL = [0, 1, 2, 3, 4, 5].map((j) => `rgba(255,255,255,${(0.6 * (1 - (j - 1) / 5)).toFixed(2)})`);
const SIGNAL = "#00ff87";   // the house accent on the picture (--green in broadcast.css)
const AIR = "#ffd23f";      // the ball's ring when it is above head height
// Keepers wear a colour of their own: the first of these far enough from both kits of both teams.
const KEEPER = ["#f2c14e", "#e05fd0", "#22d3b5", "#f2f2f2", "#111111"];
export function keeperColours(teams) {
  const kits = teams.flatMap((t) => [t.color_primary, t.color_secondary]).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).map(rgb);
  const far = (c) => kits.every((k) => Math.hypot(...k.map((v, i) => v - rgb(c)[i])) >= 120);
  const out = {}, used = new Set();
  for (const t of teams) {
    const c = KEEPER.find((x) => !used.has(x) && far(x)) ?? KEEPER.find((x) => !used.has(x));
    used.add(c);
    out[t.team_id] = c;
  }
  return out;
}

// Ids of the players the cues name: payload.player_id, or the players of the facts they cite.
// factPlayer: fact_id -> player_id of the match's fact ledger.
export function namedPlayers(cues, factPlayer) {
  const ids = new Set();
  for (const c of cues ?? []) {
    const p = c.payload ?? {};
    if (p.player_id) ids.add(p.player_id);
    for (const f of [p.fact_id, ...(p.fact_ids ?? [])]) {
      const pid = f && factPlayer.get(f);
      if (pid) ids.add(pid);
    }
  }
  return ids;
}

// the grass's opacity in the minimap over the 3D view, as a game's radar: the 3D picture shows through,
// lines, dots and ball stay opaque (view3d.mjs reads it back)
export const SEE_THROUGH = 0.5;

export class Pitch {
  constructor(canvas) {
    this.canvas = canvas;
    this.seeThrough = 1;   // app.js sets SEE_THROUGH while the 2D pitch is the minimap
    this.ctx = canvas.getContext("2d");
    this.bg = document.createElement("canvas");
    this.drawn = { players: [], ball: null };   // what the last draw put where, in stage pixels (tests read it)
  }

  // k: device pixels per stage pixel
  resize(k) {
    this.k = k;
    // CSS pixels per stage pixel (app.js caps the device ratio at 2): marks keep a readable size on a phone
    this.css = k / Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [this.canvas, this.bg]) {
      c.width = Math.round(STAGE_W * k);
      c.height = Math.round(STAGE_H * k);
    }
    this.drawBackground();
  }

  drawBackground() {
    const g = this.bg.getContext("2d");
    g.setTransform(this.k, 0, 0, this.k, 0, 0);
    // run-off a shade darker than the pitch, mowing stripes inside the lines only, 12 per length
    g.fillStyle = "#1c5428";
    g.fillRect(0, 0, STAGE_W, STAGE_H);
    const [x0, y0] = toStage(-3, 71), [x1, y1] = toStage(108, -3);
    const stripe = (105 / 12) * S;
    for (let i = 0; i < 13; i++) {
      g.fillStyle = i % 2 === 0 ? "#2a7536" : "#2e7d3b";
      const a = Math.max(x0, LEFT + (i - 1) * stripe), b = Math.min(x1, LEFT + i * stripe);
      g.fillRect(a, y0, b - a + 0.5, y1 - y0);
    }
    const v = g.createRadialGradient(STAGE_W / 2, STAGE_H / 2, 360, STAGE_W / 2, STAGE_H / 2, 1150);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,16,4,0.35)");
    g.fillStyle = v;
    g.fillRect(0, 0, STAGE_W, STAGE_H);
    const see = this.seeThrough < 1;
    if (see) {   // keep the grass at that opacity, then draw the lines over it opaque
      g.globalCompositeOperation = "destination-in";
      g.fillStyle = `rgba(0,0,0,${this.seeThrough})`;
      g.fillRect(0, 0, STAGE_W, STAGE_H);
      g.globalCompositeOperation = "source-over";
    }

    // lines at least one CSS pixel wide, so they stay crisp in the minimap and on a phone
    g.strokeStyle = g.fillStyle = see ? "#fff" : "rgba(255,255,255,0.86)";
    g.lineWidth = Math.max(3, 1 / this.css);
    g.lineJoin = "miter";
    const P = (x, y) => toStage(x, y);
    const rect = (x0, y0, x1, y1) => {
      const [a, b] = P(x0, y1), [c, d] = P(x1, y0);
      g.strokeRect(a, b, c - a, d - b);
    };
    const arc = (x, y, r, a0, a1) => {
      const [cx, cy] = P(x, y);
      g.beginPath();
      g.arc(cx, cy, r * S, a0, a1);
      g.stroke();
    };
    const spot = (x, y) => {
      const [cx, cy] = P(x, y);
      g.beginPath();
      g.arc(cx, cy, Math.max(4.5, 1.5 / this.css), 0, Math.PI * 2);
      g.fill();
    };
    rect(0, 0, 105, 68);
    g.beginPath(); g.moveTo(...P(52.5, 0)); g.lineTo(...P(52.5, 68)); g.stroke();
    arc(52.5, 34, 9.15, 0, Math.PI * 2);
    spot(52.5, 34);
    for (const side of [0, 1]) {
      const x = (m) => (side ? 105 - m : m);
      rect(Math.min(x(0), x(16.5)), 34 - 20.16, Math.max(x(0), x(16.5)), 34 + 20.16);
      rect(Math.min(x(0), x(5.5)), 34 - 9.16, Math.max(x(0), x(5.5)), 34 + 9.16);
      spot(x(11), 34);
      // penalty arc: the part of the 9.15 m circle outside the box
      const a = Math.acos(5.5 / 9.15);
      if (side) arc(x(11), 34, 9.15, Math.PI - a, Math.PI + a);
      else arc(x(11), 34, 9.15, -a, a);
      // goal and net behind the line
      const [gx0, gy0] = P(side ? 105 : -2, 34 + 3.66), [gx1, gy1] = P(side ? 107 : 0, 34 - 3.66);
      g.save();
      g.fillStyle = "rgba(255,255,255,0.22)";
      g.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
      g.strokeRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
      g.restore();
    }
    for (const [x, y, a0] of [[0, 0, -Math.PI / 2], [105, 0, Math.PI], [105, 68, Math.PI / 2], [0, 68, 0]]) {
      arc(x, y, 1, a0, a0 + Math.PI / 2);
    }
  }

  // cues: the cues on air; the players they name are lit.
  draw(match, ts, cues) {
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (this.seeThrough < 1) g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.bg, 0, 0);
    g.setTransform(this.k, 0, 0, this.k, 0, 0);
    if (this._match !== match) {   // per match: keeper colours and the fact -> player map
      this._match = match;
      this._keeper = keeperColours(match.meta.teams);
      this._text = new Map();
      this._factPlayer = new Map(match.facts.filter((f) => f.player_id).map((f) => [f.fact_id, f.player_id]));
    }
    // a disc at least 7.5 CSS pixels in radius (9 at 1280x720) but never wider than 2.4 m, so a crowded
    // box stays readable; the number goes when it would be under 5.5 CSS pixels (Split thumbnail)
    // in the minimap a small dot, as a game's radar draws them: 1.6 m across the radius
    const R = this.seeThrough < 1 ? 1.6 * S : Math.max(20, Math.min(7.5 / this.css, 2.4 * S)), TAU = Math.PI * 2;
    const numbers = R * 1.08 * this.css >= 5.5;
    const lit = namedPlayers(cues, this._factPlayer);
    const players = [];
    for (let i = 1; i < match.n; i++) {
      const pl = match.players[match.meta.entities[i]], p = pl && match.at(i, ts);
      if (!p) continue;
      const [x, y] = toStage(p[0], p[1]);
      // direction of run from the tracking 0.4 s ago: only drawn above a jog (2 m/s)
      const q = match.at(i, ts - 0.4);
      const dx = q ? p[0] - q[0] : 0, dy = q ? q[1] - p[1] : 0, v = Math.hypot(dx, dy) / 0.4;
      players.push({ id: pl.player_id, pl, x, y, r: R, v, dx, dy, focus: lit.has(pl.player_id) });
    }
    players.sort((a, b) => a.focus - b.focus);   // lit players on top
    this.drawn.players = players;

    const shape = (x, y, r, square) => {
      g.beginPath();
      if (!square) { g.arc(x, y, r, 0, TAU); return; }
      // a plain square: rounded or polygon outlines fill nothing in the software Chromium 131 the tests run
      g.rect(x - r * 0.86, y - r * 0.86, r * 1.72, r * 1.72);
    };
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `800 ${Math.round(R * 1.08)}px 'Urbanist', Arial, sans-serif`;
    const ring = R * 0.2, edge = Math.max(1.2, 0.9 / this.css);
    // shadow and dark edge in one path: the team shape, a little larger, nudged down and right like
    // the 3D view's light, so it rims every disc against the grass and falls as a shadow below
    // In the see-through minimap the frame behind can be bright or dark: the edge is an opaque dark
    // keyline inside a white one, centred, so every disc has an edge that stands out on either.
    const see = this.seeThrough < 1, so = R * 0.2 + edge;
    // one path per disc: a path of many shapes fills nothing in the software renderer the tests run
    const rims = (grow, ox, oy) => {
      for (const { pl, x, y } of players) { shape(x + ox, y + oy, R + grow, match.teams[pl.team_id].side === "away"); g.fill(); }
    };
    const key = Math.max(so, 1.5 / this.css), halo = Math.max(edge, 1.5 / this.css);   // each at least 1.5 CSS px
    if (see) { g.fillStyle = "#fff"; rims(key + halo, 0, 0); }
    g.fillStyle = see ? "rgb(4,10,22)" : "rgba(4,10,22,0.5)";
    rims(see ? key : so, see ? 0 : R * 0.1, see ? 0 : R * 0.15);

    // direction pointers, one path: a wedge from the disc edge, longer when running faster
    g.fillStyle = "rgba(255,255,255,0.92)";
    g.beginPath();
    for (const { x, y, v, dx, dy } of players) {
      if (v < 2) continue;
      const ux = dx / Math.hypot(dx, dy), uy = dy / Math.hypot(dx, dy), len = R * (1.4 + 0.35 * Math.min(1, (v - 2) / 5));
      g.moveTo(x + ux * len, y + uy * len);
      g.lineTo(x - uy * R * 0.5 + ux * R * 0.8, y + ux * R * 0.5 + uy * R * 0.8);
      g.lineTo(x + uy * R * 0.5 + ux * R * 0.8, y - ux * R * 0.5 + uy * R * 0.8);
      g.closePath();
    }
    g.fill();
    for (const { pl, x, y, focus } of players) {
      const team = match.teams[pl.team_id], square = team.side === "away";
      const fill = pl.position === "GK" ? this._keeper[pl.team_id] : team.color_primary;
      if (focus) {
        const h = g.createRadialGradient(x, y, R, x, y, R * 2.6);
        h.addColorStop(0, "rgba(0,255,135,0.55)");
        h.addColorStop(1, "rgba(0,255,135,0)");
        g.fillStyle = h;
        g.beginPath(); g.arc(x, y, R * 2.6, 0, TAU); g.fill();
      }
      // ring in the second kit colour, then the shirt colour inside
      if (focus) { shape(x, y, R + edge, square); g.fillStyle = "rgba(6,14,30,0.7)"; g.fill(); }
      shape(x, y, R, square); g.fillStyle = team.color_secondary; g.fill();
      shape(x, y, R - ring, square); g.fillStyle = fill; g.fill();
      if (focus) {
        shape(x, y, R + edge + ring * 0.9, square);
        g.lineWidth = ring * 1.1; g.strokeStyle = SIGNAL; g.stroke();
      }
      if (!numbers) continue;
      g.fillStyle = this._text.get(fill) ?? this._text.set(fill, textOn(fill)).get(fill);
      g.fillText(String(pl.shirt), x, y + R * 0.07);
    }

    const b = match.at(0, ts);
    this.drawn.ball = null;
    if (!b) return;
    const [x, y] = toStage(b[0], b[1]);
    this.drawn.ball = [x, y];
    const z = Math.max(0, b[2]), br = Math.max(9, 3 / this.css);
    // trail: where the ball was over the last second, fading; a jump faster than 60 m/s is a restart
    g.lineCap = "round";
    let prev = [x, y], prevB = b;
    for (let j = 1; j <= 5; j++) {
      const q = match.at(0, ts - j * 0.2);
      if (!q || Math.hypot(q[0] - prevB[0], q[1] - prevB[1]) > 12) break;
      const s = toStage(q[0], q[1]);
      g.strokeStyle = TRAIL[j];
      g.lineWidth = br * (1.1 - j * 0.16);
      g.beginPath(); g.moveTo(prev[0], prev[1]); g.lineTo(s[0], s[1]); g.stroke();
      prev = s; prevB = q;
    }
    // height cue: the shadow drifts away and fades, the ball grows, and above 2 m it gets a ring
    g.fillStyle = `rgba(0,0,0,${0.45 / (1 + z * 0.4)})`;
    g.beginPath(); g.ellipse(x + z * S * 0.45, y + z * S * 0.3, br, br * 0.75, 0, 0, TAU); g.fill();
    const r = br * (1 + Math.min(z, 12) * 0.08);
    g.beginPath(); g.arc(x, y, r, 0, TAU);
    g.fillStyle = "#ffffff"; g.fill();
    g.lineWidth = Math.max(2, 0.8 / this.css); g.strokeStyle = "#111111"; g.stroke();
    if (z > 2) {
      g.beginPath(); g.arc(x, y, r + br * 0.55, 0, TAU);
      g.lineWidth = br * 0.35; g.strokeStyle = AIR; g.stroke();
    }
  }
}
