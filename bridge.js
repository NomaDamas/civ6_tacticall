const fs = require('fs');
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

const fileConfig = loadHostConfigFile();

const config = {
  relayUrl: readArg('relay', process.env.RELAY_URL || fileConfig.relayUrl || 'ws://localhost:8787/ws'),
  localAgentUrl: readArg('local', process.env.LOCAL_AGENT_URL || fileConfig.localAgentUrl || 'ws://localhost:8000/ws'),
  roomId: readArg('room', process.env.ROOM_ID || fileConfig.roomId || 'civ6-room'),
  hostKey: readArg('host-key', process.env.HOST_KEY || fileConfig.hostKey || ''),
  controllerBaseUrl: readArg(
    'controller-base-url',
    process.env.CONTROLLER_BASE_URL || fileConfig.controllerBaseUrl || guessControllerBaseUrl(fileConfig.relayUrl || process.env.RELAY_URL || 'ws://localhost:8787/ws'),
  ),
};

if (!config.hostKey) {
  console.error('hostKey is required. Set HOST_KEY, use --host-key, or create host-config.json.');
  process.exit(1);
}

let relayWs = null;
let localWs = null;
let relayTimer = null;
let localTimer = null;
let qrRefreshTimer = null;

function log(kind, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${kind}] ${msg}`);
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
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

function scheduleQrRefresh() {
  if (qrRefreshTimer) clearTimeout(qrRefreshTimer);
  qrRefreshTimer = setTimeout(() => {
    qrRefreshTimer = null;
    requestPairQr();
    scheduleQrRefresh();
  }, 90 * 1000);
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
      safeSend(relayWs, { type: 'status', status: 'Idle' });
      requestPairQr();
      scheduleQrRefresh();
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

    if (msg.type === 'message' && typeof msg.message === 'string') {
      log('relay', msg.message);
    }
  });

  relayWs.on('close', (code) => {
    log('relay', `closed (${code})`);
    relayWs = null;
    if (qrRefreshTimer) {
      clearTimeout(qrRefreshTimer);
      qrRefreshTimer = null;
    }
    if (!relayTimer) {
      relayTimer = setTimeout(() => {
        relayTimer = null;
        connectRelay();
      }, 2000);
    }
  });

  relayWs.on('error', (err) => {
    log('relay', `error: ${err.message}`);
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
