import type { TransmissionMode, ChannelHealth } from '../types';

export type { ChannelHealth };

export function generateCalibrationChirp(
  sampleRate = 48_000,
  durationSec = 0.8,
  f0 = 1_000,
  f1 = 20_500,
): Float32Array {
  const totalSamples = Math.round(durationSec * sampleRate);
  const pcm = new Float32Array(totalSamples);
  const fadeSamples = Math.min(Math.round(sampleRate * 0.01), 480);

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) / (2 * durationSec)) * t * t);
    let amp = 0.75;
    if (i < fadeSamples) {
      amp *= 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
    } else if (i >= totalSamples - fadeSamples) {
      amp *= 0.5 * (1 - Math.cos((Math.PI * (totalSamples - 1 - i)) / fadeSamples));
    }
    pcm[i] = amp * Math.sin(phase);
  }

  return pcm;
}

export function evaluateSpectrumHealth(
  freqData: Float32Array | Uint8Array,
  sampleRate: number,
): ChannelHealth {
  const binCount = freqData.length;
  const binWidth = (sampleRate / 2) / binCount;

  const toDb = (val: number): number => {
    if (freqData instanceof Float32Array) return val;
    return (val / 255) * 100 - 100;
  };

  const getBandAverageDb = (minHz: number, maxHz: number): number => {
    const startBin = Math.max(0, Math.floor(minHz / binWidth));
    const endBin = Math.min(binCount - 1, Math.ceil(maxHz / binWidth));
    if (startBin >= endBin) return -100;

    let sum = 0;
    for (let i = startBin; i <= endBin; i++) {
      sum += toDb(freqData[i]);
    }
    return sum / (endBin - startBin + 1);
  };

  const noiseFloorDb = Math.round(getBandAverageDb(500, 1500));
  const audibleDb = Math.round(getBandAverageDb(2000, 5500));
  const stealthDb = Math.round(getBandAverageDb(18000, 20000));

  let cutoffFreq = Math.round(sampleRate / 2);
  for (let i = binCount - 1; i >= 0; i--) {
    const db = toDb(freqData[i]);
    if (db > noiseFloorDb + 4) {
      cutoffFreq = Math.round(i * binWidth);
      break;
    }
  }

  const audibleSnr = Math.max(0, audibleDb - noiseFloorDb);
  const stealthSnr = Math.max(0, stealthDb - noiseFloorDb);

  const audibleScore = Math.min(100, Math.max(10, Math.round(audibleSnr * 3.5 + 40)));
  const stealthScore = cutoffFreq < 17000
    ? Math.min(35, Math.round((cutoffFreq / 17000) * 35))
    : Math.min(100, Math.max(10, Math.round(stealthSnr * 3.5 + 30)));

  const stealthSupported = stealthScore >= 50 && cutoffFreq >= 18000;
  const recommendedMode: TransmissionMode = stealthSupported ? 'stealth' : 'audible';

  let reason = '';
  if (!stealthSupported) {
    if (cutoffFreq < 17000) {
      reason = `Hardware microphone roll-off detected above ${(cutoffFreq / 1000).toFixed(1)} kHz. Audible mode recommended.`;
    } else {
      reason = 'High acoustic attenuation in ultrasonic band. Audible mode provides higher SNR.';
    }
  } else {
    reason = 'Ultrasonic channel clean and supported. Inaudible stealth transmission ready.';
  }

  return {
    audibleScore,
    stealthScore,
    stealthSupported,
    recommendedMode,
    noiseFloorDb,
    snrDb: Math.round(Math.max(audibleSnr, stealthSnr)),
    cutoffFreq,
    reason,
  };
}
