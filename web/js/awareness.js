// Awareness for the 3D view: where each player looks, how his body faces the play, how his legs
// move (forward, backpedal, strafe, jockey) and his emotions after goals, near misses and fouls.
// A visual layer only, like ball3d.js: positions stay the tracking's. Pure logic, runs in Node
// (tests/web/awareness.test.mjs); the Babylon side is awareness-rig.js. Rules and sources:
// docs/awareness3d.md (rule numbers R1..R16 below refer to it).
//
//   const aw = new Awareness(match, [ts0, ts1], { ball });   ball(ts) -> {x, y, h} (default: tracking ball)
//   aw.pose(i, ts) -> {yaw, yawW, mode, emotion} | null    a scene driver (priority 10, players.js)
//   aw.look(i, ts) -> {yaw, pitch} | null                   head target, yaw = atan2(dx, dy), pitch > 0 down
//   aw.emotions    -> [{i, kind, clip, t0, dur, prio, src, face?}]   from events and facts only
//
// Everything is planned once on a 0.05 s grid with causal smoothing, so pose() and look() are pure
// functions of (i, ts) and a seek, a replay or a video frame always shows the same thing.

export const STEP = 0.05;
const D = Math.PI / 180;
const EYE_H = 1.65;
// R1 neck range: 70 deg each side, the upper spine adds 20; pitch 40 down, 30 up
export const HEAD_YAW_MAX = 90 * D, PITCH_DOWN = 40 * D, PITCH_UP = 30 * D;
const TAU_HEAD = 0.1, TAU_BODY = 0.25;           // R2 head spring, R6 body turn
const HEAD_SPEED = 400 * D;                      // R2 rad/s, the head's top turn speed
const MODE_HOLD = 0.5;                           // R6 s, a gait is kept at least this long
const REACT = 0.18, REACT_JITTER = 0.05;         // R3 the head follows the ball 180 +- 50 ms late
const SCAN_RATE = { GK: 0, DF: 0.44, MF: 0.6, FW: 0.3 }, SCAN_LEN = 0.35;   // R4 scans per second
const NEAR = 15, FAR = 25;                       // R5 defenders face the ball inside 15 m, none past 25
const BACKPEDAL_MAX = 4.5;                       // R7 faster than this backwards: turn and run
const JOCKEY_D = 3.5, JOCKEY_V = 3.5, SIDE_ON = 35 * D;   // R8 the closing defender goes side-on
const OPEN_MAX = 45 * D;                         // R9 receivers keep the ball within 45 deg of the chest
// m between two bodies' centres after a goal: team-mates' shoulders touch, never merge; an
// opponent keeps out of reach of a celebrating arm
const APART = { mate: 0.9, rival: 1.5 };
const BODY_GAP = 1.0;   // m from any point of a body lying on the grass (the beaten keeper)
// the nearest team-mate (within reach m) sprints over to the scorer from `lead` s before the goal:
// his own path plus an offset that brings him `beside` m from the scorer, at `speed` m/s over the
// track (eased in and out over `ease` s), held until `hold` s after the goal, eased back over `back` s
const JOIN = { reach: 30, lead: 0.3, beside: 1, speed: 7.5, ease: 0.4, hold: 8, back: 4 };
// share 0..1 of a move over u = 0..1 that speeds up over the first a, slows down over the last a
export function trapezoid(u, a) {
  u = clamp(u, 0, 1);
  const v = 1 / (1 - a);
  return u < a ? 0.5 * v * u * u / a : u < 1 - a ? v * (u - a / 2) : 1 - 0.5 * v * (1 - u) ** 2 / a;
}
// R10..R16: emotions. Clip lengths in seconds (the SD_ clips are built by awareness-rig.js).
export const CLIPS = { SD_ArmsUp: 1.0, SD_Clap: 0.6, SD_HandsOnHead: 2.0, SD_HandsOnHips: 2.0, SD_Dejected: 2.0,
  SD_Appeal: 1.2, SD_Palms: 1.5, SD_ArmUp: 1.0, SD_Point: 2.0, Yes: 2.5, Idle_No_Loop: 2.5 };
