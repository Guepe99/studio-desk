// A small stand-in for the parts of Babylon.js the stadium modules (web/js/scene3d/stands.js,
// lighting.js, crowd.js, toon.js) touch when they load and build, so node tests can build the
// stadium and read what it made: every mesh stays in scene.meshes (merged ones too) with its name,
// builder options, position, rotation, parent, material and thin-instance buffers. No rendering.
//
//   import { installBabylon, Scene } from "./babylon-stub.mjs";
//   installBabylon();   // before importing the modules, which read window.BABYLON when they load

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
  set(x, y, z) { Object.assign(this, { x, y, z }); return this; }
  copyFrom(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z); }
  subtract(v) { return new Vector3(this.x - v.x, this.y - v.y, this.z - v.z); }
  scale(k) { return new Vector3(this.x * k, this.y * k, this.z * k); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { const l = this.length() || 1; return this.set(this.x / l, this.y / l, this.z / l); }
  asArray() { return [this.x, this.y, this.z]; }
  static Zero() { return new Vector3(); }
  static Forward() { return new Vector3(0, 0, 1); }
}

class Color3 {
  constructor(r = 0, g = 0, b = 0) { Object.assign(this, { r, g, b }); }
  scale(k) { return new Color3(this.r * k, this.g * k, this.b * k); }
  scaleInPlace(k) { this.r *= k; this.g *= k; this.b *= k; return this; }
  toLinearSpace() { return new Color3(this.r ** 2.2, this.g ** 2.2, this.b ** 2.2); }
  toGammaSpace() { return new Color3(this.r ** (1 / 2.2), this.g ** (1 / 2.2), this.b ** (1 / 2.2)); }
  asArray() { return [this.r, this.g, this.b]; }
  static FromHexString(h) { const n = parseInt(h.slice(1), 16); return new Color3((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); }
  static Black() { return new Color3(); }
}

class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { Object.assign(this, { x, y, z, w }); }
  static RotationYawPitchRollToRef(yaw, pitch, roll, q) {
    const [sy, cy, sp, cp, sr, cr] = [yaw, pitch, roll].flatMap((a) => [Math.sin(a / 2), Math.cos(a / 2)]);
    q.x = cy * sp * cr + sy * cp * sr; q.y = sy * cp * cr - cy * sp * sr;
    q.z = cy * cp * sr - sy * sp * cr; q.w = cy * cp * cr + sy * sp * sr;
  }
}

// row-major as Babylon's: the translation in m[12..14]
class Matrix {
  constructor() { this.m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  static Identity() { return new Matrix(); }
  static ComposeToRef(s, { x, y, z, w }, p, out) {
    out.m = [
      (1 - 2 * (y * y + z * z)) * s.x, 2 * (x * y + z * w) * s.x, 2 * (x * z - y * w) * s.x, 0,
      2 * (x * y - z * w) * s.y, (1 - 2 * (x * x + z * z)) * s.y, 2 * (y * z + x * w) * s.y, 0,
      2 * (x * z + y * w) * s.z, 2 * (y * z - x * w) * s.z, (1 - 2 * (x * x + y * y)) * s.z, 0,
      p.x, p.y, p.z, 1];
  }
  static FromValuesToRef(...v) { v.pop().m = v; }
}

class Node {
  constructor(name, scene, opts = {}, kind = "node") {
    Object.assign(this, { name, opts, kind, position: new Vector3(), rotation: new Vector3(), parent: null, material: null, buffers: {} });
    scene?.meshes.push(this);
  }
  lookAt(v) { this.lookedAt = v.clone(); }
  computeWorldMatrix() { return Matrix.Identity(); }
  freezeWorldMatrix() {}
  getVerticesData() { return [0, 0, 1, 0, 1, 1, 0, 1]; }
  setVerticesData() {}
  thinInstanceSetBuffer(kind, data, stride) { this.buffers[kind] = { data, stride }; }
}

class Material {
  constructor(name, scene) { Object.assign(this, { name }); scene?.materials.push(this); }
  freeze() {} unfreeze() {}
}

export class Scene {
  constructor() { Object.assign(this, { meshes: [], materials: [], lights: [] }); }
  getMaterialByName(n) { return this.materials.find((m) => m.name === n) ?? null; }
  byName(re) { return this.meshes.filter((m) => re.test(m.name)); }
}

// a 2D canvas context that takes any drawing call
const anyContext = () => new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });

export function installBabylon() {
  const MeshBuilder = new Proxy({}, { get: (_, kind) => (name, opts, sc) => new Node(name, sc, opts, kind) });
  globalThis.window ??= {};
  globalThis.window.BABYLON = {
    Vector3, Color3, Quaternion, Matrix, MeshBuilder,
    TransformNode: class extends Node { constructor(name) { super(name, null); } },
    Mesh: { DOUBLESIDE: 2, FRONTSIDE: 0, MergeMeshes: (list) => { const m = new Node("merged", null, { parts: list }, "merged"); m.parts = list; return m; } },
    StandardMaterial: Material, PBRMaterial: Material,
    MaterialPluginBase: class { constructor(material) { this.material = material; } _enable() {} },
    ShaderLanguage: { GLSL: 0 },
    DynamicTexture: class { getContext() { return anyContext(); } update() {} },
    RawTexture: { CreateRGBATexture: () => ({}) },
    Texture: { TRILINEAR_SAMPLINGMODE: 3, BILINEAR_SAMPLINGMODE: 2, WRAP_ADDRESSMODE: 1 },
    Material: { MATERIAL_ALPHATEST: 1 },
    VertexBuffer: { UVKind: "uv" },
    Ray: class { constructor(o, d) { Object.assign(this, { origin: o, direction: d }); } },
    LensFlareSystem: class { constructor(name, emitter) { Object.assign(this, { name, emitter }); } },
    LensFlare: class {},
  };
  return globalThis.window.BABYLON;
}
