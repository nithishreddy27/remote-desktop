// Signaling server: pairs a host and a viewer via a one-time access code and
// relays WebRTC offer/answer/ICE messages between them. No screen data ever
// passes through here — media and input travel peer-to-peer over WebRTC.
//
// Environment:
//   PORT                   port to listen on (default 8080)
//   TRUST_PROXY=1          read the client IP from proxy headers (Railway, Fly.io, ...)
//   CF_TURN_KEY_ID         Cloudflare TURN key id      } hand out short-lived
//   CF_TURN_API_TOKEN      Cloudflare TURN API token   } TURN credentials
//   ICE_SERVERS            alternative: static JSON array of ICE servers

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID;
const CF_TURN_API_TOKEN = process.env.CF_TURN_API_TOKEN;
const STATIC_ICE_SERVERS = parseJson(process.env.ICE_SERVERS, []);

const CODE_TTL_MS = 10 * 60 * 1000;
const TURN_TTL_S = 24 * 60 * 60;
const HEARTBEAT_MS = 30 * 1000;

// Abuse limits.
const MAX_FAILED_JOINS_PER_SOCKET = 5;
const MAX_FAILED_JOINS_PER_IP = 20;       // per FAILED_JOIN_WINDOW_MS
const FAILED_JOIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_CONNECTIONS_PER_IP = 20;
const MAX_MESSAGES_PER_10S = 200;

// code -> { host: ws, expiresAt, pending: ws|null, requestId }
const codes = new Map();
// ip -> number of open sockets
const connectionsByIp = new Map();
// ip -> { count, resetAt }
const failedJoinsByIp = new Map();

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fly = req.headers['fly-client-ip'];
    if (fly) return fly;
    // The proxy appends the address it saw, so the last entry is the trustworthy one.
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

function ipJoinFailures(ip) {
  const entry = failedJoinsByIp.get(ip);
  if (!entry || entry.resetAt < Date.now()) return 0;
  return entry.count;
}

function recordJoinFailure(ip) {
  const now = Date.now();
  let entry = failedJoinsByIp.get(ip);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + FAILED_JOIN_WINDOW_MS };
    failedJoinsByIp.set(ip, entry);
  }
  entry.count++;
}

// Fresh ICE servers for one session. With Cloudflare configured each pairing
// gets its own short-lived TURN credentials, so nothing secret ships in the app.
async function iceServersForSession() {
  if (CF_TURN_KEY_ID && CF_TURN_API_TOKEN) {
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: TURN_TTL_S }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { iceServers } = await res.json();
      // Port 53 is blocked by browsers and only makes ICE gathering slower.
      return iceServers.map((s) => ({
        ...s,
        urls: [].concat(s.urls).filter((u) => !/:53\b/.test(u)),
      }));
    } catch (err) {
      console.error('[turn] could not get Cloudflare credentials:', err.message);
    }
  }
  return STATIC_ICE_SERVERS;
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
    if (ipJoinFailures(ws.ip) >= MAX_FAILED_JOINS_PER_IP) {
      send(ws, { type: 'rejected', reason: 'Too many failed attempts. Please wait 15 minutes and try again.' });
      ws.close(4001, 'Too many attempts');
      return;
    }
    const code = String(msg.code || '').replace(/\D/g, '');
    const entry = codes.get(code);
    if (!entry || entry.expiresAt < Date.now() || entry.pending) {
      if (!entry || entry.expiresAt < Date.now()) recordJoinFailure(ws.ip);
      ws.failedJoins = (ws.failedJoins || 0) + 1;
      send(ws, { type: 'rejected', reason: entry && entry.pending
        ? 'Someone else is already connecting to this computer.'
        : 'Invalid or expired access code.' });
      if (ws.failedJoins >= MAX_FAILED_JOINS_PER_SOCKET) ws.close(4001, 'Too many attempts');
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
  async 'join-response'(ws, msg) {
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

    const iceServers = await iceServersForSession();
    if (ws.peer !== viewer) return; // one side left while we were fetching credentials
    // Viewer must hear "accepted" before the host starts sending its offer.
    send(viewer, { type: 'accepted', iceServers });
    send(ws, { type: 'paired', iceServers });
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

wss.on('connection', (ws, req) => {
  ws.ip = clientIp(req);
  const open = (connectionsByIp.get(ws.ip) || 0) + 1;
  connectionsByIp.set(ws.ip, open);
  if (open > MAX_CONNECTIONS_PER_IP) {
    ws.close(4002, 'Too many connections');
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let windowStart = Date.now();
  let messageCount = 0;

  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - windowStart > 10000) { windowStart = now; messageCount = 0; }
    if (++messageCount > MAX_MESSAGES_PER_10S) {
      ws.close(4003, 'Rate limit exceeded');
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const handler = msg && Object.hasOwn(handlers, msg.type) && handlers[msg.type];
    if (!handler) return;
    Promise.resolve(handler(ws, msg)).catch((err) => console.error('[handler]', msg.type, err));
  });

  ws.on('close', () => {
    const left = (connectionsByIp.get(ws.ip) || 1) - 1;
    if (left > 0) connectionsByIp.set(ws.ip, left); else connectionsByIp.delete(ws.ip);
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
  for (const [ip, entry] of failedJoinsByIp) {
    if (entry.resetAt < now) failedJoinsByIp.delete(ip);
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  const turn = CF_TURN_KEY_ID && CF_TURN_API_TOKEN ? 'Cloudflare TURN'
    : STATIC_ICE_SERVERS.length ? 'static ICE_SERVERS' : 'no TURN (STUN only)';
  console.log(`Signaling server listening on port ${PORT} (${turn})`);
});
