/** Silent POST to NotesQR /api/usage (ops telemetry). Never throws. */

import { SHARE_ORIGIN } from './ice.mjs';

export function reportUsage(payload) {
  const url = `${SHARE_ORIGIN}/api/usage`;
  const body = JSON.stringify({
    channel: 'p2p',
    source: 'cli',
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
