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

const LANGS = { en: "English", it: "Italian", es: "Spanish" };
const KIND = { goal: "Goal", key_pass: "Key pass", momentum_swing: "Momentum swing", comeback: "Comeback",
  top_sprint: "Top sprint", high_press: "High press", tactical_shift: "Tactical shift", big_chance: "Big chance",
  pressing_spell: "Pressing spell", recap: "Recap" };
const STATUS = { auto_approved: "Auto-approved", needs_review: "Needs review", approved: "Approved",
  edited: "Edited and approved", rejected: "Rejected" };
const VERIFIER = { pass: "Pass", rewritten: "Rewritten", template: "Template line" };
// Since the phrasebook (verifier.on_air): the line on air is written by code, the AI's lines are a proposal.
const ON_AIR_TEXT = { phrasebook: "Phrasebook (code)", template: "Template line (code)" };
const AI_DRAFT = { pass: "Pass", rewritten: "Rewritten", template: "Not usable" };
// The notes describe the drafts the verifier sent back, not the text on screen (older packs: any note list).
const NOTES_TITLE = { rewritten: "What the earlier drafts got wrong", template: "Why the fact-only sentence" };
const DRAFT_NOTES_TITLE = { rewritten: "What the earlier AI drafts got wrong", template: "Why the AI drafts were not kept" };
const SAFETY = { passed: "Passed", flagged: "Flagged", not_checked: "Not checked" };
const AGENTS = [
  ["story_finder", "Story finder", "AI", "Picks moments from the events the match clock releases."],
  ["analyst", "Analyst", "AI", "Explains why the moment matters, citing fact ids."],
  ["commentator", "Commentator", "AI", "Writes the lines in English, Italian and Spanish."],
  ["verifier", "Verifier", "Code and AI", "Checks every number against the fact ledger; rewrites twice at most, then a template line."],
  ["director", "Director", "Rules", "Picks graphic, time and audience; never more than 2 on screen."],
];
const AGENT = Object.fromEntries(AGENTS.map(([id, name, how]) => [id, { name, how }]));
const EDIT_MAX = 600; // studiodesk/api.py EDIT_MAX_CHARS
const ON_AIR = ["auto_approved", "approved", "edited"];
const API_TIMEOUT_MS = 4000;
const CONNECT_TRIES = 3; // a slow first answer (a cold container) is not a reason to work offline for the whole visit
const RUN_MAX_FRAMES = 300; // a sprint run longer than 30 s is not a sprint: never draw a whole-match path
const SVGNS = "http://www.w3.org/2000/svg";

