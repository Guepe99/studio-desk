// Show proof: under the picture, one button per graphic on air. It opens a panel that says where each
// number on screen comes from (the fact, what it measures, its value and minute), the events the story
// cites and who checked it, and lights the cited players on the pitch (a ring in 2D, a name tag in 3D).
// Everything comes from the static pack (facts, events, stories) and the desk's own state: nothing is
// asked of a model. The numbers on screen are read from the text as it airs (with the producer's edits)
// and matched to the story's facts again here, the same rules as the verifier (studiodesk/agents/rules.py):
// a fact value within its rounding, a minute of a fact, a cited event or the moment, the score after a
// goal (or 0-0), a formation.
import { TEXT as DESK, tr, kindName, h, valueText } from "./desk.js";

const MAX_EVENTS = 6;     // a story citing more (a recap cites every pass) lists the events of its short facts
const SHORT_SOURCE = 3;   // a fact from up to 3 events (a shot, a goal) names them; a window of play does not

export const STRINGS = {
  en: {
    show: "Show proof: {what}", word: "Proof", bar: "Proof of the graphics on air", title: "Proof: {what}", close: "Close",
    onScreen: "The numbers on screen", noNumbers: "No numbers on screen: the graphic is drawn from the facts below.",
    valueOf: "{what}, {v} in minute {m}", minuteFact: "the minute of this fact: {what}", minuteEvent: "the minute of this event: {kind}",
    minuteStory: "the minute of the moment", scoreOf: "the score after the goal in minute {m}", scoreZero: "the score before any goal",
    unmatched: "not found in the facts of this story",
    facts: "The facts behind it", colWhat: "What it measures", colValue: "Value", colMinute: "Minute",
    events: "The events it cites", manyEvents: "It comes from many events of the match: the facts above sum them up.",
    moreEvents: "It also draws on more events of the match.", trackingOnly: "No single event: it is measured from the player tracking.",
    checked: "Who checked it", dtWriter: "Written by", w_ai: "The AI commentator", w_code: "Code, straight from the facts, no AI",
    dtNumbers: "Numbers check (code)", numbersOk: "Every number matches the fact ledger", numbersBad: "A number does not match the fact ledger",
    dtApproval: "On air because", ap_auto_approved: "Approved by the risk rule", ap_approved: "Approved by the producer",
    ap_edited: "Edited and approved by the producer", ap_template: "A template graphic needs no approval",
    offAir: "This graphic is no longer on air.",
  },
  it: {
    show: "Mostra le prove: {what}", word: "Prove", bar: "Le prove delle grafiche in onda", title: "Le prove: {what}", close: "Chiudi",
    onScreen: "I numeri sullo schermo", noNumbers: "Nessun numero sullo schermo: la grafica è disegnata dai fatti qui sotto.",
    valueOf: "{what}, {v} al minuto {m}", minuteFact: "il minuto di questo fatto: {what}", minuteEvent: "il minuto di questo evento: {kind}",
    minuteStory: "il minuto dell'azione", scoreOf: "il risultato dopo il gol al minuto {m}", scoreZero: "il risultato prima di ogni gol",
    unmatched: "non si trova nei fatti di questa storia",
    facts: "I fatti da cui viene", colWhat: "Cosa misura", colValue: "Valore", colMinute: "Minuto",
    events: "Gli eventi che cita", manyEvents: "Viene da molti eventi della partita: i fatti qui sopra li riassumono.",
    moreEvents: "Si basa anche su altri eventi della partita.", trackingOnly: "Nessun evento singolo: è misurato dal tracciamento dei giocatori.",
    checked: "Chi l'ha controllato", dtWriter: "Scritto da", w_ai: "Il commentatore IA", w_code: "Il codice, direttamente dai fatti, senza IA",
    dtNumbers: "Controllo dei numeri (codice)", numbersOk: "Ogni numero corrisponde al registro dei fatti", numbersBad: "Un numero non corrisponde al registro dei fatti",
    dtApproval: "In onda perché", ap_auto_approved: "Approvata dalla regola del rischio", ap_approved: "Approvata dalla regia",
    ap_edited: "Modificata e approvata dalla regia", ap_template: "Una grafica standard non ha bisogno di approvazione",
    offAir: "Questa grafica non è più in onda.",
  },
  es: {
    show: "Ver las pruebas: {what}", word: "Pruebas", bar: "Las pruebas de los gráficos en antena", title: "Las pruebas: {what}", close: "Cerrar",
    onScreen: "Las cifras en pantalla", noNumbers: "No hay cifras en pantalla: el gráfico se dibuja con los datos de abajo.",
    valueOf: "{what}, {v} en el minuto {m}", minuteFact: "el minuto de este dato: {what}", minuteEvent: "el minuto de este evento: {kind}",
    minuteStory: "el minuto de la jugada", scoreOf: "el marcador tras el gol del minuto {m}", scoreZero: "el marcador antes de cualquier gol",
    unmatched: "no aparece en los datos de esta historia",
    facts: "Los datos de los que sale", colWhat: "Qué mide", colValue: "Valor", colMinute: "Minuto",
    events: "Los eventos que cita", manyEvents: "Sale de muchos eventos del partido: los datos de arriba los resumen.",
    moreEvents: "También se basa en otros eventos del partido.", trackingOnly: "Ningún evento concreto: se mide con el seguimiento de los jugadores.",
    checked: "Quién lo comprobó", dtWriter: "Escrito por", w_ai: "El comentarista IA", w_code: "El código, directamente de los datos, sin IA",
    dtNumbers: "Control de las cifras (código)", numbersOk: "Cada cifra coincide con el registro de datos", numbersBad: "Una cifra no coincide con el registro de datos",
    dtApproval: "En antena porque", ap_auto_approved: "Aprobada por la regla de riesgo", ap_approved: "Aprobada por la realización",
    ap_edited: "Editada y aprobada por la realización", ap_template: "Un gráfico estándar no necesita aprobación",
    offAir: "Este gráfico ya no está en antena.",
  },
};

