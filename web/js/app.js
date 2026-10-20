// Studio Desk 2D broadcast page: replay, score bug, controls and the OGraf overlay.
import { loadMatch } from "./match.js";
import { Pitch, STAGE_W, STAGE_H, toStage, textOn } from "./pitch.js";
import { OGrafHost } from "./ograf-host.js";
import { Desk } from "./desk.js";
import { Voice } from "./voice.js";
import { View3D, probe, defaultView, RADAR } from "./view3d.js";
import { Ask } from "./ask.js";
import { Moments, LEAD_S } from "./moments.js";
import { Activity } from "./activity.js";
import { shortcut } from "./keys.js";

const GRAPHICS = ["nameplate", "pass_shot", "momentum", "why_card"];
const STRINGS = {
  en: {
    play: "Play", pause: "Pause", seek: "Match time", speed: "Playback speed", half2: "2nd half",
    audience: "Audience", analyst: "Analyst", casual: "Casual fan", language: "Language",
    p1: "1H", p2: "2H", loading: "Loading match", error: "Could not load match {m}. {e}",
    minute: "Minute {n}, {p}, {home} {h}, {away} {a}", h1: "first half", h2: "second half",
    nographic: "Some graphics could not load: {g}.",
    myteam: "My team", player: "Player", pickteam: "Choose the team", pickplayer: "Choose the player",
    ask: "Ask the studio", close: "Close", askLabel: "Your question about the match so far", askSend: "Ask",
    askHint: "Answers use only the match data up to the replay time.", askWait: "The studio is checking the match data.",
    askYou: "You asked", askLeft: "Questions left today: {n}", askFacts: "Facts",
    askLimit: "No more questions for now: the limit has been reached. Try again tomorrow.",
    askPaused: "Questions are paused for now: the safety check has reached its limit. Try again later.",
    askOff: "Questions are not available on this site.", askNet: "The studio could not be reached. Check the connection and try again.",
    askBad: "The studio could not take that question. Try a shorter one about this match.",
    askErr: "The studio had a problem. Try again in a minute.",
    next: "Next key moment", nonext: "No more key moments",
    nokey: "No key moments", actTitle: "Agents at work", actWait: "No agent hand-offs yet at this point of the match",
    actNone: "No agent traces in this replay", actSum: "Hand-offs so far: {n}, {tokens} tokens, {usd}",
    actMade: "How the graphic on air was made: {n} hand-offs, {tokens} tokens, {usd}",
    actRules: "rules, no model", actCode: "code, no model",
    aioff: "AI off", view: "View", broadcast: "Match broadcast", activity: "Agent activity",
  },
  // every key in every language: a missing one would fall back to English
  it: {
    play: "Riproduci", pause: "Pausa", seek: "Tempo di gioco", speed: "Velocità di riproduzione", half2: "2° tempo",
    language: "Lingua", p1: "1°T", p2: "2°T", loading: "Caricamento della partita", error: "Impossibile caricare la partita {m}. {e}",
    minute: "Minuto {n}, {p}, {home} {h}, {away} {a}", h1: "primo tempo", h2: "secondo tempo",
    nographic: "Alcune grafiche non si sono caricate: {g}.",
    aioff: "IA spenta", view: "Vista", broadcast: "Diretta della partita", activity: "Attività degli agenti",
    audience: "Pubblico", analyst: "Analista", casual: "Spettatore", myteam: "La mia squadra", player: "Giocatore",
    pickteam: "Scegli la squadra", pickplayer: "Scegli il giocatore",
    ask: "Chiedi allo studio", close: "Chiudi", askLabel: "La tua domanda sulla partita fin qui", askSend: "Chiedi",
    askHint: "Le risposte usano solo i dati della partita fino al momento del replay.", askWait: "Lo studio sta controllando i dati della partita.",
    askYou: "Hai chiesto", askLeft: "Domande rimaste oggi: {n}", askFacts: "Fatti",
    askLimit: "Per ora non si possono fare altre domande: il limite è stato raggiunto. Riprova domani.",
    askPaused: "Per ora le domande sono sospese: il controllo di sicurezza ha raggiunto il suo limite. Riprova più tardi.",
    askOff: "Le domande non sono disponibili su questo sito.", askNet: "Lo studio non risponde. Controlla la connessione e riprova.",
    askBad: "Lo studio non può accettare questa domanda. Provane una più breve su questa partita.",
    askErr: "Lo studio ha avuto un problema. Riprova tra un minuto.",
    next: "Prossimo momento chiave", nonext: "Nessun altro momento chiave",
    nokey: "Nessun momento chiave", actTitle: "Gli agenti al lavoro",
    actWait: "Ancora nessun passaggio di consegne tra gli agenti a questo punto della partita",
    actNone: "Nessuna traccia degli agenti in questo replay", actSum: "Passaggi di consegne finora: {n}, {tokens} token, {usd}",
    actMade: "Come è nata la grafica in onda: {n} passaggi di consegne, {tokens} token, {usd}",
    actRules: "solo regole", actCode: "solo codice",
  },
  es: {
    play: "Reproducir", pause: "Pausa", seek: "Tiempo de partido", speed: "Velocidad de reproducción", half2: "2.ª parte",
    language: "Idioma", p1: "1T", p2: "2T", loading: "Cargando el partido", error: "No se pudo cargar el partido {m}. {e}",
    minute: "Minuto {n}, {p}, {home} {h}, {away} {a}", h1: "primera parte", h2: "segunda parte",
    nographic: "Algunos gráficos no se pudieron cargar: {g}.",
    aioff: "IA apagada", view: "Vista", broadcast: "Retransmisión del partido", activity: "Actividad de los agentes",
    audience: "Público", analyst: "Analista", casual: "Espectador", myteam: "Mi equipo", player: "Jugador",
    pickteam: "Elige el equipo", pickplayer: "Elige el jugador",
    ask: "Pregunta al estudio", close: "Cerrar", askLabel: "Tu pregunta sobre el partido hasta ahora", askSend: "Preguntar",
    askHint: "Las respuestas usan solo los datos del partido hasta el momento de la repetición.", askWait: "El estudio está revisando los datos del partido.",
    askYou: "Preguntaste", askLeft: "Preguntas restantes hoy: {n}", askFacts: "Datos",
    askLimit: "Por ahora no se pueden hacer más preguntas: se alcanzó el límite. Inténtalo mañana.",
    askPaused: "Por ahora las preguntas están en pausa: el control de seguridad alcanzó su límite. Inténtalo más tarde.",
    askOff: "Las preguntas no están disponibles en este sitio.", askNet: "No se pudo contactar con el estudio. Revisa la conexión e inténtalo de nuevo.",
    askBad: "El estudio no puede aceptar esa pregunta. Prueba con una más corta sobre este partido.",
    askErr: "El estudio tuvo un problema. Inténtalo de nuevo en un minuto.",
    next: "Siguiente momento clave", nonext: "No hay más momentos clave",
    nokey: "No hay momentos clave", actTitle: "Los agentes en acción",
    actWait: "Todavía no hay relevos entre los agentes en este punto del partido",
    actNone: "No hay trazas de los agentes en esta repetición", actSum: "Relevos hasta ahora: {n}, {tokens} tokens, {usd}",
    actMade: "Cómo se hizo el gráfico en pantalla: {n} relevos, {tokens} tokens, {usd}",
    actRules: "reglas, sin modelo", actCode: "código, sin modelo",
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
// The controls' own strings (the layout's part of the page), in the same tables as the rest
const CONTROL_STRINGS = {
  en: { viewing: "Viewing", voice: "Voice", voiceName: "AI voice-over", goalAt: "Goal, {who}, {m}'",
    nextGoal: "Next goal", nonextGoal: "No more goals", nokeyGoal: "No goals",
    goalsHint: "AI graphics are off: this jumps to the goals",
    keysTitle: "Keyboard shortcuts", keySpace: "Space", keyPlay: "Play or pause", keyTen: "Back or forward 10 seconds",
    keyFive: "Back or forward 5 seconds", keyJump: "Jump to 0%, 10% … 90% of the match", keyVoice: "AI voice-over on or off",
    keyFull: "Full screen on or off", keyList: "This list" },
  it: { viewing: "Opzioni", voice: "Voce", voiceName: "Voce AI", goalAt: "Gol, {who}, {m}'",
    nextGoal: "Prossimo gol", nonextGoal: "Nessun altro gol", nokeyGoal: "Nessun gol",
    goalsHint: "Grafiche AI spente: il pulsante salta ai gol",
    keysTitle: "Scorciatoie da tastiera", keySpace: "Spazio", keyPlay: "Riproduci o metti in pausa", keyTen: "Indietro o avanti di 10 secondi",
    keyFive: "Indietro o avanti di 5 secondi", keyJump: "Salta allo 0%, 10% … 90% della partita", keyVoice: "Voce AI accesa o spenta",
    keyFull: "Schermo intero sì o no", keyList: "Questo elenco" },
  es: { viewing: "Opciones", voice: "Voz", voiceName: "Voz IA", goalAt: "Gol, {who}, {m}'",
    nextGoal: "Siguiente gol", nonextGoal: "No hay más goles", nokeyGoal: "No hay goles",
    goalsHint: "Gráficos IA apagados: el botón salta a los goles",
    keysTitle: "Atajos de teclado", keySpace: "Espacio", keyPlay: "Reproducir o pausar", keyTen: "Atrás o adelante 10 segundos",
    keyFive: "Atrás o adelante 5 segundos", keyJump: "Ir al 0%, 10% … 90% del partido", keyVoice: "Voz IA activada o desactivada",
    keyFull: "Pantalla completa sí o no", keyList: "Esta lista" },
};
for (const [lang, more] of Object.entries(CONTROL_STRINGS)) STRINGS[lang] = { ...more, ...STRINGS[lang] };

// Graphic text is never drawn under MIN_PX. A frame where the 17 px fact chips would be smaller gets the
// compact variant (smallest type 30 stage px); where 30 px is still too small the graphics leave the pitch
// for the deck: beside the frame when a wide, short window leaves DECK_MIN px there, else below the controls.
const MIN_PX = 11, SMALLEST = 17, COMPACT_PX = 30, DECK_MIN = 300;
let compact = false, deckMode = "", scale = 1;

function layout() {
  const app = $("#app"), cs = getComputedStyle(app), ask = $("#ask"), body = document.body.classList;
  const W = app.clientWidth || window.innerWidth, H = window.innerHeight;
  const room = Math.max(160, W - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom), gap = parseFloat(cs.rowGap) || 0;
  // from the window alone, so hiding the button cannot change the answer
  body.toggle("no-radar", Math.min(room, ((H - 120) * STAGE_W) / STAGE_H) < 600);
  body.remove("deck", "deck-side");
  // the open Viewing menu does not count: opening it moves the page down, never the picture
  const menu = $("#viewing"), menuOpen = menu.classList.contains("open");
  menu.classList.remove("open");
  for (const el of [deck, ask]) el.style.width = el.style.maxHeight = "";
  // the controls and the strip wrap: size them first, then give the frame the height that is left
  const rows = (cw) => {
    for (const el of [controls, strip]) el.style.width = `${cw}px`;
    return controls.offsetHeight + strip.offsetHeight + 2 * gap;
  };
  const fit = (h) => Math.max(Math.min(room / STAGE_W, h / STAGE_H), 90 / STAGE_H);
  // the open Ask panel never shrinks the picture: it sits beside it (side deck) or under the controls, and the page scrolls
  let below = rows(room), s = fit(H - pad - below), side = 0;
  if (COMPACT_PX * s < MIN_PX) {
    // beside the frame, the Ask panel with it
    const hs = fit(H - pad - below), colGap = 10;
    if (STAGE_W * hs + colGap + DECK_MIN <= room) { s = hs; side = room - Math.round(STAGE_W * hs) - colGap; }
  }
  if (!side) {
    // under the picture the controls take its width, and never less than room for a few buttons a row
    below = rows(Math.max(Math.round(STAGE_W * s), Math.min(room, 560)));
    s = fit(H - pad - below);
  }
  const fw = Math.round(STAGE_W * s), fh = Math.round(STAGE_H * s);
  frame.style.width = `${fw}px`;
  frame.style.height = `${fh}px`;
  stage.style.transform = `scale(${s})`;
  // the score bug is never drawn under MIN_PX either: magnified from its 38 px teams, minute and score;
  // the 30 px period label goes when it would be smaller (the minute says the half: 45+2', 46')
  const bug = Math.max(1, MIN_PX / (38 * s)), sb = $("#scorebug");
  sb.style.transform = bug > 1 ? `scale(${bug})` : "";
  sb.classList.toggle("no-period", 30 * s * bug < MIN_PX);
  compact = SMALLEST * s < MIN_PX;
  deckMode = side ? "side" : COMPACT_PX * s < MIN_PX ? "below" : "";
  body.toggle("deck", !!deckMode);
  body.toggle("deck-side", !!side);
  if (side) {
    for (const el of [deck, ask]) el.style.width = `${Math.min(side, 560)}px`;
    ask.style.maxHeight = `${fh}px`;
  } else if (deckMode) deck.style.width = controls.style.width;
  // in the radar the 2D pitch is drawn at RADAR of the stage
  pitch.resize(s * (view3d?.shown === "split" && view3d.main === "3d" ? RADAR : 1) * Math.min(window.devicePixelRatio || 1, 2));
  view3d?.resize();
  scale = s;
  menu.classList.toggle("open", menuOpen);
  if (match) placeGoals();
  state.seeked = true; // graphics are rebuilt for the new size
  laidOut = heights();
  // a small screen has no Radar (the inset would be a stamp): who had it, or a link that asks for it, gets 3D
  if (body.contains("no-radar") && view3d?.mode === "split") view3d.set("3d");
}
// a new label, a late font or the strip's narrow layout changes a height: the frame gets what is left
let laidOut = "";
const heights = () => [controls, strip].map((el) => el.offsetHeight).join("|");
const relayout = new ResizeObserver(() => { if (heights() !== laidOut) layout(); });
for (const el of [controls, strip]) relayout.observe(el);

function applyStrings() {
  // the whole page follows the language; agent output inside it is marked lang="en" where it is shown
  document.documentElement.lang = state.lang;
  for (const el of [$("#overlay"), deck]) el.lang = state.lang;
  // the audience control is translated, so a screen reader reads it in the chosen language
  for (const el of [$('[data-i18n-aria="audience"]'), $("#audience-pick"), $("#ask"), $("#ask-open")]) el.lang = state.lang;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  $("#play").setAttribute("aria-label", t(state.playing ? "pause" : "play"));
  if (match) goalLabels();
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
  // AI off: the score facts are not AI, so the button goes from goal to goal
  moments.setSheet(sheet, desk.loaded, desk.kill ? match.goals.map((f) => f.ts) : null);
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
  $(".sb-min").textContent = `${c.label}'`;
  $(".sb-period").textContent = t(c.period === 1 ? "p1" : "p2");
  $("#time").textContent = `${c.label}'`;
  const said = { n: c.label, p: t(c.period === 1 ? "h1" : "h2"), home: match.home.name, h, away: match.away.name, a };
  $("#seek-range").setAttribute("aria-valuetext", t("minute").replace(/\{(\w+)\}/g, (_, k) => said[k]));
}

// a goal's button appears once the replay has reached the goal (no spoilers) and stays: it seeks to before the goal
let reachedTs = 0;
function revealGoals() {
  reachedTs = Math.max(reachedTs, state.ts);
  const bs = [...$("#goals").children];
  let changed = false;
  for (const b of bs) {
    const hide = Number(b.dataset.ts) > reachedTs;
    if (b.hidden !== hide) { b.hidden = hide; changed = true; }
  }
  if (!changed) return;
  // the goals are one tab stop (arrows move between them): the first one shown takes it
  const shown = bs.filter((b) => !b.hidden);
  if (shown.length && !shown.some((b) => b.tabIndex === 0)) shown[0].tabIndex = 0;
  placeGoals();
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
  const range = $("#seek-range");
  range.max = String(end);
  // one button per goal above the bar: the scoring team's code and the minute on its colour; a press lands LEAD_S
  // before it. Team data goes through the DOM, never into markup; a goal of an unknown team gets no colour.
  $("#goals").replaceChildren(...[...match.goals].sort((p, q) => p.ts - q.ts).map((f) => {
    const b = document.createElement("button"), team = match.teams[f.team_id];
    b.type = "button";
    b.hidden = true;
    b.tabIndex = -1;
    b.dataset.ts = String(f.ts);
    b.dataset.code = team?.short_name ?? "";
    const minute = document.createElement("span");
    minute.className = "gm";
    minute.textContent = `${b.dataset.code ? " " : ""}${match.clock(f.ts).label}'`;
    b.replaceChildren(b.dataset.code, minute);
    if (team) Object.assign(b.style, { background: team.color_primary, color: textOn(team.color_primary) });
    b.addEventListener("click", () => seek(Math.max(0, f.ts - LEAD_S)));
    return b;
  }));
  // arrows, Home and End move between the goals shown
  $("#goals").addEventListener("keydown", (e) => {
    const bs = [...$("#goals").children].filter((b) => !b.hidden), i = bs.indexOf(e.target);
    const j = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: bs.length - 1 }[e.key];
    if (i < 0 || j === undefined) return;
    e.preventDefault();
    const to = bs[Math.max(0, Math.min(j, bs.length - 1))];
    for (const b of bs) b.tabIndex = b === to ? 0 : -1;
    to.focus();
  });
  goalLabels();
  revealGoals();
}

// "Goal, Okowande (RED), 10'": the scorer from the fact or its source event, the team code that is on the button;
// the same words show on hover
function goalLabels() {
  for (const b of $("#goals").children) {
    const f = match.goals.find((g) => String(g.ts) === b.dataset.ts);
    const pid = f.player_id ?? match.events.find((e) => e.event_id === f.source_event_ids?.[0])?.player_id;
    const name = match.players[pid]?.name, code = b.dataset.code;
    const who = name && code ? `${name} (${code})` : name || code || "?";
    b.title = t("goalAt").replace("{who}", who).replace("{m}", match.clock(f.ts).label);
    b.setAttribute("aria-label", b.title);
    b.lang = state.lang;
  }
}

// at the goal's place on the bar, nudged apart when two goals are close: a forward pass, then back from the end;
// a bar too short for every minute (a 320 px window) shows the team codes only, the names keep the minutes
function placeGoals() {
  const box = $("#goals"), w = box.clientWidth;
  const measure = () => [...box.children].filter((b) => !b.hidden).map((b) => ({ b, w: b.offsetWidth, c: (Number(b.dataset.ts) / end) * w })).sort((p, q) => p.c - q.c);
  box.classList.remove("tight");
  let items = measure();
  if (items.reduce((n, it) => n + it.w + 2, 0) > w) { box.classList.add("tight"); items = measure(); }
  let edge = 0;
  for (const it of items) { it.x = Math.max(it.c - it.w / 2, edge); edge = it.x + it.w + 2; }
  edge = w;
  for (const it of items.reverse()) { it.x = Math.max(0, Math.min(it.x, edge - it.w)); edge = it.x - 2; it.b.style.left = `${it.x}px`; }
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
  if (view3d?.shown !== "3d") pitch.draw(match, Math.min(state.ts, match.duration), [...host.live.values()].map((i) => i.cue));
  view3d?.frame(state.ts, state.speed, state.seeked, state.playing);
  drawScorebug();
  revealGoals();
  host.sync(state.ts, state.seeked, state.speed);
  // the radar steps aside while a graphic that is not pinned to a player is on the frame
  document.body.classList.toggle("radar-yield", !deckMode && [...host.live.values()].some((i) => !i.positioned));
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
  // the Viewing menu of a narrow screen is a disclosure: Escape closes it and gives the focus back to its button
  const viewing = $("#viewing"), viewingOpen = $("#viewing-open");
  const setViewing = (open) => { viewing.classList.toggle("open", open); viewingOpen.setAttribute("aria-expanded", String(open)); };
  viewingOpen.addEventListener("click", () => setViewing(!viewing.classList.contains("open")));
  for (const el of [viewing, viewingOpen]) el.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !viewing.classList.contains("open") || !viewingOpen.offsetParent) return;
    setViewing(false);
    viewingOpen.focus();
  });
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
  // the open drawer is modal: Esc closes it wherever focus is (the page behind is inert, focus may sit on body)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("desk-open") && !e.target.closest?.("textarea")) desk.closeDrawer();
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
  // the video player keys (keys.js), scoped as Space is; a key a control already used (the seek bar's arrows) is left to it
  const range = $("#seek-range");
  window.addEventListener("keydown", (e) => {
    const [act, x] = (!e.defaultPrevented && shortcut(e)) || [];
    if (!act) return;
    e.preventDefault();
    if (act === "play") setPlaying(!state.playing);
    else if (act === "step") seek(state.ts + x);
    else if (act === "fraction") seek(end * x);
    else if (act === "voice") { if (!$("#voice").hidden) $("#voice").click(); }
    else if (act === "fullscreen") (document.fullscreenElement ? document.exitFullscreen() : $("#app").requestFullscreen()).catch(() => {});
    else if (act === "keys") $("#keys").showModal();
    range.value = String(state.ts);
  });
  // full screen is the broadcast column (picture, controls, strip), without the desk
  document.addEventListener("fullscreenchange", layout);
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
  const locate = (pid, now) => {
    if (view3d?.main === "3d") return view3d.project(pid, now);
    const p = match.index[pid] !== undefined ? match.at(match.index[pid], Math.min(now, match.duration)) : null;
    if (!p) return { x: 0, y: 0, visible: false };
    const [x, y] = toStage(p[0], p[1]);
    return { x, y, visible: true };
  };
  // v_side: a card that can sit on either side (momentum) goes to the half of the frame away from the ball,
  // unless the lower third has the bottom left
  const awayFromBall = () => {
    const ball = locate("ball", state.ts);
    const third = [...host.live.values()].some((i) => i.cue.graphic === "pass_shot");
    return ball.visible && ball.x > STAGE_W / 2 && !third ? "left" : "right";
  };
  host = new OGrafHost($("#overlay"), {
    resolution: { width: STAGE_W, height: STAGE_H },
    frameRate: 60,
    locate,
    vendorParams: () => ({ v_showFactIds: state.audience === "analyst", v_players: players, v_teams: teams, v_compact: compact, v_side: awayFromBall() }),
    // in the deck or not, the nameplate stays on the pitch, magnified so its smallest type (26 px) is drawn at 11.5 px
    compact: () => ({ deck: deckMode ? deck : null, magnify: Math.max(1, 11.5 / (26 * scale)) }),
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
  window.studioDesk = { state, match, host, desk, pitch, get voice() { return voice; }, seek, setPlaying, get end() { return end; } };
  // 2D, 3D or Radar (?view=split): ?view= or what the device can draw; any change of view re-lays the page
  view3d = new View3D(match, { canvas: $("#view3d"), pitch: $("#pitch"), stage, radar: $("#radar"), badge: $("#replay-badge"),
    notice: $("#notice"), status: $("#view-status"), buttons: document.querySelectorAll("[data-view]") }, layout);
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
