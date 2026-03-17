// ══════════════════════════════════════════
//  State
// ══════════════════════════════════════════
const sessions = {};  // { id: { name, term, ws, fitAddon, container, isShell } }
let activeSessionId = null;
let layout = 'single';
let paneSlots = [];  // session IDs assigned to panes
let selectedPane = 0;  // which pane is selected for tab assignment

// ══════════════════════════════════════════
//  Session persistence (localStorage)
// ══════════════════════════════════════════
function saveState() {
  const tabs = Object.values(sessions).map(s => ({ name: s.name, isShell: s.isShell, muted: s.muted || false }));
  const active = activeSessionId ? sessions[activeSessionId]?.name : null;
  localStorage.setItem('tayterm_tabs', JSON.stringify({ tabs, active, layout }));
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem('tayterm_tabs'));
  } catch(e) { return null; }
}

// ══════════════════════════════════════════
//  Project Picker
// ══════════════════════════════════════════
function getPinnedProjects() {
  try { return JSON.parse(localStorage.getItem('tayterm_pinned')) || []; } catch(e) { return []; }
}
function savePinnedProjects(list) {
  localStorage.setItem('tayterm_pinned', JSON.stringify(list));
}
function pinProject(name) {
  const pinned = getPinnedProjects();
  if (!pinned.includes(name)) pinned.push(name);
  savePinnedProjects(pinned);
  loadProjects();
}
function unpinProject(name) {
  savePinnedProjects(getPinnedProjects().filter(n => n !== name));
  loadProjects();
}
function movePinned(name, dir) {
  const pinned = getPinnedProjects();
  const i = pinned.indexOf(name);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= pinned.length) return;
  [pinned[i], pinned[j]] = [pinned[j], pinned[i]];
  savePinnedProjects(pinned);
  loadProjects();
}

function buildCard(p, isPinned, pinIdx, pinCount) {
  const card = document.createElement('div');
  card.className = 'project-card' + (p.live ? ' live' : '');
  let badges = '';
  if (p.live) badges += '<span class="badge badge-live">LIVE</span>';
  if (p.subscribers > 0) badges += '<span class="badge badge-subs">' + p.subscribers + '</span>';
  if (p.claude) badges += '<span class="badge badge-claude">CLAUDE</span>';
  if (p.git) badges += '<span class="badge badge-git">GIT</span>';

  // Pin controls in project-name row
  let pinHtml = '';
  if (isPinned) {
    const leftDisabled = pinIdx === 0 ? ' style="opacity:0.2;pointer-events:none"' : '';
    const rightDisabled = pinIdx === pinCount - 1 ? ' style="opacity:0.2;pointer-events:none"' : '';
    pinHtml =
      '<span class="pin-controls">' +
        '<span class="pin-arrow"' + leftDisabled + ' onclick="event.stopPropagation(); movePinned(\'' + p.name + '\', -1)">&lsaquo;</span>' +
        '<span class="pin-icon pinned" onclick="event.stopPropagation(); unpinProject(\'' + p.name + '\')" title="Unpin">&#9733;</span>' +
        '<span class="pin-arrow"' + rightDisabled + ' onclick="event.stopPropagation(); movePinned(\'' + p.name + '\', 1)">&rsaquo;</span>' +
      '</span>';
  } else {
    pinHtml = '<span class="pin-icon" onclick="event.stopPropagation(); pinProject(\'' + p.name + '\')" title="Pin">&#9734;</span>';
  }

  let actionsHtml = '';
  if (p.claude_live) {
    actionsHtml =
      '<button class="btn-primary" onclick="event.stopPropagation(); openSession(\'' + p.name + '\', false)">Claude</button>' +
      '<div class="actions-row">' +
        '<button class="btn-shell" onclick="event.stopPropagation(); openSession(\'' + p.name + '\', true)">Shell</button>' +
        '<button class="btn-kill" onclick="event.stopPropagation(); killProject(\'' + p.name + '\')">Kill</button>' +
      '</div>';
  } else if (p.can_continue) {
    actionsHtml =
      '<button class="btn-primary" onclick="event.stopPropagation(); continueSession(\'' + p.name + '\')">Continue</button>' +
      '<div class="actions-row">' +
        '<button class="btn-dim" onclick="event.stopPropagation(); confirmNewSession(\'' + p.name + '\')">New</button>' +
        '<button class="btn-dim" onclick="event.stopPropagation(); resumeSession(\'' + p.name + '\')">Resume (' + p.conv_count + ')</button>' +
        '<button class="btn-shell" onclick="event.stopPropagation(); openSession(\'' + p.name + '\', true)">Shell</button>' +
      '</div>';
  } else {
    actionsHtml =
      '<button class="btn-primary" onclick="event.stopPropagation(); openSession(\'' + p.name + '\', false)">Claude</button>' +
      '<div class="actions-row">' +
        '<button class="btn-shell" onclick="event.stopPropagation(); openSession(\'' + p.name + '\', true)">Shell</button>' +
      '</div>';
  }
  card.innerHTML =
    '<div class="project-name-row">' +
      '<div class="project-name">' + p.name + '</div>' +
      pinHtml +
    '</div>' +
    '<div class="project-badges">' + badges + '</div>' +
    '<div class="project-actions">' + actionsHtml + '</div>' +
    (p.desc ? '<div class="project-desc">' + p.desc + '</div>' : '<div class="project-desc">&nbsp;</div>');
  card.onclick = () => p.can_continue ? continueSession(p.name) : openSession(p.name, false);
  return card;
}

