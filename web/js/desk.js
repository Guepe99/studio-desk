// Control desk: the candidate stories with their evidence, approve / edit / reject, the AI kill
// switch, the audit log and the agent traces (docs/CONTRACT.md, Runtime records and API; the design
// and its sources: docs/desk.md).
//
// One rule decides what goes on air: a story below the risk threshold is auto-approved and plays
// unless this visitor rejects it; a story that needs review, or that Content Safety flagged, is held
// until this visitor approves it. Only auto_approved, approved and edited go on air: any other or
// missing status is held. With the AI switched off only the generated graphics (story_id null) play.
// Generated graphics go through the same path as pseudo-stories (G-<cue_id>), decided in the tab only:
// the API keeps decisions for S- ids. At most one waits at a time; one nobody decided on expires.
// Decisions come from the API (per visitor, cookie sd_session); with static hosting, or when the API
// does not answer within API_TIMEOUT_MS (CONNECT_TRIES times), they are kept in memory for the tab.
// The desk's controls stay disabled until that is settled, and while a save is in flight: one request
// at a time, so saves never cross and a server reply never undoes what the visitor did meanwhile.
//
// The stories tab lists only stories whose facts the match has reached, up to LOOKAHEAD_S before their graphic: a desk that showed the
// whole replay would spoil it. Three sections: on air now, what needs you, what is done.
import { KICKER } from "../graphics/why_card/kicker.mjs";

