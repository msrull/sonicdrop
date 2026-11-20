const MAGIC_0 = 0x53; // 'S'
const MAGIC_1 = 0x44; // 'D'

export interface PackedFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

export function packFile(name: string, mime: string, data: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const mimeBytes = enc.encode(mime || 'application/octet-stream');

  if (nameBytes.length > 255) throw new Error('Filename too long (max 255 bytes)');
  if (mimeBytes.length > 255) throw new Error('MIME type too long (max 255 bytes)');

  const totalLen = 2 + 1 + nameBytes.length + 1 + mimeBytes.length + data.length;
  const out = new Uint8Array(totalLen);

  out[0] = MAGIC_0;
  out[1] = MAGIC_1;
  out[2] = nameBytes.length;
  out.set(nameBytes, 3);

  let off = 3 + nameBytes.length;
  out[off] = mimeBytes.length;
  off++;
  out.set(mimeBytes, off);
  off += mimeBytes.length;

  out.set(data, off);
  return out;
}

export function unpackFile(payload: Uint8Array): {
  isFile: boolean;
  file?: PackedFile;
} {
  if (payload.length < 5 || payload[0] !== MAGIC_0 || payload[1] !== MAGIC_1) {
    return { isFile: false };
  }

  const nameLen = payload[2];
  if (payload.length < 3 + nameLen + 1) return { isFile: false };

  const nameBytes = payload.subarray(3, 3 + nameLen);
  let off = 3 + nameLen;

  const mimeLen = payload[off];
  off++;
  if (payload.length < off + mimeLen) return { isFile: false };

  const mimeBytes = payload.subarray(off, off + mimeLen);
  off += mimeLen;

  const dec = new TextDecoder();
  const name = dec.decode(nameBytes);
  const mime = dec.decode(mimeBytes);
  const data = payload.subarray(off);

  return {
    isFile: true,
    file: {
      name,
      mime,
      data,
    },
  };
}