async function loadProjects() {
  const resp = await fetch('/api/projects');
  const projects = await resp.json();
  const grid = document.getElementById('project-grid');
  grid.innerHTML = '';
  const pinned = getPinnedProjects();
  const pinnedSet = new Set(pinned);

  // Pinned projects first, in saved order
  for (let i = 0; i < pinned.length; i++) {
    const p = projects.find(pr => pr.name === pinned[i]);
    if (p) grid.appendChild(buildCard(p, true, i, pinned.length));
  }

  // Unpinned projects, sorted
  const unpinned = projects.filter(p => !pinnedSet.has(p.name));
  unpinned.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    if (a.git !== b.git) return a.git ? -1 : 1;
    if (a.can_continue !== b.can_continue) return a.can_continue ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const p of unpinned) {
    grid.appendChild(buildCard(p, false, -1, 0));
  }
}

function showPicker() {
  document.getElementById('picker').style.display = 'flex';
  // Only hide terminal view if no tabs are open
  if (Object.keys(sessions).length === 0) {
    document.getElementById('terminal-view').style.display = 'none';
  }
  loadProjects();
}

// ══════════════════════════════════════════
//  Kill / Fullscreen / New Project
// ══════════════════════════════════════════
async function confirmNewSession(name) {
  showConfirm('Start a fresh Claude session?', () => openSession(name, false));
}

function showConfirm(msg, onYes) {
  document.getElementById('confirm-msg').textContent = msg;
  const yes = document.getElementById('confirm-yes');
  yes.onclick = () => { closeConfirm(); onYes(); };
  document.getElementById('confirm-modal').classList.add('active');
}
function closeConfirm() {
  document.getElementById('confirm-modal').classList.remove('active');
}

async function resumeSession(name) {
  const resp = await fetch('/api/sessions?name=' + encodeURIComponent(name));
  const data = await resp.json();
  const list = document.getElementById('resume-list');
  document.getElementById('resume-title').textContent = name + ' — Sessions';
  list.innerHTML = '';
  for (const s of data.sessions) {
    const item = document.createElement('div');
    item.className = 'resume-item';
    item.innerHTML =
      '<div class="resume-item-top">' +
        '<span class="resume-date">' + s.date + '</span>' +
        '<span class="resume-time">' + s.time + '</span>' +
        '<span class="resume-id">' + s.id.substring(0, 8) + '</span>' +
      '</div>' +
      '<div class="resume-preview">' + (s.preview || '(no preview)') + '</div>';
    item.onclick = () => { closeResumeModal(); pickSession(name, s.id); };
    list.appendChild(item);
  }
  document.getElementById('resume-modal').classList.add('active');
}

function closeResumeModal() {
  document.getElementById('resume-modal').classList.remove('active');
}

function pickSession(name, sessionId) {
  const id = name + ':claude';
  if (sessions[id]) closeTab(id);
  openSession(name, false, false, sessionId);
}

function continueSession(name) {
  const id = sessionId(name, false);
  // Close existing dead tab if any
  if (sessions[id]) closeTab(id);
  // Open with continue flag
  openSession(name, false, true, null);
}