const LANGS = ["en", "it", "es"];
// Every string the desk shows, in the three page languages. Agent output (trace text, steps, model
// names, the analyst's note, fact labels) stays English and is marked lang="en" where it is shown.
// A value is a string with {name} slots, or a function of the slots for a count that needs a plural.
export const TEXT = {
  en: {
    title: "Control desk", close: "Close", closeLabel: "Close the control desk",
    ai: "AI graphics ", on: "on", off: "off", loadingDecisions: "Loading your decisions", saving: "Saving",
    waiting: "{n} waiting", tabs: "Desk views", tabStories: "Stories", tabAudit: "Audit log", tabTraces: "Traces",
    kill: "AI off: only template graphics are on air. Stories stay listed for review.",
    footConnecting: "Connecting to the server: the desk unlocks once your saved decisions are in.",
    footOnline: "Your decisions are saved for this browser only. Other visitors see the original replay.",
    footOffline: "Decisions are kept in this tab only. {why}", footNoServer: "No server: decisions are kept in this tab only.",
    timeout: "The server did not answer in time.", notSaved: "Not saved: {why}", badChar: "the text has a character the desk does not accept",
    deskName: "Desk", deskWaiting: "{n} waiting for review", offline: "offline",
    loadingStories: "Loading stories.",
    noStories: "No AI stories in this replay yet. The template graphics play on their own; stories appear here once the agents have run on the match.",
    offair: "Off air", goMinute: "Go to minute {m}", goTitle: "Go to this moment",
    st_auto_approved: "Auto-approved", st_needs_review: "Needs review", st_approved: "Approved", st_edited: "Edited and approved", st_rejected: "Rejected",
    defaultWas: "Before your decision: {s}.", before_needs_review: "Before your decision it was waiting for you.", before_auto_approved: "Before your decision it went on air by itself (low risk).", heldSafety: "held: flagged by Content Safety",
    line_live: "On air, {by}", by_auto_approved: "approved automatically (low risk)", by_approved: "approved by you", by_edited: "edited and approved by you", by_proposal: "AI proposal put on air by you", by_template: "template graphic, no approval needed",
    line_held: "Waiting for you, {why}", why_safety: "flagged by Content Safety", line_rejected: "Off air, rejected by you", line_kill: "Off air while AI graphics are off",
    details: "Details", whyReject: "What was wrong?", r_number: "A number", r_player: "A name", r_moment: "The moment", r_tone: "The tone",
    risk_low: "Low risk", risk_mid: "Medium risk", risk_high: "High risk", riskTitle: "Risk score {r}. Below {t} a story goes on air by itself.",
    tip_low: "Low risk: it goes on air by itself. Reject it if something looks wrong.",
    tip_lowHeld: "Held for a safety check: read it before you put it on air.",
    tip_mid: "Check the names and numbers against the evidence before it goes on air.",
    tip_high: "Read the evidence and the notes first. Reject it if a claim does not match.",
    dtOnAir: "On air", dtDraft: "AI draft", dtVerifier: "Verifier", dtSafety: "Safety", none: "none",
    attempts: ({ n }) => `, ${n} attempt${n > 1 ? "s" : ""}`,
    v_pass: "Pass", v_rewritten: "Passed after a rewrite", v_template: "Template line", air_phrasebook: "Phrasebook (code)", air_template: "Template line (code)",
    d_pass: "Pass", d_rewritten: "Passed after a rewrite", d_template: "Not usable",
    n_rewritten: "What the earlier drafts got wrong", n_template: "Why the fact-only sentence",
    dn_rewritten: "What the earlier AI drafts got wrong", dn_template: "Why the AI drafts were not kept", notes: "Verifier notes",
    s_passed: "Passed", s_flagged: "Flagged", s_not_checked: "Not checked",
    evidence: ({ f, e }) => `Evidence: ${f} fact${f === 1 ? "" : "s"}, ${e} event${e === 1 ? "" : "s"}`,
    put: "Put on air", approve: "Approve", edit: "Edit", reject: "Reject", showTrace: "Show trace",
    actLabel: "{label}: {kind} at minute {m}",
    proposalOn: "AI proposal, on air: ", proposalOff: "AI proposal, not on air: ", useProposal: "Use proposal",
    lang_en: "English", lang_it: "Italian", lang_es: "Spanish", emptyText: "The {name} text cannot be empty. Reject the story to keep it off air.",
    cancel: "Cancel", saveApprove: "Save and approve",
    done_approved: "{what} approved, on air", done_kept: "{what} kept on air", done_edited: "{what} edited, on air", done_proposal: "{what}: AI proposal on air", done_proposalKill: "{what}: AI proposal on air once AI graphics are back on",
    done_approvedKill: "{what} approved, on air once AI graphics are back on", done_keptKill: "{what} approved, on air once AI graphics are back on",
    done_editedKill: "{what} edited, on air once AI graphics are back on", done_rejected: "{what} rejected, off air",
    undo: "Undo", undoLabel: "Undo: {what}", undone_onair: "Undone: {what} is on air again", undone_held: "Undone: {what} is held again",
    undone_off: "Undone: {what} is off air again",
    factsCaption: "Facts cited by the story", fact: "Fact", value: "Value", notInLedger: "not in the ledger", events: "Events ", analyst: "Analyst: ",
    goals: ({ n }) => `${n} goal${n === "1" ? "" : "s"}`,
    pitch: ({ n, run }) => `Pitch map: ${n} evidence event${n === 1 ? "" : "s"}${run ? " and the run behind a speed fact" : ""}`,
    calls: "model calls", steps: "agent steps that used the model",
    stepsTip: "From the replay's traces, one row per agent step. A step can call the model more than once: the verifier checks the texts again after a rewrite. The measures count each call.",
    tokens: "tokens", cost: "model cost", yours: "of your actions", logCaption: "Audit log, newest first",
    colWho: "Who", colWhat: "What", colCost: "Tokens and cost",
    a_ai_off: "switched AI graphics off", a_ai_on: "switched AI graphics on", a_ask: "your question, {s}", a_auto: "auto-approved, risk {r} below {t}",
    a_approved: "approved", a_edited: "edited", a_used_proposal: "used the AI proposal", a_edit_refused: "edit refused", a_rejected: "rejected", a_undo: "undid the last action",
    auditEmpty: "None yet. Put a story on air, edit it or reject it and it shows up here.",
    pipeline: "How a story is made", noTraces: "No agent traces in this replay yet.", wholeRun: "Whole run", showStory: "Show story",
    traceSum: ({ n, tok, usd, s }) => `${n} hand-off${n === "1" ? "" : "s"}, ${tok} tokens, ${usd}, ${s} s`,
    traceShared: ({ n }) => `, counting this story's share of the ${n} shared with other stories`,
    rulesNoModel: "rules, no model", codeNoModel: "code, no model", in: "In", out: "Out",
    tokInOut: "{a} in, {b} out", zeroTokens: "0 tokens", sharedBy: ({ n }) => `, shared by ${n} stories`,
    how_ai: "AI", how_codeai: "Code and AI", how_rules: "Rules",
    ag_story_finder: "Story finder", ag_analyst: "Analyst", ag_commentator: "Commentator", ag_verifier: "Verifier", ag_director: "Director",
    ag_human: "You", ag_auto: "Auto-approval", ag_studio_host: "Studio host",
    role_story_finder: "Picks moments from the events the match clock releases.",
    role_analyst: "Describes the moment from its facts, citing fact ids.",
    role_commentator: "Writes the lines in English, Italian and Spanish.",
    role_verifier: "Checks every number against the fact ledger; rewrites twice at most, then a template line.",
    role_director: "Picks graphic, time and audience; never more than 2 on screen.",
    sec_air: "On air now", sec_needs: "Needs you", sec_done: "Done",
    missed: "Missed: {n}", row_aired: "aired at {m}', {by}",
    tip_st_auto_approved: "Low risk, so it goes on air by itself. Reject it if something looks wrong.",
    tip_st_needs_review: "It airs only if you put it on air: its risk is not low, or Content Safety flagged it.",
    tip_st_approved: "You put it on air.", tip_st_edited: "You changed its text and put it on air. The new text passed the number and name checks.",
    tip_st_rejected: "You kept it off air.", tip_st_expired: "Its moment passed before anyone put it on air, so it never aired.",
    tip_st_kill: "AI graphics are off. An AI agent picked this moment, so it stays off air even though code wrote its words. Switch AI back on to air it.",
    tip_st_template: "Made by code from the facts: no AI and no approval needed.",
    airEmpty: "Nothing on screen right now.", doneEmpty: "Nothing decided yet.",
    needsEmpty: "Nothing waits for you. The agents write these graphics, and a low-risk one goes on air by itself, any other waits here for you.",
    next: "Next", inS: "in {s} s", toAir: "airs in {s} s", toAirNow: "due on air now", toAirPast: "was due on air at {m}'", left: "{s} s left",
    takeOut: "Take out", g_pass_shot: "Pass and shot", g_nameplate: "Name plate", g_momentum: "Momentum", g_team_stats: "Team shape", g_lineup: "Line-ups", g_why_card: "Card",
    done_takenOut: "{what} taken out", skip: "Skip", why_gen: "made by code from the facts", k_checkin: "Player check-in",
    line_skipped: "Off air, skipped by you", row_skipped: "skipped by you", done_skipped: "{what} skipped, off air",
    line_expired: "Off air: missed, its moment passed before anyone put it on air", row_expired: "missed, nobody put it on air in time",
    row_rejected: "rejected by you", row_kill: "off air while AI graphics are off", info: "About your decisions",
    fHeadline: "Headline", fBody: "Text", emptyTitle: "The {name} headline cannot be empty.", factsLabel: "Facts: ",
    yourActions: "Your actions", colMinute: "Minute", costHead: "What the agents cost",
    y_ai_off: "AI graphics switched off", y_ai_on: "AI graphics switched on", y_undo: "Last action undone",
    keysDesk: "In the control desk", key_a: "Put the story on air", key_e: "Edit the story", key_r: "Reject the story, or take it off air",
    key_jk: "Next or previous story", key_u: "Undo the last decision",
    k_goal: "Goal", k_key_pass: "Key pass", k_momentum_swing: "Momentum swing", k_comeback: "Comeback", k_top_sprint: "Top sprint",
    k_high_press: "High press", k_tactical_shift: "Tactical shift", k_big_chance: "Big chance", k_pressing_spell: "Pressing spell", k_recap: "Recap",
  },
  it: {
    title: "Regia", close: "Chiudi", closeLabel: "Chiudi la regia",
    ai: "Grafiche IA ", on: "accese", off: "spente", loadingDecisions: "Caricamento delle tue decisioni", saving: "Salvataggio",
    waiting: "{n} in attesa", tabs: "Viste della regia", tabStories: "Storie", tabAudit: "Registro", tabTraces: "Tracce",
    kill: "IA spenta: in onda solo le grafiche standard. Le storie restano in elenco da rivedere.",
    footConnecting: "Connessione al server: la regia si sblocca quando arrivano le tue decisioni salvate.",
    footOnline: "Le tue decisioni sono salvate solo su questo browser. Gli altri visitatori vedono il replay originale.",
    footOffline: "Le decisioni restano solo in questa scheda. {why}", footNoServer: "Nessun server: le decisioni restano solo in questa scheda.",
    timeout: "Il server non ha risposto in tempo.", notSaved: "Non salvato: {why}", badChar: "il testo contiene un carattere che la regia non accetta",
    deskName: "Regia", deskWaiting: "{n} da rivedere", offline: "offline",
    loadingStories: "Caricamento delle storie.",
    noStories: "Ancora nessuna storia IA in questo replay. Le grafiche standard vanno in onda da sole; le storie compaiono qui dopo che gli agenti hanno lavorato sulla partita.",
    offair: "Fuori onda", goMinute: "Vai al minuto {m}", goTitle: "Vai a questo momento",
    st_auto_approved: "Approvata in automatico", st_needs_review: "Da rivedere", st_approved: "Approvata", st_edited: "Modificata e approvata", st_rejected: "Respinta",
    defaultWas: "Prima della tua decisione: {s}.", before_needs_review: "Prima della tua decisione aspettava te.", before_auto_approved: "Prima della tua decisione andava in onda da sola (rischio basso).", heldSafety: "in attesa: segnalata da Content Safety",
    line_live: "In onda, {by}", by_auto_approved: "approvata in automatico (rischio basso)", by_approved: "approvata da te", by_edited: "modificata e approvata da te", by_proposal: "proposta dell'IA mandata in onda da te", by_template: "grafica standard, non serve approvazione",
    line_held: "Aspetta una tua decisione, {why}", why_safety: "segnalata da Content Safety", line_rejected: "Fuori onda, respinta da te", line_kill: "Fuori onda finché le grafiche IA sono spente",
    details: "Dettagli", whyReject: "Cosa non andava?", r_number: "Un numero", r_player: "Un nome", r_moment: "Il momento", r_tone: "Il tono",
    risk_low: "Rischio basso", risk_mid: "Rischio medio", risk_high: "Rischio alto", riskTitle: "Punteggio di rischio {r}. Sotto {t} una storia va in onda da sola.",
    tip_low: "Rischio basso: va in onda da sola. Respingila se qualcosa non torna.",
    tip_lowHeld: "In attesa di un controllo di sicurezza: leggila prima di mandarla in onda.",
    tip_mid: "Confronta nomi e numeri con le prove prima che vada in onda.",
    tip_high: "Leggi prima le prove e le note. Respingila se un'affermazione non corrisponde.",
    dtOnAir: "In onda", dtDraft: "Bozza IA", dtVerifier: "Verificatore", dtSafety: "Sicurezza", none: "nessuno",
    attempts: ({ n }) => `, ${n} tentativ${n > 1 ? "i" : "o"}`,
    v_pass: "Superato", v_rewritten: "Superato dopo una riscrittura", v_template: "Frase modello", air_phrasebook: "Frasario (codice)", air_template: "Frase modello (codice)",
    d_pass: "Superata", d_rewritten: "Superata dopo una riscrittura", d_template: "Non usabile",
    n_rewritten: "Cosa sbagliavano le bozze precedenti", n_template: "Perché la frase con i soli fatti",
    dn_rewritten: "Cosa sbagliavano le bozze IA precedenti", dn_template: "Perché le bozze IA sono state scartate", notes: "Note del verificatore",
    s_passed: "Superato", s_flagged: "Segnalato", s_not_checked: "Non controllato",
    evidence: ({ f, e }) => `Prove: ${f} fatt${f === 1 ? "o" : "i"}, ${e} event${e === 1 ? "o" : "i"}`,
    put: "Manda in onda", approve: "Approva", edit: "Modifica", reject: "Respingi", showTrace: "Mostra la traccia",
    actLabel: "{label}: {kind} al minuto {m}",
    proposalOn: "Proposta IA, in onda: ", proposalOff: "Proposta IA, non in onda: ", useProposal: "Usa la proposta",
    lang_en: "Inglese", lang_it: "Italiano", lang_es: "Spagnolo", emptyText: "Il testo ({name}) non può essere vuoto. Respingi la storia per tenerla fuori onda.",
    cancel: "Annulla", saveApprove: "Salva e approva",
    done_approved: "Approvazione salvata: {what} in onda", done_kept: "Approvazione salvata: {what} resta in onda", done_edited: "Modifica salvata: {what} in onda", done_proposal: "Proposta dell'IA in onda: {what}", done_proposalKill: "Proposta dell'IA salvata: {what} andrà in onda quando riaccendi le grafiche IA",
    done_approvedKill: "Approvazione salvata: {what} andrà in onda quando riaccendi le grafiche IA",
    done_keptKill: "Approvazione salvata: {what} andrà in onda quando riaccendi le grafiche IA",
    done_editedKill: "Modifica salvata: {what} andrà in onda quando riaccendi le grafiche IA", done_rejected: "Storia respinta: {what} fuori onda",
    undo: "Annulla", undoLabel: "Annulla: {what}", undone_onair: "Annullato: {what} di nuovo in onda", undone_held: "Annullato: {what} di nuovo in attesa",
    undone_off: "Annullato: {what} di nuovo fuori onda",
    factsCaption: "Fatti citati dalla storia", fact: "Fatto", value: "Valore", notInLedger: "non è nel registro dei fatti", events: "Eventi ", analyst: "Analista: ",
    goals: ({ n }) => `${n} gol`,
    pitch: ({ n, run }) => `Mappa del campo: ${n} event${n === 1 ? "o" : "i"} citat${n === 1 ? "o" : "i"} come prova${run ? " e la corsa dietro un dato di velocità" : ""}`,
    calls: "chiamate al modello", steps: "passaggi degli agenti che hanno usato il modello",
    stepsTip: "Dalle tracce del replay, una riga per passaggio di un agente. Un passaggio può chiamare il modello più di una volta: il verificatore ricontrolla i testi dopo una riscrittura. Le misure contano ogni chiamata.",
    tokens: "token", cost: "costo dei modelli", yours: "azioni tue", logCaption: "Registro, dal più recente",
    colWho: "Chi", colWhat: "Cosa", colCost: "Token e costo",
    a_ai_off: "hai spento le grafiche IA", a_ai_on: "hai acceso le grafiche IA", a_ask: "la tua domanda, {s}", a_auto: "approvata in automatico, rischio {r} sotto {t}",
    a_approved: "approvata", a_edited: "modificata", a_used_proposal: "hai usato la proposta dell'IA", a_edit_refused: "modifica rifiutata", a_rejected: "respinta", a_undo: "hai annullato l'ultima azione",
    auditEmpty: "Ancora nessuna. Manda in onda, modifica o respingi una storia e comparirà qui.",
    pipeline: "Come nasce una storia", noTraces: "Ancora nessuna traccia degli agenti in questo replay.", wholeRun: "Tutto il giro", showStory: "Mostra la storia",
    traceSum: ({ n, tok, usd, s }) => `${n} passaggi${n === "1" ? "o" : ""} di consegne, ${tok} token, ${usd}, ${s} s`,
    traceShared: ({ n }) => `, contando la quota di questa storia nei ${n} condivisi con altre storie`,
    rulesNoModel: "solo regole", codeNoModel: "solo codice", in: "Input", out: "Output",
    tokInOut: "{a} in input, {b} in output", zeroTokens: "0 token", sharedBy: ({ n }) => `, condiviso da ${n} storie`,
    how_ai: "IA", how_codeai: "Codice e IA", how_rules: "Regole",
    ag_story_finder: "Cercastorie", ag_analyst: "Analista", ag_commentator: "Commentatore", ag_verifier: "Verificatore", ag_director: "Regista",
    ag_human: "Tu", ag_auto: "Approvazione automatica", ag_studio_host: "Conduttore",
    role_story_finder: "Sceglie i momenti tra gli eventi che l'orologio della partita rende disponibili.",
    role_analyst: "Descrive il momento dai suoi fatti, citando gli id dei fatti.",
    role_commentator: "Scrive le frasi in inglese, italiano e spagnolo.",
    role_verifier: "Controlla ogni numero sul registro dei fatti; riscrive al massimo due volte, poi usa una frase modello.",
    role_director: "Sceglie grafica, momento e pubblico; mai più di 2 sullo schermo.",
    sec_air: "In onda ora", sec_needs: "Aspettano te", sec_done: "Già decise",
    missed: "Perse: {n}", row_aired: ({ m, by }) => `in onda ${alMinute(m)}, ${by}`,
    tip_st_auto_approved: "Rischio basso: va in onda da sola. Respingila se qualcosa non torna.",
    tip_st_needs_review: "Va in onda solo se la mandi tu: il rischio non è basso, oppure Content Safety l'ha segnalata.",
    tip_st_approved: "L'hai mandata in onda tu.", tip_st_edited: "Hai cambiato il testo e l'hai mandata in onda. Il nuovo testo ha superato il controllo di numeri e nomi.",
    tip_st_rejected: "L'hai tenuta fuori onda.", tip_st_expired: "Il suo momento è passato prima che qualcuno la mandasse in onda: non è mai andata in onda.",
    tip_st_kill: "Le grafiche IA sono spente. Un agente IA ha scelto questo momento, quindi resta fuori onda anche se il testo l'ha scritto il codice. Riaccendi l'IA per mandarla in onda.",
    tip_st_template: "Fatta dal codice a partire dai fatti: niente IA, non serve approvazione.",
    airEmpty: "In questo momento non c'è niente in onda.", doneEmpty: "Ancora niente di deciso.",
    needsEmpty: "Non c'è niente da decidere. Queste grafiche le scrivono gli agenti, quelle a rischio basso vanno in onda da sole, le altre aspettano qui una tua decisione.",
    next: "Prossima", inS: "tra {s} s", toAir: "va in onda tra {s} s", toAirNow: "va in onda adesso", toAirPast: ({ m }) => `doveva andare in onda ${alMinute(m)}`, left: "ancora {s} s",
    takeOut: "Togli", g_pass_shot: "Passaggio e tiro", g_nameplate: "Scheda giocatore", g_momentum: "Inerzia", g_team_stats: "Assetto", g_lineup: "Formazioni", g_why_card: "Riquadro",
    done_takenOut: "Fuori onda: {what}", skip: "Salta", why_gen: "fatta dal codice con i fatti", k_checkin: "Numeri del giocatore",
    line_skipped: "Fuori onda, saltata da te", row_skipped: "saltata da te", done_skipped: "Saltata: {what} fuori onda",
    line_expired: "Fuori onda: persa, il suo momento è passato prima che qualcuno la mandasse in onda", row_expired: "persa, nessuno l'ha mandata in onda in tempo",
    row_rejected: "respinta da te", row_kill: "fuori onda finché le grafiche IA sono spente", info: "Sulle tue decisioni",
    fHeadline: "Titolo", fBody: "Testo", emptyTitle: "Il titolo ({name}) non può essere vuoto.", factsLabel: "Fatti: ",
    yourActions: "Le tue azioni", colMinute: "Minuto", costHead: "Quanto sono costati gli agenti",
    y_ai_off: "Grafiche IA spente", y_ai_on: "Grafiche IA accese", y_undo: "Ultima azione annullata",
    keysDesk: "Nella regia", key_a: "Manda in onda la storia", key_e: "Modifica la storia", key_r: "Respingi la storia o mandala fuori onda",
    key_jk: "Storia successiva o precedente", key_u: "Annulla l'ultima decisione",
    k_goal: "Gol", k_key_pass: "Passaggio chiave", k_momentum_swing: "Cambio di inerzia", k_comeback: "Rimonta", k_top_sprint: "Scatto più veloce",
    k_high_press: "Pressing alto", k_tactical_shift: "Cambio tattico", k_big_chance: "Grande occasione", k_pressing_spell: "Fase di pressing", k_recap: "Riepilogo",
  },
  es: {
    title: "Realización", close: "Cerrar", closeLabel: "Cerrar la realización",
    ai: "IA ", on: "encendida", off: "apagada", loadingDecisions: "Cargando tus decisiones", saving: "Guardando",
    waiting: "{n} en espera", tabs: "Vistas de la realización", tabStories: "Historias", tabAudit: "Registro", tabTraces: "Trazas",
    kill: "IA apagada: solo los gráficos estándar están en antena. Las historias siguen en la lista para revisarlas.",
    footConnecting: "Conectando con el servidor: la realización se desbloquea cuando lleguen tus decisiones guardadas.",
    footOnline: "Tus decisiones se guardan solo en este navegador. Los demás visitantes ven la repetición original.",
    footOffline: "Las decisiones se guardan solo en esta pestaña. {why}", footNoServer: "Sin servidor: las decisiones se guardan solo en esta pestaña.",
    timeout: "El servidor no ha respondido a tiempo.", notSaved: "No guardado: {why}", badChar: "el texto tiene un carácter que la realización no acepta",
    deskName: "Realización", deskWaiting: "{n} por revisar", offline: "sin conexión",
    loadingStories: "Cargando las historias.",
    noStories: "Todavía no hay historias de IA en esta repetición. Los gráficos estándar salen solos; las historias aparecen aquí cuando los agentes han trabajado sobre el partido.",
    offair: "Fuera de antena", goMinute: "Ir al minuto {m}", goTitle: "Ir a este momento",
    st_auto_approved: "Aprobada automáticamente", st_needs_review: "Por revisar", st_approved: "Aprobada", st_edited: "Editada y aprobada", st_rejected: "Rechazada",
    defaultWas: "Antes de tu decisión: {s}.", before_needs_review: "Antes de tu decisión esperaba tu revisión.", before_auto_approved: "Antes de tu decisión salía al aire sola (riesgo bajo).", heldSafety: "en espera: marcada por Content Safety",
    line_live: "En antena, {by}", by_auto_approved: "aprobada automáticamente (riesgo bajo)", by_approved: "aprobada por ti", by_edited: "editada y aprobada por ti", by_proposal: "propuesta de la IA puesta en antena por ti", by_template: "gráfico estándar, no necesita aprobación",
    line_held: "Espera tu decisión, {why}", why_safety: "marcada por Content Safety", line_rejected: "Fuera de antena, rechazada por ti", line_kill: "Fuera de antena mientras los gráficos de IA están apagados",
    details: "Detalles", whyReject: "¿Qué estaba mal?", r_number: "Un número", r_player: "Un nombre", r_moment: "El momento", r_tone: "El tono",
    risk_low: "Riesgo bajo", risk_mid: "Riesgo medio", risk_high: "Riesgo alto", riskTitle: "Puntuación de riesgo {r}. Por debajo de {t} una historia sale al aire sola.",
    tip_low: "Riesgo bajo: sale al aire sola. Recházala si algo no cuadra.",
    tip_lowHeld: "En espera de un control de seguridad: léela antes de emitirla.",
    tip_mid: "Comprueba los nombres y los números con las pruebas antes de que salga al aire.",
    tip_high: "Lee primero las pruebas y las notas. Recházala si una afirmación no coincide.",
    dtOnAir: "En antena", dtDraft: "Borrador de IA", dtVerifier: "Verificador", dtSafety: "Seguridad", none: "ninguno",
    attempts: ({ n }) => `, ${n} intento${n > 1 ? "s" : ""}`,
    v_pass: "Superado", v_rewritten: "Superado tras una reescritura", v_template: "Frase de plantilla", air_phrasebook: "Frasario (código)", air_template: "Frase de plantilla (código)",
    d_pass: "Superado", d_rewritten: "Superado tras una reescritura", d_template: "No utilizable",
    n_rewritten: "Qué fallaba en los borradores anteriores", n_template: "Por qué la frase solo con datos",
    dn_rewritten: "Qué fallaba en los borradores de IA anteriores", dn_template: "Por qué se descartaron los borradores de IA", notes: "Notas del verificador",
    s_passed: "Superado", s_flagged: "Marcado", s_not_checked: "Sin comprobar",
    evidence: ({ f, e }) => `Pruebas: ${f} dato${f === 1 ? "" : "s"}, ${e} evento${e === 1 ? "" : "s"}`,
    put: "Emitir", approve: "Aprobar", edit: "Editar", reject: "Rechazar", showTrace: "Ver la traza",
    actLabel: "{label}: {kind} en el minuto {m}",
    proposalOn: "Propuesta de IA, en antena: ", proposalOff: "Propuesta de IA, no emitida: ", useProposal: "Usar la propuesta",
    lang_en: "Inglés", lang_it: "Italiano", lang_es: "Español", emptyText: "El texto ({name}) no puede quedar vacío. Rechaza la historia para dejarla fuera de antena.",
    cancel: "Cancelar", saveApprove: "Guardar y aprobar",
    done_approved: "Aprobación guardada: {what} en antena", done_kept: "Aprobación guardada: {what} sigue en antena", done_edited: "Cambio guardado: {what} en antena", done_proposal: "Propuesta de la IA en antena: {what}", done_proposalKill: "Propuesta de la IA guardada: {what} saldrá al aire cuando vuelvas a encender los gráficos de IA",
    done_approvedKill: "Aprobación guardada: {what} saldrá al aire cuando vuelvas a encender los gráficos de IA",
    done_keptKill: "Aprobación guardada: {what} saldrá al aire cuando vuelvas a encender los gráficos de IA",
    done_editedKill: "Cambio guardado: {what} saldrá al aire cuando vuelvas a encender los gráficos de IA", done_rejected: "Rechazo guardado: {what} fuera de antena",
    undo: "Deshacer", undoLabel: "Deshacer: {what}", undone_onair: "Deshecho: {what} otra vez en antena", undone_held: "Deshecho: {what} otra vez en espera",
    undone_off: "Deshecho: {what} otra vez fuera de antena",
    factsCaption: "Datos citados por la historia", fact: "Dato", value: "Valor", notInLedger: "no está en el registro de datos", events: "Eventos ", analyst: "Analista: ",
    goals: ({ n }) => `${n} gol${n === "1" ? "" : "es"}`,
    pitch: ({ n, run }) => `Mapa del campo: ${n} evento${n === 1 ? "" : "s"} citado${n === 1 ? "" : "s"} como prueba${run ? " y la carrera detrás de un dato de velocidad" : ""}`,
    calls: "llamadas al modelo", steps: "pasos de los agentes que usaron el modelo",
    stepsTip: "De las trazas del replay, una fila por paso de un agente. Un paso puede llamar al modelo más de una vez: el verificador vuelve a revisar los textos tras una reescritura. Las medidas cuentan cada llamada.",
    tokens: "tokens", cost: "coste de los modelos", yours: "acciones tuyas", logCaption: "Registro, primero lo más reciente",
    colWho: "Quién", colWhat: "Qué", colCost: "Tokens y coste",
    a_ai_off: "has apagado los gráficos de IA", a_ai_on: "has encendido los gráficos de IA", a_ask: "tu pregunta, {s}", a_auto: "aprobada automáticamente, riesgo {r} por debajo de {t}",
    a_approved: "aprobada", a_edited: "editada", a_used_proposal: "has usado la propuesta de la IA", a_edit_refused: "edición rechazada", a_rejected: "rechazada", a_undo: "has deshecho la última acción",
    auditEmpty: "Todavía ninguna. Emite una historia, edítala o recházala y aparecerá aquí.",
    pipeline: "Cómo nace una historia", noTraces: "Todavía no hay trazas de los agentes en esta repetición.", wholeRun: "Toda la ejecución", showStory: "Ver la historia",
    traceSum: ({ n, tok, usd, s }) => `${n} relevo${n === "1" ? "" : "s"}, ${tok} tokens, ${usd}, ${s} s`,
    traceShared: ({ n }) => `, contando la parte de esta historia en los ${n} compartidos con otras historias`,
    rulesNoModel: "reglas, sin modelo", codeNoModel: "código, sin modelo", in: "Entrada", out: "Salida",
    tokInOut: "{a} de entrada, {b} de salida", zeroTokens: "0 tokens", sharedBy: ({ n }) => `, compartido por ${n} historias`,
    how_ai: "IA", how_codeai: "Código e IA", how_rules: "Reglas",
    ag_story_finder: "Buscahistorias", ag_analyst: "Analista", ag_commentator: "Comentarista", ag_verifier: "Verificador", ag_director: "Realizador",
    ag_human: "Tú", ag_auto: "Aprobación automática", ag_studio_host: "Presentador",
    role_story_finder: "Elige los momentos entre los eventos que libera el reloj del partido.",
    role_analyst: "Describe el momento a partir de sus datos, citando los id de los datos.",
    role_commentator: "Escribe las frases en inglés, italiano y español.",
    role_verifier: "Comprueba cada número con el registro de datos; reescribe dos veces como máximo y luego usa una frase de plantilla.",
    role_director: "Elige gráfico, momento y público; nunca más de 2 en pantalla.",
    sec_air: "En antena ahora", sec_needs: "Te esperan", sec_done: "Ya decididas",
    missed: "Perdidas: {n}", row_aired: "en antena en el {m}', {by}",
    tip_st_auto_approved: "Riesgo bajo: sale al aire sola. Recházala si algo no cuadra.",
    tip_st_needs_review: "Solo sale al aire si la pones tú: su riesgo no es bajo, o Content Safety la marcó.",
    tip_st_approved: "La pusiste en antena tú.", tip_st_edited: "Cambiaste su texto y la pusiste en antena. El texto nuevo pasó el control de números y nombres.",
    tip_st_rejected: "La dejaste fuera de antena.", tip_st_expired: "Su momento pasó antes de que alguien la pusiera en antena: nunca salió.",
    tip_st_kill: "Los gráficos de IA están apagados. Un agente de IA eligió este momento, así que sigue fuera de antena aunque su texto lo escribió el código. Vuelve a encender la IA para emitirlo.",
    tip_st_template: "Hecho por código a partir de los datos: sin IA y sin aprobación.",
    airEmpty: "Ahora no hay nada en antena.", doneEmpty: "Todavía no hay nada decidido.",
    needsEmpty: "No hay nada por decidir. Estos gráficos los escriben los agentes, los de riesgo bajo salen al aire solos, los demás esperan aquí tu decisión.",
    next: "Siguiente", inS: "en {s} s", toAir: "sale al aire en {s} s", toAirNow: "sale al aire ahora", toAirPast: "debía salir al aire en el {m}'", left: "quedan {s} s",
    takeOut: "Quitar", g_pass_shot: "Pase y tiro", g_nameplate: "Rótulo", g_momentum: "Dominio", g_team_stats: "Estructura", g_lineup: "Alineaciones", g_why_card: "Tarjeta",
    done_takenOut: "Fuera de antena: {what}", skip: "Saltar", why_gen: "hecho por código con los datos", k_checkin: "Números del jugador",
    line_skipped: "Fuera de antena, saltado por ti", row_skipped: "saltado por ti", done_skipped: "Saltado: {what} fuera de antena",
    line_expired: "Fuera de antena: perdida, su momento pasó antes de que alguien la pusiera en antena", row_expired: "perdida, nadie la puso en antena a tiempo",
    row_rejected: "rechazada por ti", row_kill: "fuera de antena mientras los gráficos de IA están apagados", info: "Sobre tus decisiones",
    fHeadline: "Titular", fBody: "Texto", emptyTitle: "El titular ({name}) no puede quedar vacío.", factsLabel: "Datos: ",
    yourActions: "Tus acciones", colMinute: "Minuto", costHead: "Lo que costaron los agentes",
    y_ai_off: "Gráficos de IA apagados", y_ai_on: "Gráficos de IA encendidos", y_undo: "Última acción deshecha",
    keysDesk: "En la realización", key_a: "Emitir la historia", key_e: "Editar la historia", key_r: "Rechazar la historia o quitarla de antena",
    key_jk: "Historia siguiente o anterior", key_u: "Deshacer la última decisión",
    k_goal: "Gol", k_key_pass: "Pase clave", k_momentum_swing: "Cambio de dominio", k_comeback: "Remontada", k_top_sprint: "Sprint más rápido",
    k_high_press: "Presión alta", k_tactical_shift: "Cambio táctico", k_big_chance: "Ocasión clara", k_pressing_spell: "Fase de presión", k_recap: "Resumen",
  },
};

