import { Transmitter } from '../audio/transmitter';
import { Receiver } from '../audio/receiver';
import { pcmToWavBlob, downloadBlob } from '../core/wav';
import { evaluateSpectrumHealth } from '../core/calibration';
import type { TransmissionMode, SpeedProfile } from '../types';

const BANDS: Record<TransmissionMode, [number, number]> = {
  stealth: [18, 20],
  audible: [2, 5.5],
};

const IDLE = {
  send: [
    'Ready to send',
    'Write a message, then transmit it. Keep the receiving device close, microphone toward this one.',
  ] as const,
  recv: [
    'Ready to listen',
    'Start listening, then transmit from the other device. Keep the two devices close together.',
  ] as const,
};

export class App {
  private mode: TransmissionMode = 'stealth';
  private speed: SpeedProfile = 'standard';
  private panel: 'send' | 'recv' = 'send';
  private transmitter = new Transmitter();
  private receiver = new Receiver();

  private isRunning = false;
  private hiddenText = true;
  private receivedPayload = '';
  private rafId = 0;
  private frameCounter = 0;

  private currentAnalyser: AnalyserNode | null = null;
  private freqData: Uint8Array | null = null;

  private root!: HTMLElement;
  private cv!: HTMLCanvasElement;
  private cx!: CanvasRenderingContext2D;

  mount(root: HTMLElement): void {
    this.root = root;
    this.root.innerHTML = this.getHtml();
    this.initCanvas();
    this.bindEvents();
    this.updateBand();
    this.validate();
    this.say('idle', IDLE.send[0], IDLE.send[1]);
  }

