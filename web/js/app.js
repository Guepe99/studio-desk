// Studio Desk 2D broadcast page: replay, score bug, controls and the OGraf overlay.
import { loadMatch } from "./match.js";
import { Pitch, SEE_THROUGH, STAGE_W, STAGE_H, toStage, textOn } from "./pitch.js";
import { OGrafHost } from "./ograf-host.js";
import { Desk } from "./desk.js";
import { Voice } from "./voice.js";
import { BoothAudio } from "./booth-audio.js";
import { View3D, probe, defaultView, warm3d, RADAR, replays, holdForReplays } from "./view3d.js";
import { Ask } from "./ask.js";
import { Proof } from "./proof.js";
import { Moments, LEAD_S } from "./moments.js";
import { Activity } from "./activity.js";
import { AudienceBox } from "./audiences.js";
import { shortcut } from "./keys.js";
import { Countdown } from "./countdown.js";

const GRAPHICS = ["nameplate", "pass_shot", "momentum", "team_stats", "why_card"];
const STRINGS = {
  en: {
    play: "Play", pause: "Pause", seek: "Match time", speed: "Playback speed", half2: "Jump to 2nd half",
    audience: "Audience", analyst: "Analyst", casual: "Casual fan", kids: "Kids", language: "Language",
    p1: "1H", p2: "2H", loading: "Loading match", error: "Could not load match {m}. {e}",
    minute: "Minute {n}, {p}, {home} {h}, {away} {a}", h1: "first half", h2: "second half",
    nographic: "Some graphics could not load: {g}.",
    myteam: "My team", player: "Player",
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
    didPick: "Picked: {what}", didPickAny: "Picked a moment", didExplain: "Explained why it matters", didWrite: "Wrote the line",
    didRewrite: "Rewrote the line", didPass: "All numbers check out", didRewritten: "Asked for a rewrite", didTemplate: "Used the fact-only line",
    didCheck: "Checked the numbers", didCue: "Put it in the rundown", didFail: "Model call failed", didHand: "Passed its work on",
    replay: "Replay", swap3d: "Show the 3D view large", swap2d: "Show the 2D pitch large", load3d: "Loading the 3D view",
    fail3d: "The 3D view could not start ({e}). Showing the 2D pitch.", lost3d: "The browser stopped the 3D view. Showing the 2D pitch.",
    slow3d: "The 3D view ran at {fps} frames a second here, so the 2D pitch is back. Turn the minimap on in the settings to keep the 3D view anyway.",
    voiceOn: "AI voice-over on, with AI match commentary by fictional commentators and crowd sound: speaks the chosen language, plays at 1x", voiceOff: "AI voice-over and AI commentary off",
    aioff: "AI off", matchPick: "Choose a match", broadcast: "Match broadcast", activity: "Agent activity",
  },
  // every key in every language: a missing one would fall back to English
  it: {
    play: "Riproduci", pause: "Pausa", seek: "Tempo di gioco", speed: "Velocità di riproduzione", half2: "Vai al 2° tempo",
    language: "Lingua", p1: "1°T", p2: "2°T", loading: "Caricamento della partita", error: "Impossibile caricare la partita {m}. {e}",
    minute: "Minuto {n}, {p}, {home} {h}, {away} {a}", h1: "primo tempo", h2: "secondo tempo",
    nographic: "Alcune grafiche non si sono caricate: {g}.",
    aioff: "IA spenta", matchPick: "Scegli la partita", broadcast: "Trasmissione della partita", activity: "Attività degli agenti",
    audience: "Pubblico", analyst: "Analista", casual: "Spettatore", kids: "Bambini", myteam: "La mia squadra", player: "Giocatore",
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
    didPick: "Ha scelto: {what}", didPickAny: "Ha scelto un momento", didExplain: "Ha spiegato perché conta", didWrite: "Ha scritto la frase",
    didRewrite: "Ha riscritto la frase", didPass: "Tutti i numeri tornano", didRewritten: "Ha chiesto di riscrivere", didTemplate: "Ha usato la frase con i soli fatti",
    didCheck: "Ha controllato i numeri", didCue: "L'ha messa in scaletta", didFail: "Errore del modello", didHand: "Ha passato le consegne",
    replay: "Replay", swap3d: "Mostra in grande la vista 3D", swap2d: "Mostra in grande il campo 2D", load3d: "Caricamento della vista 3D",
    fail3d: "Impossibile avviare la vista 3D ({e}): resta il campo 2D.", lost3d: "Il browser ha fermato la vista 3D: torna il campo 2D.",
    slow3d: "Qui la vista 3D andava a {fps} fotogrammi al secondo, così è tornato il campo 2D. Accendi la minimappa nelle impostazioni per tenerla comunque.",
    voiceOn: "Voce IA accesa, con la telecronaca IA di due telecronisti inventati e il rumore del pubblico: parla nella lingua scelta, solo a velocità 1x", voiceOff: "Voce e telecronaca IA spente",
  },
  es: {
    play: "Reproducir", pause: "Pausa", seek: "Tiempo de partido", speed: "Velocidad de reproducción", half2: "Ir a la 2.ª parte",
    language: "Idioma", p1: "1T", p2: "2T", loading: "Cargando el partido", error: "No se pudo cargar el partido {m}. {e}",
    minute: "Minuto {n}, {p}, {home} {h}, {away} {a}", h1: "primera parte", h2: "segunda parte",
    nographic: "Algunos gráficos no se pudieron cargar: {g}.",
    aioff: "IA apagada", matchPick: "Elige el partido", broadcast: "Retransmisión del partido", activity: "Actividad de los agentes",
    audience: "Público", analyst: "Analista", casual: "Espectador", kids: "Niños", myteam: "Mi equipo", player: "Jugador",
    ask: "Pregunta al estudio", close: "Cerrar", askLabel: "Tu pregunta sobre el partido hasta ahora", askSend: "Preguntar",
    askHint: "Las respuestas usan solo los datos del partido hasta el momento de la repetición.", askWait: "El estudio está revisando los datos del partido.",
    askYou: "Has preguntado", askLeft: "Preguntas restantes hoy: {n}", askFacts: "Datos",
    askLimit: "Por ahora no se pueden hacer más preguntas: se ha alcanzado el límite. Inténtalo mañana.",
    askPaused: "Por ahora las preguntas están en pausa: el control de seguridad ha alcanzado su límite. Inténtalo más tarde.",
    askOff: "Las preguntas no están disponibles en este sitio.", askNet: "No se ha podido contactar con el estudio. Revisa la conexión e inténtalo de nuevo.",
    askBad: "El estudio no puede aceptar esa pregunta. Prueba con una más corta sobre este partido.",
    askErr: "El estudio ha tenido un problema. Inténtalo de nuevo en un minuto.",
    next: "Siguiente momento clave", nonext: "No hay más momentos clave",
    nokey: "No hay momentos clave", actTitle: "Los agentes en acción",
    actWait: "Todavía no hay relevos entre los agentes en este punto del partido",
    actNone: "No hay trazas de los agentes en esta repetición", actSum: "Relevos hasta ahora: {n}, {tokens} tokens, {usd}",
    actMade: "Cómo se hizo el gráfico en pantalla: {n} relevos, {tokens} tokens, {usd}",
    actRules: "reglas, sin modelo", actCode: "código, sin modelo",
    didPick: "Eligió: {what}", didPickAny: "Eligió un momento", didExplain: "Explicó por qué importa", didWrite: "Escribió la frase",
    didRewrite: "Reescribió la frase", didPass: "Todos los números cuadran", didRewritten: "Pidió reescribirla", didTemplate: "Usó la frase solo con datos",
    didCheck: "Comprobó los números", didCue: "La puso en la escaleta", didFail: "Error del modelo", didHand: "Pasó el relevo",
    replay: "Repetición", swap3d: "Mostrar en grande la vista 3D", swap2d: "Mostrar en grande el campo 2D", load3d: "Cargando la vista 3D",
    fail3d: "No se pudo iniciar la vista 3D ({e}): se muestra el campo 2D.", lost3d: "El navegador detuvo la vista 3D: se muestra el campo 2D.",
    slow3d: "Aquí la vista 3D iba a {fps} fotogramas por segundo, así que vuelve el campo 2D. Activa el minimapa en los ajustes para mantenerla de todos modos.",
    voiceOn: "Voz de IA activada, con comentarios de IA de dos comentaristas inventados y el sonido de la grada: habla en el idioma elegido, solo a 1x", voiceOff: "Voz y comentarios de IA desactivados",
  },
};

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const matchId = (params.get("match") || "M001").replace(/[^A-Za-z0-9_-]/g, "");
// ?lang= keeps the language across a change of match (matchPicker)
const state = { ts: 0, playing: false, speed: 1, audience: "analyst", lang: STRINGS[params.get("lang")] ? params.get("lang") : "en", seeked: true };
const t = (key) => (STRINGS[state.lang] ?? STRINGS.en)[key] ?? STRINGS.en[key];

