// patter's tap on the engine's output (what reaches the speakers). It sends
// the page what the engine plays in chunks of interleaved stereo, each stamped
// with the AudioContext frame it starts at; the page hands the buffers back to
// be filled again, so a running tap allocates nothing. Its own output is
// silence: it's connected to the speakers only so that it always runs.

class PatterTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.capacity = (options.processorOptions && options.processorOptions.chunkFrames) || 4096;
    this.pool = [];
    this.buf = null;
    this.fill = 0;
    this.start = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'reuse') {
        if (m.buffer.byteLength === this.capacity * 8) this.pool.push(new Float32Array(m.buffer));
      } else if (m.type === 'flush') {
        this.send();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  send() {
    if (!this.buf || !this.fill) return;
    this.port.postMessage({ type: 'chunk', frame: this.start, frames: this.fill, buffer: this.buf.buffer }, [this.buf.buffer]);
    this.buf = null;
    this.fill = 0;
  }

  process(inputs) {
    const ch = inputs[0];
    const n = ch && ch[0] ? ch[0].length : 128;
    if (this.buf && this.fill + n > this.capacity) this.send();
    if (!this.buf) {
      this.buf = this.pool.pop() || new Float32Array(this.capacity * 2);
      this.start = currentFrame;
      this.fill = 0;
    }
    const b = this.buf;
    const o = this.fill * 2;
    if (ch && ch.length) {
      const l = ch[0];
      const r = ch[1] || ch[0];
      for (let i = 0; i < n; i++) {
        b[o + 2 * i] = l[i];
        b[o + 2 * i + 1] = r[i];
      }
    } else {
      b.fill(0, o, o + 2 * n);
    }
    this.fill += n;
    if (this.fill === this.capacity) this.send();
    return true;
  }
}

registerProcessor('patter-tap', PatterTap);
