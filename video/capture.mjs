// Stills of the live site for the submission video (docs/VIDEO-SCRIPT.md), at 1920x1080, one per shot.
// Needs a Chromium with WebGL 2 on CDP_URL (see video/capture.sh). Usage: node capture.mjs [shot ...]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const BASE = "https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/";
const OUT = new URL("./public/shots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.CDP_URL);
// each shot in its own context: a new visitor, so one shot's decisions do not show in the next
let page;
const fresh = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await ctx.newPage();
  page.setDefaultTimeout(240000);
  page.on("pageerror", (e) => console.log("page error:", e.message));
  page.on("response", async (r) => { if (r.url().includes("/api/decisions")) console.log("decision", r.status(), (await r.text().catch(() => "")).slice(0, 300)); });
  page.on("request", (r) => { if (r.url().includes("/api/decisions")) console.log("post", r.postData()?.slice(0, 400)); });
};

const open = async (q) => {
  await page.goto(new URL(q, BASE).href, { waitUntil: "load" });
  await page.waitForFunction(() => window.studioDesk?.desk.ready, null, { timeout: 240000 }).catch(() => console.log("no window.studioDesk"));
  await page.waitForTimeout(8000); // the 3D draws its first frames slowly in software
  // a desk whose first requests timed out on the stalled software-3D page works in the tab, without the
  // server's checks: once the page draws, it connects again
  for (let i = 1; i <= 3 && !(await page.evaluate(() => window.studioDesk?.desk.online)); i++) {
    console.log(`desk offline, connect again (${i})`);
    await page.evaluate(() => window.studioDesk.desk.connect());
  }
  console.log("desk online:", await page.evaluate(() => window.studioDesk?.desk.online));
  await page.evaluate(() => document.querySelector("#welcome")?.close());   // the first visit's welcome, if any
};
const shot = async (name) => { await page.screenshot({ path: `${OUT}${name}.png` }); console.log("shot", name); };
const S1 = "#story-S-000001", S12 = "#story-S-000012";

const SHOTS = {
  async agents() { await open("?match=M001&t=540&view=split"); await shot("03-agents"); },
  async split() { await open("?match=M001&t=470&view=split"); await shot("01-split"); },
  async needs() { await open("?match=M001&t=475&view=split"); await shot("03-needs"); },
  async edit() {
    await open("?match=M001&t=475&view=split");
    await page.click(`${S1} .act-edited`);
    const box = page.locator(`${S1} textarea[lang="en"]`);
    const text = await box.inputValue();
    await box.fill(text.replace(/\bheads\b/, "heads at 97 km/h"));
    await shot("04a-typing");
    await page.click(`${S1} .editor .ctl.primary`);
    await page.waitForTimeout(2500);
    await shot("04b-refused");
  },
  async details() {
    await open("?match=M001&t=475&view=split");
    await page.click(`${S1} .more > summary`);
    await page.waitForTimeout(2000);
    await shot("05-details");
    await page.click(`${S1} .proposal button`);
    await page.waitForTimeout(2500);
    await shot("06a-proposal");
    await open("?match=M001&t=483&view=split");
    await shot("06b-onair");
    await page.click("#tab-audit");
    await page.waitForTimeout(2500);
    await shot("06c-audit");
  },
  async flow() {
    await open("?match=M001&t=475&view=split");
    await page.click(`${S1} .act-edited`);
    const box = page.locator(`${S1} textarea[lang="en"]`);
    await box.fill((await box.inputValue()).replace(/\bheads\b/, "heads at 97 km/h"));
    await shot("04a-typing");
    await page.click(`${S1} .editor .ctl.primary`);
    await page.waitForFunction(() => /Not saved/.test(document.querySelector("#desk")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => console.log("no refusal shown"));
    await page.waitForTimeout(1000);
    await shot("04b-refused");
    await page.locator(S1).getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(1000);
    await page.click(`${S1} .more > summary`);
    await page.click(`${S1} .proposal button`);
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.studioDesk.seek(482));
    await page.waitForTimeout(8000);
    await shot("06b-onair");
    await page.click("#tab-audit");
    await page.waitForTimeout(2500);
    await shot("06c-audit");
  },
  async audiences() {
    for (const [name, q] of [["analyst", "&audience=analyst"], ["kids", "&audience=kids"], ["fan-it", "&audience=team:T02&lang=it"]]) {
      await open(`?match=M001&t=601&view=split${q}`);
      await shot(`07-${name}`);
    }
  },
  async multiview() {
    // the four outputs at 10:02, just after the goal, then the Italian fan's window large
    // view=3d: the large window in 3D, as on a computer with a graphics card (this one draws in software)
    await page.goto(new URL("multiview.html?match=M001&t=601&view=3d", BASE).href, { waitUntil: "load" });
    await page.waitForFunction(() => window.multiview?.wins.every((w) => window.multiview.sd(w)?.match), null, { timeout: 240000 });
    await page.waitForTimeout(8000);
    await shot("07a-multiview");
    await page.click(".mv-win:nth-child(3) .mv-hit");
    await page.waitForFunction(() => { const v = window.multiview.sd(window.multiview.wins[2]).view3d; return v?.scene && v.shown === "3d"; }, null, { timeout: 240000 });
    await page.waitForTimeout(8000);
    await shot("07b-multiview-it");
  },
  async ask() {
    await open("?match=M001&t=2400&view=split");
    await page.waitForSelector("#ask-open:not([hidden])", { timeout: 60000 }).catch(() => console.log("ask button still hidden"));
    await page.click("#ask-open");
    await page.waitForTimeout(1500);
    await shot("08a-ask");
    await page.fill("#ask-q", "How many shots has each team had?");
    await shot("08a-ask");
    await page.click('#ask [type="submit"]');
    await page.waitForTimeout(25000);
    await page.evaluate(() => { for (const el of document.querySelectorAll("#ask, #ask *")) if (el.scrollHeight > el.clientHeight + 4) el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(1000);
    await shot("08b-answer");
  },
  async ai() {
    await open("?match=M001&t=2800&view=split");
    await shot("09a-ai-on");
    await page.click("#ai-switch");
    await page.waitForTimeout(2500);
    await shot("09b-ai-off");
    await page.click("#ai-switch");
    await page.click("#tab-traces");
    await page.waitForTimeout(3000);
    await shot("09c-traces");
  },
  async shift() {
    await open("?match=M001&t=4597&view=split");
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "start" }), S12);
    await page.waitForTimeout(1000);
    await shot("11a-shift");
    await page.click(`${S12} .more > summary`);
    await page.waitForTimeout(2000);
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "start" }), S12);
    await page.waitForTimeout(1000);
    await shot("11b-shift-details");
  },
};

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS)) {
  await fresh();
  try { await SHOTS[name](); } catch (e) { console.log(`FAIL ${name}: ${e.message.split("\n")[0]}`); }
}
await browser.close();
