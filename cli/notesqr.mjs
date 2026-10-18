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
import { flushUsage } from './lib/usage.mjs';
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
    if (a === '--') {
      // End of options: everything after is positional (paths / room may start with "-").
      positional.push(...argv.slice(i + 1));
      break;
    }
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
    else if (a.startsWith('-') && a !== '-') {
      // Typos like --pasword used to be swallowed silently (and their values
      // treated as files). Fail fast instead.
      console.error(`Unknown option: ${a} (see --help)`);
      process.exit(2);
    } else positional.push(a);
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

Recv options:
  -o, --out <dir>   Output directory (default: ./notesqr-downloads)
  --file <name>     Download a single file (by name, id or path)
  --password x      Room password

Common env:
  NOTESQR_NAME      Display name for send/recv (same as --name)

Premium (buy on the web only — CLI only imports a license you already have):
  https://notesqr.com/premium
  notesqr license import <license.nql>
  Later "send" uses your Premium room by default.
  Config: ${licensePath()}
  Env: NOTESQR_ROOM, NOTESQR_LICENSE_FILE, NOTESQR_CONFIG_DIR, NOTESQR_USE_RANDOM_ROOM=1
  NOTESQR_PASSWORD  Room password (keeps it out of the process list; same as --password)
  Use "--" to end options, e.g. notesqr send -- -weird-name.txt
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
    const store = await importNqlFile(file).catch((err) => {
      if (err?.code === 'ENOENT') {
        throw new Error(`license file not found: ${file} (check the path to your .nql file)`);
      }
      throw err;
    });
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
  // Prefer NOTESQR_PASSWORD over --password so the secret stays out of argv / ps.
  if (flags.password == null && process.env.NOTESQR_PASSWORD) {
    flags.password = process.env.NOTESQR_PASSWORD;
  }
  if (flags.help || positional.length === 0) {
    usage();
    await flushUsage();
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
    // @roamhq/wrtc / ws can leave live handles after a multi-file recv — exit
    // explicitly (the host already does) so the process never hangs forever.
    await flushUsage();
    process.exit(0);
  }

  if (cmd === 'license') {
    await runLicense(rest[0], rest.slice(1));
    return;
  }

  if (cmd === 'put' || cmd === 'get') {
    console.error(`[notesqr] "${cmd}" is removed. Use "send" / "recv" (WebRTC P2P).`);
    await flushUsage();
    process.exit(1);
  }

  usage();
  await flushUsage();
  process.exit(1);
}

main().catch(async (err) => {
  console.error('[notesqr]', err.message || err);
  // Keep failure telemetry: exit(1) used to kill in-flight usage POSTs.
  await flushUsage();
  process.exit(1);
});
