// Signaling server: pairs a host and a viewer via a one-time access code and
// relays WebRTC offer/answer/ICE messages between them. No screen data ever
// passes through here — media and input travel peer-to-peer over WebRTC.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_FAILED_JOINS = 5;
const HEARTBEAT_MS = 30 * 1000;

// code -> { host: ws, expiresAt, pending: ws|null, requestId }
const codes = new Map();

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function newCode() {
  let code;
  do {
    code = String(crypto.randomInt(0, 1e9)).padStart(9, '0');
  } while (codes.has(code));
  return code;
}

function releaseCode(ws) {
  if (!ws.code) return;
  const entry = codes.get(ws.code);
  if (entry && entry.host === ws) {
    if (entry.pending) {
      send(entry.pending, { type: 'rejected', reason: 'Host is no longer available.' });
      entry.pending.joining = null;
    }
    codes.delete(ws.code);
  }
  ws.code = null;
}

function cancelJoin(ws) {
  if (!ws.joining) return;
  const entry = codes.get(ws.joining);
  if (entry && entry.pending === ws) {
    entry.pending = null;
    send(entry.host, { type: 'join-cancelled' });
  }
  ws.joining = null;
}

function unpair(ws) {
  const peer = ws.peer;
  if (!peer) return;
  ws.peer = null;
  peer.peer = null;
  send(peer, { type: 'peer-left' });
}

const handlers = {
  // Host asks for a fresh access code.
  host(ws) {
    if (ws.peer) return send(ws, { type: 'error', message: 'Already in a session.' });
    releaseCode(ws);
    const code = newCode();
    const expiresAt = Date.now() + CODE_TTL_MS;
    codes.set(code, { host: ws, expiresAt, pending: null });
    ws.code = code;
    send(ws, { type: 'code', code, expiresAt });
  },

  // Viewer tries to join using a code.
  join(ws, msg) {
    if (ws.peer || ws.joining) return send(ws, { type: 'error', message: 'Already connecting.' });
    const code = String(msg.code || '').replace(/\D/g, '');
    const entry = codes.get(code);
    if (!entry || entry.expiresAt < Date.now() || entry.pending) {
      ws.failedJoins = (ws.failedJoins || 0) + 1;
      send(ws, { type: 'rejected', reason: entry && entry.pending
        ? 'Someone else is already connecting to this computer.'
        : 'Invalid or expired access code.' });
      if (ws.failedJoins >= MAX_FAILED_JOINS) ws.close(4001, 'Too many attempts');
      return;
    }
    entry.pending = ws;
    entry.requestId = crypto.randomUUID();
    ws.joining = code;
    const name = String(msg.name || 'Anonymous').slice(0, 64);
    send(entry.host, { type: 'join-request', name, requestId: entry.requestId });
    send(ws, { type: 'waiting' });
  },

  // Host accepts or denies the pending viewer.
  'join-response'(ws, msg) {
    const entry = ws.code && codes.get(ws.code);
    // Ignore stale answers (e.g. the viewer cancelled and someone else joined
    // while the host's confirmation dialog was still open).
    if (!entry || !entry.pending || msg.requestId !== entry.requestId) return;
    const viewer = entry.pending;
    entry.pending = null;
    viewer.joining = null;
    if (!msg.accept) {
      send(viewer, { type: 'rejected', reason: 'The host declined the connection.' });
      return;
    }
    // Codes are single use.
    codes.delete(ws.code);
    ws.code = null;
    ws.peer = viewer;
    viewer.peer = ws;
    // Viewer must hear "accepted" before the host starts sending its offer.
    send(viewer, { type: 'accepted' });
    send(ws, { type: 'paired' });
  },

  signal(ws, msg) {
    if (ws.peer) send(ws.peer, { type: 'signal', data: msg.data });
  },

  leave(ws) {
    cancelJoin(ws);
    unpair(ws);
  },
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('remote-desktop signaling server ok\n');
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const handler = msg && handlers[msg.type];
    if (handler) handler(ws, msg);
  });

  ws.on('close', () => {
    releaseCode(ws);
    cancelJoin(ws);
    unpair(ws);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, entry] of codes) {
    if (entry.expiresAt < now && !entry.pending) {
      codes.delete(code);
      entry.host.code = null;
      send(entry.host, { type: 'code-expired' });
    }
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Signaling server listening on ws://localhost:${PORT}`);
});
