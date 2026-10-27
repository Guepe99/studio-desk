// Watch for (docs/forecast.md): the producer's storyline forecasts from data/<match>/forecast.json, made by code
// from the facts (studiodesk/forecast.py). Each open forecast shows its probability, a reason from the facts and
// a prepared line whose minute and score code fills when the event happens. A line the producer pre-approves
// goes on air as a why_card at the event's own time; a line nobody pre-approved never airs. The decisions stay
// in this tab, in the desk's audit trail, as the generated graphics' do.
import { h, tr } from "./desk.js";

export const PREP_S = 6;   // a prepared card's time on air: it ends before the agents' card at the goal (+6.3 s)
const RECENT_S = 90;       // an event stays in the panel this long after it happened, with what aired

/** The latest forecast step at or before ts, or null. */
export function stepAt(data, ts) {
  let best = null;
  for (const s of data?.steps ?? []) if (s.ts <= ts + 1e-6) best = s; else break;
  return best;
}

/** The prepared cues: one why_card per pre-approved line whose event happens after its approval, at the
 *  event's time, in the audience and language on air. story_id null: code's own text, so the broadcast
 *  delay (feat/broadcast-delay) leaves it on its event. */
export function preparedCues(data, approvals, audience, lang) {
  const out = [];
  for (const it of data?.items ?? []) {
    const a = approvals.get(it.id);
    if (!a || !it.hit || !it.line || !(a.ts < it.at)) continue;
    out.push({ cue_id: `P-${it.id}`, match_id: data.match_id, story_id: null, ts: it.at, duration_s: PREP_S, graphic: "why_card",
      audience, lang, payload: { kind: "why", title: it.title[lang] ?? it.title.en, body: it.line[lang] ?? it.line.en,
        fact_ids: it.line_fact_ids, prepared: true, forecast_id: it.id } });
  }
  // two lines on the same event (a goal that is a second goal and a late goal): the first one only
  const seen = new Set();
  return out.sort((x, y) => x.ts - y.ts).filter((c) => !seen.has(c.ts) && seen.add(c.ts));
}

/** The sheet with the prepared cues in it: a why_card of the sheet that would start while a prepared one is
 *  on air waits for its end (the card keeps its slot through `due`, as view3d.js holdForReplays does). */
export function withPrepared(sheet, prepared) {
  if (!prepared.length) return sheet;
  const moved = sheet.map((c) => {
    if (c.graphic !== "why_card") return c;
    const p = prepared.find((x) => x.ts <= c.ts && c.ts < x.ts + x.duration_s);
    return p ? { ...c, ts: p.ts + p.duration_s, due: c.due ?? c.ts } : c;
  });
  return [...moved, ...prepared].sort((a, b) => a.ts - b.ts);
}

const auditRow = (action, ts, it, extra = {}) => ({ at: new Date().toISOString(), ts, actor: "human", action, story_id: it.id, model: null,
  tokens_in: 0, tokens_out: 0, cost_usd: 0,
  detail: { prepared: true, forecast: it.id, title_en: it.title.en, title_it: it.title.it, title_es: it.title.es, ...extra } });

export class Watch {
  /** @param {{desk, state, onChange: () => void}} opts */
  constructor(opts) {
    Object.assign(this, opts);
    this.data = null;
    this.approvals = new Map(); // forecast id -> {ts}: pre-approved at that match time
    this.aired = new Set();     // prepared cue ids already logged as on air
    this.key = "";
    this.until = 0;             // the end of the last cue this panel added or moved (app.js keeps the clock running to it)
  }

  async load(base) {
    try {
      const r = await fetch(`${base}/forecast.json`);
      if (!r.ok) return false;   // no forecasts for this match: no panel, the page as before
      this.data = await r.json();
    } catch { return false; }
    this.byId = new Map(this.data.items.map((it) => [it.id, it]));
    // the stories waiting for the producer stay on screen: closed on a short or narrow desk (one click opens it),
    // and under the stories on the narrow drawer
    this.el = h("details", { className: "watch" });
    this.el.open = matchMedia("(min-width: 1100px) and (min-height: 900px)").matches;
    if (matchMedia("(min-width: 1100px)").matches) this.desk.root.insertBefore(this.el, this.desk.bodyEl);
    else this.desk.root.append(this.el);
    return true;
  }

  tx(key, vars) { return tr(this.state.lang, key, vars); }

