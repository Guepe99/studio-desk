// 3D broadcast scene (Babylon.js 9, global BABYLON from web/vendor/babylonjs/).
// Floodlit stadium, a side TV camera that pans and zooms on the ball, a behind-the-goal replay
// camera, Quaternius mannequins driven by tracking.f32 with speed-matched locomotion clips.
//
// World axes: X = contract x - 52.5 (along the pitch), Z = contract y - 34 (across), Y up.
// The TV camera stands on the y < 0 side, so x grows to the right as on the 2D pitch.

const B = window.BABYLON;
const HALF_L = 52.5, HALF_W = 34;
const P = (x, y, h = 0) => new B.Vector3(x - HALF_L, h, y - HALF_W);

// Locomotion clips of the Universal Animation Library: speed (m/s) at which the feet do not
// slide when the clip plays at 1x, and metres per cycle (measured from the root-motion version).
const CLIPS = [
  { name: "Idle_Loop", speed: 0, stride: 0, period: 2.5 },
  { name: "Walk_Loop", speed: 0.975, stride: 1.3 },
  { name: "Jog_Fwd_Loop", speed: 5.357, stride: 5.0 },
  { name: "Sprint_Loop", speed: 8.25, stride: 5.5 },
];
const PLAYER_H = 1.82;      // metres
const BALL_R = 0.17;        // drawn about 1.5x real size so it reads on a phone
const TV_POS = P(52.5, -30, 21);

const smoothstep = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const hex = (h) => B.Color3.FromHexString(h);

// Weights of the four clips for a ground speed (two neighbours at a time, summing to 1).
export function clipWeights(v) {
  const w = [0, 0, 0, 0];
  if (v >= CLIPS[3].speed) { w[3] = 1; return w; }
  for (let i = 0; i < 3; i++) {
    const a = CLIPS[i].speed, b = CLIPS[i + 1].speed;
    if (v < b) { const t = Math.max(0, (v - a) / (b - a)); w[i] = 1 - t; w[i + 1] = t; return w; }
  }
  return w;
}

function canvasTexture(scene, name, w, h, draw, opts = {}) {
  const tex = new B.DynamicTexture(name, { width: w, height: h }, scene, opts.mipmaps ?? true);
  const g = tex.getContext();
  draw(g, w, h);
  tex.update(opts.invertY ?? true);
  tex.hasAlpha = !!opts.alpha;
  tex.anisotropicFilteringLevel = opts.aniso ?? 4;
  return tex;
}

function flatMat(scene, name, color, emissive = null) {
  const m = new B.StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = new B.Color3(0.05, 0.05, 0.05);
  if (emissive) m.emissiveColor = emissive;
  return m;
}

export class Scene3D {
  static async create(canvas, match, opts) {
    const s = new Scene3D(canvas, match, opts);
    await s._loadPlayers();
    return s;
  }

