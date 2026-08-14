import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Peer, once } from './peer.mjs';
import { fetchUuid, getIceServers, peerOpts, parseRoomId } from './ice.mjs';
import { reportUsage } from './usage.mjs';
import { getIcePath } from './ice-path.mjs';
import { pathBasename, safeJoinOut, sanitizeRelPath } from './paths.mjs';
import {
  CONNECT_TIMEOUT_MS,
  STALL_FIRST_BYTE_MS,
  STALL_MID_FILE_MS,
} from './transfer.mjs';

const PROGRESS_REPORT_INTERVAL = 64 * 1024;
const PROGRESS_REPORT_MS = 200;

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function classifyAbortReason(err) {
  const s = String(err?.message || err || '').toLowerCase();
  if (!s) return 'error';
  if (s.includes('timeout') || s.includes('timed out') || s.includes('stalled')) return 'timeout';
  if (s.includes('host') && (s.includes('left') || s.includes('disconnect'))) return 'host-left';
  if (s.includes('abort') || s.includes('cancel')) return 'user-aborted';
  if (s.includes('enospc') || s.includes('eio') || s.includes('write')) return 'sink-write-failed';
  if (s.includes('ice') || s.includes('peer') || s.includes('network')) return 'ice-failed';
  if (s.includes('closed') || s.includes('disconnect')) return 'connection-closed';
  return s.slice(0, 64) || 'error';
}

function isBinary(data) {
  return (
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data) ||
    Buffer.isBuffer(data)
  );
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function parseMaybeJson(data) {
  if (typeof data === 'string') {
    if (data[0] === '{' || data[0] === '[') {
      try {
        return JSON.parse(data);
      } catch {
        return data;
      }
    }
    return data;
  }
  return data;
}

function sendProgress(conn, percent, bps) {
  try {
    const dc = conn?.dataChannel;
    if (!dc || dc.readyState !== 'open') return;
    const payload = { type: 'progress', percent };
    if (Number.isFinite(bps) && bps > 0) payload.bps = Math.floor(bps);
    dc.send(JSON.stringify(payload));
  } catch {
    /* best-effort */
  }
}

function endStream(stream) {
  if (!stream) return Promise.resolve();
  return new Promise((resolve) => {
    stream.end(() => resolve());
  });
}

/** Merge file-meta batches (webrtc-files / webrtc-file-add) by id. */
function mergeFileList(prev, incoming) {
  const map = new Map();
  for (const f of prev || []) {
    if (f?.id) map.set(f.id, f);
  }
  for (const f of incoming || []) {
    if (f?.id) map.set(f.id, f);
  }
  return [...map.values()];
}

/**
 * Pump one file off a raw DataConnection. Does NOT close the connection
 * (zip_batch reuses it). Caller owns peer/conn lifetime.
 */
