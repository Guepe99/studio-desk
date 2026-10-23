// Starting line-ups at kick-off: each team's team-sheet formation and its eleven by line, keeper first, a
// shirt number and a surname each. Bottom right, like team shape, and on the left with v_side "left".
import { SdGraphic, esc } from "../shared/sd-graphic.mjs";

const WORDS = { en: "STARTING LINE-UPS", it: "FORMAZIONI INIZIALI", es: "ALINEACIONES INICIALES" };

export default class Lineup extends SdGraphic {
  css() {
    return `
/* as wide as its longest line (a back four of long names on one line), up to 1180 px */
.box { position: absolute; right: 96px; bottom: 84px; width: max-content; min-width: 780px; max-width: 1180px; }
.box.left { right: auto; left: 96px; }  /* v_side "left": the ball is on the right half */
.card { padding: 18px 28px 20px; }
.team + .team { margin-top: 14px; padding-top: 14px; border-top: 3px solid var(--purple-400); }
.head { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 28px; margin-bottom: 8px; }
.chip { width: 10px; height: 28px; border-radius: 3px; box-shadow: inset 0 0 0 2px var(--lilac-100); }
.form { margin-left: auto; font-size: 30px; font-variant-numeric: tabular-nums; }
.line { display: flex; flex-wrap: wrap; column-gap: 22px; row-gap: 6px; padding: 4px 0; }
.p { display: inline-flex; align-items: baseline; gap: 8px; font-weight: 600; font-size: 24px; white-space: nowrap; }
.n { min-width: 28px; text-align: right; font-weight: 800; font-size: 20px; color: var(--green); font-variant-numeric: tabular-nums; }
/* compact: every type at least 30 px (a 264 px deck draws it at 11 px) */
.compact .box { min-width: 720px; }
/* in the deck the box is scaled to the deck's width: it stays 720 px, and a line of four or more goes on two even rows */
.deck .box { width: 720px; min-width: 0; }
.deck .line.wide { display: grid; grid-template-columns: repeat(var(--cols), max-content); }
.compact .head, .compact .form, .compact .p, .compact .n { font-size: 30px; }
.compact .n { min-width: 40px; }`;
  }

  html() {
    return `<div class="box"><div class="kicker">${esc(WORDS[this.lang] ?? WORDS.en)}</div><div class="card panel">
      <div class="teams"></div></div><div class="factslot"></div></div>`;
  }

  async load(params = {}) {
    this.side = params.v_side;
    return super.load(params);
  }

  render() {
    const d = this.data, $ = (s) => this.stage.querySelector(s);
    $(".box").classList.toggle("left", this.side === "left");
    this.stage.classList.toggle("deck", !!this.closest(".deck-item"));  // ograf-host.js: below or beside the picture
    const color = (side) => this.teams[side]?.color ?? (side === "home" ? "#ffffff" : "#05f0ff");
    $(".teams").innerHTML = (Array.isArray(d.teams) ? d.teams : []).map((t) => `<div class="team">
      <div class="head"><span class="chip" style="background:${esc(color(t.side))}"></span>${esc(this.teams[t.side]?.short ?? String(t.side ?? "").toUpperCase())}<span class="form">${esc(t.formation)}</span></div>
      ${(Array.isArray(t.lines) ? t.lines : []).filter((l) => l?.length).map((l) => `<div class="line${l.length >= 4 ? " wide" : ""}" style="--cols:${Math.ceil(l.length / 2)}">${l.map((p) =>
        `<span class="p"><span class="n">${esc(p.shirt)}</span>${esc(p.name)}</span>`).join("")}</div>`).join("")}</div>`).join("");
    $(".factslot").innerHTML = this.factsHtml(d.fact_ids);
  }

  inAnims() {
    const $ = (s) => this.stage.querySelector(s);
    const lines = [...this.stage.querySelectorAll(".head, .line")];
    return [
      [$(".card"), [{ opacity: 0, transform: "translateY(40px)" }, { opacity: 1, transform: "none" }], { duration: 320 }],
      [$(".kicker"), [{ opacity: 0, transform: "translateY(30px)" }, { opacity: 1, transform: "none" }], { duration: 240, delay: 160 }],
      ...lines.map((l, i) => [l, [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: 240 + i * 50 }]),
      [$(".factslot"), [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 760 }],
    ];
  }

  outAnims() {
    return [[this.stage.querySelector(".box"), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(30px)" }], { duration: 260 }]];
  }
}
