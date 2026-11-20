async function pipe(
  data: Uint8Array,
  stream: GenericTransformStream,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  writer.write(data as any);
  writer.close();

  const chunks: Uint8Array[] = [];
  let len = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = new Uint8Array(value);
    chunks.push(chunk);
    len += chunk.length;
  }

  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function compress(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream('deflate-raw'));
}

export async function decompress(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new DecompressionStream('deflate-raw'));
}

export async function maybeCompress(
  data: Uint8Array,
): Promise<{ compressed: boolean; data: Uint8Array }> {
  const deflated = await compress(data);
  return deflated.length < data.length
    ? { compressed: true, data: deflated }
    : { compressed: false, data };
}