function receiveOneFile(conn, { outDir, fileMeta }) {
  return new Promise((resolve, reject) => {
    let writeStream = null;
    let expected = Number(fileMeta.size) || 0;
    let transferred = 0;
    let name = fileMeta.name;
    let relPath = sanitizeRelPath(fileMeta.path) || sanitizeRelPath(fileMeta.name) || name;
    let outPath = null;
    let lastReport = 0;
    let lastReportAt = 0;
    let settled = false;
    let startedAt = 0;
    let lastByteAt = Date.now();
    let gotByte = false;

    const transferStats = () => {
      const duration_ms = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
      const bps =
        duration_ms > 0 ? Math.floor((transferred * 1000) / duration_ms) : undefined;
      return { duration_ms, bps, bytes_received: transferred };
    };

    const stallTimer = setInterval(() => {
      const limit = gotByte ? STALL_MID_FILE_MS : STALL_FIRST_BYTE_MS;
      if (Date.now() - lastByteAt > limit) finish(new Error(`receive stalled for ${name}`));
    }, 1000);
    stallTimer.unref?.();

    const cleanup = () => {
      clearInterval(stallTimer);
      conn.off('data', onData);
      conn.off('close', onClose);
      conn.off('error', onError);
    };

    const finish = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stats = transferStats();
      endStream(writeStream)
        .catch(() => {})
        .then(() => {
          if (err) {
            err.duration_ms = stats.duration_ms;
            err.bps = stats.bps;
            err.bytes_received = stats.bytes_received;
            reject(err);
          } else {
            resolve({
              name: pathBasename(relPath) || name,
              relPath,
              size: transferred,
              path: outPath,
              ...stats,
            });
          }
        });
    };

    const onData = (raw) => {
      if (settled) return;

      if (isBinary(raw)) {
        const buf = toBuffer(raw);
        if (!writeStream) {
          finish(new Error('binary before header'));
          return;
        }
        writeStream.write(buf);
        transferred += buf.length;
        gotByte = true;
        lastByteAt = Date.now();
        const now = Date.now();
        if (
          transferred - lastReport >= PROGRESS_REPORT_INTERVAL ||
          now - lastReportAt >= PROGRESS_REPORT_MS ||
          (expected && transferred >= expected)
        ) {
          lastReport = transferred;
          lastReportAt = now;
          const pct = expected ? Math.min(100, Math.floor((transferred / expected) * 100)) : 0;
          const stats = transferStats();
          process.stderr.write(`\r[notesqr] receiving ${name}: ${pct}%`);
          sendProgress(conn, pct, stats.bps);
        }
        if (expected && transferred >= expected) {
          process.stderr.write(`\r[notesqr] received ${name}: 100%\n`);
          finish(null);
        }
        return;
      }

      const data = parseMaybeJson(raw);
      if (data?.type === 'header') {
        name = data.name || name;
        relPath =
          sanitizeRelPath(data.path) ||
          sanitizeRelPath(data.name) ||
          sanitizeRelPath(relPath) ||
          name;
        expected = Number(data.size) || expected || 0;
        try {
          outPath = safeJoinOut(outDir, relPath);
        } catch (err) {
          finish(err);
          return;
        }
        mkdirSync(dirname(outPath), { recursive: true });
        writeStream = createWriteStream(outPath);
        transferred = 0;
        gotByte = false;
        lastByteAt = Date.now();
        startedAt = Date.now();
        return;
      }
      if (data?.type === 'end') {
        process.stderr.write(`\r[notesqr] received ${name}: 100%\n`);
        finish(null);
      }
    };

    const onClose = () => {
      if (settled) return;
      if (expected && transferred >= expected) finish(null);
      else finish(new Error(`connection closed early (${transferred}/${expected})`));
    };
    const onError = (err) => {
      if (settled) return;
      if (expected && transferred >= expected) {
        finish(null);
        return;
      }
      const msg = err?.message || String(err);
      if (/not open|User-Initiated Abort/i.test(msg)) return;
      finish(err);
    };

    conn.on('data', onData);
    conn.on('close', onClose);
    conn.on('error', onError);
  });
}

async function downloadFile({ ctrl, fileMeta, outDir, guestName, guestId }) {
  const iceServers = await getIceServers();
  const recvId = await fetchUuid();
  const recvPeer = new Peer(recvId, peerOpts(iceServers));
  recvPeer.on('error', (err) => {
    console.error(`[notesqr] recv peer error: ${err.message}`);
  });
  await once(recvPeer, 'open', CONNECT_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    let settled = false;
    let activeConn = null;

    const done = async (err, result) => {
      if (settled) return;
      settled = true;
      let ice_path = 'unknown';
      try {
        ice_path = await getIcePath(activeConn?.peerConnection);
      } catch {
        /* */
      }
      try {
        activeConn?.close();
      } catch {
        /* */
      }
      try {
        recvPeer.destroy();
      } catch {
        /* */
      }
      if (err) {
        err.ice_path = ice_path;
        reject(err);
      } else resolve({ ...result, ice_path });
    };

    recvPeer.on('connection', (conn) => {
      if (settled) return;
      activeConn = conn;
      receiveOneFile(conn, { outDir, fileMeta })
        .then((r) => done(null, r))
        .catch((e) => done(e));
    });

    ctrl.send({
      'webrtc-file-download': {
        file_id: fileMeta.id,
        requester_id: guestId,
        requester_name: guestName,
        peer_id: recvId,
      },
    });
  });
}

