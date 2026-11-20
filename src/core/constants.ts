import type { DSPConfig, TransmissionMode } from '../types';

export const SAMPLE_RATE = 48_000;
export const SYMBOL_SAMPLES = 512;
export const GUARD_SAMPLES = 128;
export const TOTAL_SYMBOL_SAMPLES = SYMBOL_SAMPLES + GUARD_SAMPLES;

export const BITS_PER_SYMBOL = 3;
export const NUM_TONES = 1 << BITS_PER_SYMBOL;

export const STEALTH_FREQUENCIES = [
  18_000, 18_250, 18_500, 18_750,
  19_000, 19_250, 19_500, 19_750,
] as const;

export const AUDIBLE_FREQUENCIES = [
  2_000, 2_500, 3_000, 3_500,
  4_000, 4_500, 5_000, 5_500,
] as const;

export const PREAMBLE_PATTERN = [0, 1, 2, 3, 4, 5, 6, 7] as const;
export const PREAMBLE_LENGTH = PREAMBLE_PATTERN.length;

export const HEADER_BYTES = 3;
export const CRC_BYTES = 4;
export const RS_PARITY_BYTES = 16;
export const MAX_INPUT_BYTES = 512;
export const GOERTZEL_THRESHOLD = 0.00001;
export const GOERTZEL_SNR_RATIO = 1.35;
export const FADE_SAMPLES = 32;

export const SYMBOL_RATE = SAMPLE_RATE / TOTAL_SYMBOL_SAMPLES;
export const BIT_RATE = SYMBOL_RATE * BITS_PER_SYMBOL;
export const BYTE_RATE = BIT_RATE / 8;

export function getDSPConfig(mode: TransmissionMode): DSPConfig {
  return {
    mode,
    sampleRate: SAMPLE_RATE,
    symbolSamples: SYMBOL_SAMPLES,
    guardSamples: GUARD_SAMPLES,
    frequencies: mode === 'stealth' ? STEALTH_FREQUENCIES : AUDIBLE_FREQUENCIES,
    bitsPerSymbol: BITS_PER_SYMBOL,
  };
}
