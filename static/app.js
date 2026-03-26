// T-Term — Core: state, session management, tabs, uploads, and initialization

// ══════════════════════════════════════════
//  State
// ══════════════════════════════════════════
const sessions = {};  // { id: { name, term, ws, fitAddon, container, isShell } }
let activeSessionId = null;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && !/Windows/.test(navigator.userAgent);
const isIPad = isIPadOS || /iPad/.test(navigator.userAgent);
const isMobile = isIOS && !isIPad && screen.width <= 500;
// Connection detection — available to all device-specific scripts
const _host = window.location.hostname;
const connIsLocal = _host === '127.0.0.1' || _host === 'localhost' || _host === '::1' || _host.startsWith('192.168.');
const connIsTailscale = !connIsLocal && (_host.startsWith('100.64.') || _host.startsWith('100.100.') || _host.includes('tse.mesh'));
const connIsCloudflare = !connIsLocal && !connIsTailscale;
const connMode = connIsLocal ? 'local' : connIsTailscale ? 'tailscale' : 'cloudflare';

// TTS: always proxy through server to avoid mixed-content and CORS issues
const TTS_BASE = window.location.origin + '/api/tts';
const KOKORO_VOICES = [
  'am_onyx','am_adam','am_michael','am_fenrir','am_puck','am_liam',
  'af_bella','af_sarah','af_nicole','af_sky','af_heart',
  'bm_george','bm_daniel','bm_lewis','bm_fable',
  'bf_emma','bf_isabella','ff_siwis'
];
let layout = 'single';
const sentScreenshotPaths = new Set(); // Track paths sent as screenshots — suppress text echo
let paneSlots = [];  // session IDs assigned to panes
let selectedPane = 0;  // which pane is selected for tab assignment
let currentPage = 0;
let viewMode = 'messenger';
const messengerMessages = {}; // { sessionId: [{ role, text, time }] }
let sessionImageBytes = 0;
let sessionImageCount = 0;
const SESSION_IMAGE_LIMIT = 20 * 1024 * 1024; // 20MB

// ══════════════════════════════════════════
//  Session persistence (localStorage)
// ══════════════════════════════════════════
let _saveTimer = null;
function saveState() {
  if (_saveTimer) return; // Already scheduled
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const orderedNames = tabOrder.map(id => sessions[id]?.name).filter(Boolean);
    const tabs = Object.values(sessions).map(s => ({ name: s.name, isShell: s.isShell, muted: s.muted || false }));
    const active = activeSessionId ? sessions[activeSessionId]?.name : null;
    const panes = paneSlots.map(id => id && sessions[id] ? sessions[id].name : null);
    localStorage.setItem('tterm_tabs', JSON.stringify({ tabs, active, layout, panes, tabOrder: orderedNames }));
  }, 500);
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem('tterm_tabs'));
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
  // If already open in a tab, just switch to it
  const id = name + ':claude';
  if (sessions[id]) { switchTab(id); hidePicker(); return; }
  if (p.can_continue) {
    showSessionChoice(name);
  } else {
    openSession(name, false);
  }
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
  const id = name + ':claude';
  if (sessions[id]) { switchTab(id); hidePicker(); return; }
  if (p.can_continue) {
    showSessionChoice(name);
  } else {
    openSession(name, false);
  }
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

let lastProjectsLoad = 0;
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
  // Load projects if not loaded yet
  if (allProjects.length === 0) loadProjects();
}

function showSessionChoice(name) {
  showConfirm('Continue previous session or start new?', () => {
    continueSession(name);
  }, 'Continue', () => {
    openSession(name, false);
  }, 'New');
}

// ══════════════════════════════════════════
//  Kill / New Project / Confirm dialogs
// ══════════════════════════════════════════
async function confirmNewSession(name) {
  showConfirm('Start a fresh Claude session?', () => openSession(name, false));
}