/** A desk string in a page language, English when that language lacks it. */
/** Italian "al 10'" but "all'8'", "all'11'", "all'80'": the article elides before a vowel sound (otto, undici, uno). */
export function alMinute(m) { return /^(8|11?(?!\d))/.test(String(m)) ? `all'${m}'` : `al ${m}'`; }

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
const UNDO_MS = 10000; // how long an "Undone" notice stays; the Undo itself stays until the next decision
const EDIT_MAX = 600; // studiodesk/api.py EDIT_MAX_CHARS
const TITLE_MAX = 80; // studiodesk/api.py TITLE_MAX_CHARS
const LOOKAHEAD_S = 60; // a story whose first graphic is this close is listed, as Next
const MISS_S = 300; // an agents' story nobody decided on leaves Needs you 5 match minutes after its slot (or its moment, without a cue)
const ON_AIR = ["auto_approved", "approved", "edited"];
const REASONS = ["number", "player", "moment", "tone"]; // why a story was rejected, one tap each
const API_TIMEOUT_MS = 4000;
const CONNECT_TRIES = 3; // a slow first answer (a cold container) is not a reason to work offline for the whole visit
const RUN_MAX_FRAMES = 300; // a sprint run longer than 30 s is not a sprint: never draw a whole-match path
const SVGNS = "http://www.w3.org/2000/svg";
const FACT_ID = /F-[A-Z0-9_]+-\d+/g;

