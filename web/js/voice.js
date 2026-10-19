// Voice-over for the replay (docs/voice.md). Clips are generated beforehand by
// `python -m studiodesk.voice` and listed in data/<match>/voice.json.
//
// A story speaks once, when its first cue appears on screen during playback at 1x, in a language
// it has a clip for. What is on screen is the OGraf host's business and what may go on air is the
// desk's: this module only reads host.live (on screen now), host.cues (this visitor's sheet) and
// desk.onAir / desk.status, so held, rejected and AI-off stories never speak. An edited story stays
// silent (the clip says the old text), and so does a clip whose text_sha1 no longer matches the
// story text. One clip at a time: a story that comes up while another speaks waits, and is dropped
// if it would start more than QUEUE_MAX_S of match time after its cue. Seek, speed change, mute
// and anything that takes the story off air stop the clip; a pause pauses it. A story that
// Content Safety flagged never speaks, even once a visitor approves it.
//
// Autoplay: WebKit unlocks media per element, inside a user gesture. So there is one Audio element,
// created and unlocked in the button's click and reused for every clip by changing its src. If the
// browser still refuses to play (NotAllowedError), the button goes back to off.

const START_WINDOW_S = 1;   // a cue that is already older than this when it appears does not speak (after a seek)
const QUEUE_MAX_S = 4;
const KEY = "studiodesk.voice";

async function sha1(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Voice {
  /** @param {{base: string, host, desk, state, button: HTMLButtonElement}} opts */
  constructor(opts) {
    Object.assign(this, opts);
    this.clips = new Map(); // `${story_id}|${lang}` -> url
    this.played = new Set(); // stories that already had their moment since the last seek
    this.audio = null;       // the one element, made in the first click on the button
    this.current = null;     // {sid, lang}: the clip in the element now
    this.queued = null;      // {sid, ts}
    try { this.on = localStorage.getItem(KEY) === "on"; } catch { this.on = false; }
  }

  async load() {
    let rows = [];
    try {
      const r = await fetch(`${this.base}/voice.json`);
      if (r.ok) rows = await r.json();
    } catch { /* no voice for this replay */ }
    for (const row of rows) {
      const s = this.desk.byId.get(row.story_id), text = s?.texts?.[row.lang];
      // crypto.subtle needs a secure context (https or localhost); without it the page stays silent
      if (text && globalThis.crypto?.subtle && (await sha1(text)) === row.text_sha1) {
        this.clips.set(`${row.story_id}|${row.lang}`, new URL(`${this.base}/${row.file}`, document.baseURI).href);
      }
    }
    this.button.hidden = !this.clips.size;
    this.button.addEventListener("click", () => this.toggle());
    this.render();
  }

  toggle() {
    this.on = !this.on;
    try { localStorage.setItem(KEY, this.on ? "on" : "off"); } catch { /* private window: not remembered */ }
    if (!this.on) this.stop();
    else if (!this.current) this.unlock();
    this.render();
  }

  element() {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.addEventListener("ended", () => { if (this.current) this.next(); });
    }
    return this.audio;
  }

  // Inside the click: a muted play of a clip unlocks the element for the clips that come later.
  unlock() {
    if (!this.clips.size) return;
    const a = this.element();
    a.muted = true;
    a.src = this.clips.values().next().value;
    a.play().then(() => { if (!this.current) a.pause(); }, (e) => this.refused(e)).finally(() => { a.muted = false; });
  }

  refused(e) {
    if (e?.name !== "NotAllowedError") return; // AbortError: a newer src or a pause, not a refusal
    this.on = false; // the button tells the truth: this browser will not play without another press
    this.stop();
    this.render();
  }

  render() {
    this.button.setAttribute("aria-pressed", String(this.on));
    // the label says AI: listeners should know the voice is synthetic (docs/voice.md)
    this.button.title = this.on ? "AI voice-over on: English, plays at 1x" : "AI voice-over off";
  }

  /** Seek: the clip stops and every story can speak again. */
  reset() {
    this.stop();
    this.played.clear();
  }

  stop() {
    if (this.current) this.audio.pause();
    this.current = null;
    this.queued = null;
  }

  // may this story speak now, for this visitor?
  allowed(sid) {
    const s = this.desk.byId.get(sid);
    return this.on && this.state.speed === 1 && Boolean(s) && s.safety !== "flagged" && this.desk.onAir(s)
      && this.desk.status(s) !== "edited" && this.clips.has(`${sid}|${this.state.lang}`) && this.host.cues.some((c) => c.story_id === sid);
  }

  start(sid) {
    const a = this.element(); // after a reload with the voice remembered on, made outside a gesture: may be refused
    a.muted = false;
    a.src = this.clips.get(`${sid}|${this.state.lang}`);
    this.current = { sid, lang: this.state.lang };
    this.play();
  }

  play() {
    const cur = this.current;
    // refused (autoplay rules): the button goes off; a broken file: this clip stays silent; a pause while it loads is not an error
    this.audio.play().catch((e) => {
      if (e.name === "NotAllowedError") this.refused(e);
      else if (e.name !== "AbortError" && this.current === cur) this.stop();
    });
  }

  next() {
    this.current = null;
    const q = this.queued;
    this.queued = null;
    if (q && this.state.playing && this.now - q.ts <= QUEUE_MAX_S && this.allowed(q.sid)) this.start(q.sid);
  }

  /** Once per frame, after host.sync. */
  update(now, end) {
    this.now = now;
    if (this.current) {
      if (!this.allowed(this.current.sid) || this.current.lang !== this.state.lang) this.stop();
      else if (!this.state.playing && now < end) this.audio.pause(); // at full time the recap finishes
      else if (this.audio.paused && this.state.playing) this.play();
    }
    if (this.queued && !this.allowed(this.queued.sid)) this.queued = null;
    for (const inst of this.host.live.values()) {
      const c = inst.cue, sid = c.story_id;
      if (!sid || this.played.has(sid) || now < c.ts) continue;
      this.played.add(sid);
      if (now - c.ts > START_WINDOW_S || !this.state.playing || !this.allowed(sid)) continue;
      if (this.current) this.queued = { sid, ts: c.ts };
      else this.start(sid);
    }
  }
}