const frame = $("#frame"), stage = $("#stage"), controls = $("#controls"), deck = $("#deck"), strip = $("#activity");
const pitch = new Pitch($("#pitch"));
let match = null, host = null, desk = null, voice = null, booth = null, ask = null, end = 0, moments = null, activity = null, audBox = null, proof = null;
let view3d = null;   // the 3D views (view3d.js), once the match is loaded
// the 3-2-1 before kick-off and the full-time strap; pips only with the Voice button on (countdown.js)
const countdown = new Countdown($("#moment"), { lang: () => state.lang, sound: () => !!voice?.on && !$("#voice").hidden });
// The controls' own strings (the layout's part of the page), in the same tables as the rest
const CONTROL_STRINGS = {
  en: { settings: "Settings", more: "More", minimap: "Minimap",
    voice: "Voice", voiceName: "AI voice-over", goalAt: "Goal, {who}, {m}'",
    nextGoal: "Next goal", nonextGoal: "No more goals", nokeyGoal: "No goals",
    goalsHint: "AI graphics are off: this jumps to the goals",
    keysTitle: "Keyboard shortcuts", keySpace: "Space", keyPlay: "Play or pause", keyTen: "Back or forward 10 seconds",
    keyFive: "Back or forward 5 seconds", keyJump: "Jump to 0%, 10% … 90% of the match", keyVoice: "AI voice-over on or off",
    keyFull: "Full screen on or off", keyList: "This list" },
  it: { settings: "Impostazioni", more: "Altro", minimap: "Minimappa",
    voice: "Voce", voiceName: "Voce IA", goalAt: "Gol, {who}, {m}'",
    nextGoal: "Prossimo gol", nonextGoal: "Nessun altro gol", nokeyGoal: "Nessun gol",
    goalsHint: "Grafiche IA spente: il pulsante salta ai gol",
    keysTitle: "Scorciatoie da tastiera", keySpace: "Spazio", keyPlay: "Riproduci o metti in pausa", keyTen: "Indietro o avanti di 10 secondi",
    keyFive: "Indietro o avanti di 5 secondi", keyJump: "Salta allo 0%, 10% … 90% della partita", keyVoice: "Accendi o spegni la voce IA",
    keyFull: "Attiva o disattiva lo schermo intero", keyList: "Questo elenco" },
  es: { settings: "Ajustes", more: "Más", minimap: "Minimapa",
    voice: "Voz", voiceName: "Voz de IA", goalAt: "Gol, {who}, {m}'",
    nextGoal: "Siguiente gol", nonextGoal: "No hay más goles", nokeyGoal: "No hay goles",
    goalsHint: "Gráficos de IA apagados: el botón salta a los goles",
    keysTitle: "Atajos de teclado", keySpace: "Espacio", keyPlay: "Reproducir o pausar", keyTen: "Atrás o adelante 10 segundos",
    keyFive: "Atrás o adelante 5 segundos", keyJump: "Ir al 0%, 10% … 90% del partido", keyVoice: "Activar o desactivar la voz de IA",
    keyFull: "Activar o desactivar la pantalla completa", keyList: "Esta lista" },
};
for (const [lang, more] of Object.entries(CONTROL_STRINGS)) STRINGS[lang] = { ...more, ...STRINGS[lang] };
// The page header: what the page is for a first-time visitor; the match line comes from meta.json
const HEAD_STRINGS = {
  en: { tagline: "AI agents write the TV graphics for a football replay, and you decide what goes on air", replay: "Replay" },
  it: { tagline: "Gli agenti IA scrivono le grafiche TV per il replay di una partita, e tu decidi cosa va in onda", replay: "Replay" },
  es: { tagline: "Agentes de IA escriben los gráficos de TV de la repetición de un partido, y tú decides qué sale al aire", replay: "Repetición" },
};
for (const [lang, more] of Object.entries(HEAD_STRINGS)) Object.assign(STRINGS[lang], more);

