// web/js/ask-voice.js: the recorded samples become the 16 kHz mono WAV the server takes, and the reply fills
// the question box or says what went wrong.
//   node --test tests/web/ask-voice.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { AskVoice, canRecord, downsample, encodeWav, replyStatus, MAX_S, RATE } from "../../web/js/ask-voice.js";

test("downsample: 48 kHz to 16 kHz averages each group of three, and stops at MAX_S", () => {
  const got = downsample([new Float32Array([0, 0.3, 0.6]), new Float32Array([1, 1, 1, 0.5])], 48000);
  assert.equal(got.length, 2);
  assert.ok(Math.abs(got[0] - 0.3) < 1e-6 && got[1] === 1);
  assert.equal(downsample([new Float32Array(48000 * (MAX_S + 2))], 48000).length, MAX_S * RATE);
  assert.equal(downsample([new Float32Array([0.5, -0.5])], 16000).length, 2); // same rate: unchanged
  assert.equal(downsample([], 44100).length, 0);
});

test("encodeWav: a RIFF header for 16 kHz mono 16-bit PCM, then the samples clamped", () => {
  const buf = encodeWav(new Float32Array([0, 1, -1, 2]));
  const v = new DataView(buf), text = (a, n) => String.fromCharCode(...new Uint8Array(buf, a, n));
  assert.equal(buf.byteLength, 44 + 8);
  assert.deepEqual([text(0, 4), text(8, 4), text(12, 4), text(36, 4)], ["RIFF", "WAVE", "fmt ", "data"]);
  assert.deepEqual([v.getUint32(4, true), v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true),
    v.getUint32(28, true), v.getUint16(32, true), v.getUint16(34, true), v.getUint32(40, true)],
  [44, 1, 1, 16000, 32000, 2, 16, 8]);
  assert.deepEqual([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true)), [0, 32767, -32767, 32767]);
});

test("replyStatus: text, nothing heard, the cap, errors and no answer", () => {
  const r = (status) => ({ status, ok: status < 300 });
  assert.equal(replyStatus(r(200), { text: "Who scored?" }), "voiceDone");
  assert.equal(replyStatus(r(200), { text: " " }), "voiceNone");
  assert.equal(replyStatus(r(429), { status: "limit" }), "voiceLimit");
  for (const s of [413, 422, 502, 503]) assert.equal(replyStatus(r(s), { detail: "x" }), "voiceErr");
  assert.equal(replyStatus(r(200), null), "voiceErr");
  assert.equal(replyStatus(null, null), "askNet");
});

test("canRecord: a secure page with getUserMedia and audio worklets only", () => {
  const w = { isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } }, AudioContext: class {}, AudioWorkletNode: class {} };
  assert.equal(canRecord(w), true);
  assert.equal(canRecord({ ...w, isSecureContext: false }), false);
  assert.equal(canRecord({ ...w, navigator: {} }), false);
  assert.equal(canRecord({ ...w, AudioWorkletNode: undefined }), false);
});

// a stand-in for the browser: a microphone that sends `blocks` of 48 kHz samples, and a server reply
function rig({ reply = { status: 200, ok: true, json: async () => ({ text: "Who scored first?" }) }, denied = false, blocks = 10 } = {}) {
  const log = { stopped: 0, closed: 0, sent: [] };
  let port = null;
  globalThis.isSecureContext = true;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => {
    if (denied) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    return { getTracks: () => [{ stop: () => log.stopped++ }] };
  } } } });
  globalThis.AudioContext = class {
    sampleRate = 48000;
    audioWorklet = { addModule: async () => {} };
    destination = {};
    createMediaStreamSource() { return { connect() {} }; }
    async close() { log.closed++; }
  };
  globalThis.AudioWorkletNode = class { constructor() { port = this.port = {}; } connect() {} };
  globalThis.fetch = async (url, init) => { log.sent.push({ url, init }); return reply; };
  log.speak = () => { for (let i = 0; i < blocks; i++) port.onmessage({ data: new Float32Array(4800).fill(0.1) }); };
  const button = { textContent: "", hidden: true, attrs: {}, classList: { toggle() {} }, addEventListener(_, f) { this.click = f; },
    setAttribute(k, v) { this.attrs[k] = v; } };
  const ask = { state: { lang: "it" }, busy: false, status: "", t: (k) => k, input: { value: "", focus() {} }, statuses: [],
    render() { this.statuses.push(this.status); voice.render(); } };
  const voice = new AskVoice(ask, button);
  return { ask, voice, button, log };
}

