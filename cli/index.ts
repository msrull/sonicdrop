import * as fs from 'fs';
import * as path from 'path';
import { getDSPConfig, SAMPLE_RATE } from '../src/core/constants';
import { encodePacket } from '../src/core/framing';
import { generateAudioSamples } from '../src/core/fsk';
import { pcmToWavBlob } from '../src/core/wav';
import type { TransmissionMode } from '../src/types';

function printHelp() {
  console.log(`
SonicDrop CLI — Acoustic Data Transfer Utility

Usage:
  sonicdrop-cli send [text] [options]
  cat secret.txt | sonicdrop-cli send [options]

Commands:
  send [text]       Encode text into acoustic FSK sound wave (.wav)

Options:
  -m, --mode        Acoustic channel: 'stealth' (18-20 kHz) or 'audible' (2-5.5 kHz) [default: stealth]
  -o, --out         Output WAV audio file path [default: ./sonicdrop.wav]
  -h, --help        Show this help message

Examples:
  sonicdrop-cli send "sample_secret_token_9988" --mode stealth -o secret.wav
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
  let mode: TransmissionMode = 'stealth';
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
    } else if (arg === '-o' || arg === '--out') {
      outFile = args[++i];
    } else if (!arg.startsWith('-') && !text) {
      text = arg;
    }
  }

  if (!text) {
    if (!process.stdin.isTTY) {
      text = await readAllStdin();
    }
  }

  if (!text) {
    console.error('Error: No text provided. Pass text as argument or pipe via stdin.');
    process.exit(1);
  }

  console.log(`[SonicDrop] Encoding ${text.length} characters using ${mode.toUpperCase()} mode...`);

  const data = new TextEncoder().encode(text);
  const config = getDSPConfig(mode);
  const symbols = encodePacket(data, false, false, mode);
  const pcm = generateAudioSamples(symbols, config);

  const wavBlob = pcmToWavBlob(pcm, SAMPLE_RATE);
  const arrayBuffer = await wavBlob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const resolvedOut = path.resolve(process.cwd(), outFile);
  fs.writeFileSync(resolvedOut, buffer);

  const durationSec = (pcm.length / SAMPLE_RATE).toFixed(2);
  console.log(`Audio successfully synthesized:`);
  console.log(`  File:     ${resolvedOut}`);
  console.log(`  Duration: ${durationSec}s (${pcm.length} samples @ ${SAMPLE_RATE}Hz)`);
  console.log(`  Channel:  ${mode === 'stealth' ? '18 kHz - 19.75 kHz (Inaudible)' : '2 kHz - 5.5 kHz (Audible)'}`);
}

main().catch((err) => {
  console.error('[SonicDrop CLI Error]:', err.message);
  process.exit(1);
});
