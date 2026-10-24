// Babylon on a NullEngine in node, for tests of the camera director (web/js/scene3d/camera.js)
// without a browser: nothing is drawn, the cameras move as on the page.
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let mods = null;
async function babylon() {
  if (mods) return mods;
  globalThis.window = globalThis;
  vm.runInThisContext(readFileSync(path.join(ROOT, "web/vendor/babylonjs/9.29.0/babylon.js"), "utf8"));
  const { Cameras } = await import(path.join(ROOT, "web/js/scene3d/camera.js"));
  const { Match } = await import(path.join(ROOT, "web/js/match.js"));
  return (mods = { B: globalThis.BABYLON, Cameras, Match });
}

// The match id of web/data, or null when it is not there (web/data is not in git).
export async function loadMatch(id) {
  const dir = path.join(ROOT, "web/data", id);
  if (!existsSync(path.join(dir, "meta.json"))) return null;
  const { Match } = await babylon();
  const j = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const buf = readFileSync(path.join(dir, "tracking.f32"));
  return new Match(j("meta.json"), j("events.json"), j("facts.json"), j("cues.json"), new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

// The cameras of a 1280 x 720 picture of match m.
export async function cameras(m) {
  const { B, Cameras } = await babylon();
  const scene = new B.Scene(new B.NullEngine({ renderWidth: 1280, renderHeight: 720 }));
  return new Cameras(scene, m, 1);
}