export const kindName = (k, lang) => TEXT[lang]?.[`k_${k}`] ?? TEXT[lang]?.[`g_${k}`] ?? TEXT.en[`k_${k}`] ?? TEXT.en[`g_${k}`] ?? String(k).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const usd = (v, lang = "en") => {
  const d = v >= 0.1 ? 2 : 4;
  return new Intl.NumberFormat(lang, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
};
const int = (v, lang = "en") => Number(v).toLocaleString(lang);
const dec = (v, lang, d) => Number(v).toLocaleString(lang, { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false });
const cap = (s, lang) => String(s).replace(/^./, (c) => c.toLocaleUpperCase(lang));

/** The desk action of a keydown, or null. Single keys work only with the focus in the desk and never in a
 *  text field (WCAG 2.1.4): A on air, E edit, R reject or take out, J and K next and previous, U undo, ? the list. */
export function deskKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || !e.key) return null;
  const t = e.target;
  if (!t?.closest?.("#desk") || t.closest("input, textarea, select, [contenteditable]")) return null;
  if (e.key === "?") return e.repeat ? null : "keys";
  if (e.shiftKey) return null;
  const k = { a: "air", e: "edit", r: "reject", j: "next", k: "prev", u: "undo" }[e.key.toLowerCase()] ?? null;
  return k && e.repeat && k !== "next" && k !== "prev" ? null : k; // held down, only J and K keep going
}

