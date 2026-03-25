/**
 * TAYTERM - Web terminal with persistent PTY and multi-device sync.
 * Node.js rewrite. Port 7777.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const WebSocket = require('ws');
// HeadlessTerminal removed — TTS + messenger now use JSONL (structured, clean data)
const { isAuthenticated, handleAuthRoute, checkWebSocketAuth, getRequestIdentity, logAudit } = require('./auth');
const { TTSTap, claimProject, releaseProject } = require('./lib/tts-tap');
const initDaemonClient = require('./lib/daemon-client');
const createReader = require('./lib/jsonl-reader');

// Route modules
const createWsHandler = require('./routes/ws');
const createApiRouter = require('./routes/api');
const createStaticHandler = require('./routes/static');

// Ignore SIGINT like Python version
process.on('SIGINT', () => {});
process.on('uncaughtException', (err) => {
    console.error(`[CRASH] ${err.message}\n${err.stack}`);
});
process.on('unhandledRejection', (err) => {
    console.error(`[UNHANDLED] ${err}`);
});

const PROJECTS_DIR = String.raw`C:\Users\taybo\Dropbox\CODEAI`;
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE_CMD = 'claude --dangerously-skip-permissions';
const BASE_DIR = path.dirname(path.resolve(__filename));
const STATIC_DIR = path.join(BASE_DIR, 'static');
const FAVORITES_FILE = path.join(BASE_DIR, 'favorites.json');

// Per-session PTY sessions: { "ProjectName:claude" or "ProjectName:shell": { alive, subscribers, ttsTap } }
const activeTerminals = {};

// ---------------------------------------------------------------------------
//  Logging
// ---------------------------------------------------------------------------

function log(msg) {
    const now = new Date();
    const ts = now.toTimeString().slice(0, 8);
    console.log(`${ts} ${msg}`);
}

// ---------------------------------------------------------------------------
//  PTY Daemon Client (lib/daemon-client.js)
// ---------------------------------------------------------------------------

function handleDaemonMessage(msg) {
    const sessionKey = msg.sessionKey;
    const entry = sessionKey ? activeTerminals[sessionKey] : null;

    switch (msg.type) {
        case 'output': {
            if (!entry) return;
            const dead = [];
            for (const ws of entry.subscribers) {
                try {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'output', data: msg.data }));
                    } else dead.push(ws);
                } catch (e) { dead.push(ws); }
            }
            for (const ws of dead) entry.subscribers.delete(ws);
            // Detect Claude prompt (waiting for input) — notify messenger
            if (sessionKey && sessionKey.endsWith(':claude') && entry.isThinking) {
                const text = typeof msg.data === 'string' ? msg.data : '';
                if (/[\r\n]>\s*$|^>\s*$/.test(text) || /\(Y\/n\)\s*$|\(y\/N\)\s*$/i.test(text)) {
                    entry.isThinking = false;
                    for (const ws of entry.subscribers) {
                        try {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'prompt', waiting: true }));
                            }
                        } catch (e) { /* ignore */ }
                    }
                }
            }
            break;
        }
        case 'scrollback': {
            if (!entry) return;
            // Replay scrollback to all current subscribers
            for (const ws of entry.subscribers) {
                try {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'output', data: msg.data }));
                    }
                } catch (e) { /* ignore */ }
            }
            break;
        }
        case 'exit': {
            log(`PTY exited (daemon): ${sessionKey}`);
            if (entry) {
                entry.alive = false;
                if (entry._onPtyExit) entry._onPtyExit();
                // Notify WebSocket subscribers
                for (const ws of entry.subscribers) {
                    try {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'status', data: 'PTY exited' }));
                        }
                    } catch (e) { /* ignore */ }
                }
            }
            if (sessionKey && sessionKey.endsWith(':claude')) {
                releaseProject(sessionKey.split(':')[0]);
            }
            break;
        }
        case 'spawned': {
            log(`Daemon spawned: ${sessionKey} (PID ${msg.pid})`);
            if (entry) entry.alive = true;
            break;
        }
        case 'attached': {
            log(`Daemon attached: ${sessionKey}`);
            break;
        }
        case 'killed': {
            log(`Daemon killed: ${sessionKey}`);
            if (entry) {
                entry.alive = false;
                delete activeTerminals[sessionKey];
            }
            break;
        }
        case 'error': {
            log(`Daemon error: ${msg.message}`);
            break;
        }
    }
}

// Initialize daemon client — passes handleDaemonMessage as callback
const daemon = initDaemonClient(handleDaemonMessage, { log, activeTerminals });
const { ensureDaemon, daemonSpawn, daemonAttach, daemonDetach, daemonWrite, daemonResize, daemonKill, daemonList, daemonListAsync, getDaemonState } = daemon;

async function recoverDaemonSessions() {
    if (!getDaemonState().connected) return;
    const sessions = await daemonListAsync();
    if (sessions.length === 0) {
        log('Daemon recovery: no existing sessions');
        return;
    }
    log(`Daemon recovery: found ${sessions.length} live session(s)`);
    for (const s of sessions) {
        const sessionKey = s.sessionKey;
        if (activeTerminals[sessionKey]) continue; // Already known

        // Rebuild the entry
        const entry = { alive: true, subscribers: new Set(), ttsTap: null };
        activeTerminals[sessionKey] = entry;

        // Attach to get output
        daemonAttach(sessionKey);

        // Start JSONL watcher for claude sessions
        if (sessionKey.endsWith(':claude')) {
            startReader(sessionKey, { attachLatest: true });
        }

        log(`Recovered: ${sessionKey} (PID ${s.pid})`);
    }
}