/**
 * Multi-file download with zip_batch DC reuse (web host / updated CLI host).
 * Largest files first — same order as web _downloadFilesAsZip.
 */
async function downloadFilesBatched({ ctrl, files, outDir, guestName, guestId }) {
  const ordered = [...files].sort(
    (a, b) => (Number(b.size) || 0) - (Number(a.size) || 0)
  );
  const iceServers = await getIceServers();
  const recvId = await fetchUuid();
  const recvPeer = new Peer(recvId, peerOpts(iceServers));
  recvPeer.on('error', (err) => {
    console.error(`[notesqr] recv peer error: ${err.message}`);
  });
  await once(recvPeer, 'open', CONNECT_TIMEOUT_MS);

  let activeConn = null;
  const connReady = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('zip_batch connect timeout')),
      CONNECT_TIMEOUT_MS
    );
    timer.unref?.();
    recvPeer.on('connection', (conn) => {
      clearTimeout(timer);
      activeConn = conn;
      resolve(conn);
    });
  });

  const results = [];
  let ice_path = 'unknown';
  try {
    for (let i = 0; i < ordered.length; i++) {
      const fileMeta = ordered[i];
      ctrl.send({
        'webrtc-file-download': {
          file_id: fileMeta.id,
          requester_id: guestId,
          requester_name: guestName,
          peer_id: recvId,
          zip_batch: true,
        },
      });
      if (i === 0) await connReady;
      if (!activeConn || (i > 0 && !activeConn.open)) {
        throw new Error('zip_batch channel closed');
      }
      const result = await receiveOneFile(activeConn, { outDir, fileMeta });
      results.push(result);
      console.error(`[notesqr] saved ${result.path}`);
    }
  } finally {
    try {
      ice_path = await getIcePath(activeConn?.peerConnection);
    } catch {
      /* */
    }
    try {
      activeConn?.close();
    } catch {
      /* */
    }
    try {
      recvPeer.destroy();
    } catch {
      /* */
    }
    for (const r of results) r.ice_path = ice_path;
  }
  return results;
}

