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

function createSession(req) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    activeSessions.set(sessionId, {
        created: now,
        expires: now + SESSION_MAX_AGE * 1000,
        ip: req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') : '',
        userAgent: req ? (req.headers['user-agent'] || '') : '',
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
            const ua = data.userAgent || '';
            const browser = ua.match(/Chrome|Firefox|Safari|Edge|Opera/)?.[0] || 'Unknown';
            const os = ua.match(/Windows|Mac|Linux|Android|iPhone|iPad/)?.[0] || 'Unknown';
            list.push({
                id: sid.slice(0, 8),
                fullId: sid,
                ip: data.ip,
                browser, os,
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
    console.log(`[AUTH REGISTER] Using rpID=${rpID} rpName=${rpName} host=${req.headers.host} x-forwarded-host=${req.headers['x-forwarded-host']} cf-connecting-ip=${req.headers['cf-connecting-ip']}`);
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
            userName: 'tayterm-admin',
            userDisplayName: 'TayTerm Admin',
            attestationType: 'none',
            excludeCredentials: existingCreds,
            authenticatorSelection: {
                authenticatorAttachment: 'platform',
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
<meta name="viewport" content="width=device-width, initial-scale=1">
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

const poll = setInterval(async () => {
    if (!polling) return;
    try {
        const resp = await fetch('/check?token=' + TOKEN);
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
<meta name="viewport" content="width=device-width, initial-scale=1">
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
        const expires = new Date(s.expires).toLocaleString();
        const remaining = Math.max(0, Math.round((s.expires - Date.now()) / 60000));
        return '<div class="session-card' + (s.isCurrent ? ' current' : '') + '" style="animation-delay:' + (i * 0.05) + 's">' +
            '<div class="session-dot"></div>' +
            '<div class="session-info">' +
                '<div class="session-label">' + s.browser + ' on ' + s.os + (s.isCurrent ? ' <span class="session-tag tag-current">THIS DEVICE</span>' : '') + '</div>' +
                '<div class="session-meta"><span>IP: ' + s.ip + '</span><span>ID: ' + s.id + '</span><span>' + remaining + 'min left</span></div>' +
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
<meta name="viewport" content="width=device-width, initial-scale=1">
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>T-TERM — Register Device</title>
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
.container {
    position: relative; z-index: 1; text-align: center;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 24px; padding: 48px 40px; backdrop-filter: blur(20px);
    max-width: 440px; width: 90%;
}
.logo {
    font-size: 32px; font-weight: 700; letter-spacing: 4px;
    background: linear-gradient(135deg, #38bdf8 0%, #818cf8 50%, #c084fc 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    margin-bottom: 8px;
}
.subtitle { font-size: 12px; letter-spacing: 3px; color: #475569; margin-bottom: 36px; text-transform: uppercase; }
.description {
    font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 28px;
}
.btn {
    display: inline-block; width: 100%; padding: 16px 32px; border-radius: 12px; border: none;
    background: linear-gradient(135deg, #38bdf8, #818cf8);
    color: white; font-size: 16px; font-weight: 600; cursor: pointer;
    letter-spacing: 1px; transition: all 0.3s;
}
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.done {
    background: linear-gradient(135deg, #059669, #34d399);
}
.error { color: #f87171; margin-top: 16px; font-size: 13px; display: none; }
.status { color: #94a3b8; margin-top: 12px; font-size: 13px; }
.backup-codes {
    display: none; margin-top: 24px; text-align: left;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px; padding: 20px;
}
.backup-codes h3 {
    font-size: 14px; color: #fbbf24; margin-bottom: 8px; letter-spacing: 1px;
}
.backup-codes p { color: #94a3b8; font-size: 12px; margin-bottom: 12px; line-height: 1.5; }
.code-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
    font-family: 'Consolas', monospace; font-size: 15px;
    letter-spacing: 2px; color: #34d399;
}
.code-grid span {
    background: rgba(0,0,0,0.3); padding: 6px 8px; border-radius: 6px; text-align: center;
}
.btn-continue {
    display: inline-block; width: 100%; padding: 14px 32px; border-radius: 12px; border: none;
    background: linear-gradient(135deg, #059669, #34d399);
    color: white; font-size: 16px; font-weight: 600; cursor: pointer;
    letter-spacing: 1px; transition: all 0.3s; margin-top: 16px;
}
.btn-continue:active { transform: scale(0.97); }
.orb { position: absolute; border-radius: 50%; filter: blur(80px); opacity: 0.12; z-index: 0; }
.orb1 { width: 300px; height: 300px; background: #38bdf8; top: -100px; left: -100px; }
.orb2 { width: 200px; height: 200px; background: #c084fc; bottom: -50px; right: -50px; }
</style>
</head>
<body>
<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div class="container">
    <div class="logo" style="font-family:'Rajdhani',sans-serif;font-size:32px;font-weight:700;letter-spacing:8px;text-transform:uppercase">T-TERM</div>
    <div class="subtitle" style="font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:4px">First-time Setup</div>

    <div id="register-section">
        <div class="description">
            Register a passkey to secure your terminal. This uses your device's
            built-in biometrics (Face ID, fingerprint, or PIN).
        </div>
        <button class="btn" id="btn-register" onclick="registerDevice()">Register your device</button>
    </div>

    <div class="backup-codes" id="backup-codes">
        <h3>BACKUP CODES</h3>
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
