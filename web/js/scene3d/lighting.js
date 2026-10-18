// Light of the stadium (docs/broadcast3d.md). Two looks, picked with ?light=:
// - night (default): an evening match under floodlights. The sky behind the stands is dark, the
//   floodlight banks on the four corner masts and under the roofs glow (emissive, so the bloom of
//   post.js picks them up) with a faint lens flare. Four directional lights, one per corner mast,
//   light the pitch evenly in 5,600 K white (OP-32 9.1: 4,000 to 6,500 K, 5,600 K preferred); the
//   one behind camera 1's left shoulder casts the shadow map, the other three are soft fill and
//   their shadows are the faint blobs of grounding.js, which gives players the four soft shadows
//   of a floodlit match.
// - day: the previous look, a stadium HDRI and one sun at 52 degrees that casts the shadow map.
// Khronos PBR Neutral tone mapping keeps kit colours as the export gives them.
const B = window.BABYLON;
const HALF_L = 52.5, HALF_W = 34;

export const ENV_URL = "vendor/polyhaven/orlando_stadium_256.env";
// Sun of the HDRI (52 degrees up). It shines from behind the main camera's left shoulder, so the
// shadows fall away from the viewer, as the regulations ask for the main camera.
export const SUN_DIR = new B.Vector3(0.38, -0.79, 0.48).normalize();
// Corner masts (stands.js puts them here): lamp heads 46 m up, 22 m behind the goal lines and
// 30 m behind the touchlines. The first one, behind camera 1's left shoulder, casts the shadow map.
export const MASTS = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => new B.Vector3(sx * (HALF_L + 22), 46, sz * (HALF_W + 30)));
const FLOOD = new B.Color3(1, 0.96, 0.92);   // about 5,600 K

export const lightMode = (param) => (param === "day" ? "day" : "night");

// Direction of the light from a mast to the centre spot, and its elevation (radians).
export function mastLight(m) {
  const d = m.scale(-1).normalize();
  return { dir: d, elevation: Math.asin(-d.y) };
}

export function setupLighting(scene, profile, mode = "night") {
  const night = mode === "night";
  scene.environmentTexture = B.CubeTexture.CreateFromPrefilteredData(ENV_URL, scene);
  // the HDRI's sun sits at u = 0.6 of the panorama: turn it to the same azimuth as SUN_DIR
  scene.environmentTexture.rotationY = Math.atan2(-SUN_DIR.x, -SUN_DIR.z) - 0.6 * 2 * Math.PI + Math.PI / 2;
  // at night the HDRI only stands for the light bouncing off the pitch and the stands
  scene.environmentIntensity = night ? 0.32 : 0.85;
  scene.clearColor = night ? new B.Color4(0.012, 0.016, 0.032, 1) : new B.Color4(0.55, 0.65, 0.8, 1);

  const ip = scene.imageProcessingConfiguration;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = B.ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
  ip.exposure = night ? 1.12 : 1.05;   // the broadcast grade (post.js) darkens the mid-tones a little
  ip.contrast = 1;                     // contrast lives in the grade

  let key, fills = [];
  if (night) {
    MASTS.forEach((m, k) => {
      const l = new B.DirectionalLight(`flood${k}`, mastLight(m).dir, scene);
      l.position = m.clone();
      l.diffuse = FLOOD;
      l.specular = FLOOD.scale(0.5);
      // the key is a touch stronger, so one shadow leads and the others are fill
      l.intensity = k === 0 ? 1.9 : 1.25;
      if (k === 0) key = l; else fills.push(l);
    });
  } else {
    key = new B.DirectionalLight("sun", SUN_DIR.clone(), scene);
    key.intensity = 2.6;
    key.diffuse = new B.Color3(1, 0.975, 0.94);
    key.specular = new B.Color3(0.6, 0.6, 0.6);
    key.position = SUN_DIR.scale(-150);
  }

  let csm = null;
  if (profile.shadows === "csm") {
    csm = new B.CascadedShadowGenerator(profile.shadowMap, key);
    csm.numCascades = profile.cascades ?? 2;
    csm.lambda = 0.8;
    csm.stabilizeCascades = true;
    csm.shadowMaxZ = 160;              // the far touchline is about 110 m from the main camera
    // fit the cascades to what the camera really sees (WebGL 2 depth reduction): tighter maps
    if (profile.autoDepthBounds) csm.autoCalcDepthBounds = true;
    csm.cascadeBlendPercentage = 0.08;
    csm.usePercentageCloserFiltering = true;
    csm.filteringQuality = profile.shadowQuality === "medium" ? B.ShadowGenerator.QUALITY_MEDIUM : B.ShadowGenerator.QUALITY_LOW;
    csm.depthClamp = true;
    csm.bias = 0.004;
    csm.normalBias = 0.02;
    csm.darkness = night ? 0.35 : 0.15;   // the three other masts still light the shade at night
    csm.transparencyShadow = false;
  }
  const flood = night ? buildFloodlights(scene) : null;
  return {
    mode, sun: key, key, fills, csm, flood,
    // directions (x, z on the ground, unit) and elevation of the lights without a shadow map:
    // grounding.js draws their shadows as faint blobs
    blobLights: () => (night ? MASTS.slice(csm ? 1 : 0) : (csm ? [] : null)),
    addCaster(mesh) { if (csm) csm.addShadowCaster(mesh, true); },
    // the optimizer's last resort: no shadow maps, the caller turns blob shadows on
    dropShadows() { if (csm) { csm.getShadowMap().refreshRate = 0; csm.dispose(); csm = null; this.csm = null; } },
  };
}

