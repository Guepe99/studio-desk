// Agent activity (docs/CONTRACT.md, Page additions): the last hand-offs of traces.json that the replay
// clock has reached (ts <= now), so a viewer sees the agents work as the match goes. Reads only the
// replay's traces (loaded by the desk). The DOM changes only when another trace comes into reach.
// No live region: at 16x or 64x it would talk over everything, the strip is read on demand.
import { summaryText, traceFailed } from "./desk.js";

const SHOWN = 7; // one hand-off chain: finder, analyst, three commentators, verifier, director
const NAMES = { story_finder: "Story finder", analyst: "Analyst", commentator: "Commentator", verifier: "Verifier", director: "Director" };

export const agentName = (agent) => {
  const [base, lang] = String(agent).split(/_(?=[a-z]{2}$)/); // commentator_it -> Commentator IT
  return `${NAMES[base] ?? base.replace(/_/g, " ")}${lang ? ` ${lang.toUpperCase()}` : ""}`;
};
const usd = (v) => `$${Number(v).toFixed(v >= 0.1 ? 2 : 4)}`;
const int = (v) => Number(v).toLocaleString("en-US");

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
   *  @param {{traces: object[], loaded: boolean}} desk  the desk, which loads the replay's traces */
  constructor(root, desk) {
    this.root = root;
    this.desk = desk;
    this.src = null;
    this.rows = [];
    this.count = -1;
    this.sumEl = el("span", "act-sum");
    this.listEl = el("ol", "act-steps");
    root.replaceChildren(el("h2", "act-title", "Agents at work"), this.sumEl, this.listEl);
  }

  /** Every frame; seeked: the clock jumped instead of running. */
  update(now, seeked) {
    const traces = this.desk.traces;
    if (traces !== this.src) {
      this.src = traces;
      this.rows = traces.filter((r) => Number.isFinite(r.ts)).sort((a, b) => a.ts - b.ts || a.seq - b.seq);
      let tokens = 0, cost = 0;
      this.sums = this.rows.map((r) => ({ tokens: (tokens += (r.tokens_in || 0) + (r.tokens_out || 0)), cost: (cost += r.cost_usd || 0) }));
      this.count = -1;
    }
    const k = reached(this.rows, now);
    if (k === this.count) return;
    const from = seeked || this.count < 0 ? k : this.count; // rows that came into reach while playing animate in
    this.count = k;
    if (!k) {
      this.sumEl.textContent = "";
      this.listEl.replaceChildren(el("li", "act-empty", this.rows.length || !this.desk.loaded ? "Waiting for the first moment the clock releases" : "No agent traces in this replay"));
      return;
    }
    const s = this.sums[k - 1];
    this.sumEl.textContent = `${int(k)} hand-off${k === 1 ? "" : "s"} so far, ${int(s.tokens)} tokens, ${usd(s.cost)}`;
    const shown = latestPerAgent(this.rows, k);
    let nth = 0;
    this.listEl.replaceChildren(...shown.map((i) => this.item(this.rows[i], i >= from ? nth++ : -1)));
  }

  item(r, nth) {
    const failed = traceFailed(r), out = summaryText(r.output_summary);
    const li = el("li", failed ? "fallback" : "");
    li.dataset.agent = String(r.agent).replace(/_[a-z]{2}$/, "");
    li.dataset.seq = r.seq;
    li.title = out;
    if (nth >= 0) { li.classList.add("new"); li.style.setProperty("--i", nth); }
    const p = el("p", "act-out");
    p.append(el("span", "act-step", failed ? "fallback" : String(r.step ?? "")), ` ${out}`);
    const meta = el("p", "act-meta");
    if (r.model) meta.append(el("span", "act-model", r.model), el("span", "", `${int((r.tokens_in || 0) + (r.tokens_out || 0))} tok, ${usd(r.cost_usd || 0)}`));
    else meta.append(el("span", "", r.agent === "director" ? "rules, no model" : "code, no model"));
    li.append(el("b", "act-name", agentName(r.agent)), p, meta);
    return li;
  }
}
