// T-Term — iPad-specific overrides
// Runs after app.js, views.js, messenger.js — only activates on iPad

if (isIPad) {

  // Mark body for iPad-specific CSS
  document.body.classList.add('ipad');
  // Detect PWA standalone mode (Add to Home Screen)
  if (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches) {
    document.body.classList.add('ipad-pwa');
  }

  // ── Connection indicator badge (uses server-side detection from app.js) ──
  const initColor = _connColors[connInfo.route] || _connColors.unknown;
  const _connIcon = document.createElement('div');
  _connIcon.className = 'conn-badge';
  _connIcon.title = _connTitles[connInfo.route] || '';
  _connIcon.style.cssText = 'position:fixed;top:8px;right:8px;z-index:9999;display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:12px;font-size:9px;letter-spacing:0.5px;font-family:var(--font-mono);pointer-events:none;' +
    'background:rgba(' + initColor + ',0.12);border:1px solid rgba(' + initColor + ',0.25);color:rgb(' + initColor + ');transition:all 0.3s;';
  _connIcon.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/></svg>' +
    '<span class="conn-label">' + (_connLabels[connInfo.route] || '?') + '</span>';
  document.body.appendChild(_connIcon);

  // Adjust position if in PWA mode (below status bar)
  if (document.body.classList.contains('ipad-pwa')) {
    _connIcon.style.top = 'calc(env(safe-area-inset-top, 8px) + 4px)';
  }

  // Reconnect WebSocket when returning from background (iPadOS kills WS when backgrounded)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    for (const id of Object.keys(sessions)) {
      const s = sessions[id];
      if (s && s.ws && s.ws.readyState !== WebSocket.OPEN) {
        try { s.ws.close(); } catch(e) {}
      }
    }
  });

  // Voice input — uses shared Whisper STT from messenger.js (_sttToggle)
  function ipadToggleMic(micBtn, textarea) {
    _sttToggle(micBtn, textarea);
  }

  // TTS is now handled by the voice player in messenger.js
  // (Kokoro streaming, sentence-by-sentence with highlighting)

  // Override createMessengerPane to add photo picker + wire mic button
  const _origCreateMessengerPane = createMessengerPane;
  createMessengerPane = function(sid, paneIdx, totalPanes) {
    const pane = _origCreateMessengerPane(sid, paneIdx, totalPanes);

    const inputRow = pane.querySelector('.chat-input-row');
    if (!inputRow) return pane;

    // Wire mic button for voice input
    const micBtn = inputRow.querySelector('.mic-btn');
    if (micBtn && !micBtn._ipadWired) {
      micBtn._ipadWired = true;
      const textarea = inputRow.querySelector('.chat-textarea');
      micBtn.onclick = (e) => { e.preventDefault(); ipadToggleMic(micBtn, textarea); };
    }
    // Stop mic recording when send is pressed
    const sendBtn = inputRow.querySelector('.send-btn');
    if (sendBtn && !sendBtn._ipadWired) {
      sendBtn._ipadWired = true;
      const origClick = sendBtn.onclick;
      sendBtn.onclick = (e) => {
        if (_sttRecording && micBtn) ipadToggleMic(micBtn, inputRow.querySelector('.chat-textarea'));
        if (origClick) origClick(e);
      };
    }

    // Add photo picker if not already present
    if (!inputRow.querySelector('.ipad-photo-btn')) {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.style.display = 'none';
      fileInput.onchange = () => {
        const file = fileInput.files[0];
        if (file) {
          uploadScreenshot(file);
          fileInput.value = '';
        }
      };

      const photoBtn = document.createElement('button');
      photoBtn.className = 'mic-btn ipad-photo-btn';
      photoBtn.title = 'Photo Library';
      photoBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
      photoBtn.onclick = (e) => { e.preventDefault(); fileInput.click(); };

      // Insert after mic button (mic first, then photo)
      if (micBtn) {
        micBtn.after(fileInput);
        fileInput.after(photoBtn);
      } else {
        inputRow.prepend(fileInput);
        inputRow.prepend(photoBtn);
      }
    }

    return pane;
  };

}