// DOM builder: text always goes in as text nodes, never as markup.
export function h(tag, attrs = {}, ...kids) {
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
    this.met = new Set(); // the ones this visitor saw waiting in Needs you: only those can be missed
    this.kill = false;
    this.online = false;
    this.offline = "";   // why decisions stay in this tab, when the API refused or did not answer
    this.ready = false;  // connect() has settled, online or not: until then the controls are disabled
    this.busy = false;   // a save is in flight
    this.lostFocus = null; // data-focus of a control that lost focus because it was disabled
    this.focusTo = null;   // data-focus the next render moves to: the next story waiting, after a decision
    this.loaded = false;
    this.auditRows = []; // from the API: this visitor's actions and the agents' rows
    this.localAudit = []; // without the API: this tab's actions
    this.tab = "stories";
    this.editing = null;
    this.drafts = new Map(); // `${story_id}|${key}` -> text typed in the editor (key: a language, or title_<lang>), kept until saved or cancelled
    this.more = new Set(); // stories whose Details are open
    this.live = new Set(); // stories with a graphic on screen now (app.js)
    this.liveCues = [];    // the cues on screen now, templates included
    this.reasons = new Map(); // story_id -> Set of REASONS; the API has no field for them, so they stay in this tab
    this.note = "";
    this.info = false;   // the note about where decisions are kept, opened from the info button
    this.dismissed = false; // closed from the info button while it had opened by itself
    this.lastAct = null; // {id, prev}: the last decision, while its Undo is offered
    this.done = null;    // {id, key}: the outcome the status line says
    this.factIndex = new Map(this.match.facts.map((f) => [f.fact_id, f]));
    this.eventIndex = new Map(this.match.events.map((e) => [e.event_id, e]));
    // per story: when its first graphic airs, when its last one ends, and its why_card cues
    this.firstAt = new Map();
    this.slotEnd = new Map();
    this.whyCues = new Map();
    for (const c of this.match.cues) {
      const id = c.story_id;
      if (!id) continue;
      if (!(this.firstAt.get(id) <= c.ts)) this.firstAt.set(id, c.ts);
      this.slotEnd.set(id, Math.max(this.slotEnd.get(id) ?? -Infinity, c.ts + c.duration_s));
      if (c.graphic === "why_card") this.whyCues.set(id, [...(this.whyCues.get(id) ?? []), c]);
    }
    // Generated graphics: each cue without a story (the code's panels and cards, built from the facts) is
    // a pseudo-story, one per slot across its languages, and goes through the desk the stories' way.
    this.gens = [];
    this.genOf = new Map();   // slot(cue) -> its generated graphic
    for (const c of this.match.cues) {
      if (c.story_id) continue;
      let g = this.genOf.get(slot(c));
      if (!g) {
        const p = c.payload ?? {}, aud = c.audience.split(":"), id = `G-${c.cue_id}`;
        const factTs = [...list(p.fact_ids), p.fact_id].map((f) => this.factIndex.get(f)?.ts).filter((t) => t !== undefined);
        g = { story_id: id, gen: c, kind: c.graphic === "why_card" ? p.kind ?? "why_card" : c.graphic, audience: c.audience,
          // listed once its facts are in, as a story is
          ts: Math.min(c.ts, factTs.length ? Math.max(...factTs) : c.ts),
          player_id: p.player_id ?? (aud[0] === "player" ? aud[1] : null), team_id: aud[0] === "team" ? aud[1] : null,
          default_status: GEN_WAITS(c) ? "needs_review" : "auto_approved", filler: !!p.filler };
        this.genOf.set(slot(c), g);
        this.gens.push(g);
        this.firstAt.set(id, c.ts);
        this.slotEnd.set(id, c.ts + c.duration_s);
      }
      if (c.lang === "en") g.gen = c;
      if (c.graphic === "why_card") this.whyCues.set(g.story_id, [...(this.whyCues.get(g.story_id) ?? []), c]);
    }
    this.byId = new Map(this.gens.map((g) => [g.story_id, g]));
    // Built once: the live regions stay in the page, so a render announces only a new message.
    this.headEl = h("header", { className: "desk-head" });
    this.infoEl = h("p", { className: "desk-note", id: "desk-note" });
    this.killEl = h("p", { className: "banner", role: "status" });
    this.noteEl = h("p", { className: "banner warn", role: "alert" });
    // the outcome of the last decision, polite, with its Undo next to it (outside the live region) and,
    // after a reject, what was wrong under it
    this.doneMsg = h("p", { className: "done-msg", role: "status" });
    this.undoBtn = h("button", { type: "button", className: "link undo", "data-focus": "undo", "aria-keyshortcuts": "U", onclick: () => this.undo() });
    this.reasonsEl = h("div", { className: "reasons" });
    this.doneEl = h("div", { className: "done" }, h("div", { className: "done-line" }, this.doneMsg, this.undoBtn), this.reasonsEl);
    this.bodyEl = h("div", { className: "desk-body", role: "tabpanel", tabindex: 0, "data-focus": "panel" });
    root.replaceChildren(this.headEl, this.infoEl, this.killEl, this.noteEl, this.doneEl, this.bodyEl);
    root.addEventListener("keydown", (e) => this.onKey(e));
  }

  tx(key, vars) { return tr(this.state.lang, key, vars); }

  locked() { return !this.ready || this.busy; }

  /** The replay's stories and traces: static files, no API. */
  async load() {
    const base = `data/${this.matchId}`;
    [this.stories, this.traces] = await Promise.all([optionalRows(`${base}/stories.json`, "story_id"), optionalRows(`${base}/traces.json`)]);
    this.stories.sort((a, b) => a.ts - b.ts);
    this.byId = new Map([...this.gens, ...this.stories].map((s) => [s.story_id, s]));
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
  // a story or generated graphic nobody decided on while it could air is missed ("expired") and leaves Needs
  // you for the missed count: a generated graphic when its slot ends, an agents' story MISS_S after it
  status(s) {
    const d = this.decisions.get(s.story_id)?.decision ?? this.defaultStatus(s), end = this.slotEnd.get(s.story_id);
    if (d !== "needs_review") return d;
    return this.state.ts >= (s.gen ? end : (end ?? this.firstOf(s)) + MISS_S) ? "expired" : d;
  }
  /** The status a tooltip explains: the AI switch and a filler first. */
  tipKey(s) {
    const st = this.status(s);
    return this.killed(s) && st !== "rejected" && st !== "expired" ? "kill" : s.filler && st === "auto_approved" ? "template" : st;
  }
  tip(s) { const k = `tip_st_${this.tipKey(s)}`; return this.tx(k) === k ? "" : this.tx(k); }
  // the AI switch holds the agents' stories; a generated graphic is code from the facts, as a template was
  killed(s) { return this.kill && !s.gen; }
  onAir(s) { return !this.killed(s) && ON_AIR.includes(this.status(s)); }

  // ---- the match so far -----------------------------------------------------------------------

  /** The generated graphic a storyless cue belongs to, in any language. */
  genFor(cue) { return this.genOf.get(slot(cue)); }
  firstOf(s) { return this.firstAt.get(s.story_id) ?? s.ts; }
  /** Listed: the match has reached its facts (live, it is written only then), and its first graphic has aired or airs within LOOKAHEAD_S. */
  visible(s, now = this.state.ts) { return s.ts <= now && this.firstOf(s) <= now + LOOKAHEAD_S; }
  isNext(s, now = this.state.ts) { return this.firstOf(s) > now; }
  /** The stories reached, and the generated graphics of the audience on screen: of those still waiting,
   *  only the soonest is listed, so at most one waits at a time (the others wait unlisted, or expire).
   *  A filler is never listed: it shows in On air now only, while it is on screen (airRows). */
  shown() {
    const gens = this.gens.filter((g) => g.audience === this.state.audience && !g.filler && this.visible(g));
    const wait = gens.filter((g) => this.status(g) === "needs_review").sort((a, b) => this.firstOf(a) - this.firstOf(b))[0];
    return [...this.stories.filter((s) => this.visible(s)), ...gens.filter((g) => g === wait || this.status(g) !== "needs_review")];
  }
  /** The stories waiting for this visitor, oldest first. */
  queue() {
    const q = this.shown().filter((s) => this.status(s) === "needs_review").sort((a, b) => this.firstOf(a) - this.firstOf(b));
    for (const s of q) this.met.add(s.story_id);
    return q;
  }
  pending() { return this.queue().length; }

  /** The cues to play for an audience and language, with this visitor's overlay applied. */
  sheet(cues, audience, lang) {
    const mine = cues.filter((c) => c.audience === audience);
    let own = mine.filter((c) => c.lang === lang);
    // template cues are written in English only until the agents translate them
    if (lang !== "en" && !own.some((c) => c.story_id === null)) own = own.concat(mine.filter((c) => c.lang === "en" && c.story_id === null));
    return own.flatMap((c) => {
      if (c.story_id === null) { const g = this.genOf.get(slot(c)); return g && this.onAir(g) ? [c] : []; }
      const s = this.byId.get(c.story_id); // a cue of a story nobody can review is held
      if (!s || !this.onAir(s)) return [];
      const ed = this.decisions.get(s.story_id)?.edited_text, body = ed?.[c.lang], title = ed?.[`title_${c.lang}`];
      return [(body || title) && c.graphic === "why_card" ? { ...c, payload: { ...c.payload, ...(body ? { body } : {}), ...(title ? { title } : {}) } } : c];
    });
  }

  /** The story's why_card for the audience on screen, in a language (English when it has none). */
  whyCue(s, lang) {
    const cs = this.whyCues.get(s.story_id) ?? [], aud = this.state.audience;
    return cs.find((c) => c.audience === aud && c.lang === lang) ?? cs.find((c) => c.audience === aud && c.lang === "en")
      ?? cs.find((c) => c.lang === lang) ?? cs[0] ?? null;
  }
  // What airs, unedited: the card's headline and body, else the story's own line
  origTitle(s, lang) { return this.whyCue(s, lang)?.payload?.title ?? null; }
  origText(s, lang) {
    const c = this.whyCue(s, lang);
    return (c?.lang === lang ? c.payload?.body : null) ?? s.texts?.[lang] ?? c?.payload?.body ?? s.texts?.en ?? "";
  }
  /** The headline that goes on air, with this visitor's edit. */
  title(s, lang) { return this.decisions.get(s.story_id)?.edited_text?.[`title_${lang}`] ?? this.origTitle(s, lang) ?? kindName(s.kind, lang); }
  titleLang(s, lang) { return this.decisions.get(s.story_id)?.edited_text?.[`title_${lang}`] ? lang : this.whyCue(s, lang)?.lang ?? "en"; }
  /** The language the story text is shown in: the asked one, or English when it has no such text. */
  textLang(s, lang) {
    const c = this.whyCue(s, lang);
    return (this.decisions.get(s.story_id)?.edited_text?.[lang] ?? (c?.lang === lang ? c.payload?.body : null) ?? s.texts?.[lang]) ? lang : "en";
  }
  text(s, lang) { return this.decisions.get(s.story_id)?.edited_text?.[lang] ?? this.origText(s, lang); }

  /** Agent text as a viewer reads it: a fact id becomes its label, a bracketed one goes. */
  plain(text) {
    return String(text ?? "").replace(/\s*\((?:F-[A-Z0-9_]+-\d+(?:,\s*)?)+\)/g, "")
      .replace(FACT_ID, (id) => this.factIndex.get(id)?.label_en ?? "a fact");
  }

  // ---- actions --------------------------------------------------------------------------------

  /** The story the focus goes to after a decision on s: the next one waiting, else the one before. */
  nextWaiting(id) {
    const q = this.queue().map((s) => s.story_id), i = q.indexOf(id);
    const next = i < 0 ? q[0] : q[i + 1] ?? q[i - 1];
    return next && next !== id ? `${next}:card` : "sec:needs";
  }

  // Only when the visitor is working in the desk: a decision from elsewhere (a test, the voice) leaves focus alone.
  aimFocus(key) {
    const a = document.activeElement;
    if (!a || a === document.body || this.root.contains(a)) this.focusTo = key;
  }

  /** undoing: this decision takes back the last one, so the status line says so and offers no Undo. */
  async decide(s, decision, editedText = null, undoing = false) {
    if (this.locked()) return;
    const id = s.story_id, prev = this.decisions.get(id), wasStatus = this.status(s), at = new Date().toISOString();
    if (!undoing) this.aimFocus(this.nextWaiting(id));
    this.decisions.set(id, { story_id: id, decision, edited_text: editedText, at, from: wasStatus, ts: this.state.ts }); // from: a generated graphic rejected while waiting was skipped, not taken out
    this.note = "";
    if (!this.online || s.gen) {
      this.localAudit.unshift({ at, ts: this.state.ts, actor: "human", action: this.usedProposal(s) ? "used_proposal" : decision, story_id: id, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0,
        detail: { langs: [...new Set(Object.keys(editedText ?? {}).map((k) => k.replace(/^title_/, "")))] } });
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
      this.focusTo = null;
      await this.refreshAudit(); // a refused edit is logged too
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

  /** A generated graphic off air, in every language: its pseudo-story rejected. */
  takeOut(cue) { return this.decide(this.genOf.get(slot(cue)), "rejected"); }

  // The status line says what the decision did on air; its Undo stays until the next decision.
  announce(s, prev, wasStatus, undoing) {
    const st = this.status(s), id = s.story_id;
    let key;
    if (undoing) key = `undone_${this.tally(s)}`;
    else {
      key = st === "rejected" ? (s.gen ? (wasStatus === "needs_review" ? "done_skipped" : "done_takenOut") : "done_rejected")
        : st === "edited" ? (this.usedProposal(s) ? "done_proposal" : "done_edited") : wasStatus === "auto_approved" ? "done_kept" : "done_approved";
      if (this.killed(s) && st !== "rejected") key += "Kill";
    }
    this.setDone({ id, key }, undoing ? null : { id, prev });
  }

  setDone(done, act) {
    this.done = done;
    this.lastAct = act;
    clearTimeout(this.doneTimer);
    // an "Undone" notice has no Undo, so it goes by itself
    if (!act) this.doneTimer = setTimeout(() => { if (this.done === done) { this.done = null; this.renderDone(); } }, UNDO_MS);
  }

  /** Takes back the last decision: the one before it again, or none (the story's default status). */
  async undo() {
    const u = this.lastAct;
    if (!u || this.locked()) return;
    const s = this.byId.get(u.id);
    if (!s) return;
    this.aimFocus(`${u.id}:card`); // the Undo is gone: focus goes back to the story it changed
    if (!this.online || s.gen) {
      if (u.prev) this.decisions.set(u.id, u.prev); else this.decisions.delete(u.id);
      this.localAudit.unshift({ at: new Date().toISOString(), ts: this.state.ts, actor: "human", action: "undo", story_id: u.id, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, detail: {} });
      this.announce(s, null, null, true);
      this.changed();
    } else if (u.prev) {
      await this.decide(s, u.prev.decision, u.prev.edited_text ?? null, true);
    } else {
      await this.clear(s);
    }
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
    if (!this.online) this.localAudit.unshift({ at: new Date().toISOString(), ts: this.state.ts, actor: "human", action: on ? "ai_off" : "ai_on", story_id: null, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, detail: {} });
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
    this.scrollToTop(g);
    g?.focus({ preventScroll: true });
  }

  // Brings el to the top of the desk's own scrolling list: scrollIntoView would scroll the page too, and the
  // masthead and the picture would leave the screen. Without a scrolling box in the desk (the page scrolls), as before.
  scrollToTop(el) {
    let box = el?.parentElement;
    while (box && box !== this.root.parentElement && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    if (!el || !box || box === this.root.parentElement) return el?.scrollIntoView({ block: "start" });
    box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top;
  }

  // ---- keys -----------------------------------------------------------------------------------

  onKey(e) {
    const k = deskKey(e);
    if (!k) return;
    if (k === "keys") {
      const d = document.querySelector("#keys");
      if (d?.showModal && !d.open) { e.preventDefault(); d.showModal(); }
      return;
    }
    if (k === "undo") { if (this.lastAct) { e.preventDefault(); this.undo(); } return; }
    if (this.tab !== "stories") return;
    const items = [...this.bodyEl.querySelectorAll("[data-item]")];
    const cur = document.activeElement?.closest?.("[data-item]");
    if (k === "next" || k === "prev") {
      if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(cur), d = k === "next" ? 1 : -1;
      const el = items[i < 0 ? (d > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, i + d))];
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest" });
      return;
    }
    // the story in focus, else the first one waiting
    const item = cur ?? this.bodyEl.querySelector(".sec-needs [data-item]");
    const b = item?.querySelector(`[data-key="${{ air: "a", edit: "e", reject: "r" }[k]}"]`);
    if (b && !b.disabled) { e.preventDefault(); b.click(); }
  }

  /** The desk's rows in the broadcast's key list (#keys, index.html), in the page language. */
  renderKeys() {
    const dl = document.querySelector("#keys-desk");
    if (!dl) return;
    const row = (keys, k) => [h("dt", {}, keys.map((x, i) => [i ? " " : "", h("kbd", {}, x)])), h("dd", {}, this.tx(k))];
    document.querySelector("#keys-desk-title")?.replaceChildren(this.tx("keysDesk"));
    dl.replaceChildren(...row(["A"], "key_a"), ...row(["E"], "key_e"), ...row(["R"], "key_r"), ...row(["J", "K"], "key_jk"), ...row(["U"], "key_u"));
  }

  // ---- rendering ------------------------------------------------------------------------------

  render() {
    const active = document.activeElement;
    const focusKey = this.focusTo ?? (active?.closest?.("#desk") ? active.dataset.focus : active === document.body || !active ? this.lostFocus : null);
    this.focusTo = null;
    const scroll = this.shownTab === this.tab ? this.bodyEl.scrollTop : 0;
    this.shownTab = this.tab;
    const locked = this.locked(), tx = (k, v) => this.tx(k, v);
    const lang = this.state.lang, n = this.pending(), shown = this.shown().length;
    const tabs = [["stories", tx("tabStories"), shown], ["audit", tx("tabAudit")], ["traces", tx("tabTraces")]];
    const tabButton = ([id, label, count]) => h("button", {
      // only the selected tab's panel exists, so only that tab names it
      type: "button", role: "tab", id: `tab-${id}`, "aria-controls": this.tab === id ? `panel-${id}` : null, "aria-selected": String(this.tab === id),
      tabindex: this.tab === id ? 0 : -1, "data-focus": `tab:${id}`, onclick: () => { this.tab = id; this.render(); },
      onkeydown: (e) => this.tabKeys(e, tabs.map((t) => t[0])),
    }, label, count !== undefined ? h("span", { className: "count" }, int(count, lang)) : null);
    const body = this.tab === "stories" ? this.renderStories() : this.tab === "audit" ? this.renderAudit() : this.renderTraces();
    const sum = !this.ready ? tx("loadingDecisions") : this.busy ? tx("saving") : this.stories.length ? tx("waiting", { n: int(n, lang) }) : "";
    this.root.setAttribute("aria-label", tx("title"));
    // one line: the desk, the AI switch, what waits; the tabs under it
    this.headEl.replaceChildren(
      h("div", { className: "desk-title" },
        h("h2", {}, tx("title")),
        h("button", { type: "button", role: "switch", id: "ai-switch", className: "switch", "aria-checked": String(!this.kill), "data-focus": "kill",
          disabled: locked, onclick: () => this.setKill(!this.kill) },
        h("span", { className: "switch-label" }, tx("ai"), h("b", {}, tx(this.kill ? "off" : "on"))),
        h("span", { className: "track", "aria-hidden": "true" }, h("span", { className: "knob" }))),
        h("span", { className: `desk-sum${this.ready && !this.busy ? " is-count" : ""}` }, sum),
        h("button", { type: "button", id: "desk-close", className: "ctl", "aria-label": tx("closeLabel"), "data-focus": "close",
          onclick: () => this.closeDrawer() }, tx("close"))),
      h("div", { className: "desk-tabs" },
        h("div", { role: "tablist", "aria-label": tx("tabs"), className: "tabs" }, tabs.map(tabButton)),
        h("button", { type: "button", id: "desk-info", className: "info", "aria-controls": "desk-note",
          "aria-label": tx("info"), title: tx("info"), "data-focus": "info", onclick: () => { this.info = this.infoEl.hidden; this.dismissed = !this.info; this.render(); } }, "i")));
    const why = this.offline === "timeout" ? tx("timeout") : this.offline.replace(/^./, (c) => c.toUpperCase()).replace(/([^.])$/, "$1.");
    setText(this.infoEl, !this.ready ? tx("footConnecting") : this.online ? tx("footOnline") : this.offline ? tx("footOffline", { why }) : tx("footNoServer"));
    // opened from the info button, or by itself when the server refused or did not answer
    this.infoEl.hidden = !(this.info || (!this.dismissed && this.ready && !this.online && this.offline));
    this.root.querySelector("#desk-info")?.setAttribute("aria-expanded", String(!this.infoEl.hidden));
    setText(this.killEl, this.kill ? tx("kill") : "");
    setText(this.noteEl, this.note);
    this.renderDone();
    this.renderKeys();
    this.bodyEl.id = `panel-${this.tab}`;
    this.bodyEl.setAttribute("aria-labelledby", `tab-${this.tab}`);
    this.bodyEl.replaceChildren(...[body].flat(Infinity).filter(Boolean)); // replaceChildren would print a null as "null"
    this.bodyEl.scrollTop = scroll;
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
    // editor, or an action that is gone once taken, hands it to Edit, else to the story itself
    const find = (k) => this.root.querySelector(`[data-focus="${CSS.escape(k)}"]`);
    const el = focusKey ? find(focusKey) ?? find(focusKey.replace(/:[^:]+(:\w+)?$/, ":edited")) ?? find(focusKey.replace(/:[^:]+(:\w+)?$/, ":card")) : null;
    this.lostFocus = el?.disabled ? focusKey : null;
    if (el && !el.disabled && el !== document.activeElement) {
      el.focus({ preventScroll: true });
      if (el.matches("[data-item], h3")) el.scrollIntoView({ block: "nearest" });
    }
  }

  renderDone() {
    const d = this.done, s = d?.id && this.byId.get(d.id);
    const what = s ? this.what(s) : "";
    setText(this.doneMsg, what ? this.tx(d.key, { what }) : "");
    const undo = Boolean(what && this.lastAct?.id === d.id);
    this.undoBtn.hidden = !undo;
    this.undoBtn.disabled = this.locked();
    this.undoBtn.replaceChildren(this.tx("undo"), kbd("u"));
    if (undo) this.undoBtn.setAttribute("aria-label", this.tx("undoLabel", { what }));
    else this.undoBtn.removeAttribute("aria-label");
    // what was wrong with a rejected story, one tap per reason, under the message: kept in this tab and in its audit row
    const rejected = undo && s && d.key === "done_rejected";
    this.reasonsEl.hidden = !rejected;
    if (!rejected) { this.reasonsEl.replaceChildren(); return; }
    const id = s.story_id, mine = this.reasons.get(id) ?? new Set();
    const toggle = (r, b) => {
      if (!mine.delete(r)) mine.add(r);
      this.reasons.set(id, mine);
      b.setAttribute("aria-pressed", String(mine.has(r)));
    };
    this.reasonsEl.setAttribute("role", "group");
    this.reasonsEl.setAttribute("aria-labelledby", "why-reject");
    this.reasonsEl.replaceChildren(h("span", { id: "why-reject" }, this.tx("whyReject")),
      ...REASONS.map((r) => h("button", { type: "button", className: "ctl chip", "aria-pressed": String(mine.has(r)), "data-focus": `${id}:why:${r}`,
        onclick: (e) => toggle(r, e.currentTarget) }, this.tx(`r_${r}`))));
  }

  // "10'" or "45+2'": a match time as the lines say it
  clockText(ts) {
    const c = this.match.clock(ts), base = c.period === 1 ? 45 : 90;
    return c.minute > base ? `${base}+${c.minute - base}` : String(c.minute);
  }
  minuteText(s) { return this.clockText(s.gen ? this.firstOf(s) : s.ts); }

  // "Goal 10'": a story as the status line and the buttons name it
  what(s) { return `${kindName(s.kind, this.state.lang)} ${this.minuteText(s)}'`; }

  byKey(s) { const st = this.status(s); return st === "edited" && this.usedProposal(s) ? "by_proposal" : `by_${st}`; }

  tally(s) { return this.onAir(s) ? "onair" : this.status(s) === "needs_review" && !this.killed(s) ? "held" : "off"; }

  // As the card shows it: a story cleared for air but not on screen now is "approved", not "On air"
  tallyOf(s) { const t = this.tally(s); return t === "onair" && !this.live.has(s.story_id) ? "approved" : t; }

  // The card's one status line: on screen or not, and who decided
  stateLine(s) {
    const st = this.status(s), t = this.tallyOf(s), lang = this.state.lang;
    if (t === "held") return this.tx("line_held", { why: s.gen ? this.tx("why_gen") : s.safety === "flagged" ? this.tx("why_safety") : this.tx(`risk_${riskBand(Number(s.risk))}`).toLocaleLowerCase(lang) });
    if (t === "off") return this.tx(st === "expired" ? "line_expired" : st === "rejected" ? (this.skipped(s) ? "line_skipped" : "line_rejected") : this.killed(s) ? "line_kill" : "offair");
    const by = this.tx(s.filler && st === "auto_approved" ? "by_template" : this.byKey(s));  // as the proof panel says
    return t === "onair" ? this.tx("line_live", { by }) : cap(by, lang);
  }

  // A Done row in a few words: who decided, or why it stays off air
  outcome(s) {
    const st = this.status(s);
    const by = this.tx(st === "expired" ? "row_expired" : st === "rejected" ? (this.skipped(s) ? "row_skipped" : "row_rejected") : this.killed(s) ? "row_kill" : this.byKey(s));
    return this.aired(s) ? this.tx("row_aired", { m: this.clockText(this.firstOf(s)), by }) : by;
  }
  // the history of what aired: on air by the rule, or decided in this tab (match time ts) before its slot ended,
  // and the clock past its first graphic; a decision made after the slot, or read back from the API, claims nothing
  aired(s) {
    const d = this.decisions.get(s.story_id);
    return this.onAir(s) && this.firstOf(s) <= this.state.ts && (!d || d.ts < (this.slotEnd.get(s.story_id) ?? Infinity));
  }
  // a generated graphic that waited for the visitor and was not put on air
  skipped(s) { return Boolean(s.gen) && this.decisions.get(s.story_id)?.from === "needs_review"; }

  // Time words that change every second: how long to air, how long left on screen
  when(el) {
    const now = this.state.ts, [mode, id] = el.dataset.when.split("|");
    if (mode === "left") {
      const end = Math.max(...this.liveCues.filter((c) => (c.story_id ?? this.genOf.get(slot(c))?.story_id) === id).map((c) => c.ts + c.duration_s));
      return Number.isFinite(end) ? this.tx("left", { s: int(Math.max(0, Math.ceil(end - now)), this.state.lang) }) : "";
    }
    const s = this.byId.get(id), at = s ? this.firstOf(s) : now, sec = int(Math.ceil(at - now), this.state.lang);
    if (mode === "in") return at > now ? this.tx("inS", { s: sec }) : "";
    return at > now ? this.tx("toAir", { s: sec }) : now < (this.slotEnd.get(id) ?? at) ? this.tx("toAirNow") : this.tx("toAirPast", { m: this.clockText(at) });
  }
  whenSpan(mode, id) { const el = h("span", { className: `when when-${mode}`, "data-when": `${mode}|${id}` }); el.textContent = this.when(el); return el; }

  /** The cues on screen now, from app.js every frame. The list is redrawn only when what is on screen,
   *  or which stories the match has reached, changes, and never under the visitor's typing. */
  setLive(cues) {
    const now = this.state.ts;
    this.liveCues = cues;
    this.live = new Set(cues.map((c) => c.story_id ?? this.genOf.get(slot(c))?.story_id).filter(Boolean));
    // a story, or a generated graphic of the audience on screen, also counts once it is missed (3)
    const reach = [...this.stories, ...this.gens.filter((g) => g.audience === this.state.audience)]
      .map((s) => (this.status(s) === "expired" ? 3 : this.firstOf(s) <= now ? 2 : this.visible(s, now) ? 1 : 0)).join("");
    const key = `${cues.map((c) => c.cue_id).sort().join(" ")}|${reach}`;
    const a = document.activeElement, typing = this.root.contains(a) && a.matches("input, textarea");
    if (key !== this.liveKey && !typing) { this.liveKey = key; this.render(); return; }
    const sec = Math.floor(now);
    if (sec !== this.tick) {
      this.tick = sec;
      for (const el of this.bodyEl.querySelectorAll("[data-when]")) setText(el, this.when(el));
    }
  }

  tabKeys(e, ids) {
    const i = ids.indexOf(this.tab), step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (step === undefined && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    this.tab = ids[e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : (i + step + ids.length) % ids.length];
    this.render();
    this.root.querySelector(`#tab-${this.tab}`).focus();
  }

  // ---- the stories tab: on air now, needs you, done ------------------------------------------

  renderStories() {
    const tx = (k, v) => this.tx(k, v), shown = this.shown();
    const needs = this.queue();
    const done = shown.filter((s) => !["needs_review", "expired"].includes(this.status(s)) && !this.live.has(s.story_id));
    // one whose moment passed before the visitor got there (a link to the 8th minute) was never theirs to miss
    const missed = shown.filter((s) => this.status(s) === "expired" && this.met.has(s.story_id)).sort((a, b) => this.firstOf(b) - this.firstOf(a));
    // Next first, soonest first; then the rest, latest first
    done.sort((a, b) => (this.isNext(b) - this.isNext(a)) || (this.isNext(a) ? this.firstOf(a) - this.firstOf(b) : this.firstOf(b) - this.firstOf(a)));
    const air = this.airRows();
    const section = (id, items, empty) => h("section", { className: `sec sec-${id}`, "aria-labelledby": `sec-${id}` },
      h("h3", { id: `sec-${id}`, tabindex: -1, "data-focus": `sec:${id}` }, tx(`sec_${id}`), h("span", { className: "count" }, int(items.length, this.state.lang))),
      items.length ? h("ul", { className: "items" }, items.map((x) => h("li", {}, x))) : h("p", { className: "empty" }, empty));
    const needsEmpty = !this.loaded ? tx("loadingStories") : !this.stories.length ? tx("noStories") : tx("needsEmpty");
    return [
      section("air", air, tx("airEmpty")),
      section("needs", needs.map((s) => this.renderCard(s)), needsEmpty),
      section("done", done.map((s) => this.renderRow(s)), tx("doneEmpty")),
      // the missed ones are counted, not listed among the decisions; their rows open on demand
      // open stays open across the redraws a playing replay makes (each new cue redraws the list)
      missed.length ? h("details", { className: "missed", "data-focus": "sec:missed", open: this.missedOpen, ontoggle: (e) => { this.missedOpen = e.target.open; } },
        h("summary", { title: tx("tip_st_expired") }, tx("missed", { n: int(missed.length, this.state.lang) })),
        h("ul", { className: "items" }, missed.map((s) => h("li", {}, this.renderRow(s))))) : null,
    ];
  }

  // A button with its key: one filled action where a decision waits, the rest outlined or quiet
  act(s, decision, label, cls, key, onclick) {
    const id = s.story_id, kind = kindName(s.kind, this.state.lang), who = this.who(s);
    return h("button", {
      type: "button", className: `${cls} act act-${decision}`, "data-focus": `${id}:${decision}`, "data-key": key, "aria-keyshortcuts": key?.toUpperCase(),
      "aria-label": `${this.tx("actLabel", { label, kind, m: this.minuteText(s) })}${who ? `, ${who}` : ""}`, disabled: this.locked(),
      onclick: onclick ?? (() => (decision === "edited" ? this.startEdit(s) : this.decide(s, decision))),
    }, label, key ? kbd(key) : null);
  }

  who(s) { return s.player_id ? this.match.players[s.player_id]?.name : this.match.teams[s.team_id]?.short_name; }

  minuteButton(s) {
    const m = this.minuteText(s);
    return h("button", { type: "button", className: "minute", "data-focus": `${s.story_id}:go`, "aria-label": this.tx("goMinute", { m }),
      title: this.tx("goTitle"), onclick: () => this.seek(Math.max(0, this.firstOf(s) - 1)) }, `${m}'`);
  }

  // What will air, as the viewer reads it: the kicker, the headline, the body
  airText(s) {
    const lang = this.state.lang, c = this.whyCue(s, lang);
    if (s.gen && !c) return null; // a panel: its name and subject in the heading say it all
    return [
      c ? h("p", { className: "kicker" }, (KICKER[lang] ?? KICKER.en)[c.payload?.kind] ?? "") : null,
      h("p", { className: "headline", lang: this.titleLang(s, lang) }, this.title(s, lang)),
      h("p", { className: "story-text", lang: this.textLang(s, lang) }, this.text(s, lang)),
    ];
  }

  // On air now: one row per story or generated graphic on screen
  airRows() {
    const seen = new Set(), rows = [];
    for (const c of [...this.liveCues].sort((a, b) => a.ts - b.ts)) {
      const s = c.story_id ? this.byId.get(c.story_id) : this.genOf.get(slot(c));
      if (!s || seen.has(s.story_id)) continue;
      seen.add(s.story_id);
      rows.push(this.renderAir(s));
    }
    return rows;
  }

  renderAir(s) {
    const id = s.story_id, tx = (k, v) => this.tx(k, v), editing = this.editing === id;
    return h("article", { className: "story air", "data-tally": this.tallyOf(s), id: `story-${id}`, "aria-labelledby": `h-${id}`,
      "data-item": "", tabindex: -1, "data-focus": `${id}:card` },
      this.storyHead(s, this.whenSpan("left", id)),
      h("p", { className: "tally", title: this.tip(s) }, this.stateLine(s)),
      editing ? this.renderEditor(s) : this.airText(s),
      editing ? null : h("div", { className: "actions" },
        this.act(s, "rejected", tx("takeOut"), "ctl", "r"),
        s.gen ? null : this.act(s, "edited", tx("edit"), "quiet", "e")),
      s.gen ? null : this.renderDetails(s));
  }

  storyHead(s, extra) {
    const lang = this.state.lang, who = this.who(s);
    return h("div", { className: "story-head" }, this.minuteButton(s),
      h("h4", { id: `h-${s.story_id}` }, kindName(s.kind, lang), who ? h("span", { className: "who" }, who) : null),
      extra);
  }

  // Needs you: what will air, why it waits, and one filled action
  renderCard(s) {
    const id = s.story_id, tx = (k, v) => this.tx(k, v), editing = this.editing === id;
    const next = this.isNext(s);
    return h("article", { className: "story", "data-tally": this.tallyOf(s), id: `story-${id}`, "aria-labelledby": `h-${id}`,
      "data-item": "", tabindex: -1, "data-focus": `${id}:card` },
      this.storyHead(s, next ? h("span", { className: "tag" }, tx("next")) : null),
      h("p", { className: "tally" }, h("span", { title: this.tip(s) }, this.stateLine(s)), this.whenSpan("air", id)),
      editing ? this.renderEditor(s) : this.airText(s),
      // the actions come before Details, so they stay in view when it opens
      editing ? null : h("div", { className: "actions" },
        this.act(s, "approved", tx(this.killed(s) ? "approve" : "put"), "ctl primary", "a"),
        s.gen ? null : this.act(s, "edited", tx("edit"), "ctl", "e"),
        this.act(s, "rejected", tx(s.gen ? "skip" : "reject"), "quiet", "r")),
      s.gen ? null : this.renderDetails(s));
  }

  // Done: one line per story, its quiet actions at the end
  renderRow(s) {
    const id = s.story_id, tx = (k, v) => this.tx(k, v), editing = this.editing === id, lang = this.state.lang;
    const st = this.status(s), rejected = st === "rejected", next = this.isNext(s);
    // a generated graphic whose moment has passed can no longer change what airs
    const over = st === "expired" || (s.gen && this.state.ts >= this.slotEnd.get(s.story_id));
    return h("div", { className: "row", "data-tally": this.tallyOf(s), id: `story-${id}`, "aria-labelledby": `h-${id}`, role: "group",
      "data-item": "", tabindex: -1, "data-focus": `${id}:card` },
      h("div", { className: "row-line" },
        this.minuteButton(s),
        h("b", { id: `h-${id}`, className: "kind" }, kindName(s.kind, lang)),
        h("span", { className: "outcome", title: this.tip(s) }, this.outcome(s)),
        next ? [h("span", { className: "tag" }, tx("next")), this.whenSpan("in", id)] : null,
        editing || over ? null : h("span", { className: "row-acts" },
          rejected ? this.act(s, "approved", tx(this.killed(s) ? "approve" : "put"), "quiet", "a") : this.act(s, "rejected", tx(s.gen ? "takeOut" : "reject"), "quiet", "r"),
          s.gen ? null : this.act(s, "edited", tx("edit"), "quiet", "e"))),
      editing ? this.renderEditor(s) : null,
      s.gen ? null : this.renderDetails(s));
  }

  // Details, one level: why it waits, the checks, the earlier drafts, the evidence. Built once opened.
  renderDetails(s) {
    const id = s.story_id;
    const det = h("details", { className: "more", ...(this.more.has(id) ? { open: true } : {}) },
      h("summary", { "data-focus": `${id}:more` }, this.tx("details")));
    const fill = () => { if (det.open && det.children.length === 1) det.append(...this.detailsBody(s)); };
    det.addEventListener("toggle", () => {
      if (det.open) this.more.add(id); else this.more.delete(id);
      fill();
    });
    fill();
    return det;
  }

  detailsBody(s) {
    const lang = this.state.lang, st = this.status(s), id = s.story_id, tx = (k, v) => this.tx(k, v);
    const v = s.verifier ?? {}, flagged = list(v.flagged);
    const risk = Number(s.risk), band = riskBand(risk);
    const tip = band === "low" && this.defaultStatus(s) !== "auto_approved" ? "tip_lowHeld" : `tip_${band}`;
    const status = (x) => (tx(`st_${x}`) === `st_${x}` ? x : tx(`st_${x}`));
    const facts = list(s.fact_ids).map((f) => this.factIndex.get(f) ?? { fact_id: f, missing: true });
    const events = list(s.evidence_event_ids).map((e) => this.eventIndex.get(e) ?? { event_id: e, missing: true });
    return [
      // why it waits: the risk band (its score in the tooltip), or the safety flag, and what to do
      h("p", { className: "why" },
        h("span", { className: `risk risk-${band}`, title: tx("riskTitle", { r: dec(risk, lang, 2), t: dec(AUTO_RISK, lang, 2) }) },
          h("b", {}, s.safety === "flagged" ? cap(tx("why_safety"), lang) : tx(`risk_${band}`)),
          h("span", { className: "meter", "aria-hidden": "true" }, h("span", { style: `width:${Math.round(Math.min(1, Math.max(0, risk)) * 100)}%` }))),
        " ", tx(tip)),
      this.decisions.has(id) ? h("p", { className: "default" }, TEXT.en[`before_${this.defaultStatus(s)}`] ? tx(`before_${this.defaultStatus(s)}`)
        : tx("defaultWas", { s: status(this.defaultStatus(s)).toLocaleLowerCase(lang) })) : null,
      s.safety === "flagged" && s.default_status === "auto_approved" && st !== "needs_review" ? h("p", { className: "default" }, tx("heldSafety")) : null,
      this.editing === id ? null : this.renderProposal(s, lang),
      h("dl", { className: "checks" },
        v.on_air ? h("div", {}, h("dt", {}, tx("dtOnAir")), h("dd", {}, TEXT.en[`air_${v.on_air}`] ? tx(`air_${v.on_air}`) : v.on_air)) : null,
        h("div", {}, h("dt", {}, tx(v.on_air ? "dtDraft" : "dtVerifier")), h("dd", { className: `v-${v.status}` },
          TEXT.en[`${v.on_air ? "d" : "v"}_${v.status}`] ? tx(`${v.on_air ? "d" : "v"}_${v.status}`) : v.status ?? tx("none"),
          v.attempts ? tx("attempts", { n: v.attempts }) : "")),
        h("div", {}, h("dt", {}, tx("dtSafety")), h("dd", { className: `s-${s.safety}` }, TEXT.en[`s_${s.safety}`] ? tx(`s_${s.safety}`) : s.safety))),
      // the earlier drafts, as a plain list
      flagged.length ? [h("p", { className: "sub" }, TEXT.en[`n_${v.status}`] ? tx(`${v.on_air ? "dn" : "n"}_${v.status}`) : tx("notes")),
        h("ul", { className: "flagged", lang: "en" }, flagged.map((f) => h("li", {}, this.plain(flagText(f)))))] : null,
      h("p", { className: "sub" }, tx("evidence", { f: facts.length, e: events.length })),
      h("div", { className: "ev-grid" },
        this.miniPitch(s, facts, events),
        h("table", { className: "facts" },
          h("caption", { className: "sr" }, tx("factsCaption")),
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, tx("fact")), h("th", { scope: "col" }, tx("value")))),
          h("tbody", {}, facts.map((f) => h("tr", { className: f.missing ? "missing" : "" },
            // the ledger's labels are English
            h("td", {}, f.missing ? h("span", { className: "flabel" }, tx("notInLedger")) : h("span", { className: "flabel", lang: "en" }, f.label_en ?? "")),
            h("td", { className: "num" }, f.missing ? "" : valueText(f, lang))))))),
      events.some((e) => !e.missing) ? h("p", { className: "events" }, tx("events"), h("span", { lang: "en" },
        events.filter((e) => !e.missing).map((e) => `${e.type_name.replace(/_/g, " ")} (${this.match.players[e.player_id]?.name ?? ""})`).join(", "))) : null,
      s.analysis_en ? h("p", { className: "analysis" }, h("b", {}, tx("analyst")), h("span", { lang: "en" }, this.plain(s.analysis_en))) : null,
      this.traceGroups().has(id) ? h("button", { type: "button", className: "link", "data-focus": `${id}:trace`, onclick: () => this.showTrace(id) }, tx("showTrace")) : null,
    ].flat().filter(Boolean);
  }

  // The AI's own line, kept off air: one click puts it on air in all three languages, as an edit.
  renderProposal(s, lang) {
    const p = s.verifier?.proposals;
    if (!p) return null;
    const text = p[lang] ?? p.en ?? "";
    const using = this.usedProposal(s);
    return h("div", { className: "proposal" },
      h("p", { className: "proposal-text" }, h("b", {}, this.tx(using ? "proposalOn" : "proposalOff")), h("span", { lang: p[lang] ? lang : "en" }, text)),
      using ? null : h("button", { type: "button", className: "ctl", "data-focus": `${s.story_id}:proposal`, disabled: this.locked(),
        onclick: () => this.decide(s, "edited", { ...p }) }, this.tx("useProposal")));
  }

  // The visitor's edit is the AI proposal word for word: on air as an edit, but said and logged as the AI's line
  usedProposal(s) {
    const p = s.verifier?.proposals, e = this.decisions.get(s.story_id)?.edited_text;
    return !!p && !!e && Object.keys(e).length === LANGS.length && LANGS.every((l) => e[l] === p[l]);
  }

  startEdit(s) {
    this.editing = s.story_id;
    this.render();
    this.root.querySelector(`[data-focus="${CSS.escape(`${s.story_id}:text:${this.state.lang}`)}"]`)?.focus();
  }

  // All three languages in one editor, the headline and the body of each: saving approves what goes on
  // air in every language, so the reviewer sees every one. Unchanged text saves as a plain approval.
  renderEditor(s) {
    const id = s.story_id, locked = this.locked(), tx = (k, v) => this.tx(k, v);
    const keys = (e) => {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    };
    const field = (tag, key, value, max, focus, extra) => {
      const el = h(tag, { id: `${key.startsWith("title_") ? "title" : "edit"}-${id}-${key.replace(/^title_/, "")}`, lang: key.replace(/^title_/, ""), maxlength: max,
        "data-focus": focus, onkeydown: keys, ...extra });
      el.value = this.drafts.get(`${id}|${key}`) ?? value; // a draft survives a re-render and a failed save
      return el;
    };
    const sets = LANGS.map((lang) => {
      const name = tx(`lang_${lang}`), hasTitle = this.origTitle(s, lang) !== null;
      const counter = h("span", { className: "counter", id: `count-${id}-${lang}` });
      const area = field("textarea", lang, this.text(s, lang), EDIT_MAX, `${id}:text:${lang}`, { rows: 3, "aria-describedby": `count-${id}-${lang}` });
      const count = () => { counter.textContent = `${area.value.length}/${EDIT_MAX}`; };
      count();
      area.addEventListener("input", () => { this.drafts.set(`${id}|${lang}`, area.value); count(); });
      const title = hasTitle ? field("input", `title_${lang}`, this.title(s, lang), TITLE_MAX, `${id}:title:${lang}`, { type: "text" }) : null;
      title?.addEventListener("input", () => this.drafts.set(`${id}|title_${lang}`, title.value));
      return h("fieldset", { className: "edit-lang" }, h("legend", {}, name),
        title ? [h("label", { for: title.id }, tx("fHeadline")), title] : null,
        h("label", { for: area.id }, tx("fBody")), area, counter);
    });
    const save = () => {
      if (this.locked()) return;
      const texts = {};
      for (const l of LANGS) {
        const name = tx(`lang_${l}`);
        const v = (this.drafts.get(`${id}|${l}`) ?? this.text(s, l)).trim();
        if (!v) { this.note = tx("emptyText", { name }); this.render(); return; }
        if (v !== this.origText(s, l)) texts[l] = v;
        if (this.origTitle(s, l) === null) continue;
        const t = (this.drafts.get(`${id}|title_${l}`) ?? this.title(s, l)).trim();
        if (!t) { this.note = tx("emptyTitle", { name }); this.render(); return; }
        if (t !== this.origTitle(s, l)) texts[`title_${l}`] = t;
      }
      if (Object.keys(texts).length) this.decide(s, "edited", texts); else this.decide(s, "approved");
    };
    const cancel = () => { this.endEdit(id); this.focusTo = `${id}:edited`; this.render(); };
    return h("div", { className: "editor" }, sets,
      h("div", { className: "editor-bar" },
        h("button", { type: "button", className: "ctl", "data-focus": `${id}:cancel`, disabled: locked, onclick: cancel }, tx("cancel")),
        h("button", { type: "button", className: "ctl primary", "data-focus": `${id}:save`, disabled: locked, onclick: save }, tx("saveApprove"))));
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
        h("svg:title", {}, `${e.type_name.replace(/_/g, " ")}, ${this.match.players[e.player_id]?.name ?? ""}`),
        h("svg:line", { x1: x0, y1: y0, x2: x1 - ux * 1.6, y2: y1 - uy * 1.6, stroke: c, className: "ev" }),
        len > 2 ? h("svg:polygon", { fill: c, points: `${x1},${y1} ${x1 - ux * 2.6 - uy * 1.3},${y1 - uy * 2.6 + ux * 1.3} ${x1 - ux * 2.6 + uy * 1.3},${y1 - uy * 2.6 - ux * 1.3}` }) : null,
        h("svg:circle", { cx: x0, cy: y0, r: 1.4, fill: c, className: "dot" })));
    }
    const n = events.filter((e) => !e.missing).length;
    return h("svg:svg", { viewBox: "-2 -2 109 72", className: "mini", role: "img",
      "aria-label": this.tx("pitch", { n, run: marks.length > n }) }, lines, marks);
  }

  // ---- audit and traces -----------------------------------------------------------------------

  // Audit: the agents' rows (from the API, or from the replay traces) and this visitor's actions.
  auditData() {
    const fromApi = this.auditRows.filter((r) => r.actor !== "human" && r.actor !== "auto");
    // the visitor's own questions (studio_host, POST api/ask) are no reason to drop the replay's traces
    const asks = fromApi.filter((r) => r.actor === "studio_host");
    const agents = fromApi.length > asks.length ? fromApi : [...asks, ...this.traces.map((t) => ({ at: t.at, ts: t.ts, actor: t.agent, action: t.step,
      story_id: this.traceStory(t), model: t.model, tokens_in: t.tokens_in, tokens_out: t.tokens_out, cost_usd: t.cost_usd }))];
    const directorAt = new Map(this.traces.filter((t) => t.agent === "director").flatMap((t) => this.traceStories(t).map((id) => [id, t.at])));
    // the API lists the risk rule's approvals itself; without it the desk derives them from the replay
    const auto = this.online ? this.auditRows.filter((r) => r.actor === "auto") : this.stories.filter((s) => this.defaultStatus(s) === "auto_approved")
      .map((s) => ({ at: directorAt.get(s.story_id) ?? "", actor: "auto", action: "auto_approved", story_id: s.story_id, model: null,
        tokens_in: 0, tokens_out: 0, cost_usd: 0, detail: { risk: s.risk } }));
    // online, the generated graphics' decisions are this tab's only (the API keeps S- ids)
    const humans = [...(this.online ? this.auditRows.filter((r) => r.actor === "human") : []), ...this.localAudit];
    const byAt = (a, b) => String(b.at).localeCompare(String(a.at));
    const reached = (r) => !this.byId.has(r.story_id) || this.visible(this.byId.get(r.story_id)); // no spoilers, as in Stories
    // the table is the whole trail: the producer's decisions too, among the agents' steps
    return { rows: [...auto, ...agents, ...humans].filter(reached).sort(byAt), agents, humans: [...humans].sort(byAt), steps: agents !== fromApi };
  }

  renderAudit() {
    const { rows, agents, humans, steps } = this.auditData();
    const lang = this.state.lang, tx = (k, v) => this.tx(k, v);
    const calls = agents.filter((r) => r.model);
    const tokens = agents.reduce((n, r) => n + r.tokens_in + r.tokens_out, 0), cost = agents.reduce((n, r) => n + r.cost_usd, 0);
    const utc = (r) => (r.at ? `${String(r.at).slice(11, 19)} UTC` : null);
    // a row's match minute: its story's, else the match time it was logged at
    const minute = (r) => (this.byId.has(r.story_id) ? `${this.minuteText(this.byId.get(r.story_id))}'` : Number.isFinite(r.ts) ? `${this.clockText(r.ts)}'` : "");
    const said = new Set(); // rows run newest first: a story's reject reasons go on its latest reject
    const what = (r) => {
      if (r.actor !== "human" && r.actor !== "auto" && r.actor !== "studio_host") return h("span", { lang: "en" }, String(r.action).replace(/_/g, " ")); // an agent's step
      if (r.action === "ai_off" || r.action === "ai_on" || r.action === "undo") return tx(`a_${r.action}`);
      if (r.action === "ask") return tx("a_ask", { s: r.detail?.status ?? "asked" });
      if (r.action === "auto_approved") return tx("a_auto", { r: dec(r.detail?.risk, lang, 2), t: dec(AUTO_RISK, lang, 2) });
      const a = TEXT.en[`a_${r.action}`] ? tx(`a_${r.action}`) : String(r.action).replace(/_/g, " ");
      const why = r.action === "rejected" && !said.has(r.story_id) ? [...(this.reasons.get(r.story_id) ?? [])] : [];
      if (r.action === "rejected") said.add(r.story_id);
      return a + (r.detail?.langs?.length ? ` (${r.detail.langs.join(", ")})` : "") + (why.length ? `: ${why.map((x) => tx(`r_${x}`).toLocaleLowerCase(lang)).join(", ")}` : "");
    };
    // "23' Goal, rejected: a number": this visitor's own actions first, in match minutes
    const mine = humans.map((r) => {
      const s = this.byId.get(r.story_id);
      const line = s ? `${this.minuteText(s)}' ${kindName(s.kind, lang)}, ${what(r)}` : TEXT.en[`y_${r.action}`] ? tx(`y_${r.action}`) : cap(what(r), lang);
      return h("li", { title: utc(r) }, line);
    });
    return h("div", { className: "audit" },
      h("h3", { className: "audit-head" }, tx("yourActions")),
      mine.length ? h("ol", { className: "mine" }, mine) : h("p", { className: "empty" }, tx("auditEmpty")),
      // a narrow desk scrolls the table sideways instead of cutting its last column
      rows.length ? [h("h3", { className: "audit-head" }, tx("logCaption")), h("div", { className: "log-wrap", role: "region", tabindex: 0, "aria-label": tx("logCaption") }, h("table", { className: "log" },
        h("caption", { className: "sr" }, tx("logCaption")),
        h("thead", {}, h("tr", {}, ["colMinute", "colWho", "colWhat", "colCost"].map((c) => h("th", { scope: "col" }, tx(c))))),
        h("tbody", {}, rows.map((r) => h("tr", { className: `a-${r.actor === "auto" || r.actor === "human" ? r.actor : "agent"}` },
          h("td", { className: "num", title: utc(r) }, minute(r)),
          // the model under its agent, and the story by its name and minute
          h("td", {}, agentName(r.actor, lang), r.model ? h("span", { className: "model", lang: "en" }, r.model) : null),
          h("td", {}, what(r), r.story_id && this.byId.has(r.story_id) ? h("span", { className: "sid" }, this.what(this.byId.get(r.story_id))) : null),
          h("td", { className: "num" }, r.tokens_in + r.tokens_out ? [int(r.tokens_in + r.tokens_out, lang), h("br"), usd(r.cost_usd, lang)] : ""))))))] : null,
      // what it cost, last: a reviewer comes for the decisions
      h("h3", { className: "audit-head" }, tx("costHead")),
      h("div", { className: "totals" },
        h("div", steps ? { title: tx("stepsTip") } : {}, h("b", {}, int(calls.length, lang)), ` ${tx(steps ? "steps" : "calls")}`),
        h("div", {}, h("b", {}, int(tokens, lang)), ` ${tx("tokens")}`),
        h("div", {}, h("b", {}, usd(cost, lang)), ` ${tx("cost")}`),
        h("div", {}, h("b", {}, int(humans.length, lang)), ` ${tx("yours")}`)));
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
    const label = (f) => this.factIndex.get(f)?.label_en ?? "a fact";
    // a story the match has not reached stays hidden here too: its heading would spoil the replay
    return [legend, [...this.traceGroups()].filter(([sid]) => !this.byId.has(sid) || this.visible(this.byId.get(sid))).map(([sid, { rows, sum }]) => {
      const s = this.byId.get(sid);
      const shared = rows.filter((x) => x.shared > 1).length;
      return h("section", { className: "trace", "data-trace": sid, "data-focus": `trace:${sid}`, tabindex: -1, "aria-labelledby": `t-${sid || "run"}` },
        h("h3", { id: `t-${sid || "run"}` }, s ? `${this.minuteText(s)}' ${kindName(s.kind, lang)}` : tx("wholeRun"),
          s ? h("button", { type: "button", className: "link", "data-focus": `${sid}:show`, onclick: () => this.showStory(sid) }, tx("showStory")) : null),
        h("p", { className: "trace-sum" }, tx("traceSum", { n: int(rows.length, lang), tok: int(Math.round(sum.tokens), lang), usd: usd(sum.cost, lang), s: dec(sum.ms / 1000, lang, 1) }),
          shared ? tx("traceShared", { n: int(shared, lang) }) : ""),
        h("ol", { className: "chain" }, rows.map(({ t: r, shared: n }) => h("li", { "data-agent": String(r.agent).replace(/_[a-z]{2}$/, ""), className: traceFailed(r) ? "failed" : "" },
          // the step, the model and the summaries are agent output: English
          h("div", { className: "step-head" }, h("b", {}, agentName(r.agent, lang)), h("span", { className: "step", lang: "en" }, r.step),
            h("span", { className: "how", lang: r.model ? "en" : null }, r.model ?? tx(HOW[String(r.agent).replace(/_[a-z]{2}$/, "")] === "rules" ? "rulesNoModel" : "codeNoModel"))),
          h("p", { className: "io" }, h("span", { className: "io-k" }, tx("in")), h("span", { lang: "en" }, this.plain(summaryText(r.input_summary)))),
          h("p", { className: "io" }, h("span", { className: "io-k" }, tx("out")), h("span", { lang: "en" }, this.plain(summaryText(r.output_summary)))),
          h("p", { className: "step-meta" },
            r.tokens_in ? tx("tokInOut", { a: int(r.tokens_in, lang), b: int(r.tokens_out, lang) }) : tx("zeroTokens"), `, ${int(r.latency_ms, lang)} ms`, r.cost_usd ? `, ${usd(r.cost_usd, lang)}` : "",
            n > 1 ? tx("sharedBy", { n: int(n, lang) }) : ""),
          // the facts it used, by their labels: an id is a debug code to a viewer
          list(r.fact_ids).length ? h("p", { className: "fids" }, tx("factsLabel"), h("span", { lang: "en" }, [...new Set(list(r.fact_ids).map(label))].join(", "))) : null))));
    })];
  }

  showStory(id) {
    const s = this.byId.get(id);
    if (s && !this.visible(s)) this.seek(Math.max(0, this.firstOf(s) - 1)); // a story the match has not reached: go there
    this.tab = "stories";
    this.render();
    const el = this.root.querySelector(`#story-${CSS.escape(id)}`);
    this.scrollToTop(el);
    el?.querySelector(".minute")?.focus({ preventScroll: true });
  }

  /** The drawer (narrow screens) is a bottom sheet over the page, modal: the page behind leaves the tab order while it is open. */
  setDrawer(open) {
    document.body.classList.toggle("desk-open", open);
    document.querySelector("#app").inert = open;
    for (const [k, v] of [["role", "dialog"], ["aria-modal", "true"]]) if (open) this.root.setAttribute(k, v); else this.root.removeAttribute(k);
    document.querySelector("#desk-open")?.setAttribute("aria-expanded", String(open));
    if (open) window.scrollTo({ top: 0 }); // the broadcast sits above the sheet
  }

  closeDrawer() {
    this.setDrawer(false);
    document.querySelector("#desk-open")?.focus();
  }
}

