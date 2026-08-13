import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Peer, once } from './peer.mjs';
import { fetchUuid, getIceServers, peerOpts, parseRoomId } from './ice.mjs';
import { reportUsage } from './usage.mjs';
import { getIcePath } from './ice-path.mjs';
import { pathBasename, safeJoinOut, sanitizeRelPath } from './paths.mjs';

const PROGRESS_REPORT_INTERVAL = 256 * 1024;
const RECV_TIMEOUT_MS = 120_000;

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function classifyAbortReason(err) {
  const s = String(err?.message || err || '').toLowerCase();
  if (!s) return 'error';
  if (s.includes('timeout') || s.includes('timed out')) return 'timeout';
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

function sendProgress(conn, percent) {
  try {
    const dc = conn?.dataChannel;
    if (!dc || dc.readyState !== 'open') return;
    // Raw DC: send string directly to avoid DataConnection 'error' spam if closing.
    dc.send(JSON.stringify({ type: 'progress', percent }));
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

async function downloadFile({ ctrl, fileMeta, outDir, guestName, guestId }) {
  const iceServers = await getIceServers();
  const recvId = await fetchUuid();
  const recvPeer = new Peer(recvId, peerOpts(iceServers));
  await once(recvPeer, 'open');

  return new Promise((resolve, reject) => {
    let writeStream = null;
    let expected = 0;
    let transferred = 0;
    let name = fileMeta.name;
    let relPath = sanitizeRelPath(fileMeta.path) || sanitizeRelPath(fileMeta.name) || name;
    let outPath = null;
    let lastReport = 0;
    let settled = false;
    let activeConn = null;
    let timer = null;
    let startedAt = 0; // set on header — throughput excludes ICE/handshake

    const transferStats = () => {
      const duration_ms = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
      const bps =
        duration_ms > 0 ? Math.floor((transferred * 1000) / duration_ms) : undefined;
      return { duration_ms, bps, bytes_received: transferred };
    };

    const finish = async (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);

      let ice_path = 'unknown';
      try {
        ice_path = await getIcePath(activeConn?.peerConnection);
      } catch {
        /* */
      }

      const stats = transferStats();
      endStream(writeStream)
        .catch(() => {})
        .then(() => {
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
            err.duration_ms = stats.duration_ms;
            err.bps = stats.bps;
            err.bytes_received = stats.bytes_received;
            reject(err);
          } else
            resolve({
              name: pathBasename(relPath) || name,
              relPath,
              size: transferred,
              path: outPath,
              ice_path,
              ...stats,
            });
        });
    };

    timer = setTimeout(() => finish(new Error(`receive timeout for ${name}`)), RECV_TIMEOUT_MS);
    timer.unref?.();

    recvPeer.on('connection', (conn) => {
      activeConn = conn;
      conn.on('data', (raw) => {
        if (settled) return;

        if (isBinary(raw)) {
          const buf = toBuffer(raw);
          if (!writeStream) {
            finish(new Error('binary before header'));
            return;
          }
          writeStream.write(buf);
          transferred += buf.length;
          if (
            transferred - lastReport >= PROGRESS_REPORT_INTERVAL ||
            (expected && transferred >= expected)
          ) {
            lastReport = transferred;
            const pct = expected ? Math.min(100, Math.floor((transferred / expected) * 100)) : 0;
            process.stderr.write(`\r[notesqr] receiving ${name}: ${pct}%`);
            sendProgress(conn, pct);
          }
          // All bytes in — succeed even if 'end' is late / channel already closing.
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
          expected = Number(data.size) || 0;
          try {
            outPath = safeJoinOut(outDir, relPath);
          } catch (err) {
            finish(err);
            return;
          }
          mkdirSync(dirname(outPath), { recursive: true });
          writeStream = createWriteStream(outPath);
          transferred = 0;
          startedAt = Date.now();
          return;
        }
        if (data?.type === 'end') {
          process.stderr.write(`\r[notesqr] received ${name}: 100%\n`);
          finish(null);
        }
      });
      conn.on('close', () => {
        if (settled) return;
        if (expected && transferred >= expected) finish(null);
        else finish(new Error(`connection closed early (${transferred}/${expected})`));
      });
      // Ignore teardown noise (progress/close races). Only fail if we lack bytes.
      conn.on('error', (err) => {
        if (settled) return;
        if (expected && transferred >= expected) {
          finish(null);
          return;
        }
        const msg = err?.message || String(err);
        if (/not open|User-Initiated Abort/i.test(msg)) return;
        finish(err);
      });
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

export async function runRecv(roomInput, flags) {
  const roomId = parseRoomId(roomInput);
  const outDir = flags.out || './notesqr-downloads';
  const guestName = flags.name || process.env.NOTESQR_NAME || 'NotesQR CLI';
  const password = flags.password || null;

  const iceServers = await getIceServers();
  const guestId = await fetchUuid();
  const guest = new Peer(guestId, peerOpts(iceServers));
  await once(guest, 'open');

  const ctrl = guest.connect(roomId, { serialization: 'binary', reliable: true });
  await once(ctrl, 'open');

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
        files = msg['webrtc-files'];
        check();
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

  if (!files.length) {
    console.error('[notesqr] host has no files');
    guest.destroy();
    return;
  }

  let wanted = files;
  if (flags.file) {
    wanted = files.filter((f) => f.name === flags.file || f.id === flags.file);
    if (!wanted.length) throw new Error(`file not found in room: ${flags.file}`);
  }

  console.error(`[notesqr] joined ${roomId}; downloading ${wanted.length} file(s) → ${outDir}`);

  const results = [];
  for (const f of wanted) {
    try {
      const result = await downloadFile({
        ctrl,
        fileMeta: f,
        outDir,
        guestName,
        guestId,
      });
      results.push(result);
      // One line per file download (completed/aborted only — no started noise).
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
