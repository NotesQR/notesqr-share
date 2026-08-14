import { createHash, randomUUID } from 'node:crypto';
import { Peer, once } from './peer.mjs';
import {
  SHARE_ORIGIN,
  fetchUuid,
  getIceServers,
  peerOpts,
  generateRoomId,
} from './ice.mjs';
import { reportUsage } from './usage.mjs';
import { printShareBanner } from './share-banner.mjs';
import { collectSendEntries } from './paths.mjs';
import {
  HIGH_WATER,
  LOW_WATER,
  OUTBOUND_BYTES_FLOOR,
  OUTBOUND_CONCURRENCY_BASE,
  OUTBOUND_CONCURRENCY_HARD_MAX,
  CONNECT_TIMEOUT_MS,
  chunkWireItems,
  initialChunkSize,
  nextSmallerChunk,
  isMessageTooLargeError,
} from './transfer.mjs';

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function awaitDrain(dc) {
  if (dc.bufferedAmount < HIGH_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanup = () => {
      dc.removeEventListener('bufferedamountlow', onResolve);
      dc.removeEventListener('close', onResolve);
      dc.removeEventListener('error', onResolve);
    };
    const onResolve = () => {
      cleanup();
      resolve();
    };
    dc.addEventListener('bufferedamountlow', onResolve);
    dc.addEventListener('close', onResolve);
    dc.addEventListener('error', onResolve);
    if (dc.bufferedAmount < HIGH_WATER || dc.readyState !== 'open') {
      cleanup();
      resolve();
    }
  });
}

/** Adaptive chunk ladder (same as web file.js) — probe SCTP, step down on too-large. */
async function streamFileRaw(conn, filePath, meta) {
  const { open } = await import('node:fs/promises');
  const dc = conn.dataChannel;
  if (!dc) throw new Error('no data channel');
  dc.bufferedAmountLowThreshold = LOW_WATER;

  let chunkSize = initialChunkSize(conn);

  dc.send(
    JSON.stringify({
      type: 'header',
      name: meta.name,
      path: meta.relPath || meta.name,
      size: meta.size,
      mime: 'application/octet-stream',
    })
  );

  const fh = await open(filePath, 'r');
  try {
    let offset = 0;
    while (offset < meta.size) {
      if (dc.readyState !== 'open') throw new Error('datachannel closed mid-transfer');
      const want = Math.min(chunkSize, meta.size - offset);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, offset);
      if (!bytesRead) break;

      let sent = false;
      while (!sent) {
        await awaitDrain(dc);
        try {
          dc.send(buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead));
          sent = true;
        } catch (err) {
          if (!isMessageTooLargeError(err)) throw err;
          const next = nextSmallerChunk(chunkSize);
          if (!next) throw err;
          console.error(`[notesqr] chunk ${chunkSize} too large; stepping down to ${next}`);
          chunkSize = next;
          // Re-read this offset with the smaller size on the next outer iteration.
          break;
        }
      }
      if (!sent) continue; // stepped down — retry same offset with smaller chunk

      offset += bytesRead;
      const pct = Math.floor((offset / meta.size) * 100);
      process.stderr.write(`\r[notesqr] sending ${meta.name}: ${pct}%`);
    }
    await awaitDrain(dc);
    dc.send(JSON.stringify({ type: 'end' }));
    process.stderr.write(`\r[notesqr] sent ${meta.name} (${meta.size} bytes)\n`);
  } finally {
    await fh.close();
  }
}

/**
 * Host a P2P room and offer local files. Blocks until SIGINT (or --once after all
 * listed files have been fully pulled by at least one peer each — default stays open).
 */
