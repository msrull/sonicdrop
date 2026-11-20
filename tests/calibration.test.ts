import { generateCalibrationChirp, evaluateSpectrumHealth } from '../src/core/calibration';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

{
  const pcm = generateCalibrationChirp(48000, 0.8, 1000, 20500);
  assert(pcm.length === 38400, 'Chirp sample length must be 38400');
  assert(pcm[0] === 0, 'Chirp should start with zero amplitude fade');
  let maxAmp = 0;
  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i]) > maxAmp) maxAmp = Math.abs(pcm[i]);
  }
  assert(maxAmp > 0.65 && maxAmp <= 0.8, `Max amplitude should be ~0.75, got ${maxAmp}`);
}

{
  // Simulate wideband flat response (full bandwidth up to 20 kHz)
  const fullSpectrum = new Uint8Array(1024);
  fullSpectrum.fill(40); // noise floor
  for (let i = 85; i <= 235; i++) fullSpectrum[i] = 160; // audible band strong
  for (let i = 768; i <= 853; i++) fullSpectrum[i] = 150; // stealth band strong

  const health = evaluateSpectrumHealth(fullSpectrum, 48000);
  assert(health.stealthSupported === true, 'Stealth should be supported on wideband mic');
  assert(health.recommendedMode === 'stealth', 'Recommended mode should be stealth');
  assert(health.cutoffFreq >= 18000, 'Cutoff frequency should reach >= 18 kHz');
}

{
  // Simulate smartphone mic with steep speech roll-off at 15 kHz
  const rolledOffSpectrum = new Uint8Array(1024);
  rolledOffSpectrum.fill(40); // noise floor
  for (let i = 85; i <= 235; i++) rolledOffSpectrum[i] = 160; // audible band strong
  // Stealth band is dead (equal to noise floor)
  for (let i = 768; i <= 853; i++) rolledOffSpectrum[i] = 40;

  const health = evaluateSpectrumHealth(rolledOffSpectrum, 48000);
  assert(health.stealthSupported === false, 'Stealth should NOT be supported on rolled-off mic');
  assert(health.recommendedMode === 'audible', 'Audible should be recommended');
}

console.log('Calibration test suite passed.');
