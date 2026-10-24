// The camera director (web/js/scene3d/camera.js) on a NullEngine: the second half's first shot and
// the operator over long frames (16x, 64x).
//   node --test tests/web/camera3d.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMatch, cameras } from "./null3d.mjs";

const view = (ts) => ({ ts, replay: false, cuts: false });

for (const id of ["M001", "M002", "M003", "M004"]) {
  const m = await loadMatch(id);
  test(`${id}: the second half opens on the kick-off, not on where the first half ended`, { skip: !m && `no web/data/${id}` }, async () => {
    const c = await cameras(m), h = m.meta.period1_s, t = h + 0.02;
    c.update(view(t), t, 0);   // the page jumps across the break
    const aim = c.tv.getTarget().x + 52.5, ball = m.at(0, t)[0];
    assert.ok(Math.abs(aim - ball) < 8, `aim at x ${aim.toFixed(1)}, ball at ${ball.toFixed(1)}`);
  });

  test(`${id}: one long frame moves camera 1 as many short ones do`, { skip: !m && `no web/data/${id}` }, async () => {
    const c = await cameras(m), h = m.meta.period1_s;
    let worst = 0, sum = 0, n = 0;
    for (let t = 200; t < m.duration - 10; t += 97) {
      if (Math.abs(t - h) < 5) continue;
      c.state = null;
      c.update(view(t), t, 0);
      const s0 = structuredClone(c.state);
      c.update(view(t + 0.8), t + 0.8, 0.8);   // a 50 ms frame at 16x
      const big = [c.state.x[0], c.state.z[0]];
      c.state = structuredClone(s0);
      for (let k = 1; k <= 40; k++) c.update(view(t + k * 0.02), t + k * 0.02, 0.02);
      const d = Math.hypot(big[0] - c.state.x[0], big[1] - c.state.z[0]);
      worst = Math.max(worst, d); sum += d; n++;
    }
    assert.ok(worst < 4 && sum / n < 0.5, `0.8 s in one step against 40: worst ${worst.toFixed(2)} m, mean ${(sum / n).toFixed(2)} m`);
  });
}
