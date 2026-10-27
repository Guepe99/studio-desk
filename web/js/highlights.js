// Highlights (docs/highlights.md): a reel of the first half, the second half or the whole match, played on
// the page's own clock. Code picks and orders the moments, no model: every goal (the `score` facts), then
// the agents' big chances by how close they came, while the half's reel stays within BUDGET_S. Each
// moment plays from LEAD_S before its shot to AFTER_S after it, back to back in match order; a strip on
// the picture says the minute and what it is, and the score once a goal is in. It only drives seek and
// play, so it works in 2D and 3D, for every audience and language. Stopping goes back to where you were.
import { LEAD_S } from "./moments.js";
import { kindName } from "./desk.js";

// a goal keeps the celebration and the 3D view's own replay (view3d.js REPLAY: from 6 s to 11.5 s after it)
export const AFTER_S = { goal: 12, big_chance: 4 };
export const BUDGET_S = 90;   // per half: the 90 s short-report cap (docs/highlights.md)
// how close a chance came, from the shot_distance fact's outcome: the keeper had to save it, then a near miss
const OUTCOME = { saved: 0, over: 1, wide: 1, blocked: 2 };
const PARTS = ["h1", "h2", "full"];

export const HL_STRINGS = {
  en: { hl: "Highlights", hlH1: "Highlights: first half", hlH2: "Highlights: second half", hlFull: "Highlights: full match",
    hlStop: "Stop highlights", hlNone: "No highlights in this part of the match",
    hlWatchH1: "Watch the first half highlights", hlWatchFull: "Watch the match highlights" },
  it: { hl: "Highlights", hlH1: "Highlights: primo tempo", hlH2: "Highlights: secondo tempo", hlFull: "Highlights: tutta la partita",
    hlStop: "Ferma gli highlights", hlNone: "Nessun highlight in questa parte della partita",
    hlWatchH1: "Guarda gli highlights del primo tempo", hlWatchFull: "Guarda gli highlights della partita" },
  es: { hl: "Resumen", hlH1: "Resumen: primera parte", hlH2: "Resumen: segunda parte", hlFull: "Resumen: partido completo",
    hlStop: "Detener el resumen", hlNone: "No hay jugadas destacadas en esta parte del partido",
    hlWatchH1: "Ver el resumen de la primera parte", hlWatchFull: "Ver el resumen del partido" },
};

/** A story the producer has not taken off: rejected is out, and a story Content Safety flagged only once approved or edited. */
export const usable = (s, decision) => decision !== "rejected" && !(s.safety === "flagged" && !["approved", "edited"].includes(decision));

// the shot behind a goal or a story: its latest evidence event up to 10 s before (app.js playStart), else the time itself
function shotTs(match, ts, ids = []) {
  const evs = match.events.filter((e) => ids?.includes(e.event_id) && e.ts <= ts && e.ts >= ts - 10);
  return evs.length ? Math.max(...evs.map((e) => e.ts)) : ts;
}

// [from, to] of a half in match seconds
const half = (match, h) => (h === 1 ? [0, match.meta.period1_s] : [match.meta.period1_s, match.duration]);

// back to back in match order; windows that touch become one clip, so nothing plays twice
export function clips(moments) {
  const out = [];
  for (const m of [...moments].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && m.start <= last.end) { last.end = Math.max(last.end, m.end); last.moments.push(m); }
    else out.push({ start: m.start, end: m.end, moments: [m] });
  }
  return out;
}
export const length = (cs) => cs.reduce((n, c) => n + c.end - c.start, 0);

/** The reel of one half (1 or 2): every goal, then big chances, saved ones first, then near misses, then
 *  blocked, the closer shot first, while the reel stays within BUDGET_S. With the AI off, goals only.
 *  @param stories  the replay's stories; @param decision (s) => this visitor's status of a story */
