// Booth commentary planner (docs/commentary.md): a play-by-play voice and a co-commentator, plus crowd reactions,
// scheduled from the match events and the fact ledger. Pure module: no DOM, no audio, so node tests drive it.
//
// Live-ready: a Booth only ever sees what was fed to it so far. step(input) takes the next input in time order
// (a fact, an event, a studio clip, a period end, or a clock tick) and returns the plan items that starts. A
// replay is driven through the same function by planMatch(). Items: {t, voice: "pbp"|"co"|"crowd", kind, text,
// clips: [{key, off, dur}], dur, until?, event_id?, fact_ids, names}. `until` cuts an item short (a studio clip
// or a priority event); until <= t means it never plays.
//
// Clips come from manifests built by studiodesk/booth.py: a line whose clips are not all there is skipped, so a
// live match whose names are not rendered yet gets the name-free lines only. The rules cite the research in
// docs/commentary.md (A1-A7 play-by-play, B crowd, C1-C7 booth).

export const RULES = {
  react: 0.35,          // event to first word
  gapMin: 1.0,          // A2: same voice, after a line ends
  gapMax: 4.0,
  handover: [0.3, 0.8], // C4: pause before the other voice
  waitA: 3.0,           // A3: an A line may wait this long, a B line waitB, a C line must start at once
  waitB: 1.0,
  nameS: 6,             // A4: no name again within 6 s
  hold: [9, 12],        // A5: silence after the goal call
  studioAfter: 1.5,     // A7
  coCooldown: [30, 50], // C3: generic co turns in open play
  coCooldownLow: 15,    // the same while the co is under its share
  coStoppageP: 0.7,     // C2 [LF]
  coShare: [0.23, 0.27], // C1: the co's share of the booth's speech it steers to
  stoppageS: 15,
  lullS: 8,
  fillS: 3.5,           // silence before the booth fills it: in play it is never silent over 6 s (quietS)
  quietS: 6,
  kickoffWaitS: 45,     // after a goal, the talk turns to the kick-off this long after the goal
  deadS: 8,             // no event for this long: the ball is dead
  chainMax: 3,          // A4: names in a row, then a pause
  chainPause: 2,
  join: 0.06,           // between the clips of one sentence
  joinRising: 0.14,     // after "Name..."
  sentence: 0.35,       // between the sentences of one line
  closeM: 11, longGoalM: 20, oohM: 18, hardKmh: 100, sprintKmh: 32, momentum: 8, press: 4.5,
  highLine: 40, deepLine: 18, longPassM: 30,
};

const PH = /\{(player|receiver|keeper|team2?|fact:[a-z_]+)(?:\|(of))?\}/g;
const PUNCT = /^(?:\.\.\.|[!?.,:;])/;
const PEOPLE = new Set(["player", "receiver", "keeper"]);
const KICKED = new Set(["pass", "cross", "clearance", "goalkick", "freekick_short", "freekick_crossed", "corner_short",
  "corner_crossed", "shot", "shot_freekick", "shot_penalty"]);
export const UNIT = { shot_speed: "km/h", sprint_speed: "km/h", shot_distance: "m", line_height: "m",
  momentum: "/10", press_intensity: "/10", pass_accuracy: "%", distance_covered: "km", formation: null };

export const clipKey = (role, text) => `${role}|${text}`;

/** A fact value as the co says it; the same rounding as studiodesk/booth.py's clip ranges. */
export function number(v, unit, lang) {
  if (unit === null) return String(Math.trunc(v)).split("").join("-");
  if (unit === "km" && v > 200) v /= 1000;
  const tenths = unit === "/10" || unit === "km";
  const x = tenths ? Math.round(v * 10) / 10 : Math.round(v);
  const s = Number.isInteger(x) ? String(x) : x.toFixed(1);
  return lang === "en" ? s : s.replace(".", ",");
}

/** studiodesk/booth.py pieces(): a sentence cut at its placeholders. */
export function pieces(sentence, role, lang, lines) {
  const s = sentence.replaceAll("{co}", lines.personas[lang].call);
  const found = [...s.matchAll(PH)];
  if (!found.length) return [["text", s.trim()]];
  if (found.every((m) => m[1].startsWith("team"))) return [["line", s]];
  const out = [];
  let pos = 0;
  for (const m of found) {
    const text = s.slice(pos, m.index).trim();
    if (/[\p{L}\p{N}_]/u.test(text)) out.push(["text", text]);
    const p = PUNCT.exec(s.slice(m.index + m[0].length));
    const mark = p ? p[0] : "";
    pos = m.index + m[0].length + mark.length;
    if (m[1].startsWith("fact:")) out.push(["fact", m[1].slice(5), mark && ".!?".includes(mark) && mark !== "..." ? "." : ""]);
    else {
      const tone = mark === "!" ? "!" : mark === "..." ? "..." : !mark && role === "pbp" ? "..." : ".";
      out.push(["name", m[1], m[2] ?? null, tone]);
    }
  }
  const tail = s.slice(pos).trim();
  if (/[\p{L}\p{N}_]/u.test(tail)) out.push(["text", tail]);
  return out;
}

// mulberry32: a small seeded generator, so a plan is the same on every run
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const outcome = (f) => (f?.label_en ?? "").split(",").pop().trim(); // "Shot from 9 m, ..., wide": "wide"

