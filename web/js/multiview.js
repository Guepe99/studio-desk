// The producer's multiviewer (web/multiview.html): four same-origin windows of the broadcast page, one
// audience and language each, driven by one master transport. Each window is index.html with its URL
// parameters; this page only reads and drives window.studioDesk in each (app.js) and hides the page's own
// controls with a style element of its own. Broadcast conventions: a name strip (UMD) under each picture,
// a tally border on the window whose sound is live, and an audio meter on it.
import { WINDOWS, windowUrl, lagging, drift, umdLabel } from "./multiview-logic.js";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const match = (params.get("match") || "M001").replace(/[^A-Za-z0-9_-]/g, "");
const start = Number.isFinite(Number(params.get("t"))) && params.has("t") ? Number(params.get("t")) : 590;
// each window draws at this size, scaled to its cell: the broadcast page lays out its compact graphics for it
const VW = 960, VH = 540;
// inside a window only the picture and its graphics: no masthead, controls, agent strip or desk
const PICTURE_ONLY = `
  #masthead, #controls, #activity, #deck, #ask, #audiences, #proof, #desk, #radar, #keys { display: none !important; }
  #app { padding: 0 !important; gap: 0 !important; min-height: 0 !important; }
  html, body { overflow: hidden !important; background: #000 !important; }
  #frame { border-radius: 0 !important; box-shadow: none !important; outline: none !important; }`;

const wall = $("#mv-wall"), playBtn = $("#mv-play");
let playing = false, live = -1, goalsBuilt = false;
const meters = new WeakMap();   // AudioContext -> {an, buf}

const wins = WINDOWS.map((w, i) => {
  const fig = document.createElement("figure");
  fig.className = "mv-win";
  fig.innerHTML = `<div class="mv-pic"><iframe tabindex="-1" inert allow="autoplay"></iframe><button class="mv-hit" type="button" aria-pressed="false"></button></div>
    <figcaption class="mv-umd"><span class="mv-src">${i + 1}</span><span class="mv-name"></span><span class="mv-meter" aria-hidden="true"><i></i></span><span class="mv-live">Audio</span></figcaption>`;
  const frame = fig.querySelector("iframe"), hit = fig.querySelector(".mv-hit");
  frame.addEventListener("load", () => {
    const doc = frame.contentDocument, style = doc.createElement("style");
    style.textContent = PICTURE_ONLY;
    doc.head.append(style);
    frame.contentWindow.dispatchEvent(new Event("resize"));   // app.js lays the frame out again without the hidden rows
  });
  // the click is a user gesture in this page; same-origin windows share it, so their audio may start in it
  hit.addEventListener("click", () => listen(i));   // and the window grows, the others shrink beside it (fit)
  wall.append(fig);
  return { ...w, fig, frame, hit, name: fig.querySelector(".mv-name"), bar: fig.querySelector(".mv-meter i") };
});
const sd = (w) => w.frame.contentWindow?.studioDesk;

// One window at a time: the four share the 25 MB tracking file, and when all four ask for it at once Chromium
// fails the copies it is still caching (ERR_CACHE_WRITE_FAILURE). The next window opens when this one has its
// match, so it reads the file from the cache, or after 20 s whatever happened.
function open(k) {
  const w = wins[k];
  if (!w) return;
  w.frame.src = windowUrl({ match, t: start, audience: w.audience, lang: w.lang });
  const t0 = performance.now();
  const wait = setInterval(() => {
    if (sd(w)?.match || performance.now() - t0 > 20000) { clearInterval(wait); open(k + 1); }
  }, 200);
}
open(0);

function label(w) {
  const teams = Object.fromEntries(Object.entries(sd(w)?.match?.teams ?? {}).map(([id, t]) => [id, t.name]));
  const text = umdLabel(w, teams);
  w.name.textContent = text;
  w.frame.title = text;
  w.hit.setAttribute("aria-label", `Listen to ${text}`);
}
wins.forEach(label);

// The window's sound: the studio voice and the booth with its crowd follow the page's Voice button
// (voice.js, booth-audio.js); set here directly, so the visitor's remembered choice is left as it was.
function sound(w, on) {
  const d = sd(w), v = d?.voice;
  if (!v || v.on === on) return;
  v.on = on;
  if (on) { if (!v.current) v.unlock(); d.booth?.unlock(); } else v.stop();
  v.render();
}

function listen(i) {
  live = live === i ? -1 : i;   // the live window clicked again: all quiet
  wins.forEach((w, j) => {
    sound(w, j === live);
    w.fig.classList.toggle("tally", j === live);
    w.hit.setAttribute("aria-pressed", String(j === live));
  });
  fit();
}

function setPlaying(on) {
  playing = on;
  playBtn.classList.toggle("playing", on);
  playBtn.setAttribute("aria-label", on ? "Pause all" : "Play all");
  for (const w of wins) sd(w)?.setPlaying(on);
}
playBtn.addEventListener("click", () => setPlaying(!playing));
$("#mv-single").addEventListener("click", (e) => {
  const d = live >= 0 ? sd(wins[live]) : sd(wins[0]);
  e.currentTarget.href = `index.html?match=${match}&t=${Math.floor(d?.state.ts ?? start)}${playing ? "&play=1" : ""}`;
});
document.addEventListener("keydown", (e) => {
  if ((e.key === " " || e.key === "k") && !e.target.closest("button")) { e.preventDefault(); setPlaying(!playing); }
});