export function halfReel(match, stories, h, { aiOff = false, decision = (s) => s.default_status } = {}) {
  const [from, to] = half(match, h), inHalf = (ts) => ts > from && ts <= to;
  const at = (kind, ts, ids, extra) => {
    const shot = shotTs(match, ts, ids);
    return { kind, ts, shot, start: Math.max(from, shot - LEAD_S), end: Math.min(to, shot + AFTER_S[kind]), ...extra };
  };
  const goals = match.goals.filter((f) => inHalf(f.ts)).map((f) => at("goal", f.ts, f.source_event_ids, {
    team_id: f.team_id, player_id: f.player_id ?? match.events.find((e) => e.event_id === f.source_event_ids?.[0])?.player_id, fact_id: f.fact_id }));
  const outcome = new Map(match.facts.filter((f) => f.kind === "shot_distance")
    .map((f) => [f.source_event_ids?.[0], { rank: OUTCOME[/(\w+)\s*$/.exec(f.label_en ?? "")?.[1]] ?? 3, m: f.value }]));
  const chances = aiOff ? [] : stories.filter((s) => s.kind === "big_chance" && inHalf(s.ts) && usable(s, decision(s)))
    .map((s) => at("big_chance", s.ts, s.evidence_event_ids, { team_id: s.team_id, player_id: s.player_id, story_id: s.story_id,
      ...(outcome.get(s.evidence_event_ids?.[0]) ?? { rank: 3, m: Infinity }) }))
    .sort((a, b) => a.rank - b.rank || a.m - b.m || a.ts - b.ts);
  let picked = goals;   // every goal goes in, whatever the budget
  for (const c of chances) if (length(clips([...picked, c])) <= BUDGET_S) picked = [...picked, c];
  return clips(picked);
}

/** The reel of a part: "h1", "h2" or "full" (the two halves' reels one after the other). */
export const reel = (match, stories, part, opts) =>
  (part === "full" ? [1, 2] : [part === "h1" ? 1 : 2]).flatMap((h) => halfReel(match, stories, h, opts));

/** The words on the strip for a moment, in the page's language: "Goal, Okowande (RED), 10'" with the
 *  score after it once the goal is in, "Big chance, Duarte (OST), 8'". Names and codes from meta.json. */
export function caption(match, m, lang, t, now) {
  const name = match.players[m.player_id]?.name, code = match.teams[m.team_id]?.short_name;
  const who = name && code ? `${name} (${code})` : name || code || "?", min = match.clock(m.ts).label;
  const what = m.kind === "goal" ? t("goalAt").replace("{who}", who).replace("{m}", min) : `${kindName(m.kind, lang)}, ${who}, ${min}'`;
  if (m.kind !== "goal" || now < m.ts) return { what, score: "" };
  const [h, a] = match.score(m.ts);
  return { what, score: `${match.home.short_name} ${h}-${a} ${match.away.short_name}` };
}

/** The reel offered beside the recap card: "h1" while the half-time recap is on, "full" from the full-time
 *  recap on (the clock stops at its end, so the offer stays), else null. The recap times from the cue sheet. */
const windows = new WeakMap();   // per match: the offer runs every frame, the cue sheet is read once
export function offer(match, now) {
  if (!windows.has(match)) {
    const p1 = match.meta.period1_s;
    const recaps = (match.cues ?? []).filter((c) => c.graphic === "why_card" && c.payload?.kind === "recap");
    const at = (h) => recaps.filter((c) => (h === 1 ? Math.abs(c.ts - p1) <= 1 : c.ts >= match.duration - 1));
    const span = (cs, from) => [Math.min(from, ...cs.map((c) => c.ts)), Math.max(from + 12, ...cs.map((c) => c.ts + c.duration_s))];
    windows.set(match, [...span(at(1), p1), span(at(2), match.duration)[0]]);
  }
  const [a, b, c] = windows.get(match);
  return now >= a && now <= b ? "h1" : now >= c ? "full" : null;
}