const kindName = (k) => KIND[k] ?? String(k).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const usd = (v) => `$${Number(v).toFixed(v >= 0.1 ? 2 : 4)}`;
const int = (v) => Number(v).toLocaleString("en-US");

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
    this.factIndex = new Map(this.match.facts.map((f) => [f.fact_id, f]));
    this.eventIndex = new Map(this.match.events.map((e) => [e.event_id, e]));
    // Built once: the live regions stay in the page, so a render announces only a new message.
    this.headEl = h("header", { className: "desk-head" });
    this.killEl = h("p", { className: "banner", role: "status" });
    this.noteEl = h("p", { className: "banner warn", role: "alert" });
    this.bodyEl = h("div", { className: "desk-body", role: "tabpanel", tabindex: 0, "data-focus": "panel" });
    this.footEl = h("footer", { className: "desk-foot" });
    root.replaceChildren(this.headEl, this.killEl, this.noteEl, this.bodyEl, this.footEl);
  }

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
        this.offline = e.api ? e.message : e.timeout ? "The server did not answer in time." : "";
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

  async decide(s, decision, editedText = null) {
    if (this.locked()) return;
    const id = s.story_id, prev = this.decisions.get(id), at = new Date().toISOString();
    this.decisions.set(id, { story_id: id, decision, edited_text: editedText, at });
    this.note = "";
    if (!this.online) {
      this.localAudit.unshift({ at, actor: "human", action: decision, story_id: id, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0,
        detail: { langs: Object.keys(editedText ?? {}) } });
      this.endEdit(id);
      this.changed();
      return;
    }
    this.busy = true;
    this.changed();
    try {
      await this.api("POST", "api/decisions", { match_id: this.matchId, story_id: id, decision, ...(editedText ? { edited_text: editedText } : {}) });
      this.endEdit(id); // the editor and its drafts go only once the server has the text
      await this.refreshAudit();
    } catch (e) {
      if (prev) this.decisions.set(id, prev); else this.decisions.delete(id);
      this.note = `Not saved: ${e.validation && editedText ? "the text has a character the desk does not accept" : e.message}`;
    }
    this.busy = false;
    this.changed();
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
      this.note = `Not saved: ${e.message}`;
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
    const locked = this.locked();
    const tabs = [["stories", `Stories`, this.stories.length], ["audit", "Audit log"], ["traces", "Traces"]];
    const tabButton = ([id, label, n]) => h("button", {
      // only the selected tab's panel exists, so only that tab names it
      type: "button", role: "tab", id: `tab-${id}`, "aria-controls": this.tab === id ? `panel-${id}` : null, "aria-selected": String(this.tab === id),
      tabindex: this.tab === id ? 0 : -1, "data-focus": `tab:${id}`, onclick: () => { this.tab = id; this.render(); },
      onkeydown: (e) => this.tabKeys(e, tabs.map((t) => t[0])),
    }, label, n !== undefined ? h("span", { className: "count" }, n) : null);
    const body = this.tab === "stories" ? this.renderStories() : this.tab === "audit" ? this.renderAudit() : this.renderTraces();
    const sum = !this.ready ? "Loading your decisions" : this.busy ? "Saving" : this.stories.length ? `${this.pending()} of ${this.stories.length} waiting for review` : "";
    this.headEl.replaceChildren(
      h("div", { className: "desk-title" },
        h("h2", {}, "Control desk"),
        h("button", { type: "button", id: "desk-close", className: "ctl", "aria-label": "Close the control desk", "data-focus": "close",
          onclick: () => this.closeDrawer() }, "Close")),
      h("div", { className: "desk-bar" },
        h("button", { type: "button", role: "switch", id: "ai-switch", className: "switch", "aria-checked": String(!this.kill), "data-focus": "kill",
          disabled: locked, onclick: () => this.setKill(!this.kill) },
        h("span", { className: "track", "aria-hidden": "true" }, h("span", { className: "knob" })),
        h("span", { className: "switch-label" }, "AI graphics ", h("b", {}, this.kill ? "off" : "on"))),
        h("span", { className: "desk-sum" }, sum)),
      h("div", { role: "tablist", "aria-label": "Desk views", className: "tabs" }, tabs.map(tabButton)));
    setText(this.killEl, this.kill ? "AI off: only template graphics are on air. Stories stay listed for review." : "");
    setText(this.noteEl, this.note);
    this.bodyEl.id = `panel-${this.tab}`;
    this.bodyEl.setAttribute("aria-labelledby", `tab-${this.tab}`);
    this.bodyEl.replaceChildren(...[body].flat(Infinity).filter(Boolean)); // replaceChildren would print a null as "null"
    this.bodyEl.scrollTop = scroll;
    setText(this.footEl, !this.ready ? "Connecting to the server: the desk unlocks once your saved decisions are in."
      : this.online ? "Your decisions are saved for this browser only. Other visitors see the original replay."
        : this.offline ? `Decisions are kept in this tab only. ${this.offline.replace(/^./, (c) => c.toUpperCase()).replace(/([^.])$/, "$1.")}`
          : "No server: decisions are kept in this tab only.");
    document.querySelector("#ai-off")?.toggleAttribute("hidden", !this.kill);
    // the Desk button (narrow screens) carries the count and the offline state, so a closed drawer still shows them
    const open = document.querySelector("#desk-open"), n = this.pending(), off = this.ready && !this.online;
    if (open) {
      open.querySelector(".count").textContent = n ? String(n) : "";
      open.querySelector(".off")?.toggleAttribute("hidden", !off);
      open.setAttribute("aria-label", `Desk${n ? `, ${n} waiting for review` : ""}${off ? ", offline" : ""}`);
    }
    // focus stays on the same control; one disabled during a save gets it back once enabled; a closed editor hands it to Edit
    const find = (k) => this.root.querySelector(`[data-focus="${CSS.escape(k)}"]`);
    const el = focusKey ? find(focusKey) ?? find(focusKey.replace(/:(save|cancel|text:\w+)$/, ":edited")) : null;
    this.lostFocus = el?.disabled ? focusKey : null;
    if (el && !el.disabled && el !== document.activeElement) el.focus({ preventScroll: true });
  }

  tabKeys(e, ids) {
    const i = ids.indexOf(this.tab), step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (step === undefined && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    this.tab = ids[e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : (i + step + ids.length) % ids.length];
    this.render();
    this.root.querySelector(`#tab-${this.tab}`).focus();
  }

  renderStories() {
    if (!this.loaded) return h("p", { className: "empty" }, "Loading stories.");
    if (!this.stories.length) {
      return h("p", { className: "empty" }, "No AI stories in this replay yet. The template graphics play on their own; stories appear here once the agents have run on the match.");
    }
    return h("ol", { className: "stories" }, this.stories.map((s) => h("li", {}, this.renderStory(s))));
  }

  renderStory(s) {
    const lang = this.state.lang, st = this.status(s), id = s.story_id;
    const tally = this.onAir(s) ? "onair" : st === "needs_review" && !this.kill ? "held" : "off";
    const tallyText = { onair: "On air", held: "Held", off: this.kill && st !== "rejected" ? "Off air, AI off" : "Off air" }[tally];
    const c = this.match.clock(s.ts), base = c.period === 1 ? 45 : 90;
    const minute = c.minute > base ? `${base}+${c.minute - base}` : String(c.minute); // stoppage as the lines say it
    const who = s.player_id ? this.match.players[s.player_id]?.name : this.match.teams[s.team_id]?.short_name;
    const v = s.verifier ?? {}, flagged = v.flagged ?? [];
    const risk = Number(s.risk);
    const editing = this.editing === id;
    const decided = this.decisions.has(id);
    const act = (decision, label) => h("button", {
      type: "button", className: `ctl act act-${decision}`, "aria-pressed": String(st === decision), "data-focus": `${id}:${decision}`,
      "aria-label": `${label}: ${kindName(s.kind)} at minute ${minute}${who ? `, ${who}` : ""}`, disabled: this.locked(),
      onclick: () => (decision === "edited" ? this.startEdit(s) : this.decide(s, decision)),
    }, label);
    const firstCue = this.match.cues.find((c) => c.story_id === id);
    return h("article", { className: "story", "data-tally": tally, id: `story-${id}`, "aria-labelledby": `h-${id}` },
      h("div", { className: "story-head" },
        h("button", { type: "button", className: "minute", "data-focus": `${id}:go`, "aria-label": `Go to minute ${minute}`,
          title: "Go to this moment", onclick: () => this.seek(Math.max(0, (firstCue?.ts ?? s.ts) - 1)) }, `${minute}'`),
        h("h3", { id: `h-${id}` }, kindName(s.kind), who ? h("span", { className: "who" }, who) : null),
        h("span", { className: "tally" }, tallyText)),
      h("div", { className: "story-meta" },
        h("span", { className: `status st-${st}` }, STATUS[st] ?? st),
        decided ? h("span", { className: "default" }, `default: ${String(STATUS[this.defaultStatus(s)] ?? this.defaultStatus(s)).toLowerCase()}`) : null,
        s.safety === "flagged" && s.default_status === "auto_approved" ? h("span", { className: "default" }, "held: flagged by Content Safety") : null,
        h("span", { className: "risk", title: "Below 0.35 a story goes on air by itself" },
          `Risk ${risk.toFixed(2)}`,
          h("span", { className: "meter", "aria-hidden": "true" }, h("span", { style: `width:${Math.round(Math.min(1, Math.max(0, risk)) * 100)}%` })))),
      editing ? this.renderEditor(s) : h("p", { className: "story-text", lang: this.textLang(s, lang) }, this.text(s, lang)),
      editing ? null : this.renderProposal(s, lang),
      h("dl", { className: "checks" },
        v.on_air ? h("div", {}, h("dt", {}, "On air"), h("dd", {}, ON_AIR_TEXT[v.on_air] ?? v.on_air)) : null,
        h("div", {}, h("dt", {}, v.on_air ? "AI draft" : "Verifier"), h("dd", { className: `v-${v.status}` },
          `${(v.on_air ? AI_DRAFT : VERIFIER)[v.status] ?? v.status ?? "none"}`, v.attempts ? `, ${v.attempts} attempt${v.attempts > 1 ? "s" : ""}` : "")),
        h("div", {}, h("dt", {}, "Safety"), h("dd", { className: `s-${s.safety}` }, SAFETY[s.safety] ?? s.safety))),
      flagged.length ? h("details", { className: "flagged" }, h("summary", { "data-focus": `${id}:notes` }, `${(v.on_air ? DRAFT_NOTES_TITLE : NOTES_TITLE)[v.status] ?? "Verifier notes"} (${flagged.length})`),
        h("ul", {}, flagged.map((f) => h("li", {}, flagText(f))))) : null,
      this.renderEvidence(s),
      editing ? null : h("div", { className: "actions" },
        act("approved", "Approve"), act("edited", "Edit"), act("rejected", "Reject"),
        this.traceGroups().has(id) ? h("button", { type: "button", className: "link", "data-focus": `${id}:trace`, onclick: () => this.showTrace(id) }, "Show trace") : null));
  }

  // The AI's own line, kept off air: one click puts it on air in all three languages, as an edit.
  renderProposal(s, lang) {
    const p = s.verifier?.proposals;
    if (!p) return null;
    const text = p[lang] ?? p.en ?? "";
    const using = Object.keys(LANGS).every((l) => this.decisions.get(s.story_id)?.edited_text?.[l] === p[l]);
    return h("div", { className: "proposal" },
      h("p", { className: "proposal-text", lang: p[lang] ? lang : "en" }, h("b", {}, using ? "AI proposal, on air: " : "AI proposal, not on air: "), text),
      using ? null : h("button", { type: "button", className: "ctl", "data-focus": `${s.story_id}:proposal`, disabled: this.locked(),
        onclick: () => this.decide(s, "edited", { ...p }) }, "Use proposal"));
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
    const areas = Object.entries(LANGS).map(([lang, name]) => {
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
      for (const [l, name] of Object.entries(LANGS)) {
        const v = (this.drafts.get(`${id}|${l}`) ?? this.text(s, l)).trim();
        if (!v) { this.note = `The ${name} text cannot be empty. Reject the story to keep it off air.`; this.render(); return; }
        if (v !== (s.texts?.[l] ?? s.texts?.en ?? "")) texts[l] = v;
      }
      if (Object.keys(texts).length) this.decide(s, "edited", texts); else this.decide(s, "approved");
    };
    const cancel = () => { this.endEdit(id); this.render(); };
    return h("div", { className: "editor" }, areas,
      h("div", { className: "editor-bar" },
        h("button", { type: "button", className: "ctl", "data-focus": `${id}:cancel`, disabled: locked, onclick: cancel }, "Cancel"),
        h("button", { type: "button", className: "ctl primary", "data-focus": `${id}:save`, disabled: locked, onclick: save }, "Save and approve")));
  }

  renderEvidence(s) {
    const facts = list(s.fact_ids).map((id) => this.factIndex.get(id) ?? { fact_id: id, label_en: "not in the ledger", missing: true });
    const events = list(s.evidence_event_ids).map((id) => this.eventIndex.get(id) ?? { event_id: id, missing: true });
    const det = h("details", { className: "evidence", ...(this.open.has(s.story_id) ? { open: true } : {}) },
      h("summary", { "data-focus": `${s.story_id}:evidence` }, `Evidence: ${facts.length} fact${facts.length === 1 ? "" : "s"}, ${events.length} event${events.length === 1 ? "" : "s"}`));
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
    return [
      h("div", { className: "ev-grid" },
        this.miniPitch(s, facts, events),
        h("table", { className: "facts" },
          h("caption", { className: "sr" }, "Facts cited by the story"),
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Fact"), h("th", { scope: "col" }, "Value"))),
          h("tbody", {}, facts.map((f) => h("tr", { className: f.missing ? "missing" : "" },
            h("td", { title: f.fact_id }, h("span", { className: "flabel" }, f.label_en ?? "")),
            h("td", { className: "num" }, f.missing ? "" : valueText(f))))))),
      events.length ? h("p", { className: "events" }, "Events ", events.map((e) => h("span", { className: "eid", title: e.missing ? "not in events.json" : `${e.type_name}, ${this.match.players[e.player_id]?.name ?? e.player_id}` },
        e.missing ? `${e.event_id}?` : `${e.event_id} ${e.type_name.replace(/_/g, " ")}`))) : null,
      s.analysis_en ? h("p", { className: "analysis", lang: "en" }, h("b", {}, "Analyst: "), s.analysis_en) : null,
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
      "aria-label": `Pitch map: ${n} evidence event${n === 1 ? "" : "s"}${marks.length > n ? " and the run behind a speed fact" : ""}` }, lines, marks);
  }

  // Audit: the agents' rows (from the API, or from the replay traces) and this visitor's actions.
  auditData() {
    const fromApi = this.auditRows.filter((r) => r.actor !== "human" && r.actor !== "auto");
    const agents = fromApi.length ? fromApi : this.traces.map((t) => ({ at: t.at, actor: t.agent, action: t.step,
      story_id: this.traceStory(t), model: t.model, tokens_in: t.tokens_in, tokens_out: t.tokens_out, cost_usd: t.cost_usd }));
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
    const calls = agents.filter((r) => r.model);
    const tokens = agents.reduce((n, r) => n + r.tokens_in + r.tokens_out, 0), cost = agents.reduce((n, r) => n + r.cost_usd, 0);
    const actorName = (a) => (a === "human" ? "You" : a === "auto" ? "Risk rule" : AGENT[a]?.name ?? a);
    const what = (r) => {
      if (r.action === "ai_off") return "switched AI graphics off";
      if (r.action === "ai_on") return "switched AI graphics on";
      if (r.action === "auto_approved") return `auto-approved, risk ${Number(r.detail?.risk).toFixed(2)} below 0.35`;
      return String(r.action).replace(/_/g, " ") + (r.detail?.langs?.length ? ` (${r.detail.langs.join(", ")})` : "");
    };
    return h("div", { className: "audit" },
      h("div", { className: "totals" },
        h("div", {}, h("b", {}, int(calls.length)), " model calls"),
        h("div", {}, h("b", {}, int(tokens)), " tokens"),
        h("div", {}, h("b", {}, usd(cost)), " model cost"),
        h("div", {}, h("b", {}, int(humans.length)), " of your actions")),
      rows.length ? h("table", { className: "log" },
        h("caption", { className: "sr" }, "Audit log, newest first"),
        h("thead", {}, h("tr", {}, ["UTC", "Who", "What", "Model", "Tokens and cost"].map((c) => h("th", { scope: "col" }, c)))),
        h("tbody", {}, rows.map((r) => h("tr", { className: `a-${r.actor === "human" ? "human" : r.actor === "auto" ? "auto" : "agent"}` },
          h("td", { className: "num" }, String(r.at).slice(11, 19)),
          h("td", {}, actorName(r.actor)),
          h("td", {}, what(r), r.story_id ? h("span", { className: "sid" }, r.story_id) : null),
          h("td", {}, r.model ?? ""),
          h("td", { className: "num" }, r.tokens_in + r.tokens_out ? [int(r.tokens_in + r.tokens_out), h("br"), usd(r.cost_usd)] : ""))))) :
        h("p", { className: "empty" }, "Nothing logged yet. Approve, edit or reject a story and it shows up here."));
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
    const legend = h("ol", { className: "pipeline", "aria-label": "How a story is made" },
      AGENTS.map(([id, name, how, role]) => h("li", { "data-agent": id }, h("b", {}, name), h("span", { className: "how" }, how), h("span", { className: "role" }, role))));
    if (!this.traces.length) return [legend, h("p", { className: "empty" }, "No agent traces in this replay yet.")];
    return [legend, [...this.traceGroups()].map(([sid, { rows, sum }]) => {
      const s = this.byId.get(sid);
      const shared = rows.filter((x) => x.shared > 1).length;
      return h("section", { className: "trace", "data-trace": sid, "data-focus": `trace:${sid}`, tabindex: -1, "aria-labelledby": `t-${sid || "run"}` },
        h("h3", { id: `t-${sid || "run"}` }, s ? `${this.match.clock(s.ts).minute}' ${kindName(s.kind)}` : "Whole run",
          s ? h("button", { type: "button", className: "link", "data-focus": `${sid}:show`, onclick: () => this.showStory(sid) }, "Show story") : null),
        h("p", { className: "trace-sum" }, `${rows.length} hand-offs, ${int(Math.round(sum.tokens))} tokens, ${usd(sum.cost)}, ${(sum.ms / 1000).toFixed(1)} s`,
          shared ? `, counting this story's share of the ${shared} shared with other stories` : ""),
        h("ol", { className: "chain" }, rows.map(({ t: r, shared: n }) => h("li", { "data-agent": r.agent, className: traceFailed(r) ? "failed" : "" },
          h("div", { className: "step-head" }, h("b", {}, AGENT[r.agent]?.name ?? r.agent), h("span", { className: "step" }, r.step),
            h("span", { className: "how" }, r.model ?? (AGENT[r.agent]?.how === "Rules" ? "rules, no model" : "code, no model"))),
          h("p", { className: "io" }, h("span", { className: "io-k" }, "In"), summaryText(r.input_summary)),
          h("p", { className: "io" }, h("span", { className: "io-k" }, "Out"), summaryText(r.output_summary)),
          h("p", { className: "step-meta" },
            r.tokens_in ? `${int(r.tokens_in)} in, ${int(r.tokens_out)} out` : "0 tokens", `, ${int(r.latency_ms)} ms`, r.cost_usd ? `, ${usd(r.cost_usd)}` : "",
            n > 1 ? `, shared by ${n} stories` : ""),
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

function valueText(f) {
  const v = Number(f.value);
  const n = Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) >= 100 ? 0 : 1);
  if (f.unit === "formation") return String(Math.round(v)).split("").join("-"); // 442 is 4-4-2
  return f.unit === "/10" ? `${n}/10` : f.unit === "goals" ? `${n} goal${v === 1 ? "" : "s"}` : `${n} ${f.unit ?? ""}`.trim();
}

function flagText(f) {
  if (typeof f === "string") return f;
  if (f && typeof f === "object") {
    const parts = [f.claim ? `"${f.claim}"` : null, f.reason ?? f.text ?? null, f.fact_id ? `(${f.fact_id})` : null].filter(Boolean);
    return parts.length ? parts.join(" ") : JSON.stringify(f);
  }
  return String(f);
}
