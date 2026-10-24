// Quality profiles of the 3D scene, picked from what the browser offers (docs/scene3d-research.md,
// "Test renderer"), overridable with ?quality=low|high. The profile holds for the whole replay: no optimizer
// lowers it while playing (21/10/2026, a softer picture was what a viewer noticed); a machine that
// cannot keep up is offered the 2D pitch instead (view3d.js, SLOW_FPS).
const B = window.BABYLON;

export const PROFILES = {
  // laptop or desktop with WebGL 2: three shadow cascades fitted to the view, sharpen, bloom (MSAA 4
  // only where SSAO2 is not supported, FXAA with it, post.js),
  // depth of field on tight shots and replays, SSAO2 at half resolution (docs/broadcast3d.md)
  high: { name: "high", shadows: "csm", shadowMap: 1024, cascades: 3, autoDepthBounds: true, shadowQuality: "medium",
    msaa: 4, fxaa: false, sharpen: true, bloom: true, bloomScale: 0.5, dof: true, ssao: true,
    maxWidth: 1920, detailScales: 2, crowd: 1, aniso: 8,
    // two 3D rows, no crowd outline: in SwiftShader four rows with outlines made the frame 3.6 times slower (18/10/2026)
    crowd3dRows: 2, crowdOutline: false, crowdHair: true },
  // phone, WebGL 1 or a software renderer: blob shadows (two cascades on a WebGL 2 phone, see
  // pickProfile), FXAA, bloom at half the high profile's scale, no depth of field or SSAO, one
  // grass detail scale, sparser crowd
  low: { name: "low", shadows: "blob", shadowMap: 0, cascades: 2, autoDepthBounds: false, shadowQuality: "low",
    msaa: 1, fxaa: true, sharpen: true, bloom: true, bloomScale: 0.25, dof: false, ssao: false,
    maxWidth: 1100, detailScales: 1, crowd: 0.3, aniso: 4,
    crowd3dRows: 0, crowdOutline: false, crowdHair: false },   // cards only: in lavapipe the 3D row and the hair cards cost a quarter of the frame rate
};

// env: {webGLVersion, maxMSAA, coarsePointer, shortSide (CSS px)}; param: the ?quality= value.
export function pickProfile(env, param) {
  if (param === "low" || param === "high") return { ...PROFILES[param], forced: true };
  const phone = env.coarsePointer && env.shortSide < 820;
  const high = env.webGLVersion >= 2 && env.maxMSAA >= 4 && !phone;
  if (high) return { ...PROFILES.high, forced: false };
  // a phone with WebGL 2 still gets a real shadow map: two cascades of 1024 px
  if (env.webGLVersion >= 2) return { ...PROFILES.low, shadows: "csm", shadowMap: 1024, forced: false };
  return { ...PROFILES.low, forced: false };
}

export function detectEnv(engine) {
  return {
    webGLVersion: engine.webGLVersion,
    maxMSAA: engine.getCaps().maxMSAASamples ?? 1,
    coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
    shortSide: Math.min(window.innerWidth, window.innerHeight),
  };
}