async function killProject(name) {
  await fetch('/api/kill', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name: name})});
  // Close tabs for this project
  for (const id of Object.keys(sessions)) {
    if (id.startsWith(name + ':')) closeTab(id);
  }
  loadProjects();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

function newProject() {
  const name = prompt('Project name:');
  if (!name || !name.trim()) return;
  fetch('/api/new-project', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name: name.trim()})})
    .then(r => r.json()).then(result => {
      if (result.error) { alert(result.error); return; }
      loadProjects();
    });
}

// ══════════════════════════════════════════
//  Pixel Claude Sprite
// ══════════════════════════════════════════
function drawMiniClaude(el) {
  const img = new Image();
  img.onload = function() {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.style.width = Math.round(img.width * 0.2) + 'px';
    c.style.height = Math.round(img.height * 0.2) + 'px';
    c.style.imageRendering = 'pixelated';
    const ctx = c.getContext('2d');

    const tmp = document.createElement('canvas');
    tmp.width = img.width; tmp.height = img.height;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(img, 0, 0);
    const imgData = tctx.getImageData(0, 0, tmp.width, tmp.height);
    const d = imgData.data;

    ctx.fillStyle = '#00ff41';
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        if (d[i+3] > 128 && (d[i] + d[i+1] + d[i+2]) > 80) {
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    el.appendChild(c);
  };
  img.src = '/api/claude-logo';
}

// ══════════════════════════════════════════
//  Session management
// ══════════════════════════════════════════
function sessionId(name, isShell) {
  return name + (isShell ? ':shell' : ':claude');
}

function openSession(name, isShell, continueFlag, resumeId) {
  const id = sessionId(name, isShell);

  // If already open, just switch to it
  if (sessions[id]) {
    switchTab(id);
    document.getElementById('picker').style.display = 'none';
    return;
  }

  // Show terminal view, hide picker
  document.getElementById('picker').style.display = 'none';
  document.getElementById('terminal-view').style.display = 'flex';

  // Create container
  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;display:none;position:relative;';

  // Loading overlay with running pixel Claude logo
  const loader = document.createElement('div');
  loader.className = 'loading-overlay';
  loader.innerHTML =
    '<div class="loading-indicator">' +
      '<span class="loading-label">' + (isShell ? 'SHELL' : 'LOADING') + '</span>' +
      '<div class="mini-logos">' +
        '<div class="mini-logo"></div>' +
        '<div class="mini-logo"></div>' +
        '<div class="mini-logo"></div>' +
        '<div class="mini-logo"></div>' +
      '</div>' +
    '</div>';
  container.appendChild(loader);
  loader.querySelectorAll('.mini-logo').forEach(el => drawMiniClaude(el));

  // Create terminal
  const term = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    fontSize: 17,
    fontFamily: '"Fira Code", monospace',
    fontWeight: '300',
    fontWeightBold: '500',
    drawBoldTextInBrightColors: true,
    overviewRuler: { width: 10 },
    theme: {
      background: '#000',
      foreground: '#ececec',
      black: '#000000',
      red: '#ff0000',
      green: '#00ff00',
      yellow: '#ffff00',
      blue: '#5c5cff',
      magenta: '#ff00ff',
      cyan: '#00ffff',
      white: '#ffffff',
      brightBlack: '#808080',
      brightRed: '#ff0000',
      brightGreen: '#00ff00',
      brightYellow: '#ffff00',
      brightBlue: '#5c5cff',
      brightMagenta: '#ff00ff',
      brightCyan: '#00ffff',
      brightWhite: '#ffffff',
      scrollbarSliderBackground: 'rgba(0,204,51,0.4)',
      scrollbarSliderHoverBackground: 'rgba(0,255,65,0.55)',
      scrollbarSliderActiveBackground: 'rgba(0,255,65,0.7)',
    },
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  try { term.loadAddon(new WebglAddon.WebglAddon()); } catch(e) {}

  // Scroll-to-bottom button
  const scrollBtn = document.createElement('div');
  scrollBtn.className = 'scroll-to-bottom';
  scrollBtn.innerHTML = '&#x25BC;';
  container.appendChild(scrollBtn);
  scrollBtn.addEventListener('click', () => term.scrollToBottom());
  term.onScroll(() => {
    const atBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
    scrollBtn.classList.toggle('visible', !atBottom);
  });

  // Connect WebSocket
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = 'project=' + encodeURIComponent(name) + (isShell ? '' : resumeId ? '&resume=' + resumeId : continueFlag ? '&continue=1' : '&claude=1');
  const ws = new WebSocket(proto + '//' + location.host + '/ws?' + params);

  let loaderDismissed = false;
  function dismissLoader() {
    if (!loaderDismissed && loader.parentNode) {
      loaderDismissed = true;
      loader.style.transition = 'opacity 0.3s';
      loader.style.opacity = '0';
      setTimeout(() => loader.remove(), 300);
    }
  }

  const session = { name, term, ws, fitAddon, container, isShell, muted: false };
  sessions[id] = session;

  ws.onopen = () => {
    fitAddon.fit();
    const dims = fitAddon.proposeDimensions() || { cols: 120, rows: 30 };
    ws.send(JSON.stringify({ type: 'resize', cols: dims.cols - 1, rows: dims.rows }));
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
    }, 50);
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output') {
        term.write(msg.data);
        dismissLoader();
      }
    } catch(err) {}
  };

  ws.onclose = () => {};

  term.onData(data => {
    if (ws.readyState === WebSocket.OPEN) {
      if (data === '\r' && pendingAttachments[id] && pendingAttachments[id].length > 0) {
        const atts = pendingAttachments[id];
        const paths = atts.map(a => a.path).join(' ');
        ws.send(JSON.stringify({ type: 'input', data: ' ' + paths }));
        ws.send(JSON.stringify({ type: 'input', data: '\r' }));
        clearAllAttachments(id);
        return;
      }
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  // Clipboard handler
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const key = e.key.toLowerCase();
    if (key === 'f11') {
      e.preventDefault();
      toggleFullscreen();
      return false;
    }
    if (e.ctrlKey && key === 'tab') return false;
    if (e.shiftKey && key === 'enter') {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'input', data: '\n' }));
      return false;
    }
    if (e.ctrlKey && e.shiftKey && key === 's') {
      e.preventDefault();
      doScreenshot('snip');
      return false;
    }
    if (e.ctrlKey && key === 'c') {
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
        term.clearSelection();
        return false;
      }
      return true;
    }
    if (e.ctrlKey && key === 'v') {
      e.preventDefault();
      navigator.clipboard.read().then(async (items) => {
        let handled = false;
        for (const item of items) {
          const imageType = item.types.find(t => t.startsWith('image/'));
          if (imageType) {
            handled = true;
            const blob = await item.getType(imageType);
            const ext = imageType.split('/')[1] || 'png';
            uploadScreenshot(new File([blob], 'paste_' + Date.now() + '.' + ext, { type: imageType }));
          }
        }
        if (!handled) {
          const text = await navigator.clipboard.readText();
          if (text) {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: 'input', data: text.trim().replace(/\r\n/g, '\n') }));
          }
        }
      }).catch(() => {
        navigator.clipboard.readText().then(text => {
          if (text && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'input', data: text.trim().replace(/\r\n/g, '\n') }));
        }).catch(() => {});
      });
      return false;
    }
    return true;
  });

  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    navigator.clipboard.readText().then(text => {
      if (text && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'input', data: text.trim().replace(/\r\n/g, '\n') }));
    }).catch(() => {});
  });

  renderTabs();
  switchTab(id);
  saveState();
}

