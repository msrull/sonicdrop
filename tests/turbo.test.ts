import { encodePacketBytes, decodePacketBytes, calcEncodedByteCount } from '../src/core/framing';
import {
  encodeTurboBytes,
  demodulateTurboSymbol,
  getTurboCoeffs,
  TURBO_TOTAL_SAMPLES,
  TURBO_SYMBOL_SAMPLES,
} from '../src/core/turbo';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

// 1. Test Turbo packet encoding and decoding in Audible mode
{
  const rawText = 'Turbo multi-carrier acoustic air-gap secret payload 1200bps!';
  const data = new TextEncoder().encode(rawText);
  const coded = encodePacketBytes(data, false, false, 'audible', 'turbo');

  const pcm = encodeTurboBytes(coded, 'audible');
  const coeffs = getTurboCoeffs('audible');

  // Add realistic channel noise and attenuation (Amp = 0.04, noise = 0.005)
  const noisy = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    noisy[i] = 0.04 * pcm[i] + 0.005 * (Math.random() * 2 - 1);
  }

  // Demodulate symbols
  const recoveredBytes = new Uint8Array(coded.length);
  for (let s = 0; s < coded.length; s++) {
    const off = s * TURBO_TOTAL_SAMPLES;
    const window = noisy.subarray(off, off + TURBO_SYMBOL_SAMPLES);
    recoveredBytes[s] = demodulateTurboSymbol(window, coeffs);
  }

  const result = decodePacketBytes(recoveredBytes);
  const decodedText = new TextDecoder().decode(result.data);

  assert(decodedText === rawText, 'Decoded text matches original');
  assert(result.header.speed === 'turbo', 'Header speed profile preserved as turbo');
  assert(result.header.mode === 'audible', 'Header mode preserved as audible');
}

// 2. Test Turbo packet in Stealth mode
{
  const rawText = 'Ultrasonic 18kHz stealth turbo burst 1200bps!';
  const data = new TextEncoder().encode(rawText);
  const coded = encodePacketBytes(data, false, false, 'stealth', 'turbo');

  const pcm = encodeTurboBytes(coded, 'stealth');
  const coeffs = getTurboCoeffs('stealth');

  // Add noise
  const noisy = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    noisy[i] = 0.04 * pcm[i] + 0.005 * (Math.random() * 2 - 1);
  }

  const recoveredBytes = new Uint8Array(coded.length);
  for (let s = 0; s < coded.length; s++) {
    const off = s * TURBO_TOTAL_SAMPLES;
    const window = noisy.subarray(off, off + TURBO_SYMBOL_SAMPLES);
    recoveredBytes[s] = demodulateTurboSymbol(window, coeffs);
  }

  const result = decodePacketBytes(recoveredBytes);
  const decodedText = new TextDecoder().decode(result.data);

  assert(decodedText === rawText, 'Decoded text matches original');
  assert(result.header.speed === 'turbo', 'Header speed preserved as turbo');
  assert(result.header.mode === 'stealth', 'Header mode preserved as stealth');
}

console.log('Turbo multi-carrier test suite passed.');
