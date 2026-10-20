// Shared base of the Studio Desk OGraf v1 graphics (https://github.com/ebu/ograf, MIT).
// One step (stepCount 1), real-time actions, and the non-real-time path (setActionsSchedule +
// goToTime) built on Web Animations so any frame can be rendered at an exact time.
//
// A graphic subclass provides css(), html(), render() and inAnims() / outAnims(), each anim being
// [element, keyframes, timing]. Elements are in their visible state in CSS; in-animations start
// hidden. All layout is in a 1920x1080 space, scaled to the renderer resolution on load.
//
// Vendor load() params (OGraf "v_" fields): v_showFactIds (show the evidence fact ids),
// v_players {player_id: {name, shirt, team_short, team_name, color, text}},
// v_teams {home: {short, name, color}, away: {...}}, v_compact (a small frame or the deck: the graphic is
// drawn small, so the smallest type is raised to 30 px), v_side ("left" or "right": a graphic that can
// sit on either side goes there, momentum).

export const EASE = "cubic-bezier(.2,.8,.2,1)";
const REDUCED = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");

// The page's palette, again on :host: a graphic is a standalone OGraf component and may be hosted
// without broadcast.css. Purple panels, white text, green or pink accents; green is only a fill or an
// accent on purple, never text on a light surface.
const BASE_CSS = `
:host { position: absolute; inset: 0; pointer-events: none; overflow: hidden;
  --purple: #37003c; --purple-700: #28002b; --purple-900: #1e0021; --purple-400: #541e5d; --lilac-100: #ebe5eb;
  --page: #ffffff; --green: #00ff87; --pink: #ff2882; --cyan: #05f0ff;
  --r-card: 16px; --r-box: 12px; --r-chip: 8px; --shadow: 0 4px 16px 0 rgba(55, 0, 60, .08); }
.stage { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; transform-origin: 0 0;
  font-family: "Urbanist", "Helvetica Neue", Arial, sans-serif; color: var(--page); line-height: 1; }
.panel { background: var(--purple); border-radius: 0 var(--r-card) var(--r-card) var(--r-card); box-shadow: var(--shadow); }
.kicker { background: var(--green); color: var(--purple); font-weight: 800; font-size: 22px; letter-spacing: .1em;
  padding: 9px 18px 8px; border-radius: var(--r-chip) var(--r-chip) 0 0; display: inline-block; }
.facts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
/* fact id chips: the provenance, small and quiet, one line each (the floor size on a phone, never bigger) */
.facts span { font-weight: 400; font-size: 17px; color: var(--lilac-100); white-space: nowrap;
  background: var(--purple-900); border-radius: var(--r-chip); padding: 3px 8px; }
.compact .kicker, .compact .facts span { font-size: 30px; }
.compact .facts span { padding: 2px 8px; }
`;

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class SdGraphic extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.currentStep = undefined;
    this.data = {};
    this._schedule = [];
    this._anims = [];
    this._phase = null;
  }

  // --- subclass hooks
  css() { return ""; }
  html() { return ""; }
  render() {}
  inAnims() { return []; }
  outAnims() { return [[this.stage, [{ opacity: 1 }, { opacity: 0 }], { duration: 250 }]]; }
  get customActions() { return {}; }

  factsHtml(ids) {
    const all = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    // A momentum series cites one fact per window: show the latest few, count the rest.
    const list = all.slice(-3), more = all.length - list.length;
    const chips = list.map((f) => `<span>${esc(f)}</span>`).join("") + (more ? `<span>+${more} more</span>` : "");
    return this.showFacts && all.length ? `<div class="facts">${chips}</div>` : "";
  }

  // --- OGraf v1 interface
  async load(params = {}) {
    this.data = structuredClone(params.data ?? {});
    this._loadData = structuredClone(this.data);
    this.renderType = params.renderType ?? "realtime";
    this.showFacts = !!params.v_showFactIds;
    this.players = params.v_players ?? {};
    this.teams = params.v_teams ?? {};
    this.resolution = params.renderCharacteristics?.resolution ?? { width: 1920, height: 1080 };
    this.shadowRoot.innerHTML = `<style>${BASE_CSS}${this.css()}</style><div class="stage">${this.html()}</div>`;
    this.stage = this.shadowRoot.querySelector(".stage");
    this.stage.classList.toggle("compact", !!params.v_compact);
    const w = this.clientWidth || params.renderCharacteristics?.resolution?.width || 1920;
    this.stage.style.transform = `scale(${w / 1920})`;
    this.render();
    this._animate("in", 0);
    if (document.fonts) await document.fonts.ready;
    return { statusCode: 200 };
  }

  async dispose() {
    this._anims.forEach((a) => a.cancel());
    this._anims = [];
    this.shadowRoot.innerHTML = "";
    return { statusCode: 200 };
  }

  async playAction(params = {}) {
    const { goto, delta, skipAnimation } = params;
    const target = Number.isInteger(goto) && goto >= 0 ? goto
      : (this.currentStep ?? -1) + (Number.isInteger(delta) ? delta : 1);
    if (target >= 1) {
      await this.stopAction(params);
      return { statusCode: 200, currentStep: undefined };
    }
    const shown = this.currentStep === 0;
    this.currentStep = 0;
    if (!shown) await this._animate("in", null, skipAnimation);
    return { statusCode: 200, currentStep: 0 };
  }

  async stopAction(params = {}) {
    this.currentStep = undefined;
    await this._animate("out", null, params.skipAnimation);
    return { statusCode: 200 };
  }

  async updateAction(params = {}) {
    Object.assign(this.data, params.data ?? {});
    this.render();
    // render() may replace animated elements: rebuild the animations in the current state
    this._phase = null;
    this._animate("in", this.currentStep === 0 ? null : 0, this.currentStep === 0);
    return { statusCode: 200 };
  }

  async customAction(params = {}) {
    const fn = this.customActions[params.id];
    if (!fn) return { statusCode: 404, statusMessage: `Unknown custom action: ${params.id}` };
    fn.call(this, params.payload ?? {});
    return { statusCode: 200 };
  }

  async setActionsSchedule(params = {}) {
    this._schedule = [...(params.schedule ?? [])].sort((a, b) => a.timestamp - b.timestamp);
  }

  async goToTime({ timestamp }) {
    const data = structuredClone(this._loadData);
    let play = null, stop = null;
    for (const { timestamp: ts, action } of this._schedule) {
      if (ts > timestamp) break;
      if (action.type === "updateAction") Object.assign(data, action.params?.data ?? {});
      else if (action.type === "playAction") { play = ts; stop = null; }
      else if (action.type === "stopAction" && play !== null) stop = ts;
      else if (action.type === "customAction") this.customActions[action.params?.id]?.call(this, action.params.payload ?? {});
    }
    if (JSON.stringify(data) !== JSON.stringify(this.data)) {
      this.data = data;
      this.render();
      this._phase = null;
    }
    if (stop !== null) this._animate("out", timestamp - stop);
    else if (play !== null) this._animate("in", timestamp - play);
    else this._animate("in", 0);
    this.currentStep = play !== null && stop === null ? 0 : undefined;
    return { statusCode: 200 };
  }

  // --- animation: phase "in" or "out"; at = ms on a paused timeline, or null to run live
  _animate(phase, at = null, skip = false) {
    const reuse = at !== null && this._phase === phase && this._anims.length && this._anims[0].playState === "paused";
    if (!reuse) {
      this._anims.forEach((a) => a.cancel());
      const list = phase === "out" ? this.outAnims() : this.inAnims();
      this._anims = list.map(([el, kf, t]) => el.animate(kf, { fill: "both", easing: EASE, ...t }));
      this._phase = phase;
    }
    // reduced motion: jump to the end state (at = 0 is the hidden start of a graphic, kept as is)
    if (skip || (REDUCED?.matches && at !== 0)) this._anims.forEach((a) => a.finish());
    else if (at !== null) this._anims.forEach((a) => { a.pause(); a.currentTime = Math.max(0, at); });
    else return Promise.all(this._anims.map((a) => a.finished.catch(() => {})));
    return Promise.resolve();
  }
}
