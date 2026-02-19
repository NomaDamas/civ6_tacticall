(function () {
  const TOKEN_KEY = 'civ_device_token';
  const WS_URL_KEY = 'civ_ws_url';
  const state = {
    socket: null,
    reconnectTimer: null,
    manuallyClosed: true,
    isListening: false,
    isAuthed: false,
    qrPairTokenFromUrl: '',
  };

  const ui = {
    wsUrl: document.getElementById('wsUrl'),
    connectBtn: document.getElementById('connectBtn'),
    forgetBtn: document.getElementById('forgetBtn'),
    connectionBadge: document.getElementById('connectionBadge'),
    agentStatus: document.getElementById('agentStatus'),
    statusDot: document.getElementById('statusDot'),
    startAgentBtn: document.getElementById('startAgentBtn'),
    stopAgentBtn: document.getElementById('stopAgentBtn'),
    commandInput: document.getElementById('commandInput'),
    sendBtn: document.getElementById('sendBtn'),
    voiceBtn: document.getElementById('voiceBtn'),
    voiceHint: document.getElementById('voiceHint'),
    agentStateView: document.getElementById('agentStateView'),
    logs: document.getElementById('logs'),
    clearLogsBtn: document.getElementById('clearLogsBtn'),
  };

  const STATUS_COLOR = {
    Idle: 'bg-amber-400',
    Reasoning: 'bg-sky-400',
    'Executing Action': 'bg-emerald-400',
    'Waiting for User': 'bg-violet-400',
  };

  function init() {
    loadSavedConfig();
    bindEvents();
    renderAgentState({});
    connect();
    log('system', 'Controller initialized');
  }

  function bindEvents() {
    ui.connectBtn.addEventListener('click', () => {
      if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.manuallyClosed = true;
        state.socket.close(1000, 'Manual disconnect');
        return;
      }
      connect();
    });

    ui.forgetBtn.addEventListener('click', () => {
      localStorage.removeItem(TOKEN_KEY);
      state.qrPairTokenFromUrl = '';
      log('system', 'Saved login removed. Pair again to login.');
    });

    ui.sendBtn.addEventListener('click', sendCurrentInput);
    ui.startAgentBtn.addEventListener('click', () => sendControl('start'));
    ui.stopAgentBtn.addEventListener('click', () => sendControl('stop'));
    ui.commandInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendCurrentInput();
      }
    });

    ui.voiceBtn.addEventListener('click', toggleVoiceInput);
    ui.clearLogsBtn.addEventListener('click', () => {
      ui.logs.innerHTML = '';
      log('system', 'Logs cleared');
    });
  }

  function defaultWsUrl() {
    const isSecurePage = location.protocol === 'https:';
    const proto = isSecurePage ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function loadSavedConfig() {
    ui.wsUrl.value = localStorage.getItem(WS_URL_KEY) || defaultWsUrl();
    const params = new URLSearchParams(location.search);
    const pair = params.get('pair');
    const ws = params.get('ws');
    if (ws && /^wss?:\/\//i.test(ws)) {
      ui.wsUrl.value = ws;
    }
    if (pair) {
      state.qrPairTokenFromUrl = pair.trim();
      log('system', 'QR pair token detected from URL');
    }
  }

  function validateConfig() {
    const url = ui.wsUrl.value.trim();
    if (!/^wss?:\/\//i.test(url)) {
      log('error', 'WebSocket URL must start with ws:// or wss://');
      return null;
    }
    return { url };
  }

  function connect() {
    const cfg = validateConfig();
    if (!cfg) return;

    localStorage.setItem(WS_URL_KEY, cfg.url);
    cleanupSocket();
    state.manuallyClosed = false;
    state.isAuthed = false;
    updateConnectionBadge('Connecting', 'border-warning/60 text-warning');

    const token = localStorage.getItem(TOKEN_KEY);
    const qrPairToken = state.qrPairTokenFromUrl;
    if (!token && !qrPairToken) {
      log('error', 'No saved login. Scan the QR from host PC first.');
      updateConnectionBadge('Scan QR First', 'border-warning/60 text-warning');
      return;
    }

    try {
      const ws = new WebSocket(cfg.url);
      state.socket = ws;

      ws.onopen = () => {
        ui.connectBtn.textContent = 'Disconnect';
        updateConnectionBadge('Authenticating', 'border-warning/60 text-warning');
        if (qrPairToken) {
          ws.send(JSON.stringify({ type: 'qr_pair_login', pairToken: qrPairToken }));
        } else if (token) {
          ws.send(JSON.stringify({ type: 'token_login', token }));
        }
      };

      ws.onmessage = (event) => handleIncomingMessage(event.data);
      ws.onerror = () => log('error', 'WebSocket encountered an error');

      ws.onclose = (event) => {
        state.isAuthed = false;
        updateConnectionBadge('Disconnected', 'border-slate-500/60 text-slate-300');
        ui.connectBtn.textContent = 'Connect';
        log('system', `Socket closed (${event.code})`);
        if (!state.manuallyClosed) scheduleReconnect();
      };
    } catch (error) {
      log('error', `Connection failed: ${error.message}`);
      scheduleReconnect();
    }
  }

  function cleanupSocket() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.socket) {
      state.socket.onopen = null;
      state.socket.onmessage = null;
      state.socket.onerror = null;
      state.socket.onclose = null;
      if (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING) {
        state.socket.close(1000, 'Reconnecting');
      }
      state.socket = null;
    }
    ui.connectBtn.textContent = 'Connect';
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    updateConnectionBadge('Retrying...', 'border-warning/60 text-warning');
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, 2000);
  }

  function handleIncomingMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log('agent', String(raw));
      return;
    }

    if (!parsed || typeof parsed !== 'object') return;

    if (parsed.type === 'auth_ok') {
      state.isAuthed = true;
      if (typeof parsed.token === 'string' && parsed.token) {
        localStorage.setItem(TOKEN_KEY, parsed.token);
      }
      if (parsed.method === 'qr_pair') {
        state.qrPairTokenFromUrl = '';
        const url = new URL(location.href);
        url.searchParams.delete('pair');
        history.replaceState({}, '', url.toString());
      }
      updateConnectionBadge('Connected', 'border-accent/60 text-accent');
      log('system', parsed.method === 'qr_pair' ? 'Paired via QR and logged in' : 'Auto login success');
      return;
    }

    if (parsed.type === 'auth_error') {
      state.isAuthed = false;
      const message = parsed.message || 'Authentication failed';
      if (parsed.code === 'invalid_token') {
        localStorage.removeItem(TOKEN_KEY);
      }
      updateConnectionBadge('Auth Failed', 'border-danger/60 text-danger');
      log('error', message);
      return;
    }

    if (parsed.type === 'status' && typeof parsed.status === 'string') {
      setAgentStatus(parsed.status);
      log('agent', `Status: ${parsed.status}`);
      return;
    }

    if (parsed.type === 'status' && parsed.data && typeof parsed.data === 'object') {
      renderAgentState(parsed.data);
      const statusText = inferStatusText(parsed.data);
      if (statusText) setAgentStatus(statusText);
      log('agent', 'State snapshot updated');
      return;
    }

    if (parsed.type === 'agent_state' && parsed.data && typeof parsed.data === 'object') {
      renderAgentState(parsed.data);
      const statusText = inferStatusText(parsed.data);
      if (statusText) setAgentStatus(statusText);
      log('agent', 'Agent state received');
      return;
    }

    if (parsed.type === 'message' && typeof parsed.message === 'string') {
      log('agent', parsed.message);
      return;
    }

    if (typeof parsed.status === 'string') setAgentStatus(parsed.status);
    if (typeof parsed.message === 'string') {
      log('agent', parsed.message);
      return;
    }
    if (typeof parsed.content === 'string') {
      log('agent', parsed.content);
      return;
    }

    log('agent', JSON.stringify(parsed));
  }

  function sendCurrentInput() {
    const text = ui.commandInput.value.trim();
    if (!text) {
      log('error', 'Cannot send an empty command');
      return;
    }

    if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.isAuthed) {
      log('error', 'Not connected to authenticated session');
      return;
    }

    state.socket.send(JSON.stringify({ type: 'command', content: text }));
    log('user', text);
    ui.commandInput.value = '';
    setAgentStatus('Waiting for User');
  }

  function sendControl(action) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.isAuthed) {
      log('error', 'Not connected to authenticated session');
      return;
    }
    state.socket.send(JSON.stringify({ type: 'control', action }));
    log('system', `Control sent: ${action}`);
  }

  function setAgentStatus(statusText) {
    ui.agentStatus.textContent = statusText;
    ui.statusDot.className = `h-2.5 w-2.5 rounded-full ${STATUS_COLOR[statusText] || 'bg-slate-400'}`;
  }

  function inferStatusText(data) {
    if (!data || typeof data !== 'object') return '';
    const candidates = [data.state, data.phase, data.status];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  function renderAgentState(snapshot) {
    try {
      ui.agentStateView.textContent = JSON.stringify(snapshot || {}, null, 2);
    } catch {
      ui.agentStateView.textContent = '{}';
    }
  }

  function log(kind, message) {
    const line = document.createElement('div');
    line.className = 'mb-1';
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    const tag = kind.toUpperCase();
    let color = 'text-slate-200';
    if (kind === 'system') color = 'text-cyan-300';
    if (kind === 'error') color = 'text-rose-300';
    if (kind === 'user') color = 'text-emerald-300';
    if (kind === 'agent') color = 'text-amber-300';
    line.innerHTML = `<span class="text-slate-500">[${ts}]</span> <span class="${color}">${tag}</span>: ${escapeHtml(message)}`;
    ui.logs.appendChild(line);
    ui.logs.scrollTop = ui.logs.scrollHeight;
  }

  function updateConnectionBadge(text, classNames) {
    ui.connectionBadge.textContent = text;
    ui.connectionBadge.className = `rounded-full border px-2 py-1 text-xs font-semibold ${classNames}`;
  }

  function escapeHtml(str) {
    return str
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function toggleVoiceInput() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      ui.voiceHint.textContent = 'Speech recognition is not supported on this browser.';
      log('error', 'Web Speech API unavailable');
      return;
    }

    if (state.isListening) {
      if (window.__civRecognition) window.__civRecognition.stop();
      return;
    }

    const recognition = new SpeechRecognition();
    window.__civRecognition = recognition;
    recognition.lang = 'ko-KR';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      state.isListening = true;
      ui.voiceBtn.classList.add('live-ring');
      ui.voiceHint.textContent = 'Listening...';
    };

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript;
      }
      ui.commandInput.value = transcript.trim();
      ui.voiceHint.textContent = 'Voice captured. Review and send.';
    };

    recognition.onerror = (event) => {
      ui.voiceHint.textContent = `Voice error: ${event.error}`;
      log('error', `Voice input error: ${event.error}`);
    };

    recognition.onend = () => {
      state.isListening = false;
      ui.voiceBtn.classList.remove('live-ring');
    };

    recognition.start();
  }

  init();
})();