  constructor(canvas, match, { capture = false, entities, goalEnd = 1 }) {
    this.canvas = canvas;
    this.match = match;
    this.goalEnd = goalEnd;
    this.entities = entities;
    const engine = this.engine = new B.Engine(canvas, true, { preserveDrawingBuffer: capture, stencil: false, powerPreference: "high-performance" }, true);
    const scene = this.scene = new B.Scene(engine);
    scene.clearColor = new B.Color4(0.015, 0.025, 0.06, 1);
    scene.ambientColor = new B.Color3(0.25, 0.27, 0.32);
    scene.skipPointerMovePicking = true;
    scene.constantlyUpdateMeshUnderPointer = false;

    // Light: a cool sky fill and one warm key from the floodlights. No shadow maps: the four
    // floodlight shadows under each player are a baked decal.
    const hemi = new B.HemisphericLight("sky", new B.Vector3(0, 1, 0), scene);
    hemi.intensity = 0.55;
    hemi.diffuse = new B.Color3(0.8, 0.86, 1);
    hemi.groundColor = new B.Color3(0.16, 0.2, 0.16);
    const key = new B.DirectionalLight("flood", new B.Vector3(-0.35, -1, 0.5), scene);
    key.intensity = 0.95;
    key.diffuse = new B.Color3(1, 0.97, 0.9);
    key.specular = new B.Color3(0.3, 0.3, 0.3);

    this.tv = new B.FreeCamera("tv", TV_POS.clone(), scene);
    this.tv.minZ = 5; this.tv.maxZ = 600;
    // raised and off-axis behind the goal, so the net sits below the line of sight
    this.goalCam = new B.FreeCamera("goal", P(52.5 + goalEnd * 63, 34 + 7, 7.5), scene);
    this.goalCam.minZ = 0.3; this.goalCam.maxZ = 600;
    scene.activeCamera = this.tv;

    this._pitch();
    this._goals();
    this._stadium();
    this._ball();

    const pipe = this.pipeline = new B.DefaultRenderingPipeline("broadcast", true, scene, [this.tv, this.goalCam]);
    pipe.samples = capture ? 1 : 4;
    pipe.fxaaEnabled = true;
    pipe.bloomEnabled = true;
    pipe.bloomThreshold = 2.0;   // only the lamps (emissive 2.6) bloom, not lit kits or nets
    pipe.bloomWeight = 0.55;
    pipe.bloomKernel = 48;
    pipe.bloomScale = 0.5;
    pipe.imageProcessingEnabled = true;
    pipe.imageProcessing.toneMappingEnabled = true;
    pipe.imageProcessing.toneMappingType = B.ImageProcessingConfiguration.TONEMAPPING_ACES;
    pipe.imageProcessing.exposure = 1.25;
    pipe.imageProcessing.contrast = 1.12;
    pipe.imageProcessing.vignetteEnabled = true;
    pipe.imageProcessing.vignetteWeight = 1.6;
    pipe.imageProcessing.vignetteColor = new B.Color4(0, 0, 0.04, 0);

    this.resize();
  }

  // Cap the render resolution: about 1100 px wide on a phone, 1920 on a big screen.
  resize() {
    const cssW = this.canvas.clientWidth || 1280;
    const dpr = window.devicePixelRatio || 1;
    const maxW = cssW < 900 ? 1100 : 1920;
    this.engine.setHardwareScalingLevel(Math.max(1 / dpr, cssW / maxW));
    this.engine.resize();
  }

