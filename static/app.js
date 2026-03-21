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
  // Save pane assignments by name (IDs change across sessions)
  const panes = paneSlots.map(id => id && sessions[id] ? sessions[id].name : null);
  localStorage.setItem('tayterm_tabs', JSON.stringify({ tabs, active, layout, panes }));
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem('tayterm_tabs'));
  } catch(e) { return null; }
}

// ══════════════════════════════════════════
//  Project Picker
// ══════════════════════════════════════════
let _cachedFavorites = null;
function getPinnedProjects() {
  return _cachedFavorites || [];
}
async function fetchFavorites() {
  try {
    const resp = await fetch('/api/favorites');
    _cachedFavorites = await resp.json();
  } catch(e) { _cachedFavorites = []; }
  return _cachedFavorites;
}
function savePinnedProjects(list) {
  _cachedFavorites = list;
  fetch('/api/favorites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(list)
  }).catch(() => {});
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

// App color map from T-Server design system
const appColorMap = {
  'TAYTERM': '#0284c7', 'NaturalVoice': '#7c3aed', 'LEGAL': '#dc2626',
  'TayProcess': '#4f46e5', 'MESHVPN': '#059669', 'NinjaTrader': '#d97706',
  'TELEGRAMBOT': '#d97706', 'Command Center': '#0891b2', 'IMAGEW': '#ea580c',
};
// SVG icons from T-Server design system (line icons, inherit color via currentColor)
const appIconSvg = {
  'TAYTERM': '<polyline points="7 10 10 13 7 16"/><line x1="13" y1="16" x2="17" y2="16"/>',
  'NaturalVoice': '<line x1="4" y1="9" x2="4" y2="15"/><line x1="7" y1="6" x2="7" y2="18"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="13" y1="4" x2="13" y2="20"/><line x1="16" y1="7" x2="16" y2="17"/><line x1="19" y1="9" x2="19" y2="15"/>',
  'LEGAL': '<line x1="12" y1="3" x2="12" y2="19"/><line x1="5" y1="6" x2="19" y2="6"/><path d="M5 6 L3 12 Q3 14 5 14 Q7 14 7 12 Z" fill="currentColor" opacity="0.15"/><path d="M19 6 L17 12 Q17 14 19 14 Q21 14 21 12 Z" fill="currentColor" opacity="0.15"/><line x1="8" y1="19" x2="16" y2="19"/>',
  'TayProcess': '<circle cx="12" cy="12" r="3"/><path d="M12 2 L12 5"/><path d="M12 19 L12 22"/><path d="M2 12 L5 12"/><path d="M19 12 L22 12"/><path d="M4.93 4.93 L6.34 6.34"/><path d="M17.66 17.66 L19.07 19.07"/><path d="M4.93 19.07 L6.34 17.66"/><path d="M17.66 6.34 L19.07 4.93"/>',
  'MESHVPN': '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><circle cx="12" cy="12" r="2"/><line x1="7.8" y1="7.2" x2="10.5" y2="10.5"/><line x1="16.2" y1="7.2" x2="13.5" y2="10.5"/><line x1="7.8" y1="16.8" x2="10.5" y2="13.5"/><line x1="16.2" y1="16.8" x2="13.5" y2="13.5"/>',
  'NinjaTrader': '<line x1="6" y1="4" x2="6" y2="20"/><rect x="4" y="8" width="4" height="5" rx="0.5" fill="currentColor" opacity="0.3"/><line x1="12" y1="6" x2="12" y2="18"/><rect x="10" y="9" width="4" height="6" rx="0.5" fill="currentColor" opacity="0.3"/><line x1="18" y1="3" x2="18" y2="17"/><rect x="16" y="5" width="4" height="7" rx="0.5" fill="currentColor" opacity="0.3"/>',
  'Command Center': '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="4" rx="1.5"/><rect x="14" y="11" width="7" height="10" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
};
function getProjectIcon(name) {
  const svg = appIconSvg[name];
  if (!svg) return '';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + svg + '</svg>';
}
const projectColors = {};
const defaultColors = ['#0284c7','#d97706','#dc2626','#818cf8','#14b8a6','#7c3aed','#f97316','#22c55e'];
function getProjectColor(name) {
  if (appColorMap[name]) return appColorMap[name];
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
        (getProjectIcon(p.name) || terminalIcon) +
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
            (getProjectIcon(p.name) || terminalIcon) + convDot +
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
  await fetchFavorites();
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
  // Skip animations on return visits
  document.body.classList.add('no-intro');
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
      } else if (msg.type === 'chat') {
        // Calculate response time from when user last sent
        let responseTime = '';
        if (msg.role === 'assistant' && sessions[id] && sessions[id]._lastSendTime) {
          const elapsed = ((Date.now() - sessions[id]._lastSendTime) / 1000).toFixed(1);
          responseTime = elapsed + 's';
        }
        const tokens = msg.outputTokens || 0;
        addMessengerMessage(id, msg.role, msg.text, { responseTime, tokens });
        if (msg.role === 'assistant') {
          if (sessions[id]) {
            sessions[id].isThinking = false;
            sessions[id].toolHistory = [];
            sessions[id].activeAgents = 0;
            sessions[id]._outputTokens = 0;
          }
          showMessengerTyping(id, false);
          // Set speaking glow on tab (TTS will speak it)
          if (sessions[id] && !sessions[id].muted) {
            sessions[id].speaking = true;
            renderTabs();
            const words = (msg.text || '').split(/\s+/).length;
            const duration = Math.max(3000, Math.min(words * 100, 30000));
            clearTimeout(sessions[id]._speakTimer);
            sessions[id]._speakTimer = setTimeout(() => {
              if (sessions[id]) { sessions[id].speaking = false; renderTabs(); }
            }, duration);
          }
        }
      } else if (msg.type === 'thinking') {
        if (sessions[id]) {
          sessions[id].isThinking = true;
          if (!sessions[id].toolHistory) sessions[id].toolHistory = [];
          sessions[id]._outputTokens = (sessions[id]._outputTokens || 0) + (msg.outputTokens || 0);
        }
        showMessengerTyping(id, true, sessions[id]?.toolHistory, sessions[id]?.activeAgents);
        updateInfoPanel(id, msg);
      } else if (msg.type === 'tool') {
        if (sessions[id]) {
          sessions[id].isThinking = true;
          if (!sessions[id].toolHistory) sessions[id].toolHistory = [];
          sessions[id]._outputTokens = (sessions[id]._outputTokens || 0) + (msg.outputTokens || 0);
          for (const t of (msg.tools || [])) {
            sessions[id].toolHistory.push(t);
            if (t === 'Agent') sessions[id].activeAgents = (sessions[id].activeAgents || 0) + 1;
          }
        }
        showMessengerTyping(id, true, sessions[id]?.toolHistory, sessions[id]?.activeAgents);
        updateInfoPanel(id, msg);
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
      tab.oncontextmenu = (e) => { e.preventDefault(); showTabMenu(id, e); };
    }
    strip.appendChild(tab);
  }
  const addBtn = document.createElement('button');
  addBtn.className = 'tab-add';
  addBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  addBtn.onclick = () => showPicker();
  strip.appendChild(addBtn);
}