export class Booth {
  /** @param {{lines, lang: string, meta, names?: {players, teams}, durations: Map<string, number>, seed?: number}} o */
  constructor(o) {
    Object.assign(this, { lines: o.lines, lang: o.lang, meta: o.meta, names: o.names ?? { players: {}, teams: {} },
      durations: o.durations });
    this.rand = rng(o.seed ?? 1);
    this.plan = [];
    this.facts = [];
    this.byEvent = new Map();  // event_id -> facts
    this.latest = new Map();   // `${kind}|${team}` and `${kind}|${player}` -> latest fact
    this.end = { pbp: -1e9, co: -1e9 };
    this.sec = { pbp: 0, co: 0 };  // speech so far, to keep the co near a quarter of it (C1)
    this.gap = { pbp: RULES.gapMin, co: RULES.gapMin };
    this.blockFrom = Infinity; this.blockUntil = -1; this.needFresh = false;
    this.holdUntil = -1;
    this.said = new Map();     // name id -> last time said
    this.recent = new Map();     // `${role}|${kind}` -> the variants used last, newest first
    this.pending = [];         // follow-ups: {at, until, run(now)}
    this.coNext = 60;
    this.stoppage = -1e9; this.lastAB = 0;
    this.last = null;          // last event
    this.chain = 0; this.chainUntil = -1;
    this.period = 0; this.inBreak = false;
    this.goalEvent = null;
    this.anticipation = null;
    this.used = new Set();     // fact ids the co already cited
    this.missing = new Set();  // clip keys a line wanted and the manifests lack
    const home = o.meta.teams.find((t) => t.side === "home") ?? o.meta.teams[0];
    this.home = home.team_id;
    this.other = Object.fromEntries(o.meta.teams.map((t) => [t.team_id, o.meta.teams.find((u) => u !== t)?.team_id]));
    this.players = new Map(o.meta.players.map((p) => [p.player_id, p]));
  }

  // --- what the booth knows -------------------------------------------------------------------------------------

  addFact(f) {
    this.facts.push(f);
    for (const id of f.source_event_ids ?? []) {
      if (!this.byEvent.has(id)) this.byEvent.set(id, []);
      this.byEvent.get(id).push(f);
    }
    this.latest.set(`${f.kind}|${f.player_id ?? f.team_id}`, f); // a team's figure and a player's are kept apart
  }

  eventFact(e, kind) { return (this.byEvent.get(e.event_id) ?? []).find((f) => f.kind === kind); }

  // home attacks +x in the first half (true of every match in the data; shortcut: read it from the line-up
  // positions once a feed carries the attacking side)
  attacksUp(team) { return (team === this.home) === (this.period !== 2); }

  inFinalThird(e) {
    const x = e.end_x ?? e.start_x;
    return this.attacksUp(e.team_id) ? x > 70 : x < 35;
  }

  inOppHalf(e) { return this.attacksUp(e.team_id) ? e.start_x > 52.5 : e.start_x < 52.5; }

  keeperOf(team, ts) {
    const on = (this.meta.lineups ?? []).filter((l) => (l.starter || l.on_ts !== null) && (l.on_ts ?? 0) <= ts
      && (l.off_ts === null || l.off_ts > ts));
    const gk = on.map((l) => this.players.get(l.player_id)).find((p) => p?.team_id === team && p.position === "GK");
    return gk?.player_id ?? null;
  }

  // --- rendering a line into clips ------------------------------------------------------------------------------

  /** One variant (a list of sentences) with its slots filled, or null when a clip is missing. */
  render(role, sentences, slots) {
    const clips = [], names = [], factIds = [], words = [];
    let off = 0;
    for (const [i, sentence] of sentences.entries()) {
      if (i) off += RULES.sentence - RULES.join;
      for (const p of pieces(sentence, role, this.lang, this.lines)) {
        let text;
        if (p[0] === "text") text = p[1];
        else if (p[0] === "line") {
          if (!slots.team) return null;
          text = this.fillTeams(p[1], slots.team, slots.team2 ?? this.other[slots.team]);
          names.push(slots.team);
        } else if (p[0] === "fact") {
          const f = slots.facts?.[p[1]];
          if (!f) return null;
          const v = number(f.value, UNIT[p[1]], this.lang);
          factIds.push(f.fact_id);
          if (UNIT[p[1]]) { // the number, then its unit (studiodesk/booth.py fact_texts)
            const k = clipKey(role, v), d = this.durations.get(k);
            if (d === undefined) { this.missing.add(k); return null; }
            clips.push({ key: k, off: Math.round(off * 1000) / 1000, dur: d });
            off += d + RULES.join;
            words.push(v);
            text = this.lines.units[this.lang][UNIT[p[1]]] + p[2];
          } else text = v + p[2];
        } else {
          const id = p[1] === "team2" ? slots.team2 ?? this.other[slots.team] : slots[p[1]];
          const called = PEOPLE.has(p[1]) ? this.names.players[id] : this.names.teams[id]?.[p[2] ?? ""];
          if (!called) return null;
          text = called + p[3];
          names.push(id);
        }
        const key = clipKey(role, text), dur = this.durations.get(key);
        if (dur === undefined) { this.missing.add(key); return null; }
        clips.push({ key, off: Math.round(off * 1000) / 1000, dur });
        off += dur + (p[0] === "name" && p[3] === "..." ? RULES.joinRising : RULES.join);
        words.push(text);
      }
    }
    return { clips, dur: Math.round((off - RULES.join) * 1000) / 1000, names, factIds, text: words.join(" ") };
  }