// A grid of round lamps on a dark panel, as raw pixels (small canvas textures read back empty on
// the software WebGL 1 test renderer). cols x rows lamps, `px` pixels per lamp.
function lampTexture(scene, name, cols, rows, px = 16) {
  const W = cols * px, H = rows * px, data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x % px + 0.5) / px - 0.5, v = (y % px + 0.5) / px - 0.5, r = Math.hypot(u, v) / 0.42;
    const k = r < 1 ? 1 - r ** 4 : 0.03;
    const o = (y * W + x) * 4;
    data[o] = 255 * k; data[o + 1] = 250 * k; data[o + 2] = 240 * k; data[o + 3] = 255;
  }
  const t = B.RawTexture.CreateRGBATexture(data, W, H, scene, true, false, B.Texture.TRILINEAR_SAMPLINGMODE);
  t.name = name;
  return t;
}

const lampMaterial = (scene, name, tex, power) => {
  const m = new B.StandardMaterial(name, scene);
  m.disableLighting = true;
  m.diffuseColor = B.Color3.Black();
  m.emissiveTexture = tex;
  m.emissiveColor = new B.Color3(power, power, power);   // above 1: only the lamps reach the bloom threshold
  m.backFaceCulling = false;
  m.freeze();
  return m;
};

// Emissive floodlight banks: a lamp panel on the face of each mast head (stands.js builds the
// masts) and a row of lamps under the leading edge of each roof; a faint lens flare on the masts.
export function buildFloodlights(scene) {
  const panels = [], strips = [];
  for (const m of MASTS) {
    const p = B.MeshBuilder.CreatePlane("floodPanel", { width: 10.4, height: 5 }, scene);
    const aim = new B.Vector3(0, -20, 0);
    // stands.js turns the head with lookAt(aim): sit just in front of its face, facing the pitch
    p.position.copyFrom(m.add(aim.subtract(m).normalize().scale(0.45)));
    p.lookAt(m.add(m.subtract(aim)));   // a plane shows its front to -Z: look away from the pitch
    panels.push(p);
  }
  // roofs of the far stand and the two end stands (stands.js: front edge 0.2 of the depth back, 25 m up)
  const strip = (len, x, z, rotY) => {
    const s = B.MeshBuilder.CreatePlane("floodStrip", { width: len, height: 0.9 }, scene);
    const uv = s.getVerticesData(B.VertexBuffer.UVKind);
    for (let i = 0; i < uv.length; i += 2) uv[i] *= len / 2.5;   // one lamp every 2.5 m
    s.setVerticesData(B.VertexBuffer.UVKind, uv);
    s.position.set(x, 24.1, z);
    s.rotation.set(-0.5, rotY, 0);   // tilted down towards the pitch
    strips.push(s);
  };
  strip(140, 0, HALF_W + 9 + 26 * 0.2 - 0.6, 0);
  for (const sx of [-1, 1]) strip(64, sx * (HALF_L + 9 + 22 * 0.2 - 0.6), 0, sx * Math.PI / 2);
  const merge = (list, mat) => {
    const out = B.Mesh.MergeMeshes(list, true);
    out.material = mat; out.freezeWorldMatrix(); out.isPickable = false;
    return out;
  };
  const panelTex = lampTexture(scene, "floodPanelTex", 6, 3);
  const stripTex = lampTexture(scene, "floodStripTex", 1, 1);
  stripTex.wrapU = B.Texture.WRAP_ADDRESSMODE;
  const mastMesh = merge(panels, lampMaterial(scene, "floodPanelMat", panelTex, 7));
  const roofMesh = merge(strips, lampMaterial(scene, "floodStripMat", stripTex, 5));

  // lens flare: a soft halo and two small ghosts along the line through the frame centre. Each
  // mast is an emitter; no occlusion picking (the heads stand above the roofs).
  const flareTex = (() => {
    const S = 64, data = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const r = Math.hypot(x + 0.5 - S / 2, y + 0.5 - S / 2) / (S / 2), k = Math.max(0, 1 - r) ** 2;
      data.set([255 * k, 255 * k, 255 * k, 255 * k], (y * S + x) * 4);
    }
    const t = B.RawTexture.CreateRGBATexture(data, S, S, scene, true, false, B.Texture.BILINEAR_SAMPLINGMODE);
    t.hasAlpha = true;
    return t;
  })();
  const flares = MASTS.map((m, k) => {
    const emitter = new B.TransformNode(`flareAt${k}`, scene);
    emitter.position.copyFrom(m);
    const sys = new B.LensFlareSystem(`flare${k}`, emitter, scene);
    sys.meshesSelectionPredicate = () => false;
    for (const [size, pos, c] of [[0.16, 0, [0.5, 0.48, 0.45]], [0.05, 0.45, [0.12, 0.14, 0.18]], [0.09, 0.85, [0.08, 0.1, 0.14]]]) {
      const f = new B.LensFlare(size, pos, new B.Color3(...c), null, sys);
      f.texture = flareTex;
    }
    return sys;
  });
  return { mastMesh, roofMesh, flares };
}

// PBR material for cloth, plastic and paint: dielectric, rough, colour from a hex string or Color3.
export function pbr(scene, name, color, { roughness = 0.75, emissive = null, unlit = false } = {}) {
  const m = new B.PBRMaterial(name, scene);
  m.albedoColor = typeof color === "string" ? B.Color3.FromHexString(color).toLinearSpace() : color;
  m.metallic = 0;
  m.roughness = roughness;
  if (emissive) m.emissiveColor = emissive;
  m.unlit = unlit;
  return m;
}
