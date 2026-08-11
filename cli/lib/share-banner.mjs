/**
 * Human-facing share URL + optional terminal QR (stderr).
 * Skips QR when not a TTY, NOTESQR_MCP=1, or flags.noQr / --no-qr.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const qrcode = require('qrcode-terminal');

/** OSC 8 hyperlink when stderr is a TTY (iTerm, Windows Terminal, VTE, etc.). */
export function hyperlink(url, label = url) {
  if (!process.stderr.isTTY) return label;
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
}

export function printShareBanner(url, flags = {}) {
  const skipQr =
    flags.noQr ||
    flags['no-qr'] ||
    process.env.NOTESQR_MCP === '1' ||
    process.env.NOTESQR_NO_QR === '1' ||
    !process.stderr.isTTY;

  console.error('');
  console.error(`[notesqr] share link: ${hyperlink(url)}`);
  console.error('[notesqr] open on phone / another PC, or: notesqr recv <url> -o ./out');

  if (skipQr) {
    console.error('');
    return;
  }

  console.error('[notesqr] scan QR with your phone:');
  console.error('');
  qrcode.generate(url, { small: true }, (out) => {
    for (const line of String(out).split('\n')) {
      if (line.length) console.error(line);
    }
  });
  console.error('');
}