function closeSession(id) {
  const session = sessions[id];
  if (!session) return;
  if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.close();
  if (session.term) session.term.dispose();
  if (session.container && session.container.parentNode) session.container.parentNode.removeChild(session.container);
  delete sessions[id];

  // Remove from pane slots
  paneSlots = paneSlots.map(s => s === id ? null : s);

  // Switch to another tab or show picker
  const remaining = Object.keys(sessions);
  if (remaining.length > 0) {
    switchTab(remaining[remaining.length - 1]);
  } else {
    activeSessionId = null;
    showPicker();
  }
  renderTabs();
  saveState();
}

// ══════════════════════════════════════════
//  Tabs
// ══════════════════════════════════════════
function renderTabs() {
  const strip = document.getElementById('tab-strip');
  strip.innerHTML = '';
  const muteIcon = '<svg viewBox="0 0 24 24"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
  const speakerIcon = '<svg viewBox="0 0 24 24"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
  for (const [id, s] of Object.entries(sessions)) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (id === activeSessionId ? ' active' : '');
    tab.innerHTML =
      '<span class="tab-mute' + (s.muted ? ' muted' : '') + '" onclick="event.stopPropagation(); toggleMute(\'' + id + '\')">' + (s.muted ? muteIcon : speakerIcon) + '</span>' +
      '<span class="tab-name">' + s.name + '</span>' +
      (s.isShell ? '<span class="tab-shell">SHELL</span>' : '') +
      '<span class="tab-close" onclick="event.stopPropagation(); closeSession(\'' + id + '\')">&times;</span>';
    tab.onclick = () => switchTab(id);
    strip.appendChild(tab);
  }
  const addBtn = document.createElement('div');
  addBtn.className = 'tab tab-add';
  addBtn.innerHTML = '+';
  addBtn.onclick = () => showPicker();
  strip.appendChild(addBtn);
}

