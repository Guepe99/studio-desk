// "Why it matters" card and recap, top right.
import { SdGraphic } from "../shared/sd-graphic.mjs";

const KICKER = { why: "WHY IT MATTERS", recap: "RECAP" };

export default class WhyCard extends SdGraphic {
  css() {
    return `
.box { position: absolute; right: 72px; top: 56px; width: 720px; }
.card { padding: 22px 30px 26px; margin-top: -2px; border-left: 8px solid #2ec4f1; }
.title { font-weight: 800; font-size: 50px; line-height: 1.02; letter-spacing: .005em; }
.body { margin-top: 14px; font-weight: 500; font-size: 33px; line-height: 1.22; color: #dfe7fb;
  display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }`;
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
