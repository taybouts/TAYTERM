/**
 * TAYTERM WebAuthn/Passkey Authentication
 *
 * Provides passkey-based auth with session cookies.
 * Gracefully degrades to open access if @simplewebauthn/server is not installed.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
const COOKIE_NAME = 'tayterm_session';

// In-memory session store: { token: { created: number, expires: number } }
const sessions = {};

// In-memory challenge store: { challenge: string, expires: number }
let currentChallenge = null;

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
    const host = (req.headers.host || 'localhost').split(':')[0];

    if (host === 'taybouts.com' || host.endsWith('.taybouts.com')) {
        return {
            rpID: 'taybouts.com',
            rpName: 'TAYTERM',
            origin: 'https://term.taybouts.com',
        };
    }

    // Development / localhost
    const port = (req.headers.host || '').split(':')[1] || '7777';
    return {
        rpID: 'localhost',
        rpName: 'TAYTERM (dev)',
        origin: `https://localhost:${port}`,
    };
}

// ---------------------------------------------------------------------------
//  Session Management
// ---------------------------------------------------------------------------

function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    sessions[token] = {
        created: now,
        expires: now + SESSION_MAX_AGE * 1000,
    };
    return token;
}

function isValidSession(token) {
    if (!token || !sessions[token]) return false;
    if (Date.now() > sessions[token].expires) {
        delete sessions[token];
        return false;
    }
    return true;
}

function getSessionFromCookie(req) {
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    return match ? match[1] : null;
}

function setSessionCookie(res, token) {
    const cookie = `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`;
    // Append to existing Set-Cookie headers
    const existing = res.getHeader('Set-Cookie') || [];
    const cookies = Array.isArray(existing) ? existing : (existing ? [existing] : []);
    cookies.push(cookie);
    res.setHeader('Set-Cookie', cookies);
}

function clearSessionCookie(res) {
    const cookie = `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
    res.setHeader('Set-Cookie', cookie);
}

// Clean up expired sessions every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const token of Object.keys(sessions)) {
        if (now > sessions[token].expires) {
            delete sessions[token];
        }
    }
}, 10 * 60 * 1000);

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

/**
 * Check if a request has a valid session.
 * Returns true if auth is disabled (no simplewebauthn) or if no passkeys registered.
 */
function isAuthenticated(req) {
    // If simplewebauthn not available, auth is disabled
    if (!simplewebauthn) return true;

    // If no passkeys registered yet, allow open access
    if (!hasPasskeys()) return true;

    const token = getSessionFromCookie(req);
    return isValidSession(token);
}

/**
 * Handle /auth/* routes. Returns true if the route was handled.
 */
async function handleAuthRoute(req, res, pathname) {
    // If simplewebauthn not available, nothing to handle
    if (!simplewebauthn) return false;

    if (req.method === 'GET' && pathname === '/auth/login') {
        return serveLoginPage(req, res);
    }
    if (req.method === 'GET' && pathname === '/auth/register') {
        return serveRegisterPage(req, res);
    }
    if (req.method === 'POST' && pathname === '/auth/register/options') {
        return await handleRegisterOptions(req, res);
    }
    if (req.method === 'POST' && pathname === '/auth/register/verify') {
        return await handleRegisterVerify(req, res);
    }
    if (req.method === 'POST' && pathname === '/auth/login/options') {
        return await handleLoginOptions(req, res);
    }
    if (req.method === 'POST' && pathname === '/auth/login/verify') {
        return await handleLoginVerify(req, res);
    }
    if (req.method === 'GET' && pathname === '/auth/logout') {
        return handleLogout(req, res);
    }
    if (req.method === 'GET' && pathname === '/auth/status') {
        return handleStatus(req, res);
    }

    return false;
}

// ---------------------------------------------------------------------------
//  Route Handlers
// ---------------------------------------------------------------------------

function serveLoginPage(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(LOGIN_HTML);
    return true;
}

function serveRegisterPage(req, res) {
    // Only allow registration if no passkeys exist
    if (hasPasskeys()) {
        res.writeHead(302, { Location: '/auth/login' });
        res.end();
        return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(REGISTER_HTML);
    return true;
}

async function handleRegisterOptions(req, res) {
    if (hasPasskeys()) {
        sendAuthJson(res, { error: 'Passkeys already registered' }, 403);
        return true;
    }

    const { rpID, rpName } = getRpConfig(req);
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
            userDisplayName: 'TAYTERM Admin',
            attestationType: 'none',
            excludeCredentials: existingCreds,
            authenticatorSelection: {
                residentKey: 'preferred',
                userVerification: 'preferred',
            },
        });

        currentChallenge = options.challenge;
        sendAuthJson(res, options);
    } catch (e) {
        console.error('[AUTH] Register options error:', e);
        sendAuthJson(res, { error: e.message }, 500);
    }
    return true;
}

