// Grounding: what keeps players from floating (docs/broadcast3d.md, section 4).
// - Contact darkening: a small dark blob under every player's feet, on every profile and in both
//   lights. It sits on the grass, so it works whatever the players are made of (PBR, toon).
// - Blob shadows for the lights that have no shadow map: at night one long faint blob per corner
//   mast, pointing away from it and as long as a 1.82 m player's shadow at that mast's elevation;
//   in daylight without sun shadows (the low profile) the contact blob grows to the old 1.5 m
//   soft round shadow.
// One thin-instanced plane per kind, so two draw calls whatever the number of players.
const B = window.BABYLON;
const PLAYER_H = 1.82;
const CONTACT_D = 0.95;   // metres across the contact blob
const CAST_W = 0.7;       // metres across a mast's blob shadow

// Alpha mask as raw pixels (small canvas textures read back empty on the WebGL 1 test renderer).
// alpha(u, v): u across, v along, both -1..1.
function mask(scene, name, alpha) {
  const S = 64, px = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    px[(y * S + x) * 4 + 3] = 255 * Math.max(0, Math.min(1, alpha((x + 0.5) / S * 2 - 1, (y + 0.5) / S * 2 - 1)));
  }
  const t = B.RawTexture.CreateRGBATexture(px, S, S, scene, true, false, B.Texture.TRILINEAR_SAMPLINGMODE);
  t.name = name; t.hasAlpha = true;
  return t;
}

function blobMesh(scene, name, tex, alpha) {
  const m = new B.StandardMaterial(`${name}Mat`, scene);
  m.diffuseTexture = tex; m.useAlphaFromDiffuseTexture = true;
  m.disableLighting = true; m.emissiveColor = B.Color3.Black(); m.diffuseColor = B.Color3.Black();
  m.disableDepthWrite = true; m.zOffset = -2; m.alpha = alpha;
  const mesh = B.MeshBuilder.CreateGround(name, { width: 1, height: 1 }, scene);
  mesh.material = m;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.isPickable = false;
  return mesh;
}

// Shadow on the ground of a player standing at (x, z) lit from a mast at m (world metres):
// direction away from the mast, length from the light's elevation, capped at 6 m. Written into
// out when given (Grounding.set, up to 4 a player a frame), else into a new {dir, len}.
export function castBlob(x, z, m, out = { dir: [0, 0], len: 0 }) {
  const dx = x - m.x, dz = z - m.z, flat = Math.hypot(dx, dz);
  out.len = Math.min(6, Math.max(1.2, PLAYER_H * flat / Math.max(m.y, 1)));
  out.dir[0] = dx / flat; out.dir[1] = dz / flat;
  return out;
}

export class Grounding {
  constructor(scene, count, light) {
    this.light = light;
    this.count = count;
    this.enabled = true;
    // dark core, soft rim
    this.contact = blobMesh(scene, "contactShadows", mask(scene, "contactMask", (u, v) => 0.75 * (1 - Math.hypot(u, v)) ** 1.3), 1);
    // a long soft shadow, darkest at the feet end (local -z, which is v = 1 of the ground's
    // texture) and fading out along it
    this.cast = blobMesh(scene, "castShadows", mask(scene, "castMask", (u, v) => (1 - u * u) * Math.max(0, 1 - Math.abs(0.8 - v) / 1.8) ** 1.2 * 0.6), 1);
    this.contactBuf = new Float32Array(16 * count);
    this.castBuf = new Float32Array(16 * count * 4);
    this.contact.thinInstanceSetBuffer("matrix", this.contactBuf, 16, false);
    this.cast.thinInstanceSetBuffer("matrix", this.castBuf, 16, false);
    this._m = new B.Matrix(); this._q = new B.Quaternion(); this._s = new B.Vector3(); this._p = new B.Vector3();
    this.frame();
  }

  // Before the players of a frame: which blobs the lights ask for.
  frame() {
    this.lights = this.light.blobLights();   // null: one round blob (day, no sun shadows)
    this.cast.isVisible = this.enabled && !!this.lights?.length;
    this.cast.material.alpha = 0.42;
    this.contact.isVisible = this.enabled;
    // day without sun shadows: the contact blob grows into the old soft round shadow
    this.contactD = this.lights === null ? 1.5 : CONTACT_D;
  }

  // Player k at world (x, z), or hidden.
  set(k, x, z, visible) {
    const m = this._m, q = this._q, s = this._s, p = this._p;
    if (!visible) {
      B.Matrix.ScalingToRef(0, 0, 0, m);
      m.copyToArray(this.contactBuf, k * 16);
      for (let j = 0; j < 4; j++) m.copyToArray(this.castBuf, (k * 4 + j) * 16);
      return;
    }
    B.Matrix.ComposeToRef(s.set(this.contactD, 1, this.contactD), q.set(0, 0, 0, 1), p.set(x, 0.021, z), m);
    m.copyToArray(this.contactBuf, k * 16);
    for (let j = 0; j < 4; j++) {
      if (this.lights && j < this.lights.length) {
        const { dir, len } = castBlob(x, z, this.lights[j], (this._blob ??= { dir: [0, 0], len: 0 }));
        // the mask's v axis is local z: turn it onto the shadow's direction
        B.Quaternion.RotationYawPitchRollToRef(Math.atan2(dir[0], dir[1]), 0, 0, q);
        B.Matrix.ComposeToRef(s.set(CAST_W, 1, len), q, p.set(x + dir[0] * len * 0.45, 0.02, z + dir[1] * len * 0.45), m);
      } else B.Matrix.ScalingToRef(0, 0, 0, m);
      m.copyToArray(this.castBuf, (k * 4 + j) * 16);
    }
  }

  commit() {
    this.contact.thinInstanceBufferUpdated("matrix");
    this.cast.thinInstanceBufferUpdated("matrix");
  }
}
