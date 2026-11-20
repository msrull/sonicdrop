import { getDSPConfig, SAMPLE_RATE } from '../core/constants';
import { encodePacket } from '../core/framing';
import { generateAudioSamples } from '../core/fsk';
import { maybeCompress } from '../core/compression';
import { encrypt } from '../core/crypto';
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

    const config = getDSPConfig(opts.mode);
    const symbols = encodePacket(data, encrypted, compressed, opts.mode);
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
    const c = getDSPConfig(opts.mode);
    const headerCrcRs = 3 + 4 + 16;
    const totalSymbols = 8 + Math.ceil(((len + headerCrcRs) * 8) / 3);
    return (totalSymbols * (c.symbolSamples + c.guardSamples)) / c.sampleRate;
  }
}
