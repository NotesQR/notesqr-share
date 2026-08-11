#!/usr/bin/env node
/**
 * NotesQR CLI — WebRTC P2P (same handshake as notesqr.com web)
 *
 *   notesqr send <files...> [--password x] [--name alias] [--once]
 *   notesqr recv <room|url> [-o dir] [--password x] [--file name]
 *
 * Prefer: npx -y github:colocoquillo/notesqr-share send ./file.pdf --once
 */

import { runSend } from './lib/host.mjs';
import { runRecv } from './lib/guest.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--password') flags.password = argv[++i];
    else if (a === '--name') flags.name = argv[++i];
    else if (a === '--room') flags.room = argv[++i];
    else if (a === '--file') flags.file = argv[++i];
    else if (a === '-o' || a === '--out') flags.out = argv[++i];
    else if (a === '--once') flags.once = true;
    else if (a === '--no-qr') flags.noQr = true;
    else if (a === '--json') flags.json = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a.startsWith('-')) flags[a] = true;
    else positional.push(a);
  }
  return { positional, flags };
}

function usage() {
  console.log(`NotesQR CLI — WebRTC P2P file transfer

Install / run (no global install needed):
  npx -y github:colocoquillo/notesqr-share send ./file.pdf --once
  npx -y github:colocoquillo/notesqr-share recv <url> -o ./out

Usage:
  notesqr send <files...> [--password x] [--name alias] [--once] [--no-qr] [--json]
  notesqr recv <room|url> [-o dir] [--password x] [--file name]

Both peers must stay connected until the download finishes.
Share URL: https://notesqr.com/abc-defg-hij
On send (TTY): clickable link + QR. Use --json / NOTESQR_JSON=1 for machine output.
Skip QR with --no-qr / NOTESQR_NO_QR=1.

Requires Node.js 18+.
`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || positional.length === 0) {
    usage();
    process.exit(flags.help ? 0 : 1);
  }

  const [cmd, ...rest] = positional;

  if (cmd === 'send') {
    await runSend(rest, flags);
    return;
  }

  if (cmd === 'recv') {
    if (!rest[0]) throw new Error('recv requires room id or URL');
    await runRecv(rest[0], flags);
    return;
  }

  if (cmd === 'put' || cmd === 'get') {
    console.error(`[notesqr] "${cmd}" is removed. Use "send" / "recv" (WebRTC P2P).`);
    process.exit(1);
  }

  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error('[notesqr]', err.message || err);
  process.exit(1);
});