// What a fact measures and what an event is, in the viewer's language (the ledger's labels are English)
export const FACT_KINDS = {
  en: { ball_speed: "Ball speed", distance_covered: "Distance covered", formation: "Formation", line_height: "Defensive line height",
    momentum: "Momentum", pass_accuracy: "Pass completion", pass_difficulty: "Pass difficulty", pass_distance: "Pass length",
    press_intensity: "Pressing intensity", score: "Score", shot_distance: "Shot distance", shot_speed: "Shot speed", sprint_count: "Sprints",
    sprint_speed: "Sprint speed", team_length: "Team length", team_width: "Team width", xt_added: "Threat added (xT)" },
  it: { ball_speed: "Velocità della palla", distance_covered: "Distanza percorsa", formation: "Modulo", line_height: "Altezza della linea difensiva",
    momentum: "Inerzia", pass_accuracy: "Precisione nei passaggi", pass_difficulty: "Difficoltà del passaggio", pass_distance: "Lunghezza del passaggio",
    press_intensity: "Intensità del pressing", score: "Risultato", shot_distance: "Distanza del tiro", shot_speed: "Velocità del tiro", sprint_count: "Scatti",
    sprint_speed: "Velocità nello scatto", team_length: "Lunghezza della squadra", team_width: "Ampiezza della squadra", xt_added: "Pericolosità aggiunta (xT)" },
  es: { ball_speed: "Velocidad del balón", distance_covered: "Distancia recorrida", formation: "Sistema", line_height: "Altura de la línea defensiva",
    momentum: "Dominio", pass_accuracy: "Precisión en el pase", pass_difficulty: "Dificultad del pase", pass_distance: "Longitud del pase",
    press_intensity: "Intensidad de la presión", score: "Marcador", shot_distance: "Distancia del disparo", shot_speed: "Velocidad del disparo", sprint_count: "Sprints",
    sprint_speed: "Velocidad en sprint", team_length: "Longitud del equipo", team_width: "Anchura del equipo", xt_added: "Amenaza añadida (xT)" },
};
export const EVENT_KINDS = {
  en: { clearance: "Clearance", corner_crossed: "Corner into the box", corner_short: "Short corner", cross: "Cross", dribble: "Run with the ball",
    foul: "Foul", freekick_crossed: "Free kick into the box", freekick_short: "Short free kick", goalkick: "Goal kick", interception: "Interception",
    keeper_claim: "Keeper claim", keeper_save: "Save", pass: "Pass", shot: "Shot", goal: "Goal", tackle: "Tackle", take_on: "Take-on", throw_in: "Throw-in" },
  it: { clearance: "Rinvio", corner_crossed: "Calcio d'angolo in area", corner_short: "Calcio d'angolo corto", cross: "Cross", dribble: "Conduzione",
    foul: "Fallo", freekick_crossed: "Punizione in area", freekick_short: "Punizione corta", goalkick: "Rimessa dal fondo", interception: "Intercetto",
    keeper_claim: "Presa del portiere", keeper_save: "Parata", pass: "Passaggio", shot: "Tiro", goal: "Gol", tackle: "Contrasto", take_on: "Dribbling", throw_in: "Rimessa laterale" },
  es: { clearance: "Despeje", corner_crossed: "Córner al área", corner_short: "Córner en corto", cross: "Centro", dribble: "Conducción",
    foul: "Falta", freekick_crossed: "Falta al área", freekick_short: "Falta en corto", goalkick: "Saque de puerta", interception: "Intercepción",
    keeper_claim: "Blocaje del portero", keeper_save: "Parada", pass: "Pase", shot: "Disparo", goal: "Gol", tackle: "Entrada", take_on: "Regate", throw_in: "Saque de banda" },
};

