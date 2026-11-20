import {
  generateAckNackTone,
  detectAckNack,
  ARQ_BURST_SAMPLES,
} from '../core/arq';
import { SAMPLE_RATE } from '../core/constants';
import type { TransmissionMode } from '../types';

export class ArqSession {
  private ctx: AudioContext | null = null;

  async playAck(mode: TransmissionMode): Promise<void> {
    await this.playTone(generateAckNackTone('ack', mode));
  }

  async playNack(mode: TransmissionMode): Promise<void> {
    await this.playTone(generateAckNackTone('nack', mode));
  }

  private async playTone(pcm: Float32Array): Promise<void> {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (ctx.state === 'suspended') await ctx.resume();

    const buf = ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
    buf.copyToChannel(pcm as any, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    return new Promise((resolve) => {
      src.onended = () => {
        try {
          ctx.close();
        } catch {}
        resolve();
      };
      src.start();
    });
  }

  async waitForHandshake(
    analyser: AnalyserNode,
    mode: TransmissionMode,
    timeoutMs = 1500,
  ): Promise<'ack' | 'nack' | 'timeout'> {
    const startTime = performance.now();
    const timeBuffer = new Float32Array(ARQ_BURST_SAMPLES);

    return new Promise((resolve) => {
      const checkInterval = window.setInterval(() => {
        if (performance.now() - startTime >= timeoutMs) {
          clearInterval(checkInterval);
          resolve('timeout');
          return;
        }

        analyser.getFloatTimeDomainData(timeBuffer);
        const result = detectAckNack(timeBuffer, mode, 0.0001);
        if (result === 'ack' || result === 'nack') {
          clearInterval(checkInterval);
          resolve(result);
        }
      }, 20);
    });
  }
}