  fillTeams(sentence, team, team2) {
    const s = sentence.replaceAll("{co}", this.lines.personas[this.lang].call)
      .replace(PH, (_, slot, form) => this.names.teams[slot === "team" ? team : team2]?.[form ?? ""] ?? "");
    return s.slice(0, 1).toUpperCase() + s.slice(1);
  }

  /** Pick a variant of `kind` that renders, avoiding the last one used and names said within 6 s. */
  choose(role, kind, slots, t) {
    const vs = this.lines[role][this.lang][kind] ?? [];
    const ok = [];
    vs.forEach((v, i) => {
      const r = this.render(role, Array.isArray(v) ? v : [v], slots);
      if (r && !r.names.some((n) => PEOPLE.has(this.slotOf(slots, n)) && t - (this.said.get(n) ?? -1e9) < RULES.nameS)) ok.push([i, r]);
    });
    if (!ok.length) return null;
    // never the last variant; of a kind said often (the fill-in lines), not one of the last few either
    const recent = this.recent.get(`${role}|${kind}`) ?? [];
    const rested = ok.filter(([i]) => !recent.slice(0, Math.max(1, Math.min(4, Math.floor(vs.length / 3)))).includes(i));
    const fresh = vs.length < 2 ? ok : rested.length ? rested : ok.filter(([i]) => i !== recent[0]);
    if (!fresh.length) return null;
    const [i, r] = fresh[Math.floor(this.rand() * fresh.length)];
    return { ...r, variant: i }; // remembered once the line is really planned (emit)
  }

  slotOf(slots, id) { return ["player", "receiver", "keeper"].find((s) => slots[s] === id) ?? "team"; }

  // --- scheduling ------------------------------------------------------------------------------------------------

  /** When `role` may start at or after t0: its own gap, a handover after the other voice. */
  earliest(role, t0, prio) {
    const other = role === "pbp" ? "co" : "pbp";
    const own = this.end[role] + (prio === "C" ? this.gap[role] : RULES.gapMin);
    const [h0, h1] = RULES.handover;
    return Math.max(t0, own, this.end[other] + (h0 + h1) / 2);
  }

  blocked(t, dur) {
    return (t + dur > this.blockFrom && t < this.blockUntil) || t < this.holdUntil;
  }

  /** Say a line now or soon; returns the item or null. */
  say(role, kinds, slots, t0, prio, opts = {}) {
    if (opts.cut && role === "pbp") this.cutCo(t0);
    let r = null, kind = null;
    for (const k of kinds) { r = this.choose(role, k, slots, t0); if (r) { kind = k; break; } }
    if (!r) return null;
    const wait = prio === "A" ? RULES.waitA : prio === "B" ? RULES.waitB : 0.25;
    const start = () => Math.ceil((opts.at ?? this.earliest(role, t0, prio)) * 100 - 1e-6) / 100; // plan times are in 10 ms
    let t = start();
    // a fill-in line gives way to anything that is not open play
    if (t - t0 > wait && prio !== "C" && opts.at === undefined) { this.cutFill(t0); t = start(); }
    // a priority call that would come too late cuts the play-by-play's own line instead (a card during a pass call)
    if (t - t0 > wait && opts.cut && role === "pbp" && opts.at === undefined) { this.cut("pbp", t0); t = start(); }
    if (t - t0 > wait && opts.at === undefined) return null;
    if (this.blocked(t, r.dur)) return null;
    return this.emit({ t, voice: role, kind, ...r, event_id: slots.event_id ?? null, ...(opts.cont ? { cont: true } : {}) }, role);
  }

  emit(item, role) {
    const { names, factIds, variant, ...rest } = item;
    const k = `${role}|${item.kind}`;
    this.recent.set(k, [variant, ...(this.recent.get(k) ?? [])].slice(0, 4));
    const out = { ...rest, fact_ids: factIds, names };
    this.plan.push(out);
    this.out.push(out);
    this.end[role] = out.t + out.dur;
    this.sec[role] += out.dur;
    const u = this.rand();
    this.gap[role] = RULES.gapMin + (RULES.gapMax - RULES.gapMin) * u * u; // mean near 2 s (A2)
    for (const n of names) this.said.set(n, out.t);
    for (const f of factIds) this.used.add(f);
    if (role === "co") this.coLast = out.t;
    if (role === "co") this.coNext = out.t + RULES.coCooldown[0] + (RULES.coCooldown[1] - RULES.coCooldown[0]) * this.rand();
    return out;
  }

  crowd(kind, t, until) {
    const it = { t: Math.round(t * 100) / 100, voice: "crowd", kind, text: kind, clips: [{ key: `crowd|${kind}`, off: 0, dur: 0 }],
      dur: 0, event_id: null, fact_ids: [], names: [] };
    if (until !== undefined) it.until = until;
    this.plan.push(it);
    this.out.push(it);
    return it;
  }