export function px(lang, key, vars = {}) {
  const s = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}
const plainName = (k) => String(k).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
export const factKind = (k, lang) => FACT_KINDS[lang]?.[k] ?? FACT_KINDS.en[k] ?? plainName(k);
// a shot that went in is a goal (SPADL: result "success")
export const eventKind = (e, lang) => {
  const k = e.type_name === "shot" && e.result_name === "success" ? "goal" : e.type_name;
  return EVENT_KINDS[lang]?.[k] ?? EVENT_KINDS.en[k] ?? plainName(k);
};

const list = (v) => (Array.isArray(v) ? v : []);

// The text a graphic puts on screen, as the graphic writes its numbers (web/graphics/<name>/graphic.mjs);
// the shirt number on a name plate or a lower third is not a stat and is left out.
export function onAirText(cue) {
  const p = cue.payload ?? {};
  if (cue.graphic === "why_card") return `${p.title ?? ""}\n${p.body ?? ""}`;
  if (cue.graphic === "pass_shot") {
    const big = Number.isFinite(p.value) ? (p.value >= 100 ? p.value.toFixed(0) : p.value.toFixed(1)) : "";
    return `${big} ${p.unit ?? ""}\n${typeof p.quality === "string" ? p.quality : ""}`.trim();
  }
  if (cue.graphic === "nameplate") return Number.isFinite(p.speed_kmh) ? `${p.speed_kmh.toFixed(1)} km/h` : "";
  return ""; // momentum: bars, no numbers
}

// The numbers in a text, each with what it reads as: a minute ("10'", "45+2'", "8th minute", "minuto 8"),
// a formation (4-3-3), a score (2-1) or a value (33.8, 8,5/10 with the /10 kept, 83 and the unit after it).
const TOKEN = /(\d+)\+(\d+)\s?['’′]|\b(\d+)(?:st|nd|rd|th) minute\b|\bminut[oe] (\d+)\b|\b(\d(?:-\d){2,4})\b|\b(\d+) ?- ?(\d+)\b|(\d+(?:[.,]\d+)?)( ?\/ ?10\b)?( ?['’′])?/g;
export function numbersIn(text) {
  const out = [];
  for (const m of String(text).matchAll(TOKEN)) {
    const [all, a, b, ord, mi, form, s1, s2, num, ten, mark] = m;
    const tok = { text: all.trim() };
    if (a) Object.assign(tok, { kind: "minute", m: `${a}+${b}` });
    else if (ord || mi) Object.assign(tok, { kind: "minute", m: ord ?? mi });
    else if (form) Object.assign(tok, { kind: "formation", digits: form.replace(/-/g, "") });
    else if (s1) Object.assign(tok, { kind: "score", pair: [Number(s1), Number(s2)] });
    else if (mark) Object.assign(tok, { kind: "minute", m: num });
    else {
      const after = text.slice(m.index + all.length).trimStart();
      const unit = ten ? "/10" : /^km\/h/.test(after) ? "km/h" : /^km\b/.test(after) ? "km" : /^m\b/.test(after) ? "m" : after.startsWith("%") ? "%" : "";
      Object.assign(tok, { kind: "value", n: Number(num.replace(",", ".")), d: (num.split(/[.,]/)[1] ?? "").length, unit });
    }
    out.push(tok);
  }
  return out;
}