  // --- pitch: stripes and lines painted on one texture, 125 x 88 m (10 m of grass around)
  _pitch() {
    const scene = this.scene;
    const K = 20, M = 10;                     // pixels per metre, margin in metres
    const W = (105 + 2 * M) * K, H = (68 + 2 * M) * K;
    const tex = canvasTexture(scene, "pitchTex", W, H, (g) => {
      const X = (x) => (x + M) * K, Y = (y) => (68 + M - y) * K;
      const stripe = 105 / 14;
      for (let i = -2; i < 17; i++) {
        g.fillStyle = i % 2 ? "#2d6e30" : "#367b38";
        g.fillRect(X(i * stripe), 0, stripe * K + 1, H);
      }
      // speckle so the grass is not flat plastic
      const rnd = mulberry(11);
      for (let i = 0; i < 90000; i++) {
        g.fillStyle = rnd() < 0.5 ? "rgba(0,0,0,0.07)" : "rgba(255,255,255,0.05)";
        g.fillRect(rnd() * W, rnd() * H, 2, 2);
      }
      // worn goalmouths
      for (const gx of [0, 105]) {
        const r = g.createRadialGradient(X(gx), Y(34), 0, X(gx), Y(34), 9 * K);
        r.addColorStop(0, "rgba(90,80,40,0.35)"); r.addColorStop(1, "rgba(90,80,40,0)");
        g.fillStyle = r; g.fillRect(X(gx) - 9 * K, Y(34) - 9 * K, 18 * K, 18 * K);
      }
      g.strokeStyle = "rgba(245,245,240,0.95)"; g.fillStyle = "rgba(245,245,240,0.95)";
      g.lineWidth = 0.12 * K;
      const rect = (x0, y0, x1, y1) => g.strokeRect(X(x0), Y(y1), (x1 - x0) * K, (y1 - y0) * K);
      const arc = (x, y, r, a0, a1) => { g.beginPath(); g.arc(X(x), Y(y), r * K, a0, a1); g.stroke(); };
      const spot = (x, y) => { g.beginPath(); g.arc(X(x), Y(y), 0.12 * K, 0, Math.PI * 2); g.fill(); };
      rect(0, 0, 105, 68);
      g.beginPath(); g.moveTo(X(52.5), Y(0)); g.lineTo(X(52.5), Y(68)); g.stroke();
      arc(52.5, 34, 9.15, 0, Math.PI * 2); spot(52.5, 34);
      const a = Math.acos(5.5 / 9.15);
      rect(0, 34 - 20.16, 16.5, 34 + 20.16); rect(88.5, 34 - 20.16, 105, 34 + 20.16);
      rect(0, 34 - 9.16, 5.5, 34 + 9.16); rect(99.5, 34 - 9.16, 105, 34 + 9.16);
      spot(11, 34); spot(94, 34);
      arc(11, 34, 9.15, -a, a); arc(94, 34, 9.15, Math.PI - a, Math.PI + a);
      // canvas y grows downwards, so the corner arcs turn the other way
      arc(0, 0, 1, -Math.PI / 2, 0); arc(105, 0, 1, Math.PI, Math.PI * 1.5);
      arc(0, 68, 1, 0, Math.PI / 2); arc(105, 68, 1, Math.PI / 2, Math.PI);
    }, { aniso: 8 });
    const ground = B.MeshBuilder.CreateGround("pitch", { width: 105 + 2 * M, height: 68 + 2 * M }, scene);
    const m = new B.StandardMaterial("grass", scene);
    m.diffuseTexture = tex;
    m.specularColor = new B.Color3(0.04, 0.05, 0.04);
    ground.material = m;
    ground.freezeWorldMatrix();
    // dark surround out to the stands
    const apron = B.MeshBuilder.CreateGround("apron", { width: 260, height: 220 }, scene);
    apron.position.y = -0.5;   // well below the pitch: the HDR target's depth buffer is coarse
    apron.material = flatMat(scene, "apronMat", new B.Color3(0.09, 0.13, 0.1));
    apron.freezeWorldMatrix();
  }

