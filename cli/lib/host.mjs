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

const CHUNK_SIZE = 16 * 1024;
const HIGH_WATER = 1 << 20;
const LOW_WATER = 1 << 18;

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

async function streamFileRaw(conn, filePath, meta) {
  const { open } = await import('node:fs/promises');
  const dc = conn.dataChannel;
  if (!dc) throw new Error('no data channel');
  dc.bufferedAmountLowThreshold = LOW_WATER;

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
    const buf = Buffer.allocUnsafe(CHUNK_SIZE);
    let offset = 0;
    while (offset < meta.size) {
      if (dc.readyState !== 'open') throw new Error('datachannel closed mid-transfer');
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK_SIZE, meta.size - offset), offset);
      if (!bytesRead) break;
      await awaitDrain(dc);
      dc.send(buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead));
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
  await once(host, 'open');

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

  // Humans (TTY): clean banner + QR on stderr. Agents/MCP/pipes: JSON on stdout.
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
  let activeTransfers = 0;
  const completed = new Set(); // fileId that finished at least once

  const broadcastRoster = () => {
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
    for (const g of guests.values()) {
      if (g.conn?.open) {
        g.conn.send({ 'webrtc-peers': peers, 'webrtc-files': fileMeta });
      }
    }
  };

  host.on('connection', (ctrl) => {
    ctrl.on('open', () => {
      /* wait for webrtc-connect */
    });

    ctrl.on('data', async (msg) => {
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
        broadcastRoster();
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
        const recvPeerId = req.peer_id;
        if (!recvPeerId) return;

        activeTransfers += 1;
        console.error(
          `[notesqr] transfer start: ${file.name} → ${req.requester_name || req.requester_id}`
        );

        let sendPeer;
        try {
          const sendId = await fetchUuid();
          sendPeer = new Peer(sendId, peerOpts(await getIceServers()));
          await once(sendPeer, 'open');
          const raw = sendPeer.connect(recvPeerId, { serialization: 'raw', reliable: true });
          await once(raw, 'open');
          raw.on('data', (d) => {
            if (d && typeof d === 'object' && d.type === 'progress') {
              /* optional */
            }
          });
          await streamFileRaw(raw, file.path, file);
          completed.add(file.id);
          try {
            raw.close();
          } catch {
            /* */
          }
        } catch (err) {
          console.error(`[notesqr] transfer failed: ${err.message}`);
        } finally {
          try {
            sendPeer?.destroy();
          } catch {
            /* */
          }
          activeTransfers -= 1;
          if (flags.once && completed.size >= files.length && activeTransfers === 0) {
            console.error('[notesqr] --once: all files transferred, exiting');
            host.destroy();
            process.exit(0);
          }
        }
      }
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
    host.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
}
