// Converts an equirectangular .hdr into Babylon's prefiltered .env (the file the 3D scene loads
// as scene.environmentTexture), inside the WebGL 2 test browser. Not a test: a reproducible tool.
//
//   WEBGL=2 scripts/with-lock.sh chromium tests/web/run-smoke.sh hdr-to-env.mjs <in.hdr> <out.env> [cube size, 256]
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const [base, input, output, size = "256"] = process.argv.slice(2);
if (!input || !output) { console.log("usage: hdr-to-env.mjs <base> <in.hdr> <out.env> [size]"); process.exit(2); }
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext()).newPage();
  page.on("console", (m) => console.log(`page: ${m.text()}`));
  await page.goto(new URL("index.html", base).href);
  await page.addScriptTag({ url: new URL("vendor/babylonjs/9.29.0/babylon.js", base).href });
  const b64 = await page.evaluate(async ({ hdr, size }) => {
    const bytes = Uint8Array.from(atob(hdr), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes]));
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const engine = new BABYLON.Engine(canvas, false);
    if (engine.webGLVersion < 2) throw new Error("prefiltering needs WebGL 2: run with WEBGL=2");
    const scene = new BABYLON.Scene(engine);
    // size, noMipmap=false, generateHarmonics=true, gammaSpace=false, prefilterOnLoad=true
    const tex = new BABYLON.HDRCubeTexture(url, scene, size, false, true, false, true);
    await new Promise((res, rej) => { tex.onLoadObservable.addOnce(res); setTimeout(() => rej(new Error("load timeout")), 300000); });
    const buf = await BABYLON.EnvironmentTextureTools.CreateEnvTextureAsync(tex, { imageType: "image/png" });
    let s = "";
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  }, { hdr: readFileSync(input).toString("base64"), size: Number(size) });
  writeFileSync(output, Buffer.from(b64, "base64"));
  console.log(`${output}: ${Buffer.from(b64, "base64").length} bytes`);
} finally {
  await browser.close();
}