const ONCE = new Set(["Idle_No_Loop"]);
// With the retargeted motion clips (docs/motion3d.md) each stand-in becomes a real clip, picked
// per player and event among the variants the clip file has. Key: "<kind>:<clip>", then "<clip>".
const MOTION = {
  // the scorer: arms out or up first (they read on a running body), the knee slide last
  "celebrate:SD_ArmsUp": ["M_celeb_arms_wide", "M_celeb_arms_up", "M_celeb_jump_fist", "M_celeb_knee_slide"],
  "join:SD_ArmsUp": ["M_join_hug", "M_join_high_five", "M_celeb_jump_fist", "M_celeb_arms_up"],
  SD_Clap: ["M_clap"], SD_HandsOnHead: ["M_hands_on_head"], SD_HandsOnHips: ["M_dejected_hips"],
  SD_Dejected: ["M_crouch_head_down"], SD_Appeal: ["M_appeal_arms_out"], SD_Palms: ["M_palms_shrug"],
  "call:SD_ArmUp": ["M_call_ball"], "appeal:SD_ArmUp": ["M_point_forward", "M_call_ball"], SD_Point: ["M_keeper_organise"],
};
const PRIO = { celebrate: 6, join: 5, dejected: 5, near_miss: 4, appeal: 3, protest: 3, call: 2, organise: 1 };
const MODES = ["forward", "backpedal", "strafe", "jockey"];
const KICKS = new Set(["pass", "cross", "freekick_crossed", "freekick_short", "corner_crossed", "corner_short", "goalkick", "throw_in"]);
const SET_PIECES = new Set(["freekick_crossed", "freekick_short", "corner_crossed", "corner_short", "shot_freekick"]);

