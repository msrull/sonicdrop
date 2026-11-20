import { GOERTZEL_THRESHOLD } from './constants';

export function goertzel(
  samples: Float32Array,
  freq: number,
  sampleRate: number,
): number {
  const N = samples.length;
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);

  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < N; i++) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (N * N);
}

export function detectSymbol(
  samples: Float32Array,
  frequencies: readonly number[],
  sampleRate: number,
  threshold = GOERTZEL_THRESHOLD,
): { symbol: number; magnitude: number } {
  let bestIdx = -1;
  let bestMag = 0;

  for (let i = 0; i < frequencies.length; i++) {
    const m = goertzel(samples, frequencies[i], sampleRate);
    if (m > bestMag) {
      bestMag = m;
      bestIdx = i;
    }
  }
  return bestMag >= threshold
    ? { symbol: bestIdx, magnitude: bestMag }
    : { symbol: -1, magnitude: bestMag };
}

export function allMagnitudes(
  samples: Float32Array,
  frequencies: readonly number[],
  sampleRate: number,
): Float32Array {
  const out = new Float32Array(frequencies.length);
  for (let i = 0; i < frequencies.length; i++) {
    out[i] = goertzel(samples, frequencies[i], sampleRate);
  }
  return out;
}
