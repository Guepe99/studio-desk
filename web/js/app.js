// Studio Desk 2D broadcast page: replay, score bug, controls and the OGraf overlay.
import { loadMatch } from "./match.js";
import { Pitch, STAGE_W, STAGE_H, toStage, textOn } from "./pitch.js";
import { OGrafHost } from "./ograf-host.js";
import { Desk } from "./desk.js";
import { Voice } from "./voice.js";
import { View3D, probe, defaultView, RADAR } from "./view3d.js";
import { Ask } from "./ask.js";
import { Moments } from "./moments.js";
import { Activity } from "./activity.js";

const GRAPHICS = ["nameplate", "pass_shot", "momentum", "why_card"];
const STRINGS = {
  en: {
    play: "Play", pause: "Pause", seek: "Match time", speed: "Playback speed", half2: "2nd half",
    audience: "Audience", analyst: "Analyst", casual: "Casual fan", language: "Language",
    p1: "1H", p2: "2H", loading: "Loading match", error: "Could not load match {m}. {e}",
    minute: "Minute {n}, {p}", h1: "first half", h2: "second half", goal: "Goal",
    nographic: "Some graphics could not load: {g}.",
    myteam: "My team", player: "Player", pickteam: "Choose the team", pickplayer: "Choose the player",
    ask: "Ask the studio", close: "Close", askLabel: "Your question about the match so far", askSend: "Ask",
    askHint: "Answers use only the match data up to the replay time.", askWait: "The studio is checking the match data.",
    askYou: "You asked", askLeft: "Questions left today: {n}", askFacts: "Facts",
    askLimit: "No more questions for now: the limit is reached. Try again tomorrow.",
    askOff: "Questions are not available on this site.", askNet: "The studio could not be reached. Check the connection and try again.",
    askBad: "The studio could not take that question. Try a shorter one about this match.",
    next: "Next key moment", nonext: "No more key moments",
    nokey: "No key moments", actTitle: "Agents at work", actWait: "No agent hand-offs yet at this point of the match",
    actNone: "No agent traces in this replay", actSum: "Hand-offs so far: {n}, {tokens} tokens, {usd}",
    actMade: "How the graphic on air was made: {n} hand-offs, {tokens} tokens, {usd}", actTok: "{n} tok",
    actRules: "rules, no model", actCode: "code, no model",
  },
  // the controls, Ask and the agent strip are translated; every other key falls back to English
  it: {
    audience: "Pubblico", analyst: "Analista", casual: "Spettatore", myteam: "La mia squadra", player: "Giocatore",
    pickteam: "Scegli la squadra", pickplayer: "Scegli il giocatore",
    ask: "Chiedi allo studio", close: "Chiudi", askLabel: "La tua domanda sulla partita fin qui", askSend: "Chiedi",
    askHint: "Le risposte usano solo i dati della partita fino al momento del replay.", askWait: "Lo studio sta controllando i dati della partita.",
    askYou: "Hai chiesto", askLeft: "Domande rimaste oggi: {n}", askFacts: "Fatti",
    askLimit: "Per ora non si possono fare altre domande: il limite è raggiunto. Riprova domani.",
    askOff: "Le domande non sono disponibili su questo sito.", askNet: "Lo studio non risponde. Controlla la connessione e riprova.",
    askBad: "Lo studio non può prendere questa domanda. Provane una più breve su questa partita.",
    next: "Prossimo momento chiave", nonext: "Nessun altro momento chiave",
    nokey: "Nessun momento chiave", actTitle: "Gli agenti al lavoro",
    actWait: "Ancora nessun passaggio di consegne tra gli agenti a questo punto della partita",
    actNone: "Nessuna traccia degli agenti in questo replay", actSum: "Passaggi di consegne finora: {n}, {tokens} token, {usd}",
    actMade: "Come è nata la grafica in onda: {n} passaggi di consegne, {tokens} token, {usd}",
    actRules: "solo regole", actCode: "solo codice",
    ag_story_finder: "Cerca storie", ag_analyst: "Analista", ag_commentator: "Commentatore", ag_verifier: "Verificatore", ag_director: "Regista",
  },
  es: {
    audience: "Público", analyst: "Analista", casual: "Espectador", myteam: "Mi equipo", player: "Jugador",
    pickteam: "Elige el equipo", pickplayer: "Elige el jugador",
    ask: "Pregunta al estudio", close: "Cerrar", askLabel: "Tu pregunta sobre el partido hasta ahora", askSend: "Preguntar",
    askHint: "Las respuestas usan solo los datos del partido hasta el momento de la repetición.", askWait: "El estudio está revisando los datos del partido.",
    askYou: "Preguntaste", askLeft: "Preguntas restantes hoy: {n}", askFacts: "Hechos",
    askLimit: "Por ahora no se pueden hacer más preguntas: se alcanzó el límite. Inténtalo mañana.",
    askOff: "Las preguntas no están disponibles en este sitio.", askNet: "No se pudo contactar con el estudio. Revisa la conexión e inténtalo de nuevo.",
    askBad: "El estudio no puede aceptar esa pregunta. Prueba con una más corta sobre este partido.",
    next: "Siguiente momento clave", nonext: "No hay más momentos clave",
    nokey: "No hay momentos clave", actTitle: "Los agentes en acción",
    actWait: "Todavía no hay relevos entre los agentes en este punto del partido",
    actNone: "No hay trazas de los agentes en esta repetición", actSum: "Relevos hasta ahora: {n}, {tokens} tokens, {usd}",
    actMade: "Cómo se hizo el gráfico en pantalla: {n} relevos, {tokens} tokens, {usd}",
    actRules: "reglas, sin modelo", actCode: "código, sin modelo",
    ag_story_finder: "Buscahistorias", ag_analyst: "Analista", ag_commentator: "Comentarista", ag_verifier: "Verificador", ag_director: "Realizador",
  },
};

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const matchId = (params.get("match") || "M001").replace(/[^A-Za-z0-9_-]/g, "");
const state = { ts: 0, playing: false, speed: 1, audience: "analyst", lang: "en", seeked: true };
const t = (key) => (STRINGS[state.lang] ?? STRINGS.en)[key] ?? STRINGS.en[key];

