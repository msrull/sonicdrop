import { getDSPConfig, SAMPLE_RATE } from '../core/constants';
import { encodePacket, encodePacketBytes } from '../core/framing';
import { generateAudioSamples } from '../core/fsk';
import { maybeCompress } from '../core/compression';
import { encrypt } from '../core/crypto';
import { generateCalibrationChirp } from '../core/calibration';
import {
  encodeTurboBytes,
  getTurboFrequencies,
  TURBO_PREAMBLE_PATTERN,
  TURBO_TOTAL_SAMPLES,
} from '../core/turbo';
import type { TransmitOptions, TransmitState } from '../types';

export class Transmitter {
  private ctx: AudioContext | null = null;
  private src: AudioBufferSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private progressTimer = 0;

  state: TransmitState = 'idle';

  onStateChange?: (s: TransmitState) => void;
  onAnalyserReady?: (a: AnalyserNode) => void;
  onProgress?: (p: number) => void;

  private setState(s: TransmitState) {
    this.state = s;
    this.onStateChange?.(s);
  }

  async synthesizePCM(text: string, opts: TransmitOptions): Promise<{ pcm: Float32Array; sampleRate: number }> {
    let data = new TextEncoder().encode(text);

    let compressed = false;
    if (opts.compress !== false) {
      const r = await maybeCompress(data);
      compressed = r.compressed;
      data = new Uint8Array(r.data);
    }

    let encrypted = false;
    if (opts.pin) {
      data = new Uint8Array(await encrypt(data, opts.pin));
      encrypted = true;
    }

    const speed = opts.speed || 'standard';

    if (speed === 'turbo') {
      const coded = encodePacketBytes(data, encrypted, compressed, opts.mode, 'turbo');
      const turboPcm = encodeTurboBytes(coded, opts.mode);

      const freqs = getTurboFrequencies(opts.mode);
      const preamblePcm = new Float32Array(TURBO_PREAMBLE_PATTERN.length * 640);
      let off = 0;
      for (const sym of TURBO_PREAMBLE_PATTERN) {
        const f = freqs[sym * 2];
        const inc = (2 * Math.PI * f) / SAMPLE_RATE;
        for (let i = 0; i < 512; i++) {
          let amp = 0.8;
          if (i < 32) amp *= 0.5 * (1 - Math.cos((Math.PI * i) / 32));
          else if (i >= 512 - 32) amp *= 0.5 * (1 - Math.cos((Math.PI * (511 - i)) / 32));
          preamblePcm[off + i] = amp * Math.sin(inc * i);
        }
        off += 640;
      }

      const pcm = new Float32Array(preamblePcm.length + turboPcm.length);
      pcm.set(preamblePcm);
      pcm.set(turboPcm, preamblePcm.length);
      return { pcm, sampleRate: SAMPLE_RATE };
    }

    const config = getDSPConfig(opts.mode);
    const symbols = encodePacket(data, encrypted, compressed, opts.mode, 'standard');
    const pcm = generateAudioSamples(symbols, config);

    return { pcm, sampleRate: SAMPLE_RATE };
  }

  async transmit(text: string, opts: TransmitOptions): Promise<void> {
    try {
      this.setState('encoding');

      const { pcm } = await this.synthesizePCM(text, opts);

      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }

      const buf = this.ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
      buf.copyToChannel(pcm as any, 0);

      this.analyserNode = this.ctx.createAnalyser();
      this.analyserNode.fftSize = 2048;
      this.analyserNode.smoothingTimeConstant = 0.3;
      this.onAnalyserReady?.(this.analyserNode);

      this.src = this.ctx.createBufferSource();
      this.src.buffer = buf;
      this.src.connect(this.analyserNode);
      this.analyserNode.connect(this.ctx.destination);

      const dur = pcm.length / SAMPLE_RATE;
      this.setState('transmitting');

      this.progressTimer = window.setInterval(() => {
        if (this.ctx && this.state === 'transmitting') {
          this.onProgress?.(Math.min(1, this.ctx.currentTime / dur));
        }
      }, 50);

      this.src.onended = () => {
        clearInterval(this.progressTimer);
        this.onProgress?.(1);
        this.setState('done');
      };

      this.src.start();
    } catch (e) {
      this.setState('error');
      throw e;
    }
  }

  async playCalibrationChirp(): Promise<void> {
    try {
      this.setState('transmitting');
      const pcm = generateCalibrationChirp(SAMPLE_RATE, 0.8);

      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }

      const buf = this.ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
      buf.copyToChannel(pcm as any, 0);

      this.analyserNode = this.ctx.createAnalyser();
      this.analyserNode.fftSize = 2048;
      this.analyserNode.smoothingTimeConstant = 0.3;
      this.onAnalyserReady?.(this.analyserNode);

      this.src = this.ctx.createBufferSource();
      this.src.buffer = buf;
      this.src.connect(this.analyserNode);
      this.analyserNode.connect(this.ctx.destination);

      const dur = pcm.length / SAMPLE_RATE;
      this.progressTimer = window.setInterval(() => {
        if (this.ctx && this.state === 'transmitting') {
          this.onProgress?.(Math.min(1, this.ctx.currentTime / dur));
        }
      }, 50);

      this.src.onended = () => {
        clearInterval(this.progressTimer);
        this.onProgress?.(1);
        this.setState('done');
      };

      this.src.start();
    } catch (e) {
      this.setState('error');
      throw e;
    }
  }

  stop(): void {
    clearInterval(this.progressTimer);
    try {
      this.src?.stop();
    } catch {}
    this.src?.disconnect();
    this.analyserNode?.disconnect();
    this.ctx?.close();
    this.src = null;
    this.analyserNode = null;
    this.ctx = null;
    this.setState('idle');
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  getDuration(text: string, opts: TransmitOptions): number {
    const len = new TextEncoder().encode(text).length;
    const headerCrcRs = 3 + 4 + 16;
    if (opts.speed === 'turbo') {
      const totalBytes = len + headerCrcRs;
      const preambleDur = (TURBO_PREAMBLE_PATTERN.length * 640) / SAMPLE_RATE;
      const payloadDur = (totalBytes * TURBO_TOTAL_SAMPLES) / SAMPLE_RATE;
      return preambleDur + payloadDur;
    }
    const c = getDSPConfig(opts.mode);
    const totalSymbols = 8 + Math.ceil(((len + headerCrcRs) * 8) / 3);
    return (totalSymbols * (c.symbolSamples + c.guardSamples)) / c.sampleRate;
  }
}
