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
const pty = require('node-pty');
const WebSocket = require('ws');
// HeadlessTerminal removed — TTS + messenger now use JSONL (structured, clean data)
const { isAuthenticated, handleAuthRoute, checkWebSocketAuth } = require('./auth');

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
const TTS_URL = 'http://127.0.0.1:7123';
const FAVORITES_FILE = path.join(BASE_DIR, 'favorites.json');

// ANSI escape code regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07|\x1b[()][AB012]|\x1b\[\??[0-9;]*[hl]|\r/g;

// Per-session PTY sessions: { "ProjectName:claude" or "ProjectName:shell": { pty, subscribers, ttsTap } }
const activeTerminals = {};

// TTS project claims — track which projects T-Term is handling TTS for
const claimedProjects = new Set();

function claimProject(project) {
    // Stream watcher uses last segment of JSONL path (e.g. 'Command-Center')
    const claimName = project.replace(/ /g, '-');
    if (claimedProjects.has(claimName)) return;
    claimedProjects.add(claimName);
    const data = JSON.stringify({ project: claimName, claimed: true });
    const req = http.request({ hostname: '127.0.0.1', port: 7123, path: '/claim-project', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, () => {});
    req.on('error', () => {});
    req.end(data);
    log(`Claimed TTS for: ${project}`);
}

function releaseProject(project) {
    const claimName = project.replace(/ /g, '-');
    if (!claimedProjects.has(claimName)) return;
    claimedProjects.delete(claimName);
    const data = JSON.stringify({ project: claimName, claimed: false });
    const req = http.request({ hostname: '127.0.0.1', port: 7123, path: '/claim-project', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, () => {});
    req.on('error', () => {});
    req.end(data);
    log(`Released TTS for: ${project}`);
}

// Heartbeat every 30s — re-claim all active projects
setInterval(() => {
    for (const project of claimedProjects) {
        const data = JSON.stringify({ project, claimed: true });
        const req = http.request({ hostname: '127.0.0.1', port: 7123, path: '/claim-project', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, () => {});
        req.on('error', () => {});
        req.end(data);
    }
}, 30000);

// ---------------------------------------------------------------------------
//  TTS Tap
// ---------------------------------------------------------------------------

class TTSTap {
    constructor(project) {
        this.project = project;
        this.buffer = '';
        this.inCodeBlock = false;
        this.sentencesSent = new Set();
        this.echoPending = '';
        this.muted = false;
    }

    _cleanMarkdown(text) {
        text = text.replace(/\*\*(.+?)\*\*/g, '$1');
        text = text.replace(/\*(.+?)\*/g, '$1');
        text = text.replace(/`(.+?)`/g, '$1');
        text = text.replace(/\[(.+?)\]\(.+?\)/g, '$1');
        text = text.replace(/^\s*[-*]\s+/, '');
        text = text.replace(/^\s*\d+\.\s+/, '');
        return text.trim();
    }

    _shouldSkip(line) {
        const stripped = line.trim();
        if (!stripped || stripped.length <= 2) return true;
        // Strip non-ASCII first
        const ascii = stripped.replace(/[^\x20-\x7E]/g, '').trim();
        if (!ascii || ascii.length <= 2) return true;
        // Code blocks
        if (/^\s*```/.test(stripped)) {
            this.inCodeBlock = !this.inCodeBlock;
            return true;
        }
        if (this.inCodeBlock) return true;
        // Anything with | is likely a table, status bar, or separator
        if (/\|/.test(ascii)) return true;
        // Anything with [] is likely a progress bar, log prefix, or UI element
        if (/\[.*\]/.test(ascii)) return true;
        // Lines starting with non-letter (symbols, numbers, paths, prompts)
        if (!/^[A-Za-z]/.test(ascii)) return true;
        // Skip known terminal/system patterns
        if (/^(Tip:|Use |Press |Copyright|Windows|PS |claude |git |python |pip |npm |node )/.test(ascii)) return true;
        if (/https?:\/\//.test(ascii)) return true;
        if (/ctrl\+|shift\+|alt\+/i.test(ascii)) return true;
        // Must be mostly letters and spaces (natural language)
        const alphaSpaces = (ascii.match(/[a-zA-Z\s]/g) || []).length;
        if (alphaSpaces / ascii.length < 0.7) return true;
        // Must have at least 5 words
        if (ascii.split(/\s+/).length < 5) return true;
        return false;
    }

    _sendToTts(sentence) {
        try {
            // Strip non-ASCII to prevent Unicode encoding crashes on Windows
            const clean = sentence.replace(/[^\x20-\x7E]/g, '').trim();
            if (!clean || clean.length <= 2) return;
            const data = JSON.stringify({ text: clean, project: this.project });
            const url = new URL('/speak', TTS_URL);
            const req = http.request({
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
                timeout: 2000,
            }, () => {});
            req.on('error', () => {});
            req.write(data);
            req.end();
        } catch (e) { /* fire and forget */ }
    }

    userInput(text) {
        this.echoPending += text;
    }

    feed(rawData) {
        if (this.muted) return;
        let plain = rawData.replace(ANSI_RE, '');
        if (!plain.trim()) return;

        // Echo matching
        if (this.echoPending) {
            const remaining = this._consumeEcho(plain);
            if (!remaining) return;
            plain = remaining;
        }

        this.buffer += plain;

        while (this.buffer.includes('\n')) {
            const idx = this.buffer.indexOf('\n');
            const line = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 1);
            if (this._shouldSkip(line)) continue;
            const cleaned = this._cleanMarkdown(line);
            if (!cleaned) continue;
            const parts = cleaned.split(/(?<=[.!?:])(?:\s+|\n)/);
            for (const sentence of parts) {
                const s = sentence.trim();
                if (!s || s.length <= 2) continue;
                const key = s.slice(0, 120);
                if (this.sentencesSent.has(key)) continue;
                this.sentencesSent.add(key);
                this._sendToTts(s);
            }
        }
    }

    _consumeEcho(output) {
        const outNorm = output.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const echoNorm = this.echoPending.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        let matchLen = 0;
        let ei = 0, oi = 0;
        while (ei < echoNorm.length && oi < outNorm.length) {
            if (echoNorm[ei] === outNorm[oi]) {
                ei++; oi++;
                matchLen = oi;
            } else if (' \t\n'.includes(outNorm[oi])) {
                oi++;
            } else if (' \t\n'.includes(echoNorm[ei])) {
                ei++;
            } else {
                break;
            }
        }

        if (matchLen === 0) {
            this.echoPending = '';
            return output;
        }

        this.echoPending = echoNorm.slice(ei);
        if (matchLen >= outNorm.length) return '';
        return output.slice(matchLen);
    }

    feedClean(text) {
        if (this.muted) return;
        // Reset dedup for each new message — prevents stale keys from eating sentences
        this.sentencesSent = new Set();
        const lines = text.split('\n');
        for (const line of lines) {
            const cleaned = this._cleanMarkdown(line);
            if (!cleaned || cleaned.length <= 3) continue;
            // Send each line as a chunk — don't split on punctuation (causes drops)
            const key = cleaned.slice(0, 120);
            if (this.sentencesSent.has(key)) continue;
            this.sentencesSent.add(key);
            this._sendToTts(cleaned);
        }
    }
}

// ---------------------------------------------------------------------------
//  PTY Reader
// ---------------------------------------------------------------------------

function startReader(sessionKey) {
    const entry = activeTerminals[sessionKey];
    const ptyProc = entry.pty;
    let ttsTap = null;

    if (sessionKey.endsWith(':claude')) {
        const proj = sessionKey.split(':')[0];
        ttsTap = new TTSTap(proj.replace(/ /g, '-'));
        entry.ttsTap = ttsTap;
    }

    // JSONL file watcher for clean text extraction (mobile + TTS)
    if (sessionKey.endsWith(':claude')) {
        const proj = sessionKey.split(':')[0];
        const projectPath = path.join(PROJECTS_DIR, proj);
        const claudeProjKey = projectPath.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-').replace(/ /g, '-').replace(/ /g, '-');
        const convDir = path.join(CLAUDE_PROJECTS_DIR, claudeProjKey);

        // Find and watch the latest JSONL file
        let jsonlWatcher = null;
        let jsonlPos = 0;
        let jsonlPath = null;

        function findLatestJsonl() {
            try {
                if (!fs.existsSync(convDir)) return null;
                const files = fs.readdirSync(convDir).filter(f => f.endsWith('.jsonl'));
                if (files.length === 0) return null;
                let latest = null, latestMtime = 0;
                for (const f of files) {
                    const fp = path.join(convDir, f);
                    const mt = fs.statSync(fp).mtimeMs;
                    if (mt > latestMtime) { latestMtime = mt; latest = fp; }
                }
                return latest;
            } catch (e) { return null; }
        }

        function readNewLines() {
            if (!jsonlPath || !fs.existsSync(jsonlPath)) return;
            try {
                const stat = fs.statSync(jsonlPath);
                if (stat.size <= jsonlPos) return;
                const fd = fs.openSync(jsonlPath, 'r');
                const buf = Buffer.alloc(stat.size - jsonlPos);
                fs.readSync(fd, buf, 0, buf.length, jsonlPos);
                fs.closeSync(fd);
                jsonlPos = stat.size;

                const newData = buf.toString('utf-8');
                const lines = newData.split('\n').filter(l => l.trim());
                for (const line of lines) {
                    try {
                        const obj = JSON.parse(line);
                        const msg = parseJsonlEntry(obj);
                        if (msg) {
                            entry.isThinking = isThinking;
                            for (const ws of entry.subscribers) {
                                try {
                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify(msg));
                                    }
                                } catch (e) { /* ignore */ }
                            }
                            if (msg.type === 'chat' && msg.role === 'assistant' && ttsTap && !ttsTap.muted) {
                                try {
                                    claimProject(entry.name || sessionKey.split(':')[0]);
                                    ttsTap.feedClean(msg.text);
                                } catch (e) { /* ignore */ }
                            }
                        }
                    } catch (e) { /* skip unparseable lines */ }
                }
            } catch (e) { /* ignore read errors */ }
        }

        let isThinking = false;
        let insideAgent = false; // Track when we're processing agent tool results

        function parseJsonlEntry(obj) {
            const entryType = obj.type;
            if (entryType === 'user') {
                isThinking = true; // User sent message — Claude will start thinking
                insideAgent = false; // Reset agent tracking on new user message
                const content = obj.message?.content;
                let text = '';
                if (Array.isArray(content)) {
                    for (const c of content) {
                        if (c.type === 'text') text += c.text;
                    }
                } else if (typeof content === 'string') {
                    text = content;
                }
                if (text.trim()) {
                    // Skip system notifications that leak into JSONL
                    if (/^<task-notification|^<system-reminder/.test(text.trim())) return null;
                    return { type: 'chat', role: 'user', text: text.trim() };
                }
            } else if (entryType === 'assistant') {
                const content = obj.message?.content;
                if (!Array.isArray(content)) return null;
                let text = '';
                const tools = [];
                let hasThinking = false;
                let agentCount = 0;
                for (const c of content) {
                    if (c.type === 'text') text += c.text;
                    else if (c.type === 'tool_use') {
                        tools.push(c.name);
                        if (c.name === 'Agent') agentCount++;
                    }
                    else if (c.type === 'thinking') hasThinking = true;
                }
                // Extract token/context info
                const usage = obj.message?.usage || {};
                const outputTokens = usage.output_tokens || 0;
                const contextUsed = usage.cache_read_input_tokens || 0;
                const tokenInfo = { outputTokens, contextUsed };

                if (hasThinking && !text.trim() && tools.length === 0) {
                    isThinking = true;
                    return { type: 'thinking', ...tokenInfo };
                }
                if (text.trim()) {
                    isThinking = false;
                    // Skip short system fragments that aren't real conversation
                    const t = text.trim();
                    if (/^No response requested\.?$/i.test(t)) return null;
                    if (t.length < 5 && !/[a-z]/i.test(t)) return null;
                    const isAgentRelated = insideAgent && tools.length === 0;
                    if (agentCount > 0) insideAgent = true;
                    else insideAgent = false;
                    if (tools.length > 0) {
                        return { type: 'chat', role: 'assistant', text: text.trim(), tools, agents: agentCount, fromAgent: isAgentRelated, ...tokenInfo };
                    }
                    return { type: 'chat', role: 'assistant', text: text.trim(), fromAgent: isAgentRelated, ...tokenInfo };
                }
                if (tools.length > 0) {
                    isThinking = true;
                    if (agentCount > 0) insideAgent = true;
                    return { type: 'tool', tools, agents: agentCount, ...tokenInfo };
                }
            }
            return null;
        }

        // Start watching after a short delay (let Claude start first)
        setTimeout(() => {
            jsonlPath = findLatestJsonl();
            if (jsonlPath) {
                // Store on entry so history API can use the same file
                entry.jsonlPath = jsonlPath;
                // Start at end of file (don't replay history)
                jsonlPos = fs.statSync(jsonlPath).size;
                log(`Watching JSONL: ${jsonlPath}`);

                // Watch for changes
                jsonlWatcher = fs.watch(jsonlPath, () => readNewLines());

                // Poll periodically in case fs.watch misses events
                entry._jsonlInterval = setInterval(() => {
                    readNewLines();
                }, 1000);
            }

            // Expose switch function for session resume
            entry._switchJsonl = (newPath) => {
                if (jsonlWatcher) jsonlWatcher.close();
                jsonlPath = newPath;
                jsonlPos = fs.statSync(newPath).size; // Start at end
                entry.jsonlPath = newPath;
                jsonlWatcher = fs.watch(jsonlPath, () => readNewLines());
                if (ttsTap) ttsTap.sentencesSent = new Set(); // Reset dedup for new session
                log(`Watcher switched to: ${newPath}`);
            };
        }, 3000);

        // Cleanup on PTY exit
        const origOnExit = ptyProc.onExit;
        ptyProc.onExit(() => {
            if (jsonlWatcher) jsonlWatcher.close();
            if (entry._jsonlInterval) clearInterval(entry._jsonlInterval);
        });
    }

    ptyProc.onData((data) => {
        // Broadcast raw PTY data to all WebSocket subscribers (for xterm.js on desktop)
        const dead = [];
        for (const ws of entry.subscribers) {
            try {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'output', data: data }));
                } else {
                    dead.push(ws);
                }
            } catch (e) {
                dead.push(ws);
            }
        }
        for (const ws of dead) {
            entry.subscribers.delete(ws);
        }
        // PTY feed disabled — too much terminal UI noise (spinners, status bars, tips)
        // TTS handled by feedClean via JSONL parser instead
    });

    ptyProc.onExit(() => {
        log(`PTY exited: ${sessionKey}`);
        if (activeTerminals[sessionKey]) {
            activeTerminals[sessionKey].pty = null;
        }
        // Release TTS claim for this project
        if (sessionKey.endsWith(':claude')) {
            const proj = sessionKey.split(':')[0];
            releaseProject(proj);
        }
    });
}

// ---------------------------------------------------------------------------
//  Projects
// ---------------------------------------------------------------------------

function getProjects() {
    const projects = [];
    let entries;
    try {
        entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    } catch (e) {
        return projects;
    }

    const names = entries
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => d.name)
        .sort();

    for (const name of names) {
        const projPath = path.join(PROJECTS_DIR, name);
        const hasGit = fs.existsSync(path.join(projPath, '.git'));
        const hasClaude = fs.existsSync(path.join(projPath, 'CLAUDE.md'));

        // Description from README.md
        let desc = '';
        const readmePath = path.join(projPath, 'README.md');
        if (fs.existsSync(readmePath)) {
            try {
                const lines = fs.readFileSync(readmePath, 'utf-8').split('\n');
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!') || trimmed.startsWith('[')) continue;
                    desc = trimmed.slice(0, 80);
                    break;
                }
            } catch (e) { /* ignore */ }
        }

        const claudeKey = `${name}:claude`;
        const shellKey = `${name}:shell`;
        const claudeLive = !!(activeTerminals[claudeKey]?.pty);
        const shellLive = !!(activeTerminals[shellKey]?.pty);
        const isLive = claudeLive;

        // Check Claude conversation files
        const claudeProjKey = projPath.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-');
        const convDir = path.join(CLAUDE_PROJECTS_DIR, claudeProjKey);
        let convCount = 0;
        if (fs.existsSync(convDir)) {
            try {
                convCount = fs.readdirSync(convDir).filter(f => f.endsWith('.jsonl')).length;
            } catch (e) { /* ignore */ }
        }
        const hasConversations = convCount > 0;

        let subCount = 0;
        if (claudeLive) subCount += activeTerminals[claudeKey].subscribers.size;
        if (shellLive) subCount += activeTerminals[shellKey].subscribers.size;

        projects.push({
            name, path: projPath, git: hasGit, claude: hasClaude,
            live: isLive, claude_live: claudeLive, shell_live: shellLive,
            can_continue: hasConversations && !claudeLive,
            conv_count: convCount, subscribers: subCount, desc,
        });
    }
    return projects;
}

// ---------------------------------------------------------------------------
//  Multipart Parser (minimal, for upload)
// ---------------------------------------------------------------------------

function parseMultipart(body, boundary) {
    const fields = {};
    const sep = Buffer.from(`--${boundary}`);
    const parts = [];

    // Split by boundary
    let start = 0;
    while (true) {
        const idx = body.indexOf(sep, start);
        if (idx === -1) break;
        if (start > 0) {
            // Everything between previous boundary end and this boundary start (minus trailing \r\n)
            let partData = body.slice(start, idx);
            // Strip leading \r\n
            if (partData[0] === 0x0d && partData[1] === 0x0a) partData = partData.slice(2);
            // Strip trailing \r\n
            if (partData[partData.length - 2] === 0x0d && partData[partData.length - 1] === 0x0a) {
                partData = partData.slice(0, partData.length - 2);
            }
            parts.push(partData);
        }
        start = idx + sep.length;
        // Check for -- (end marker)
        if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    }

    for (const part of parts) {
        // Split headers from body by \r\n\r\n
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headerStr = part.slice(0, headerEnd).toString('utf-8');
        const partBody = part.slice(headerEnd + 4);

        const nameMatch = headerStr.match(/name="([^"]+)"/);
        if (!nameMatch) continue;
        const fieldName = nameMatch[1];
        const filenameMatch = headerStr.match(/filename="([^"]*)"/);

        if (filenameMatch) {
            fields[fieldName] = { filename: filenameMatch[1], data: partBody };
        } else {
            fields[fieldName] = partBody.toString('utf-8').trim();
        }
    }
    return fields;
}

// ---------------------------------------------------------------------------
//  HTTP Request Helpers
// ---------------------------------------------------------------------------

function sendJson(res, data, status = 200) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function log(msg) {
    const now = new Date();
    const ts = now.toTimeString().slice(0, 8);
    console.log(`${ts} ${msg}`);
}

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
//  Route Handlers
// ---------------------------------------------------------------------------

function handleIndex(req, res) {
    const indexPath = path.join(STATIC_DIR, 'index.html');
    try {
        const html = fs.readFileSync(indexPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(html);
    } catch (e) {
        res.writeHead(404);
        res.end('Not found');
    }
}

function handleStatic(req, res, filename) {
    const filepath = path.join(STATIC_DIR, filename);
    // Prevent directory traversal
    if (!filepath.startsWith(STATIC_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    try {
        const content = fs.readFileSync(filepath, 'utf-8');
        const ext = path.extname(filename).toLowerCase();
        const contentTypes = {
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.html': 'text/html',
            '.json': 'application/json',
            '.png': 'image/png',
            '.ico': 'image/x-icon',
        };
        const ct = contentTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
        res.end(content);
    } catch (e) {
        res.writeHead(404);
        res.end('Not found');
    }
}

function handleApiProjects(req, res) {
    const projects = getProjects();
    sendJson(res, projects);
}

async function handleApiKill(req, res) {
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body.toString()); } catch (e) { sendJson(res, { error: 'invalid json' }, 400); return; }

    const name = data.name || '';
    const killed = [];

    for (const keyType of ['claude', 'shell']) {
        const key = `${name}:${keyType}`;
        if (activeTerminals[key]) {
            const entry = activeTerminals[key];
            if (entry.pty) {
                try { entry.pty.kill(); } catch (e) { /* ignore */ }
                killed.push(keyType);
                if (keyType === 'claude') releaseProject(name);
            }
            // Notify subscribers
            for (const ws of entry.subscribers) {
                try {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'status', data: 'killed' }));
                        ws.close();
                    }
                } catch (e) { /* ignore */ }
            }
            entry.subscribers.clear();
            entry.pty = null;
        }
    }

    log(`Killed: ${name} (${killed.length ? killed.join(', ') : 'nothing running'})`);
    sendJson(res, { killed });
}

function handleApiSessions(req, res) {
    const url = new URL(req.url, 'https://localhost');
    const name = url.searchParams.get('name') || '';
    const projectPath = path.join(PROJECTS_DIR, name);

    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        sendJson(res, { sessions: [] });
        return;
    }

    const claudeProjKey = projectPath.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-').replace(/ /g, '-');
    const convDir = path.join(CLAUDE_PROJECTS_DIR, claudeProjKey);

    if (!fs.existsSync(convDir) || !fs.statSync(convDir).isDirectory()) {
        sendJson(res, { sessions: [] });
        return;
    }

    const sessionsList = [];
    const starsFile = path.join(projectPath, '.tterm_session_stars.json');
    let starredSessions = [];
    try { starredSessions = fs.existsSync(starsFile) ? JSON.parse(fs.readFileSync(starsFile, 'utf-8')) : []; } catch(e) {}
    const files = fs.readdirSync(convDir).filter(f => f.endsWith('.jsonl'));

    for (const fname of files) {
        const fpath = path.join(convDir, fname);
        const sid = fname.replace('.jsonl', '');
        const mtime = fs.statSync(fpath).mtimeMs / 1000;
        const dt = new Date(mtime * 1000);

        // Get first real user message as preview + total tokens
        let preview = '';
        let totalTokens = 0;
        try {
            const content = fs.readFileSync(fpath, 'utf-8');
            for (const line of content.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const obj = JSON.parse(line);
                    // Count tokens from usage data
                    const usage = obj.message?.usage;
                    if (usage) {
                        totalTokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);
                    }
                    if (!preview && obj.type === 'user') {
                        let text = '';
                        const msgContent = obj.message?.content || '';
                        if (Array.isArray(msgContent)) {
                            for (const c of msgContent) {
                                if (c && typeof c === 'object' && c.type === 'text') {
                                    text = c.text;
                                    break;
                                }
                            }
                        } else if (typeof msgContent === 'string') {
                            text = msgContent;
                        }
                        // Strip XML-like tags and trim
                        text = text.replace(/<[^>]+>/g, '').trim();
                        if (text.length > 2) {
                            preview = text.slice(0, 100).replace(/\n/g, ' ');
                        }
                    }
                } catch (e) { /* skip malformed lines */ }
            }
        } catch (e) { /* ignore */ }

        const dd = String(dt.getDate()).padStart(2, '0');
        const mm = String(dt.getMonth() + 1).padStart(2, '0');
        const yy = String(dt.getFullYear()).slice(-2);
        const hh = String(dt.getHours()).padStart(2, '0');
        const min = String(dt.getMinutes()).padStart(2, '0');

        sessionsList.push({
            id: sid,
            date: `${dd}-${mm}-${yy}`,
            time: `${hh}:${min}`,
            timestamp: mtime,
            preview,
            tokens: totalTokens,
            starred: starredSessions.includes(sid),
        });
    }

    sessionsList.sort((a, b) => b.timestamp - a.timestamp);
    // Include which session is currently active (locked JSONL)
    const sessionKey = name + ':claude';
    let activeSession = '';
    if (activeTerminals[sessionKey] && activeTerminals[sessionKey].jsonlPath) {
        activeSession = path.basename(activeTerminals[sessionKey].jsonlPath, '.jsonl');
    }
    sendJson(res, { sessions: sessionsList, activeSession });
}

function handleApiConversation(req, res) {
    const url = new URL(req.url, 'https://localhost');
    const name = url.searchParams.get('name') || '';
    const projectPath = path.join(PROJECTS_DIR, name);

    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        sendJson(res, []);
        return;
    }

    const claudeProjKey = projectPath.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-').replace(/ /g, '-');
    const convDir = path.join(CLAUDE_PROJECTS_DIR, claudeProjKey);

    if (!fs.existsSync(convDir) || !fs.statSync(convDir).isDirectory()) {
        sendJson(res, []);
        return;
    }

    // Use the locked JSONL path from the active session if available
    let latest = null;
    const sessionKey = name + ':claude';
    if (activeTerminals[sessionKey] && activeTerminals[sessionKey].jsonlPath) {
        latest = activeTerminals[sessionKey].jsonlPath;
    } else {
        // Fallback: find most recent JSONL
        let latestMtime = 0;
        const files = fs.readdirSync(convDir).filter(f => f.endsWith('.jsonl'));
        for (const fname of files) {
            const fpath = path.join(convDir, fname);
            const mt = fs.statSync(fpath).mtimeMs;
            if (mt > latestMtime) {
                latestMtime = mt;
                latest = fpath;
            }
        }
    }

    if (!latest) {
        sendJson(res, []);
        return;
    }

    const messages = [];
    try {
        const content = fs.readFileSync(latest, 'utf-8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
                const obj = JSON.parse(line);
                const entryType = obj.type || '';

                if (entryType === 'user') {
                    const msgContent = obj.message?.content || '';
                    let text = '';
                    if (Array.isArray(msgContent)) {
                        for (const c of msgContent) {
                            if (c && typeof c === 'object' && c.type === 'text') {
                                text += c.text + '\n';
                            }
                        }
                    } else if (typeof msgContent === 'string') {
                        text = msgContent;
                    }
                    if (text.trim()) {
                        const ts = obj.timestamp ? new Date(obj.timestamp) : null;
                        const time = ts ? ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                        const rawTs = ts ? ts.getTime() : 0;
                        messages.push({ role: 'user', text: text.trim(), time, ts: rawTs });
                    }
                } else if (entryType === 'assistant') {
                    const msgContent = obj.message?.content || [];
                    let text = '';
                    const contentArr = Array.isArray(msgContent) ? msgContent : [];
                    for (const c of contentArr) {
                        if (c && typeof c === 'object') {
                            if (c.type === 'text') {
                                text += c.text + '\n';
                            } else if (c.type === 'tool_use') {
                                messages.push({
                                    type: 'tool_use',
                                    name: c.name || '',
                                    summary: '',
                                });
                            }
                        }
                    }
                    if (text.trim()) {
                        const ts = obj.timestamp ? new Date(obj.timestamp) : null;
                        const time = ts ? ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                        const rawTs = ts ? ts.getTime() : 0;
                        messages.push({ role: 'assistant', text: text.trim(), time, ts: rawTs });
                    }
                }
            } catch (e) { /* skip malformed lines */ }
        }
    } catch (e) { /* ignore */ }

    sendJson(res, messages.slice(-200));
}

async function handleApiNewProject(req, res) {
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body.toString()); } catch (e) { sendJson(res, { error: 'invalid json' }, 400); return; }

    const name = (data.name || '').trim();
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
        sendJson(res, { error: 'Invalid project name' }, 400);
        return;
    }

    const projPath = path.join(PROJECTS_DIR, name);
    if (fs.existsSync(projPath)) {
        sendJson(res, { error: 'Project already exists' }, 400);
        return;
    }

    fs.mkdirSync(projPath, { recursive: true });
    log(`Created project: ${name}`);
    sendJson(res, { created: name });
}

function handleClaudeLogo(req, res) {
    const logoPath = path.join(BASE_DIR, 'claude_logo.png');
    if (fs.existsSync(logoPath)) {
        const data = fs.readFileSync(logoPath);
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=86400',
            'Content-Length': data.length,
        });
        res.end(data);
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
}

async function handleUpload(req, res) {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
        sendJson(res, { error: 'no boundary' }, 400);
        return;
    }
    const boundary = boundaryMatch[1].replace(/;.*$/, '').trim();

    const body = await readBody(req);
    const fields = parseMultipart(body, boundary);

    if (!fields.file || !fields.file.data) {
        sendJson(res, { error: 'no file' }, 400);
        return;
    }

    const project = typeof fields.project === 'string' ? fields.project : null;
    const subfolder = typeof fields.subfolder === 'string' ? fields.subfolder : null;

    let uploadDir;
    if (project) {
        uploadDir = path.join(PROJECTS_DIR, project, '.screenshots');
    } else {
        uploadDir = path.join(PROJECTS_DIR, '.tayterm_uploads');
    }
    if (subfolder) {
        uploadDir = path.join(uploadDir, subfolder);
    }
    fs.mkdirSync(uploadDir, { recursive: true });

    let filename = fields.file.filename || `paste_${Date.now()}.png`;
    filename = path.basename(filename);
    let savePath = path.join(uploadDir, filename);

    if (fs.existsSync(savePath)) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        filename = `${base}_${Date.now()}${ext}`;
        savePath = path.join(uploadDir, filename);
    }

    fs.writeFileSync(savePath, fields.file.data);
    const size = fs.statSync(savePath).size;
    log(`Upload: ${savePath} (${size} bytes)`);
    const relPath = path.relative(PROJECTS_DIR, savePath).replace(/\\/g, '/');
    const url = '/screenshots/' + encodeURI(relPath);
    sendJson(res, { path: savePath, url });
}

// ---------------------------------------------------------------------------
//  WebSocket Handler
// ---------------------------------------------------------------------------

function handleWebSocket(ws, req) {
    const url = new URL(req.url, 'https://localhost');
    const projectName = url.searchParams.get('project') || '';
    const autoClaude = url.searchParams.get('claude') === '1';
    const continueClaude = url.searchParams.get('continue') === '1';
    const resumeId = url.searchParams.get('resume') || '';
    const projectPath = path.join(PROJECTS_DIR, projectName);
    const sessionType = (autoClaude || continueClaude || resumeId) ? 'claude' : 'shell';
    const sessionKey = `${projectName}:${sessionType}`;
    const remoteAddr = req.socket.remoteAddress || 'unknown';

    if (!projectName || !fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        ws.send(JSON.stringify({ type: 'error', data: `Project not found: ${projectName}` }));
        ws.close();
        return;
    }

    // Check for existing live PTY
    let isReattach = false;
    if (activeTerminals[sessionKey]?.pty) {
        isReattach = true;
    }

    let entry;
    if (isReattach) {
        log(`Reattach: ${sessionKey} — ${remoteAddr}`);
        ws.send(JSON.stringify({ type: 'status', data: `reattached to live ${sessionType} PTY` }));
        entry = activeTerminals[sessionKey];
    } else {
        // Build env: remove Claude-related vars
        const env = { ...process.env };
        for (const v of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION',
                         'CLAUDE_CODE_ENTRY_POINT', 'CLAUDE_CODE_PARENT']) {
            delete env[v];
        }
        env.TERM = 'xterm-256color';
        env.COLORTERM = 'truecolor';

        // ConPTY (default) for correct true-color support
        const ptyProc = pty.spawn('powershell.exe', [], {
            name: 'xterm-256color',
            cols: 120,
            rows: 30,
            cwd: projectPath,
            env,
            conptyInheritCursor: true,
        });

        entry = { pty: ptyProc, subscribers: new Set(), ttsTap: null };
        activeTerminals[sessionKey] = entry;
        startReader(sessionKey);
        log(`New PTY: ${sessionKey} — ${remoteAddr}`);
        ws.send(JSON.stringify({ type: 'status', data: `new ${sessionType} PTY started` }));

        // Don't claim TTS at session creation — claim happens dynamically
        // when feedClean actually fires (only unmuted sessions with active TTSTap)

        // Launch claude if requested (after delay for PowerShell to fully init)
        if (autoClaude || continueClaude || resumeId) {
            let cmd = CLAUDE_CMD;
            if (continueClaude) cmd += ' --continue';
            else if (resumeId) cmd += ' --resume ' + resumeId;
            log(`Will launch: ${cmd}`);
            setTimeout(() => {
                if (entry.pty) {
                    log(`Sending to PTY: ${cmd}`);
                    entry.pty.write(cmd + '\r');
                }
            }, 1500);
        }
    }

    // Subscribe
    entry.subscribers.add(ws);

    ws.on('message', (raw) => {
        try {
            const payload = JSON.parse(raw.toString());
            if (payload.type === 'input') {
                if (entry.pty) {
                    entry.pty.write(payload.data);
                    if (entry.ttsTap) {
                        entry.ttsTap.userInput(payload.data);
                    }
                }
            } else if (payload.type === 'resize') {
                if (entry.pty) {
                    entry.pty.resize(payload.cols, payload.rows);
                }
            }
        } catch (e) { /* ignore */ }
    });

    ws.on('close', () => {
        entry.subscribers.delete(ws);
        log(`Browser detached: ${sessionKey} — ${remoteAddr} (${entry.subscribers.size} still connected)`);
    });

    ws.on('error', () => {
        entry.subscribers.delete(ws);
    });
}

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
    const authPaths = ['/auth/', '/login', '/approve', '/do-approve', '/check', '/register', '/admin'];
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
        if (req.method === 'GET' && pathname === '/') {
            handleIndex(req, res);
        } else if (req.method === 'GET' && pathname.startsWith('/static/')) {
            const filename = pathname.slice('/static/'.length);
            handleStatic(req, res, filename);
        } else if (req.method === 'GET' && pathname === '/api/projects') {
            handleApiProjects(req, res);
        } else if (req.method === 'POST' && pathname === '/api/kill') {
            await handleApiKill(req, res);
        } else if (req.method === 'GET' && pathname === '/api/sessions') {
            handleApiSessions(req, res);
        } else if (req.method === 'GET' && pathname === '/api/load-session') {
            // Switch which JSONL the active session reads from
            const u = new URL(req.url, 'https://localhost');
            const sName = u.searchParams.get('name') || '';
            const sessionFile = u.searchParams.get('session') || '';
            const sKey = sName + ':claude';
            if (activeTerminals[sKey] && sessionFile) {
                const projPath = path.join(PROJECTS_DIR, sName);
                const cpk = projPath.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-').replace(/ /g, '-');
                const newPath = path.join(CLAUDE_PROJECTS_DIR, cpk, sessionFile + '.jsonl');
                if (fs.existsSync(newPath)) {
                    activeTerminals[sKey].jsonlPath = newPath;
                    // Also switch the live JSONL watcher
                    if (activeTerminals[sKey]._switchJsonl) {
                        activeTerminals[sKey]._switchJsonl(newPath);
                    }
                    log(`Switched session JSONL for ${sName}: ${sessionFile}`);
                }
            }
            sendJson(res, { ok: true });
        } else if (req.method === 'DELETE' && pathname === '/api/session') {
            const body = await readBody(req);
            const { name, session } = JSON.parse(body.toString('utf-8'));
            const projPath = path.join(PROJECTS_DIR, name);
            const cpk = projPath.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-').replace(/ /g, '-');
            const filePath = path.join(CLAUDE_PROJECTS_DIR, cpk, session + '.jsonl');
            // Don't delete the currently active session
            const sKey = name + ':claude';
            if (activeTerminals[sKey] && activeTerminals[sKey].jsonlPath === filePath) {
                sendJson(res, { error: 'Cannot delete active session' }, 400);
                return;
            }
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    log(`Deleted session: ${session} for ${name}`);
                    sendJson(res, { ok: true });
                } else {
                    sendJson(res, { error: 'Session not found' }, 404);
                }
            } catch(e) { sendJson(res, { error: e.message }, 500); }
        } else if (req.method === 'POST' && pathname === '/api/session-star') {
            const body = await readBody(req);
            const { name, session, starred } = JSON.parse(body.toString('utf-8'));
            const projPath = path.join(PROJECTS_DIR, name);
            const starsFile = path.join(projPath, '.tterm_session_stars.json');
            try {
                const existing = fs.existsSync(starsFile) ? JSON.parse(fs.readFileSync(starsFile, 'utf-8')) : [];
                const idx = existing.indexOf(session);
                if (starred && idx < 0) existing.push(session);
                else if (!starred && idx >= 0) existing.splice(idx, 1);
                fs.writeFileSync(starsFile, JSON.stringify(existing, null, 2));
                sendJson(res, { ok: true, starred: !!starred });
            } catch(e) { sendJson(res, { error: e.message }, 500); }
        } else if (req.method === 'GET' && pathname === '/api/conversation') {
            handleApiConversation(req, res);
        } else if (req.method === 'POST' && pathname === '/api/new-project') {
            await handleApiNewProject(req, res);
        } else if (req.method === 'GET' && pathname === '/api/claude-logo') {
            handleClaudeLogo(req, res);
        } else if (req.method === 'GET' && pathname === '/api/chat-media') {
            // Get saved images/media for a project
            const name = new URL(req.url, 'https://localhost').searchParams.get('name') || '';
            const mediaFile = path.join(PROJECTS_DIR, name, '.tterm_media.json');
            try {
                const data = fs.existsSync(mediaFile) ? JSON.parse(fs.readFileSync(mediaFile, 'utf-8')) : [];
                sendJson(res, data);
            } catch(e) { sendJson(res, []); }
        } else if (req.method === 'POST' && pathname === '/api/chat-media') {
            // Save an image/media reference
            const body = await readBody(req);
            const { name, media } = JSON.parse(body.toString('utf-8'));
            const mediaFile = path.join(PROJECTS_DIR, name, '.tterm_media.json');
            try {
                const existing = fs.existsSync(mediaFile) ? JSON.parse(fs.readFileSync(mediaFile, 'utf-8')) : [];
                existing.push(media);
                fs.writeFileSync(mediaFile, JSON.stringify(existing, null, 2));
                sendJson(res, { ok: true });
            } catch(e) { sendJson(res, { error: e.message }, 500); }
        } else if (req.method === 'DELETE' && pathname === '/api/chat-media') {
            const body = await readBody(req);
            const { name, ts } = JSON.parse(body.toString('utf-8'));
            const mediaFile = path.join(PROJECTS_DIR, name, '.tterm_media.json');
            try {
                const existing = fs.existsSync(mediaFile) ? JSON.parse(fs.readFileSync(mediaFile, 'utf-8')) : [];
                const filtered = existing.filter(m => m.ts !== ts);
                fs.writeFileSync(mediaFile, JSON.stringify(filtered, null, 2));
                sendJson(res, { ok: true, removed: existing.length - filtered.length });
            } catch(e) { sendJson(res, { error: e.message }, 500); }
        } else if (req.method === 'GET' && pathname === '/api/stars') {
            // Get starred messages for a project
            const name = new URL(req.url, 'https://localhost').searchParams.get('name') || '';
            const starsFile = path.join(PROJECTS_DIR, name, '.tterm_stars.json');
            try {
                const data = fs.existsSync(starsFile) ? JSON.parse(fs.readFileSync(starsFile, 'utf-8')) : [];
                sendJson(res, data);
            } catch(e) { sendJson(res, []); }
        } else if (req.method === 'POST' && pathname === '/api/stars') {
            // Star/unstar a message
            const body = await readBody(req);
            const { name, star } = JSON.parse(body.toString('utf-8'));
            const starsFile = path.join(PROJECTS_DIR, name, '.tterm_stars.json');
            try {
                const existing = fs.existsSync(starsFile) ? JSON.parse(fs.readFileSync(starsFile, 'utf-8')) : [];
                // Toggle — remove if exists, add if not
                const idx = existing.findIndex(s => s.text === star.text && s.time === star.time);
                if (idx >= 0) existing.splice(idx, 1);
                else existing.push(star);
                fs.writeFileSync(starsFile, JSON.stringify(existing, null, 2));
                sendJson(res, { ok: true, starred: idx < 0 });
            } catch(e) { sendJson(res, { error: e.message }, 500); }
        } else if (req.method === 'GET' && pathname === '/api/notes') {
            const name = new URL(req.url, 'https://localhost').searchParams.get('name') || '';
            const notesFile = name ? path.join(PROJECTS_DIR, name, '.tterm_notes.json') : path.join(__dirname, '.tterm_notes.json');
            try {
                const data = fs.existsSync(notesFile) ? JSON.parse(fs.readFileSync(notesFile, 'utf-8')) : [];
                sendJson(res, data);
            } catch(e) { sendJson(res, []); }
        } else if (req.method === 'POST' && pathname === '/api/notes') {
            const body = await readBody(req);
            const { name, note } = JSON.parse(body.toString('utf-8'));
            const notesFile = name ? path.join(PROJECTS_DIR, name, '.tterm_notes.json') : path.join(__dirname, '.tterm_notes.json');
            try {
                const existing = fs.existsSync(notesFile) ? JSON.parse(fs.readFileSync(notesFile, 'utf-8')) : [];
                existing.push(note);
                fs.writeFileSync(notesFile, JSON.stringify(existing, null, 2));
                sendJson(res, { ok: true });
            } catch(e) { sendJson(res, { error: e.message }, 500); }
        } else if (req.method === 'DELETE' && pathname === '/api/notes') {
            const body = await readBody(req);
            const { name, ts } = JSON.parse(body.toString('utf-8'));
            const notesFile = name ? path.join(PROJECTS_DIR, name, '.tterm_notes.json') : path.join(__dirname, '.tterm_notes.json');
            try {
                const existing = fs.existsSync(notesFile) ? JSON.parse(fs.readFileSync(notesFile, 'utf-8')) : [];
                const filtered = existing.filter(n => n.ts !== ts);
                fs.writeFileSync(notesFile, JSON.stringify(filtered, null, 2));
                sendJson(res, { ok: true });
            } catch(e) { sendJson(res, { error: e.message }, 500); }
        } else if (req.method === 'GET' && pathname === '/api/stats') {
            const name = new URL(req.url, 'https://localhost').searchParams.get('name') || '';
            const projectPath = path.join(PROJECTS_DIR, name);
            const claudeProjKey = projectPath.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-').replace(/ /g, '-');
            const convDir = path.join(CLAUDE_PROJECTS_DIR, claudeProjKey);
            try {
                if (!fs.existsSync(convDir)) { sendJson(res, {}); return; }
                const files = fs.readdirSync(convDir).filter(f => f.endsWith('.jsonl'));
                if (files.length === 0) { sendJson(res, {}); return; }
                let latest = null, latestMtime = 0;
                for (const f of files) {
                    const fp = path.join(convDir, f);
                    const mt = fs.statSync(fp).mtimeMs;
                    if (mt > latestMtime) { latestMtime = mt; latest = fp; }
                }
                const content = fs.readFileSync(latest, 'utf-8');
                const lines = content.split('\n').filter(l => l.trim());
                let lastContext = 0, totalOutput = 0, model = '';
                for (const line of lines) {
                    try {
                        const obj = JSON.parse(line);
                        if (obj.type === 'assistant' && obj.message?.usage) {
                            const u = obj.message.usage;
                            lastContext = u.cache_read_input_tokens || u.input_tokens || lastContext;
                            totalOutput += u.output_tokens || 0;
                        }
                        if (obj.type === 'assistant' && obj.message?.model) {
                            model = obj.message.model;
                        }
                    } catch(e) {}
                }
                const mediaFile = path.join(PROJECTS_DIR, name, '.tterm_media.json');
                let imageCount = 0, imageBytes = 0;
                try {
                    if (fs.existsSync(mediaFile)) {
                        const media = JSON.parse(fs.readFileSync(mediaFile, 'utf-8'));
                        imageCount = media.length;
                        imageBytes = media.reduce((sum, m) => sum + (m.size || 0), 0);
                    }
                } catch(e) {}
                sendJson(res, { context: lastContext, outputTokens: totalOutput, model, imageCount, imageBytes });
            } catch(e) { sendJson(res, {}); }
        } else if (req.method === 'POST' && pathname === '/api/mute') {
            const body = await readBody(req);
            const { name, muted } = JSON.parse(body.toString('utf-8'));
            const key = name + ':claude';
            if (activeTerminals[key] && activeTerminals[key].ttsTap) {
                activeTerminals[key].ttsTap.muted = !!muted;
                if (muted) releaseProject(name);
                log(`TTS ${muted ? 'muted' : 'unmuted'}: ${name}`);
            }
            sendJson(res, { ok: true, muted: !!muted });
        } else if (req.method === 'GET' && pathname === '/api/favorites') {
            try {
                const favs = fs.existsSync(FAVORITES_FILE) ? JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf-8')) : [];
                sendJson(res, favs);
            } catch(e) { sendJson(res, []); }
        } else if (req.method === 'POST' && pathname === '/api/favorites') {
            const body = await readBody(req);
            try {
                const favs = JSON.parse(body.toString('utf-8'));
                fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favs, null, 2));
                sendJson(res, { ok: true });
            } catch(e) { sendJson(res, { error: 'invalid data' }, 400); }
        } else if (req.method === 'POST' && pathname === '/upload') {
            await handleUpload(req, res);
        } else if (req.method === 'GET' && pathname.startsWith('/screenshots/')) {
            // Serve screenshot files: /screenshots/PROJECT/.screenshots/sm/filename.jpg
            const relPath = decodeURIComponent(pathname.slice('/screenshots/'.length));
            const filePath = path.join(PROJECTS_DIR, relPath);
            if (fs.existsSync(filePath)) {
                const ext = path.extname(filePath).toLowerCase();
                const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
                res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
                res.end(fs.readFileSync(filePath));
            } else {
                res.writeHead(404); res.end('Not found');
            }
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
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

function main() {
    // Parse --port arg
    let port = 7777;
    const portIdx = process.argv.indexOf('--port');
    if (portIdx !== -1 && process.argv[portIdx + 1]) {
        port = parseInt(process.argv[portIdx + 1], 10) || 7777;
    }

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
