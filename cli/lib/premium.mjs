/**
 * Premium license config for CLI / MCP.
 * Store: ~/.config/notesqr/premium-license.v1.json (or NOTESQR_CONFIG_DIR)
 * Never write licenses under public web roots.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SHARE_ORIGIN } from './ice.mjs';

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function configDir() {
  if (process.env.NOTESQR_CONFIG_DIR) return process.env.NOTESQR_CONFIG_DIR;
  return path.join(os.homedir(), '.config', 'notesqr');
}

export function licensePath() {
  if (process.env.NOTESQR_LICENSE_FILE) return process.env.NOTESQR_LICENSE_FILE;
  return path.join(configDir(), 'premium-license.v1.json');
}

function emptyStore() {
  return { v: 2, rooms: [], activeRoom: null, useRandomRoom: false, importedAt: null };
}

export async function readLicenseStore() {
  try {
    const raw = await fs.readFile(licensePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.v === 2 && Array.isArray(parsed.rooms)) {
      return {
        v: 2,
        rooms: parsed.rooms
          .filter((r) => r?.room)
          .map((r) => ({
            room: String(r.room).toLowerCase(),
            claimToken: String(r.claimToken || ''),
            mockSubscriptionId: String(r.mockSubscriptionId || ''),
            issuedAt: String(r.issuedAt || ''),
          })),
        activeRoom: parsed.activeRoom ? String(parsed.activeRoom).toLowerCase() : null,
        useRandomRoom: !!parsed.useRandomRoom,
        importedAt: parsed.importedAt || null,
      };
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return emptyStore();
}

async function writeLicenseStore(store) {
  const dir = path.dirname(licensePath());
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${licensePath()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, licensePath());
}

export async function clearLicenseStore() {
  try {
    await fs.unlink(licensePath());
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

async function apiPost(pathname, body) {
  const base = (process.env.NOTESQR_ORIGIN || SHARE_ORIGIN).replace(/\/$/, '');
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function importNqlFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const { ok, status, data } = await apiPost('/api/premium/license/verify', { nql: raw });
  if (!ok) {
    throw new Error(data.error || `verify failed (${status})`);
  }
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  if (!rooms.length) {
    throw new Error('No active rooms in this license');
  }
  const store = {
    v: 2,
    rooms: rooms.map((r) => ({
      room: String(r.room).toLowerCase(),
      claimToken: String(r.claimToken || ''),
      mockSubscriptionId: String(r.mockSubscriptionId || ''),
      issuedAt: String(r.issuedAt || new Date().toISOString()),
    })),
    activeRoom: String(rooms[0].room).toLowerCase(),
    useRandomRoom: false,
    importedAt: new Date().toISOString(),
  };
  await writeLicenseStore(store);
  return store;
}

export async function syncLicenseStore() {
  const store = await readLicenseStore();
  if (!store.rooms.length) return store;
  const { ok, data } = await apiPost('/api/premium/license/sync', { rooms: store.rooms });
  if (!ok) return store;
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  let activeRoom = store.activeRoom;
  if (activeRoom && !rooms.some((r) => r.room === activeRoom)) {
    activeRoom = rooms[0]?.room || null;
  }
  if (!activeRoom) activeRoom = rooms[0]?.room || null;
  const next = {
    ...store,
    rooms,
    activeRoom,
    useRandomRoom: rooms.length ? store.useRandomRoom : true,
  };
  await writeLicenseStore(next);
  return next;
}

/**
 * Resolve host room: --room flag > env NOTESQR_ROOM > active Premium > random.
 * @param {{ room?: string, useRandom?: boolean }} flags
 * @param {() => string} generateRandom
 */
export async function resolveSendRoomId(flags, generateRandom) {
  if (flags.room) {
    const id = String(flags.room).trim().toLowerCase();
    if (!ROOM_RE.test(id)) {
      throw new Error(`invalid room id: ${id} (use [A-Za-z0-9_-]{1,64})`);
    }
    return id;
  }
  if (process.env.NOTESQR_ROOM) {
    const id = String(process.env.NOTESQR_ROOM).trim().toLowerCase();
    if (!ROOM_RE.test(id)) {
      throw new Error(`invalid NOTESQR_ROOM: ${id}`);
    }
    return id;
  }
  if (flags.useRandom || process.env.NOTESQR_USE_RANDOM_ROOM === '1') {
    return generateRandom();
  }
  const store = await syncLicenseStore().catch(() => readLicenseStore());
  if (store.useRandomRoom || !store.rooms.length) {
    return generateRandom();
  }
  return store.activeRoom || store.rooms[0].room || generateRandom();
}

/** Claim token for a Premium room from the local license store (empty if none). */
export async function claimTokenForRoom(room) {
  const key = String(room || '').trim().toLowerCase();
  if (!key) return '';
  const store = await readLicenseStore();
  const hit = store.rooms.find((r) => r.room === key);
  return hit?.claimToken || '';
}

export { ROOM_RE };
