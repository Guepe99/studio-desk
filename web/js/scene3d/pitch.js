// The pitch: one PBR ground whose albedo is computed per pixel by a material plugin, so nothing
// depends on texture resolution at broadcast distance.
// - 18 straight mowing stripes along the length (105 / 18 = 5.83 m, UEFA asks 5.50 to 6.10 m);
//   their contrast follows the view direction, as cut grass does.
// - the markings of Law 1 at the coordinates of docs/CONTRACT.md, 12 cm wide, as a distance field
//   anti-aliased with screen derivatives: a line thinner than a pixel is drawn one pixel wide and
//   dimmed in proportion, so it neither shimmers nor breaks up when the camera pans.
// - a CC0 grass photo (ambientCG Grass005, luminance only) at two scales against tiling, slow
//   world-space noise, and light wear in the goalmouths and on the spots.
const B = window.BABYLON;

export const DETAIL_URL = "vendor/ambientcg/grass005_detail.jpg";
export const LINE_W = 0.12;
export const STRIPES = 18;
const MARGIN = 10;   // grass beyond the lines, metres

const GLSL_DEFS = `
#ifdef PITCH
uniform sampler2D pitchDetailSampler;
float pHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float pNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(pHash(i), pHash(i + vec2(1.0, 0.0)), f.x), mix(pHash(i + vec2(0.0, 1.0)), pHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float pBoxEdge(vec2 p, vec2 c, vec2 h) { vec2 d = abs(p - c) - h; return abs(length(max(d, 0.0)) + min(max(d.x, d.y), 0.0)); }
// distance in metres from contract point p to the centre of the nearest line (spots: their rim)
float pitchLineDist(vec2 p) {
  vec2 q = vec2(min(p.x, 105.0 - p.x), p.y);                // the two halves are mirror images
  vec2 r = vec2(q.x, min(p.y, 68.0 - p.y));                 // and so are the four corners
  float d = pBoxEdge(p, vec2(52.5, 34.0), vec2(52.5, 34.0));   // touchlines and goal lines
  d = min(d, length(vec2(p.x - 52.5, p.y - clamp(p.y, 0.0, 68.0))));   // halfway line
  float c = length(p - vec2(52.5, 34.0));
  d = min(d, abs(c - 9.15));                                // centre circle
  d = min(d, max(c - 0.05, 0.0));                           // centre spot, 22 cm
  d = min(d, pBoxEdge(q, vec2(8.25, 34.0), vec2(8.25, 20.16)));   // penalty area
  d = min(d, pBoxEdge(q, vec2(2.75, 34.0), vec2(2.75, 9.16)));    // goal area
  float s = length(q - vec2(11.0, 34.0));
  d = min(d, max(s - 0.05, 0.0));                           // penalty mark
  if (q.x > 16.5) d = min(d, abs(s - 9.15));                // penalty arc
  if (r.x >= 0.0 && r.y >= 0.0) d = min(d, abs(length(r) - 1.0));   // corner arcs
  return d;
}
vec3 pitchAlbedo(vec3 posW, vec3 eye, vec4 prm) {
  vec2 p = vec2(posW.x + 52.5, posW.z + 34.0);
  vec3 viewDir = normalize(posW - eye);
  // stripes: grass laid away from the viewer looks lighter; the pattern swaps sides with the view
  float parity = mod(floor(p.x / (105.0 / ${STRIPES}.0)), 2.0) * 2.0 - 1.0;
  float facing = viewDir.z / (abs(viewDir.z) + 0.25);
  float stripe = parity * (0.035 + 0.085 * abs(viewDir.z)) * sign(facing + 1e-4) * mix(0.6, 1.0, abs(facing));
  vec3 grass = vec3(0.052, 0.155, 0.040) * (1.0 + stripe);
  // slow patches, then the photo detail at one or two scales
  float n = pNoise(p * 0.11) * 0.6 + pNoise(p * 0.47 + 7.3) * 0.4;
  grass *= 0.9 + 0.2 * n;
  float t1 = texture2D(pitchDetailSampler, p / 1.9).r;
  float detail = 0.55 + 0.9 * t1;
  if (prm.x > 1.5) {
    vec2 pr = mat2(0.8, -0.6, 0.6, 0.8) * p;
    detail *= 0.8 + 0.4 * texture2D(pitchDetailSampler, pr / 8.3).r;
  }
  grass *= detail;
  // wear: goalmouths, penalty marks and the centre spot
  vec2 q = vec2(min(p.x, 105.0 - p.x), p.y);
  float e = length((q - vec2(2.6, 34.0)) / vec2(4.2, 6.0));
  float wear = (1.0 - smoothstep(0.25, 1.0, e)) * (0.45 + 0.55 * pNoise(p * 1.7));
  wear += (1.0 - smoothstep(0.2, 1.1, length(q - vec2(11.0, 34.0)))) * 0.45;
  wear += (1.0 - smoothstep(0.3, 1.6, length(p - vec2(52.5, 34.0)))) * 0.35;
  grass = mix(grass, vec3(0.145, 0.125, 0.075) * (0.8 + 0.4 * n), clamp(wear, 0.0, 1.0) * 0.6);
  // lines, 12 cm: widen to one pixel when thinner and dim in proportion (no shimmer, no gaps)
  float d = pitchLineDist(p);
  float fw = max(fwidth(d), 1e-4);
  float halfW = ${(LINE_W / 2).toFixed(3)};
  float w = max(halfW, fw * 0.7);
  float cov = (1.0 - smoothstep(w - fw * 0.5, w + fw * 0.5, d)) * (halfW / w);
  return mix(grass, vec3(0.80, 0.81, 0.78), cov * prm.y);
}
#endif
`;