  /** app.js cueSheet: the desk's sheet with the pre-approved lines. */
  sheet(cues, audience, lang) {
    const prepared = preparedCues(this.data, this.approvals, audience, lang);
    const out = withPrepared(cues, prepared);
    this.until = Math.max(0, ...out.filter((c) => c.due !== undefined || c.payload?.prepared).map((c) => c.ts + c.duration_s));
    return out;
  }

  toggle(id, now) {
    const it = this.byId.get(id);
    if (!it || it.at <= now) return;   // only before the event
    const on = !this.approvals.has(id);
    if (on) this.approvals.set(id, { ts: now }); else this.approvals.delete(id);
    this.desk.localAudit.unshift(auditRow(on ? "prepared_approved" : "prepared_withdrawn", now, it));
    this.key = "";
    this.onChange();
    this.desk.render();
  }

  /** Every frame. ts: the picture's time; delay: how far the desk runs ahead of it (feat/broadcast-delay). */
  update(ts, live, delay = 0) {
    if (!this.data) return;
    for (const c of live) {
      if (!c.payload?.prepared || this.aired.has(c.cue_id)) continue;
      this.aired.add(c.cue_id);
      this.desk.localAudit.unshift(auditRow("prepared_aired", c.ts, this.byId.get(c.payload.forecast_id), { cue_id: c.cue_id, lang: c.lang }));
      this.key = "";
      this.desk.render();
    }
    const now = ts + delay, step = stepAt(this.data, now);
    const recent = this.data.items.filter((it) => it.hit && it.at <= now && now < it.at + RECENT_S);
    const key = `${this.state.lang}|${step?.ts}|${recent.map((it) => it.id)}|${[...this.approvals.keys()]}|${this.aired.size}`;
    if (key === this.key) return;
    this.key = key;
    this.render(step, recent, now);
  }

  render(step, recent, now) {
    const lang = this.state.lang, pct = new Intl.NumberFormat(lang, { style: "percent" });
    const focused = document.activeElement?.closest?.("[data-watch]")?.dataset.watch;
    const slot = (name) => h("span", { className: "w-slot" }, this.tx(`w_slot_${name.toLowerCase()}`));
    // the template with its open slots as chips: {minute} and {score} wait for the event
    const line = (text) => String(text).split(/(\{\w+\})/).filter(Boolean).map((part) => (/^\{\w+\}$/.test(part) ? slot(part.slice(1, -1)) : part));
    const open = (step?.items ?? []).map((f) => {
      const it = this.byId.get(f.id), on = this.approvals.has(f.id);
      return h("li", { className: `w-item${on ? " on" : ""}`, "data-watch": f.id },
        h("div", { className: "w-top" }, h("span", { className: "w-title" }, it.title[lang] ?? it.title.en),
          h("span", { className: "w-p", title: this.tx("w_pTitle") }, pct.format(f.p))),
        h("div", { className: "w-bar", "aria-hidden": "true" }, h("span", { style: `width:${Math.round(f.p * 100)}%` })),
        h("p", { className: "w-reason" }, f.reason[lang] ?? f.reason.en),
        h("p", { className: "w-line" }, line(it.template[lang] ?? it.template.en)),
        h("button", { type: "button", className: "ctl w-pre", "aria-pressed": String(on), "data-watch": f.id,
          onclick: () => this.toggle(f.id, this.state.ts + (this.desk.delay || 0)) }, this.tx(on ? "w_preOn" : "w_pre")));
    });
    const done = recent.map((it) => {
      const aired = this.aired.has(`P-${it.id}`);
      return h("li", { className: "w-item w-done", "data-watch": it.id },
        h("div", { className: "w-top" }, h("span", { className: "w-title" }, it.title[lang] ?? it.title.en),
          h("span", { className: "w-out" }, this.tx(aired ? "w_aired" : "w_notAired"))),
        h("p", { className: "w-line" }, it.line[lang] ?? it.line.en));
    });
    this.el.replaceChildren(
      h("summary", { className: "w-head" }, h("h3", { id: "watch-head" }, this.tx("w_head")), h("span", { className: "w-note" }, this.tx("w_note"))),
      open.length || done.length ? h("ul", { className: "w-list" }, ...done, ...open) : h("p", { className: "w-empty" }, this.tx("w_empty")));
    if (focused) this.el.querySelector(`button[data-watch="${CSS.escape(focused)}"]`)?.focus();
  }
}