// Graphic text is never drawn under MIN_PX. A frame where the 17 px fact chips would be smaller gets the
// compact variant (smallest type 30 stage px); where 30 px is still too small the graphics leave the pitch
// for the deck: beside the frame when a wide, short window leaves DECK_MIN px there, else below the controls.
const MIN_PX = 11, SMALLEST = 17, COMPACT_PX = 30, DECK_MIN = 300;
let compact = false, deckMode = "", scale = 1, radarK = 1, laidFor = "";

function layout() {
  const app = $("#app"), cs = getComputedStyle(app), ask = $("#ask"), pf = $("#proof"), body = document.body.classList;
  const W = app.clientWidth || window.innerWidth, H = window.innerHeight;
  const room = Math.max(160, W - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom), gap = parseFloat(cs.rowGap) || 0;
  const head = $("#masthead").offsetHeight, top = head ? head + gap : 0;
  body.remove("deck", "deck-side");
  for (const el of [deck, ask, pf]) el.style.width = el.style.maxHeight = "";
  // the header, the controls and the strip wrap: size them first, then give the frame the height that
  // is left. The strip counts at its height with cards (.reserve), so the picture does not move when
  // the first hand-off comes in; a short window lets the strip go under the fold before the graphics
  // leave the pitch.
  const rows = (cw, withStrip = true) => {
    for (const el of [controls, strip]) el.style.width = `${cw}px`;
    strip.classList.add("reserve");
    const sh = strip.offsetHeight;
    strip.classList.remove("reserve");
    return top + controls.offsetHeight + gap + (withStrip ? sh + gap : 0);
  };
  const fit = (h) => Math.max(Math.min(room / STAGE_W, h / STAGE_H), 90 / STAGE_H);
  const onPitch = (x) => COMPACT_PX * x >= MIN_PX;
  // the open Ask panel never shrinks the picture: it sits beside it (side deck), over the docked desk or under the controls
  let keep = true, below = rows(room), s = fit(H - pad - below), side = 0;
  if (!onPitch(s) && onPitch(fit(H - pad - rows(room, false)))) { keep = false; below = rows(room, false); s = fit(H - pad - below); }
  if (!onPitch(s)) {
    // beside the frame, the Ask panel with it
    const colGap = 10;
    if (STAGE_W * s + colGap + DECK_MIN <= room) side = room - Math.round(STAGE_W * s) - colGap;
  }
  if (!side) {
    // under the picture the controls take its width (never less than room for a few buttons a row),
    // unless that wraps them onto another row
    const narrow = rows(Math.max(Math.round(STAGE_W * s), Math.min(room, 560)), keep);
    if (narrow <= below) s = fit(H - pad - narrow);
    else rows(room, keep);
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
  // the countdown strap magnified the same way, and under the score bug when that one is magnified (a phone)
  const mo = $("#moment"), mk = Math.max(1, MIN_PX / (38 * s));
  mo.style.scale = mk > 1 ? String(mk) : "";
  mo.style.top = bug > 1 ? `${sb.offsetTop + sb.offsetHeight * bug + 16}px` : "";
  compact = SMALLEST * s < MIN_PX;
  deckMode = side ? "side" : COMPACT_PX * s < MIN_PX ? "below" : "";
  body.toggle("deck", !!deckMode);
  body.toggle("deck-side", !!side);
  if (side) {
    deck.style.width = `${Math.min(side, 560)}px`;
    deck.style.maxHeight = `${fh}px`;
    if (!DOCKED.matches) for (const el of [ask, pf]) { el.style.width = deck.style.width; el.style.maxHeight = `${fh}px`; }
  } else if (deckMode) deck.style.width = controls.style.width;
  $("#audiences").style.width = controls.style.width;
  // the minimap sits at RADAR_K of its box, as small as a game's radar, but never narrower than RADAR_MIN px:
  // magnified on a small frame, as the score bug is
  radarK = Math.max(RADAR_K, RADAR_MIN / (RADAR_BOX.w * s));
  $("#radar").style.scale = radarK !== 1 ? String(radarK) : "";
  // in the minimap the 2D pitch is drawn at RADAR of the stage
  const inset = view3d?.shown === "split" && view3d.main === "3d";
  pitch.seeThrough = inset ? SEE_THROUGH : 1;
  pitch.resize(s * (inset ? RADAR * radarK : 1) * Math.min(window.devicePixelRatio || 1, 2));
  minimapState();
  view3d?.resize();
  scale = s;
  if (match) placeGoals();
  // graphics are rebuilt for a new size, not when only a label moved the controls
  const size = [s, compact, deckMode, deck.style.width, deck.style.maxHeight].join("|");
  if (size !== laidFor) { laidFor = size; state.seeked = true; }
  laidOut = heights();
  if (!$("#settings-menu").hidden) placeMenu();
}

// The minimap item says whether the minimap is on (and cannot be turned on once the 3D view failed);
// the inset's name says what a click on it does.
function minimapState() {
  const item = $("#minimap"), off = !!(view3d?.failed || view3d?.lost);
  item.setAttribute("aria-checked", String(view3d?.mode === "split"));
  item.setAttribute("aria-disabled", String(off));
}
// a new label, a late font or the strip's narrow layout changes a height: the frame gets what is left
let laidOut = "";
const heights = () => [controls, strip, $("#masthead")].map((el) => el.offsetHeight).join("|");
const relayout = new ResizeObserver(() => { if (heights() !== laidOut) layout(); });
for (const el of [controls, strip, $("#masthead")]) relayout.observe(el);
// the desk is docked from 1100 px (broadcast.css), and the open Ask panel then sits over its foot (ask.css)
const DOCKED = matchMedia("(min-width: 1100px)");

function applyStrings() {
  // the whole page follows the language; agent output inside it is marked lang="en" where it is shown
  document.documentElement.lang = state.lang;
  for (const el of [$("#overlay"), deck]) el.lang = state.lang;
  // the settings are translated, so a screen reader reads them in the chosen language (each language item keeps its own)
  for (const el of [$("#settings-wrap"), $("#ask"), $("#ask-open")]) el.lang = state.lang;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  $("#play").setAttribute("aria-label", t(state.playing ? "pause" : "play"));
  if (match) goalLabels();
  settingsState();
  minimapState();
  view3d?.relabel();
  voice?.render();
  countdown.relabel();
}

function setPlaying(on) {
  if (on && state.ts >= end) seek(0);
  if (countdown.counting) countdown.cancel();   // a programmatic play or pause (tests, demo scripts) goes at once
  state.playing = on;
  showPlaying(on);
}

function showPlaying(on) {
  $("#play").classList.toggle("playing", on);
  $("#play").setAttribute("aria-label", t(on ? "pause" : "play"));
}

// The viewer's Play (the button, Space, K): from the very start it counts 3-2-1 first, the clock held
// until "Kick off"; a press during the count stops it.
function pressPlay() {
  if (countdown.counting) return setPlaying(false);
  if (!state.playing && state.ts >= end) seek(0);
  if (!state.playing && countdown.start(state.ts, state.speed)) return showPlaying(true);
  setPlaying(!state.playing);
}

function setSpeed(x) {
  state.speed = x;
  checked("data-speed", x);
  settingsState();
}

function setAudience(a) {
  state.audience = a;
  checked("data-audience", a);
  settingsState();
  refreshCues();
}

function seek(ts) {
  state.ts = Math.min(Math.max(ts, 0), end);
  state.seeked = true;
  voice?.reset();
  booth?.reset();
  const counting = countdown.counting;
  countdown.cancel();   // a seek is never the very start, nor still the kick-off
  if (counting) showPlaying(state.playing);
}

function checked(attr, value) {
  for (const b of document.querySelectorAll(`[${attr}]`)) b.setAttribute("aria-checked", String(b.getAttribute(attr) === String(value)));
}

// Beside the gear, what is not the default: the speed (so nobody wonders why the match runs fast) and the audience
function settingsState() {
  const aud = document.querySelector(`[data-audience="${CSS.escape(state.audience)}"]`);
  const said = [state.speed !== 1 ? `${state.speed}x` : "", state.audience !== "analyst" ? aud?.dataset.short ?? aud?.textContent ?? "" : ""];
  const el = $("#settings-state");
  el.textContent = said.filter(Boolean).join(" · ");
  el.hidden = !el.textContent;
}

// The settings menu opens under the gear when it fits there, else over it, and never off the screen.
function setMenu(open, focusGear = false) {
  const menu = $("#settings-menu");
  menu.hidden = !open;
  $("#settings").setAttribute("aria-expanded", String(open));
  if (open) placeMenu();
  if (focusGear) $("#settings").focus();
}
function placeMenu() {
  const menu = $("#settings-menu"), g = $("#settings").getBoundingClientRect(), wrap = $("#settings-wrap").getBoundingClientRect();
  Object.assign(menu.style, { top: "", bottom: "", left: "", maxHeight: "" });
  const m = menu.getBoundingClientRect(), below = window.innerHeight - g.bottom - 14, above = g.top - 14;
  const down = m.height <= below || below >= above;
  menu.style[down ? "top" : "bottom"] = "calc(100% + 6px)";
  if (m.height > (down ? below : above)) menu.style.maxHeight = `${down ? below : above}px`;
  const vw = document.documentElement.clientWidth;
  menu.style.left = `${Math.min(Math.max(8, g.right - m.width), vw - 8 - m.width) - wrap.left}px`;
}

function cueSheet() {
  return desk.sheet(match.cues, state.audience, state.lang);
}

function refreshCues() {
  const sheet = cueSheet();
  // a momentum or team shape card due during a goal replay waits for its end: the 3D replay's goal camera
  // has the net across the foot of the picture, where the card sits
  host.setCues(holdForReplays(sheet, replays(match)), state.ts);
  // AI off: the score facts are not AI, so the button goes from goal to goal
  moments.setSheet(sheet, desk.loaded, desk.kill ? match.goals.map((f) => playStart(f.ts, f.source_event_ids)) : null,
    (c) => playStart(c.ts, desk.byId.get(c.story_id)?.evidence_event_ids));
  ask?.render();
}

// when the play behind a graphic or a goal began: its last evidence event up to 10 s before, else the time itself
function playStart(ts, ids = []) {
  const evs = match.events.filter((e) => ids?.includes(e.event_id) && e.ts <= ts && e.ts >= ts - 10);
  return evs.length ? Math.max(...evs.map((e) => e.ts)) : ts;
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
  // before its shot. Team data goes through the DOM, never into markup; a goal of an unknown team gets no colour.
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
    b.addEventListener("click", () => seek(Math.max(0, playStart(f.ts, f.source_event_ids) - LEAD_S)));
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
  const gap = lastFrame === null ? 0 : (now - lastFrame) / 1000;
  let dt = gap > 1 ? 0.1 : gap;
  lastFrame = now;
  if (countdown.frame(now, state.ts, state.speed, match.duration)) { setPlaying(true); dt = 0; }   // the clock starts at 0 on "Kick off"
  if (state.playing) {
    state.ts += dt * state.speed;
    if (state.ts >= end) { state.ts = end; setPlaying(false); }
  }
  // past the last tracking frame (full-time recap) the picture holds the last frame
  if (view3d?.shown !== "3d") pitch.draw(match, Math.min(state.ts, match.duration), [...host.live.values()].map((i) => i.cue));
  proof.update([...host.live.values()].map((i) => i.cue));
  view3d?.frame(state.ts, state.speed, state.seeked, state.playing);
  drawScorebug();
  revealGoals();
  host.sync(state.ts, state.seeked, state.speed);
  placeRadar();
  placeMoment();
  voice?.update(state.ts, end); // null until its clips are checked
  try { booth?.update(state.ts); } catch (e) { booth.stop(); queueMicrotask(() => { throw e; }); } // reported, the frame goes on
  moments.update(state.ts);
  const onAir = onAirStory();
  activity.update(state.ts, state.seeked, onAir, state.lang);
  audBox.update(onAir, state.ts, state.lang, state.audience);
  desk.setLive([...host.live.values()].map((i) => i.cue));
  state.seeked = false;
  const range = $("#seek-range");
  if (document.activeElement !== range || state.playing) range.value = String(state.ts);
  $("#seek-marks .fill").style.width = `${(state.ts / end) * 100}%`;
  requestAnimationFrame(tick);
}

// The Radar box takes the first spot along the foot of the frame (centre, right, left) that no graphic
// on the pitch covers; it steps aside only when they cover all three. Stage px, as view3d.css #radar.
// Magnified on a small frame (radarK), it grows from its bottom left corner and the spots move in with it.
const RADAR_BOX = { w: 440, h: 291, bottom: 20 }, RADAR_MIN = 120, RADAR_K = 0.7;
// The boxes of the graphics on the pitch (elements in stage px)
const graphicBoxes = () => [...host.live.values(), ...host.leaving].filter((i) => !i.positioned && i.node === i.el)
  .map((i) => i.el.shadowRoot?.querySelector(".stage")?.firstElementChild).filter((b) => b?.offsetWidth);
function placeRadar() {
  const boxes = graphicBoxes();
  const w = RADAR_BOX.w * radarK, top = STAGE_H - RADAR_BOX.bottom - RADAR_BOX.h * radarK;
  const x = [(STAGE_W - w) / 2, STAGE_W - 40 - w, 40].find((l) => boxes.every((b) => b.offsetLeft >= l + w || b.offsetLeft + b.offsetWidth <= l || b.offsetTop + b.offsetHeight <= top));
  document.body.classList.toggle("radar-yield", x === undefined);
  if (x !== undefined) $("#radar").style.left = `${x}px`;
}

// The countdown and full-time strap (top centre) gives way to anything on air there: a graphic or the replay badge.
function placeMoment() {
  const m = $("#moment");
  if (!m.classList.contains("on")) return;
  const k = Number(m.style.scale) || 1, w = m.offsetWidth * k, x = (STAGE_W - w) / 2, y = m.offsetTop, h = m.offsetHeight * k;
  const badge = $("#replay-badge.on"), boxes = graphicBoxes().map((b) => [b.offsetLeft, b.offsetTop, b.offsetWidth, b.offsetHeight]);
  if (badge) boxes.push([badge.offsetLeft - badge.offsetWidth / 2, badge.offsetTop, badge.offsetWidth, badge.offsetHeight]);
  m.classList.toggle("covered", boxes.some(([bx, by, bw, bh]) => bx < x + w && bx + bw > x && by < y + h && by + bh > y));
}

function wireControls() {
  $("#play").addEventListener("click", pressPlay);
  // My team and Player: one item per team and per player the cue sheet has cues for; a player's item
  // says when he first appears (a late substitute)
  const first = {};
  for (const c of match.cues) first[c.audience] = Math.min(first[c.audience] ?? Infinity, c.ts);
  const has = (aud) => first[aud] !== undefined;
  const choices = {
    team: [match.home, match.away].filter((tm) => has(`team:${tm.team_id}`)).map((tm) => [`team:${tm.team_id}`, tm.name, tm.short_name]),
    player: match.meta.players.filter((p) => has(`player:${p.player_id}`)).map((p) => [`player:${p.player_id}`,
      `${p.name} (${match.teams[p.team_id]?.short_name ?? ""} ${p.shirt}), ${match.clock(first[`player:${p.player_id}`]).label}'`, p.name]),
  };
  for (const [kind, list] of Object.entries(choices)) {
    const group = $(`#mg-${kind}`).parentElement;
    for (const [aud, label, short] of list) {
      // names come from the data: set as text, never as markup
      const b = Object.assign(document.createElement("button"), { type: "button", tabIndex: -1, textContent: label });
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", "false");
      Object.assign(b.dataset, { audience: aud, short });
      group.append(b);
    }
    group.hidden = !list.length;
  }
  const setLang = (lang) => {
    state.lang = lang;
    checked("data-lang", lang);
    applyStrings(); lastBug = ""; refreshCues(); desk.render();
  };
  const menu = $("#settings-menu"), gear = $("#settings");
  menu.addEventListener("click", (e) => {
    const b = e.target.closest('[role^="menuitem"]');
    if (!b || b.getAttribute("aria-disabled") === "true") return;
    if (b.dataset.speed) setSpeed(Number(b.dataset.speed));
    else if (b.dataset.audience) setAudience(b.dataset.audience);
    else if (b.dataset.lang) setLang(b.dataset.lang);
    else if (b.id === "minimap") view3d?.pick(view3d.mode === "split" ? view3d.main : "split");
    else if (b.id === "half2") { setMenu(false, true); seek(match.meta.period1_s); }
    else if (b.id === "keys-open") { setMenu(false, true); $("#keys").showModal(); }
  });
  // a menu button: Enter or ArrowDown opens it on its first item, ArrowUp on its last; arrows, Home and End move,
  // Escape closes it and gives the focus back to the gear, Tab closes it and moves on
  const items = () => [...menu.querySelectorAll('[role^="menuitem"]')].filter((b) => b.offsetParent);
  const openAt = (last) => { setMenu(true); const l = items(); l[last ? l.length - 1 : 0]?.focus(); };
  gear.addEventListener("click", () => (menu.hidden ? openAt(false) : setMenu(false)));
  gear.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    openAt(e.key === "ArrowUp");
  });
  menu.addEventListener("keydown", (e) => {
    const l = items(), i = l.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: l.length - 1 }[e.key];
    if (to !== undefined) { e.preventDefault(); l[(to + l.length) % l.length].focus(); }
    else if (e.key === "Escape") { e.preventDefault(); setMenu(false, true); }
    else if (e.key === "Tab") setMenu(false, true);   // the Tab then moves on from the gear
  });
  document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !e.target.closest?.("#settings-wrap")) setMenu(false); });
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
  $("#desk-open").addEventListener("click", () => {
    const open = !document.body.classList.contains("desk-open");
    desk.setDrawer(open);
    if (open) $("#desk").querySelector('[role="tab"][aria-selected="true"]')?.focus();
  });
  // widening the window docks the desk: a drawer left open would keep the page inert
  matchMedia("(max-width: 1099px)").addEventListener("change", (e) => { if (!e.matches) desk.setDrawer(false); });
  // the open drawer is modal: Esc closes it wherever focus is (the page behind is inert, focus may sit on body),
  // unless an Esc of its own came first: the editor cancelling, or the key list dialog closing
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented && document.body.classList.contains("desk-open") && !e.target.closest?.("textarea, input, dialog")) desk.closeDrawer();
  });
  // Space toggles play with focus in the broadcast or its controls (a single-key shortcut scoped to them,
  // WCAG 2.1.4); keyup is swallowed too so a focused button does not click as well. On the gear Space opens
  // the settings menu, in the menu it picks the item (a menu button), on the minimap it swaps the pictures.
  const spaceKey = (e) => e.code === "Space" && e.target.tagName !== "SELECT" && !!e.target.closest?.("#frame, #controls") && !e.target.closest('#settings-wrap, #radar, #proof-bar');
  window.addEventListener("keydown", (e) => {
    if (!spaceKey(e)) return;
    e.preventDefault();
    if (!e.repeat) pressPlay();
  }, true);
  window.addEventListener("keyup", (e) => { if (spaceKey(e)) e.preventDefault(); }, true);
  // the video player keys (keys.js), scoped as Space is; a key a control already used (the seek bar's arrows) is left to it
  const range = $("#seek-range");
  window.addEventListener("keydown", (e) => {
    const [act, x] = (!e.defaultPrevented && shortcut(e)) || [];
    if (!act) return;
    e.preventDefault();
    if (act === "play") pressPlay();
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

// The match picker in the masthead: the replays in data/matches.json (team names, no score). A pick loads
// that match in the same language and view.
async function matchPicker() {
  const sel = $("#mh-teams");
  let rows = [];
  try { const r = await fetch("data/matches.json"); if (r.ok) rows = await r.json(); } catch { /* the current match only */ }
  if (!rows.some((r) => r.match_id === matchId)) rows = [{ match_id: matchId, home: match.home.name, away: match.away.name }];
  sel.replaceChildren(...rows.map((r) => new Option(`${r.home} vs ${r.away}`, r.match_id, false, r.match_id === matchId)));
  sel.disabled = rows.length < 2;
  sel.addEventListener("change", () => {
    const p = new URLSearchParams(location.search);
    p.set("match", sel.value);
    p.set("lang", state.lang);
    if (view3d) p.set("view", view3d.mode);
    location.search = p;
  });
}

async function main() {
  applyStrings();
  checked("data-lang", state.lang);
  layout();
  $("#status").textContent = t("loading");
  const view = params.get("view") ?? defaultView(probe());
  if (view !== "2d") {
    warm3d().catch(() => {});   // View3D reports a failure when it asks again
    stage.classList.add("loading3d");   // the stadium still from the start; View3D takes it off once the scene is up
  }
  try {
    match = await loadMatch(`data/${matchId}`);
  } catch (err) {
    $("#status").textContent = t("error").replace("{m}", matchId).replace("{e}", err.message);
    return;
  }
  end = Math.max(match.duration, ...match.cues.map((c) => c.ts + c.duration_s));
  matchPicker();
  $("#mh-venue").textContent = match.meta.venue_name ?? "";
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
  // v_side: a card that can sit on either side (momentum, team shape) goes to the half of the frame away from the ball,
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
    // raw fact ids never go on air: they are debug codes to a viewer, and the desk evidence lists them
    vendorParams: () => ({ v_showFactIds: false, v_players: players, v_teams: teams, v_compact: compact, v_side: awayFromBall() }),
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
  // the menu's name for an audience: a player by his name, a team by its full name; null when not on the menu
  const audLabel = (aud) => {
    const b = document.querySelector(`#settings-menu [data-audience="${CSS.escape(aud)}"]`);
    return !b ? null : aud.startsWith("player:") ? b.dataset.short || b.textContent : b.textContent;
  };
  audBox = new AudienceBox($("#audiences"), desk, { label: audLabel, pick: setAudience });
  $("#status").textContent = "";
  buildSeekMarks();
  wireControls();
  layout(); // the team and player buttons may have changed the controls' height
  ask = new Ask($("#ask"), { matchId, state, t, button: $("#ask-open"), controls, maxTs: match.duration, onLayout: layout });
  proof = new Proof($("#proof-bar"), $("#proof"), { desk, match, state, pitch, view3d: () => view3d, onLayout: layout });
  refreshCues();
  // hooks for tests and the lead's demo scripts
  window.studioDesk = { state, match, host, desk, pitch, proof, countdown, get voice() { return voice; }, get booth() { return booth; }, seek, setPlaying, get end() { return end; } };
  // 3D with the 2D minimap (split), or one picture alone (?view=2d or 3d): ?view= or what the device can draw;
  // any change of view re-lays the page
  view3d = new View3D(match, { canvas: $("#view3d"), pitch: $("#pitch"), stage, radar: $("#radar"), badge: $("#replay-badge"),
    notice: $("#notice"), status: $("#view-status") }, layout, t);
  view3d.set(view);
  window.studioDesk.view3d = view3d;
  // a link to a moment: ?t= (match seconds), &audience=, &speed= (one of the menu's) and &play=1
  const aud = params.get("audience"), sp = params.get("speed");
  if (aud && document.querySelector(`[data-audience="${CSS.escape(aud)}"]`)) setAudience(aud);
  if (sp && document.querySelector(`[data-speed="${CSS.escape(sp)}"]`)) setSpeed(Number(sp));
  if (params.has("t") && Number.isFinite(Number(params.get("t")))) seek(Number(params.get("t")));
  if (params.get("play") === "1") setPlaying(true);
  // the shortcuts (Space, N) work at once; a visitor who already moved the focus keeps it
  if (document.activeElement === document.body) frame.focus();
  requestAnimationFrame(tick);
  await desk.load();
  const v = new Voice({ base: `data/${matchId}`, host, desk, state, t, button: $("#voice") });
  await Promise.all([v.load().then(() => { voice = v; }), desk.connect(), ask.probe()]); // the voice and Ask buttons may appear
  // the booth and the crowd follow the same button (docs/commentary.md)
  const b = new BoothAudio({ base: `data/${matchId}`, match, host, state, voice: v });
  if (await b.load()) {
    $("#voice").hidden = false;
    $("#voice").addEventListener("click", () => b.unlock());
    booth = b;
  }
}

main();
