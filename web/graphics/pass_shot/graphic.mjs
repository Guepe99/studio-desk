// Pass / shot lower third: the player, the measured value (shot speed, pass length) and a quality bar.
import { SdGraphic } from "../shared/sd-graphic.mjs";

const KICKER = { shot: "SHOT SPEED", pass: "PASS" };

// quality is display text from the export ("Difficulty 8.1/10", "Goal", "No goal"), or
// {value, max} drawn as a bar of value / max; null hides the row. A bare number has no scale, so
// it is shown as text, never guessed into a bar.
const scaled = (q) => q && typeof q === "object" && Number.isFinite(q.value) && Number.isFinite(q.max) && q.max > 0;
const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export default class PassShot extends SdGraphic {
  css() {
    return `
.l3 { position: absolute; left: 96px; bottom: 84px; width: 860px; }
.card { display: grid; grid-template-columns: 96px 1fr auto; align-items: stretch; height: 126px; margin-top: -2px; }
.num { display: grid; place-items: center; font-weight: 800; font-size: 60px; }
.who { padding: 0 24px; display: flex; flex-direction: column; justify-content: center; gap: 10px; min-width: 0; }
.name { font-weight: 800; font-size: 52px; letter-spacing: .01em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.team { font-weight: 500; font-size: 28px; color: #a8b6d8; white-space: nowrap; }
.val { background: #1f3473; padding: 0 30px 0 40px; display: flex; align-items: baseline; gap: 10px; align-self: stretch;
  clip-path: polygon(18px 0, 100% 0, 100% 100%, 0 100%); padding-top: 26px; }
.big { font-weight: 800; font-size: 84px; font-variant-numeric: tabular-nums; }
.unit { font-weight: 700; font-size: 30px; color: #2ec4f1; }
.q { display: flex; align-items: center; gap: 18px; height: 50px; padding: 0 24px; background: rgba(8,15,38,.92); }
.q.none, .q.text .track, .q.text .qval { display: none; }
.qlabel { font-weight: 700; font-size: 24px; letter-spacing: .08em; color: #a8b6d8; }
.compact .qlabel { font-size: 28px; }
.q.text .qlabel { font-size: 32px; font-weight: 800; letter-spacing: .03em; color: #fff; }
.q.goal { background: #2ec4f1; }
.q.goal .qlabel { color: #0e1a3d; letter-spacing: .12em; text-transform: uppercase; }
.track { flex: 1; height: 12px; background: #2a3c74; border-radius: 6px; overflow: hidden; }
.bar { height: 100%; background: linear-gradient(90deg, #2ec4f1, #9ff0ff); transform-origin: 0 50%; border-radius: 6px; }
.qval { font-weight: 800; font-size: 32px; min-width: 52px; text-align: right; font-variant-numeric: tabular-nums; }`;
  }

  html() {
    return `<div class="l3"><div class="kicker"></div>
      <div class="card panel"><div class="num"></div><div class="who"><div class="name"></div><div class="team"></div></div>
      <div class="val"><span class="big"></span><span class="unit"></span></div></div>
      <div class="q"><span class="qlabel">QUALITY</span><div class="track"><div class="bar"></div></div><span class="qval"></span></div>
      <div class="factslot"></div></div>`;
  }

  render() {
    const d = this.data, p = this.players[d.player_id] ?? {}, $ = (s) => this.stage.querySelector(s);
    $(".kicker").textContent = KICKER[d.mode] ?? String(d.mode ?? "").toUpperCase();
    const num = $(".num");
    num.textContent = p.shirt ?? "";
    num.style.background = p.color ?? "#2ec4f1";
    num.style.color = p.text ?? "#0e1a3d";
    $(".name").textContent = p.name ?? d.player_id ?? "";
    $(".team").textContent = p.team_name ?? p.team_short ?? "";
    $(".big").textContent = Number.isFinite(d.value) ? (d.value >= 100 ? d.value.toFixed(0) : d.value.toFixed(1)) : "";
    $(".unit").textContent = d.unit ?? "";
    const q = d.quality, row = $(".q"), bar = scaled(q);
    row.classList.toggle("none", q == null || q === "");
    row.classList.toggle("text", !bar);
    row.classList.toggle("goal", q === "Goal");
    $(".qlabel").textContent = bar ? "QUALITY" : typeof q === "object" ? "" : String(q ?? "");
    $(".bar").style.width = `${bar ? Math.round(Math.min(100, Math.max(0, (q.value / q.max) * 100))) : 0}%`;
    $(".qval").textContent = bar ? `${fmt(q.value)}/${fmt(q.max)}` : "";
    $(".factslot").innerHTML = this.factsHtml(d.fact_ids);
  }

  inAnims() {
    const $ = (s) => this.stage.querySelector(s);
    return [
      [$(".kicker"), [{ transform: "translateY(30px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 240, delay: 260 }],
      [$(".card"), [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 420 }],
      [$(".who"), [{ opacity: 0, transform: "translateX(-24px)" }, { opacity: 1, transform: "none" }], { duration: 280, delay: 200 }],
      [$(".val"), [{ opacity: 0, transform: "translateX(40px)" }, { opacity: 1, transform: "none" }], { duration: 300, delay: 300 }],
      [$(".q"), [{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 220, delay: 420 }],
      [$(".bar"), [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 600, delay: 520 }],
      [$(".factslot"), [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 600 }],
    ];
  }

  outAnims() {
    return [[this.stage.querySelector(".l3"), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-60px)" }], { duration: 260 }]];
  }
}
