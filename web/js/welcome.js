// First look: a short welcome for a visitor who opens the site cold (a judge with a minute to spare).
// One sentence on what Studio Desk is, one button to the first goal with sound, one to kick-off. A native modal
// dialog: the focus moves in, Escape closes it, the page behind is inert. It shows once per browser, and never
// on a deep link (a shared moment, a chosen match or view): that visitor already knows where they are going.

export const KEY = "studiodesk.welcome";

// merged into app.js STRINGS (data-i18n in index.html)
export const WELCOME_STRINGS = {
  en: { welcomeTitle: "Welcome to Studio Desk",
    welcomeText: "Studio Desk is an AI production desk for football: agents write the TV graphics from the match data, and you approve what goes on air.",
    welcomeGoal: "Watch the first goal, with sound", welcomeStart: "Start from kick-off" },
  it: { welcomeTitle: "Ti diamo il benvenuto in Studio Desk",
    welcomeText: "Studio Desk è una regia con IA per il calcio: gli agenti scrivono le grafiche TV dai dati della partita e tu approvi cosa va in onda.",
    welcomeGoal: "Guarda il primo gol, con l'audio", welcomeStart: "Parti dal calcio d'inizio" },
  es: { welcomeTitle: "Te damos la bienvenida a Studio Desk",
    welcomeText: "Studio Desk es un control de realización con IA para el fútbol: los agentes escriben los gráficos de TV con los datos del partido y tú apruebas qué sale al aire.",
    welcomeGoal: "Ver el primer gol, con sonido", welcomeStart: "Empezar desde el saque inicial" },
};

/** A plain first visit: no URL parameter but lang, and not dismissed in this browser before. Storage that
 *  throws (site data blocked) shows it: a cold visitor must see it, even if it cannot be remembered. */
export function wantsWelcome(search, store) {
  if ([...new URLSearchParams(search).keys()].some((k) => k !== "lang")) return false;
  try { return store?.getItem(KEY) !== "done"; } catch { return true; }
}

/** Opens the dialog; any way out (a button, Escape) remembers it. Each button closes it, then acts in the same
 *  click, so sound may start: browsers allow it only inside a user gesture. */
export function openWelcome(dialog, { firstGoal, kickoff, store }) {
  dialog.addEventListener("close", () => { try { store?.setItem(KEY, "done"); } catch { /* not remembered */ } }, { once: true });
  for (const [id, act] of [["#welcome-goal", firstGoal], ["#welcome-start", kickoff]]) {
    dialog.querySelector(id).addEventListener("click", () => { dialog.close(); act(); });
  }
  dialog.showModal();
}
