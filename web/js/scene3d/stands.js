// Procedural stadium: four raked stands with roofs, a seated crowd drawn as thin-instanced quads
// (one draw call per shirt or skin colour), LED boards and four floodlight masts.
// Everything here is static: world matrices and materials are frozen.
const B = window.BABYLON;
const HALF_L = 52.5, HALF_W = 34;

// Seats of one stand, in the stand's own frame: x along the stand, d outwards from the front
// wall, h above the ground. A single tier rising 15.5 m over its depth, first row 1.5 m up.
export function seatGrid(len, depth, density, rnd) {
  const seats = [];
  const rowStep = 0.85 / Math.sqrt(density), seatStep = 0.55 / Math.sqrt(density);
  for (let d = 0.9; d < depth - 0.4; d += rowStep) {
    const h = 1.5 + 15.5 * (d / depth);
    for (let x = -len / 2 + 1.2; x < len / 2 - 1.2; x += seatStep) {
      if (Math.abs(((x + len / 2) % 20) - 10) < 0.8) continue;   // aisles every 20 m
      if (rnd() < 0.1) continue;                                   // empty seats
      seats.push([x + (rnd() - 0.5) * 0.12, d, h]);
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
  const people = [];   // [worldX, worldY, worldZ, rotY]
  // gantry: the near side, where the broadcast camera sits; no roof or side walls to frame it
  const stand = (len, front, depth, rotY, gantry = false) => {
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
    for (const [x, d, h] of gantry ? [] : seatGrid(len, depth, profile.crowd, rnd)) {
      const z = front + d;
      people.push([x * c + z * s, h, -x * s + z * c, rotY]);
    }
  };
  // the side stands run to the back of the end stands, closing the corners
  const sideLen = 2 * (HALF_L + 9 + 22);
  stand(sideLen, HALF_W + 9, 26, 0);                // far side
  stand(sideLen, HALF_W + 9, 26, Math.PI, true);    // near side
  stand(80, HALF_L + 9, 22, Math.PI / 2);   // right end
  stand(80, HALF_L + 9, 22, -Math.PI / 2);  // left end
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
  // a cheap lit material, not PBR: an alpha-tested PBR albedo samples as empty under WebGL 1 on
  // the software test renderer (lavapipe), and a crowd needs no image-based light
  const crowdMat = (name, tex, rgb) => {
    const m = new B.StandardMaterial(name, scene);
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
  const skins = ["#f1c9a5", "#e0ac83", "#c68a62", "#8d5a3b", "#5c3a24"].map((h) => dim(lin(h), 1));
  const torsos = shirts.map(() => []), faces = skins.map(() => []);
  const m = new B.Matrix(), q = new B.Quaternion(), one = new B.Vector3(1, 1, 1), pos = new B.Vector3();
  for (const [x, y, z, rotY] of people) {
    // planes face -Z by default; turn them to face the pitch like the stand
    B.Quaternion.RotationYawPitchRollToRef(rotY + Math.PI, 0, 0, q);
    pos.set(x, y + 0.42 + rnd() * 0.06, z);
    const homeEnd = (x < 0) === (match.home.side === "home");
    const r = rnd(), shade = rnd() < 0.5 ? 1 : 0;
    const shirt = r < 0.5 ? (homeEnd ? 0 : 2) + shade : r < 0.62 ? (homeEnd ? 2 : 0) + shade : 4 + Math.floor(rnd() * neutral.length);
    B.Matrix.ComposeToRef(one, q, pos, m); torsos[shirt].push(...m.m);
    pos.y += 0.38;
    B.Matrix.ComposeToRef(one, q, pos, m); faces[Math.floor(rnd() * skins.length)].push(...m.m);
  }
  const n = people.length;
  const crowd = (name, w, h, tex, cols, groups) => groups.forEach((list, k) => {
    if (!list.length) return;
    const mesh = B.MeshBuilder.CreatePlane(`${name}${k}`, { width: w, height: h }, scene);
    mesh.material = crowdMat(`${name}Mat${k}`, tex, cols[k]);
    mesh.thinInstanceSetBuffer("matrix", new Float32Array(list), 16, true);
    mesh.freezeWorldMatrix();
    mesh.alwaysSelectAsActiveMesh = true;   // one bounding box for the whole group
    mesh.material.freeze();
  });
  crowd("crowdTorso", 0.5, 0.55, torsoTex, shirts, torsos);
  crowd("crowdHead", 0.2, 0.25, headTex, skins, faces);

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
  return { people: n };
}