const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function hash(s, n = 0) {
  let h = 2166136261 ^ n;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

export class Awareness {
  // motion: the clips.json of web/vendor/motion (null keeps the procedural SD_ stand-ins)
  constructor(match, span = [0, match.duration], { ball, motion = null } = {}) {
    this.match = match;
    this.motion = motion;
    const m = match;
    this.ball = ball ?? ((ts) => { const b = m.at(0, ts); return b && { x: b[0], y: b[1], h: Math.max(0, b[2]) }; });
    this.ents = m.meta.entities;
    this.team = this.ents.map((p, i) => (i === 0 ? null : p.split("-")[0]));   // player_id is <team_id>-<shirt>
    this.role = this.ents.map((p) => m.players[p]?.position ?? "MF");
    this.home = m.home.team_id;
    this.events = [...m.events].sort((a, b) => a.ts - b.ts);
    this.joins = [];   // team-mates running to a scorer: {i, si, t0, T, t1, side}
    this.bodyOf = null;   // (i, ts) -> [[x, y, w?], ...] points of a body lying on the grass (w: 0..1 going down), or null (keeper3d-rig.js)
    this.emotions = this._emotions();
    // after a goal the players bunch round the scorer: bodies are kept apart then (see _apart)
    this.apart = m.goals.map((g) => [g.ts, g.ts + 14]);
    this.byPlayer = new Map();
    for (const e of this.emotions) (this.byPlayer.get(e.i) ?? this.byPlayer.set(e.i, []).get(e.i)).push(e);
    this.receives = this._receives();
    this.T0 = Math.max(0, span[0] - 10);
    this.K = Math.ceil((Math.min(m.duration, span[1] + 1) - this.T0) / STEP) + 1;
    this._plan();
  }

  // own goal x of a team at ts (contract: home attacks x = 105 in period 1)
  goalX(team, ts) {
    const p2 = ts > this.match.meta.period1_s;
    return (team === this.home) !== p2 ? 0 : 105;
  }

  // ------------------------------------------------------------------ emotions (R10..R16)
  _emotions() {
    const m = this.match, out = [];
    const idx = (pid) => (pid && m.index[pid] !== undefined ? m.index[pid] : null);
    const add = (pid, kind, clip, t0, dur, src, extra = {}) => {
      const i = idx(pid);
      if (i === null || !m.at(i, t0)) return;
      const opts = this.motion && (MOTION[`${kind}:${clip}`] ?? MOTION[clip])?.filter((c) => this.motion.clips[c]);
      if (opts?.length) {
        // a one-shot clip covers its own length; a longer window chains the next variants
        // a scorer opens with arms out wide, which no one reads as anything but joy (hands raised to
        // the head can read as despair); the other variants follow
        let k = kind === "celebrate" ? 0 : Math.floor(hash(pid, Math.round(t0 * 10)) * opts.length), t = t0;
        while (t < t0 + dur - 0.5) {
          const c = opts[k++ % opts.length], mc = this.motion.clips[c];
          const d = mc.loop ? t0 + dur - t : Math.min(mc.len, t0 + dur - t);
          out.push({ i, kind, clip: c, t0: t, dur: d, prio: PRIO[kind], src, ...extra });
          t += d;
          if (opts.length === 1 && !mc.loop) break;
        }
        return;
      }
      out.push({ i, kind, clip, t0, dur, prio: PRIO[kind], src, ...extra });
    };
    const onPitch = (team, ts) => this.ents.map((p, i) => i).filter((i) => i > 0 && this.team[i] === team && m.at(i, ts));
    const dist = (i, j, ts) => { const a = m.at(i, ts), b = m.at(j, ts); return Math.hypot(a[0] - b[0], a[1] - b[1]); };
    const other = (team) => (team === m.home.team_id ? m.away.team_id : m.home.team_id);
    const gkOf = (team, ts) => onPitch(team, ts).find((i) => this.role[i] === "GK") ?? null;
    const byId = new Map(this.events.map((e) => [e.event_id, e]));

    // R10-R12: goals, from the score facts of the ledger
    for (const f of m.goals) {
      const g = f.ts, ev = (f.source_event_ids ?? []).map((id) => byId.get(id)).find(Boolean);
      const scorer = f.player_id ?? ev?.player_id, si = idx(scorer), src = f.fact_id;
      if (si === null || !m.at(si, g)) continue;
      // the first second decides how a goal reads: the scorer at once, everyone within about 0.5 s
      add(scorer, "celebrate", "SD_ArmsUp", g + 0.15, 9, src);
      // teammates react nearest first, each with one of the three common gestures, facing the scorer
      const mates = onPitch(f.team_id, g).filter((i) => i !== si).sort((a, b) => dist(a, si, g) - dist(b, si, g));
      // the nearest outfield team-mate runs over and joins in on arrival (the tracks part as they
      // run on, so the distance is the larger of now and 2 s on)
      const run = mates.find((i) => this.role[i] !== "GK");
      let arrive = null;
      if (run !== undefined && m.at(run, g - JOIN.lead) && dist(run, si, g) < JOIN.reach) {
        const d = Math.max(dist(run, si, g), m.at(run, g + 2) && m.at(si, g + 2) ? dist(run, si, g + 2) : 0);
        const T = clamp(d / JOIN.speed + JOIN.ease, 1.2, 4), a = m.at(run, g), b = m.at(si, g), n = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
        this.joins.push({ i: run, si, t0: g - JOIN.lead, T, t1: g + JOIN.hold, side: [(a[0] - b[0]) / n * JOIN.beside, (a[1] - b[1]) / n * JOIN.beside] });
        arrive = g - JOIN.lead + T;
      }
      mates.forEach((i, k) => {
        const gk = this.role[i] === "GK", t0 = i === run && arrive !== null ? arrive - 0.2 : g + 0.3 + 0.05 * k;
        add(this.ents[i], "join", gk ? "Yes" : ["SD_ArmsUp", "Yes", "SD_Clap"][k % 3], t0, 8, src, gk ? {} : { face: si });
      });
      // the conceding side: hands on head or hips, arms down, staggered from the goal outwards
      const ct = other(f.team_id), gx = this.goalX(ct, g);
      const down = onPitch(ct, g).sort((a, b) => Math.abs(m.at(a, g)[0] - gx) - Math.abs(m.at(b, g)[0] - gx));
      // neighbours never share a gesture or a beat: the gestures go round in turn from a start
      // picked per goal, each player a little later than the one nearer the goal
      const DOWN = ["SD_HandsOnHead", "SD_HandsOnHips", "SD_Dejected", "SD_Palms"], k0 = Math.floor(hash(src, 3) * DOWN.length);
      let n = 0;
      down.forEach((i, k) => {
        const pid = this.ents[i], u = hash(pid, Math.round(g));
        if (this.role[i] === "GK") {
          add(pid, "dejected", "Idle_No_Loop", g + 0.8, 2.5, src);
          add(pid, "dejected", "SD_HandsOnHips", g + 3.3, 3.5, src);
        } else {
          add(pid, "dejected", DOWN[(k0 + n++) % DOWN.length], g + 0.35 + 0.07 * k + 0.15 * u, 3 + 3 * hash(pid, k + 7), src);
        }
      });
    }

    // R13: near misses: a missed shot that ends by the frame, or a shot the keeper saves
    const shots = this.events.filter((e) => e.type_name.startsWith("shot") && e.result_name !== "success");
    for (const e of shots) {
      const gx = e.end_x < 52.5 ? 0 : 105;
      const saved = this.events.some((s) => s.type_name === "keeper_save" && s.ts >= e.ts && s.ts - e.ts < 2.5);
      const byFrame = Math.abs(e.end_x - gx) < 3 && Math.abs(e.end_y - 34) < 3.66 + 2.5;
      if (!saved && !byFrame) continue;
      const arrive = e.ts + Math.hypot(e.end_x - e.start_x, e.end_y - e.start_y) / 22, src = `event:${e.event_id}`;
      add(e.player_id, "near_miss", "SD_HandsOnHead", arrive + 0.2, 2.5, src);
      const si = idx(e.player_id);
      if (si === null || !m.at(si, arrive)) continue;
      onPitch(e.team_id, arrive).filter((i) => i !== si && this.role[i] !== "GK" && dist(i, si, arrive) < 20)
        .sort((a, b) => dist(a, si, arrive) - dist(b, si, arrive)).slice(0, 2)
        .forEach((i, k) => add(this.ents[i], "near_miss", "SD_HandsOnHead", arrive + 0.4 + 0.2 * k, 2, src));
      const gk = gkOf(other(e.team_id), arrive);
      if (gk !== null) add(this.ents[gk], "organise", "SD_Point", arrive + 1.2, 2.5, src);
    }

    // R14: fouls: the fouled player appeals, the fouler shows his palms, two teammates protest
    for (const e of this.events.filter((x) => x.type_name === "foul")) {
      const src = `event:${e.event_id}`;
      add(e.related_player_id, "appeal", "SD_Appeal", e.ts + 0.4, 1.6, src);
      add(e.player_id, "protest", "SD_Palms", e.ts + 0.5, 1.5, src);
      const vi = idx(e.related_player_id);
      if (vi === null || !m.at(vi, e.ts)) continue;
      onPitch(this.team[vi], e.ts).filter((i) => i !== vi && dist(i, vi, e.ts) < 12)
        .sort((a, b) => dist(a, vi, e.ts) - dist(b, vi, e.ts)).slice(0, 2)
        .forEach((i, k) => add(this.ents[i], "appeal", "SD_ArmUp", e.ts + 0.6 + 0.2 * k, 1.2, src));
    }

    // R15: a player about to receive a long pass calls for it, arm up, until it is struck
    for (let k = 0; k + 1 < this.events.length; k++) {
      const e = this.events[k], n = this.events[k + 1];
      if (!KICKS.has(e.type_name) || n.team_id !== e.team_id || n.player_id === e.player_id || n.period !== e.period) continue;
      if (Math.hypot(e.end_x - e.start_x, e.end_y - e.start_y) < 15) continue;
      add(n.player_id, "call", "SD_ArmUp", e.ts - 1.2, 1.3, `event:${e.event_id}`);
    }

    // R16: the keeper organises his defence before a set piece against him
    for (const e of this.events.filter((x) => SET_PIECES.has(x.type_name))) {
      const gk = gkOf(other(e.team_id), e.ts);
      if (gk !== null) add(this.ents[gk], "organise", "SD_Point", e.ts - 4, 3.5, `event:${e.event_id}`);
    }
    return out.sort((a, b) => a.t0 - b.t0);
  }

  // The emotion player i shows at ts (highest priority, then latest), as a driver emotion.
  emotionAt(i, ts) {
    let best = null;
    for (const e of this.byPlayer.get(i) ?? []) {
      if (e.t0 > ts) break;
      if (ts >= e.t0 + e.dur) continue;
      if (!best || e.prio > best.prio || (e.prio === best.prio && e.t0 > best.t0)) best = e;
    }
    return best;
  }

  emotion(i, ts) {
    const e = this.emotionAt(i, ts);
    if (!e) return null;
    const mc = this.motion?.clips[e.clip];
    const u = ts - e.t0, len = mc?.len ?? CLIPS[e.clip] ?? 1, once = mc ? !mc.loop : ONCE.has(e.clip);
    const weight = clamp(Math.min(u / 0.25, (e.dur - u) / 0.4), 0, 1);
    return { clip: e.clip, t: once ? Math.min(u, len) : u % len, weight, upper: true, full: !!mc?.full, kind: e.kind };
  }

  // per player: [from, to] windows while a pass travels to him (no scans then, R4)
  _receives() {
    const out = new Map();
    for (let k = 0; k + 1 < this.events.length; k++) {
      const e = this.events[k], n = this.events[k + 1];
      if (!KICKS.has(e.type_name) || n.team_id !== e.team_id || n.period !== e.period) continue;
      const i = this.match.index[n.player_id];
      if (i !== undefined) (out.get(i) ?? out.set(i, []).get(i)).push([e.ts - 0.3, n.ts]);
    }
    return out;
  }

  _scanning(i, ts) {
    const rate = SCAN_RATE[this.role[i]] ?? 0.44;
    if (!rate) return false;
    const W = 1 / rate, n = Math.floor(ts / W), pid = this.ents[i];
    for (const s of [n, n - 1]) {
      const t0 = s * W + hash(pid, s) * (W - SCAN_LEN), len = SCAN_LEN * (0.75 + 0.5 * hash(pid, s + 99991));
      if (ts >= t0 && ts < t0 + len) return (this.receives.get(i) ?? []).every(([a, b]) => ts < a || ts > b);
    }
    return false;
  }

  // ------------------------------------------------------------------ the plan (R1..R9)
  _plan() {
    const m = this.match, N = this.ents.length, K = this.K;
    this.fy = new Float32Array(K * N); this.fw = new Float32Array(K * N);
    this.hy = new Float32Array(K * N); this.hp = new Float32Array(K * N);
    this.mode = new Uint8Array(K * N); this.live = new Uint8Array(K * N);
    const aB = 1 - Math.exp(-STEP / TAU_BODY), aH = 1 - Math.exp(-STEP / TAU_HEAD);
    const sy = new Float64Array(N), sw = new Float64Array(N), shy = new Float64Array(N), shp = new Float64Array(N);
    const started = new Uint8Array(N), lastMode = new Uint8Array(N), hold = new Float64Array(N);
    const react = this.ents.map((p) => REACT + REACT_JITTER * (2 * hash(p, 3) - 1));
    let ev = 0;
    for (let k = 0; k < K; k++) {
      const t = this.T0 + k * STEP;
      const b = this.ball(t);
      const pos = [], vel = [];
      for (let i = 1; i < N; i++) {
        const p = m.at(i, t);
        pos[i] = p;
        if (!p) continue;
        const a = m.at(i, Math.max(0, t - 0.2)) ?? p, c = m.at(i, Math.min(m.duration, t + 0.2)) ?? p;
        vel[i] = [(c[0] - a[0]) / 0.4, (c[1] - a[1]) / 0.4];
      }
      // possession: an outfield player within 1.5 m of a low ball, else the team of the last event
      while (ev + 1 < this.events.length && this.events[ev + 1].ts <= t) ev++;
      let carrier = null, cd = 1.5;
      if (b && b.h < 1.5) for (let i = 1; i < N; i++) {
        if (!pos[i]) continue;
        const d = Math.hypot(pos[i][0] - b.x, pos[i][1] - b.y);
        if (d < cd) { cd = d; carrier = i; }
      }
      const poss = carrier !== null ? this.team[carrier] : this.events[ev]?.ts <= t ? this.events[ev].team_id : null;
      // the defender nearest the carrier (for jockeying)
      let jockey = null;
      if (carrier !== null) {
        let jd = JOCKEY_D;
        for (let i = 1; i < N; i++) {
          if (!pos[i] || this.team[i] === poss || this.role[i] === "GK") continue;
          const d = Math.hypot(pos[i][0] - pos[carrier][0], pos[i][1] - pos[carrier][1]);
          if (d < jd && Math.hypot(...vel[i]) < JOCKEY_V) { jd = d; jockey = i; }
        }
      }
      for (let i = 1; i < N; i++) {
        const o = k * N + i;
        if (!pos[i] || !b) { started[i] = 0; continue; }
        this.live[o] = 1;
        const [x, y] = pos[i], [vx, vy] = vel[i], v = Math.hypot(vx, vy);
        const run = v > 0.7 ? Math.atan2(vx, vy) : null;
        const toBall = Math.atan2(b.x - x, b.y - y), dBall = Math.hypot(b.x - x, b.y - y);
        const team = this.team[i], gk = this.role[i] === "GK";
        const emo = this.emotionAt(i, t);
        let ty = run ?? toBall, tw = 0, isJockey = false;
        if (emo?.face !== undefined && pos[emo.face]) {
          ty = Math.atan2(pos[emo.face][0] - x, pos[emo.face][1] - y); tw = v < 3 ? 0.85 : 0.3;
        } else if (i === carrier) {
          tw = 0;                                            // the ball rig turns the carrier
        } else if (gk) {
          ty = toBall; tw = v > 4 ? 0.5 : 0.95;
        } else if (poss && team !== poss) {
          const ux = (b.x - x) / Math.max(dBall, 1e-6), uy = (b.y - y) / Math.max(dBall, 1e-6);
          const away = -(vx * ux + vy * uy);                 // m/s moving away from the ball
          const gx = this.goalX(team, t);
          const beaten = carrier !== null && dBall < NEAR && Math.abs(pos[carrier][0] - gx) < Math.abs(x - gx) - 1 && v > 3;
          if (i === jockey) {
            // side-on, the chest turned off the carrier towards the nearer touchline (R8)
            const toC = Math.atan2(pos[carrier][0] - x, pos[carrier][1] - y);
            const s = Math.sign(angleDiff(toC, Math.atan2(0, (y < 34 ? 0 : 68) - y))) || 1;
            ty = toC + s * SIDE_ON; tw = 1; isJockey = true;
          } else if (away > BACKPEDAL_MAX || beaten) {
            tw = 0;                                          // turn and run (R7)
          } else {
            ty = toBall; tw = clamp((FAR - dBall) / (FAR - NEAR), 0, 1);
          }
        } else if (poss && team === poss) {
          if (v < 3 && dBall < 30) {
            // open body: between the ball and the goal he attacks, ball within 45 deg (R9)
            const goal = Math.atan2(105 - this.goalX(team, t) - x, 34 - y);
            ty = toBall + clamp(angleDiff(toBall, goal), -OPEN_MAX, OPEN_MAX); tw = 0.7 * (1 - v / 3);
          }
        } else if (v < 2) {
          ty = toBall; tw = 0.6;
        }
        if (tw === 0) ty = run ?? (started[i] ? sy[i] : toBall);
        // head target: the ball as it was a reaction time ago, or a scan, or what the emotion looks at
        const bl = this.ball(Math.max(0, t - react[i])) ?? b;
        let hy = Math.atan2(bl.x - x, bl.y - y);
        let hp = Math.atan2(EYE_H - bl.h - 0.11, Math.max(Math.hypot(bl.x - x, bl.y - y), 0.3));
        if (emo) {
          if (emo.face !== undefined && pos[emo.face]) { hy = Math.atan2(pos[emo.face][0] - x, pos[emo.face][1] - y); hp = 0; }
          else if (emo.kind === "dejected") { hy = sy[i]; hp = 35 * D; }
          else if (emo.kind === "celebrate") { hy = sy[i]; hp = -20 * D; }
          else if (emo.kind === "near_miss") { hp = -10 * D; }
        } else if (i !== carrier && !gk && !(team !== poss && dBall < 10) && this._scanning(i, t)) {
          // R4: a look away from the ball: over the shoulder towards the goal he attacks, or for a
          // defender towards his own goal (runners behind him), at least 70 deg off the ball
          const gx = this.goalX(team, t), aim = team === poss ? 105 - gx : gx;
          let s = Math.atan2(aim - x, 34 - y);
          if (Math.abs(angleDiff(toBall, s)) < 70 * D) s = toBall + Math.sign(angleDiff(toBall, s) || 1) * 70 * D;
          hy = s; hp = 0;
        }
        if (!started[i]) { sy[i] = ty; sw[i] = tw; shy[i] = hy; shp[i] = hp; started[i] = 1; }
        sy[i] += angleDiff(sy[i], ty) * aB; sw[i] += (tw - sw[i]) * aB;
        const cap = HEAD_SPEED * STEP;
        shy[i] += clamp(angleDiff(shy[i], hy) * aH, -cap, cap); shp[i] += clamp((hp - shp[i]) * aH, -cap, cap);
        // locomotion mode from the angle between the shown chest and the run, with 10 deg hysteresis
        let mode = 0;
        if (run !== null) {
          const chest = run + angleDiff(run, sy[i]) * sw[i];
          const a = Math.abs(angleDiff(run, chest)) / D, pm = lastMode[i], hy10 = 10;
          if (isJockey && v < JOCKEY_V) mode = 3;
          else if (a > 120 + (pm === 1 ? -hy10 : hy10)) mode = 1;
          else if (a > 60 + (pm === 0 ? hy10 : -hy10)) mode = 2;
          if (mode === 1 && v > BACKPEDAL_MAX) mode = 0;
        }
        if (mode !== lastMode[i] && t < hold[i]) mode = lastMode[i];
        else if (mode !== lastMode[i]) hold[i] = t + MODE_HOLD;
        lastMode[i] = mode;
        this.fy[o] = sy[i]; this.fw[o] = sw[i]; this.mode[o] = mode;
        this.hy[o] = shy[i]; this.hp[o] = clamp(shp[i], -PITCH_UP, PITCH_DOWN);
      }
    }
  }

  _at(i, ts) {
    const u = (ts - this.T0) / STEP;
    if (!(u >= 0 && u <= this.K - 1)) return null;
    const k0 = Math.floor(u), k1 = Math.min(k0 + 1, this.K - 1), a = u - k0, N = this.ents.length;
    const o0 = k0 * N + i, o1 = k1 * N + i;
    if (!this.live[o0] || !this.live[o1]) return null;
    return { o0, o1, a, near: a < 0.5 ? o0 : o1 };
  }

  pose(i, ts) {
    const s = this._at(i, ts);
    if (!s) return null;
    const { o0, o1, a } = s;
    const mode = MODES[this.mode[s.near]];
    const yawW = mode === "backpedal" ? 1 : this.fw[o0] + (this.fw[o1] - this.fw[o0]) * a;
    const [ax, ay] = this._apart(i, ts), j = this._join(i, ts);
    // running to the scorer: the body faces the run, whatever the tracking's own heading
    const run = j && j.e > 0 && j.e < 1;
    return { yaw: this.fy[o0] + angleDiff(this.fy[o0], this.fy[o1]) * a, yawW: run ? 0 : yawW, mode: run ? "forward" : mode,
      emotion: this.emotion(i, ts), dx: ax + (j?.dx ?? 0), dy: ay + (j?.dy ?? 0) };
  }

  // Offset {dx, dy, e} of a team-mate running over to the scorer (JOIN), or null.
  _join(i, ts) {
    const J = this.joins.find((q) => q.i === i && ts > q.t0 && ts < q.t1 + JOIN.back);
    const p = J && this.match.at(i, ts), s = J && this.match.at(J.si, ts);
    if (!p || !s) return null;
    const e = ts < J.t1 ? trapezoid((ts - J.t0) / J.T, JOIN.ease / J.T) : 1 - trapezoid((ts - J.t1) / JOIN.back, JOIN.ease / JOIN.back);
    return { dx: (s[0] + J.side[0] - p[0]) * e, dy: (s[1] + J.side[1] - p[1]) * e, e };
  }

  // Where player i is drawn on the grass before the push apart: tracking plus a run to the scorer.
  _pos(i, ts) {
    const p = this.match.at(i, ts), j = p && this._join(i, ts);
    return j ? [p[0] + j.dx, p[1] + j.dy] : p;
  }

  // Root offset that keeps player i at least APART metres from everyone else (more from opponents) (each of a pair moves
  // half the overlap, a running joiner all of it), faded in and out over 0.5 s at the edges of a post-goal window; else zero.
  _apart(i, ts) {
    const win = this.apart.find(([a, b]) => ts >= a && ts < b);
    if (!win) return [0, 0];
    const w = clamp(Math.min(ts - win[0], win[1] - ts) / 0.5, 0, 1), p = this._pos(i, ts);
    if (!p || this.bodyOf?.(i, ts)) return [0, 0];
    // a team-mate sprinting to the scorer steps round whoever stands in his way (a player kneeling
    // in his path is not shoved off his knees)
    const running = (j) => { const r = this._join(j, ts); return !!r && r.e > 0 && r.e < 1; };
    const runI = running(i);
    let dx = 0, dy = 0;
    for (let j = 1; j < this.ents.length; j++) {
      // a body on the grass does not move aside: whoever stands on it steps off all the way
      const body = j !== i && this.bodyOf?.(j, ts);
      if (body) {
        for (const b of body) {
          const ex = p[0] - b[0], ey = p[1] - b[1], d = Math.hypot(ex, ey), gap = BODY_GAP * (b[2] ?? 1);
          if (d < gap && d > 1e-3) { dx += ex / d * (gap - d); dy += ey / d * (gap - d); }
        }
        continue;
      }
      const q = j !== i && this._pos(j, ts);
      if (!q) continue;
      const ex = p[0] - q[0], ey = p[1] - q[1], d = Math.hypot(ex, ey), gap = this.team[i] === this.team[j] ? APART.mate : APART.rival;
      if (d >= gap) continue;
      const ux = d > 1e-3 ? ex / d : (i < j ? 1 : -1), uy = d > 1e-3 ? ey / d : 0;   // stacked: split along x
      const runJ = running(j), share = runI === runJ ? 0.5 : runI ? 1 : 0;
      dx += ux * (gap - d) * share; dy += uy * (gap - d) * share;
    }
    return [dx * w, dy * w];
  }

  look(i, ts) {
    const s = this._at(i, ts);
    if (!s) return null;
    const { o0, o1, a } = s;
    return { yaw: this.hy[o0] + angleDiff(this.hy[o0], this.hy[o1]) * a, pitch: this.hp[o0] + (this.hp[o1] - this.hp[o0]) * a };
  }
}

// Where the head ends up for a look target and a chest facing: the neck and upper spine reach at
// most HEAD_YAW_MAX each side of the chest (R1). Both yaws as atan2(dx, dy).
export function headYaw(chest, target) {
  return chest + clamp(angleDiff(chest, target), -HEAD_YAW_MAX, HEAD_YAW_MAX);
}
