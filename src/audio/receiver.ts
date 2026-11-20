import {
  getDSPConfig,
  SAMPLE_RATE,
  SYMBOL_SAMPLES,
  GUARD_SAMPLES,
  TOTAL_SYMBOL_SAMPLES,
  PREAMBLE_PATTERN,
  PREAMBLE_LENGTH,
  GOERTZEL_THRESHOLD,
  GOERTZEL_SNR_RATIO,
} from '../core/constants';
import {
  decodePacket,
  decodePacketBytes,
  calcEncodedByteCount,
} from '../core/framing';
import {
  getTurboFrequencies,
  TURBO_SYMBOL_SAMPLES,
  TURBO_TOTAL_SAMPLES,
  TURBO_PREAMBLE_PATTERN,
} from '../core/turbo';
import { decompress } from '../core/compression';
import { decrypt } from '../core/crypto';
import { evaluateSpectrumHealth } from '../core/calibration';
import type {
  ReceiveResult,
  ReceiveState,
  TransmissionMode,
  SpeedProfile,
  ChannelHealth,
  PacketHeader,
} from '../types';

export class Receiver {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private bandpassFilter: BiquadFilterNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private muteGain: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;

  state: ReceiveState = 'idle';
  private mode: TransmissionMode = 'stealth';
  private speed: SpeedProfile = 'standard';
  private pin: string | null = null;

  private preambleBuffer: number[] = [];
  private capturedSymbols: number[] = [];
  private capturedBytes: number[] = [];
  private expectedSymbolsTotal = 0;
  private expectedBytesTotal = 0;
  private lastDetectedSymbol = -1;
  private isSynchronized = false;
  private startTime = 0;
  private meterTimer = 0;

  private hopCount = 0;
  private tone7PeakHop = 0;
  private tone7PeakMag = 0;
  private tone7Hops = 0;
  private nextSampleHop = 0;
  private silenceHops = 0;
  private hopsPerSymbol = 10;
  private lastMags = new Float32Array(16);

  onStateChange?: (state: ReceiveState) => void;
  onSymbolDetected?: (symbol: number, mag: number) => void;
  onProgress?: (receivedSymbols: number, totalSymbols: number) => void;
  onResult?: (result: ReceiveResult) => void;
  onError?: (err: Error) => void;
  onAnalyserReady?: (analyser: AnalyserNode) => void;
  onMicLevel?: (normalized: number, db: number) => void;
  onChannelHealth?: (health: ChannelHealth) => void;

  private setState(newState: ReceiveState) {
    this.state = newState;
    this.onStateChange?.(newState);
  }

  async start(
    mode: TransmissionMode = 'stealth',
    speed: SpeedProfile = 'standard',
    pin?: string,
  ): Promise<void> {
    this.mode = mode;
    this.speed = speed;
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
        this.bandpassFilter.type = 'highpass';
        this.bandpassFilter.frequency.value = 16000;
        this.bandpassFilter.Q.value = 0.707;
      } else {
        this.bandpassFilter.type = 'highpass';
        this.bandpassFilter.frequency.value = 1500;
        this.bandpassFilter.Q.value = 0.707;
      }

      this.analyserNode = this.ctx.createAnalyser();
      this.analyserNode.fftSize = 2048;
      this.analyserNode.smoothingTimeConstant = 0.2;
      this.onAnalyserReady?.(this.analyserNode);

      await this.ctx.audioWorklet.addModule('./worklets/demodulator-worklet.js');
      this.workletNode = new AudioWorkletNode(this.ctx, 'demodulator-processor');

      const hopSize = 64;
      if (speed === 'turbo') {
        this.hopsPerSymbol = Math.round(TURBO_TOTAL_SAMPLES / hopSize); // 5 hops = 320 samples
        const freqs = getTurboFrequencies(mode);
        this.workletNode.port.postMessage({
          type: 'configure',
          frequencies: freqs,
          blockSize: TURBO_SYMBOL_SAMPLES,
          hopSize: hopSize,
        });
      } else {
        this.hopsPerSymbol = Math.round(TOTAL_SYMBOL_SAMPLES / hopSize); // 10 hops = 640 samples
        const config = getDSPConfig(mode);
        this.workletNode.port.postMessage({
          type: 'configure',
          frequencies: config.frequencies,
          blockSize: SYMBOL_SAMPLES,
          hopSize: hopSize,
        });
      }