function showTabMenu(sessionId, event) {
  closeTabMenu();
  const s = sessions[sessionId];
  if (!s) return;

  const tab = event.currentTarget;
  const rect = tab.getBoundingClientRect();
  const dd = document.createElement('div');
  dd.className = 'tab-menu';
  dd.style.left = rect.left + 'px';
  dd.style.top = rect.bottom + 'px';
  dd.style.minWidth = rect.width + 'px';

  // Header
  const header = document.createElement('div');
  header.className = 'tab-menu-header';
  header.textContent = s.name;
  dd.appendChild(header);

  // Mute toggle
  const muteBtn = document.createElement('button');
  muteBtn.className = 'tab-menu-item';
  muteBtn.innerHTML = (s.muted ? '&#9834; Unmute' : '&#9834; Mute');
  muteBtn.onclick = () => { toggleMute(sessionId); closeTabMenu(); };
  dd.appendChild(muteBtn);

  // Voice section
  const sep1 = document.createElement('div');
  sep1.className = 'tab-menu-sep';
  dd.appendChild(sep1);

  const voiceHeader = document.createElement('div');
  voiceHeader.className = 'tab-menu-header';
  voiceHeader.textContent = 'Voice';
  dd.appendChild(voiceHeader);

  const voiceList = document.createElement('div');
  voiceList.className = 'tab-menu-voices';
  KOKORO_VOICES.forEach(v => {
    const btn = document.createElement('button');
    btn.className = 'tab-menu-item';
    btn.textContent = v;
    btn.onclick = () => {
      fetch(TTS_BASE + '/project-voice', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({project: s.name, voice: v})
      }).catch(() => {});
      closeTabMenu();
    };
    voiceList.appendChild(btn);
  });
  dd.appendChild(voiceList);

  // Close session
  const sep2 = document.createElement('div');
  sep2.className = 'tab-menu-sep';
  dd.appendChild(sep2);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-menu-item danger';
  closeBtn.textContent = 'Close Session';
  closeBtn.onclick = () => { closeSession(sessionId); closeTabMenu(); };
  dd.appendChild(closeBtn);

  document.body.appendChild(dd);
  setTimeout(() => document.addEventListener('click', closeTabMenu, { once: true }), 0);
}

