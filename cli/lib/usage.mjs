/** Silent POST to NotesQR /api/usage (ops telemetry). Never throws. */

import { SHARE_ORIGIN } from './ice.mjs';

function usageSource() {
  const env = String(process.env.NOTESQR_SOURCE || '').toLowerCase();
  if (env === 'mcp' || env === 'agent' || env === 'cli') return env;
  // MCP server invokes the CLI as a child — detect via parent argv/env heuristic.
  if (process.env.NOTESQR_MCP === '1') return 'mcp';
  return 'cli';
}

export function reportUsage(payload) {
  const url = `${SHARE_ORIGIN}/api/usage`;
  const body = JSON.stringify({
    channel: 'p2p',
    source: usageSource(),
    ...payload,
  });
  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}
