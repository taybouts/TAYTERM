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
// Server-side connection info (async — updates connInfo when ready)
let connInfo = { route: connMode, cloudflare: connIsCloudflare, clientIp: '', localNetwork: connIsLocal };
const _connLabels = { 'local': 'LAN', 'tailscale': 'TS', 'cf-lan': 'CF\u2009\u279C\u2009LAN', 'cf-remote': 'CF', 'unknown': '?' };
const _connColors = { 'local': '34,197,94', 'tailscale': '56,189,248', 'cf-lan': '34,197,94', 'cf-remote': '245,158,11', 'unknown': '148,163,184' };
const _connTitles = { 'local': 'Local network (direct)', 'tailscale': 'Tailscale VPN (direct)', 'cf-lan': 'Cloudflare \u279C Local network', 'cf-remote': 'Cloudflare (remote)', 'unknown': 'Unknown' };
(async function fetchConnInfo() {
  try {
    const r = await fetch('/api/connection-info');
    connInfo = await r.json();
    // Update any connection badges on the page
    document.querySelectorAll('.conn-badge').forEach(el => {
      const route = connInfo.route;
      const c = _connColors[route] || _connColors.unknown;
      el.style.background = 'rgba(' + c + ',0.12)';
      el.style.borderColor = 'rgba(' + c + ',0.25)';
      el.style.color = 'rgb(' + c + ')';
      el.querySelector('.conn-label').textContent = _connLabels[route] || '?';
      el.title = (_connTitles[route] || '') + (connInfo.clientIp ? ' \u2014 ' + connInfo.clientIp : '');
    });
  } catch(e) {}
})();

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
function rerenderDashboard() {
  const pinned = getPinnedProjects();
  renderFavorites(allProjects, pinned);
  renderHeroStatus(allProjects, pinned);
  renderDashboard(allProjects, pinned);
}
function pinProject(name) {
  const pinned = getPinnedProjects();
  if (!pinned.includes(name)) pinned.push(name);
  savePinnedProjects(pinned);
  rerenderDashboard();
}
function unpinProject(name) {
  savePinnedProjects(getPinnedProjects().filter(n => n !== name));
  rerenderDashboard();
}
function movePinned(name, dir) {
  const pinned = getPinnedProjects();
  const i = pinned.indexOf(name);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= pinned.length) return;
  [pinned[i], pinned[j]] = [pinned[j], pinned[i]];
  savePinnedProjects(pinned);
  rerenderDashboard();
}

const terminalIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';

// ══════════════════════════════════════════
//  Icon Library + Project Appearance
// ══════════════════════════════════════════

