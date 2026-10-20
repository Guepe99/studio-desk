// Control desk: the candidate stories with their evidence, approve / edit / reject, the AI kill
// switch, the audit log and the agent traces (docs/CONTRACT.md, Runtime records and API).
//
// One rule decides what goes on air: a story below the risk threshold is auto-approved and plays
// unless this visitor rejects it; a story that needs review, or that Content Safety flagged, is held
// until this visitor approves it. Only auto_approved, approved and edited go on air: any other or
// missing status is held. With the AI switched off only template graphics (story_id null) play.
// Decisions come from the API (per visitor, cookie sd_session); with static hosting, or when the API
// does not answer within API_TIMEOUT_MS (CONNECT_TRIES times), they are kept in memory for the tab.
// The desk's controls stay disabled until that is settled, and while a save is in flight: one request
// at a time, so saves never cross and a server reply never undoes what the visitor did meanwhile.

const LANGS = ["en", "it", "es"];
// Every string the desk shows, in the three page languages. Agent output (trace text, steps, model
// names, the analyst's note, fact labels) stays English and is marked lang="en" where it is shown.
// A value is a string with {name} slots, or a function of the slots for a count that needs a plural.
export const TEXT = {
  en: {
    title: "Control desk", close: "Close", closeLabel: "Close the control desk",
    purpose: "The agents write these graphics. Nothing they write goes on air until you or the risk rule approve it.",
    ai: "AI graphics ", on: "on", off: "off", loadingDecisions: "Loading your decisions", saving: "Saving",
    waiting: "{n} of {m} waiting for review", tabs: "Desk views", tabStories: "Stories", tabAudit: "Audit log", tabTraces: "Traces",
    kill: "AI off: only template graphics are on air. Stories stay listed for review.",
    footConnecting: "Connecting to the server: the desk unlocks once your saved decisions are in.",
    footOnline: "Your decisions are saved for this browser only. Other visitors see the original replay.",
    footOffline: "Decisions are kept in this tab only. {why}", footNoServer: "No server: decisions are kept in this tab only.",
    timeout: "The server did not answer in time.", notSaved: "Not saved: {why}", badChar: "the text has a character the desk does not accept",
    deskName: "Desk", deskWaiting: "{n} waiting for review", offline: "offline",
    loadingStories: "Loading stories.",
    noStories: "No AI stories in this replay yet. The template graphics play on their own; stories appear here once the agents have run on the match.",
    onair: "On air", held: "Held", offair: "Off air", offairKill: "Off air, AI off", goMinute: "Go to minute {m}", goTitle: "Go to this moment",
    st_auto_approved: "Auto-approved", st_needs_review: "Needs review", st_approved: "Approved", st_edited: "Edited and approved", st_rejected: "Rejected",
    defaultWas: "default: {s}", heldSafety: "held: flagged by Content Safety",
    risk_low: "Low risk", risk_mid: "Medium risk", risk_high: "High risk", riskTitle: "Risk score {r}. Below {t} a story goes on air by itself.",
    tip_low: "The risk rule puts it on air by itself. Reject it if something looks wrong.",
    tip_lowHeld: "Held for a safety check: read it before you put it on air.",
    tip_mid: "Check the names and numbers against the evidence before it goes on air.",
    tip_high: "Read the evidence and the notes first. Reject it if a claim does not match.",
    dtOnAir: "On air", dtDraft: "AI draft", dtVerifier: "Verifier", dtSafety: "Safety", none: "none",
    attempts: ({ n }) => `, ${n} attempt${n > 1 ? "s" : ""}`,
    v_pass: "Pass", v_rewritten: "Rewritten", v_template: "Template line", air_phrasebook: "Phrasebook (code)", air_template: "Template line (code)",
    d_pass: "Pass", d_rewritten: "Rewritten", d_template: "Not usable",
    n_rewritten: "What the earlier drafts got wrong", n_template: "Why the fact-only sentence",
    dn_rewritten: "What the earlier AI drafts got wrong", dn_template: "Why the AI drafts were not kept", notes: "Verifier notes",
    s_passed: "Passed", s_flagged: "Flagged", s_not_checked: "Not checked",
    evidence: ({ f, e }) => `Evidence: ${f} fact${f === 1 ? "" : "s"}, ${e} event${e === 1 ? "" : "s"}`,
    put: "Put on air", keep: "Keep on air", approve: "Approve", edit: "Edit", reject: "Reject", showTrace: "Show trace",
    actLabel: "{label}: {kind} at minute {m}",
    proposalOn: "AI proposal, on air: ", proposalOff: "AI proposal, not on air: ", useProposal: "Use proposal",
    lang_en: "English", lang_it: "Italian", lang_es: "Spanish", emptyText: "The {name} text cannot be empty. Reject the story to keep it off air.",
    cancel: "Cancel", saveApprove: "Save and approve",
    done_approved: "{what} approved, on air", done_kept: "{what} kept on air", done_edited: "{what} edited, on air",
    done_approvedKill: "{what} approved, on air once AI graphics are back on", done_keptKill: "{what} approved, on air once AI graphics are back on",
    done_editedKill: "{what} edited, on air once AI graphics are back on", done_rejected: "{what} rejected, off air",
    undo: "Undo", undoLabel: "Undo: {what}", undone_onair: "Undone: {what} is on air again", undone_held: "Undone: {what} is held again",
    undone_off: "Undone: {what} is off air again",
    factsCaption: "Facts cited by the story", fact: "Fact", value: "Value", notInLedger: "not in the ledger", events: "Events ", analyst: "Analyst: ",
    goals: ({ n }) => `${n} goal${n === "1" ? "" : "s"}`,
    pitch: ({ n, run }) => `Pitch map: ${n} evidence event${n === 1 ? "" : "s"}${run ? " and the run behind a speed fact" : ""}`,
    calls: "model calls", tokens: "tokens", cost: "model cost", yours: "of your actions", logCaption: "Audit log, newest first",
    colUtc: "UTC", colWho: "Who", colWhat: "What", colModel: "Model", colCost: "Tokens and cost",
    a_ai_off: "switched AI graphics off", a_ai_on: "switched AI graphics on", a_ask: "your question, {s}", a_auto: "auto-approved, risk {r} below {t}",
    a_approved: "approved", a_edited: "edited", a_rejected: "rejected", a_undo: "undid the last action",
    auditEmpty: "Nothing logged yet. Put a story on air, edit it or reject it and it shows up here.",
    pipeline: "How a story is made", noTraces: "No agent traces in this replay yet.", wholeRun: "Whole run", showStory: "Show story",
    traceSum: ({ n, tok, usd, s }) => `${n} hand-off${n === "1" ? "" : "s"}, ${tok} tokens, ${usd}, ${s} s`,
    traceShared: ({ n }) => `, counting this story's share of the ${n} shared with other stories`,
    rulesNoModel: "rules, no model", codeNoModel: "code, no model", in: "In", out: "Out",
    tokInOut: "{a} in, {b} out", zeroTokens: "0 tokens", sharedBy: ({ n }) => `, shared by ${n} stories`,
    how_ai: "AI", how_codeai: "Code and AI", how_rules: "Rules",
    ag_story_finder: "Story finder", ag_analyst: "Analyst", ag_commentator: "Commentator", ag_verifier: "Verifier", ag_director: "Director",
    ag_human: "You", ag_auto: "Risk rule", ag_studio_host: "Studio host",
    role_story_finder: "Picks moments from the events the match clock releases.",
    role_analyst: "Explains why the moment matters, citing fact ids.",
    role_commentator: "Writes the lines in English, Italian and Spanish.",
    role_verifier: "Checks every number against the fact ledger; rewrites twice at most, then a template line.",
    role_director: "Picks graphic, time and audience; never more than 2 on screen.",
    k_goal: "Goal", k_key_pass: "Key pass", k_momentum_swing: "Momentum swing", k_comeback: "Comeback", k_top_sprint: "Top sprint",
    k_high_press: "High press", k_tactical_shift: "Tactical shift", k_big_chance: "Big chance", k_pressing_spell: "Pressing spell", k_recap: "Recap",
  },
  it: {
    title: "Regia", close: "Chiudi", closeLabel: "Chiudi la regia",
    purpose: "Queste grafiche le scrivono gli agenti. Niente di ciò che scrivono va in onda finché non lo approvi tu o la regola del rischio.",
    ai: "Grafiche IA ", on: "accese", off: "spente", loadingDecisions: "Caricamento delle tue decisioni", saving: "Salvataggio",
    waiting: "{n} di {m} da rivedere", tabs: "Viste della regia", tabStories: "Storie", tabAudit: "Registro", tabTraces: "Tracce",
    kill: "IA spenta: in onda solo le grafiche standard. Le storie restano in elenco da rivedere.",
    footConnecting: "Connessione al server: la regia si sblocca quando arrivano le tue decisioni salvate.",
    footOnline: "Le tue decisioni sono salvate solo per questo browser. Gli altri visitatori vedono il replay originale.",
    footOffline: "Le decisioni restano solo in questa scheda. {why}", footNoServer: "Nessun server: le decisioni restano solo in questa scheda.",
    timeout: "Il server non ha risposto in tempo.", notSaved: "Non salvato: {why}", badChar: "il testo contiene un carattere che la regia non accetta",
    deskName: "Regia", deskWaiting: "{n} da rivedere", offline: "offline",
    loadingStories: "Caricamento delle storie.",
    noStories: "Ancora nessuna storia IA in questo replay. Le grafiche standard vanno in onda da sole; le storie compaiono qui dopo che gli agenti hanno lavorato sulla partita.",
    onair: "In onda", held: "In attesa", offair: "Fuori onda", offairKill: "Fuori onda, IA spenta", goMinute: "Vai al minuto {m}", goTitle: "Vai a questo momento",
    st_auto_approved: "Approvata in automatico", st_needs_review: "Da rivedere", st_approved: "Approvata", st_edited: "Modificata e approvata", st_rejected: "Respinta",
    defaultWas: "di partenza: {s}", heldSafety: "in attesa: segnalata da Content Safety",
    risk_low: "Rischio basso", risk_mid: "Rischio medio", risk_high: "Rischio alto", riskTitle: "Punteggio di rischio {r}. Sotto {t} una storia va in onda da sola.",
    tip_low: "La regola del rischio la manda in onda da sola. Respingila se qualcosa non torna.",
    tip_lowHeld: "In attesa di un controllo di sicurezza: leggila prima di mandarla in onda.",
    tip_mid: "Controlla nomi e numeri sulle prove prima che vada in onda.",
    tip_high: "Leggi prima le prove e le note. Respingila se un'affermazione non corrisponde.",
    dtOnAir: "In onda", dtDraft: "Bozza IA", dtVerifier: "Verificatore", dtSafety: "Sicurezza", none: "nessuno",
    attempts: ({ n }) => `, ${n} tentativ${n > 1 ? "i" : "o"}`,
    v_pass: "Superato", v_rewritten: "Riscritto", v_template: "Frase modello", air_phrasebook: "Frasario (codice)", air_template: "Frase modello (codice)",
    d_pass: "Superata", d_rewritten: "Riscritta", d_template: "Non usabile",
    n_rewritten: "Cosa sbagliavano le bozze precedenti", n_template: "Perché la frase con i soli fatti",
    dn_rewritten: "Cosa sbagliavano le bozze IA precedenti", dn_template: "Perché le bozze IA sono state scartate", notes: "Note del verificatore",
    s_passed: "Superato", s_flagged: "Segnalato", s_not_checked: "Non controllato",
    evidence: ({ f, e }) => `Prove: ${f} fatt${f === 1 ? "o" : "i"}, ${e} event${e === 1 ? "o" : "i"}`,
    put: "Manda in onda", keep: "Tieni in onda", approve: "Approva", edit: "Modifica", reject: "Respingi", showTrace: "Mostra la traccia",
    actLabel: "{label}: {kind} al minuto {m}",
    proposalOn: "Proposta IA, in onda: ", proposalOff: "Proposta IA, non in onda: ", useProposal: "Usa la proposta",
    lang_en: "Inglese", lang_it: "Italiano", lang_es: "Spagnolo", emptyText: "Il testo ({name}) non può essere vuoto. Respingi la storia per tenerla fuori onda.",
    cancel: "Annulla", saveApprove: "Salva e approva",
    done_approved: "Approvazione salvata: {what} in onda", done_kept: "Approvazione salvata: {what} resta in onda", done_edited: "Modifica salvata: {what} in onda",
    done_approvedKill: "Approvazione salvata: {what} andrà in onda quando riaccendi le grafiche IA",
    done_keptKill: "Approvazione salvata: {what} andrà in onda quando riaccendi le grafiche IA",
    done_editedKill: "Modifica salvata: {what} andrà in onda quando riaccendi le grafiche IA", done_rejected: "Rifiuto salvato: {what} fuori onda",
    undo: "Annulla", undoLabel: "Annulla: {what}", undone_onair: "Annullato: {what} di nuovo in onda", undone_held: "Annullato: {what} di nuovo in attesa",
    undone_off: "Annullato: {what} di nuovo fuori onda",
    factsCaption: "Fatti citati dalla storia", fact: "Fatto", value: "Valore", notInLedger: "non nel registro dei fatti", events: "Eventi ", analyst: "Analista: ",
    goals: ({ n }) => `${n} gol`,
    pitch: ({ n, run }) => `Mappa del campo: ${n} event${n === 1 ? "o" : "i"} di prova${run ? " e la corsa dietro un dato di velocità" : ""}`,
    calls: "chiamate al modello", tokens: "token", cost: "costo dei modelli", yours: "azioni tue", logCaption: "Registro, dal più recente",
    colUtc: "UTC", colWho: "Chi", colWhat: "Cosa", colModel: "Modello", colCost: "Token e costo",
    a_ai_off: "ha spento le grafiche IA", a_ai_on: "ha acceso le grafiche IA", a_ask: "la tua domanda, {s}", a_auto: "approvata in automatico, rischio {r} sotto {t}",
    a_approved: "approvata", a_edited: "modificata", a_rejected: "respinta", a_undo: "ha annullato l'ultima azione",
    auditEmpty: "Ancora niente nel registro. Manda in onda, modifica o respingi una storia e comparirà qui.",
    pipeline: "Come nasce una storia", noTraces: "Ancora nessuna traccia degli agenti in questo replay.", wholeRun: "Tutto il giro", showStory: "Mostra la storia",
    traceSum: ({ n, tok, usd, s }) => `${n} passaggi${n === "1" ? "o" : ""} di consegne, ${tok} token, ${usd}, ${s} s`,
    traceShared: ({ n }) => `, contando la quota di questa storia nei ${n} condivisi con altre storie`,
    rulesNoModel: "solo regole", codeNoModel: "solo codice", in: "Entrata", out: "Uscita",
    tokInOut: "{a} in entrata, {b} in uscita", zeroTokens: "0 token", sharedBy: ({ n }) => `, condiviso da ${n} storie`,
    how_ai: "IA", how_codeai: "Codice e IA", how_rules: "Regole",
    ag_story_finder: "Cerca storie", ag_analyst: "Analista", ag_commentator: "Commentatore", ag_verifier: "Verificatore", ag_director: "Regista",
    ag_human: "Tu", ag_auto: "Regola del rischio", ag_studio_host: "Conduttore",
    role_story_finder: "Sceglie i momenti tra gli eventi che l'orologio della partita rende disponibili.",
    role_analyst: "Spiega perché il momento conta, citando gli id dei fatti.",
    role_commentator: "Scrive le frasi in inglese, italiano e spagnolo.",
    role_verifier: "Controlla ogni numero sul registro dei fatti; riscrive al massimo due volte, poi usa una frase modello.",
    role_director: "Sceglie grafica, momento e pubblico; mai più di 2 sullo schermo.",
    k_goal: "Gol", k_key_pass: "Passaggio chiave", k_momentum_swing: "Cambio di inerzia", k_comeback: "Rimonta", k_top_sprint: "Scatto più veloce",
    k_high_press: "Pressing alto", k_tactical_shift: "Cambio tattico", k_big_chance: "Grande occasione", k_pressing_spell: "Fase di pressing", k_recap: "Riepilogo",
  },
  es: {
    title: "Mesa de control", close: "Cerrar", closeLabel: "Cerrar la mesa de control",
    purpose: "Estos gráficos los escriben los agentes. Nada de lo que escriben sale al aire hasta que lo apruebes tú o la regla de riesgo.",
    ai: "Gráficos de IA ", on: "encendidos", off: "apagados", loadingDecisions: "Cargando tus decisiones", saving: "Guardando",
    waiting: "{n} de {m} por revisar", tabs: "Vistas de la mesa", tabStories: "Historias", tabAudit: "Registro", tabTraces: "Trazas",
    kill: "IA apagada: solo los gráficos estándar están al aire. Las historias siguen en la lista para revisarlas.",
    footConnecting: "Conectando con el servidor: la mesa se desbloquea cuando lleguen tus decisiones guardadas.",
    footOnline: "Tus decisiones se guardan solo para este navegador. Los demás visitantes ven la repetición original.",
    footOffline: "Las decisiones se guardan solo en esta pestaña. {why}", footNoServer: "Sin servidor: las decisiones se guardan solo en esta pestaña.",
    timeout: "El servidor no respondió a tiempo.", notSaved: "No guardado: {why}", badChar: "el texto tiene un carácter que la mesa no acepta",
    deskName: "Mesa", deskWaiting: "{n} por revisar", offline: "sin conexión",
    loadingStories: "Cargando las historias.",
    noStories: "Todavía no hay historias de IA en esta repetición. Los gráficos estándar salen solos; las historias aparecen aquí cuando los agentes han trabajado sobre el partido.",
    onair: "Al aire", held: "En espera", offair: "Fuera del aire", offairKill: "Fuera del aire, IA apagada", goMinute: "Ir al minuto {m}", goTitle: "Ir a este momento",
    st_auto_approved: "Aprobada automáticamente", st_needs_review: "Por revisar", st_approved: "Aprobada", st_edited: "Editada y aprobada", st_rejected: "Rechazada",
    defaultWas: "de partida: {s}", heldSafety: "en espera: marcada por Content Safety",
    risk_low: "Riesgo bajo", risk_mid: "Riesgo medio", risk_high: "Riesgo alto", riskTitle: "Puntuación de riesgo {r}. Por debajo de {t} una historia sale al aire sola.",
    tip_low: "La regla de riesgo la pone al aire sola. Recházala si algo no cuadra.",
    tip_lowHeld: "En espera de un control de seguridad: léela antes de ponerla al aire.",
    tip_mid: "Comprueba los nombres y los números con las pruebas antes de que salga al aire.",
    tip_high: "Lee primero las pruebas y las notas. Recházala si una afirmación no coincide.",
    dtOnAir: "Al aire", dtDraft: "Borrador de IA", dtVerifier: "Verificador", dtSafety: "Seguridad", none: "ninguno",
    attempts: ({ n }) => `, ${n} intento${n > 1 ? "s" : ""}`,
    v_pass: "Superado", v_rewritten: "Reescrito", v_template: "Frase de plantilla", air_phrasebook: "Frasario (código)", air_template: "Frase de plantilla (código)",
    d_pass: "Superado", d_rewritten: "Reescrito", d_template: "No utilizable",
    n_rewritten: "Qué fallaba en los borradores anteriores", n_template: "Por qué la frase solo con datos",
    dn_rewritten: "Qué fallaba en los borradores de IA anteriores", dn_template: "Por qué se descartaron los borradores de IA", notes: "Notas del verificador",
    s_passed: "Superado", s_flagged: "Marcado", s_not_checked: "Sin comprobar",
    evidence: ({ f, e }) => `Pruebas: ${f} dato${f === 1 ? "" : "s"}, ${e} evento${e === 1 ? "" : "s"}`,
    put: "Poner al aire", keep: "Mantener al aire", approve: "Aprobar", edit: "Editar", reject: "Rechazar", showTrace: "Ver la traza",
    actLabel: "{label}: {kind} en el minuto {m}",
    proposalOn: "Propuesta de IA, al aire: ", proposalOff: "Propuesta de IA, no al aire: ", useProposal: "Usar la propuesta",
    lang_en: "Inglés", lang_it: "Italiano", lang_es: "Español", emptyText: "El texto ({name}) no puede quedar vacío. Rechaza la historia para dejarla fuera del aire.",
    cancel: "Cancelar", saveApprove: "Guardar y aprobar",
    done_approved: "Aprobación guardada: {what} al aire", done_kept: "Aprobación guardada: {what} sigue al aire", done_edited: "Cambio guardado: {what} al aire",
    done_approvedKill: "Aprobación guardada: {what} saldrá al aire cuando vuelvas a encender los gráficos de IA",
    done_keptKill: "Aprobación guardada: {what} saldrá al aire cuando vuelvas a encender los gráficos de IA",
    done_editedKill: "Cambio guardado: {what} saldrá al aire cuando vuelvas a encender los gráficos de IA", done_rejected: "Rechazo guardado: {what} fuera del aire",
    undo: "Deshacer", undoLabel: "Deshacer: {what}", undone_onair: "Deshecho: {what} otra vez al aire", undone_held: "Deshecho: {what} otra vez en espera",
    undone_off: "Deshecho: {what} otra vez fuera del aire",
    factsCaption: "Datos citados por la historia", fact: "Dato", value: "Valor", notInLedger: "no está en el registro de datos", events: "Eventos ", analyst: "Analista: ",
    goals: ({ n }) => `${n} gol${n === "1" ? "" : "es"}`,
    pitch: ({ n, run }) => `Mapa del campo: ${n} evento${n === 1 ? "" : "s"} de prueba${run ? " y la carrera detrás de un dato de velocidad" : ""}`,
    calls: "llamadas al modelo", tokens: "tokens", cost: "coste de los modelos", yours: "acciones tuyas", logCaption: "Registro, del más reciente",
    colUtc: "UTC", colWho: "Quién", colWhat: "Qué", colModel: "Modelo", colCost: "Tokens y coste",
    a_ai_off: "apagó los gráficos de IA", a_ai_on: "encendió los gráficos de IA", a_ask: "tu pregunta, {s}", a_auto: "aprobada automáticamente, riesgo {r} por debajo de {t}",
    a_approved: "aprobada", a_edited: "editada", a_rejected: "rechazada", a_undo: "deshizo la última acción",
    auditEmpty: "Todavía no hay nada en el registro. Pon una historia al aire, edítala o recházala y aparecerá aquí.",
    pipeline: "Cómo nace una historia", noTraces: "Todavía no hay trazas de los agentes en esta repetición.", wholeRun: "Toda la ejecución", showStory: "Ver la historia",
    traceSum: ({ n, tok, usd, s }) => `${n} relevo${n === "1" ? "" : "s"}, ${tok} tokens, ${usd}, ${s} s`,
    traceShared: ({ n }) => `, contando la parte de esta historia en los ${n} compartidos con otras historias`,
    rulesNoModel: "reglas, sin modelo", codeNoModel: "código, sin modelo", in: "Entrada", out: "Salida",
    tokInOut: "{a} de entrada, {b} de salida", zeroTokens: "0 tokens", sharedBy: ({ n }) => `, compartido por ${n} historias`,
    how_ai: "IA", how_codeai: "Código e IA", how_rules: "Reglas",
    ag_story_finder: "Buscahistorias", ag_analyst: "Analista", ag_commentator: "Comentarista", ag_verifier: "Verificador", ag_director: "Realizador",
    ag_human: "Tú", ag_auto: "Regla de riesgo", ag_studio_host: "Presentador",
    role_story_finder: "Elige los momentos entre los eventos que libera el reloj del partido.",
    role_analyst: "Explica por qué importa el momento, citando los id de los datos.",
    role_commentator: "Escribe las frases en inglés, italiano y español.",
    role_verifier: "Comprueba cada número con el registro de datos; reescribe dos veces como máximo y luego usa una frase de plantilla.",
    role_director: "Elige gráfico, momento y público; nunca más de 2 en pantalla.",
    k_goal: "Gol", k_key_pass: "Pase clave", k_momentum_swing: "Cambio de dominio", k_comeback: "Remontada", k_top_sprint: "Sprint más rápido",
    k_high_press: "Presión alta", k_tactical_shift: "Cambio táctico", k_big_chance: "Ocasión clara", k_pressing_spell: "Fase de presión", k_recap: "Resumen",
  },
};
/** A desk string in a page language, English when that language lacks it. */
export function tr(lang, key, vars = {}) {
  const v = TEXT[lang]?.[key] ?? TEXT.en[key];
  if (typeof v === "function") return v(vars);
  return v === undefined ? key : v.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}
