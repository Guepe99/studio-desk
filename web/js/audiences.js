// "Same moment, several audiences" (docs/CONTRACT.md, Page additions): under the page, the story on air
// (or the latest one the clock has reached) as each audience on the menu sees it, side by side, in the
// page language. A card's button switches the broadcast to that audience. Text from stories.json
// (texts_by_audience, written by code from the facts), always set as text. The DOM changes only when
// the story, the language, the audience or this visitor's edit changes.

const STRINGS = {
  en: { title: "Same moment, several audiences", hint: "Pick one to watch the broadcast as that audience does.",
    none: "No story yet at this point of the match." },
  it: { title: "Lo stesso momento, per ogni pubblico", hint: "Scegline uno per vedere la trasmissione come la vede quel pubblico.",
    none: "Ancora nessuna storia a questo punto della partita." },
  es: { title: "El mismo momento, para cada público", hint: "Elige uno para ver la retransmisión como la ve ese público.",
    none: "Todavía no hay ninguna historia en este punto del partido." },
};

/** The line an audience sees on air (studiodesk/agents/audiences.py text_for): its own, else the casual
 *  one (never for the analyst, who keeps the line its voice clip says), else the story's `texts`. */
export function lineFor(s, audience, lang) {
  const own = s.texts_by_audience ?? {};
  if (audience !== "analyst") {
    for (const k of [audience, "casual"]) if (own[k]?.[lang]) return own[k][lang];
  }
  return s.texts?.[lang] ?? null;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class AudienceBox {
  /** @param {HTMLElement} root  the #audiences section
   *  @param {{stories: object[], decisions: Map, onAir: Function, what: Function}} desk  the desk, which loads the stories
   *  @param {{label: (aud: string) => string|null, pick: (aud: string) => void}} opts  the menu's name for an
   *         audience (null when the menu has no such item) and the switch */
  constructor(root, desk, { label, pick }) {
    Object.assign(this, { root, desk, label, pick, key: null });
    this.titleEl = el("h2", "aud-title");
    this.titleEl.id = "aud-title";
    this.subEl = el("p", "aud-sub");
    this.hintEl = el("p", "sr");
    this.hintEl.id = "aud-hint";
    this.listEl = el("ul", "aud-list");
    root.setAttribute("aria-labelledby", "aud-title");
    root.replaceChildren(this.titleEl, this.subEl, this.hintEl, this.listEl);
    this.listEl.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-aud]");
      if (b) this.pick(b.dataset.aud);
    });
  }

  /** The story to show: the one on air, else the latest cleared for air whose moment the clock has reached. */
  story(onAirId, now) {
    if (onAirId) return this.desk.byId?.get(onAirId) ?? null;
    let best = null;
    for (const s of this.desk.stories) if (s.ts <= now && this.desk.onAir(s)) best = s;
    return best;
  }

  /** Every frame: the story graphic on air (or null), the clock, the page language and the audience on screen. */
  update(onAirId, now, lang, audience) {
    const has = this.desk.stories.length > 0;
    this.root.hidden = !has;
    if (!has) return;
    const s = this.story(onAirId, now), ed = s && this.desk.decisions.get(s.story_id)?.edited_text;
    const key = [s?.story_id, lang, audience, JSON.stringify(ed ?? null)].join("|");
    if (key === this.key) return;
    this.key = key;
    const w = STRINGS[lang] ?? STRINGS.en;
    this.root.lang = lang;
    this.titleEl.textContent = w.title;
    this.hintEl.textContent = w.hint;
    this.subEl.textContent = s ? this.desk.what(s) : w.none;
    if (!s) { this.listEl.replaceChildren(); return; }
    const { home, away } = this.desk.match;
    const auds = ["analyst", "casual", "kids", `team:${home.team_id}`, `team:${away.team_id}`];
    if (s.player_id) auds.push(`player:${s.player_id}`);
    const cards = [];
    for (const aud of auds) {
      const name = this.label(aud);
      if (!name) continue; // not on the menu: nothing to switch to
      // this visitor's edit replaces the line for every audience, as the cue sheet does (desk.js sheet)
      const asked = ed?.[lang] ?? lineFor(s, aud, lang), text = asked ?? ed?.en ?? lineFor(s, aud, "en") ?? "";
      // a word joiner after the dash keeps a score ("1-0") on one line
      const li = el("li", "aud-card"), b = el("button", "aud-pick", name), p = el("p", "aud-text", text.replace(/(\d)-(\d)/g, "$1-⁠$2"));
      Object.assign(b, { type: "button" });
      b.dataset.aud = aud;
      b.setAttribute("aria-pressed", String(aud === audience));
      b.setAttribute("aria-describedby", "aud-hint");
      p.lang = asked ? lang : "en";
      li.classList.toggle("on", aud === audience);
      li.append(b, p);
      cards.push(li);
    }
    // a click on a card re-renders the cards: the focus stays on that audience's button
    const focused = this.listEl.contains(document.activeElement) ? document.activeElement.dataset.aud : null;
    this.listEl.replaceChildren(...cards);
    if (focused) this.listEl.querySelector(`button[data-aud="${CSS.escape(focused)}"]`)?.focus();
  }
}