async function handleRegisterVerify(req, res) {
    if (hasPasskeys()) {
        sendAuthJson(res, { error: 'Passkeys already registered' }, 403);
        return true;
    }

    const body = await readAuthBody(req);
    let credential;
    try {
        credential = JSON.parse(body);
    } catch (e) {
        sendAuthJson(res, { error: 'Invalid JSON' }, 400);
        return true;
    }

    const { rpID, origin } = getRpConfig(req);

    try {
        const verification = await simplewebauthn.verifyRegistrationResponse({
            response: credential,
            expectedChallenge: currentChallenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
        });

        if (!verification.verified || !verification.registrationInfo) {
            sendAuthJson(res, { error: 'Verification failed' }, 400);
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

        // Generate backup codes
        const backupCodes = [];
        for (let i = 0; i < 8; i++) {
            backupCodes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
        }
        data.backupCodes = backupCodes.map(code => ({
            code: crypto.createHash('sha256').update(code).digest('hex'),
            used: false,
        }));

        savePasskeys(data);
        currentChallenge = null;

        // Create session immediately after registration
        const token = createSession();
        setSessionCookie(res, token);

        sendAuthJson(res, { verified: true, backupCodes });
    } catch (e) {
        console.error('[AUTH] Register verify error:', e);
        sendAuthJson(res, { error: e.message }, 500);
    }
    return true;
}

async function handleLoginOptions(req, res) {
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
            userVerification: 'preferred',
        });

        currentChallenge = options.challenge;
        sendAuthJson(res, options);
    } catch (e) {
        console.error('[AUTH] Login options error:', e);
        sendAuthJson(res, { error: e.message }, 500);
    }
    return true;
}