class PitchPlugin extends B.MaterialPluginBase {
  constructor(material, detail, scales) {
    super(material, "Pitch", 200, { PITCH: false });
    this.detail = detail;
    this.scales = scales;
    this.lines = 1;
    this._enable(true);
  }
  prepareDefines(defines) { defines.PITCH = true; }
  isReadyForSubMesh() { return this.detail.isReady(); }
  getClassName() { return "PitchPlugin"; }
  getSamplers(samplers) { samplers.push("pitchDetailSampler"); }
  getActiveTextures(list) { list.push(this.detail); }
  hasTexture(t) { return t === this.detail; }
  getUniforms() {
    return { ubo: [{ name: "pitchParams", size: 4, type: "vec4" }], fragment: "#ifdef PITCH\nuniform vec4 pitchParams;\n#endif\n" };
  }
  bindForSubMesh(ubo) {
    ubo.updateFloat4("pitchParams", this.scales, this.lines, 0, 0);
    ubo.setTexture("pitchDetailSampler", this.detail);
  }
  getCustomCode(shaderType, shaderLanguage) {
    if (shaderType !== "fragment" || (shaderLanguage ?? 0) !== B.ShaderLanguage.GLSL) return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: GLSL_DEFS,
      CUSTOM_FRAGMENT_UPDATE_ALBEDO: "#ifdef PITCH\nsurfaceAlbedo = pitchAlbedo(vPositionW, vEyePosition.xyz, pitchParams);\n#endif\n",
    };
  }
}

export function buildPitch(scene, profile) {
  const detail = new B.Texture(DETAIL_URL, scene, false, true, B.Texture.TRILINEAR_SAMPLINGMODE);
  detail.wrapU = detail.wrapV = B.Texture.WRAP_ADDRESSMODE;
  detail.anisotropicFilteringLevel = profile.aniso;
  detail.gammaSpace = false;   // a luminance map, used as a factor around 1

  const ground = B.MeshBuilder.CreateGround("pitch", { width: 105 + 2 * MARGIN, height: 68 + 2 * MARGIN }, scene);
  const m = new B.PBRMaterial("grass", scene);
  m.albedoColor = B.Color3.White();
  m.metallic = 0;
  m.roughness = 0.92;
  m.environmentIntensity = 0.9;
  m.enableSpecularAntiAliasing = true;   // also switches on screen derivatives in WebGL 1
  m.pitch = new PitchPlugin(m, detail, profile.detailScales);
  ground.material = m;
  ground.receiveShadows = true;
  ground.freezeWorldMatrix();

  // ground out to the stands, well below the pitch: the HDR target's depth buffer is coarse
  const apron = B.MeshBuilder.CreateGround("apron", { width: 260, height: 220 }, scene);
  apron.position.y = -0.5;
  const am = new B.PBRMaterial("apronMat", scene);
  am.albedoColor = new B.Color3(0.035, 0.06, 0.035);
  am.metallic = 0; am.roughness = 0.95;
  apron.material = am;
  apron.freezeWorldMatrix();
  return { ground, material: m };
}