export async function runSend(filePaths, flags) {
  if (!filePaths.length) throw new Error('send requires at least one file or folder');

  const hostName = flags.name || process.env.NOTESQR_NAME || 'NotesQR CLI';
  const password = flags.password || null;
  const roomId = flags.room || generateRoomId();
  const passwordHashV1 = password ? sha256Hex(`notesqr:v1:${roomId}:${password}`) : null;
  const passwordHashLegacy = password ? sha256Hex(password) : null;

  const files = collectSendEntries(filePaths).map((ent) => ({
    id: randomUUID(),
    path: ent.abs, // local filesystem path for streaming
    relPath: ent.path, // relative path for peers / zip / recv tree
    name: ent.name,
    size: ent.size,
    owner_id: roomId,
    owner_name: hostName,
  }));

  const iceServers = await getIceServers();
  const host = new Peer(roomId, peerOpts(iceServers));
  await once(host, 'open', CONNECT_TIMEOUT_MS);

  const url = `${SHARE_ORIGIN}/${roomId}`;
  const payload = {
    mode: 'p2p',
    room: roomId,
    url,
    password_required: Boolean(password),
    files: files.map(({ id, name, size, relPath }) => ({
      id,
      name,
      size,
      path: relPath,
    })),
    note: 'Keep this process running. Receiver must open the URL (or notesqr recv) while online.',
    support: {
      ask_user:
        'NotesQR is free. If this helped, please consider donating — it keeps the relays and signaling online.',
      donate_url: `${SHARE_ORIGIN}/donate`,
      paypal_url: 'https://www.paypal.com/donate/?hosted_button_id=C9Y6XMERX2DPY',
      btc_address: 'bc1qvhzknu5a6st7k9rj8vatz56xcs6n8krzdm5axh',
    },
  };

  const wantJson =
    flags.json ||
    process.env.NOTESQR_MCP === '1' ||
    process.env.NOTESQR_JSON === '1' ||
    !process.stdout.isTTY;

  if (wantJson) {
    console.log(JSON.stringify(payload, null, 2));
  }

  printShareBanner(url, {
    ...flags,
    files: files.map(({ relPath, name, size }) => ({ name: relPath || name, size })),
  });

  reportUsage({
    event: 'share',
    room: roomId,
    count: files.length,
    bytes: files.reduce((s, f) => s + (Number(f.size) || 0), 0) || undefined,
    files: files.slice(0, 100).map(({ relPath, name, size }) => ({
      name: relPath || name,
      size,
    })),
  });

  const guests = new Map(); // controlPeerId -> { name, conn }
  const completed = new Set(); // fileId that finished at least once

  // Adaptive outbound fan-out (web parity).
  let outboundActive = 0;
  let outboundActiveBytes = 0;
  const outboundQueue = [];

  // zip_batch: one Peer+DC per remote zip peer_id (web folder downloads).
  const zipSendSessions = new Map(); // zipPeerId -> { peer, conn, chain }

  const canStartOutbound = (file) => {
    if (outboundActive >= OUTBOUND_CONCURRENCY_HARD_MAX) return false;
    if (outboundActive < OUTBOUND_CONCURRENCY_BASE) return true;
    return outboundActiveBytes < OUTBOUND_BYTES_FLOOR;
  };

  const notifyQueued = (req) => {
    const payload = { file_id: req.file_id, requester_id: req.requester_id };
    const g = guests.get(req.requester_id);
    if (g?.conn?.open) {
      try {
        g.conn.send({ 'webrtc-file-queued': payload });
      } catch {
        /* */
      }
    }
  };

  const destroyZipSession = (zipPeerId) => {
    const s = zipSendSessions.get(zipPeerId);
    if (!s) return;
    zipSendSessions.delete(zipPeerId);
    try {
      s.conn?.close();
    } catch {
      /* */
    }
    try {
      s.peer?.destroy();
    } catch {
      /* */
    }
  };

  const ensureZipSendSession = async (zipPeerId) => {
    const existing = zipSendSessions.get(zipPeerId);
    if (existing?.conn?.open) return existing;
    if (existing) destroyZipSession(zipPeerId);

    const sendId = await fetchUuid();
    const sendPeer = new Peer(sendId, peerOpts(await getIceServers()));
    sendPeer.on('error', (err) => {
      console.error(`[notesqr] zip-send peer error: ${err.message}`);
    });
    await once(sendPeer, 'open', CONNECT_TIMEOUT_MS);
    const raw = sendPeer.connect(zipPeerId, { serialization: 'raw', reliable: true });
    raw.on('error', (err) => {
      console.error(`[notesqr] zip-send link error: ${err.message}`);
    });
    await once(raw, 'open', CONNECT_TIMEOUT_MS);
    const session = { peer: sendPeer, conn: raw, chain: Promise.resolve() };
    raw.on('close', () => {
      if (zipSendSessions.get(zipPeerId) === session) destroyZipSession(zipPeerId);
    });
    zipSendSessions.set(zipPeerId, session);
    return session;
  };

  const sendRosterTo = (conn) => {
    if (!conn?.open) return;
    const peers = [{ id: roomId, name: hostName }];
    for (const [id, g] of guests) peers.push({ id, name: g.name });
    const fileMeta = files.map(({ id, name, size, owner_id, owner_name, relPath }) => ({
      id,
      name,
      path: relPath || name,
      size,
      owner_id,
      owner_name,
    }));
    try {
      conn.send({ 'webrtc-peers': peers });
    } catch {
      /* */
    }
    const batches = chunkWireItems(fileMeta);
    for (let i = 0; i < batches.length; i++) {
      try {
        if (i === 0) conn.send({ 'webrtc-files': batches[i] });
        else conn.send({ 'webrtc-file-add': batches[i] });
      } catch (err) {
        console.error(`[notesqr] roster batch failed: ${err.message}`);
        break;
      }
    }
  };

  const broadcastRoster = () => {
    for (const g of guests.values()) sendRosterTo(g.conn);
  };

  const maybeOnceExit = () => {
    if (flags.once && completed.size >= files.length && outboundActive === 0) {
      console.error('[notesqr] --once: all files transferred, exiting');
      for (const id of [...zipSendSessions.keys()]) destroyZipSession(id);
      host.destroy();
      process.exit(0);
    }
  };

  const runTransfer = async (req, file) => {
    const recvPeerId = req.peer_id;
    const zipBatch = !!req.zip_batch;
    console.error(
      `[notesqr] transfer start: ${file.name} → ${req.requester_name || req.requester_id}` +
        (zipBatch ? ' (zip_batch)' : '')
    );

    if (zipBatch) {
      const session = await ensureZipSendSession(recvPeerId);
      // Serialize entries on the shared DC (web multiplexes header/chunks/end).
      const run = session.chain.then(() => streamFileRaw(session.conn, file.path, file));
      session.chain = run.catch(() => {});
      await run;
      completed.add(file.id);
      return;
    }

    let sendPeer;
    let raw;
    try {
      const sendId = await fetchUuid();
      sendPeer = new Peer(sendId, peerOpts(await getIceServers()));
      sendPeer.on('error', (err) => {
        console.error(`[notesqr] transfer peer error: ${err.message}`);
      });
      await once(sendPeer, 'open', CONNECT_TIMEOUT_MS);
      raw = sendPeer.connect(recvPeerId, { serialization: 'raw', reliable: true });
      raw.on('error', (err) => {
        console.error(`[notesqr] transfer link error: ${err.message}`);
      });
      await once(raw, 'open', CONNECT_TIMEOUT_MS);
      raw.on('data', () => {});
      await streamFileRaw(raw, file.path, file);
      completed.add(file.id);
    } finally {
      try {
        raw?.close();
      } catch {
        /* */
      }
      try {
        sendPeer?.destroy();
      } catch {
        /* */
      }
    }
  };

  const dequeueOutbound = () => {
    while (outboundQueue.length > 0) {
      const next = outboundQueue[0];
      const file = files.find((f) => f.id === next.file_id);
      if (!file) {
        outboundQueue.shift();
        continue;
      }
      if (!canStartOutbound(file)) break;
      outboundQueue.shift();
      startOutbound(next, file);
    }
  };

  const startOutbound = (req, file) => {
    const size = Number(file.size) || 0;
    outboundActive += 1;
    outboundActiveBytes += size;
    Promise.resolve()
      .then(() => runTransfer(req, file))
      .catch((err) => {
        console.error(`[notesqr] transfer failed: ${err?.message || err}`);
      })
      .finally(() => {
        outboundActive = Math.max(0, outboundActive - 1);
        outboundActiveBytes = Math.max(0, outboundActiveBytes - size);
        dequeueOutbound();
        maybeOnceExit();
      });
  };

  host.on('connection', (ctrl) => {
    ctrl.on('error', (err) => {
      console.error(`[notesqr] control link error (${ctrl.peer}): ${err.message}`);
    });

    ctrl.on('open', () => {
      /* wait for webrtc-connect */
    });

    const onCtrlData = async (msg) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg['webrtc-connect']) {
        const info = msg['webrtc-connect'];
        const guestName = info.name || 'Guest';
        if (passwordHashV1) {
          if (!info.password) {
            ctrl.send({ 'webrtc-connect-response': { status: 'password_required' } });
            ctrl.close();
            return;
          }
          if (info.password !== passwordHashV1 && info.password !== passwordHashLegacy) {
            ctrl.send({ 'webrtc-connect-response': { status: 'password_invalid' } });
            ctrl.close();
            return;
          }
        }
        guests.set(ctrl.peer, { name: guestName, conn: ctrl });
        ctrl.send({
          'webrtc-connect-response': { status: 'welcome', secured: Boolean(passwordHashV1) },
        });
        sendRosterTo(ctrl);
        console.error(`[notesqr] peer joined: ${guestName} (${ctrl.peer})`);
        return;
      }

      if (msg['webrtc-user-name']) {
        const g = guests.get(ctrl.peer);
        if (g) g.name = msg['webrtc-user-name'].name || g.name;
        broadcastRoster();
        return;
      }

      if (msg['webrtc-file-download']) {
        const req = msg['webrtc-file-download'];
        const file = files.find((f) => f.id === req.file_id);
        if (!file) {
          console.error(`[notesqr] unknown file_id ${req.file_id}`);
          return;
        }
        if (!req.peer_id) return;

        if (!canStartOutbound(file)) {
          outboundQueue.push(req);
          notifyQueued(req);
          console.error(`[notesqr] queued: ${file.name} (active=${outboundActive})`);
          return;
        }
        startOutbound(req, file);
      }
    };

    ctrl.on('data', (msg) => {
      Promise.resolve(onCtrlData(msg)).catch((err) => {
        console.error(`[notesqr] control handler error: ${err?.message || err}`);
      });
    });

    ctrl.on('close', () => {
      if (guests.has(ctrl.peer)) {
        console.error(`[notesqr] peer left: ${guests.get(ctrl.peer).name}`);
        guests.delete(ctrl.peer);
        broadcastRoster();
      }
    });
  });

  host.on('disconnected', () => {
    console.error('[notesqr] signaling disconnected; reconnecting…');
    try {
      host.reconnect();
    } catch (err) {
      console.error(err.message);
    }
  });

  host.on('error', (err) => {
    console.error(`[notesqr] host error: ${err.message}`);
  });

  const shutdown = () => {
    console.error('\n[notesqr] shutting down');
    for (const id of [...zipSendSessions.keys()]) destroyZipSession(id);
    host.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
}
