// Daylight: image-based lighting from a prefiltered stadium HDRI, one sun with cascaded shadow maps
// (high profile) and the PBR materials everything is made of. Khronos PBR Neutral tone mapping keeps
// kit colours as the export gives them.
const B = window.BABYLON;

export const ENV_URL = "vendor/polyhaven/orlando_stadium_256.env";
// Sun of the HDRI (52 degrees up). It shines from behind the main camera's left shoulder, so the
// shadows fall away from the viewer, as the regulations ask for the main camera.
export const SUN_DIR = new B.Vector3(0.38, -0.79, 0.48).normalize();

export function setupLighting(scene, profile) {
  scene.environmentTexture = B.CubeTexture.CreateFromPrefilteredData(ENV_URL, scene);
  // the HDRI's sun sits at u = 0.6 of the panorama: turn it to the same azimuth as SUN_DIR
  scene.environmentTexture.rotationY = Math.atan2(-SUN_DIR.x, -SUN_DIR.z) - 0.6 * 2 * Math.PI + Math.PI / 2;
  scene.environmentIntensity = 0.85;

  const ip = scene.imageProcessingConfiguration;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = B.ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
  ip.exposure = 1.0;
  ip.contrast = 1.08;

  const sun = new B.DirectionalLight("sun", SUN_DIR.clone(), scene);
  sun.intensity = 2.6;
  sun.diffuse = new B.Color3(1, 0.975, 0.94);   // about 5,600 K
  sun.specular = new B.Color3(0.6, 0.6, 0.6);
  sun.position = SUN_DIR.scale(-150);

  let csm = null;
  if (profile.shadows === "csm") {
    csm = new B.CascadedShadowGenerator(profile.shadowMap, sun);
    csm.numCascades = 2;
    csm.lambda = 0.75;
    csm.stabilizeCascades = true;
    csm.shadowMaxZ = 150;              // the far touchline is about 110 m from the main camera
    csm.cascadeBlendPercentage = 0.08;
    csm.usePercentageCloserFiltering = true;
    csm.filteringQuality = B.ShadowGenerator.QUALITY_LOW;
    csm.depthClamp = true;
    csm.bias = 0.004;
    csm.normalBias = 0.02;
    csm.darkness = 0.15;               // sky light still reaches into the shade
    csm.transparencyShadow = false;
  }
  return {
    sun, csm,
    addCaster(mesh) { if (csm) csm.addShadowCaster(mesh, true); },
    // the optimizer's last resort: no shadow maps, the caller turns blob shadows on
    dropShadows() { if (csm) { csm.getShadowMap().refreshRate = 0; csm.dispose(); csm = null; this.csm = null; } },
  };
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
