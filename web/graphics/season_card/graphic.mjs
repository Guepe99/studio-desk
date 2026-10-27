// The season so far, at kick-off: the two clubs' lines in the table with their last five, the last meeting
// and each club's top scorer on the team sheet. Top right, where the key moment card sits later.
import { SdGraphic, esc } from "../shared/sd-graphic.mjs";

const WORDS = {
  en: { kicker: "SEASON SO FAR", week: "Matchweek {n}", pos: "Pos", pts: "Pts", gd: "GD", form: "Last 5", met: "Last meeting",
    top: "Top scorer", goals: (n) => `${n} goal${n === 1 ? "" : "s"}`, res: { W: "W", D: "D", L: "L" } },
  it: { kicker: "LA STAGIONE FIN QUI", week: "{n}ª giornata", pos: "Pos", pts: "Pt", gd: "DR", form: "Ultime 5", met: "Ultimo confronto",
    top: "Miglior marcatore", goals: (n) => `${n} gol`, res: { W: "V", D: "N", L: "P" } },
  es: { kicker: "LA TEMPORADA HASTA AHORA", week: "Jornada {n}", pos: "Pos", pts: "Pts", gd: "DG", form: "Últimos 5", met: "Último enfrentamiento",
    top: "Máximo goleador", goals: (n) => `${n} gol${n === 1 ? "" : "es"}`, res: { W: "G", D: "E", L: "P" } },
};

const ordinal = (n, lang) => (lang === "it" ? `${n}°` : lang === "es" ? `${n}.º`
  : `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`);
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);

export default class SeasonCard extends SdGraphic {
  css() {
    return `
.box { position: absolute; right: 72px; top: 56px; width: 720px; }
.card { padding: 20px 30px 22px 34px; box-shadow: inset 8px 0 0 var(--green), var(--shadow); }
.title { font-weight: 800; font-size: 40px; line-height: 1.08; }
.table { display: grid; grid-template-columns: 1fr repeat(3, 72px) max-content; column-gap: 14px; row-gap: 10px; align-items: center;
  margin-top: 16px; font-variant-numeric: tabular-nums; }
.th { font-weight: 600; font-size: 20px; color: var(--lilac-100); text-align: right; }
.th.club { text-align: left; }
.club { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 30px; }
.chip { width: 10px; height: 30px; border-radius: 3px; box-shadow: inset 0 0 0 2px var(--lilac-100); }
.num { font-weight: 700; font-size: 30px; text-align: right; }
.form { display: flex; gap: 5px; justify-content: flex-end; }
.r { width: 30px; height: 30px; border-radius: 6px; display: grid; place-items: center; font-weight: 800; font-size: 19px; }
.r.W { background: var(--green); color: var(--purple); }
.r.D { background: var(--lilac-100); color: var(--purple); }
.r.L { background: var(--pink); color: var(--page); }
.more { margin-top: 16px; padding-top: 14px; border-top: 3px solid var(--purple-400); display: grid; row-gap: 8px; }
.more:empty { display: none; }
.line { display: flex; align-items: baseline; gap: 12px; font-size: 26px; }
.lbl { font-weight: 600; font-size: 20px; color: var(--lilac-100); min-width: 0; }
.val { font-weight: 700; }
.compact .title { font-size: 40px; }
.compact .th, .compact .lbl, .compact .r { font-size: 30px; }
.compact .r { width: 40px; height: 40px; }
.compact .line, .compact .club, .compact .num { font-size: 32px; }
.compact .table { grid-template-columns: 1fr repeat(3, 84px) max-content; }`;
  }

  html() {
    return `<div class="box"><div class="kicker"></div><div class="card panel"><div class="title"></div>
      <div class="table"></div><div class="more"></div></div><div class="factslot"></div></div>`;
  }

  render() {
    const d = this.data, $ = (s) => this.stage.querySelector(s), w = WORDS[this.lang] ?? WORDS.en;
    const short = (side) => esc(this.teams?.[side]?.short ?? String(side ?? "").toUpperCase());
    const color = (side) => esc(this.teams?.[side]?.color ?? (side === "home" ? "#ffffff" : "#05f0ff"));
    $(".kicker").textContent = w.kicker;
    $(".title").textContent = int(d.matchweek) === null ? "" : w.week.replace("{n}", int(d.matchweek));
    const rows = Array.isArray(d.rows) ? d.rows : [];
    $(".table").innerHTML = [`<span class="th club"></span>`, ...[w.pos, w.pts, w.gd, w.form].map((h) => `<span class="th">${esc(h)}</span>`),
      ...rows.flatMap((r) => [
        `<span class="club"><span class="chip" style="background:${color(r.side)}"></span>${short(r.side)}</span>`,
        `<span class="num">${int(r.pos) === null ? "" : esc(ordinal(int(r.pos), this.lang))}</span>`,
        `<span class="num">${int(r.pts) ?? ""}</span>`,
        `<span class="num">${int(r.gd) === null ? "" : signed(int(r.gd))}</span>`,
        `<span class="form">${(Array.isArray(r.form) ? r.form : []).filter((x) => w.res[x]).map((x) => `<span class="r ${x}">${w.res[x]}</span>`).join("")}</span>`,
      ])].join("");
    const h = d.h2h, lines = [];
    if (h && int(h.matchweek) !== null && int(h.home_goals) !== null && int(h.away_goals) !== null) {
      lines.push([w.met, `${w.week.replace("{n}", int(h.matchweek))}: ${short(h.home)} ${int(h.home_goals)}-${int(h.away_goals)} ${short(h.away)}`]);
    }
    for (const s of Array.isArray(d.scorers) ? d.scorers : []) {
      lines.push([`${w.top}, ${short(s.side)}`, int(s.goals) === null ? esc(s.name) : `${esc(s.name)}, ${w.goals(int(s.goals))}`]);
    }
    $(".more").innerHTML = lines.map(([l, v]) => `<div class="line"><span class="lbl">${esc(l)}</span><span class="val">${v}</span></div>`).join("");
    $(".factslot").innerHTML = this.factsHtml(d.fact_ids);
  }

  inAnims() {
    const $ = (s) => this.stage.querySelector(s);
    const rows = [...this.stage.querySelectorAll(".club, .line")];
    return [
      [$(".card"), [{ clipPath: "inset(0 0 0 100%)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 420 }],
      [$(".kicker"), [{ opacity: 0, transform: "translateY(24px)" }, { opacity: 1, transform: "none" }], { duration: 240, delay: 220 }],
      [$(".title"), [{ opacity: 0, transform: "translateX(30px)" }, { opacity: 1, transform: "none" }], { duration: 300, delay: 260 }],
      ...rows.map((r, i) => [r, [{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 420 + i * 60 }]),
      [$(".factslot"), [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 700 }],
    ];
  }

  outAnims() {
    return [[this.stage.querySelector(".box"), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(60px)" }], { duration: 260 }]];
  }
}
