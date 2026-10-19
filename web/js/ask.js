// Ask the studio: a visitor's question about the match up to the replay time (POST api/ask, docs/CONTRACT.md).
// The server checks every answer against the facts; the page only shows it. The question echo and the
// answer are untrusted text: they are set with textContent, never as markup.
const ASK_TIMEOUT_MS = 60000; // the agent may take up to 45 s, plus Content Safety on both sides

export class Ask {
  constructor(panel, { matchId, state, t, button, controls, maxTs, onLayout }) {
    Object.assign(this, { panel, matchId, state, t, button, controls, maxTs, onLayout });
    this.form = panel.querySelector("form");
    this.input = panel.querySelector("#ask-q");
    this.send = this.form.querySelector('[type="submit"]');
    this.statusEl = panel.querySelector("#ask-status");
    this.logEl = panel.querySelector("#ask-log");
    this.live = panel.querySelector("#ask-live");
    this.log = [];
    this.left = null;
    this.status = "";
    this.busy = false;
    button.addEventListener("click", () => this.setOpen(panel.hidden));
    panel.querySelector(".ask-close").addEventListener("click", () => this.setOpen(false));
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") this.setOpen(false); });
    this.form.addEventListener("submit", (e) => { e.preventDefault(); this.submit(); });
    window.addEventListener("resize", () => { if (!panel.hidden) this.place(); });
  }

  // A 422 to an empty body means the endpoint is there with a model behind it; anything else keeps the box hidden.
  async probe() {
    try {
      const r = await fetch("api/ask", { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(4000),
        headers: { "content-type": "application/json" }, body: "{}" });
      if (r.status !== 422) return;
    } catch { return; }
    this.button.hidden = false;
    this.onLayout();
  }

  setOpen(open) {
    this.panel.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    if (open) { this.place(); this.render(); this.input.focus(); } else this.button.focus();
  }

  // over the broadcast, on the side of the controls with more room: above on a wide screen, below on a phone in portrait
  place() {
    const app = this.panel.parentElement.getBoundingClientRect(), c = this.controls.getBoundingClientRect();
    const above = c.top - app.top, below = app.bottom - c.bottom, up = above >= below;
    Object.assign(this.panel.style, up ? { top: "auto", bottom: `${app.bottom - c.top + 8}px` } : { top: `${c.bottom - app.top + 8}px`, bottom: "auto" },
      { maxHeight: `${Math.max(120, (up ? above : below) - 16)}px` });
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
    else if (r.status === 503) { this.status = "askOff"; this.form.hidden = true; }
    else if (!r.ok || typeof data?.answer !== "string") this.status = "askBad";
    else {
      this.log.unshift({ question, lang, answer: data.answer, declined: data.status !== "answered", facts: data.fact_ids ?? [] });
      this.left = data.questions_left;
      this.status = "";
      this.input.value = "";
      this.live.textContent = data.answer;
    }
    this.render();
  }

  // also called when the language or the audience changes: fact ids show only in Analyst mode
  render() {
    this.send.disabled = this.busy;
    const left = this.status || this.left === null ? "" : this.t("askLeft").replace("{n}", this.left);
    this.statusEl.textContent = this.status ? this.t(this.status) : left;
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
