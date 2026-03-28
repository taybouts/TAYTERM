// T-Term — Messenger UI, chat bubbles, side tray, and conversation management

let selectedMessengerPane = 0;
const cachedPanes = {}; // { sessionId: DOM element }
const savedScrollPositions = {}; // { sessionId: scrollTop }
const scrollLockedToBottom = {}; // { sessionId: boolean }

function createMessengerPane(sid, paneIdx, totalPanes) {
  // Check if cached pane is stale (messages added while off-screen)
  if (sid && cachedPanes[sid] && messengerMessages[sid]) {
    const chatArea = cachedPanes[sid].querySelector('.chat-messages');
    const rendered = chatArea ? chatArea.querySelectorAll('.msg-bubble').length : 0;
    if (rendered !== messengerMessages[sid].length) {
      delete cachedPanes[sid]; // Stale — force full recreation
    }
  }

  // Return cached pane if it exists and is fresh
  if (sid && cachedPanes[sid]) {
    const cached = cachedPanes[sid];
    cached.className = 'messenger-split-pane' + (totalPanes > 1 && paneIdx === selectedMessengerPane ? ' selected' : '');
    // Update pane label and click handler with current paneIdx
    let label = cached.querySelector('.messenger-pane-label');
    if (totalPanes > 1) {
      if (!label && sessions[sid]) {
        label = document.createElement('div');
        label.className = 'messenger-pane-label';
        label.textContent = sessions[sid].name.toUpperCase();
        cached.insertBefore(label, cached.firstChild);
      }
      if (label) label.style.display = '';
      cached.onclick = (e) => {
        if (e.target.closest('.chat-input-area')) return;
        selectedMessengerPane = paneIdx;
        selectedPane = paneIdx;
        activeSessionId = sid;
        document.querySelectorAll('.messenger-split-pane').forEach((p, j) => {
          p.classList.toggle('selected', j === selectedMessengerPane);
        });
      };
    } else {
      if (label) label.style.display = 'none';
      cached.onclick = null;
    }
    return cached;
  }

  const pane = document.createElement('div');
  pane.className = 'messenger-split-pane' + (totalPanes > 1 && paneIdx === selectedMessengerPane ? ' selected' : '');
  if (sid) pane.dataset.sessionId = sid;

  // Pane label (top-right corner)
  if (totalPanes > 1 && sid && sessions[sid]) {
    const label = document.createElement('div');
    label.className = 'messenger-pane-label';
    label.textContent = sessions[sid].name.toUpperCase();
    pane.appendChild(label);
    // Click to select
    pane.onclick = (e) => {
      if (e.target.closest('.chat-input-area')) return;
      selectedMessengerPane = paneIdx;
      selectedPane = paneIdx; // Keep in sync for tab switching
      activeSessionId = sid;
      document.querySelectorAll('.messenger-split-pane').forEach((p, j) => {
        p.classList.toggle('selected', j === selectedMessengerPane);
      });
    };
  }

  const chatWrap = document.createElement('div');
  chatWrap.style.cssText = 'flex:1;position:relative;min-height:0;display:flex;flex-direction:column';
  const chatArea = document.createElement('div');
  chatArea.className = 'chat-messages';
  chatWrap.appendChild(chatArea);
  // Scroll-to-bottom button
  const scrollBtn = document.createElement('button');
  scrollBtn.className = 'chat-scroll-btn';
  scrollBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>';
  scrollBtn.onclick = () => { if (sid) scrollLockedToBottom[sid] = true; chatArea._scrollToBottom(); };
  chatWrap.appendChild(scrollBtn);
  let _programmaticScroll = false;
  chatArea._scrollToBottom = () => { _programmaticScroll = true; chatArea.scrollTop = chatArea.scrollHeight; };
  chatArea.addEventListener('scroll', () => {
    const atBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 50;
    scrollBtn.classList.toggle('visible', !atBottom);
    // Only update lock state on user-initiated scrolls (not programmatic)
    if (_programmaticScroll) { _programmaticScroll = false; return; }
    if (sid) scrollLockedToBottom[sid] = atBottom;
  });
  pane.appendChild(chatWrap);

  const inputArea = document.createElement('div');
  inputArea.className = 'chat-input-area';
  inputArea.innerHTML = `
    <div class="stats-handle" onclick="this.closest('.chat-input-area').classList.toggle('stats-open')"></div>
    <div class="chat-input-row">
      <button class="mic-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 1a4 4 0 00-4 4v7a4 4 0 008 0V5a4 4 0 00-4-4z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/></svg></button>
      <textarea class="chat-textarea" placeholder="Send a message..." rows="1"></textarea>
      <button class="send-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
    </div>
    <div class="global-stats" data-sid="${sid || ''}">
      <div class="gs-item gs-fixed">
        <span class="gs-label">MODEL</span>
        <span class="gs-value" data-field="model">Opus 4.6</span>
      </div>
      <div class="gs-sep"></div>
      <div class="gs-item" style="flex:85">
        <span class="gs-label">CONTEXT</span>
        <span class="gs-value" data-field="context">—</span>
        <div class="gs-bar"><div class="gs-bar-fill" data-field="contextBar"></div></div>
        <span class="gs-pct" data-field="contextPct">—</span>
      </div>
      <div class="gs-sep"></div>
      <div class="gs-item" style="flex:15">
        <span class="gs-label">IMAGES</span>
        <span class="gs-value" data-field="images">0</span>
        <div class="gs-bar"><div class="gs-bar-fill" data-field="imageBar" style="background:var(--amber)"></div></div>
      </div>
      <div class="gs-sep"></div>
      <div class="gs-item gs-fixed">
        <span class="gs-label">OUTPUT</span>
        <span class="gs-value" data-field="tokens">—</span>
      </div>
      <div class="gs-sep"></div>
      <div class="gs-item gs-fixed">
        <span class="gs-label">AGENTS</span>
        <span class="gs-value" data-field="agents">0</span>
      </div>
      <button class="gs-toggle" onclick="event.stopPropagation();document.body.classList.toggle('show-stats')" title="Per-message stats">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="10" height="10"><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/></svg>
      </button>
    </div>`;
  pane.appendChild(inputArea);

  const textarea = inputArea.querySelector('.chat-textarea');
  const sendBtn = inputArea.querySelector('.send-btn');
  const sendMsg = () => {
    const text = textarea.value.trim();
    const atts = pendingAttachments[sid] || [];
    if (!sid || !sessions[sid]) return;
    const ws = sessions[sid].ws;
    if (!text && atts.length === 0) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: '\r' }));
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
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
    if (sessions[sid]) {
      sessions[sid]._lastSendTime = Date.now();
      sessions[sid].activeAgents = 0;
      sessions[sid].toolHistory = [];
    }
    if (text) addMessengerMessage(sid, 'user', text);
    showMessengerTyping(sid, true);
    textarea.value = '';
    textarea.style.height = '44px';
  };
  sendBtn.onclick = sendMsg;
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
  });
  textarea.addEventListener('input', () => {
    textarea.style.height = '44px';
    if (textarea.scrollHeight > 44) {
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }
  });
  // Right-click = paste
  textarea.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    navigator.clipboard.readText().then(text => {
      if (text) {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
        textarea.selectionStart = textarea.selectionEnd = start + text.length;
        textarea.dispatchEvent(new Event('input'));
        textarea.focus();
      }
    }).catch(() => {});
  });
  // Paste image from clipboard
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

  // Wire mic button — Whisper STT via NaturalVoice /transcribe
  const micBtn = inputArea.querySelector('.mic-btn');
  if (micBtn) {
    micBtn.onclick = () => _sttToggle(micBtn, textarea);
  }

  // Load conversation history (only when server has confirmed JSONL attachment)
  if (sid && sessions[sid] && !sessions[sid].isShell && sessions[sid]._jsonlSessionId && (!messengerMessages[sid] || messengerMessages[sid].length === 0)) {
    loadConversationHistory(sid, chatArea);
  } else if (sid && messengerMessages[sid] && messengerMessages[sid].length > 0) {
    for (const m of messengerMessages[sid]) {
      if (m.type === 'image') {
        chatArea.appendChild(createImageBubble(m.role, m.blobUrl, m.time, m.sizeInfo, m.ts));
      } else {
        chatArea.appendChild(createMsgBubble(m.role, m.text, m.time));
      }
    }
    setTimeout(() => { if (chatArea._scrollToBottom) chatArea._scrollToBottom(); else chatArea.scrollTop = chatArea.scrollHeight; }, 50);
  }
  // Default: locked to bottom on first creation
  if (sid && scrollLockedToBottom[sid] === undefined) scrollLockedToBottom[sid] = true;

  // Restore thinking indicator if session is still thinking
  if (sid && sessions[sid]?.isThinking) {
    showMessengerTyping(sid, true, sessions[sid].toolHistory, sessions[sid].activeAgents);
  }

  // Cache the pane
  if (sid) cachedPanes[sid] = pane;

  return pane;
}

