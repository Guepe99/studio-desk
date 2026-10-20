// Agent activity (docs/CONTRACT.md, Page additions): the last hand-offs of traces.json that the replay
// clock has reached (ts <= now), so a viewer sees the agents work as the match goes. While a story
// graphic is on air it shows how that graphic was made instead: the chain of its story. Reads only the
// replay's traces (loaded by the desk). The DOM changes only when what is shown changes.
// No live region: at 16x or 64x it would talk over everything, the strip is read on demand.
import { traceFailed, agentName, kindName } from "./desk.js";

const SHOWN = 7; // one hand-off chain: finder, analyst, three commentators, verifier, director
const usd = (v, lang) => {
  const d = v >= 0.1 ? 2 : 4;
  return new Intl.NumberFormat(lang, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
};
const int = (v, lang) => Math.round(Number(v)).toLocaleString(lang);
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k]);

/** How many rows (sorted by ts) have ts <= now. */
export function reached(rows, now) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].ts <= now) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Indexes of the latest reached step of each agent (at most SHOWN), oldest first: a chain with
 *  rewrites still shows the whole team, finder to director, rather than only its last few steps. */
export function latestPerAgent(rows, k) {
  const seen = new Set(), out = [];
  for (let i = k - 1; i >= 0 && out.length < SHOWN; i--) {
    if (!seen.has(rows[i].agent)) { seen.add(rows[i].agent); out.unshift(i); }
  }
  return out;
}

// Untrusted agent text: always textContent, never markup.
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Activity {
  /** @param {HTMLElement} root  the #activity element
   *  @param {{traces: object[], loaded: boolean, traceGroups: () => Map}} desk  the desk, which loads the replay's traces
   *  @param {(key: string) => string} t  the page strings */
  constructor(root, desk, t) {
    this.root = root;
    this.desk = desk;
    this.t = t;
    this.src = null;
    this.rows = [];
    this.count = -1;  // rows reached at the last view by the clock
    this.view = null; // what is shown: the story on air or the rows reached, and the language
    this.titleEl = el("h2", "act-title");
    this.sumEl = el("span", "act-sum");
    this.listEl = el("ol", "act-steps");
    root.replaceChildren(this.titleEl, this.sumEl, this.listEl);
  }

  /** Every frame. seeked: the clock jumped instead of running; story: the story graphic on air (the
   *  latest cue), or null; lang: the page language. */
  update(now, seeked, story = null, lang = "en") {
    const traces = this.desk.traces;
    if (traces !== this.src) {
      this.src = traces;
      this.rows = traces.filter((r) => Number.isFinite(r.ts)).sort((a, b) => a.ts - b.ts || a.seq - b.seq);
      let tokens = 0, cost = 0;
      this.sums = this.rows.map((r) => ({ tokens: (tokens += (r.tokens_in || 0) + (r.tokens_out || 0)), cost: (cost += r.cost_usd || 0) }));
      this.count = -1;
      this.view = null;
    }
    const k = reached(this.rows, now);
    if (seeked) this.count = k; // nothing reached by a jump animates in
    // the same chain and totals as that story in the desk's Traces tab
    const group = story && this.desk.loaded ? this.desk.traceGroups().get(story) : null;
    const view = `${group ? `story:${story}` : k}|${lang}`;
    if (view === this.view) return;
    const [was, wasLang] = (this.view ?? "|").split("|");
    this.view = view;
    if (lang !== wasLang) { this.root.lang = lang; this.titleEl.textContent = this.t("actTitle"); }
    const t = this.t;
    if (group) {
      const rows = group.rows.map((g) => g.t);
      this.sumEl.textContent = fill(t("actMade"), { n: int(rows.length, lang), tokens: int(group.sum.tokens, lang), usd: usd(group.sum.cost, lang) });
      // a graphic that comes on air while playing brings its chain in; a seek or a new language does not
      const fresh = !seeked && lang === wasLang && was !== `story:${story}`;
      let nth = 0;
      this.listEl.replaceChildren(...latestPerAgent(rows, rows.length).map((i) => this.item(rows[i], fresh ? nth++ : -1, lang)));
      return;
    }
    const from = this.count < 0 || lang !== wasLang ? k : this.count; // rows that came into reach while playing animate in
    this.count = k;
    if (!k) {
      this.sumEl.textContent = "";
      this.listEl.replaceChildren(el("li", "act-empty", t(this.rows.length || !this.desk.loaded ? "actWait" : "actNone")));
      return;
    }
    const s = this.sums[k - 1];
    this.sumEl.textContent = fill(t("actSum"), { n: int(k, lang), tokens: int(s.tokens, lang), usd: usd(s.cost, lang) });
    let nth = 0;
    this.listEl.replaceChildren(...latestPerAgent(this.rows, k).map((i) => this.item(this.rows[i], i >= from ? nth++ : -1, lang)));
  }

  // What an agent did, as one plain sentence in the page language; its own words, ids and step
  // names stay in the desk's Traces tab.
  said(r, lang) {
    const agent = String(r.agent).replace(/_[a-z]{2}$/, ""), out = String(r.output_summary ?? "");
    if (r.step === "fallback") return this.t("didTemplate");
    if (traceFailed(r)) return this.t("didFail");
    if (agent === "story_finder") {
      const s = this.desk.byId.get(this.desk.traceStories(r)[0]);
      return s ? fill(this.t("didPick"), { what: `${kindName(s.kind, lang).toLocaleLowerCase(lang)}, ${this.desk.minuteText(s)}'` }) : this.t("didPickAny");
    }
    if (agent === "analyst") return this.t("didExplain");
    if (agent === "commentator") return this.t(r.step === "rewrite" ? "didRewrite" : "didWrite");
    if (agent === "verifier") return this.t(/^pass/.test(out) ? "didPass" : /^template/.test(out) ? "didTemplate" : /rewritten|^fail/.test(out) ? "didRewritten" : "didCheck");
    return this.t(agent === "director" ? "didCue" : "didHand");
  }

  item(r, nth, lang) {
    const li = el("li", traceFailed(r) ? "fallback" : "");
    li.dataset.agent = String(r.agent).replace(/_[a-z]{2}$/, "");
    li.dataset.seq = r.seq;
    if (nth >= 0) { li.classList.add("new"); li.style.setProperty("--i", nth); }
    const p = el("p", "act-out", this.said(r, lang));
    // the model only: tokens and cost are in the summary line and in the desk
    const meta = el("p", "act-meta");
    if (r.model) { const m = el("span", "act-model", r.model); m.lang = "en"; meta.append(m); }
    else meta.append(el("span", "", this.t(r.agent === "director" ? "actRules" : "actCode")));
    li.append(el("b", "act-name", agentName(r.agent, lang)), p, meta);
    return li;
  }
}
