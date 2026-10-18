// Post-processing. High profile: HDR pipeline, MSAA 4, a light sharpen, faint bloom on the
// brightest highlights and a soft vignette. Low profile: no pipeline at all (in software it cost
// four fifths of the frame); the materials tone-map themselves and one FXAA pass smooths edges.
// No depth of field, SSAO, SSR or TAA (docs/scene3d-research.md, "Not worth doing").
const B = window.BABYLON;

function vignette(ip) {
  ip.vignetteEnabled = true;
  ip.vignetteWeight = 1.2;
  ip.vignetteStretch = 0.4;
  ip.vignetteColor = new B.Color4(0, 0, 0, 0);
  ip.vignetteCameraFov = 0.6;
}

export function setupPost(scene, cameras, profile) {
  if (profile.msaa < 2) {
    vignette(scene.imageProcessingConfiguration);
    const fxaa = profile.fxaa ? cameras.map((c) => new B.FxaaPostProcess("fxaa", 1, c)) : [];
    return { pipe: null, fxaa, drop() {} };
  }
  const pipe = new B.DefaultRenderingPipeline("broadcast", true, scene, cameras);
  pipe.samples = profile.msaa;
  pipe.fxaaEnabled = profile.fxaa;
  pipe.sharpenEnabled = profile.sharpen;
  if (profile.sharpen) { pipe.sharpen.edgeAmount = 0.22; pipe.sharpen.colorAmount = 1; }
  pipe.bloomEnabled = profile.bloom;
  if (profile.bloom) {
    pipe.bloomThreshold = 0.92;
    pipe.bloomWeight = 0.12;
    pipe.bloomKernel = 48;
    pipe.bloomScale = 0.5;
  }
  pipe.imageProcessingEnabled = true;
  const ip = pipe.imageProcessing;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = B.ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
  vignette(ip);
  return {
    pipe,
    drop() { pipe.samples = 1; pipe.fxaaEnabled = true; pipe.sharpenEnabled = false; pipe.bloomEnabled = false; },
  };
}
