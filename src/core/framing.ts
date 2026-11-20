import { crc32, crc32ToBytes, bytesToCrc32 } from './crc32';
import { rsEncode, rsDecode } from './reed-solomon';
import { bytesToSymbols, symbolsToBytes } from './fsk';
import {
  HEADER_BYTES,
  CRC_BYTES,
  RS_PARITY_BYTES,
  PREAMBLE_PATTERN,
  BITS_PER_SYMBOL,
} from './constants';
import type { TransmissionMode, PacketHeader } from '../types';

function buildHeader(
  len: number,
  encrypted: boolean,
  compressed: boolean,
  mode: TransmissionMode,
): Uint8Array {
  const h = new Uint8Array(HEADER_BYTES);
  h[0] = len & 0xFF;
  h[1] = (len >>> 8) & 0xFF;
  h[2] = (encrypted ? 1 : 0) | (compressed ? 2 : 0) | (mode === 'audible' ? 4 : 0);
  return h;
}

function parseHeader(h: Uint8Array): PacketHeader {
  return {
    payloadLength: h[0] | (h[1] << 8),
    encrypted: Boolean(h[2] & 1),
    compressed: Boolean(h[2] & 2),
    mode: (h[2] & 4) ? 'audible' : 'stealth',
    version: (h[2] >>> 4) & 0xF,
  };
}

export function encodePacket(
  data: Uint8Array,
  encrypted: boolean,
  compressed: boolean,
  mode: TransmissionMode,
): number[] {
  const header = buildHeader(data.length, encrypted, compressed, mode);
  const inner = new Uint8Array(HEADER_BYTES + data.length);
  inner.set(header);
  inner.set(data, HEADER_BYTES);

  const crcBytes = crc32ToBytes(crc32(inner));
  const payload = new Uint8Array(inner.length + CRC_BYTES);
  payload.set(inner);
  payload.set(crcBytes, inner.length);

  const coded = rsEncode(payload, RS_PARITY_BYTES);
  return [...PREAMBLE_PATTERN, ...bytesToSymbols(coded)];
}

export interface DecodeResult {
  header: PacketHeader;
  data: Uint8Array;
  errorsFixed: number;
}

export function decodePacket(symbols: number[], encodedByteCount: number): DecodeResult {
  const raw = symbolsToBytes(symbols, encodedByteCount);
  const { data: corrected, corrected: errorsFixed } = rsDecode(raw, RS_PARITY_BYTES);

  if (corrected.length < HEADER_BYTES + CRC_BYTES) {
    throw new Error('Decoded packet too short');
  }

  const inner = corrected.slice(0, corrected.length - CRC_BYTES);
  const storedCrc = bytesToCrc32(corrected, corrected.length - CRC_BYTES);
  const calcCrc = crc32(inner);

  if (calcCrc !== storedCrc) {
    throw new Error(
      `CRC mismatch (0x${calcCrc.toString(16)} vs 0x${storedCrc.toString(16)}) — data corrupted beyond repair`,
    );
  }

  const header = parseHeader(inner);
  const data = inner.slice(HEADER_BYTES, HEADER_BYTES + header.payloadLength);

  return { header, data, errorsFixed };
}

export function calcSymbolCount(dataLength: number): number {
  return Math.ceil((calcEncodedByteCount(dataLength) * 8) / BITS_PER_SYMBOL);
}

export function calcEncodedByteCount(dataLength: number): number {
  return HEADER_BYTES + dataLength + CRC_BYTES + RS_PARITY_BYTES;
}
