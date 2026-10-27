// Ask the studio: a visitor's question about the match up to the replay time (POST api/ask, docs/CONTRACT.md).
// The server checks every answer against the facts; the page only shows it. The question echo and the
// answer are untrusted text: they are set with textContent, never as markup.
import { AskVoice } from "./ask-voice.js";
import { LEAD_S } from "./moments.js";

const ASK_TIMEOUT_MS = 60000; // the server gives up on an answer at 55 s (config.ASK_TIMEOUT_S)
// "Watch it": the moment an answer is about, from the events behind its cited facts (no API change). A shot that
// scored is a goal, any other shot a shot; a chance is the one play an xT fact is about (cumulative pass facts are not).
const STRENGTH = { goal: 3, shot: 2, chance: 1 };
const CHANCE_KINDS = new Set(["xt_added"]);

/** A moment's button shows only while the clock is at or past its lead-in: a rewind before it hides it, so the
 *  button never jumps past the replay time, and the press itself (which lands at `at`) keeps it. */
export const canWatch = (m, now) => !!m && now >= m.at - 1;

/** The one moment worth replaying for an answer: of the events behind the cited facts, up to `now`, the latest
 *  of the strongest kind, as {event_id, ts, kind, at} with `at` the seek target LEAD_S before it; null when none. */
