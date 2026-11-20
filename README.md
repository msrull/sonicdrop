# 🔊 SonicDrop

> **Transmit data through sound. No Wi-Fi. No Bluetooth. No pairing. Just air.**

SonicDrop is an air-gapped acoustic data transfer utility that converts text, passwords, API keys, or seed phrases into near-ultrasonic sound waves (18 kHz – 20 kHz). The transmitting device plays the signal through its speaker, while the receiving device's microphone catches, decodes, and copies the secret directly into the clipboard — completely offline and network-free.

---

## ⚡ 15-Second Quickstart

```bash
# Clone and run locally
git clone https://github.com/msrull/sonicdrop.git
cd sonicdrop
npm install
npm run dev
```

Open `http://localhost:3000` on two devices (or two browser tabs):
1. On **Device A**, enter your secret text and press **Broadcast through Audio**.
2. On **Device B**, select **Receive Data** and press **Start Listening**.
3. Watch the real-time spectrogram catch the signal through the air!

---

## 🏗️ How It Works (Pipeline)

```
[Plaintext Secret]
   │
   ├─► 1. Optional Compression (Deflate-raw) + Optional Encryption (AES-256-GCM via PIN)
   │
   ├─► 2. Packet Framing (Preamble Sync + Length Header + Payload + CRC-32)
   │
   ├─► 3. Forward Error Correction (Reed-Solomon ECC over GF(2^8) — heals up to 8 corrupted bytes)
   │
   ├─► 4. 8-Tone FSK Modulator (3 bits/symbol, 18.0 - 19.75 kHz or 2.0 - 5.5 kHz)
   │
   ├─► 5. Web Audio API (AudioBufferSourceNode ──► Speaker Output)
   │
   ═══════════ Acoustic Channel / Air (10 cm – 2 meters) ═══════════
   │
   ├─► 6. Web Audio API (getUserMedia ──► Biquad Bandpass Filter)
   │
   ├─► 7. AudioWorklet Real-time Goertzel Detector (Detects chirp sync & tone transitions)
   │
   ├─► 8. Reed-Solomon Decoder (Berlekamp-Massey + Chien Search + Forney) + CRC-32 Validation
   │
   └─► 9. Decryption / Decompression ──► Auto-Copy to Receiver's Clipboard
```

---

## 🎛️ Dual Transmission Profiles

| Mode | Frequency Band | Audible to Humans? | Best For |
|---|---|---|---|
| **Stealth Mode** | 18,000 – 19,750 Hz | 🔇 No (Near-ultrasonic) | Quiet environments, stealth air-gapped transfers |
| **Audible Mode** | 2,000 – 5,500 Hz | 🔊 Yes (Retro modem chirp) | Low-cost speakers, noisy rooms, high reliability |

---

## 🛡️ Key Technical Mitigations

1. **Browser AGC & Filters Bypassed**: Microphones aggressively cut ultrasonic frequencies if noise suppression is on. SonicDrop explicitly requests:
   ```javascript
   {
     echoCancellation: false,
     noiseSuppression: false,
     autoGainControl: false
   }
   ```
2. **Room Reverberation & Echo**: Guard intervals (128 samples silence) between symbol bursts + Reed-Solomon (16 parity bytes) recover lost bits caused by room bounce.
3. **Eavesdropping Protection**: Optional 4-digit PIN derives an AES-256-GCM encryption key using PBKDF2 (100,000 rounds). Even if someone records the audio, they cannot read the secret.

---

## 🚀 Development & Build

```bash
# Development server with Hot Module Replacement
npm run dev

# Typecheck and production bundle (outputs to /dist)
npm run build

# Preview production build locally
npm run preview
```

---

## 🤝 Contributing & Good First Issues

We welcome contributions! Check out our issues or pick one of these starter tasks:
- [ ] **#1: Dynamic Bitrate Selector**: Allow users to toggle between 150 bps (noisy) and 300 bps (close range).
- [ ] **#2: Sound Waveform WAV Exporter**: Add a button to download the synthesized audio as an offline `.wav` file.
- [ ] **#3: QR Code Fallback View**: Optional visual fallback when acoustic conditions are too noisy.

---

## 📄 License

MIT License. Free for personal and commercial open-source use.