function startNewSessionInPlace(sessionId) {
  const s = sessions[sessionId];
  if (!s || s.isShell) return;
  showConfirm('Start a new session? (sends /clear)', () => {
    // Clear messenger history
    delete messengerMessages[sessionId];
    delete cachedPanes[sessionId];
    messengerMessages[sessionId] = [];
    renderMessenger();

    // Tell server to send /clear and reset JSONL watcher
    fetch('/api/new-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: s.name })
    }).catch(() => {});
  }, 'Clear & New', () => {
    // Keep messenger history, just start new session
    delete cachedPanes[sessionId];
    renderMessenger();

    fetch('/api/new-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: s.name })
    }).catch(() => {});
  }, 'Keep History');
}

function showConfirm(msg, onYes, yesLabel, onAlt, altLabel) {
  document.getElementById('confirm-msg').textContent = msg;
  const yes = document.getElementById('confirm-yes');
  yes.textContent = yesLabel || 'Yes';
  yes.onclick = () => { closeConfirm(); onYes(); };
  // Optional second action button
  let altBtn = document.getElementById('confirm-alt');
  if (onAlt && altLabel) {
    if (!altBtn) {
      altBtn = document.createElement('button');
      altBtn.id = 'confirm-alt';
      altBtn.className = yes.className;
      yes.parentNode.insertBefore(altBtn, yes.nextSibling);
    }
    altBtn.textContent = altLabel;
    altBtn.style.display = '';
    altBtn.onclick = () => { closeConfirm(); onAlt(); };
  } else if (altBtn) {
    altBtn.style.display = 'none';
  }
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

  // Check if a PTY is already alive — reattach instead of killing
  if (!continueFlag && !resumeId && !isShell) {
    fetch('/api/daemon').then(r => r.json()).then(data => {
      const alive = data.sessions && data.sessions.some(s => s.sessionKey === name + ':claude');
      delete cachedPanes[id];
      if (alive) {
        // Live PTY exists — reattach
        _doOpenSession(name, isShell, true, null, id);
      } else {
        // No live PTY — fresh start
        delete messengerMessages[id];
        messengerMessages[id] = [];
        _doOpenSession(name, isShell, false, null, id);
      }
    }).catch(() => {
      // Can't reach daemon check — just try to connect (don't kill anything)
      delete cachedPanes[id];
      _doOpenSession(name, isShell, true, null, id);
    });
    return;
  }

  _doOpenSession(name, isShell, continueFlag, resumeId, id);
}

