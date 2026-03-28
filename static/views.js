// T-Term — View modes, layouts, and pane management

// ══════════════════════════════════════════
//  View mode toggle (Terminal / Messenger)
// ══════════════════════════════════════════
function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('.view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === mode);
  });
  const paneArea = document.getElementById('pane-area');
  const messengerPane = document.getElementById('messengerPane');
  const splitView = document.getElementById('splitView');
  const sideTray = document.getElementById('sideTray');
  // Hide all first
  paneArea.style.display = 'none';
  messengerPane.classList.remove('active');
  splitView.classList.remove('active');
  if (sideTray) sideTray.style.display = 'none';

  if (mode === 'messenger') {
    messengerPane.classList.add('active');
    if (sideTray) sideTray.style.display = 'flex';
    renderMessenger();
  } else if (mode === 'split') {
    splitView.classList.add('active');
    if (sideTray) sideTray.style.display = 'flex';
    renderSplitView();
  } else {
    paneArea.style.display = '';
    setTimeout(() => {
      for (const sid of paneSlots) {
        if (sid && sessions[sid] && sessions[sid].fitAddon) {
          try { sessions[sid].fitAddon.fit(); } catch(e) {}
        }
      }
    }, 100);
  }
}

function renderSplitView() {
  const sv = document.getElementById('splitView');
  // Save scroll positions before destroying
  sv.querySelectorAll('.messenger-split-pane').forEach(p => {
    const chat = p.querySelector('.chat-messages');
    const psid = p.dataset.sessionId;
    if (chat && psid) savedScrollPositions[psid] = chat.scrollTop;
  });
  sv.innerHTML = '';
  const sid = activeSessionId || paneSlots[0];
  if (!sid || !sessions[sid]) return;
  const s = sessions[sid];

  // Left — messenger
  const left = document.createElement('div');
  left.className = 'split-messenger messenger-split-pane';
  left.dataset.sessionId = sid;
  const chatArea = document.createElement('div');
  chatArea.className = 'chat-messages';
  left.appendChild(chatArea);

  // Chat input
  const inputArea = document.createElement('div');
  inputArea.className = 'chat-input-area';
  inputArea.innerHTML = `
    <div class="chat-input-row">
      <textarea class="chat-textarea" placeholder="Send a message..." rows="1"></textarea>
      <button class="send-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
    </div>`;
  left.appendChild(inputArea);

  // Wire send
  const textarea = inputArea.querySelector('.chat-textarea');
  const sendBtn = inputArea.querySelector('.send-btn');
  const sendMsg = () => {
    const text = textarea.value.trim();
    const atts = pendingAttachments[sid] || [];
    const ws = s.ws;
    if (!text && atts.length === 0) {
      // Empty enter — send \r to submit whatever is in the terminal input line
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: '\r' }));
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      // Send pending attachments first
      if (atts.length > 0) {
        const paths = atts.map(a => a.path).join(' ');
        const combined = text ? text + ' ' + paths : paths;
        ws.send(JSON.stringify({ type: 'input', data: combined }));
        setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: '\r' })); }, Math.max(100, Math.min(combined.length * 2, 500)));
        clearAllAttachments(sid);
      } else {
        ws.send(JSON.stringify({ type: 'input', data: text }));
        const delay = Math.max(100, Math.min(text.length * 2, 500));
        setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: '\r' })); }, delay);
      }
    }
    if (sessions[sid]) { sessions[sid]._lastSendTime = Date.now(); sessions[sid].activeAgents = 0; sessions[sid].toolHistory = []; }
    if (text) addMessengerMessage(sid, 'user', text);
    showMessengerTyping(sid, true);
    textarea.value = '';
    textarea.style.height = '44px';
  };
  sendBtn.onclick = sendMsg;
  textarea.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
  textarea.addEventListener('input', () => { textarea.style.height = '44px'; if (textarea.scrollHeight > 44) textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px'; });
  // Paste image in split view
  textarea.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) uploadScreenshot(blob);
        return;
      }
    }
  });

  // Load history (only when server has confirmed JSONL attachment)
  if (sessions[sid] && sessions[sid]._jsonlSessionId && !messengerMessages[sid]) {
    loadConversationHistory(sid, chatArea);
  } else {
    for (const m of messengerMessages[sid]) {
      if (m.type === 'image') chatArea.appendChild(createImageBubble(m.role, m.blobUrl, m.time, null, m.ts));
      else chatArea.appendChild(createMsgBubble(m.role, m.text, m.time));
    }
    // Restore scroll: locked to bottom → snap to bottom, scrolled up → restore position
    setTimeout(() => {
      if (scrollLockedToBottom[sid] === false && savedScrollPositions[sid] !== undefined) {
        chatArea.scrollTop = savedScrollPositions[sid];
      } else {
        chatArea.scrollTop = chatArea.scrollHeight;
      }
    }, 50);
  }
  sv.appendChild(left);

  // Restore thinking indicator after pane is in DOM
  if (sessions[sid]?.isThinking) showMessengerTyping(sid, true, sessions[sid].toolHistory, sessions[sid].activeAgents);

  // Divider
  const divider = document.createElement('div');
  divider.className = 'split-divider';
  sv.appendChild(divider);

  // Right — terminal
  const right = document.createElement('div');
  right.className = 'split-terminal';
  s.container.style.display = 'flex';
  s.container.style.flex = '1';
  s.container.style.minHeight = '0';
  s.container.style.margin = '0';
  right.appendChild(s.container);
  sv.appendChild(right);

  setTimeout(() => { try { s.fitAddon.fit(); } catch(e) {} }, 100);
}

