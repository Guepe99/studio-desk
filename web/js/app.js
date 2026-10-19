// Studio Desk 2D broadcast page: replay, score bug, controls and the OGraf overlay.
import { loadMatch } from "./match.js";
import { Pitch, STAGE_W, STAGE_H, toStage, textOn } from "./pitch.js";
import { OGrafHost } from "./ograf-host.js";
import { Desk } from "./desk.js";
import { Voice } from "./voice.js";

const GRAPHICS = ["nameplate", "pass_shot", "momentum", "why_card"];
const STRINGS = {
  en: {
    play: "Play", pause: "Pause", seek: "Match time", speed: "Playback speed", half2: "2nd half",
    audience: "Audience", analyst: "Analyst", casual: "Casual fan", language: "Language",
    p1: "1H", p2: "2H", loading: "Loading match", error: "Could not load match {m}. {e}",
    minute: "Minute {n}, {p}", h1: "first half", h2: "second half", goal: "Goal",
    nographic: "Some graphics could not load: {g}.",
  },
};

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const matchId = (params.get("match") || "M001").replace(/[^A-Za-z0-9_-]/g, "");
const state = { ts: 0, playing: false, speed: 1, audience: "analyst", lang: "en", seeked: true };
const t = (key) => (STRINGS[state.lang] ?? STRINGS.en)[key] ?? STRINGS.en[key];

const frame = $("#frame"), stage = $("#stage"), controls = $("#controls"), deck = $("#deck");
const pitch = new Pitch($("#pitch"));
let match = null, host = null, desk = null, voice = null, end = 0;
// Phone in portrait: the pitch is too small for 1920-wide graphics, so they go to the deck below it.
let portrait = false, scale = 1;

function layout() {
  // controls wrap: size them first, then give the frame the height that is left
  // the docked desk (wide screens) takes its width from #app; the drawer (narrow) floats over it
  const W = $("#app").clientWidth || window.innerWidth;
  const cw = Math.min(W - 32, 860);
  controls.style.width = `${cw}px`;
  const ch = controls.offsetHeight + 24;
  const w = Math.max(160, W - 32), h = Math.max(90, window.innerHeight - ch);
  const s = Math.min(w / STAGE_W, h / STAGE_H);
  frame.style.width = `${Math.round(STAGE_W * s)}px`;
  frame.style.height = `${Math.round(STAGE_H * s)}px`;
  stage.style.transform = `scale(${s})`;
  controls.style.width = `${Math.max(Math.round(STAGE_W * s), cw)}px`;
  pitch.resize(s * Math.min(window.devicePixelRatio || 1, 2));
  scale = s;
  portrait = window.innerHeight > W;
  document.body.classList.toggle("portrait", portrait);
  if (portrait) {
    deck.style.width = frame.style.width;
    deck.style.height = `${Math.max(0, window.innerHeight - Math.round(STAGE_H * s) - controls.offsetHeight - 36)}px`;
  }
  state.seeked = true; // graphics are rebuilt for the new size
}

function applyStrings() {
  // the page chrome is English; the graphics and story texts carry the chosen language
  for (const el of [$("#overlay"), deck]) el.lang = state.lang;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  $("#play").setAttribute("aria-label", t(state.playing ? "pause" : "play"));
}

function setPlaying(on) {
  if (on && state.ts >= end) seek(0);
  state.playing = on;
  $("#play").classList.toggle("playing", on);
  $("#play").setAttribute("aria-label", t(on ? "pause" : "play"));
}

function seek(ts) {
  state.ts = Math.min(Math.max(ts, 0), end);
  state.seeked = true;
  voice?.reset();
}

function pressed(group, attr, value) {
  for (const b of document.querySelectorAll(`[${attr}]`)) b.setAttribute("aria-pressed", String(b.getAttribute(attr) === String(value)));
}

function cueSheet() {
  return desk.sheet(match.cues, state.audience, state.lang);
}

function refreshCues() {
  host.setCues(cueSheet(), state.ts);
}