function closeTabMenu() {
  const existing = document.querySelector('.tab-menu');
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

  const existingIdx = paneSlots.indexOf(id);
  if (existingIdx >= 0 && existingIdx !== selectedPane) {
    // Swap: clicked tab is in another pane — swap with selected pane
    const currentInSelected = paneSlots[selectedPane];
    paneSlots[selectedPane] = id;
    paneSlots[existingIdx] = currentInSelected;
  } else if (existingIdx === selectedPane) {
    // Already in selected pane — nothing to do
  } else {
    // Not in any pane — assign to selected pane (or first empty)
    const emptyIdx = paneSlots.indexOf(null);
    if (emptyIdx >= 0) {
      paneSlots[emptyIdx] = id;
      selectedPane = emptyIdx;
    } else {
      paneSlots[selectedPane] = id;
    }
  }

  renderTabs();
  renderPanes();
  saveState();
}

// ══════════════════════════════════════════
//  View mode toggle (Terminal / Messenger)
// ══════════════════════════════════════════
let viewMode = 'messenger';
const messengerMessages = {}; // { sessionId: [{ role, text, time }] }

function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('.view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === mode);
  });
  const paneArea = document.getElementById('pane-area');
  const messengerPane = document.getElementById('messengerPane');
  if (mode === 'messenger') {
    paneArea.style.display = 'none';
    messengerPane.classList.add('active');
    renderMessenger();
  } else {
    paneArea.style.display = '';
    messengerPane.classList.remove('active');
    // Re-fit all visible terminals after DOM is visible
    setTimeout(() => {
      for (const sid of paneSlots) {
        if (sid && sessions[sid] && sessions[sid].fitAddon) {
          try { sessions[sid].fitAddon.fit(); } catch(e) {}
        }
      }
    }, 100);
  }
}

let selectedMessengerPane = 0;

