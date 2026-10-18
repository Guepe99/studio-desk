// Loads a replay export (docs/CONTRACT.md, "Replay export") and answers time questions about it.

const GOAL_SHOTS = new Set(["shot", "shot_freekick", "shot_penalty"]);

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

export async function loadMatch(base) {
  const [meta, events, facts, cues, buf] = await Promise.all([
    getJson(`${base}/meta.json`), getJson(`${base}/events.json`), getJson(`${base}/facts.json`),
    getJson(`${base}/cues.json`),
    fetch(`${base}/tracking.f32`).then((r) => {
      if (!r.ok) throw new Error(`${base}/tracking.f32: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  // shortcut: Float32Array reads in platform byte order; every browser platform we target is little-endian.
  const pos = new Float32Array(buf);
  const n = meta.entities.length;
  if (pos.length !== meta.frames * n * 3) {
    throw new Error(`tracking.f32 has ${pos.length} floats, expected ${meta.frames} x ${n} x 3`);
  }
  return new Match(meta, events, facts, cues, pos);
}

export class Match {
  constructor(meta, events, facts, cues, pos) {
    Object.assign(this, { meta, events, facts, cues, pos });
    this.n = meta.entities.length;
    this.duration = meta.period1_s + meta.period2_s;
    this.home = meta.teams.find((t) => t.side === "home");
    this.away = meta.teams.find((t) => t.side === "away");
    this.players = Object.fromEntries(meta.players.map((p) => [p.player_id, p]));
    this.teams = Object.fromEntries(meta.teams.map((t) => [t.team_id, t]));
    this.index = Object.fromEntries(meta.entities.map((e, i) => [e, i]));
    // Goals as [ts, scoring team_id]; an own goal counts for the other team.
    this.goals = events.flatMap((e) => {
      if (GOAL_SHOTS.has(e.type_name) && e.result_name === "success") return [[e.ts, e.team_id]];
      if (e.result_name === "owngoal") return [[e.ts, e.team_id === this.home.team_id ? this.away.team_id : this.home.team_id]];
      return [];
    });
  }

  clock(ts) {
    const period = ts < this.meta.period1_s ? 1 : 2;
    const t = period === 1 ? ts : ts - this.meta.period1_s;
    return { period, t, minute: Math.floor(t / 60) + (period === 2 ? 45 : 0) + 1 };
  }

  score(ts) {
    let h = 0, a = 0;
    for (const [g, team] of this.goals) {
      if (g > ts) continue;
      if (team === this.home.team_id) h++; else a++;
    }
    return [h, a];
  }

  // Entity i at time ts, interpolated between the two nearest frames. null when off the pitch.
  at(i, ts) {
    const f = Math.min(Math.max(ts * this.meta.fps, 0), this.meta.frames - 1);
    const f0 = Math.floor(f), f1 = Math.min(f0 + 1, this.meta.frames - 1), a = f - f0;
    const p = this.pos, o0 = (f0 * this.n + i) * 3, o1 = (f1 * this.n + i) * 3;
    if (Number.isNaN(p[o0]) || Number.isNaN(p[o1])) return null;
    return [p[o0] + (p[o1] - p[o0]) * a, p[o0 + 1] + (p[o1 + 1] - p[o0 + 1]) * a, p[o0 + 2] + (p[o1 + 2] - p[o0 + 2]) * a];
  }
}
