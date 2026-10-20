// The still of the 3D stadium the broadcast page shows while the 3D view loads (web/img/stadium3d.jpg):
// M001 at kick-off from the broadcast camera, the 3D canvas alone. Run through the browser lock:
//
//   WEBGL=2 scripts/with-lock.sh chromium tests/web/run-smoke.sh ../../scripts/poster3d.mjs
//
// then, blurred so it reads as a stand-in for any match (one match's kits, a player mid-move), the frame's round corners cut off:
//   ffmpeg -y -i out/shots/stadium3d.png -vf "crop=iw-48:ih-27,scale=1280:720,gblur=sigma=10,eq=brightness=-0.06" -q:v 6 web/img/stadium3d.jpg
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:8765/";
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../out/shots");
mkdirSync(out, { recursive: true });

const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
await page.goto(`${base}index.html?match=M001&view=3d`);
await page.waitForFunction(() => window.studioDesk?.view3d?.scene || window.studioDesk?.view3d?.failed, null, { timeout: 300000 });
if (await page.evaluate(() => window.studioDesk.view3d.failed)) throw new Error("the 3D view did not load");
await page.evaluate(() => window.studioDesk.seek(2));
await page.waitForFunction(() => window.studioDesk.view3d.ready, null, { timeout: 120000 });
await page.evaluate(() => { for (const id of ["#overlay", "#scorebug"]) document.querySelector(id).style.visibility = "hidden"; });   // no score bug of one match
await page.waitForTimeout(3000);
// a software renderer takes seconds a frame and the canvas never counts as stable: a clip of the page instead
const box = await page.evaluate(() => { const r = document.querySelector("#view3d").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
await page.screenshot({ path: `${out}/stadium3d.png`, clip: box, timeout: 180000 });
console.log(`poster: ${out}/stadium3d.png`);
await browser.close();
