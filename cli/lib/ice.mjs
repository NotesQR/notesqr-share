const SHARE_ORIGIN = process.env.NOTESQR_ORIGIN || 'https://notesqr.com';
const SIGNAL_HOST = process.env.NOTESQR_SIGNAL_HOST || 'notesqr.com';
const SIGNAL_PORT = Number(process.env.NOTESQR_SIGNAL_PORT || 443);
const SIGNAL_SECURE = process.env.NOTESQR_SIGNAL_SECURE !== '0';

const STUN_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

let cachedCred = null;

async function fetchUuid() {
  const res = await fetch(`${SHARE_ORIGIN}/api/uuid`);
  if (!res.ok) throw new Error(`uuid HTTP ${res.status}`);
  const data = await res.json();
  if (!data.uuid) throw new Error('uuid missing');
  return data.uuid;
}

async function getIceServers() {
  const servers = [...STUN_ICE];
  try {
    const now = Math.floor(Date.now() / 1000);
    if (!cachedCred || cachedCred.exp <= now) {
      const res = await fetch(`${SHARE_ORIGIN}/api/credentials`);
      if (!res.ok) throw new Error(`credentials HTTP ${res.status}`);
      const data = await res.json();
      if (!data.token) throw new Error('token missing');
      const payload = JSON.parse(
        Buffer.from(data.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
      );
      const turnHost =
        (typeof data.turn_host === 'string' && data.turn_host.trim()) || SIGNAL_HOST;
      cachedCred = {
        username: payload.username,
        credential: payload.credential,
        exp: payload.exp - 10,
        turnHost,
      };
    }
    const host = cachedCred.turnHost;
    servers.push(
      { urls: `stun:${host}:3478` },
      {
        urls: [`turn:${host}:3478`, `turn:${host}:3478?transport=tcp`],
        username: cachedCred.username,
        credential: cachedCred.credential,
      }
    );
  } catch (err) {
    console.warn('[notesqr] host TURN unavailable; STUN-only:', err.message);
  }
  return servers;
}

function peerOpts(iceServers) {
  return {
    host: SIGNAL_HOST,
    port: SIGNAL_PORT,
    secure: SIGNAL_SECURE,
    config: { iceServers },
  };
}

function generateRoomId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let s = '';
  for (let i = 0; i < 10; i++) s += alphabet[bytes[i] % alphabet.length];
  return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7, 10)}`;
}

function parseRoomId(input) {
  if (!input) throw new Error('room id required');
  let id = String(input).trim();
  try {
    if (id.includes('://') || id.startsWith('notesqr.com') || id.startsWith('/')) {
      const u = new URL(id.includes('://') ? id : `https://${id.replace(/^\//, '')}`);
      id = u.pathname.replace(/^\//, '').split('/')[0];
    }
  } catch {
    /* keep raw */
  }
  id = id.replace(/^\//, '');
  if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(id)) {
    throw new Error(`invalid room id: ${id} (expected abc-defg-hij)`);
  }
  return id;
}

export {
  SHARE_ORIGIN,
  fetchUuid,
  getIceServers,
  peerOpts,
  generateRoomId,
  parseRoomId,
};