const frame = $("#frame"), stage = $("#stage"), controls = $("#controls"), deck = $("#deck"), strip = $("#activity");
const pitch = new Pitch($("#pitch"));
let match = null, host = null, desk = null, voice = null, ask = null, end = 0, moments = null, activity = null;
let view3d = null;   // the 3D views (view3d.js), once the match is loaded
// Phone in portrait: the pitch is too small for 1920-wide graphics, so they go to the deck below it.
let portrait = false, scale = 1;

function layout() {
  // controls wrap: size them first, then give the frame the height that is left
  // the docked desk (wide screens) takes its width from #app; the drawer (narrow) floats over it
  const W = $("#app").clientWidth || window.innerWidth;
  const cw = Math.min(W - 32, 860);
  controls.style.width = `${cw}px`;
  const ch = controls.offsetHeight + strip.offsetHeight + 36; // #app: 16 px of padding and 2 gaps of 10 between 3 boxes
  const w = Math.max(160, W - 32), h = Math.max(90, window.innerHeight - ch);
  const s = Math.min(w / STAGE_W, h / STAGE_H);
  frame.style.width = `${Math.round(STAGE_W * s)}px`;
  frame.style.height = `${Math.round(STAGE_H * s)}px`;
  stage.style.transform = `scale(${s})`;
  controls.style.width = `${Math.max(Math.round(STAGE_W * s), cw)}px`;
  strip.style.width = frame.style.width;
  // in the radar the 2D pitch is drawn at RADAR of the stage
  pitch.resize(s * (view3d?.shown === "split" && view3d.main === "3d" ? RADAR : 1) * Math.min(window.devicePixelRatio || 1, 2));
  view3d?.resize();
  scale = s;
  portrait = window.innerHeight > W;
  document.body.classList.toggle("portrait", portrait);
  if (portrait) {
    deck.style.width = frame.style.width;
    deck.style.height = `${Math.max(0, window.innerHeight - Math.round(STAGE_H * s) - controls.offsetHeight - strip.offsetHeight - 46)}px`;
  }
  state.seeked = true; // graphics are rebuilt for the new size
  laidOut = `${controls.offsetHeight}|${strip.offsetHeight}`;
}
// a new label, a late font or the strip's narrow layout changes a height: the frame gets what is left
let laidOut = "";
const relayout = new ResizeObserver(() => { if (`${controls.offsetHeight}|${strip.offsetHeight}` !== laidOut) layout(); });
relayout.observe(controls);
relayout.observe(strip);

