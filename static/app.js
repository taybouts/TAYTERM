// ══════════════════════════════════════════
//  State
// ══════════════════════════════════════════
const sessions = {};  // { id: { name, term, ws, fitAddon, container, isShell } }
let activeSessionId = null;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && !/Windows/.test(navigator.userAgent);
const isMobile = (isIOS || isIPadOS) && screen.width <= 1400;
const TTS_BASE = window.location.protocol + '//' + window.location.hostname + ':7123';
const KOKORO_VOICES = [
  'am_onyx','am_adam','am_michael','am_fenrir','am_puck','am_liam',
  'af_bella','af_sarah','af_nicole','af_sky','af_heart',
  'bm_george','bm_daniel','bm_lewis','bm_fable',
  'bf_emma','bf_isabella','ff_siwis'
];
let layout = 'single';
let paneSlots = [];  // session IDs assigned to panes
let selectedPane = 0;  // which pane is selected for tab assignment
let currentPage = 0;

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

const terminalIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';

// App color map for project icons
const projectColors = {};
const defaultColors = ['#0284c7','#d4a847','#f43f5e','#818cf8','#14b8a6','#a78bfa','#f97316','#22c55e'];
function getProjectColor(name) {
  if (!projectColors[name]) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    projectColors[name] = defaultColors[Math.abs(hash) % defaultColors.length];
  }
  return projectColors[name];
}
function adjustColor(hex, amount) {
  let r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  r = Math.min(255, r + amount); g = Math.min(255, g + amount); b = Math.min(255, b + amount);
  return '#' + [r,g,b].map(c => c.toString(16).padStart(2,'0')).join('');
}

