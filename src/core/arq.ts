import { crc32, crc32ToBytes, bytesToCrc32 } from './crc32';
import { SAMPLE_RATE } from './constants';
import type { TransmissionMode } from '../types';

export const ARQ_CHUNK_PAYLOAD_SIZE = 48; // bytes per chunk
export const ARQ_HEADER_SIZE = 3;
export const ARQ_CRC_SIZE = 4;
export const ARQ_BURST_SAMPLES = 2304; // 48ms @ 48kHz

export const ARQ_FREQS = {
  audible: { ack: 4_800, nack: 2_400 },
  stealth: { ack: 19_500, nack: 18_000 },
} as const;

export interface ArqChunk {
  index: number;
  total: number;
  payload: Uint8Array;
}

export function buildChunkPacket(chunk: ArqChunk): Uint8Array {
  const inner = new Uint8Array(ARQ_HEADER_SIZE + chunk.payload.length);
  inner[0] = chunk.index;
  inner[1] = chunk.total;
  inner[2] = chunk.payload.length;
  inner.set(chunk.payload, ARQ_HEADER_SIZE);

  const crc = crc32ToBytes(crc32(inner));
  const packet = new Uint8Array(inner.length + ARQ_CRC_SIZE);
  packet.set(inner);
  packet.set(crc, inner.length);
  return packet;
}

export function parseChunkPacket(packet: Uint8Array): ArqChunk {
  if (packet.length < ARQ_HEADER_SIZE + ARQ_CRC_SIZE) {
    throw new Error('Chunk packet too short');
  }

  const inner = packet.slice(0, packet.length - ARQ_CRC_SIZE);
  const storedCrc = bytesToCrc32(packet, packet.length - ARQ_CRC_SIZE);
  const calcCrc = crc32(inner);

  if (storedCrc !== calcCrc) {
    throw new Error('Chunk CRC mismatch');
  }

  const index = inner[0];
  const total = inner[1];
  const len = inner[2];
  const payload = inner.slice(ARQ_HEADER_SIZE, ARQ_HEADER_SIZE + len);

  return { index, total, payload };
}

export function splitIntoChunks(
  data: Uint8Array,
  chunkSize = ARQ_CHUNK_PAYLOAD_SIZE,
): ArqChunk[] {
  if (data.length === 0) {
    return [{ index: 0, total: 1, payload: new Uint8Array(0) }];
  }

  const total = Math.ceil(data.length / chunkSize);
  const chunks: ArqChunk[] = [];

  for (let i = 0; i < total; i++) {
    const start = i * chunkSize;
    const end = Math.min(data.length, start + chunkSize);
    chunks.push({
      index: i,
      total,
      payload: data.slice(start, end),
    });
  }

  return chunks;
}

export class ArqReassembler {
  private chunks = new Map<number, Uint8Array>();
  private totalExpected = 0;

  addPacket(packet: Uint8Array): {
    success: boolean;
    chunk?: ArqChunk;
    complete: boolean;
    data?: Uint8Array;
  } {
    try {
      const chunk = parseChunkPacket(packet);
      this.totalExpected = chunk.total;
      this.chunks.set(chunk.index, chunk.payload);

      if (this.chunks.size >= this.totalExpected) {
        const complete = this.reassemble();
        return { success: true, chunk, complete: true, data: complete };
      }

      return { success: true, chunk, complete: false };
    } catch {
      return { success: false, complete: false };
    }
  }

  private reassemble(): Uint8Array {
    let totalLen = 0;
    for (let i = 0; i < this.totalExpected; i++) {
      const part = this.chunks.get(i);
      if (!part) throw new Error(`Missing chunk ${i}`);
      totalLen += part.length;
    }

    const out = new Uint8Array(totalLen);
    let off = 0;
    for (let i = 0; i < this.totalExpected; i++) {
      const part = this.chunks.get(i)!;
      out.set(part, off);
      off += part.length;
    }
    return out;
  }

  getMissingIndices(): number[] {
    const missing: number[] = [];
    for (let i = 0; i < this.totalExpected; i++) {
      if (!this.chunks.has(i)) missing.push(i);
    }
    return missing;
  }

  getProgress(): { received: number; total: number } {
    return { received: this.chunks.size, total: this.totalExpected || 1 };
  }

  reset(): void {
    this.chunks.clear();
    this.totalExpected = 0;
  }
}

export function generateAckNackTone(
  type: 'ack' | 'nack',
  mode: TransmissionMode,
): Float32Array {
  const freq = ARQ_FREQS[mode][type];
  const pcm = new Float32Array(ARQ_BURST_SAMPLES);
  const fade = 96;

  for (let i = 0; i < ARQ_BURST_SAMPLES; i++) {
    let amp = 0.8;
    if (i < fade) {
      amp *= 0.5 * (1 - Math.cos((Math.PI * i) / fade));
    } else if (i >= ARQ_BURST_SAMPLES - fade) {
      amp *= 0.5 * (1 - Math.cos((Math.PI * (ARQ_BURST_SAMPLES - 1 - i)) / fade));
    }
    pcm[i] = amp * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  }

  return pcm;
}

export function detectAckNack(
  samples: Float32Array,
  mode: TransmissionMode,
  threshold = 0.0001,
): 'ack' | 'nack' | null {
  const { ack: ackF, nack: nackF } = ARQ_FREQS[mode];
  const N = samples.length;

  const calc = (f: number): number => {
    const c = 2 * Math.cos((2 * Math.PI * f) / SAMPLE_RATE);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < N; i++) {
      const s0 = samples[i] + c * s1 - s2;
      s2 = s1; s1 = s0;
    }
    return (s1 * s1 + s2 * s2 - c * s1 * s2) / (N * N);
  };

  const ackE = calc(ackF);
  const nackE = calc(nackF);

  if (ackE > threshold && ackE > nackE * 3.0) return 'ack';
  if (nackE > threshold && nackE > ackE * 3.0) return 'nack';
  return null;
}