  private getHtml(): string {
    return `
      <div class="wrap">
        <header>
          <div class="brand"><svg aria-hidden="true"><use href="#m"/></svg>SonicDrop</div>
          <div class="off">No internet required</div>
        </header>

        <div class="tabs" id="tabs" data-m="send" role="tablist">
          <span class="thumb"></span>
          <button role="tab" id="tab-send" data-m="send" aria-selected="true">Send</button>
          <button role="tab" id="tab-recv" data-m="recv" aria-selected="false">Receive</button>
        </div>

        <div class="grid">
          <section class="card">
            <div class="form" id="p-send">
              <div class="step" id="s1" data-n="1">
                <div class="row">
                  <label class="st" for="msg">Write your message</label>
                  <span class="cnt" id="cnt">0 / 512 bytes</span>
                </div>
                <textarea id="msg" placeholder="Paste a key, password or note"></textarea>
                <div class="row">
                  <span class="sub">It only leaves this device as sound.</span>
                  <button class="link" id="eye" type="button">Hide</button>
                </div>
              </div>

              <div class="step" id="s2" data-n="2">
                <div class="st">Choose how to send it</div>
                <div class="opts">
                  <label class="opt">
                    <input type="radio" name="ch-send" value="stealth" checked>
                    <div><b>Stealth</b><span>18–20 kHz, inaudible</span></div>
                  </label>
                  <label class="opt">
                    <input type="radio" name="ch-send" value="audible">
                    <div><b>Audible</b><span>2–5.5 kHz, most reliable in noisy rooms</span></div>
                  </label>
                </div>
                <div class="row" style="margin-top: 6px;">
                  <span class="sub" id="cal-hint-send">Channel calibration</span>
                  <button class="link" id="btn-sweep" type="button">Play sweep test</button>
                </div>
                <div class="row" style="margin-top: 10px;">
                  <span class="lab">Speed</span>
                  <div class="row" style="gap: 12px;">
                    <label style="font-size: 13px; display: flex; align-items: center; gap: 4px; cursor: pointer;">
                      <input type="radio" name="spd-send" value="standard" checked> Standard (225 bps)
                    </label>
                    <label style="font-size: 13px; display: flex; align-items: center; gap: 4px; cursor: pointer;">
                      <input type="radio" name="spd-send" value="turbo"> Turbo (1,200 bps)
                    </label>
                  </div>
                </div>
                <div class="f">
                  <label class="lab" for="pin">PIN <span class="sub">(optional)</span></label>
                  <input type="text" id="pin" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="4 digits">
                  <span class="sub">Encrypts with AES-256-GCM. The receiver enters the same PIN.</span>
                </div>
              </div>

              <div class="step" id="s3" data-n="3">
                <div class="st">Transmit</div>
                <div class="acts">
                  <button class="btn" id="tx" disabled>Transmit</button>
                  <button class="btn sec" id="wav" disabled>Save WAV</button>
                </div>
              </div>
            </div>

            <div class="form" id="p-recv" hidden>
              <div class="step done" data-n="1">
                <div class="st">Choose the channel</div>
                <div class="opts">
                  <label class="opt">
                    <input type="radio" name="ch-recv" value="stealth" checked>
                    <div><b>Stealth</b><span>18–20 kHz, inaudible</span></div>
                  </label>
                  <label class="opt">
                    <input type="radio" name="ch-recv" value="audible">
                    <div><b>Audible</b><span>2–5.5 kHz, most reliable in noisy rooms</span></div>
                  </label>
                </div>
                <div class="row" style="margin-top: 6px;">
                  <span class="sub" id="cal-hint-recv">Auto-profiling active while listening</span>
                </div>
                <div class="row" style="margin-top: 10px;">
                  <span class="lab">Speed</span>
                  <div class="row" style="gap: 12px;">
                    <label style="font-size: 13px; display: flex; align-items: center; gap: 4px; cursor: pointer;">
                      <input type="radio" name="spd-recv" value="standard" checked> Standard (225 bps)
                    </label>
                    <label style="font-size: 13px; display: flex; align-items: center; gap: 4px; cursor: pointer;">
                      <input type="radio" name="spd-recv" value="turbo"> Turbo (1,200 bps)
                    </label>
                  </div>
                </div>
              </div>

              <div class="step done" data-n="2">
                <div class="f">
                  <label class="st" for="dpin">Enter the PIN <span class="sub">(if the sender set one)</span></label>
                  <input type="text" id="dpin" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="4 digits">
                </div>
              </div>

              <div class="step" id="r3" data-n="3">
                <div class="st">Start listening</div>
                <div class="acts">
                  <button class="btn" id="rx">Start listening</button>
                </div>
                <div class="res" id="res" hidden>
                  <div class="out" id="out"></div>
                  <div class="row">
                    <button class="link" id="show" type="button">Show</button>
                    <button class="link" id="copy" type="button">Copy</button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section class="card link-card">
            <div class="stat" id="stat" data-s="idle">
              <i></i>
              <div>
                <b id="ttl"></b>
                <span id="dsc"></span>
              </div>
            </div>

            <svg id="viz" viewBox="0 0 420 140" role="img" aria-label="Sound travelling from one device to another">
              <g class="dev">
                <rect x="24" y="20" width="56" height="88" rx="10"/>
                <rect class="fl" x="44" y="96" width="16" height="3" rx="1.5"/>
              </g>
              <g class="arcs l">
                <path d="M96 42A22 22 0 0 1 96 86"/>
                <path d="M96 24A40 40 0 0 1 96 104"/>
                <path d="M96 6A58 58 0 0 1 96 122"/>
              </g>
              <line class="dots" x1="172" y1="64" x2="248" y2="64"/>
              <g class="arcs r">
                <path d="M324 42A22 22 0 0 0 324 86"/>
                <path d="M324 24A40 40 0 0 0 324 104"/>
                <path d="M324 6A58 58 0 0 0 324 122"/>
              </g>
              <g class="dev">
                <rect x="340" y="20" width="56" height="88" rx="10"/>
                <rect class="fl" x="360" y="96" width="16" height="3" rx="1.5"/>
              </g>
              <text id="ll" x="52" y="134">This device</text>
              <text id="lr" x="368" y="134">Nearby device</text>
            </svg>

            <div class="f">
              <div class="row">
                <span class="lab">Signal activity</span>
                <span class="sub" id="rng"></span>
              </div>
              <div class="plot" id="plot">
                <div class="band" id="band"></div>
                <canvas id="cv"></canvas>
                <div class="hint" id="hint">Nothing yet</div>
              </div>
            </div>

            <div class="bar"><i id="bar"></i></div>
          </section>
        </div>

        <footer>
          Your message travels as sound through the air, with Reed–Solomon error correction and a CRC-32 integrity check. No network is used at any point.
        </footer>
      </div>
    `;
  }