function renderMessenger() {
  const mp = document.getElementById('messengerPane');
  // Save scroll positions by session ID before detaching
  mp.querySelectorAll('.messenger-split-pane').forEach(p => {
    const chat = p.querySelector('.chat-messages');
    const sid = p.dataset.sessionId;
    if (chat && sid) savedScrollPositions[sid] = chat.scrollTop;
  });
  // Detach children (don't destroy — they're cached)
  while (mp.firstChild) mp.removeChild(mp.firstChild);
  const paneCount = { single: 1, hsplit: 2, vsplit: 2, triple: 3, quad: 4 }[layout] || 1;
  const sids = [];
  for (let i = 0; i < paneCount; i++) {
    sids.push(paneSlots[i] || null);
  }

  if (layout === 'vsplit') {
    mp.style.flexDirection = 'column';
    mp.appendChild(createMessengerPane(sids[0], 0, paneCount));
    mp.appendChild(createMessengerPane(sids[1], 1, paneCount));
  } else if (layout === 'triple') {
    mp.style.flexDirection = 'row';
    mp.appendChild(createMessengerPane(sids[0], 0, paneCount));
    const rightCol = document.createElement('div');
    rightCol.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:2px;min-width:0;min-height:0;';
    rightCol.appendChild(createMessengerPane(sids[1], 1, paneCount));
    rightCol.appendChild(createMessengerPane(sids[2], 2, paneCount));
    mp.appendChild(rightCol);
  } else if (layout === 'quad') {
    mp.style.flexDirection = 'column';
    const row1 = document.createElement('div');
    row1.style.cssText = 'flex:1;display:flex;flex-direction:row;gap:2px;min-height:0;';
    row1.appendChild(createMessengerPane(sids[0], 0, paneCount));
    row1.appendChild(createMessengerPane(sids[1], 1, paneCount));
    mp.appendChild(row1);
    const row2 = document.createElement('div');
    row2.style.cssText = 'flex:1;display:flex;flex-direction:row;gap:2px;min-height:0;';
    row2.appendChild(createMessengerPane(sids[2], 2, paneCount));
    row2.appendChild(createMessengerPane(sids[3], 3, paneCount));
    mp.appendChild(row2);
  } else {
    // single or hsplit — side by side
    mp.style.flexDirection = 'row';
    for (let i = 0; i < sids.length; i++) {
      mp.appendChild(createMessengerPane(sids[i], i, paneCount));
    }
  }
  // Restore thinking indicators for sessions that are currently thinking
  for (const sid of sids) {
    if (sid && sessions[sid] && sessions[sid].isThinking) {
      showMessengerTyping(sid, true);
    }
  }
  // Restore scroll positions after layout settles (rAF + timeout for reliable layout)
  requestAnimationFrame(() => {
    setTimeout(() => {
      mp.querySelectorAll('.messenger-split-pane').forEach(p => {
        const chat = p.querySelector('.chat-messages');
        const sid = p.dataset.sessionId;
        if (!chat || !sid) return;
        if (scrollLockedToBottom[sid]) {
          // Was following chat — snap to bottom (catches new messages while away)
          chat.scrollTop = chat.scrollHeight;
        } else if (savedScrollPositions[sid] !== undefined) {
          // Was scrolled up — restore exact position
          chat.scrollTop = savedScrollPositions[sid];
        }
      });
    }, 0);
  });
}

function isImagePath(text) {
  return /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(text.trim()) && /[\\/]/.test(text) && text.trim().split('\n').length <= 2;
}