function toggleMute(id) {
  if (!sessions[id]) return;
  const s = sessions[id];
  s.muted = !s.muted;
  fetch('http://127.0.0.1:7123/tts-state', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({project: s.name, state: s.muted ? 'muted' : 'default'})
  }).catch(() => {});
  renderTabs();
  saveState();
}

function switchTab(id) {
  if (!sessions[id]) return;
  activeSessionId = id;

  // Assign to selected pane (or first empty, or selected pane replacing existing)
  if (!paneSlots.includes(id)) {
    const emptyIdx = paneSlots.indexOf(null);
    if (emptyIdx >= 0) {
      paneSlots[emptyIdx] = id;
      selectedPane = emptyIdx;
    } else {
      // Replace the selected pane's content
      paneSlots[selectedPane] = id;
    }
  } else {
    // Already in a slot — just update selected pane to where it is
    selectedPane = paneSlots.indexOf(id);
  }

  renderTabs();
  renderPanes();
  saveState();
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

function renderPanes() {
  const area = document.getElementById('pane-area');
  area.className = 'layout-' + layout;
  area.innerHTML = '';

  const paneCount = { single: 1, hsplit: 2, vsplit: 2, triple: 3, quad: 4 }[layout] || 1;
  const isMultiPane = paneCount > 1;
  while (paneSlots.length < paneCount) paneSlots.push(null);
  if (selectedPane >= paneCount) selectedPane = 0;

  for (let i = 0; i < paneCount; i++) {
    const pane = document.createElement('div');
    // Only show border highlights in multi-pane mode
    if (isMultiPane) {
      pane.className = 'pane' + (i === selectedPane ? ' selected' : '');
    } else {
      pane.className = 'pane';
    }

    const sid = paneSlots[i];
    if (sid && sessions[sid]) {
      const s = sessions[sid];
      // Only show pane label in multi-pane mode
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

      s.container.style.display = 'block';
      s.container.style.width = '100%';
      s.container.style.height = '100%';
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

      // Fit after render
      setTimeout(() => {
        s.fitAddon.fit();
        s.term.refresh(0, s.term.rows - 1);
      }, 50);
    } else if (isMultiPane) {
      // Empty pane — clickable to select it
      const paneIdx = i;
      pane.onclick = () => {
        selectedPane = paneIdx;
        document.querySelectorAll('.pane').forEach((p, j) => {
          p.classList.remove('selected');
          if (j === selectedPane) p.classList.add('selected');
        });
      };
    }

    area.appendChild(pane);
  }

  // Refit all visible sessions
  setTimeout(() => {
    for (const sid of paneSlots) {
      if (sid && sessions[sid]) {
        sessions[sid].fitAddon.fit();
      }
    }
  }, 100);
}

// ══════════════════════════════════════════
//  Upload / drag & drop
// ══════════════════════════════════════════
async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const resp = await fetch('/upload', { method: 'POST', body: formData });
    const result = await resp.json();
    if (result.path && activeSessionId && sessions[activeSessionId]) {
      const s = sessions[activeSessionId];
      if (s.ws.readyState === WebSocket.OPEN)
        s.ws.send(JSON.stringify({ type: 'input', data: result.path }));
    }
  } catch(err) { console.error('Upload failed:', err); }
}

// ══════════════════════════════════════════
//  Screenshot & Attachments
// ══════════════════════════════════════════
const pendingAttachments = {};  // { sessionId: [{ path, blobUrl }, ...] }

function toggleScreenshotMenu(e) {
  e.stopPropagation();
  const dd = document.getElementById('screenshot-dropdown');
  dd.classList.toggle('open');
  const close = (ev) => { if (!dd.contains(ev.target)) { dd.classList.remove('open'); document.removeEventListener('click', close); } };
  if (dd.classList.contains('open')) setTimeout(() => document.addEventListener('click', close), 0);
}

