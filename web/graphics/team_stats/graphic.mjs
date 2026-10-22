// Team shape: the two teams side by side over one 5-minute window, one row per measure (formation, line
// height, length, width, pressing), a split bar for each number. Bottom right, like momentum, and on the
// left with v_side "left".
import { SdGraphic, esc } from "../shared/sd-graphic.mjs";

const WORDS = {
  en: { kicker: "TEAM SHAPE", formation: "Formation", line_height: "Defensive line", team_length: "Length", team_width: "Width", press_intensity: "Pressing" },
  it: { kicker: "ASSETTO", formation: "Modulo", line_height: "Linea difensiva", team_length: "Lunghezza", team_width: "Ampiezza", press_intensity: "Pressing" },
  es: { kicker: "ESTRUCTURA", formation: "Sistema", line_height: "Línea defensiva", team_length: "Longitud", team_width: "Anchura", press_intensity: "Presión" },
};

export default class TeamStats extends SdGraphic {
  css() {
    return `
.box { position: absolute; right: 96px; bottom: 84px; width: 780px; }
.box.left { right: auto; left: 96px; }  /* v_side "left": the ball is on the right half */
.card { padding: 20px 28px 22px; }
.head, .row { display: grid; grid-template-columns: 236px 126px 1fr 126px; column-gap: 16px; align-items: center; }
.head { padding-bottom: 12px; margin-bottom: 4px; border-bottom: 3px solid var(--purple-400); }
.when { font-weight: 600; font-size: 24px; color: var(--lilac-100); }
.team { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 28px; }
.team.home { grid-column: 2; justify-content: flex-end; }
.team.away { grid-column: 4; }
.chip { width: 10px; height: 28px; border-radius: 3px; box-shadow: inset 0 0 0 2px var(--lilac-100); }
.row { height: 50px; }
.lab { font-weight: 600; font-size: 24px; color: var(--lilac-100); white-space: nowrap; }
.v { font-weight: 800; font-size: 30px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.v.home { text-align: right; }
.split { display: flex; gap: 4px; height: 16px; }
.seg { border-radius: 3px; box-shadow: inset 0 0 0 2px var(--lilac-100); }
/* compact: the label on its own line above the numbers, every type at least 30 px (a 264 px deck draws it at 11 px) */
.compact .box { width: 720px; }
.compact .head, .compact .row { grid-template-columns: 150px 1fr 150px; row-gap: 6px; }
.compact .when { grid-column: 1 / -1; }
.compact .team.home { grid-column: 1; justify-content: flex-start; }
.compact .team.away { grid-column: 3; justify-content: flex-end; }
.compact .row { height: auto; padding: 8px 0; }
.compact .lab { grid-column: 1 / -1; }
.compact .v.home { text-align: left; }
.compact .v.away { text-align: right; }
.compact .when, .compact .team, .compact .lab, .compact .v { font-size: 30px; }`;
  }

  html() {
    const w = WORDS[this.lang] ?? WORDS.en;
    return `<div class="box"><div class="kicker">${esc(w.kicker)}</div><div class="card panel">
      <div class="head"><span class="when"></span><span class="team home"></span><span class="team away"></span></div>
      <div class="rows"></div></div>
      <div class="factslot"></div></div>`;
  }

  async load(params = {}) {
    this.side = params.v_side;
    return super.load(params);
  }

  render() {
    const d = this.data, w = WORDS[this.lang] ?? WORDS.en, $ = (s) => this.stage.querySelector(s);
    $(".box").classList.toggle("left", this.side === "left");
    const color = (side) => this.teams[side]?.color ?? (side === "home" ? "#ffffff" : "#05f0ff");
    $(".when").textContent = d.when ?? "";
    for (const side of ["home", "away"]) {
      $(`.team.${side}`).innerHTML = `<span class="chip" style="background:${esc(color(side))}"></span>${esc(this.teams[side]?.short ?? side.toUpperCase())}`;
    }
    $(".rows").innerHTML = (Array.isArray(d.rows) ? d.rows : []).map((r) => {
      const h = Number(r.home_v), a = Number(r.away_v), bar = r.home_v != null && r.away_v != null && h >= 0 && a >= 0;
      const share = bar ? (h + a > 0 ? h / (h + a) : 0.5) : 0;
      // the two shares of the bar: each side's value over the two together (0 and 0 split in half)
      const split = bar ? `<div class="split"><div class="seg" style="flex:${share} 1 0;background:${esc(color("home"))}"></div>`
        + `<div class="seg" style="flex:${1 - share} 1 0;background:${esc(color("away"))}"></div></div>` : "<div></div>";
      return `<div class="row"><span class="lab">${esc(w[r.stat] ?? r.stat)}</span><span class="v home">${esc(r.home)}</span>${split}<span class="v away">${esc(r.away)}</span></div>`;
    }).join("");
    $(".factslot").innerHTML = this.factsHtml(d.fact_ids);
  }

  inAnims() {
    const $ = (s) => this.stage.querySelector(s);
    const rows = [...this.stage.querySelectorAll(".row")], bars = [...this.stage.querySelectorAll(".split")];
    return [
      [$(".card"), [{ opacity: 0, transform: "translateY(40px)" }, { opacity: 1, transform: "none" }], { duration: 320 }],
      [$(".kicker"), [{ opacity: 0, transform: "translateY(30px)" }, { opacity: 1, transform: "none" }], { duration: 240, delay: 160 }],
      ...rows.map((r, i) => [r, [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: 240 + i * 60 }]),
      ...bars.map((b, i) => [b, [{ clipPath: "inset(0 50% 0 50%)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 420, delay: 360 + i * 60 }]),
      [$(".factslot"), [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 760 }],
    ];
  }

  outAnims() {
    return [[this.stage.querySelector(".box"), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(30px)" }], { duration: 260 }]];
  }
}
