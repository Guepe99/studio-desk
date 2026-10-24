// Post-processing: a graded HDR chain on every profile (docs/broadcast3d.md, section 2).
// - DefaultRenderingPipeline with HDR: MSAA 4 on WebGL 2, FXAA where SSAO2 draws the scene (the
//   high profile) or without WebGL 2; a sharpen pass for the
//   crisp edge of a broadcast camera; bloom only above 1.0 in the HDR buffer, which in practice
//   means the floodlight lamps (half the bloom resolution on the low profile).
// - A broadcast grade through a colour lookup table built here (grade() below), a very light
//   vignette, no grain and no chromatic aberration (they muddy flat cel shading).
// - Depth of field only on the tight shot and replays, high profile only. No motion blur: TV sport runs
//   shutters of about 1/100 to 1/120 s. SSAO2 at half resolution, high profile only.
const B = window.BABYLON;

export const LUT_N = 16;   // lattice points per channel: plenty for a smooth grade

const clamp01 = (x) => Math.min(1, Math.max(0, x));
// ITU-R BT.709 camera transfer (OETF) and the BT.1886 display (gamma 2.4).
const oetf709 = (l) => (l < 0.018 ? 4.5 * l : 1.099 * l ** 0.45 - 0.099);

// The broadcast grade, on display (sRGB-encoded) values 0..1:
// 1. the picture as a TV chain shows it: undo the sRGB encoding (2.2), encode with the BT.709
//    camera curve and show it on a BT.1886 display (2.4). End to end that is the system gamma of
//    about 1.2 that gives TV pictures their contrast, deeper shadows and richer colour. The frame
//    is already tone mapped for a display, so the full curve crushes the darks (18% grey to 8%):
//    half of it is applied (18% grey to 13%), which keeps cel-shaded shadows readable;
// 2. a soft knee from 90%, so floodlit whites roll off instead of clipping;
// 3. a little vibrance: up to +8% saturation on dull colours, none on colours already strong, so
//    kits and cel shading keep their flat colour and nothing clips.
const SYSTEM_GAMMA_MIX = 0.5;
export function grade(r, g, b) {
  let c = [r, g, b].map((x) => {
    const v = oetf709(clamp01(x) ** 2.2);
    return clamp01(x) + ((Math.max(0, v) ** 2.4) ** (1 / 2.2) - clamp01(x)) * SYSTEM_GAMMA_MIX;
  });
  c = c.map((x) => (x > 0.9 ? 0.9 + (1 - Math.exp(-(x - 0.9) / 0.1)) * 0.1 : x));
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const sat = Math.max(...c) - Math.min(...c);
  const k = 1 + 0.08 * (1 - clamp01(sat / 0.6));
  return c.map((x) => clamp01(l + (x - l) * k));
}

// RGBA bytes of an N^3 lookup table as Babylon's 2D colour grading texture expects it with
// colorGradingWithGreenDepth = false and colorGradingBGR = true: N slices along blue, side by side,
// each N x N with red across and green down. Width N * N, height N.
export function lutPixels(n = LUT_N, fn = grade) {
  const px = new Uint8Array(n * n * n * 4);
  for (let bi = 0; bi < n; bi++) for (let gi = 0; gi < n; gi++) for (let ri = 0; ri < n; ri++) {
    const out = fn(ri / (n - 1), gi / (n - 1), bi / (n - 1));
    const o = (gi * n * n + bi * n + ri) * 4;
    px[o] = Math.round(out[0] * 255); px[o + 1] = Math.round(out[1] * 255); px[o + 2] = Math.round(out[2] * 255); px[o + 3] = 255;
  }
  return px;
}

export function lutTexture(scene, fn = grade, n = LUT_N) {
  const t = B.RawTexture.CreateRGBATexture(lutPixels(n, fn), n * n, n, scene, false, false, B.Texture.BILINEAR_SAMPLINGMODE);
  t.wrapU = t.wrapV = B.Texture.CLAMP_ADDRESSMODE;
  // no anisotropic filtering: where two neighbouring pixels fall in different blue slices the
  // texture coordinate jumps by a whole slice, and an anisotropic tap blends across it (coloured
  // speckles over the grass and on every edge)
  t.anisotropicFilteringLevel = 1;
  t.name = "broadcastLut";
  return t;
}

export function setGrade(ip, tex) {
  ip.colorGradingEnabled = !!tex;
  ip.colorGradingTexture = tex;
  ip.colorGradingWithGreenDepth = false;
  ip.colorGradingBGR = true;
}