function _doOpenSession(name, isShell, continueFlag, resumeId, id) {
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
  let params = 'project=' + encodeURIComponent(name) + (isShell ? '' : resumeId ? '&resume=' + resumeId : continueFlag ? '&continue=1' : '&claude=1');
  let ws = new WebSocket(proto + '//' + location.host + '/ws?' + params);

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

  function handleWsMessage(e) {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output') {
        term.write(msg.data);
        dismissLoader();
        // Detect Claude prompt — means Claude is idle
        if (sessions[id]?.isThinking && /\n>\s*$|\r>\s*$/.test(msg.data)) {
          sessions[id].isThinking = false;
          sessions[id].toolHistory = [];
          showMessengerTyping(id, false);
        }
      } else if (msg.type === 'chat') {
        // Calculate response time from when user last sent
        let responseTime = '';
        if (msg.role === 'assistant' && sessions[id] && sessions[id]._lastSendTime) {
          const elapsed = ((Date.now() - sessions[id]._lastSendTime) / 1000).toFixed(1);
          responseTime = elapsed + 's';
        }
        const tokens = msg.outputTokens || 0;
        const contextUsed = msg.contextUsed || 0;
        addMessengerMessage(id, msg.role, msg.text, { responseTime, tokens, contextUsed });
        if (msg.role === 'assistant') {
          updateInfoPanel(id, msg);
          if (sessions[id]) {
            sessions[id].isThinking = false;
            sessions[id].toolHistory = [];
            sessions[id]._outputTokens = 0;
            sessions[id]._currentResponseTokens = 0;
            // Don't reset activeAgents here — keep showing until next user message
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
          sessions[id]._currentResponseTokens = (sessions[id]._currentResponseTokens || 0) + (msg.outputTokens || 0);
        }
        showMessengerTyping(id, true, sessions[id]?.toolHistory, sessions[id]?.activeAgents);
        updateInfoPanel(id, msg);
      } else if (msg.type === 'tool') {
        if (sessions[id]) {
          sessions[id].isThinking = true;
          if (!sessions[id].toolHistory) sessions[id].toolHistory = [];
          sessions[id]._outputTokens = (sessions[id]._outputTokens || 0) + (msg.outputTokens || 0);
          sessions[id]._currentResponseTokens = (sessions[id]._currentResponseTokens || 0) + (msg.outputTokens || 0);
          for (const t of (msg.tools || [])) {
            sessions[id].toolHistory.push(t);
            if (t === 'Agent') sessions[id].activeAgents = (sessions[id].activeAgents || 0) + 1;
          }
        }
        showMessengerTyping(id, true, sessions[id]?.toolHistory, sessions[id]?.activeAgents);
        updateInfoPanel(id, msg);
      } else if (msg.type === 'prompt') {
        // Claude is waiting for user input
        if (sessions[id]) sessions[id].isThinking = false;
        showMessengerTyping(id, false);
        showPromptNotification(id);
      } else if (msg.type === 'user-input') {
        // Input from another device — show in messenger if it looks like a message (not just \r or control chars)
        const text = (msg.data || '').replace(/\r$/, '').trim();
        if (text && text.length > 0 && !/^[\x00-\x1f]+$/.test(text)) {
          addMessengerMessage(id, 'user', text);
          if (sessions[id]) {
            sessions[id].isThinking = true;
            sessions[id].toolHistory = [];
            sessions[id].activeAgents = 0;
            sessions[id]._currentResponseTokens = 0;
          }
          showMessengerTyping(id, true);
        }
      }
    } catch(err) {}
  }

  function handleWsClose() {
    // Auto-reconnect if session still exists (not intentionally closed)
    if (!sessions[id]) return;
    sessions[id]._reconnecting = true;
    renderTabs();
    // Reconnect as continue
    const rParams = 'project=' + encodeURIComponent(name) + (isShell ? '' : '&continue=1');
    const newWs = new WebSocket(proto + '//' + location.host + '/ws?' + rParams);
    newWs.onopen = () => {
      ws = newWs;
      sessions[id].ws = newWs;
      sessions[id]._reconnecting = false;
      renderTabs();
      const dims = fitAddon.proposeDimensions() || { cols: 120, rows: 30 };
      newWs.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
    };
    newWs.onmessage = handleWsMessage;
    newWs.onclose = handleWsClose;
    newWs.onerror = () => {};
  }

  ws.onmessage = handleWsMessage;
  ws.onclose = handleWsClose;

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
      // Skip if messenger textarea is focused — it has its own paste handler
      if (document.activeElement && document.activeElement.classList.contains('chat-textarea')) return true;
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
  delete cachedPanes[id];

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
let tabOrder = []; // Ordered session IDs for tab strip

function getOrderedSessionIds() {
  const allIds = Object.keys(sessions);
  // Keep existing order, append new tabs at end
  const ordered = tabOrder.filter(id => allIds.includes(id));
  for (const id of allIds) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  tabOrder = ordered;
  return ordered;
}

const _muteIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
const _speakerIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
const _closeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
let _renderTabsTimer = null;

function renderTabs() {
  // Debounce rapid calls (speaking state, messages, etc.)
  if (_renderTabsTimer) cancelAnimationFrame(_renderTabsTimer);
  _renderTabsTimer = requestAnimationFrame(_renderTabsNow);
}