// A key next to a button label; the button's aria-keyshortcuts says it to a screen reader
// a template graphic has one cue per language: taking it out takes it out in every language
const slot = (c) => `${c.graphic}|${c.due ?? c.ts}|${c.audience}`;   // a card held past a replay keeps its slot (view3d.js holdForReplays)
// The graphics the code adds per audience (studiodesk/agents/audiences.py _generated: the kids sheet, the
// player check-ins, the analyst's team shape panels) wait for the visitor; the template graphics (momentum,
// name plate, pass and shot, from the fact ledger alone) go on air by the risk rule, as they always did. So do
// the fillers (payload.filler, audiences.py fill_cues): they keep every sheet from going a minute with nothing.
export const GEN_WAITS = (c) => !c.payload?.filler && (c.audience === "kids" || c.payload?.kind === "checkin" || c.graphic === "team_stats");
const kbd = (k) => h("kbd", { "aria-hidden": "true" }, k.toUpperCase());

// A live region announces any text change, the same text included: write only a new one.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

export function valueText(f, lang = "en") {
  const v = Number(f.value);
  const n = Number.isInteger(v) ? String(v) : dec(v, lang, Math.abs(v) >= 100 ? 0 : 1);
  if (f.unit === "formation") return String(Math.round(v)).split("").join("-"); // 442 is 4-4-2
  return f.unit === "/10" ? `${n}/10` : f.unit === "goals" ? tr(lang, "goals", { n }) : `${n} ${f.unit ?? ""}`.trim();
}

function flagText(f) {
  if (typeof f === "string") return f;
  if (f && typeof f === "object") {
    const parts = [f.claim ? `"${f.claim}"` : null, f.reason ?? f.text ?? null].filter(Boolean);
    return parts.length ? parts.join(" ") : JSON.stringify(f);
  }
  return String(f);
}