function renderFavorites(projects, pinned) {
  const favHero = document.getElementById('favHero');
  if (!favHero) return;
  const favProjects = pinned.map(name => projects.find(p => p.name === name)).filter(Boolean);
  if (!favProjects.length) {
    favHero.innerHTML = '<div class="fav-hero-empty">Right-click any project below to add favorites</div>';
    return;
  }
  favHero.innerHTML = favProjects.map(p => {
    const color = getProjectColor(p.name);
    const statusClass = p.live ? 'online' : 'offline';
    const esc = p.name.replace(/'/g, "\\'");
    return '<div class="fav-item" style="--glow:' + color + '30" onclick="favClick(\'' + esc + '\')" oncontextmenu="event.preventDefault();unpinProject(\'' + esc + '\')">' +
      '<div class="fav-icon" style="background:linear-gradient(135deg, ' + color + ', ' + adjustColor(color, 40) + ')">' +
        terminalIcon +
        '<div class="fav-status ' + statusClass + '"></div>' +
      '</div>' +
      '<div class="fav-label">' + p.name + '</div>' +
      '<div class="fav-actions">' +
        '<button class="fav-act" onclick="event.stopPropagation(); confirmNewSession(\'' + esc + '\')">New</button>' +
        '<button class="fav-act shell" onclick="event.stopPropagation(); openSession(\'' + esc + '\', true)">Shell</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function favClick(name) {
  const p = allProjects.find(pr => pr.name === name);
  if (!p) return;
  if (isMobile) { mobileOpenSession(name, p.can_continue); return; }
  p.can_continue ? continueSession(name) : openSession(name, false);
}

function renderHeroStatus(projects, pinned) {
  const el = document.getElementById('heroStatus');
  if (!el) return;
  const live = projects.filter(p => p.live).length;
  const total = projects.length;
  const favCount = pinned.length;
  el.innerHTML =
    '<div class="hs-item"><span class="hs-dot g"></span>' + live + ' Live</div>' +
    '<div class="hs-item"><span class="hs-dot b"></span>' + total + ' Projects</div>' +
    '<div class="hs-item"><span class="hs-dot a"></span>' + favCount + ' Favorites</div>';
}

let activeFilter = 'All';
let searchQuery = '';

function setFilter(f) {
  activeFilter = f;
  document.querySelectorAll('.filter-pill').forEach(p => p.classList.toggle('active', p.dataset.filter === f));
  renderDashboard(allProjects, getPinnedProjects());
}

function getCategory(p) {
  if (p.live) return 'Active';
  if (p.git) return 'Development';
  return 'Other';
}

function renderDashboard(projects, pinned) {
  const grid = document.getElementById('project-grid');
  if (!grid) return;
  const pinnedSet = new Set(pinned);

  let filtered = projects.map((p, i) => ({...p, _idx: i}));

  // Search filter
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(p => p.name.toLowerCase().includes(q) || (p.desc || '').toLowerCase().includes(q));
  }

  // Category filter
  if (activeFilter !== 'All') {
    filtered = filtered.filter(p => getCategory(p) === activeFilter);
  }

  if (!filtered.length) {
    grid.innerHTML = '<div style="text-align:center;padding:60px 20px;font-family:var(--font-mono);font-size:13px;color:var(--text2);letter-spacing:2px;">No projects found</div>';
    return;
  }

  // Group by category
  const groups = {};
  const catOrder = ['Active', 'Development', 'Other'];
  filtered.forEach(p => {
    const cat = getCategory(p);
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(p);
  });

  let html = '';
  let cardIdx = 0;
  catOrder.forEach(cat => {
    if (!groups[cat]) return;
    html += '<div class="cat-label">' + cat + '</div>';
    html += '<div class="project-grid">';
    groups[cat].forEach(p => {
      const color = getProjectColor(p.name);
      const esc = p.name.replace(/'/g, "\\'");
      const isFav = pinnedSet.has(p.name);
      let badges = '';
      if (p.live) badges += '<span class="badge-live"><span class="badge-live-dot"></span>LIVE</span>';
      if (p.git) badges += '<span class="badge-pill">GIT</span>';
      if (p.claude) badges += '<span class="badge-pill">CLAUDE</span>';
      if (p.subscribers > 0) badges += '<span class="badge-subs">' + p.subscribers + ' connected</span>';
      const convDot = p.can_continue ? '<div class="conv-dot" title="Has conversation"></div>' : '';

      let actionsHtml = '';
      if (p.claude_live) {
        actionsHtml =
          '<button class="act-btn primary" onclick="event.stopPropagation(); openSession(\'' + esc + '\', false)">Claude</button>' +
          '<button class="act-btn shell" onclick="event.stopPropagation(); openSession(\'' + esc + '\', true)">Shell</button>' +
          '<button class="act-btn kill" onclick="event.stopPropagation(); killProject(\'' + esc + '\')">Kill</button>';
      } else if (p.can_continue) {
        actionsHtml =
          '<button class="act-btn" onclick="event.stopPropagation(); confirmNewSession(\'' + esc + '\')">New</button>' +
          '<button class="act-btn shell" onclick="event.stopPropagation(); openSession(\'' + esc + '\', true)">Shell</button>';
      } else {
        actionsHtml =
          '<button class="act-btn" onclick="event.stopPropagation(); confirmNewSession(\'' + esc + '\')">New</button>' +
          '<button class="act-btn shell" onclick="event.stopPropagation(); openSession(\'' + esc + '\', true)">Shell</button>';
      }

      html += '<div class="project-card ' + (p.live ? 'live' : '') + '" style="animation-delay:' + (cardIdx * 0.05) + 's"' +
        ' onclick="cardClick(\'' + esc + '\')"' +
        ' oncontextmenu="event.preventDefault();toggleFav(\'' + esc + '\')">' +
        (isFav ? '<div class="card-star">\u2605</div>' : '') +
        '<div class="project-card-header">' +
          '<div class="project-icon" style="background:linear-gradient(135deg, ' + color + ', ' + adjustColor(color, 40) + ')">' +
            terminalIcon + convDot +
          '</div>' +
          '<div>' +
            '<div class="project-name">' + p.name + '</div>' +
            '<div class="project-badges">' + badges + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="project-desc">' + (p.desc || '&nbsp;') + '</div>' +
        '<div class="project-actions">' + actionsHtml + '</div>' +
      '</div>';
      cardIdx++;
    });
    html += '</div>';
  });

  grid.innerHTML = html;
}

function cardClick(name) {
  const p = allProjects.find(pr => pr.name === name);
  if (!p) return;
  if (isMobile) { mobileOpenSession(name, p.can_continue); return; }
  p.can_continue ? continueSession(name) : openSession(name, false);
}

function toggleFav(name) {
  const pinned = getPinnedProjects();
  if (pinned.includes(name)) {
    unpinProject(name);
  } else {
    pinProject(name);
  }
}

let allProjects = [];

async function loadProjects() {
  const resp = await fetch('/api/projects');
  allProjects = await resp.json();
  const pinned = getPinnedProjects();

  // Render hero favorites
  renderFavorites(allProjects, pinned);

  // Render hero status line
  renderHeroStatus(allProjects, pinned);

  // Render dashboard grid
  renderDashboard(allProjects, pinned);
}

function hidePicker() {
  document.getElementById('picker').style.display = 'none';
  var nav = document.getElementById('pageNav');
  if (nav) nav.style.display = 'none';
  var clock = document.querySelector('.clock-wrap');
  if (clock) clock.style.opacity = '0';
}

function showPicker() {
  document.getElementById('picker').style.display = '';
  var nav = document.getElementById('pageNav');
  if (nav) nav.style.display = '';
  var clock = document.querySelector('.clock-wrap');
  if (clock) clock.style.opacity = currentPage === 0 ? '1' : '0';
  // Only hide terminal view if no tabs are open
  if (Object.keys(sessions).length === 0) {
    document.getElementById('terminal-view').classList.remove('active');
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
  if (sessions[id]) closeSession(id);
  openSession(name, false, false, sessionId);
}

function continueSession(name) {
  const id = sessionId(name, false);
  // Close existing dead tab if any
  if (sessions[id]) closeSession(id);
  // Open with continue flag
  openSession(name, false, true, null);
}

async function killProject(name) {
  await fetch('/api/kill', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name: name})});
  // Close tabs for this project
  for (const id of Object.keys(sessions)) {
    if (id.startsWith(name + ':')) closeSession(id);
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

    ctx.fillStyle = '#38bdf8';
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
    hidePicker();
    return;
  }

  // Show terminal view, hide picker
  hidePicker();
  document.getElementById('terminal-view').classList.add('active');

  // Create container
  const container = document.createElement('div');
  container.style.cssText = 'flex:1;display:none;position:relative;min-width:0;min-height:0;margin:4px;';

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
      background: '#000000',
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
      scrollbarSliderBackground: 'rgba(56,189,248,0.15)',
      scrollbarSliderHoverBackground: 'rgba(56,189,248,0.25)',
      scrollbarSliderActiveBackground: 'rgba(56,189,248,0.35)',
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
    if (!isMobile) {
      const dims = fitAddon.proposeDimensions() || { cols: 120, rows: 30 };
      ws.send(JSON.stringify({ type: 'resize', cols: dims.cols - 1, rows: dims.rows }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
      }, 50);
    }
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
    if (!isMobile && ws.readyState === WebSocket.OPEN) {
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

  // Touch scroll for iOS/iPad with momentum
  let touchLastY = null, touchVelocity = 0, touchLastTime = 0, momentumId = null;
  container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      touchLastY = e.touches[0].clientY;
      touchLastTime = Date.now();
      touchVelocity = 0;
      if (momentumId) { cancelAnimationFrame(momentumId); momentumId = null; }
    }
  }, { passive: true });
  container.addEventListener('touchmove', (e) => {
    if (touchLastY === null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const now = Date.now();
    const dt = now - touchLastTime || 1;
    const dy = touchLastY - y;
    touchVelocity = dy / dt;
    const lines = Math.round(dy / 16);
    if (lines !== 0) term.scrollLines(lines);
    touchLastY = y;
    touchLastTime = now;
  }, { passive: true });
  container.addEventListener('touchend', () => {
    touchLastY = null;
    // iOS UIScrollView.DecelerationRate.normal = 0.998/ms = 0.998^16 ≈ 0.968/frame
    let v = touchVelocity;
    let remainder = 0;
    function momentum() {
      if (Math.abs(v) < 0.005) return;
      remainder += v * 16;
      const lines = Math.trunc(remainder);
      if (lines !== 0) { term.scrollLines(lines); remainder -= lines; }
      v *= 0.968;
      momentumId = requestAnimationFrame(momentum);
    }
    momentumId = requestAnimationFrame(momentum);
  }, { passive: true });

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
  const muteIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
  const speakerIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
  const closeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  for (const [id, s] of Object.entries(sessions)) {
    const tabColor = s.isShell ? '#38bdf8' : getProjectColor(s.name);
    const tab = document.createElement('div');
    tab.className = 'tab-item' + (id === activeSessionId ? ' active' : '') + (s.speaking ? ' speaking' : '');
    tab.innerHTML =
      '<div class="tab-color" style="background:' + tabColor + '"></div>' +
      (s.isShell ? '<span class="tab-sh-badge">SH</span>' : '') +
      '<span class="tab-name">' + s.name + '</span>' +
      '<button class="tab-mute' + (s.muted ? ' muted' : '') + (s.speaking ? ' speaking' : '') + '" onclick="event.stopPropagation(); toggleMute(\'' + id + '\')">' + (s.muted ? muteIcon : speakerIcon) + '</button>' +
      '<button class="tab-close" onclick="event.stopPropagation(); closeSession(\'' + id + '\')">' + closeIcon + '</button>';
    tab.onclick = () => switchTab(id);
    if (!s.isShell) {
      tab.oncontextmenu = (e) => { e.preventDefault(); showVoicePicker(id, e); };
    }
    strip.appendChild(tab);
  }
  const addBtn = document.createElement('button');
  addBtn.className = 'tab-add';
  addBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  addBtn.onclick = () => showPicker();
  strip.appendChild(addBtn);
}