let lastBug = "";
function drawScorebug() {
  const c = match.clock(state.ts), [h, a] = match.score(state.ts);
  const key = `${c.minute}|${c.period}|${h}|${a}|${state.lang}`;
  if (key === lastBug) return;
  lastBug = key;
  $(".sb-home .sb-name").textContent = match.home.short_name;
  $(".sb-away .sb-name").textContent = match.away.short_name;
  $(".sb-home .sb-chip").style.background = match.home.color_primary;
  $(".sb-away .sb-chip").style.background = match.away.color_primary;
  $(".sb-h").textContent = h;
  $(".sb-a").textContent = a;
  $(".sb-min").textContent = `${c.minute}'`;
  $(".sb-period").textContent = t(c.period === 1 ? "p1" : "p2");
  $("#time").textContent = `${c.minute}'`;
  $("#seek-range").setAttribute("aria-valuetext", t("minute").replace("{n}", c.minute).replace("{p}", t(c.period === 1 ? "h1" : "h2")));
}

function buildSeekMarks() {
  const marks = $("#seek-marks"), pct = (ts) => `${(ts / end) * 100}%`;
  const step = match.duration < 20 * 60 ? 60 : 300;
  let html = '<div class="fill"></div>';
  for (const [p0, len] of [[0, match.meta.period1_s], [match.meta.period1_s, match.meta.period2_s]]) {
    for (let s = 0; s <= len; s += step) {
      const major = s % 900 === 0;
      html += `<div class="tick${major ? " major" : ""}" style="left:${pct(p0 + s)}"></div>`;
    }
  }
  html += `<div class="half" style="left:${pct(match.meta.period1_s)}"></div>`;
  marks.innerHTML = html;
  // team data goes through the DOM, never into markup; a goal of an unknown team gets no colour
  for (const f of match.goals) {
    const g = document.createElement("div");
    g.className = "goal";
    g.title = t("goal");
    g.style.left = pct(f.ts);
    g.style.background = match.teams[f.team_id]?.color_primary ?? "";
    marks.append(g);
  }
  const range = $("#seek-range");
  range.max = String(end);
}

let lastFrame = null;
function tick(now) {
  const dt = lastFrame === null ? 0 : Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (state.playing) {
    state.ts += dt * state.speed;
    if (state.ts >= end) { state.ts = end; setPlaying(false); }
  }
  // past the last tracking frame (full-time recap) the picture holds the last frame
  pitch.draw(match, Math.min(state.ts, match.duration));
  drawScorebug();
  host.sync(state.ts, state.seeked, state.speed);
  voice?.update(state.ts, end); // null until its clips are checked
  state.seeked = false;
  const range = $("#seek-range");
  if (document.activeElement !== range || state.playing) range.value = String(state.ts);
  $("#seek-marks .fill").style.width = `${(state.ts / end) * 100}%`;
  requestAnimationFrame(tick);
}

