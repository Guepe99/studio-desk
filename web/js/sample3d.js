// 3D sample page: 20 seconds of the match on one clock, as a 3D broadcast and on the 2D pitch.
// ?match=<id> (default M001, the match shipped in the image), ?from=<ts> start of the 20 s (default: 12 s before the first goal).
// If a goal falls in the stretch, the last seconds are its replay from behind the goal.
import { loadMatch } from "./match.js";
import { Pitch, STAGE_W, STAGE_H, textOn } from "./pitch.js";
import { OGrafHost } from "./ograf-host.js";
import { Scene3D } from "./scene3d.js";
import { AwarenessRig } from "./awareness-rig.js";

const LOOP_S = 20;          // clock seconds before the loop restarts
const REPLAY_MIN_S = 5.5;   // replay length when the goal sits at the default place
const AFTER_GOAL_S = 2.5;   // live seconds after the goal before cutting to the replay
const REPLAY_END_S = 1.6;   // the shot flies for about 0.8 s, then a beat in the net
const WIPE_S = 0.45;        // half-length of the wipe around each cut
const GRAPHICS = ["nameplate", "pass_shot", "momentum", "why_card"];

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const matchId = (params.get("match") || "M001").replace(/[^A-Za-z0-9_-]/g, "");
const capture = params.has("capture");
const solo = params.get("view") === "3d";   // the 3D frame alone, filling the window (video capture)

// Clock second c (0..20) -> {ts shown, replay?, live ts for the score bug}.
export function makeTimeline(goals, duration, fromParam) {
  const first = goals[0];
  let from = Number.isFinite(fromParam) ? fromParam
    : first !== undefined ? first - (LOOP_S - REPLAY_MIN_S - AFTER_GOAL_S) : 0;
  from = Math.min(Math.max(from, 0), Math.max(0, duration - LOOP_S));
  const goal = goals.find((g) => g >= from + 3 && g + AFTER_GOAL_S <= from + LOOP_S - REPLAY_MIN_S);
  if (goal === undefined) return { from, goal: null, cuts: [0], at: (c) => ({ ts: from + c, replay: false, live: from + c }) };
  const cut = goal + AFTER_GOAL_S - from;
  const r0 = goal + REPLAY_END_S - (LOOP_S - cut);   // the replay ends once the ball is in the net
  return {
    from, goal, cuts: [0, cut],
    at: (c) => (c < cut ? { ts: from + c, replay: false, live: from + c } : { ts: r0 + (c - cut), replay: true, live: from + cut }),
  };
}

// Match time [first, last] the clip shows: the live stretch and the replay, which starts before it.
export function clipSpan(tl) {
  const starts = tl.cuts.map((c) => tl.at(c).ts);
  return [Math.min(...starts), Math.max(tl.from + LOOP_S, tl.at(LOOP_S - 0.001).ts)];
}

const frame = $("#frame"), stage = $("#stage"), side = $("#side"), frame2d = $("#frame2d");
const pitch = new Pitch($("#pitch"));
let match, tl, scene, host;
const state = { c: 0, playing: true, lastTs: null, lastC: null };

function layout() {
  const portrait = window.innerHeight > window.innerWidth;
  const W = window.innerWidth - 32, H = window.innerHeight - 32;
  let f, s;
  if (solo) { f = Math.min(window.innerWidth, window.innerHeight * 16 / 9); s = 200; }
  else if (portrait) { f = W; s = W; }
  else {
    f = Math.min((W - 16) / 1.36, (H - 8) * 16 / 9);
    s = Math.max(200, W - 16 - f);
    s = Math.min(s, f * 0.42);
  }
  frame.style.width = `${Math.round(f)}px`; frame.style.height = `${Math.round(f * 9 / 16)}px`;
  stage.style.transform = `scale(${f / STAGE_W})`;
  side.style.width = `${Math.round(s)}px`;
  frame2d.style.width = `${Math.round(s)}px`; frame2d.style.height = `${Math.round(s * 9 / 16)}px`;
  pitch.resize((s / STAGE_W) * Math.min(window.devicePixelRatio || 1, 2));
  scene?.resize();
}

let lastBug = "";
function drawScorebug(ts) {
  const c = match.clock(ts), [h, a] = match.score(ts);
  const key = `${c.minute}|${c.period}|${h}|${a}`;
  if (key === lastBug) return;
  lastBug = key;
  $(".sb-home .sb-name").textContent = match.home.short_name;
  $(".sb-away .sb-name").textContent = match.away.short_name;
  $(".sb-home .sb-chip").style.background = match.home.color_primary;
  $(".sb-away .sb-chip").style.background = match.away.color_primary;
  $(".sb-h").textContent = h;
  $(".sb-a").textContent = a;
  $(".sb-min").textContent = `${c.minute}'`;
  $(".sb-period").textContent = c.period === 1 ? "1H" : "2H";
}

// The wipe crosses the frame around every cut; its position is a function of the clock only.
function drawWipe(c) {
  let d = Infinity;
  for (const cut of tl.cuts) for (const k of [cut - LOOP_S, cut, cut + LOOP_S]) if (Math.abs(c - k) < Math.abs(d)) d = c - k;
  const el = $("#wipe");
  if (Math.abs(d) >= WIPE_S) { el.style.display = "none"; return; }
  const u = (d + WIPE_S) / (2 * WIPE_S);              // 0..1
  const x = 2100 - 5400 * u;                           // fully covers the frame at u = 0.5
  el.style.display = "grid";
  el.style.transform = `translateX(${x}px) skewX(-14deg)`;
}