export async function runRecv(roomInput, flags) {
  const roomId = parseRoomId(roomInput);
  const outDir = flags.out || './notesqr-downloads';
  const guestName = flags.name || process.env.NOTESQR_NAME || 'NotesQR CLI';
  const password = flags.password || null;

  const iceServers = await getIceServers();
  const guestId = await fetchUuid();
  const guest = new Peer(guestId, peerOpts(iceServers));
  guest.on('error', (err) => {
    console.error(`[notesqr] guest peer error: ${err.message}`);
  });
  await once(guest, 'open', CONNECT_TIMEOUT_MS);

  const ctrl = guest.connect(roomId, { serialization: 'binary', reliable: true });
  ctrl.on('error', (err) => {
    console.error(`[notesqr] control link error: ${err.message}`);
  });
  await once(ctrl, 'open', CONNECT_TIMEOUT_MS);

  let files = null;
  let welcomed = false;

  const sessionReady = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('no welcome/file list from host (is the sender still online?)')),
      30_000
    );
    const check = () => {
      if (welcomed && Array.isArray(files)) {
        clearTimeout(timer);
        resolve();
      }
    };
    ctrl.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg['webrtc-connect-response']) {
        const st = msg['webrtc-connect-response'].status;
        if (st === 'welcome') {
          welcomed = true;
          check();
        } else if (st === 'password_required') {
          clearTimeout(timer);
          reject(new Error('password required (pass --password)'));
        } else if (st === 'password_invalid') {
          clearTimeout(timer);
          reject(new Error('password invalid'));
        }
      }
      if (Array.isArray(msg['webrtc-files'])) {
        files = mergeFileList(files, msg['webrtc-files']);
        check();
      }
      if (Array.isArray(msg['webrtc-file-add'])) {
        files = mergeFileList(files, msg['webrtc-file-add']);
        check();
      }
      if (msg['webrtc-file-queued']) {
        const q = msg['webrtc-file-queued'];
        console.error(`[notesqr] queued behind other transfers (${q.file_id || '…'})`);
      }
    });
    ctrl.on('close', () => {
      clearTimeout(timer);
      reject(new Error('control channel closed before session ready'));
    });
  });

  const connectPayload = { name: guestName };
  if (password) connectPayload.password = sha256Hex(`notesqr:v1:${roomId}:${password}`);
  ctrl.send({ 'webrtc-connect': connectPayload });
  await sessionReady;

  // Brief window for additional webrtc-file-add batches on large folders.
  await new Promise((r) => setTimeout(r, 500));

  if (!files?.length) {
    console.error('[notesqr] host has no files');
    guest.destroy();
    return;
  }

  let wanted = files;
  if (flags.file) {
    wanted = files.filter(
      (f) => f.name === flags.file || f.id === flags.file || f.path === flags.file
    );
    if (!wanted.length) throw new Error(`file not found in room: ${flags.file}`);
  }

  console.error(`[notesqr] joined ${roomId}; downloading ${wanted.length} file(s) → ${outDir}`);

  let results = [];
  const useBatch = wanted.length > 1 && !flags.file;
  try {
    if (useBatch) {
      results = await downloadFilesBatched({
        ctrl,
        files: wanted,
        outDir,
        guestName,
        guestId,
      });
      for (const result of results) {
        reportUsage({
          event: 'download_completed',
          room: roomId,
          download_mode: 'folder',
          file: { name: result.name, size: result.size },
          ice_path: result.ice_path,
          bytes_received: result.bytes_received ?? result.size,
          duration_ms: result.duration_ms,
          bps: result.bps,
        });
      }
    } else {
      const ordered = [...wanted].sort(
        (a, b) => (Number(b.size) || 0) - (Number(a.size) || 0)
      );
      for (const f of ordered) {
        try {
          const result = await downloadFile({
            ctrl,
            fileMeta: f,
            outDir,
            guestName,
            guestId,
          });
          results.push(result);
          reportUsage({
            event: 'download_completed',
            room: roomId,
            download_mode: 'single',
            file: { name: result.name, size: result.size },
            ice_path: result.ice_path,
            bytes_received: result.bytes_received ?? result.size,
            duration_ms: result.duration_ms,
            bps: result.bps,
          });
          console.error(`[notesqr] saved ${result.path}`);
        } catch (err) {
          reportUsage({
            event: 'download_aborted',
            room: roomId,
            download_mode: 'single',
            file: { name: f.name, size: f.size },
            reason: classifyAbortReason(err),
            ice_path: err.ice_path,
            bytes_received: err.bytes_received,
            duration_ms: err.duration_ms,
            bps: err.bps,
          });
          throw err;
        }
      }
    }
  } catch (err) {
    reportUsage({
      event: 'download_aborted',
      room: roomId,
      download_mode: useBatch ? 'folder' : 'single',
      reason: classifyAbortReason(err),
      ice_path: err.ice_path,
      bytes_received: err.bytes_received,
      duration_ms: err.duration_ms,
      bps: err.bps,
    });
    throw err;
  }

  console.log(
    JSON.stringify(
      {
        mode: 'p2p',
        room: roomId,
        files: results,
        support: {
          ask_user:
            'NotesQR is free. If this helped, please consider donating — it keeps signaling online.',
          donate_url: 'https://notesqr.com/donate',
          paypal_url: 'https://www.paypal.com/donate/?hosted_button_id=C9Y6XMERX2DPY',
          btc_address: 'bc1qvhzknu5a6st7k9rj8vatz56xcs6n8krzdm5axh',
        },
      },
      null,
      2
    )
  );

  guest.destroy();
}