  /** A priority event cuts the co mid-sentence (C5). */
  cutCo(t) {
    this.cut("co", t);
    this.pending = this.pending.filter((p) => p.role !== "co");
  }

  cutFill(t) {
    for (const it of this.plan) {
      if (it.fill && it.t + it.dur > t && (it.until ?? Infinity) > t) {
        it.until = Math.max(it.t, Math.round(t * 100) / 100);
        this.end[it.voice] = it.until;
      }
    }
  }

  cut(voice, t) {
    for (const it of this.plan) {
      if (it.voice === voice && it.t + it.dur > t && (it.until ?? Infinity) > t) {
        it.until = Math.max(it.t, Math.round(t * 100) / 100);
        this.end[voice] = it.until;
      }
    }
  }

  later(at, until, role, run, keep = false) { this.pending.push({ at, until, role, run, keep }); }

  idle(t) { return t >= this.end.pbp + this.gap.pbp && t >= this.end.co + RULES.handover[1]; }

  // --- inputs --------------------------------------------------------------------------------------------------

  step(input) {
    this.out = [];
    const t = input.ts;
    if (input.type === "fact") this.addFact(input.fact);
    else if (input.type === "studio") this.studio(t, input.d);
    else if (input.type === "period_end") this.periodEnd(t, input.period);
    else if (input.type === "event") this.event(input.event);
    else if (input.type === "tick") this.tick(t);
    return this.out;
  }

  studio(t, d) {
    // A7: the studio voice has priority: booth lines stop, the queue clears, the booth resumes on a fresh event
    for (const it of this.plan) {
      if (it.voice !== "crowd" && it.t + it.dur > t && (it.until ?? Infinity) > t) it.until = Math.max(it.t, t);
    }
    this.end.pbp = Math.min(this.end.pbp, t); this.end.co = Math.min(this.end.co, t);
    // two clips at once: voice.js plays one after the other, so the block covers the longer stretch
    if (t >= this.blockUntil) this.blockFrom = t;
    this.blockUntil = Math.max(this.blockUntil, t + d + RULES.studioAfter);
    this.pending = this.pending.filter((p) => p.keep);
    this.needFresh = true;
  }

  periodEnd(t, period) {
    this.crowd("whistle", t);
    if (this.anticipation) { this.anticipation.until = t; this.anticipation = null; }
    const full = period === 2;
    this.inBreak = true;
    this.say("pbp", [full ? "full_time" : "half_time"], {}, t + RULES.react, "A");
    // the break exchange (C, exchange 11) waits for the studio recap, if one plays
    const run = (now) => {
      const best = this.bestPassing();
      const q = this.say("pbp", [full ? "full_time_q" : "half_time_q"], {}, now, "A", { at: now });
      if (!q) return;
      const c1 = this.say("co", [full ? "full_time" : "half_time"], { team: best?.team_id, facts: { pass_accuracy: best } },
        q.t + q.dur + RULES.handover[0], "A", { at: q.t + q.dur + RULES.handover[0] });
      const top = this.topRunner();
      if (!full && c1 && top) this.say("co", ["half_time_runner"], { player: top.player_id, facts: { distance_covered: top } }, c1.t + c1.dur + RULES.sentence, "A",
        { at: c1.t + c1.dur + RULES.sentence, cont: true });
      this.breakUntil = this.end.co;
    };
    this.later(t + 1, t + 40, "pbp", run, true);
  }

  bestPassing() {
    const fs = this.meta.teams.map((tm) => this.latest.get(`pass_accuracy|${tm.team_id}`)).filter((f) => f && !f.player_id);
    return fs.sort((a, b) => b.value - a.value)[0] ?? null;
  }

  topRunner() {
    const fs = this.facts.filter((f) => f.kind === "distance_covered" && f.player_id);
    const at = Math.max(...fs.map((f) => f.ts));
    return fs.filter((f) => f.ts === at).sort((a, b) => b.value - a.value)[0] ?? null;
  }

  event(e) {
    const t = e.ts, type = e.type_name, res = e.result_name;
    if (e.period !== this.period) {
      this.period = e.period;
      this.inBreak = false;
      this.crowd("whistle", t);
      this.say("pbp", [e.period === 1 ? "kickoff" : "kickoff2"], { team: this.home, team2: this.other[this.home] },
        Math.max(t + RULES.react, this.breakUntil ?? 0), "A", { at: Math.max(t + RULES.react, (this.breakUntil ?? 0) + 0.5, this.earliest("pbp", t, "A")) });   // never over "That's half-time"
    }
    this.possession(e);
    // the ball's own sound on every kick, before any rule that keeps the voices quiet: a shot is a strike
    if (KICKED.has(type)) this.crowd(type.startsWith("shot") ? "strike" : "kick", t);
    const slots = { player: e.player_id, receiver: e.related_player_id, team: e.team_id, event_id: e.event_id };
    const prio = (type === "shot" || type === "shot_freekick" || type === "keeper_save" ||
      (type === "foul" && res !== "fail")) ? "A"
      : (type === "foul" || type.startsWith("corner") || type === "freekick_crossed" || res === "offside") ? "B" : "C";
    if (prio !== "C") this.lastAB = t;
    if (this.needFresh) {
      // a fresh A or B event resumes the booth; open play does too once 8 s have passed, or it would stay quiet for minutes
      if (t < this.blockUntil || prio === "C" && t < this.blockUntil + RULES.lullS) { this.last = e; return; }
      this.needFresh = false;
    }
    const at = t + RULES.react;
    if (type === "shot" || type === "shot_freekick") this.shot(e, slots, at);
    else if (type === "keeper_save") this.save(e, at);
    else if (type === "foul") this.foul(e, slots, at);
    else if (res === "offside") {
      this.stoppage = t;
      this.say("pbp", ["pass_offside"], slots, at, "B");
      const line = this.latest.get(`line_height|${this.other[e.team_id]}`);
      if (line && line.value >= RULES.highLine) this.later(t + 1, t + RULES.stoppageS, "co", (now) =>
        this.say("co", ["high_line"], { team: this.other[e.team_id], facts: { line_height: line } }, now, "B"));
    } else if (type.startsWith("corner")) {
      this.stoppage = t;
      this.say("pbp", [type], slots, at, "B");
    } else if (type === "freekick_crossed") this.say("pbp", ["freekick_crossed"], slots, at, "B");
    else this.open(e, slots, at);
    this.last = e;
  }

