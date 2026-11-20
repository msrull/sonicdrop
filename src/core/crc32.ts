const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  }
  TABLE[i] = c;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function crc32ToBytes(crc: number): Uint8Array {
  return new Uint8Array([
    crc & 0xFF,
    (crc >>> 8) & 0xFF,
    (crc >>> 16) & 0xFF,
    (crc >>> 24) & 0xFF,
  ]);
}

export function bytesToCrc32(bytes: Uint8Array, offset = 0): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}
