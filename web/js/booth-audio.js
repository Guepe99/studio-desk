// Booth commentary and crowd playback (docs/commentary.md). web/js/booth.js plans the lines; this module plays the
// planned clips gaplessly with the Web Audio API: decoded AudioBuffers started back to back on the audio clock, a
// few ms of fade at every join, the crowd bed looping underneath and ducking under any voice.
//
// It follows the voice button (voice.js): on together, only at 1x, stopped by a seek, a speed change, the button
// or a language switch, paused by a pause. The studio voice comes first: while a studio clip plays the booth's
// lines stop at once, nothing new starts until 1.5 s after it, and the crowd ducks (rule A7).
//
// Autoplay: the AudioContext is made and resumed inside the button's click (unlock()); one made later stays
// suspended and silent until the next press.
import { planMatch, inputs, studioInputs, RULES } from "./booth.js";

export const MIX = {
  duck: 0.5,        // crowd gain under a voice (-6 dB): the bed then sits about 9 to 10 dB under the voices
  duckIn: 0.05,     // time constants of the duck, s
  duckOut: 0.35,
  fade: 0.006,      // at each clip's ends, s
  cut: 0.03,        // a line or a crowd sound stopped early fades this fast
  crowd: 1,         // crowd bus gain before ducking
};
const LOOKAHEAD_S = 1.0;   // lines go on the audio clock this far ahead
const PREFETCH_S = 15;     // and their clips are fetched and decoded this far ahead
const LATE_S = 0.25;       // a line whose start was missed by more than this is dropped
const JOIN_S = 0.05;       // the least silence between two lines when the audio clock runs late
export const CROWD_URL = "vendor/crowd-audio";

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

export class BoothAudio {
  /** @param {{base: string, match, host, state, voice}} opts voice: the studio Voice (its button, rows, current clip) */
  constructor(opts) {
    Object.assign(this, opts);
    this.ok = false;
    this.ctx = null;
    this.buffers = new Map(); // url -> Promise<AudioBuffer | null>
    this.live = [];           // {src, gain, end, voice}: sources started and not yet ended
    this.plans = new Map();   // `${lang}|${audience}` -> plan
    this.cursor = -1;         // index of the next plan item to schedule; -1: find it from the clock
    this.blockUntil = -1;     // match time before which no line starts (studio voice)
  }

  async load() {
    try {
      const [lines, shared, local] = await Promise.all([getJson("booth/lines.json"), getJson("booth/booth.json"),
        getJson(`${this.base}/booth.json`)]);
      this.lines = lines;
      this.names = local.names ?? {};
      this.rows = new Map(); // `${lang}|${key}` -> {url, d}
      for (const [doc, dir] of [[shared, "booth"], [local, this.base]]) {
        for (const r of doc.clips) this.rows.set(`${r.lang}|${r.key}`, { url: new URL(`${dir}/${r.file}`, document.baseURI).href, d: r.duration_s });
      }
      this.ok = true;
    } catch { /* no booth for this match: the studio voice alone */ }
    return this.ok;
  }

  /** The plan for this language and the studio clips this visitor can hear (host.cues is the visitor's sheet). */
  plan() {
    const { lang, audience } = this.state, desk = this.voice.desk;
    // stories held, rejected, with the AI off or edited in this language never speak (voice.js allowed()), so the
    // booth does not leave room for them and talks there itself
    const rows = (this.voice.rows ?? []).filter((r) => r.lang === lang && desk.byId.has(r.story_id) && desk.onAir(desk.byId.get(r.story_id))
      && !desk.decisions.get(r.story_id)?.edited_text?.[lang]);
    const id = `${lang}|${audience}|${rows.map((r) => r.story_id).join()}`;
    if (!this.plans.has(id)) {
      const durations = new Map();
      for (const [k, r] of this.rows) if (k.startsWith(`${lang}|`)) durations.set(k.slice(lang.length + 1), r.d);
      const m = this.match;
      this.plans.set(id, planMatch({ lines: this.lines, lang, meta: m.meta, names: this.names[lang], durations, seed: 1 },
        inputs({ events: m.events, facts: m.facts, studio: studioInputs(this.host.cues, rows, lang), meta: m.meta })));
    }
    if (id !== this.planId) { this.planId = id; this.cursor = -1; } // a desk decision: find the place in the new plan
    return this.plans.get(id);
  }