  possession(e) {
    const prev = this.last, t = e.ts;
    const ok = e.result_name === "success" && e.end_x !== null;
    const same = prev && prev.team_id === e.team_id;
    // B: anticipation while one side strings successful events into the last 30 m; it fades on a turnover
    if (this.anticipation && (!same || e.type_name.startsWith("shot"))) {
      this.anticipation.until = Math.round(t * 100) / 100;
      this.anticipation = null;
    }
    const deep = this.attacksUp(e.team_id) ? e.end_x > 75 : e.end_x < 30;
    if (!this.anticipation && ok && same && deep && !e.type_name.startsWith("shot") && t >= this.holdUntil) {
      this.anticipation = this.crowd("anticipation", t);
    }
  }

  shot(e, slots, at) {
    const t = e.ts, dist = this.eventFact(e, "shot_distance"), out = outcome(dist), m = dist?.value ?? 99;
    const head = e.bodypart_name === "head";
    if (e.result_name === "success" || out === "goal") return this.goal(e, slots, at, dist);
    if (out === "wide" || out === "over") {
      if (m <= RULES.oohM) this.crowd("ooh", t + 0.3);
      if (m <= RULES.closeM) {
        const p = this.say("pbp", ["close_miss", "close_miss_noname"], slots, at, "A", { cut: true });
        if (p) this.say("co", ["close_miss"], { facts: { shot_distance: dist } }, p.t + p.dur + RULES.handover[0], "A",
          { at: p.t + p.dur + RULES.handover[0] + (RULES.handover[1] - RULES.handover[0]) * this.rand() });
        return;
      }
      const kinds = e.type_name === "shot_freekick" ? ["shot_freekick", "shot_noname"] : head ? [`shot_${out}_head`, `shot_${out}`] : [`shot_${out}`];
      const p = this.say("pbp", [...kinds, `${out}_noname`], slots, at, "A", { cut: true });
      this.stoppage = t;
      this.followShot(e, p);
      return;
    }
    if (out === "blocked") {
      this.say("pbp", ["shot_blocked", "blocked_noname"], slots, at, "A", { cut: true });
      return;
    }
    // saved: the shot line rises, the keeper_save event finishes it
    if (m <= RULES.oohM) this.crowd("ooh", t + 1.0);
    const kinds = e.type_name === "shot_freekick" ? ["shot_freekick"] : head ? ["shot_saved_head", "shot_saved"] : ["shot_saved"];
    this.shotLine = this.say("pbp", [...kinds, "shot_noname"], slots, at, "A", { cut: true });
    this.shotEvent = e;
  }

  save(e, at) {
    const shot = this.shotEvent && e.ts - this.shotEvent.ts < 3 ? this.shotEvent : null;
    const line = this.shotLine && shot ? this.shotLine : null;
    const slots = { keeper: e.player_id, team: e.team_id, event_id: e.event_id };
    const start = line ? Math.max(at, line.t + line.dur + 0.12) : at;
    const p = this.say("pbp", ["keeper_save", "save_noname"], slots, start, "A", line ? { at: start, cont: true } : {});
    this.stoppage = e.ts;
    this.followShot(shot ?? e, p);
    this.shotLine = this.shotEvent = null;
  }

  /** C2: after a shot that ends play, the co may come in once play stops. */
  followShot(e, p) {
    const t = e.ts;
    this.later(t + 1, t + RULES.stoppageS, "co", (now) => {
      const speed = this.eventFact(e, "shot_speed");
      if (speed && speed.value >= RULES.hardKmh && speed.ts <= now) {
        return this.say("co", ["hard_shot"], { facts: { shot_speed: speed } }, now, "B");
      }
      if (this.rand() < RULES.coStoppageP) return this.say("co", [p?.kind?.startsWith("keeper") || p?.kind === "save_noname" ? "save" : "near_miss"], {}, now, "B");
      return true; // decided: no co line
    });
  }

