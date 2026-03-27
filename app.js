(function () {
  const TOKEN_KEY = 'civ_device_token';
  const WS_URL_KEY = 'civ_ws_url';
  const DISCUSSION_LANG_KEY = 'civ_discussion_lang';
  const state = {
    socket: null,
    reconnectTimer: null,
    manuallyClosed: true,
    isListening: false,
    isAuthed: false,
    qrPairTokenFromUrl: '',
    frameCount: 0,
    lastFrameAt: 0,
    lastNoFrameWarnAt: 0,
    wsMessageCount: 0,
    lastSuggestion: '',
    discussionPending: false,
    discussionTypingEl: null,
    liveViewVisible: false,
    discussionPanelVisible: false,
    supportBayVisible: false,
    openDrawer: '',
    voiceRecognition: null,
    voiceRequested: false,
    voiceRestartTimer: null,
    voiceBaseValue: '',
    voiceCommittedTranscript: '',
    voiceFinalTranscript: '',
    voiceInterimTranscript: '',
    voiceResultOffset: 0,
    voiceResultCount: 0,
    voiceIdleTimer: null,
    voiceStopReason: 'manual',
  };

  const ui = {
    wsUrl: document.getElementById('wsUrl'),
    connectBtn: document.getElementById('connectBtn'),
    forgetBtn: document.getElementById('forgetBtn'),
    connectionBadge: document.getElementById('connectionBadge'),
    agentStatus: document.getElementById('agentStatus'),
    statusDot: document.getElementById('statusDot'),
    controlTabBtn: document.getElementById('controlTabBtn'),
    discussionTabBtn: document.getElementById('discussionTabBtn'),
    workspaceShell: document.getElementById('workspaceShell'),
    coreColumn: document.getElementById('coreColumn'),
    liveView: document.getElementById('liveView'),
    liveMeta: document.getElementById('liveMeta'),
    liveSection: document.getElementById('liveSection'),
    tvToggleLabel: document.getElementById('tvToggleLabel'),
    voiceStateBadge: document.getElementById('voiceStateBadge'),
    startAgentBtn: document.getElementById('startAgentBtn'),
    stopAgentBtn: document.getElementById('stopAgentBtn'),
    commandInput: document.getElementById('commandInput'),
    sendBtn: document.getElementById('sendBtn'),
    voiceBtn: document.getElementById('voiceBtn'),
    voiceBtnLabel: document.getElementById('voiceBtnLabel'),
    tvToggleBtn: document.getElementById('tvToggleBtn'),
    discussionToggleBtn: document.getElementById('discussionToggleBtn'),
    discussionPanel: document.getElementById('discussionPanel'),
    discussionCloseBtn: document.getElementById('discussionCloseBtn'),
    supportToggleBtn: document.getElementById('supportToggleBtn'),
    supportBay: document.getElementById('supportBay'),
    guideDrawerBtn: document.getElementById('guideDrawerBtn'),
    systemDrawerBtn: document.getElementById('systemDrawerBtn'),
    guideDrawer: document.getElementById('guideDrawer'),
    systemDrawer: document.getElementById('systemDrawer'),
    voiceHint: document.getElementById('voiceHint'),
    discussionLanguage: document.getElementById('discussionLanguage'),
    discussionStatus: document.getElementById('discussionStatus'),
    discussionChat: document.getElementById('discussionChat'),
    discussionInput: document.getElementById('discussionInput'),
    discussionSendBtn: document.getElementById('discussionSendBtn'),
    discussionUseBtn: document.getElementById('discussionUseBtn'),
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
    autoResizeCommandInput();
    autoResizeDiscussionInput();
    updateVoiceButtonState();
    setVoiceStatus('MIC OFF', 'muted', getVoiceStopHint());
    setLiveViewVisible(false);
    setOpenDrawer('');
    setDiscussionPanelVisible(false);
    setSupportBayVisible(false);
    startDebugMonitors();
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
    ui.tvToggleBtn.addEventListener('click', toggleLiveView);
    ui.controlTabBtn.addEventListener('click', () => setDiscussionPanelVisible(false));
    ui.discussionTabBtn.addEventListener('click', () => setDiscussionPanelVisible(true));
    ui.discussionToggleBtn.addEventListener('click', toggleDiscussionPanel);
    ui.discussionCloseBtn.addEventListener('click', () => setDiscussionPanelVisible(false));
    ui.supportToggleBtn.addEventListener('click', toggleSupportBay);
    ui.guideDrawerBtn.addEventListener('click', () => toggleDrawer('guide'));
    ui.systemDrawerBtn.addEventListener('click', () => toggleDrawer('system'));
    document.querySelectorAll('[data-drawer-close]').forEach((button) => {
      button.addEventListener('click', () => setOpenDrawer(''));
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.openDrawer) {
        setOpenDrawer('');
        return;
      }
      if (event.key === 'Escape' && state.discussionPanelVisible) {
        setDiscussionPanelVisible(false);
        return;
      }
      if (event.key === 'Escape' && state.supportBayVisible) {
        setSupportBayVisible(false);
      }
    });
    ui.commandInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendCurrentInput();
      }
    });
    ui.commandInput.addEventListener('input', handleCommandInput);

    ui.voiceBtn.addEventListener('click', toggleVoiceInput);
    ui.discussionSendBtn.addEventListener('click', handleDiscussionSend);
    ui.discussionUseBtn.addEventListener('click', useLastSuggestion);
    ui.discussionLanguage.addEventListener('change', () => {
      localStorage.setItem(DISCUSSION_LANG_KEY, ui.discussionLanguage.value);
      setDiscussionStatus(`Language set: ${ui.discussionLanguage.value}`);
    });
    ui.discussionInput.addEventListener('input', autoResizeDiscussionInput);
    ui.discussionInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handleDiscussionSend();
      }
    });
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
    ui.discussionLanguage.value = localStorage.getItem(DISCUSSION_LANG_KEY) || 'ko';
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
    state.wsMessageCount += 1;
    if (parsed.type) {
      console.debug(`[ws] type=${parsed.type}`);
    } else {
      console.debug('[ws] message without type');
    }

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

    if (parsed.type === 'discussion_answer') {
      setDiscussionPending(false);
      const answer = typeof parsed.answer === 'string' ? parsed.answer : '';
      if (answer) {
        state.lastSuggestion = answer;
        discussionAddMessage('assistant', answer);
        setDiscussionStatus('LLM response received.');
      } else {
        setDiscussionStatus('LLM returned empty response.');
      }
      return;
    }

    if (parsed.type === 'discussion_error' || parsed.type === 'discussion_answer_error') {
      setDiscussionPending(false);
      setDiscussionStatus(parsed.message || 'Discussion error');
      return;
    }

    if (parsed.type === 'video_frame') {
      renderVideoFrame(parsed);
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
    resetVoiceTranscript(ui.commandInput.value);
    autoResizeCommandInput();
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

  function handleDiscussionSend() {
    const text = ui.discussionInput.value.trim();
    if (!text) return;
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.isAuthed) {
      setDiscussionStatus('Connect first to discuss.');
      return;
    }
    discussionAddMessage('user', text);
    setDiscussionPending(true);
    setDiscussionStatus('Asking LLM...');
    state.socket.send(
      JSON.stringify({
        type: 'discussion_query',
        query: text,
        language: ui.discussionLanguage.value,
      }),
    );
    ui.discussionInput.value = '';
    autoResizeDiscussionInput();
  }

  function useLastSuggestion() {
    if (!state.lastSuggestion) {
      setDiscussionStatus('No suggestion yet.');
      return;
    }
    ui.commandInput.value = state.lastSuggestion;
    syncVoiceBaseToInput();
    autoResizeCommandInput();
    setDiscussionStatus('Suggestion copied to Command.');
  }

  function discussionAddMessage(role, text) {
    const row = document.createElement('div');
    row.className = `mb-2 flex ${role === 'user' ? 'justify-end' : 'justify-start'}`;

    const bubble = document.createElement('div');
    bubble.className =
      role === 'user'
        ? 'max-w-[88%] rounded-2xl rounded-br-md border border-emerald-300/35 bg-emerald-500/15 px-3 py-2 text-slate-100'
        : 'max-w-[88%] rounded-2xl rounded-bl-md border border-amber-300/30 bg-amber-500/10 px-3 py-2 text-slate-100';

    const header = document.createElement('div');
    header.className = role === 'user' ? 'mb-1 text-[10px] font-semibold text-emerald-300' : 'mb-1 text-[10px] font-semibold text-amber-300';
    header.textContent = role === 'user' ? 'YOU' : 'ASSISTANT';
    bubble.appendChild(header);

    const body = document.createElement('div');
    body.className = 'md-content break-words text-xs leading-relaxed';

    if (role === 'assistant') {
      const view = buildAssistantView(text);
      body.innerHTML = renderDiscussionMarkdown(view.shortText);
      bubble.appendChild(body);
      if (view.truncated) {
        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'mt-2 rounded-md border border-amber-300/35 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-200';
        moreBtn.textContent = 'More';
        moreBtn.dataset.expanded = 'false';
        moreBtn.addEventListener('click', () => {
          const expanded = moreBtn.dataset.expanded === 'true';
          if (expanded) {
            body.innerHTML = renderDiscussionMarkdown(view.shortText);
            moreBtn.textContent = 'More';
            moreBtn.dataset.expanded = 'false';
          } else {
            body.innerHTML = renderDiscussionMarkdown(view.fullText);
            moreBtn.textContent = 'Less';
            moreBtn.dataset.expanded = 'true';
          }
        });
        bubble.appendChild(moreBtn);
      }
    } else {
      body.className = 'whitespace-pre-wrap break-words text-xs leading-relaxed';
      body.textContent = text;
      bubble.appendChild(body);
    }

    row.appendChild(bubble);
    ui.discussionChat.appendChild(row);
    ui.discussionChat.scrollTop = ui.discussionChat.scrollHeight;
  }

  function buildAssistantView(text) {
    const fullText = normalizeText(text);
    const lines = fullText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const units =
      lines.length > 1
        ? lines
        : fullText
            .split(/(?<=[.!?])\s+/)
            .map((part) => part.trim())
            .filter(Boolean);

    const shortUnits = units.slice(0, 4).map((line) => shortenLine(line, 120));
    const shortText = shortUnits.join('\n');
    const truncated = units.length > 4 || fullText.length > 520;

    return {
      fullText,
      shortText: shortText || shortenLine(fullText, 220),
      truncated,
    };
  }

  function normalizeText(text) {
    return String(text || '')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  function shortenLine(line, maxLen) {
    if (!line || line.length <= maxLen) return line;
    return `${line.slice(0, maxLen - 3).trimEnd()}...`;
  }

  function renderDiscussionMarkdown(input) {
    const text = normalizeText(input);
    if (!text) return '';

    const codeBlocks = [];
    let src = text.replace(/```([\s\S]*?)```/g, (_, rawCode) => {
      const token = `@@CODE_${codeBlocks.length}@@`;
      codeBlocks.push(rawCode.replace(/^\n+|\n+$/g, ''));
      return token;
    });

    const lines = src.split('\n');
    const out = [];
    let inUl = false;
    let inOl = false;

    const closeLists = () => {
      if (inUl) {
        out.push('</ul>');
        inUl = false;
      }
      if (inOl) {
        out.push('</ol>');
        inOl = false;
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        closeLists();
        continue;
      }

      const ul = line.match(/^[-*]\s+(.*)$/);
      if (ul) {
        if (inOl) {
          out.push('</ol>');
          inOl = false;
        }
        if (!inUl) {
          out.push('<ul>');
          inUl = true;
        }
        out.push(`<li>${renderInlineMarkdown(ul[1])}</li>`);
        continue;
      }

      const ol = line.match(/^\d+\.\s+(.*)$/);
      if (ol) {
        if (inUl) {
          out.push('</ul>');
          inUl = false;
        }
        if (!inOl) {
          out.push('<ol>');
          inOl = true;
        }
        out.push(`<li>${renderInlineMarkdown(ol[1])}</li>`);
        continue;
      }

      closeLists();

      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        out.push(`<h${level}>${renderInlineMarkdown(h[2])}</h${level}>`);
        continue;
      }

      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        out.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
        continue;
      }

      if (/^@@CODE_\d+@@$/.test(line)) {
        out.push(`<pre><code>${line}</code></pre>`);
        continue;
      }

      out.push(`<p>${renderInlineMarkdown(line)}</p>`);
    }
    closeLists();

    let html = out.join('');
    html = html.replace(/@@CODE_(\d+)@@/g, (_, i) => escapeHtml(codeBlocks[Number(i)] || ''));
    return html;
  }

  function renderInlineMarkdown(text) {
    let html = escapeHtml(text || '');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
      const safe = sanitizeUrl(url);
      if (!safe) return label;
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    return html;
  }

  function sanitizeUrl(url) {
    try {
      const value = String(url || '').trim();
      const parsed = new URL(value);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return escapeHtml(value);
    } catch {}
    return '';
  }

  function setDiscussionPending(pending) {
    state.discussionPending = pending;
    ui.discussionSendBtn.disabled = pending;
    if (pending) {
      addDiscussionTyping();
      return;
    }
    removeDiscussionTyping();
  }

  function addDiscussionTyping() {
    removeDiscussionTyping();
    const row = document.createElement('div');
    row.className = 'mb-2 flex justify-start';

    const bubble = document.createElement('div');
    bubble.className =
      'max-w-[75%] rounded-2xl rounded-bl-md border border-amber-300/30 bg-amber-500/10 px-3 py-2 text-slate-200';
    bubble.textContent = 'Assistant is thinking...';

    row.appendChild(bubble);
    ui.discussionChat.appendChild(row);
    state.discussionTypingEl = row;
    ui.discussionChat.scrollTop = ui.discussionChat.scrollHeight;
  }

  function removeDiscussionTyping() {
    if (state.discussionTypingEl && state.discussionTypingEl.parentNode) {
      state.discussionTypingEl.parentNode.removeChild(state.discussionTypingEl);
    }
    state.discussionTypingEl = null;
  }

  function setDiscussionStatus(text) {
    ui.discussionStatus.textContent = text;
  }

  function renderVideoFrame(payload) {
    const mime = typeof payload.mime === 'string' ? payload.mime : 'image/jpeg';
    const base64Data = typeof payload.data === 'string' ? payload.data : '';
    if (!base64Data) return;

    const src = base64Data.startsWith('data:') ? base64Data : `data:${mime};base64,${base64Data}`;
    ui.liveView.src = src;

    const now = Date.now();
    state.frameCount += 1;
    let fpsText = '';
    if (state.lastFrameAt > 0) {
      const dt = now - state.lastFrameAt;
      if (dt > 0) fpsText = `${(1000 / dt).toFixed(1)} fps`;
    }
    state.lastFrameAt = now;

    const sizeText = payload.width && payload.height ? `${payload.width}x${payload.height}` : '';
    ui.liveMeta.textContent = [fpsText, sizeText, `frames:${state.frameCount}`].filter(Boolean).join(' | ') || 'Streaming';
  }

  function autoResizeTextarea(element, minHeight, maxHeight) {
    if (!element) return;
    element.style.height = 'auto';
    const next = Math.max(minHeight, Math.min(element.scrollHeight, maxHeight));
    element.style.height = `${next}px`;
  }

  function autoResizeCommandInput() {
    autoResizeTextarea(ui.commandInput, 52, 220);
  }

  function autoResizeDiscussionInput() {
    autoResizeTextarea(ui.discussionInput, 52, 168);
  }

  function handleCommandInput() {
    autoResizeCommandInput();
    if (!state.voiceRequested) return;
    syncVoiceBaseToInput();
  }

  function syncVoiceBaseToInput() {
    resetVoiceTranscript(ui.commandInput.value, state.voiceRequested);
  }

  function resetVoiceTranscript(baseValue = '', preserveSession = false) {
    state.voiceBaseValue = baseValue;
    state.voiceCommittedTranscript = '';
    state.voiceFinalTranscript = '';
    state.voiceInterimTranscript = '';
    if (preserveSession) {
      state.voiceResultOffset = state.voiceResultCount;
      return;
    }
    state.voiceResultOffset = 0;
    state.voiceResultCount = 0;
  }

  function commitVoiceTranscript() {
    state.voiceCommittedTranscript += state.voiceFinalTranscript;
    state.voiceFinalTranscript = '';
    state.voiceInterimTranscript = '';
    state.voiceResultOffset = 0;
    state.voiceResultCount = 0;
  }

  function joinVoiceInput(baseValue, transcript) {
    const base = String(baseValue || '');
    const spoken = String(transcript || '');
    if (!base) return spoken.trim();
    if (!spoken) return base;
    const needsSpacer = !/\s$/.test(base) && !/^[\s,.!?]/.test(spoken);
    return `${base}${needsSpacer ? ' ' : ''}${spoken.trimStart()}`;
  }

  function renderVoiceTranscript() {
    const transcript = `${state.voiceCommittedTranscript}${state.voiceFinalTranscript}${state.voiceInterimTranscript}`;
    ui.commandInput.value = joinVoiceInput(state.voiceBaseValue, transcript);
    autoResizeCommandInput();
  }

  function setLiveViewVisible(visible) {
    state.liveViewVisible = Boolean(visible);
    ui.liveSection.hidden = !state.liveViewVisible;
    ui.coreColumn.classList.toggle('has-live', state.liveViewVisible);
    if (ui.tvToggleLabel) {
      ui.tvToggleLabel.textContent = state.liveViewVisible ? 'ON' : 'OFF';
    }
    ui.tvToggleBtn.setAttribute('aria-pressed', state.liveViewVisible ? 'true' : 'false');
    ui.tvToggleBtn.classList.toggle('is-active', state.liveViewVisible);
    ui.tvToggleBtn.setAttribute('aria-label', state.liveViewVisible ? '스트리밍 끄기' : '스트리밍 켜기');
    ui.tvToggleBtn.title = state.liveViewVisible ? '스트리밍 끄기' : '스트리밍 켜기';
  }

  function toggleLiveView() {
    setLiveViewVisible(!state.liveViewVisible);
  }

  function setSupportBayVisible(visible) {
    state.supportBayVisible = Boolean(visible);
    if (!state.supportBayVisible) {
      setOpenDrawer('');
    }
    ui.supportBay.hidden = !state.supportBayVisible;
    ui.supportBay.classList.toggle('is-open', state.supportBayVisible);
    ui.supportToggleBtn.classList.toggle('is-active', state.supportBayVisible);
    ui.supportToggleBtn.setAttribute('aria-expanded', state.supportBayVisible ? 'true' : 'false');
    ui.supportToggleBtn.setAttribute('aria-label', state.supportBayVisible ? '보조 메뉴 닫기' : '보조 메뉴 열기');
    ui.supportToggleBtn.title = state.supportBayVisible ? '보조 메뉴 닫기' : '보조 메뉴 열기';
  }

  function toggleSupportBay() {
    setSupportBayVisible(!state.supportBayVisible);
  }

  function setDiscussionPanelVisible(visible) {
    state.discussionPanelVisible = Boolean(visible);
    ui.discussionPanel.hidden = !state.discussionPanelVisible;
    ui.discussionPanel.classList.toggle('is-open', state.discussionPanelVisible);
    ui.discussionToggleBtn.classList.toggle('is-active', state.discussionPanelVisible);
    ui.discussionToggleBtn.setAttribute('aria-expanded', state.discussionPanelVisible ? 'true' : 'false');
    ui.controlTabBtn.classList.toggle('is-active', !state.discussionPanelVisible);
    ui.discussionTabBtn.classList.toggle('is-active', state.discussionPanelVisible);
    ui.workspaceShell.classList.toggle('has-discussion', state.discussionPanelVisible);
    if (state.discussionPanelVisible) {
      setDiscussionStatus(`Ready to discuss with server LLM (${ui.discussionLanguage.value}).`);
    }
  }

  function toggleDiscussionPanel() {
    setDiscussionPanelVisible(!state.discussionPanelVisible);
  }

  function setOpenDrawer(name) {
    state.openDrawer = name;

    const isGuideOpen = name === 'guide';
    const isSystemOpen = name === 'system';

    ui.guideDrawer.classList.toggle('is-open', isGuideOpen);
    ui.systemDrawer.classList.toggle('is-open', isSystemOpen);
    ui.guideDrawer.hidden = !isGuideOpen;
    ui.systemDrawer.hidden = !isSystemOpen;

    ui.guideDrawerBtn.classList.toggle('is-active', isGuideOpen);
    ui.systemDrawerBtn.classList.toggle('is-active', isSystemOpen);

    ui.guideDrawerBtn.setAttribute('aria-pressed', isGuideOpen ? 'true' : 'false');
    ui.systemDrawerBtn.setAttribute('aria-pressed', isSystemOpen ? 'true' : 'false');
    ui.guideDrawerBtn.setAttribute('aria-expanded', isGuideOpen ? 'true' : 'false');
    ui.systemDrawerBtn.setAttribute('aria-expanded', isSystemOpen ? 'true' : 'false');

    if (ui.supportBay) {
      ui.supportBay.classList.toggle('has-open-panel', Boolean(name));
      ui.supportBay.dataset.activePanel = name || 'none';
      if (name && window.matchMedia('(max-width: 960px)').matches) {
        ui.supportBay.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }

  function toggleDrawer(name) {
    if (!state.supportBayVisible) {
      setSupportBayVisible(true);
    }
    if (state.openDrawer === name) {
      setOpenDrawer('');
      return;
    }
    setOpenDrawer(name);
  }

  function updateVoiceButtonState() {
    const active = state.voiceRequested;
    ui.voiceBtn.classList.toggle('live-ring', active);
    ui.voiceBtn.classList.toggle('is-recording', active);
    if (ui.voiceBtnLabel) {
      ui.voiceBtnLabel.textContent = active ? 'STOP' : 'MIC';
    } else {
      ui.voiceBtn.textContent = active ? 'STOP' : 'MIC';
    }
    ui.voiceBtn.setAttribute('aria-label', active ? '실시간 음성 입력 중지' : '실시간 음성 입력 시작');
    ui.voiceBtn.title = active ? '실시간 음성 입력 중지' : '실시간 음성 입력 시작';
  }

  function setVoiceStatus(badgeText, tone = 'muted', hintText = '') {
    if (ui.voiceStateBadge) {
      ui.voiceStateBadge.textContent = badgeText;
      ui.voiceStateBadge.classList.toggle('is-active', tone === 'active');
      ui.voiceStateBadge.classList.toggle('is-muted', tone === 'muted');
      ui.voiceStateBadge.classList.toggle('is-warm', tone === 'warm');
      ui.voiceStateBadge.classList.toggle('is-danger', tone === 'danger');
    }
    if (ui.voiceHint) {
      ui.voiceHint.textContent = hintText || badgeText;
    }
  }

  function clearVoiceIdleTimer() {
    if (!state.voiceIdleTimer) return;
    clearTimeout(state.voiceIdleTimer);
    state.voiceIdleTimer = null;
  }

  function scheduleVoiceIdleStop(delayMs) {
    clearVoiceIdleTimer();
    if (!state.voiceRequested) return;
    state.voiceIdleTimer = setTimeout(() => {
      state.voiceIdleTimer = null;
      if (!state.voiceRequested) return;
      stopVoiceRecognition('idle');
    }, delayMs);
  }

  function getVoiceStopHint() {
    if (state.voiceStopReason === 'idle') {
      return '말이 멈춰서 마이크를 자동 종료했습니다. 다시 말하려면 B 버튼을 누르세요.';
    }
    return '마이크 꺼짐. B 버튼을 누르면 실시간 입력이 시작됩니다.';
  }

  function clearVoiceRestartTimer() {
    if (!state.voiceRestartTimer) return;
    clearTimeout(state.voiceRestartTimer);
    state.voiceRestartTimer = null;
  }

  function ensureVoiceRecognition() {
    if (state.voiceRecognition) return state.voiceRecognition;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;

    const recognition = new SpeechRecognition();
    recognition.lang = 'ko-KR';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      state.isListening = true;
      state.voiceStopReason = '';
      updateVoiceButtonState();
      scheduleVoiceIdleStop(4500);
      setVoiceStatus('MIC LIVE', 'active', '실시간 입력 중입니다. 말이 멈추면 마이크가 자동 종료됩니다.');
    };

    recognition.onresult = (event) => {
      if (state.voiceResultOffset > event.results.length) {
        state.voiceResultOffset = 0;
      }

      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = state.voiceResultOffset; i < event.results.length; i += 1) {
        const segment = event.results[i][0]?.transcript || '';
        if (event.results[i].isFinal) {
          finalTranscript += segment;
        } else {
          interimTranscript += segment;
        }
      }

      state.voiceResultCount = event.results.length;
      state.voiceFinalTranscript = finalTranscript;
      state.voiceInterimTranscript = interimTranscript;
      renderVoiceTranscript();
      scheduleVoiceIdleStop(2200);
      setVoiceStatus('MIC LIVE', 'active', '실시간 입력 중입니다. 말이 멈추면 마이크가 자동 종료됩니다.');
    };

    recognition.onerror = (event) => {
      const error = event.error || 'unknown';
      if (error === 'aborted' && !state.voiceRequested) return;
      clearVoiceIdleTimer();

      if (error === 'not-allowed' || error === 'service-not-allowed' || error === 'audio-capture') {
        state.voiceRequested = false;
        clearVoiceRestartTimer();
      }

      updateVoiceButtonState();
      setVoiceStatus('MIC ERR', 'danger', `마이크 오류: ${error}`);
      log('error', `Voice input error: ${error}`);
    };

    recognition.onend = () => {
      state.isListening = false;
      clearVoiceIdleTimer();
      commitVoiceTranscript();
      renderVoiceTranscript();

      if (state.voiceRequested) {
        setVoiceStatus('MIC RETRY', 'warm', '마이크를 다시 연결하는 중입니다. 계속 말하면 입력이 이어집니다.');
        clearVoiceRestartTimer();
        state.voiceRestartTimer = setTimeout(() => {
          state.voiceRestartTimer = null;
          if (!state.voiceRequested || state.isListening) return;
          startVoiceRecognition();
        }, 200);
        return;
      }

      updateVoiceButtonState();
      setVoiceStatus('MIC OFF', 'muted', getVoiceStopHint());
    };

    state.voiceRecognition = recognition;
    return recognition;
  }

  function startVoiceRecognition() {
    const recognition = ensureVoiceRecognition();
    if (!recognition) {
      state.voiceRequested = false;
      updateVoiceButtonState();
      setVoiceStatus('MIC N/A', 'danger', '현재 브라우저는 음성 인식을 지원하지 않습니다.');
      log('error', 'Web Speech API unavailable');
      return;
    }

    try {
      recognition.start();
    } catch (error) {
      if (error && error.name === 'InvalidStateError') return;
      state.voiceRequested = false;
      updateVoiceButtonState();
      setVoiceStatus('MIC ERR', 'danger', `마이크 오류: ${error.message}`);
      log('error', `Voice input start failed: ${error.message}`);
    }
  }

  function stopVoiceRecognition(reason = 'manual') {
    state.voiceStopReason = reason;
    state.voiceRequested = false;
    clearVoiceRestartTimer();
    clearVoiceIdleTimer();
    updateVoiceButtonState();

    if (!state.voiceRecognition || !state.isListening) {
      setVoiceStatus('MIC OFF', 'muted', getVoiceStopHint());
      return;
    }

    try {
      state.voiceRecognition.stop();
    } catch (error) {
      setVoiceStatus('MIC ERR', 'danger', `마이크 오류: ${error.message}`);
      log('error', `Voice input stop failed: ${error.message}`);
    }
  }

  function startDebugMonitors() {
    setInterval(() => {
      const now = Date.now();
      const msSinceFrame = state.lastFrameAt > 0 ? now - state.lastFrameAt : -1;

      if (msSinceFrame > 5000 && now - state.lastNoFrameWarnAt > 5000) {
        state.lastNoFrameWarnAt = now;
        console.warn(`[video] no frame for ${msSinceFrame}ms`);
      }

      console.debug(
        `[debug] ws_messages=${state.wsMessageCount} frames=${state.frameCount} last_frame_ms=${msSinceFrame}`,
      );
    }, 5000);
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
    ui.connectionBadge.className = `hud-chip rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${classNames}`;
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
    if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
      setVoiceStatus('MIC N/A', 'danger', '현재 브라우저는 음성 인식을 지원하지 않습니다.');
      log('error', 'Web Speech API unavailable');
      return;
    }

    if (state.voiceRequested) {
      stopVoiceRecognition('manual');
      return;
    }

    state.voiceRequested = true;
    state.voiceStopReason = '';
    resetVoiceTranscript(ui.commandInput.value);
    updateVoiceButtonState();
    setVoiceStatus('MIC ARM', 'warm', '마이크 준비 중... 잠시 후 바로 실시간 입력이 시작됩니다.');
    startVoiceRecognition();
  }

  init();
})();
