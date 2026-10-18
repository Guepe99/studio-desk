// Prints what the test browser's WebGL offers the 3D scene: WebGL version, MSAA samples, float and
// half-float render targets, depth textures. The quality profiles in web/js/scene3d/quality.js and
// docs/scene3d-research.md ("Test renderer") are decided from this output.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh webgl-caps.mjs
import { createRequire } from "node:module";
import { homedir } from "node:os";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
  await page.goto(new URL("index.html", base).href);
  await page.addScriptTag({ url: new URL("vendor/babylonjs/9.29.0/babylon.js", base).href });
  const caps = await page.evaluate(() => {
    const c = document.createElement("canvas");
    document.body.append(c);
    const raw = c.getContext("webgl2");
    const rawInfo = raw ? {
      maxSamples: raw.getParameter(raw.MAX_SAMPLES),
      colorBufferFloat: !!raw.getExtension("EXT_color_buffer_float"),
      colorBufferHalfFloat: !!raw.getExtension("EXT_color_buffer_half_float"),
      floatLinear: !!raw.getExtension("OES_texture_float_linear"),
      renderer: raw.getParameter(raw.RENDERER),
    } : null;
    const c2 = document.createElement("canvas");
    document.body.append(c2);
    const engine = new BABYLON.Engine(c2, true);
    const k = engine.getCaps();
    return {
      webgl2Context: !!raw, raw: rawInfo,
      babylon: {
        webGLVersion: engine.webGLVersion, maxMSAASamples: k.maxMSAASamples,
        textureFloatRender: k.textureFloatRender, textureHalfFloatRender: k.textureHalfFloatRender,
        textureFloatLinearFiltering: k.textureFloatLinearFiltering, depthTextureExtension: k.depthTextureExtension,
        maxTextureSize: k.maxTextureSize, maxAnisotropy: k.maxAnisotropy, standardDerivatives: k.standardDerivatives,
      },
    };
  });
  console.log(JSON.stringify(caps, null, 2));
} finally {
  await browser.close();
}