  goal(e, slots, at, dist) {
    const t = e.ts;
    if (this.anticipation) { this.anticipation.until = t; this.anticipation = null; }
    this.goalEvent = e;
    this.crowd("roar", t);
    const call = this.say("pbp", ["goal", "goal_noname"], slots, at, "A", { cut: true });
    this.holdUntil = (call?.t ?? t) + RULES.hold[0] + (RULES.hold[1] - RULES.hold[0]) * this.rand();
    this.pending = this.pending.filter((p) => p.keep);
    const scorer = e.player_id;
    this.later(this.holdUntil, this.holdUntil + 20, "pbp", (now) => {
      const speed = this.eventFact(e, "shot_speed");
      const sprint = this.facts.find((f) => f.kind === "sprint_speed" && f.player_id === scorer && f.ts <= now
        && f.ts >= t - 15 && f.value >= RULES.sprintKmh);
      const [pk, ck, facts] = dist && dist.value >= RULES.longGoalM ? ["long_goal", "long_goal", { shot_distance: dist }]
        : sprint ? ["sprint_goal", "sprint_goal", { sprint_speed: sprint }]
          : ["after_goal", "goal", { shot_distance: dist, shot_speed: speed?.ts <= now ? speed : undefined }];
      const p = this.say("pbp", [pk, "after_goal"], { ...slots, said: false }, now, "A", { at: now });
      if (!p) return null;
      const h = p.t + p.dur + RULES.handover[0] + (RULES.handover[1] - RULES.handover[0]) * this.rand();
      this.say("co", [ck], { facts }, h, "A", { at: h });
      return p;
    }); // a studio clip in the hold drops it: the clip already told the scorer, the speed and the score
  }

  foul(e, slots, at) {
    const t = e.ts;
    this.stoppage = t;
    this.crowd("whistle", t);
    if (e.result_name === "yellow_card" || e.result_name === "red_card") {
      const p = this.say("pbp", [e.result_name], slots, at, "A", { cut: true });
      if (p) this.later(t + 1, t + RULES.stoppageS, "co", (now) => this.say("co", ["yellow_card"], {}, now, "B"));
      return;
    }
    this.say("pbp", ["foul", "foul_noname"], { ...slots, team: this.other[e.team_id] }, at, "B"); // the free kick's team
  }

  open(e, slots, at) {
    const t = e.ts, type = e.type_name, res = e.result_name;
    if (!this.idle(at) || at < this.chainUntil || this.blocked(at, 0)) return;
    let kinds = null;
    if (type === "pass" && res === "success" && e.related_player_id) {
      const dist = this.eventFact(e, "pass_distance");
      const long = dist && dist.value >= RULES.longPassM;
      const back = this.attacksUp(e.team_id) ? e.end_x < e.start_x - 8 : e.end_x > e.start_x + 8;
      // every pass names its receiver, own half included (the owner's rule over A4's final third)
      kinds = long ? ["pass_long", "pass"] : back ? ["back_pass", "pass"] : ["pass"];
    } else if (type === "take_on") kinds = [res === "success" ? "take_on" : "take_on_fail"];
    else if (type === "interception" || type === "tackle") {
      const press = this.latest.get(`press_intensity|${e.team_id}`);
      if (this.inOppHalf(e) && press && press.value >= RULES.press && t >= this.coNext - 20) {
        const p = this.say("pbp", ["press"], slots, at, "C");
        if (p) this.say("co", ["press"], { team: e.team_id, facts: { press_intensity: press } }, p.t + p.dur + RULES.handover[0], "B");
        return;
      }
      kinds = [type];
    } else if (type === "cross") kinds = ["cross"];
    else if (type === "clearance" && this.last && ["cross", "shot", "corner_crossed", "freekick_crossed"].includes(this.last.type_name)) kinds = ["clearance"];
    else if (type === "keeper_claim" && this.last?.type_name?.includes("cross")) kinds = ["keeper_claim"], slots.keeper = e.player_id;
    if (!kinds) return;
    const p = this.say("pbp", kinds, slots, at, "C");
    if (p) {
      this.chain = p.t - (this.prevC ?? -1e9) < 6 ? this.chain + 1 : 1;
      this.prevC = p.t + p.dur;
      if (this.chain >= RULES.chainMax) { this.chainUntil = this.prevC + RULES.chainPause; this.chain = 0; }
    }
  }

  tick(t) {
    if (t < this.blockUntil || t < this.holdUntil) return;
    // follow-ups first: the goal exchange, the break, the co after a stoppage
    for (const p of [...this.pending]) {
      if (t < p.at) continue;
      if (t > p.until) { this.pending.splice(this.pending.indexOf(p), 1); continue; }
      if (p.role === "co" ? !this.idle(t) : t < this.end.pbp + RULES.gapMin || t < this.end.co + RULES.handover[0]) continue;
      if (p.role === "co" && this.last && this.inFinalThird(this.last) && t - this.last.ts < 4) continue;
      this.pending.splice(this.pending.indexOf(p), 1);
      if (p.run(t)) return;
    }
    this.coTurn(t);
    if (!this.out.some((it) => it.voice !== "crowd")) this.fill(t);
  }

