// Cel shading for the anime footballers (?players=anime, docs/anime3d.md): two material plugins on
// Babylon's PBR material, so the kit code of players3d.js (albedoColor, albedoTexture) still works.
//
//   toon(material, {face})  two flat tones from the sun's angle with a crisp edge, a cool shade
//                           tint and a thin rim on the lit side (MToon's shade colour, shading
//                           shift and toony, simplified); the face material also tints the iris
//                           and brow rectangles of its atlas (build_anime.TINT_RECTS)
//   outline(material)       inverted hull: the vertex shader pushes the surface out along its
//                           normal by a world width capped at a few pixels, so lines stay thin
//                           when the player is far (Guilty Gear Xrd's distance-scaled width)
const B = window.BABYLON;
import { SUN_DIR } from "./scene3d/lighting.js";

const GLSL = (lang) => lang === undefined || lang === B.ShaderLanguage?.GLSL;

class ToonPlugin extends B.MaterialPluginBase {
  constructor(material, face) {
    super(material, "Toon", 200, { TOON: false, TOON_FACE: false });
    this.face = face;
    this.iris = new B.Color3(1, 1, 1);
    this.brow = new B.Color3(1, 1, 1);
    this._enable(true);
  }
  isCompatible(lang) { return GLSL(lang); }
  prepareDefines(defines) { defines.TOON = true; defines.TOON_FACE = !!this.face; }
  getClassName() { return "ToonPlugin"; }
  getUniforms() {
    return {
      ubo: [{ name: "toonSun", size: 3, type: "vec3" }, { name: "toonIris", size: 3, type: "vec3" }, { name: "toonBrow", size: 3, type: "vec3" }],
      fragment: "uniform vec3 toonSun;\nuniform vec3 toonIris;\nuniform vec3 toonBrow;\n",
    };
  }
  bindForSubMesh(ubo) {
    ubo.updateFloat3("toonSun", SUN_DIR.x, SUN_DIR.y, SUN_DIR.z);
    ubo.updateColor3("toonIris", this.iris);
    ubo.updateColor3("toonBrow", this.brow);
  }
  getCustomCode(type) {
    if (type !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
#ifdef TOON
  vec3 toonAlb = surfaceAlbedo;
#if defined(TOON_FACE) && defined(ALBEDO)
  vec2 tuv = vAlbedoUV;
  if (tuv.x > 0.5 && tuv.y < 0.25) toonAlb *= toonIris;
  if (tuv.x > 0.5 && tuv.y > 0.5 && tuv.y < 0.625) toonAlb *= toonBrow;
#endif
  vec3 toonN = normalize(normalW);
  float toonNdl = dot(toonN, -toonSun);
  float toonLit = smoothstep(-0.02, 0.06, toonNdl);
  vec3 toonV = normalize(vEyePosition.xyz - vPositionW);
  float toonRim = smoothstep(0.62, 0.7, 1.0 - max(dot(toonN, toonV), 0.0)) * toonLit;
  vec3 toonCol = toonAlb * mix(vec3(0.62, 0.6, 0.78), vec3(1.55), toonLit) + toonAlb * toonRim * 0.35;
  vec4 toonOut = vec4(toonCol, finalColor.a);
#if defined(IMAGEPROCESSINGPOSTPROCESS) || defined(SS_SCATTERING)
  toonOut.rgb = clamp(toonOut.rgb, 0.0, 30.0);
#else
  toonOut = applyImageProcessing(toonOut);
#endif
  finalColor.rgb = toonOut.rgb;
#endif
`,
    };
  }
}

class OutlinePlugin extends B.MaterialPluginBase {
  constructor(material) {
    super(material, "Outline", 210, { TOON_OUTLINE: false });
    this._enable(true);
  }
  isCompatible(lang) { return GLSL(lang); }
  prepareDefines(defines) { defines.TOON_OUTLINE = true; }
  getClassName() { return "OutlinePlugin"; }
  getUniforms() {
    return { ubo: [{ name: "outlineW", size: 4, type: "vec4" }], vertex: "uniform vec4 outlineW;\n" };
  }
  bindForSubMesh(ubo, scene, engine) {
    const cam = scene.activeCamera;
    // world size of one pixel at 1 m: 2 tan(fov / 2) / height
    const px = 2 * Math.tan((cam?.fov ?? 0.8) / 2) / Math.max(1, engine.getRenderHeight());
    ubo.updateFloat4("outlineW", OUTLINE_WORLD, OUTLINE_PX * px, 0, 0);
  }
  getCustomCode(type) {
    if (type !== "vertex") return null;
    return {
      CUSTOM_VERTEX_UPDATE_WORLDPOS: `
#ifdef TOON_OUTLINE
  float olDist = length(vEyePosition.xyz - worldPos.xyz);
  worldPos.xyz += normalize(vNormalW) * min(outlineW.x, outlineW.y * olDist);
#endif
`,
    };
  }
}

// line width: 9 mm on the body, never more than 1.6 px
const OUTLINE_WORLD = 0.009, OUTLINE_PX = 1.6;

export function toon(material, { face = false } = {}) {
  const p = new ToonPlugin(material, face);
  return p;
}

export function outlineMaterial(scene) {
  const m = new B.PBRMaterial("anime-outline", scene);
  m.unlit = true;
  m.albedoColor = new B.Color3(0.045, 0.03, 0.04);
  m.cullBackFaces = false;      // draw the back faces only: the hull shows where it sticks out
  new OutlinePlugin(m);
  return m;
}
