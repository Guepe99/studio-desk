// Post-processing: HDR pipeline, MSAA 4 on WebGL 2 (FXAA otherwise), a light sharpen, faint bloom
// on the brightest highlights and a soft vignette. No depth of field, SSAO, SSR or TAA (see
// docs/scene3d-research.md, "Not worth doing").
const B = window.BABYLON;

export function setupPost(scene, cameras, profile) {
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
  ip.vignetteEnabled = true;
  ip.vignetteWeight = 1.2;
  ip.vignetteStretch = 0.4;
  ip.vignetteColor = new B.Color4(0, 0, 0, 0);
  ip.vignetteCameraFov = 0.6;
  return {
    pipe,
    drop() { pipe.samples = 1; pipe.fxaaEnabled = true; pipe.sharpenEnabled = false; pipe.bloomEnabled = false; },
  };
}
