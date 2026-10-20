// The whole match in 3D on the broadcast page (index.html): the scene of scene3d.js with its rigs,
// on the page's clock, as the main picture (3D) or with the 2D pitch beside it (Split). Babylon and
// the scene load only when a 3D view is asked for; until the scene is ready the 2D pitch stays up.
//
// The rigs plan the ball, the awareness layer and the keepers for a stretch of match time. Here
// that stretch is a window around the clock (WINDOW), planned again when the clock leaves it, so a
// 94-minute match never sits in memory; a seek out of the window costs one plan (0.1 to 0.3 s on
// this server).
//
// After a goal the 3D view shows it again from behind the goal in the dead time before the
// restart: from REPLAY.after s after the goal (when camera 2 leaves the scorer), for REPLAY.len s,
// ending REPLAY.end s after the goal with the ball in the net. Only when the restart comes later
// than that, and only up to 4x (at 16x it would last a third of a second). The page clock, the
// score bug, the 2D pitch and the graphics stay live.
//
// The page falls back to 2D when the scene cannot start, or when it draws fewer than FPS_FLOOR
// frames a second over FPS_WINDOW_S seconds of play (after FPS_GRACE_S for the shaders): 12 fps is
// the "on twos" rate of TV animation, the slowest at which movement still reads as movement, and
// the page clock stops keeping real time under 1 fps (app.js takes a longer gap as a pause). By then
// the SceneOptimizer of scene3d/quality.js has had three of its 2 s steps to lower the quality; it
// holds its steps while the 3D picture is paused, since a paused picture draws no frames to count.
const FPS_FLOOR = 12, FPS_WINDOW_S = 5, FPS_GRACE_S = 3;
const WINDOW = [15, 105];   // match seconds planned behind and ahead of the picture
const REPLAY = { after: 6, len: 5.5, end: 1.6, maxSpeed: 4 };
const BABYLON = ["vendor/babylonjs/9.29.0/babylon.js", "vendor/babylonjs/9.29.0/babylon.glTF2FileLoader.min.js"];
export const VIEWS = ["2d", "3d", "split"];   // "split" is the Radar: one picture large, the other small
// The radar shows the pitch lines and a margin (1420 x 940 stage px around the 1359 x 880 pitch) at
// this scale; view3d.css places it with the same numbers.
export const RADAR = 440 / 1420;

// What the browser offers: WebGL 2, a software renderer (no GPU), a phone (the rule of
// scene3d/quality.js pickProfile).
export function probe() {
  let gl = null;
  try { gl = document.createElement("canvas").getContext("webgl2"); } catch { /* no WebGL */ }
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  return {
    webgl2: !!gl,
    software: /swiftshader|llvmpipe|lavapipe|software/i.test(renderer),
    phone: (matchMedia?.("(pointer: coarse)").matches ?? false) && Math.min(innerWidth, innerHeight) < 820,
  };
}

// 3D on a computer with WebGL 2 and a GPU; a phone, WebGL 1 or a software renderer start in 2D
// (a software renderer draws the scene at 3 to 6 fps on this server).
export const defaultView = (env) => (env.webgl2 && !env.phone && !env.software ? "3d" : "2d");

// The goal replays that fit before the restart: [{from, to, src, end}] in page time; src is the
// match time the replay starts from, end the goal it goes in (-1 at x = 0, 1 at x = 105).
export function replays(match) {
  const ev = [...match.events].sort((a, b) => a.ts - b.ts);
  return match.goals.map((g) => {
    const from = g.ts + REPLAY.after, to = from + REPLAY.len, next = ev.find((e) => e.ts > g.ts + 1);
    if (to > match.duration || (next && next.ts < to + 1)) return null;
    const b = match.at(0, Math.min(g.ts + 0.7, match.duration));   // where the ball is a moment after the shot
    return { from, to, src: g.ts + REPLAY.end - REPLAY.len, end: b && b[0] < 52.5 ? -1 : 1 };
  }).filter(Boolean);
}

// The 3D picture at page time ts: {ts, replay, end?}.
export function viewAt(reps, ts, speed) {
  if (speed <= REPLAY.maxSpeed) for (const r of reps) if (ts >= r.from && ts < r.to) return { ts: r.src + (ts - r.from), replay: true, end: r.end };
  return { ts, replay: false };
}

const script = (src) => new Promise((ok, ko) => {
  const s = document.createElement("script");
  s.src = src;
  s.onload = ok;
  s.onerror = () => ko(new Error(`${src} did not load`));
  document.head.append(s);
});

