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

const PASSKEY_FILE = path.join(path.dirname(path.resolve(__filename)), '.tayterm_passkeys.json');
const SESSION_MAX_AGE = 86400; // 24 hours in seconds
const TOKEN_MAX_AGE = 5 * 60 * 1000; // 5 minutes
const COOKIE_NAME = 'tayterm_session';

// Pending QR sessions: token -> { approved, created, sessionId }
const pendingSessions = new Map();

// Active sessions: sessionId -> { created, expires, ip, userAgent }
const activeSessions = new Map();

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
    return sessionId;
}

function isValidSession(sessionId) {
    if (!sessionId || !activeSessions.has(sessionId)) return false;
    const session = activeSessions.get(sessionId);
    if (Date.now() > session.expires) {
        activeSessions.delete(sessionId);
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
    for (const [sessionId, data] of activeSessions) {
        if (now > data.expires) {
            activeSessions.delete(sessionId);
        }
    }
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
    if (!simplewebauthn) return true;
    if (!hasPasskeys()) return true;
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

    // Registration page
    if (req.method === 'GET' && pathname === '/register') {
        return serveRegisterPage(req, res);
    }
    if (req.method === 'POST' && pathname === '/register/start') {
        return await handleRegisterStart(req, res);
    }
    if (req.method === 'POST' && pathname === '/register/finish') {
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
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
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

    // Auto-approve for Tailscale — already authenticated by mesh network
    if (isTailscaleRequest(req)) {
        const sessionId = createSession(req);
        pending.approved = true;
        pending.sessionId = sessionId;
        console.log(`[AUTH] Auto-approved via Tailscale (${req.socket.remoteAddress})`);
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(`<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>T-TERM — Approved</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;background:#0a0a0f;color:#e6edf3;display:flex;align-items:center;justify-content:center;font-family:'Segoe UI',sans-serif}
.card{text-align:center;padding:48px 40px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:24px;backdrop-filter:blur(20px);max-width:340px;width:90%}
.logo{font-family:'Rajdhani',sans-serif;font-size:32px;font-weight:700;letter-spacing:8px;background:linear-gradient(135deg,#38bdf8,#818cf8,#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px}
.check{font-size:48px;margin:16px 0;animation:pop 0.4s ease}
@keyframes pop{from{transform:scale(0)}to{transform:scale(1)}}
.msg{font-size:14px;color:#94a3b8;line-height:1.6}
.sub{font-family:'Share Tech Mono',monospace;font-size:10px;color:#475569;margin-top:16px;letter-spacing:2px}</style></head>
<body><div class="card"><div class="logo">T-TERM</div><div class="check">&#9989;</div>
<div class="msg">Access granted</div><div class="sub">You can close this page</div></div></body></html>`);
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

        sendJson(res, { ok: true });
    } catch (e) {
        console.error('[AUTH] WebAuthn verify error:', e);
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

function serveRegisterPage(req, res) {
    if (hasPasskeys()) {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(REGISTER_HTML);
    return true;
}

async function handleRegisterStart(req, res) {
    if (hasPasskeys()) {
        sendJson(res, { error: 'Passkeys already registered' }, 403);
        return true;
    }

    const rpConfig = getRpConfig(req);
    const { rpID, rpName } = rpConfig;
    console.log(`[AUTH REGISTER] rpID=${rpID} origin=${rpConfig.origin}`);
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
            userName: 'tterm-admin',
            userDisplayName: 'T-Term Admin',
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
    if (hasPasskeys()) {
        sendJson(res, { error: 'Passkeys already registered' }, 403);
        return true;
    }

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
        data.passkeys.push({
            credentialID: cred.id,
            credentialPublicKey: Buffer.from(cred.publicKey).toString('base64'),
            counter: cred.counter,
            transports: credential.response.transports || [],
            deviceType: credentialDeviceType,
            backedUp: credentialBackedUp,
            registeredAt: new Date().toISOString(),
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

        savePasskeys(data);
        registrationChallenge = null;

        // Create session immediately after registration
        const sessionId = createSession(req);
        setSessionCookie(res, sessionId, req);

        sendJson(res, { verified: true, backupCodes });
    } catch (e) {
        console.error('[AUTH] Register finish error:', e);
        sendJson(res, { error: e.message }, 500);
    }
    return true;
}

function handleLogout(req, res) {
    const sessionId = getSessionFromCookie(req);
    if (sessionId) activeSessions.delete(sessionId);
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
    background: linear-gradient(135deg, #38bdf8 0%, #818cf8 50%, #c084fc 100%);
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
.orb2 { width: 300px; height: 300px; background: #c084fc; bottom: -100px; right: -100px; }
.orb3 { width: 200px; height: 200px; background: #818cf8; top: 50%; left: 60%; }
.hud { position: fixed; width: 28px; height: 28px; z-index: 2; pointer-events: none; opacity: 0.15; }
.hud::before, .hud::after { content: ''; position: absolute; background: #38bdf8; }
.hud-tl { top: 10px; left: 10px; } .hud-tl::before { width: 18px; height: 1px; } .hud-tl::after { width: 1px; height: 18px; }
.hud-tr { top: 10px; right: 10px; } .hud-tr::before { width: 18px; height: 1px; right: 0; } .hud-tr::after { width: 1px; height: 18px; right: 0; }
.hud-bl { bottom: 10px; left: 10px; } .hud-bl::before { width: 18px; height: 1px; bottom: 0; } .hud-bl::after { width: 1px; height: 18px; bottom: 0; }
.hud-br { bottom: 10px; right: 10px; } .hud-br::before { width: 18px; height: 1px; right: 0; bottom: 0; } .hud-br::after { width: 1px; height: 18px; right: 0; bottom: 0; }
.divider { border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 24px 0; }
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
</script>
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
    background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc);
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
.orb2 { width: 200px; height: 200px; background: #c084fc; bottom: -60px; right: -40px; }
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
    background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc);
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
    position: relative; overflow: hidden;
}
html { overflow: hidden; max-width: 100vw; }
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
</style>
</head>
<body>
<div class="hud hud-tl"></div><div class="hud hud-tr"></div>
<div class="hud hud-bl"></div><div class="hud hud-br"></div>
<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div class="container">
    <div class="logo">T-TERM</div>
    <div class="subtitle">First-time Setup</div>

    <div id="register-section">
        <div class="icon-shield">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
        </div>
        <div class="description">
            Register a passkey to secure your terminal. This uses your device's
            built-in biometrics (Face ID, fingerprint, or PIN).
        </div>
        <button class="btn" id="btn-register" onclick="registerDevice()">Register Device</button>
    </div>

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
            document.getElementById('register-section').style.display = 'none';
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

// Enter key triggers registration

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
//  Exports
// ---------------------------------------------------------------------------

module.exports = { isAuthenticated, handleAuthRoute, checkWebSocketAuth };
