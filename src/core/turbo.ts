import { SAMPLE_RATE } from './constants';
import type { TransmissionMode } from '../types';

export const TURBO_SYMBOL_SAMPLES = 256;
export const TURBO_GUARD_SAMPLES = 64;
export const TURBO_TOTAL_SAMPLES = TURBO_SYMBOL_SAMPLES + TURBO_GUARD_SAMPLES; // 320 samples @ 48kHz = 6.67ms
export const TURBO_DF = SAMPLE_RATE / TURBO_SYMBOL_SAMPLES; // 187.5 Hz orthogonal spacing

export const TURBO_FREQUENCIES_AUDIBLE = Array.from(
  { length: 16 },
  (_, i) => 2_000 + i * TURBO_DF,
);

export const TURBO_FREQUENCIES_STEALTH = Array.from(
  { length: 16 },
  (_, i) => 17_000 + i * TURBO_DF,
);

export const TURBO_PREAMBLE_PATTERN = [7, 6, 5, 4, 3, 2, 1, 0] as const;

export function getTurboFrequencies(mode: TransmissionMode): readonly number[] {
  return mode === 'stealth' ? TURBO_FREQUENCIES_STEALTH : TURBO_FREQUENCIES_AUDIBLE;
}

export function encodeTurboBytes(
  bytes: Uint8Array,
  mode: TransmissionMode,
): Float32Array {
  const freqs = getTurboFrequencies(mode);
  const total = bytes.length * TURBO_TOTAL_SAMPLES;
  const pcm = new Float32Array(total);
  const fade = 24;

  for (let s = 0; s < bytes.length; s++) {
    const byte = bytes[s];
    const t0 = byte & 3;
    const t1 = 4 + ((byte >>> 2) & 3);
    const t2 = 8 + ((byte >>> 4) & 3);
    const t3 = 12 + ((byte >>> 6) & 3);

    const activeTones = [freqs[t0], freqs[t1], freqs[t2], freqs[t3]];
    const off = s * TURBO_TOTAL_SAMPLES;

    for (let i = 0; i < TURBO_SYMBOL_SAMPLES; i++) {
      let amp = 0.2;
      if (i < fade) {
        amp *= 0.5 * (1 - Math.cos((Math.PI * i) / fade));
      } else if (i >= TURBO_SYMBOL_SAMPLES - fade) {
        amp *= 0.5 * (1 - Math.cos((Math.PI * (TURBO_SYMBOL_SAMPLES - 1 - i)) / fade));
      }

      let val = 0;
      for (let k = 0; k < 4; k++) {
        val += amp * Math.sin((2 * Math.PI * activeTones[k] * i) / SAMPLE_RATE);
      }
      pcm[off + i] = val;
    }
  }

  return pcm;
}

export function getTurboCoeffs(mode: TransmissionMode): Float32Array {
  const freqs = getTurboFrequencies(mode);
  const coeffs = new Float32Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    coeffs[i] = 2 * Math.cos((2 * Math.PI * freqs[i]) / SAMPLE_RATE);
  }
  return coeffs;
}

export function demodulateTurboSymbol(
  samples: Float32Array,
  coeffs: Float32Array,
): number {
  const bs = TURBO_SYMBOL_SAMPLES;
  const mags = new Float32Array(16);

  for (let f = 0; f < 16; f++) {
    const c = coeffs[f];
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < bs; i++) {
      const s0 = samples[i] + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    mags[f] = (s1 * s1 + s2 * s2 - c * s1 * s2) / (bs * bs);
  }

  let best0 = 0, max0 = 0;
  for (let i = 0; i < 4; i++) {
    if (mags[i] > max0) {
      max0 = mags[i];
      best0 = i;
    }
  }

  let best1 = 0, max1 = 0;
  for (let i = 4; i < 8; i++) {
    if (mags[i] > max1) {
      max1 = mags[i];
      best1 = i - 4;
    }
  }

  let best2 = 0, max2 = 0;
  for (let i = 8; i < 12; i++) {
    if (mags[i] > max2) {
      max2 = mags[i];
      best2 = i - 8;
    }
  }

  let best3 = 0, max3 = 0;
  for (let i = 12; i < 16; i++) {
    if (mags[i] > max3) {
      max3 = mags[i];
      best3 = i - 12;
    }
  }

  return best0 | (best1 << 2) | (best2 << 4) | (best3 << 6);
}
