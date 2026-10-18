// The near rows of the crowd as low-poly anime spectators: the body of web/vendor/crowd/spectator.glb
// (about 360 triangles, built by scripts/build_spectator.py) with, added here at load time, a big
// spiky hair mass, a drawn face (tall eyes, a mouth) and a two-colour scarf held between the hands,
// all skinned to the same skeleton; the head is drawn 1.3 times life size. One thin-instanced mesh,
// one draw call, toon shaded (toon.js), its poses baked at load time into a vertex animation
// texture (Babylon's BakedVertexAnimationManager). Each spectator picks a pose loop and a phase of
// its own; shirts and scarves come in the two kits (home fans in the majority) or neutral colours,
// hair in anime colours, skin from five tones.
// The crowd reacts to the goals of the match data (score facts): the scoring team's end, and that
// team's shirts anywhere, rise in a ripple, celebrate and sit back down within about 10 s.
// Everything is a pure function of match time, so seeks, replays and video frames agree.
import { ToonPlugin } from "./toon.js";

const B = window.BABYLON;

export const SPECTATOR_URL = "vendor/crowd/spectator.glb";
export const BAKE_FPS = 20;
const HEIGHT = 1.75;   // metres, standing
const PALETTE = 8;     // texels of the body's region palette (scripts/build_footballer.py)
// region index (u * 8) -> what it is on a spectator: 0 skin, 1 shirt, 2 trousers, 3 shoes;
// the parts added here: 4 hair, 5 face lines, 6 scarf, 7 scarf stripe
const REGION = [0, 1, 2, 2, 3, 0, 0, 5];   // skin, shirt, shorts, socks, boots, forearms, hands, eyes
export const HEAD_SCALE = 1.3;   // anime proportions: a bigger head (and hair) on the same body
// anime hair colours: black, dark brown, chestnut, blonde, silver, pink, sky blue, teal, violet, orange, green, red
export const HAIR = ["#1d1a26", "#4a2c1d", "#8a4a26", "#f2d36b", "#d9dde8", "#ff8fbf", "#5fb6ff",
  "#27c2b0", "#9b6bff", "#ff9a3c", "#66d05a", "#e8443a"];

// Reaction to one goal, seconds from the goal: rise after `delay`, cheer, sit after `stay`.
export const RISE_S = 0.5, SIT_S = 0.7;
export const REACT = { delay: [0.2, 1.6], stay: [7, 9.3] };   // seated again by goal + 10 s

// Pose of a spectator at ts. person: {fan, end, delay, stay, cheer}; goals: [{ts, side}].
// Returns {clip, t} (t: seconds into the clip, or a 0..1 blend for "rise"), or null when seated.
export function reaction(person, goals, ts) {
  for (const g of goals) {
    if (person.fan !== g.side && person.end !== g.side) continue;
    const t = ts - g.ts - person.delay;
    if (t < 0 || t > person.stay + SIT_S) continue;
    if (t < RISE_S) return { clip: "rise", t: t / RISE_S };
    if (t > person.stay) return { clip: "rise", t: 1 - (t - person.stay) / SIT_S };
    return { clip: person.cheer, t: t - RISE_S };
  }
  return null;
}

// --- baking -----------------------------------------------------------------------------------

