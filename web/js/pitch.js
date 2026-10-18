// Top-down pitch on a canvas, in 1920x1080 stage pixels. Pitch 105 x 68 m, origin bottom-left.

export const STAGE_W = 1920, STAGE_H = 1080;
const TOP = 130, BOTTOM = 70;
export const S = (STAGE_H - TOP - BOTTOM) / 68;          // pixels per metre
const LEFT = (STAGE_W - 105 * S) / 2;

export const toStage = (x, y) => [LEFT + x * S, TOP + (68 - y) * S];

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
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

export class Pitch {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.bg = document.createElement("canvas");
  }

  // k: device pixels per stage pixel
  resize(k) {
    this.k = k;
    for (const c of [this.canvas, this.bg]) {
      c.width = Math.round(STAGE_W * k);
      c.height = Math.round(STAGE_H * k);
    }
    this.drawBackground();
  }

  drawBackground() {
    const g = this.bg.getContext("2d");
    g.setTransform(this.k, 0, 0, this.k, 0, 0);
    // mowing stripes across the whole frame, 14 per pitch length
    const stripe = (105 / 14) * S;
    for (let i = -6; i * stripe < STAGE_W; i++) {
      g.fillStyle = i % 2 === 0 ? "#2f7f3b" : "#378a43";
      g.fillRect(LEFT + i * stripe, 0, stripe + 1, STAGE_H);
    }
    const v = g.createRadialGradient(STAGE_W / 2, STAGE_H / 2, 300, STAGE_W / 2, STAGE_H / 2, 1150);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,20,0,0.45)");
    g.fillStyle = v;
    g.fillRect(0, 0, STAGE_W, STAGE_H);

    g.strokeStyle = "rgba(255,255,255,0.88)";
    g.fillStyle = "rgba(255,255,255,0.88)";
    g.lineWidth = 3;
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
      g.arc(cx, cy, 4, 0, Math.PI * 2);
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
      g.fillStyle = "rgba(255,255,255,0.18)";
      g.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
      g.strokeRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
      g.restore();
    }
    for (const [x, y, a0] of [[0, 0, -Math.PI / 2], [105, 0, Math.PI], [105, 68, Math.PI / 2], [0, 68, 0]]) {
      arc(x, y, 1, a0, a0 + Math.PI / 2);
    }
  }

  draw(match, ts) {
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.bg, 0, 0);
    g.setTransform(this.k, 0, 0, this.k, 0, 0);
    const R = 16;
    const players = [];
    for (let i = 1; i < match.n; i++) {
      const p = match.at(i, ts);
      if (p) players.push([i, ...toStage(p[0], p[1])]);
    }
    g.fillStyle = "rgba(0,0,0,0.28)";
    for (const [, x, y] of players) {
      g.beginPath(); g.ellipse(x + 4, y + 5, R, R * 0.8, 0, 0, Math.PI * 2); g.fill();
    }
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "800 19px 'Barlow Condensed', 'Arial Narrow', sans-serif";
    for (const [i, x, y] of players) {
      const pl = match.players[match.meta.entities[i]];
      const team = match.teams[pl.team_id];
      g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2);
      g.fillStyle = team.color_primary; g.fill();
      g.lineWidth = 3; g.strokeStyle = team.color_secondary; g.stroke();
      g.fillStyle = textOn(team.color_primary);
      g.fillText(String(pl.shirt), x, y + 1);
    }
    const b = match.at(0, ts);
    if (b) {
      const [x, y] = toStage(b[0], b[1]);
      const z = Math.max(0, b[2]);
      // height cue: the shadow drifts away and fades, the ball grows
      g.fillStyle = `rgba(0,0,0,${0.4 / (1 + z * 0.4)})`;
      g.beginPath(); g.ellipse(x + z * S * 0.45, y + z * S * 0.3, 7, 5, 0, 0, Math.PI * 2); g.fill();
      const r = 7 * (1 + z * 0.14);
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = "#ffffff"; g.fill();
      g.lineWidth = 2; g.strokeStyle = "#1b1b1b"; g.stroke();
    }
  }
}
