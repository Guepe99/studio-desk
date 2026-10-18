// Procedural stadium: four raked stands with roofs, LED boards and four floodlight masts, and the
// crowd: the front rows as low-poly 3D spectators (crowd.js, built after the players load), the
// rows behind as thin-instanced cards (one draw call per shirt or skin colour) that jump when their
// end celebrates a goal. Industry practice is the same split: instanced 3D near the pitch,
// impostors further out (docs/scene3d-research.md, section F).
// Everything else here is static: world matrices and materials are frozen.
import { buildCrowd3D, HAIR } from "./crowd.js";
import { toonMaterial } from "./toon.js";

const B = window.BABYLON;
const HALF_L = 52.5, HALF_W = 34;

// Seats of one stand, in the stand's own frame: x along the stand, d outwards from the front
// wall, h above the ground, row from the front (0). A single tier rising 15.5 m over its depth,
// first row 1.5 m up.
export function seatGrid(len, depth, density, rnd) {
  const seats = [];
  const rowStep = 0.85 / Math.sqrt(density), seatStep = 0.55 / Math.sqrt(density);
  for (let d = 0.9, row = 0; d < depth - 0.4; d += rowStep, row++) {
    const h = 1.5 + 15.5 * (d / depth);
    for (let x = -len / 2 + 1.2; x < len / 2 - 1.2; x += seatStep) {
      if (Math.abs(((x + len / 2) % 20) - 10) < 0.8) continue;   // aisles every 20 m
      if (rnd() < 0.1) continue;                                   // empty seats
      seats.push([x + (rnd() - 0.5) * 0.12, d, h, row]);
    }
  }
  return seats;
}

function canvasTexture(scene, name, w, h, draw, alpha = false) {
  const tex = new B.DynamicTexture(name, { width: w, height: h }, scene, true);
  draw(tex.getContext(), w, h);
  tex.update(true);
  tex.hasAlpha = alpha;
  return tex;
}

// Who sits where: the home end (world x < 0) and the long stand are mostly home shirts, the away
// end mostly away shirts, the rest neutral. fan: "home", "away" or null.
export const SHIRT_SHARE = { home: [0.66, 0.04], side: [0.5, 0.08], away: [0.12, 0.58] };   // [home, away]
export function pickFan(end, r) {
  const [h, a] = SHIRT_SHARE[end];
  return r < h ? "home" : r < h + a ? "away" : null;
}

// Cards jump when their end, or their team, celebrates: a vertex offset in the shader driven by
// the time since the last goal (crowdGoal: since, side +1 home / -1 away, match time, this
// material's team +1 / -1 / 0). Per-card delay and length come from a hash of its position, with
// the same ranges as the 3D spectators (crowd.js REACT).
class CardJumpPlugin extends B.MaterialPluginBase {
  constructor(material, team, state) {
    super(material, "CardJump", 210, { CARDJUMP: false });
    this.team = team;
    this.state = state;
    this._enable(true);
  }
  prepareDefines(defines) { defines.CARDJUMP = true; }
  getClassName() { return "CardJumpPlugin"; }
  getUniforms() {
    return { ubo: [{ name: "crowdGoal", size: 4, type: "vec4" }], vertex: "#ifdef CARDJUMP\nuniform vec4 crowdGoal;\n#endif\n" };
  }
  bindForSubMesh(ubo) { ubo.updateFloat4("crowdGoal", this.state.since, this.state.side, this.state.time, this.team); }
  getCustomCode(shaderType, shaderLanguage) {
    if (shaderType !== "vertex" || (shaderLanguage ?? 0) !== B.ShaderLanguage.GLSL) return null;
    return {
      CUSTOM_VERTEX_UPDATE_WORLDPOS: `#ifdef CARDJUMP
{
  vec3 o = finalWorld[3].xyz;
  float endSide = abs(o.x) > ${(HALF_L + 8).toFixed(1)} && abs(o.z) < ${(HALF_W + 8).toFixed(1)} ? -sign(o.x) : 0.0;   // +1 home end (x < 0)
  bool mine = crowdGoal.y != 0.0 && (endSide == crowdGoal.y || crowdGoal.w == crowdGoal.y);
  float h = fract(sin(dot(o.xz, vec2(12.9898, 78.233))) * 43758.5453);
  float t = crowdGoal.x - mix(0.2, 1.6, h);
  float stay = mix(7.0, 9.3, fract(h * 7.13));
  float env = mine ? smoothstep(0.0, 0.5, t) * (1.0 - smoothstep(stay, stay + 0.7, t)) : 0.0;
  worldPos.y += env * (0.3 + 0.12 * abs(sin(crowdGoal.z * 7.0 + h * 40.0)));
}
#endif
`,
    };
  }
}