// A fact value as the panel shows it: a score as the score it made, a momentum index as the number
export function factValue(f, match, lang) {
  if (f.kind === "score") return match.score(f.ts).join("-");
  if (f.unit === "index") return valueText({ ...f, unit: "" }, lang);
  return valueText(f, lang);
}

const near = (v, n, d) => Math.abs(v - n) <= 0.5 * 10 ** -d + 1e-9;
const sameScore = (p, [a, b]) => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a);

// Where one number on screen comes from: {fact} | {event} | {story} | {zero} | null (not in the story's facts)
function sourceOf(tok, { facts, events, story, match, minute }) {
  const known = facts.filter((f) => !f.missing);
  if (tok.kind === "minute") {
    const f = known.find((x) => minute(x.ts) === tok.m);
    if (f) return { fact: f };
    const e = events.find((x) => minute(x.ts) === tok.m);
    if (e) return { event: e };
    return story && minute(story.ts) === tok.m ? { story: true } : null;
  }
  if (tok.kind === "score") {
    const f = known.find((x) => x.kind === "score" && sameScore(match.score(x.ts), tok.pair));
    return f ? { fact: f } : tok.pair[0] === 0 && tok.pair[1] === 0 ? { zero: true } : null;
  }
  if (tok.kind === "formation") {
    const f = known.find((x) => x.unit === "formation" && String(Math.round(x.value)) === tok.digits);
    return f ? { fact: f } : null;
  }
  const f = known.find((x) => {
    const v = Number(x.value);
    if (tok.unit === "km") return x.unit === "m" && near(v / 1000, tok.n, tok.d);
    if (!near(v, tok.n, tok.d)) return false;
    if (tok.unit === "/10") return x.unit === "/10" || x.unit === "index";
    return !tok.unit || tok.unit === x.unit;
  });
  return f ? { fact: f } : null;
}

// The proof of one cue on air, without words: the facts it cites, the numbers on screen with their
// source, the events to list, the players to light, and who wrote and passed it.
// ctx: {story (null for a template graphic), factIndex, eventIndex, match, minute (ts -> "10" or "45+2"), status}
export function proofOf(cue, { story, factIndex, eventIndex, match, minute, status }) {
  const p = cue.payload ?? {};
  const ids = story ? list(story.fact_ids) : list(p.fact_ids).length ? p.fact_ids : p.fact_id ? [p.fact_id] : [];
  const facts = [...new Set(ids)].map((id) => factIndex.get(id) ?? { fact_id: id, missing: true });
  const known = facts.filter((f) => !f.missing);
  const cited = story ? list(story.evidence_event_ids) : [...new Set(known.flatMap((f) => list(f.source_event_ids)))];
  const allEvents = cited.map((id) => eventIndex.get(id)).filter(Boolean);
  let shown = allEvents;
  if (shown.length > MAX_EVENTS) {
    const short = new Set(known.flatMap((f) => (list(f.source_event_ids).length <= SHORT_SOURCE ? f.source_event_ids : [])));
    shown = allEvents.filter((e) => short.has(e.event_id)).slice(0, MAX_EVENTS);
  }
  shown = [...shown].sort((a, b) => a.ts - b.ts);
  const numbers = numbersIn(onAirText(cue)).map((tok) => ({ ...tok, src: sourceOf(tok, { facts, events: allEvents, story, match, minute }) }));
  const players = new Set([story?.player_id, p.player_id, ...known.map((f) => f.player_id), ...shown.map((e) => e.player_id)]
    .filter((id) => id && match.players[id]));
  const v = story?.verifier ?? {};
  return {
    cue, story, facts, numbers, events: shown, more: allEvents.length > shown.length, players,
    writer: !story ? "code" : v.on_air ?? "ai",       // "phrasebook" | "template" | "ai" | "code" (a template graphic)
    verifier: story && !v.on_air ? v.status ?? null : null,   // the verifier passed the AI's own line; a phrasebook line is code
    safety: story?.safety ?? null,
    approval: story ? status : "template",
    numbersOk: numbers.every((x) => x.src),
  };
}

const minuteMark = (m) => `${m}'`;