// ══════════════════════════════════════════
//  Pane layouts
// ══════════════════════════════════════════
function setLayout(newLayout) {
  layout = newLayout;
  document.querySelectorAll('.layout-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.layout === layout);
  });

  const paneCount = { single: 1, hsplit: 2, vsplit: 2, triple: 3, quad: 4 }[layout] || 1;
  // Ensure paneSlots has right length
  while (paneSlots.length < paneCount) paneSlots.push(null);
  paneSlots.length = paneCount;
  // Fill empty slots with open sessions
  const usedIds = new Set(paneSlots.filter(Boolean));
  const available = Object.keys(sessions).filter(id => !usedIds.has(id));
  for (let i = 0; i < paneSlots.length; i++) {
    if (!paneSlots[i] && available.length > 0) paneSlots[i] = available.shift();
  }
  // Make sure active session is in a slot
  if (activeSessionId && !paneSlots.includes(activeSessionId)) {
    paneSlots[0] = activeSessionId;
  }

  renderPanes();
  saveState();
}

function createPane(i, isMultiPane) {
  const pane = document.createElement('div');
  pane.className = 'pane' + (isMultiPane && i === selectedPane ? ' selected' : '');

  const sid = paneSlots[i];
  if (sid && sessions[sid]) {
    const s = sessions[sid];
    if (isMultiPane) {
      const label = document.createElement('div');
      label.className = 'pane-label';
      if (s.isShell) {
        label.innerHTML = s.name.toUpperCase() + ' <span style="color:var(--cyan);font-weight:700">SHELL</span>';
      } else {
        label.textContent = s.name.toUpperCase();
      }
      pane.appendChild(label);
    }
    s.container.style.display = 'flex';
    s.container.style.flex = '1';
    s.container.style.minHeight = '0';
    pane.appendChild(s.container);
    const paneIdx = i;
    pane.onclick = () => {
      selectedPane = paneIdx;
      activeSessionId = sid;
      document.querySelectorAll('.pane').forEach((p, j) => {
        p.classList.remove('selected');
        if (j === selectedPane && isMultiPane) p.classList.add('selected');
      });
      renderTabs();
      sessions[sid].term.focus();
    };
    setTimeout(() => s.fitAddon.fit(), 50);
  } else if (isMultiPane) {
    const paneIdx = i;
    pane.onclick = () => {
      selectedPane = paneIdx;
      document.querySelectorAll('.pane').forEach((p, j) => {
        p.classList.remove('selected');
        if (j === selectedPane) p.classList.add('selected');
      });
    };
  }
  return pane;
}

function renderPanes() {
  const area = document.getElementById('pane-area');
  area.className = 'pane-area layout-' + layout;
  area.innerHTML = '';

  const paneCount = { single: 1, hsplit: 2, vsplit: 2, triple: 3, quad: 4 }[layout] || 1;
  const isMultiPane = paneCount > 1;
  while (paneSlots.length < paneCount) paneSlots.push(null);
  if (selectedPane >= paneCount) selectedPane = 0;

  if (layout === 'triple') {
    // Left pane + right column with 2 stacked panes
    area.appendChild(createPane(0, true));
    const rightCol = document.createElement('div');
    rightCol.className = 'pane-right-col';
    rightCol.appendChild(createPane(1, true));
    rightCol.appendChild(createPane(2, true));
    area.appendChild(rightCol);
  } else if (layout === 'quad') {
    // 2 rows, 2 panes each
    const row1 = document.createElement('div');
    row1.className = 'pane-row';
    row1.appendChild(createPane(0, true));
    row1.appendChild(createPane(1, true));
    area.appendChild(row1);
    const row2 = document.createElement('div');
    row2.className = 'pane-row';
    row2.appendChild(createPane(2, true));
    row2.appendChild(createPane(3, true));
    area.appendChild(row2);
  } else {
    for (let i = 0; i < paneCount; i++) {
      area.appendChild(createPane(i, isMultiPane));
    }
  }

  // Show correct view
  if (viewMode === 'messenger') {
    area.style.display = 'none';
    document.getElementById('messengerPane').classList.add('active');
    const st = document.getElementById('sideTray');
    if (st) st.style.display = 'flex';
    renderMessenger();
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}