const AGENTS = [["story_finder", "ai"], ["analyst", "ai"], ["commentator", "ai"], ["verifier", "codeai"], ["director", "rules"]];
const HOW = Object.fromEntries(AGENTS);
/** Display name of an agent id: commentator_it is "Commentator IT"; the desk's own actors (human,
 *  auto, studio_host) too. An id nobody named yet reads as words, never as a raw id. */
export const agentName = (agent, lang = "en") => {
  const [base, code] = String(agent).split(/_(?=[a-z]{2}$)/);
  const name = TEXT[lang]?.[`ag_${base}`] ?? TEXT.en[`ag_${base}`] ?? base.replace(/_/g, " ");
  return code ? `${name} ${code.toUpperCase()}` : name;
};
const AUTO_RISK = 0.35; // studiodesk/config.py AUTO_APPROVE_RISK
const HIGH_RISK = 0.6;  // ours: from here the reviewer reads the evidence before anything else
export const riskBand = (r) => (r < AUTO_RISK ? "low" : r < HIGH_RISK ? "mid" : "high"); // an unknown risk counts as high
const UNDO_MS = 10000;
const EDIT_MAX = 600; // studiodesk/api.py EDIT_MAX_CHARS
const ON_AIR = ["auto_approved", "approved", "edited"];
const API_TIMEOUT_MS = 4000;
const CONNECT_TRIES = 3; // a slow first answer (a cold container) is not a reason to work offline for the whole visit
const RUN_MAX_FRAMES = 300; // a sprint run longer than 30 s is not a sprint: never draw a whole-match path
const SVGNS = "http://www.w3.org/2000/svg";

