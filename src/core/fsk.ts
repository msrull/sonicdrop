import { BITS_PER_SYMBOL, FADE_SAMPLES } from './constants';
import type { DSPConfig } from '../types';

export function bytesToSymbols(data: Uint8Array): number[] {
  const totalBits = data.length * 8;
  const count = Math.ceil(totalBits / BITS_PER_SYMBOL);
  const out: number[] = [];

  let bitIdx = 0;
  for (let s = 0; s < count; s++) {
    let sym = 0;
    for (let b = 0; b < BITS_PER_SYMBOL; b++) {
      sym <<= 1;
      if (bitIdx < totalBits) {
        const bytePos = bitIdx >>> 3;
        const bitPos = 7 - (bitIdx & 7);
        sym |= (data[bytePos] >>> bitPos) & 1;
      }
      bitIdx++;
    }
    out.push(sym);
  }
  return out;
}

export function symbolsToBytes(symbols: number[], byteCount: number): Uint8Array {
  const out = new Uint8Array(byteCount);
  let bitIdx = 0;

  for (const sym of symbols) {
    for (let b = BITS_PER_SYMBOL - 1; b >= 0; b--) {
      if (bitIdx >= byteCount * 8) return out;
      const bit = (sym >>> b) & 1;
      out[bitIdx >>> 3] |= bit << (7 - (bitIdx & 7));
      bitIdx++;
    }
  }
  return out;
}

export function generateAudioSamples(
  symbols: number[],
  config: DSPConfig,
): Float32Array {
  const { symbolSamples, guardSamples, sampleRate, frequencies } = config;
  const total = symbols.length * (symbolSamples + guardSamples);
  const pcm = new Float32Array(total);

  let off = 0;
  for (const sym of symbols) {
    const freq = frequencies[sym];
    const inc = (2 * Math.PI * freq) / sampleRate;

    for (let i = 0; i < symbolSamples; i++) {
      let amp = 0.8;
      if (i < FADE_SAMPLES) {
        amp *= 0.5 * (1 - Math.cos((Math.PI * i) / FADE_SAMPLES));
      } else if (i >= symbolSamples - FADE_SAMPLES) {
        amp *= 0.5 * (1 - Math.cos((Math.PI * (symbolSamples - 1 - i)) / FADE_SAMPLES));
      }
      pcm[off + i] = amp * Math.sin(inc * i);
    }
    off += symbolSamples + guardSamples;
  }
  return pcm;
}