  _goals() {
    const scene = this.scene;
    const white = flatMat(scene, "post", new B.Color3(0.95, 0.95, 0.95), new B.Color3(0.25, 0.25, 0.25));
    const netTex = canvasTexture(scene, "netTex", 128, 128, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineWidth = 5;
      for (let i = 0; i <= 128; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); }
    }, { alpha: true });
    netTex.wrapU = netTex.wrapV = B.Texture.WRAP_ADDRESSMODE;
    const net = new B.StandardMaterial("net", scene);
    net.diffuseTexture = netTex;
    net.useAlphaFromDiffuseTexture = true;
    net.transparencyMode = B.Material.MATERIAL_ALPHATEST;
    net.alphaCutOff = 0.3;
    net.backFaceCulling = false;
    net.emissiveColor = new B.Color3(0.35, 0.35, 0.35);
    const GW = 7.32, GH = 2.44, D = 2.2, cell = 0.12 * 4;   // one texture tile = 4 net cells
    const posts = [], nets = [];
    for (const s of [-1, 1]) {
      const x = s * HALF_L;
      for (const z of [-GW / 2, GW / 2]) {
        const p = B.MeshBuilder.CreateCylinder("p", { diameter: 0.12, height: GH, tessellation: 10 }, scene);
        p.position.set(x, GH / 2, z); posts.push(p);
      }
      const bar = B.MeshBuilder.CreateCylinder("b", { diameter: 0.12, height: GW + 0.12, tessellation: 10 }, scene);
      bar.rotation.x = Math.PI / 2; bar.position.set(x, GH, 0); posts.push(bar);
      const plane = (w, h, pos, rotY, rotX = 0) => {
        const m = B.MeshBuilder.CreatePlane("n", { width: w, height: h, sideOrientation: B.Mesh.DOUBLESIDE }, scene);
        const uv = m.getVerticesData(B.VertexBuffer.UVKind);
        for (let i = 0; i < uv.length; i += 2) { uv[i] *= w / cell; uv[i + 1] *= h / cell; }
        m.setVerticesData(B.VertexBuffer.UVKind, uv);
        m.position.copyFrom(pos); m.rotation.y = rotY; m.rotation.x = rotX;
        nets.push(m);
      };
      plane(GW, GH * 0.9, new B.Vector3(x + s * D, GH * 0.45, 0), Math.PI / 2);                 // back
      plane(GW, Math.hypot(D, GH * 0.1), new B.Vector3(x + s * D / 2, GH * 0.95, 0), Math.PI / 2, s * (Math.PI / 2 - Math.atan2(GH * 0.1, D)));
      for (const z of [-GW / 2, GW / 2]) plane(D, GH, new B.Vector3(x + s * D / 2, GH / 2, z), 0); // sides
    }
    const mp = B.Mesh.MergeMeshes(posts, true); mp.material = white; mp.freezeWorldMatrix();
    const mn = B.Mesh.MergeMeshes(nets, true); mn.material = net; mn.freezeWorldMatrix();
  }

  // Stands, boards, four floodlight towers with a glow around the lamps.
  _stadium() {
    const scene = this.scene;
    const rnd = mulberry(5);
    const shirts = [this.match.home.color_primary, this.match.away.color_primary, "#d9dde6", "#2b3550", "#5a6687", "#c9b48a"];
    const crowdTex = canvasTexture(scene, "crowd", 512, 256, (g, w, h) => {
      g.fillStyle = "#11141f"; g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 6) {
        if (rnd() < 0.12) continue;
        const home = x < w / 2;
        const c = rnd() < 0.55 ? (home ? shirts[0] : shirts[1]) : shirts[2 + Math.floor(rnd() * 4)];
        g.fillStyle = c; g.fillRect(x + 1, y + 3, 4, 5);
        g.fillStyle = "#d8b89a"; g.fillRect(x + 2, y + 1, 2, 2);
      }
      for (let x = 0; x < w; x += 128) { g.fillStyle = "#0a0c14"; g.fillRect(x, 0, 6, h); }   // aisles
    });
    crowdTex.wrapU = crowdTex.wrapV = B.Texture.WRAP_ADDRESSMODE;
    const crowd = new B.StandardMaterial("crowdMat", scene);
    crowd.diffuseTexture = crowdTex;
    crowd.emissiveColor = new B.Color3(0.22, 0.22, 0.25);
    crowd.specularColor = B.Color3.Black();
    const concrete = flatMat(scene, "concrete", new B.Color3(0.17, 0.18, 0.22));
    concrete.emissiveColor = new B.Color3(0.03, 0.035, 0.05);

    // A stand is a raked slab from (front, 1.5 m) to (back, 17 m) plus a roof and a back wall.
    const tiers = [], shells = [];
    const stand = (len, front, depth, cx, cz, rotY) => {
      const root = new B.TransformNode("stand", scene);
      root.position.set(cx, 0, cz); root.rotation.y = rotY;
      const rake = Math.atan2(15.5, depth), slope = Math.hypot(15.5, depth);
      const t = B.MeshBuilder.CreatePlane("tier", { width: len, height: slope }, scene);
      const uv = t.getVerticesData(B.VertexBuffer.UVKind);
      for (let i = 0; i < uv.length; i += 2) { uv[i] *= len / 30; uv[i + 1] *= slope / 15; }
      t.setVerticesData(B.VertexBuffer.UVKind, uv);
      t.parent = root; t.rotation.x = Math.PI / 2 - rake; t.position.set(0, 1.5 + 7.75, front + depth / 2);
      tiers.push(t);
      const wall = B.MeshBuilder.CreateBox("w", { width: len, height: 1.5, depth: 0.4 }, scene);
      wall.parent = root; wall.position.set(0, 0.75, front); shells.push(wall);
      const back = B.MeshBuilder.CreateBox("bk", { width: len, height: 26, depth: 1 }, scene);
      back.parent = root; back.position.set(0, 13, front + depth + 0.5); shells.push(back);
      const roof = B.MeshBuilder.CreateBox("rf", { width: len, height: 0.8, depth: depth * 0.75 }, scene);
      roof.parent = root; roof.position.set(0, 25, front + depth * 0.62); shells.push(roof);
      for (const sx of [-1, 1]) {
        const side = B.MeshBuilder.CreateBox("sd", { width: 0.6, height: 26, depth: depth }, scene);
        side.parent = root; side.position.set(sx * len / 2, 13, front + depth / 2); shells.push(side);
      }
    };
    stand(118, HALF_W + 9, 26, 0, 0, 0);            // far side (rotY 0 faces -Z, towards the pitch)
    stand(118, HALF_W + 9, 26, 0, 0, Math.PI);      // near side, behind the TV camera
    stand(80, HALF_L + 9, 22, 0, 0, Math.PI / 2);   // right end
    stand(80, HALF_L + 9, 22, 0, 0, -Math.PI / 2);  // left end
    for (const m of [...tiers, ...shells]) m.computeWorldMatrix(true);
    const mt = B.Mesh.MergeMeshes(tiers, true, true); mt.material = crowd; mt.freezeWorldMatrix();
    const ms = B.Mesh.MergeMeshes(shells, true, true); ms.material = concrete; ms.freezeWorldMatrix();

    // LED boards around the pitch
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
      b.position.set(x, 0.45, z); b.rotation.y = rotY; b.computeWorldMatrix(true); boards.push(b);
    };
    board(110, 0, HALF_W + 5, 0);
    board(110, 0, -HALF_W - 5, Math.PI);
    for (const s of [-1, 1]) for (const z of [-20, 20]) board(28, s * (HALF_L + 4), z, s * Math.PI / 2);
    const mb = B.Mesh.MergeMeshes(boards, true); mb.material = boardMat; mb.freezeWorldMatrix();

    // Floodlight towers: mast, a bank of lamps (emissive above the bloom threshold) and a halo.
    const lampTex = canvasTexture(scene, "lamps", 256, 128, (g, w, h) => {
      g.fillStyle = "#1a1d26"; g.fillRect(0, 0, w, h);
      for (let y = 10; y < h; y += 24) for (let x = 12; x < w; x += 24) {
        const r = g.createRadialGradient(x, y, 0, x, y, 11);
        r.addColorStop(0, "#ffffff"); r.addColorStop(0.6, "#f4f6ff"); r.addColorStop(1, "rgba(200,210,255,0.2)");
        g.fillStyle = r; g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fill();
      }
    });
    const lampMat = new B.StandardMaterial("lampMat", scene);
    lampMat.emissiveTexture = lampTex; lampMat.diffuseColor = B.Color3.Black();
    lampMat.emissiveColor = new B.Color3(2.6, 2.6, 2.7);   // HDR: well above the bloom threshold
    lampMat.disableLighting = true;
    // glow: an additive radial halo facing the camera, the cheap stand-in for light in the haze
    const haloTex = canvasTexture(scene, "haloTex", 256, 256, (g, w, h) => {
      const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.12, "rgba(220,228,255,0.55)");
      r.addColorStop(0.4, "rgba(150,165,210,0.12)"); r.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = r; g.fillRect(0, 0, w, h);
    }, { alpha: true });
    const haloMat = new B.StandardMaterial("haloMat", scene);
    haloMat.emissiveTexture = haloTex; haloMat.opacityTexture = haloTex;
    haloMat.diffuseColor = B.Color3.Black(); haloMat.disableLighting = true;
    haloMat.alphaMode = B.Engine.ALPHA_ADD; haloMat.disableDepthWrite = true;
    const masts = [], heads = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const base = new B.Vector3(sx * (HALF_L + 22), 0, sz * (HALF_W + 30));
      const top = base.add(new B.Vector3(0, 46, 0));
      const mast = B.MeshBuilder.CreateCylinder("mast", { diameterTop: 0.9, diameterBottom: 1.8, height: 46, tessellation: 8 }, scene);
      mast.position.set(base.x, 23, base.z); mast.computeWorldMatrix(true); masts.push(mast);
      const head = B.MeshBuilder.CreatePlane("head", { width: 11, height: 5.5, sideOrientation: B.Mesh.DOUBLESIDE }, scene);
      head.position.copyFrom(top);
      head.lookAt(new B.Vector3(0, -20, 0));
      head.rotate(B.Axis.Y, Math.PI, B.Space.LOCAL);
      head.computeWorldMatrix(true); heads.push(head);
      const halo = B.MeshBuilder.CreatePlane("halo", { size: 34 }, scene);
      halo.position.copyFrom(top);
      halo.billboardMode = B.Mesh.BILLBOARDMODE_ALL;
      halo.material = haloMat;
    }
    const mm = B.Mesh.MergeMeshes(masts, true); mm.material = concrete; mm.freezeWorldMatrix();
    const mh = B.Mesh.MergeMeshes(heads, true); mh.material = lampMat; mh.freezeWorldMatrix();
  }

  _ball() {
    const scene = this.scene;
    this.ball = B.MeshBuilder.CreateSphere("ball", { diameter: BALL_R * 2, segments: 12 }, scene);
    const m = flatMat(scene, "ballMat", new B.Color3(1, 1, 1), new B.Color3(0.55, 0.55, 0.55));
    this.ball.material = m;
    this.ballShadow = B.MeshBuilder.CreateDisc("ballShadow", { radius: BALL_R * 1.1, tessellation: 16 }, scene);
    this.ballShadow.rotation.x = Math.PI / 2;
    const sm = new B.StandardMaterial("ballShadowMat", scene);
    sm.diffuseColor = B.Color3.Black(); sm.specularColor = B.Color3.Black(); sm.disableLighting = true;
    sm.alpha = 0.5;
    this.ballShadow.material = sm;
  }

  async _loadPlayers() {
    const scene = this.scene, match = this.match;
    const container = await B.LoadAssetContainerAsync("vendor/quaternius/mannequin.glb", scene);
    // kit materials: primary on the body, secondary on the joints; goalkeepers in their own kit
    const kits = {};
    const kit = (team, gk) => {
      const id = `${team.team_id}${gk ? "gk" : ""}`;
      if (!kits[id]) {
        const body = flatMat(scene, `${id}-body`, hex(gk ? (team.side === "home" ? "#1f9d6b" : "#7a3fb8") : team.color_primary));
        body.specularColor = new B.Color3(0.12, 0.12, 0.12);
        body.emissiveColor = body.diffuseColor.scale(0.12);
        const joints = flatMat(scene, `${id}-joints`, hex(gk ? "#15171f" : team.color_secondary));
        joints.emissiveColor = joints.diffuseColor.scale(0.08);
        kits[id] = { body, joints };
      }
      return kits[id];
    };
    // measure the model once to scale it to PLAYER_H
    const probe = container.instantiateModelsToScene((n) => `probe-${n}`, false, { doNotInstantiate: true });
    const { min, max } = probe.rootNodes[0].getHierarchyBoundingVectors(true);
    const scale = PLAYER_H / (max.y - min.y);
    probe.rootNodes.forEach((n) => n.dispose());
    probe.animationGroups.forEach((g) => g.dispose());
    probe.skeletons.forEach((s) => s.dispose());

    this.players = [];
    for (const i of this.entities) {
      const pid = match.meta.entities[i];
      const pl = match.players[pid], team = match.teams[pl.team_id];
      const inst = container.instantiateModelsToScene((n) => `${pid}-${n}`, false, { doNotInstantiate: true });
      const holder = new B.TransformNode(`player-${pid}`, scene);
      const root = inst.rootNodes[0];
      root.parent = holder;
      root.scaling.scaleInPlace(scale);
      const k = kit(team, pl.position === "GK");
      for (const m of root.getChildMeshes()) {
        m.material = /joint/i.test(m.material?.name ?? "") ? k.joints : k.body;
        m.alwaysSelectAsActiveMesh = true;   // the bind-pose bounding box is wrong once animated
      }
      const groups = CLIPS.map((c) => {
        const g = inst.animationGroups.find((a) => a.name.endsWith(c.name));
        g.start(true, 1, g.from, g.to);
        g.pause();
        g.setWeightForAllAnimatables(0);
        return g;
      });
      for (const g of inst.animationGroups) if (!groups.includes(g)) g.dispose();
      this.players.push({ i, pid, holder, groups, yaw: null, phase: (this.players.length * 0.618) % 1, idle: (this.players.length * 0.37) % 1, w: [1, 0, 0, 0] });
    }
    // the container is not disposed: the clones share its geometry

    // four-way floodlight shadow decal, one thin-instanced plane for all players
    const shTex = canvasTexture(scene, "shadow", 256, 256, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.translate(w / 2, h / 2);
      for (let k = 0; k < 4; k++) {
        g.save(); g.rotate(Math.PI / 4 + k * Math.PI / 2);
        const r = g.createLinearGradient(0, 0, 118, 0);
        r.addColorStop(0, "rgba(0,0,0,0.38)"); r.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = r; g.beginPath(); g.ellipse(52, 0, 66, 13, 0, 0, Math.PI * 2); g.fill();
        g.restore();
      }
      const c = g.createRadialGradient(0, 0, 0, 0, 0, 30);
      c.addColorStop(0, "rgba(0,0,0,0.55)"); c.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = c; g.beginPath(); g.arc(0, 0, 30, 0, Math.PI * 2); g.fill();
    }, { alpha: true });
    const shMat = new B.StandardMaterial("shadowMat", scene);
    shMat.diffuseTexture = shTex; shMat.useAlphaFromDiffuseTexture = true;
    shMat.disableLighting = true; shMat.emissiveColor = B.Color3.Black(); shMat.disableDepthWrite = true;
    const sh = this.shadows = B.MeshBuilder.CreateGround("shadows", { width: 3.4, height: 3.4 }, scene);
    sh.material = shMat;
    sh.alwaysSelectAsActiveMesh = true;
    this.shadowBuf = new Float32Array(16 * this.players.length);
    sh.thinInstanceSetBuffer("matrix", this.shadowBuf, 16, false);
  }

  // --- per frame
  // view: {ts, replay}; dt: seconds of match time since the last call (0 after a jump).
  update(view, dt) {
    const { match } = this;
    const ts = Math.min(view.ts, match.duration);
    const b = match.at(0, ts);
    if (b) {
      const z = Math.max(0, b[2]);
      this.ball.position.copyFrom(P(b[0], b[1], z + BALL_R));
      this.ballShadow.position.copyFrom(P(b[0], b[1], 0.03));
      this.ballShadow.material.alpha = 0.5 / (1 + z * 0.6);
    }
    this.ball.setEnabled(!!b);
    this.ballShadow.setEnabled(!!b);

    const m = new B.Matrix();
    this.players.forEach((p, k) => {
      const now = match.at(p.i, ts);
      if (!now) { p.holder.setEnabled(false); B.Matrix.ScalingToRef(0, 0, 0, m); m.copyToArray(this.shadowBuf, k * 16); return; }
      p.holder.setEnabled(true);
      // velocity over +-0.2 s, which smooths the 10 fps steps of the tracking data
      const a = match.at(p.i, Math.max(0, ts - 0.2)) ?? now, c = match.at(p.i, Math.min(match.duration, ts + 0.2)) ?? now;
      const vx = (c[0] - a[0]) / 0.4, vy = (c[1] - a[1]) / 0.4, v = Math.hypot(vx, vy);
      p.holder.position.copyFrom(P(now[0], now[1], 0));
      // face the run; when nearly still, face the ball
      let want = p.yaw;
      if (v > 0.7) want = Math.atan2(vx, vy);
      else if (b) want = Math.atan2(b[0] - now[0], b[1] - now[1]);
      if (p.yaw === null || dt === 0) p.yaw = want;
      else p.yaw += angleDiff(p.yaw, want) * (1 - Math.exp(-dt * 7));
      p.holder.rotation.y = p.yaw;
      // locomotion: weights from speed, one shared cycle phase advanced by ground speed / stride
      const w = clipWeights(v);
      const moving = w[1] + w[2] + w[3];
      const stride = moving > 0 ? (w[1] * CLIPS[1].stride + w[2] * CLIPS[2].stride + w[3] * CLIPS[3].stride) / moving : 1;
      p.phase = (p.phase + (v / stride) * dt) % 1;
      p.idle = (p.idle + dt / CLIPS[0].period) % 1;
      p.groups.forEach((g, j) => {
        if (w[j] === 0 && p.w[j] === 0) return;
        g.setWeightForAllAnimatables(w[j]);
        const ph = j === 0 ? p.idle : p.phase;
        g.goToFrame(g.from + ph * (g.to - g.from), true);
      });
      p.w = w;
      B.Matrix.TranslationToRef(p.holder.position.x, 0.02, p.holder.position.z, m);
      m.copyToArray(this.shadowBuf, k * 16);
    });
    this.shadows.thinInstanceBufferUpdated("matrix");

    if (view.replay) this._goalCamera(ts);
    else this._tvCamera(ts);
  }

  // Ball position smoothed with a Gaussian over the data around ts (stateless, so it never jerks
  // after a seek and renders the same frame by frame).
  _smoothBall(ts, sigma, lead) {
    let sx = 0, sy = 0, sw = 0;
    for (let k = -18; k <= 8; k++) {
      const t = ts + k * 0.1;
      const p = this.match.at(0, Math.min(Math.max(t, 0), this.match.duration));
      if (!p) continue;
      const w = Math.exp(-((k * 0.1 - lead) ** 2) / (2 * sigma * sigma));
      sx += p[0] * w; sy += p[1] * w; sw += w;
    }
    return sw ? [sx / sw, sy / sw] : [52.5, 34];
  }

  _tvCamera(ts) {
    const [bx, by] = this._smoothBall(ts, 0.75, 0.15);
    const tx = Math.min(Math.max(bx - HALF_L, -36), 36);
    const tz = (by - HALF_W) * 0.55;
    const target = new B.Vector3(tx, 0, tz);
    const cam = this.tv;
    cam.position.copyFrom(TV_POS);
    cam.setTarget(target);
    // zoom: about 46 m of pitch across the frame in midfield, 34 m near a goal
    const width = 46 - 12 * smoothstep(22, 40, Math.abs(tx));
    const dist = B.Vector3.Distance(TV_POS, target);
    cam.fov = 2 * Math.atan((width / (16 / 9)) / 2 / dist);
    this.scene.activeCamera = cam;
  }

  _goalCamera(ts) {
    const [bx, by] = this._smoothBall(ts, 0.45, 0.1);
    const cam = this.goalCam;
    const target = P(bx, by, 0.6);
    // keep the goal mouth in shot: aim between the ball and the goal
    const goal = P(this.goalEnd > 0 ? 105 : 0, 34, 1);
    const aim = B.Vector3.Lerp(target, goal, 0.25);
    cam.setTarget(aim);
    const dist = B.Vector3.Distance(cam.position, target);
    cam.fov = Math.min(0.85, Math.max(0.45, 2 * Math.atan(14 / Math.max(dist, 1))));
    this.scene.activeCamera = cam;
  }

  render() { this.scene.render(); }

  // Screen position, in 1920 x 1080 stage pixels, of a player's feet.
  project(entityIndex, ts) {
    const p = this.match.at(entityIndex, Math.min(ts, this.match.duration));
    if (!p) return { x: 0, y: 0, visible: false };
    const cam = this.scene.activeCamera;
    const world = P(p[0], p[1], 0);
    const w = this.engine.getRenderWidth(), h = this.engine.getRenderHeight();
    const view = cam.getViewMatrix();
    if (B.Vector3.TransformCoordinates(world, view).z <= 0) return { x: 0, y: 0, visible: false };
    const s = B.Vector3.Project(world, B.Matrix.IdentityReadOnly, cam.getTransformationMatrix(), cam.viewport.toGlobal(w, h));
    const x = (s.x / w) * 1920, y = (s.y / h) * 1080;
    return { x, y, visible: x > -200 && x < 2120 && y > -200 && y < 1280 };
  }
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