async function handleLoginVerify(req, res) {
    const body = await readAuthBody(req);
    let credential;
    try {
        credential = JSON.parse(body);
    } catch (e) {
        sendAuthJson(res, { error: 'Invalid JSON' }, 400);
        return true;
    }

    // Check backup code
    if (credential.backupCode) {
        return handleBackupCodeLogin(res, credential.backupCode);
    }

    const { rpID, origin } = getRpConfig(req);
    const data = loadPasskeys();

    // Find the matching passkey
    const passkey = (data.passkeys || []).find(pk => pk.credentialID === credential.id);
    if (!passkey) {
        sendAuthJson(res, { error: 'Passkey not found' }, 400);
        return true;
    }

    try {
        const verification = await simplewebauthn.verifyAuthenticationResponse({
            response: credential,
            expectedChallenge: currentChallenge,
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
            sendAuthJson(res, { error: 'Authentication failed' }, 401);
            return true;
        }

        // Update counter
        passkey.counter = verification.authenticationInfo.newCounter;
        savePasskeys(data);
        currentChallenge = null;

        const token = createSession();
        setSessionCookie(res, token);
        sendAuthJson(res, { verified: true });
    } catch (e) {
        console.error('[AUTH] Login verify error:', e);
        sendAuthJson(res, { error: e.message }, 500);
    }
    return true;
}

function handleBackupCodeLogin(res, code) {
    const data = loadPasskeys();
    const hash = crypto.createHash('sha256').update(code.toUpperCase().trim()).digest('hex');
    const entry = (data.backupCodes || []).find(bc => bc.code === hash && !bc.used);

    if (!entry) {
        sendAuthJson(res, { error: 'Invalid or used backup code' }, 401);
        return true;
    }

    entry.used = true;
    savePasskeys(data);

    const token = createSession();
    setSessionCookie(res, token);
    sendAuthJson(res, { verified: true });
    return true;
}

function handleLogout(req, res) {
    const token = getSessionFromCookie(req);
    if (token) delete sessions[token];
    clearSessionCookie(res);
    res.writeHead(302, { Location: '/auth/login' });
    res.end();
    return true;
}

function handleStatus(req, res) {
    sendAuthJson(res, {
        authenticated: isAuthenticated(req),
        hasPasskeys: hasPasskeys(),
        authEnabled: !!simplewebauthn,
    });
    return true;
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function sendAuthJson(res, data, status = 200) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
}

function readAuthBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
//  Login Page HTML
// ---------------------------------------------------------------------------

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TAYTERM — Sign In</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0a0a0a; color: #c0c0c0; font-family: 'Consolas', 'Courier New', monospace;
    display: flex; align-items: center; justify-content: center; min-height: 100vh;
  }
  .card {
    background: #111; border: 1px solid #2a2a2a; border-radius: 8px;
    padding: 2.5rem; max-width: 400px; width: 90%; text-align: center;
  }
  h1 { color: #00ff88; font-size: 1.6rem; margin-bottom: 0.3rem; letter-spacing: 2px; }
  .subtitle { color: #555; font-size: 0.85rem; margin-bottom: 2rem; }
  .btn {
    display: inline-block; width: 100%; padding: 0.9rem 1.5rem; margin: 0.4rem 0;
    background: #1a3a2a; color: #00ff88; border: 1px solid #00ff88;
    border-radius: 4px; font-family: inherit; font-size: 1rem; cursor: pointer;
    transition: background 0.2s, box-shadow 0.2s;
  }
  .btn:hover { background: #0d4a2a; box-shadow: 0 0 15px rgba(0, 255, 136, 0.15); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-secondary {
    background: transparent; color: #888; border-color: #333;
  }
  .btn-secondary:hover { background: #1a1a1a; color: #aaa; border-color: #555; }
  .error { color: #ff4444; margin-top: 1rem; font-size: 0.85rem; display: none; }
  .status { color: #666; margin-top: 1rem; font-size: 0.85rem; }
  .backup-input {
    width: 100%; padding: 0.7rem; margin: 0.5rem 0; background: #0a0a0a;
    color: #c0c0c0; border: 1px solid #333; border-radius: 4px;
    font-family: inherit; font-size: 1rem; text-align: center;
    letter-spacing: 2px; text-transform: uppercase;
  }
  .backup-input:focus { outline: none; border-color: #00ff88; }
  .divider { border: none; border-top: 1px solid #222; margin: 1.2rem 0; }
  .link { color: #00ff88; text-decoration: none; font-size: 0.85rem; cursor: pointer; }
  .link:hover { text-decoration: underline; }
  #backup-section { display: none; }
</style>
</head>
<body>
<div class="card">
  <h1>TAYTERM</h1>
  <p class="subtitle">terminal access</p>

  <div id="main-section">
    <button class="btn" id="btn-passkey" onclick="loginWithPasskey()">Sign in with Passkey</button>
    <hr class="divider">
    <a class="link" onclick="showBackupSection()">Use backup code</a>
  </div>

  <div id="backup-section">
    <input class="backup-input" id="backup-code" placeholder="BACKUP CODE" maxlength="8">
    <button class="btn" onclick="loginWithBackup()">Submit</button>
    <hr class="divider">
    <a class="link" onclick="hideBackupSection()">Back to passkey</a>
  </div>

  <div id="setup-section" style="display:none">
    <p class="status">No passkeys registered yet.</p>
    <button class="btn" onclick="window.location='/auth/register'">Set up your device</button>
  </div>

  <p class="error" id="error"></p>
  <p class="status" id="status"></p>
</div>

<script src="https://unpkg.com/@simplewebauthn/browser/dist/bundle/index.umd.min.js"></script>
<script>
const { startAuthentication } = SimpleWebAuthnBrowser;

// Check if passkeys exist
fetch('/auth/status').then(r => r.json()).then(data => {
    if (!data.hasPasskeys) {
        document.getElementById('main-section').style.display = 'none';
        document.getElementById('setup-section').style.display = 'block';
    }
    if (data.authenticated) {
        window.location = '/';
    }
}).catch(() => {});

function showError(msg) {
    const el = document.getElementById('error');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 5000);
}

function showStatus(msg) {
    document.getElementById('status').textContent = msg;
}

function showBackupSection() {
    document.getElementById('main-section').style.display = 'none';
    document.getElementById('backup-section').style.display = 'block';
    document.getElementById('backup-code').focus();
}

function hideBackupSection() {
    document.getElementById('backup-section').style.display = 'none';
    document.getElementById('main-section').style.display = 'block';
}

async function loginWithPasskey() {
    const btn = document.getElementById('btn-passkey');
    btn.disabled = true;
    showStatus('Requesting passkey...');

    try {
        const optResp = await fetch('/auth/login/options', { method: 'POST' });
        const options = await optResp.json();
        if (options.error) { showError(options.error); btn.disabled = false; return; }

        showStatus('Touch your authenticator...');
        const credential = await startAuthentication({ optionsJSON: options });

        showStatus('Verifying...');
        const verResp = await fetch('/auth/login/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credential),
        });
        const result = await verResp.json();

        if (result.verified) {
            showStatus('Authenticated!');
            window.location = '/';
        } else {
            showError(result.error || 'Authentication failed');
        }
    } catch (e) {
        showError(e.message || 'Authentication cancelled or failed');
    }
    btn.disabled = false;
    showStatus('');
}

async function loginWithBackup() {
    const code = document.getElementById('backup-code').value.trim();
    if (!code) { showError('Enter a backup code'); return; }

    try {
        const resp = await fetch('/auth/login/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backupCode: code }),
        });
        const result = await resp.json();
        if (result.verified) {
            window.location = '/';
        } else {
            showError(result.error || 'Invalid backup code');
        }
    } catch (e) {
        showError(e.message);
    }
}

// Enter key on backup input
document.getElementById('backup-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') loginWithBackup();
});
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
//  Registration Page HTML
// ---------------------------------------------------------------------------

const REGISTER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TAYTERM — Register Device</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0a0a0a; color: #c0c0c0; font-family: 'Consolas', 'Courier New', monospace;
    display: flex; align-items: center; justify-content: center; min-height: 100vh;
  }
  .card {
    background: #111; border: 1px solid #2a2a2a; border-radius: 8px;
    padding: 2.5rem; max-width: 440px; width: 90%; text-align: center;
  }
  h1 { color: #00ff88; font-size: 1.6rem; margin-bottom: 0.3rem; letter-spacing: 2px; }
  .subtitle { color: #555; font-size: 0.85rem; margin-bottom: 2rem; }
  .btn {
    display: inline-block; width: 100%; padding: 0.9rem 1.5rem; margin: 0.4rem 0;
    background: #1a3a2a; color: #00ff88; border: 1px solid #00ff88;
    border-radius: 4px; font-family: inherit; font-size: 1rem; cursor: pointer;
    transition: background 0.2s, box-shadow 0.2s;
  }
  .btn:hover { background: #0d4a2a; box-shadow: 0 0 15px rgba(0, 255, 136, 0.15); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .error { color: #ff4444; margin-top: 1rem; font-size: 0.85rem; display: none; }
  .status { color: #666; margin-top: 1rem; font-size: 0.85rem; }
  .success { color: #00ff88; }
  .backup-codes {
    display: none; margin-top: 1.5rem; text-align: left;
    background: #0a0a0a; border: 1px solid #2a2a2a; border-radius: 4px; padding: 1.2rem;
  }
  .backup-codes h3 { color: #ffaa00; font-size: 0.9rem; margin-bottom: 0.8rem; }
  .backup-codes p { color: #888; font-size: 0.75rem; margin-bottom: 0.8rem; }
  .code-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem;
    font-size: 1.1rem; letter-spacing: 2px; color: #00ff88;
  }
  .code-grid span { background: #111; padding: 0.3rem 0.5rem; border-radius: 2px; text-align: center; }
  .btn-done { margin-top: 1rem; }
</style>
</head>
<body>
<div class="card">
  <h1>TAYTERM</h1>
  <p class="subtitle">first-time device setup</p>

  <div id="register-section">
    <p class="status" style="margin-bottom: 1.2rem;">
      Register a passkey to secure your terminal. This uses your device's
      built-in authenticator (fingerprint, face, PIN, or security key).
    </p>
    <button class="btn" id="btn-register" onclick="registerDevice()">Register your device</button>
  </div>

  <div class="backup-codes" id="backup-codes">
    <h3>BACKUP CODES</h3>
    <p>Save these codes somewhere safe. Each can be used once if you lose your passkey.</p>
    <div class="code-grid" id="code-grid"></div>
    <button class="btn btn-done" onclick="window.location='/'">Continue to TAYTERM</button>
  </div>

  <p class="error" id="error"></p>
  <p class="status" id="status"></p>
</div>

<script src="https://unpkg.com/@simplewebauthn/browser/dist/bundle/index.umd.min.js"></script>
<script>
const { startRegistration } = SimpleWebAuthnBrowser;

async function registerDevice() {
    const btn = document.getElementById('btn-register');
    btn.disabled = true;
    showStatus('Generating options...');

    try {
        const optResp = await fetch('/auth/register/options', { method: 'POST' });
        const options = await optResp.json();
        if (options.error) { showError(options.error); btn.disabled = false; return; }

        showStatus('Touch your authenticator...');
        const credential = await startRegistration({ optionsJSON: options });

        showStatus('Verifying...');
        const verResp = await fetch('/auth/register/verify', {
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

module.exports = { isAuthenticated, handleAuthRoute };
