#!/usr/bin/env node
/**
 * NotesQR CLI — WebRTC P2P (same handshake as notesqr.com web)
 *
 *   notesqr send <files...> [--password x] [--name alias] [--room name] [--once]
 *   notesqr recv <room|url> [-o dir] [--password x] [--file name]
 *   notesqr license import <file.nql>
 *   notesqr license status
 *   notesqr license clear
 *
 * Prefer: npx -y github:NotesQR/notesqr-share send ./file.pdf --once
 */

import { runSend } from './lib/host.mjs';
import { runRecv } from './lib/guest.mjs';
import {
  clearLicenseStore,
  importNqlFile,
  licensePath,
  readLicenseStore,
  syncLicenseStore,
} from './lib/premium.mjs';

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
    else if (a === '--random-room') flags.useRandom = true;
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
  npx -y github:NotesQR/notesqr-share send ./file.pdf --once
  npx -y github:NotesQR/notesqr-share recv <url> -o ./out

Usage:
  notesqr send <files|folders...> [options]
  notesqr recv <room|url> [-o dir] [--password x] [--file name]
  notesqr license import <license.nql>
  notesqr license status
  notesqr license clear

Send options:
  --room <name>     Host this room (Premium custom name or random-style id)
  --random-room     Ignore imported Premium license; use a random room
  --password x      Protect the room
  --name alias      Display name
  --once            Exit after every file has been pulled once
  --no-qr / --json  Output control

Premium (buy on the web only — CLI only imports a license you already have):
  https://notesqr.com/premium
  notesqr license import <license.nql>
  Later "send" uses your Premium room by default.
  Config: ${licensePath()}
  Env: NOTESQR_ROOM, NOTESQR_LICENSE_FILE, NOTESQR_CONFIG_DIR, NOTESQR_USE_RANDOM_ROOM=1
  Guide: https://notesqr.com/premium/info

Both peers must stay connected until the download finishes.
Share URL: https://notesqr.com/<room>

Requires Node.js 18+.
`);
}

async function runLicense(sub, rest) {
  if (sub === 'import') {
    const file = rest[0];
    if (!file) throw new Error('usage: notesqr license import <file.nql>');
    const store = await importNqlFile(file);
    console.log(`[notesqr] license imported → ${licensePath()}`);
    console.log(
      `[notesqr] active room: ${store.activeRoom} (${store.rooms.length} room(s))`
    );
    return;
  }
  if (sub === 'status') {
    const store = await syncLicenseStore().catch(() => readLicenseStore());
    console.log(`[notesqr] config: ${licensePath()}`);
    if (!store.rooms.length) {
      console.log('[notesqr] no Premium license imported');
      return;
    }
    console.log(`[notesqr] active: ${store.activeRoom || '(none)'}`);
    console.log(`[notesqr] useRandomRoom: ${!!store.useRandomRoom}`);
    for (const r of store.rooms) {
      console.log(`  - ${r.room}`);
    }
    return;
  }
  if (sub === 'clear') {
    await clearLicenseStore();
    console.log('[notesqr] Premium license cleared');
    return;
  }
  throw new Error('usage: notesqr license import|status|clear');
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

  if (cmd === 'license') {
    await runLicense(rest[0], rest.slice(1));
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