// The words of a proof, in a language: [{text, ...}] rows ready to render (and to test without a DOM)
export function proofWords(pr, { match, minute, lang, what }) {
  const subject = (f) => (f.kind !== "score" && f.player_id ? match.players[f.player_id]?.name : match.teams[f.team_id]?.name) ?? "";
  const factWhat = (f) => [factKind(f.kind, lang), subject(f)].filter(Boolean).join(", ");
  const numberLine = ({ text, kind, src }) => {
    if (!src) return { text, about: px(lang, "unmatched"), ok: false };
    if (src.zero) return { text, about: px(lang, "scoreZero"), ok: true };
    if (src.story) return { text, about: px(lang, "minuteStory"), ok: true };
    if (src.event) return { text, about: px(lang, "minuteEvent", { kind: eventKind(src.event, lang) }), ok: true };
    const f = src.fact;
    if (kind === "minute") return { text, about: px(lang, "minuteFact", { what: factWhat(f) }), ok: true };
    if (kind === "score") return { text, about: px(lang, "scoreOf", { m: minute(f.ts) }), ok: true };
    return { text, about: px(lang, "valueOf", { what: factWhat(f), v: factValue(f, match, lang), m: minute(f.ts) }), ok: true };
  };
  const d = (k) => tr(lang, k);
  return {
    title: px(lang, "title", { what }),
    numbers: pr.numbers.map(numberLine),
    facts: pr.facts.map((f) => (f.missing ? { what: tr(lang, "notInLedger"), value: "", minute: "", missing: true }
      : { what: factWhat(f), value: factValue(f, match, lang), minute: minuteMark(minute(f.ts)) })),
    events: pr.events.map((e) => ({ minute: minuteMark(minute(e.ts)), kind: eventKind(e, lang), player: match.players[e.player_id]?.name ?? "" })),
    eventsNote: pr.events.length ? (pr.more ? px(lang, "moreEvents") : "") : px(lang, pr.more ? "manyEvents" : "trackingOnly"),
    checks: [
      [px(lang, "dtWriter"), pr.writer === "ai" ? px(lang, "w_ai") : pr.writer === "code" ? px(lang, "w_code") : DESK.en[`air_${pr.writer}`] ? d(`air_${pr.writer}`) : pr.writer],
      [px(lang, "dtNumbers"), px(lang, pr.numbersOk ? "numbersOk" : "numbersBad")],
      pr.verifier ? [d("dtVerifier"), DESK.en[`v_${pr.verifier}`] ? d(`v_${pr.verifier}`) : pr.verifier] : null,
      pr.safety ? [d("dtSafety"), DESK.en[`s_${pr.safety}`] ? d(`s_${pr.safety}`) : pr.safety] : null,
      [px(lang, "dtApproval"), px(lang, `ap_${pr.approval}`)],
    ].filter(Boolean),
  };
}