// Flags held up in the stands: plain team colours, waving by a sine wave in the vertex shader
// that grows from the pole to the free edge (amplitude 0.22 m, 0.7 cycles along the flag).
class FlagWavePlugin extends B.MaterialPluginBase {
  constructor(material, state, width) {
    super(material, "FlagWave", 220, { FLAGWAVE: false });
    this.state = state;
    this.width = width;
    this._enable(true);
  }
  prepareDefines(defines) { defines.FLAGWAVE = true; }
  getClassName() { return "FlagWavePlugin"; }
  getUniforms() {
    return { ubo: [{ name: "flagWave", size: 2, type: "vec2" }], vertex: "#ifdef FLAGWAVE\nuniform vec2 flagWave;\n#endif\n" };
  }
  bindForSubMesh(ubo) { ubo.updateFloat2("flagWave", this.state.time, this.width); }
  getCustomCode(shaderType, shaderLanguage) {
    if (shaderType !== "vertex" || (shaderLanguage ?? 0) !== B.ShaderLanguage.GLSL) return null;
    return {
      CUSTOM_VERTEX_UPDATE_WORLDPOS: `#ifdef FLAGWAVE
{
  float a = clamp(position.x / flagWave.y + 0.5, 0.0, 1.0);
  float ph = dot(finalWorld[3].xz, vec2(0.37, 0.61));
  worldPos.xyz += normalize(finalWorld[1].xyz) * sin(flagWave.x * 4.2 - a * 4.4 + ph) * 0.22 * a;
}
#endif
`,
    };
  }
}

function mat(scene, name, rgb, roughness = 0.85) {
  const m = new B.PBRMaterial(name, scene);
  m.albedoColor = new B.Color3(...rgb);
  m.metallic = 0;
  m.roughness = roughness;
  return m;
}

