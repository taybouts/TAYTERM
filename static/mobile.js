// T-Term — Mobile-specific UI and chat interface

// ==========================================
//  Mobile Chat UI
// ==========================================
let mobileWs = null;
let mobileProject = null;
let mobileMuted = false;
let mobileTerm = null;
let mobileTermView = false;
let mobileLastMsgCount = 0;
let mobilePollTimer = null;

function mobileInit() {
  if (!isMobile) return;
  // Hide desktop UI, show mobile picker
  document.getElementById('terminal-view').classList.remove('active');
  // The picker works for mobile too — cards open mobile chat instead
}

function mobileOpenSession(name, continueFlag) {
  mobileProject = name;
  hidePicker();
  document.getElementById('mobile-chat').style.display = 'flex';
  document.getElementById('mobile-project-name').textContent = name;
  document.getElementById('mobile-messages').innerHTML = '';
  document.getElementById('mobile-mute').textContent = 'MUTE';
  document.getElementById('mobile-mute').classList.remove('muted');
  mobileMuted = false;

  // Load conversation history from JSONL
  mobileLoadHistory(name);

  // Connect WebSocket with auto-reconnect
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const baseWsUrl = proto + '//' + location.host + '/ws?project=' + encodeURIComponent(name);
  let firstConnect = !continueFlag;

  function mobileConnect() {
    const url = baseWsUrl + (firstConnect ? '&claude=1' : '&continue=1');
    firstConnect = false; // All reconnects use continue
    mobileWs = new WebSocket(url);
    mobileWs.onopen = () => {
      document.getElementById('mobile-project-name').textContent = mobileProject;
    };
    mobileWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'chat') {
          if (msg.role === 'user' && msg.text) {
            const t = msg.text.trim();
            // Skip image paths
            const isImg = /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(t) || /^\[Image:/.test(t) || /^(C:\\|\/[a-z]|\.\.\/|\.screenshots)/i.test(t);
            if (!isImg) {
              // Dedup — skip if we already added this message locally
              const existing = document.querySelectorAll('#mobile-messages .msg.user .msg-bubble');
              const lastUserBubble = existing[existing.length - 1];
              if (!lastUserBubble || lastUserBubble.textContent.trim() !== t) {
                mobileAddMessage('user', msg.text);
              }
            }
          } else if (msg.role === 'assistant' && msg.text) {
            mobileStreamDiv = null;
            const typing = document.getElementById('mobile-typing');
            if (typing) typing.remove();
            mobileToolBadges = [];
            mobileAddMessage('assistant', msg.text);
          }
        } else if (msg.type === 'thinking') {
          mobileShowTyping('Thinking...');
        } else if (msg.type === 'tool') {
          mobileShowTyping('Working...', msg.tools);
        } else if (msg.type === 'output' && mobileTerm) {
          mobileTerm.write(msg.data);
        }
      } catch(err) {}
    };
    mobileWs.onclose = () => {
      if (mobileProject) {
        document.getElementById('mobile-project-name').textContent = mobileProject + ' (reconnecting...)';
        setTimeout(mobileConnect, 2000);
      }
    };
  }
  mobileConnect();

  // Reconnect when returning from background (iOS kills WebSocket when backgrounded)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && mobileProject) {
      if (!mobileWs || mobileWs.readyState !== WebSocket.OPEN) {
        mobileConnect();
      }
    }
  });

  // Auto-grow textarea
  const input = document.getElementById('mobile-input');
  input.value = '';
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      mobileSend();
    }
  });
  // Don't auto-focus input on mobile — prevents keyboard from popping up on load
}

