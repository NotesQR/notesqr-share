/**
 * Node port of filesync-notesqr/web/js/modules/webrtc/peer.js
 * Uses `ws` + `@roamhq/wrtc` instead of browser globals.
 */
import { EventEmitter } from 'node:events';
import { randomFillSync } from 'node:crypto';
import WebSocket from 'ws';
import wrtc from '@roamhq/wrtc';

const {
  RTCPeerConnection,
} = wrtc;

function randomId(prefix = '') {
  const bytes = new Uint8Array(8);
  randomFillSync(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return prefix + hex;
}

function makeError(type, message) {
  const err = new Error(message);
  err.type = type;
  return err;
}

/**
 * Node EventEmitter throws if 'error' has zero listeners. WebRTC ICE/DC failures
 * are routine (guest leaves, NAT dies) — never let that kill the host/guest process.
 */
function emitError(emitter, err) {
  if (!emitter) return;
  if (emitter.listenerCount('error') > 0) {
    emitter.emit('error', err);
    return;
  }
  const label = err?.type ? `${err.type}: ` : '';
  console.error(`[notesqr] ${label}${err?.message || err}`);
}

const SERIALIZATION_BINARY = 'binary';
const SERIALIZATION_RAW = 'raw';
const PING_INTERVAL_MS = 10000;

class DataConnection extends EventEmitter {
  constructor(peer, remoteId, opts) {
    super();
    this._peer = peer;
    this._remoteId = remoteId;
    this._connectionId = (opts && opts.connectionId) || randomId('dc_');
    this._serialization = (opts && opts.serialization) || SERIALIZATION_BINARY;
    this._reliable = opts?.reliable !== false;
    this._label = (opts && opts.label) || this._connectionId;
    this._open = false;
    this._closed = false;
    this._pc = null;
    this._dc = null;
    this._pendingCandidates = [];
    this._remoteDescriptionSet = false;
  }

  get peer() {
    return this._remoteId;
  }
  get peerConnection() {
    return this._pc;
  }
  get dataChannel() {
    return this._dc;
  }
  get open() {
    return this._open;
  }
  get connectionId() {
    return this._connectionId;
  }
  get serialization() {
    return this._serialization;
  }

  async _initOutbound(iceServers) {
    this._pc = new RTCPeerConnection({ iceServers });
    this._wireRtcEvents();
    this._dc = this._pc.createDataChannel(this._label, { ordered: true });
    this._wireDataChannelEvents();

    try {
      const offer = await this._pc.createOffer();
      await this._pc.setLocalDescription(offer);
      this._peer._sendSignal(this._remoteId, {
        kind: 'offer',
        connectionId: this._connectionId,
        sdp: offer.sdp,
        label: this._label,
        serialization: this._serialization,
        reliable: this._reliable,
      });
    } catch (err) {
      emitError(this, makeError('webrtc', `Failed to create offer: ${err?.message || err}`));
      this.close();
    }
  }

  async _initInbound(iceServers, offerPayload) {
    this._pc = new RTCPeerConnection({ iceServers });
    this._wireRtcEvents();
    this._pc.ondatachannel = (ev) => {
      this._dc = ev.channel;
      this._wireDataChannelEvents();
    };

    try {
      await this._pc.setRemoteDescription({ type: 'offer', sdp: offerPayload.sdp });
      this._remoteDescriptionSet = true;
      await this._drainPendingCandidates();
      const answer = await this._pc.createAnswer();
      await this._pc.setLocalDescription(answer);
      this._peer._sendSignal(this._remoteId, {
        kind: 'answer',
        connectionId: this._connectionId,
        sdp: answer.sdp,
      });
    } catch (err) {
      emitError(this, makeError('webrtc', `Failed to answer: ${err?.message || err}`));
      this.close();
    }
  }

  async _handleSignal(payload) {
    if (!payload || typeof payload !== 'object') return;
    try {
      if (payload.kind === 'answer') {
        if (!this._pc) return;
        await this._pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        this._remoteDescriptionSet = true;
        await this._drainPendingCandidates();
      } else if (payload.kind === 'candidate') {
        if (!this._pc) return;
        const cand = payload.candidate;
        if (cand == null) return;
        if (!this._remoteDescriptionSet) this._pendingCandidates.push(cand);
        else {
          try {
            await this._pc.addIceCandidate(cand);
          } catch (err) {
            console.warn('addIceCandidate failed:', err?.message || err);
          }
        }
      } else if (payload.kind === 'close') {
        this.close();
      }
    } catch (err) {
      emitError(this, makeError('webrtc', `Signal handling failed: ${err?.message || err}`));
    }
  }

  async _drainPendingCandidates() {
    const pending = this._pendingCandidates;
    this._pendingCandidates = [];
    for (const cand of pending) {
      if (cand == null) continue;
      try {
        await this._pc.addIceCandidate(cand);
      } catch (err) {
        console.warn('addIceCandidate (drained) failed:', err?.message || err);
      }
    }
  }

  _wireRtcEvents() {
    this._pc.onicecandidate = (ev) => {
      if (this._closed || !ev.candidate) return;
      const cand = typeof ev.candidate.toJSON === 'function' ? ev.candidate.toJSON() : ev.candidate;
      this._peer._sendSignal(this._remoteId, {
        kind: 'candidate',
        connectionId: this._connectionId,
        candidate: cand,
      });
    };

    this._pc.oniceconnectionstatechange = () => {
      if (!this._pc || this._closed) return;
      const state = this._pc.iceConnectionState;
      if (state === 'failed') {
        // Tear down first so a throwing error listener cannot skip close().
        this.close();
        emitError(this, makeError('webrtc', 'ICE state failed'));
      } else if (state === 'closed') {
        this.close();
      }
    };
  }

  _wireDataChannelEvents() {
    if (!this._dc) return;
    this._dc.binaryType = 'arraybuffer';
    this._dc.onopen = () => {
      this._open = true;
      this.emit('open');
    };
    this._dc.onclose = () => {
      this._open = false;
      if (!this._closed) {
        this._closed = true;
        this.emit('close');
      }
    };
    this._dc.onerror = (ev) => {
      const e = ev && ev.error;
      const dcState = this._dc && this._dc.readyState;
      const inClosingState = dcState === 'closing' || dcState === 'closed' || this._closed;
      const isCloseAbort =
        e &&
        ((e.errorDetail === 'sctp-failure' && e.sctpCauseCode === 12) ||
          (typeof e.message === 'string' && e.message.includes('User-Initiated Abort')));
      if (inClosingState || isCloseAbort) return;
      emitError(this, makeError('webrtc', e ? e.message || String(e) : 'DataChannel error'));
    };
    this._dc.onmessage = (ev) => {
      let payload = ev.data;
      if (this._serialization === SERIALIZATION_BINARY && typeof payload === 'string') {
        if (payload.length > 0 && (payload[0] === '{' || payload[0] === '[')) {
          try {
            payload = JSON.parse(payload);
          } catch {
            /* leave */
          }
        }
      }
      this.emit('data', payload);
    };
  }

  send(data) {
    if (!this._dc || this._dc.readyState !== 'open') {
      emitError(this, makeError('webrtc', 'Connection is not open.'));
      return;
    }
    try {
      if (data instanceof ArrayBuffer) {
        this._dc.send(data);
      } else if (ArrayBuffer.isView(data)) {
        this._dc.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      } else if (Buffer.isBuffer(data)) {
        this._dc.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      } else if (typeof data === 'string') {
        this._dc.send(data);
      } else if (this._serialization === SERIALIZATION_RAW) {
        emitError(this, makeError('webrtc', 'Raw connection only accepts strings or binary data.'));
      } else {
        this._dc.send(JSON.stringify(data));
      }
    } catch (err) {
      emitError(this, makeError('webrtc', `send failed: ${err?.message || err}`));
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._open = false;
    if (this._peer && !this._peer.destroyed) {
      this._peer._sendSignal(this._remoteId, { kind: 'close', connectionId: this._connectionId });
    }
    if (this._dc) {
      try {
        this._dc.onopen = this._dc.onmessage = this._dc.onclose = this._dc.onerror = null;
      } catch {
        /* */
      }
      try {
        this._dc.close();
      } catch {
        /* */
      }
    }
    if (this._pc) {
      try {
        this._pc.onicecandidate = this._pc.oniceconnectionstatechange = this._pc.ondatachannel = null;
      } catch {
        /* */
      }
      try {
        this._pc.close();
      } catch {
        /* */
      }
    }
    if (this._peer) this._peer._unregisterConnection(this);
    this.emit('close');
  }
}

class Peer extends EventEmitter {
  constructor(id, opts = {}) {
    super();
    this._id = id;
    this._opts = opts;
    this._iceServers = (opts.config && opts.config.iceServers) || [];
    this._wsUrl = this._buildSignalUrl(opts);
    this._ws = null;
    this._destroyed = false;
    this._connections = new Map();
    this._socketOpened = false;
    this._pingTimer = null;
    this._signalQueue = [];

    if (typeof RTCPeerConnection === 'undefined') {
      queueMicrotask(() =>
        emitError(this, makeError('browser-incompatible', 'WebRTC is not supported.'))
      );
      return;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id || '')) {
      queueMicrotask(() => emitError(this, makeError('invalid-id', 'Peer id is invalid.')));
      return;
    }

    this._connect();
  }

  get id() {
    return this._id;
  }
  get destroyed() {
    return this._destroyed;
  }

  _buildSignalUrl(opts) {
    const isSecure = opts.secure ?? true;
    const proto = isSecure ? 'wss' : 'ws';
    const host = opts.host || 'notesqr.com';
    const port = opts.port || (isSecure ? 443 : 80);
    const defaultPort = isSecure ? 443 : 80;
    const portPart = Number(port) === defaultPort ? '' : `:${port}`;
    return `${proto}://${host}${portPart}/ws`;
  }

  _connect() {
    if (this._destroyed) return;
    if (this._ws) {
      try {
        this._ws.removeAllListeners();
        this._ws.close();
      } catch {
        /* */
      }
      this._ws = null;
    }

    let ws;
    try {
      ws = new WebSocket(this._wsUrl);
    } catch (err) {
      emitError(this, makeError('socket-error', `WebSocket construct failed: ${err?.message || err}`));
      return;
    }
    this._ws = ws;

    ws.on('open', () => {
      this._socketOpened = true;
      try {
        ws.send(JSON.stringify({ type: 'register', id: this._id }));
      } catch (err) {
        emitError(this, makeError('socket-error', `WS send failed: ${err?.message || err}`));
      }
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      this._handleSignalingMessage(msg);
    });

    ws.on('error', () => {
      if (!this._destroyed) emitError(this, makeError('socket-error', 'Signaling socket error.'));
    });

    ws.on('close', (code, reasonBuf) => {
      if (this._ws !== ws) return;
      this._ws = null;
      this._stopPing();
      const wasOpen = this._socketOpened;
      this._socketOpened = false;
      const reason = reasonBuf ? reasonBuf.toString() : '';

      if (code === 4400) {
        emitError(this, makeError('invalid-id', reason || 'Invalid register.'));
        return;
      }
      if (code === 4409) {
        emitError(this, makeError('unavailable-id', reason || 'Peer id already in use.'));
        return;
      }
      if (this._destroyed) return;
      if (wasOpen) this.emit('disconnected');
      else emitError(this, makeError('network', 'Failed to reach signaling server.'));
    });
  }

  _handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'registered':
        this._startPing();
        this._flushSignalQueue();
        this.emit('open', this._id);
        return;
      case 'signal': {
        const from = msg.from;
        const payload = msg.payload;
        if (typeof from !== 'string' || !payload || typeof payload !== 'object') return;
        this._handleIncomingSignal(from, payload);
        return;
      }
      case 'peer-unavailable': {
        const err = makeError('peer-unavailable', `Could not reach peer ${msg.id}`);
        let routed = false;
        for (const conn of Array.from(this._connections.values())) {
          if (conn._remoteId === msg.id && !conn._open && !conn._closed) {
            emitError(conn, err);
            conn.close();
            routed = true;
          }
        }
        if (!routed) emitError(this, err);
        return;
      }
      case 'error': {
        const code = msg.code;
        const messageText = msg.message || code || 'Server error.';
        const mapping = {
          'invalid-id': 'invalid-id',
          'unavailable-id': 'unavailable-id',
          'invalid-message': 'server-error',
          'rate-limited': 'server-error',
        };
        emitError(this, makeError(mapping[code] || 'server-error', messageText));
        return;
      }
      case 'pong':
        return;
      default:
        return;
    }
  }

  async _handleIncomingSignal(fromId, payload) {
    const connId = payload && payload.connectionId;
    if (typeof connId !== 'string') return;

    if (payload.kind === 'offer') {
      if (this._connections.has(connId)) return;
      const conn = new DataConnection(this, fromId, {
        connectionId: connId,
        serialization: payload.serialization || SERIALIZATION_BINARY,
        reliable: payload.reliable !== false,
        label: payload.label,
      });
      this._connections.set(connId, conn);
      this.emit('connection', conn);
      await conn._initInbound(this._iceServers, payload);
      return;
    }

    const existing = this._connections.get(connId);
    if (!existing) return;
    await existing._handleSignal(payload);
  }

  _sendSignal(toId, payload) {
    const env = { type: 'signal', to: toId, payload };
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify(env));
      } catch {
        this._signalQueue.push(env);
      }
    } else {
      this._signalQueue.push(env);
    }
  }

  _flushSignalQueue() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const queue = this._signalQueue;
    this._signalQueue = [];
    for (const env of queue) {
      try {
        this._ws.send(JSON.stringify(env));
      } catch {
        this._signalQueue.unshift(env);
        return;
      }
    }
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        try {
          this._ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          /* */
        }
      }
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  connect(otherId, opts = {}) {
    if (this._destroyed) {
      const err = makeError('disconnected', 'Cannot connect from a destroyed peer.');
      queueMicrotask(() => emitError(this, err));
      const stub = new DataConnection(this, otherId, opts);
      queueMicrotask(() => emitError(stub, err));
      return stub;
    }
    const conn = new DataConnection(this, otherId, {
      ...opts,
      connectionId: opts.connectionId || randomId('dc_'),
    });
    this._connections.set(conn.connectionId, conn);
    conn._initOutbound(this._iceServers).catch((err) => {
      emitError(conn, makeError('webrtc', err?.message || String(err)));
    });
    return conn;
  }

  reconnect() {
    if (this._destroyed) throw new Error('Peer already destroyed.');
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return;
    this._connect();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._stopPing();
    for (const conn of Array.from(this._connections.values())) {
      try {
        conn.close();
      } catch {
        /* */
      }
    }
    this._connections.clear();
    if (this._ws) {
      try {
        this._ws.removeAllListeners();
        this._ws.close();
      } catch {
        /* */
      }
      this._ws = null;
    }
    this.emit('close');
  }

  _unregisterConnection(conn) {
    this._connections.delete(conn.connectionId);
  }
}

/**
 * Wait for one event. Optional timeoutMs rejects with Error(`${event} timeout`).
 */
function once(emitter, event, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const onOk = (v) => {
      cleanup();
      resolve(v);
    };
    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error(`${event} timeout`));
    };
    const cleanup = () => {
      emitter.off(event, onOk);
      emitter.off('error', onErr);
      if (timer) clearTimeout(timer);
    };
    emitter.on(event, onOk);
    emitter.on('error', onErr);
    if (timeoutMs > 0) {
      timer = setTimeout(onTimeout, timeoutMs);
      timer.unref?.();
    }
  });
}

export { Peer, DataConnection, once, randomId };