  private initCanvas(): void {
    this.cv = this.root.querySelector('#cv')!;
    this.cx = this.cv.getContext('2d')!;

    const plot = this.root.querySelector('#plot')!;
    const hint = this.root.querySelector('#hint')!;
    [5, 10, 15, 20].forEach((f) => {
      const t = document.createElement('div');
      t.className = 'tick';
      t.style.bottom = (f / 22) * 100 + '%';
      t.textContent = f + ' kHz';
      plot.insertBefore(t, hint);
    });

    const observer = new ResizeObserver(() => {
      this.cv.width = this.cv.clientWidth;
      this.cv.height = this.cv.clientHeight;
    });
    observer.observe(this.cv);

    this.transmitter.onAnalyserReady = (a) => this.attachAnalyser(a);
    this.receiver.onAnalyserReady = (a) => this.attachAnalyser(a);
  }

  private attachAnalyser(analyser: AnalyserNode) {
    this.currentAnalyser = analyser;
    this.freqData = new Uint8Array(analyser.frequencyBinCount);
    if (!this.rafId) {
      this.startWaterfallLoop();
    }
  }

  private startWaterfallLoop() {
    const loop = () => {
      this.renderWaterfall();
      if (this.isRunning) {
        this.rafId = requestAnimationFrame(loop);
      } else {
        this.rafId = 0;
      }
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private renderWaterfall() {
    const W = this.cv.width;
    const H = this.cv.height;
    if (!W || !H) return;

    this.cx.drawImage(this.cv, -2, 0);
    this.cx.clearRect(W - 2, 0, 2, H);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    this.cx.fillStyle = accent || '#1F5EDD';

    if (this.currentAnalyser && this.freqData) {
      this.currentAnalyser.getByteFrequencyData(this.freqData as any);
      const binCount = this.freqData.length;
      const maxFreq = 22000;
      const sampleRate = 48000;

      for (let y = 0; y < H; y += 2) {
        const freq = maxFreq * (1 - y / H);
        const bin = Math.min(binCount - 1, Math.round((freq * 2 * binCount) / sampleRate));
        const val = this.freqData[bin] || 0;
        const norm = val / 255;

        if (norm > 0.05) {
          this.cx.globalAlpha = Math.min(1, norm * 1.2);
          this.cx.fillRect(W - 2, y, 2, 2);
        }
      }
      this.cx.globalAlpha = 1;

      this.frameCounter = (this.frameCounter || 0) + 1;
      if (this.frameCounter % 30 === 0 && this.panel === 'recv' && this.isRunning) {
        this.updateLiveChannelHealth();
      }
    }
  }

  private updateLiveChannelHealth(): void {
    if (!this.freqData) return;
    const health = evaluateSpectrumHealth(this.freqData, 48000);
    const hint = this.root.querySelector('#cal-hint-recv') as HTMLElement;
    if (!hint) return;

    if (health.stealthSupported) {
      hint.innerHTML = `<span style="color:#10b981;font-weight:500;">● Stealth ready</span> • Cutoff: ${(health.cutoffFreq / 1000).toFixed(1)} kHz (SNR: ${health.snrDb} dB)`;
    } else {
      hint.innerHTML = `<span style="color:#f59e0b;font-weight:500;">● Audible recommended</span> • ${health.reason}`;
    }
  }

  private say(status: 'idle' | 'busy' | 'ok' | 'error', title: string, desc: string): void {
    const stat = this.root.querySelector('#stat') as HTMLDivElement;
    const ttl = this.root.querySelector('#ttl') as HTMLElement;
    const dsc = this.root.querySelector('#dsc') as HTMLElement;
    if (stat) stat.dataset.s = status;
    if (ttl) ttl.textContent = title;
    if (dsc) dsc.textContent = desc;
  }

  private updateBand(): void {
    const activeChannel = this.root.querySelector<HTMLInputElement>(`#p-${this.panel} input[name^="ch-"]:checked`);
    this.mode = (activeChannel?.value as TransmissionMode) || 'stealth';
    const activeSpeed = this.root.querySelector<HTMLInputElement>(`#p-${this.panel} input[name^="spd-"]:checked`);
    this.speed = (activeSpeed?.value as SpeedProfile) || 'standard';

    const [a, b] = BANDS[this.mode];
    const el = this.root.querySelector('#band') as HTMLDivElement;
    const rng = this.root.querySelector('#rng') as HTMLElement;
    if (el) {
      el.style.top = (1 - b / 22) * 100 + '%';
      el.style.height = ((b - a) / 22) * 100 + '%';
    }
    if (rng) {
      rng.textContent = `${a}–${b} kHz • ${this.speed === 'turbo' ? 'Turbo 1.2 kbps' : '225 bps'}`;
    }
  }

  private validate(): void {
    const msg = (this.root.querySelector('#msg') as HTMLTextAreaElement)?.value || '';
    const pin = (this.root.querySelector('#pin') as HTMLInputElement)?.value || '';
    const n = new TextEncoder().encode(msg).length;
    const badPin = pin.length > 0 && pin.length < 4;
    const ok = n > 0 && n <= 512 && !badPin;

    const cnt = this.root.querySelector('#cnt') as HTMLElement;
    if (cnt) {
      cnt.textContent = n + ' / 512 bytes';
      cnt.classList.toggle('bad', n > 512);
    }

    const pinGroup = (this.root.querySelector('#pin') as HTMLElement)?.closest('.f');
    pinGroup?.classList.toggle('bad', badPin);

    this.root.querySelector('#s1')?.classList.toggle('done', ok);
    this.root.querySelector('#s2')?.classList.toggle('done', ok);

    const tx = this.root.querySelector('#tx') as HTMLButtonElement;
    const wav = this.root.querySelector('#wav') as HTMLButtonElement;
    if (tx) tx.disabled = !this.isRunning && !ok;
    if (wav) wav.disabled = !ok || this.isRunning;
  }

  private paintReceived(): void {
    const out = this.root.querySelector('#out') as HTMLElement;
    const show = this.root.querySelector('#show') as HTMLElement;
    if (out) {
      out.textContent = this.hiddenText ? '•'.repeat(this.receivedPayload.length || 8) : this.receivedPayload;
    }
    if (show) {
      show.textContent = this.hiddenText ? 'Show' : 'Hide';
    }
  }

  private bindEvents(): void {
    const tabs = this.root.querySelector('#tabs') as HTMLElement;
    const tabBtns = this.root.querySelectorAll<HTMLButtonElement>('.tabs button');
    const pSend = this.root.querySelector('#p-send') as HTMLElement;
    const pRecv = this.root.querySelector('#p-recv') as HTMLElement;
    const ll = this.root.querySelector('#ll') as HTMLElement;
    const lr = this.root.querySelector('#lr') as HTMLElement;
    const hint = this.root.querySelector('#hint') as HTMLElement;
    const bar = this.root.querySelector('#bar') as HTMLElement;

    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (this.isRunning) this.stopCurrent();
        this.panel = btn.dataset.m as 'send' | 'recv';
        tabs.dataset.m = this.panel;

        tabBtns.forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
        pSend.hidden = this.panel !== 'send';
        pRecv.hidden = this.panel !== 'recv';

        this.root.querySelector('#res')!.setAttribute('hidden', '');
        bar.style.width = '0';

        if (this.panel === 'send') {
          ll.textContent = 'This device';
          lr.textContent = 'Nearby device';
          this.say('idle', IDLE.send[0], IDLE.send[1]);
        } else {
          ll.textContent = 'Nearby device';
          lr.textContent = 'This device';
          this.say('idle', IDLE.recv[0], IDLE.recv[1]);
        }

        this.cx.clearRect(0, 0, this.cv.width, this.cv.height);
        hint.hidden = false;
        this.updateBand();
      });
    });

    const msg = this.root.querySelector('#msg') as HTMLTextAreaElement;
    msg.addEventListener('input', () => {
      this.validate();
      this.root.querySelector('#s3')?.classList.remove('done');
    });

    const eye = this.root.querySelector('#eye') as HTMLButtonElement;
    eye.addEventListener('click', () => {
      const masked = msg.classList.toggle('mask');
      eye.textContent = masked ? 'Show' : 'Hide';
    });

    const pins = this.root.querySelectorAll<HTMLInputElement>('#pin, #dpin');
    pins.forEach((p) => {
      p.addEventListener('input', () => {
        p.value = p.value.replace(/\D/g, '');
        this.validate();
      });
    });

    const radios = this.root.querySelectorAll<HTMLInputElement>('input[type=radio]');
    radios.forEach((r) => r.addEventListener('change', () => this.updateBand()));

    const tx = this.root.querySelector('#tx') as HTMLButtonElement;
    tx.addEventListener('click', () => {
      if (this.isRunning) {
        this.stopCurrent();
        return;
      }
      this.handleTransmit();
    });

    const wav = this.root.querySelector('#wav') as HTMLButtonElement;
    wav.addEventListener('click', () => {
      this.handleSaveWav();
    });

    const btnSweep = this.root.querySelector('#btn-sweep') as HTMLButtonElement;
    btnSweep?.addEventListener('click', async () => {
      if (this.isRunning) return;
      this.isRunning = true;
      btnSweep.disabled = true;
      btnSweep.textContent = 'Sweeping...';
      const viz = this.root.querySelector('#viz') as HTMLElement;
      const hint = this.root.querySelector('#hint') as HTMLElement;
      this.cx.clearRect(0, 0, this.cv.width, this.cv.height);
      hint.hidden = true;
      viz.classList.add('l');
      this.say('busy', 'Acoustic sweep', 'Broadcasting 1–20.5 kHz channel calibration chirp.');

      this.transmitter.onStateChange = (state) => {
        if (state === 'done') {
          this.say('ok', 'Sweep complete', 'Frequency spectrum benchmark broadcasted.');
          btnSweep.disabled = false;
          btnSweep.textContent = 'Play sweep test';
          this.stopCurrent(true);
        } else if (state === 'error') {
          this.say('error', 'Sweep error', 'Failed to play calibration sweep.');
          btnSweep.disabled = false;
          btnSweep.textContent = 'Play sweep test';
          this.stopCurrent(false);
        }
      };

      try {
        await this.transmitter.playCalibrationChirp();
      } catch (e: any) {
        alert('Calibration error: ' + e.message);
        btnSweep.disabled = false;
        btnSweep.textContent = 'Play sweep test';
        this.stopCurrent(false);
      }
    });

    const rx = this.root.querySelector('#rx') as HTMLButtonElement;
    rx.addEventListener('click', () => {
      if (this.isRunning) {
        this.stopCurrent();
        return;
      }
      this.handleReceive();
    });

    const show = this.root.querySelector('#show') as HTMLButtonElement;
    show.addEventListener('click', () => {
      this.hiddenText = !this.hiddenText;
      this.paintReceived();
    });

    const copy = this.root.querySelector('#copy') as HTMLButtonElement;
    copy.addEventListener('click', async () => {
      if (this.receivedPayload) {
        try {
          await navigator.clipboard.writeText(this.receivedPayload);
          copy.textContent = 'Copied';
          setTimeout(() => (copy.textContent = 'Copy'), 1500);
        } catch {}
      }
    });
  }

  private async handleTransmit() {
    const text = (this.root.querySelector('#msg') as HTMLTextAreaElement).value.trim();
    const pin = (this.root.querySelector('#pin') as HTMLInputElement).value.trim() || undefined;
    const txBtn = this.root.querySelector('#tx') as HTMLButtonElement;
    const viz = this.root.querySelector('#viz') as HTMLElement;
    const bar = this.root.querySelector('#bar') as HTMLElement;
    const hint = this.root.querySelector('#hint') as HTMLElement;

    this.isRunning = true;
    txBtn.textContent = 'Cancel';
    txBtn.classList.add('sec');
    this.root.querySelector('#s3')?.classList.remove('done');

    this.cx.clearRect(0, 0, this.cv.width, this.cv.height);
    hint.hidden = true;
    viz.classList.add('l');

    this.say('busy', 'Transmitting', 'Keep both devices still until it finishes.');

    this.transmitter.onProgress = (pct) => {
      bar.style.width = Math.round(pct * 100) + '%';
    };

    this.transmitter.onStateChange = (state) => {
      if (state === 'done') {
        const byteCount = new TextEncoder().encode(text).length;
        this.say('ok', 'Sent', `Transmitted ${byteCount} bytes.`);
        bar.style.width = '100%';
        this.root.querySelector('#s3')?.classList.add('done');
        this.stopCurrent(true);
      } else if (state === 'error') {
        this.say('error', 'Transmission error', 'Failed to broadcast acoustic signal.');
        this.stopCurrent(false);
      }
    };

    try {
      await this.transmitter.transmit(text, { mode: this.mode, speed: this.speed, pin });
    } catch (err: any) {
      alert(`Error transmitting: ${err.message}`);
      this.stopCurrent(false);
    }
  }

  private async handleSaveWav() {
    const text = (this.root.querySelector('#msg') as HTMLTextAreaElement).value.trim();
    const pin = (this.root.querySelector('#pin') as HTMLInputElement).value.trim() || undefined;
    const wavBtn = this.root.querySelector('#wav') as HTMLButtonElement;

    try {
      wavBtn.textContent = 'Saving...';
      const { pcm, sampleRate } = await this.transmitter.synthesizePCM(text, {
        mode: this.mode,
        speed: this.speed,
        pin,
      });
      const blob = pcmToWavBlob(pcm, sampleRate);
      downloadBlob(blob, `sonicdrop-${this.mode}-${this.speed}-${Date.now()}.wav`);
      wavBtn.textContent = 'Save WAV';
    } catch (err: any) {
      alert(`Failed to export WAV: ${err.message}`);
      wavBtn.textContent = 'Save WAV';
    }
  }

  private async handleReceive() {
    const pin = (this.root.querySelector('#dpin') as HTMLInputElement).value.trim() || undefined;
    const rxBtn = this.root.querySelector('#rx') as HTMLButtonElement;
    const viz = this.root.querySelector('#viz') as HTMLElement;
    const res = this.root.querySelector('#res') as HTMLElement;
    const hint = this.root.querySelector('#hint') as HTMLElement;
    const bar = this.root.querySelector('#bar') as HTMLElement;

    this.isRunning = true;
    rxBtn.textContent = 'Stop listening';
    rxBtn.classList.add('sec');
    res.hidden = true;
    this.root.querySelector('#r3')?.classList.remove('done');

    this.cx.clearRect(0, 0, this.cv.width, this.cv.height);
    hint.hidden = true;
    viz.classList.add('r');

    this.say('busy', 'Listening', 'Waiting for a signal on the selected channel.');

    this.receiver.onStateChange = (state) => {
      if (state === 'listening') {
        this.say('busy', 'Listening', 'Waiting for acoustic preamble...');
      } else if (state === 'syncing') {
        this.say('busy', 'Preamble detected', 'Synchronizing symbol clock...');
      } else if (state === 'receiving') {
        this.say('busy', 'Receiving', 'Capturing audio payload packets. Keep devices still.');
      } else if (state === 'decoding') {
        this.say('busy', 'Checking', 'Verifying Reed-Solomon ECC & CRC-32...');
      } else if (state === 'error') {
        this.say('error', 'Receive error', 'Signal corrupted or wrong PIN.');
        this.stopCurrent(false);
      }
    };

    this.receiver.onProgress = (cur, total) => {
      if (total > 0) {
        bar.style.width = Math.min(100, Math.round((cur / total) * 100)) + '%';
      }
    };

    this.receiver.onResult = async (result) => {
      this.receivedPayload = result.text;
      const spdTag = result.speed === 'turbo' ? 'TURBO 1.2k' : 'STD 225b';
      this.say(
        'ok',
        'Message received',
        `Checksum passed. ${result.errorsFixed} byte error(s) corrected. [${spdTag} • ${result.mode.toUpperCase()}]`,
      );
      bar.style.width = '100%';
      this.paintReceived();
      res.hidden = false;
      this.root.querySelector('#r3')?.classList.add('done');

      try {
        await navigator.clipboard.writeText(result.text);
      } catch {}

      this.stopCurrent(true);
    };

    this.receiver.onError = (err) => {
      this.say('error', 'Error', err.message);
      this.stopCurrent(false);
    };

    try {
      await this.receiver.start(this.mode, this.speed, pin);
    } catch (err: any) {
      alert(`Microphone access error: ${err.message}`);
      this.stopCurrent(false);
    }
  }

  private stopCurrent(done = false) {
    this.isRunning = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;

    const viz = this.root.querySelector('#viz') as HTMLElement;
    viz?.classList.remove('l', 'r');

    const tx = this.root.querySelector('#tx') as HTMLButtonElement;
    const rx = this.root.querySelector('#rx') as HTMLButtonElement;
    const wav = this.root.querySelector('#wav') as HTMLButtonElement;
    if (tx) {
      tx.textContent = 'Transmit';
      tx.classList.remove('sec');
    }
    if (rx) {
      rx.textContent = 'Start listening';
      rx.classList.remove('sec');
    }
    if (wav) {
      wav.classList.add('sec');
    }

    if (!done) {
      const bar = this.root.querySelector('#bar') as HTMLElement;
      if (bar) bar.style.width = '0';
      this.say('idle', IDLE[this.panel][0], IDLE[this.panel][1]);
    }

    if (this.transmitter.state !== 'idle') this.transmitter.stop();
    if (this.receiver.state !== 'idle') this.receiver.stop();

    this.validate();
  }
}