async function loadConversationHistory(sessionId, chatArea) {
  const s = sessions[sessionId];
  if (!s) return;
  _vpLoadingHistory = true;
  try {
    // Load text messages from JSONL
    const resp = await fetch(`/api/conversation?name=${encodeURIComponent(s.name)}`);
    const messages = await resp.json();
    // Load saved images from server
    let media = [];
    try {
      const mediaResp = await fetch(`/api/chat-media?name=${encodeURIComponent(s.name)}`);
      media = await mediaResp.json();
    } catch(e) { /* ignore media errors */ }

    if (!messengerMessages[sessionId]) messengerMessages[sessionId] = [];

    // Merge text and images by timestamp
    const allItems = [];
    for (const m of messages) {
      if (m.role === 'user' || m.role === 'assistant') {
        const text = m.text || '';
        if (isImagePath(text) || /^\[Image:/.test(text)) continue;
        allItems.push({ type: 'text', role: m.role, text, time: m.time || '', ts: m.ts || 0 });
      }
    }
    for (const img of media) {
      allItems.push({ type: 'image', role: 'user', url: img.url, time: img.time || '', ts: img.ts || 0, size: img.size || 0 });
    }

    // Sort by timestamp so images appear in the right position
    allItems.sort((a, b) => a.ts - b.ts);

    // Store all items in memory
    for (const item of allItems) {
      if (item.type === 'image') {
        messengerMessages[sessionId].push({ role: 'user', type: 'image', blobUrl: item.url, time: item.time, ts: item.ts });
      } else {
        messengerMessages[sessionId].push({ role: item.role, text: item.text, time: item.time });
      }
    }

    // Only render last 50 messages in the DOM
    const MSG_LIMIT = 50;
    const startIdx = Math.max(0, allItems.length - MSG_LIMIT);
    const rendered = allItems.slice(startIdx);

    // Add "load more" button if there's older history
    if (startIdx > 0) {
      const loadMore = document.createElement('div');
      loadMore.className = 'load-more-btn';
      loadMore.textContent = `Load ${startIdx} older messages`;
      loadMore.dataset.sessionId = sessionId;
      loadMore.dataset.startIdx = '0';
      loadMore.dataset.endIdx = String(startIdx);
      loadMore.onclick = () => {
        const items = messengerMessages[sessionId];
        const end = parseInt(loadMore.dataset.endIdx);
        const batchStart = Math.max(0, end - MSG_LIMIT);
        const batch = items.slice(batchStart, end);
        const scrollBefore = chatArea.scrollHeight;
        const frag = document.createDocumentFragment();
        for (const m of batch) {
          if (m.type === 'image') {
            frag.appendChild(createImageBubble('user', m.blobUrl, m.time, null, m.ts));
          } else {
            frag.appendChild(createMsgBubble(m.role, m.text, m.time));
          }
        }
        chatArea.insertBefore(frag, loadMore.nextSibling);
        // Keep scroll position stable
        chatArea.scrollTop += chatArea.scrollHeight - scrollBefore;
        if (batchStart > 0) {
          loadMore.textContent = `Load ${batchStart} older messages`;
          loadMore.dataset.endIdx = String(batchStart);
        } else {
          loadMore.remove();
        }
      };
      chatArea.appendChild(loadMore);
    }

    const frag = document.createDocumentFragment();
    for (const item of rendered) {
      if (item.type === 'image') {
        frag.appendChild(createImageBubble('user', item.url, item.time, null, item.ts));
      } else {
        frag.appendChild(createMsgBubble(item.role, item.text, item.time));
      }
    }
    chatArea.appendChild(frag);
    if (chatArea._scrollToBottom) chatArea._scrollToBottom(); else chatArea.scrollTop = chatArea.scrollHeight;
  } catch (e) { /* ignore fetch errors */ }
  _vpLoadingHistory = false;
}

function renderMarkdown(text) {
  // Escape HTML (single pass)
  let html = text.replace(/[&<>]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
  // Code blocks (```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Headers (h1-h4) — single pass
  html = html.replace(/^(#{1,4})\s+(.+)$/gm, (_, hashes, text) => {
    const n = hashes.length;
    return '<h' + n + ' class="md-h">' + text + '</h' + n + '>';
  });
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Markdown links [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="md-link">$1</a>');
  // Bare URLs (not already inside an href)
  html = html.replace(/(?<!href="|">)(https?:\/\/[^\s<)"]+)/g, '<a href="$1" target="_blank" rel="noopener" class="md-link">$1</a>');
  // Rewrite localhost URLs to use actual server hostname (so links work from mobile)
  html = html.replace(/href="(https?):\/\/localhost(:\d+)?/g, 'href="$1://' + window.location.hostname + '$2');
  // Tables: detect lines with | separators
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (match) => {
    const rows = match.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return match;
    // Skip separator rows (|---|---|, | --- | --- |, |:---:|---:|, etc.)
    const dataRows = rows.filter(r => {
      const cells = r.split('|').filter(c => c !== '');
      return !cells.every(c => /^[\s\-:]+$/.test(c));
    });
    if (dataRows.length === 0) return match;
    let table = '<table>';
    dataRows.forEach((row, i) => {
      const cells = row.split('|').filter(c => c !== '').map(c => c.trim());
      const tag = i === 0 ? 'th' : 'td';
      table += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
    });
    table += '</table>';
    return table;
  });
  // Numbered lists: lines starting with 1. 2. etc
  html = html.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="numbered"><span class="list-num">$1</span>$2</li>');
  // Bullet lists: lines starting with - or *
  html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  // Clean up <br> inside block elements (no lookbehind for Safari compat)
  html = html.replace(/<ul><br>/g, '<ul>');
  html = html.replace(/<br><\/ul>/g, '</ul>');
  html = html.replace(/<\/li><br>/g, '</li>');
  html = html.replace(/<pre><br>/g, '<pre>');
  html = html.replace(/<br><\/pre>/g, '</pre>');
  html = html.replace(/<\/tr><br>/g, '</tr>');
  html = html.replace(/<table><br>/g, '<table>');
  html = html.replace(/<br><\/table>/g, '</table>');
  html = html.replace(/<br><(h[1-4])/g, '<$1');
  html = html.replace(/<\/(h[1-4])><br>/g, '</$1>');
  return html;
}

function createMsgBubble(role, text, time, extra) {
  const msg = document.createElement('div');
  msg.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  if (role === 'assistant') {
    bubble.innerHTML = renderMarkdown(text);
    // Read-aloud overlay button — top-right corner, visible on hover
    const readBtn = document.createElement('div');
    readBtn.className = 'bubble-read-btn';
    readBtn.title = 'Read aloud';
    readBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    readBtn.onclick = (e) => { e.stopPropagation(); readBubbleAloud(text, readBtn); };
    bubble.appendChild(readBtn);
    // Copy button — copies raw text (preserves markdown formatting)
    const copyBtn = document.createElement('div');
    copyBtn.className = 'bubble-copy-btn';
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    copyBtn.onclick = (e) => { e.stopPropagation(); navigator.clipboard.writeText(text).then(() => { copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="20 6 9 17 4 12"/></svg>'; setTimeout(() => { copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; }, 1500); }); };
    bubble.appendChild(copyBtn);
  } else {
    bubble.innerHTML = renderMarkdown(text);
  }
  msg.appendChild(bubble);

  // Time always visible
  if (time) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    let html = time;
    if (role === 'assistant' && extra) {
      if (extra.responseTime) html += ' <span class="msg-extra">&middot; ' + extra.responseTime + '</span>';
      if (extra.tokens > 0) html += ' <span class="msg-extra">&middot; ' + extra.tokens + ' tok</span>';
    }
    meta.innerHTML = html;
    msg.appendChild(meta);
  }

  // Right-click to flag assistant bubbles
  if (role === 'assistant') {
    bubble.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const isFlagged = msg.classList.toggle('flagged');
      // Update in-memory message
      const sid = msg.closest('[data-session-id]')?.dataset.sessionId;
      if (sid && messengerMessages[sid]) {
        const match = messengerMessages[sid].find(m => m.text === text && m.role === 'assistant');
        if (match) match.flagged = isFlagged;
      }
      // Save to server
      const s = sid && sessions[sid];
      if (s) {
        fetch('/api/stars', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: s.name, star: { text: text.slice(0, 200), time: time || '' } })
        }).catch(() => {});
      }
    });
  }
  return msg;
}

// ══════════════════════════════════════════
//  Voice Player — sentence-by-sentence TTS with highlighting
// ══════════════════════════════════════════
let _vpAutoPlay = true;   // Auto-play TTS on new assistant messages
let _vpLoadingHistory = false; // Suppress auto-play during history load
const _vpQueue = [];      // Queue of { bubble, text, readBtn } for messages that arrive during playback
let _vpSharedAudioCtx = null; // Shared AudioContext — created on first user gesture for iOS

// Create/unlock AudioContext on any user interaction (iOS requires gesture)
function _vpEnsureAudioCtx() {
  if (!_vpSharedAudioCtx || _vpSharedAudioCtx.state === 'closed') {
    _vpSharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_vpSharedAudioCtx.state === 'suspended') _vpSharedAudioCtx.resume();
  return _vpSharedAudioCtx;
}
document.addEventListener('touchstart', _vpEnsureAudioCtx, { once: false, passive: true });
document.addEventListener('click', _vpEnsureAudioCtx, { once: false, passive: true });

const _vp = {
  sentences: [],
  currentIndex: -1,
  paused: false,
  active: false,
  bubbleEl: null,
  btnEl: null,
  generation: 0,
  rawText: '',
  abortCtrl: null,
  audioEl: null, // Persistent <audio> element — plays in background tabs like YouTube
};

function _vpSplitSentences(text) {
  // Split on sentence boundaries: . ! ? followed by space or end, plus newlines for paragraphs
  const raw = text.replace(/\n{2,}/g, '\n').trim();
  const parts = [];
  // Split by lines first to respect paragraph structure
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Split line into sentences
    const sents = trimmed.match(/[^.!?]+[.!?]+[\s]?|[^.!?]+$/g);
    if (sents) {
      for (const s of sents) {
        const clean = s.trim();
        if (clean.length > 2) parts.push(clean);
      }
    } else if (trimmed.length > 2) {
      parts.push(trimmed);
    }
  }
  return parts;
}

function _vpStart(bubble, rawText, btn, startIndex) {
  _vpStop(); // Stop any existing playback
  _vp.rawText = rawText;
  // Get clean text from the bubble's rendered content (excluding buttons)
  const clone = bubble.cloneNode(true);
  clone.querySelectorAll('.bubble-read-btn, .bubble-copy-btn').forEach(el => el.remove());
  const visibleText = clone.innerText || clone.textContent || '';
  _vp.sentences = _vpSplitSentences(visibleText);
  if (_vp.sentences.length === 0) return;
  _vp.bubbleEl = bubble;
  _vp.btnEl = btn;
  _vp.active = true;
  _vp.paused = false;
  _vp.generation++;
  _vp._lastHighlightEnd = 0;
  // Show controller
  const bar = document.getElementById('voiceBar');
  if (bar) bar.classList.add('visible');
  // Mark button as reading
  if (btn) { btn.classList.add('reading'); }
  // Add click-to-jump handler on bubble
  bubble._vpClickHandler = (e) => {
    if (e.target.closest('.bubble-read-btn, .bubble-copy-btn')) return;
    if (!_vp.active || _vp.bubbleEl !== bubble) return;
    _vpJumpToClick(e, bubble);
  };
  bubble.addEventListener('click', bubble._vpClickHandler);
  _vpSpeakIndex(startIndex || 0);
}

// Persistent <audio> element — browsers keep these playing in background tabs (like YouTube)
const _vpAudio = document.createElement('audio');
_vpAudio.style.display = 'none';
document.body.appendChild(_vpAudio);

function _vpKillAudio() {
  if (_vp.abortCtrl) { _vp.abortCtrl.abort(); _vp.abortCtrl = null; }
  // Stop <audio> element (desktop)
  _vpAudio.onended = null;
  _vpAudio.pause();
  if (_vpAudio.src) { URL.revokeObjectURL(_vpAudio.src); _vpAudio.removeAttribute('src'); }
  // Stop AudioBufferSource (iOS)
  if (_vp._currentSource) { try { _vp._currentSource.onended = null; _vp._currentSource.stop(); } catch(e) {} _vp._currentSource = null; }
}

function _vpStop(skipQueue) {
  _vp.generation++;
  _vpKillAudio();
  _vpClearHighlight();
  if (typeof inkNotifySpeakStop === 'function') inkNotifySpeakStop();
  if (_vp.btnEl) _vp.btnEl.classList.remove('reading');
  if (_vp.bubbleEl && _vp.bubbleEl._vpClickHandler) {
    _vp.bubbleEl.removeEventListener('click', _vp.bubbleEl._vpClickHandler);
    delete _vp.bubbleEl._vpClickHandler;
  }
  _vp.active = false;
  _vp.bubbleEl = null;
  _vp.btnEl = null;
  _vp.sentences = [];
  _vp.currentIndex = -1;
  _vp.paused = false;
  const bar = document.getElementById('voiceBar');
  if (bar) bar.classList.remove('visible');
  // Play next queued message if any
  if (!skipQueue && _vpQueue.length > 0) {
    const next = _vpQueue.shift();
    if (next.bubble) {
      setTimeout(() => _vpStart(next.bubble, next.text, next.readBtn, 0), 100);
    } else {
      _vpPlayAudioOnly(next.text);
    }
  }
}

function _vpPause() {
  if (!_vp.active) return;
  _vp.paused = true;
  _vpAudio.pause();
  _vpUpdateUI();
}

function _vpResume() {
  if (!_vp.active) return;
  _vp.paused = false;
  _vpUpdateUI();
  const idx = _vp.currentIndex >= 0 ? _vp.currentIndex : 0;
  _vpSpeakIndex(idx);
}

function _vpTogglePause() {
  if (!_vp.active) return;
  _vp.paused ? _vpResume() : _vpPause();
}

function _vpNext() {
  if (!_vp.active) return;
  _vp.generation++;
  _vpKillAudio();
  _vp.paused = false;
  const next = (_vp.currentIndex >= 0 ? _vp.currentIndex : 0) + 1;
  if (next < _vp.sentences.length) _vpSpeakIndex(next);
}

function _vpPrev() {
  if (!_vp.active) return;
  _vp.generation++;
  _vpKillAudio();
  _vp.paused = false;
  const prev = _vp.currentIndex > 0 ? _vp.currentIndex - 1 : 0;
  _vpSpeakIndex(prev);
}

async function _vpSpeakIndex(index) {
  if (!_vp.active || index >= _vp.sentences.length) {
    _vpStop();
    return;
  }
  const gen = _vp.generation;
  _vp.currentIndex = index;
  _vpHighlight(index);
  _vpUpdateUI();
  if (typeof inkNotifySpeakStart === 'function') inkNotifySpeakStart();

  _vpKillAudio();
  _vp.abortCtrl = new AbortController();

  try {
    const resp = await fetch(TTS_BASE + '/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: _vp.sentences[index], voice: 'am_onyx', speed: 1.25 }),
      signal: _vp.abortCtrl.signal,
    });
    if (!resp.ok) throw new Error('TTS ' + resp.status);

    if (isIOS || isIPad) {
      // iOS: use AudioContext (pre-unlocked by touch events) — <audio> autoplay is blocked
      const wavBuf = await resp.arrayBuffer();
      if (gen !== _vp.generation) return;
      const ctx = _vpEnsureAudioCtx();
      const audioBuf = await ctx.decodeAudioData(wavBuf);
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(ctx.destination);
      _vp._currentSource = src;
      await new Promise(resolve => {
        src.onended = () => { _vp._currentSource = null; resolve(); };
        src.start(0);
      });
    } else {
      // Desktop: use <audio> element — works in background tabs
      const wavBlob = await resp.blob();
      if (gen !== _vp.generation) return;
      const blobUrl = URL.createObjectURL(wavBlob);
      _vpAudio.src = blobUrl;
      await new Promise((resolve, reject) => {
        _vpAudio.onended = () => { URL.revokeObjectURL(blobUrl); resolve(); };
        _vpAudio.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('audio error')); };
        _vpAudio.play().catch(reject);
      });
    }
    if (gen !== _vp.generation || _vp.paused) return;
    _vpSpeakIndex(index + 1);
  } catch(e) {
    if (e.name === 'AbortError') return;
    if (gen !== _vp.generation) return;
    _vpSpeakIndex(index + 1);
  }
}

