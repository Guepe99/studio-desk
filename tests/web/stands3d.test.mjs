// web/js/scene3d/stands.js and lighting.js, built on a Babylon stand-in (babylon-stub.mjs): the lamp
// panels and roof strips sit where the masts and roofs are, and every card spectator jumps whole,
// head and hair with the torso, for his shirt or his end (corners too).
//   node --test tests/web/stands3d.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { installBabylon, Scene } from "./babylon-stub.mjs";

installBabylon();
const { buildStadium } = await import("../../web/js/scene3d/stands.js");
const { buildFloodlights, MASTS } = await import("../../web/js/scene3d/lighting.js");

const HALF_L = 52.5, HALF_W = 34;
const build = () => {
  const sc = new Scene();
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const match = { home: { color_primary: "#cc0000" }, away: { color_primary: "#0000cc" }, goals: [], teams: {} };
  const stadium = buildStadium(sc, match, { crowd: 1, crowd3dRows: 2, crowdHair: true }, rnd);
  buildFloodlights(sc);
  return { sc, stadium };
};
const { sc } = build();

test("a lamp panel on every mast head, and the far roof strip no longer than the far stand", () => {
  const masts = sc.byName(/^mast$/), heads = sc.byName(/^lampHead$/), panels = sc.byName(/^floodPanel$/);
  assert.equal(masts.length, 4);
  for (const [k, m] of MASTS.entries()) {
    const mast = masts.find((x) => Math.hypot(x.position.x - m.x, x.position.z - m.z) < 0.01);
    assert.ok(mast, `no mast under light ${k} at ${m.asArray()}`);
    assert.ok(Math.abs(mast.position.y * 2 - m.y) < 0.01, `mast ${k} is ${mast.position.y * 2} m, the light at ${m.y} m`);
    const head = heads.find((h) => Math.hypot(h.position.x - m.x, h.position.y - m.y, h.position.z - m.z) < 0.01);
    assert.ok(head, `no lamp head at light ${k}`);
    const panel = panels.find((p) => Math.hypot(p.position.x - m.x, p.position.y - m.y, p.position.z - m.z) < 1);
    assert.ok(panel, `no lamp panel within 1 m of lamp head ${k}`);
  }
  // the far stand runs 2 * (HALF_L + 9) along x; its roof strip is the one at z > 0
  const far = sc.byName(/^floodStrip$/).find((s) => s.position.z > 1);
  assert.ok(far.opts.width <= 2 * (HALF_L + 9) + 0.01, `far roof strip ${far.opts.width} m, the stand ${2 * (HALF_L + 9)} m`);
});

// cards by group: [{mesh, i, x, z, fan: [shirt, end]}]; the shader jumps a card when either equals the goal's side
const cards = (re) => sc.byName(re).flatMap((mesh) => {
  const m = mesh.buffers.matrix.data, f = mesh.buffers.cardFan?.data, n = m.length / 16;
  return Array.from({ length: n }, (_, i) => ({ mesh, i, x: m[16 * i + 12], z: m[16 * i + 14], fan: f && [f[2 * i], f[2 * i + 1]] }));
});
const key = (c) => `${c.x.toFixed(3)},${c.z.toFixed(3)}`;

test("a card spectator's head and hair jump with his torso", () => {
  const torsos = cards(/^crowdTorso\d+$/), byPos = new Map(torsos.map((c) => [key(c), c]));
  assert.ok(torsos.length > 10000, `${torsos.length} torso cards`);
  // shirts: groups 0-1 home kit, 2-3 away kit, the rest neutral
  for (const t of torsos) {
    const k = +t.mesh.name.slice("crowdTorso".length);
    assert.deepEqual(t.fan?.[0], k < 2 ? 1 : k < 4 ? -1 : 0, `torso card ${t.mesh.name}[${t.i}] shirt`);
  }
  for (const re of [/^crowdHead\d+$/, /^crowdHair\d+$/]) {
    const list = cards(re);
    assert.equal(list.length, torsos.length, `${re}: one per torso`);
    let wrong = 0;
    for (const c of list) {
      const t = byPos.get(key(c));
      assert.ok(t, `${re} card at ${key(c)} without a torso`);
      if (!c.fan || c.fan[0] !== t.fan[0] || c.fan[1] !== t.fan[1]) wrong++;
    }
    assert.equal(wrong, 0, `${re}: ${wrong} of ${list.length} cards not with their torso`);
  }
});

test("the end stands and the end half of each corner jump for their end", () => {
  const torsos = cards(/^crowdTorso\d+$/);
  const zone = (c) => (Math.abs(c.z) < HALF_W + 8 ? (Math.abs(c.x) > HALF_L + 8 ? "end" : "side") : Math.abs(c.x) > HALF_L + 8 ? "corner" : "side");
  const ends = { end: 0, corner: 0 };
  for (const c of torsos) {
    const z = zone(c), own = -Math.sign(c.x);   // +1 home end at x < 0
    if (z === "side") { assert.equal(c.fan?.[1], 0, `side card at ${key(c)}`); continue; }
    if (z === "end") assert.equal(c.fan?.[1], own, `end card at ${key(c)}`);
    else assert.ok(c.fan?.[1] === 0 || c.fan?.[1] === own, `corner card at ${key(c)}: end ${c.fan?.[1]}`);
    if (c.fan?.[1] === own) ends[z]++;
  }
  // the corners' end halves react (a corner card was never reached by its end's goal)
  assert.ok(ends.end > 1000 && ends.corner > 500, JSON.stringify(ends));
});
