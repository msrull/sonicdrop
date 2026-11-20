import * as fs from 'fs';
import * as path from 'path';
import { getDSPConfig, SAMPLE_RATE } from '../src/core/constants';
import { encodePacket, encodePacketBytes } from '../src/core/framing';
import { generateAudioSamples } from '../src/core/fsk';
import { pcmToWavBlob } from '../src/core/wav';
import { packFile } from '../src/core/file-pack';
import {
  encodeTurboBytes,
  getTurboFrequencies,
  TURBO_PREAMBLE_PATTERN,
} from '../src/core/turbo';
import type { TransmissionMode, SpeedProfile } from '../src/types';

function printHelp() {
  console.log(`
SonicDrop CLI — Acoustic Data Transfer Utility

Usage:
  sonicdrop-cli send [text] [options]
  sonicdrop-cli send -f <filepath> [options]
  cat secret.txt | sonicdrop-cli send [options]

Commands:
  send [text]       Encode text or file into acoustic FSK sound wave (.wav)

Options:
  -f, --file        Path to input file to transmit
  -m, --mode        Acoustic channel: 'stealth' (18-20 kHz) or 'audible' (2-5.5 kHz) [default: stealth]
  -s, --speed       Speed tier: 'standard' (225 bps) or 'turbo' (1200 bps) [default: standard]
  -o, --out         Output WAV audio file path [default: ./sonicdrop.wav]
  -h, --help        Show this help message

Examples:
  sonicdrop-cli send "sample_secret_token_9988" --mode stealth -o secret.wav
  sonicdrop-cli send -f key.pem --speed turbo --mode audible -o key.wav
  cat id_rsa.pub | sonicdrop-cli send --mode audible -o key.wav
  `);
}

async function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data.trim());
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const cmd = args[0];
  if (cmd !== 'send') {
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
  }

  let text = '';
  let filePath = '';
  let mode: TransmissionMode = 'stealth';
  let speed: SpeedProfile = 'standard';
  let outFile = 'sonicdrop.wav';

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-m' || arg === '--mode') {
      const val = args[++i];
      if (val === 'audible' || val === 'stealth') {
        mode = val;
      } else {
        console.error(`Invalid mode '${val}'. Use 'stealth' or 'audible'.`);
        process.exit(1);
      }
    } else if (arg === '-s' || arg === '--speed') {
      const val = args[++i];
      if (val === 'standard' || val === 'turbo') {
        speed = val;
      } else {
        console.error(`Invalid speed '${val}'. Use 'standard' or 'turbo'.`);
        process.exit(1);
      }
    } else if (arg === '-f' || arg === '--file') {
      filePath = args[++i];
    } else if (arg === '-o' || arg === '--out') {
      outFile = args[++i];
    } else if (!arg.startsWith('-') && !text) {
      text = arg;
    }
  }

  let payloadData: Uint8Array;
  let summaryLabel = '';

  if (filePath) {
    const resolvedIn = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolvedIn)) {
      console.error(`Error: File not found: ${resolvedIn}`);
      process.exit(1);
    }
    const rawFile = fs.readFileSync(resolvedIn);
    const fileName = path.basename(resolvedIn);
    payloadData = packFile(fileName, 'application/octet-stream', new Uint8Array(rawFile));
    summaryLabel = `file "${fileName}" (${rawFile.length} bytes)`;
  } else {
    if (!text && !process.stdin.isTTY) {
      text = await readAllStdin();
    }
    if (!text) {
      console.error('Error: No text or file provided. Pass text, -f <file>, or pipe via stdin.');
      process.exit(1);
    }
    payloadData = new TextEncoder().encode(text);
    summaryLabel = `${text.length} characters`;
  }

  console.log(`[SonicDrop] Encoding ${summaryLabel} via ${mode.toUpperCase()} (${speed.toUpperCase()} speed)...`);

  let pcm: Float32Array;

  if (speed === 'turbo') {
    const coded = encodePacketBytes(payloadData, false, false, mode, 'turbo');
    const turboPcm = encodeTurboBytes(coded, mode);

    const freqs = getTurboFrequencies(mode);
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

    pcm = new Float32Array(preamblePcm.length + turboPcm.length);
    pcm.set(preamblePcm);
    pcm.set(turboPcm, preamblePcm.length);
  } else {
    const config = getDSPConfig(mode);
    const symbols = encodePacket(payloadData, false, false, mode, 'standard');
    pcm = generateAudioSamples(symbols, config);
  }

  const wavBlob = pcmToWavBlob(pcm, SAMPLE_RATE);
  const arrayBuffer = await wavBlob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const resolvedOut = path.resolve(process.cwd(), outFile);
  fs.writeFileSync(resolvedOut, buffer);

  const durationSec = (pcm.length / SAMPLE_RATE).toFixed(2);
  console.log(`Audio successfully synthesized:`);
  console.log(`  File:     ${resolvedOut}`);
  console.log(`  Duration: ${durationSec}s (${pcm.length} samples @ ${SAMPLE_RATE}Hz)`);
  console.log(`  Speed:    ${speed === 'turbo' ? 'Turbo Multi-Carrier (1,200 bps)' : 'Standard (225 bps)'}`);
  console.log(`  Channel:  ${mode === 'stealth' ? '18 kHz - 20 kHz (Inaudible)' : '2 kHz - 5.5 kHz (Audible)'}`);
}

main().catch((err) => {
  console.error('[SonicDrop CLI Error]:', err.message);
  process.exit(1);
});