function _vpHighlight(index) {
  _vpClearHighlight();
  if (!_vp.bubbleEl || index < 0 || index >= _vp.sentences.length) return;

  const sentence = _vp.sentences[index];
  const bubble = _vp.bubbleEl;
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  let fullText = '';
  for (const tn of textNodes) fullText += tn.textContent;

  // Cumulative offset — walk through all previous sentences to find position
  // More reliable than indexOf which can match wrong occurrences
  const normFull = fullText.replace(/\s+/g, ' ');
  let cumOffset = 0;
  for (let si = 0; si < index; si++) {
    const prevNorm = _vp.sentences[si].replace(/\s+/g, ' ');
    const foundAt = normFull.indexOf(prevNorm, cumOffset);
    if (foundAt !== -1) {
      cumOffset = foundAt + prevNorm.length;
    } else {
      cumOffset += prevNorm.length;
    }
  }
  const normSent = sentence.replace(/\s+/g, ' ');
  let normPos = normFull.indexOf(normSent, cumOffset);
  if (normPos === -1) normPos = normFull.indexOf(normSent);
  if (normPos === -1 && normSent.length > 40) normPos = normFull.indexOf(normSent.substring(0, 40), cumOffset);
  if (normPos === -1 && normSent.length > 40) normPos = normFull.indexOf(normSent.substring(0, 40));
  if (normPos === -1) return;

  // Map normalized position back to original text
  let sentPos = 0, ni = 0;
  while (ni < normPos && sentPos < fullText.length) {
    if (/\s/.test(fullText[sentPos])) {
      sentPos++;
      if (ni < normPos && normFull[ni] === ' ') ni++;
      while (sentPos < fullText.length && /\s/.test(fullText[sentPos])) sentPos++;
    } else { sentPos++; ni++; }
  }

  // Find text nodes and wrap matching range
  let offset = 0;
  for (const node of textNodes) {
    const nodeEnd = offset + node.textContent.length;
    const sentEnd = sentPos + sentence.length;
    if (nodeEnd > sentPos && offset < sentEnd) {
      const startInNode = Math.max(0, sentPos - offset);
      const endInNode = Math.min(node.textContent.length, sentEnd - offset);
      try {
        const range = document.createRange();
        range.setStart(node, startInNode);
        range.setEnd(node, endInNode);
        const span = document.createElement('span');
        span.className = 'voice-highlight';
        range.surroundContents(span);
        const chatContainer = span.closest('.chat-messages');
        if (chatContainer) {
          const spanRect = span.getBoundingClientRect();
          const containerRect = chatContainer.getBoundingClientRect();
          if (spanRect.bottom > containerRect.bottom - 80 || spanRect.top < containerRect.top) {
            span.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      } catch(e) {}
      break;
    }
    offset = nodeEnd;
  }
}

function _vpClearHighlight() {
  if (!_vp.bubbleEl) return;
  _vp.bubbleEl.querySelectorAll('.voice-highlight').forEach(el => {
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize();
  });
}

function _vpJumpToClick(e, bubble) {
  // Determine which sentence was clicked based on text position
  const selection = window.getSelection();
  if (!selection.anchorNode || !bubble.contains(selection.anchorNode)) return;

  const clone = bubble.cloneNode(true);
  clone.querySelectorAll('.bubble-read-btn, .bubble-copy-btn').forEach(el => el.remove());
  const fullText = clone.innerText || clone.textContent || '';

  try {
    const range = document.createRange();
    range.selectNodeContents(bubble);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    const charPos = range.toString().length;

    let bestIndex = 0, pos = 0;
    for (let i = 0; i < _vp.sentences.length; i++) {
      const sentPos = fullText.indexOf(_vp.sentences[i], pos);
      if (sentPos === -1) continue;
      if (charPos >= sentPos && charPos <= sentPos + _vp.sentences[i].length) { bestIndex = i; break; }
      if (sentPos > charPos) { bestIndex = Math.max(0, i - 1); break; }
      pos = sentPos + _vp.sentences[i].length;
      bestIndex = i;
    }

    _vp.generation++; // Kill any in-flight playback chain
    _vpKillAudio();
    _vp.paused = false;
    _vpSpeakIndex(bestIndex);
  } catch(ex) {}
}

function _vpUpdateUI() {
  const counter = document.getElementById('vpCounter');
  if (counter) {
    const cur = _vp.currentIndex >= 0 ? _vp.currentIndex + 1 : 0;
    counter.textContent = cur + ' / ' + _vp.sentences.length;
  }
  const ppBtn = document.getElementById('vpPlayPause');
  if (ppBtn) ppBtn.textContent = _vp.paused ? '\u25B6' : '\u23F8';
  // Progress bar
  const total = _vp.sentences.length || 1;
  const cur = _vp.currentIndex >= 0 ? _vp.currentIndex : 0;
  const pct = total <= 1 ? 0 : Math.min(100, (cur / (total - 1)) * 100);
  const fill = document.getElementById('vpProgress');
  if (fill) fill.style.width = pct + '%';
}

function _vpTimelineClick(e) {
  if (!_vp.active || _vp.sentences.length === 0) return;
  const bar = document.getElementById('vpTimeline');
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const index = Math.round(pct * (_vp.sentences.length - 1));
  _vpKillAudio();
  _vp.paused = false;
  _vpSpeakIndex(index);
}

// Audio-only playback (no highlight) — for when the pane isn't visible
async function _vpPlayAudioOnly(text) {
  _vpStop();
  _vp.sentences = _vpSplitSentences(text);
  if (_vp.sentences.length === 0) return;
  _vp.active = true;
  _vp.paused = false;
  _vp.generation++;
  _vpSpeakIndex(0);
}

function readBubbleAloud(text, btn) {
  if (_vp.active && _vp.btnEl === btn) {
    // Toggle — stop if same bubble + clear queue
    _vpQueue.length = 0;
    _vpStop(true);
    return;
  }
  const bubble = btn.closest('.msg-bubble');
  if (!bubble) return;
  _vpStart(bubble, text, btn, 0);
}

// ══════════════════════════════════════════
//  STT — Whisper via NaturalVoice /transcribe
// ══════════════════════════════════════════
let _sttRecorder = null;
let _sttChunks = [];
let _sttStream = null;
let _sttRecording = false;
let _sttLockedTextarea = null; // Locked to the textarea when recording started
let _sttLockedMicBtn = null;
let _sttLockedSendFn = null;  // Send function captured at record start

async function _sttToggle(micBtn, textarea) {
  if (_sttRecording) {
    _sttStop(micBtn, textarea);
  } else {
    _sttStart(micBtn, textarea);
  }
}

async function _sttStart(micBtn, textarea, sendFn) {
  if (_sttRecording) return;
  _sttLockedTextarea = textarea;
  _sttLockedMicBtn = micBtn;
  _sttLockedSendFn = sendFn || null;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    _sttStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _sttRecorder = new MediaRecorder(_sttStream, { mimeType: 'audio/webm' });
    _sttChunks = [];
    _sttRecorder.ondataavailable = (e) => _sttChunks.push(e.data);
    _sttRecorder.start();
    _sttRecording = true;
    if (micBtn) micBtn.classList.add('recording');
  } catch(e) {
    _sttRecording = false;
  }
}

async function _sttStop(micBtn, textarea, autoSend) {
  if (!_sttRecording || !_sttRecorder) return;
  _sttRecording = false;
  // Use locked references (from when recording started)
  const targetTextarea = _sttLockedTextarea || textarea;
  const targetMicBtn = _sttLockedMicBtn || micBtn;
  const targetSendFn = _sttLockedSendFn;
  if (targetMicBtn) targetMicBtn.classList.remove('recording');
  return new Promise(resolve => {
    _sttRecorder.onstop = async () => {
      if (_sttStream) { _sttStream.getTracks().forEach(t => t.stop()); _sttStream = null; }
      if (!_sttChunks.length) { resolve(''); return; }
      const blob = new Blob(_sttChunks, { type: 'audio/webm' });
      _sttChunks = [];
      const text = await _sttTranscribe(blob);
      if (text && targetTextarea) {
        targetTextarea.value = targetTextarea.value ? targetTextarea.value + ' ' + text : text;
        targetTextarea.focus();
        targetTextarea.dispatchEvent(new Event('input'));
        // Auto-send if push-to-talk
        if (autoSend && targetSendFn) {
          targetSendFn();
        }
      }
      _sttLockedTextarea = null;
      _sttLockedMicBtn = null;
      _sttLockedSendFn = null;
      resolve(text);
    };
    _sttRecorder.stop();
  });
}

// ── Push-to-talk: hold Ctrl+Shift to record, release to send ──
let _pttActive = false;

function _pttGetActiveInput() {
  // Find the active session's messenger textarea and send function
  const sid = activeSessionId;
  if (!sid || !sessions[sid]) return null;
  // Find the visible pane for this session
  const panes = document.querySelectorAll('.messenger-split-pane, .split-messenger');
  for (const pane of panes) {
    if (pane.dataset.sessionId !== sid) continue;
    const textarea = pane.querySelector('.chat-textarea');
    const sendBtn = pane.querySelector('.send-btn');
    const micBtn = pane.querySelector('.mic-btn');
    if (textarea && sendBtn) {
      return { textarea, micBtn, sendFn: () => sendBtn.click() };
    }
  }
  return null;
}

document.addEventListener('keydown', (e) => {
  if (_pttActive) return;
  // Catch Ctrl+Shift in either press order
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'Shift' || e.key === 'Control')) {
    e.preventDefault();
    _pttActive = true;
    const target = _pttGetActiveInput();
    if (target) {
      _sttStart(target.micBtn, target.textarea, target.sendFn);
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Alt') return;
  // Alt while recording = cancel (discard recording, don't send)
  if (_pttActive) {
    e.preventDefault();
    _pttActive = false;
    if (_sttRecording) {
      _sttRecording = false;
      if (_sttLockedMicBtn) _sttLockedMicBtn.classList.remove('recording');
      if (_sttRecorder) _sttRecorder.stop();
      if (_sttStream) { _sttStream.getTracks().forEach(t => t.stop()); _sttStream = null; }
      _sttChunks = [];
      _sttLockedTextarea = null;
      _sttLockedMicBtn = null;
      _sttLockedSendFn = null;
    }
    return;
  }
  // Alt while voice player is speaking = stop TTS + clear queue
  if (_vp.active) {
    e.preventDefault();
    _vpQueue.length = 0;
    _vpStop(true);
  }
});

// Arrow keys to navigate sentences while voice player is active
document.addEventListener('keydown', (e) => {
  if (!_vp.active) return;
  // Don't intercept if typing in a textarea/input
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    _vpNext();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    _vpPrev();
  } else if (e.key === ' ') {
    e.preventDefault();
    _vpTogglePause();
  }
});