// Full icon library — name → SVG inner content (24x24 viewBox, stroke-based)
const iconLibrary = {
  // App Icons — Line (24x24) — T-Server design system originals
  'terminal':     '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  'waveform-app': '<line x1="4" y1="9" x2="4" y2="15"/><line x1="7" y1="6" x2="7" y2="18"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="13" y1="4" x2="13" y2="20"/><line x1="16" y1="7" x2="16" y2="17"/><line x1="19" y1="9" x2="19" y2="15"/>',
  'scale-app':    '<line x1="12" y1="3" x2="12" y2="19"/><line x1="5" y1="6" x2="19" y2="6"/><path d="M5 6 L3 12 Q3 14 5 14 Q7 14 7 12 Z" fill="currentColor" opacity="0.15"/><path d="M19 6 L17 12 Q17 14 19 14 Q21 14 21 12 Z" fill="currentColor" opacity="0.15"/><line x1="8" y1="19" x2="16" y2="19"/>',
  'gear-app':     '<circle cx="12" cy="12" r="3"/><path d="M12 2 L12 5"/><path d="M12 19 L12 22"/><path d="M2 12 L5 12"/><path d="M19 12 L22 12"/><path d="M4.93 4.93 L6.34 6.34"/><path d="M17.66 17.66 L19.07 19.07"/><path d="M4.93 19.07 L6.34 17.66"/><path d="M17.66 6.34 L19.07 4.93"/>',
  'network-app':  '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><circle cx="12" cy="12" r="2"/><line x1="7.8" y1="7.2" x2="10.5" y2="10.5"/><line x1="16.2" y1="7.2" x2="13.5" y2="10.5"/><line x1="7.8" y1="16.8" x2="10.5" y2="13.5"/><line x1="16.2" y1="16.8" x2="13.5" y2="13.5"/>',
  'chart-app':    '<line x1="6" y1="4" x2="6" y2="20"/><rect x="4" y="8" width="4" height="5" rx="0.5" fill="currentColor" opacity="0.3"/><line x1="12" y1="6" x2="12" y2="18"/><rect x="10" y="9" width="4" height="6" rx="0.5" fill="currentColor" opacity="0.3"/><line x1="18" y1="3" x2="18" y2="17"/><rect x="16" y="5" width="4" height="7" rx="0.5" fill="currentColor" opacity="0.3"/>',
  'grid-app':     '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="4" rx="1.5"/><rect x="14" y="11" width="7" height="10" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  // Development
  'code':       '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  'braces':       '<path d="M8 3 C5 3 4 5 4 7 L4 10 C4 11 3 12 2 12 C3 12 4 13 4 14 L4 17 C4 19 5 21 8 21"/><path d="M16 3 C19 3 20 5 20 7 L20 10 C20 11 21 12 22 12 C21 12 20 13 20 14 L20 17 C20 19 19 21 16 21"/>',
  'git':          '<circle cx="12" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><line x1="12" y1="8" x2="12" y2="12"/><path d="M12 12 C12 16 6 16 6 16"/><path d="M12 12 C12 16 18 16 18 16"/>',
  'bug':          '<rect x="8" y="6" width="8" height="14" rx="4"/><line x1="5" y1="10" x2="8" y2="10"/><line x1="16" y1="10" x2="19" y2="10"/><line x1="5" y1="14" x2="8" y2="14"/><line x1="16" y1="14" x2="19" y2="14"/><path d="M9 2 L10 6"/><path d="M15 2 L14 6"/>',
  'database':     '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5 L4 19 C4 20.7 7.6 22 12 22 C16.4 22 20 20.7 20 19 L20 5"/><path d="M4 12 C4 13.7 7.6 15 12 15 C16.4 15 20 13.7 20 12"/>',
  'cpu':          '<rect x="6" y="6" width="12" height="12" rx="2"/><line x1="9" y1="2" x2="9" y2="6"/><line x1="15" y1="2" x2="15" y2="6"/><line x1="9" y1="18" x2="9" y2="22"/><line x1="15" y1="18" x2="15" y2="22"/><line x1="2" y1="9" x2="6" y2="9"/><line x1="2" y1="15" x2="6" y2="15"/><line x1="18" y1="9" x2="22" y2="9"/><line x1="18" y1="15" x2="22" y2="15"/>',
  'api':          '<path d="M4 15 L8 4 L12 15"/><line x1="5.5" y1="11" x2="10.5" y2="11"/><path d="M14 4 L14 15"/><circle cx="14" cy="4" r="1.5" fill="currentColor" opacity="0.3"/><path d="M18 4 L18 15"/><line x1="18" y1="4" x2="22" y2="4"/><line x1="18" y1="9" x2="21" y2="9"/>',
  // Communication
  'chat':         '<path d="M21 12 C21 16.4 16.97 20 12 20 C10.5 20 9.1 19.7 7.8 19.2 L3 21 L4.5 17.2 C3.6 15.7 3 13.9 3 12 C3 7.6 7.03 4 12 4 C16.97 4 21 7.6 21 12Z"/>',
  'mail':         '<rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/>',
  'phone':        '<path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.4 19.4 0 01-6-6 19.8 19.8 0 01-3.1-8.7A2 2 0 014.1 2h3a2 2 0 012 1.7 12.4 12.4 0 00.7 2.7 2 2 0 01-.5 2.1L8.1 9.7a16 16 0 006.2 6.2l1.2-1.2a2 2 0 012.1-.5 12.4 12.4 0 002.7.7A2 2 0 0122 16.9z"/>',
  'send':         '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9"/>',
  'bot':          '<rect x="5" y="8" width="14" height="12" rx="3"/><circle cx="9" cy="14" r="1.5" fill="currentColor" opacity="0.4"/><circle cx="15" cy="14" r="1.5" fill="currentColor" opacity="0.4"/><line x1="12" y1="3" x2="12" y2="8"/><circle cx="12" cy="3" r="1.5"/>',
  // Audio & Media
  'waveform':     '<line x1="4" y1="9" x2="4" y2="15"/><line x1="7" y1="6" x2="7" y2="18"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="13" y1="4" x2="13" y2="20"/><line x1="16" y1="7" x2="16" y2="17"/><line x1="19" y1="9" x2="19" y2="15"/>',
  'mic':          '<path d="M12 2 C10.3 2 9 3.3 9 5 L9 12 C9 13.7 10.3 15 12 15 C13.7 15 15 13.7 15 12 L15 5 C15 3.3 13.7 2 12 2Z"/><path d="M19 10 L19 12 C19 15.9 15.9 19 12 19 C8.1 19 5 15.9 5 12 L5 10"/><line x1="12" y1="19" x2="12" y2="22"/>',
  'speaker':      '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><path d="M15.5 8.5 C16.9 9.9 16.9 14.1 15.5 15.5"/><path d="M19 5 C22 8 22 16 19 19"/>',
  'music':        '<path d="M9 18 L9 5 L21 3 L21 16"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  'headphones':   '<path d="M3 18 L3 12 C3 7 7 3 12 3 C17 3 21 7 21 12 L21 18"/><rect x="1" y="14" width="4" height="7" rx="1.5"/><rect x="19" y="14" width="4" height="7" rx="1.5"/>',
  'camera':       '<path d="M23 19 C23 20.1 22.1 21 21 21 L3 21 C1.9 21 1 20.1 1 19 L1 8 C1 6.9 1.9 6 3 6 L7 6 L9 3 L15 3 L17 6 L21 6 C22.1 6 23 6.9 23 8Z"/><circle cx="12" cy="13" r="4"/>',
  'image':        '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  'video':        '<polygon points="23 7 16 12 23 17"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  // Objects & Concepts
  'folder':       '<path d="M22 19 C22 20.1 21.1 21 20 21 L4 21 C2.9 21 2 20.1 2 19 L2 5 C2 3.9 2.9 3 4 3 L9 3 L11 6 L20 6 C21.1 6 22 6.9 22 8Z"/>',
  'file':         '<path d="M14 2 L6 2 C4.9 2 4 2.9 4 4 L4 20 C4 21.1 4.9 22 6 22 L18 22 C19.1 22 20 21.1 20 20 L20 8Z"/><polyline points="14 2 14 8 20 8"/>',
  'book':         '<path d="M4 19.5 C4 18.1 5.1 17 6.5 17 L20 17 L20 2 L6.5 2 C5.1 2 4 3.1 4 4.5Z"/><path d="M4 19.5 C4 20.9 5.1 22 6.5 22 L20 22 L20 17"/>',
  'clipboard':    '<path d="M16 4 L18 4 C19.1 4 20 4.9 20 6 L20 20 C20 21.1 19.1 22 18 22 L6 22 C4.9 22 4 21.1 4 20 L4 6 C4 4.9 4.9 4 6 4 L8 4"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  'key':          '<path d="M21 2 L19 4 L21 2Z M15 8 L19 4 M15 8 L17 10 L15 12 M7 14 C4.8 14 3 15.8 3 18 C3 20.2 4.8 22 7 22 C9.2 22 11 20.2 11 18 C11 15.8 9.2 14 7 14Z"/>',
  // Business & Finance
  'scale':        '<line x1="12" y1="3" x2="12" y2="19"/><line x1="5" y1="6" x2="19" y2="6"/><path d="M5 6 L3 12 Q3 14 5 14 Q7 14 7 12 Z" fill="currentColor" opacity="0.15"/><path d="M19 6 L17 12 Q17 14 19 14 Q21 14 21 12 Z" fill="currentColor" opacity="0.15"/><line x1="8" y1="19" x2="16" y2="19"/>',
  'chart':        '<line x1="6" y1="4" x2="6" y2="20"/><rect x="4" y="8" width="4" height="5" rx="0.5" fill="currentColor" opacity="0.3"/><line x1="12" y1="6" x2="12" y2="18"/><rect x="10" y="9" width="4" height="6" rx="0.5" fill="currentColor" opacity="0.3"/><line x1="18" y1="3" x2="18" y2="17"/><rect x="16" y="5" width="4" height="7" rx="0.5" fill="currentColor" opacity="0.3"/>',
  'dollar':       '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5 L9.5 5 C7.5 5 6 6.5 6 8.5 C6 10.5 7.5 12 9.5 12 L14.5 12 C16.5 12 18 13.5 18 15.5 C18 17.5 16.5 19 14.5 19 L7 19"/>',
  'briefcase':    '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7 L16 5 C16 3.9 15.1 3 14 3 L10 3 C8.9 3 8 3.9 8 5 L8 7"/>',
  // Infrastructure & Network
  'cloud':        '<path d="M18 10 C18.7 10 20 10.5 20 13 C20 15.5 18 16 17 16 L7 16 C4.8 16 3 14.2 3 12 C3 9.8 4.8 8 7 8 C7 5 9.2 3 12 3 C14.5 3 16.5 4.8 17 7"/>',
  'globe':        '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2 C14.7 4.7 16 8.2 16 12 C16 15.8 14.7 19.3 12 22"/><path d="M12 2 C9.3 4.7 8 8.2 8 12 C8 15.8 9.3 19.3 12 22"/>',
  'server':       '<rect x="3" y="2" width="18" height="6" rx="2"/><rect x="3" y="10" width="18" height="6" rx="2"/><circle cx="7" cy="5" r="1" fill="currentColor"/><circle cx="7" cy="13" r="1" fill="currentColor"/><line x1="3" y1="20" x2="8" y2="20"/><line x1="16" y1="20" x2="21" y2="20"/><line x1="12" y1="16" x2="12" y2="22"/>',
  'network':      '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><circle cx="12" cy="12" r="2"/><line x1="7.8" y1="7.2" x2="10.5" y2="10.5"/><line x1="16.2" y1="7.2" x2="13.5" y2="10.5"/><line x1="7.8" y1="16.8" x2="10.5" y2="13.5"/><line x1="16.2" y1="16.8" x2="13.5" y2="13.5"/>',
  'wifi':         '<path d="M5 12.5 C8.5 9 15.5 9 19 12.5"/><path d="M2 9 C7 4 17 4 22 9"/><path d="M8.5 16 C10 14.5 14 14.5 15.5 16"/><circle cx="12" cy="19" r="1" fill="currentColor"/>',
  'shield':       '<path d="M12 22 C12 22 3 18 3 10 L3 5 L12 2 L21 5 L21 10 C21 18 12 22 12 22Z"/>',
  'lock':         '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11 L8 7 C8 4.8 9.8 3 12 3 C14.2 3 16 4.8 16 7 L16 11"/>',
  // Shapes & UI
  'grid':         '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="4" rx="1.5"/><rect x="14" y="11" width="7" height="10" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  'layers':       '<polygon points="12 2 2 7 12 12 22 7"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  'box':          '<path d="M21 16 L21 8 C21 7.5 20.7 7 20.2 6.7 L12.2 2.2 C12.1 2.1 11.9 2.1 11.8 2.2 L3.8 6.7 C3.3 7 3 7.5 3 8 L3 16 C3 16.5 3.3 17 3.8 17.3 L11.8 21.8 C11.9 21.9 12.1 21.9 12.2 21.8 L20.2 17.3 C20.7 17 21 16.5 21 16Z"/><line x1="3.3" y1="7" x2="12" y2="12"/><line x1="12" y1="22" x2="12" y2="12"/><line x1="20.7" y1="7" x2="12" y2="12"/>',
  // Science & Tools
  'gear':         '<circle cx="12" cy="12" r="3"/><path d="M12 2 L12 5"/><path d="M12 19 L12 22"/><path d="M2 12 L5 12"/><path d="M19 12 L22 12"/><path d="M4.93 4.93 L6.34 6.34"/><path d="M17.66 17.66 L19.07 19.07"/><path d="M4.93 19.07 L6.34 17.66"/><path d="M17.66 6.34 L19.07 4.93"/>',
  'wrench':       '<path d="M14.7 6.3 C13.5 5.1 11.7 4.7 10.1 5.3 L12.4 7.6 L11.7 10.3 L9 11 L6.7 8.7 C6.1 10.3 6.5 12.1 7.7 13.3 C8.9 14.5 10.7 14.9 12.3 14.3 L18.3 20.3 C18.7 20.7 19.3 20.7 19.7 20.3 L20.3 19.7 C20.7 19.3 20.7 18.7 20.3 18.3 L14.3 12.3 C14.9 10.7 14.5 8.9 14.7 6.3Z"/>',
  'flask':        '<path d="M9 3 L15 3"/><path d="M10 3 L10 9 L4 19 C3.3 20.3 4.2 22 5.7 22 L18.3 22 C19.8 22 20.7 20.3 20 19 L14 9 L14 3"/>',
  'atom':         '<circle cx="12" cy="12" r="2" fill="currentColor" opacity="0.4"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/>',
  'lightning':    '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/>',
  'fire':         '<path d="M12 22 C16.4 22 20 18.4 20 14 C20 8 12 2 12 2 C12 2 4 8 4 14 C4 18.4 7.6 22 12 22Z"/><path d="M12 22 C14.2 22 16 20.2 16 18 C16 15 12 11 12 11 C12 11 8 15 8 18 C8 20.2 9.8 22 12 22Z" fill="currentColor" opacity="0.15"/>',
  // Navigation & Arrows
  'compass':      '<circle cx="12" cy="12" r="10"/><polygon points="16.2 7.8 14.5 14.5 7.8 16.2 9.5 9.5" fill="currentColor" opacity="0.2"/><polygon points="16.2 7.8 14.5 14.5 7.8 16.2 9.5 9.5"/>',
  'rocket':       '<path d="M4.5 16.5 C3 18 3 21 3 21 C3 21 6 21 7.5 19.5 C8.3 18.7 8.3 17.3 7.5 16.5 C6.7 15.7 5.3 15.7 4.5 16.5Z"/><path d="M12 15 L9 12 C9 12 11 6 17 3 C17 3 14 9 12 15Z"/><path d="M12 15 L15 18 C15 18 18 12 21 6"/>',
  'target':       '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  // People & Social
  'user':         '<path d="M20 21 L20 19 C20 16.8 18.2 15 16 15 L8 15 C5.8 15 4 16.8 4 19 L4 21"/><circle cx="12" cy="7" r="4"/>',
  'users':        '<path d="M17 21 L17 19 C17 16.8 15.2 15 13 15 L5 15 C2.8 15 1 16.8 1 19 L1 21"/><circle cx="9" cy="7" r="4"/><path d="M23 21 L23 19 C23 17.1 21.8 15.5 20 15.1"/><path d="M16 3.1 C17.8 3.6 19 5.1 19 7 C19 8.9 17.8 10.4 16 10.9"/>',
  'heart':        '<path d="M20.8 4.6 C18.5 2.3 14.8 2.3 12.5 4.6 L12 5.1 L11.5 4.6 C9.2 2.3 5.5 2.3 3.2 4.6 C0.9 6.9 0.9 10.6 3.2 12.9 L12 21.7 L20.8 12.9 C23.1 10.6 23.1 6.9 20.8 4.6Z"/>',
  'star':         '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3"/>',
  // Misc
  'home':         '<path d="M3 9 L12 2 L21 9 L21 20 C21 21.1 20.1 22 19 22 L5 22 C3.9 22 3 21.1 3 20Z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  'clock':        '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  'eye':          '<path d="M1 12 C1 12 5 5 12 5 C19 5 23 12 23 12 C23 12 19 19 12 19 C5 19 1 12 1 12Z"/><circle cx="12" cy="12" r="3"/>',
  'search':       '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.7" y2="16.7"/>',
  'download':     '<path d="M21 15 L21 19 C21 20.1 20.1 21 19 21 L5 21 C3.9 21 3 20.1 3 19 L3 15"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  'upload':       '<path d="M21 15 L21 19 C21 20.1 20.1 21 19 21 L5 21 C3.9 21 3 20.1 3 19 L3 15"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  'link':         '<path d="M10 13 C10.9 14.3 12.6 15 14 15 C16.2 15 18 13.2 18 11 L21 8 C21 5.8 19.2 4 17 4 C14.8 4 13 5.8 13 8"/><path d="M14 11 C13.1 9.7 11.4 9 10 9 C7.8 9 6 10.8 6 13 L3 16 C3 18.2 4.8 20 7 20 C9.2 20 11 18.2 11 16"/>',
  'pin':          '<path d="M21 10 C21 17 12 23 12 23 C12 23 3 17 3 10 C3 5 7 1 12 1 C17 1 21 5 21 10Z"/><circle cx="12" cy="10" r="3"/>',
  'flag':         '<line x1="4" y1="22" x2="4" y2="2"/><path d="M4 2 L4 15 C4 15 7 12 12 15 C17 18 20 15 20 15 L20 2 C20 2 17 5 12 2 C7 -1 4 2 4 2Z" fill="currentColor" opacity="0.1"/>',
  'zap':          '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/>',
  'bulb':         '<path d="M9 18 L15 18"/><path d="M10 22 L14 22"/><path d="M12 2 C8 2 5 5 5 9 C5 12 7 14 8.5 15.5 C9 16 9 16.5 9 17 L15 17 C15 16.5 15 16 15.5 15.5 C17 14 19 12 19 9 C19 5 16 2 12 2Z"/>',
  'telescope':    '<circle cx="6" cy="18" r="3"/><line x1="8.5" y1="16" x2="18" y2="4"/><line x1="15" y1="3" x2="21" y2="7"/><line x1="9" y1="15.5" x2="13" y2="10"/>',
};

