// Ask the studio: a visitor's question about the match up to the replay time (POST api/ask, docs/CONTRACT.md).
// The server checks every answer against the facts; the page only shows it. The question echo and the
// answer are untrusted text: they are set with textContent, never as markup.
const ASK_TIMEOUT_MS = 60000; // the server gives up on an answer at 55 s (config.ASK_TIMEOUT_S)
// Suggested questions, each shown only once the ledger up to the replay time holds the facts that answer it.
const SUGGEST = [["askSugShots", ["team_shots"]], ["askSugControl", ["team_possession"]],
  ["askSugGoals", ["score"]], ["askSugSprint", ["sprint_speed"]], ["askSugPass", ["pass_difficulty"]]];
const MAX_SUGGEST = 4;

// the suggestion keys the facts with ts <= now support, in SUGGEST order, at most MAX_SUGGEST
export function suggestions(facts, now) {
  const kinds = new Set(facts.filter((f) => f.ts <= now).map((f) => f.kind));
  return SUGGEST.filter(([, need]) => need.every((k) => kinds.has(k))).map(([key]) => key).slice(0, MAX_SUGGEST);
}

export class Ask {
  constructor(panel, { matchId, state, t, button, controls, maxTs, onLayout, facts = [] }) {
    Object.assign(this, { panel, matchId, state, t, button, controls, maxTs, onLayout, facts });
    this.form = panel.querySelector("form");
    this.input = panel.querySelector("#ask-q");
    this.send = this.form.querySelector('[type="submit"]');
    this.statusEl = panel.querySelector("#ask-status");
    this.logEl = panel.querySelector("#ask-log");
    this.suggestEl = panel.querySelector("#ask-suggest");
    this.suggestEl?.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-q]");
      if (!b || this.busy) return;
      this.input.value = this.t(b.dataset.q);
      this.submit();
    });
    // outside the panel: an answer that comes after the panel is closed, and askOff as the box goes, are still announced
    this.live = document.querySelector("#ask-live");
    this.log = [];
    this.left = null;
    this.status = "";
    this.busy = false;
    button.addEventListener("click", () => this.setOpen(panel.hidden));
    panel.querySelector(".ask-close").addEventListener("click", () => this.setOpen(false));
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") this.setOpen(false); });
    this.form.addEventListener("submit", (e) => { e.preventDefault(); this.submit(); });
  }

  // GET api/ask says whether a model and Content Safety are there. It is always a 200, so the probe leaves no
  // error in the console; anything but {available: true} keeps the box hidden.
  async probe() {
    try {
      const r = await fetch("api/ask", { credentials: "same-origin", signal: AbortSignal.timeout(4000) });
      if (!r.ok || (await r.json()).available !== true) return;
    } catch { return; }
    this.button.hidden = false;
    this.onLayout();
  }

  setOpen(open) {
    this.panel.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    // the panel is in the page flow, beside or under the picture and never over it: the page scrolls to show it whole
    if (open) {
      this.render();
      this.input.focus({ preventScroll: true });
      // once the page has laid itself out around the panel
      requestAnimationFrame(() => this.panel.scrollIntoView({ block: "nearest" }));
    } else this.button.focus();
  }

  // the model went away (503): no box and no button, and focus on the control just before the hidden button
  turnOff() {
    this.announce(this.t("askOff"), this.state.lang);
    this.form.hidden = this.button.hidden = this.panel.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
    this.controls.querySelector("#settings")?.focus();
    this.onLayout();
  }

  async submit() {
    const question = this.input.value.trim();
    if (!question || this.busy) return;
    const lang = this.state.lang, ts = Math.floor(Math.min(this.state.ts, this.maxTs) * 10) / 10;
    this.busy = true;
    this.status = "askWait";
    this.render();
    let r = null, data = null;
    try {
      r = await fetch("api/ask", { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
        headers: { "content-type": "application/json" }, body: JSON.stringify({ match_id: this.matchId, ts, question, lang }) });
      data = await r.json().catch(() => null);
    } catch { r = null; }
    this.busy = false;
    if (!r) this.status = "askNet";
    else if (r.status === 429) this.status = "askLimit";
    else if (r.status === 503) { this.status = "askOff"; this.turnOff(); }
    else if (r.ok && data?.status === "paused") {
      // Content Safety is out of quota or rate limited: not a decline, the questions are paused
      this.log.unshift({ question, lang, answer: this.t("askPaused"), declined: true, facts: [] });
      this.left = data.questions_left ?? this.left;
      this.status = "";
      this.announce(this.t("askPaused"), lang);
    }
    else if (r.status >= 500) this.status = "askErr";
    else if (!r.ok || typeof data?.answer !== "string") this.status = "askBad";
    else {
      this.log.unshift({ question, lang, answer: data.answer, declined: data.status !== "answered", facts: data.fact_ids ?? [] });
      this.left = data.questions_left;
      this.status = "";
      this.input.value = "";
      this.announce(data.answer, lang);
    }
    this.render();
  }

  // rebuilt only when the list changes, so a focused suggestion keeps its focus
  renderSuggestions() {
    if (!this.suggestEl) return;
    const keys = suggestions(this.facts, Math.min(this.state.ts, this.maxTs));
    const sig = `${this.state.lang}|${keys.join()}`;
    if (sig === this.suggestSig) return;
    this.suggestSig = sig;
    this.suggestEl.hidden = !keys.length;
    const head = document.createElement("p");
    head.textContent = this.t("askTry");
    this.suggestEl.replaceChildren(head, ...keys.map((k) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ctl";
      b.dataset.q = k;
      b.textContent = this.t(k);
      return b;
    }));
  }

  // emptied first, so the same sentence twice (two declines) is still announced
  announce(text, lang) {
    this.live.textContent = "";
    this.live.lang = lang;
    requestAnimationFrame(() => { this.live.textContent = text; });
  }

  // also called when the language or the audience changes: fact ids show only in Analyst mode
  render() {
    // aria-disabled, not disabled: a disabled button would drop the focus of whoever pressed it (busy stops a second send)
    this.send.setAttribute("aria-disabled", String(this.busy));
    const left = this.status || this.left === null ? "" : this.t("askLeft").replace("{n}", this.left);
    const status = this.status ? this.t(this.status) : left;
    if (this.statusEl.textContent !== status) this.statusEl.textContent = status; // a rewrite would be announced again
    this.renderSuggestions();
    const analyst = this.state.audience === "analyst";
    this.logEl.replaceChildren(...this.log.map((q) => {
      const li = document.createElement("li");
      const you = document.createElement("p"), ans = document.createElement("p");
      you.className = "ask-you";
      you.textContent = `${this.t("askYou")}: ${q.question}`;
      ans.className = q.declined ? "ask-a declined" : "ask-a";
      ans.lang = q.lang;
      ans.textContent = q.answer;
      li.append(you, ans);
      if (analyst && q.facts.length) {
        const ids = document.createElement("p");
        ids.className = "ask-facts";
        ids.textContent = `${this.t("askFacts")}: ${q.facts.join(", ")}`;
        li.append(ids);
      }
      return li;
    }));
  }
}