// one button per goal, copied from the first window's own goal buttons (team code and minute on its colour);
// a press clicks the same button in every window, so each lands where the broadcast page lands
function buildGoals(d) {
  const src = [...d.document.querySelectorAll("#goals button")];
  if (!src.length) return;
  goalsBuilt = true;
  $("#mv-goals").replaceChildren(...src.map((b) => {
    const c = b.cloneNode(true);
    c.hidden = false;
    c.tabIndex = 0;
    c.addEventListener("click", () => {
      for (const w of wins) w.frame.contentDocument?.querySelector(`#goals button[data-ts="${CSS.escape(b.dataset.ts)}"]`)?.click();
    });
    return c;
  }));
}

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;

// Every frame: the reference clock is the live window (its sound is never cut by a correction), else the
// first loaded one; every other window further than DRIFT_S from it is seeked to it.
function tick() {
  requestAnimationFrame(tick);
  const ready = wins.filter((w) => sd(w)?.match);
  if (!ready.length) return;
  const ref = ready.includes(wins[live]) ? wins[live] : ready[0], r = sd(ref);
  if (!goalsBuilt) buildGoals(ref.frame.contentWindow);
  for (const w of ready) if (!w.named) { w.named = true; label(w); }   // a team by its name once its match is in
  // the broadcast page focuses its picture when it loads: the keyboard belongs to this page
  if (document.activeElement instanceof HTMLIFrameElement) document.activeElement.blur();
  if (playing && r.state.ts >= r.end) setPlaying(false);
  const times = wins.map((w) => sd(w)?.match ? sd(w).state.ts : null);
  for (const i of lagging(times, r.state.ts)) sd(wins[i]).seek(r.state.ts);
  wins.forEach((w, j) => {
    const d = sd(w);
    if (!d?.match) return;
    if (d.state.playing !== playing) d.setPlaying(playing);
    if (d.voice && d.voice.on !== (j === live)) sound(w, j === live);   // a voice that loaded after the click
  });
  const c = r.match.clock(Math.min(r.state.ts, r.match.duration));
  $("#mv-clock").textContent = `${c.label}' ${c.period === 1 ? "1H" : "2H"}  ${fmt(r.state.ts)}`;
  $("#mv-sync").textContent = `Sync ±${drift(times, r.state.ts).toFixed(2)} s`;
  meter();
}

// the live window's level, from its booth's mix (the crowd and the commentators), in dBFS from -60 to 0
function meter() {
  for (const w of wins) w.bar.style.transform = "scaleY(0)";
  const b = live >= 0 ? sd(wins[live])?.booth : null;
  if (!b?.ctx || b.ctx.state !== "running") return;
  if (!meters.has(b.ctx)) {
    const an = b.ctx.createAnalyser();
    an.fftSize = 1024;
    b.voiceBus.connect(an);
    b.duck.connect(an);
    meters.set(b.ctx, { an, buf: new Float32Array(an.fftSize) });
  }
  const { an, buf } = meters.get(b.ctx);
  an.getFloatTimeDomainData(buf);
  const rms = Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
  const db = 20 * Math.log10(rms || 1e-6);
  wins[live].bar.style.transform = `scaleY(${Math.max(0, Math.min(1, (db + 60) / 60)).toFixed(3)})`;
}

// the cells: 16:9 pictures as large as the wall allows, two by two (one column on a narrow screen); with a
// window live, as in a gallery multiviewer: that one large on the left, the other three small beside it
const ONE_COL = matchMedia("(max-width: 899px), (orientation: portrait)");
function size(w, pw) {
  // a large window draws at full size, so it gets the page's full graphics; a small one at VW x VH
  const vw = pw > 1.25 * VW ? 2 * VW : VW;
  w.fig.style.setProperty("--pw", `${pw}px`);
  w.fig.style.setProperty("--k", String(pw / vw));
  Object.assign(w.frame.style, { width: `${vw}px`, height: `${vw * VH / VW}px` });
}
function fit() {
  const cols = ONE_COL.matches ? 1 : 2, gap = 12, umd = 30;
  const cs = getComputedStyle(wall);
  const W = wall.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const H = wall.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 8;   // 8: the tally outline, 4 px a side
  const focus = cols === 2 && live >= 0;
  wall.classList.toggle("one-col", cols === 1);
  wall.classList.toggle("focus", focus);
  wins.forEach((w, j) => w.fig.classList.toggle("big", focus && j === live));
  if (focus) {
    const small = Math.floor(Math.max(160, Math.min(W * 0.3, ((H - 2 * gap) / 3 - umd) * 16 / 9)));
    const big = Math.floor(Math.max(160, Math.min(W - gap - small, (H - umd) * 16 / 9)));
    wins.forEach((w, j) => size(w, j === live ? big : small));
    return;
  }
  let pw = (W - gap * (cols - 1)) / cols;
  if (cols === 2) pw = Math.min(pw, ((H - gap) / 2 - umd) * 16 / 9);
  pw = Math.floor(Math.max(160, pw));
  wins.forEach((w) => size(w, pw));
}
new ResizeObserver(fit).observe(wall);
ONE_COL.addEventListener("change", fit);
fit();
requestAnimationFrame(tick);
// for tests: the windows and the master state
window.multiview = { wins, sd, listen, setPlaying, get live() { return live; }, get playing() { return playing; } };