async function doScreenshot(mode) {
  document.getElementById('screenshot-dropdown').classList.remove('open');
  try {
    const surface = mode === 'window' ? 'window' : 'monitor';
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: surface }, preferCurrentTab: false
    });
    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // Wait a frame for video to render
    await new Promise(r => requestAnimationFrame(r));
    const cvs = document.createElement('canvas');
    cvs.width = video.videoWidth;
    cvs.height = video.videoHeight;
    cvs.getContext('2d').drawImage(video, 0, 0);
    track.stop();

    if (mode === 'snip') {
      startSnipSelection(cvs);
    } else {
      cvs.toBlob(blob => { if (blob) uploadScreenshot(blob); }, 'image/png');
    }
  } catch (err) { console.log('Screenshot cancelled or failed:', err); }
}

function startSnipSelection(srcCanvas) {
  const overlay = document.getElementById('snip-overlay');
  const canvas = document.getElementById('snip-canvas');
  const sel = document.getElementById('snip-sel');
  canvas.width = srcCanvas.width;
  canvas.height = srcCanvas.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(srcCanvas, 0, 0);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  overlay.classList.add('active');
  sel.style.display = 'none';

  let startX, startY, dragging = false;

  function toCanvasCoords(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * canvas.width, y: (e.clientY - r.top) / r.height * canvas.height };
  }

  function onDown(e) { const p = toCanvasCoords(e); startX = p.x; startY = p.y; dragging = true; sel.style.display = 'block'; }
  function onMove(e) {
    if (!dragging) return;
    const p = toCanvasCoords(e);
    const r = canvas.getBoundingClientRect();
    const sx = Math.min(startX, p.x), sy = Math.min(startY, p.y);
    const sw = Math.abs(p.x - startX), sh = Math.abs(p.y - startY);
    sel.style.left = (sx / canvas.width * r.width + r.left) + 'px';
    sel.style.top = (sy / canvas.height * r.height + r.top) + 'px';
    sel.style.width = (sw / canvas.width * r.width) + 'px';
    sel.style.height = (sh / canvas.height * r.height) + 'px';
  }
  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const p = toCanvasCoords(e);
    const sx = Math.round(Math.min(startX, p.x)), sy = Math.round(Math.min(startY, p.y));
    const sw = Math.round(Math.abs(p.x - startX)), sh = Math.round(Math.abs(p.y - startY));
    cleanup();
    if (sw < 10 || sh < 10) return;
    const crop = document.createElement('canvas');
    crop.width = sw; crop.height = sh;
    crop.getContext('2d').drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    crop.toBlob(blob => { if (blob) uploadScreenshot(blob); }, 'image/png');
  }
  function onKey(e) { if (e.key === 'Escape') { cleanup(); } }

  function cleanup() {
    overlay.classList.remove('active');
    sel.style.display = 'none';
    overlay.removeEventListener('mousedown', onDown);
    overlay.removeEventListener('mousemove', onMove);
    overlay.removeEventListener('mouseup', onUp);
    document.removeEventListener('keydown', onKey);
  }

  overlay.addEventListener('mousedown', onDown);
  overlay.addEventListener('mousemove', onMove);
  overlay.addEventListener('mouseup', onUp);
  document.addEventListener('keydown', onKey);
}

async function uploadScreenshot(blob) {
  const formData = new FormData();
  formData.append('file', blob instanceof File ? blob : new File([blob], 'screenshot_' + Date.now() + '.png', { type: 'image/png' }));
  try {
    const resp = await fetch('/upload', { method: 'POST', body: formData });
    const result = await resp.json();
    if (result.path && activeSessionId) {
      const blobUrl = URL.createObjectURL(blob);
      if (!pendingAttachments[activeSessionId]) pendingAttachments[activeSessionId] = [];
      const idx = pendingAttachments[activeSessionId].length;
      pendingAttachments[activeSessionId].push({ path: result.path, blobUrl });
      addAttachPreview(activeSessionId, blobUrl, idx);
    }
  } catch(err) { console.error('Screenshot upload failed:', err); }
}

