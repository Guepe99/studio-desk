// Motion fluidity of the 3D sample (docs/flow3d.md, section 5): steps the scene at 60 Hz through a
// window without drawing and measures what makes motion look mechanical: jerk of the drawn root,
// clip switches and their crossfade times, players stepping in lockstep, cadence against speed,
// how still a player holding the ball is, and how long a throw-in taker leaves the ball on the
// grass. Also probes the locomotion loops: where in the cycle each foot is planted, so blends
// between loops can be checked for matching phase. Prints one JSON object.
//
//   [CHECK=1] scripts/with-lock.sh chromium tests/web/run-smoke.sh motion-flow-measure.mjs [match] [from] [seconds] [query]
//   CHECK=1 fails on a slow throw-in pick-up, a still holder or a jumping ball (M001 512 and 530).
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base = "http://127.0.0.1:8765/", match = "M001", from = "480", seconds = "20", query = ""] = process.argv.slice(2);
  const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
    page.setDefaultTimeout(900000);
    page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
    await page.goto(new URL(`sample3d.html?match=${match}&capture=1&from=${from}${query ? `&${query}` : ""}`, base).href);
    await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 300000 });
    const out = await page.evaluate(motionFlow, Number(seconds));
    out.loops = await page.evaluate(probeLoops);
    console.log(JSON.stringify(out, null, 1));
    if (process.env.CHECK) {
      // a throw-in taker has the ball in his hands within 2 s of reaching it; a player keeping a
      // still ball in open play moves it with his feet at least half of the time, and it never jumps
      const bad = [];
      for (const T of out.throws) if (T.near !== null && !(T.pickupDelay !== null && T.pickupDelay < 2)) bad.push(`throw-in at ${T.throwAt}: in hands ${T.pickupDelay} s after reaching the ball`);
      const h = out.holdStill;
      if (h.seconds >= 2 && h.legActionShare < 0.5) bad.push(`holding a still ball ${h.seconds} s, feet on it ${h.legActionShare} of the time`);
      if (h.ballJumps) bad.push(`the held ball jumps ${h.ballJumps} times`);
      if (!out.throws.length && h.seconds < 2) bad.push("nothing to check in this window");
      console.log(bad.length ? `FAIL\n${bad.join("\n")}` : "PASS");
      if (bad.length) process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

// Where each locomotion loop plants its feet: the normalised cycle time of the lowest point of the
// left and right foot bones, the loop played alone at full weight on the first player.
export async function probeLoops() {
  const sc = window.sample3d.scene, p = sc.players[0], out = {};
  for (let j = 1; j < p.anim.loco.length; j++) {
    const g = p.anim.loco[j];
    p.anim.loco.forEach((h, k) => h.setWeightForAllAnimatables(k === j ? 1 : 0));
    const low = { l: [1e9, 0], r: [1e9, 0] };
    for (let k = 0; k < 40; k++) {
      g.goToFrame(g.from + (k / 40) * (g.to - g.from), true);
      sc.scene.animate();
      for (const side of ["l", "r"]) {
        const n = p.anim.node(`foot_${side}`);
        n.computeWorldMatrix(true);
        for (let q = n; q; q = q.parent) q.computeWorldMatrix(true);
        const y = n.getAbsolutePosition().y - p.holder.position.y;
        if (y < low[side][0]) low[side] = [y, k / 40];
      }
    }
    out[g.name.replace(/^.*-/, "")] = { leftDown: low.l[1], rightDown: low.r[1] };
  }
  p.anim.loco.forEach((h, k) => h.setWeightForAllAnimatables(p.w[k]));
  return out;
}

export async function motionFlow(seconds) {
  const s = window.sample3d, sc = s.scene, B = window.BABYLON;
  const { resolve, throwAt } = await import("./js/scene3d/players.js");
  const HZ = 60, dt = 1 / HZ;
  const stop = Math.min(seconds, (s.tl.cuts[1] ?? 20) - 0.1);
  const q = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(3); };
  const stat = (arr) => ({ n: arr.length, p50: q(arr, 0.5), p95: q(arr, 0.95), p99: q(arr, 0.99), max: q(arr, 1) });
  const SET = new Set(["freekick_crossed", "freekick_short", "shot_freekick", "shot_penalty", "goalkick", "corner_crossed", "corner_short", "throw_in"]);
  const evs = [...sc.match.events].sort((a, b) => a.ts - b.ts);
  const nextEvent = (ts) => evs.find((e) => e.ts > ts);
  const R = sc.players.map((p) => ({ p, prev: null, v: null, a: null, dom: null, mode: null, phase: null, rise: {}, w: {}, foot: null }));
  const jerk = [], accel = [], clipSwitch = [], modeSwitch = [], rises = [], cadence = { walk: [], jog: [], sprint: [] };
  let lockPairs = 0, lockSame = 0, playerSeconds = 0;
  const hold = { frames: 0, legFrames: 0, footSpeed: [], ballOff: [], ballFoot: [], ballJump: 0, stretches: [] };
  const throws = {};
  let prevBall = null, prevHolder = null, holdRun = 0;
  const stepMs = [];   // CPU of the scene update and the animation step (drivers, rigs, layers), no drawing
  for (let k = 0; k * dt < stop; k++) {
    const c = k * dt, ts = s.tl.at(c).ts;
    const t0 = performance.now();
    sc.update({ ts, replay: false }, k ? dt : 0);
    sc.scene.animate();
    if (k) stepMs.push(performance.now() - t0);
    const ball = sc.ball.position.clone();
    const ballV = prevBall ? Math.hypot(ball.x - prevBall.x, ball.z - prevBall.z) * HZ : 0;
    // the drawn ball must never jump: more than 0.5 m in one frame while held
    const moving = [];
    let holder = null, hd = 1.2;
    for (const r of R) {
      const h = r.p.holder;
      if (!h.isEnabled()) { r.prev = null; r.v = null; r.a = null; continue; }
      playerSeconds += dt;
      const pos = [h.position.x, h.position.z];
      if (r.prev) {
        const v = [(pos[0] - r.prev[0]) * HZ, (pos[1] - r.prev[1]) * HZ];
        if (r.v) {
          const a = [(v[0] - r.v[0]) * HZ, (v[1] - r.v[1]) * HZ];
          accel.push(Math.hypot(...a));
          if (r.a) jerk.push(Math.hypot(a[0] - r.a[0], a[1] - r.a[1]) * HZ);
          r.a = a;
        }
        r.v = v;
      }
      r.prev = pos;
      const speed = r.v ? Math.hypot(...r.v) : 0;
      // dominant clip: the four loops, the motion loop, the clips of actions and emotions
      const w = { walk: r.p.w[1], jog: r.p.w[2], sprint: r.p.w[3], idle: r.p.w[0], ...(r.p.loop ? { [r.p.loop]: r.p.wl ?? 0 } : {}) };
      for (const [key, x] of Object.entries(r.p.aw)) if (!key.endsWith("^")) w[key] = x;
      let dom = null, top = 0;
      for (const [key, x] of Object.entries(w)) if (x > top) { top = x; dom = key; }
      if (r.dom && dom !== r.dom && top >= 0.5) clipSwitch.push(ts);
      if (top >= 0.5) r.dom = dom;
      // rise times of any weight from under 0.1 to over 0.9
      for (const [key, x] of Object.entries(w)) {
        const st = r.rise[key];
        if (x < 0.1) r.rise[key] = c;
        else if (x > 0.9 && st !== undefined && st !== null) { rises.push(c - st); r.rise[key] = null; }
      }
      const mode = resolve(sc.drivers, r.p.i, ts).mode;
      if (r.mode && mode !== r.mode) modeSwitch.push(ts);
      r.mode = mode;
      // cadence: steps per second of the forward loops, two steps a cycle
      if (r.phase !== null && mode === "forward" && r.p.w[0] < 0.2 && speed > 0.5) {
        const d = ((r.p.phase - r.phase) % 1 + 1) % 1;
        (speed < 2.2 ? cadence.walk : speed < 5.5 ? cadence.jog : cadence.sprint).push([speed, 2 * d * HZ]);
      }
      r.phase = r.p.phase;
      if (speed > 1.5 && mode === "forward" && !r.p.wl) moving.push(r.p.phase);
      const d = Math.hypot(ball.x - pos[0], ball.z - pos[1]);
      if (d < hd && speed < 0.8) { hd = d; holder = r; }
      // feet in the body's frame (what moves when the body stands)
      const f = ["l", "r"].map((side) => { const n = r.p.anim.node(`ball_${side}`); n.computeWorldMatrix(true); return n.getAbsolutePosition().subtract(h.position); });
      r.footPrev = r.foot; r.foot = f;
      r.feetW = ["l", "r"].map((side) => r.p.anim.node(`ball_${side}`).getAbsolutePosition().clone());
    }
    for (let a = 0; a < moving.length; a++) for (let b = a + 1; b < moving.length; b++) {
      const d = Math.abs(moving[a] - moving[b]);
      lockPairs++; if (Math.min(d, 1 - d) < 0.03) lockSame++;
    }
    // a player holding a still ball in open play (no throw-in, no set piece next)
    const nx = nextEvent(ts);
    const open = holder && ball.y < 0.4 && ballV < 0.6 && !throwAt(sc.throws[holder.p.pid], ts) && !(nx && SET.has(nx.type_name) && nx.player_id === holder.p.pid);
    if (open) {
      hold.frames++; holdRun++;
      if (sc.rig.players.get(holder.p.i)?.leg) hold.legFrames++;
      if (holder.footPrev) hold.footSpeed.push(Math.max(...[0, 1].map((j) => holder.foot[j].subtract(holder.footPrev[j]).length() * HZ)));
      hold.ballFoot.push(Math.min(...holder.feetW.map((x) => Math.hypot(x.x - ball.x, x.z - ball.z))));
      if (prevBall && prevHolder === holder) hold.ballOff.push(Math.hypot(ball.x - prevBall.x, ball.z - prevBall.z));
      if (prevBall && prevHolder === holder && Math.hypot(ball.x - prevBall.x, ball.y - prevBall.y, ball.z - prevBall.z) > 0.25) hold.ballJump++;
    } else if (holdRun) { hold.stretches.push(+(holdRun / HZ).toFixed(2)); holdRun = 0; }
    prevHolder = open ? holder : null;
    // throw-ins: when the taker first stands within 1 m of the ball, and when the ball leaves the grass
    for (const r of R) {
      const list = sc.throws[r.p.pid];
      if (!list || !r.prev) continue;
      for (const t of list) {
        if (ts < t.ts - 20 || ts > t.ts) continue;
        const T = (throws[t.ts] ??= { pid: r.p.pid, throwAt: t.ts, near: null, inHands: null });
        const d = Math.hypot(ball.x - r.prev[0], ball.z - r.prev[1]);
        if (T.near === null && d < 1.0 && ball.y < 0.3) T.near = +ts.toFixed(2);
        if (T.near !== null && T.inHands === null && ball.y > 0.8) T.inHands = +ts.toFixed(2);
      }
    }
    prevBall = ball;
  }
  if (holdRun) hold.stretches.push(+(holdRun / HZ).toFixed(2));
  const minutes = playerSeconds / 60;
  const cad = (arr) => arr.length ? { n: arr.length, speed: q(arr.map((x) => x[0]), 0.5), stepsPerS: q(arr.map((x) => x[1]), 0.5) } : null;
  return {
    window: { from: s.tl.from, seconds: +stop.toFixed(2), players: R.length },
    stepMs: stat(stepMs),
    accel: stat(accel), jerk: stat(jerk),
    clipSwitchesPerPlayerMinute: +(clipSwitch.length / minutes).toFixed(2),
    modeSwitchesPerPlayerMinute: +(modeSwitch.length / minutes).toFixed(2),
    weightRiseS: stat(rises),
    lockstepShare: +(lockSame / Math.max(1, lockPairs)).toFixed(3), lockPairs,
    cadence: { walk: cad(cadence.walk), jog: cad(cadence.jog), sprint: cad(cadence.sprint) },
    holdStill: { seconds: +(hold.frames / HZ).toFixed(2), stretches: hold.stretches, legActionShare: +(hold.legFrames / Math.max(1, hold.frames)).toFixed(3),
      footSpeed: stat(hold.footSpeed), ballStep: stat(hold.ballOff), ballToFoot: stat(hold.ballFoot), ballJumps: hold.ballJump },
    throws: Object.values(throws).map((T) => ({ ...T, pickupDelay: T.near !== null && T.inHands !== null ? +(T.inHands - T.near).toFixed(2) : null, handsBeforeThrow: T.inHands !== null ? +(T.throwAt - T.inHands).toFixed(2) : null })),
  };
}