// The seated pose over any clip: thighs forward, shins down, pelvis lowered to a seat. Rotations
// are applied about the body's own left-right axis, found from the skeleton, so no bone axis
// convention is assumed.
function sitPose(nodes) {
  const n = (k) => nodes[k];
  const pelvis = n("pelvis"), tl = n("thigh_l"), tr = n("thigh_r");
  const side = tr.getAbsolutePosition().subtract(tl.getAbsolutePosition()).normalize();
  const turn = (node, axis, angle) => {
    const parent = node.parent;
    const pw = B.Quaternion.FromRotationMatrix(parent.getWorldMatrix().getRotationMatrix());
    const cur = pw.multiply(node.rotationQuaternion);
    const want = B.Quaternion.RotationAxis(axis, angle).multiply(cur);
    node.rotationQuaternion = B.Quaternion.Inverse(pw).multiply(want);
    node.computeWorldMatrix(true);
  };
  const hipH = pelvis.getAbsolutePosition().y;
  // try both signs: the one that lifts the knee is "forward"
  const knee = n("calf_l");
  const y0 = knee.getAbsolutePosition().y;
  const save = [tl.rotationQuaternion.clone(), tr.rotationQuaternion.clone()];
  turn(tl, side, 1.4);
  const sign = knee.getAbsolutePosition().y > y0 ? 1 : -1;
  tl.rotationQuaternion = save[0]; tl.computeWorldMatrix(true);
  for (const s of ["l", "r"]) {
    turn(n(`thigh_${s}`), side, sign * 1.45);
    for (const k of [`calf_${s}`]) n(k).computeWorldMatrix(true);
    turn(n(`calf_${s}`), side, -sign * 1.5);
  }
  // pelvis down so the thighs sit at about 0.47 of standing hip height (a stadium seat)
  const drop = hipH * 0.47;
  const pw = pelvis.parent.getWorldMatrix().clone().invert();
  const target = pelvis.getAbsolutePosition().subtract(new B.Vector3(0, drop, 0));
  pelvis.position = B.Vector3.TransformCoordinates(target, pw);
  pelvis.computeWorldMatrix(true);
}

function sample(group, t) {
  const len = (group.to - group.from);
  group.goToFrame(group.from + ((t * 60) % (len + 1e-6)));
}

// Bakes the clips into one Float32Array of bone matrices, frame after frame. Returns the frame
// ranges {name: [from, to]} as the VAT settings want them.
function bake(skeleton, mesh, groups, nodes, list) {
  const rows = [], ranges = {};
  const all = Object.values(groups);
  const nodeList = Object.values(nodes);
  const rest = new Map(nodeList.map((nd) => [nd, [nd.position.clone(), nd.rotationQuaternion?.clone()]]));
  const reset = () => { for (const [nd, [p, q]] of rest) { nd.position.copyFrom(p); if (q) nd.rotationQuaternion = q.clone(); } };
  const grab = () => {
    for (const nd of nodeList) nd.computeWorldMatrix(true);
    skeleton.prepare(true);
    rows.push(Float32Array.from(skeleton.getTransformMatrices(mesh)));
  };
  const pose = (clip, t, sit) => {
    reset();
    sample(groups[clip], t);
    nodes.Head.scaling.setAll(HEAD_SCALE);
    for (const nd of nodeList) nd.computeWorldMatrix(true);
    if (sit) sitPose(nodes);
  };
  for (const g of all) { g.start(false, 1, g.from, g.to); g.pause(); }
  for (const { name, clip, sit, len, blend } of list) {
    const from = rows.length;
    const n = blend ? 10 : Math.max(2, Math.round(len * BAKE_FPS));
    for (let f = 0; f < n; f++) {
      if (blend) {
        // seated -> standing at the first frame of Idle, node by node
        pose("Idle_Loop", 0, true);
        const a = nodeList.map((nd) => [nd.position.clone(), nd.rotationQuaternion?.clone()]);
        pose("Idle_Loop", 0, false);
        const k = f / (n - 1), e = k * k * (3 - 2 * k);
        nodeList.forEach((nd, i) => {
          B.Vector3.LerpToRef(a[i][0], nd.position, e, nd.position);
          if (a[i][1]) nd.rotationQuaternion = B.Quaternion.Slerp(a[i][1], nd.rotationQuaternion, e);
        });
      } else pose(clip, f / BAKE_FPS, sit);
      grab();
    }
    ranges[name] = [from, rows.length - 1];
  }
  for (const g of all) g.stop();
  reset();
  const out = new Float32Array(rows.length * rows[0].length);
  rows.forEach((r, i) => out.set(r, i * r.length));
  return { data: out, ranges };
}

// --- anime parts ------------------------------------------------------------------------------