function getOrCreateAttachStrip(sessionId) {
  const session = sessions[sessionId];
  if (!session) return null;
  let strip = session.container.querySelector('.attach-strip');
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'attach-strip';
    strip.dataset.sessionId = sessionId;
    session.container.appendChild(strip);
  }
  return strip;
}

function addAttachPreview(sessionId, blobUrl, idx) {
  const strip = getOrCreateAttachStrip(sessionId);
  if (!strip) return;
  const wrap = document.createElement('div');
  wrap.className = 'attach-preview';
  wrap.dataset.idx = idx;
  const img = document.createElement('img');
  img.src = blobUrl;
  const x = document.createElement('div');
  x.className = 'attach-x';
  x.textContent = '×';
  x.onclick = () => removeAttachment(sessionId, idx);
  wrap.appendChild(img);
  wrap.appendChild(x);
  strip.appendChild(wrap);
}

function removeAttachment(sessionId, idx) {
  const atts = pendingAttachments[sessionId];
  if (!atts || !atts[idx]) return;
  URL.revokeObjectURL(atts[idx].blobUrl);
  atts.splice(idx, 1);
  rebuildAttachPreviews(sessionId);
}

function rebuildAttachPreviews(sessionId) {
  const strip = getOrCreateAttachStrip(sessionId);
  if (strip) strip.innerHTML = '';
  const atts = pendingAttachments[sessionId] || [];
  if (atts.length === 0) {
    if (strip) strip.remove();
    return;
  }
  atts.forEach((att, i) => addAttachPreview(sessionId, att.blobUrl, i));
}

function clearAllAttachments(sessionId) {
  const atts = pendingAttachments[sessionId] || [];
  atts.forEach(a => URL.revokeObjectURL(a.blobUrl));
  delete pendingAttachments[sessionId];
  const strip = getOrCreateAttachStrip(sessionId);
  if (strip) strip.remove();
}

let dragCounter = 0;
const dropOverlay = document.getElementById('drop-overlay');
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; dropOverlay.classList.add('active'); });
document.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('active'); } });
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => {
  e.preventDefault(); dragCounter = 0; dropOverlay.classList.remove('active');
  for (const file of e.dataTransfer.files) uploadFile(file);
});

// ══════════════════════════════════════════
//  Window events
// ══════════════════════════════════════════
window.addEventListener('focus', () => {
  for (const s of Object.values(sessions)) {
    if (s.container.style.display !== 'none') {
      s.fitAddon.fit();
      s.term.refresh(0, s.term.rows - 1);
    }
  }
});

// ══════════════════════════════════════════
//  Init — restore or show picker
// ══════════════════════════════════════════
(function init() {
  const saved = loadState();
  if (saved && saved.tabs && saved.tabs.length > 0) {
    layout = saved.layout || 'single';
    document.querySelectorAll('.layout-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.layout === layout);
    });
    for (const tab of saved.tabs) {
      openSession(tab.name, tab.isShell || false, !tab.isShell);
      // Restore mute state
      const sid = tab.name + (tab.isShell ? ':shell' : ':claude');
      if (sessions[sid] && tab.muted) {
        sessions[sid].muted = true;
        fetch('http://127.0.0.1:7123/tts-state', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({project: tab.name, state: 'muted'})
        }).catch(() => {});
      }
    }
    if (saved.active) {
      const id = Object.keys(sessions).find(k => sessions[k].name === saved.active);
      if (id) switchTab(id);
    }
  } else {
    showPicker();
  }
})();

// ══════════════════════════════════════════
//  TTS speaking indicator
// ══════════════════════════════════════════
setInterval(async () => {
  try {
    const resp = await fetch('http://127.0.0.1:7123/status');
    const data = await resp.json();
    const speaking = data.speaking_project;
    document.querySelectorAll('.tab').forEach(tab => {
      tab.classList.remove('speaking');
    });
    if (speaking) {
      for (const [id, s] of Object.entries(sessions)) {
        if (s.name === speaking) {
          const tabs = document.querySelectorAll('.tab');
          tabs.forEach(t => {
            if (t.querySelector('.tab-name') && t.querySelector('.tab-name').textContent === s.name) {
              t.classList.add('speaking');
            }
          });
        }
      }
    }
  } catch(e) {}
}, 500);