function applyStrings() {
  // the page chrome is English; the graphics and story texts carry the chosen language
  for (const el of [$("#overlay"), deck]) el.lang = state.lang;
  // the audience control is translated, so a screen reader reads it in the chosen language
  for (const el of [$('[data-i18n-aria="audience"]'), $("#audience-pick")]) el.lang = state.lang;
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

function setSpeed(x) {
  state.speed = x;
  pressed("data-speed", x);
}

function seek(ts) {
  state.ts = Math.min(Math.max(ts, 0), end);
  state.seeked = true;
  voice?.reset();
}

function pressed(attr, value) {
  for (const b of document.querySelectorAll(`[${attr}]`)) b.setAttribute("aria-pressed", String(b.getAttribute(attr) === String(value)));
}

function cueSheet() {
  return desk.sheet(match.cues, state.audience, state.lang);
}

function refreshCues() {
  const sheet = cueSheet();
  host.setCues(sheet, state.ts);
  moments.setSheet(sheet, desk.loaded);
  ask?.render();
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

// the story of the latest story graphic on air (a tie goes to the later cue), or null
function onAirStory() {
  let best = null;
  for (const { cue } of host.live.values()) {
    if (cue.story_id && (!best || cue.ts > best.ts || (cue.ts === best.ts && cue.cue_id > best.cue_id))) best = cue;
  }
  return best?.story_id ?? null;
}

let lastFrame = null;
function tick(now) {
  // a stall of the page (a 3D replan) keeps the clock in real time; a gap over 1 s is a hidden tab
  const gap = lastFrame === null ? 0 : (now - lastFrame) / 1000, dt = gap > 1 ? 0.1 : gap;
  lastFrame = now;
  if (state.playing) {
    state.ts += dt * state.speed;
    if (state.ts >= end) { state.ts = end; setPlaying(false); }
  }
  // past the last tracking frame (full-time recap) the picture holds the last frame
  if (view3d?.shown !== "3d") pitch.draw(match, Math.min(state.ts, match.duration));
  view3d?.frame(state.ts, state.speed, state.seeked, state.playing);
  drawScorebug();
  host.sync(state.ts, state.seeked, state.speed);
  // the radar steps aside while a graphic that is not pinned to a player is on the frame
  document.body.classList.toggle("radar-yield", !portrait && [...host.live.values()].some((i) => !i.positioned));
  voice?.update(state.ts, end); // null until its clips are checked
  moments.update(state.ts);
  activity.update(state.ts, state.seeked, onAirStory(), state.lang);
  state.seeked = false;
  const range = $("#seek-range");
  if (document.activeElement !== range || state.playing) range.value = String(state.ts);
  $("#seek-marks .fill").style.width = `${(state.ts / end) * 100}%`;
  requestAnimationFrame(tick);
}

function wireControls() {
  $("#play").addEventListener("click", () => setPlaying(!state.playing));
  for (const b of document.querySelectorAll("[data-speed]")) {
    b.addEventListener("click", () => setSpeed(Number(b.dataset.speed)));
  }
  // "team" and "player" need a pick: the select lists the ones the cue sheet has cues for
  const first = {}, last = {}; // audience -> its first cue: the picker says when a late substitute first appears
  for (const c of match.cues) first[c.audience] = Math.min(first[c.audience] ?? Infinity, c.ts);
  const auds = new Set(Object.keys(first));
  const choices = {
    team: [match.home, match.away].filter((tm) => auds.has(`team:${tm.team_id}`)).map((tm) => [`team:${tm.team_id}`, tm.name]),
    player: match.meta.players.filter((p) => auds.has(`player:${p.player_id}`))
      .map((p) => [`player:${p.player_id}`,
        `${p.name} (${match.teams[p.team_id]?.short_name ?? ""} ${p.shirt}), ${match.clock(first[`player:${p.player_id}`]).minute}'`]),
  };
  const pick = $("#audience-pick");
  const setAudience = (aud) => {
    const kind = aud.split(":")[0], list = choices[kind];
    state.audience = aud;
    pressed("data-audience", kind);
    if (list) {
      last[kind] = aud;
      const key = kind === "team" ? "pickteam" : "pickplayer";
      if (pick.dataset.i18nAria !== key || !pick.options.length) {
        // names come from the data: Option sets them as text, never as markup
        pick.replaceChildren(...list.map(([v, label]) => new Option(label, v)));
        pick.dataset.i18nAria = key;
        pick.setAttribute("aria-label", t(key));
      }
      pick.value = aud;
    }
    if (pick.hidden !== !list) { pick.hidden = !list; layout(); } // the controls may wrap differently
    refreshCues();
  };
  for (const b of document.querySelectorAll("[data-audience]")) {
    const list = choices[b.dataset.audience];
    if (list) b.hidden = !list.length;
    b.addEventListener("click", () => setAudience(list ? last[b.dataset.audience] ?? list[0][0] : b.dataset.audience));
  }
  pick.addEventListener("change", () => setAudience(pick.value));
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
  // Space toggles play with focus in the broadcast or its controls (a single-key shortcut scoped to them,
  // WCAG 2.1.4); keyup is swallowed too so a focused button does not click as well.
  const spaceKey = (e) => e.code === "Space" && e.target.tagName !== "SELECT" && !!e.target.closest?.("#frame, #controls");
  window.addEventListener("keydown", (e) => {
    if (!spaceKey(e)) return;
    e.preventDefault();
    if (!e.repeat) setPlaying(!state.playing);
  }, true);
  window.addEventListener("keyup", (e) => { if (spaceKey(e)) e.preventDefault(); }, true);
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
      if (view3d?.main === "3d") return view3d.project(pid, now);
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
  moments = new Moments($("#next-moment"), { state, seek, setSpeed, t, live: $("#moments-live") });
  activity = new Activity(strip, desk, t);
  $("#status").textContent = "";
  buildSeekMarks();
  wireControls();
  layout(); // the team and player buttons may have changed the controls' height
  ask = new Ask($("#ask"), { matchId, state, t, button: $("#ask-open"), controls, maxTs: match.duration, onLayout: layout });
  refreshCues();
  // hooks for tests and the lead's demo scripts
  window.studioDesk = { state, match, host, desk, get voice() { return voice; }, seek, setPlaying, get end() { return end; } };
  // 2D, 3D or Radar (?view=split): ?view= or what the device can draw; any change of view re-lays the page
  view3d = new View3D(match, { canvas: $("#view3d"), pitch: $("#pitch"), stage, radar: $("#radar"), badge: $("#replay-badge"),
    notice: $("#notice"), buttons: document.querySelectorAll("[data-view]") }, layout);
  view3d.set(params.get("view") ?? defaultView(probe()));
  window.studioDesk.view3d = view3d;
  // the shortcuts (Space, N) work at once; a visitor who already moved the focus keeps it
  if (document.activeElement === document.body) frame.focus();
  requestAnimationFrame(tick);
  await desk.load();
  const v = new Voice({ base: `data/${matchId}`, host, desk, state, button: $("#voice") });
  await Promise.all([v.load().then(() => { voice = v; }), desk.connect(), ask.probe()]); // the voice and Ask buttons may appear
}

main();