  coTurn(t) {
    // C1: the co's share of the speech steers how often it comes in on its own
    const share = this.sec.co / Math.max(1, this.sec.pbp + this.sec.co);
    const low = share < RULES.coShare[0], high = share > RULES.coShare[1];
    if (!this.idle(t) || t < (low ? (this.coLast ?? -1e9) + RULES.coCooldownLow : this.coNext) || t < (this.breakUntil ?? 0)) return;
    if (this.last && this.inFinalThird(this.last) && t - this.last.ts < 6) return; // C2: never in the final third
    const quiet = t - this.lastAB >= RULES.lullS && this.last && t - this.last.ts < 6;
    const stopped = t - this.stoppage < RULES.stoppageS;
    if (!quiet && !stopped) return;
    if (quiet && this.lull(t)) return;
    const p = low ? 1 : high ? 0 : RULES.coStoppageP / 2;
    if ((stopped && t - this.stoppage > 2 || quiet && low) && this.rand() < p) this.say("co", ["stoppage"], {}, t, "C");
  }

  /** C2: in a lull the co may use a fresh fact: momentum, a deep block, a formation change, a sprint. */
  lull(t) {
    const fresh = (f) => f && !this.used.has(f.fact_id) && t - f.ts < 120 && f.ts <= t;
    for (const tm of this.meta.teams.map((x) => x.team_id)) {
      const mo = this.latest.get(`momentum|${tm}`);
      if (fresh(mo) && mo.value >= RULES.momentum) {
        const p = this.say("pbp", ["momentum"], { team: tm }, t, "C", { at: t });
        if (p) this.say("co", ["momentum"], { team: tm, facts: { momentum: mo } }, p.t + p.dur + RULES.handover[0], "B",
          { at: p.t + p.dur + RULES.handover[0] + 0.2 });
        this.used.add(mo.fact_id);
        return true;
      }
    }
    const team = this.last?.team_id, opp = this.other[team];
    const line = this.latest.get(`line_height|${opp}`);
    if (team && fresh(line) && line.value <= RULES.deepLine) {
      const p = this.say("pbp", ["deep_block"], { team }, t, "C", { at: t });
      if (p) this.say("co", ["deep_block"], { team, team2: opp, facts: { line_height: line } }, p.t + p.dur + RULES.handover[0], "B");
      this.used.add(line.fact_id);
      return true;
    }
    for (const tm of this.meta.teams.map((x) => x.team_id)) {
      const f = this.latest.get(`formation|${tm}`);
      const prev = this.facts.filter((x) => x.kind === "formation" && x.team_id === tm && x.ts < f?.ts).at(-1);
      if (fresh(f) && prev && prev.value !== f.value) {
        const p = this.say("pbp", ["formation"], { team: tm }, t, "C", { at: t });
        if (p) this.say("co", ["formation"], { facts: { formation: f } }, p.t + p.dur + RULES.handover[0], "B");
        this.used.add(f.fact_id);
        return true;
      }
    }
    const sprint = this.facts.findLast((f) => f.kind === "sprint_speed" && f.value >= RULES.sprintKmh);
    if (fresh(sprint) && t - sprint.ts < 20) {
      this.used.add(sprint.fact_id);
      return Boolean(this.say("co", ["sprint"], { player: sprint.player_id, facts: { sprint_speed: sprint } }, t, "C"));
    }
    return false;
  }

  /** Who has the ball after event e, as far as the booth can tell: [team, player or null]. */
  holder(e) {
    if (e.result_name === "fail" || e.result_name === "offside") return [this.other[e.team_id], null];
    return [e.team_id, e.type_name === "pass" ? e.related_player_id : e.player_id];
  }

  /** The owner's rule over A6: outside the goal hold, a studio clip and the breaks, the booth is never silent over
   * 6 s. In play a possession or build-up line, or a co opinion; in a dead ball the restart, a pause line or the co;
   * after a goal the celebration, then the kick-off. The co comes in while it is under its share (C3), never in the
   * final third (C2). */
  fill(t) {
    const e = this.last;
    if (!e || !this.period || this.inBreak || t < this.blockUntil || t < this.holdUntil) return;
    if (t - Math.max(this.end.pbp, this.end.co) < RULES.fillS) return;
    const since = t - e.ts, at = { at: t };
    const share = this.sec.co / Math.max(1, this.sec.pbp + this.sec.co);
    const coBarred = this.inFinalThird(e) && since < 6;
    // the kinds in a random order, the one this voice filled with last at the end: no kind twice in a row
    const order = (role, kinds) => {
      const ks = kinds.map((k) => [k, this.rand()]).sort((a, b) => a[1] - b[1]).map(([k]) => k);
      return [...ks.filter((k) => k !== this.lastFill?.[role]), ...ks.filter((k) => k === this.lastFill?.[role])];
    };
    const say = (role, kinds, slots) => {
      const r = this.say(role, order(role, kinds), slots, t, "C", at);
      if (r) { (this.lastFill ??= {})[role] = r.kind; r.fill = true; }
      return r;
    };
    let pbp, co;
    if (e === this.goalEvent) {
      const late = since > RULES.kickoffWaitS;
      pbp = () => say("pbp", [late ? "kickoff_wait" : "celebrate", "stoppage"], { team: late ? this.other[e.team_id] : e.team_id });
      co = () => say("co", ["goal_opinion", "lull"], {});
    } else if (this.dead(e, since)) {
      // whoever did not touch it last restarts (a throw-in, a goal kick, a free kick, a corner): said first
      const first = this.restartFor !== e;
      pbp = () => {
        const r = say("pbp", first ? ["restart"] : ["stoppage", "restart"], { team: this.other[e.team_id] });
        if (r) this.restartFor = e;
        return r;
      };
      co = () => this.lull(t) || say("co", ["lull", "stoppage"], {});
    } else {
      const [team, player] = this.holder(e);
      pbp = () => say("pbp", ["build_up", "possession"], { team, player });
      co = () => this.lull(t) || say("co", ["lull"], {});
    }
    const coSafe = () => (coBarred ? null : co());
    const r = share < (RULES.coShare[0] + RULES.coShare[1]) / 2 ? coSafe() || pbp() : pbp() || coSafe();
    if (r) this.needFresh = false;
  }