// ══════════════════════════════════════════
//  Settings & Matrix Rain
// ══════════════════════════════════════════
const matrixState = {
  chars: 'アカサタナハマヤラワ0123456789TAYTERM',
  canvas: document.getElementById('matrix-bg'),
  interval: null,
  settings: Object.assign(
    { opacity: 0.12, speed: 50, fade: 0.05, fontSize: 14, color: '#00ff41', rain: true, scanlines: false },
    JSON.parse(localStorage.getItem('tayterm_matrix') || '{}')
  ),
  drops: [],
  columns: 0,
};

function saveMatrixSettings() {
  localStorage.setItem('tayterm_matrix', JSON.stringify(matrixState.settings));
}

function initRain() {
  const { canvas, settings } = matrixState;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.opacity = settings.opacity;
  matrixState.columns = Math.floor(canvas.width / settings.fontSize);
  matrixState.drops = Array(matrixState.columns).fill(1);

  if (matrixState.interval) clearInterval(matrixState.interval);

  if (!settings.rain) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  matrixState.interval = setInterval(() => {
    const s = matrixState.settings;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,' + (1 - s.fade) + ')';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = s.fontSize + 'px monospace';
    ctx.fillStyle = s.color;
    for (let i = 0; i < matrixState.drops.length; i++) {
      const char = matrixState.chars[Math.floor(Math.random() * matrixState.chars.length)];
      ctx.fillText(char, i * s.fontSize, matrixState.drops[i] * s.fontSize);
      if (matrixState.drops[i] * s.fontSize > canvas.height && Math.random() > 0.975) matrixState.drops[i] = 0;
      matrixState.drops[i]++;
    }
  }, settings.speed);
}

function toggleSettings() {
  document.getElementById('settings-panel').classList.toggle('open');
}

function toggleScanlines() {
  const s = matrixState.settings;
  s.scanlines = !s.scanlines;
  document.getElementById('scanlines-overlay').style.display = s.scanlines ? 'block' : 'none';
  document.getElementById('toggle-scanlines').classList.toggle('on', s.scanlines);
  saveMatrixSettings();
}

function toggleRain() {
  const s = matrixState.settings;
  s.rain = !s.rain;
  document.getElementById('toggle-rain').classList.toggle('on', s.rain);
  saveMatrixSettings();
  initRain();
}

function updateSetting(key, value) {
  matrixState.settings[key] = value;
  saveMatrixSettings();

  if (key === 'opacity') {
    document.getElementById('val-opacity').textContent = value.toFixed(2);
    matrixState.canvas.style.opacity = value;
  } else if (key === 'speed') {
    document.getElementById('val-speed').textContent = value + 'ms';
    initRain();
  } else if (key === 'fade') {
    document.getElementById('val-fade').textContent = value.toFixed(2);
  } else if (key === 'fontSize') {
    document.getElementById('val-fontSize').textContent = value + 'px';
    initRain();
  } else if (key === 'color') {
    document.querySelectorAll('.color-preset').forEach(el => {
      el.classList.toggle('active', el.style.background === value || el.style.backgroundColor === value);
    });
  }
}

// Apply saved settings to UI
(function applySettings() {
  const s = matrixState.settings;
  document.getElementById('sl-opacity').value = Math.round(s.opacity * 100);
  document.getElementById('val-opacity').textContent = s.opacity.toFixed(2);
  document.getElementById('sl-speed').value = s.speed;
  document.getElementById('val-speed').textContent = s.speed + 'ms';
  document.getElementById('sl-fade').value = Math.round(s.fade * 100);
  document.getElementById('val-fade').textContent = s.fade.toFixed(2);
  document.getElementById('sl-fontSize').value = s.fontSize;
  document.getElementById('val-fontSize').textContent = s.fontSize + 'px';
  document.getElementById('toggle-scanlines').classList.toggle('on', s.scanlines);
  document.getElementById('toggle-rain').classList.toggle('on', s.rain);
  document.getElementById('scanlines-overlay').style.display = s.scanlines ? 'block' : 'none';
  document.querySelectorAll('.color-preset').forEach(el => {
    el.classList.toggle('active', el.style.background === s.color);
  });
  initRain();
})();

window.addEventListener('resize', () => {
  matrixState.canvas.width = window.innerWidth;
  matrixState.canvas.height = window.innerHeight;
  matrixState.columns = Math.floor(matrixState.canvas.width / matrixState.settings.fontSize);
  matrixState.drops = Array(matrixState.columns).fill(1);
  for (const s of Object.values(sessions)) {
    if (s.container.style.display !== 'none') s.fitAddon.fit();
  }
});