// One frame of the sample at clock second c; dt is the match time since the previous frame.
function show(c) {
  const v = tl.at(c);
  const jumped = state.lastTs === null || v.ts < state.lastTs || v.ts - state.lastTs > 0.5;
  const dt = jumped ? 0 : v.ts - state.lastTs;
  state.lastTs = v.ts;
  scene.update(v, dt);
  scene.render();
  pitch.draw(match, Math.min(v.ts, match.duration));
  drawScorebug(v.live);
  $("#replay-badge").classList.toggle("on", v.replay);
  drawWipe(c);
  host.sync(v.ts, jumped || capture);
  $("#time").textContent = `${c.toFixed(1)} s`;
}

let lastFrame = null, fpsAt = 0;
function loop(now) {
  const dt = lastFrame === null ? 0 : Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (state.playing) state.c = (state.c + dt) % LOOP_S;
  show(state.c);
  if (now - fpsAt > 500) { fpsAt = now; $("#fps").textContent = `${scene.engine.getFps().toFixed(0)} fps`; }
  if (!capture) requestAnimationFrame(loop);
}

function setPlaying(on) {
  state.playing = on;
  $("#play").classList.toggle("playing", on);
  $("#play").setAttribute("aria-label", on ? "Pause" : "Play");
}

async function main() {
  if (solo) document.body.classList.add("solo");
  layout();
  $("#status").textContent = "Loading match";
  try {
    match = await loadMatch(`data/${matchId}`);
  } catch (err) {
    $("#status").textContent = `Could not load match ${matchId}. ${err.message}`;
    return;
  }
  const fromParam = params.has("from") ? Number(params.get("from")) : NaN;
  tl = makeTimeline(match.goals.map((g) => g.ts), match.duration, fromParam);
  // players who are on the pitch at some point of the stretch (live part and replay)
  const [s0, s1] = clipSpan(tl);
  const f0 = Math.max(0, Math.floor((s0 - 1) * match.meta.fps));
  const f1 = Math.min(match.meta.frames - 1, Math.ceil((s1 + 1) * match.meta.fps));
  const entities = [];
  for (let i = 1; i < match.n; i++) {
    for (let f = f0; f <= f1; f += 5) if (!Number.isNaN(match.pos[(f * match.n + i) * 3])) { entities.push(i); break; }
  }
  // which end the replayed goal goes in: where the ball is a moment after the shot
  const gb = tl.goal !== null ? match.at(0, tl.goal + 0.7) : null;
  const goalEnd = gb && gb[0] < 52.5 ? -1 : 1;
  try {
    scene = await Scene3D.create($("#view3d"), match, { capture, entities, goalEnd, span: [s0, s1] });
    // players who watch the ball and react to goals, near misses and fouls; ?aware=0 turns it off
    new AwarenessRig(scene).enabled = params.get("aware") !== "0";
  } catch (err) {
    $("#status").textContent = `3D view could not start. ${err.message}`;
    throw err;
  }

  const players = Object.fromEntries(match.meta.players.map((p) => {
    const team = match.teams[p.team_id];
    return [p.player_id, { name: p.name, shirt: p.shirt, team_short: team.short_name, team_name: team.name,
      color: team.color_primary, text: textOn(team.color_primary) }];
  }));
  const teams = Object.fromEntries([match.home, match.away].map((tm) => [tm.side, { short: tm.short_name, name: tm.name, color: tm.color_primary }]));
  host = new OGrafHost($("#overlay"), {
    resolution: { width: STAGE_W, height: STAGE_H },
    frameRate: capture ? 25 : 60,
    locate: (pid, now) => (match.index[pid] !== undefined ? scene.project(match.index[pid], now) : { x: 0, y: 0, visible: false }),
    vendorParams: () => ({ v_showFactIds: true, v_players: players, v_teams: teams }),
  });
  await Promise.all(GRAPHICS.map((g) => host.register(g, `graphics/${g}/${g}.ograf.json`)));
  host.setCues(match.cues.filter((c) => c.audience === "analyst" && c.lang === "en"), tl.at(0).ts);
  $("#status").textContent = "";

  $("#play").addEventListener("click", () => setPlaying(!state.playing));
  window.addEventListener("resize", layout);
  // Space toggles play anywhere; keyup is swallowed too so a focused button does not click as well.
  window.addEventListener("keydown", (e) => { if (e.code === "Space") { e.preventDefault(); if (!e.repeat) setPlaying(!state.playing); } }, true);
  window.addEventListener("keyup", (e) => { if (e.code === "Space") e.preventDefault(); }, true);

  // Deterministic hook for screenshots and the video: draw clock second c and wait until the
  // graphics have caught up.
  window.__setTime = async (c) => {
    state.c = ((c % LOOP_S) + LOOP_S) % LOOP_S;
    show(state.c);
    await Promise.all([...host.live.values()].map((i) => i.chain));
    host.sync(tl.at(state.c).ts, false);   // place the graphics again now that they are loaded
    return tl.at(state.c);
  };
  window.sample3d = { match, tl, scene, host, state, setPlaying, LOOP_S, ready: true };
  if (capture) { setPlaying(false); show(0); } else requestAnimationFrame(loop);
}

main();
