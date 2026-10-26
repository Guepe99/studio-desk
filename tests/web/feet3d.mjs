// Feet on the grass: over the 20 s of the DEMO sample and of M001 around its first goal (when
// web/data/M001 is there), the lowest point of each planted boot, its sole, stays within TOL of the
// ground, with today's footballers and with the anime ones (?players=anime). A boot is planted
// when it is the lower of the two and its lowest point moves slower than PLANTED m/s along the
// ground. Keeper actions (GK_ clips: dives, saves) are reported apart, as they lie on the ground.
//
//   [STEP=0.06] scripts/with-lock.sh chromium tests/web/run-smoke.sh feet3d.mjs [DEMO,M001] [default,anime]
//
// Prints the spread of the planted soles, the worst sink and the worst float per page (player,
// clips, clock second) and exits 1 when a sole outside keeper actions is more than TOL under the
// grass. Floats are only printed: a jog clip stepping in place lifts slow feet by design.
import { createRequire } from "node:module";
import { homedir } from "node:os";
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const [base, matches = "DEMO,M001", looks = "default,anime"] = process.argv.slice(2);
const TOL = 0.02, STEP = +(process.env.STEP ?? 0.06), PLANTED = 0.3;

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
let failed = false;
try {
  for (const match of matches.split(",")) {
    for (const look of looks.split(",")) {
      const page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
      page.setDefaultTimeout(600000);
      page.on("pageerror", (e) => console.log("pageerror", e.message));
      const res = await page.goto(new URL(`sample3d.html?match=${match}&capture=1&view=3d&players=${look === "anime" ? "anime" : "footballer"}`, base).href);
      const meta = await page.request.get(new URL(`data/${match}/meta.json`, base).href);
      if (!res?.ok() || !meta.ok()) { console.log(`${match} ${look}: no data, skipped`); await page.context().close(); continue; }
      await page.waitForFunction(() => window.sample3d?.ready, null, { timeout: 600000 });
      const r = await page.evaluate(async ({ STEP, PLANTED, TOL }) => {
        const s = window.sample3d, sc = s.scene, B = window.BABYLON;
        const bootsPart = sc.container.meshes.find((m) => m.material?.name === "boots")?.name;
        if (!bootsPart) return { error: "no boots part in the player file" };
        const feet = sc.players.map((p) => {
          const boots = sc.scene.getMeshByName(`${p.pid}-${bootsPart}`);
          return { p, boots, l: p.anim.node("foot_l"), r: p.anim.node("foot_r"), prev: [null, null] };
        });
        const v = new B.Vector3();
        const rows = [];
        let samples = 0;
        for (let c = 0; c <= s.LOOP_S - 0.5; c += STEP) {
          const { ts } = await window.__setTime(c);
          for (const f of feet) {
            if (!f.p.holder.isEnabled() || !f.boots) continue;
            f.boots.skeleton.prepare(true);
            const pos = f.boots.getPositionData(true, true);
            const W = f.boots.getWorldMatrix(), L = f.l.getAbsolutePosition(), R = f.r.getAbsolutePosition();
            const low = [null, null];
            for (let k = 0; k < pos.length; k += 3) {
              B.Vector3.TransformCoordinatesFromFloatsToRef(pos[k], pos[k + 1], pos[k + 2], W, v);
              const side = B.Vector3.DistanceSquared(v, L) < B.Vector3.DistanceSquared(v, R) ? 0 : 1;
              if (!low[side] || v.y < low[side][1]) low[side] = [v.x, v.y, v.z];
            }
            const prev = f.prev;
            f.prev = low.map((q) => q && [...q, c]);
            const clips = [...f.p.ws.map((w, j) => (w > 0.2 ? ["idle", "walk", "jog", "run"][j] : null)).filter(Boolean),
              ...Object.entries(f.p.aw).filter(([, w]) => w > 0.2).map(([k]) => k)].join("+");
            const scale = +f.p.holder.getChildren()[0].scaling.y.toFixed(4);
            for (const side of [0, 1]) {
              const q = low[side], pr = prev[side];
              if (!q || !pr || c - pr[3] > STEP * 1.5) continue;
              samples++;
              const speed = Math.hypot(q[0] - pr[0], q[2] - pr[2]) / (c - pr[3]);
              const lower = q[1] <= low[1 - side][1];
              const gk = /(^|\+)GK_/.test(clips);
              if ((lower && speed < PLANTED) || q[1] < -TOL) rows.push({ d: q[1], pid: f.p.pid, foot: side ? "right" : "left", c: +c.toFixed(2), ts: +ts.toFixed(2), clips, speed: +speed.toFixed(2), scale, planted: lower && speed < PLANTED, gk });
            }
          }
        }
        return { rows, samples, players: feet.length, bootsPart };
      }, { STEP, PLANTED, TOL });
      if (r.error) { console.log(`${match} ${look}: ${r.error}`); failed = true; await page.context().close(); continue; }
      const fmt = (w) => (w ? `${(w.d * 100).toFixed(1)} cm, ${w.pid} ${w.foot} boot at ${w.c} s (ts ${w.ts}), ${w.clips}, ${w.speed} m/s, scale ${w.scale}` : "none");
      const cm = (x) => (x * 100).toFixed(1);
      const pct = (a, q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
      const field = r.rows.filter((w) => !w.gk), planted = field.filter((w) => w.planted);
      const ys = planted.map((w) => w.d).sort((a, b) => a - b);
      const off = planted.filter((w) => Math.abs(w.d) > TOL);
      const sink = field.reduce((m, w) => (!m || w.d < m.d ? w : m), null);
      const float = planted.reduce((m, w) => (!m || w.d > m.d ? w : m), null);
      const gkSink = r.rows.filter((w) => w.gk).reduce((m, w) => (!m || w.d < m.d ? w : m), null);
      // the median planted sole per player scale (height variants): a slope here is a scale about the wrong point
      const byScale = {};
      for (const w of planted) (byScale[w.scale] ??= []).push(w.d);
      const scales = Object.entries(byScale).sort(([a], [b]) => a - b).map(([k, a]) => `${k}: ${cm(a.sort((x, y) => x - y)[a.length >> 1])}`).join(", ");
      const bad = sink && -sink.d > TOL;
      console.log(`${match} ${look}: ${r.players} players, ${r.samples} boot samples, ${planted.length} planted`);
      console.log(`  planted sole cm: 5% ${cm(pct(ys, 0.05))}, median ${cm(pct(ys, 0.5))}, 95% ${cm(pct(ys, 0.95))}; ${off.length} beyond ${TOL * 100} cm either way`);
      console.log(`  median by scale: ${scales}`);
      console.log(`  lowest sole outside keeper actions: ${fmt(sink)}`);
      console.log(`  highest planted sole: ${fmt(float)}`);
      console.log(`  lowest sole in keeper actions: ${fmt(gkSink)}${bad ? "\n  FAIL" : "\n  ok"}`);
      if (bad) failed = true;
      await page.context().close();
    }
  }
} finally {
  await browser.close();
}
console.log(failed ? "feet3d FAILED" : "feet3d ok");
process.exit(failed ? 1 : 0);
