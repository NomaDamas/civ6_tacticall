const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const port = Number(process.env.PORT || 8787);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

app.use(express.static(path.resolve(__dirname)));
app.get('/health', (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

const TOKENS_FILE = path.resolve(__dirname, 'auth-tokens.json');
const tokens = loadTokens();
const rooms = new Map();
const pairSessions = new Map();

function loadTokens() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return new Map();
    const list = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    return new Map(list.map((it) => [it.token, it]));
  } catch {
    return new Map();
  }
}

function saveTokens() {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(Array.from(tokens.values()), null, 2));
}

function nowMs() {
  return Date.now();
}

function newToken(size = 24) {
  return crypto.randomBytes(size).toString('hex');
}

function sanitizeRoomId(input) {
  return String(input || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64);
}

function isSocketOpen(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

function safeSend(ws, payload) {
  if (!isSocketOpen(ws)) return;
  ws.send(JSON.stringify(payload));
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      roomId,
      host: null,
      hostKey: null,
      controllers: new Set(),
      lastPairSessionToken: null,
    });
  }
  return rooms.get(roomId);
}

function cleanupRoomIfEmpty(room) {
  if (!room.host && room.controllers.size === 0) {
    rooms.delete(room.roomId);
  }
}

function broadcastToControllers(room, payload) {
  for (const ws of room.controllers) safeSend(ws, payload);
}

function createPairSession(roomId, baseUrl) {
  const token = newToken(20);
  const expiresAt = nowMs() + 2 * 60 * 1000;
  pairSessions.set(token, {
    token,
    roomId,
    expiresAt,
    used: false,
  });

  const controllerBaseUrl = baseUrl || PUBLIC_BASE_URL || '';
  const pairUrl = controllerBaseUrl
    ? `${controllerBaseUrl.replace(/\/$/, '')}/?pair=${token}`
    : `/?pair=${token}`;

  return {
    token,
    expiresAt,
    pairUrl,
  };
}

function attachController(ws, room, method, token) {
  room.controllers.add(ws);
  ws.meta = { authed: true, role: 'controller', roomId: room.roomId };
  safeSend(ws, {
    type: 'auth_ok',
    method,
    token,
    hostOnline: Boolean(room.host && isSocketOpen(room.host)),
  });

  if (!room.host || !isSocketOpen(room.host)) {
    safeSend(ws, { type: 'message', message: 'Connected. Waiting for host bridge.' });
  }
}

function issueControllerToken(roomId) {
  const token = newToken(24);
  tokens.set(token, {
    token,
    roomId,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  });
  saveTokens();
  return token;
}

function handleHostAuth(ws, msg) {
  const roomId = sanitizeRoomId(msg.roomId);
  const hostKey = String(msg.hostKey || '');
  if (!roomId || !hostKey) {
    safeSend(ws, { type: 'auth_error', message: 'roomId and hostKey are required' });
    ws.close(4001, 'Invalid host auth');
    return;
  }

  const room = getOrCreateRoom(roomId);
  if (room.host && isSocketOpen(room.host)) {
    safeSend(ws, { type: 'auth_error', message: 'host already connected' });
    ws.close(4002, 'Host exists');
    return;
  }

  if (!room.hostKey) {
    room.hostKey = hostKey;
  } else if (room.hostKey !== hostKey) {
    safeSend(ws, { type: 'auth_error', message: 'wrong host key' });
    ws.close(4003, 'Wrong host key');
    return;
  }

  room.host = ws;
  ws.meta = { authed: true, role: 'host', roomId };
  safeSend(ws, { type: 'auth_ok', role: 'host', roomId });
  broadcastToControllers(room, { type: 'message', message: 'Host connected' });
}

function handleTokenLogin(ws, msg) {
  const token = String(msg.token || '').trim();
  const info = tokens.get(token);
  if (!info) {
    safeSend(ws, { type: 'auth_error', code: 'invalid_token', message: 'token is invalid' });
    return;
  }

  const room = getOrCreateRoom(info.roomId);
  info.lastUsedAt = new Date().toISOString();
  tokens.set(token, info);
  saveTokens();
  attachController(ws, room, 'token', token);
}

