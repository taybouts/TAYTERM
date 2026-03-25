/**
 * TAYTERM Hybrid QR Code + Face ID Authentication
 *
 * Desktop: shows QR code on login page, polls for approval.
 * Phone: scans QR, approves via Face ID (WebAuthn).
 * Graceful degradation if @simplewebauthn/server not installed.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const QRCode = require('qrcode');

// ---------------------------------------------------------------------------
//  HTML Templates
// ---------------------------------------------------------------------------
const inviteEmailHtml = require('./templates/invite-email');
const loginPageHTML = require('./templates/login');
const sessionsPageHTML = require('./templates/sessions');
const approvePageHTML = require('./templates/approve');
const REGISTER_HTML = require('./templates/register');
const expiredInviteHTML = require('./templates/expired-invite');
const inviteRegisterHTML = require('./templates/invite-register');
const adminPageHTML = require('./templates/admin');

// ---------------------------------------------------------------------------
//  Resend Email Integration
// ---------------------------------------------------------------------------
const RESEND_API_KEY = 're_UV4AqZgv_FyN3HbAyopoMzYptbDvtLk1Z';
const RESEND_FROM = 'T-Term <register@taybouts.com>';

function sendInviteEmail(toEmail, inviteLink) {
    const html = inviteEmailHtml(toEmail, inviteLink);
    const payload = JSON.stringify({
        from: RESEND_FROM,
        to: [toEmail],
        subject: 'You\'ve been invited to T-Term',
        html,
    });

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.resend.com',
            path: '/emails',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(body)); } catch (e) { resolve(body); }
                } else {
                    console.error(`[EMAIL] Resend error ${res.statusCode}: ${body}`);
                    reject(new Error(`Resend ${res.statusCode}: ${body}`));
                }
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}


// ---------------------------------------------------------------------------
//  Try to load SimpleWebAuthn (graceful degradation)
// ---------------------------------------------------------------------------

let simplewebauthn = null;
try {
    simplewebauthn = require('@simplewebauthn/server');
} catch (e) {
    console.log('[AUTH] @simplewebauthn/server not found — auth disabled (open access)');
}

// ---------------------------------------------------------------------------
//  Config
// ---------------------------------------------------------------------------

const BASE_DIR = path.dirname(path.resolve(__filename));
const PASSKEY_FILE = path.join(BASE_DIR, '.tterm_passkeys.json');
const WHITELIST_FILE = path.join(BASE_DIR, '.tterm_whitelist.json');
const AUDIT_FILE = path.join(BASE_DIR, '.tterm_audit.json');
const USERS_FILE = path.join(BASE_DIR, '.tterm_users.json');
const INVITES_FILE = path.join(BASE_DIR, '.tterm_invites.json');
const INVITE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_MAX_AGE = 86400; // 24 hours in seconds
const TOKEN_MAX_AGE = 5 * 60 * 1000; // 5 minutes
const COOKIE_NAME = 'tterm_session';
const WHITELIST_COOKIE = 'tterm_trusted';

// Pending QR sessions: token -> { approved, created, sessionId }
const pendingSessions = new Map();

// Active sessions: sessionId -> { created, expires, ip, userAgent }
const SESSIONS_FILE = path.join(BASE_DIR, '.tterm_sessions.json');
const activeSessions = new Map();

// Load sessions from file on startup
function loadSessionsFromFile() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
            const now = Date.now();
            for (const [id, session] of Object.entries(data)) {
                if (session.expires > now) {
                    activeSessions.set(id, session);
                }
            }
            console.log(`[AUTH] Loaded ${activeSessions.size} active sessions from file`);
        }
    } catch (e) { console.error('[AUTH] Failed to load sessions:', e.message); }
}

function saveSessionsToFile() {
    try {
        const obj = {};
        for (const [id, session] of activeSessions) {
            obj[id] = session;
        }
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (e) { console.error('[AUTH] Failed to save sessions:', e.message); }
}

loadSessionsFromFile();

// Per-token WebAuthn challenges for approval flow
const pendingChallenges = new Map();

// Registration challenge (only one at a time)
let registrationChallenge = null;

// ---------------------------------------------------------------------------
//  Passkey Storage
// ---------------------------------------------------------------------------

function loadPasskeys() {
    try {
        if (fs.existsSync(PASSKEY_FILE)) {
            return JSON.parse(fs.readFileSync(PASSKEY_FILE, 'utf-8'));
        }
    } catch (e) {
        console.error('[AUTH] Failed to load passkeys:', e.message);
    }
    return { passkeys: [], backupCodes: [] };
}

function savePasskeys(data) {
    fs.writeFileSync(PASSKEY_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function hasPasskeys() {
    const data = loadPasskeys();
    return data.passkeys && data.passkeys.length > 0;
}

// ---------------------------------------------------------------------------
//  Whitelist Storage (trusted devices that skip auth)
// ---------------------------------------------------------------------------

function loadWhitelist() {
    try {
        if (fs.existsSync(WHITELIST_FILE)) return JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf-8'));
    } catch (e) {}
    return [];
}

function saveWhitelist(list) {
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

function isWhitelisted(req) {
    const cookies = parseCookies(req);
    const token = cookies[WHITELIST_COOKIE];
    if (!token) return false;
    const list = loadWhitelist();
    return list.some(d => d.token === token);
}

function parseCookies(req) {
    const header = req.headers.cookie || '';
    const out = {};
    header.split(';').forEach(c => {
        const [k, ...v] = c.trim().split('=');
        if (k) out[k] = v.join('=');
    });
    return out;
}

// ---------------------------------------------------------------------------
//  Audit Log
// ---------------------------------------------------------------------------

function loadAudit() {
    try {
        if (fs.existsSync(AUDIT_FILE)) return JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf-8'));
    } catch (e) {}
    return [];
}

function logAudit(event, details) {
    const log = loadAudit();
    log.unshift({
        event,
        time: Date.now(),
        ...details
    });
    // Keep last 200 entries
    if (log.length > 200) log.length = 200;
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(log, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
//  User Storage
// ---------------------------------------------------------------------------

function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
    } catch (e) {}
    return [];
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
//  Invite Storage
// ---------------------------------------------------------------------------

function loadInvites() {
    try {
        if (fs.existsSync(INVITES_FILE)) return JSON.parse(fs.readFileSync(INVITES_FILE, 'utf-8'));
    } catch (e) {}
    return [];
}

function saveInvites(list) {
    fs.writeFileSync(INVITES_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

function validateInviteToken(token) {
    if (!token) return null;
    const invites = loadInvites();
    const invite = invites.find(i => i.token === token && i.status === 'pending');
    if (!invite) return null;
    if (Date.now() > invite.expiresAt) {
        invite.status = 'expired';
        saveInvites(invites);
        return null;
    }
    return invite;
}

function consumeInvite(token, username) {
    const invites = loadInvites();
    const invite = invites.find(i => i.token === token);
    if (invite) {
        invite.status = 'used';
        invite.usedAt = Date.now();
        invite.usedBy = username;
        saveInvites(invites);
        logAudit('invite_used', { email: invite.email, username });
    }
}

function isInviteAuthorized(req) {
    const token = req.headers['x-invite-token'];
    return validateInviteToken(token) !== null;
}

// Pending registration: stores user profile until passkey is created
let pendingRegistration = null;

// ---------------------------------------------------------------------------
//  RP Config (dynamic based on request)
// ---------------------------------------------------------------------------

function getRpConfig(req) {
    const host = req.headers.host || 'localhost';
    const fwdHost = req.headers['x-forwarded-host'] || '';
    const referer = req.headers.referer || '';
    const fwdProto = req.headers['x-forwarded-proto'] || '';
    const cfHost = req.headers['x-original-host'] || req.headers['cf-host'] || '';
    console.log(`[AUTH RP] host=${host} fwdHost=${fwdHost} cfHost=${cfHost} referer=${referer}`);
    // Check all possible indicators for taybouts.com (Cloudflare Tunnel may change Host header)
    // Tailscale MagicDNS
    if (host.includes('tse.mesh') || fwdHost.includes('tse.mesh')) {
        const tsHost = host.split(':')[0];
        console.log(`[AUTH RP] Tailscale detected, using rpID=tse.mesh origin=https://${host}`);
        return {
            rpID: 'tse.mesh',
            rpName: 'T-Term',
            origin: `https://${host}`,
        };
    }
    if (host.includes('taybouts.com') || fwdHost.includes('taybouts.com') || referer.includes('taybouts.com') || cfHost.includes('taybouts.com') || req.headers['cf-connecting-ip']) {
        // Detect actual subdomain from headers for correct origin
        const actualHost = [host, fwdHost, cfHost].find(h => h.includes('taybouts.com')) || 'term.taybouts.com';
        const cleanHost = actualHost.split(':')[0];
        console.log(`[AUTH RP] Detected taybouts.com, using origin=https://${cleanHost}`);
        return {
            rpID: 'taybouts.com',
            rpName: 'T-Term',
            origin: `https://${cleanHost}`,
        };
    }
    const port = host.split(':')[1] || '7778';
    return {
        rpID: 'localhost',
        rpName: 'T-Term',
        origin: `https://localhost:${port}`,
    };
}

// ---------------------------------------------------------------------------
//  Session Management
// ---------------------------------------------------------------------------

function parseDeviceInfo(ua) {
    if (!ua) return { browser: 'Unknown', os: 'Unknown', device: '' };
    // Browser
    let browser = 'Unknown';
    if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/Chrome\//.test(ua)) browser = 'Chrome';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';
    else if (/Safari\//.test(ua)) browser = 'Safari';
    else if (/Opera|OPR/.test(ua)) browser = 'Opera';
    // Browser version
    const verMatch = ua.match(/(Edg|Chrome|Firefox|Safari|OPR)\/(\d+)/);
    if (verMatch) browser += ' ' + verMatch[2];
    // OS
    let os = 'Unknown';
    if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Mac OS X/.test(ua)) { const m = ua.match(/Mac OS X (\d+[._]\d+)/); os = 'macOS' + (m ? ' ' + m[1].replace(/_/g,'.') : ''); }
    else if (/Android/.test(ua)) { const m = ua.match(/Android (\d+)/); os = 'Android' + (m ? ' ' + m[1] : ''); }
    else if (/iPhone/.test(ua)) { const m = ua.match(/iPhone OS (\d+_\d+)/); os = 'iOS' + (m ? ' ' + m[1].replace(/_/g,'.') : ''); }
    else if (/iPad/.test(ua)) { const m = ua.match(/CPU OS (\d+_\d+)/); os = 'iPadOS' + (m ? ' ' + m[1].replace(/_/g,'.') : ''); }
    else if (/Linux/.test(ua)) os = 'Linux';
    // Device
    let device = '';
    if (/iPhone/.test(ua)) device = 'iPhone';
    else if (/iPad/.test(ua)) device = 'iPad';
    else if (/Android/.test(ua)) { const m = ua.match(/;\s*([^;)]+)\s*Build/); device = m ? m[1].trim() : 'Android Device'; }
    return { browser, os, device };
}

// Map known IPs to machine names
const knownMachines = {
    '100.64.0.2': 'TayCast',
    '100.64.0.1': 'Broadcast-1',
    '100.64.0.4': 'OneO7',
    '100.64.0.41': 'PodM-1',
    '100.64.0.42': 'PodM-2',
    '::1': 'Localhost',
    '127.0.0.1': 'Localhost',
    '::ffff:127.0.0.1': 'Localhost',
};

function resolveMachineName(ip) {
    if (!ip) return '';
    // Check direct match
    if (knownMachines[ip]) return knownMachines[ip];
    // Check forwarded IPs (may have multiple comma-separated)
    const first = ip.split(',')[0].trim();
    if (knownMachines[first]) return knownMachines[first];
    // Check if it's a local IP
    if (first.startsWith('192.168.')) return 'Local Network';
    return '';
}

function createSession(req) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const ua = req ? (req.headers['user-agent'] || '') : '';
    const info = parseDeviceInfo(ua);
    const ip = req ? (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').split(',')[0].trim() : '';
    const machineName = resolveMachineName(ip);
    activeSessions.set(sessionId, {
        created: now,
        expires: now + SESSION_MAX_AGE * 1000,
        ip,
        userAgent: ua,
        browser: info.browser,
        os: info.os,
        device: info.device,
        machine: machineName,
        host: req ? (req.headers.host || '') : '',
        via: req ? (req.headers['cf-connecting-ip'] ? 'Cloudflare' : req.headers.host?.includes('tse.mesh') ? 'Tailscale' : 'Direct') : '',
    });
    saveSessionsToFile();
    return sessionId;
}

function isValidSession(sessionId) {
    if (!sessionId || !activeSessions.has(sessionId)) return false;
    const session = activeSessions.get(sessionId);
    if (Date.now() > session.expires) {
        activeSessions.delete(sessionId);
        saveSessionsToFile();
        return false;
    }
    return true;
}

function getSessionFromCookie(req) {
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    return match ? match[1] : null;
}

function setSessionCookie(res, sessionId, req) {
    const rpConfig = getRpConfig(req || {headers:{}});
    const domain = rpConfig.rpID === 'taybouts.com' ? '; Domain=.taybouts.com' : '';
    const sameSite = rpConfig.rpID === 'taybouts.com' ? 'None' : 'Strict';
    const cookie = `${COOKIE_NAME}=${sessionId}; HttpOnly; Secure; SameSite=${sameSite}; Path=/; Max-Age=${SESSION_MAX_AGE}${domain}`;
    const existing = res.getHeader('Set-Cookie') || [];
    const cookies = Array.isArray(existing) ? existing : (existing ? [existing] : []);
    cookies.push(cookie);
    res.setHeader('Set-Cookie', cookies);
}

function clearSessionCookie(res) {
    const cookie = `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0; Domain=.taybouts.com`;
    res.setHeader('Set-Cookie', cookie);
}

// Clean up expired tokens and sessions every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of pendingSessions) {
        if (now - data.created > TOKEN_MAX_AGE) {
            pendingSessions.delete(token);
        }
    }
    let sessionsChanged = false;
    for (const [sessionId, data] of activeSessions) {
        if (now > data.expires) {
            activeSessions.delete(sessionId);
            sessionsChanged = true;
        }
    }
    if (sessionsChanged) saveSessionsToFile();
    for (const [token, data] of pendingChallenges) {
        if (now - data.created > TOKEN_MAX_AGE) {
            pendingChallenges.delete(token);
        }
    }
}, 10 * 60 * 1000);

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

function isAuthenticated(req) {
    if (!simplewebauthn) return false;
    if (isLocalRequest(req)) return true;
    if (!hasPasskeys()) return false;
    const sessionId = getSessionFromCookie(req);
    return isValidSession(sessionId);
}

function checkWebSocketAuth(req) {
    return isAuthenticated(req);
}

async function handleAuthRoute(req, res, pathname) {
    if (!simplewebauthn) return false;

    const url = new URL(req.url, 'https://localhost');

    // Login page (desktop) — shows QR code
    if (req.method === 'GET' && pathname === '/login') {
        return await serveLoginPage(req, res);
    }

    // Approval page (phone) — shows Face ID button
    if (req.method === 'GET' && pathname === '/approve') {
        return serveApprovePage(req, res, url);
    }

    // Phone requests WebAuthn challenge for approval
    if (req.method === 'POST' && pathname === '/auth/approve-options') {
        return await handleApproveOptions(req, res, url);
    }

    // Phone posts approval after Face ID
    if (req.method === 'POST' && pathname === '/do-approve') {
        return await handleDoApprove(req, res, url);
    }

    // Desktop polls for approval
    if (req.method === 'GET' && pathname === '/check') {
        return handleCheck(req, res, url);
    }

    // Direct passkey sign-in (no QR needed)
    if (req.method === 'POST' && pathname === '/auth/passkey-options') {
        return await handlePasskeyOptions(req, res);
    }
    if (req.method === 'POST' && pathname === '/auth/passkey-verify') {
        return await handlePasskeyVerify(req, res);
    }

    // Invite — one-time link for new user registration
    if (req.method === 'GET' && pathname === '/invite') {
        const token = url.searchParams.get('token');
        if (!token) { res.writeHead(400); res.end('Missing token'); return true; }
        const invite = validateInviteToken(token);
        if (!invite) {
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
            res.end(expiredInviteHTML());
            return true;
        }
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(inviteRegisterHTML(invite));
        return true;
    }

    // Registration — only allowed from localhost, authenticated admin, or valid invite
    function canRegister(req) {
        return isLocalRequest(req) || isAuthenticated(req) || isInviteAuthorized(req);
    }

    if (req.method === 'GET' && pathname === '/register') {
        if (!canRegister(req)) {
            res.writeHead(302, { Location: '/login' });
            res.end();
            return true;
        }
        return serveRegisterPage(req, res);
    }
    // Registration — Step 1: Save profile, move to passkey
    if (req.method === 'POST' && pathname === '/register/profile') {
        if (!canRegister(req)) {
            sendJson(res, { error: 'Registration closed' }, 403);
            return true;
        }
        const body = await readBody(req);
        const { username, displayName, email } = JSON.parse(body.toString('utf-8'));
        if (!username || username.trim().length < 2) {
            sendJson(res, { error: 'Username is required (min 2 characters)' }, 400);
            return true;
        }
        // Check if username already taken
        const users = loadUsers();
        if (users.find(u => u.username.toLowerCase() === username.trim().toLowerCase())) {
            sendJson(res, { error: 'Username already taken' }, 409);
            return true;
        }
        pendingRegistration = {
            username: username.trim(),
            displayName: (displayName || '').trim(),
            email: (email || '').trim(),
            created: Date.now(),
            inviteToken: req.headers['x-invite-token'] || null,
        };
        logAudit('register_profile', { username: pendingRegistration.username, ip: req.socket.remoteAddress });
        sendJson(res, { ok: true });
        return true;
    }
    // Registration — Step 2: WebAuthn start
    if (req.method === 'POST' && pathname === '/register/start') {
        if (!canRegister(req)) {
            sendJson(res, { error: 'Registration closed' }, 403);
            return true;
        }
        return await handleRegisterStart(req, res);
    }
    // Registration — Step 2: WebAuthn finish
    if (req.method === 'POST' && pathname === '/register/finish') {
        if (!canRegister(req)) {
            sendJson(res, { error: 'Registration closed' }, 403);
            return true;
        }
        return await handleRegisterFinish(req, res);
    }

    // Logout
    if (req.method === 'GET' && pathname === '/auth/logout') {
        return handleLogout(req, res);
    }

    // Status
    if (req.method === 'GET' && pathname === '/auth/status') {
        return handleStatus(req, res);
    }

    // Sessions management page
    if (req.method === 'GET' && pathname === '/auth/sessions') {
        return serveSessionsPage(req, res);
    }

    // Sessions API — list active sessions
    if (req.method === 'GET' && pathname === '/auth/sessions-list') {
        const currentSessionId = getSessionFromCookie(req);
        const list = [];
        for (const [sid, data] of activeSessions) {
            list.push({
                id: sid.slice(0, 8),
                fullId: sid,
                ip: data.ip,
                browser: data.browser || 'Unknown',
                os: data.os || 'Unknown',
                device: data.device || '',
                machine: data.machine || resolveMachineName(data.ip),
                via: data.via || 'Direct',
                host: data.host || '',
                screen: data.screen || '',
                cores: data.cores || 0,
                memory: data.memory || 0,
                gpu: data.gpu || '',
                platform: data.platform || '',
                timezone: data.timezone || '',
                created: data.created,
                expires: data.expires,
                isCurrent: sid === currentSessionId,
            });
        }
        list.sort((a, b) => b.created - a.created);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
        return true;
    }

    // Kill a session
    if (req.method === 'POST' && pathname === '/auth/kill-session') {
        const body = await readBody(req);
        const { sessionId } = JSON.parse(body.toString('utf-8'));
        if (sessionId && activeSessions.has(sessionId)) {
            activeSessions.delete(sessionId);
            saveSessionsToFile();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
        }
        return true;
    }

    // Admin page
    if (req.method === 'GET' && pathname === '/admin') {
        if (!isAuthenticated(req)) { res.writeHead(302, { Location: '/login' }); res.end(); return true; }
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(adminPageHTML());
        return true;
    }

    // Admin API — audit log
    if (req.method === 'GET' && pathname === '/admin/audit') {
        if (!isAuthenticated(req)) { sendJson(res, { error: 'Unauthorized' }, 401); return true; }
        sendJson(res, loadAudit());
        return true;
    }

    // Admin API — registered devices (passkeys)
    if (req.method === 'GET' && pathname === '/admin/devices') {
        if (!isAuthenticated(req)) { sendJson(res, { error: 'Unauthorized' }, 401); return true; }
        const data = loadPasskeys();
        const users = loadUsers();
        const devices = (data.passkeys || []).map((pk, i) => {
            const user = users.find(u => u.credentialID === pk.credentialID || u.username === pk.username);
            return {
                index: i,
                id: pk.credentialID.slice(0, 12) + '...',
                username: pk.username || user?.username || '',
                displayName: user?.displayName || '',
                email: user?.email || '',
                role: user?.role || 'user',
                deviceType: pk.deviceType || 'unknown',
                backedUp: pk.backedUp || false,
                registeredAt: pk.registeredAt || 'unknown',
                counter: pk.counter,
                label: pk.label || '',
                browser: pk.browser || '',
                os: pk.os || '',
                device: pk.device || '',
                ip: pk.ip || '',
            };
        });
        sendJson(res, devices);
        return true;
    }

    // Admin API — label a device
    if (req.method === 'POST' && pathname === '/admin/label-device') {
        if (!isAuthenticated(req)) { sendJson(res, { error: 'Unauthorized' }, 401); return true; }
        const body = await readBody(req);
        const { index, label } = JSON.parse(body.toString('utf-8'));
        const data = loadPasskeys();
        if (data.passkeys && data.passkeys[index]) {
            data.passkeys[index].label = label;
            savePasskeys(data);
            sendJson(res, { ok: true });
        } else {
            sendJson(res, { error: 'Device not found' }, 404);
        }
        return true;
    }

    // Admin API — remove a device
    if (req.method === 'POST' && pathname === '/admin/remove-device') {
        if (!isAuthenticated(req)) { sendJson(res, { error: 'Unauthorized' }, 401); return true; }
        const body = await readBody(req);
        const { index } = JSON.parse(body.toString('utf-8'));
        const data = loadPasskeys();
        if (data.passkeys && data.passkeys[index]) {
            const removed = data.passkeys.splice(index, 1);
            savePasskeys(data);
            logAudit('device_removed', { deviceType: removed[0]?.deviceType });
            sendJson(res, { ok: true });
        } else {
            sendJson(res, { error: 'Device not found' }, 404);
        }
        return true;
    }

    // Admin API — users
    if (req.method === 'GET' && pathname === '/admin/users') {
        if (!isAuthenticated(req)) { sendJson(res, { error: 'Unauthorized' }, 401); return true; }
        sendJson(res, loadUsers());
        return true;
    }

    // Admin API — create invite
    if (req.method === 'POST' && pathname === '/admin/invite-create') {
        if (!isAuthenticated(req)) { sendJson(res, { error: 'Unauthorized' }, 401); return true; }
        const body = await readBody(req);
        const { email } = JSON.parse(body.toString('utf-8'));
        if (!email || !email.includes('@')) { sendJson(res, { error: 'Valid email required' }, 400); return true; }
        const token = crypto.randomBytes(32).toString('hex');
        const invites = loadInvites();
        const invite = {
            id: crypto.randomUUID(),
            email: email.trim().toLowerCase(),
            token,
            createdAt: Date.now(),
            expiresAt: Date.now() + INVITE_MAX_AGE,
            status: 'pending',
            usedAt: null,
            usedBy: null,
        };
        invites.push(invite);
        saveInvites(invites);
        logAudit('invite_created', { email: invite.email, ip: req.socket.remoteAddress });
        // Always use the public URL for invite links (they're sent to external people)
        const link = `https://term.taybouts.com/invite?token=${token}`;

        // Send invite email
        let emailSent = false;
        try {
            await sendInviteEmail(invite.email, link);
            emailSent = true;
            console.log(`[EMAIL] Invite sent to ${invite.email}`);
        } catch (e) {
            console.error(`[EMAIL] Failed to send invite to ${invite.email}:`, e.message);
        }

        sendJson(res, { ok: true, link, token, expiresAt: invite.expiresAt, emailSent });
        return true;
    }

    // Admin API — list invites
    if (req.method === 'GET' && pathname === '/admin/invites') {
        if (!isAuthenticated(req)) { sendJson(res, { error: 'Unauthorized' }, 401); return true; }
        const invites = loadInvites().map(i => ({ ...i, token: undefined })); // Don't expose tokens
        sendJson(res, invites);
        return true;
    }

    // Admin API — revoke invite
    if (req.method === 'POST' && pathname === '/admin/invite-revoke') {
        if (!isAuthenticated(req)) { sendJson(res, { error: 'Unauthorized' }, 401); return true; }
        const body = await readBody(req);
        const { id } = JSON.parse(body.toString('utf-8'));
        const invites = loadInvites();
        const invite = invites.find(i => i.id === id);
        if (invite && invite.status === 'pending') {
            invite.status = 'revoked';
            saveInvites(invites);
            logAudit('invite_revoked', { email: invite.email });
            sendJson(res, { ok: true });
        } else {
            sendJson(res, { error: 'Invite not found or already used' }, 404);
        }
        return true;
    }

    return false;
}

// ---------------------------------------------------------------------------
//  Route Handlers
// ---------------------------------------------------------------------------

async function serveLoginPage(req, res) {
    // If no passkeys, redirect to registration
    if (!hasPasskeys()) {
        res.writeHead(302, { Location: '/register' });
        res.end();
        return true;
    }

    // Already authenticated
    if (isAuthenticated(req)) {
        res.writeHead(302, { Location: '/' });
        res.end();
        return true;
    }

    // Generate QR token
    const token = crypto.randomUUID();
    pendingSessions.set(token, { approved: false, created: Date.now(), sessionId: null });

    // Build QR URL — Tailscale MagicDNS for local, term.taybouts.com for external
    const rpConfig = getRpConfig(req);
    const approveHost = rpConfig.rpID === 'taybouts.com' ? 'term.taybouts.com' : 'term.taybouts.com';
    const approveUrl = `https://${approveHost}/approve?token=${token}`;

    let qrDataUrl;
    try {
        qrDataUrl = await QRCode.toDataURL(approveUrl, {
            width: 220, margin: 1,
            color: { dark: '#0d1117', light: '#ffffff' },
        });
    } catch (e) {
        console.error('[AUTH] QR generation failed:', e);
        res.writeHead(500);
        res.end('QR generation failed');
        return true;
    }

    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(loginPageHTML(token, qrDataUrl));
    return true;
}

function isLocalRequest(req) {
    const ip = req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isTailscaleRequest(req) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const host = req.headers.host || '';
    return ip.startsWith('100.64.') || ip.startsWith('100.100.') || host.includes('tse.mesh');
}

function serveApprovePage(req, res, url) {
    const token = url.searchParams.get('token');
    if (!token || !pendingSessions.has(token)) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>Invalid or expired link</h1>');
        return true;
    }

    const pending = pendingSessions.get(token);
    if (Date.now() - pending.created > TOKEN_MAX_AGE) {
        pendingSessions.delete(token);
        res.writeHead(410, { 'Content-Type': 'text/html' });
        res.end('<h1>Link expired</h1>');
        return true;
    }



    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(approvePageHTML(token));
    return true;
}

async function handleApproveOptions(req, res, url) {
    const token = url.searchParams.get('token');
    if (!token || !pendingSessions.has(token)) {
        sendJson(res, { error: 'Invalid or expired token' }, 404);
        return true;
    }

    const { rpID } = getRpConfig(req);
    const data = loadPasskeys();
    const allowCredentials = (data.passkeys || []).map(pk => ({
        id: pk.credentialID,
        type: 'public-key',
        transports: pk.transports || [],
    }));

    try {
        const options = await simplewebauthn.generateAuthenticationOptions({
            rpID,
            allowCredentials,
            userVerification: 'required',
        });

        // Store challenge keyed by token
        pendingChallenges.set(token, { challenge: options.challenge, created: Date.now() });
        sendJson(res, options);
    } catch (e) {
        console.error('[AUTH] Approve options error:', e);
        sendJson(res, { error: e.message }, 500);
    }
    return true;
}

async function handleDoApprove(req, res, url) {
    const token = url.searchParams.get('token');
    if (!token || !pendingSessions.has(token)) {
        sendJson(res, { error: 'Invalid or expired token' }, 404);
        return true;
    }

    const body = await readBody(req);
    let payload;
    try {
        payload = JSON.parse(body);
    } catch (e) {
        sendJson(res, { error: 'Invalid JSON' }, 400);
        return true;
    }

    // Verify WebAuthn response
    const { rpID, origin } = getRpConfig(req);
    const data = loadPasskeys();
    const challengeEntry = pendingChallenges.get(token);

    if (!challengeEntry) {
        sendJson(res, { error: 'No challenge found — reload the page' }, 400);
        return true;
    }

    // Check backup code path
    if (payload.backupCode) {
        const hash = crypto.createHash('sha256').update(payload.backupCode.toUpperCase().trim()).digest('hex');
        const entry = (data.backupCodes || []).find(bc => bc.code === hash && !bc.used);
        if (!entry) {
            sendJson(res, { error: 'Invalid or used backup code' }, 401);
            return true;
        }
        entry.used = true;
        savePasskeys(data);
        pendingChallenges.delete(token);

        // Mark session approved
        const pending = pendingSessions.get(token);
        const sessionId = createSession(req);
        pending.approved = true;
        pending.sessionId = sessionId;
        logAudit('login_backup', { ip: req.socket.remoteAddress });
        sendJson(res, { ok: true });
        return true;
    }

    // WebAuthn verification
    const passkey = (data.passkeys || []).find(pk => pk.credentialID === payload.id);
    if (!passkey) {
        sendJson(res, { error: 'Passkey not found' }, 400);
        return true;
    }

    try {
        const verification = await simplewebauthn.verifyAuthenticationResponse({
            response: payload,
            expectedChallenge: challengeEntry.challenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            credential: {
                id: passkey.credentialID,
                publicKey: Buffer.from(passkey.credentialPublicKey, 'base64'),
                counter: passkey.counter,
                transports: passkey.transports || [],
            },
        });

        if (!verification.verified) {
            sendJson(res, { error: 'Face ID verification failed' }, 401);
            return true;
        }

        // Update counter
        passkey.counter = verification.authenticationInfo.newCounter;
        savePasskeys(data);
        pendingChallenges.delete(token);

        // Mark session approved
        const pending = pendingSessions.get(token);
        const sessionId = createSession(req);
        pending.approved = true;
        pending.sessionId = sessionId;
        logAudit('login_passkey', { ip: req.socket.remoteAddress });

        sendJson(res, { ok: true });
    } catch (e) {
        console.error('[AUTH] WebAuthn verify error:', e);
        logAudit('login_failed', { ip: req.socket.remoteAddress, error: e.message });
        sendJson(res, { error: e.message }, 500);
    }
    return true;
}

function handleCheck(req, res, url) {
    const token = url.searchParams.get('token');
    const pending = pendingSessions.get(token);

    if (!pending) {
        sendJson(res, { approved: false });
        return true;
    }

    if (pending.approved && pending.sessionId) {
        // Update session with DESKTOP info (not phone that approved)
        const ua = req.headers['user-agent'] || '';
        const info = parseDeviceInfo(ua);
        const ip = (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').split(',')[0].trim();
        // Parse client-side device fingerprint
        let clientInfo = {};
        try { clientInfo = JSON.parse(url.searchParams.get('info') || '{}'); } catch(e) {}
        const session = activeSessions.get(pending.sessionId);
        if (session) {
            session.ip = ip;
            session.userAgent = ua;
            session.browser = info.browser;
            session.os = info.os;
            session.device = info.device;
            session.machine = resolveMachineName(ip);
            session.host = req.headers.host || '';
            session.via = req.headers['cf-connecting-ip'] ? 'Cloudflare' : req.headers.host?.includes('tse.mesh') ? 'Tailscale' : 'Direct';
            // Client-side fingerprint
            session.screen = clientInfo.screen || '';
            session.cores = clientInfo.cores || 0;
            session.memory = clientInfo.memory || 0;
            session.gpu = clientInfo.gpu || '';
            session.platform = clientInfo.platform || '';
            session.timezone = clientInfo.timezone || '';
            session.language = clientInfo.language || '';
            session.touch = clientInfo.touch || false;
        }
        // Set session cookie on the desktop browser that's polling
        setSessionCookie(res, pending.sessionId, req);
        sendJson(res, { approved: true });
        // Clean up — token is consumed
        pendingSessions.delete(token);
    } else {
        sendJson(res, { approved: false });
    }
    return true;
}

// ---------------------------------------------------------------------------
//  Direct Passkey Sign-in (device authenticates itself)
// ---------------------------------------------------------------------------

async function handlePasskeyOptions(req, res) {
    const data = loadPasskeys();
    if (!data.passkeys || data.passkeys.length === 0) {
        sendJson(res, { error: 'No passkeys registered' }, 400);
        return true;
    }

    const { rpID, origin } = getRpConfig(req);

    try {
        const options = await simplewebauthn.generateAuthenticationOptions({
            rpID,
            allowCredentials: data.passkeys.map(pk => ({
                id: pk.credentialID,
                type: 'public-key',
                transports: pk.transports || [],
            })),
            userVerification: 'required',
        });

        // Store challenge for verification
        pendingChallenges.set('direct_auth', { challenge: options.challenge, created: Date.now() });
        sendJson(res, options);
    } catch (e) {
        console.error('[AUTH] Passkey options error:', e);
        sendJson(res, { error: e.message }, 500);
    }
    return true;
}

async function handlePasskeyVerify(req, res) {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf-8'));
    const data = loadPasskeys();

    const challengeEntry = pendingChallenges.get('direct_auth');
    if (!challengeEntry) {
        sendJson(res, { error: 'No pending challenge' }, 400);
        return true;
    }

    const { rpID, origin } = getRpConfig(req);
    const passkey = (data.passkeys || []).find(pk => pk.credentialID === payload.id);
    if (!passkey) {
        sendJson(res, { error: 'Passkey not found' }, 400);
        return true;
    }

    try {
        const verification = await simplewebauthn.verifyAuthenticationResponse({
            response: payload,
            expectedChallenge: challengeEntry.challenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            credential: {
                id: passkey.credentialID,
                publicKey: Buffer.from(passkey.credentialPublicKey, 'base64'),
                counter: passkey.counter,
                transports: passkey.transports || [],
            },
        });

        if (!verification.verified) {
            sendJson(res, { error: 'Verification failed' }, 401);
            return true;
        }

        passkey.counter = verification.authenticationInfo.newCounter;
        savePasskeys(data);
        pendingChallenges.delete('direct_auth');

        const sessionId = createSession(req);
        setSessionCookie(res, sessionId, req);
        logAudit('login_passkey_direct', { ip: req.socket.remoteAddress });

        sendJson(res, { ok: true });
    } catch (e) {
        console.error('[AUTH] Passkey verify error:', e);
        logAudit('login_failed', { ip: req.socket.remoteAddress, error: e.message });
        sendJson(res, { error: e.message }, 500);
    }
    return true;
}

function serveRegisterPage(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(REGISTER_HTML);
    return true;
}

async function handleRegisterStart(req, res) {
    if (!pendingRegistration) {
        sendJson(res, { error: 'Complete the profile form first' }, 400);
        return true;
    }

    const rpConfig = getRpConfig(req);
    const { rpID, rpName } = rpConfig;
    console.log(`[AUTH REGISTER] rpID=${rpID} origin=${rpConfig.origin} user=${pendingRegistration.username}`);
    const data = loadPasskeys();
    const existingCreds = (data.passkeys || []).map(pk => ({
        id: pk.credentialID,
        type: 'public-key',
        transports: pk.transports || [],
    }));

    try {
        const options = await simplewebauthn.generateRegistrationOptions({
            rpName,
            rpID,
            userName: pendingRegistration.username,
            userDisplayName: pendingRegistration.displayName || pendingRegistration.username,
            attestationType: 'none',
            excludeCredentials: existingCreds,
            authenticatorSelection: {
                residentKey: 'required',
                userVerification: 'required',
            },
        });

        registrationChallenge = options.challenge;
        sendJson(res, options);
    } catch (e) {
        console.error('[AUTH] Register start error:', e);
        sendJson(res, { error: e.message }, 500);
    }
    return true;
}

async function handleRegisterFinish(req, res) {

    const body = await readBody(req);
    let credential;
    try {
        credential = JSON.parse(body);
    } catch (e) {
        sendJson(res, { error: 'Invalid JSON' }, 400);
        return true;
    }

    const { rpID, origin } = getRpConfig(req);

    try {
        const verification = await simplewebauthn.verifyRegistrationResponse({
            response: credential,
            expectedChallenge: registrationChallenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
        });

        if (!verification.verified || !verification.registrationInfo) {
            sendJson(res, { error: 'Verification failed' }, 400);
            return true;
        }

        const { credential: cred, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

        const data = loadPasskeys();
        data.passkeys = data.passkeys || [];
        const ua = req.headers['user-agent'] || '';
        const devInfo = parseDeviceInfo(ua);
        const ip = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

        data.passkeys.push({
            credentialID: cred.id,
            credentialPublicKey: Buffer.from(cred.publicKey).toString('base64'),
            counter: cred.counter,
            transports: credential.response.transports || [],
            deviceType: credentialDeviceType,
            backedUp: credentialBackedUp,
            registeredAt: new Date().toISOString(),
            browser: devInfo.browser,
            os: devInfo.os,
            device: devInfo.device,
            ip: ip,
            userAgent: ua,
        });

        // Generate backup codes (XXXX-XXXX format)
        const backupCodes = [];
        for (let i = 0; i < 8; i++) {
            const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
            const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
            backupCodes.push(`${part1}-${part2}`);
        }
        data.backupCodes = backupCodes.map(code => ({
            code: crypto.createHash('sha256').update(code).digest('hex'),
            used: false,
        }));
        data.registeredAt = new Date().toISOString();

        // Link passkey to user profile
        if (pendingRegistration) {
            data.passkeys[data.passkeys.length - 1].username = pendingRegistration.username;
            // Save user profile
            const users = loadUsers();
            users.push({
                username: pendingRegistration.username,
                displayName: pendingRegistration.displayName || '',
                email: pendingRegistration.email || '',
                role: users.length === 0 ? 'admin' : 'user',
                credentialID: cred.id,
                registeredAt: new Date().toISOString(),
                ip: req.socket.remoteAddress,
            });
            saveUsers(users);
        }

        savePasskeys(data);
        registrationChallenge = null;

        // Create session immediately after registration
        const sessionId = createSession(req);
        setSessionCookie(res, sessionId, req);

        // Consume invite token if this was an invite registration
        const inviteToken = pendingRegistration?.inviteToken || req.headers['x-invite-token'];
        if (inviteToken) {
            consumeInvite(inviteToken, pendingRegistration?.username || 'unknown');
        }

        logAudit('register', {
            ip: req.socket.remoteAddress,
            username: pendingRegistration?.username,
            deviceType: credentialDeviceType,
            viaInvite: !!inviteToken,
        });
        pendingRegistration = null;
        sendJson(res, { verified: true, backupCodes });
    } catch (e) {
        console.error('[AUTH] Register finish error:', e);
        sendJson(res, { error: e.message }, 500);
    }
    return true;
}

function handleLogout(req, res) {
    const sessionId = getSessionFromCookie(req);
    if (sessionId) { activeSessions.delete(sessionId); saveSessionsToFile(); }
    clearSessionCookie(res);
    res.writeHead(302, { Location: '/login' });
    res.end();
    return true;
}

function handleStatus(req, res) {
    sendJson(res, {
        authenticated: isAuthenticated(req),
        hasPasskeys: hasPasskeys(),
    });
    return true;
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function sendJson(res, data, status = 200) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
//  Sessions Management Page
// ---------------------------------------------------------------------------

function serveSessionsPage(req, res) {
    if (!isAuthenticated(req)) {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(sessionsPageHTML());
    return true;
}







// ---------------------------------------------------------------------------
//  Identity helper — identify who is making a request
// ---------------------------------------------------------------------------

function getRequestIdentity(req) {
    const ip = (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ua = req.headers['user-agent'] || '';
    const info = parseDeviceInfo(ua);
    const machine = resolveMachineName(ip);

    // Try to find username from session
    let username = null;
    const sessionId = getSessionFromCookie(req);
    if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId);
        // Find user by matching session IP + device
        const users = loadUsers();
        const passkeys = loadPasskeys().passkeys || [];
        // Match by session info
        for (const u of users) {
            const pk = passkeys.find(p => p.credentialID === u.credentialID);
            if (pk && pk.device === info.device) { username = u.username; break; }
        }
        if (!username && users.length > 0) username = session.machine || users[0].username;
    }

    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const label = username || machine || (isLocal ? 'localhost' : ip);
    const device = info.device || info.os || 'Unknown';

    return { label, device, ip, browser: info.browser, os: info.os, username, machine, isLocal };
}

// ---------------------------------------------------------------------------
//  Exports
// ---------------------------------------------------------------------------

module.exports = { isAuthenticated, handleAuthRoute, checkWebSocketAuth, getRequestIdentity, logAudit };