function wireControls() {
  $("#play").addEventListener("click", () => setPlaying(!state.playing));
  for (const b of document.querySelectorAll("[data-speed]")) {
    b.addEventListener("click", () => { state.speed = Number(b.dataset.speed); pressed("speed", "data-speed", state.speed); });
  }
  for (const b of document.querySelectorAll("[data-audience]")) {
    b.addEventListener("click", () => {
      state.audience = b.dataset.audience;
      pressed("audience", "data-audience", state.audience);
      refreshCues();
    });
  }
  $("#half2").addEventListener("click", () => seek(match.meta.period1_s));
  $("#seek-range").addEventListener("input", (e) => seek(Number(e.target.value)));
  // the range keeps a fine step for dragging; keys move by useful match time instead
  const KEY_STEP = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 60, PageDown: -60 };
  $("#seek-range").addEventListener("keydown", (e) => {
    const d = KEY_STEP[e.key];
    if (d === undefined && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    seek(e.key === "Home" ? 0 : e.key === "End" ? end : state.ts + d);
    e.target.value = String(state.ts);
  });
  $("#lang").addEventListener("change", (e) => { state.lang = e.target.value; applyStrings(); lastBug = ""; refreshCues(); desk.render(); });
  $("#desk-open").addEventListener("click", () => {
    const open = !document.body.classList.contains("desk-open");
    desk.setDrawer(open);
    if (open) $("#desk").querySelector('[role="tab"][aria-selected="true"]')?.focus();
  });
  // widening the window docks the desk: a drawer left open would keep the page inert
  matchMedia("(max-width: 1099px)").addEventListener("change", (e) => { if (!e.matches) desk.setDrawer(false); });
  $("#desk").addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("desk-open") && !e.target.closest("textarea")) desk.closeDrawer();
  });
  // Space toggles play anywhere; keyup is swallowed too so a focused button does not click as well.
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.target.tagName === "SELECT" || e.target.closest?.("#desk")) return;
    e.preventDefault();
    if (!e.repeat) setPlaying(!state.playing);
  }, true);
  window.addEventListener("keyup", (e) => { if (e.code === "Space" && e.target.tagName !== "SELECT" && !e.target.closest?.("#desk")) e.preventDefault(); }, true);
  window.addEventListener("resize", layout);
}

async function main() {
  applyStrings();
  layout();
  $("#status").textContent = t("loading");
  try {
    match = await loadMatch(`data/${matchId}`);
  } catch (err) {
    $("#status").textContent = t("error").replace("{m}", matchId).replace("{e}", err.message);
    return;
  }
  end = Math.max(match.duration, ...match.cues.map((c) => c.ts + c.duration_s));
  const players = Object.fromEntries(match.meta.players.map((p) => {
    const team = match.teams[p.team_id];
    return [p.player_id, { name: p.name, shirt: p.shirt, team_short: team.short_name, team_name: team.name,
      color: team.color_primary, text: textOn(team.color_primary) }];
  }));
  const teams = Object.fromEntries([match.home, match.away].map((tm) => [tm.side, { short: tm.short_name, name: tm.name, color: tm.color_primary }]));
  host = new OGrafHost($("#overlay"), {
    resolution: { width: STAGE_W, height: STAGE_H },
    frameRate: 60,
    locate: (pid, now) => {
      const p = match.index[pid] !== undefined ? match.at(match.index[pid], Math.min(now, match.duration)) : null;
      if (!p) return { x: 0, y: 0, visible: false };
      const [x, y] = toStage(p[0], p[1]);
      return { x, y, visible: true };
    },
    vendorParams: () => ({ v_showFactIds: state.audience === "analyst", v_players: players, v_teams: teams, v_compact: portrait }),
    // the nameplate stays on the pitch, magnified so its smallest type (26 px) is drawn at 11.5 px
    compact: () => (portrait ? { deck, magnify: Math.max(1, 11.5 / (26 * scale)) } : null),
  });
  // a graphic that fails to register is left out (its cues are skipped) and named on screen
  const reg = await Promise.allSettled(GRAPHICS.map((g) => host.register(g, `graphics/${g}/${g}.ograf.json`)));
  const missing = GRAPHICS.filter((g, i) => reg[i].status === "rejected");
  if (missing.length) {
    $("#notice").textContent = t("nographic").replace("{g}", missing.join(", "));
    $("#notice").hidden = false;
    layout();
  }
  // The replay starts now and needs no API: until the stories load, only template graphics play.
  desk = new Desk($("#desk"), { match, matchId, state, seek, onChange: refreshCues });
  desk.render();
  $("#status").textContent = "";
  buildSeekMarks();
  wireControls();
  refreshCues();
  // hooks for tests and the lead's demo scripts
  window.studioDesk = { state, match, host, desk, get voice() { return voice; }, seek, setPlaying, get end() { return end; } };
  requestAnimationFrame(tick);
  await desk.load();
  const v = new Voice({ base: `data/${matchId}`, host, desk, state, button: $("#voice") });
  await Promise.all([v.load().then(() => { voice = v; }), desk.connect()]);
}

main();
