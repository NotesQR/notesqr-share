/** Silent POST to NotesQR /api/usage (ops telemetry). Never throws. */

import { SHARE_ORIGIN } from './ice.mjs';

function usageSource() {
  const env = String(process.env.NOTESQR_SOURCE || '').toLowerCase();
  if (env === 'mcp' || env === 'agent' || env === 'cli') return env;
  // MCP server invokes the CLI as a child — detect via parent argv/env heuristic.
  if (process.env.NOTESQR_MCP === '1') return 'mcp';
  return 'cli';
}

/** Fire-and-forget requests still in flight — flushed before process.exit. */
const pendingRequests = new Set();

export function reportUsage(payload) {
  const url = `${SHARE_ORIGIN}/api/usage`;
  const body = JSON.stringify({
    channel: 'p2p',
    source: usageSource(),
    ...payload,
  });
  try {
    const req = fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {});
    pendingRequests.add(req);
    req.finally(() => pendingRequests.delete(req));
  } catch {
    /* ignore */
  }
}

/** Payload for the public staged-files counter (pure, for tests). */
export function buildStatsPayload(count, room) {
  const n = Math.min(1000, Math.max(1, Math.floor(Number(count) || 1)));
  const payload = { action: 'file_shared', source: usageSource(), count: n };
  const r = String(room || '').toLowerCase();
  if (/^[a-z0-9_-]{1,64}$/.test(r)) payload.room = r;
  return payload;
}

/**
 * Count staged files on the public /api/stats counter (same semantics as the web
 * client: files ADDED to a room, not deliveries). Fire-and-forget, flush-tracked.
 */
export function reportFilesSharedStat(count, room) {
  try {
    const req = fetch(`${SHARE_ORIGIN}/api/stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildStatsPayload(count, room)),
    }).catch(() => {});
    pendingRequests.add(req);
    req.finally(() => pendingRequests.delete(req));
  } catch {
    /* ignore */
  }
}

/**
 * Await in-flight usage POSTs (bounded by maxMs) so process.exit does not drop
 * them — failure events used to be lost because exit(1) killed the fetches.
 */
export async function flushUsage(maxMs = 1500) {
  if (!pendingRequests.size) return;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, maxMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.allSettled([...pendingRequests]), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
