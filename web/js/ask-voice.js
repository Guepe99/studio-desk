// Ask the studio by voice (POST api/ask/voice, studiodesk/speech.py). The microphone button records at most
// MAX_S seconds; the page turns the samples into 16 kHz mono 16-bit PCM WAV, one of the two formats the Azure
// Speech REST API for short audio takes, since MediaRecorder gives WebM or MP4 in most browsers. The text that
// comes back goes into the question box, and the visitor sends it with Ask as a typed question. The samples are
// dropped once sent: no audio is kept, here or on the server.
export const MAX_S = 10;
export const RATE = 16000;
const MIN_SAMPLES = RATE / 5; // under 0.2 s nothing is sent (the server refuses it too)

// a secure page with the microphone API and audio worklets; the browser asks for the microphone only on click
export function canRecord(w = globalThis) {
  return !!(w.isSecureContext && w.navigator?.mediaDevices?.getUserMedia && w.AudioContext && w.AudioWorkletNode);
}

// the recorded blocks at `from` Hz as one block at `to` Hz: each output sample is the mean of the input
// samples it covers (a crude low-pass, enough for speech), at most MAX_S seconds
export function downsample(chunks, from, to = RATE) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  const ratio = from / to, n = Math.min(Math.floor(total / ratio), MAX_S * to);
  const out = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const a = Math.floor(j * ratio), b = Math.max(a + 1, Math.min(total, Math.floor((j + 1) * ratio)));
    let sum = 0;
    for (let i = a; i < b; i++) sum += all[i];
    out[j] = sum / (b - a);
  }
  return out;
}

// a mono 16-bit PCM WAV file: the 44-byte RIFF header, then the samples clamped to -1..1
export function encodeWav(samples, rate = RATE) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE");
  text(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, "data"); v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return buf;
}

// the status key for the server's reply: r is null when the request never got an answer
export function replyStatus(r, data) {
  if (!r) return "askNet";
  if (r.status === 429) return "voiceLimit";
  if (r.ok && typeof data?.text === "string") return data.text.trim() ? "voiceDone" : "voiceNone";
  return "voiceErr";
}

export class AskVoice {
  // ask: the Ask panel (ask.js), whose status line and question box this fills
  constructor(ask, button) {
    Object.assign(this, { ask, button, recording: false, busy: false, chunks: [] });
    button.addEventListener("click", () => (this.recording ? this.stop() : this.start()));
  }

  // after the Ask probe: shown only when the server has Speech and this browser can record
  enable(on) {
    this.button.hidden = !(on && canRecord());
    this.render();
  }

  status(key) {
    this.ask.status = key;
    this.ask.render();
  }

  async start() {
    if (this.busy || this.ask.busy) return;
    this.busy = this.ask.busy = true; // no question goes out while one is being recorded or transcribed
    this.chunks = [];
    try {
      this.ctx = new AudioContext(); // made before the first await, in the click: Safari starts it suspended otherwise
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      await this.ctx.audioWorklet.addModule("js/ask-voice-worklet.js");
      const node = new AudioWorkletNode(this.ctx, "ask-voice-tap");
      let n = 0;
      node.port.onmessage = (e) => {
        if (!this.recording) return;
        this.chunks.push(e.data);
        if ((n += e.data.length) >= this.ctx.sampleRate * MAX_S) this.stop();
      };
      this.ctx.createMediaStreamSource(this.stream).connect(node);
      node.connect(this.ctx.destination); // pulls the node through the graph; its output is silence
    } catch {
      this.release();
      this.busy = this.ask.busy = false;
      return this.status("voiceMicOff");
    }
    this.recording = true;
    this.timer = setTimeout(() => this.stop(), MAX_S * 1000 + 500); // in case the blocks stop coming
    this.status("voiceRec");
  }

  // the microphone and the audio graph go; the browser's recording indicator turns off
  release() {
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.ctx?.close().catch(() => {});
    this.stream = this.ctx = null;
  }

  // the panel closed or questions were turned off: nothing is sent
  cancel() {
    if (!this.recording) return;
    this.recording = this.busy = this.ask.busy = false;
    this.release();
    this.chunks = [];
    this.render();
  }

  async stop() {
    if (!this.recording) return;
    this.recording = false;
    const rate = this.ctx.sampleRate, lang = this.ask.state.lang;
    this.release();
    const samples = downsample(this.chunks, rate);
    this.chunks = [];
    let key = "voiceNone";
    if (samples.length >= MIN_SAMPLES) {
      this.status("voiceWait");
      let r = null, data = null;
      try {
        r = await fetch(`api/ask/voice?lang=${lang}`, { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(30000),
          headers: { "content-type": "audio/wav" }, body: encodeWav(samples) });
        data = await r.json().catch(() => null);
      } catch { r = null; }
      key = replyStatus(r, data);
      if (key === "voiceDone") this.ask.input.value = data.text.trim().slice(0, 280); // the box's maxlength
    }
    this.busy = this.ask.busy = false;
    this.status(key);
    this.ask.input.focus();
  }

  // the label says what a press does; aria-disabled, as on Ask, so the focus stays on the button
  render() {
    const label = this.ask.t(this.recording ? "voiceStop" : "voiceMic");
    if (this.button.textContent !== label) this.button.textContent = label;
    this.button.classList.toggle("rec", this.recording);
    this.button.setAttribute("aria-disabled", String(this.busy && !this.recording));
  }
}
