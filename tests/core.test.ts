import { crc32, crc32ToBytes, bytesToCrc32 } from '../src/core/crc32';
import { rsEncode, rsDecode } from '../src/core/reed-solomon';
import { bytesToSymbols, symbolsToBytes } from '../src/core/fsk';
import { encodePacket, decodePacket, calcEncodedByteCount } from '../src/core/framing';
import { PREAMBLE_LENGTH } from '../src/core/constants';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

{
  const data = new TextEncoder().encode('Hello, SonicDrop!');
  const c = crc32(data);
  const bytes = crc32ToBytes(c);
  const recovered = bytesToCrc32(bytes);
  assert(c === recovered, 'CRC32 roundtrip check');
}

{
  const data = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
  const nsym = 8;
  const encoded = rsEncode(data, nsym);
  assert(encoded.length === data.length + nsym, 'RS encoded length');

  const corrupted = new Uint8Array(encoded);
  corrupted[1] ^= 0x55;
  corrupted[4] ^= 0xaa;
  corrupted[7] ^= 0x12;

  const { data: recovered, corrected } = rsDecode(corrupted, nsym);
  assert(corrected === 3, 'RS corrected error count must be 3');
  for (let i = 0; i < data.length; i++) {
    assert(recovered[i] === data[i], `RS recovered byte ${i}`);
  }
}

{
  const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
  const symbols = bytesToSymbols(data);
  const recovered = symbolsToBytes(symbols, data.length);
  for (let i = 0; i < data.length; i++) {
    assert(recovered[i] === data[i], `Symbol packing byte ${i}`);
  }
}

{
  const rawText = 'sonicdrop_sample_airgap_secret_payload_9988';
  const data = new TextEncoder().encode(rawText);
  const packetSymbols = encodePacket(data, false, false, 'stealth');

  const payloadSymbols = packetSymbols.slice(PREAMBLE_LENGTH);
  const encodedByteCount = calcEncodedByteCount(data.length);
  const result = decodePacket(payloadSymbols, encodedByteCount);

  const decodedText = new TextDecoder().decode(result.data);
  assert(decodedText === rawText, 'Decoded text matches original');
  assert(result.header.mode === 'stealth', 'Header mode preserved');
}

console.log('Core test suite passed.');