  /** The ball is out of play after e: a foul, an offside, a shot or a save that ends play, a ball that ends off the
   * pitch, or nothing has happened for deadS. */
  dead(e, since) {
    const off = e.end_x !== null && e.end_x !== undefined && (e.end_x <= 0.5 || e.end_x >= 104.5 || e.end_y <= 0.5 || e.end_y >= 67.5);
    return since > RULES.deadS || off || this.stoppage === e.ts && !e.type_name.startsWith("corner");
  }
}

/** The input stream of a replay: facts, events, studio clips, period ends and a tick every second, in time order. */
export function inputs({ events, facts, studio = [], meta, tick = 1 }) {
  const order = { fact: 0, period_end: 1, studio: 2, event: 3, tick: 4 };
  const p1 = meta.period1_s, end = meta.period1_s + meta.period2_s;
  const out = [
    ...facts.map((f) => ({ type: "fact", ts: f.ts, fact: f })),
    ...events.map((e) => ({ type: "event", ts: e.ts, event: e })),
    ...studio.map((s) => ({ type: "studio", ts: s.ts, d: s.d })),
    { type: "period_end", ts: p1, period: 1 }, { type: "period_end", ts: end, period: 2 },
  ];
  for (let t = 0; t <= end + 30; t += tick) out.push({ type: "tick", ts: t });
  return out.sort((a, b) => a.ts - b.ts || order[a.type] - order[b.type]);
}

/** A whole replay through step(): the same plan a live match would get, input by input. */
export function planMatch(opts, stream) {
  const b = new Booth(opts);
  for (const input of stream) b.step(input);
  return b.plan;
}

/** Speech totals of a plan: seconds per voice actually played and the co's share of booth speech. */
export function shares(plan) {
  const sec = { pbp: 0, co: 0 };
  for (const it of plan) if (it.voice !== "crowd") sec[it.voice] += Math.max(0, Math.min(it.t + it.dur, it.until ?? Infinity) - it.t);
  return { ...sec, coShare: sec.co / Math.max(1e-9, sec.pbp + sec.co) };
}

/** The booth's silences outside the exceptions (before kick-off, the goal hold, a studio clip and its 1.5 s,
 * half-time, after full-time), longest first: [{from, to}] in match seconds. */
export function silences(plan, studio, meta) {
  const sp = plan.filter((it) => it.voice !== "crowd" && (it.until ?? Infinity) > it.t).sort((a, b) => a.t - b.t);
  const end = (it) => Math.min(it.t + it.dur, it.until ?? Infinity);
  const p1 = meta.period1_s, ko2 = sp.find((it) => it.t >= p1 && it.kind === "kickoff2")?.t ?? p1;
  const ex = [[-Infinity, sp[0]?.t ?? Infinity], [p1, ko2], [p1 + meta.period2_s, Infinity],
    ...studio.map((s) => [s.ts, s.ts + s.d + RULES.studioAfter]),
    ...sp.filter((it) => it.voice === "pbp" && it.kind.startsWith("goal")).map((g) => [g.t, g.t + RULES.hold[1]])]
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  let reach = -Infinity;
  for (let i = 0; i <= sp.length; i++) {
    const a = reach, b = sp[i]?.t ?? Infinity;
    if (i < sp.length) reach = Math.max(reach, end(sp[i]));
    if (!(b > a)) continue;
    let cur = a;
    for (const [x0, x1] of ex) {
      if (x1 <= cur || x0 >= b) continue;
      if (x0 > cur) out.push({ from: cur, to: x0 });
      cur = Math.max(cur, x1);
    }
    if (b > cur) out.push({ from: cur, to: b });
  }
  return out.filter((s) => Number.isFinite(s.to - s.from)).sort((x, y) => (y.to - y.from) - (x.to - x.from));
}

/** The studio inputs for a replay: each voiced why_card once, with its clip's length. */
export function studioInputs(cues, voiceRows, lang, audience) {
  const dur = new Map(voiceRows.filter((r) => r.lang === lang).map((r) => [r.story_id, r.duration_s]));
  const seen = new Set(), out = [];
  for (const c of cues) {
    if (c.graphic !== "why_card" || c.lang !== lang || (audience && c.audience !== audience) || !dur.has(c.story_id) || seen.has(c.story_id)) continue;
    seen.add(c.story_id);
    out.push({ ts: c.ts, d: dur.get(c.story_id), story_id: c.story_id });
  }
  return out.sort((a, b) => a.ts - b.ts);
}