export class View3D {
  // els: {canvas, pitch (the 2D canvas), stage, radar, badge, notice, status, buttons}; onChange: the page
  // lays itself out again (the shown view or the notice changed); t: the page strings.
  constructor(match, els, onChange, t) {
    Object.assign(this, { match, els, onChange, t });
    this.mode = "2d";          // what the visitor asked for
    this.scene = null;
    this.reps = replays(match);
    this.speed = 1;
    this.last = null;
    this.floor = FPS_FLOOR;    // tests raise it to force the fallback
    this.watch = true;         // off once the visitor picks 3D again after a slow fallback
    this.fps = null;
    this.frames = [];
    this.swapped = false;      // Radar: the 2D pitch large and the 3D picture small
    this.home = els.canvas.parentElement;
    els.radar.addEventListener("click", () => { this.swapped = !this.swapped; this._apply(); });
    document.addEventListener("visibilitychange", () => { this.since = null; });
    for (const b of els.buttons) b.addEventListener("click", () => {
      if (this.slow) this.watch = false;   // the visitor asked for it, slow or not
      this.set(b.dataset.view);
    });
  }

  // The view on screen: the 2D pitch until the scene is ready.
  get shown() { return this.scene ? this.mode : "2d"; }
  // The picture that fills the frame, and that the graphics follow.
  get main() { const v = this.shown; return v === "3d" || (v === "split" && !this.swapped) ? "3d" : "2d"; }

  set(mode) {
    this.mode = VIEWS.includes(mode) ? mode : "2d";
    for (const b of this.els.buttons) b.setAttribute("aria-pressed", String(b.dataset.view === this.mode));
    if (this.notice) this._notice("");
    if (this.mode !== "2d" && !this.scene && !this.loading) {
      this._status(this.t("load3d"));
      this.loading = this._load().then(() => this._status(""), (err) => {
        this._status("");
        console.warn(`3D view: ${err.message}`);
        this.failed = true;
        for (const b of this.els.buttons) if (b.dataset.view !== "2d") b.disabled = true;
        this.set("2d");
        this._notice(this.t("fail3d").replace("{e}", err.message));
      });
    }
    this._apply();
  }

  async _load() {
    if (!window.BABYLON) for (const src of BABYLON) await script(src);
    const [{ Scene3D }, { AwarenessRig }, { KeeperRig }, { loadMotion }] = await Promise.all(
      ["./scene3d.js", "./awareness-rig.js", "./keeper3d-rig.js", "./scene3d/players.js"].map((m) => import(m)));
    // everyone who is on the pitch at some point of the match (an unused substitute is not built)
    const m = this.match, entities = [];
    for (let i = 1; i < m.n; i++) for (let f = 0; f < m.meta.frames; f += 10) if (!Number.isNaN(m.pos[(f * m.n + i) * 3])) { entities.push(i); break; }
    const s = await Scene3D.create(this.els.canvas, m, { entities, span: this._span(this.clock ?? 0) });
    this.els.canvas.tabIndex = -1;   // Babylon makes the canvas a tab stop; nothing in it takes keys
    s.engine.onContextLostObservable.add(() => {
      this.lost = true;
      for (const b of this.els.buttons) if (b.dataset.view !== "2d") b.disabled = true;
      this.set("2d");
      this._notice(this.t("lost3d"));
    });
    await loadMotion(s).catch((e) => console.warn(`motion clips not loaded, procedural poses: ${e.message}`));
    new AwarenessRig(s);
    new KeeperRig(s);
    this.scene = s;
    this.last = null;
    this._apply();
  }

  _span(ts) { return [Math.max(0, ts - WINDOW[0]), Math.min(this.match.duration, ts + WINDOW[1])]; }

  // Puts each picture where the shown view wants it: the 2D pitch in the frame (2D) or hidden (3D);
  // in the Radar the small one goes in the radar box at the bottom of the frame, under the graphics.
  _apply() {
    const v = this.shown, { pitch, stage, canvas, radar } = this.els;
    const small = v !== "split" ? null : this.swapped ? canvas : pitch;
    if (small === pitch) radar.append(pitch); else stage.prepend(pitch);
    if (small === canvas) radar.append(canvas); else this.home.prepend(canvas);
    pitch.hidden = v === "3d";
    radar.hidden = !small;
    radar.classList.toggle("is-3d", small === canvas);
    this.relabel();
    document.body.dataset.shownView = v;
    if (v === "2d") this._badge(false);
    this.last = null;   // draw the next frame whatever the clock does
    this.onChange();
  }

  // The words it shows, in the page language (also when the language changes)
  relabel() {
    const { radar, badge } = this.els;
    radar.setAttribute("aria-label", this.t(radar.classList.contains("is-3d") ? "swap3d" : "swap2d"));
    if (badge.classList.contains("on")) badge.textContent = this.t("replay");
  }