// Adds hair, face and scarf to the body, in its bind space (the space of the vertex data), skinned
// rigidly to the head (hair, face) or blended from one hand to the other (scarf). Returns the
// region of every vertex. rnd seeds the hair spikes.
function animeParts(mesh, skeleton, rnd) {
  const K = B.VertexBuffer;
  const pos = Array.from(mesh.getVerticesData(K.PositionKind));
  const uv = mesh.getVerticesData(K.UVKind);
  const mi = Array.from(mesh.getVerticesData(K.MatricesIndicesKind));
  const mw = Array.from(mesh.getVerticesData(K.MatricesWeightsKind));
  const idx = Array.from(mesh.getIndices());
  const nv0 = pos.length / 3;
  const region = [];
  for (let i = 0; i < nv0; i++) region.push(REGION[Math.min(PALETTE - 1, Math.floor(uv[2 * i] * PALETTE))]);
  const bone = (re) => skeleton.bones.findIndex((b) => re.test(b.getTransformNode()?.name ?? b.name));
  const head = bone(/^Head$/), hl = bone(/^hand_l$/), hr = bone(/^hand_r$/);
  // the vertices a bone moves most: their box and centre
  const top1 = (i) => { let k = 0; for (let j = 1; j < 4; j++) if (mw[4 * i + j] > mw[4 * i + k]) k = j; return mi[4 * i + k]; };
  const box = (b, pick = () => true) => {
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let i = 0; i < nv0; i++) {
      if (top1(i) !== b || !pick(i)) continue;
      for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], pos[3 * i + a]); hi[a] = Math.max(hi[a], pos[3 * i + a]); }
    }
    return { lo, hi, c: lo.map((v, a) => (v + hi[a]) / 2), s: hi.map((v, a) => v - lo[a]), found: lo[0] < 1e8 };
  };
  const H = box(head), L = box(hl), R = box(hr);
  // spectators wear trousers: the bare legs of the footballer body take the trouser colour
  const legs = new Set(skeleton.bones.map((b, i) => (/thigh|calf/.test(b.getTransformNode()?.name ?? b.name) ? i : -1)));
  for (let i = 0; i < nv0; i++) if (region[i] === 0 && legs.has(top1(i))) region[i] = 2;
  // front of the face: the side of the head where the eye texels are, else +Z (glTF forward)
  const eyes = box(head, (i) => region[i] === 5);
  let front = [0, 0, 1];
  if (eyes.found) {
    const f = [eyes.c[0] - H.c[0], 0, eyes.c[2] - H.c[2]], l = Math.hypot(f[0], f[2]);
    if (l > 1e-4) front = [f[0] / l, 0, f[2] / l];
  }
  const side = [front[2], 0, -front[0]];
  const r = Math.max(H.s[0], H.s[2]) / 2, top = H.hi[1];
  const add = (p, b0, b1 = b0, t = 0, reg = 4) => {
    pos.push(...p);
    mi.push(b0, b1, 0, 0); mw.push(1 - t, t, 0, 0);
    region.push(reg);
    return pos.length / 3 - 1;
  };
  const at = (o, f, sd, up) => [o[0] + front[0] * f + side[0] * sd, o[1] + up, o[2] + front[2] * f + side[2] * sd];

  // hair: a low sphere around the skull, pushed out into spikes, cut back above the brow
  const sph = B.MeshBuilder.CreateSphere("hairTmp", { segments: 5, diameter: 2 }, mesh.getScene());
  const sp = sph.getVerticesData(K.PositionKind), si = sph.getIndices();
  const base = pos.length / 3;
  const centre = [H.c[0], top - r * 0.85, H.c[2]];
  const spike = new Map();   // one length per shared position, so spikes do not tear
  for (let i = 0; i < sp.length / 3; i++) {
    const x = sp[3 * i], y = sp[3 * i + 1], z = sp[3 * i + 2];
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    if (!spike.has(key)) spike.set(key, 1 + (rnd() < 0.5 ? 0.45 * rnd() : 0));
    let k = spike.get(key);
    // sphere axes: x to the side, z to the front, y up; the face stays free under the fringe
    let f = z * 1.12, u = y * 1.05 + 0.1, sd = x * 1.18;
    if (z > 0.2 && y < 0.4) { f = Math.min(f, 0.1 + 0.4 * Math.max(0, y)); k = Math.min(k, 1.08); }   // fringe line
    if (y < -0.45) u = -0.45 * 1.05 + 0.1 + (y + 0.45) * 0.4;                                        // none under the jaw
    if (z < 0) u -= 0.3 * k * -z * (y < 0.3 ? 1 : 0);                                                // longer at the back
    add(at(centre, f * r * k, sd * r * k, u * r * k), head, head, 0, 4);
  }
  for (const i of si) idx.push(base + i);
  sph.dispose();

  // face: two tall eyes and a mouth, a hair's breadth in front of the face
  const quad = (cs, cu, w, h, reg) => {
    const fz = r * 1.04;
    const a = add(at(H.c, fz, cs - w / 2, cu - h / 2), head, head, 0, reg);
    const b = add(at(H.c, fz, cs + w / 2, cu - h / 2), head, head, 0, reg);
    const c = add(at(H.c, fz, cs + w / 2, cu + h / 2), head, head, 0, reg);
    const d = add(at(H.c, fz, cs - w / 2, cu + h / 2), head, head, 0, reg);
    idx.push(a, b, c, a, c, d);
  };
  quad(-r * 0.36, r * 0.05, r * 0.22, r * 0.4, 5);
  quad(r * 0.36, r * 0.05, r * 0.22, r * 0.4, 5);
  quad(0, -r * 0.55, r * 0.32, r * 0.08, 5);

  // scarf: a strip from one hand to the other, in alternating colour blocks
  const N = 8, w = r * 0.9;
  for (let k = 0; k < N; k++) {
    const reg = k % 2 ? 7 : 6;
    const v = [k / N, (k + 1) / N].flatMap((t) => {
      const p = L.c.map((x, a) => x + (R.c[a] - x) * t);
      return [add([p[0], p[1] + w / 2, p[2]], hl, hr, t, reg), add([p[0], p[1] - w / 2, p[2]], hl, hr, t, reg)];
    });
    idx.push(v[0], v[1], v[3], v[0], v[3], v[2]);
  }

  const nv = pos.length / 3;
  const normals = [];
  B.VertexData.ComputeNormals(pos, idx, normals);
  // the loaded winding may be the other hand from Babylon's: orient by the body's own normals
  const n0 = mesh.getVerticesData(K.NormalKind);
  let agree = 0;
  for (let i = 0; i < 3 * nv0; i++) agree += n0[i] * normals[i];
  if (agree < 0) for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
  for (let i = 0; i < 3 * nv0; i++) normals[i] = n0[i];
  for (const kind of mesh.getVerticesDataKinds()) {
    if ([K.PositionKind, K.NormalKind, K.MatricesIndicesKind, K.MatricesWeightsKind].includes(kind)) continue;
    const d = mesh.getVerticesData(kind), out = new Float32Array(nv * (d.length / nv0));
    out.set(d);
    mesh.setVerticesData(kind, out, false);
  }
  mesh.setVerticesData(K.PositionKind, pos, false);
  mesh.setVerticesData(K.NormalKind, normals, false);
  mesh.setVerticesData(K.MatricesIndicesKind, mi, false);
  mesh.setVerticesData(K.MatricesWeightsKind, mw, false);
  mesh.setIndices(idx);
  return { region: Float32Array.from(region), info: { nv0, nv, tris: idx.length / 3, eyes: eyes.found, flipped: agree < 0, front, bones: [head, hl, hr], hands: L.found && R.found } };
}

