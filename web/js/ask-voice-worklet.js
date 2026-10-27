// Ask the studio by voice: copies each block of microphone samples (first channel) to web/js/ask-voice.js.
// Its output stays silent.
registerProcessor("ask-voice-tap", class extends AudioWorkletProcessor {
  process([input]) {
    if (input?.[0]?.length) this.port.postMessage(input[0].slice());
    return true;
  }
});
