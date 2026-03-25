// T-Term — iPad-specific overrides
// Runs after app.js, views.js, messenger.js — only activates on iPad

if (isIPad) {

  // Mark both html and body for iPad-specific CSS
  document.documentElement.classList.add('ipad');
  document.body.classList.add('ipad');
  // Detect PWA standalone mode (Add to Home Screen)
  if (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches) {
    document.body.classList.add('ipad-pwa');
  }

  // Version indicator
  const _v = document.createElement('div');
  _v.textContent = 'iPad v17';
  _v.style.cssText = 'position:fixed;bottom:2px;left:2px;font-size:9px;color:rgba(255,255,255,0.2);z-index:9999;pointer-events:none;';
  document.body.appendChild(_v);

  // Unlock the html frame — overflow:hidden on html clips the safe area on iOS Safari
  document.documentElement.style.overflowY = 'visible';
  document.documentElement.style.overflowX = 'hidden';

  // ── Connection detection: LAN vs Tailscale vs Cloudflare ──
  const host = window.location.hostname;
  const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('192.168.');
  const isTailscale = !isLocal && (host.startsWith('100.64.') || host.startsWith('100.100.') || host.includes('tse.mesh'));
  const isCloudflare = !isLocal && !isTailscale;
  const connMode = isLocal ? 'local' : isTailscale ? 'tailscale' : 'cloudflare';
  const connLabel = isLocal ? 'LAN' : isTailscale ? 'TS' : 'CF';
  const connTitle = isLocal ? 'Local (direct)' : isTailscale ? 'Tailscale (direct)' : 'Cloudflare (proxied)';
  const connColor = isLocal ? '34,197,94' : isTailscale ? '56,189,248' : '245,158,11'; // green, blue, orange

  // Connection indicator badge
  const _connIcon = document.createElement('div');
  _connIcon.title = connTitle;
  _connIcon.style.cssText = 'position:fixed;top:8px;right:8px;z-index:9999;display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:12px;font-size:9px;letter-spacing:0.5px;font-family:var(--font-mono);pointer-events:none;' +
    'background:rgba(' + connColor + ',0.12);border:1px solid rgba(' + connColor + ',0.25);color:rgb(' + connColor + ');';
  _connIcon.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/></svg>' +
    '<span>' + connLabel + '</span>';
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

  // Voice input state
  let ipadRecognition = null;
  let ipadIsRecording = false;
  let ipadMicDismissed = false;

  function ipadToggleMic(micBtn, textarea) {
    if (ipadIsRecording) {
      // Stop recording
      ipadMicDismissed = true;
      if (ipadRecognition) ipadRecognition.stop();
      ipadIsRecording = false;
      ipadRecognition = null;
      micBtn.classList.remove('recording');
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    ipadMicDismissed = false;
    ipadRecognition = new SR();
    ipadRecognition.continuous = true;
    ipadRecognition.interimResults = true;
    ipadRecognition.lang = 'en-US';

    ipadRecognition.onresult = (e) => {
      if (ipadMicDismissed) return;
      let text = '';
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
      }
      textarea.value = text;
      textarea.style.height = '44px';
      if (textarea.scrollHeight > 44) textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    };

    ipadRecognition.onend = () => {
      ipadIsRecording = false;
      micBtn.classList.remove('recording');
      ipadRecognition = null;
    };

    ipadRecognition.start();
    ipadIsRecording = true;
    micBtn.classList.add('recording');
  }

  // ── TTS — stream audio from Kokoro via Tailscale, browser fallback ──
  // TTS: local direct, Tailscale direct, or Cloudflare proxy
  const IPAD_TTS = isCloudflare ? window.location.origin + '/api/tts' : 'http://' + host + ':7123';
  let _ttsAudioCtx = null;
  let _ttsAbort = null;
  let _ttsServerOk = null; // null=unknown, true/false=cached result

  function _ttsCtx() {
    if (!_ttsAudioCtx) _ttsAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_ttsAudioCtx.state === 'suspended') _ttsAudioCtx.resume();
    return _ttsAudioCtx;
  }

  // Check if Kokoro server is reachable (cached for 60s)
  async function _ttsCheckServer() {
    if (_ttsServerOk !== null) return _ttsServerOk;
    try {
      const resp = await fetch(IPAD_TTS + '/status', { signal: AbortSignal.timeout(2000) });
      _ttsServerOk = resp.ok;
    } catch(e) { _ttsServerOk = false; }
    setTimeout(() => { _ttsServerOk = null; }, 60000); // Re-check after 60s
    return _ttsServerOk;
  }

  // Stream PCM audio from Kokoro /stream endpoint (same as LEGAL app)
  async function _ttsStreamKokoro(text) {
    _ttsAbort = new AbortController();
    const resp = await fetch(IPAD_TTS + '/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.substring(0, 10000), voice: 'af_bella', speed: 1.25 }),
      signal: _ttsAbort.signal
    });
    if (!resp.ok) throw new Error('TTS ' + resp.status);
    const ctx = _ttsCtx();
    let nextPlayTime = ctx.currentTime;
    const reader = resp.body.getReader();
    let buffer = new Uint8Array(0);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Append to buffer
      const tmp = new Uint8Array(buffer.length + value.length);
      tmp.set(buffer); tmp.set(value, buffer.length);
      buffer = tmp;
      // Parse chunks: 4-byte little-endian length header + PCM data
      while (buffer.length >= 4) {
        const chunkLen = buffer[0] | (buffer[1] << 8) | (buffer[2] << 16) | (buffer[3] << 24);
        if (buffer.length < 4 + chunkLen) break;
        const pcm = buffer.slice(4, 4 + chunkLen);
        buffer = buffer.slice(4 + chunkLen);
        // Convert to float32 audio
        const samples = new Float32Array(pcm.length / 2);
        const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        for (let i = 0; i < samples.length; i++) {
          samples[i] = view.getInt16(i * 2, true) / 32768;
        }
        const audioBuf = ctx.createBuffer(1, samples.length, 24000);
        audioBuf.getChannelData(0).set(samples);
        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(ctx.destination);
        const startTime = Math.max(nextPlayTime, ctx.currentTime);
        src.start(startTime);
        nextPlayTime = startTime + audioBuf.duration;
      }
    }
  }

  // Browser SpeechSynthesis fallback
  function _ttsBrowserSpeak(text) {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.1;
    utter.pitch = 1.0;
    // Try to pick a good English voice
    const voices = synth.getVoices();
    const preferred = voices.find(v => v.name.includes('Samantha')) || voices.find(v => v.lang.startsWith('en'));
    if (preferred) utter.voice = preferred;
    synth.speak(utter);
  }

  function _ttsStop() {
    if (_ttsAbort) { _ttsAbort.abort(); _ttsAbort = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (_ttsAudioCtx) {
      _ttsAudioCtx.close().catch(() => {});
      _ttsAudioCtx = null;
    }
  }

  // Override readBubbleAloud to play on device instead of server speakers
  const _origReadBubble = readBubbleAloud;
  readBubbleAloud = function(text, btn) {
    if (btn.classList.contains('reading')) {
      btn.classList.remove('reading');
      _ttsStop();
      return;
    }
    btn.classList.add('reading');
    _ttsCheckServer().then(ok => {
      if (ok) {
        _ttsStreamKokoro(text).catch(() => _ttsBrowserSpeak(text)).finally(() => btn.classList.remove('reading'));
      } else {
        _ttsBrowserSpeak(text);
        btn.classList.remove('reading');
      }
    });
  };

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
