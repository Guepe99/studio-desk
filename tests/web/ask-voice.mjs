// Browser test of Ask the studio by voice against the real API with a Speech stub (tests/web/ask_voice_server.py)
// and Chromium's fake microphone, on the DEMO fixture.
//
//   scripts/with-lock.sh chromium tests/web/run-smoke.sh ask-voice.mjs
//
// Checks: the page may use the microphone (Permissions-Policy); the microphone button appears only when the
// server says voice is there; a mouse round in English and a keyboard round in Italian: Speak, the
// recording state with Stop, the WAV sent to api/ask/voice in the page language, the text in the question
// box and the status asking to check it; nothing is sent to api/ask until the visitor presses Ask.
// Screenshots: out/shots/ask-voice-*.png (SHOTS=dir to put them elsewhere).
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${homedir()}/bin/pagine/`);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:8000/";
const shots = process.env.SHOTS ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/shots");
mkdirSync(shots, { recursive: true });
const fakeMic = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
const browser = process.env.CDP_URL ? await chromium.connectOverCDP(process.env.CDP_URL) : await chromium.launch({ args: fakeMic });
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

async function open(lang, route) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.grantPermissions(["microphone"], { origin: new URL(base).origin });
  const page = await ctx.newPage();
  const sent = [];
  page.on("request", (r) => { if (r.url().includes("/api/ask")) sent.push(r); });
  if (route) await page.route("**/api/ask", route);
  const res = await page.goto(new URL(`?match=DEMO&lang=${lang}`, base).href);
  return { ctx, page, sent, res };
}

const voicePosts = (sent) => sent.filter((r) => r.method() === "POST" && r.url().includes("/api/ask/voice"));

try {
  // 1. English, with the mouse
  {
    const { ctx, page, sent, res } = await open("en");
    check((res.headers()["permissions-policy"] ?? "").includes("microphone=(self)"), "the page may use the microphone");
    await page.locator("#ask-open").waitFor({ state: "visible", timeout: 20000 });
    await page.click("#ask-open");
    const mic = page.locator("#ask-mic");
    await mic.waitFor({ state: "visible", timeout: 5000 });
    check((await mic.textContent()) === "Speak", "the button says Speak");
    await mic.click();
    await page.waitForFunction(() => document.querySelector("#ask-mic").textContent === "Stop", null, { timeout: 5000 });
    check((await page.textContent("#ask-status")).startsWith("Listening."), "the status says it is listening");
    check(await mic.evaluate((b) => b.classList.contains("rec")), "the button shows the recording dot");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(shots, "ask-voice-recording.png") });
    await mic.click();
    await page.waitForFunction(() => document.querySelector("#ask-q").value !== "", null, { timeout: 10000 });
    check((await page.inputValue("#ask-q")) === "Who has scored so far?", "the text is in the question box");
    check((await page.textContent("#ask-status")) === "Check the text, then press Ask.", "the status asks to check it");
    const [post] = voicePosts(sent);
    const body = post?.postDataBuffer();
    check(post?.url().endsWith("/api/ask/voice?lang=en") && post.headers()["content-type"] === "audio/wav", "one WAV post in English");
    check(body?.subarray(0, 4).toString() === "RIFF" && body.readUInt32LE(24) === 16000 && body.length > 44 + 32000,
      `16 kHz WAV of more than 1 s (${body?.length} bytes)`);
    check(!sent.some((r) => r.method() === "POST" && r.url().endsWith("/api/ask")), "no question is sent before Ask");
    check(await page.evaluate(() => document.activeElement?.id === "ask-q"), "the focus is on the question box");
    await page.screenshot({ path: path.join(shots, "ask-voice-done.png") });
    await ctx.close();
  }
  // 2. Italian, with the keyboard only
  {
    const { ctx, page, sent } = await open("it");
    await page.locator("#ask-open").waitFor({ state: "visible", timeout: 20000 });
    await page.focus("#ask-open");
    await page.keyboard.press("Enter");
    const mic = page.locator("#ask-mic");
    await mic.waitFor({ state: "visible", timeout: 5000 });
    check((await mic.textContent()) === "Parla", "Italian: the button says Parla");
    await page.keyboard.press("Tab"); // from the question box to the microphone
    check(await page.evaluate(() => document.activeElement?.id === "ask-mic"), "Italian: Tab reaches the microphone");
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector("#ask-mic").textContent === "Stop", null, { timeout: 5000 });
    await page.waitForTimeout(1000);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#ask-q").value !== "", null, { timeout: 10000 });
    check((await page.inputValue("#ask-q")) === "Chi ha segnato finora?", "Italian: the text is in the box");
    check(voicePosts(sent)[0]?.url().endsWith("lang=it"), "Italian: the clip is sent with lang=it");
    await ctx.close();
  }
  // 3. a server without Speech: no microphone button
  {
    const { ctx, page } = await open("en", (r) => (r.request().method() === "GET"
      ? r.fulfill({ json: { available: true, voice: false } }) : r.continue()));
    await page.locator("#ask-open").waitFor({ state: "visible", timeout: 20000 });
    await page.click("#ask-open");
    check(await page.locator("#ask-mic").isHidden(), "no Speech on the server: no microphone button");
    await ctx.close();
  }
} catch (e) {
  fails.push(String(e));
  console.error(e);
}
await browser.close();
if (fails.length) { console.error(`ask-voice: ${fails.length} failed`); process.exit(1); }
console.log("ask-voice: all checks passed");