export class Highlights {
  /** @param {{match, state, desk, t, seek, setSpeed, setPlaying, stop: HTMLButtonElement, offerBtn: HTMLButtonElement,
   *    strip: HTMLElement, live: HTMLElement, frame: HTMLElement}} opts */
  constructor(opts) {
    Object.assign(this, opts);
    this.reel = null;
    this.shown = "";
    this.offered = null;
    this.stop.addEventListener("click", () => this.end(true));
    this.offerBtn.addEventListener("click", () => this.start(this.offered));
  }

  start(part) {
    if (!PARTS.includes(part)) return;
    const d = this.desk, decision = (s) => d.decisions.get(s.story_id)?.decision ?? d.defaultStatus(s);
    const r = reel(this.match, d.stories ?? [], part, { aiOff: d.kill, decision });
    if (!r.length) { this.say(this.t("hlNone")); return; }
    // where you were: a second press of a part keeps the first place
    this.back ??= { ts: this.state.ts, playing: this.state.playing, speed: this.state.speed };
    this.reel = r;
    this.i = 0;
    this.showOffer(null);
    this.setSpeed(1);   // a replay at 16x would flash past, and the 3D replays play up to 4x only
    this.seek(r[0].start);
    this.setPlaying(true);
    this.stop.hidden = false;
    this.strip.hidden = false;
    this.shown = "";
  }

  /** back: return to where the viewer was (Stop, or the reel's end); without it the viewer moved elsewhere and stays. */
  end(back) {
    if (!this.reel) return;
    const b = this.back, focused = document.activeElement === this.stop;
    this.reel = null;
    this.back = null;
    this.stop.hidden = true;
    this.strip.hidden = true;
    this.strip.classList.remove("cut");
    if (back) { this.seek(b.ts); this.setSpeed(b.speed); this.setPlaying(b.playing); }
    // the hidden Stop button would drop the focus to the page: it goes to the frame, where the player keys work
    if (focused) this.frame?.focus({ preventScroll: true });
  }

  /** Every frame, before anything draws the clock: the next clip at the end of one, and the strip. */
  update(now) {
    if (!this.reel) return this.showOffer(offer(this.match, now));
    const c = this.reel[this.i];
    if (now < c.start - 1 || now > c.end + 1.5) return this.end(false);   // a seek of the viewer's own
    if (now >= c.end) {
      if (++this.i >= this.reel.length) return this.end(true);
      this.seek(this.reel[this.i].start);
      return this.update(this.state.ts);
    }
    const ms = c.moments, m = [...ms].reverse().find((x) => x.start <= now) ?? ms[0], lang = this.state.lang;
    const { what, score } = caption(this.match, m, lang, this.t, now);
    const key = `${this.i}|${ms.indexOf(m)}|${what}|${score}|${lang}`;
    if (key === this.shown) return;
    const cut = !this.shown.startsWith(`${this.i}|${ms.indexOf(m)}|`);
    this.shown = key;
    this.strip.lang = lang;
    this.strip.querySelector(".hl-tag").textContent = this.t("hl");
    this.strip.querySelector(".hl-what").textContent = what;
    const sc = this.strip.querySelector(".hl-score");
    sc.textContent = score;
    sc.hidden = !score;
    this.stop.lang = lang;
    this.stop.textContent = `${this.t("hlStop")} ${this.i + 1}/${this.reel.length}`;
    // a new moment comes in with a wipe, as a replay comes in behind a logo transition
    if (cut) { this.strip.classList.remove("cut"); void this.strip.offsetWidth; this.strip.classList.add("cut"); }
  }

  showOffer(part) {
    const key = part && `${part}|${this.state.lang}`;
    if (key === this.offerKey) return;
    this.offerKey = key;
    this.offered = part;
    this.offerBtn.hidden = !part;
    if (!part) return;
    this.offerBtn.lang = this.state.lang;
    this.offerBtn.textContent = this.t(part === "h1" ? "hlWatchH1" : "hlWatchFull");
  }

  say(text) { this.live.textContent = ""; requestAnimationFrame(() => { this.live.textContent = text; }); }
}
