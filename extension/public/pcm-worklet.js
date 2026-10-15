// PCM tap — runs on the audio thread, replacing the deprecated
// ScriptProcessorNode. Accumulates the mixed mono input into fixed-size blocks
// and posts each (transferred, zero-copy) to the offscreen document, which
// converts to int16 and streams it over the WebSocket to the scribe service.
//
// Plain JS (no bundling): it's loaded as a worklet module via
// audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js')).

const CHUNK = 4096; // ~85 ms at 48 kHz — responsive yet cheap

class PCMTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(CHUNK);
    this._n = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this._buf[this._n++] = channel[i];
        if (this._n === CHUNK) {
          const out = this._buf.slice(0);
          this.port.postMessage(out, [out.buffer]);
          this._n = 0;
        }
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor('pcm-tap', PCMTap);