document.addEventListener('keyup', (e) => {
  if (!_pttActive) return;
  if (e.key === 'Shift' || e.key === 'Control') {
    _pttActive = false;
    if (_sttRecording) {
      _sttStop(null, null, true); // autoSend = true
    }
  }
});

async function _sttTranscribe(blob) {
  const fd = new FormData();
  fd.append('audio', blob, 'recording.webm');
  try {
    const resp = await fetch(TTS_BASE + '/transcribe', { method: 'POST', body: fd });
    if (!resp.ok) return '';
    const data = await resp.json();
    return (data.text || '').trim();
  } catch(e) {
    return '';
  }
}

// ══════════════════════════════════════════
//  Side Tray
// ══════════════════════════════════════════
let activeTrayPanel = null;

function initTrayHover() {
  const tray = document.getElementById('sideTray');
  const zone = document.getElementById('trayHoverZone');
  let leaveTimer = null;

  function startClose() {
    if (tray.classList.contains('panel-open')) return;
    leaveTimer = setTimeout(() => tray.classList.remove('open'), 300);
  }

  zone.addEventListener('mouseenter', () => {
    clearTimeout(leaveTimer);
    tray.classList.add('open');
  });
  zone.addEventListener('mouseleave', startClose);

  tray.addEventListener('mouseenter', () => clearTimeout(leaveTimer));
  tray.addEventListener('mouseleave', startClose);
}

function closeTray() {
  const tray = document.getElementById('sideTray');
  tray.classList.remove('panel-open', 'open');
  activeTrayPanel = null;
  document.querySelectorAll('.tray-icon').forEach(b => b.classList.remove('active'));
}

function openTrayPanel(panel) {
  const tray = document.getElementById('sideTray');
  const icons = document.querySelectorAll('.tray-icon');
  if (activeTrayPanel === panel) {
    tray.classList.remove('panel-open');
    activeTrayPanel = null;
    icons.forEach(b => b.classList.remove('active'));
    return;
  }
  activeTrayPanel = panel;
  icons.forEach(b => b.classList.toggle('active', b.dataset.panel === panel));
  tray.classList.add('panel-open');
  renderTrayPanel(panel);
}

