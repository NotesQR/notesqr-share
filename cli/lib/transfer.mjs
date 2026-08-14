/**
 * Shared transfer knobs — keep in sync with
 * filesync-notesqr/web/js/modules/webrtc/file.js + user.js.
 */

export const CHUNK_HARD_MAX = 1024 * 1024;
export const CHUNK_FALLBACK = 16 * 1024;
export const CHUNK_STEPS = [1024, 512, 256, 128, 64, 32, 16].map((k) => k * 1024);
export const HIGH_WATER = 4 << 20; // 4 MiB
export const LOW_WATER = 1 << 20; // 1 MiB

export const OUTBOUND_CONCURRENCY_BASE = 5;
export const OUTBOUND_BYTES_FLOOR = 10 * 1024 * 1024; // 10 MiB
export const OUTBOUND_CONCURRENCY_HARD_MAX = 32;

/** Stay under typical Chrome SCTP maxMessageSize for JSON control frames. */
export const WIRE_JSON_BUDGET = 180 * 1024;

export const CONNECT_TIMEOUT_MS = 20_000;
/** No progress at all (waiting first byte). */
export const STALL_FIRST_BYTE_MS = 120_000;
/** No byte movement mid-file. */
export const STALL_MID_FILE_MS = 45_000;

export function advertisedMaxMessageSize(conn) {
  try {
    const m = conn?.peerConnection?.sctp?.maxMessageSize;
    if (Number.isFinite(m) && m > 0) return m;
  } catch {
    /* */
  }
  return 0;
}

export function initialChunkSize(conn) {
  const adv = advertisedMaxMessageSize(conn);
  const ceiling =
    adv > 0
      ? Math.min(CHUNK_HARD_MAX, Math.max(CHUNK_FALLBACK, adv - 32))
      : 256 * 1024;
  for (const step of CHUNK_STEPS) {
    if (step <= ceiling) return step;
  }
  return CHUNK_FALLBACK;
}

export function nextSmallerChunk(size) {
  for (const step of CHUNK_STEPS) {
    if (step < size) return step;
  }
  return 0;
}

export function isMessageTooLargeError(err) {
  const name = err && err.name;
  const msg = String(err?.message || err || '').toLowerCase();
  if (name === 'TypeError' || name === 'OperationError') return true;
  return (
    msg.includes('too large') ||
    msg.includes('message size') ||
    msg.includes('maxmessagesize') ||
    msg.includes('sctp')
  );
}

export function estimateWireItemBytes(item) {
  if (!item || typeof item !== 'object') return 64;
  const path = String(item.path || item.name || '');
  const name = String(item.name || '');
  const id = String(item.id || '');
  const owner = String(item.owner_id || '');
  const ownerName = String(item.owner_name || '');
  return 90 + (path.length + name.length + id.length + owner.length + ownerName.length) * 2 + 24;
}

/** Split file-meta arrays into SCTP-safe batches (no O(n²) stringify). */
export function chunkWireItems(items, budget = WIRE_JSON_BUDGET) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const batches = [];
  let cur = [];
  let curSize = 48;
  for (const item of list) {
    const itemSize = estimateWireItemBytes(item) + 1;
    if (cur.length && curSize + itemSize > budget) {
      batches.push(cur);
      cur = [item];
      curSize = 48 + itemSize;
    } else {
      cur.push(item);
      curSize += itemSize;
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}