function createMessengerPane(sid, paneIdx, totalPanes) {
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

  const chatArea = document.createElement('div');
  chatArea.className = 'chat-messages';
  pane.appendChild(chatArea);

  const inputArea = document.createElement('div');
  inputArea.className = 'chat-input-area';
  inputArea.innerHTML = `
    <div class="chat-input-row">
      <button class="mic-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 1a4 4 0 00-4 4v7a4 4 0 008 0V5a4 4 0 00-4-4z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/></svg></button>
      <textarea class="chat-textarea" placeholder="Send a message..." rows="1"></textarea>
      <button class="send-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
    </div>
    <div class="info-toggle" onclick="this.parentElement.querySelector('.info-panel').classList.toggle('open')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><polyline points="18 15 12 9 6 15"/></svg>
    </div>
    <div class="info-panel" data-sid="${sid || ''}">
      <div class="info-row">
        <span class="info-label">MODEL</span>
        <span class="info-value" data-field="model">—</span>
      </div>
      <div class="info-row">
        <span class="info-label">CONTEXT</span>
        <span class="info-value" data-field="context">—</span>
        <div class="info-bar"><div class="info-bar-fill" data-field="contextBar"></div></div>
      </div>
      <div class="info-row">
        <span class="info-label">OUTPUT</span>
        <span class="info-value" data-field="tokens">—</span>
      </div>
      <div class="info-row">
        <span class="info-label">BRANCH</span>
        <span class="info-value" data-field="branch">—</span>
      </div>
    </div>`;
  pane.appendChild(inputArea);

  const textarea = inputArea.querySelector('.chat-textarea');
  const sendBtn = inputArea.querySelector('.send-btn');
  const sendMsg = () => {
    const text = textarea.value.trim();
    if (!text || !sid || !sessions[sid]) return;
    const ws = sessions[sid].ws;
    if (ws.readyState === WebSocket.OPEN) {
      // Send text and carriage return separately — longer delay for longer text
      ws.send(JSON.stringify({ type: 'input', data: text }));
      const delay = Math.max(100, Math.min(text.length * 2, 500));
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: '\r' }));
        }
      }, delay);
    }
    if (sessions[sid]) sessions[sid]._lastSendTime = Date.now();
    addMessengerMessage(sid, 'user', text);
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

  // Load conversation history
  if (sid && sessions[sid] && !sessions[sid].isShell && !messengerMessages[sid]) {
    loadConversationHistory(sid, chatArea);
  } else if (sid && messengerMessages[sid]) {
    for (const m of messengerMessages[sid]) {
      if (m.type === 'image') {
        chatArea.appendChild(createImageBubble(m.role, m.blobUrl, m.time, m.sizeInfo));
      } else {
        chatArea.appendChild(createMsgBubble(m.role, m.text, m.time));
      }
    }
    setTimeout(() => { chatArea.scrollTop = chatArea.scrollHeight; }, 50);
  }

  return pane;
}

function renderMessenger() {
  const mp = document.getElementById('messengerPane');
  mp.innerHTML = '';
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
}

function isImagePath(text) {
  return /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(text.trim()) && /[\\/]/.test(text) && text.trim().split('\n').length <= 2;
}

