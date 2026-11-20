import {
  getDSPConfig,
  SAMPLE_RATE,
  SYMBOL_SAMPLES,
  GUARD_SAMPLES,
  TOTAL_SYMBOL_SAMPLES,
  PREAMBLE_PATTERN,
  PREAMBLE_LENGTH,
  GOERTZEL_THRESHOLD,
  HEADER_BYTES,
  CRC_BYTES,
  RS_PARITY_BYTES,
} from '../core/constants';
import { decodePacket, calcEncodedByteCount } from '../core/framing';
import { decompress } from '../core/compression';
import { decrypt } from '../core/crypto';
import type {
  ReceiveResult,
  ReceiveState,
  TransmissionMode,
} from '../types';

export class Receiver {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private bandpassFilter: BiquadFilterNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private analyserNode: AnalyserNode | null = null;

  state: ReceiveState = 'idle';
  private mode: TransmissionMode = 'stealth';
  private pin: string | null = null;

  private preambleBuffer: number[] = [];
  private capturedSymbols: number[] = [];
  private expectedSymbolsTotal = 0;
  private currentSymbolHoldCount = 0;
  private lastDetectedSymbol = -1;
  private isSynchronized = false;
  private startTime = 0;
  private meterTimer: number = 0;

  onStateChange?: (state: ReceiveState) => void;
  onSymbolDetected?: (symbol: number, mag: number) => void;
  onProgress?: (receivedSymbols: number, totalSymbols: number) => void;
  onResult?: (result: ReceiveResult) => void;
  onError?: (err: Error) => void;
  onAnalyserReady?: (analyser: AnalyserNode) => void;
  onMicLevel?: (normalized: number, db: number) => void;

  private setState(newState: ReceiveState) {
    this.state = newState;
    this.onStateChange?.(newState);
  }