      this.workletNode.port.onmessage = (event) => {
        if (event.data.type === 'magnitudes') {
          this.processMagnitudes(new Float32Array(event.data.mags));
        }
      };

      this.muteGain = this.ctx.createGain();
      this.muteGain.gain.value = 0;

      this.sourceNode.connect(this.bandpassFilter);
      this.bandpassFilter.connect(this.analyserNode);
      this.analyserNode.connect(this.workletNode);
      this.workletNode.connect(this.muteGain);
      this.muteGain.connect(this.ctx.destination);

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
    this.capturedBytes = [];
    this.expectedSymbolsTotal = 0;
    this.expectedBytesTotal = 0;
    this.lastDetectedSymbol = -1;
    this.isSynchronized = false;
    this.hopCount = 0;
    this.tone7PeakHop = 0;
    this.tone7PeakMag = 0;
    this.tone7Hops = 0;
    this.nextSampleHop = 0;
    this.silenceHops = 0;
  }

  private processMagnitudes(mags: Float32Array) {
    this.hopCount++;
    this.lastMags.set(mags);

    let maxVal = 0;
    let maxIdx = -1;
    let sum = 0;
    for (let i = 0; i < mags.length; i++) {
      sum += mags[i];
      if (mags[i] > maxVal) {
        maxVal = mags[i];
        maxIdx = i;
      }
    }

    const noise = (sum - maxVal) / (mags.length - 1);
    const detected = maxVal >= GOERTZEL_THRESHOLD && maxVal >= GOERTZEL_SNR_RATIO * noise ? maxIdx : -1;
    this.onSymbolDetected?.(detected, maxVal);

    if (!this.isSynchronized) {
      this.handlePreambleSearch(detected, maxVal);
    } else {
      this.handleSymbolCollection(detected, maxIdx);
    }
  }

  private handlePreambleSearch(detected: number, maxVal: number) {
    if (detected === -1) return;

    if (this.speed === 'turbo') {
      const turboPattern = [14, 12, 10, 8, 6, 4, 2, 0];
      if (detected !== this.lastDetectedSymbol) {
        this.lastDetectedSymbol = detected;
        const expected = this.preambleBuffer.length;
        if (expected < turboPattern.length && detected === turboPattern[expected]) {
          this.preambleBuffer.push(detected);
          this.setState('syncing');
          if (detected === 0) {
            this.tone7PeakHop = this.hopCount;
            this.tone7PeakMag = maxVal;
            this.tone7Hops = 1;
          }
        } else if (detected === turboPattern[0]) {
          this.preambleBuffer = [detected];
          this.setState('syncing');
        } else {
          this.preambleBuffer = [];
          this.setState('listening');
        }
      } else if (detected === 0 && this.preambleBuffer.length === turboPattern.length) {
        this.tone7Hops++;
        if (maxVal > this.tone7PeakMag) {
          this.tone7PeakMag = maxVal;
          this.tone7PeakHop = this.hopCount;
        }
        if (this.tone7Hops >= 4) {
          this.isSynchronized = true;
          this.startTime = performance.now();
          this.capturedBytes = [];
          this.expectedBytesTotal = 0;
          this.silenceHops = 0;
          this.nextSampleHop = this.tone7PeakHop + this.hopsPerSymbol;
          this.setState('receiving');
        }
      }
    } else {
      if (detected !== this.lastDetectedSymbol) {
        this.lastDetectedSymbol = detected;
        const expected = this.preambleBuffer.length;
        if (expected < PREAMBLE_LENGTH && detected === PREAMBLE_PATTERN[expected]) {
          this.preambleBuffer.push(detected);
          this.setState('syncing');
          if (detected === 7) {
            this.tone7PeakHop = this.hopCount;
            this.tone7PeakMag = maxVal;
            this.tone7Hops = 1;
          }
        } else if (detected === PREAMBLE_PATTERN[0]) {
          this.preambleBuffer = [detected];
          this.setState('syncing');
        } else {
          this.preambleBuffer = [];
          this.setState('listening');
        }
      } else if (detected === 7 && this.preambleBuffer.length === PREAMBLE_LENGTH) {
        this.tone7Hops++;
        if (maxVal > this.tone7PeakMag) {
          this.tone7PeakMag = maxVal;
          this.tone7PeakHop = this.hopCount;
        }
        if (this.tone7Hops >= 4) {
          this.isSynchronized = true;
          this.startTime = performance.now();
          this.capturedSymbols = [];
          this.expectedSymbolsTotal = 0;
          this.silenceHops = 0;
          this.nextSampleHop = this.tone7PeakHop + this.hopsPerSymbol;
          this.setState('receiving');
        }
      }
    }
  }

  private handleSymbolCollection(detected: number, maxIdx: number) {
    if (detected === -1) {
      this.silenceHops++;
      if (
        this.silenceHops > this.hopsPerSymbol * 5 &&
        (this.capturedSymbols.length >= 8 || this.capturedBytes.length >= 8)
      ) {
        this.finishCaptureAndDecode();
        return;
      }
    } else {
      this.silenceHops = 0;
    }

    if (this.hopCount === this.nextSampleHop) {
      if (this.speed === 'turbo') {
        let b0 = 0, m0 = 0;
        for (let i = 0; i < 4; i++) if (this.lastMags[i] > m0) { m0 = this.lastMags[i]; b0 = i; }
        let b1 = 0, m1 = 0;
        for (let i = 4; i < 8; i++) if (this.lastMags[i] > m1) { m1 = this.lastMags[i]; b1 = i - 4; }
        let b2 = 0, m2 = 0;
        for (let i = 8; i < 12; i++) if (this.lastMags[i] > m2) { m2 = this.lastMags[i]; b2 = i - 8; }
        let b3 = 0, m3 = 0;
        for (let i = 12; i < 16; i++) if (this.lastMags[i] > m3) { m3 = this.lastMags[i]; b3 = i - 12; }

        const byte = b0 | (b1 << 2) | (b2 << 4) | (b3 << 6);
        this.capturedBytes.push(byte);
        this.nextSampleHop += this.hopsPerSymbol;

        this.checkDynamicTurboLength();
        this.onProgress?.(this.capturedBytes.length, this.expectedBytesTotal);

        if (this.expectedBytesTotal > 0 && this.capturedBytes.length >= this.expectedBytesTotal) {
          this.finishCaptureAndDecode();
        }
      } else {
        this.capturedSymbols.push(maxIdx);
        this.nextSampleHop += this.hopsPerSymbol;

        this.checkDynamicPacketLength();
        this.onProgress?.(this.capturedSymbols.length, this.expectedSymbolsTotal);

        if (this.expectedSymbolsTotal > 0 && this.capturedSymbols.length >= this.expectedSymbolsTotal) {
          this.finishCaptureAndDecode();
        }
      }
    }
  }

  private checkDynamicTurboLength() {
    if (this.expectedBytesTotal === 0 && this.capturedBytes.length >= 3) {
      const payloadLength = this.capturedBytes[0] | (this.capturedBytes[1] << 8);
      if (payloadLength > 0 && payloadLength <= 2048) {
        this.expectedBytesTotal = 3 + payloadLength + 4 + 16;
      }
    }
  }

  private checkDynamicPacketLength() {
    if (this.expectedSymbolsTotal === 0 && this.capturedSymbols.length >= 6) {
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
      let header: PacketHeader;
      let data: Uint8Array;
      let errorsFixed = 0;

      if (this.speed === 'turbo') {
        const raw = new Uint8Array(this.capturedBytes);
        const dec = decodePacketBytes(raw);
        header = dec.header;
        data = dec.data;
        errorsFixed = dec.errorsFixed;
      } else {
        const encodedByteCount = this.expectedSymbolsTotal > 0
          ? Math.floor((this.expectedSymbolsTotal * 3) / 8)
          : Math.floor((this.capturedSymbols.length * 3) / 8);

        const dec = decodePacket(
          this.capturedSymbols,
          encodedByteCount > 0 ? encodedByteCount : 32,
        );
        header = dec.header;
        data = dec.data;
        errorsFixed = dec.errorsFixed;
      }

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
        mode: this.mode,
        speed: this.speed,
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

    if (this.muteGain) {
      try {
        this.muteGain.disconnect();
      } catch {}
      this.muteGain = null;
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

  getChannelHealth(): ChannelHealth | null {
    if (!this.analyserNode || !this.ctx) return null;
    const freqData = new Float32Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getFloatFrequencyData(freqData);
    return evaluateSpectrumHealth(freqData, this.ctx.sampleRate);
  }
}