async function loadConversationHistory(sessionId, chatArea) {
  const s = sessions[sessionId];
  if (!s) return;
  try {
    const resp = await fetch(`/api/conversation?name=${encodeURIComponent(s.name)}`);
    const messages = await resp.json();
    if (!messengerMessages[sessionId]) messengerMessages[sessionId] = [];
    for (const m of messages) {
      if (m.role === 'user' || m.role === 'assistant') {
        const text = m.text || '';
        // Skip image paths and [Image:...] references
        if (isImagePath(text) || /^\[Image:/.test(text)) continue;
        messengerMessages[sessionId].push({ role: m.role, text, time: m.time || '' });
        chatArea.appendChild(createMsgBubble(m.role, text, m.time || ''));
      }
    }
    chatArea.scrollTop = chatArea.scrollHeight;
  } catch (e) { /* ignore fetch errors */ }
}

function renderMarkdown(text) {
  // Escape HTML first
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Code blocks (```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Tables: detect lines with | separators
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (match) => {
    const rows = match.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return match;
    // Skip separator row (|---|---|)
    const dataRows = rows.filter(r => !/^\|[\s\-:]+\|$/.test(r));
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
  // Line breaks (but not inside pre/ul/table)
  html = html.replace(/\n/g, '<br>');
  // Clean up <br> inside <ul>, <pre>, <table>
  html = html.replace(/<ul><br>/g, '<ul>');
  html = html.replace(/<br><\/ul>/g, '</ul>');
  html = html.replace(/<\/li><br>/g, '</li>');
  html = html.replace(/<pre><br>/g, '<pre>');
  html = html.replace(/<br><\/pre>/g, '</pre>');
  html = html.replace(/<\/tr><br>/g, '</tr>');
  html = html.replace(/<table><br>/g, '<table>');
  html = html.replace(/<br><\/table>/g, '</table>');
  return html;
}

function createMsgBubble(role, text, time, extra) {
  const msg = document.createElement('div');
  msg.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  if (role === 'assistant') {
    bubble.innerHTML = renderMarkdown(text);
  } else {
    bubble.textContent = text;
  }
  msg.appendChild(bubble);
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  let parts = [];
  if (time) parts.push(time);
  if (role === 'assistant' && extra) {
    if (extra.responseTime) parts.push('<span class="meta-stat">' + extra.responseTime + '</span>');
    if (extra.tokens > 0) parts.push('<span class="meta-stat">' + extra.tokens + ' tok</span>');
  }
  if (parts.length > 0) {
    meta.innerHTML = parts.join(' <span class="meta-sep">·</span> ');
    msg.appendChild(meta);
  }
  return msg;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function createImageBubble(role, blobUrl, time, sizeInfo) {
  const msg = document.createElement('div');
  msg.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble msg-image';
  const img = document.createElement('img');
  img.src = blobUrl;
  img.onload = () => {
    // Scroll after image loads
    const chatArea = msg.closest('.chat-messages');
    if (chatArea) chatArea.scrollTop = chatArea.scrollHeight;
  };
  img.onclick = () => {
    const viewer = document.createElement('div');
    viewer.className = 'image-viewer';
    viewer.innerHTML = `<img src="${blobUrl}">`;
    viewer.onclick = () => viewer.remove();
    document.body.appendChild(viewer);
  };
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

function addMessengerImage(sessionId, role, blobUrl, filePath, imageSize) {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sizeInfo = imageSize ? { imageSize, imageNum: sessionImageCount, totalBytes: sessionImageBytes } : null;
  if (!messengerMessages[sessionId]) messengerMessages[sessionId] = [];
  messengerMessages[sessionId].push({ role, type: 'image', blobUrl, filePath, time, sizeInfo });

  if (viewMode === 'messenger') {
    const panes = document.querySelectorAll('.messenger-split-pane');
    for (const pane of panes) {
      if (pane.dataset.sessionId === sessionId) {
        const chatArea = pane.querySelector('.chat-messages');
        chatArea.appendChild(createImageBubble(role, blobUrl, time, sizeInfo));
        chatArea.scrollTop = chatArea.scrollHeight;
      }
    }
  }
}

function addMessengerMessage(sessionId, role, text, extra) {
  if (!text || !text.trim()) return;
  const trimmed = text.trim();
  if (isImagePath(trimmed) || /^\[Image:/.test(trimmed)) return;
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

  if (viewMode === 'messenger') {
    const panes = document.querySelectorAll('.messenger-split-pane');
    for (const pane of panes) {
      if (pane.dataset.sessionId === sessionId) {
        const chatArea = pane.querySelector('.chat-messages');
        const bubble = createMsgBubble(role, text.trim(), time, meta);
        if (role === 'assistant') {
          // Assistant response goes BEFORE the typing indicator (replacing it)
          const typing = chatArea.querySelector('.typing');
          if (typing) {
            chatArea.insertBefore(bubble, typing);
          } else {
            chatArea.appendChild(bubble);
          }
        } else {
          // User message goes at the bottom (after typing indicator)
          chatArea.appendChild(bubble);
        }
        chatArea.scrollTop = chatArea.scrollHeight;
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

function showMessengerTyping(sessionId, show, tools, agents) {
  if (viewMode !== 'messenger') return;
  const panes = document.querySelectorAll('.messenger-split-pane');
  for (const pane of panes) {
    if (pane.dataset.sessionId === sessionId) {
      const chatArea = pane.querySelector('.chat-messages');
      let existing = chatArea.querySelector('.typing');
      if (show) {
        if (!existing) {
          existing = document.createElement('div');
          existing.className = 'msg typing';
          chatArea.appendChild(existing);
        }
        // Determine current phase from the session state
        const s = sessions[sessionId];
        const lastTool = tools && tools.length > 0 ? tools[tools.length - 1] : null;
        const phase = lastTool ? (toolVerbs[lastTool] || lastTool + '...') : 'Thinking...';

        let html = '<div class="typing-row">';
        // Phase status (replaces dots)
        html += '<div class="typing-status"><span class="status-text">' + phase + '</span></div>';
        // Tool history badges
        if (tools && tools.length > 0) {
          html += '<div class="typing-tools">';
          for (const t of tools) {
            const isAgent = t === 'Agent';
            html += '<span class="tool-badge' + (isAgent ? ' agent' : '') + '">' + t + '</span>';
          }
          html += '</div>';
        }
        if (agents && agents > 0) {
          html += '<span class="agent-count">' + agents + ' agent' + (agents > 1 ? 's' : '') + '</span>';
        }
        // Token count if available
        if (s && s._outputTokens > 0) {
          html += '<span class="token-count">' + s._outputTokens + ' tok</span>';
        }
        html += '</div>';
        existing.innerHTML = html;
        chatArea.scrollTop = chatArea.scrollHeight;
      } else if (!show && existing) {
        existing.remove();
      }
    }
  }
}

function updateInfoPanel(sessionId, msg) {
  if (!msg) return;
  const panels = document.querySelectorAll('.info-panel[data-sid="' + sessionId + '"]');
  for (const panel of panels) {
    const contextUsed = msg.contextUsed || 0;
    const contextMax = 1000000;
    const pct = Math.round((contextUsed / contextMax) * 100);
    const contextK = Math.round(contextUsed / 1000);
    const modelField = panel.querySelector('[data-field="model"]');
    if (modelField) modelField.textContent = 'Opus 4.6 (1M)';
    const contextField = panel.querySelector('[data-field="context"]');
    if (contextField) contextField.textContent = contextK + 'K / 1M (' + pct + '%)';
    const bar = panel.querySelector('[data-field="contextBar"]');
    if (bar) {
      bar.style.width = pct + '%';
      bar.style.background = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--amber)' : 'var(--accent2)';
    }
    const tokensField = panel.querySelector('[data-field="tokens"]');
    const s = sessions[sessionId];
    if (tokensField && s) tokensField.textContent = (s._outputTokens || 0) + ' tokens';
  }
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
    renderMessenger();
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

let sessionImageBytes = 0;
let sessionImageCount = 0;
const SESSION_IMAGE_LIMIT = 20 * 1024 * 1024; // 20MB

async function uploadScreenshot(blob) {
  const ts = Date.now();
  const projectName = activeSessionId && sessions[activeSessionId] ? sessions[activeSessionId].name : '';

  // Upload full quality original — get URL for display
  const rawForm = new FormData();
  if (projectName) rawForm.append('project', projectName);
  rawForm.append('file', new File([blob], 'screenshot_' + ts + '.png', { type: 'image/png' }));
  let fullUrl = null;
  try {
    const rawResp = await fetch('/upload', { method: 'POST', body: rawForm });
    const rawResult = await rawResp.json();
    fullUrl = rawResult.url || null;
  } catch(e) {}

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
      // Display full quality, send compressed to Claude
      const displayUrl = fullUrl || result.url || URL.createObjectURL(blob);
      sessionImageBytes += compressed.size;
      sessionImageCount++;
      // Show full quality image in messenger
      addMessengerImage(activeSessionId, 'user', displayUrl, result.path, compressed.size);
      // In messenger mode, send the image path to PTY immediately
      if (viewMode === 'messenger') {
        const s = sessions[activeSessionId];
        if (s && s.ws.readyState === WebSocket.OPEN) {
          s.ws.send(JSON.stringify({ type: 'input', data: result.path + '\r' }));
        }
      } else {
        // Terminal mode — add to pending attachments (sent on Enter)
        if (!pendingAttachments[activeSessionId]) pendingAttachments[activeSessionId] = [];
        const idx = pendingAttachments[activeSessionId].length;
        pendingAttachments[activeSessionId].push({ path: result.path, blobUrl: imgUrl });
        addAttachPreview(activeSessionId, imgUrl, idx);
      }
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
    // Restore pane assignments
    if (saved.panes && saved.panes.length > 0) {
      for (let i = 0; i < saved.panes.length; i++) {
        if (saved.panes[i]) {
          const sid = Object.keys(sessions).find(k => sessions[k].name === saved.panes[i]);
          if (sid) paneSlots[i] = sid;
        }
      }
      renderPanes();
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
