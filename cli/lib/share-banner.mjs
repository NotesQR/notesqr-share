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

function qrLines(url) {
  let out = '';
  qrcode.generate(url, { small: true }, (s) => {
    out = String(s);
  });
  return out.split('\n').filter((l) => l.length);
}

/**
 * @param {string} url
 * @param {{ noQr?: boolean, files?: { name: string, size: number }[] }} flags
 */
export function printShareBanner(url, flags = {}) {
  const skipQr =
    flags.noQr ||
    flags['no-qr'] ||
    process.env.NOTESQR_MCP === '1' ||
    process.env.NOTESQR_NO_QR === '1' ||
    !process.stderr.isTTY;

  const files = Array.isArray(flags.files) ? flags.files : [];
  const fileBit =
    files.length === 1
      ? files[0].name
      : files.length > 1
        ? `${files.length} files`
        : null;

  console.error('');
  if (fileBit) console.error(`[notesqr] hosting ${fileBit}`);
  console.error(`[notesqr] ${hyperlink(url)}`);
  console.error('[notesqr] phone: scan QR · other PC: open link or notesqr recv');

  if (!skipQr) {
    console.error('');
    for (const line of qrLines(url)) console.error(line);
  }

  console.error('');
  console.error('[notesqr] waiting for peers… (Ctrl+C to stop)');
  console.error('');
}