function renderTrayPanel(panel) {
  const body = document.getElementById('trayPanel');
  body.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'tray-panel-header';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tray-close-btn';
  closeBtn.innerHTML = '&times;';
  closeBtn.title = 'Close panel';
  closeBtn.onclick = () => closeTray();

  const content = document.createElement('div');
  content.className = 'tray-panel-body';

  function setHeader(title) {
    const span = document.createElement('span');
    span.textContent = title;
    header.appendChild(span);
    header.appendChild(closeBtn);
    body.appendChild(header);
  }

  if (panel === 'flags') {
    setHeader('Flagged');
    // Find all flagged messages
    const sid = activeSessionId;
    if (sid && messengerMessages[sid]) {
      const flagged = messengerMessages[sid].filter(m => m.flagged);
      if (flagged.length === 0) {
        content.innerHTML = '<div style="text-align:center;padding:20px;font-family:var(--font-mono);font-size:11px;color:var(--text3)">Right-click any response to flag it</div>';
      }
      for (const m of flagged) {
        const idx = messengerMessages[sid].indexOf(m);
        const card = document.createElement('div');
        card.className = 'flag-card';
        card.innerHTML = '<div class="flag-card-text">' + (m.text || '').slice(0, 150) + '</div><div class="flag-card-time">' + (m.time || '') + '</div>';
        card.onclick = () => scrollToMessage(sid, idx);
        content.appendChild(card);
      }
    }
    // Also load from server
    if (sid && sessions[sid]) {
      fetch('/api/stars?name=' + encodeURIComponent(sessions[sid].name))
        .then(r => r.json())
        .then(stars => {
          if (stars.length > 0 && content.children.length <= 1) {
            content.innerHTML = '';
            for (const s of stars) {
              const card = document.createElement('div');
              card.className = 'flag-card';
              card.innerHTML = '<div class="flag-card-text">' + (s.text || '').slice(0, 150) + '</div><div class="flag-card-time">' + (s.time || '') + '</div>';
              content.appendChild(card);
            }
          }
        }).catch(() => {});
    }
  } else if (panel === 'search') {
    setHeader('Search');
    const input = document.createElement('input');
    input.className = 'tray-search';
    input.placeholder = 'Search conversation...';
    input.autofocus = true;
    content.appendChild(input);
    const results = document.createElement('div');
    content.appendChild(results);
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      results.innerHTML = '';
      if (!q || q.length < 2) return;
      const sid = activeSessionId;
      if (!sid || !messengerMessages[sid]) return;
      let count = 0;
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'gi');
      for (let i = 0; i < messengerMessages[sid].length; i++) {
        const m = messengerMessages[sid][i];
        if (m.text && m.text.toLowerCase().includes(q) && count < 20) {
          const card = document.createElement('div');
          card.className = 'flag-card';
          const highlighted = m.text.slice(0, 200).replace(re, '<strong style="color:var(--accent2)">$&</strong>');
          card.innerHTML = '<div class="flag-card-text">' + highlighted + '</div><div class="flag-card-time">' + (m.role === 'user' ? 'You' : 'Claude') + ' · ' + (m.time || '') + '</div>';
          card.onclick = () => scrollToMessage(sid, i, q);
          results.appendChild(card);
          count++;
        }
      }
      if (count === 0) results.innerHTML = '<div style="padding:12px;font-family:var(--font-mono);font-size:11px;color:var(--text3);text-align:center">No results</div>';
    });
    setTimeout(() => input.focus(), 100);
  } else if (panel === 'gallery') {
    setHeader('Gallery');
    const sid = activeSessionId;
    if (sid && messengerMessages[sid]) {
      const images = messengerMessages[sid].filter(m => m.type === 'image');
      for (const img of images) {
        const thumb = document.createElement('img');
        thumb.className = 'gallery-thumb';
        thumb.src = img.blobUrl;
        thumb.onclick = () => {
          const viewer = document.createElement('div');
          viewer.className = 'image-viewer';
          viewer.innerHTML = '<img src="' + img.blobUrl + '">';
          viewer.onclick = () => viewer.remove();
          document.body.appendChild(viewer);
        };
        content.appendChild(thumb);
      }
      if (images.length === 0) {
        content.innerHTML = '<div style="text-align:center;padding:20px;font-family:var(--font-mono);font-size:11px;color:var(--text3)">No screenshots yet</div>';
      }
    }
  } else if (panel === 'sessions') {
    setHeader('Sessions');
    if (!window._sessionsCache) window._sessionsCache = {};
    if (activeSessionId && sessions[activeSessionId]) {
      const name = sessions[activeSessionId].name;
      // Return cached DOM if we have it for this project
      if (window._sessionsCache[name]) {
        content.appendChild(window._sessionsCache[name]);
        return;
      }
      content.innerHTML = '<div style="padding:12px;text-align:center;font-family:var(--font-mono);font-size:10px;color:var(--text3)">Loading...</div>';
      fetch('/api/sessions?name=' + encodeURIComponent(name))
        .then(r => r.json())
        .then(data => {
          content.innerHTML = '';
          const list = data.sessions || [];
          if (list.length === 0) {
            content.innerHTML = '<div style="padding:20px;text-align:center;font-family:var(--font-mono);font-size:11px;color:var(--text3)">No sessions found</div>';
            return;
          }
          const activeJsonl = data.activeSession || '';
          const wrapper = document.createElement('div');
          for (let i = 0; i < list.length; i++) {
            const s = list[i];
            const card = document.createElement('div');
            const isActive = s.id === activeJsonl;
            card.className = 'flag-card session-card' + (isActive ? ' active' : '') + (s.starred ? ' starred' : '');
            card.style.cursor = 'pointer';
            if (isActive) card.style.borderLeft = '2px solid var(--accent2)';
            if (s.starred) card.style.borderLeft = '2px solid var(--accent3, #f5a623)';
            if (isActive && s.starred) card.style.borderLeft = '2px solid var(--accent2)';
            const tokenInfo = s.tokens ? ' · ' + (s.tokens > 1000 ? Math.round(s.tokens/1000) + 'k' : s.tokens) + ' tok' : '';
            const starIcon = s.starred ? '<span style="color:var(--accent3, #f5a623);margin-right:4px">&#9733;</span>' : '';
            card.innerHTML = '<div class="flag-card-text">' + starIcon + (s.preview || '<em style="opacity:0.4">No preview</em>') + '</div>'
              + '<div class="flag-card-time">' + s.date + ' · ' + s.time + tokenInfo + (isActive ? ' · <span style="color:var(--accent2)">active</span>' : (i === 0 ? ' · <span style="color:var(--accent2)">latest</span>' : '')) + '</div>'
              + '<div class="session-actions" style="display:flex;gap:4px;margin-top:4px">'
              + '<button class="session-resume-btn" style="font-size:9px;padding:2px 6px;background:var(--accent2);color:#000;border:none;border-radius:3px;cursor:pointer">Resume</button>'
              + '<button class="session-delete-btn" style="font-size:9px;padding:2px 6px;background:transparent;color:var(--text3);border:1px solid var(--text3);border-radius:3px;cursor:pointer">Delete</button>'
              + '</div>';
            // Single click — browse conversation
            card.onclick = (e) => {
              if (e.target.closest('.session-actions')) return;
              const sid = activeSessionId;
              if (sid && sessions[sid]) {
                delete messengerMessages[sid];
                delete cachedPanes[sid];
                fetch('/api/load-session?name=' + encodeURIComponent(name) + '&session=' + encodeURIComponent(s.id))
                  .then(() => renderMessenger());
                wrapper.querySelectorAll('.session-card').forEach(c => {
                  c.classList.remove('active');
                  if (!c.classList.contains('starred')) c.style.borderLeft = '';
                });
                card.classList.add('active');
                card.style.borderLeft = '2px solid var(--accent2)';
              }
            };
            // Right-click — toggle favorite
            card.oncontextmenu = (e) => {
              e.preventDefault();
              s.starred = !s.starred;
              card.classList.toggle('starred', s.starred);
              if (s.starred) {
                card.style.borderLeft = '2px solid var(--accent3, #f5a623)';
                card.querySelector('.flag-card-text').insertAdjacentHTML('afterbegin', '<span style="color:var(--accent3, #f5a623);margin-right:4px">&#9733;</span>');
              } else {
                card.style.borderLeft = card.classList.contains('active') ? '2px solid var(--accent2)' : '';
                const star = card.querySelector('.flag-card-text span');
                if (star) star.remove();
              }
              fetch('/api/session-star', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ name, session: s.id, starred: s.starred })
              }).catch(() => {});
            };
            // Resume button
            card.querySelector('.session-resume-btn').onclick = (e) => {
              e.stopPropagation();
              showModal('Resume Session', 'This will exit the current Claude conversation and resume the selected session.', [
                { label: 'Cancel' },
                { label: 'Resume', class: 'primary', action: () => {
                  const sid = activeSessionId;
                  if (sid && sessions[sid] && sessions[sid].ws && sessions[sid].ws.readyState === WebSocket.OPEN) {
                    sessions[sid].ws.send(JSON.stringify({ type: 'input', data: '/exit\r' }));
                    setTimeout(() => {
                      sessions[sid].ws.send(JSON.stringify({ type: 'input', data: 'claude --resume ' + s.id + '\r' }));
                    }, 1500);
                    delete messengerMessages[sid];
                    delete cachedPanes[sid];
                    fetch('/api/load-session?name=' + encodeURIComponent(name) + '&session=' + encodeURIComponent(s.id))
                      .then(() => setTimeout(() => renderMessenger(), 2000));
                  }
                }}
              ]);
            };
            // Delete button
            card.querySelector('.session-delete-btn').onclick = (e) => {
              e.stopPropagation();
              if (isActive) {
                showModal('Cannot Delete', 'This is the active session. Switch to a different session before deleting.', [
                  { label: 'OK', class: 'primary' }
                ]);
                return;
              }
              showModal('Delete Session', 'This will permanently delete this conversation. This cannot be undone.', [
                { label: 'Cancel' },
                { label: 'Delete', class: 'danger', action: () => {
                  fetch('/api/session', {
                    method: 'DELETE',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ name, session: s.id })
                  }).then(r => r.json()).then(d => {
                    if (d.ok) {
                      card.remove();
                      delete window._sessionsCache[name];
                    }
                  }).catch(() => {});
                }}
              ]);
            };
            wrapper.appendChild(card);
          }
          window._sessionsCache[name] = wrapper;
          content.appendChild(wrapper);
        }).catch(() => {
          content.innerHTML = '<div style="padding:20px;text-align:center;font-family:var(--font-mono);font-size:11px;color:var(--text3)">Failed to load sessions</div>';
        });
    } else {
      content.innerHTML = '<div style="padding:20px;text-align:center;font-family:var(--font-mono);font-size:11px;color:var(--text3)">No active project</div>';
    }
  } else if (panel === 'notes') {
    setHeader('Notes');

    // Scope selector: General or current project
    const scopeBar = document.createElement('div');
    scopeBar.className = 'notes-scope';
    const projectName = activeSessionId && sessions[activeSessionId] ? sessions[activeSessionId].name : '';
    let noteScope = 'general';

    const btnGeneral = document.createElement('button');
    btnGeneral.className = 'notes-scope-btn active';
    btnGeneral.textContent = 'General';
    btnGeneral.onclick = () => { noteScope = 'general'; btnGeneral.classList.add('active'); btnProject.classList.remove('active'); loadNotes(); };

    const btnProject = document.createElement('button');
    btnProject.className = 'notes-scope-btn';
    btnProject.textContent = projectName || 'Project';
    btnProject.disabled = !projectName;
    btnProject.onclick = () => { noteScope = 'project'; btnProject.classList.add('active'); btnGeneral.classList.remove('active'); loadNotes(); };

    scopeBar.appendChild(btnGeneral);
    scopeBar.appendChild(btnProject);
    content.appendChild(scopeBar);

    // Input
    const noteInput = document.createElement('textarea');
    noteInput.className = 'notes-input';
    noteInput.placeholder = 'Quick note...';
    noteInput.rows = 2;
    content.appendChild(noteInput);

    const addBtn = document.createElement('button');
    addBtn.className = 'notes-add-btn';
    addBtn.textContent = 'Add Note';
    addBtn.onclick = async () => {
      const text = noteInput.value.trim();
      if (!text) return;
      const name = noteScope === 'project' ? projectName : '';
      await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, note: { text, ts: Date.now(), time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), date: new Date().toLocaleDateString(), project: name || 'general' } })
      });
      noteInput.value = '';
      loadNotes();
    };
    content.appendChild(addBtn);

    noteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addBtn.click(); }
    });

    const notesList = document.createElement('div');
    notesList.id = 'notes-list';
    content.appendChild(notesList);

    async function loadNotes() {
      const name = noteScope === 'project' ? projectName : '';
      try {
        const resp = await fetch('/api/notes?name=' + encodeURIComponent(name));
        const notes = await resp.json();
        notesList.innerHTML = '';
        if (notes.length === 0) {
          notesList.innerHTML = '<div style="padding:16px;text-align:center;font-family:var(--font-mono);font-size:11px;color:var(--text3)">No notes yet</div>';
          return;
        }
        for (const n of [...notes].reverse()) {
          const card = document.createElement('div');
          card.className = 'flag-card note-card';
          card.innerHTML = '<div class="flag-card-text">' + n.text + '</div>'
            + '<div class="flag-card-time">' + (n.date || '') + ' · ' + (n.time || '') + '</div>';
          card.querySelector('.flag-card-text').onclick = (e) => { e.stopPropagation(); e.target.classList.toggle('expanded'); };
          const copyBtn = document.createElement('button');
          copyBtn.className = 'note-copy';
          copyBtn.innerHTML = '&#x2398;';
          copyBtn.title = 'Copy';
          copyBtn.onclick = (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(n.text);
            copyBtn.innerHTML = '&#x2713;';
            setTimeout(() => { copyBtn.innerHTML = '&#x2398;'; }, 1000);
          };
          card.appendChild(copyBtn);
          const delBtn = document.createElement('button');
          delBtn.className = 'note-delete';
          delBtn.innerHTML = '&times;';
          delBtn.onclick = async (e) => {
            e.stopPropagation();
            await fetch('/api/notes', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, ts: n.ts }) });
            loadNotes();
          };
          card.appendChild(delBtn);
          notesList.appendChild(card);
        }
      } catch(e) { notesList.innerHTML = '<div style="padding:16px;text-align:center;font-family:var(--font-mono);font-size:11px;color:var(--text3)">Failed to load</div>'; }
    }
    loadNotes();
    setTimeout(() => noteInput.focus(), 100);
  }

  body.appendChild(content);
}