  async start(mode: TransmissionMode = 'stealth', pin?: string): Promise<void> {
    this.mode = mode;
    this.pin = pin || null;
    this.resetDetectionState();

    try {
      this.setState('listening');

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: SAMPLE_RATE,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });

      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }

      this.sourceNode = this.ctx.createMediaStreamSource(this.stream);

      this.bandpassFilter = this.ctx.createBiquadFilter();
      if (mode === 'stealth') {
        this.bandpassFilter.type = 'bandpass';
        this.bandpassFilter.frequency.value = 18875;
        this.bandpassFilter.Q.value = 8.0;
      } else {
        this.bandpassFilter.type = 'bandpass';
        this.bandpassFilter.frequency.value = 3750;
        this.bandpassFilter.Q.value = 1.5;
      }

      this.analyserNode = this.ctx.createAnalyser();
      this.analyserNode.fftSize = 2048;
      this.analyserNode.smoothingTimeConstant = 0.2;
      this.onAnalyserReady?.(this.analyserNode);

      await this.ctx.audioWorklet.addModule('./worklets/demodulator-worklet.js');
      this.workletNode = new AudioWorkletNode(this.ctx, 'demodulator-processor');

      const config = getDSPConfig(mode);
      const hopSize = Math.floor(GUARD_SAMPLES / 2);
      this.workletNode.port.postMessage({
        type: 'configure',
        frequencies: config.frequencies,
        blockSize: SYMBOL_SAMPLES,
        hopSize: hopSize,
      });

      this.workletNode.port.onmessage = (event) => {
        if (event.data.type === 'magnitudes') {
          this.processMagnitudes(new Float32Array(event.data.mags));
        }
      };

      this.sourceNode.connect(this.bandpassFilter);
      this.bandpassFilter.connect(this.analyserNode);
      this.analyserNode.connect(this.workletNode);

      this.meterTimer = window.setInterval(() => {
        if (!this.analyserNode) return;
        const timeData = new Uint8Array(this.analyserNode.fftSize);
        this.analyserNode.getByteTimeDomainData(timeData as any);
        let sum = 0;
        for (let i = 0; i < timeData.length; i++) {
          const val = (timeData[i] - 128) / 128;
          sum += val * val;
        }
        const rms = Math.sqrt(sum / timeData.length);
        const db = 20 * Math.log10(Math.max(rms, 1e-4));
        const normalized = Math.max(0, Math.min(1, (db + 60) / 60));
        this.onMicLevel?.(normalized, Math.round(db));
      }, 50);
    } catch (err: any) {
      this.setState('error');
      this.onError?.(err);
      this.stop();
      throw err;
    }
  }

  private resetDetectionState() {
    this.preambleBuffer = [];
    this.capturedSymbols = [];
    this.expectedSymbolsTotal = 0;
    this.currentSymbolHoldCount = 0;
    this.lastDetectedSymbol = -1;
    this.isSynchronized = false;
  }

  private processMagnitudes(mags: Float32Array) {
    let maxVal = 0;
    let maxIdx = -1;
    for (let i = 0; i < mags.length; i++) {
      if (mags[i] > maxVal) {
        maxVal = mags[i];
        maxIdx = i;
      }
    }

    const detected = maxVal >= GOERTZEL_THRESHOLD ? maxIdx : -1;
    this.onSymbolDetected?.(detected, maxVal);

    if (!this.isSynchronized) {
      this.handlePreambleSearch(detected);
    } else {
      this.handleSymbolCollection(detected);
    }
  }

  private handlePreambleSearch(symbol: number) {
    if (symbol === -1) {
      this.currentSymbolHoldCount = 0;
      return;
    }

    if (symbol === this.lastDetectedSymbol) {
      this.currentSymbolHoldCount++;
    } else {
      this.lastDetectedSymbol = symbol;
      this.currentSymbolHoldCount = 1;

      const expectedNext = this.preambleBuffer.length;
      if (symbol === PREAMBLE_PATTERN[expectedNext]) {
        this.preambleBuffer.push(symbol);
        this.setState('syncing');

        if (this.preambleBuffer.length === PREAMBLE_LENGTH) {
          this.isSynchronized = true;
          this.startTime = performance.now();
          this.capturedSymbols = [];
          this.setState('receiving');
        }
      } else if (symbol === PREAMBLE_PATTERN[0]) {
        this.preambleBuffer = [symbol];
        this.setState('syncing');
      } else {
        this.preambleBuffer = [];
        this.setState('listening');
      }
    }
  }

  private handleSymbolCollection(symbol: number) {
    if (symbol !== -1) {
      if (symbol !== this.lastDetectedSymbol) {
        this.lastDetectedSymbol = symbol;
        this.currentSymbolHoldCount = 1;
        this.capturedSymbols.push(symbol);

        this.checkDynamicPacketLength();
        this.onProgress?.(this.capturedSymbols.length, this.expectedSymbolsTotal);

        if (this.expectedSymbolsTotal > 0 && this.capturedSymbols.length >= this.expectedSymbolsTotal) {
          this.finishCaptureAndDecode();
        }
      } else {
        this.currentSymbolHoldCount++;
        const expectedTicksPerSymbol = Math.round(TOTAL_SYMBOL_SAMPLES / (GUARD_SAMPLES / 2));
        if (this.currentSymbolHoldCount >= expectedTicksPerSymbol * 1.6) {
          this.capturedSymbols.push(symbol);
          this.currentSymbolHoldCount = 1;
          this.checkDynamicPacketLength();
          this.onProgress?.(this.capturedSymbols.length, this.expectedSymbolsTotal);

          if (this.expectedSymbolsTotal > 0 && this.capturedSymbols.length >= this.expectedSymbolsTotal) {
            this.finishCaptureAndDecode();
          }
        }
      }
    } else {
      this.lastDetectedSymbol = -1;
      this.currentSymbolHoldCount = 0;
    }
  }

  private checkDynamicPacketLength() {
    if (this.expectedSymbolsTotal === 0 && this.capturedSymbols.length >= 8) {
      try {
        let byte0 = 0;
        let byte1 = 0;
        let bitIdx = 0;
        for (let s = 0; s < 6; s++) {
          const sym = this.capturedSymbols[s];
          for (let b = 2; b >= 0; b--) {
            if (bitIdx < 8) {
              byte0 |= ((sym >>> b) & 1) << (7 - bitIdx);
            } else if (bitIdx < 16) {
              byte1 |= ((sym >>> b) & 1) << (15 - bitIdx);
            }
            bitIdx++;
          }
        }
        const payloadLength = byte0 | (byte1 << 8);
        if (payloadLength > 0 && payloadLength <= 2048) {
          const encodedBytes = calcEncodedByteCount(payloadLength);
          this.expectedSymbolsTotal = Math.ceil((encodedBytes * 8) / 3);
        }
      } catch {}
    }
  }

  private async finishCaptureAndDecode() {
    this.setState('decoding');
    const durMs = performance.now() - this.startTime;

    try {
      const encodedByteCount = calcEncodedByteCount(
        Math.floor((this.capturedSymbols.length * 3) / 8) - (HEADER_BYTES + CRC_BYTES + RS_PARITY_BYTES),
      );

      const { header, data, errorsFixed } = decodePacket(
        this.capturedSymbols,
        encodedByteCount > 0 ? encodedByteCount : 32,
      );

      let payload = data;

      if (header.encrypted) {
        if (!this.pin) {
          throw new Error('Payload is encrypted. PIN required to decrypt.');
        }
        payload = await decrypt(payload, this.pin);
      }

      if (header.compressed) {
        payload = await decompress(payload);
      }

      const text = new TextDecoder().decode(payload);

      const result: ReceiveResult = {
        text,
        encrypted: header.encrypted,
        compressed: header.compressed,
        byteLength: payload.length,
        durationMs: durMs,
        errorsFixed,
      };

      this.setState('done');
      this.onResult?.(result);
    } catch (err: any) {
      this.setState('error');
      this.onError?.(err);
    } finally {
      this.stop();
    }
  }

  stop(): void {
    if (this.meterTimer) {
      clearInterval(this.meterTimer);
      this.meterTimer = 0;
    }

    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: 'stop' });
        this.workletNode.disconnect();
      } catch {}
      this.workletNode = null;
    }

    if (this.bandpassFilter) {
      this.bandpassFilter.disconnect();
      this.bandpassFilter = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }

    this.resetDetectionState();
    if (this.state !== 'done' && this.state !== 'error') {
      this.setState('idle');
    }
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyserNode;
  }
}