// --- the crowd --------------------------------------------------------------------------------

// Shader plugin: the colour of each body region from per-instance shirt and skin colours.
class CrowdPlugin extends B.MaterialPluginBase {
  constructor(material) {
    super(material, "Crowd", 200, { CROWD: false });
    this._enable(true);
  }
  prepareDefines(defines) { defines.CROWD = true; }
  getClassName() { return "CrowdPlugin"; }
  getAttributes(attributes) { attributes.push("crowdRegion", "crowdShirt", "crowdSkin", "crowdHair"); }
  getCustomCode(shaderType, shaderLanguage) {
    if ((shaderLanguage ?? 0) !== B.ShaderLanguage.GLSL) return null;
    if (shaderType === "vertex") return {
      CUSTOM_VERTEX_DEFINITIONS: "#ifdef CROWD\nattribute float crowdRegion;\nattribute vec4 crowdShirt;\nattribute vec4 crowdSkin;\nattribute vec4 crowdHair;\nvarying vec3 vCrowd;\n#endif\n",
      // no scarf: its vertices fold into one point (a degenerate, invisible strip)
      CUSTOM_VERTEX_UPDATE_POSITION: "#ifdef CROWD\nif (crowdRegion > 5.5 && crowdShirt.a < 0.5) positionUpdated = vec3(0.0);\n#endif\n",
      CUSTOM_VERTEX_MAIN_END: `#ifdef CROWD
float rg = crowdRegion;
vCrowd = rg < 0.5 ? crowdSkin.rgb : rg < 1.5 ? crowdShirt.rgb : rg < 2.5 ? crowdSkin.a * vec3(0.17, 0.22, 0.38)
  : rg < 3.5 ? vec3(0.08, 0.07, 0.1) : rg < 4.5 ? crowdHair.rgb : rg < 5.5 ? vec3(0.07, 0.05, 0.1)
  : rg < 6.5 ? crowdShirt.rgb : vec3(0.96, 0.95, 0.9);
#endif
`,
    };
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: "#ifdef CROWD\nvarying vec3 vCrowd;\n#endif\n",
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: "#ifdef CROWD\nbaseColor.rgb = vCrowd;\n#endif\n",
    };
  }
}