function scrollToMessage(sid, msgIndex, searchTerm) {
  const panes = document.querySelectorAll('.messenger-split-pane');
  for (const pane of panes) {
    if (pane.dataset.sessionId !== sid) continue;
    const chatArea = pane.querySelector('.chat-messages');
    const bubbles = chatArea.querySelectorAll('.msg');
    const bubble = bubbles[msgIndex];
    if (!bubble) continue;

    // Clear any previous highlights
    document.querySelectorAll('.msg-bubble.search-highlight').forEach(el => {
      el.classList.remove('search-highlight');
    });
    document.querySelectorAll('.search-mark').forEach(el => {
      el.replaceWith(el.textContent);
    });

    const msgBubble = bubble.querySelector('.msg-bubble');
    if (msgBubble) {
      // Highlight the bubble border
      msgBubble.classList.add('search-highlight');
      setTimeout(() => msgBubble.classList.remove('search-highlight'), 4000);

      // Highlight search term inside the bubble
      if (searchTerm) {
        const escaped = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(escaped, 'gi');
        const walker = document.createTreeWalker(msgBubble, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode);
        for (const node of textNodes) {
          if (re.test(node.textContent)) {
            const frag = document.createDocumentFragment();
            let last = 0;
            node.textContent.replace(re, (match, offset) => {
              frag.appendChild(document.createTextNode(node.textContent.slice(last, offset)));
              const mark = document.createElement('span');
              mark.className = 'search-mark';
              mark.textContent = match;
              frag.appendChild(mark);
              last = offset + match.length;
            });
            frag.appendChild(document.createTextNode(node.textContent.slice(last)));
            node.parentNode.replaceChild(frag, node);
          }
        }
      }
    }

    bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function createImageBubble(role, blobUrl, time, sizeInfo, ts) {
  const msg = document.createElement('div');
  msg.className = `msg ${role}`;
  if (ts) msg.dataset.mediaTs = ts;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble msg-image';
  const img = document.createElement('img');
  img.src = blobUrl;
  img.onload = () => {
    const chatArea = msg.closest('.chat-messages');
    const pane = msg.closest('.messenger-split-pane, .split-messenger');
    const sid = pane?.dataset?.sessionId;
    if (chatArea && scrollLockedToBottom[sid] !== false) { if (chatArea._scrollToBottom) chatArea._scrollToBottom(); else chatArea.scrollTop = chatArea.scrollHeight; }
  };
  img.onclick = () => {
    const viewer = document.createElement('div');
    viewer.className = 'image-viewer';
    viewer.innerHTML = `<img src="${blobUrl}">`;
    viewer.onclick = () => viewer.remove();
    document.body.appendChild(viewer);
  };
  const delBtn = document.createElement('button');
  delBtn.className = 'img-delete-btn';
  delBtn.innerHTML = '&times;';
  delBtn.title = 'Delete image';
  delBtn.onclick = (e) => {
    e.stopPropagation();
    deleteImage(msg, ts);
  };
  bubble.appendChild(delBtn);
  bubble.appendChild(img);
  msg.appendChild(bubble);
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  let metaText = time || '';
  if (sizeInfo) {
    const pct = Math.round((sizeInfo.totalBytes / SESSION_IMAGE_LIMIT) * 100);
    metaText += (metaText ? ' · ' : '') + formatBytes(sizeInfo.imageSize);
    metaText += ' · ' + sizeInfo.imageNum + ' image' + (sizeInfo.imageNum > 1 ? 's' : '');
    metaText += ' · ' + formatBytes(sizeInfo.totalBytes) + ' / 20 MB';
    if (pct > 80) meta.style.color = 'var(--red)';
    else if (pct > 50) meta.style.color = 'var(--amber)';
  }
  if (metaText) {
    meta.textContent = metaText;
    msg.appendChild(meta);
  }
  return msg;
}

function deleteImage(msgEl, ts) {
  const projectName = activeSessionId && sessions[activeSessionId] ? sessions[activeSessionId].name : '';
  if (!projectName || !ts) { msgEl.remove(); return; }
  fetch('/api/chat-media', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: projectName, ts })
  }).then(() => {
    msgEl.remove();
    // Remove from local cache
    if (activeSessionId && messengerMessages[activeSessionId]) {
      messengerMessages[activeSessionId] = messengerMessages[activeSessionId].filter(m => m.ts !== ts);
    }
  }).catch(e => console.error('Delete image failed:', e));
}

function addMessengerImage(sessionId, role, blobUrl, filePath, imageSize, mediaTs) {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const ts = mediaTs || Date.now();
  const sizeInfo = imageSize ? { imageSize, imageNum: sessionImageCount, totalBytes: sessionImageBytes } : null;
  if (!messengerMessages[sessionId]) messengerMessages[sessionId] = [];
  messengerMessages[sessionId].push({ role, type: 'image', blobUrl, filePath, time, sizeInfo, ts });

  const allPanes = document.querySelectorAll('.messenger-split-pane, .split-messenger');
  for (const pane of allPanes) {
    if (pane.dataset.sessionId !== sessionId) continue;
    if (pane.closest('.messenger-pane:not(.active)') || pane.closest('.split-view:not(.active)')) continue;
    const chatArea = pane.querySelector('.chat-messages');
    if (!chatArea) continue;
    chatArea.appendChild(createImageBubble(role, blobUrl, time, sizeInfo, ts));
    if (scrollLockedToBottom[pane.dataset.sessionId] !== false) {
      if (chatArea._scrollToBottom) chatArea._scrollToBottom(); else chatArea.scrollTop = chatArea.scrollHeight;
    }
  }
}

