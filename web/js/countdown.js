// The two broadcast moments at the ends of the replay (plan step p65): a 3-2-1 "Kick off" count when the
// viewer presses Play at the very start, and a "Full time" strap in the last seconds before the final whistle.
//
// The count holds the clock: Play starts it, the match clock runs from "Kick off" (COUNT_S real seconds
// later), as a broadcast counts down to air. A second press stops it, a seek or a programmatic play
// (window.studioDesk.setPlaying, the tests) cancels it. It shows only from the very start (a seek or a deep
// link past START_TS never counts) and only up to MAX_SPEED: at 16x and 64x the viewer is skimming and a
// three second wait would cost a minute of match, so play starts at once. Full time follows the same speed
// rule (at 16x its six match seconds would flash for a third of a second).
//
// Sound follows the page's: pips only with the Voice button on and at 1x, the speeds the booth and the
// voice play at (voice.js, booth-audio.js). Three short pips and a long one on a WebAudio oscillator, made in
// the Play press (an AudioContext needs a user gesture). The whistles are the booth's own: it blows
// web/vendor/crowd-audio/whistle.mp3 at kick-off and at full time (booth.js), so nothing is added here.
//
// The strap sits top centre, where the replay badge goes; app.js hides it while a graphic on air or the
// replay badge covers that spot (a full-time recap card comes on at the whistle).
export const COUNT_S = 3;            // real seconds of "3", "2", "1"
export const KICKOFF_S = 1.5;        // real seconds "Kick off" stays once the clock runs
export const START_TS = 0.5;         // match seconds: Play before this counts, after it plays at once
export const MAX_SPEED = 4;
export const FULL_TIME = [2, 4];     // match seconds before and after the final whistle
export const PIPS = [[0, 0.1, 880], [1, 0.1, 880], [2, 0.1, 880], [3, 0.45, 1320]];   // [s after the press, length s, Hz]

export const WORDS = {
  en: { kickoff: "Kick off", fulltime: "Full time" },
  it: { kickoff: "Calcio d'inizio", fulltime: "Fine partita" },
  es: { kickoff: "Saque inicial", fulltime: "Final del partido" },
};

export const wantsCountdown = (ts, speed) => ts < START_TS && speed <= MAX_SPEED;

// What the count says e real seconds after the press: "3", "2", "1", then "kickoff", then nothing.
export function countLabel(e) {
  if (!(e >= 0)) return null;
  if (e < COUNT_S) return String(COUNT_S - Math.floor(e));
  return e < COUNT_S + KICKOFF_S ? "kickoff" : null;
}

export const fullTimeAt = (ts, duration, speed) => speed <= MAX_SPEED && ts >= duration - FULL_TIME[0] && ts < duration + FULL_TIME[1];

const REDUCE = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

export class Countdown {
  /** @param {HTMLElement} el the strap; opts: lang() the page language, sound() whether pips may play */
  constructor(el, { lang, sound }) {
    Object.assign(this, { el, lang, sound });
    this.span = el.firstElementChild;
    this.t0 = null;      // performance.now() of the press, while counting or showing "Kick off"
    this.started = false;
    this.ctx = null;
    this.bus = null;
    this.shown = null;
  }

  get counting() { return this.t0 !== null && !this.started; }

  // The press: true when the count starts (the caller holds the clock until frame() says go).
  start(ts, speed, now = performance.now()) {
    this.cancel();
    if (!wantsCountdown(ts, speed)) return false;
    this.t0 = now;
    this.started = false;
    if (this.sound() && speed === 1) this._pips();
    return true;
  }

  cancel() {
    this.t0 = null;
    this._silence();
  }

  _silence() {
    if (this.bus) { try { this.bus.disconnect(); } catch { /* already gone */ } this.bus = null; }
  }

  _pips() {
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AC) return;
    this.ctx ??= new AC();
    this.ctx.resume().catch(() => {});
    const c = this.ctx, at = c.currentTime + 0.02;
    this.bus = c.createGain();
    this.bus.gain.value = 0.18;
    this.bus.connect(c.destination);
    for (const [off, len, hz] of PIPS) {
      const o = c.createOscillator(), g = c.createGain(), t = at + off;
      o.frequency.value = hz;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + 0.005);   // a few ms of ramp at each end: no click
      g.gain.setValueAtTime(1, t + len - 0.02);
      g.gain.linearRampToValueAtTime(0, t + len);
      o.connect(g).connect(this.bus);
      o.start(t);
      o.stop(t + len + 0.01);
    }
  }

  // Once per page frame. Returns true on the frame the clock should start.
  frame(now, ts, speed, duration) {
    let go = false, label = null;
    if (this.t0 !== null) {
      // the speed raised past MAX_SPEED mid count: play at once; the sound turned off or the speed off 1x: go on silent
      if (!this.started && speed > MAX_SPEED) this.t0 = Math.min(this.t0, now - COUNT_S * 1000);
      if (this.bus && !(this.sound() && speed === 1)) this._silence();
      const e = Math.max(0, (now - this.t0) / 1000);   // a frame's time can be from before the press (the frame began first)
      if (!this.started && e >= COUNT_S) { this.started = true; go = true; }
      label = countLabel(e);
      if (label === null) this.t0 = null;
    }
    if (label === null && fullTimeAt(ts, duration, speed)) label = "fulltime";
    if (label !== this.shown) this._show(label);
    return go;
  }

  _show(label) {
    this.shown = label;
    const words = WORDS[this.lang()] ?? WORDS.en;
    this.span.textContent = label === null ? "" : words[label] ?? label;
    this.el.classList.toggle("on", label !== null);
    this.el.classList.toggle("digit", /^\d$/.test(label ?? ""));
    if (label !== null && !REDUCE.matches) this.span.animate?.([{ opacity: 0, transform: "scale(1.25)" }, { opacity: 1, transform: "scale(1)" }], { duration: 220, easing: "ease-out" });
  }

  // a language change while the strap is up
  relabel() { const l = this.shown; this.shown = undefined; if (l !== null) this._show(l); else this.shown = null; }
}
