const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('ws');
const QRCode = require('qrcode');

const args = process.argv.slice(2);

function readArg(name, fallback) {
  const key = `--${name}`;
  const idx = args.indexOf(key);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

function loadHostConfigFile() {
  const filePath = path.resolve(process.cwd(), 'host-config.json');
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    console.error(`Invalid JSON in ${filePath}`);
    process.exit(1);
  }
}

function guessControllerBaseUrl(relayUrl) {
  const raw = String(relayUrl || '').trim();
  if (!raw) return '';
  if (raw.startsWith('wss://')) return raw.replace('wss://', 'https://').replace(/\/ws$/, '');
  if (raw.startsWith('ws://')) return raw.replace('ws://', 'http://').replace(/\/ws$/, '');
  return raw.replace(/\/ws$/, '');
}

function detectLanIp() {
  const nics = os.networkInterfaces();
  for (const entries of Object.values(nics)) {
    if (!entries) continue;
    for (const item of entries) {
      if (!item || item.family !== 'IPv4' || item.internal) continue;
      const ip = item.address;
      if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) {
        return ip;
      }
    }
  }
  return '127.0.0.1';
}

function buildAutoControllerBaseUrl(relayUrl, explicitBaseUrl) {
  const base = String(explicitBaseUrl || '').trim();
  if (base && base.toLowerCase() !== 'auto') return base;

  const relay = String(relayUrl || '').trim();
  if (relay.startsWith('wss://')) return relay.replace('wss://', 'https://').replace(/\/ws$/, '');
  if (relay.startsWith('ws://') && !/ws:\/\/(localhost|127\.0\.0\.1)/.test(relay)) {
    return relay.replace('ws://', 'http://').replace(/\/ws$/, '');
  }

  const lanIp = detectLanIp();
  return `http://${lanIp}:8787`;
}

const fileConfig = loadHostConfigFile();

const relayUrl = readArg(
  'relay',
  process.env.RELAY_URL || fileConfig.relayUrl || 'ws://127.0.0.1:8787/ws',
);

const config = {
  relayUrl,
  localAgentUrl: readArg('local', process.env.LOCAL_AGENT_URL || fileConfig.localAgentUrl || 'ws://localhost:8000/ws'),
  roomId: readArg('room', process.env.ROOM_ID || fileConfig.roomId || 'civ6-room'),
  hostKey: readArg('host-key', process.env.HOST_KEY || fileConfig.hostKey || ''),
  discussionUserId: readArg(
    'discussion-user-id',
    process.env.DISCUSSION_USER_ID || fileConfig.discussionUserId || 'web_user',
  ),
  discussionMode: readArg(
    'discussion-mode',
    process.env.DISCUSSION_MODE || fileConfig.discussionMode || 'in_game',
  ),
  discussionLanguage: readArg(
    'discussion-language',
    process.env.DISCUSSION_LANGUAGE || fileConfig.discussionLanguage || 'ko',
  ),
  controllerBaseUrl: buildAutoControllerBaseUrl(
    relayUrl,
    readArg(
      'controller-base-url',
      process.env.CONTROLLER_BASE_URL || fileConfig.controllerBaseUrl || '',
    ),
  ),
};

