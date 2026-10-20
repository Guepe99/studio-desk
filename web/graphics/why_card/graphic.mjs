// "Why it matters" card and recap, top right.
import { SdGraphic } from "../shared/sd-graphic.mjs";

const KICKER = { why: "WHY IT MATTERS", recap: "RECAP" };
// The body gets 5 lines at 33 px; longer text shrinks to fit, down to 24 px (30 px in the compact
// variant of a small frame). Text that still does not fit is shown in full and the card grows: a body is never cut.
const BODY_PX = 33, MIN_PX = 24, COMPACT_PX = 30, LINE = 1.22, MAX_H = 5 * BODY_PX * LINE;

export default class WhyCard extends SdGraphic {
  css() {
    return `
.box { position: absolute; right: 72px; top: 56px; width: 720px; }
.card { padding: 22px 30px 26px 34px; box-shadow: inset 8px 0 0 var(--pink), var(--shadow); }
.title { font-weight: 800; font-size: 44px; line-height: 1.08; }
.body { margin-top: 14px; font-weight: 400; font-size: ${BODY_PX}px; line-height: ${LINE}; color: var(--lilac-100); }`;
  }

  html() {
    return `<div class="box"><div class="kicker"></div><div class="card panel"><div class="title"></div><div class="body"></div></div>
      <div class="factslot"></div></div>`;
  }

  render() {
    const d = this.data, $ = (s) => this.stage.querySelector(s);
    $(".kicker").textContent = KICKER[d.kind] ?? "";
    $(".title").textContent = d.title ?? "";
    $(".body").textContent = d.body ?? "";
    $(".factslot").innerHTML = this.factsHtml(d.fact_ids);
    this.fit();
  }

  async load(params) {
    const r = await super.load(params);
    this.fit(); // again with the web font loaded
    return r;
  }

  fit() {
    const b = this.stage.querySelector(".body");
    const min = this.stage.classList.contains("compact") ? COMPACT_PX : MIN_PX;
    for (let px = BODY_PX; px >= min; px--) {
      b.style.fontSize = `${px}px`;
      if (b.scrollHeight <= MAX_H + 1) return;
    }
  }

  inAnims() {
    const $ = (s) => this.stage.querySelector(s);
    return [
      [$(".card"), [{ clipPath: "inset(0 0 0 100%)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 420 }],
      [$(".kicker"), [{ opacity: 0, transform: "translateY(24px)" }, { opacity: 1, transform: "none" }], { duration: 240, delay: 220 }],
      [$(".title"), [{ opacity: 0, transform: "translateX(30px)" }, { opacity: 1, transform: "none" }], { duration: 300, delay: 260 }],
      [$(".body"), [{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: 420 }],
      [$(".factslot"), [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 640 }],
    ];
  }

  outAnims() {
    return [[this.stage.querySelector(".box"), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(60px)" }], { duration: 260 }]];
  }
}