test("record, stop, transcribe: the text goes into the box and the microphone is released", async () => {
  const { ask, voice, button, log } = rig();
  voice.enable(true);
  assert.equal(button.hidden, false);
  await button.click();
  assert.equal(button.textContent, "voiceStop");
  assert.equal(ask.busy, true); // no question goes out meanwhile
  log.speak();
  await button.click();
  assert.equal(log.stopped, 1);
  assert.equal(log.closed, 1);
  assert.equal(log.sent.length, 1);
  const { url, init } = log.sent[0];
  assert.equal(url, "api/ask/voice?lang=it");
  assert.equal(init.headers["content-type"], "audio/wav");
  assert.equal(init.body.byteLength, 44 + 2 * 16000); // 1 s at 48 kHz, sent at 16 kHz
  assert.equal(ask.input.value, "Who scored first?");
  assert.deepEqual(ask.statuses.filter(Boolean), ["voiceRec", "voiceWait", "voiceDone"]);
  assert.equal(ask.busy, false);
  assert.equal(button.textContent, "voiceMic");
  assert.equal(button.attrs["aria-disabled"], "false");
});

test("recording stops by itself at MAX_S", async () => {
  const { voice, button, log } = rig({ blocks: MAX_S * 10 + 5 });
  voice.enable(true);
  await button.click();
  log.speak();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(voice.recording, false);
  assert.equal(log.sent[0].init.body.byteLength, 44 + 2 * MAX_S * RATE);
});

test("a blocked microphone, too short a clip, a cap and a closed panel", async () => {
  let t = rig({ denied: true });
  await t.button.click();
  assert.equal(t.ask.status, "voiceMicOff");
  assert.equal(t.ask.busy, false);

  t = rig({ blocks: 1 }); // 0.1 s: not sent
  await t.button.click();
  t.log.speak();
  await t.button.click();
  assert.equal(t.log.sent.length, 0);
  assert.equal(t.ask.status, "voiceNone");

  t = rig({ reply: { status: 429, ok: false, json: async () => ({ status: "limit" }) } });
  await t.button.click();
  t.log.speak();
  await t.button.click();
  assert.equal(t.ask.status, "voiceLimit");
  assert.equal(t.ask.input.value, "");

  t = rig();
  await t.button.click();
  t.log.speak();
  t.voice.cancel(); // the panel closed: nothing is sent and the microphone goes
  assert.equal(t.log.sent.length, 0);
  assert.equal(t.log.stopped, 1);
  assert.equal(t.ask.busy, false);

  t = rig();
  const started = t.button.click(); // the permission prompt is open
  t.voice.cancel(); // the panel closed before the visitor answered it
  await started;
  assert.equal(t.voice.recording, false);
  assert.equal(t.log.stopped, 1); // the granted microphone is let go at once
  assert.equal(t.ask.busy, false);
  assert.ok(!t.ask.statuses.includes("voiceRec"));
  await t.button.click(); // and a new press records again
  assert.equal(t.voice.recording, true);
});

test("hidden when the server has no Speech or the browser cannot record", () => {
  const t = rig();
  t.voice.enable(false);
  assert.equal(t.button.hidden, true);
  globalThis.AudioWorkletNode = undefined;
  t.voice.enable(true);
  assert.equal(t.button.hidden, true);
});