// seats: [{x, y, z, rotY, end, fan, shirt: [r,g,b], skin: [r,g,b]}] in world metres (y: row floor).
// goals: [{ts, side}]. Returns {update(ts), people, mesh, state(i)} or null if the model fails.
export async function buildCrowd3D(scene, seats, goals, rnd, { outline = false } = {}) {
  if (!seats.length) return null;
  const c = await B.LoadAssetContainerAsync(SPECTATOR_URL, scene);
  c.addAllToScene();
  const mesh = c.meshes.find((m) => m.skeleton);
  mesh.name = "crowd3d";   // the perf test switches /^crowd/ off
  const skeleton = mesh.skeleton;
  const nodes = Object.fromEntries(c.transformNodes.map((t) => [t.name, t]));
  const groups = Object.fromEntries(c.animationGroups.map((g) => [g.name, g]));

  const list = [
    { name: "sit", clip: "Idle_Loop", sit: true, len: 2.5 },
    { name: "sitClap", clip: "M_clap", sit: true, len: 2 },
    { name: "stand", clip: "Idle_Loop", sit: false, len: 2.5 },
    { name: "rise", blend: true },
    { name: "armsUp", clip: "M_celeb_arms_up", sit: false, len: 3 },
    { name: "jump", clip: "M_celeb_jump_fist", sit: false, len: 3 },
    { name: "clap", clip: "M_clap", sit: false, len: 2 },
  ];
  // size: standing height from the head bone over the feet
  for (const g of Object.values(groups)) g.stop();
  for (const nd of Object.values(nodes)) nd.computeWorldMatrix(true);
  const F = mesh.computeWorldMatrix(true).clone();
  const parts = animeParts(mesh, skeleton, rnd);
  const { data, ranges } = bake(skeleton, mesh, groups, nodes, list);
  const tallRaw = nodes.Head.getAbsolutePosition().y - Math.min(nodes.foot_l.getAbsolutePosition().y, nodes.foot_r.getAbsolutePosition().y);
  const scale = HEIGHT / (tallRaw * 1.12);   // the head bone sits about 11% under the top of the head
  for (const g of c.animationGroups) g.dispose();

  const baker = new B.VertexAnimationBaker(scene, mesh);
  const vat = baker.textureFromBakedVertexData(data);
  const manager = new B.BakedVertexAnimationManager(scene);
  manager.texture = vat;
  mesh.bakedVertexAnimationManager = manager;

  mesh.setVerticesData("crowdRegion", parts.region, false, 1);

  const m = new B.StandardMaterial("crowd3d", scene);
  m.specularColor = new B.Color3(0, 0, 0);
  m.backFaceCulling = false;   // the scarf and the face are single sheets
  m.twoSidedLighting = true;
  m.crowd = new CrowdPlugin(m);
  m.toon = new ToonPlugin(m);
  mesh.material = m;
  // the mesh keeps its loaded world matrix F; instance x F = F x D, so D places the seat
  const Finv = F.clone().invert();

  const n = seats.length;
  const mats = new Float32Array(16 * n), shirt = new Float32Array(4 * n), skin = new Float32Array(4 * n), hair = new Float32Array(4 * n);
  const vatSet = new Float32Array(4 * n);
  const people = [];
  const cheers = ["armsUp", "armsUp", "jump", "clap"];
  const D = new B.Matrix(), q = new B.Quaternion(), M = new B.Matrix();
  seats.forEach((s, i) => {
    const k = scale * (0.93 + 0.12 * rnd());
    B.Quaternion.RotationYawPitchRollToRef(s.rotY + Math.PI + (rnd() - 0.5) * 0.35, 0, 0, q);
    B.Matrix.ComposeToRef(new B.Vector3(k, k, k), q, new B.Vector3(s.x, s.y, s.z), D);
    // instance x mesh world = F x D: the loaded orientation first, then the seat
    F.multiplyToRef(D, M); M.multiplyToRef(Finv, M);
    M.copyToArray(mats, 16 * i);
    // scarf: about half the fans, in their team's colours (a = 1 shows it)
    shirt.set([...s.shirt, s.fan && rnd() < 0.55 ? 1 : 0], 4 * i);
    skin.set([...s.skin, 0.7 + 0.6 * rnd()], 4 * i);
    hair.set([...s.hair, 1], 4 * i);
    const r = rnd();
    const base = r < 0.06 ? "sitClap" : r < 0.1 ? "stand" : "sit";
    const p = {
      fan: s.fan, end: s.end, base,
      offset: Math.floor(rnd() * 1000), speed: BAKE_FPS * (0.85 + 0.3 * rnd()),
      delay: REACT.delay[0] + (REACT.delay[1] - REACT.delay[0]) * rnd(),
      stay: REACT.stay[0] + (REACT.stay[1] - REACT.stay[0]) * rnd(),
      cheer: cheers[Math.floor(rnd() * cheers.length)],
      pose: null,
    };
    people.push(p);
  });
  mesh.thinInstanceSetBuffer("matrix", mats, 16, true);
  mesh.thinInstanceSetBuffer("crowdShirt", shirt, 4, true);
  mesh.thinInstanceSetBuffer("crowdSkin", skin, 4, true);
  mesh.thinInstanceSetBuffer("crowdHair", hair, 4, true);
  mesh.thinInstanceSetBuffer("bakedVertexAnimationSettingsInstanced", vatSet, 4, false);
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.isPickable = false;
  if (outline) {
    // thin ink line of the inverted hull; the outline pass knows the baked animation
    mesh.renderOutline = true;
    mesh.outlineWidth = 0.012;
    mesh.outlineColor = new B.Color3(0.08, 0.05, 0.12);
  }

  const settings = (i, pose) => {
    const p = people[i];
    let r, off = p.offset, speed = p.speed;
    if (!pose) r = ranges[p.base];
    else {
      r = ranges[pose.clip];
      const frames = r[1] - r[0] + 1;
      // pinned frame (speed 0): non-looping playback straight from match time
      off = pose.clip === "rise" ? Math.round(Math.min(1, Math.max(0, pose.t)) * (frames - 1)) : Math.floor(pose.t * BAKE_FPS) % frames;
      speed = 0;
    }
    vatSet[4 * i] = r[0]; vatSet[4 * i + 1] = r[1]; vatSet[4 * i + 2] = off; vatSet[4 * i + 3] = speed;
  };
  people.forEach((_, i) => settings(i, null));
  mesh.thinInstanceBufferUpdated("bakedVertexAnimationSettingsInstanced");

  let dirty = true;
  const crowd = {
    mesh, people, ranges, scale, parts: parts.info,
    update(ts) {
      manager.time = ts;
      let changed = false;
      people.forEach((p, i) => {
        const pose = reaction(p, goals, ts);
        if (!pose && !p.pose) return;
        p.pose = pose;
        settings(i, pose);
        changed = true;
      });
      if (changed || dirty) mesh.thinInstanceBufferUpdated("bakedVertexAnimationSettingsInstanced");
      dirty = changed;   // one more upload after the last change puts everyone back on their loop
    },
    // for the tests: the clip a spectator shows at ts
    clipAt(i, ts) { return reaction(people[i], goals, ts)?.clip ?? people[i].base; },
  };
  return crowd;
}