export function buildStadium(scene, match, profile, rnd) {
  const concrete = mat(scene, "concrete", [0.32, 0.33, 0.35]);
  const seatMat = mat(scene, "seats", [0.03, 0.04, 0.07], 1);
  seatMat.metallicF0Factor = 0;   // no sky reflection: seen at a grazing angle the rows turned grey
  const roofMat = mat(scene, "roof", [0.55, 0.57, 0.6], 0.5);
  roofMat.backFaceCulling = false;

  const tiers = [], shells = [], roofs = [];
  const people = [];   // [worldX, worldY, worldZ, rotY, end, row]
  // gantry: the near side, where the broadcast camera sits; no roof or side walls to frame it
  const stand = (len, front, depth, rotY, end, gantry = false) => {
    const root = new B.TransformNode("stand", scene);
    root.rotation.y = rotY;
    const rake = Math.atan2(15.5, depth), slope = Math.hypot(15.5, depth);
    const t = B.MeshBuilder.CreatePlane("tier", { width: len, height: slope }, scene);
    t.parent = root; t.rotation.x = Math.PI / 2 - rake; t.position.set(0, 1.5 + 7.75, front + depth / 2);
    tiers.push(t);
    const wall = B.MeshBuilder.CreateBox("w", { width: len, height: 1.5, depth: 0.4 }, scene);
    wall.parent = root; wall.position.set(0, 0.75, front); shells.push(wall);
    const back = B.MeshBuilder.CreateBox("bk", { width: len, height: 27, depth: 1 }, scene);
    back.parent = root; back.position.set(0, 13.5, front + depth + 0.5); shells.push(back);
    if (!gantry) {
      const roof = B.MeshBuilder.CreateBox("rf", { width: len + 1, height: 0.6, depth: depth * 0.8 }, scene);
      roof.parent = root; roof.position.set(0, 25.5, front + depth * 0.6); roof.rotation.x = -0.06; roofs.push(roof);
      const fascia = B.MeshBuilder.CreateBox("fa", { width: len + 1, height: 1.6, depth: 0.3 }, scene);
      fascia.parent = root; fascia.position.set(0, 25.2, front + depth * 0.2); shells.push(fascia);
      for (const sx of [-1, 1]) {
        const side = B.MeshBuilder.CreateBox("sd", { width: 0.6, height: 27, depth }, scene);
        side.parent = root; side.position.set(sx * len / 2, 13.5, front + depth / 2); tiers.push(side);   // seat colour: in the wide shot a grey end wall read as sky
      }
    }
    // stand frame -> world: local (x, h, front + d), turned by rotY (rotY 0 faces -Z, the pitch)
    const c = Math.cos(rotY), s = Math.sin(rotY);
    // no crowd under the camera: the nearest heads would fill the bottom of the broadcast frame
    for (const [x, d, h, row] of gantry ? [] : seatGrid(len, depth, profile.crowd, rnd)) {
      const z = front + d;
      people.push([x * c + z * s, h, -x * s + z * c, rotY, end, row]);
    }
  };
  // the side stands run to the back of the end stands, closing the corners
  const sideLen = 2 * (HALF_L + 9 + 22);
  stand(sideLen, HALF_W + 9, 26, 0, "side");                // far side
  stand(sideLen, HALF_W + 9, 26, Math.PI, "side", true);    // near side
  stand(80, HALF_L + 9, 22, Math.PI / 2, "away");   // right end (x > 0)
  stand(80, HALF_L + 9, 22, -Math.PI / 2, "home");  // left end (x < 0)
  const merge = (list, m) => {
    for (const x of list) x.computeWorldMatrix(true);
    const out = B.Mesh.MergeMeshes(list, true, true);
    out.material = m; out.freezeWorldMatrix(); out.doNotSyncBoundingInfo = true;
    return out;
  };
  merge(tiers, seatMat); merge(shells, concrete); merge(roofs, roofMat);

  // crowd: a torso and a head per seat. Shirts lean to the two kits, by end of the ground.
  // Silhouettes as raw pixels, not canvas drawings: small canvas textures came out empty under
  // WebGL 1 on the software test renderer (lavapipe), which hid the whole crowd there.
  // inside(u, v): u across, v down, both 0..1.
  const mask = (name, inside) => {
    const S = 64, px = new Uint8Array(S * S * 4).fill(255);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px[(y * S + x) * 4 + 3] = inside((x + 0.5) / S, (y + 0.5) / S) ? 255 : 0;
    const t = B.RawTexture.CreateRGBATexture(px, S, S, scene, true, true, B.Texture.TRILINEAR_SAMPLINGMODE);
    t.name = name; t.hasAlpha = true;
    return t;
  };
  // shoulders round off from 0.12 to 0.35 down, the body widens to the bottom edge
  const torsoTex = mask("torso", (u, v) => v > 0.12 && Math.abs(u - 0.5) < (v < 0.35 ? 0.27 + 0.11 * Math.sqrt((v - 0.12) / 0.23) : 0.38 + 0.08 * v));
  const headTex = mask("head", (u, v) => ((u - 0.5) / 0.34) ** 2 + ((v - 0.5) / 0.44) ** 2 < 1);
  // anime hair over the head card: a spiky crown and sides, the face left free under the fringe
  const hairTex = mask("hair", (u, v) => {
    const dx = (u - 0.5) / 0.46, dy = (v - 0.52) / 0.46;
    const spikes = 0.12 * Math.max(0, Math.cos(u * Math.PI * 9)) * (v < 0.4 ? 1 : 0);
    if (dx * dx + dy * dy > (1 + spikes) ** 2) return false;
    return v < 0.36 || Math.abs(u - 0.5) > 0.3 - 0.25 * Math.max(0, v - 0.7);
  });
  // a cheap lit material, not PBR: an alpha-tested PBR albedo samples as empty under WebGL 1 on
  // the software test renderer (lavapipe), and a crowd needs no image-based light
  const cheer = { since: 99, side: 0, time: 0 };
  const crowdMat = (name, tex, rgb, team = 0) => {
    const m = new B.StandardMaterial(name, scene);
    m.cardJump = new CardJumpPlugin(m, team, cheer);
    m.diffuseColor = new B.Color3(...rgb);
    m.emissiveColor = new B.Color3(...rgb).scale(0.35);
    m.specularColor = B.Color3.Black();
    m.diffuseTexture = tex;
    m.useAlphaFromDiffuseTexture = true;
    m.transparencyMode = B.Material.MATERIAL_ALPHATEST;
    m.alphaCutOff = 0.5;
    m.backFaceCulling = false;
    return m;
  };
  // colours go by mesh: one draw call per shirt or skin colour
  const lin = (hex) => B.Color3.FromHexString(hex).toLinearSpace();
  const dim = (c, k) => [c.r * k, c.g * k, c.b * k];
  const home = lin(match.home.color_primary), away = lin(match.away.color_primary);
  const neutral = ["#e8e8e8", "#1d2230", "#3b4660", "#6b6f78", "#8a2b2b", "#2f5d8a", "#c9b48a"].map(lin);
  const shirts = [dim(home, 1), dim(home, 0.75), dim(away, 1), dim(away, 0.75), ...neutral.map((c) => dim(c, 0.9))];
  const shirtTeam = [1, 1, -1, -1, ...neutral.map(() => 0)];
  const skins = ["#f1c9a5", "#e0ac83", "#c68a62", "#8d5a3b", "#5c3a24"].map((h) => dim(lin(h), 1));
  const torsos = shirts.map(() => []), faces = skins.map(() => []), hairs = HAIR.map(() => []);
  // the 3D spectators are toon shaded in display (gamma) colours, flat and saturated
  const gam = (hex) => B.Color3.FromHexString(hex).asArray();
  const near3d = {
    shirts: [home.toGammaSpace().asArray(), home.toGammaSpace().scale(0.85).asArray(), away.toGammaSpace().asArray(), away.toGammaSpace().scale(0.85).asArray(),
      ...["#f4f4f0", "#2b3a6b", "#59b8ff", "#ffd23f", "#ff7eb6", "#3cc48a", "#ff8a3d"].map(gam)],
    skins: ["#ffe1c8", "#f5c7a1", "#d9a074", "#a5704a", "#6e4630"].map(gam),
    hair: HAIR.map(gam),
  };
  const near = [];   // seats of the 3D spectators
  const m = new B.Matrix(), q = new B.Quaternion(), one = new B.Vector3(1, 1, 1), pos = new B.Vector3();
  for (const [x, y, z, rotY, end, row] of people) {
    const fan = pickFan(end, rnd()), shade = rnd() < 0.5 ? 1 : 0;
    const shirt = fan === "home" ? shade : fan === "away" ? 2 + shade : 4 + Math.floor(rnd() * neutral.length);
    const skin = Math.floor(rnd() * skins.length), hair = Math.floor(rnd() * HAIR.length);
    if (row < profile.crowd3dRows) {
      near.push({ x, y, z, rotY, end, fan, shirt: near3d.shirts[shirt], skin: near3d.skins[skin], hair: near3d.hair[hair] });
      continue;
    }
    // planes face -Z by default; turn them to face the pitch like the stand
    B.Quaternion.RotationYawPitchRollToRef(rotY + Math.PI, 0, 0, q);
    pos.set(x, y + 0.42 + rnd() * 0.06, z);
    B.Matrix.ComposeToRef(one, q, pos, m); torsos[shirt].push(...m.m);
    pos.y += 0.38;
    B.Matrix.ComposeToRef(one, q, pos, m); faces[skin].push(...m.m);
    pos.y += 0.03;   // same x and z as the head: the card jump hashes them alike
    B.Matrix.ComposeToRef(one, q, pos, m); hairs[hair].push(...m.m);
  }
  const n = people.length;
  const crowd = (name, w, h, tex, cols, groups, teams) => groups.forEach((list, k) => {
    if (!list.length) return;
    const mesh = B.MeshBuilder.CreatePlane(`${name}${k}`, { width: w, height: h }, scene);
    mesh.material = crowdMat(`${name}Mat${k}`, tex, cols[k], teams?.[k] ?? 0);
    mesh.thinInstanceSetBuffer("matrix", new Float32Array(list), 16, true);
    mesh.freezeWorldMatrix();
    mesh.alwaysSelectAsActiveMesh = true;   // one bounding box for the whole group
  });
  crowd("crowdTorso", 0.5, 0.55, torsoTex, shirts, torsos, shirtTeam);
  crowd("crowdHead", 0.2, 0.25, headTex, skins, faces);
  crowd("crowdHair", 0.27, 0.3, hairTex, HAIR.map(lin).map((c) => dim(c, 1)), hairs);
  for (const k of HAIR.keys()) { const h = scene.getMaterialByName(`crowdHairMat${k}`); if (h) h.zOffset = -2; }   // drawn over its head

  // flags: a few fans per crowded stand hold one up, home colours in the home end and the long
  // stand, away colours in the away end
  const FW = 2.2, FH = 1.4, POLE = 3.4;
  const flagMesh = (name, rgb) => {
    const f = B.MeshBuilder.CreateGround(name, { width: FW, height: FH, subdivisions: 10 }, scene);
    const fm = toonMaterial(scene, `${name}Mat`, rgb);
    fm.backFaceCulling = false; fm.twoSidedLighting = true;
    fm.wave = new FlagWavePlugin(fm, cheer, FW);
    f.material = fm;
    return f;
  };
  const flags = { home: [], away: [] }, poles = [];
  const rows = people.filter((p) => p[5] >= 1 && p[5] <= 5 && p[4] !== "side" || p[5] >= 1 && p[5] <= 3 && p[4] === "side" && Math.abs(p[0]) < 50);
  const fq = new B.Quaternion(), along = new B.Vector3();
  for (let k = 0; k < 12 && rows.length; k++) {
    const [x, y, z, rotY, end] = rows[Math.floor(rnd() * rows.length)];
    along.set(Math.cos(rotY), 0, -Math.sin(rotY));
    B.Quaternion.RotationYawPitchRollToRef(rotY, -Math.PI / 2, 0, fq);
    pos.set(x, y + POLE - FH / 2, z).addInPlace(along.scale(FW / 2));
    B.Matrix.ComposeToRef(one, fq, pos, m);
    flags[end === "away" ? "away" : "home"].push(...m.m);
    B.Matrix.TranslationToRef(x, y + POLE / 2, z, m); poles.push(...m.m);
  }
  for (const [side, rgb] of [["home", home.toGammaSpace()], ["away", away.toGammaSpace()]]) {
    if (!flags[side].length) continue;
    const f = flagMesh(`flag-${side}`, rgb.asArray());
    f.thinInstanceSetBuffer("matrix", new Float32Array(flags[side]), 16, true);
    f.alwaysSelectAsActiveMesh = true;
  }
  if (poles.length) {
    const pl = B.MeshBuilder.CreateCylinder("flagPole", { height: POLE, diameter: 0.05, tessellation: 5 }, scene);
    pl.material = toonMaterial(scene, "flagPoleMat", [0.85, 0.85, 0.82]);
    pl.thinInstanceSetBuffer("matrix", new Float32Array(poles), 16, true);
    pl.alwaysSelectAsActiveMesh = true;
  }

  // LED boards round the pitch
  const boardTex = canvasTexture(scene, "boards", 1024, 64, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, "#0e1a3d"); grd.addColorStop(0.5, "#16306e"); grd.addColorStop(1, "#0e1a3d");
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.fillStyle = "#2ec4f1"; g.fillRect(0, h - 8, w, 8);
    g.font = "800 40px 'Barlow Condensed', 'Arial Narrow', sans-serif"; g.textBaseline = "middle";
    g.fillStyle = "#ffffff";
    for (let x = 30; x < w; x += 340) g.fillText("STUDIO DESK", x, h / 2 - 2);
  });
  boardTex.wrapU = B.Texture.WRAP_ADDRESSMODE;
  const boardMat = new B.StandardMaterial("boardMat", scene);
  boardMat.diffuseTexture = boardTex; boardMat.emissiveTexture = boardTex;
  boardMat.disableLighting = true;
  const boards = [];
  const board = (len, x, z, rotY) => {
    const b = B.MeshBuilder.CreatePlane("bd", { width: len, height: 0.9 }, scene);
    const uv = b.getVerticesData(B.VertexBuffer.UVKind);
    for (let i = 0; i < uv.length; i += 2) uv[i] *= len / 16;
    b.setVerticesData(B.VertexBuffer.UVKind, uv);
    b.position.set(x, 0.45, z); b.rotation.y = rotY; boards.push(b);
  };
  board(110, 0, HALF_W + 5, 0);
  board(110, 0, -HALF_W - 5, Math.PI);
  for (const s of [-1, 1]) for (const z of [-20, 20]) board(28, s * (HALF_L + 4), z, s * Math.PI / 2);
  merge(boards, boardMat);

  // floodlight masts, lamps off in daylight
  const lampMat = mat(scene, "lamps", [0.12, 0.13, 0.15], 0.4);
  const masts = [], heads = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const base = new B.Vector3(sx * (HALF_L + 22), 0, sz * (HALF_W + 30));
    const mast = B.MeshBuilder.CreateCylinder("mast", { diameterTop: 0.9, diameterBottom: 1.8, height: 46, tessellation: 8 }, scene);
    mast.position.set(base.x, 23, base.z); masts.push(mast);
    const lamp = B.MeshBuilder.CreateBox("lampHead", { width: 11, height: 5.5, depth: 0.8 }, scene);
    lamp.position.set(base.x, 46, base.z);
    lamp.lookAt(new B.Vector3(0, -20, 0));
    heads.push(lamp);
  }
  merge(masts, concrete); merge(heads, lampMat);

  for (const x of [concrete, seatMat, roofMat, lampMat, boardMat]) x.freeze();
  // the goals of the match data (score facts), never invented
  const goals = match.goals.filter((f) => f.value > 0).map((f) => ({ ts: f.ts, side: match.teams[f.team_id].side }));
  const stadium = {
    people: n, near: near.length, cards: n - near.length, goals, cheer, crowd3d: null,
    // the 3D spectators, after the players so the page shows the pitch first
    async load() { stadium.crowd3d = await buildCrowd3D(scene, near, goals, rnd, { outline: profile.crowdOutline }); },
    update(ts) {
      const g = goals.filter((x) => x.ts <= ts && ts - x.ts < 12).pop();   // the last goal drives the cards
      cheer.since = g ? ts - g.ts : 99;
      cheer.side = g ? (g.side === "home" ? 1 : -1) : 0;
      cheer.time = ts;
      stadium.crowd3d?.update(ts);
    },
  };
  return stadium;
}
