// Broadcast delay (docs/delay.md). With a delay of D seconds the control desk runs at the live time and the
// picture (2D, 3D and the graphics on it) D seconds behind, as a broadcaster's delay line does. A story whose
// graphic was ready within D seconds of its moment then goes on the delayed picture at that moment: its cues
// move earlier by up to D seconds, never before the moment, so the goal graphic lands on the goal. Nothing
// here reads past the live time: the shift comes from the times the cues reached air.

// 0 is today's page; 5 s is the classic sports delay, 10 s covers every story latency measured live
// (docs/MEASURES.md: 3.7, 5.6 and 9.7 s), 15 s stays inside what HD delay units hold (20 s).
export const DELAYS = [0, 5, 10, 15];

/** ?delay= or a menu value: one of DELAYS, else 0. */
export function delayFrom(v) {
  const n = Number(v);
  return DELAYS.includes(n) ? n : 0;
}

// a story's moment: the one event it cites (a shot, a sprint) when at most this long before the story
const MOMENT_WINDOW_S = 10;

/** The moment a story is about: its one cited event within 10 s before it, else the story's own time
 *  (a recap, a pressing spell, a shift: a window that ends then). eventTs: Map event_id -> ts. */
export function storyMoment(story, eventTs) {
  const ids = story.evidence_event_ids ?? [];
  const ts = ids.length === 1 ? eventTs.get(ids[0]) : undefined;
  return ts !== undefined && ts <= story.ts && ts >= story.ts - MOMENT_WINDOW_S ? ts : story.ts;
}

/** Per story: its moment, when its first cue reached air (ready), and lead = ready - moment.
 *  A story with no cue is left out. */
export function storyTimes(cues, stories, events) {
  const eventTs = new Map(events.map((e) => [e.event_id, e.ts]));
  const first = new Map();
  for (const c of cues) if (c.story_id && !(first.get(c.story_id) <= c.ts)) first.set(c.story_id, c.ts);
  return stories.filter((s) => first.has(s.story_id)).map((s) => {
    const moment = storyMoment(s, eventTs), ready = first.get(s.story_id);
    return { story_id: s.story_id, kind: s.kind, moment, ready, lead: ready - moment };
  });
}

/** How many seconds earlier each story's cues go on a picture delayed by `delay`: story_id -> seconds. */
export function shifts(cues, stories, events, delay) {
  if (!delay) return new Map();
  return new Map(storyTimes(cues, stories, events).map((r) => [r.story_id, Math.max(0, Math.min(delay, r.lead))]));
}

/** The cue sheet on the delayed picture: a story's cues all move by its shift (their order and gaps
 *  stay), the code's own cues stay put. delay 0 gives back the same array. */
export function delayCues(cues, stories, events, delay) {
  const by = shifts(cues, stories, events, delay);
  if (![...by.values()].some(Boolean)) return cues;
  const at = (x) => Math.round(x * 100) / 100;
  return cues.map((c) => (by.get(c.story_id) ? { ...c, ts: at(c.ts - by.get(c.story_id)) } : c)).sort((a, b) => a.ts - b.ts);
}

/** In the page, before the desk is built: the match's cues as the delayed picture plays them. A replay with
 *  no stories.json (template cues only) has nothing to move. */
export async function delayMatch(match, base, delay) {
  if (!delay) return;
  let stories = [];
  try { const r = await fetch(`${base}/stories.json`); if (r.ok) stories = await r.json(); } catch { /* nothing to move */ }
  match.cues = delayCues(match.cues, stories, match.events, delay);
}

/** The badge under the score bug: hidden without a delay. */
export function showDelay(el, delay, t) {
  el.hidden = !delay;
  el.textContent = delay ? t("delayOn").replace("{s}", delay) : "";
  el.title = delay ? t("delayWhy").replace("{s}", delay) : "";
}

/** A change of delay rebuilds the cue sheet and the desk: the page reloads at the same moment, with the
 *  same language, view, audience, speed and play state. state: app.js state; view: the 3D view's mode or "". */
export function delayUrl(search, delay, state, view = "") {
  const p = new URLSearchParams(search);
  const put = (k, v, on) => (on ? p.set(k, String(v)) : p.delete(k));
  put("delay", delay, delay);
  put("t", Math.floor(state.ts * 10) / 10, true);
  put("play", 1, state.playing);
  put("lang", state.lang, true);
  put("speed", state.speed, state.speed !== 1);
  put("audience", state.audience, state.audience !== "analyst");
  put("view", view, view);
  return `?${p}`;
}

export const DELAY_STRINGS = {
  en: { delay: "Broadcast delay", delayOn: "Delay {s} s", delayWhy: "The picture runs {s} seconds behind the control desk",
    whyDelay: "The picture runs this far behind the desk, as on live TV: a goal graphic lands on the goal and you see each story first. A change reloads the page." },
  it: { delay: "Ritardo di trasmissione", delayOn: "Ritardo {s} s", delayWhy: "L'immagine va in onda {s} secondi dopo la regia",
    whyDelay: "L'immagine va in onda con questo ritardo sulla regia, come in TV: la grafica del gol arriva sul gol e tu vedi ogni storia prima. Cambiarlo ricarica la pagina." },
  es: { delay: "Retardo de emisión", delayOn: "Retardo {s} s", delayWhy: "La imagen va {s} segundos por detrás de la realización",
    whyDelay: "La imagen sale con este retardo respecto a la realización, como en la tele en directo: el gráfico del gol llega con el gol y tú ves antes cada historia. Cambiarlo recarga la página." },
};