const localApiBaseUrl = (function buildLocalApiBaseUrl() {
  const explicit = String(process.env.LOCAL_API_BASE_URL || fileConfig.localApiBaseUrl || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  return config.localAgentUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://').replace(/\/ws$/, '');
})();

if (!config.hostKey) {
  console.error('hostKey is required. Set HOST_KEY, use --host-key, or create host-config.json.');
  process.exit(1);
}

let relayWs = null;
let localWs = null;
let relayTimer = null;
let localTimer = null;
let relayAuthed = false;

function log(kind, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${kind}] ${msg}`);
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

async function fetchJsonWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}


function requestPairQr() {
  if (!safeSend(relayWs, { type: 'create_pair_qr', baseUrl: config.controllerBaseUrl })) return;
  log('pair', 'Requested new QR session');
}

async function printQr(url, expiresAt) {
  try {
    const qrText = await QRCode.toString(url, { type: 'terminal', small: true });
    console.log('\n=== Pair QR (scan with phone) ===');
    console.log(qrText);
    console.log(`Pair URL: ${url}`);
    console.log(`Expires: ${expiresAt}`);
    console.log('===============================\n');
  } catch (error) {
    log('pair', `QR render failed: ${error.message}`);
    log('pair', `Open URL manually: ${url}`);
  }
}

function connectRelay() {
  if (relayWs && (relayWs.readyState === WebSocket.OPEN || relayWs.readyState === WebSocket.CONNECTING)) {
    return;
  }

  log('relay', `connecting -> ${config.relayUrl}`);
  relayWs = new WebSocket(config.relayUrl);

  relayWs.on('open', () => {
    log('relay', 'connected, authenticating as host');
    safeSend(relayWs, {
      type: 'auth',
      role: 'host',
      roomId: config.roomId,
      hostKey: config.hostKey,
    });
  });

  relayWs.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      log('relay', `non-json message: ${String(data)}`);
      return;
    }

    if (msg.type === 'auth_ok') {
      log('relay', `authenticated to room '${config.roomId}'`);
      relayAuthed = true;
      safeSend(relayWs, { type: 'status', status: 'Idle' });
      requestPairQr();
      return;
    }

    if (msg.type === 'pair_qr') {
      await printQr(msg.pairUrl, msg.expiresAt);
      return;
    }

    if (msg.type === 'auth_error') {
      log('relay', `auth failed: ${msg.message || 'unknown'}`);
      return;
    }

    if (msg.type === 'command' && typeof msg.content === 'string') {
      log('cmd', msg.content);
      if (!safeSend(localWs, { type: 'command', content: msg.content })) {
        safeSend(relayWs, {
          type: 'message',
          message: 'Local agent is offline. Command not delivered.',
        });
      }
      return;
    }

    if (msg.type === 'control' && typeof msg.action === 'string') {
      log('control', msg.action);
      if (!safeSend(localWs, { type: 'control', action: msg.action })) {
        safeSend(relayWs, {
          type: 'message',
          message: 'Local agent is offline. Control not delivered.',
        });
      }
      return;
    }

    if (msg.type === 'discussion_query') {
      try {
        const query = String(msg.query || '').trim();
        const language = String(msg.language || config.discussionLanguage || 'ko').trim() || 'ko';
        if (!query) {
          safeSend(relayWs, { type: 'discussion_error', message: 'Empty discussion question.' });
          return;
        }
        const endpoint = `${localApiBaseUrl}/api/discuss`;
        log(
          'discussion',
          `query -> ${endpoint} (user_id=${config.discussionUserId}, mode=${config.discussionMode}, language=${language})`,
        );

        const res = await fetchJsonWithTimeout(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: config.discussionUserId,
            message: query,
            mode: config.discussionMode,
            language,
          }),
        });
        if (!res.ok) {
          let detail = '';
          try {
            const errBody = await res.json();
            if (errBody && typeof errBody.error === 'string') detail = ` (${errBody.error})`;
          } catch {}
          safeSend(relayWs, {
            type: 'discussion_error',
            message: `Discussion endpoint failed: ${res.status}${detail}`,
          });
          return;
        }
        const data = await res.json();
        const answer = typeof data.response === 'string' ? data.response : '';
        if (!answer) {
          safeSend(relayWs, {
            type: 'discussion_answer_error',
            message: 'Discussion endpoint returned empty response.',
          });
          return;
        }
        log('discussion', `answer received (${answer.length} chars)`);
        safeSend(relayWs, { type: 'discussion_answer', answer });
      } catch (error) {
        const reason = error?.name === 'AbortError' ? 'Discussion request timeout (30s)' : `Discussion error: ${error.message}`;
        safeSend(relayWs, { type: 'discussion_answer_error', message: reason });
      }
      return;
    }

    if (msg.type === 'message' && typeof msg.message === 'string') {
      log('relay', msg.message);
    }
  });

  relayWs.on('close', (code) => {
    log('relay', `closed (${code})`);
    relayAuthed = false;
    relayWs = null;
    if (!relayTimer) {
      relayTimer = setTimeout(() => {
        relayTimer = null;
        connectRelay();
      }, 2000);
    }
  });

  relayWs.on('error', (err) => {
    log('relay', `error: ${err.message}`);
    if (String(err.message || '').includes('ECONNREFUSED')) {
      log('relay', 'hint: run `npm start` first, and use ws://127.0.0.1:8787/ws for local relay');
    }
  });
}

function connectLocal() {
  if (localWs && (localWs.readyState === WebSocket.OPEN || localWs.readyState === WebSocket.CONNECTING)) {
    return;
  }

  log('local', `connecting -> ${config.localAgentUrl}`);
  localWs = new WebSocket(config.localAgentUrl);

  localWs.on('open', () => {
    log('local', 'connected');
    safeSend(relayWs, { type: 'message', message: 'Local Civ6 agent connected' });
    safeSend(relayWs, { type: 'status', status: 'Waiting for User' });
  });

  localWs.on('message', (data) => {
    const raw = String(data);
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'status' && msg.data && typeof msg.data === 'object') {
        safeSend(relayWs, { type: 'agent_state', data: msg.data });

        const statusGuess = msg.data.state || msg.data.phase || msg.data.status;
        if (typeof statusGuess === 'string' && statusGuess.trim()) {
          safeSend(relayWs, { type: 'status', status: statusGuess.trim() });
        }
        return;
      }

      if (msg.type === 'video_frame' && typeof msg.data === 'string') {
        safeSend(relayWs, {
          type: 'video_frame',
          data: msg.data,
          mime: typeof msg.mime === 'string' ? msg.mime : 'image/jpeg',
          width: Number(msg.width || 0) || undefined,
          height: Number(msg.height || 0) || undefined,
          ts: msg.ts || Date.now(),
        });
        return;
      }

      if (typeof msg.status === 'string') safeSend(relayWs, { type: 'status', status: msg.status });
      if (typeof msg.message === 'string') {
        safeSend(relayWs, { type: 'message', message: msg.message });
        return;
      }
      if (typeof msg.content === 'string') {
        safeSend(relayWs, { type: 'message', message: msg.content });
        return;
      }
      safeSend(relayWs, { type: 'message', message: raw });
    } catch {
      safeSend(relayWs, { type: 'message', message: raw });
    }
  });

  localWs.on('close', (code) => {
    log('local', `closed (${code})`);
    localWs = null;
    safeSend(relayWs, { type: 'message', message: 'Local Civ6 agent disconnected' });
    safeSend(relayWs, { type: 'status', status: 'Idle' });
    if (!localTimer) {
      localTimer = setTimeout(() => {
        localTimer = null;
        connectLocal();
      }, 2000);
    }
  });

  localWs.on('error', (err) => {
    log('local', `error: ${err.message}`);
  });
}

connectRelay();
connectLocal();

if (process.stdin.isTTY) {
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  log('pair', "manual QR refresh: type 'r' (or 'qr') then Enter");
  process.stdin.on('data', (chunk) => {
    const cmd = String(chunk || '').trim().toLowerCase();
    if (cmd === 'r' || cmd === 'qr' || cmd === 'refresh') {
      requestPairQr();
      return;
    }
    if (cmd) {
      log('pair', `unknown command: ${cmd} (use 'r' to refresh QR)`);
    }
  });
}
