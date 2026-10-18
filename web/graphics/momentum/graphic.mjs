// Momentum: one bar per window, home above and away below a centre line; the latest window is lit.
import { SdGraphic, esc } from "../shared/sd-graphic.mjs";

const H = 92; // pixels for a momentum of 10

export default class Momentum extends SdGraphic {
  css() {
    return `
.box { position: absolute; right: 96px; bottom: 84px; width: 780px; }
.card { padding: 22px 28px 18px; margin-top: -2px; }
.row { display: grid; grid-template-columns: 112px 1fr; align-items: end; height: ${H + 6}px; }
.row.away { align-items: start; }
.team { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 32px; letter-spacing: .04em; align-self: center; }
.chip { width: 10px; height: 30px; border-radius: 2px; box-shadow: inset 0 0 0 2px rgba(255,255,255,.5); }
.bars { display: flex; gap: 6px; height: 100%; align-items: flex-end; }
.away .bars { align-items: flex-start; }
.bar { flex: 0 1 56px; min-width: 6px; border-radius: 3px 3px 0 0; opacity: .55; transform-origin: 50% 100%; box-shadow: inset 0 0 0 2px rgba(255,255,255,.6); }
.away .bar { border-radius: 0 0 3px 3px; transform-origin: 50% 0; }
.bar.now { opacity: 1; box-shadow: 0 0 0 2px #fff; }
.mid { height: 3px; background: #fff; margin-left: 112px; opacity: .85; }
.foot { display: flex; justify-content: space-between; margin: 12px 0 0 112px; font-weight: 500; font-size: 22px; color: #a8b6d8; }
.compact .foot { font-size: 28px; }`;
  }

  html() {
    return `<div class="box"><div class="kicker">MOMENTUM</div><div class="card panel">
      <div class="row home"><div class="team"></div><div class="bars"></div></div>
      <div class="mid"></div>
      <div class="row away"><div class="team"></div><div class="bars"></div></div>
      <div class="foot"><span>Kick-off</span><span>Now</span></div></div>
      <div class="factslot"></div></div>`;
  }

  render() {
    const d = this.data, $ = (s) => this.stage.querySelector(s);
    for (const side of ["home", "away"]) {
      const t = this.teams[side] ?? {};
      const vals = Array.isArray(d[side]) ? d[side] : [];
      const color = t.color ?? (side === "home" ? "#ffffff" : "#2ec4f1");
      $(`.${side} .team`).innerHTML = `<span class="chip" style="background:${esc(color)}"></span>${esc(t.short ?? side.toUpperCase())}`;
      $(`.${side} .bars`).innerHTML = vals.map((v, i) => {
        const h = Math.max(3, Math.min(10, Number(v) || 0) / 10 * H);
        return `<div class="bar${i === vals.length - 1 ? " now" : ""}" style="height:${h}px;background:${esc(color)}"></div>`;
      }).join("");
    }
    $(".factslot").innerHTML = this.factsHtml(d.fact_ids);
  }

  inAnims() {
    const $ = (s) => this.stage.querySelector(s);
    const bars = [...this.stage.querySelectorAll(".bar")];
    const n = Math.max(1, bars.length / 2);
    return [
      [$(".card"), [{ opacity: 0, transform: "translateY(40px)" }, { opacity: 1, transform: "none" }], { duration: 320 }],
      [$(".kicker"), [{ opacity: 0, transform: "translateY(30px)" }, { opacity: 1, transform: "none" }], { duration: 240, delay: 160 }],
      [$(".mid"), [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 300, delay: 200 }],
      ...bars.map((b, i) => [b, [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: 360, delay: 320 + (i % n) * 40 }]),
      [$(".factslot"), [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 700 }],
    ];
  }

  outAnims() {
    return [[this.stage.querySelector(".box"), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(30px)" }], { duration: 260 }]];
  }
}
