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
const QRCode = require('qrcode');

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
    if (isWhitelisted(req)) return true;
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

    // Admin API — whitelist
    if (req.method === 'GET' && pathname === '/admin/whitelist') {
        if (!isAuthenticated(req)) { sendJson(res, { error: 'Unauthorized' }, 401); return true; }
        sendJson(res, loadWhitelist());
        return true;
    }

    // Admin API — whitelist this device
    if (req.method === 'POST' && pathname === '/admin/whitelist-add') {
        if (!isAuthenticated(req)) { sendJson(res, { error: 'Unauthorized' }, 401); return true; }
        const body = await readBody(req);
        const { label } = JSON.parse(body.toString('utf-8'));
        const token = crypto.randomBytes(32).toString('hex');
        const list = loadWhitelist();
        list.push({
            token,
            label: label || 'Unnamed device',
            ip: req.socket.remoteAddress,
            created: Date.now(),
        });
        saveWhitelist(list);
        logAudit('whitelist_add', { label, ip: req.socket.remoteAddress });
        // Set persistent cookie (1 year) — works across subdomains
        const host = req.headers.host || '';
        const domainPart = host.includes('taybouts.com') ? '; Domain=.taybouts.com' : '';
        const cookieOpts = `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000${domainPart}`;
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `${WHITELIST_COOKIE}=${token}; ${cookieOpts}`
        });
        res.end(JSON.stringify({ ok: true }));
        return true;
    }

    // Admin API — remove from whitelist
    if (req.method === 'POST' && pathname === '/admin/whitelist-remove') {
        if (!isAuthenticated(req)) { sendJson(res, { error: 'Unauthorized' }, 401); return true; }
        const body = await readBody(req);
        const { index } = JSON.parse(body.toString('utf-8'));
        const list = loadWhitelist();
        if (list[index]) {
            const removed = list.splice(index, 1);
            saveWhitelist(list);
            logAudit('whitelist_remove', { label: removed[0]?.label });
            sendJson(res, { ok: true });
        } else {
            sendJson(res, { error: 'Not found' }, 404);
        }
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
        const rpConfig = getRpConfig(req);
        const host = rpConfig.rpID === 'taybouts.com' ? 'term.taybouts.com' : req.headers.host;
        const link = `https://${host}/invite?token=${token}`;
        sendJson(res, { ok: true, link, token, expiresAt: invite.expiresAt });
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
//  Login Page HTML (Desktop — QR code embedded)
// ---------------------------------------------------------------------------

function loginPageHTML(token, qrDataUrl) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>T-TERM — Sign In</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body {
    min-height: 100vh;
    background: linear-gradient(135deg, #0a0a0f 0%, #0d1117 30%, #0a0f1a 60%, #0a0a0f 100%);
    font-family: 'Segoe UI', Arial, sans-serif;
    color: #e6edf3;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    position: relative; overflow: hidden;
}
body::before {
    content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    background-image:
        linear-gradient(rgba(56, 189, 248, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(56, 189, 248, 0.03) 1px, transparent 1px);
    background-size: 60px 60px; z-index: 0;
}
body::after {
    content: ''; position: fixed; width: 100%; height: 2px; left: 0;
    background: linear-gradient(90deg, transparent, rgba(56,189,248,0.06), transparent);
    animation: scan 8s linear infinite; z-index: 0; pointer-events: none;
}
@keyframes scan { from { top: -2px; } to { top: 100%; } }
.container {
    position: relative; z-index: 1; text-align: center;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 24px; padding: 48px 44px; backdrop-filter: blur(20px);
    max-width: 420px; width: 90%;
    animation: containerIn 0.8s ease;
}
@keyframes containerIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
.logo {
    font-family: 'Rajdhani', sans-serif; font-size: 48px; font-weight: 700;
    letter-spacing: 12px; text-transform: uppercase;
    background: linear-gradient(135deg, #38bdf8 0%, #0284c7 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 4px;
    animation: titleIn 1s ease; animation-fill-mode: both;
}
@keyframes titleIn { from { opacity: 0; letter-spacing: 20px; } to { opacity: 1; letter-spacing: 12px; } }
.subtitle {
    font-family: 'Share Tech Mono', monospace; font-size: 11px;
    letter-spacing: 6px; color: #475569; margin-bottom: 40px; text-transform: uppercase;
    animation: fadeIn 1s ease 0.2s; animation-fill-mode: both;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.qr-container {
    background: white; border-radius: 16px; padding: 16px; display: inline-block;
    margin-bottom: 24px;
    box-shadow: 0 0 40px rgba(56, 189, 248, 0.1);
    animation: pulse 3s ease-in-out infinite, fadeIn 0.8s ease 0.4s both;
}
.qr-container img { display: block; border-radius: 8px; width: 220px; height: 220px; }
.scan-text {
    font-family: 'Segoe UI', sans-serif; font-size: 14px; color: #94a3b8; margin-bottom: 6px;
    animation: fadeIn 1s ease 0.5s both;
}
.scan-hint {
    font-family: 'Share Tech Mono', monospace; font-size: 10px; color: #475569;
    letter-spacing: 1px;
    animation: fadeIn 1s ease 0.6s both;
}
.status {
    margin-top: 24px; padding: 12px 20px; border-radius: 8px;
    font-family: 'Share Tech Mono', monospace; font-size: 12px; letter-spacing: 1px;
    animation: fadeIn 1s ease 0.7s both;
}
.waiting { background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.2); color: #38bdf8; }
.approved { background: rgba(34, 197, 94, 0.08); border: 1px solid rgba(34, 197, 94, 0.2); color: #22c55e; }
@keyframes pulse {
    0%, 100% { box-shadow: 0 0 20px rgba(56, 189, 248, 0.1); }
    50% { box-shadow: 0 0 50px rgba(56, 189, 248, 0.2); }
}
.orb { position: absolute; border-radius: 50%; filter: blur(100px); opacity: 0.08; z-index: 0; }
.orb1 { width: 400px; height: 400px; background: #38bdf8; top: -150px; left: -150px; }
.orb2 { width: 300px; height: 300px; background: #0284c7; bottom: -100px; right: -100px; }
.orb3 { width: 200px; height: 200px; background: #38bdf8; top: 50%; left: 60%; }
.hud { position: fixed; width: 28px; height: 28px; z-index: 2; pointer-events: none; opacity: 0.15; }
.hud::before, .hud::after { content: ''; position: absolute; background: #38bdf8; }
.hud-tl { top: 10px; left: 10px; } .hud-tl::before { width: 18px; height: 1px; } .hud-tl::after { width: 1px; height: 18px; }
.hud-tr { top: 10px; right: 10px; } .hud-tr::before { width: 18px; height: 1px; right: 0; } .hud-tr::after { width: 1px; height: 18px; right: 0; }
.hud-bl { bottom: 10px; left: 10px; } .hud-bl::before { width: 18px; height: 1px; bottom: 0; } .hud-bl::after { width: 1px; height: 18px; bottom: 0; }
.hud-br { bottom: 10px; right: 10px; } .hud-br::before { width: 18px; height: 1px; right: 0; bottom: 0; } .hud-br::after { width: 1px; height: 18px; right: 0; bottom: 0; }
.divider { border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 24px 0; }
.btn-passkey {
    display: block; width: 100%; padding: 14px; border-radius: 10px; border: none;
    background: linear-gradient(135deg, #0284c7, #38bdf8);
    color: white; font-family: 'Rajdhani', sans-serif; font-size: 16px;
    font-weight: 700; cursor: pointer; letter-spacing: 2px; text-transform: uppercase;
    transition: all 0.3s; margin-bottom: 16px;
}
.btn-passkey:hover { box-shadow: 0 4px 20px rgba(2,132,199,0.3); }
.btn-passkey:active { transform: scale(0.97); }
.btn-passkey:disabled { opacity: 0.5; cursor: not-allowed; }
.backup-link {
    font-family: 'Share Tech Mono', monospace; font-size: 10px; letter-spacing: 1px;
    color: #475569; cursor: pointer; text-decoration: none; text-transform: uppercase;
    transition: color 0.2s;
}
.backup-link:hover { color: #38bdf8; }
#backup-section { display: none; margin-top: 16px; }
.backup-input {
    width: 100%; padding: 12px; background: rgba(255,255,255,0.04);
    color: #e6edf3; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
    font-family: 'Share Tech Mono', monospace; font-size: 16px; text-align: center;
    letter-spacing: 4px; text-transform: uppercase; margin-bottom: 12px;
}
.backup-input:focus { outline: none; border-color: rgba(56, 189, 248, 0.4); }
.btn-backup {
    display: inline-block; padding: 10px 32px; border-radius: 8px; border: none;
    background: linear-gradient(135deg, #0284c7, #38bdf8);
    color: white; font-family: 'Share Tech Mono', monospace; font-size: 11px;
    font-weight: 600; cursor: pointer; letter-spacing: 2px; text-transform: uppercase;
    transition: all 0.3s;
}
.btn-backup:hover { box-shadow: 0 4px 16px rgba(2, 132, 199, 0.3); }
.btn-backup:active { transform: scale(0.97); }
.error { color: #ef4444; margin-top: 12px; font-size: 12px; font-family: 'Share Tech Mono', monospace; display: none; }
</style>
</head>
<body>
<div class="hud hud-tl"></div><div class="hud hud-tr"></div>
<div class="hud hud-bl"></div><div class="hud hud-br"></div>
<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div class="orb orb3"></div>
<div class="container">
    <div class="logo">T-TERM</div>
    <div class="subtitle">Secure Access</div>
    <div id="qr-section">
        <div class="qr-container">
            <img src="${qrDataUrl}" alt="Scan to login">
        </div>
        <div class="scan-text">Scan with your phone to sign in</div>
        <div class="scan-hint">Point your camera at the QR code</div>
        <div class="status waiting" id="status">Waiting for approval...</div>
    </div>
    <hr class="divider">
    <button class="btn-passkey" onclick="signInWithPasskey()">Sign in with Passkey</button>
    <a class="backup-link" id="backup-toggle" onclick="toggleBackup()">Use backup code instead</a>
    <div id="backup-section">
        <input class="backup-input" id="backup-code" placeholder="XXXX-XXXX" maxlength="9">
        <button class="btn-backup" onclick="submitBackup()">Submit</button>
    </div>
    <div class="error" id="error"></div>
</div>
<script>
const TOKEN = '${token}';
let polling = true;

// Collect device fingerprint automatically
function getDeviceInfo() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    let gpu = '';
    if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    }
    return {
        screen: screen.width + 'x' + screen.height,
        pixelRatio: window.devicePixelRatio || 1,
        cores: navigator.hardwareConcurrency || 0,
        memory: navigator.deviceMemory || 0,
        gpu: gpu,
        platform: navigator.platform || '',
        language: navigator.language || '',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        touch: navigator.maxTouchPoints > 0,
        darkMode: window.matchMedia('(prefers-color-scheme: dark)').matches,
    };
}
const deviceInfo = getDeviceInfo();

const poll = setInterval(async () => {
    if (!polling) return;
    try {
        const resp = await fetch('/check?token=' + TOKEN + '&info=' + encodeURIComponent(JSON.stringify(deviceInfo)));
        const data = await resp.json();
        if (data.approved) {
            clearInterval(poll);
            const s = document.getElementById('status');
            s.textContent = 'Approved! Loading terminal...';
            s.className = 'status approved';
            setTimeout(() => { window.location.href = '/'; }, 800);
        }
    } catch(e) {}
}, 1500);

function toggleBackup() {
    const sec = document.getElementById('backup-section');
    sec.style.display = sec.style.display === 'none' ? 'block' : 'none';
    if (sec.style.display === 'block') document.getElementById('backup-code').focus();
}

function showError(msg) {
    const el = document.getElementById('error');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 5000);
}

async function submitBackup() {
    const code = document.getElementById('backup-code').value.trim();
    if (!code) { showError('Enter a backup code'); return; }
    try {
        const resp = await fetch('/do-approve?token=' + TOKEN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backupCode: code }),
        });
        const data = await resp.json();
        if (data.ok) {
            const s = document.getElementById('status');
            s.textContent = 'Approved! Loading terminal...';
            s.className = 'status approved';
            setTimeout(() => { window.location.href = '/'; }, 800);
        } else {
            showError(data.error || 'Invalid backup code');
        }
    } catch(e) {
        showError('Network error');
    }
}

document.getElementById('backup-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitBackup();
});

async function signInWithPasskey() {
    const btn = document.querySelector('.btn-passkey');
    btn.disabled = true;
    btn.textContent = 'Authenticating...';
    polling = false;

    try {
        const optResp = await fetch('/auth/passkey-options', { method: 'POST' });
        const options = await optResp.json();
        if (options.error) { showError(options.error); btn.disabled = false; btn.textContent = 'Sign in with Passkey'; polling = true; return; }

        const credential = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });

        const verResp = await fetch('/auth/passkey-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credential),
        });
        const result = await verResp.json();

        if (result.ok) {
            btn.textContent = 'Success!';
            btn.style.background = 'linear-gradient(135deg, #059669, #22c55e)';
            setTimeout(() => { window.location.href = '/'; }, 500);
        } else {
            showError(result.error || 'Authentication failed');
            btn.disabled = false;
            btn.textContent = 'Sign in with Passkey';
            polling = true;
        }
    } catch (e) {
        showError(e.message || 'Authentication cancelled');
        btn.disabled = false;
        btn.textContent = 'Sign in with Passkey';
        polling = true;
    }
}
</script>
<script src="https://unpkg.com/@simplewebauthn/browser/dist/bundle/index.umd.min.js"></script>
</body>
</html>`;
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

function sessionsPageHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>T-TERM — Sessions</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body {
    min-height: 100vh;
    background: linear-gradient(135deg, #0a0a0f 0%, #0d1117 30%, #0a0f1a 60%, #0a0a0f 100%);
    font-family: 'Segoe UI', Arial, sans-serif; color: #e6edf3;
    display: flex; flex-direction: column; align-items: center;
    padding: 40px 20px; position: relative;
}
body::before {
    content: ''; position: fixed; inset: 0;
    background-image: linear-gradient(rgba(56,189,248,0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(56,189,248,0.03) 1px, transparent 1px);
    background-size: 60px 60px; z-index: 0; pointer-events: none;
}
.container { position: relative; z-index: 1; max-width: 600px; width: 100%; }
.header {
    display: flex; align-items: center; gap: 16px; margin-bottom: 32px;
}
.logo {
    font-family: 'Rajdhani', sans-serif; font-size: 28px; font-weight: 700;
    letter-spacing: 6px; text-transform: uppercase;
    background: linear-gradient(135deg, #38bdf8, #0284c7);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
}
.subtitle {
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    letter-spacing: 3px; color: #475569; text-transform: uppercase;
}
.back-btn {
    margin-left: auto; font-family: 'Share Tech Mono', monospace; font-size: 10px;
    letter-spacing: 1px; color: #475569; text-decoration: none;
    border: 1px solid rgba(255,255,255,0.06); padding: 6px 14px;
    border-radius: 6px; background: rgba(255,255,255,0.03); cursor: pointer;
    transition: all 0.15s; text-transform: uppercase;
}
.back-btn:hover { border-color: rgba(56,189,248,0.3); color: #38bdf8; }
.session-card {
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 12px; padding: 16px 20px; margin-bottom: 8px;
    display: flex; align-items: center; gap: 14px;
    transition: all 0.15s; animation: cardIn 0.3s ease both;
}
@keyframes cardIn { from { opacity: 0; transform: translateY(8px); } }
.session-card.current { border-color: rgba(56,189,248,0.25); }
.session-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,0.5); }
.session-card.current .session-dot { background: #38bdf8; box-shadow: 0 0 6px rgba(56,189,248,0.5); }
.session-info { flex: 1; min-width: 0; }
.session-label {
    font-family: 'Share Tech Mono', monospace; font-size: 12px;
    color: #e6edf3; letter-spacing: 0.5px; margin-bottom: 3px;
}
.session-meta {
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    color: #475569; display: flex; gap: 10px; flex-wrap: wrap;
}
.session-tag {
    font-family: 'Share Tech Mono', monospace; font-size: 9px;
    padding: 2px 8px; border-radius: 4px; letter-spacing: 0.5px;
}
.tag-current { background: rgba(56,189,248,0.1); color: #38bdf8; border: 1px solid rgba(56,189,248,0.2); }
.tag-cloudflare { background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px solid rgba(245,158,11,0.2); }
.tag-tailscale { background: rgba(34,197,94,0.1); color: #22c55e; border: 1px solid rgba(34,197,94,0.2); }
.kill-btn {
    font-family: 'Share Tech Mono', monospace; font-size: 9px;
    padding: 4px 12px; border-radius: 4px; letter-spacing: 1px;
    border: 1px solid rgba(239,68,68,0.3); background: none;
    color: #ef4444; cursor: pointer; text-transform: uppercase;
    transition: all 0.15s; opacity: 0;
}
.session-card:hover .kill-btn { opacity: 1; }
.kill-btn:hover { background: rgba(239,68,68,0.1); border-color: #ef4444; }
.empty {
    text-align: center; padding: 40px;
    font-family: 'Share Tech Mono', monospace; font-size: 12px;
    color: #475569; letter-spacing: 1px;
}
.count {
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    color: #475569; letter-spacing: 1px; margin-bottom: 16px;
    text-transform: uppercase;
}
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <div>
            <div class="logo">T-TERM</div>
            <div class="subtitle">Active Sessions</div>
        </div>
        <a class="back-btn" href="/">Back to terminal</a>
    </div>
    <div class="count" id="count"></div>
    <div id="sessions"></div>
</div>
<script>
async function load() {
    const resp = await fetch('/auth/sessions-list');
    const sessions = await resp.json();
    const el = document.getElementById('sessions');
    document.getElementById('count').textContent = sessions.length + ' active session' + (sessions.length !== 1 ? 's' : '');
    if (sessions.length === 0) {
        el.innerHTML = '<div class="empty">No active sessions</div>';
        return;
    }
    el.innerHTML = sessions.map((s, i) => {
        const created = new Date(s.created).toLocaleString();
        const remaining = Math.max(0, Math.round((s.expires - Date.now()) / 60000));
        const hours = Math.floor(remaining / 60);
        const mins = remaining % 60;
        const timeLeft = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
        const deviceLabel = s.device ? s.device + ' · ' : '';
        const machineLabel = s.machine ? '<strong style="color:var(--accent2)">' + s.machine + '</strong> · ' : '';
        const viaTag = s.via !== 'Direct' ? ' <span class="session-tag tag-' + s.via.toLowerCase() + '">' + s.via.toUpperCase() + '</span>' : '';
        return '<div class="session-card' + (s.isCurrent ? ' current' : '') + '" style="animation-delay:' + (i * 0.05) + 's">' +
            '<div class="session-dot"></div>' +
            '<div class="session-info">' +
                '<div class="session-label">' + machineLabel + deviceLabel + s.browser + ' on ' + s.os + (s.isCurrent ? ' <span class="session-tag tag-current">THIS DEVICE</span>' : '') + viaTag + '</div>' +
                '<div class="session-meta"><span>' + s.ip + '</span><span>' + s.id + '</span><span>' + timeLeft + ' left</span><span>' + created + '</span></div>' +
                (s.screen || s.gpu ? '<div class="session-meta"><span>' + (s.screen ? s.screen : '') + '</span>' + (s.cores ? '<span>' + s.cores + ' cores</span>' : '') + (s.memory ? '<span>' + s.memory + 'GB RAM</span>' : '') + (s.gpu ? '<span>' + s.gpu.substring(0,40) + '</span>' : '') + (s.timezone ? '<span>' + s.timezone + '</span>' : '') + '</div>' : '') +
            '</div>' +
            (s.isCurrent ? '' : '<button class="kill-btn" onclick="killSession(\\'' + s.fullId + '\\', this)">Revoke</button>') +
        '</div>';
    }).join('');
}

async function killSession(id, btn) {
    btn.textContent = '...';
    await fetch('/auth/kill-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: id })
    });
    load();
}

load();
setInterval(load, 10000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
//  Approve Page HTML (Phone — Face ID via WebAuthn)
// ---------------------------------------------------------------------------

function approvePageHTML(token) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>T-TERM — Approve</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body {
    min-height: 100vh;
    background: linear-gradient(135deg, #0a0a0f 0%, #0d1117 50%, #0a0a0f 100%);
    font-family: 'Segoe UI', Arial, sans-serif; color: #e6edf3;
    display: flex; align-items: center; justify-content: center;
    position: relative; overflow: hidden;
}
body::before {
    content: ''; position: fixed; inset: 0;
    background-image: linear-gradient(rgba(56,189,248,0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(56,189,248,0.03) 1px, transparent 1px);
    background-size: 60px 60px; z-index: 0; pointer-events: none;
}
.orb { position: absolute; border-radius: 50%; filter: blur(100px); opacity: 0.08; z-index: 0; }
.orb1 { width: 300px; height: 300px; background: #38bdf8; top: -100px; left: -80px; }
.orb2 { width: 200px; height: 200px; background: #0284c7; bottom: -60px; right: -40px; }
.container {
    text-align: center; padding: 44px 36px;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 24px; max-width: 360px; width: 92%;
    backdrop-filter: blur(20px); position: relative; z-index: 1;
    animation: containerIn 0.6s ease;
}
@keyframes containerIn { from { opacity: 0; transform: translateY(16px); } }
.logo {
    font-family: 'Rajdhani', sans-serif; font-size: 32px; font-weight: 700;
    letter-spacing: 8px; text-transform: uppercase;
    background: linear-gradient(135deg, #38bdf8, #0284c7);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    margin-bottom: 4px;
}
.subtitle {
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    letter-spacing: 4px; color: #475569; text-transform: uppercase; margin-bottom: 28px;
}
.icon {
    font-size: 44px; margin-bottom: 16px;
    animation: fadeIn 0.6s ease 0.2s both;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.message {
    font-size: 14px; color: #94a3b8; margin-bottom: 28px; line-height: 1.6;
    animation: fadeIn 0.6s ease 0.3s both;
}
.btn {
    display: block; width: 100%; padding: 16px; border-radius: 12px; border: none;
    background: linear-gradient(135deg, #0284c7, #38bdf8);
    color: white; font-family: 'Rajdhani', sans-serif; font-size: 16px;
    font-weight: 700; cursor: pointer; letter-spacing: 2px; text-transform: uppercase;
    transition: all 0.3s; animation: fadeIn 0.6s ease 0.4s both;
}
.btn:hover { box-shadow: 0 4px 20px rgba(2,132,199,0.3); }
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.done { background: linear-gradient(135deg, #059669, #22c55e); }
.error {
    color: #ef4444; margin-top: 16px;
    font-family: 'Share Tech Mono', monospace; font-size: 11px; display: none;
}
.status {
    color: #475569; margin-top: 12px;
    font-family: 'Share Tech Mono', monospace; font-size: 11px; letter-spacing: 1px;
}
</style>
</head>
<body>
<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div class="container">
    <div class="logo">T-TERM</div>
    <div class="subtitle">Approve Access</div>
    <div class="icon" id="icon">&#128274;</div>
    <div class="message" id="msg">A device is requesting access to your terminal</div>
    <button class="btn" id="btn" onclick="approve()">Approve Login</button>
    <div class="error" id="error"></div>
    <div class="status" id="status"></div>
</div>
<script src="https://unpkg.com/@simplewebauthn/browser/dist/bundle/index.umd.min.js"></script>
<script>
const TOKEN = '${token}';
const { startAuthentication } = SimpleWebAuthnBrowser;

async function approve() {
    const btn = document.getElementById('btn');
    const msg = document.getElementById('msg');
    const icon = document.getElementById('icon');
    const status = document.getElementById('status');
    btn.disabled = true;
    btn.textContent = 'Verifying identity...';
    status.textContent = '';

    try {
        // Step 1: Get WebAuthn challenge from server
        const optResp = await fetch('/auth/approve-options?token=' + TOKEN, { method: 'POST' });
        const options = await optResp.json();
        if (options.error) {
            showError(options.error);
            btn.disabled = false;
            btn.textContent = 'Approve Login';
            return;
        }

        // Step 2: Trigger Face ID / biometric
        status.textContent = 'Confirm with Face ID...';
        const credential = await startAuthentication({ optionsJSON: options });

        // Step 3: Send signed response to server
        status.textContent = 'Verifying...';
        const resp = await fetch('/do-approve?token=' + TOKEN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credential),
        });
        const data = await resp.json();

        if (data.ok) {
            btn.textContent = 'Approved!';
            btn.classList.add('done');
            icon.innerHTML = '&#9989;';
            msg.textContent = 'Terminal access granted. You can close this page.';
            status.textContent = '';
        } else {
            showError(data.error || 'Verification failed');
            btn.disabled = false;
            btn.textContent = 'Approve Login';
        }
    } catch(e) {
        showError(e.message || 'Authentication cancelled');
        btn.disabled = false;
        btn.textContent = 'Try Again';
    }
}

function showError(msg) {
    const el = document.getElementById('error');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 5000);
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
//  Registration Page HTML
// ---------------------------------------------------------------------------

const REGISTER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>T-TERM — Register Device</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body {
    min-height: 100vh; max-width: 100vw;
    background: linear-gradient(135deg, #0a0a0f 0%, #0d1117 30%, #0a0f1a 60%, #0a0a0f 100%);
    font-family: 'Segoe UI', Arial, sans-serif; color: #e6edf3;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    position: relative; overflow-x: hidden; overflow-y: auto;
    padding: 40px 20px;
}
html { max-width: 100vw; }
@media (max-width: 500px) {
    body { justify-content: flex-start; padding-top: 60px; }
}
body::before {
    content: ''; position: fixed; inset: 0;
    background-image: linear-gradient(rgba(56,189,248,0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(56,189,248,0.03) 1px, transparent 1px);
    background-size: 60px 60px; z-index: 0; pointer-events: none;
}
body::after {
    content: ''; position: fixed; width: 100%; height: 2px; left: 0;
    background: linear-gradient(90deg, transparent, rgba(56,189,248,0.06), transparent);
    animation: scan 8s linear infinite; z-index: 0; pointer-events: none;
}
@keyframes scan { from { top: -2px; } to { top: 100%; } }
.orb { position: absolute; border-radius: 50%; filter: blur(100px); opacity: 0.08; z-index: 0; }
.orb1 { width: 400px; height: 400px; background: #0284c7; top: -150px; left: -150px; }
.orb2 { width: 300px; height: 300px; background: #38bdf8; bottom: -100px; right: -100px; }
.hud { position: fixed; width: 28px; height: 28px; z-index: 2; pointer-events: none; opacity: 0.15; }
.hud::before, .hud::after { content: ''; position: absolute; background: #38bdf8; }
.hud-tl { top: 10px; left: 10px; } .hud-tl::before { width: 18px; height: 1px; } .hud-tl::after { width: 1px; height: 18px; }
.hud-tr { top: 10px; right: 10px; } .hud-tr::before { width: 18px; height: 1px; right: 0; } .hud-tr::after { width: 1px; height: 18px; right: 0; }
.hud-bl { bottom: 10px; left: 10px; } .hud-bl::before { width: 18px; height: 1px; bottom: 0; } .hud-bl::after { width: 1px; height: 18px; bottom: 0; }
.hud-br { bottom: 10px; right: 10px; } .hud-br::before { width: 18px; height: 1px; right: 0; bottom: 0; } .hud-br::after { width: 1px; height: 18px; right: 0; bottom: 0; }
.container {
    position: relative; z-index: 1; text-align: center;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 24px; padding: 48px 44px; backdrop-filter: blur(20px);
    max-width: 420px; width: 90%;
    animation: containerIn 0.8s ease;
}
@keyframes containerIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
.logo {
    font-family: 'Rajdhani', sans-serif; font-size: 48px; font-weight: 700;
    letter-spacing: 12px; text-transform: uppercase;
    background: linear-gradient(135deg, #38bdf8 0%, #0284c7 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text; margin-bottom: 4px;
}
.subtitle {
    font-family: 'Share Tech Mono', monospace; font-size: 11px;
    letter-spacing: 6px; color: #475569; margin-bottom: 36px; text-transform: uppercase;
}
.icon-shield {
    width: 56px; height: 56px; margin: 0 auto 20px;
    border: 2px solid rgba(56,189,248,0.3); border-radius: 14px;
    display: flex; align-items: center; justify-content: center;
    background: rgba(56,189,248,0.06);
    animation: fadeIn 0.6s ease 0.3s both;
}
.icon-shield svg { width: 28px; height: 28px; color: #38bdf8; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.description {
    font-size: 13px; color: #64748b; line-height: 1.6; margin-bottom: 24px;
    animation: fadeIn 0.6s ease 0.4s both;
}
.form-group { margin-bottom: 16px; text-align: left; animation: fadeIn 0.6s ease 0.5s both; }
.form-label {
    font-family: 'Share Tech Mono', monospace; font-size: 9px;
    letter-spacing: 2px; color: #475569; text-transform: uppercase;
    margin-bottom: 6px; display: block;
}
.form-input {
    width: 100%; padding: 12px 14px; background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08); border-radius: 10px;
    font-family: 'Segoe UI', sans-serif; font-size: 15px; color: #e6edf3;
    outline: none; transition: border-color 0.2s;
}
.form-input:focus { border-color: rgba(56,189,248,0.4); }
.form-input::placeholder { color: #475569; }
.btn {
    display: block; width: 100%; padding: 14px; border-radius: 10px; border: none;
    background: linear-gradient(135deg, #0284c7, #38bdf8);
    color: white; font-family: 'Rajdhani', sans-serif; font-size: 16px;
    font-weight: 700; cursor: pointer; letter-spacing: 2px; text-transform: uppercase;
    transition: all 0.3s; animation: fadeIn 0.6s ease 0.6s both;
}
.btn:hover { box-shadow: 0 4px 20px rgba(2,132,199,0.3); }
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.done { background: linear-gradient(135deg, #059669, #22c55e); }
.error { color: #ef4444; margin-top: 16px; font-family: 'Share Tech Mono', monospace; font-size: 11px; display: none; }
.status { color: #475569; margin-top: 12px; font-family: 'Share Tech Mono', monospace; font-size: 11px; letter-spacing: 1px; }
.backup-codes {
    display: none; margin-top: 24px; text-align: left;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 12px; padding: 20px;
}
.backup-codes h3 {
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    color: #f59e0b; margin-bottom: 8px; letter-spacing: 2px; text-transform: uppercase;
}
.backup-codes p { color: #64748b; font-size: 12px; margin-bottom: 12px; line-height: 1.5; }
.code-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
    font-family: 'Share Tech Mono', monospace; font-size: 14px;
    letter-spacing: 3px; color: #22c55e;
}
.code-grid span {
    background: rgba(0,0,0,0.3); padding: 8px; border-radius: 6px; text-align: center;
    border: 1px solid rgba(34,197,94,0.15);
}
.btn-continue {
    display: block; width: 100%; padding: 14px; border-radius: 10px; border: none;
    background: linear-gradient(135deg, #059669, #22c55e);
    color: white; font-family: 'Rajdhani', sans-serif; font-size: 16px;
    font-weight: 700; cursor: pointer; letter-spacing: 2px; text-transform: uppercase;
    transition: all 0.3s; margin-top: 16px;
}
.btn-continue:hover { box-shadow: 0 4px 20px rgba(34,197,94,0.3); }
.btn-continue:active { transform: scale(0.97); }
.success-icon {
    width: 64px; height: 64px; margin: 0 auto 16px;
    border: 2px solid rgba(34,197,94,0.4); border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: rgba(34,197,94,0.08);
    animation: pop 0.4s ease;
}
@keyframes pop { from { transform: scale(0); } to { transform: scale(1); } }
.success-icon svg { width: 32px; height: 32px; color: #22c55e; }
.step-user {
    font-family: 'Share Tech Mono', monospace; font-size: 11px;
    color: #38bdf8; letter-spacing: 1px; margin-bottom: 20px;
    padding: 8px 16px; background: rgba(56,189,248,0.06);
    border: 1px solid rgba(56,189,248,0.15); border-radius: 8px;
    display: inline-block;
}
</style>
</head>
<body>
<div class="hud hud-tl"></div><div class="hud hud-tr"></div>
<div class="hud hud-bl"></div><div class="hud hud-br"></div>
<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div class="container">
    <div class="logo">T-TERM</div>
    <div class="subtitle">Create Account</div>

    <!-- Step 1: Profile -->
    <div id="step-profile">
        <div class="icon-shield">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
            </svg>
        </div>
        <div class="description">
            Set up your account to access T-Term. You'll register a passkey in the next step.
        </div>
        <div class="form-group">
            <label class="form-label">Username *</label>
            <input class="form-input" id="reg-username" placeholder="Choose a username" autocomplete="off" autofocus>
        </div>
        <div class="form-group">
            <label class="form-label">Display Name</label>
            <input class="form-input" id="reg-displayname" placeholder="Your name (optional)">
        </div>
        <div class="form-group">
            <label class="form-label">Email</label>
            <input class="form-input" id="reg-email" type="email" placeholder="Email (optional)">
        </div>
        <button class="btn" id="btn-profile" onclick="submitProfile()">Continue</button>
    </div>

    <!-- Step 2: Passkey -->
    <div id="step-passkey" style="display:none">
        <div class="icon-shield">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
        </div>
        <div class="description">
            Now register a passkey using your device's biometrics
            (Face ID, fingerprint, or PIN). This will be used to approve future logins.
        </div>
        <div class="step-user" id="step-user"></div>
        <button class="btn" id="btn-register" onclick="registerDevice()">Register Passkey</button>
    </div>

    <!-- Step 3: Backup codes -->
    <div class="backup-codes" id="backup-codes">
        <div class="success-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
            </svg>
        </div>
        <h3>Backup Codes</h3>
        <p>Save these codes somewhere safe. Each can be used once if you lose your device.</p>
        <div class="code-grid" id="code-grid"></div>
        <button class="btn-continue" onclick="window.location='/'">Continue to T-TERM</button>
    </div>

    <div class="error" id="error"></div>
    <div class="status" id="status"></div>
</div>

<script src="https://unpkg.com/@simplewebauthn/browser/dist/bundle/index.umd.min.js"></script>
<script>
const { startRegistration } = SimpleWebAuthnBrowser;

// Step 1: Submit profile
async function submitProfile() {
    const username = document.getElementById('reg-username').value.trim();
    const displayName = document.getElementById('reg-displayname').value.trim();
    const email = document.getElementById('reg-email').value.trim();

    if (!username || username.length < 2) {
        showError('Username is required (min 2 characters)');
        return;
    }

    const btn = document.getElementById('btn-profile');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        const resp = await fetch('/register/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, displayName, email }),
        });
        const result = await resp.json();
        if (result.error) {
            showError(result.error);
            btn.disabled = false;
            btn.textContent = 'Continue';
            return;
        }
        // Move to step 2
        document.getElementById('step-profile').style.display = 'none';
        document.getElementById('step-passkey').style.display = 'block';
        document.getElementById('step-user').textContent = 'Account: ' + username;
    } catch (e) {
        showError(e.message);
        btn.disabled = false;
        btn.textContent = 'Continue';
    }
}

// Step 2: Register passkey
async function registerDevice() {
    const btn = document.getElementById('btn-register');
    btn.disabled = true;
    showStatus('Generating options...');

    try {
        const optResp = await fetch('/register/start', { method: 'POST' });
        const options = await optResp.json();
        if (options.error) { showError(options.error); btn.disabled = false; return; }

        showStatus('Confirm with biometrics...');
        const credential = await startRegistration({ optionsJSON: options });

        showStatus('Verifying...');
        const verResp = await fetch('/register/finish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credential),
        });
        const result = await verResp.json();

        if (result.verified) {
            showStatus('');
            document.getElementById('step-passkey').style.display = 'none';
            const codeGrid = document.getElementById('code-grid');
            for (const code of result.backupCodes) {
                const span = document.createElement('span');
                span.textContent = code;
                codeGrid.appendChild(span);
            }
            document.getElementById('backup-codes').style.display = 'block';
        } else {
            showError(result.error || 'Registration failed');
            btn.disabled = false;
        }
    } catch (e) {
        showError(e.message || 'Registration cancelled or failed');
        btn.disabled = false;
    }
}

// Enter key on profile form
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.getElementById('step-profile').style.display !== 'none') {
        submitProfile();
    }
});

function showError(msg) {
    const el = document.getElementById('error');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 5000);
}

function showStatus(msg) {
    document.getElementById('status').textContent = msg;
}
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
//  Invite Registration HTML
// ---------------------------------------------------------------------------

function expiredInviteHTML() {
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>T-TERM — Invite Expired</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body {
    min-height: 100vh;
    background: linear-gradient(135deg, #0a0a0f 0%, #0d1117 30%, #0a0f1a 60%, #0a0a0f 100%);
    font-family: 'Segoe UI', Arial, sans-serif; color: #e6edf3;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.container {
    text-align: center; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 24px; padding: 48px 44px; backdrop-filter: blur(20px); max-width: 420px; width: 90%;
}
.logo { font-family: 'Rajdhani', sans-serif; font-size: 48px; font-weight: 700; letter-spacing: 12px;
    background: linear-gradient(135deg, #38bdf8 0%, #0284c7 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 4px; }
.subtitle { font-family: 'Share Tech Mono', monospace; font-size: 11px; letter-spacing: 6px; color: #475569; margin-bottom: 40px; text-transform: uppercase; }
.msg { font-size: 16px; color: #94a3b8; margin-bottom: 24px; line-height: 1.6; }
.btn { display: inline-block; padding: 14px 32px; border-radius: 10px; border: none;
    background: linear-gradient(135deg, #0284c7, #38bdf8); color: white;
    font-family: 'Rajdhani', sans-serif; font-size: 16px; font-weight: 700;
    cursor: pointer; letter-spacing: 2px; text-transform: uppercase; text-decoration: none; }
</style></head><body>
<div class="container">
    <div class="logo">T-TERM</div>
    <div class="subtitle">Invite Link</div>
    <div class="msg">This invite link has expired or has already been used.</div>
    <a class="btn" href="/login">Go to Login</a>
</div>
</body></html>`;
}

function inviteRegisterHTML(invite) {
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>T-TERM — You're Invited</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body {
    min-height: 100vh;
    background: linear-gradient(135deg, #0a0a0f 0%, #0d1117 30%, #0a0f1a 60%, #0a0a0f 100%);
    font-family: 'Segoe UI', Arial, sans-serif; color: #e6edf3;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    position: relative; overflow: hidden;
}
body::before {
    content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    background-image: linear-gradient(rgba(56, 189, 248, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(56, 189, 248, 0.03) 1px, transparent 1px);
    background-size: 60px 60px; z-index: 0;
}
.container {
    position: relative; z-index: 1; text-align: center;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 24px; padding: 48px 44px; backdrop-filter: blur(20px);
    max-width: 420px; width: 90%;
}
.logo { font-family: 'Rajdhani', sans-serif; font-size: 48px; font-weight: 700; letter-spacing: 12px;
    background: linear-gradient(135deg, #38bdf8 0%, #0284c7 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 4px; }
.subtitle { font-family: 'Share Tech Mono', monospace; font-size: 11px; letter-spacing: 6px; color: #475569; margin-bottom: 32px; text-transform: uppercase; }
.invite-badge { display: inline-block; padding: 8px 16px; border-radius: 8px;
    background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.2);
    color: #38bdf8; font-family: 'Share Tech Mono', monospace; font-size: 12px;
    letter-spacing: 1px; margin-bottom: 28px; }
.form-group { margin-bottom: 16px; text-align: left; }
.form-label { font-family: 'Share Tech Mono', monospace; font-size: 10px; letter-spacing: 2px;
    color: #475569; text-transform: uppercase; margin-bottom: 6px; display: block; }
.form-input { width: 100%; padding: 12px 16px; background: rgba(255,255,255,0.04);
    color: #e6edf3; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
    font-family: 'Segoe UI', sans-serif; font-size: 14px; }
.form-input:focus { outline: none; border-color: rgba(56, 189, 248, 0.4); }
.form-input:read-only { opacity: 0.6; cursor: not-allowed; }
.btn { display: block; width: 100%; padding: 14px; border-radius: 10px; border: none;
    background: linear-gradient(135deg, #0284c7, #38bdf8); color: white;
    font-family: 'Rajdhani', sans-serif; font-size: 16px; font-weight: 700;
    cursor: pointer; letter-spacing: 2px; text-transform: uppercase; transition: all 0.3s; margin-top: 8px; }
.btn:hover { box-shadow: 0 4px 20px rgba(2,132,199,0.3); }
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-success { background: linear-gradient(135deg, #059669, #22c55e); }
.error { color: #ef4444; margin-top: 12px; font-size: 12px; font-family: 'Share Tech Mono', monospace; display: none; }
.status { margin-top: 16px; font-family: 'Share Tech Mono', monospace; font-size: 12px; color: #94a3b8; display: none; }
#step-2 { display: none; }
#step-3 { display: none; }
.backup-codes { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px; padding: 16px; margin: 16px 0; font-family: 'Share Tech Mono', monospace;
    font-size: 14px; letter-spacing: 2px; line-height: 2; color: #38bdf8; }
</style></head><body>
<div class="container">
    <div class="logo">T-TERM</div>
    <div class="subtitle">You're Invited</div>
    <div class="invite-badge">Invited: ${invite.email}</div>

    <div id="step-1">
        <div class="form-group">
            <label class="form-label">Username</label>
            <input class="form-input" id="username" placeholder="Choose a username" autocomplete="off">
        </div>
        <div class="form-group">
            <label class="form-label">Display Name</label>
            <input class="form-input" id="displayName" placeholder="Your name">
        </div>
        <div class="form-group">
            <label class="form-label">Email</label>
            <input class="form-input" id="email" value="${invite.email}" readonly>
        </div>
        <button class="btn" id="btn-continue" onclick="submitProfile()">Continue</button>
    </div>

    <div id="step-2">
        <p style="color:#94a3b8; margin-bottom:20px;">Register a passkey using your device's biometrics</p>
        <button class="btn" id="btn-register" onclick="registerDevice()">Register Passkey</button>
    </div>

    <div id="step-3">
        <p style="color:#22c55e; margin-bottom:16px; font-family:'Share Tech Mono',monospace; letter-spacing:1px;">Registration complete!</p>
        <p style="color:#94a3b8; margin-bottom:12px; font-size:13px;">Save your backup codes. They can be used if you lose access to your device:</p>
        <div class="backup-codes" id="backup-codes"></div>
        <button class="btn btn-success" onclick="window.location.href='/'">Continue to T-TERM</button>
    </div>

    <div class="error" id="error"></div>
    <div class="status" id="status"></div>
</div>
<script src="https://unpkg.com/@simplewebauthn/browser/dist/bundle/index.umd.min.js"></script>
<script>
const INVITE_TOKEN = '${invite.token}';
const headers = { 'Content-Type': 'application/json', 'x-invite-token': INVITE_TOKEN };

function showError(msg) {
    const el = document.getElementById('error');
    el.textContent = msg; el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 5000);
}

async function submitProfile() {
    const username = document.getElementById('username').value.trim();
    const displayName = document.getElementById('displayName').value.trim();
    const email = document.getElementById('email').value.trim();
    if (!username || username.length < 2) { showError('Username is required (min 2 characters)'); return; }
    const btn = document.getElementById('btn-continue');
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
        const resp = await fetch('/register/profile', {
            method: 'POST', headers,
            body: JSON.stringify({ username, displayName, email })
        });
        const data = await resp.json();
        if (data.error) { showError(data.error); btn.disabled = false; btn.textContent = 'Continue'; return; }
        document.getElementById('step-1').style.display = 'none';
        document.getElementById('step-2').style.display = 'block';
    } catch(e) { showError('Network error'); btn.disabled = false; btn.textContent = 'Continue'; }
}

async function registerDevice() {
    const btn = document.getElementById('btn-register');
    btn.disabled = true; btn.textContent = 'Waiting for device...';
    try {
        const optResp = await fetch('/register/start', { method: 'POST', headers });
        const options = await optResp.json();
        if (options.error) { showError(options.error); btn.disabled = false; btn.textContent = 'Register Passkey'; return; }
        const credential = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
        const verResp = await fetch('/register/finish', {
            method: 'POST', headers,
            body: JSON.stringify(credential)
        });
        const result = await verResp.json();
        if (result.verified) {
            document.getElementById('step-2').style.display = 'none';
            document.getElementById('step-3').style.display = 'block';
            if (result.backupCodes) {
                document.getElementById('backup-codes').textContent = result.backupCodes.join('\\n');
            }
        } else { showError(result.error || 'Registration failed'); btn.disabled = false; btn.textContent = 'Register Passkey'; }
    } catch(e) { showError(e.message || 'Registration cancelled'); btn.disabled = false; btn.textContent = 'Register Passkey'; }
}
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
//  Admin Page HTML
// ---------------------------------------------------------------------------

function adminPageHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>T-TERM — Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body {
    min-height: 100vh;
    background: linear-gradient(135deg, #0a0a0f 0%, #0d1117 30%, #0a0f1a 60%, #0a0a0f 100%);
    font-family: 'Segoe UI', Arial, sans-serif; color: #e6edf3;
    display: flex; flex-direction: column; align-items: center;
    padding: 40px 20px; position: relative;
}
body::before {
    content: ''; position: fixed; inset: 0;
    background-image: linear-gradient(rgba(56,189,248,0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(56,189,248,0.03) 1px, transparent 1px);
    background-size: 60px 60px; z-index: 0; pointer-events: none;
}
.container { position: relative; z-index: 1; max-width: 700px; width: 100%; }
.header { display: flex; align-items: center; gap: 16px; margin-bottom: 32px; }
.logo {
    font-family: 'Rajdhani', sans-serif; font-size: 28px; font-weight: 700;
    letter-spacing: 6px; text-transform: uppercase;
    background: linear-gradient(135deg, #38bdf8, #0284c7);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
}
.subtitle {
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    letter-spacing: 3px; color: #475569; text-transform: uppercase;
}
.back-btn {
    margin-left: auto; font-family: 'Share Tech Mono', monospace; font-size: 10px;
    letter-spacing: 1px; color: #475569; text-decoration: none;
    border: 1px solid rgba(255,255,255,0.06); padding: 6px 14px;
    border-radius: 6px; background: rgba(255,255,255,0.03); cursor: pointer;
    transition: all 0.15s; text-transform: uppercase;
}
.back-btn:hover { border-color: rgba(56,189,248,0.3); color: #38bdf8; }

/* Tabs */
.tabs { display: flex; gap: 2px; margin-bottom: 24px; }
.tab {
    font-family: 'Share Tech Mono', monospace; font-size: 11px;
    letter-spacing: 1.5px; color: #475569; text-transform: uppercase;
    padding: 10px 20px; cursor: pointer; transition: all 0.15s;
    background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04);
    border-radius: 8px 8px 0 0; border-bottom: none;
}
.tab:hover { color: #94a3b8; }
.tab.active {
    color: #38bdf8; background: rgba(56,189,248,0.05);
    border-color: rgba(56,189,248,0.15); border-bottom: none;
    position: relative;
}
.tab.active::after {
    content: ''; position: absolute; bottom: -1px; left: 0; right: 0;
    height: 2px; background: linear-gradient(90deg, #38bdf8, #0284c7);
}
.panel { display: none; }
.panel.active { display: block; }

/* Cards */
.card {
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 12px; padding: 14px 18px; margin-bottom: 8px;
    display: flex; align-items: center; gap: 14px;
    transition: all 0.15s; animation: cardIn 0.3s ease both;
}
@keyframes cardIn { from { opacity: 0; transform: translateY(8px); } }
.card:hover { border-color: rgba(255,255,255,0.1); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot-blue { background: #38bdf8; box-shadow: 0 0 6px rgba(56,189,248,0.5); }
.dot-green { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,0.5); }
.dot-red { background: #ef4444; box-shadow: 0 0 6px rgba(239,68,68,0.5); }
.dot-amber { background: #f59e0b; box-shadow: 0 0 6px rgba(245,158,11,0.5); }
.card-info { flex: 1; min-width: 0; }
.card-label {
    font-family: 'Share Tech Mono', monospace; font-size: 12px;
    color: #e6edf3; letter-spacing: 0.5px; margin-bottom: 3px;
}
.card-meta {
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    color: #475569; display: flex; gap: 10px; flex-wrap: wrap;
}
.tag {
    font-family: 'Share Tech Mono', monospace; font-size: 9px;
    padding: 2px 8px; border-radius: 4px; letter-spacing: 0.5px;
}
.tag-blue { background: rgba(56,189,248,0.1); color: #38bdf8; border: 1px solid rgba(56,189,248,0.2); }
.tag-green { background: rgba(34,197,94,0.1); color: #22c55e; border: 1px solid rgba(34,197,94,0.2); }
.tag-red { background: rgba(239,68,68,0.1); color: #ef4444; border: 1px solid rgba(239,68,68,0.2); }
.tag-amber { background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px solid rgba(245,158,11,0.2); }

/* Buttons */
.btn-danger {
    font-family: 'Share Tech Mono', monospace; font-size: 9px;
    padding: 4px 12px; border-radius: 4px; letter-spacing: 1px;
    border: 1px solid rgba(239,68,68,0.3); background: none;
    color: #ef4444; cursor: pointer; text-transform: uppercase;
    transition: all 0.15s; opacity: 0;
}
.card:hover .btn-danger { opacity: 1; }
.btn-danger:hover { background: rgba(239,68,68,0.1); border-color: #ef4444; }
.btn-action {
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    padding: 8px 20px; border-radius: 6px; letter-spacing: 1px;
    border: 1px solid rgba(56,189,248,0.3); background: rgba(56,189,248,0.05);
    color: #38bdf8; cursor: pointer; text-transform: uppercase;
    transition: all 0.15s; white-space: nowrap; flex-shrink: 0;
}
.btn-action:hover { background: rgba(56,189,248,0.15); border-color: #38bdf8; }
.section-title {
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    color: #475569; letter-spacing: 1px; margin-bottom: 12px;
    text-transform: uppercase;
}
.empty {
    text-align: center; padding: 32px;
    font-family: 'Share Tech Mono', monospace; font-size: 11px;
    color: #475569; letter-spacing: 1px;
}
.label-input {
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
    color: #e6edf3; padding: 4px 8px; border-radius: 4px;
    font-family: 'Share Tech Mono', monospace; font-size: 11px;
    width: 140px; outline: none;
}
.label-input:focus { border-color: rgba(56,189,248,0.4); }

/* Whitelist form */
.wl-form {
    display: flex; gap: 8px; margin-bottom: 16px; align-items: center;
}
.wl-input {
    flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
    color: #e6edf3; padding: 8px 14px; border-radius: 6px;
    font-family: 'Share Tech Mono', monospace; font-size: 11px; outline: none;
}
.wl-input:focus { border-color: rgba(56,189,248,0.4); }
.wl-input::placeholder { color: #475569; }
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <div>
            <div class="logo">T-TERM</div>
            <div class="subtitle">Administration</div>
        </div>
        <a class="back-btn" href="/">Back to terminal</a>
    </div>

    <div class="tabs">
        <div class="tab active" onclick="switchTab('sessions')">Sessions</div>
        <div class="tab" onclick="switchTab('devices')">Devices</div>
        <div class="tab" onclick="switchTab('whitelist')">Trusted</div>
        <div class="tab" onclick="switchTab('audit')">Audit Log</div>
        <div class="tab" onclick="switchTab('invites')">Invites</div>
    </div>

    <!-- Sessions Panel -->
    <div class="panel active" id="panel-sessions">
        <div class="section-title" id="sessions-count"></div>
        <div id="sessions-list"></div>
    </div>

    <!-- Devices Panel -->
    <div class="panel" id="panel-devices">
        <div class="section-title" id="devices-count"></div>
        <div id="devices-list"></div>
    </div>

    <!-- Whitelist Panel -->
    <div class="panel" id="panel-whitelist">
        <div class="wl-form">
            <input class="wl-input" id="wl-label" placeholder="Device label (e.g. Dev Machine)">
            <button class="btn-action" onclick="whitelistThis()">Trust This Device</button>
        </div>
        <div class="section-title" id="whitelist-count"></div>
        <div id="whitelist-list"></div>
    </div>

    <!-- Audit Panel -->
    <div class="panel" id="panel-audit">
        <div class="section-title" id="audit-count"></div>
        <div id="audit-list"></div>
    </div>

    <!-- Invites Panel -->
    <div class="panel" id="panel-invites">
        <div class="wl-form">
            <input class="wl-input" id="invite-email" placeholder="Email address to invite" type="email">
            <button class="btn-action" onclick="createInvite()">Generate Link</button>
        </div>
        <div id="invite-link-box" style="display:none; margin:16px 0; padding:12px 16px; background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.2); border-radius:8px;">
            <div style="font-family:'Share Tech Mono',monospace; font-size:10px; color:#475569; letter-spacing:1px; margin-bottom:8px;">INVITE LINK (copy and send):</div>
            <div id="invite-link-text" style="font-family:'Share Tech Mono',monospace; font-size:11px; color:#38bdf8; word-break:break-all; margin-bottom:8px;"></div>
            <button class="btn-action" onclick="copyInviteLink()" style="font-size:10px; padding:6px 12px;">Copy Link</button>
            <span id="copy-confirm" style="font-family:'Share Tech Mono',monospace; font-size:10px; color:#22c55e; margin-left:8px; display:none;">Copied!</span>
        </div>
        <div class="section-title" id="invites-count"></div>
        <div id="invites-list"></div>
    </div>
</div>

<script>
function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelector('.tab[onclick*="' + name + '"]').classList.add('active');
    document.getElementById('panel-' + name).classList.add('active');
}

// Sessions
async function loadSessions() {
    const resp = await fetch('/auth/sessions-list');
    const sessions = await resp.json();
    const el = document.getElementById('sessions-list');
    document.getElementById('sessions-count').textContent = sessions.length + ' active session' + (sessions.length !== 1 ? 's' : '');
    if (sessions.length === 0) { el.innerHTML = '<div class="empty">No active sessions</div>'; return; }
    el.innerHTML = sessions.map((s, i) => {
        const remaining = Math.max(0, Math.round((s.expires - Date.now()) / 60000));
        const hours = Math.floor(remaining / 60), mins = remaining % 60;
        const timeLeft = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
        const machine = s.machine ? '<strong style="color:#38bdf8">' + s.machine + '</strong> · ' : '';
        return '<div class="card" style="animation-delay:' + (i * 0.04) + 's">' +
            '<div class="dot ' + (s.isCurrent ? 'dot-blue' : 'dot-green') + '"></div>' +
            '<div class="card-info">' +
                '<div class="card-label">' + machine + s.browser + ' on ' + s.os +
                    (s.isCurrent ? ' <span class="tag tag-blue">THIS DEVICE</span>' : '') + '</div>' +
                '<div class="card-meta"><span>' + s.ip + '</span><span>' + s.id + '</span><span>' + timeLeft + ' left</span></div>' +
                (s.screen || s.gpu ? '<div class="card-meta">' + (s.screen ? '<span>' + s.screen + '</span>' : '') + (s.gpu ? '<span>' + s.gpu.substring(0,40) + '</span>' : '') + '</div>' : '') +
            '</div>' +
            (s.isCurrent ? '' : '<button class="btn-danger" onclick="killSession(\\'' + s.fullId + '\\', this)">Revoke</button>') +
        '</div>';
    }).join('');
}

async function killSession(id, btn) {
    btn.textContent = '...';
    await fetch('/auth/kill-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) });
    loadSessions();
}

// Devices
async function loadDevices() {
    const resp = await fetch('/admin/devices');
    const devices = await resp.json();
    const el = document.getElementById('devices-list');
    document.getElementById('devices-count').textContent = devices.length + ' registered device' + (devices.length !== 1 ? 's' : '');
    if (devices.length === 0) { el.innerHTML = '<div class="empty">No devices registered</div>'; return; }
    el.innerHTML = devices.map((d, i) => {
        const name = d.displayName || d.username || 'Unknown';
        const roleTag = d.role === 'admin' ? '<span class="tag tag-amber">ADMIN</span>' : '<span class="tag tag-blue">USER</span>';
        const deviceLabel = [d.device, d.browser, d.os].filter(Boolean).join(' · ') || d.deviceType;
        return '<div class="card" style="animation-delay:' + (i * 0.04) + 's">' +
            '<div class="dot dot-blue"></div>' +
            '<div class="card-info">' +
                '<div class="card-label">' + name + ' ' + roleTag +
                    (d.username ? ' <span style="color:#475569;font-size:10px">@' + d.username + '</span>' : '') + '</div>' +
                '<div class="card-meta">' +
                    '<span>' + deviceLabel + '</span>' +
                    (d.backedUp ? '<span class="tag tag-green">BACKED UP</span>' : '') +
                '</div>' +
                '<div class="card-meta">' +
                    (d.email ? '<span>' + d.email + '</span>' : '') +
                    (d.ip ? '<span>' + d.ip + '</span>' : '') +
                    '<span>' + new Date(d.registeredAt).toLocaleDateString() + '</span>' +
                '</div>' +
            '</div>' +
            '<button class="btn-danger" onclick="removeDevice(' + d.index + ', this)">Remove</button>' +
        '</div>';
    }).join('');
}

async function labelDevice(index, label) {
    await fetch('/admin/label-device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index, label }) });
}

async function removeDevice(index, btn) {
    if (!confirm('Remove this device? It will no longer be able to approve logins.')) return;
    btn.textContent = '...';
    await fetch('/admin/remove-device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index }) });
    loadDevices();
}

// Whitelist
async function loadWhitelist() {
    const resp = await fetch('/admin/whitelist');
    const list = await resp.json();
    const el = document.getElementById('whitelist-list');
    document.getElementById('whitelist-count').textContent = list.length + ' trusted device' + (list.length !== 1 ? 's' : '');
    if (list.length === 0) { el.innerHTML = '<div class="empty">No trusted devices — these skip authentication entirely</div>'; return; }
    el.innerHTML = list.map((d, i) => {
        return '<div class="card" style="animation-delay:' + (i * 0.04) + 's">' +
            '<div class="dot dot-green"></div>' +
            '<div class="card-info">' +
                '<div class="card-label">' + d.label + '</div>' +
                '<div class="card-meta"><span>' + d.ip + '</span><span>Added: ' + new Date(d.created).toLocaleDateString() + '</span></div>' +
            '</div>' +
            '<button class="btn-danger" onclick="removeWhitelist(' + i + ', this)">Remove</button>' +
        '</div>';
    }).join('');
}

async function whitelistThis() {
    const label = document.getElementById('wl-label').value.trim() || 'Unnamed device';
    await fetch('/admin/whitelist-add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
    document.getElementById('wl-label').value = '';
    loadWhitelist();
}

async function removeWhitelist(index, btn) {
    if (!confirm('Remove this device from trusted list?')) return;
    btn.textContent = '...';
    await fetch('/admin/whitelist-remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index }) });
    loadWhitelist();
}

// Audit
async function loadAudit() {
    const resp = await fetch('/admin/audit');
    const log = await resp.json();
    const el = document.getElementById('audit-list');
    document.getElementById('audit-count').textContent = log.length + ' event' + (log.length !== 1 ? 's' : '');
    if (log.length === 0) { el.innerHTML = '<div class="empty">No events recorded</div>'; return; }

    const eventColors = {
        login_passkey: 'green', login_backup: 'amber', login_failed: 'red',
        register: 'blue', device_removed: 'red',
        whitelist_add: 'green', whitelist_remove: 'amber',
    };
    const eventLabels = {
        login_passkey: 'Login (Passkey)', login_backup: 'Login (Backup Code)', login_failed: 'Login Failed',
        register: 'Device Registered', device_removed: 'Device Removed',
        whitelist_add: 'Device Trusted', whitelist_remove: 'Trust Removed',
    };

    el.innerHTML = log.map((e, i) => {
        const color = eventColors[e.event] || 'blue';
        const label = eventLabels[e.event] || e.event;
        const dt = new Date(e.time);
        const date = dt.toLocaleDateString();
        const time = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const details = [];
        if (e.ip) details.push(e.ip);
        if (e.error) details.push(e.error);
        if (e.deviceType) details.push(e.deviceType);
        if (e.label) details.push(e.label);
        return '<div class="card" style="animation-delay:' + (Math.min(i, 20) * 0.03) + 's">' +
            '<div class="dot dot-' + color + '"></div>' +
            '<div class="card-info">' +
                '<div class="card-label">' + label + ' <span class="tag tag-' + color + '">' + e.event.toUpperCase() + '</span></div>' +
                '<div class="card-meta"><span>' + date + ' ' + time + '</span>' + details.map(d => '<span>' + d + '</span>').join('') + '</div>' +
            '</div>' +
        '</div>';
    }).join('');
}

let lastInviteLink = '';

async function loadInvites() {
    try {
        const resp = await fetch('/admin/invites');
        const invites = await resp.json();
        const el = document.getElementById('invites-list');
        const countEl = document.getElementById('invites-count');
        const pending = invites.filter(i => i.status === 'pending');
        countEl.textContent = pending.length + ' pending, ' + invites.length + ' total';
        el.innerHTML = invites.sort((a,b) => b.createdAt - a.createdAt).map(i => {
            const dotColor = i.status === 'pending' ? '#22c55e' : i.status === 'used' ? '#38bdf8' : '#ef4444';
            const statusTag = i.status === 'pending' ? 'PENDING' : i.status === 'used' ? 'USED' : i.status.toUpperCase();
            const date = new Date(i.createdAt).toLocaleString();
            const expires = new Date(i.expiresAt).toLocaleString();
            const usedInfo = i.usedBy ? ' by ' + i.usedBy + ' at ' + new Date(i.usedAt).toLocaleString() : '';
            const revokeBtn = i.status === 'pending' ? '<button class="btn-remove" onclick="revokeInvite(\\'' + i.id + '\\', this)">Revoke</button>' : '';
            return '<div class="card"><div class="dot" style="background:' + dotColor + '"></div>' +
                '<div class="card-info"><div class="card-label">' + i.email + ' <span style="opacity:0.5; font-size:10px;">(' + statusTag + ')</span></div>' +
                '<div class="card-meta">Created: ' + date + ' | Expires: ' + expires + usedInfo + '</div></div>' +
                revokeBtn + '</div>';
        }).join('');
    } catch(e) {}
}

async function createInvite() {
    const email = document.getElementById('invite-email').value.trim();
    if (!email || !email.includes('@')) { alert('Enter a valid email'); return; }
    try {
        const resp = await fetch('/admin/invite-create', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await resp.json();
        if (data.error) { alert(data.error); return; }
        lastInviteLink = data.link;
        document.getElementById('invite-link-text').textContent = data.link;
        document.getElementById('invite-link-box').style.display = 'block';
        document.getElementById('invite-email').value = '';
        loadInvites();
    } catch(e) { alert('Failed to create invite'); }
}

function copyInviteLink() {
    navigator.clipboard.writeText(lastInviteLink).then(() => {
        const c = document.getElementById('copy-confirm');
        c.style.display = 'inline'; setTimeout(() => c.style.display = 'none', 2000);
    });
}

async function revokeInvite(id, btn) {
    btn.disabled = true; btn.textContent = 'Revoking...';
    try {
        await fetch('/admin/invite-revoke', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        loadInvites();
    } catch(e) { btn.disabled = false; btn.textContent = 'Revoke'; }
}

// Init
loadSessions();
loadDevices();
loadWhitelist();
loadAudit();
loadInvites();
setInterval(loadSessions, 10000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
//  Exports
// ---------------------------------------------------------------------------

module.exports = { isAuthenticated, handleAuthRoute, checkWebSocketAuth };