function showVoicePicker(sessionId, event) {
  closeVoicePicker();
  const s = sessions[sessionId];
  if (!s) return;
  const dd = document.createElement('div');
  dd.id = 'voice-picker';
  dd.style.left = event.clientX + 'px';
  dd.style.top = event.clientY + 'px';
  KOKORO_VOICES.forEach(v => {
    const btn = document.createElement('button');
    btn.textContent = v;
    btn.onclick = () => {
      fetch(TTS_BASE + '/project-voice', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({project: s.name, voice: v})
      }).catch(() => {});
      closeVoicePicker();
    };
    dd.appendChild(btn);
  });
  document.body.appendChild(dd);
  setTimeout(() => document.addEventListener('click', closeVoicePicker, { once: true }), 0);
}

function closeVoicePicker() {
  const existing = document.getElementById('voice-picker');
  if (existing) existing.remove();
}

function toggleMute(id) {
  if (!sessions[id]) return;
  const s = sessions[id];
  s.muted = !s.muted;
  fetch(TTS_BASE + '/tts-state', {
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
//  View mode toggle (Terminal / Messenger)
// ══════════════════════════════════════════
let viewMode = 'terminal';
function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('.view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === mode);
  });
  // TODO: Wire up messenger pane switching in PAGE 3
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
}

// ══════════════════════════════════════════
//  Upload / drag & drop
// ══════════════════════════════════════════
async function uploadFile(file) {
  const formData = new FormData();
  const projectName = activeSessionId && sessions[activeSessionId] ? sessions[activeSessionId].name : '';
  if (projectName) formData.append('project', projectName);
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
    stream.getTracks().forEach(t => t.stop());
    video.srcObject = null;

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
    // Redraw: dimmed base + bright selection
    ctx.drawImage(srcCanvas, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (sw > 0 && sh > 0) {
      ctx.drawImage(srcCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
    }
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

function compressImage(blob, maxWidth, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = img.width > maxWidth ? maxWidth / img.width : 1;
      const cvs = document.createElement('canvas');
      cvs.width = Math.round(img.width * scale);
      cvs.height = Math.round(img.height * scale);
      cvs.getContext('2d').drawImage(img, 0, 0, cvs.width, cvs.height);
      cvs.toBlob(resolve, 'image/jpeg', quality);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(blob);
  });
}

let sessionImageCount = 0;

function updateImageCounter() {
  let counter = document.getElementById('image-counter');
  if (!counter) {
    counter = document.createElement('span');
    counter.id = 'image-counter';
    const bar = document.getElementById('top-bar');
    if (bar) bar.appendChild(counter);
  }
  counter.textContent = sessionImageCount > 0 ? sessionImageCount + ' img' : '';
}

async function uploadScreenshot(blob) {
  const ts = Date.now();
  const projectName = activeSessionId && sessions[activeSessionId] ? sessions[activeSessionId].name : '';

  // Upload full quality original
  const rawForm = new FormData();
  if (projectName) rawForm.append('project', projectName);
  rawForm.append('file', new File([blob], 'screenshot_' + ts + '.png', { type: 'image/png' }));
  fetch('/upload', { method: 'POST', body: rawForm }).catch(() => {});

  // Upload compressed version for Claude into sm/ subfolder
  const compressed = await compressImage(blob, 1280, 0.8);
  const compForm = new FormData();
  if (projectName) compForm.append('project', projectName);
  compForm.append('subfolder', 'sm');
  compForm.append('file', new File([compressed], 'screenshot_' + ts + '.jpg', { type: 'image/jpeg' }));
  try {
    const resp = await fetch('/upload', { method: 'POST', body: compForm });
    const result = await resp.json();
    if (result.path && activeSessionId) {
      const blobUrl = URL.createObjectURL(compressed);
      if (!pendingAttachments[activeSessionId]) pendingAttachments[activeSessionId] = [];
      const idx = pendingAttachments[activeSessionId].length;
      pendingAttachments[activeSessionId].push({ path: result.path, blobUrl });
      addAttachPreview(activeSessionId, blobUrl, idx);
      sessionImageCount++;
      updateImageCounter();
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
// No focus handler — WebGL handles repaints, fit() on focus causes scroll thrashing

// ══════════════════════════════════════════
//  Init — restore or show picker
// ══════════════════════════════════════════
(function init() {
  if (isMobile) {
    document.body.classList.add('mobile');
    document.getElementById('terminal-view').classList.remove('active');
    showPicker();
    return;
  }
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
        fetch(TTS_BASE + '/tts-state', {
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
//  TTS speaking indicator (TODO: replace with push from TTS server)
// ══════════════════════════════════════════

// ══════════════════════════════════════════
//  Page Navigation
// ══════════════════════════════════════════
const PAGE_NAMES = ['Home', 'Dashboard'];

function goPage(idx) {
  idx = Math.max(0, Math.min(1, idx));
  currentPage = idx;
  var pagesEl = document.getElementById('pages');
  if (pagesEl) pagesEl.style.transform = 'translateX(-' + (idx * 100) + 'vw)';

  // Update dots
  document.querySelectorAll('.page-dot').forEach(function(d) {
    d.classList.toggle('active', parseInt(d.dataset.page) === idx);
  });
  var label = document.getElementById('pageLabel');
  if (label) label.textContent = PAGE_NAMES[idx];
  var prev = document.getElementById('navPrev');
  if (prev) prev.disabled = idx === 0;
  var next = document.getElementById('navNext');
  if (next) next.disabled = idx === 1;

  // Show/hide clock on hero page
  var clock = document.querySelector('.clock-wrap');
  if (clock) clock.style.opacity = idx === 0 ? '1' : '0';
}

// Keyboard navigation for pages
document.addEventListener('keydown', function(e) {
  // Don't navigate if terminal view is active or input is focused
  if (document.getElementById('terminal-view').classList.contains('active')) return;
  if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); goPage(currentPage + 1); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); goPage(currentPage - 1); }
});

// ══════════════════════════════════════════
//  Clock
// ══════════════════════════════════════════
function updateClock() {
  var now = new Date();
  var h = String(now.getHours()).padStart(2, '0');
  var m = String(now.getMinutes()).padStart(2, '0');
  var s = String(now.getSeconds()).padStart(2, '0');
  var timeEl = document.getElementById('clockTime');
  if (timeEl) timeEl.textContent = h + ':' + m + ':' + s;

  var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var dateEl = document.getElementById('clockDate');
  if (dateEl) dateEl.textContent = days[now.getDay()] + ' ' + now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getFullYear();
}
updateClock();
setInterval(updateClock, 1000);

// ══════════════════════════════════════════
//  Theme Switching
// ══════════════════════════════════════════
(function initThemes() {
  document.querySelectorAll('.theme-dot').forEach(function(dot) {
    dot.addEventListener('click', function() {
      document.querySelectorAll('.theme-dot').forEach(function(d) { d.classList.remove('active'); });
      dot.classList.add('active');
      document.body.className = dot.dataset.theme ? 'theme-' + dot.dataset.theme : '';
      localStorage.setItem('tayterm_theme', dot.dataset.theme || '');
    });
  });
  // Restore saved theme
  var saved = localStorage.getItem('tayterm_theme');
  if (saved) {
    document.body.className = 'theme-' + saved;
    document.querySelectorAll('.theme-dot').forEach(function(d) {
      d.classList.toggle('active', (d.dataset.theme || '') === saved);
    });
  }
})();

// ══════════════════════════════════════════
//  Search
// ══════════════════════════════════════════
(function initSearch() {
  var input = document.getElementById('searchInput');
  if (input) {
    input.addEventListener('input', function() {
      searchQuery = this.value;
      renderDashboard(allProjects, getPinnedProjects());
    });
  }
})();

// ══════════════════════════════════════════
//  Window resize
// ══════════════════════════════════════════
window.addEventListener('resize', () => {
  for (const s of Object.values(sessions)) {
    if (s.container.style.display !== 'none') s.fitAddon.fit();
  }
});

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
  const wsUrl = proto + '//' + location.host + '/ws?project=' + encodeURIComponent(name) + '&claude=1';

  function mobileConnect() {
    mobileWs = new WebSocket(wsUrl);
    mobileWs.onopen = () => {
      document.getElementById('mobile-project-name').textContent = mobileProject;
    };
    mobileWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'chat') {
          if (msg.role === 'assistant' && msg.text) {
            mobileAddMessage('assistant', msg.text);
          }
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
    const container = document.getElementById('mobile-messages');
    for (const msg of messages) {
      if (msg.role === 'user' && msg.text) {
        mobileAddMessage('user', msg.text);
      } else if (msg.role === 'assistant' && msg.text) {
        mobileAddMessage('assistant', msg.text);
      } else if (msg.type === 'tool_use' && msg.name) {
        mobileAddTool(msg.name, msg.summary || '');
      }
    }
    mobileLastMsgCount = messages.length;
    container.scrollTop = container.scrollHeight;
  } catch(err) {}
}

function mobileAddMessage(role, text) {
  const container = document.getElementById('mobile-messages');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (role === 'assistant') {
    div.innerHTML = mobileRenderMarkdown(text);
    // Make code blocks tappable
    div.querySelectorAll('pre').forEach(pre => {
      pre.onclick = () => pre.classList.toggle('expanded');
    });
  } else {
    div.textContent = text;
  }
  container.appendChild(div);
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
    if (/^(Reading|Writing|Editing|Searching|Running|Created|Updated)\s/i.test(s)) return false;
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
    container.appendChild(mobileStreamDiv);
  }
  mobileStreamDiv.innerHTML = mobileRenderMarkdown(
    (mobileStreamDiv.dataset.raw || '') + clean
  );
  mobileStreamDiv.dataset.raw = (mobileStreamDiv.dataset.raw || '') + clean;
  mobileStreamDiv.querySelectorAll('pre').forEach(pre => {
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
