/**
 * Gateway Auth — T-Term authenticates via taybouts.com gateway.
 * Checks tterm_session cookie against gateway's /auth/verify endpoint.
 * Redirects unauthenticated users to taybouts.com/login.
 */

const https = require('https');
const http = require('http');

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://taybouts.com';
const COOKIE_NAME = 'gateway_session';

// Cache verified sessions for 60 seconds to avoid hammering the gateway
const sessionCache = new Map();
const CACHE_TTL = 60000;

function parseCookies(req) {
    const out = {};
    (req.headers.cookie || '').split(';').forEach(c => {
        const [k, ...v] = c.trim().split('=');
        if (k) out[k] = v.join('=');
    });
    return out;
}

function getSessionFromCookie(req) {
    const cookies = parseCookies(req);
    return cookies[COOKIE_NAME] || null;
}

async function verifySession(req) {
    const sessionId = getSessionFromCookie(req);
    if (!sessionId) return null;

    // Check cache
    const cached = sessionCache.get(sessionId);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
        return cached.user;
    }

    return new Promise((resolve) => {
        const url = new URL(GATEWAY_URL + '/auth/verify');
        const mod = url.protocol === 'https:' ? https : http;
        const verifyReq = mod.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: '/auth/verify',
            method: 'GET',
            headers: { 'Cookie': `${COOKIE_NAME}=${sessionId}` },
            rejectUnauthorized: false,
        }, (verifyRes) => {
            let body = '';
            verifyRes.on('data', c => body += c);
            verifyRes.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.valid) {
                        sessionCache.set(sessionId, { user: data, ts: Date.now() });
                        resolve(data);
                    } else {
                        sessionCache.delete(sessionId);
                        resolve(null);
                    }
                } catch (e) { resolve(null); }
            });
        });
        verifyReq.on('error', () => resolve(null));
        verifyReq.setTimeout(3000, () => { verifyReq.destroy(); resolve(null); });
        verifyReq.end();
    });
}

function isAuthenticated(req) {
    // Localhost always allowed (server machine)
    const ip = req.socket.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
    // Check session cookie exists (actual verification is async via verifySession)
    return !!getSessionFromCookie(req);
}

function checkWebSocketAuth(req) {
    // For WebSocket, just check cookie exists — the session was already verified on page load
    const ip = req.socket.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
    return !!getSessionFromCookie(req);
}

function getRequestIdentity(req) {
    const ip = (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ua = req.headers['user-agent'] || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

    // Parse basic device info from UA
    let browser = 'Unknown', os = 'Unknown', device = '';
    if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/Chrome\//.test(ua)) browser = 'Chrome';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';
    else if (/Safari\//.test(ua)) browser = 'Safari';
    const verMatch = ua.match(/(Edg|Chrome|Firefox|Safari|OPR)\/(\d+)/);
    if (verMatch) browser += ' ' + verMatch[2];
    if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/iPhone/.test(ua)) { os = 'iOS'; device = 'iPhone'; }
    else if (/iPad/.test(ua)) { os = 'iPadOS'; device = 'iPad'; }
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Linux/.test(ua)) os = 'Linux';

    const label = isLocal ? 'Localhost' : (device || ip);
    return { label, device, ip, browser, os, username: null, machine: '', isLocal };
}

function logAudit(event, details) {
    // Simple console log — gateway owns the real audit log
    console.log(`[AUDIT] ${event}: ${JSON.stringify(details)}`);
}

// Middleware: redirect to gateway login if not authenticated
async function handleAuthRoute(req, res, pathname) {
    // Redirect auth pages to gateway
    if (pathname === '/login' || pathname === '/register') {
        const redirect = encodeURIComponent('https://term.taybouts.com' + (req.url || '/'));
        res.writeHead(302, { 'Location': `${GATEWAY_URL}/login?redirect=${redirect}` });
        res.end();
        return true;
    }
    if (pathname === '/admin') {
        res.writeHead(302, { 'Location': `${GATEWAY_URL}/admin` });
        res.end();
        return true;
    }
    // Auth status check
    if (pathname === '/auth/status') {
        const user = await verifySession(req);
        const ip = req.socket.remoteAddress || '';
        const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: isLocal || !!user, hasPasskeys: true }));
        return true;
    }
    if (pathname === '/auth/logout') {
        res.writeHead(302, {
            'Location': GATEWAY_URL,
            'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0; Domain=.taybouts.com`
        });
        res.end();
        return true;
    }
    return false;
}

module.exports = { isAuthenticated, handleAuthRoute, checkWebSocketAuth, getRequestIdentity, logAudit, verifySession };