  // Inside the click: the AudioContext is made, or resumed, in the user gesture.
  unlock() {
    if (!this.ok) return;
    if (!this.ctx) {
      const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.voiceBus = this.ctx.createGain();
      this.crowdBus = this.ctx.createGain();
      this.duck = this.ctx.createGain();
      this.crowdBus.gain.value = MIX.crowd;
      this.voiceBus.connect(this.ctx.destination);
      this.crowdBus.connect(this.duck).connect(this.ctx.destination);
    }
    this.ctx.resume().catch(() => {});
  }

  buffer(url) {
    if (!this.buffers.has(url)) {
      this.buffers.set(url, fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((b) => (b ? this.ctx.decodeAudioData(b) : null)).catch(() => null)
        .then((buf) => { this.buffers.set(url, buf); return buf; }));
    }
    return this.buffers.get(url);
  }

  /** A buffer already decoded, or undefined (still loading or broken). */
  ready(url) {
    const b = this.buffers.get(url);
    return b instanceof AudioBuffer ? b : undefined;
  }

  urls(it) {
    if (it.voice === "crowd") return [`${CROWD_URL}/${it.kind}.mp3`];
    return it.clips.map((c) => this.rows.get(`${this.state.lang}|${c.key}`)?.url);
  }

  /** Seek: everything stops; the next frame finds its place in the plan again. */
  reset() {
    this.stop();
  }

  stop() {
    for (const l of this.live) this.end(l);
    this.live = [];
    this.bed = null;
    this.cursor = -1;
    this.lang = null;
  }

  end(l, at) {
    const t = Math.max(at ?? this.ctx.currentTime, this.ctx.currentTime);
    try {
      l.gain.gain.cancelScheduledValues(t);
      l.gain.gain.setTargetAtTime(0, t, MIX.cut / 3);
      l.src.stop(t + MIX.cut * 2);
    } catch { /* already stopped */ }
  }

  // match time -> audio clock, anchored when playback (re)starts
  at(ts) { return this.t0 + (ts - this.n0); }

  /** Once per frame, after voice.update. */
  update(now) {
    if (!this.ok || !this.ctx) return;
    const s = this.state, on = this.voice.on && s.speed === 1;
    if (!on || s.lang !== this.lang && this.lang !== null) this.stop();
    if (!on) return;
    if (!s.playing) { if (this.ctx.state === "running") this.ctx.suspend().catch(() => {}); return; }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    if (this.ctx.state !== "running") return; // no gesture yet: silent until the next press
    const clock = this.ctx.currentTime;
    const plan = this.plan(); // first: a new plan resets the cursor
    // first frame after a start, a seek or a stall of the page: anchor the audio clock to match time
    if (this.cursor < 0 || Math.abs(this.at(now) - clock) > 0.3) { this.t0 = clock; this.n0 = now; }
    this.live = this.live.filter((l) => l.end > clock);
    if (this.cursor < 0) {
      this.lang = s.lang;
      this.cursor = plan.findIndex((it) => it.t >= now - LATE_S);
      if (this.cursor < 0) this.cursor = plan.length;
    }
    if (!this.bed) this.startBed();
    // the studio voice: booth lines stop now and none starts until 1.5 s after it
    const studio = Boolean(this.voice.current);
    if (studio) {
      this.blockUntil = now + RULES.studioAfter;
      for (const l of this.live) if (l.voice !== "crowd") { this.end(l); l.end = clock; }
    }
    this.setDuck(studio || this.live.some((l) => l.voice !== "crowd" && l.start <= clock + 0.02), clock);
    for (let i = this.cursor; i < plan.length && plan[i].t < now + PREFETCH_S; i++) for (const u of this.urls(plan[i])) if (u) this.buffer(u);
    while (this.cursor < plan.length && plan[this.cursor].t < now + LOOKAHEAD_S) {
      const it = plan[this.cursor++];
      if (it.t < now - LATE_S || (it.until ?? Infinity) <= it.t) continue;
      if (it.voice !== "crowd" && it.t < this.blockUntil) continue;
      this.schedule(it, now);
    }
  }