  // The 3D view's own notice; the page's notice (a missing graphic) comes back when it clears.
  _notice(text) {
    const n = this.els.notice;
    if (text && !this.notice) this.prior = n.hidden ? "" : n.textContent;
    this.notice = !!text;
    n.textContent = text || this.prior || "";
    n.hidden = !n.textContent;
    this.onChange();
  }

  // Loading news is polite (role=status); the notice (role=alert) is kept for the lines that say something failed.
  _status(text) {
    this.els.status.textContent = text;
    this.onChange();
  }

  // The replay badge, read out once when it comes on.
  _badge(on) {
    const b = this.els.badge;
    if (b.classList.contains("on") === on) return;
    b.classList.toggle("on", on);
    b.textContent = on ? this.t("replay") : "";
  }

  resize() { if (!this.lost) this.scene?.resize(); this.last = null; }   // a lost context has no textures to rebuild

  // One page frame: draws the 3D picture at page time ts. Called before the graphics are placed.
  frame(ts, speed, seeked, playing) {
    this.clock = ts;
    const s = this.scene;
    // the quality steps wait while the picture is paused, and for 2 s after, while the engine's
    // frame-rate average still holds the pause
    const now = performance.now();
    if (!(playing && this.mode !== "2d")) this.playing = null; else this.playing ??= now;
    if (s) s.held = this.playing == null || now - this.playing < 2000;
    if (!s || this.mode === "2d" || this.lost) return;
    this.speed = speed;
    const v = viewAt(this.reps, Math.min(ts, this.match.duration), speed);
    const [a, b] = s.span, end = this.match.duration;
    if ((v.ts - 5 < a && a > 0) || (v.ts + 5 > b && b < end)) s.replan(this._span(v.ts));
    const l = this.last;
    // a jump (seek, replay cut, or more than the camera spring takes in one step) starts the
    // camera and the turns afresh
    const half = this.match.meta.period1_s;   // the half-time break is a cut, not a second of play
    const jumped = seeked || !l || v.replay !== l.replay || v.ts < l.ts || v.ts - l.ts > 1 || (v.ts > half) !== (l.ts > half);
    // a pause also ends a run of play for the frame-rate watch
    this._watch(playing);
    if (this.mode === "2d") return;
    // paused: nothing new to draw, once the shaders a seek needed have compiled (until then a
    // paused picture would stay without its players) and unless the quality steps resized the
    // canvas, which clears it
    const size = `${s.engine.getRenderWidth()}x${s.engine.getRenderHeight()}`;
    if (!jumped && v.ts === l.ts && this.ready && size === this.size) return;
    this.size = size;
    if (v.replay) s.cams.goalEnd = v.end;
    s.update(v, jumped ? 0 : v.ts - l.ts);
    // before the render, so the frame drawn then is the whole picture; until the post effects
    // compile nothing new is drawn (as sample3d.js __setTime)
    const ready = s.scene.isReady() && (s.scene.activeCamera?._postProcesses ?? []).every((p) => !p || p.isReady());
    s.render();
    this.ready = ready;
    this.last = v;
    this._badge(v.replay);
  }

  // Screen position of a player in the 3D picture, in 1920 x 1080 stage pixels (OGraf locate).
  project(pid, now) {
    const i = this.match.index[pid];
    if (i === undefined || !this.scene) return { x: 0, y: 0, visible: false };
    return this.scene.project(i, viewAt(this.reps, now, this.speed).ts);
  }

  // Frame rate while playing; under the floor for a whole window, back to 2D.
  _watch(playing) {
    const now = performance.now();
    if (!playing) { this.since = null; return; }
    // a new run of play, or back from a hidden tab: start counting again (not on a slow frame:
    // under 1 fps every frame is a long gap)
    if (this.since == null) { this.since = now; this.frames = []; }
    if (now - this.since < FPS_GRACE_S * 1000) return;
    this.frames.push(now);
    // keep one frame older than the window, or at a few fps the window never fills
    while (this.frames.length > 1 && now - this.frames[1] > FPS_WINDOW_S * 1000) this.frames.shift();
    const span = (now - this.frames[0]) / 1000;
    if (span < FPS_WINDOW_S - 0.5) return;
    this.fps = (this.frames.length - 1) / span;
    if (this.watch && this.fps < this.floor) {
      this.watch = false;
      this.slow = true;
      this.set("2d");
      this._notice(this.t("slow3d").replace("{fps}", this.fps.toLocaleString(document.documentElement.lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 })));
    }
  }
}
