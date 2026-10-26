// Pass / shot lower third: the player, the measured value (shot speed, pass length) and a quality bar.
import { SdGraphic, decimal } from "../shared/sd-graphic.mjs";

const KICKER = { en: { shot: "SHOT SPEED", pass: "PASS" }, it: { shot: "VELOCITÀ DEL TIRO", pass: "PASSAGGIO" }, es: { shot: "VELOCIDAD DEL TIRO", pass: "PASE" } };
const QUALITY = { en: "QUALITY", it: "QUALITÀ", es: "CALIDAD" };
const GOAL = ["Goal", "Gol"]; // the export's quality text for a goal: "Goal" in English, "Gol" in Italian and Spanish

// quality is display text from the export ("Difficulty 8.1/10", "Goal", "No goal"), or
// {value, max} drawn as a bar of value / max; null hides the row. A bare number has no scale, so
// it is shown as text, never guessed into a bar.
const scaled = (q) => q && typeof q === "object" && Number.isFinite(q.value) && Number.isFinite(q.max) && q.max > 0;
const fmt = (v, lang) => (Number.isInteger(v) ? String(v) : decimal(v, 1, lang));
// the name on one line from 46 px down to 36 px, else on two lines at 40 px
const NAME_PX = 46, NAME_MIN = 36, TWO_PX = 40;

export default class PassShot extends SdGraphic {
  css() {
    return `
.l3 { position: absolute; left: 96px; bottom: 84px; width: 860px; }
.compact .l3 { width: 720px; }  /* fits a 264 px deck with its smallest type (30 px) at 11 px */
.card { display: grid; grid-template-columns: 96px 1fr auto; align-items: stretch; min-height: 126px; overflow: hidden; }
.num { display: grid; place-items: center; font-weight: 800; font-size: 60px; }
.who { padding: 8px 24px; display: flex; flex-direction: column; justify-content: center; gap: 10px; min-width: 0; }
/* a name is never cut (fit()): a long one steps down in size, then takes two lines and the card grows */
.name { font-weight: 800; font-size: ${NAME_PX}px; line-height: 1.05; text-transform: uppercase; white-space: nowrap; }
.name.two { white-space: normal; font-size: ${TWO_PX}px; }
.team { font-weight: 600; font-size: 28px; color: var(--lilac-100); white-space: nowrap; }
.team.two { white-space: normal; line-height: 1.1; }
.val { background: var(--purple-700); padding: 0 30px 0 32px; display: flex; align-items: baseline; gap: 10px; align-self: stretch; padding-top: 24px; }
.big { font-weight: 800; font-size: 80px; font-variant-numeric: tabular-nums; }
.unit { font-weight: 700; font-size: 28px; color: var(--green); }
.q { display: flex; align-items: center; gap: 18px; height: 50px; padding: 0 24px; margin-top: 6px; border-radius: var(--r-box); background: var(--purple-900); }
.q.none, .q.text .track, .q.text .qval { display: none; }
.qlabel { font-weight: 700; font-size: 24px; letter-spacing: .08em; color: var(--lilac-100); }
.compact .qlabel, .compact .team, .compact .unit { font-size: 30px; }
.q.text .qlabel { font-size: 30px; font-weight: 800; letter-spacing: .02em; color: var(--page); }
.q.goal { background: var(--green); }
.q.goal .qlabel { color: var(--purple); letter-spacing: .12em; text-transform: uppercase; }
.track { flex: 1; height: 12px; background: var(--purple-400); border-radius: 6px; overflow: hidden; }
.bar { height: 100%; background: var(--green); transform-origin: 0 50%; border-radius: 6px; }
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
    $(".kicker").textContent = (KICKER[this.lang] ?? KICKER.en)[d.mode] ?? String(d.mode ?? "").toUpperCase();
    const num = $(".num");
    num.textContent = p.shirt ?? "";
    num.style.background = p.color ?? "#00ff87";
    num.style.color = p.text ?? "#37003c";
    $(".name").textContent = p.name ?? d.player_id ?? "";
    $(".team").textContent = p.team_name ?? p.team_short ?? "";
    // the threshold on the value rounded to tenths, so 99.96 is "100", not "100.0"
    const v = Math.round(d.value * 10) / 10;
    $(".big").textContent = Number.isFinite(d.value) ? decimal(d.value, v >= 100 ? 0 : 1, this.lang) : "";
    $(".unit").textContent = d.unit ?? "";
    const q = d.quality, row = $(".q"), bar = scaled(q);
    row.classList.toggle("none", q == null || q === "");
    row.classList.toggle("text", !bar);
    row.classList.toggle("goal", GOAL.includes(q));
    $(".qlabel").textContent = bar ? QUALITY[this.lang] ?? QUALITY.en : typeof q === "object" ? "" : String(q ?? "");
    $(".bar").style.width = `${bar ? Math.round(Math.min(100, Math.max(0, (q.value / q.max) * 100))) : 0}%`;
    $(".qval").textContent = bar ? `${fmt(q.value, this.lang)}/${fmt(q.max, this.lang)}` : "";
    $(".factslot").innerHTML = this.factsHtml(d.fact_ids);
    this.fit();
  }

  async load(params) {
    const r = await super.load(params);
    this.fit(); // again with the web font loaded
    return r;
  }

  fit() {
    const name = this.stage.querySelector(".name"), team = this.stage.querySelector(".team");
    name.classList.remove("two");
    team.classList.remove("two");
    for (let px = NAME_PX; px >= NAME_MIN; px--) {
      name.style.fontSize = `${px}px`;
      if (name.scrollWidth <= name.clientWidth + 1) break;
    }
    if (name.scrollWidth > name.clientWidth + 1) { name.style.fontSize = ""; name.classList.add("two"); }
    team.classList.toggle("two", team.scrollWidth > team.clientWidth + 1);
  }

  inAnims() {
    const $ = (s) => this.stage.querySelector(s);
    return [
      [$(".kicker"), [{ transform: "translateY(30px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 240, delay: 260 }],
      [$(".card"), [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 420 }],
      [$(".who"), [{ opacity: 0.5, transform: "translateX(-24px)" }, { opacity: 1, transform: "none" }], { duration: 240 }],   // the text rides in with the wipe: no empty bar
      [$(".val"), [{ opacity: 0, transform: "translateX(40px)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: 140 }],
      [$(".q"), [{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 220, delay: 420 }],
      [$(".bar"), [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 600, delay: 520 }],
      [$(".factslot"), [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 600 }],
    ];
  }

  outAnims() {
    return [[this.stage.querySelector(".l3"), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-60px)" }], { duration: 260 }]];
  }
}