function addMessengerMessage(sessionId, role, text, extra) {
  if (!text || !text.trim()) return;
  const trimmed = text.trim();
  if (sentScreenshotPaths.has(trimmed) || isImagePath(trimmed) || /^\[Image:/.test(trimmed) || /\.screenshots[/\\]/i.test(trimmed) || /\.(png|jpg|jpeg|gif|webp)$/im.test(trimmed)) {
    // If we sent this screenshot, it's already displayed — just suppress the text
    if (sentScreenshotPaths.has(trimmed)) {
      sentScreenshotPaths.delete(trimmed);
      return;
    }
    // Image sent from another device — fetch and display it
    if (sessions[sessionId]) {
      fetch('/api/chat-media?name=' + encodeURIComponent(sessions[sessionId].name))
        .then(r => r.json())
        .then(media => {
          if (media.length > 0) {
            const latest = media[media.length - 1];
            const existing = (messengerMessages[sessionId] || []).find(m => m.ts === latest.ts);
            if (!existing) {
              addMessengerImage(sessionId, 'user', latest.url, '', latest.size, latest.ts);
            }
          }
        }).catch(() => {});
    }
    return;
  }
  // Skip system notifications (task notifications, progress, etc.)
  if (/^<task-notification|^<system-reminder|^<usage>/.test(trimmed)) return;
  if (!messengerMessages[sessionId]) messengerMessages[sessionId] = [];
  const msgs = messengerMessages[sessionId];
  for (let i = Math.max(0, msgs.length - 5); i < msgs.length; i++) {
    if (msgs[i].role === role && msgs[i].text === trimmed) return;
  }
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const meta = { responseTime: extra?.responseTime, tokens: extra?.tokens };
  msgs.push({ role, text: trimmed, time, meta });

  // Remove typing indicator only for assistant messages
  if (role === 'assistant') showMessengerTyping(sessionId, false);
  // Remove prompt notification when new message arrives
  document.querySelectorAll('.messenger-split-pane').forEach(p => {
    if (p.dataset.sessionId === sessionId) {
      const pw = p.querySelector('.prompt-waiting');
      if (pw) pw.remove();
    }
  });

  // Render in any visible chat area for this session
  let _autoPlayBubble = null;
  const allPanes = document.querySelectorAll('.messenger-split-pane, .split-messenger');
  for (const pane of allPanes) {
    const paneSid = pane.dataset.sessionId;
    if (paneSid !== sessionId) continue;
    if (pane.closest('.messenger-pane:not(.active)') || pane.closest('.split-view:not(.active)')) continue;
    const chatArea = pane.querySelector('.chat-messages');
    if (!chatArea) continue;
    const bubble = createMsgBubble(role, text.trim(), time, meta);
    if (role === 'assistant') {
      const typing = chatArea.querySelector('.typing');
      if (typing) {
        chatArea.insertBefore(bubble, typing);
      } else {
        chatArea.appendChild(bubble);
      }
      if (!_autoPlayBubble) _autoPlayBubble = bubble;
    } else {
      chatArea.appendChild(bubble);
    }
    // Only auto-scroll if user is locked to bottom (following chat)
    if (scrollLockedToBottom[paneSid] !== false) {
      if (chatArea._scrollToBottom) chatArea._scrollToBottom(); else chatArea.scrollTop = chatArea.scrollHeight;
    }
  }
  // Auto-play TTS once (outside loop) for new live assistant messages
  if (role === 'assistant' && _vpAutoPlay && !_vpLoadingHistory) {
    const _isMuted = sessionId && sessions[sessionId] && sessions[sessionId].muted;
    if (!_isMuted) {
      if (_vp.active) {
        // Queue for later — will play when current finishes
        if (_autoPlayBubble) {
          const readBtn = _autoPlayBubble.querySelector('.bubble-read-btn');
          const msgBubble = _autoPlayBubble.querySelector('.msg-bubble') || _autoPlayBubble;
          _vpQueue.push({ bubble: msgBubble, text: trimmed, readBtn });
        } else {
          _vpQueue.push({ bubble: null, text: trimmed, readBtn: null });
        }
      } else {
        if (_autoPlayBubble) {
          const readBtn = _autoPlayBubble.querySelector('.bubble-read-btn');
          const msgBubble = _autoPlayBubble.querySelector('.msg-bubble') || _autoPlayBubble;
          if (readBtn) {
            const startPlay = () => _vpStart(msgBubble, trimmed, readBtn, 0);
            if (document.hasFocus()) {
              setTimeout(startPlay, 100);
            } else {
              queueMicrotask(startPlay);
            }
          }
        } else {
          _vpPlayAudioOnly(trimmed);
        }
      }
    }
  }
}

const toolVerbs = {
  'Read': 'Reading...', 'Edit': 'Editing...', 'Write': 'Writing...',
  'Bash': 'Running command...', 'Grep': 'Searching...', 'Glob': 'Searching files...',
  'Agent': 'Launching agent...', 'WebSearch': 'Searching web...',
  'WebFetch': 'Fetching page...', 'Skill': 'Running skill...',
  'NotebookEdit': 'Editing notebook...', 'ToolSearch': 'Finding tools...',
  'SendMessage': 'Messaging agent...',
};

let _typingCache = {}; // { sessionId: { phase, toolCount, agents, tokens } }

function showMessengerTyping(sessionId, show, tools, agents) {
  if (viewMode !== 'messenger' && viewMode !== 'split') return;
  const panes = document.querySelectorAll('.messenger-split-pane');
  for (const p of panes) {
    if (p.dataset.sessionId !== sessionId) continue;
    const ca = p.querySelector('.chat-messages');
    if (ca) { _showTypingInArea(sessionId, ca, show, tools, agents); }
  }
}

function _showTypingInArea(sessionId, chatArea, show, tools, agents) {
  let existing = chatArea.querySelector('.typing');
  if (show) {
    if (!existing) {
      existing = document.createElement('div');
      existing.className = 'msg typing';
      existing.title = 'Click to cancel';
      existing.style.cursor = 'pointer';
      existing.onclick = () => cancelClaude(sessionId);
      chatArea.appendChild(existing);
    }
    const s = sessions[sessionId];
    const lastTool = tools && tools.length > 0 ? tools[tools.length - 1] : null;
    const phase = lastTool ? (toolVerbs[lastTool] || lastTool + '...') : 'Thinking...';
    const toolCount = tools ? tools.length : 0;
    const tokens = s ? s._currentResponseTokens || 0 : 0;

    // Skip DOM update if nothing changed
    const cache = _typingCache[sessionId];
    if (cache && cache.phase === phase && cache.toolCount === toolCount && cache.agents === agents && cache.tokens === tokens) {
      return;
    }
    _typingCache[sessionId] = { phase, toolCount, agents, tokens };

    let html = '<div class="typing-row"><div class="typing-status"><span class="status-text">' + phase + '</span></div>';
    if (toolCount > 0) {
      html += '<div class="typing-tools">';
      for (const t of tools) html += '<span class="tool-badge' + (t === 'Agent' ? ' agent' : '') + '">' + t + '</span>';
      html += '</div>';
    }
    if (agents > 0) html += '<span class="agent-count">' + agents + ' agent' + (agents > 1 ? 's' : '') + '</span>';
    if (tokens > 0) html += '<span class="token-count">' + tokens + ' tok</span>';
    html += '</div>';
    existing.innerHTML = html;
    if (scrollLockedToBottom[sessionId] !== false) { if (chatArea._scrollToBottom) chatArea._scrollToBottom(); else chatArea.scrollTop = chatArea.scrollHeight; }
  } else if (!show && existing) {
    existing.remove();
    delete _typingCache[sessionId];
  }
}

function showPromptNotification(sessionId) {
  // Use cached pane first, fallback to DOM scan
  const cached = cachedPanes[sessionId];
  const panesArr = cached ? [cached] : document.querySelectorAll('.messenger-split-pane');
  for (const pane of panesArr) {
    if (pane.dataset.sessionId !== sessionId) continue;
    {
      const chatArea = pane.querySelector('.chat-messages');
      if (!chatArea) continue;
      // Remove any existing prompt notification
      const old = chatArea.querySelector('.prompt-waiting');
      if (old) old.remove();
      const notice = document.createElement('div');
      notice.className = 'msg prompt-waiting';
      notice.innerHTML = '<div class="prompt-badge">Waiting for your input</div>';
      chatArea.appendChild(notice);
      if (scrollLockedToBottom[sessionId] !== false) { if (chatArea._scrollToBottom) chatArea._scrollToBottom(); else chatArea.scrollTop = chatArea.scrollHeight; }
      // Focus the textarea
      const textarea = pane.querySelector('.chat-textarea');
      if (textarea) textarea.focus();
    }
  }
}

function cancelClaude(sessionId) {
  const s = sessions[sessionId];
  if (s && s.ws && s.ws.readyState === WebSocket.OPEN) {
    s.ws.send(JSON.stringify({ type: 'input', data: '\x1b' }));
    // Show cancelled state on the thinking bubble
    const panes = document.querySelectorAll('.messenger-split-pane, .split-messenger');
    for (const pane of panes) {
      const typing = pane.querySelector('.typing');
      if (typing) {
        typing.innerHTML = '<div class="typing-row"><div class="typing-status cancelled"><span class="status-text">Interrupted</span></div></div>';
        typing.style.cursor = 'default';
        typing.onclick = null;
        setTimeout(() => typing.remove(), 2000);
      }
    }
    if (s) { s.isThinking = false; s.toolHistory = []; }
  }
}

function updateInfoPanel(sessionId, msg) {
  if (!msg) return;
  const panels = document.querySelectorAll('.global-stats[data-sid="' + sessionId + '"]');
  for (const panel of panels) {
    const contextUsed = msg.contextUsed || 0;
    const contextMax = 1000000;
    const pct = Math.round((contextUsed / contextMax) * 100);
    const contextK = Math.round(contextUsed / 1000);

    const set = (f, v) => { const el = panel.querySelector('[data-field="' + f + '"]'); if (el) el.textContent = v; };
    set('model', 'Opus 4.6');
    set('context', contextK + 'K / 1M');
    set('contextPct', pct + '%');

    const bar = panel.querySelector('[data-field="contextBar"]');
    if (bar) {
      bar.style.width = pct + '%';
      bar.style.background = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--amber)' : 'var(--accent2)';
    }

    const s = sessions[sessionId];
    set('tokens', (s?._outputTokens || msg.outputTokens || 0) + ' tok');

    // Images
    const imgMB = (sessionImageBytes / (1024 * 1024)).toFixed(1);
    set('images', sessionImageCount + ' · ' + imgMB + ' MB');
    const imgBar = panel.querySelector('[data-field="imageBar"]');
    if (imgBar) imgBar.style.width = Math.round((sessionImageBytes / SESSION_IMAGE_LIMIT) * 100) + '%';

    // Agents
    const agentWrap = panel.querySelector('[data-field="agentsWrap"]');
    if (agentWrap && s?.activeAgents > 0) {
      agentWrap.style.display = '';
      set('agents', s.activeAgents + ' running');
    } else if (agentWrap) {
      agentWrap.style.display = 'none';
    }
  }
}

async function loadStats(sessionId) {
  const s = sessions[sessionId];
  if (!s || s.isShell) return;
  try {
    const resp = await fetch('/api/stats?name=' + encodeURIComponent(s.name));
    const stats = await resp.json();
    if (stats.context) {
      s._outputTokens = stats.outputTokens || 0;
      sessionImageCount = stats.imageCount || 0;
      sessionImageBytes = stats.imageBytes || 0;
      updateInfoPanel(sessionId, { contextUsed: stats.context, outputTokens: stats.outputTokens, model: stats.model });
    }
  } catch(e) {}
}
