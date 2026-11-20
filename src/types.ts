export type TransmissionMode = 'stealth' | 'audible';
export type SpeedProfile = 'standard' | 'turbo';

export interface DSPConfig {
  mode: TransmissionMode;
  sampleRate: number;
  symbolSamples: number;
  guardSamples: number;
  frequencies: readonly number[];
  bitsPerSymbol: number;
}

export interface PacketHeader {
  payloadLength: number;
  encrypted: boolean;
  compressed: boolean;
  mode: TransmissionMode;
  speed: SpeedProfile;
  version: number;
}

export interface TransmitOptions {
  mode: TransmissionMode;
  speed?: SpeedProfile;
  pin?: string;
  compress?: boolean;
}

export interface ReceiveResult {
  text: string;
  encrypted: boolean;
  compressed: boolean;
  mode: TransmissionMode;
  speed: SpeedProfile;
  byteLength: number;
  durationMs: number;
  errorsFixed: number;
}

export type AppPanel = 'send' | 'receive';

export type TransmitState =
  | 'idle'
  | 'encoding'
  | 'transmitting'
  | 'done'
  | 'error';

export type ReceiveState =
  | 'idle'
  | 'listening'
  | 'syncing'
  | 'receiving'
  | 'decoding'
  | 'done'
  | 'error';

export interface SpectrogramData {
  magnitudes: Float32Array;
  sampleRate: number;
  fftSize: number;
}

export interface DetectedSymbol {
  index: number;
  magnitude: number;
  timestamp: number;
}

export interface ChannelHealth {
  audibleScore: number;
  stealthScore: number;
  stealthSupported: boolean;
  recommendedMode: TransmissionMode;
  noiseFloorDb: number;
  snrDb: number;
  cutoffFreq: number;
  reason: string;
}
