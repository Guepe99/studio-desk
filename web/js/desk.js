// Control desk: the candidate stories with their evidence, approve / edit / reject, the AI kill
// switch, the audit log and the agent traces (docs/CONTRACT.md, Runtime records and API).
//
// One rule decides what goes on air: a story below the risk threshold is auto-approved and plays
// unless this visitor rejects it; a story that needs review is held until this visitor approves it.
// With the AI switched off only template graphics (story_id null) play. Decisions come from the
// API (per visitor, cookie sd_session); with static hosting they are kept in memory for the tab.

const LANGS = { en: "English", it: "Italian", es: "Spanish" };
const KIND = { goal: "Goal", key_pass: "Key pass", momentum_swing: "Momentum swing", comeback: "Comeback",
  top_sprint: "Top sprint", high_press: "High press", tactical_shift: "Tactical shift" };
const STATUS = { auto_approved: "Auto-approved", needs_review: "Needs review", approved: "Approved",
  edited: "Edited and approved", rejected: "Rejected" };
const VERIFIER = { pass: "Pass", rewritten: "Rewritten", template: "Template line" };
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

async function optionalJson(url) {
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : [];
  } catch {
    return [];
  }
}

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
    this.auditRows = []; // from the API: this visitor's actions and the agents' rows
    this.localAudit = []; // without the API: this tab's actions
    this.tab = "stories";
    this.editing = null;
    this.open = new Set(); // stories whose evidence is expanded
    this.note = "";
    this.factIndex = new Map(this.match.facts.map((f) => [f.fact_id, f]));
    this.eventIndex = new Map(this.match.events.map((e) => [e.event_id, e]));
  }

  async load() {
    const base = `data/${this.matchId}`;
    [this.stories, this.traces] = await Promise.all([optionalJson(`${base}/stories.json`), optionalJson(`${base}/traces.json`)]);
    this.stories.sort((a, b) => a.ts - b.ts);
    this.byId = new Map(this.stories.map((s) => [s.story_id, s]));
    try {
      const s = await this.api("GET", "api/session");
      const d = await this.api("GET", `api/decisions?match_id=${encodeURIComponent(this.matchId)}`);
      this.online = true;
      this.kill = Boolean(d.kill_switch ?? s.kill_switch);
      for (const x of d.decisions) this.decisions.set(x.story_id, x);
      await this.refreshAudit();
    } catch {
      this.online = false; // static hosting: decisions live in this tab
    }
    this.render();
  }

  async api(method, path, body) {
    const r = await fetch(path, {
      method, credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch { /* not JSON: no API here */ }
    if (!r.ok || data === null) throw new Error(typeof data?.detail === "string" ? data.detail : `HTTP ${r.status}`);
    return data;
  }

  async refreshAudit() {
    if (!this.online) return;
    try {
      this.auditRows = (await this.api("GET", `api/audit?match_id=${encodeURIComponent(this.matchId)}`)).rows;
    } catch { /* keep the last rows */ }
  }

  // ---- the rule -------------------------------------------------------------------------------

  status(s) { return this.decisions.get(s.story_id)?.decision ?? s.default_status; }
  onAir(s) { return !this.kill && this.status(s) !== "rejected" && this.status(s) !== "needs_review"; }
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

  text(s, lang) { return this.decisions.get(s.story_id)?.edited_text?.[lang] ?? s.texts?.[lang] ?? s.texts?.en ?? ""; }

  // ---- actions --------------------------------------------------------------------------------

  async decide(s, decision, editedText = null) {
    const id = s.story_id, prev = this.decisions.get(id), at = new Date().toISOString();
    this.decisions.set(id, { story_id: id, decision, edited_text: editedText, at });
    this.editing = null;
    this.note = "";
    if (!this.online) {
      this.localAudit.unshift({ at, actor: "human", action: decision, story_id: id, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0,
        detail: { langs: Object.keys(editedText ?? {}) } });
    }
    this.changed();
    if (!this.online) return;
    try {
      await this.api("POST", "api/decisions", { match_id: this.matchId, story_id: id, decision, ...(editedText ? { edited_text: editedText } : {}) });
      await this.refreshAudit();
    } catch (e) {
      if (prev) this.decisions.set(id, prev); else this.decisions.delete(id);
      this.note = `Not saved: ${e.message}`;
    }
    this.changed();
  }

  async setKill(on) {
    const prev = this.kill;
    this.kill = on;
    this.note = "";
    if (!this.online) this.localAudit.unshift({ at: new Date().toISOString(), actor: "human", action: on ? "ai_off" : "ai_on", story_id: null, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, detail: {} });
    this.changed();
    if (!this.online) return;
    try {
      await this.api("POST", "api/kill", { on });
      await this.refreshAudit();
    } catch (e) {
      this.kill = prev;
      this.note = `Not saved: ${e.message}`;
    }
    this.changed();
  }

  changed() {
    this.render();
    this.onChange();
  }

  showTrace(storyId) {
    this.tab = "traces";
    this.render();
    const g = this.root.querySelector(`[data-trace="${storyId}"]`);
    g?.scrollIntoView({ block: "start" });
    g?.focus({ preventScroll: true });
  }

  // ---- rendering ------------------------------------------------------------------------------

  render() {
    const focusKey = document.activeElement?.closest?.("#desk") ? document.activeElement.dataset.focus : null;
    const scroll = this.shownTab === this.tab ? this.root.querySelector(".desk-body")?.scrollTop ?? 0 : 0;
    this.shownTab = this.tab;
    const tabs = [["stories", `Stories`, this.stories.length], ["audit", "Audit log"], ["traces", "Traces"]];
    const tabButton = ([id, label, n]) => h("button", {
      type: "button", role: "tab", id: `tab-${id}`, "aria-controls": `panel-${id}`, "aria-selected": String(this.tab === id),
      tabindex: this.tab === id ? 0 : -1, "data-focus": `tab:${id}`, onclick: () => { this.tab = id; this.render(); },
      onkeydown: (e) => this.tabKeys(e, tabs.map((t) => t[0])),
    }, label, n !== undefined ? h("span", { className: "count" }, n) : null);
    const body = this.tab === "stories" ? this.renderStories() : this.tab === "audit" ? this.renderAudit() : this.renderTraces();
    this.root.replaceChildren(...[
      h("header", { className: "desk-head" },
        h("div", { className: "desk-title" },
          h("h2", {}, "Control desk"),
          h("button", { type: "button", id: "desk-close", className: "ctl", "aria-label": "Close the control desk", "data-focus": "close",
            onclick: () => this.closeDrawer() }, "Close")),
        h("div", { className: "desk-bar" },
          h("button", { type: "button", role: "switch", id: "ai-switch", className: "switch", "aria-checked": String(!this.kill), "data-focus": "kill",
            onclick: () => this.setKill(!this.kill) },
          h("span", { className: "track", "aria-hidden": "true" }, h("span", { className: "knob" })),
          h("span", { className: "switch-label" }, "AI graphics ", h("b", {}, this.kill ? "off" : "on"))),
          h("span", { className: "desk-sum" }, this.stories.length ? `${this.pending()} of ${this.stories.length} waiting for review` : "")),
        h("div", { role: "tablist", "aria-label": "Desk views", className: "tabs" }, tabs.map(tabButton))),
      this.kill ? h("p", { className: "banner", role: "status" }, "AI off: only template graphics are on air. Stories stay listed for review.") : null,
      this.note ? h("p", { className: "banner warn", role: "alert" }, this.note) : null,
      h("div", { className: "desk-body", role: "tabpanel", id: `panel-${this.tab}`, "aria-labelledby": `tab-${this.tab}`, tabindex: 0 }, body),
      h("footer", { className: "desk-foot" }, this.online
        ? "Your decisions are saved for this browser only. Other visitors see the original replay."
        : "No server: decisions are kept in this tab only."),
    ].filter(Boolean)); // replaceChildren would print a null as "null"
    this.root.querySelector(".desk-body").scrollTop = scroll;
    document.querySelector("#ai-off")?.toggleAttribute("hidden", !this.kill);
    const badge = document.querySelector("#desk-open .count");
    if (badge) badge.textContent = this.pending() ? String(this.pending()) : "";
    if (this.editing) this.root.querySelector("textarea")?.focus();
    else if (focusKey) this.root.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus();
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
    if (!this.stories.length) {
      return h("p", { className: "empty" }, "No AI stories in this replay yet. The template graphics play on their own; stories appear here once the agents have run on the match.");
    }
    return h("ol", { className: "stories" }, this.stories.map((s) => h("li", {}, this.renderStory(s))));
  }

  renderStory(s) {
    const lang = this.state.lang, st = this.status(s), id = s.story_id;
    const tally = this.onAir(s) ? "onair" : st === "needs_review" && !this.kill ? "held" : "off";
    const tallyText = { onair: "On air", held: "Held", off: this.kill && st !== "rejected" ? "Off air, AI off" : "Off air" }[tally];
    const minute = this.match.clock(s.ts).minute;
    const who = s.player_id ? this.match.players[s.player_id]?.name : this.match.teams[s.team_id]?.short_name;
    const v = s.verifier ?? {}, flagged = v.flagged ?? [];
    const risk = Number(s.risk);
    const editing = this.editing === id;
    const decided = this.decisions.has(id);
    const act = (decision, label) => h("button", {
      type: "button", className: `ctl act act-${decision}`, "aria-pressed": String(st === decision), "data-focus": `${id}:${decision}`,
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
        decided ? h("span", { className: "default" }, `default: ${(STATUS[s.default_status] ?? s.default_status).toLowerCase()}`) : null,
        h("span", { className: "risk", title: "Below 0.35 a story goes on air by itself" },
          `Risk ${risk.toFixed(2)}`,
          h("span", { className: "meter", "aria-hidden": "true" }, h("span", { style: `width:${Math.round(Math.min(1, Math.max(0, risk)) * 100)}%` })))),
      editing ? this.renderEditor(s) : h("p", { className: "story-text", lang }, this.text(s, lang)),
      h("dl", { className: "checks" },
        h("div", {}, h("dt", {}, "Verifier"), h("dd", { className: `v-${v.status}` },
          `${VERIFIER[v.status] ?? v.status ?? "none"}`, v.attempts ? `, ${v.attempts} attempt${v.attempts > 1 ? "s" : ""}` : "")),
        h("div", {}, h("dt", {}, "Safety"), h("dd", { className: `s-${s.safety}` }, SAFETY[s.safety] ?? s.safety))),
      flagged.length ? h("details", { className: "flagged" }, h("summary", { "data-focus": `${id}:notes` }, `Verifier notes (${flagged.length})`),
        h("ul", {}, flagged.map((f) => h("li", {}, flagText(f))))) : null,
      this.renderEvidence(s),
      editing ? null : h("div", { className: "actions" },
        act("approved", "Approve"), act("edited", "Edit"), act("rejected", "Reject"),
        h("button", { type: "button", className: "link", "data-focus": `${id}:trace`, onclick: () => this.showTrace(id) }, "Show trace")));
  }

  startEdit(s) {
    this.editing = s.story_id;
    this.render();
  }

  renderEditor(s) {
    const lang = this.state.lang, id = s.story_id;
    const counter = h("span", { className: "counter", id: `count-${id}` });
    const area = h("textarea", { lang, maxlength: EDIT_MAX, rows: 4, "aria-label": `Story text in ${LANGS[lang]}`, "aria-describedby": `count-${id}` });
    area.value = this.text(s, lang);
    const count = () => { counter.textContent = `${area.value.length}/${EDIT_MAX}, ${LANGS[lang]}`; };
    count();
    const save = () => {
      const value = area.value.trim();
      if (!value) { this.note = "The text cannot be empty. Reject the story to keep it off air."; this.render(); return; }
      const prev = this.decisions.get(id)?.edited_text ?? {};
      this.decide(s, "edited", { ...prev, [lang]: value });
    };
    const cancel = () => { this.editing = null; this.render(); };
    area.addEventListener("input", count);
    area.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    });
    return h("div", { className: "editor" }, area,
      h("div", { className: "editor-bar" }, counter,
        h("button", { type: "button", className: "ctl", "data-focus": `${id}:cancel`, onclick: cancel }, "Cancel"),
        h("button", { type: "button", className: "ctl primary", "data-focus": `${id}:save`, onclick: save }, "Save and approve")));
  }

  renderEvidence(s) {
    const facts = (s.fact_ids ?? []).map((id) => this.factIndex.get(id) ?? { fact_id: id, label_en: "not in the ledger", missing: true });
    const events = (s.evidence_event_ids ?? []).map((id) => this.eventIndex.get(id) ?? { event_id: id, missing: true });
    const det = h("details", { className: "evidence", ...(this.open.has(s.story_id) ? { open: true } : {}) },
      h("summary", { "data-focus": `${s.story_id}:evidence` }, `Evidence: ${facts.length} fact${facts.length === 1 ? "" : "s"}, ${events.length} event${events.length === 1 ? "" : "s"}`),
      h("div", { className: "ev-grid" },
        this.miniPitch(s, facts, events),
        h("table", { className: "facts" },
          h("caption", { className: "sr" }, "Facts cited by the story"),
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Fact"), h("th", { scope: "col" }, "Value"))),
          h("tbody", {}, facts.map((f) => h("tr", { className: f.missing ? "missing" : "" },
            h("td", {}, h("span", { className: "fid" }, f.fact_id), h("span", { className: "flabel" }, f.label_en ?? "")),
            h("td", { className: "num" }, f.missing ? "" : valueText(f))))))),
      events.length ? h("p", { className: "events" }, "Events ", events.map((e) => h("span", { className: "eid", title: e.missing ? "not in events.json" : `${e.type_name}, ${this.match.players[e.player_id]?.name ?? e.player_id}` },
        e.missing ? `${e.event_id}?` : `${e.event_id} ${e.type_name.replace(/_/g, " ")}`))) : null,
      s.analysis_en ? h("p", { className: "analysis", lang: "en" }, h("b", {}, "Analyst: "), s.analysis_en) : null);
    det.addEventListener("toggle", () => (det.open ? this.open.add(s.story_id) : this.open.delete(s.story_id)));
    return det;
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
      const i = this.match.index[f.player_id];
      if (f.missing || i === undefined || !Array.isArray(f.source_frames) || f.source_events_ids?.length) continue;
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
    const fromApi = this.auditRows.filter((r) => r.actor !== "human");
    const agents = fromApi.length ? fromApi : this.traces.map((t) => ({ at: t.at, actor: t.agent, action: t.step,
      story_id: this.traceStory(t), model: t.model, tokens_in: t.tokens_in, tokens_out: t.tokens_out, cost_usd: t.cost_usd }));
    const directorAt = new Map(this.traces.filter((t) => t.agent === "director").flatMap((t) => this.traceStories(t).map((id) => [id, t.at])));
    const auto = fromApi.some((r) => r.actor === "auto") ? [] : this.stories.filter((s) => s.default_status === "auto_approved")
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
    const ids = (t.story_ids ?? []).filter((id) => this.byId.has(id));
    if (ids.length) return ids;
    if (t.story_id) return [t.story_id];
    const named = `${t.input_summary} ${t.output_summary}`.match(/S-\d{6}/)?.[0];
    if (named && this.byId.has(named)) return [named];
    return [this.stories.find((s) => (t.fact_ids ?? []).some((f) => s.fact_ids.includes(f)))?.story_id ?? null];
  }

  traceStory(t) { return this.traceStories(t)[0]; }

  renderTraces() {
    const legend = h("ol", { className: "pipeline", "aria-label": "How a story is made" },
      AGENTS.map(([id, name, how, role]) => h("li", { "data-agent": id }, h("b", {}, name), h("span", { className: "how" }, how), h("span", { className: "role" }, role))));
    if (!this.traces.length) return [legend, h("p", { className: "empty" }, "No agent traces in this replay yet.")];
    const groups = new Map();
    for (const t of this.traces) {
      for (const k of this.traceStories(t).map((id) => id ?? "")) {
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(t);
      }
    }
    return [legend, [...groups].map(([sid, rows]) => {
      rows.sort((a, b) => a.seq - b.seq);
      const s = this.byId.get(sid);
      const sum = (k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
      return h("section", { className: "trace", "data-trace": sid, tabindex: -1, "aria-labelledby": `t-${sid || "run"}` },
        h("h3", { id: `t-${sid || "run"}` }, s ? `${this.match.clock(s.ts).minute}' ${kindName(s.kind)}` : "Whole run",
          s ? h("button", { type: "button", className: "link", onclick: () => this.showStory(sid) }, "Show story") : null),
        h("p", { className: "trace-sum" }, `${rows.length} hand-offs, ${int(sum("tokens_in") + sum("tokens_out"))} tokens, ${usd(sum("cost_usd"))}, ${(sum("latency_ms") / 1000).toFixed(1)} s`),
        h("ol", { className: "chain" }, rows.map((r) => h("li", { "data-agent": r.agent, className: /fail/.test(r.output_summary) ? "failed" : "" },
          h("div", { className: "step-head" }, h("b", {}, AGENT[r.agent]?.name ?? r.agent), h("span", { className: "step" }, r.step),
            h("span", { className: "how" }, r.model ?? (AGENT[r.agent]?.how === "Rules" ? "rules, no model" : "code, no model"))),
          h("p", { className: "io" }, h("span", { className: "io-k" }, "In"), r.input_summary),
          h("p", { className: "io" }, h("span", { className: "io-k" }, "Out"), r.output_summary),
          h("p", { className: "step-meta" },
            r.tokens_in ? `${int(r.tokens_in)} in, ${int(r.tokens_out)} out` : "0 tokens", `, ${int(r.latency_ms)} ms`, r.cost_usd ? `, ${usd(r.cost_usd)}` : ""),
          r.fact_ids?.length ? h("p", { className: "fids" }, r.fact_ids.map((f) => h("span", { className: "fid" }, f))) : null))));
    })];
  }

  showStory(id) {
    this.tab = "stories";
    this.render();
    const el = this.root.querySelector(`#story-${CSS.escape(id)}`);
    el?.scrollIntoView({ block: "start" });
    el?.querySelector(".minute")?.focus({ preventScroll: true });
  }

  closeDrawer() {
    document.body.classList.remove("desk-open");
    const b = document.querySelector("#desk-open");
    b?.setAttribute("aria-expanded", "false");
    b?.focus();
  }
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