function handleQrPairLogin(ws, msg) {
  const pairToken = String(msg.pairToken || '').trim();
  if (!pairToken) {
    safeSend(ws, { type: 'auth_error', message: 'pairToken is required' });
    return;
  }

  const session = pairSessions.get(pairToken);
  if (!session || session.used || session.expiresAt <= nowMs()) {
    safeSend(ws, { type: 'auth_error', code: 'invalid_pair', message: 'pair token expired/invalid' });
    return;
  }

  const room = rooms.get(session.roomId);
  if (!room || !room.host || !isSocketOpen(room.host)) {
    safeSend(ws, { type: 'auth_error', code: 'host_offline', message: 'host is offline' });
    return;
  }

  session.used = true;
  pairSessions.set(pairToken, session);

  const token = issueControllerToken(room.roomId);
  attachController(ws, room, 'qr_pair', token);
  safeSend(room.host, { type: 'message', message: 'A controller paired via QR.' });
}

function handleAuthedMessage(ws, msg) {
  const room = rooms.get(ws.meta.roomId);
  if (!room) return;

  if (ws.meta.role === 'controller') {
    if (!room.host || !isSocketOpen(room.host)) {
      safeSend(ws, { type: 'message', message: 'Host is offline' });
      return;
    }

    if (msg.type === 'command') {
      const content = String(msg.content || '').trim();
      if (!content) return;

      safeSend(room.host, {
        type: 'command',
        content,
        roomId: room.roomId,
        sentAt: new Date().toISOString(),
      });
      return;
    }

    if (msg.type === 'control') {
      const action = String(msg.action || '').trim();
      if (!action) return;

      safeSend(room.host, {
        type: 'control',
        action,
        roomId: room.roomId,
        sentAt: new Date().toISOString(),
      });
      return;
    }

    return;
  }

  if (ws.meta.role === 'host') {
    if (msg.type === 'create_pair_qr') {
      const requestedBaseUrl = String(msg.baseUrl || '').trim();
      const session = createPairSession(room.roomId, requestedBaseUrl);
      room.lastPairSessionToken = session.token;
      safeSend(ws, {
        type: 'pair_qr',
        pairToken: session.token,
        pairUrl: session.pairUrl,
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
      return;
    }

    if (msg.type === 'status' && typeof msg.status === 'string') {
      broadcastToControllers(room, { type: 'status', status: msg.status });
      return;
    }

    if (msg.type === 'agent_state' && msg.data && typeof msg.data === 'object') {
      broadcastToControllers(room, { type: 'agent_state', data: msg.data });
      return;
    }

    if (msg.type === 'message' && typeof msg.message === 'string') {
      broadcastToControllers(room, { type: 'message', message: msg.message });
      return;
    }

    if (msg.type === 'video_frame' && typeof msg.data === 'string') {
      broadcastToControllers(room, {
        type: 'video_frame',
        data: msg.data,
        mime: typeof msg.mime === 'string' ? msg.mime : 'image/jpeg',
        width: Number(msg.width || 0) || undefined,
        height: Number(msg.height || 0) || undefined,
        ts: msg.ts || Date.now(),
      });
      return;
    }

    if (typeof msg.content === 'string') {
      broadcastToControllers(room, { type: 'message', message: msg.content });
    }
  }
}

function detachClient(ws) {
  const meta = ws.meta;
  if (!meta || !meta.authed || !meta.roomId) return;

  const room = rooms.get(meta.roomId);
  if (!room) return;

  if (meta.role === 'host' && room.host === ws) {
    room.host = null;
    broadcastToControllers(room, { type: 'status', status: 'Waiting for User' });
    broadcastToControllers(room, { type: 'message', message: 'Host disconnected' });
  }

  if (meta.role === 'controller') {
    room.controllers.delete(ws);
  }

  cleanupRoomIfEmpty(room);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.meta = { authed: false, role: null, roomId: null };

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      safeSend(ws, { type: 'message', message: 'Invalid JSON payload' });
      return;
    }

    if (!ws.meta.authed) {
      if (msg.type === 'auth' && msg.role === 'host') {
        handleHostAuth(ws, msg);
        return;
      }

      if (msg.type === 'token_login') {
        handleTokenLogin(ws, msg);
        return;
      }

      if (msg.type === 'qr_pair_login') {
        handleQrPairLogin(ws, msg);
        return;
      }

      safeSend(ws, { type: 'auth_error', message: 'authenticate first' });
      return;
    }

    handleAuthedMessage(ws, msg);
  });

  ws.on('close', () => detachClient(ws));
  ws.on('error', () => detachClient(ws));

  safeSend(ws, { type: 'message', message: 'Connected to Civ relay. Authenticate first.' });
});

setInterval(() => {
  const now = nowMs();

  for (const [pairToken, session] of pairSessions.entries()) {
    if (session.used || session.expiresAt <= now) {
      pairSessions.delete(pairToken);
    }
  }

  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }
}, 25000);

server.listen(port, () => {
  console.log(`Civ relay server listening on http://localhost:${port}`);
});
