// Toon (cel) shading for the anime look, shared by anything that wants it (the 3D crowd today,
// the players can adopt it): the base colour times one of three flat tones picked by how much the
// surface faces the sun, with a crisp edge between tones and a cool tint in the shadow tone, as
// anime cel shading does (docs/scene3d-research.md, section F). It replaces the lit colour of a
// StandardMaterial, so no specular, no image-based light and no PBR falloff are left.
//
//   const m = toonMaterial(scene, "name");          // a StandardMaterial with the plugin
//   new ToonPlugin(existingStandardMaterial);       // or on a material of your own
//
// The base colour is whatever the material's diffuse is at CUSTOM_FRAGMENT_UPDATE_DIFFUSE
// (diffuseColor, a texture, or a plugin that writes baseColor before this one runs).
import { SUN_DIR } from "./lighting.js";

const B = window.BABYLON;

// tones: lit, mid, shadow (multipliers of the base colour); edges: the cosines to the sun where the
// tone changes; soft: half width of the edge, small enough to read as a line at 1080p.
export const TOON = {
  tones: [1.0, 0.8, 0.58],
  edges: [0.42, -0.08],
  soft: 0.02,
  shadowTint: [0.86, 0.84, 1.08],   // shadows lean blue-violet instead of going grey
};

// GLSL of the ramp, also handy for a test: k(d) = lit above edges[0], mid down to edges[1], then shadow
export function toonTone(d, t = TOON) {
  const step = (e, x) => { const k = Math.min(1, Math.max(0, (x - (e - t.soft)) / (2 * t.soft))); return k * k * (3 - 2 * k); };
  const mid = t.tones[2] + (t.tones[1] - t.tones[2]) * step(t.edges[1], d);
  return mid + (t.tones[0] - mid) * step(t.edges[0], d);
}

export class ToonPlugin extends B.MaterialPluginBase {
  constructor(material, opts = {}) {
    super(material, "Toon", 300, { TOON: false });
    this.t = { ...TOON, ...opts };
    this.light = SUN_DIR.scale(-1);   // towards the sun
    this._enable(true);
  }
  prepareDefines(defines) { defines.TOON = true; }
  getClassName() { return "ToonPlugin"; }
  getUniforms() {
    return {
      ubo: [
        { name: "toonLight", size: 3, type: "vec3" },
        { name: "toonTones", size: 4, type: "vec4" },
        { name: "toonEdges", size: 4, type: "vec4" },
      ],
      fragment: "#ifdef TOON\nuniform vec3 toonLight;\nuniform vec4 toonTones;\nuniform vec4 toonEdges;\n#endif\n",
    };
  }
  bindForSubMesh(ubo) {
    const { tones, edges, soft, shadowTint } = this.t;
    ubo.updateVector3("toonLight", this.light);
    ubo.updateFloat4("toonTones", tones[0], tones[1], tones[2], soft);
    ubo.updateFloat4("toonEdges", edges[0], edges[1], shadowTint[0], shadowTint[2]);
  }
  getCustomCode(shaderType, shaderLanguage) {
    if (shaderType !== "fragment" || (shaderLanguage ?? 0) !== B.ShaderLanguage.GLSL) return null;
    return {
      CUSTOM_FRAGMENT_BEFORE_FOG: `#ifdef TOON
{
  float d = dot(normalW, normalize(toonLight));
  float s = toonTones.w;
  float shadow = 1.0 - smoothstep(toonEdges.y - s, toonEdges.y + s, d);
  float mid = mix(toonTones.y, toonTones.z, shadow);
  float k = mix(mid, toonTones.x, smoothstep(toonEdges.x - s, toonEdges.x + s, d));
  vec3 tint = mix(vec3(1.0), vec3(toonEdges.z, toonEdges.z, toonEdges.w), shadow);
  color.rgb = baseColor.rgb * diffuseColor * k * tint;
}
#endif
`,
    };
  }
}

// A StandardMaterial lit only by the toon ramp. rgb: base colour in the material's (gamma) space.
export function toonMaterial(scene, name, rgb = [1, 1, 1], opts) {
  const m = new B.StandardMaterial(name, scene);
  m.diffuseColor = new B.Color3(...rgb);
  m.specularColor = new B.Color3(0, 0, 0);
  m.toon = new ToonPlugin(m, opts);
  return m;
}