// Default hardcoded map (fallback when no saved settings exist)
const _defaultColorMap = {
  'T-Term': '#0284c7', 'T-Voice': '#7c3aed', 'LEGAL': '#dc2626',
  'TayProcess': '#4f46e5', 'MESHVPN': '#059669', 'NinjaTrader': '#d97706',
  'TELEGRAMBOT': '#d97706', 'Command Center': '#0891b2', 'IMAGEW': '#ea580c',
};
const _defaultIconMap = {
  'T-Term': 'terminal', 'T-Voice': 'waveform-app', 'LEGAL': 'scale-app',
  'TayProcess': 'gear-app', 'MESHVPN': 'network-app', 'NinjaTrader': 'chart-app',
  'Command Center': 'grid-app',
};

// Saved project settings (loaded from server)
let _projectSettings = {};
(async function loadProjectSettings() {
  try {
    const r = await fetch('/api/project-settings');
    _projectSettings = await r.json();
  } catch(e) {}
})();

function _iconSvgFromKey(key) {
  const inner = iconLibrary[key];
  if (!inner) return '';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
}

function getProjectIcon(name) {
  // Saved setting takes priority
  const saved = _projectSettings[name];
  if (saved && saved.icon) return _iconSvgFromKey(saved.icon);
  // Hardcoded default
  if (_defaultIconMap[name]) return _iconSvgFromKey(_defaultIconMap[name]);
  return '';
}

