// Nameplate: a tag attached to a player on the pitch, with name and speed.
import { SdGraphic } from "../shared/sd-graphic.mjs";

export default class Nameplate extends SdGraphic {
  css() {
    return `
.anchor { position: absolute; left: 0; top: 0; will-change: transform; }
.ring { position: absolute; left: -35px; top: -35px; width: 70px; height: 70px; box-sizing: border-box; border-radius: 50%;
  border: 5px solid var(--green); box-shadow: 0 0 0 3px var(--purple); }
.leader { position: absolute; left: -2px; width: 4px; background: var(--green); top: -100px; height: 70px; transform-origin: 50% 100%; }
.box { position: absolute; left: -2px; bottom: 100px; display: flex; flex-direction: column; align-items: flex-start; }
.tag { display: flex; align-items: stretch; height: 84px; border-radius: var(--r-box); overflow: hidden; }
.num { width: 72px; display: grid; place-items: center; font-weight: 800; font-size: 42px; }
.txt { padding: 8px 24px 0 16px; display: flex; flex-direction: column; justify-content: center; gap: 6px; }
.name { font-weight: 800; font-size: 34px; text-transform: uppercase; white-space: nowrap; }
.sub { display: flex; gap: 14px; align-items: baseline; font-size: 26px; white-space: nowrap; }
.team { font-weight: 700; color: var(--lilac-100); letter-spacing: .06em; }
.speed { font-weight: 800; color: var(--green); font-size: 28px; }
.flip-x .box { left: auto; right: -2px; align-items: flex-end; }
.flip-y .leader { top: 30px; transform-origin: 50% 0; }
.flip-y .box { bottom: auto; top: 100px; flex-direction: column-reverse; }
.flip-y .facts { margin: 0 0 8px; }
.hidden { display: none; }`;
  }

  html() {
    return `<div class="anchor"><div class="ring"></div><div class="leader"></div>
      <div class="box"><div class="tag panel"><div class="num"></div>
      <div class="txt"><div class="name"></div><div class="sub"><span class="team"></span><span class="speed"></span></div></div></div>
      <div class="factslot"></div></div></div>`;
  }

  render() {
    const d = this.data, p = this.players[d.player_id] ?? {}, $ = (s) => this.stage.querySelector(s);
    const num = $(".num");
    num.textContent = d.shirt ?? "";
    num.style.background = p.color ?? "#00ff87";
    num.style.color = p.text ?? "#37003c";
    $(".name").textContent = d.name ?? d.player_id ?? "";
    $(".team").textContent = d.team_short ?? "";
    $(".speed").textContent = Number.isFinite(d.speed_kmh) ? `${d.speed_kmh.toFixed(1)} km/h` : "";
    $(".factslot").innerHTML = this.factsHtml(d.fact_id);
    this.anchor = $(".anchor");
  }

  get customActions() {
    return {
      // payload {x, y, visible}: the player's position in renderer pixels, sent every frame. The
      // element may be larger than the renderer (drawn magnified): flip against the renderer edge.
      position({ x, y, visible = true }) {
        if (!this.anchor) return;
        const k = 1920 / (this.clientWidth || 1920);
        const sx = x * k, sy = y * k;
        this.anchor.classList.toggle("hidden", !visible || !Number.isFinite(sx));
        this.anchor.classList.toggle("flip-x", sx > this.resolution.width * k - 460);
        // below the player only where the top is short and the bottom has more room: drawn
        // magnified on a phone the renderer is under 500 stage px tall, and neither side may fit
        this.anchor.classList.toggle("flip-y", sy < 330 && this.resolution.height * k - sy > sy);
        this.anchor.style.transform = `translate(${sx}px, ${sy}px)`;
      },
    };
  }

  inAnims() {
    const $ = (s) => this.stage.querySelector(s);
    return [
      [$(".ring"), [{ transform: "scale(2.2)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 260 }],
      [$(".leader"), [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: 180, delay: 140 }],
      [$(".tag"), [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 320, delay: 260 }],
      [$(".txt"), [{ opacity: 0, transform: "translateX(-16px)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: 420 }],
      [$(".factslot"), [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 560 }],
    ];
  }
}