function _renderTabsNow() {
  _renderTabsTimer = null;
  const strip = document.getElementById('tab-strip');
  const orderedIds = getOrderedSessionIds();
  const existingTabs = strip.querySelectorAll('.tab-item');
  const existingMap = {};
  existingTabs.forEach(t => { existingMap[t.dataset.tabId] = t; });

  // Update existing tabs in-place, create new ones as needed
  let dragSrcId = null;
  const seen = new Set();
  let insertBefore = strip.querySelector('.tab-add');

  for (const id of orderedIds) {
    const s = sessions[id];
    if (!s) continue;
    seen.add(id);
    const tabColor = s.isShell ? '#38bdf8' : getProjectColor(s.name);
    const wantClass = 'tab-item' + (id === activeSessionId ? ' active' : '') + (s.speaking ? ' speaking' : '');

    let tab = existingMap[id];
    if (tab) {
      // Update in place
      if (tab.className !== wantClass) tab.className = wantClass;
      const muteBtn = tab.querySelector('.tab-mute');
      if (muteBtn) {
        const wantMuteClass = 'tab-mute' + (s.muted ? ' muted' : '') + (s.speaking ? ' speaking' : '');
        if (muteBtn.className !== wantMuteClass) muteBtn.className = wantMuteClass;
        const wantIcon = s.muted ? _muteIcon : _speakerIcon;
        if (muteBtn.innerHTML !== wantIcon) muteBtn.innerHTML = wantIcon;
      }
      // Ensure correct order
      if (tab.nextSibling !== insertBefore) strip.insertBefore(tab, insertBefore);
      insertBefore = tab.nextSibling;
    } else {
      // Create new tab
      tab = document.createElement('div');
      tab.className = wantClass;
      tab.draggable = true;
      tab.dataset.tabId = id;
      tab.innerHTML =
        '<div class="tab-color" style="background:' + tabColor + '"></div>' +
        (s.isShell ? '<span class="tab-sh-badge">SH</span>' : '') +
        '<span class="tab-name">' + s.name + '</span>' +
        '<button class="tab-mute' + (s.muted ? ' muted' : '') + (s.speaking ? ' speaking' : '') + '" onclick="event.stopPropagation(); toggleMute(\'' + id + '\')">' + (s.muted ? _muteIcon : _speakerIcon) + '</button>' +
        '<button class="tab-close" onclick="event.stopPropagation(); closeSession(\'' + id + '\')">' + _closeIcon + '</button>';
      tab.onclick = () => switchTab(id);
      if (!s.isShell) tab.oncontextmenu = (e) => { e.preventDefault(); showTabMenu(id, e); };
      tab.addEventListener('dragstart', (e) => { dragSrcId = id; tab.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      tab.addEventListener('dragend', () => { tab.classList.remove('dragging'); strip.querySelectorAll('.drag-over').forEach(t => t.classList.remove('drag-over')); });
      tab.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; strip.querySelectorAll('.drag-over').forEach(t => t.classList.remove('drag-over')); if (id !== dragSrcId) tab.classList.add('drag-over'); });
      tab.addEventListener('drop', (e) => { e.preventDefault(); if (dragSrcId && dragSrcId !== id) { const f = tabOrder.indexOf(dragSrcId), t2 = tabOrder.indexOf(id); if (f >= 0 && t2 >= 0) { tabOrder.splice(f, 1); tabOrder.splice(t2, 0, dragSrcId); renderTabs(); saveState(); } } });
      strip.insertBefore(tab, insertBefore);
      insertBefore = tab.nextSibling;
    }
  }

  // Remove tabs for closed sessions
  existingTabs.forEach(t => { if (!seen.has(t.dataset.tabId)) t.remove(); });

  // Ensure add button exists
  if (!strip.querySelector('.tab-add')) {
    const addBtn = document.createElement('button');
    addBtn.className = 'tab-add';
    addBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    addBtn.onclick = () => showPicker();
    strip.appendChild(addBtn);
  }
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
        body: JSON.stringify({project: s.name.replace(/ /g, '-'), voice: v})
      }).catch(() => {});
      closeTabMenu();
    };
    voiceList.appendChild(btn);
  });
  dd.appendChild(voiceList);

  // New session (mid-session clear)
  const sep2 = document.createElement('div');
  sep2.className = 'tab-menu-sep';
  dd.appendChild(sep2);

  const newBtn = document.createElement('button');
  newBtn.className = 'tab-menu-item';
  newBtn.textContent = 'New Session';
  newBtn.onclick = () => { startNewSessionInPlace(sessionId); closeTabMenu(); };
  dd.appendChild(newBtn);

  // Close & Kill
  const killBtn = document.createElement('button');
  killBtn.className = 'tab-menu-item danger';
  killBtn.textContent = 'Close & Kill';
  killBtn.onclick = () => {
    const s = sessions[sessionId];
    if (!s) return;
    fetch('/api/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: s.name })
    }).catch(() => {});
    closeSession(sessionId);
    closeTabMenu();
  };
  dd.appendChild(killBtn);

  document.body.appendChild(dd);
  setTimeout(() => document.addEventListener('click', closeTabMenu, { once: true }), 0);
}