const projectColors = {};
const defaultColors = ['#0284c7','#d97706','#dc2626','#818cf8','#14b8a6','#7c3aed','#f97316','#22c55e'];
function getProjectColor(name) {
  // Saved setting takes priority
  const saved = _projectSettings[name];
  if (saved && saved.color) return saved.color;
  // Hardcoded default
  if (_defaultColorMap[name]) return _defaultColorMap[name];
  // Hash-based fallback
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

// ══════════════════════════════════════════
//  Project Appearance Picker Modal
// ══════════════════════════════════════════
const paletteColors = [
  '#0284c7','#0891b2','#14b8a6','#059669','#22c55e','#84cc16',
  '#d97706','#ea580c','#f97316','#dc2626','#e11d48','#f43f5e',
  '#7c3aed','#8b5cf6','#818cf8','#4f46e5','#6366f1','#a855f7',
  '#ec4899','#d946ef','#06b6d4','#0ea5e9','#64748b','#78716c',
];

function showAppearancePicker(projectName) {
  const currentColor = getProjectColor(projectName);
  const saved = _projectSettings[projectName] || {};
  const currentIcon = saved.icon || _defaultIconMap[projectName] || '';

  const overlay = document.createElement('div');
  overlay.className = 'tterm-modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'tterm-modal';
  modal.style.maxWidth = '480px';
  modal.style.maxHeight = '80vh';
  modal.style.overflow = 'auto';

  // Title
  const title = document.createElement('div');
  title.className = 'tterm-modal-title';
  title.textContent = projectName;
  modal.appendChild(title);

  // Preview
  const preview = document.createElement('div');
  preview.style.cssText = 'display:flex;align-items:center;gap:12px;margin:12px 0 16px;justify-content:center;';
  const previewIcon = document.createElement('div');
  previewIcon.className = 'project-icon';
  previewIcon.style.cssText = 'width:72px;height:72px;border-radius:16px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,' + currentColor + ',' + adjustColor(currentColor, 40) + ');';
  previewIcon.innerHTML = (currentIcon ? _iconSvgFromKey(currentIcon) : getProjectIcon(projectName)) || terminalIcon;
  preview.appendChild(previewIcon);
  const previewLabel = document.createElement('div');
  previewLabel.style.cssText = 'font-size:18px;font-weight:600;color:#e2e8f0;';
  previewLabel.textContent = projectName;
  preview.appendChild(previewLabel);
  modal.appendChild(preview);

  let selectedIcon = currentIcon;
  let selectedColor = currentColor;

  function updatePreview() {
    previewIcon.style.background = 'linear-gradient(135deg,' + selectedColor + ',' + adjustColor(selectedColor, 40) + ')';
    previewIcon.innerHTML = (selectedIcon ? _iconSvgFromKey(selectedIcon) : '') || terminalIcon;
  }

  // Color section
  const colorLabel = document.createElement('div');
  colorLabel.style.cssText = 'font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:8px;font-weight:600;';
  colorLabel.textContent = 'Color';
  modal.appendChild(colorLabel);

  const colorGrid = document.createElement('div');
  colorGrid.style.cssText = 'display:grid;grid-template-columns:repeat(8,1fr);gap:6px;margin-bottom:16px;';
  for (const c of paletteColors) {
    const swatch = document.createElement('div');
    swatch.style.cssText = 'width:100%;aspect-ratio:1;border-radius:8px;cursor:pointer;background:' + c + ';border:2px solid ' + (c === selectedColor ? '#fff' : 'transparent') + ';transition:border 0.15s,transform 0.15s;';
    swatch.onmouseenter = () => { swatch.style.transform = 'scale(1.15)'; };
    swatch.onmouseleave = () => { swatch.style.transform = ''; };
    swatch.onclick = () => {
      selectedColor = c;
      colorGrid.querySelectorAll('div').forEach(d => d.style.borderColor = 'transparent');
      swatch.style.borderColor = '#fff';
      customColorInput.value = c;
      updatePreview();
    };
    colorGrid.appendChild(swatch);
  }
  modal.appendChild(colorGrid);

  // Custom color input
  const customRow = document.createElement('div');
  customRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:20px;';
  const customColorInput = document.createElement('input');
  customColorInput.type = 'color';
  customColorInput.value = selectedColor;
  customColorInput.style.cssText = 'width:36px;height:36px;border:none;background:none;cursor:pointer;padding:0;';
  customColorInput.oninput = () => {
    selectedColor = customColorInput.value;
    colorGrid.querySelectorAll('div').forEach(d => d.style.borderColor = 'transparent');
    updatePreview();
  };
  const customLabel = document.createElement('span');
  customLabel.style.cssText = 'color:#94a3b8;font-size:12px;';
  customLabel.textContent = 'Custom color';
  customRow.appendChild(customColorInput);
  customRow.appendChild(customLabel);
  modal.appendChild(customRow);

  // Icon section
  const iconLabel = document.createElement('div');
  iconLabel.style.cssText = 'font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:8px;font-weight:600;';
  iconLabel.textContent = 'Icon';
  modal.appendChild(iconLabel);

  const iconGrid = document.createElement('div');
  iconGrid.style.cssText = 'display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:20px;';
  // "None" option
  const noneCell = document.createElement('div');
  noneCell.style.cssText = 'width:100%;aspect-ratio:1;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:10px;color:#64748b;border:2px solid ' + (!selectedIcon ? '#fff' : 'transparent') + ';background:rgba(255,255,255,0.05);transition:border 0.15s,background 0.15s;';
  noneCell.textContent = 'none';
  noneCell.onclick = () => {
    selectedIcon = '';
    iconGrid.querySelectorAll('.icon-cell').forEach(d => d.style.borderColor = 'transparent');
    noneCell.style.borderColor = '#fff';
    updatePreview();
  };
  noneCell.className = 'icon-cell';
  iconGrid.appendChild(noneCell);

  for (const [key, inner] of Object.entries(iconLibrary)) {
    const cell = document.createElement('div');
    cell.className = 'icon-cell';
    cell.style.cssText = 'width:100%;aspect-ratio:1;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#e2e8f0;border:2px solid ' + (key === selectedIcon ? '#fff' : 'transparent') + ';background:rgba(255,255,255,0.05);transition:border 0.15s,background 0.15s;';
    cell.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:28px;height:28px;">' + inner + '</svg>';
    cell.title = key;
    cell.onmouseenter = () => { cell.style.background = 'rgba(255,255,255,0.12)'; };
    cell.onmouseleave = () => { cell.style.background = 'rgba(255,255,255,0.05)'; };
    cell.onclick = () => {
      selectedIcon = key;
      iconGrid.querySelectorAll('.icon-cell').forEach(d => d.style.borderColor = 'transparent');
      cell.style.borderColor = '#fff';
      updatePreview();
    };
    iconGrid.appendChild(cell);
  }
  modal.appendChild(iconGrid);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'tterm-modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'tterm-modal-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => overlay.remove();
  const saveBtn = document.createElement('button');
  saveBtn.className = 'tterm-modal-btn primary';
  saveBtn.textContent = 'Save';
  saveBtn.onclick = async () => {
    try {
      await fetch('/api/project-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: projectName, icon: selectedIcon, color: selectedColor }),
      });
      _projectSettings[projectName] = { icon: selectedIcon, color: selectedColor };
      delete projectColors[projectName]; // Clear hash cache
      rerenderDashboard(); // Re-render picker without network calls
    } catch(e) {}
    overlay.remove();
  };
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
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
        '<div class="card-edit-btn" onclick="event.stopPropagation();showAppearancePicker(\'' + esc + '\')" title="Edit icon &amp; color">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>' +
        '</div>' +
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
        // No live PTY — fresh start (server will send jsonl-ready when JSONL attaches)
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
      } else if (msg.type === 'jsonl-ready') {
        // Server confirmed which JSONL is active — safe to load history
        if (sessions[id]) {
          sessions[id]._jsonlSessionId = msg.sessionId;
        }
        // Load history if messenger is empty for this session
        if (!messengerMessages[id] || messengerMessages[id].length === 0) {
          delete cachedPanes[id];
          renderMessenger();
        }
      } else if (msg.type === 'jsonl-cleared') {
        // /clear happened — clean slate, wait for new jsonl-ready
        delete messengerMessages[id];
        delete cachedPanes[id];
        messengerMessages[id] = [];
        if (sessions[id]) sessions[id]._jsonlSessionId = null;
        renderMessenger();
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
    // Auto-reconnect if session still exists (not intentionally closed or killed)
    if (!sessions[id] || sessions[id]._killed) return;
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

  if (!window._bulkRestore) {
    renderTabs();
    switchTab(id);
    saveState();
  }
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
    // Close WS first with no-reconnect flag to prevent auto-reconnect race
    s._killed = true;
    if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.close();
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
    // Clean slate — clear stale messenger caches from previous page load
    for (const k of Object.keys(cachedPanes)) delete cachedPanes[k];
    for (const k of Object.keys(messengerMessages)) delete messengerMessages[k];
    // Suppress rendering during bulk restore — one render at the end
    window._bulkRestore = true;
    for (const tab of saved.tabs) {
      openSession(tab.name, tab.isShell || false, !tab.isShell);
      // Restore mute state
      const sid = tab.name + (tab.isShell ? ':shell' : ':claude');
      if (sessions[sid] && tab.muted) {
        sessions[sid].muted = true;
      }
    }
    window._bulkRestore = false;
    // Restore pane assignments
    if (saved.panes && saved.panes.length > 0) {
      for (let i = 0; i < saved.panes.length; i++) {
        if (saved.panes[i]) {
          const sid = Object.keys(sessions).find(k => sessions[k].name === saved.panes[i]);
          if (sid) paneSlots[i] = sid;
        }
      }
    }
    // Restore tab order
    if (saved.tabOrder && saved.tabOrder.length > 0) {
      tabOrder = saved.tabOrder.map(name => Object.keys(sessions).find(k => sessions[k].name === name)).filter(Boolean);
    }
    // Set active tab
    if (saved.active) {
      const id = Object.keys(sessions).find(k => sessions[k].name === saved.active);
      if (id) activeSessionId = id;
    }
    // Single render pass — all sessions exist, paneSlots correct, no wasted renders
    renderTabs();
    renderPanes();
    if (activeSessionId) loadStats(activeSessionId);
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