export function answerMoment(factIds, factById, eventById, now) {
  let best = null;
  for (const id of factIds) {
    const f = factById.get(id), ids = f?.source_event_ids ?? [];
    for (const eid of ids) {
      const e = eventById.get(eid);
      if (!e || e.ts > now) continue;
      const kind = e.type_name === "shot" ? (e.result_name === "success" ? "goal" : "shot")
        : CHANCE_KINDS.has(f.kind) && ids.length === 1 ? "chance" : null;
      if (kind && (!best || STRENGTH[kind] > STRENGTH[best.kind] || (kind === best.kind && e.ts > best.ts))) best = { event_id: eid, ts: e.ts, kind, at: Math.max(0, e.ts - LEAD_S) };
    }
  }
  return best;
}

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
  constructor(panel, { matchId, state, t, button, controls, maxTs, onLayout, facts = [], match = null, watch = null }) {
    Object.assign(this, { panel, matchId, state, t, button, controls, maxTs, onLayout, facts, match, watch });
    this.factById = new Map(facts.map((f) => [f.fact_id, f]));
    this.eventById = new Map((match?.events ?? []).map((e) => [e.event_id, e]));
    // when each fact kind a suggestion needs is first in the ledger: the only times the suggestions can change
    const first = new Map();
    for (const f of facts) if (!(first.get(f.kind) <= f.ts)) first.set(f.kind, f.ts);
    this.suggestAt = SUGGEST.flatMap(([, need]) => need.map((k) => first.get(k))).filter(Number.isFinite);
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
    const mic = panel.querySelector("#ask-mic"); // a question by voice (ask-voice.js), once the probe allows it
    this.voice = mic ? new AskVoice(this, mic) : null;
    this.log = [];
    this.watchShown = "";
    this.left = null;
    this.status = "";
    this.busy = false;
    button.addEventListener("click", () => this.setOpen(panel.hidden));
    panel.querySelector(".ask-close").addEventListener("click", () => this.setOpen(false));
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") this.setOpen(false); });
    this.form.addEventListener("submit", (e) => { e.preventDefault(); this.submit(); });
  }

  // GET api/ask says whether a model and Content Safety are there, and (voice) Speech for the microphone. It is always a 200, so the probe leaves no
  // error in the console; anything but {available: true} keeps the box hidden.
  async probe() {
    let data = null;
    try {
      const r = await fetch("api/ask", { credentials: "same-origin", signal: AbortSignal.timeout(4000) });
      if (!r.ok || (data = await r.json()).available !== true) return;
    } catch { return; }
    this.voice?.enable(data.voice === true);
    this.button.hidden = false;
    this.onLayout();
  }

  setOpen(open) {
    this.panel.hidden = !open;
    if (!open) this.voice?.cancel();
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
    this.voice?.cancel();
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
      const facts = data.fact_ids ?? [];
      this.log.unshift({ question, lang, answer: data.answer, declined: data.status !== "answered", facts,
        moment: data.status === "answered" ? answerMoment(facts, this.factById, this.eventById, ts) : null });
      this.left = data.questions_left;
      this.status = "";
      this.input.value = "";
      this.announce(data.answer, lang);
    }
    this.render();
  }

  // every frame: while the panel is open the suggestions follow the clock, rebuilt only when one of their
  // first fact times is crossed (a few comparisons a frame)
  update() {
    if (this.panel.hidden) return;
    if (this.suggestCount() !== this.suggestN) this.renderSuggestions();
    if (this.watchSig() !== this.watchShown) this.render();
  }

  // which answers' "Watch it" buttons the clock allows: the log is rebuilt only when one of them changes
  watchSig() { return this.watch ? this.log.map((q) => (canWatch(q.moment, this.state.ts) ? 1 : 0)).join("") : ""; }

  // how many of those first fact times the clock has passed
  suggestCount() {
    const now = Math.min(this.state.ts, this.maxTs);
    let n = 0;
    for (const t of this.suggestAt) if (t <= now) n++;
    return n;
  }

  // rebuilt only when the list changes, so a focused suggestion keeps its focus
  renderSuggestions() {
    this.suggestN = this.suggestCount();
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

  factText(id) {
    const f = this.factById.get(id);
    if (!f) return id;
    const who = f.player_id ? this.match?.players?.[f.player_id]?.name : this.match?.teams?.[f.team_id]?.short_name;
    return who ? `${f.label_en} (${who})` : f.label_en;
  }

  // emptied first, so the same sentence twice (two declines) is still announced
  announce(text, lang) {
    this.live.textContent = "";
    this.live.lang = lang;
    requestAnimationFrame(() => { this.live.textContent = text; });
  }

  // also called when the language or the audience changes: the cited facts show only in Analyst mode
  render() {
    // aria-disabled, not disabled: a disabled button would drop the focus of whoever pressed it (busy stops a second send)
    this.send.setAttribute("aria-disabled", String(this.busy));
    this.voice?.render();
    const left = this.status || this.left === null ? "" : this.t("askLeft").replace("{n}", this.left);
    const status = this.status ? this.t(this.status) : left;
    if (this.statusEl.textContent !== status) this.statusEl.textContent = status; // a rewrite would be announced again
    this.renderSuggestions();
    const analyst = this.state.audience === "analyst";
    this.watchShown = this.watchSig();
    this.logEl.replaceChildren(...this.log.map((q) => {
      const li = document.createElement("li");
      const you = document.createElement("p"), ans = document.createElement("p");
      you.className = "ask-you";
      you.textContent = `${this.t("askYou")}: ${q.question}`;
      ans.className = q.declined ? "ask-a declined" : "ask-a";
      ans.lang = q.lang;
      ans.textContent = q.answer;
      li.append(you, ans);
      const m = q.moment;
      if (this.watch && canWatch(m, this.state.ts)) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ctl ask-watch";
        b.lang = this.state.lang;
        b.textContent = this.t("askWatch").replace("{what}", this.t(`askMoment_${m.kind}`)).replace("{m}", this.match.clock(m.ts).label);
        b.addEventListener("click", () => this.watch(m.at));
        li.append(b);
      }
      if (analyst && q.facts.length) {
        const ids = document.createElement("p");
        ids.className = "ask-facts";
        // the facts by their ledger label (English) and whose they are; the id stays in the tooltip
        ids.lang = "en";
        ids.title = q.facts.join(", ");
        ids.textContent = `${this.t("askFacts")}: ${q.facts.map((id) => this.factText(id)).join("; ")}`;
        li.append(ids);
      }
      return li;
    }));
  }
}