async function mobileLoadHistory(name) {
  try {
    const resp = await fetch('/api/conversation?name=' + encodeURIComponent(name));
    const messages = await resp.json();

    // Fetch images
    let media = [];
    try {
      const mediaResp = await fetch('/api/chat-media?name=' + encodeURIComponent(name));
      media = await mediaResp.json();
    } catch(e) {}

    // Merge text and images by timestamp
    const allItems = [];
    for (const m of messages) {
      if ((m.role === 'user' || m.role === 'assistant') && m.text) {
        // Skip image path messages
        if (/\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(m.text.trim())) continue;
        if (/^\[Image:/.test(m.text)) continue;
        allItems.push({ type: 'text', role: m.role, text: m.text, time: m.time || '', ts: m.ts || 0 });
      }
    }
    for (const img of media) {
      allItems.push({ type: 'image', url: img.url, time: img.time || '', ts: img.ts || 0 });
    }
    allItems.sort((a, b) => a.ts - b.ts);

    const container = document.getElementById('mobile-messages');
    for (const item of allItems) {
      if (item.type === 'image') {
        mobileAddImage(item.url, item.time);
      } else {
        mobileAddMessage(item.role, item.text, item.time);
      }
    }
    mobileLastMsgCount = messages.length;
    container.scrollTop = container.scrollHeight;
  } catch(err) {}
}

function mobileAddImage(url, time) {
  const container = document.getElementById('mobile-messages');
  const msg = document.createElement('div');
  msg.className = 'msg user';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble msg-image';
  const img = document.createElement('img');
  img.src = url;
  img.onclick = () => {
    const viewer = document.createElement('div');
    viewer.className = 'image-viewer';
    viewer.innerHTML = '<img src="' + url + '">';
    viewer.onclick = () => viewer.remove();
    document.body.appendChild(viewer);
  };
  bubble.appendChild(img);
  msg.appendChild(bubble);
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = time || '';
  msg.appendChild(meta);
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

async function mobileUploadPhoto(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = ''; // Reset so same file can be picked again

  const blob = file;
  const ts = Date.now();
  const projectName = mobileProject || '';

  // Show image immediately in mobile chat
  const displayUrl = URL.createObjectURL(blob);
  mobileAddImage(displayUrl, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

  // Upload full quality
  const rawForm = new FormData();
  if (projectName) rawForm.append('project', projectName);
  rawForm.append('file', new File([blob], 'photo_' + ts + '.jpg', { type: file.type }));
  let fullUrl = null;
  try {
    const rawResp = await fetch('/upload', { method: 'POST', body: rawForm });
    const rawResult = await rawResp.json();
    fullUrl = rawResult.url || null;
  } catch(e) {}

  // Upload compressed for Claude
  const compressed = await compressImage(blob, 1280, 0.8);
  const compForm = new FormData();
  if (projectName) compForm.append('project', projectName);
  compForm.append('subfolder', 'sm');
  compForm.append('file', new File([compressed], 'photo_' + ts + '.jpg', { type: 'image/jpeg' }));
  try {
    const resp = await fetch('/upload', { method: 'POST', body: compForm });
    const result = await resp.json();
    if (result.path && mobileWs && mobileWs.readyState === WebSocket.OPEN) {
      // Save image reference
      const imgUrl = fullUrl || result.url || displayUrl;
      fetch('/api/chat-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: projectName, media: { url: imgUrl, time: new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}), size: compressed.size, ts } })
      }).catch(() => {});
      // Send path to Claude via PTY
      mobileWs.send(JSON.stringify({ type: 'input', data: result.path + '\r' }));
    }
  } catch(e) { console.error('Photo upload failed:', e); }
}

let mobileToolBadges = [];

function mobileShowTyping(status, tools) {
  const container = document.getElementById('mobile-messages');
  let ind = document.getElementById('mobile-typing');
  if (!ind) {
    ind = document.createElement('div');
    ind.className = 'mobile-typing';
    ind.id = 'mobile-typing';
    container.appendChild(ind);
  }
  // Accumulate tool badges
  if (tools) {
    for (const t of tools) {
      if (!mobileToolBadges.includes(t)) mobileToolBadges.push(t);
    }
  }
  let html = '<div class="typing-row"><div class="typing-status"><span class="status-text">' + status + '</span></div>';
  if (mobileToolBadges.length > 0) {
    html += '<div class="typing-tools">' + mobileToolBadges.map(t => '<span class="tool-badge">' + t + '</span>').join('') + '</div>';
  }
  html += '</div>';
  ind.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function mobileAddMessage(role, text, time) {
  const container = document.getElementById('mobile-messages');
  const msg = document.createElement('div');
  msg.className = 'msg ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  if (role === 'assistant') {
    bubble.innerHTML = mobileRenderMarkdown(text);
    bubble.querySelectorAll('pre').forEach(pre => {
      pre.onclick = () => pre.classList.toggle('expanded');
    });
  } else {
    bubble.textContent = text;
  }
  msg.appendChild(bubble);
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  msg.appendChild(meta);
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function mobileAddTool(name, summary) {
  const container = document.getElementById('mobile-messages');
  const div = document.createElement('div');
  div.className = 'msg-tool';
  div.innerHTML = '<span class="tool-name">' + name + '</span>' + (summary ? ' ' + summary : '');
  container.appendChild(div);
}

// Strip ALL ANSI escape sequences (including true-color, OSC, cursor movement)
const ANSI_STRIP = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[>=<]|\x1b\[[\d;]*m|\r|\x0f/g;

function mobileCleanOutput(text) {
  text = text.replace(ANSI_STRIP, '');
  // Filter out lines that are tool output, diffs, file paths, prompts
  const lines = text.split('\n').filter(line => {
    const s = line.trim();
    if (!s) return false;
    // Skip diff lines
    if (/^[+-]{3}\s/.test(s)) return false;
    if (/^@@\s/.test(s)) return false;
    if (/^[+-]\s/.test(s) && !s.startsWith('- ')) return false;
    // Skip line numbers from diffs
    if (/^\d+[+-]?\s/.test(s) && s.length < 8) return false;
    // Skip file paths
    if (/^(C:\\|\/[a-z]|\.\.\/|src\/)/i.test(s)) return false;
    // Skip tool status lines
    if (/^(Reading|Writing|Editing|Searching|Running|Created|Updated|Grepping|Globbing|Read|Grep|Edit|Write|Bash|Glob)\s/i.test(s)) return false;
    if (/^(Read|Grep|Edit|Write|Bash|Glob|Agent|TaskCreate|TaskUpdate)\b/.test(s)) return false;
    // Skip box drawing / borders
    if (/^[─━═│┃┌┐└┘├┤┬┴┼╋▎▌]+$/.test(s)) return false;
    if (/^[\s]*[│|]/.test(s)) return false;
    return true;
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function mobileRenderMarkdown(text) {
  // Code blocks
  text = text.replace(/```[\w]*\n([\s\S]*?)```/g, '<pre>$1</pre>');
  // Inline code
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Line breaks to paragraphs
  text = text.split('\n\n').map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
  return text;
}

let mobileStreamDiv = null;

function mobileAppendStreaming(rawData) {
  const clean = mobileCleanOutput(rawData);
  if (!clean) return;
  const container = document.getElementById('mobile-messages');
  if (!mobileStreamDiv) {
    mobileStreamDiv = document.createElement('div');
    mobileStreamDiv.className = 'msg assistant';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    mobileStreamDiv.appendChild(bubble);
    container.appendChild(mobileStreamDiv);
  }
  const bubble = mobileStreamDiv.querySelector('.msg-bubble');
  bubble.dataset.raw = (bubble.dataset.raw || '') + clean;
  bubble.innerHTML = mobileRenderMarkdown(bubble.dataset.raw);
  bubble.querySelectorAll('pre').forEach(pre => {
    pre.onclick = () => pre.classList.toggle('expanded');
  });
  container.scrollTop = container.scrollHeight;
}

function mobileSend() {
  const input = document.getElementById('mobile-input');
  // Stop recording first and wait a moment for final result
  if (mobileIsRecording) {
    mobileStopMic();
    // Delay send slightly to let final recognition result land
    setTimeout(() => mobileSendText(), 300);
    return;
  }
  mobileSendText();
}

function mobileSendText() {
  const input = document.getElementById('mobile-input');
  const text = input.value.trim();
  if (!text) return;
  if (!mobileWs || mobileWs.readyState !== WebSocket.OPEN) {
    document.getElementById('mobile-project-name').textContent = mobileProject + ' (disconnected)';
    return;
  }
  mobileAddMessage('user', text);
  mobileStreamDiv = null;
  mobileWs.send(JSON.stringify({ type: 'input', data: text + '\r' }));
  input.value = '';
  input.style.height = 'auto';
}

async function mobilePollConversation(name) {
  try {
    const resp = await fetch('/api/conversation?name=' + encodeURIComponent(name));
    const messages = await resp.json();
    if (messages.length > mobileLastMsgCount) {
      // Render only new messages
      const newMsgs = messages.slice(mobileLastMsgCount);
      for (const msg of newMsgs) {
        if (msg.role === 'user' && msg.text) {
          // Skip if we already added it locally via mobileSend
          // Check last user msg in DOM
        } else if (msg.role === 'assistant' && msg.text) {
          mobileAddMessage('assistant', msg.text);
        } else if (msg.type === 'tool_use' && msg.name) {
          mobileAddTool(msg.name, msg.summary || '');
        }
      }
      mobileLastMsgCount = messages.length;
    }
  } catch(err) {}
}

function mobileShowPicker() {
  if (mobileWs) mobileWs.close();
  if (mobilePollTimer) clearInterval(mobilePollTimer);
  mobileWs = null;
  mobileProject = null;
  mobilePollTimer = null;
  mobileLastMsgCount = 0;
  document.getElementById('mobile-chat').style.display = 'none';
  showPicker();
}

let mobileRecognition = null;
let mobileIsRecording = false;
let mobileMicDismissed = false;

function mobileStopMic() {
  if (mobileRecognition) {
    mobileMicDismissed = true;
    mobileRecognition.stop();
  }
  mobileIsRecording = false;
  mobileRecognition = null;
  document.getElementById('mobile-mic').classList.remove('recording');
}

function mobileToggleMic() {
  const input = document.getElementById('mobile-input');

  if (mobileIsRecording) {
    // Cancel — stop and clear
    mobileStopMic();
    input.value = '';
    input.style.height = 'auto';
    return;
  }

  // Start recording
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('Speech recognition not supported'); return; }

  mobileMicDismissed = false;
  mobileRecognition = new SR();
  mobileRecognition.continuous = true;
  mobileRecognition.interimResults = true;
  mobileRecognition.lang = 'en-US';

  mobileRecognition.onresult = (e) => {
    if (mobileMicDismissed) return;
    let text = '';
    for (let i = 0; i < e.results.length; i++) {
      text += e.results[i][0].transcript;
    }
    input.value = text;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  };

  mobileRecognition.onend = () => {
    mobileIsRecording = false;
    document.getElementById('mobile-mic').classList.remove('recording');
    mobileRecognition = null;
  };

  mobileRecognition.onerror = () => {
    mobileIsRecording = false;
    document.getElementById('mobile-mic').classList.remove('recording');
    mobileRecognition = null;
  };

  mobileRecognition.start();
  mobileIsRecording = true;
  document.getElementById('mobile-mic').classList.add('recording');
  btn.classList.add('recording');
}

function mobileToggleView() {
  const messages = document.getElementById('mobile-messages');
  const termDiv = document.getElementById('mobile-terminal');
  const btn = document.getElementById('mobile-toggle-view');

  mobileTermView = !mobileTermView;

  if (mobileTermView) {
    // Switch to terminal view
    messages.style.display = 'none';
    termDiv.style.display = 'block';
    btn.textContent = 'CHAT';

    if (!mobileTerm) {
      mobileTerm = new Terminal({
        cursorBlink: true,
        scrollback: 1000,
        fontSize: 11,
        fontFamily: '"Fira Code", monospace',
        fontWeight: '300',
        theme: {
          background: '#000',
          foreground: '#ececec',
        },
      });
      const mFitAddon = new FitAddon.FitAddon();
      mobileTerm.loadAddon(mFitAddon);
      mobileTerm.open(termDiv);
      // No WebGL on mobile — canvas renderer only
      // Touch scroll for mobile terminal
      let tLastY = null, tVelocity = 0, tLastTime = 0, tMomentumId = null;
      termDiv.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
          tLastY = e.touches[0].clientY;
          tLastTime = Date.now();
          tVelocity = 0;
          if (tMomentumId) { cancelAnimationFrame(tMomentumId); tMomentumId = null; }
        }
      }, { passive: true });
      termDiv.addEventListener('touchmove', (e) => {
        if (tLastY === null || e.touches.length !== 1) return;
        const y = e.touches[0].clientY;
        const now = Date.now();
        const dt = now - tLastTime || 1;
        const dy = tLastY - y;
        tVelocity = dy / dt;
        const lines = Math.round(dy / 16);
        if (lines !== 0) mobileTerm.scrollLines(lines);
        tLastY = y;
        tLastTime = now;
      }, { passive: true });
      termDiv.addEventListener('touchend', () => {
        tLastY = null;
        let v = tVelocity;
        let remainder = 0;
        function momentum() {
          if (Math.abs(v) < 0.005) return;
          remainder += v * 16;
          const lines = Math.trunc(remainder);
          if (lines !== 0) { mobileTerm.scrollLines(lines); remainder -= lines; }
          v *= 0.968;
          tMomentumId = requestAnimationFrame(momentum);
        }
        tMomentumId = requestAnimationFrame(momentum);
      }, { passive: true });
      // Pinch to zoom — change font size
      let pinchStartDist = 0;
      let pinchStartSize = 11;
      termDiv.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          pinchStartDist = Math.sqrt(dx * dx + dy * dy);
          pinchStartSize = mobileTerm.options.fontSize;
        }
      }, { passive: true });
      termDiv.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && pinchStartDist > 0) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const scale = dist / pinchStartDist;
          const newSize = Math.round(Math.min(24, Math.max(6, pinchStartSize * scale)));
          if (newSize !== mobileTerm.options.fontSize) {
            mobileTerm.options.fontSize = newSize;
            mFitAddon.fit();
          }
        }
      }, { passive: true });
      termDiv.addEventListener('touchend', () => { pinchStartDist = 0; }, { passive: true });
      // Fit after render
      setTimeout(() => mFitAddon.fit(), 200);
      // Don't send resize — let desktop control PTY size
    } else {
      // Re-fit existing terminal
      setTimeout(() => mobileTerm.element && mobileTerm.refresh(0, mobileTerm.rows - 1), 100);
    }
  } else {
    // Switch to chat view
    messages.style.display = 'flex';
    termDiv.style.display = 'none';
    btn.textContent = 'TTY';
  }
}

function mobileToggleMute() {
  mobileMuted = !mobileMuted;
  const btn = document.getElementById('mobile-mute');
  btn.textContent = mobileMuted ? 'MUTED' : 'MUTE';
  btn.classList.toggle('muted', mobileMuted);
  if (mobileProject) {
    fetch(TTS_BASE + '/tts-state', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({project: mobileProject, state: mobileMuted ? 'muted' : 'default'})
    }).catch(() => {});
  }
}