// The bar of buttons under the picture and the panel they open. Driven by app.js each frame.
export class Proof {
  // bar: the button row in #controls; panel: the #proof section; ctx: {desk, match, state, pitch, view3d: () => View3D, onLayout}
  constructor(bar, panel, ctx) {
    Object.assign(this, { bar, panel, ...ctx });
    this.live = [];          // the cues on air, as the bar shows them
    this.openId = null;      // the cue whose proof is open
    this.key = "";
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); this.close(); } });
    bar.addEventListener("keydown", (e) => { if (e.key === "Escape" && this.openId) { e.preventDefault(); this.close(); } });
  }

  ctx(cue) {
    const story = cue.story_id ? this.desk.byId.get(cue.story_id) ?? null : null;
    return { story, factIndex: this.desk.factIndex, eventIndex: this.desk.eventIndex, match: this.match,
      // the verifier's minute (rules.py): a fact at 300.0 s closes minute 5
      minute: (ts) => this.desk.clockText(Math.max(0, ts - 1e-6)), status: story ? this.desk.status(story) : null };
  }
  what(cue) {
    const s = cue.story_id && this.desk.byId.get(cue.story_id);
    return s ? this.desk.what(s) : this.desk.cueWhat(cue);
  }

  // The cues on air now (host.live): a new set or a new language redraws the bar
  update(cues) {
    const lang = this.state.lang, key = `${lang}|${cues.map((c) => c.cue_id).join(",")}`;
    if (key === this.key) return;
    this.key = key;
    this.live = [...cues].sort((a, b) => a.ts - b.ts || String(a.cue_id).localeCompare(String(b.cue_id)));
    // a new language or audience airs the same graphic as another cue: the open proof follows it
    const same = this.openId && !this.live.some((c) => c.cue_id === this.openId)
      && this.live.find((c) => c.story_id === this.cue.story_id && c.graphic === this.cue.graphic && c.ts === this.cue.ts);
    if (same) { this.openId = same.cue_id; this.cue = same; }
    const focused = this.bar.contains(document.activeElement) ? document.activeElement.dataset.cue : null;
    this.bar.lang = lang;
    this.bar.setAttribute("aria-label", px(lang, "bar"));
    this.bar.replaceChildren(...this.live.map((c) => h("button", {
      type: "button", className: "ctl proof-chip", "data-cue": c.cue_id, "aria-controls": "proof", "aria-expanded": String(this.openId === c.cue_id),
      "aria-label": px(lang, "show", { what: this.what(c) }), onclick: () => (this.openId === c.cue_id ? this.close() : this.open(c.cue_id)),
    }, h("svg:svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, h("svg:path", { d: "M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z" })),
    h("span", { className: "pf-word" }, px(lang, "word")), h("span", { className: "pf-what" }, this.what(c)))));
    if (focused) this.bar.querySelector(`[data-cue="${CSS.escape(focused)}"]`)?.focus();
    if (this.openId) this.render();   // the language changed, or the graphic left the air (the panel says so)
  }

  open(id) {
    this.openId = id;
    this.cue = this.live.find((c) => c.cue_id === id) ?? this.cue;
    this.panel.hidden = false;
    this.key = "";
    this.update(this.live);   // the buttons' state, and the panel
    this.onLayout();
    this.panel.querySelector("h2").focus({ preventScroll: true });
    requestAnimationFrame(() => this.panel.scrollIntoView({ block: "nearest" }));
  }

  close() {
    const id = this.openId;
    this.openId = null;
    this.panel.hidden = true;
    this.highlight(new Set());
    this.key = "";
    this.update(this.live);
    this.onLayout();
    // back to its button, or to the picture when the graphic has gone
    (this.bar.querySelector(`[data-cue="${CSS.escape(id ?? "")}"]`) ?? document.querySelector("#frame"))?.focus();
  }

  highlight(ids) {
    this.pitch.cited = ids;
    this.view3d()?.setCited(ids);
  }

  render() {
    const cue = this.cue, lang = this.state.lang, c = this.ctx(cue);
    const pr = proofOf(cue, c), w = proofWords(pr, { match: this.match, minute: c.minute, lang, what: this.what(cue) });
    this.proof = pr;
    this.highlight(pr.players);
    const onAir = this.live.some((x) => x.cue_id === cue.cue_id);
    this.panel.lang = lang;
    this.panel.replaceChildren(...[
      h("div", { className: "proof-head" }, h("h2", { id: "proof-title", tabindex: "-1" }, w.title),
        h("button", { type: "button", className: "ctl proof-close", onclick: () => this.close() }, px(lang, "close"))),
      onAir ? null : h("p", { className: "proof-off" }, px(lang, "offAir")),
      h("h3", {}, px(lang, "onScreen")),
      w.numbers.length ? h("ul", { className: "proof-nums" }, w.numbers.map((n) => h("li", { className: n.ok ? "" : "bad" },
        h("b", {}, n.text), " ", n.about))) : h("p", { className: "proof-note" }, px(lang, "noNumbers")),
      h("h3", {}, px(lang, "facts")),
      h("table", { className: "proof-facts" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, px(lang, "colWhat")), h("th", { scope: "col" }, px(lang, "colValue")), h("th", { scope: "col" }, px(lang, "colMinute")))),
        h("tbody", {}, w.facts.map((f) => h("tr", { className: f.missing ? "missing" : "" }, h("td", {}, f.what), h("td", { className: "num" }, f.value), h("td", { className: "num" }, f.minute))))),
      h("h3", {}, px(lang, "events")),
      w.events.length ? h("ul", { className: "proof-events" }, w.events.map((e) => h("li", {}, h("b", {}, e.minute), " ", e.kind, e.player ? `, ${e.player}` : ""))) : null,
      w.eventsNote ? h("p", { className: "proof-note" }, w.eventsNote) : null,
      h("h3", {}, px(lang, "checked")),
      h("dl", { className: "proof-checks" }, w.checks.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))),
    ].filter(Boolean));   // replaceChildren writes a null as the text "null"
  }
}
