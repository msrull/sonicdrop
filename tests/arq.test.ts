import {
  splitIntoChunks,
  buildChunkPacket,
  parseChunkPacket,
  ArqReassembler,
  generateAckNackTone,
  detectAckNack,
  ARQ_BURST_SAMPLES,
} from '../src/core/arq';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

// 1. Chunk splitting and reassembly
{
  const data = new Uint8Array(200);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 13) & 0xff;

  const chunks = splitIntoChunks(data, 48);
  assert(chunks.length === 5, `Expected 5 chunks for 200 bytes, got ${chunks.length}`);

  const reassembler = new ArqReassembler();

  // Feed in reverse order (simulate out-of-order network arrival)
  for (let i = chunks.length - 1; i >= 0; i--) {
    const packet = buildChunkPacket(chunks[i]);
    const res = reassembler.addPacket(packet);
    assert(res.success, `Chunk ${i} should be parsed successfully`);
    if (i === 0) {
      assert(res.complete, 'Reassembly should be complete after final chunk');
      assert(res.data!.length === data.length, 'Reassembled length matches');
      for (let j = 0; j < data.length; j++) {
        assert(res.data![j] === data[j], `Byte ${j} mismatch`);
      }
    } else {
      assert(!res.complete, `Should not be complete at chunk index ${i}`);
    }
  }
}

// 2. Corrupted chunk detection
{
  const chunk = { index: 0, total: 1, payload: new Uint8Array([1, 2, 3, 4, 5]) };
  const packet = buildChunkPacket(chunk);

  // Corrupt 1 byte
  packet[4] ^= 0xff;

  let failed = false;
  try {
    parseChunkPacket(packet);
  } catch {
    failed = true;
  }
  assert(failed, 'Corrupted chunk must throw CRC mismatch error');
}

// 3. ACK and NACK tone detection in Audible & Stealth
{
  for (const mode of ['audible', 'stealth'] as const) {
    const ackPcm = generateAckNackTone('ack', mode);
    assert(ackPcm.length === ARQ_BURST_SAMPLES, 'ACK tone length');
    const ackResult = detectAckNack(ackPcm, mode);
    assert(ackResult === 'ack', `ACK detection failed in ${mode} mode`);

    const nackPcm = generateAckNackTone('nack', mode);
    assert(nackPcm.length === ARQ_BURST_SAMPLES, 'NACK tone length');
    const nackResult = detectAckNack(nackPcm, mode);
    assert(nackResult === 'nack', `NACK detection failed in ${mode} mode`);

    // Silence should return null
    const silence = new Float32Array(ARQ_BURST_SAMPLES);
    const silenceResult = detectAckNack(silence, mode);
    assert(silenceResult === null, `Silence should return null in ${mode} mode`);
  }
}

console.log('ARQ test suite passed.');