// TTS Tap + project claims loaded from lib/tts-tap.js

// ---------------------------------------------------------------------------
//  PTY Reader (lib/jsonl-reader.js)
// ---------------------------------------------------------------------------
const startReader = createReader({
    activeTerminals, PROJECTS_DIR, CLAUDE_PROJECTS_DIR, TTSTap, claimProject, WebSocket, log,
});

// ---------------------------------------------------------------------------
//  SSL Cert Generation
// ---------------------------------------------------------------------------

function ensureCerts() {
    const certPath = path.join(BASE_DIR, '.tayterm_cert.pem');
    const keyPath = path.join(BASE_DIR, '.tayterm_key.pem');

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        return { cert: certPath, key: keyPath };
    }

    log('Generating self-signed certificate...');
    try {
        execSync(
            `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
            `-days 365 -nodes -subj "/CN=tayterm"`,
            { stdio: 'pipe' }
        );
        log('Certificate generated.');
    } catch (e) {
        log(`WARNING: Could not generate certs: ${e.message}`);
        return null;
    }

    return { cert: certPath, key: keyPath };
}

// ---------------------------------------------------------------------------
//  Wire up route handlers
// ---------------------------------------------------------------------------

const sharedDeps = {
    activeTerminals, PROJECTS_DIR, CLAUDE_PROJECTS_DIR, CLAUDE_CMD, FAVORITES_FILE,
    BASE_DIR, STATIC_DIR,
    daemonSpawn, daemonAttach, daemonDetach, daemonWrite, daemonResize,
    daemonKill, daemonList, daemonListAsync, getDaemonState,
    startReader, log, fs, path, WebSocket,
    isAuthenticated, getRequestIdentity, logAudit,
    releaseProject,
};

const handleWebSocket = createWsHandler(sharedDeps);
const handleApiRoute = createApiRouter(sharedDeps);
const handleStaticRoute = createStaticHandler(sharedDeps);

// ---------------------------------------------------------------------------
//  HTTP Router
// ---------------------------------------------------------------------------

async function requestHandler(req, res) {
    const url = new URL(req.url, 'https://localhost');
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
    }

    // Auth routes are always accessible
    const authPaths = ['/auth/', '/login', '/approve', '/do-approve', '/check', '/register', '/admin', '/invite'];
    if (authPaths.some(p => pathname === p || pathname.startsWith(p + '/') || pathname.startsWith(p + '?')) || pathname.startsWith('/auth/')) {
        const handled = await handleAuthRoute(req, res, pathname);
        if (handled) return;
    }

    // Everything else requires authentication
    if (!isAuthenticated(req)) {
        if (req.method === 'GET' && !pathname.startsWith('/api/')) {
            res.writeHead(302, { Location: '/login' });
            res.end();
        } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not authenticated' }));
        }
        return;
    }

    try {
        if (await handleApiRoute(req, res, pathname)) return;
        if (await handleStaticRoute(req, res, pathname)) return;

        res.writeHead(404);
        res.end('Not found');
    } catch (e) {
        console.error('Request error:', e);
        if (!res.headersSent) {
            res.writeHead(500);
            res.end('Internal server error');
        }
    }
}

// ---------------------------------------------------------------------------
//  Main
// ---------------------------------------------------------------------------

async function main() {
    // Parse --port arg
    let port = 7777;
    const portIdx = process.argv.indexOf('--port');
    if (portIdx !== -1 && process.argv[portIdx + 1]) {
        port = parseInt(process.argv[portIdx + 1], 10) || 7777;
    }

    // Connect to PTY daemon (starts it if not running)
    await ensureDaemon();

    // Recover any existing PTY sessions from the daemon
    await recoverDaemonSessions();

    // Ensure SSL certs
    const certs = ensureCerts();
    let server;

    if (certs) {
        const sslOptions = {
            cert: fs.readFileSync(certs.cert),
            key: fs.readFileSync(certs.key),
        };
        server = https.createServer(sslOptions, requestHandler);
    } else {
        // Fallback to HTTP if no certs
        log('WARNING: No SSL certs, falling back to HTTP');
        server = http.createServer(requestHandler);
    }

    // WebSocket server on /ws path
    const wss = new WebSocket.Server({ noServer: true });
    wss.on('connection', handleWebSocket);

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'https://localhost');
        if (url.pathname === '/ws') {
            // Auth check for WebSocket upgrade
            if (!checkWebSocketAuth(req)) {
                const ip = req.socket.remoteAddress || '';
                log(`WS auth REJECTED — ip:${ip} cookie:${(req.headers.cookie || 'NONE').substring(0, 50)} host:${req.headers.host}`);
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req);
            });
        } else {
            socket.destroy();
        }
    });

    server.listen(port, '0.0.0.0', () => {
        log(`TAYTERM on https://0.0.0.0:${port}`);
        log(`Projects: ${PROJECTS_DIR}`);
    });
}

main();