const kindName = (k, lang) => TEXT[lang]?.[`k_${k}`] ?? TEXT.en[`k_${k}`] ?? String(k).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const usd = (v, lang = "en") => {
  const d = v >= 0.1 ? 2 : 4;
  return new Intl.NumberFormat(lang, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
};
const int = (v, lang = "en") => Number(v).toLocaleString(lang);
const dec = (v, lang, d) => Number(v).toLocaleString(lang, { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false });

// DOM builder: text always goes in as text nodes, never as markup.
function h(tag, attrs = {}, ...kids) {
  const el = tag.startsWith("svg:") ? document.createElementNS(SVGNS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k === "className" ? "class" : k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

// An array of row objects, or [] when the file is missing or malformed: bad data never stops the desk.
async function optionalRows(url, key) {
  try {
    const r = await fetch(url);
    const rows = r.ok ? await r.json() : [];
    return Array.isArray(rows) ? rows.filter((x) => x && typeof x === "object" && (!key || typeof x[key] === "string")) : [];
  } catch {
    return [];
  }
}

const list = (v) => (Array.isArray(v) ? v : []);

// A trace summary as shown: an exception's raw text becomes a short reason (the full text stays in the pack).
export function summaryText(text) {
  const s = String(text ?? "");
  const i = s.search(/ fallback: | failed: /);
  if (i < 0 || !/Exception|Error\(|Traceback|<class /.test(s.slice(i))) return s;
  const code = s.slice(i).match(/Error code: (\d{3})/)?.[1] ?? (/Timeout/.test(s.slice(i)) ? "timeout" : null);
  return `${s.slice(0, i)}${s.slice(i).startsWith(" fallback") ? " fallback" : " failed"}: model call failed${code ? ` (${code})` : ""}`;
}

// A failed step: the agents write " fallback: <why>" or "<what> failed: <why>", or log a "fallback" step.
export const traceFailed = (t) => t.step === "fallback" || /(^| )fallback: |\bfailed: /.test(String(t.output_summary ?? ""));

export class Desk {
  /** @param {HTMLElement} root  the #desk element
   *  @param {{match, matchId: string, state, seek: (ts: number) => void, onChange: () => void}} opts */
  constructor(root, opts) {
    Object.assign(this, opts);
    this.root = root;
    this.stories = [];
    this.traces = [];
    this.byId = new Map();
    this.decisions = new Map(); // story_id -> {decision, edited_text, at}
    this.kill = false;
    this.online = false;
    this.offline = "";   // why decisions stay in this tab, when the API refused or did not answer
    this.ready = false;  // connect() has settled, online or not: until then the controls are disabled
    this.busy = false;   // a save is in flight
    this.lostFocus = null; // data-focus of a control that lost focus because it was disabled
    this.loaded = false;
    this.auditRows = []; // from the API: this visitor's actions and the agents' rows
    this.localAudit = []; // without the API: this tab's actions
    this.tab = "stories";
    this.editing = null;
    this.drafts = new Map(); // `${story_id}|${lang}` -> text typed in the editor, kept until saved or cancelled
    this.open = new Set(); // stories whose evidence is expanded
    this.note = "";
    this.lastAct = null; // {id, prev}: the last decision, while its Undo is offered
    this.done = null;    // {id, key}: the outcome the status line says
    this.factIndex = new Map(this.match.facts.map((f) => [f.fact_id, f]));
    this.eventIndex = new Map(this.match.events.map((e) => [e.event_id, e]));
    // Built once: the live regions stay in the page, so a render announces only a new message.
    this.headEl = h("header", { className: "desk-head" });
    this.killEl = h("p", { className: "banner", role: "status" });
    this.noteEl = h("p", { className: "banner warn", role: "alert" });
    // the outcome of the last decision, polite, with its Undo next to it (outside the live region)
    this.doneMsg = h("p", { className: "done-msg", role: "status" });
    this.undoBtn = h("button", { type: "button", className: "link undo", "data-focus": "undo", onclick: () => this.undo() });
    this.doneEl = h("div", { className: "done" }, this.doneMsg, this.undoBtn);
    this.bodyEl = h("div", { className: "desk-body", role: "tabpanel", tabindex: 0, "data-focus": "panel" });
    this.footEl = h("footer", { className: "desk-foot" });
    root.replaceChildren(this.headEl, this.killEl, this.noteEl, this.doneEl, this.bodyEl, this.footEl);
  }

  tx(key, vars) { return tr(this.state.lang, key, vars); }

  locked() { return !this.ready || this.busy; }

  /** The replay's stories and traces: static files, no API. */
  async load() {
    const base = `data/${this.matchId}`;
    [this.stories, this.traces] = await Promise.all([optionalRows(`${base}/stories.json`, "story_id"), optionalRows(`${base}/traces.json`)]);
    this.stories.sort((a, b) => a.ts - b.ts);
    this.byId = new Map(this.stories.map((s) => [s.story_id, s]));
    this.loaded = true;
    this.changed();
  }

  /** This visitor's decisions from the API. Without an answer the desk keeps working in the tab. */
  async connect() {
    for (let attempt = 1; ; attempt++) {
      try {
        const s = await this.api("GET", "api/session");
        const d = await this.api("GET", `api/decisions?match_id=${encodeURIComponent(this.matchId)}`);
        this.online = true;
        this.kill = Boolean(d.kill_switch ?? s.kill_switch);
        for (const x of list(d.decisions)) if (x && typeof x.story_id === "string") this.decisions.set(x.story_id, x);
        await this.refreshAudit();
        break;
      } catch (e) {
        // no answer or a server error: try again; static hosting (404) or a refusal: offline at once
        if (e.retry && attempt < CONNECT_TRIES) { await new Promise((r) => setTimeout(r, 500 * attempt)); continue; }
        this.online = false; // decisions live in this tab
        this.offline = e.api ? e.message : e.timeout ? "timeout" : ""; // the server's own reason stays in its words
        break;
      }
    }
    this.ready = true;
    this.changed();
  }

  async api(method, path, body) {
    let r;
    try {
      r = await fetch(path, {
        method, credentials: "same-origin", signal: AbortSignal.timeout(API_TIMEOUT_MS),
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw Object.assign(new Error(e.name === "TimeoutError" ? "the server did not answer in time" : "no connection"), { timeout: e.name === "TimeoutError", retry: true });
    }
    let data = null;
    try { data = await r.json(); } catch { /* not JSON: no API here */ }
    if (r.ok && data !== null) return data;
    // a list detail is FastAPI's validation error (422): the caller knows what it sent
    const detail = typeof data?.detail === "string" ? data.detail : Array.isArray(data?.detail) ? `the server refused the request (HTTP ${r.status})` : null;
    throw Object.assign(new Error(detail ?? `HTTP ${r.status}`), { api: detail !== null, validation: Array.isArray(data?.detail), retry: r.status >= 500 });
  }

  async refreshAudit() {
    if (!this.online) return;
    try {
      this.auditRows = (await this.api("GET", `api/audit?match_id=${encodeURIComponent(this.matchId)}`)).rows;
    } catch { /* keep the last rows */ }
  }

  // ---- the rule -------------------------------------------------------------------------------

  // A story Content Safety flagged never goes on air by itself, whatever its risk.
  defaultStatus(s) { return s.safety === "flagged" ? "needs_review" : s.default_status; }
  status(s) { return this.decisions.get(s.story_id)?.decision ?? this.defaultStatus(s); }
  onAir(s) { return !this.kill && ON_AIR.includes(this.status(s)); }
  pending() { return this.stories.filter((s) => this.status(s) === "needs_review").length; }

  /** The cues to play for an audience and language, with this visitor's overlay applied. */
  sheet(cues, audience, lang) {
    const mine = cues.filter((c) => c.audience === audience);
    let own = mine.filter((c) => c.lang === lang);
    // template cues are written in English only until the agents translate them
    if (lang !== "en" && !own.some((c) => c.story_id === null)) own = own.concat(mine.filter((c) => c.lang === "en" && c.story_id === null));
    return own.flatMap((c) => {
      if (c.story_id === null) return [c];
      const s = this.byId.get(c.story_id); // a cue of a story nobody can review is held
      if (!s || !this.onAir(s)) return [];
      const text = this.decisions.get(s.story_id)?.edited_text?.[c.lang];
      return [text && c.graphic === "why_card" ? { ...c, payload: { ...c.payload, body: text } } : c];
    });
  }

  /** The language the story text is shown in: the asked one, or English when it has no such text. */
  textLang(s, lang) { return (this.decisions.get(s.story_id)?.edited_text?.[lang] ?? s.texts?.[lang]) ? lang : "en"; }
  text(s, lang) { return this.decisions.get(s.story_id)?.edited_text?.[lang] ?? s.texts?.[lang] ?? s.texts?.en ?? ""; }

  // ---- actions --------------------------------------------------------------------------------

  /** undoing: this decision takes back the last one, so the status line says so and offers no Undo. */
  async decide(s, decision, editedText = null, undoing = false) {
    if (this.locked()) return;
    const id = s.story_id, prev = this.decisions.get(id), wasStatus = this.status(s), at = new Date().toISOString();
    this.decisions.set(id, { story_id: id, decision, edited_text: editedText, at });
    this.note = "";
    if (!this.online) {
      this.localAudit.unshift({ at, actor: "human", action: decision, story_id: id, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0,
        detail: { langs: Object.keys(editedText ?? {}) } });
      this.endEdit(id);
      this.announce(s, prev, wasStatus, undoing);
      this.changed();
      return;
    }
    this.busy = true;
    this.changed();
    let ok = false;
    try {
      await this.api("POST", "api/decisions", { match_id: this.matchId, story_id: id, decision, ...(editedText ? { edited_text: editedText } : {}) });
      this.endEdit(id); // the editor and its drafts go only once the server has the text
      ok = true;
      await this.refreshAudit();
    } catch (e) {
      if (prev) this.decisions.set(id, prev); else this.decisions.delete(id);
      this.note = this.tx("notSaved", { why: e.validation && editedText ? this.tx("badChar") : e.message });
    }
    if (ok) this.announce(s, prev, wasStatus, undoing);
    this.busy = false;
    this.changed();
  }

  // Online undo of a story's first decision: the server drops it and writes an "undo" audit row.
  async clear(s) {
    const id = s.story_id, prev = this.decisions.get(id);
    this.decisions.delete(id);
    this.note = "";
    this.busy = true;
    this.changed();
    try {
      await this.api("DELETE", `api/decisions?match_id=${encodeURIComponent(this.matchId)}&story_id=${encodeURIComponent(id)}`);
      await this.refreshAudit();
      this.announce(s, null, null, true);
    } catch (e) {
      if (prev) this.decisions.set(id, prev);
      this.note = this.tx("notSaved", { why: e.message });
    }
    this.busy = false;
    this.changed();
  }

  // The status line: what the decision did on air, and an Undo for a few seconds.
  announce(s, prev, wasStatus, undoing) {
    const st = this.status(s), id = s.story_id;
    let key;
    if (undoing) key = `undone_${this.tally(s)}`;
    else {
      key = st === "rejected" ? "done_rejected" : st === "edited" ? "done_edited" : wasStatus === "auto_approved" ? "done_kept" : "done_approved";
      if (this.kill && st !== "rejected") key += "Kill";
    }
    this.done = { id, key };
    this.lastAct = undoing ? null : { id, prev };
    clearTimeout(this.doneTimer);
    const expire = () => {
      // never pull the Undo from under the visitor's focus
      if (this.doneEl.contains(document.activeElement)) { this.doneTimer = setTimeout(expire, 2000); return; }
      this.lastAct = null;
      this.renderDone();
    };
    this.doneTimer = setTimeout(expire, UNDO_MS);
  }

  /** Takes back the last decision: the one before it again, or none (the story's default status). */
  async undo() {
    const u = this.lastAct, s = u && this.byId.get(u.id);
    if (!s || this.locked()) return;
    if (!this.online) {
      if (u.prev) this.decisions.set(u.id, u.prev); else this.decisions.delete(u.id);
      this.localAudit.unshift({ at: new Date().toISOString(), actor: "human", action: "undo", story_id: u.id, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, detail: {} });
      this.announce(s, null, null, true);
      this.changed();
    } else if (u.prev) {
      await this.decide(s, u.prev.decision, u.prev.edited_text ?? null, true);
    } else {
      await this.clear(s);
    }
    // the Undo is gone: focus goes back to the story it changed
    if (!this.doneEl.contains(document.activeElement) && document.activeElement !== document.body) return;
    this.root.querySelector(`[data-focus="${CSS.escape(`${u.id}:edited`)}"]`)?.focus();
  }

  endEdit(id) {
    if (this.editing === id) this.editing = null;
    for (const k of [...this.drafts.keys()]) if (k.startsWith(`${id}|`)) this.drafts.delete(k);
  }

  async setKill(on) {
    if (this.locked()) return;
    const prev = this.kill;
    this.kill = on;
    this.note = "";
    if (!this.online) this.localAudit.unshift({ at: new Date().toISOString(), actor: "human", action: on ? "ai_off" : "ai_on", story_id: null, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, detail: {} });
    this.busy = this.online;
    this.changed();
    if (!this.online) return;
    try {
      await this.api("POST", "api/kill", { on });
      await this.refreshAudit();
    } catch (e) {
      this.kill = prev;
      this.note = this.tx("notSaved", { why: e.message });
    }
    this.busy = false;
    this.changed();
  }

  changed() {
    this.render();
    this.onChange();
  }

  showTrace(storyId) {
    this.tab = "traces";
    this.render();
    const g = this.root.querySelector(`[data-trace="${CSS.escape(storyId)}"]`);
    g?.scrollIntoView({ block: "start" });
    g?.focus({ preventScroll: true });
  }

  // ---- rendering ------------------------------------------------------------------------------

  render() {
    const active = document.activeElement;
    const focusKey = active?.closest?.("#desk") ? active.dataset.focus : active === document.body || !active ? this.lostFocus : null;
    const scroll = this.shownTab === this.tab ? this.bodyEl.scrollTop : 0;
    this.shownTab = this.tab;
    const locked = this.locked(), tx = (k, v) => this.tx(k, v);
    const tabs = [["stories", tx("tabStories"), this.stories.length], ["audit", tx("tabAudit")], ["traces", tx("tabTraces")]];
    const tabButton = ([id, label, n]) => h("button", {
      // only the selected tab's panel exists, so only that tab names it
      type: "button", role: "tab", id: `tab-${id}`, "aria-controls": this.tab === id ? `panel-${id}` : null, "aria-selected": String(this.tab === id),
      tabindex: this.tab === id ? 0 : -1, "data-focus": `tab:${id}`, onclick: () => { this.tab = id; this.render(); },
      onkeydown: (e) => this.tabKeys(e, tabs.map((t) => t[0])),
    }, label, n !== undefined ? h("span", { className: "count" }, n) : null);
    const body = this.tab === "stories" ? this.renderStories() : this.tab === "audit" ? this.renderAudit() : this.renderTraces();
    const lang = this.state.lang, n = this.pending();
    const sum = !this.ready ? tx("loadingDecisions") : this.busy ? tx("saving") : this.stories.length ? tx("waiting", { n: int(n, lang), m: int(this.stories.length, lang) }) : "";
    this.root.setAttribute("aria-label", tx("title"));
    this.headEl.replaceChildren(
      h("div", { className: "desk-title" },
        h("h2", {}, tx("title")),
        h("button", { type: "button", id: "desk-close", className: "ctl", "aria-label": tx("closeLabel"), "data-focus": "close",
          onclick: () => this.closeDrawer() }, tx("close"))),
      h("p", { className: "desk-purpose" }, tx("purpose")),
      h("div", { className: "desk-bar" },
        h("button", { type: "button", role: "switch", id: "ai-switch", className: "switch", "aria-checked": String(!this.kill), "data-focus": "kill",
          disabled: locked, onclick: () => this.setKill(!this.kill) },
        h("span", { className: "track", "aria-hidden": "true" }, h("span", { className: "knob" })),
        h("span", { className: "switch-label" }, tx("ai"), h("b", {}, tx(this.kill ? "off" : "on")))),
        h("span", { className: "desk-sum" }, sum)),
      h("div", { role: "tablist", "aria-label": tx("tabs"), className: "tabs" }, tabs.map(tabButton)));
    setText(this.killEl, this.kill ? tx("kill") : "");
    setText(this.noteEl, this.note);
    this.renderDone();
    this.bodyEl.id = `panel-${this.tab}`;
    this.bodyEl.setAttribute("aria-labelledby", `tab-${this.tab}`);
    this.bodyEl.replaceChildren(...[body].flat(Infinity).filter(Boolean)); // replaceChildren would print a null as "null"
    this.bodyEl.scrollTop = scroll;
    const why = this.offline === "timeout" ? tx("timeout") : this.offline.replace(/^./, (c) => c.toUpperCase()).replace(/([^.])$/, "$1.");
    setText(this.footEl, !this.ready ? tx("footConnecting") : this.online ? tx("footOnline") : this.offline ? tx("footOffline", { why }) : tx("footNoServer"));
    document.querySelector("#ai-off")?.toggleAttribute("hidden", !this.kill);
    // the Desk button (narrow screens) carries the count and the offline state, so a closed drawer still shows them
    const open = document.querySelector("#desk-open"), off = this.ready && !this.online;
    if (open) {
      if (open.firstChild?.nodeType === Node.TEXT_NODE) open.firstChild.nodeValue = `${tx("deskName")} `; // the button's visible word
      open.querySelector(".count").textContent = n ? int(n, lang) : "";
      const offEl = open.querySelector(".off");
      if (offEl) { offEl.textContent = tx("offline"); offEl.toggleAttribute("hidden", !off); }
      open.setAttribute("aria-label", [tx("deskName"), n ? tx("deskWaiting", { n: int(n, lang) }) : "", off ? tx("offline") : ""].filter(Boolean).join(", "));
    }
    // focus stays on the same control; one disabled during a save gets it back once enabled; a closed
    // editor, or an action that is gone once taken (Put on air, Reject), hands it to Edit
    const find = (k) => this.root.querySelector(`[data-focus="${CSS.escape(k)}"]`);
    const el = focusKey ? find(focusKey) ?? find(focusKey.replace(/:(save|cancel|text:\w+|approved|rejected)$/, ":edited")) : null;
    this.lostFocus = el?.disabled ? focusKey : null;
    if (el && !el.disabled && el !== document.activeElement) el.focus({ preventScroll: true });
  }

  renderDone() {
    const s = this.done && this.byId.get(this.done.id);
    setText(this.doneMsg, s ? this.tx(this.done.key, { what: this.what(s) }) : "");
    const undo = Boolean(s && this.lastAct?.id === s.story_id);
    this.undoBtn.hidden = !undo;
    this.undoBtn.disabled = this.locked();
    setText(this.undoBtn, this.tx("undo"));
    if (undo) this.undoBtn.setAttribute("aria-label", this.tx("undoLabel", { what: this.what(s) }));
    else this.undoBtn.removeAttribute("aria-label");
  }

  // "Goal 10'": a story as the status line and the buttons name it
  minuteText(s) {
    const c = this.match.clock(s.ts), base = c.period === 1 ? 45 : 90;
    return c.minute > base ? `${base}+${c.minute - base}` : String(c.minute); // stoppage as the lines say it
  }

  what(s) { return `${kindName(s.kind, this.state.lang)} ${this.minuteText(s)}'`; }

  tally(s) { return this.onAir(s) ? "onair" : this.status(s) === "needs_review" && !this.kill ? "held" : "off"; }

  tabKeys(e, ids) {
    const i = ids.indexOf(this.tab), step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (step === undefined && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    this.tab = ids[e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : (i + step + ids.length) % ids.length];
    this.render();
    this.root.querySelector(`#tab-${this.tab}`).focus();
  }

  renderStories() {
    if (!this.loaded) return h("p", { className: "empty" }, this.tx("loadingStories"));
    if (!this.stories.length) return h("p", { className: "empty" }, this.tx("noStories"));
    return h("ol", { className: "stories" }, this.stories.map((s) => h("li", {}, this.renderStory(s))));
  }

  renderStory(s) {
    const lang = this.state.lang, st = this.status(s), id = s.story_id, tx = (k, v) => this.tx(k, v);
    const tally = this.tally(s);
    const tallyText = tx({ onair: "onair", held: "held", off: this.kill && st !== "rejected" ? "offairKill" : "offair" }[tally]);
    const minute = this.minuteText(s), kind = kindName(s.kind, lang);
    const who = s.player_id ? this.match.players[s.player_id]?.name : this.match.teams[s.team_id]?.short_name;
    const v = s.verifier ?? {}, flagged = v.flagged ?? [];
    const risk = Number(s.risk), band = riskBand(risk);
    const tip = band === "low" && this.defaultStatus(s) !== "auto_approved" ? "tip_lowHeld" : `tip_${band}`;
    const editing = this.editing === id;
    const decided = this.decisions.has(id);
    const status = (x) => tx(`st_${x}`) === `st_${x}` ? x : tx(`st_${x}`);
    // One filled action, named by what it does on air; an action that would change nothing is not offered.
    const primary = st === "needs_review" || st === "rejected" ? (this.kill ? "approve" : "put") : st === "auto_approved" ? (this.kill ? "approve" : "keep") : null;
    const act = (decision, label, cls) => h("button", {
      type: "button", className: `${cls} act act-${decision}`, "data-focus": `${id}:${decision}`,
      "aria-label": `${tx("actLabel", { label, kind, m: minute })}${who ? `, ${who}` : ""}`, disabled: this.locked(),
      onclick: () => (decision === "edited" ? this.startEdit(s) : this.decide(s, decision)),
    }, label);
    const firstCue = this.match.cues.find((c) => c.story_id === id);
    return h("article", { className: "story", "data-tally": tally, id: `story-${id}`, "aria-labelledby": `h-${id}` },
      h("div", { className: "story-head" },
        h("button", { type: "button", className: "minute", "data-focus": `${id}:go`, "aria-label": tx("goMinute", { m: minute }),
          title: tx("goTitle"), onclick: () => this.seek(Math.max(0, (firstCue?.ts ?? s.ts) - 1)) }, `${minute}'`),
        h("h3", { id: `h-${id}` }, kind, who ? h("span", { className: "who" }, who) : null),
        h("span", { className: "tally" }, tallyText)),
      h("div", { className: "story-meta" },
        h("span", { className: `status st-${st}` }, status(st)),
        decided ? h("span", { className: "default" }, tx("defaultWas", { s: status(this.defaultStatus(s)).toLocaleLowerCase(lang) })) : null,
        s.safety === "flagged" && s.default_status === "auto_approved" ? h("span", { className: "default" }, tx("heldSafety")) : null,
        h("span", { className: `risk risk-${band}`, title: tx("riskTitle", { r: dec(risk, lang, 2), t: dec(AUTO_RISK, lang, 2) }) },
          h("b", {}, tx(`risk_${band}`)),
          h("span", { className: "meter", "aria-hidden": "true" }, h("span", { style: `width:${Math.round(Math.min(1, Math.max(0, risk)) * 100)}%` })),
          h("small", {}, Number.isFinite(risk) ? dec(risk, lang, 2) : ""))),
      h("p", { className: "risk-tip" }, tx(tip)),
      editing ? this.renderEditor(s) : h("p", { className: "story-text", lang: this.textLang(s, lang) }, this.text(s, lang)),
      editing ? null : this.renderProposal(s, lang),
      h("dl", { className: "checks" },
        v.on_air ? h("div", {}, h("dt", {}, tx("dtOnAir")), h("dd", {}, TEXT.en[`air_${v.on_air}`] ? tx(`air_${v.on_air}`) : v.on_air)) : null,
        h("div", {}, h("dt", {}, tx(v.on_air ? "dtDraft" : "dtVerifier")), h("dd", { className: `v-${v.status}` },
          TEXT.en[`${v.on_air ? "d" : "v"}_${v.status}`] ? tx(`${v.on_air ? "d" : "v"}_${v.status}`) : v.status ?? tx("none"),
          v.attempts ? tx("attempts", { n: v.attempts }) : "")),
        h("div", {}, h("dt", {}, tx("dtSafety")), h("dd", { className: `s-${s.safety}` }, TEXT.en[`s_${s.safety}`] ? tx(`s_${s.safety}`) : s.safety))),
      flagged.length ? h("details", { className: "flagged" }, h("summary", { "data-focus": `${id}:notes` },
        `${TEXT.en[`n_${v.status}`] ? tx(`${v.on_air ? "dn" : "n"}_${v.status}`) : tx("notes")} (${int(flagged.length, lang)})`),
        h("ul", { lang: "en" }, flagged.map((f) => h("li", {}, flagText(f))))) : null,
      this.renderEvidence(s),
      editing ? null : h("div", { className: "actions" },
        primary ? act("approved", tx(primary), "ctl primary") : null,
        act("edited", tx("edit"), "ctl"),
        st === "rejected" ? null : act("rejected", tx("reject"), "quiet"),
        this.traceGroups().has(id) ? h("button", { type: "button", className: "link", "data-focus": `${id}:trace`, onclick: () => this.showTrace(id) }, tx("showTrace")) : null));
  }

  // The AI's own line, kept off air: one click puts it on air in all three languages, as an edit.
  renderProposal(s, lang) {
    const p = s.verifier?.proposals;
    if (!p) return null;
    const text = p[lang] ?? p.en ?? "";
    const using = LANGS.every((l) => this.decisions.get(s.story_id)?.edited_text?.[l] === p[l]);
    return h("div", { className: "proposal" },
      h("p", { className: "proposal-text" }, h("b", {}, this.tx(using ? "proposalOn" : "proposalOff")), h("span", { lang: p[lang] ? lang : "en" }, text)),
      using ? null : h("button", { type: "button", className: "ctl", "data-focus": `${s.story_id}:proposal`, disabled: this.locked(),
        onclick: () => this.decide(s, "edited", { ...p }) }, this.tx("useProposal")));
  }

  startEdit(s) {
    this.editing = s.story_id;
    this.render();
    this.root.querySelector(`[data-focus="${CSS.escape(`${s.story_id}:text:${this.state.lang}`)}"]`)?.focus();
  }

  // All three languages in one editor: saving approves what goes on air in every language, so the
  // reviewer sees every one. Unchanged text saves as a plain approval.
  renderEditor(s) {
    const id = s.story_id, locked = this.locked();
    const areas = LANGS.map((lang) => {
      const name = this.tx(`lang_${lang}`);
      const counter = h("span", { className: "counter", id: `count-${id}-${lang}` });
      const area = h("textarea", { id: `edit-${id}-${lang}`, lang, maxlength: EDIT_MAX, rows: 3, "aria-describedby": `count-${id}-${lang}`,
        "data-focus": `${id}:text:${lang}` });
      // a draft survives a re-render and a failed save
      area.value = this.drafts.get(`${id}|${lang}`) ?? this.text(s, lang);
      const count = () => { counter.textContent = `${area.value.length}/${EDIT_MAX}`; };
      count();
      area.addEventListener("input", () => { this.drafts.set(`${id}|${lang}`, area.value); count(); });
      area.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      });
      return h("div", { className: "edit-lang" }, h("label", { for: `edit-${id}-${lang}` }, name), area, counter);
    });
    const save = () => {
      if (this.locked()) return;
      const texts = {};
      for (const l of LANGS) {
        const v = (this.drafts.get(`${id}|${l}`) ?? this.text(s, l)).trim();
        if (!v) { this.note = this.tx("emptyText", { name: this.tx(`lang_${l}`) }); this.render(); return; }
        if (v !== (s.texts?.[l] ?? s.texts?.en ?? "")) texts[l] = v;
      }
      if (Object.keys(texts).length) this.decide(s, "edited", texts); else this.decide(s, "approved");
    };
    const cancel = () => { this.endEdit(id); this.render(); };
    return h("div", { className: "editor" }, areas,
      h("div", { className: "editor-bar" },
        h("button", { type: "button", className: "ctl", "data-focus": `${id}:cancel`, disabled: locked, onclick: cancel }, this.tx("cancel")),
        h("button", { type: "button", className: "ctl primary", "data-focus": `${id}:save`, disabled: locked, onclick: save }, this.tx("saveApprove"))));
  }

  renderEvidence(s) {
    const facts = list(s.fact_ids).map((id) => this.factIndex.get(id) ?? { fact_id: id, missing: true });
    const events = list(s.evidence_event_ids).map((id) => this.eventIndex.get(id) ?? { event_id: id, missing: true });
    const det = h("details", { className: "evidence", ...(this.open.has(s.story_id) ? { open: true } : {}) },
      h("summary", { "data-focus": `${s.story_id}:evidence` }, this.tx("evidence", { f: facts.length, e: events.length })));
    // the body (and its pitch map) is built only once the evidence is open
    const fill = () => { if (det.open && det.children.length === 1) det.append(...this.evidenceBody(s, facts, events)); };
    det.addEventListener("toggle", () => {
      if (det.open) this.open.add(s.story_id); else this.open.delete(s.story_id);
      fill();
    });
    fill();
    return det;
  }

  evidenceBody(s, facts, events) {
    const lang = this.state.lang, tx = (k, v) => this.tx(k, v);
    return [
      h("div", { className: "ev-grid" },
        this.miniPitch(s, facts, events),
        h("table", { className: "facts" },
          h("caption", { className: "sr" }, tx("factsCaption")),
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, tx("fact")), h("th", { scope: "col" }, tx("value")))),
          h("tbody", {}, facts.map((f) => h("tr", { className: f.missing ? "missing" : "" },
            // the ledger's labels are English
            h("td", { title: f.fact_id }, f.missing ? h("span", { className: "flabel" }, tx("notInLedger")) : h("span", { className: "flabel", lang: "en" }, f.label_en ?? "")),
            h("td", { className: "num" }, f.missing ? "" : valueText(f, lang))))))),
      events.length ? h("p", { className: "events" }, tx("events"), events.map((e) => h("span", { className: "eid", title: e.missing ? "not in events.json" : `${e.type_name}, ${this.match.players[e.player_id]?.name ?? e.player_id}` },
        e.missing ? `${e.event_id}?` : [`${e.event_id} `, h("span", { lang: "en" }, e.type_name.replace(/_/g, " "))]))) : null,
      s.analysis_en ? h("p", { className: "analysis" }, h("b", {}, tx("analyst")), h("span", { lang: "en" }, s.analysis_en)) : null,
    ].filter(Boolean);
  }

  // Where the evidence happened: event arrows from start to end, and the run behind a speed fact.
  miniPitch(s, facts, events) {
    const Y = (y) => 68 - y;
    const color = (team) => this.match.teams[team]?.color_primary ?? "#ffffff";
    const lines = h("svg:g", { className: "lines" },
      h("svg:rect", { x: 0, y: 0, width: 105, height: 68 }),
      h("svg:line", { x1: 52.5, y1: 0, x2: 52.5, y2: 68 }),
      h("svg:circle", { cx: 52.5, cy: 34, r: 9.15 }),
      h("svg:rect", { x: 0, y: 13.84, width: 16.5, height: 40.32 }), h("svg:rect", { x: 88.5, y: 13.84, width: 16.5, height: 40.32 }),
      h("svg:rect", { x: 0, y: 24.84, width: 5.5, height: 18.32 }), h("svg:rect", { x: 99.5, y: 24.84, width: 5.5, height: 18.32 }));
    const marks = [];
    for (const f of facts) {
      // only a sprint fact's frames are its run; distance and sprint counts span the whole match so far
      const i = this.match.index[f.player_id], span = list(f.source_frames);
      if (f.missing || f.kind !== "sprint_speed" || i === undefined || span.length !== 2 || !(span[1] - span[0] <= RUN_MAX_FRAMES)) continue;
      const pts = [];
      for (let k = f.source_frames[0]; k <= f.source_frames[1]; k++) {
        const p = this.match.at(i, k / this.match.meta.fps);
        if (p) pts.push(`${p[0].toFixed(1)},${Y(p[1]).toFixed(1)}`);
      }
      if (pts.length > 1) marks.push(h("svg:polyline", { points: pts.join(" "), className: "run", stroke: color(f.team_id) }));
    }
    for (const e of events) {
      if (e.missing) continue;
      const c = color(e.team_id), [x0, y0, x1, y1] = [e.start_x, Y(e.start_y), e.end_x, Y(e.end_y)];
      const len = Math.hypot(x1 - x0, y1 - y0) || 1, ux = (x1 - x0) / len, uy = (y1 - y0) / len;
      marks.push(h("svg:g", {},
        h("svg:title", {}, `Event ${e.event_id}: ${e.type_name.replace(/_/g, " ")}, ${this.match.players[e.player_id]?.name ?? e.player_id}`),
        h("svg:line", { x1: x0, y1: y0, x2: x1 - ux * 1.6, y2: y1 - uy * 1.6, stroke: c, className: "ev" }),
        len > 2 ? h("svg:polygon", { fill: c, points: `${x1},${y1} ${x1 - ux * 2.6 - uy * 1.3},${y1 - uy * 2.6 + ux * 1.3} ${x1 - ux * 2.6 + uy * 1.3},${y1 - uy * 2.6 - ux * 1.3}` }) : null,
        h("svg:circle", { cx: x0, cy: y0, r: 1.4, fill: c, className: "dot" })));
    }
    const n = events.filter((e) => !e.missing).length;
    return h("svg:svg", { viewBox: "-2 -2 109 72", className: "mini", role: "img",
      "aria-label": this.tx("pitch", { n, run: marks.length > n }) }, lines, marks);
  }

  // Audit: the agents' rows (from the API, or from the replay traces) and this visitor's actions.
  auditData() {
    const fromApi = this.auditRows.filter((r) => r.actor !== "human" && r.actor !== "auto");
    // the visitor's own questions (studio_host, POST api/ask) are no reason to drop the replay's traces
    const asks = fromApi.filter((r) => r.actor === "studio_host");
    const agents = fromApi.length > asks.length ? fromApi : [...asks, ...this.traces.map((t) => ({ at: t.at, actor: t.agent, action: t.step,
      story_id: this.traceStory(t), model: t.model, tokens_in: t.tokens_in, tokens_out: t.tokens_out, cost_usd: t.cost_usd }))];
    const directorAt = new Map(this.traces.filter((t) => t.agent === "director").flatMap((t) => this.traceStories(t).map((id) => [id, t.at])));
    // the API lists the risk rule's approvals itself; without it the desk derives them from the replay
    const auto = this.online ? this.auditRows.filter((r) => r.actor === "auto") : this.stories.filter((s) => this.defaultStatus(s) === "auto_approved")
      .map((s) => ({ at: directorAt.get(s.story_id) ?? "", actor: "auto", action: "auto_approved", story_id: s.story_id, model: null,
        tokens_in: 0, tokens_out: 0, cost_usd: 0, detail: { risk: s.risk } }));
    const humans = this.online ? this.auditRows.filter((r) => r.actor === "human") : this.localAudit;
    return { rows: [...humans, ...auto, ...agents].sort((a, b) => String(b.at).localeCompare(String(a.at))), agents, humans };
  }

  renderAudit() {
    const { rows, agents, humans } = this.auditData();
    const lang = this.state.lang, tx = (k, v) => this.tx(k, v);
    const calls = agents.filter((r) => r.model);
    const tokens = agents.reduce((n, r) => n + r.tokens_in + r.tokens_out, 0), cost = agents.reduce((n, r) => n + r.cost_usd, 0);
    const what = (r) => {
      if (r.actor !== "human" && r.actor !== "auto" && r.actor !== "studio_host") return h("span", { lang: "en" }, String(r.action).replace(/_/g, " ")); // an agent's step
      if (r.action === "ai_off" || r.action === "ai_on" || r.action === "undo") return tx(`a_${r.action}`);
      if (r.action === "ask") return tx("a_ask", { s: r.detail?.status ?? "asked" });
      if (r.action === "auto_approved") return tx("a_auto", { r: dec(r.detail?.risk, lang, 2), t: dec(AUTO_RISK, lang, 2) });
      const a = TEXT.en[`a_${r.action}`] ? tx(`a_${r.action}`) : String(r.action).replace(/_/g, " ");
      return a + (r.detail?.langs?.length ? ` (${r.detail.langs.join(", ")})` : "");
    };
    return h("div", { className: "audit" },
      h("div", { className: "totals" },
        h("div", {}, h("b", {}, int(calls.length, lang)), ` ${tx("calls")}`),
        h("div", {}, h("b", {}, int(tokens, lang)), ` ${tx("tokens")}`),
        h("div", {}, h("b", {}, usd(cost, lang)), ` ${tx("cost")}`),
        h("div", {}, h("b", {}, int(humans.length, lang)), ` ${tx("yours")}`)),
      // a narrow desk scrolls the table sideways instead of cutting its last column
      rows.length ? h("div", { className: "log-wrap", role: "region", tabindex: 0, "aria-label": tx("logCaption") }, h("table", { className: "log" },
        h("caption", { className: "sr" }, tx("logCaption")),
        h("thead", {}, h("tr", {}, ["colUtc", "colWho", "colWhat", "colModel", "colCost"].map((c) => h("th", { scope: "col" }, tx(c))))),
        h("tbody", {}, rows.map((r) => h("tr", { className: `a-${r.actor === "human" ? "human" : r.actor === "auto" ? "auto" : "agent"}` },
          h("td", { className: "num" }, String(r.at).slice(11, 19)),
          h("td", {}, agentName(r.actor, lang)),
          h("td", {}, what(r), r.story_id ? h("span", { className: "sid" }, r.story_id) : null),
          h("td", { lang: r.model ? "en" : null }, r.model ?? ""),
          h("td", { className: "num" }, r.tokens_in + r.tokens_out ? [int(r.tokens_in + r.tokens_out, lang), h("br"), usd(r.cost_usd, lang)] : "")))))) :
        h("p", { className: "empty" }, tx("auditEmpty")));
  }

  // A trace row belongs to the stories in its story_ids; older replays without them fall back to
  // its story_id, else a story id named in its summaries, else the first story citing one of its facts.
  traceStories(t) {
    const ids = list(t.story_ids).filter((id) => this.byId.has(id));
    if (ids.length) return ids;
    if (t.story_id) return [t.story_id];
    const named = `${t.input_summary} ${t.output_summary}`.match(/S-\d{6}/)?.[0];
    if (named && this.byId.has(named)) return [named];
    return [this.stories.find((s) => list(t.fact_ids).some((f) => list(s.fact_ids).includes(f)))?.story_id ?? null];
  }

  traceStory(t) { return this.traceStories(t)[0]; }

  /** story_id ("" for the whole run) -> {rows, sum}. A hand-off shared by n stories is listed in each
   *  group, and each group counts 1/n of its tokens, cost and time, so the groups add up to the run. */
  traceGroups() {
    if (this._groups?.traces === this.traces && this._groups.stories === this.stories) return this._groups.map;
    const map = new Map();
    for (const t of this.traces) {
      const ids = this.traceStories(t).map((id) => id ?? "");
      for (const k of ids) {
        if (!map.has(k)) map.set(k, { rows: [], sum: { tokens: 0, cost: 0, ms: 0 } });
        const g = map.get(k);
        g.rows.push({ t, shared: ids.length });
        g.sum.tokens += ((t.tokens_in ?? 0) + (t.tokens_out ?? 0)) / ids.length;
        g.sum.cost += (t.cost_usd ?? 0) / ids.length;
        g.sum.ms += (t.latency_ms ?? 0) / ids.length;
      }
    }
    for (const g of map.values()) g.rows.sort((a, b) => a.t.seq - b.t.seq);
    this._groups = { traces: this.traces, stories: this.stories, map };
    return map;
  }

  renderTraces() {
    const lang = this.state.lang, tx = (k, v) => this.tx(k, v);
    const legend = h("ol", { className: "pipeline", "aria-label": tx("pipeline") },
      AGENTS.map(([id, how]) => h("li", { "data-agent": id }, h("b", {}, agentName(id, lang)), h("span", { className: "how" }, tx(`how_${how}`)), h("span", { className: "role" }, tx(`role_${id}`)))));
    if (!this.traces.length) return [legend, h("p", { className: "empty" }, tx("noTraces"))];
    return [legend, [...this.traceGroups()].map(([sid, { rows, sum }]) => {
      const s = this.byId.get(sid);
      const shared = rows.filter((x) => x.shared > 1).length;
      return h("section", { className: "trace", "data-trace": sid, "data-focus": `trace:${sid}`, tabindex: -1, "aria-labelledby": `t-${sid || "run"}` },
        h("h3", { id: `t-${sid || "run"}` }, s ? `${this.match.clock(s.ts).minute}' ${kindName(s.kind, lang)}` : tx("wholeRun"),
          s ? h("button", { type: "button", className: "link", "data-focus": `${sid}:show`, onclick: () => this.showStory(sid) }, tx("showStory")) : null),
        h("p", { className: "trace-sum" }, tx("traceSum", { n: int(rows.length, lang), tok: int(Math.round(sum.tokens), lang), usd: usd(sum.cost, lang), s: dec(sum.ms / 1000, lang, 1) }),
          shared ? tx("traceShared", { n: int(shared, lang) }) : ""),
        h("ol", { className: "chain" }, rows.map(({ t: r, shared: n }) => h("li", { "data-agent": String(r.agent).replace(/_[a-z]{2}$/, ""), className: traceFailed(r) ? "failed" : "" },
          // the step, the model and the summaries are agent output: English
          h("div", { className: "step-head" }, h("b", {}, agentName(r.agent, lang)), h("span", { className: "step", lang: "en" }, r.step),
            h("span", { className: "how", lang: r.model ? "en" : null }, r.model ?? tx(HOW[String(r.agent).replace(/_[a-z]{2}$/, "")] === "rules" ? "rulesNoModel" : "codeNoModel"))),
          h("p", { className: "io" }, h("span", { className: "io-k" }, tx("in")), h("span", { lang: "en" }, summaryText(r.input_summary))),
          h("p", { className: "io" }, h("span", { className: "io-k" }, tx("out")), h("span", { lang: "en" }, summaryText(r.output_summary))),
          h("p", { className: "step-meta" },
            r.tokens_in ? tx("tokInOut", { a: int(r.tokens_in, lang), b: int(r.tokens_out, lang) }) : tx("zeroTokens"), `, ${int(r.latency_ms, lang)} ms`, r.cost_usd ? `, ${usd(r.cost_usd, lang)}` : "",
            n > 1 ? tx("sharedBy", { n: int(n, lang) }) : ""),
          list(r.fact_ids).length ? h("p", { className: "fids" }, list(r.fact_ids).map((f) => h("span", { className: "fid" }, f))) : null))));
    })];
  }

  showStory(id) {
    this.tab = "stories";
    this.render();
    const el = this.root.querySelector(`#story-${CSS.escape(id)}`);
    el?.scrollIntoView({ block: "start" });
    el?.querySelector(".minute")?.focus({ preventScroll: true });
  }

  /** The drawer (narrow screens) is modal: the page behind leaves the tab order while it is open. */
  setDrawer(open) {
    document.body.classList.toggle("desk-open", open);
    document.querySelector("#app").inert = open;
    for (const [k, v] of [["role", "dialog"], ["aria-modal", "true"]]) if (open) this.root.setAttribute(k, v); else this.root.removeAttribute(k);
    document.querySelector("#desk-open")?.setAttribute("aria-expanded", String(open));
  }

  closeDrawer() {
    this.setDrawer(false);
    document.querySelector("#desk-open")?.focus();
  }
}

// A live region announces any text change, the same text included: write only a new one.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function valueText(f, lang = "en") {
  const v = Number(f.value);
  const n = Number.isInteger(v) ? String(v) : dec(v, lang, Math.abs(v) >= 100 ? 0 : 1);
  if (f.unit === "formation") return String(Math.round(v)).split("").join("-"); // 442 is 4-4-2
  return f.unit === "/10" ? `${n}/10` : f.unit === "goals" ? tr(lang, "goals", { n }) : `${n} ${f.unit ?? ""}`.trim();
}

function flagText(f) {
  if (typeof f === "string") return f;
  if (f && typeof f === "object") {
    const parts = [f.claim ? `"${f.claim}"` : null, f.reason ?? f.text ?? null, f.fact_id ? `(${f.fact_id})` : null].filter(Boolean);
    return parts.length ? parts.join(" ") : JSON.stringify(f);
  }
  return String(f);
}
