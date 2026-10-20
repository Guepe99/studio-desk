// Momentum: one bar per window, home above and away below a centre line; the latest window is lit.
import { SdGraphic, esc } from "../shared/sd-graphic.mjs";

const H = 92; // pixels for a momentum of 10
const WORDS = { en: ["MOMENTUM", "Kick-off", "Now"], it: ["INERZIA", "Calcio d'inizio", "Ora"], es: ["DOMINIO", "Inicio", "Ahora"] };

export default class Momentum extends SdGraphic {
  css() {
    return `
/* the axis runs from kick-off to now: the card grows with the windows played (62 px each, never under
   320 px for the two labels) up to its full width, where the bars start to narrow */
.box { position: absolute; right: 96px; bottom: 84px; --axis: max(320px, var(--n, 13) * 62px - 6px); width: min(780px, calc(168px + var(--axis))); }
.box.left { right: auto; left: 96px; }  /* v_side "left": the ball is on the right half */
.compact .box { width: min(720px, calc(168px + var(--axis))); }  /* fits a 264 px deck with its smallest type (30 px) at 11 px */
.card { padding: 22px 28px 18px; }
.row { display: grid; grid-template-columns: 112px 1fr; align-items: end; height: ${H + 6}px; }
.row.away { align-items: start; }
.team { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 28px; align-self: center; }
.chip { width: 10px; height: 30px; border-radius: 3px; box-shadow: inset 0 0 0 2px var(--lilac-100); }
.bars { display: flex; gap: 6px; height: 100%; align-items: flex-end; }
.away .bars { align-items: flex-start; }
.bar { flex: 1 1 56px; min-width: 6px; border-radius: 3px 3px 0 0; opacity: .55; transform-origin: 50% 100%; box-shadow: inset 0 0 0 2px var(--lilac-100); }
.away .bar { border-radius: 0 0 3px 3px; transform-origin: 50% 0; }
.bar.now { opacity: 1; box-shadow: 0 0 0 3px var(--green); }
.mid { height: 3px; border-radius: 2px; background: var(--page); margin-left: 112px; }
.foot { display: flex; justify-content: space-between; margin: 12px 0 0 112px; font-weight: 600; font-size: 22px; color: var(--lilac-100); }
.compact .foot, .compact .team { font-size: 30px; }`;
  }

  html() {
    const [kicker, start, now] = WORDS[this.lang] ?? WORDS.en;
    return `<div class="box"><div class="kicker">${kicker}</div><div class="card panel">
      <div class="row home"><div class="team"></div><div class="bars"></div></div>
      <div class="mid"></div>
      <div class="row away"><div class="team"></div><div class="bars"></div></div>
      <div class="foot"><span>${esc(start)}</span><span>${now}</span></div></div>
      <div class="factslot"></div></div>`;
  }

  async load(params = {}) {
    this.side = params.v_side;
    return super.load(params);
  }

  render() {
    const d = this.data, $ = (s) => this.stage.querySelector(s);
    $(".box").classList.toggle("left", this.side === "left");
    $(".box").style.setProperty("--n", Math.max(...["home", "away"].map((k) => (Array.isArray(d[k]) ? d[k].length : 0)), 1));
    for (const side of ["home", "away"]) {
      const t = this.teams[side] ?? {};
      const vals = Array.isArray(d[side]) ? d[side] : [];
      const color = t.color ?? (side === "home" ? "#ffffff" : "#05f0ff");
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