function vignette(ip) {
  ip.vignetteEnabled = true;
  ip.vignetteWeight = 0.6;
  ip.vignetteStretch = 0.5;
  ip.vignetteColor = new B.Color4(0, 0, 0, 0);
  ip.vignetteCameraFov = 0.6;
}

export function setupPost(scene, cameras, profile) {
  let ssao = null;
  if (profile.ssao && B.SSAO2RenderingPipeline?.IsSupported) {
    // before the default pipeline, so the occlusion lands on the HDR image before the grade
    ssao = new B.SSAO2RenderingPipeline("ssao", scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, cameras);
    ssao.radius = 1.2;
    ssao.totalStrength = 0.9;
    ssao.samples = 8;
    ssao.maxZ = 160;
    ssao.expensiveBlur = false;
  }
  const pipe = new B.DefaultRenderingPipeline("broadcast", true, scene, cameras);
  // with SSAO2 the scene is drawn into its prepass target, not the pipeline's: MSAA here would only
  // multisample full-screen passes (depth of field, bloom), which gains nothing and costs a resolve
  // each. FXAA then: MSAA 4 in the prepass target (ssao.textureSamples) cost 33 to 40% of the frame
  // rate on the SwiftShader test renderer, FXAA 17% (scene3d-perf.mjs high, docs/broadcast3d.md)
  pipe.samples = ssao ? 1 : profile.msaa;
  pipe.fxaaEnabled = profile.fxaa || !!ssao;
  pipe.sharpenEnabled = profile.sharpen;
  if (profile.sharpen) { pipe.sharpen.edgeAmount = 0.25; pipe.sharpen.colorAmount = 1; }
  pipe.bloomEnabled = profile.bloom;
  if (profile.bloom) {
    pipe.bloomThreshold = 1.0;   // HDR: only what is brighter than white, the lamps
    pipe.bloomWeight = 0.3;
    pipe.bloomKernel = 64;
    pipe.bloomScale = profile.bloomScale;
  }
  pipe.depthOfFieldBlurLevel = B.DepthOfFieldEffectBlurLevel.Low;   // here, as setting it rebuilds the pipeline
  // depth of field is built once, here, and then only attached to the cameras or detached
  // (update): turning depthOfFieldEnabled on and off rebuilt the whole chain at each cut
  pipe.depthOfFieldEnabled = !!profile.dof;
  pipe.chromaticAberrationEnabled = false;
  pipe.grainEnabled = false;
  pipe.imageProcessingEnabled = true;
  const ip = pipe.imageProcessing;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = B.ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
  const lut = lutTexture(scene);
  setGrade(ip.imageProcessingConfiguration ?? scene.imageProcessingConfiguration, lut);
  vignette(ip);
  let dof = pipe.depthOfFieldEnabled;
  // Depth of field on or off without a rebuild: its passes attached to the cameras or not, the depth
  // pass of each camera running or not (else a whole extra draw of the scene every frame), and the
  // clear moved to the chain's first pass (the scene is drawn into that one's input).
  const setDof = (on) => {
    if (on === dof || !pipe.depthOfFieldEnabled) return;
    dof = on;
    const mgr = scene.postProcessRenderPipelineManager, next = (pipe.bloomEnabled ? pipe.bloom._effects[0] : null) ?? pipe.imageProcessing;
    if (on) mgr.enableEffectInPipeline("broadcast", pipe.depthOfField._name, cameras); else mgr.disableEffectInPipeline("broadcast", pipe.depthOfField._name, cameras);
    pipe.depthOfField._effects[0].autoClear = on;
    if (next) next.autoClear = !on;
    for (const r of Object.values(scene._depthRenderer ?? {})) r.enabled = on;
  };
  setDof(false);
  return {
    pipe, ssao, lut,
    // per frame: depth of field on for a tight shot or a replay (focus in metres), off otherwise
    update(cams) {
      setDof(!!profile.dof && cams.focus !== null);
      if (dof) {
        const cam = scene.activeCamera;
        pipe.depthOfField.focusDistance = cams.focus * 1000;   // millimetres
        pipe.depthOfField.focalLength = 12 / Math.tan(cam.fov / 2);   // a 24 mm tall sensor
        pipe.depthOfField.fStop = 2.8;
      }
    },
    drop() {
      setDof(false);
      pipe.samples = 1; pipe.fxaaEnabled = true; pipe.sharpenEnabled = false; pipe.bloomEnabled = false;
      pipe.depthOfFieldEnabled = false; profile.dof = false;
      if (ssao) { ssao.dispose(); ssao = null; this.ssao = null; }
    },
  };
}