function closeTabMenu() {
  const existing = document.querySelector('.tab-menu');
  if (existing) existing.remove();
}

function showModal(title, body, actions) {
  const overlay = document.createElement('div');
  overlay.className = 'tterm-modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'tterm-modal';
  const titleEl = document.createElement('div');
  titleEl.className = 'tterm-modal-title';
  titleEl.textContent = title;
  modal.appendChild(titleEl);
  const bodyEl = document.createElement('div');
  bodyEl.className = 'tterm-modal-body';
  bodyEl.textContent = body;
  modal.appendChild(bodyEl);
  const actionsEl = document.createElement('div');
  actionsEl.className = 'tterm-modal-actions';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = 'tterm-modal-btn' + (a.class ? ' ' + a.class : '');
    btn.textContent = a.label;
    btn.onclick = () => { overlay.remove(); if (a.action) a.action(); };
    actionsEl.appendChild(btn);
  }
  modal.appendChild(actionsEl);
  overlay.appendChild(modal);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

function toggleMute(id) {
  if (!sessions[id]) return;
  const s = sessions[id];
  s.muted = !s.muted;
  // Stop voice player if muting
  if (s.muted && typeof _vpStop === 'function') _vpStop();
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
  if (viewMode === 'split') {
    renderSplitView();
  } else {
    renderPanes();
  }
  saveState();
  loadStats(id);
  // Refresh side tray panel if open (so it shows data for the new active session)
  if (activeTrayPanel) renderTrayPanel(activeTrayPanel);
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

async function doPageScreenshot() {
  document.getElementById('screenshot-dropdown').classList.remove('open');
  try {
    const canvas = await html2canvas(document.body, {
      backgroundColor: '#0a0a0f',
      scale: Math.max(window.devicePixelRatio || 1, 2),
      logging: false,
      useCORS: true,
    });
    canvas.toBlob(blob => { if (blob) uploadScreenshot(blob); }, 'image/png');
  } catch(err) { console.error('Page screenshot failed:', err); }
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
      addMessengerImage(activeSessionId, 'user', displayUrl, result.path, compressed.size, ts);
      // Save image reference server-side for persistence
      fetch('/api/chat-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: projectName, media: { url: displayUrl, time: new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}), size: compressed.size, ts } })
      }).catch(() => {});
      // In messenger or split mode, send the image path to PTY immediately
      if (viewMode === 'messenger' || viewMode === 'split') {
        const s = sessions[activeSessionId];
        if (s && s.ws.readyState === WebSocket.OPEN) {
          sentScreenshotPaths.add(result.path);
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
  x.textContent = '\u00d7';
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
//  Global keyboard handlers
// ══════════════════════════════════════════
// Escape key cancels Claude in messenger
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (viewMode === 'messenger' || viewMode === 'split')) {
    const s = sessions[activeSessionId];
    if (s && s.isThinking) {
      cancelClaude(activeSessionId);
    }
  }
});

// ══════════════════════════════════════════
//  Init — restore or show picker
// ══════════════════════════════════════════
window.addEventListener('DOMContentLoaded', function init() {
  if (isMobile) {
    document.body.classList.add('mobile');
    document.getElementById('terminal-view').classList.remove('active');
    loadProjects();
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
    // Restore tab order
    if (saved.tabOrder && saved.tabOrder.length > 0) {
      tabOrder = saved.tabOrder.map(name => Object.keys(sessions).find(k => sessions[k].name === name)).filter(Boolean);
    }
    if (saved.active) {
      const id = Object.keys(sessions).find(k => sessions[k].name === saved.active);
      if (id) switchTab(id);
    }
  } else {
    showPicker();
  }
  initTrayHover();
  loadProjects();
});

// ══════════════════════════════════════════
//  Page Navigation
// ══════════════════════════════════════════
const PAGE_NAMES = ['Home', 'Dashboard'];

function goPage(idx) {
  idx = Math.max(0, Math.min(PAGE_NAMES.length - 1, idx));
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
  if (next) next.disabled = idx === PAGE_NAMES.length - 1;

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