  schedule(it, now) {
    const urls = this.urls(it), bufs = urls.map((u) => this.ready(u));
    if (bufs.some((b) => !b)) return; // not decoded in time, or missing: the line is skipped, never late
    const stopAt = it.until !== undefined ? this.at(it.until) : Infinity;
    const offs = it.voice === "crowd" ? [0] : it.clips.map((c) => c.off);
    // When the audio clock falls behind the page's (a slow frame), a line never starts over the one before:
    // all its clips move by the same delay, so a name stays after its phrase, and a line that would start
    // more than LATE_S late is dropped
    const now0 = this.ctx.currentTime, at0 = this.at(it.t);
    const busy = it.voice === "crowd" ? now0 : Math.max(now0, ...this.live.filter((l) => l.voice !== "crowd").map((l) => l.end + JOIN_S));
    const delay = Math.max(0, busy - at0);
    if (it.voice !== "crowd" && delay > LATE_S) return;
    bufs.forEach((buf, i) => {
      const start = this.at(it.t + offs[i]) + delay;
      if (start >= stopAt) return;
      const end = Math.min(start + buf.duration, stopAt);
      this.play(buf, start, end, it.voice === "crowd" ? this.crowdBus : this.voiceBus, it.voice, end < start + buf.duration);
    });
    if (it.voice !== "crowd") this.lastLine = it;
  }

  play(buf, start, end, bus, voice, cut, loop = false) {
    const src = this.ctx.createBufferSource(), gain = this.ctx.createGain();
    src.buffer = buf;
    src.loop = loop;
    const g = gain.gain, f = cut ? MIX.cut : MIX.fade;
    g.setValueAtTime(0, start);
    g.linearRampToValueAtTime(1, start + MIX.fade);
    src.connect(gain).connect(bus);
    src.start(start); // before stop(): stop() on a source not started throws
    if (Number.isFinite(end)) {
      g.setValueAtTime(1, Math.max(start + MIX.fade, end - f));
      g.linearRampToValueAtTime(0, end);
      src.stop(end + 0.01);
    }
    const l = { src, gain, start, end: Number.isFinite(end) ? end : Infinity, voice };
    this.live.push(l);
    return l;
  }

  startBed() {
    const url = `${CROWD_URL}/bed.mp3`, buf = this.ready(url);
    if (!buf) { this.buffer(url); return; }
    this.bed = this.play(buf, this.ctx.currentTime, Infinity, this.crowdBus, "crowd", false, true);
  }

  setDuck(on, clock) {
    if (on === this.ducked) return;
    this.ducked = on;
    this.duck.gain.setTargetAtTime(on ? MIX.duck : 1, clock, on ? MIX.duckIn : MIX.duckOut);
  }

  /** For the browser test: what plays now. */
  get status() {
    const clock = this.ctx?.currentTime ?? 0;
    const now = this.live.filter((l) => l.start <= clock && l.end > clock);
    return { state: this.ctx?.state ?? "none", lines: now.filter((l) => l.voice !== "crowd").length,
      crowd: now.filter((l) => l.voice === "crowd").length, duck: this.duck?.gain.value ?? 1, last: this.lastLine?.text ?? null };
  }
}
