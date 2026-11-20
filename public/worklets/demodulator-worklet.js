class DemodulatorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this._active = false;
    this._blockSize = 512;
    this._hopSize = 128;
    this._ring = new Float32Array(512);
    this._wPos = 0;
    this._filled = 0;
    this._hop = 0;
    this._coeffs = [];

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'configure') {
        this._blockSize = d.blockSize || 512;
        this._hopSize = d.hopSize || 128;
        this._ring = new Float32Array(this._blockSize);
        this._wPos = 0;
        this._filled = 0;
        this._hop = 0;

        this._coeffs = d.frequencies.map((f) => {
          const k = Math.round((f * this._blockSize) / sampleRate);
          return 2 * Math.cos((2 * Math.PI * k) / this._blockSize);
        });
        this._active = true;
      } else if (d.type === 'stop') {
        this._active = false;
      }
    };
  }

  process(inputs) {
    if (!this._active) return true;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    const bs = this._blockSize;

    for (let i = 0; i < ch.length; i++) {
      this._ring[this._wPos] = ch[i];
      this._wPos = (this._wPos + 1) % bs;
      if (this._filled < bs) this._filled++;
      this._hop++;

      if (this._hop >= this._hopSize && this._filled >= bs) {
        this._hop = 0;

        const buf = new Float32Array(bs);
        for (let j = 0; j < bs; j++) {
          buf[j] = this._ring[(this._wPos + j) % bs];
        }

        const mags = new Float32Array(this._coeffs.length);
        for (let f = 0; f < this._coeffs.length; f++) {
          const c = this._coeffs[f];
          let s1 = 0;
          let s2 = 0;
          for (let j = 0; j < bs; j++) {
            const s0 = buf[j] + c * s1 - s2;
            s2 = s1;
            s1 = s0;
          }
          mags[f] = (s1 * s1 + s2 * s2 - c * s1 * s2) / (bs * bs);
        }

        this.port.postMessage({ type: 'magnitudes', mags }, [mags.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('demodulator-processor', DemodulatorProcessor);
