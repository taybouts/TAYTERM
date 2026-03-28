#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  T-Daemon — PTY process manager — Owns all PTY processes, survives server restarts
// ═══════════════════════════════════════════════════════════════════════════

const net = require('net');
const pty = require('node-pty');
const os = require('os');
const path = require('path');

const PORT = 5041;
const HOST = '127.0.0.1';
const SCROLLBACK_LIMIT = 64 * 1024; // 64KB per session

// ═══════════════════════════════════════════
//  Session Map
// ═══════════════════════════════════════════
const sessions = new Map();
// sessionKey -> { pty, subscribers: Set<socket>, scrollback, metadata }

const logBuffer = [];
const LOG_BUFFER_MAX = 500;

function log(msg) {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const entry = `[${ts}] ${msg}`;
    console.log(`[DAEMON ${ts}] ${msg}`);
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}

// ═══════════════════════════════════════════
//  Command Handlers
// ═══════════════════════════════════════════

function handleSpawn(socket, msg) {
    const { sessionKey, cwd, cmd, args, cols, rows } = msg;

    if (sessions.has(sessionKey)) {
        send(socket, { type: 'error', message: `Session already exists: ${sessionKey}` });
        return;
    }

    // Build env: remove Claude-related vars to avoid nesting
    const env = { ...process.env };
    for (const v of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION',
                     'CLAUDE_CODE_ENTRY_POINT', 'CLAUDE_CODE_PARENT']) {
        delete env[v];
    }
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';

    const ptyProc = pty.spawn(cmd || 'powershell.exe', args || [], {
        name: 'xterm-256color',
        cols: cols || 120,
        rows: rows || 30,
        cwd: cwd || os.homedir(),
        env,
        conptyInheritCursor: true,
    });

    const session = {
        pty: ptyProc,
        subscribers: new Set(),
        scrollback: '',
        metadata: {
            sessionKey,
            cwd,
            cmd: cmd || 'powershell.exe',
            pid: ptyProc.pid,
            cols: cols || 120,
            rows: rows || 30,
            createdAt: Date.now(),
            lastActivity: Date.now(),
        }
    };

    sessions.set(sessionKey, session);

    // PTY output → broadcast to subscribers + scrollback
    ptyProc.onData((data) => {
        session.metadata.lastActivity = Date.now();

        // Append to scrollback (ring buffer)
        session.scrollback += data;
        if (session.scrollback.length > SCROLLBACK_LIMIT) {
            session.scrollback = session.scrollback.slice(-SCROLLBACK_LIMIT);
        }

        // Broadcast to all subscribers
        const dead = [];
        for (const sub of session.subscribers) {
            try {
                send(sub, { type: 'output', sessionKey, data });
            } catch (e) {
                dead.push(sub);
            }
        }
        for (const sub of dead) session.subscribers.delete(sub);
    });

    // PTY exit
    ptyProc.onExit(({ exitCode }) => {
        log(`PTY exited: ${sessionKey} (code ${exitCode})`);
        // Notify all subscribers
        for (const sub of session.subscribers) {
            try {
                send(sub, { type: 'exit', sessionKey, code: exitCode });
            } catch (e) { /* ignore */ }
        }
        sessions.delete(sessionKey);
    });

    log(`Spawned: ${sessionKey} (PID ${ptyProc.pid}) in ${cwd}`);
    send(socket, { type: 'spawned', sessionKey, pid: ptyProc.pid });
}

function handleAttach(socket, msg) {
    const { sessionKey } = msg;
    const session = sessions.get(sessionKey);

    if (!session) {
        send(socket, { type: 'error', message: `No session: ${sessionKey}` });
        return;
    }

    session.subscribers.add(socket);

    // Send scrollback so client can replay terminal state
    if (session.scrollback.length > 0) {
        send(socket, { type: 'scrollback', sessionKey, data: session.scrollback });
    }

    log(`Attached: ${sessionKey} (${session.subscribers.size} subscribers)`);
    send(socket, { type: 'attached', sessionKey, pid: session.pty.pid });
}

function handleDetach(socket, msg) {
    const { sessionKey } = msg;
    const session = sessions.get(sessionKey);
    if (session) {
        session.subscribers.delete(socket);
        log(`Detached: ${sessionKey} (${session.subscribers.size} subscribers)`);
    }
    send(socket, { type: 'detached', sessionKey });
}

function handleWrite(socket, msg) {
    const { sessionKey, data } = msg;
    const session = sessions.get(sessionKey);
    if (session && session.pty) {
        session.pty.write(data);
    }
}

function handleResize(socket, msg) {
    const { sessionKey, cols, rows } = msg;
    const session = sessions.get(sessionKey);
    if (session && session.pty) {
        session.pty.resize(cols, rows);
        session.metadata.cols = cols;
        session.metadata.rows = rows;
    }
}

function handleKill(socket, msg) {
    const { sessionKey } = msg;
    const session = sessions.get(sessionKey);

    if (!session) {
        send(socket, { type: 'error', message: `No session: ${sessionKey}` });
        return;
    }

    log(`Killing: ${sessionKey}`);
    try { session.pty.kill(); } catch (e) { /* ignore */ }

    // Notify all subscribers
    for (const sub of session.subscribers) {
        try {
            send(sub, { type: 'exit', sessionKey, code: -1 });
        } catch (e) { /* ignore */ }
    }
    sessions.delete(sessionKey);
    send(socket, { type: 'killed', sessionKey });
}

function handleList(socket) {
    const list = [];
    for (const [key, session] of sessions) {
        list.push({
            sessionKey: key,
            pid: session.metadata.pid,
            cwd: session.metadata.cwd,
            cmd: session.metadata.cmd,
            cols: session.metadata.cols,
            rows: session.metadata.rows,
            createdAt: session.metadata.createdAt,
            lastActivity: session.metadata.lastActivity,
            subscribers: session.subscribers.size,
            scrollbackSize: session.scrollback.length,
        });
    }
    send(socket, { type: 'list', sessions: list });
}

// ═══════════════════════════════════════════
//  Protocol: newline-delimited JSON
// ═══════════════════════════════════════════

function send(socket, obj) {
    if (socket.writable) {
        socket.write(JSON.stringify(obj) + '\n');
    }
}

function handleMessage(socket, msg) {
    switch (msg.action) {
        case 'spawn':   handleSpawn(socket, msg); break;
        case 'attach':  handleAttach(socket, msg); break;
        case 'detach':  handleDetach(socket, msg); break;
        case 'write':   handleWrite(socket, msg); break;
        case 'resize':  handleResize(socket, msg); break;
        case 'kill':    handleKill(socket, msg); break;
        case 'list':    handleList(socket); break;
        default:
            send(socket, { type: 'error', message: `Unknown action: ${msg.action}` });
    }
}

// ═══════════════════════════════════════════
//  TCP Server
// ═══════════════════════════════════════════

const server = net.createServer((socket) => {
    let buffer = '';
    log(`Client connected: ${socket.remoteAddress}:${socket.remotePort}`);

    socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;
            try {
                const msg = JSON.parse(line);
                handleMessage(socket, msg);
            } catch (e) {
                log(`Invalid JSON from client: ${JSON.stringify(line.slice(0, 200))}`);
                send(socket, { type: 'error', message: 'Invalid JSON' });
            }
        }
    });

    socket.on('close', () => {
        log(`Client disconnected: ${socket.remoteAddress}:${socket.remotePort}`);
        // Remove this socket from all session subscribers
        for (const [key, session] of sessions) {
            session.subscribers.delete(socket);
        }
    });

    socket.on('error', (err) => {
        if (err.code !== 'ECONNRESET') {
            log(`Socket error: ${err.message}`);
        }
    });
});

server.listen(PORT, HOST, () => {
    log(`PTY Daemon running on ${HOST}:${PORT} (PID ${process.pid})`);
    log(`Scrollback buffer: ${(SCROLLBACK_LIMIT / 1024).toFixed(0)}KB per session`);
});

// ═══════════════════════════════════════════
//  HTTP Dashboard — port 5042
// ═══════════════════════════════════════════
const http = require('http');

// Log buffer is populated by the log() function defined at the top

const DASH_PORT = 5042;

function getSessionsJson() {
    const list = [];
    for (const [key, session] of sessions) {
        list.push({
            sessionKey: key,
            pid: session.metadata.pid,
            cwd: session.metadata.cwd,
            cmd: session.metadata.cmd,
            cols: session.metadata.cols,
            rows: session.metadata.rows,
            createdAt: session.metadata.createdAt,
            lastActivity: session.metadata.lastActivity,
            subscribers: session.subscribers.size,
            scrollbackSize: session.scrollback.length,
            uptime: Math.floor((Date.now() - session.metadata.createdAt) / 1000),
        });
    }
    return list;
}

const dashboardHtml = () => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>PTY Daemon</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
:root {
  --bg-deep: #0a0a0f; --bg-mid: #0d1117; --accent: #0284c7; --accent2: #38bdf8;
  --emerald: #22c55e; --red: #ef4444; --cyan: #38bdf8; --amber: #f59e0b;
  --text: #e6edf3; --text2: #475569; --text3: #64748b;
  --glass-bg: rgba(255,255,255,0.03); --glass-border: rgba(255,255,255,0.06);
  --glass-hover: rgba(255,255,255,0.06); --accent-border: rgba(56,189,248,0.3);
  --radius: 12px;
  --font-display: 'Rajdhani', 'Segoe UI', sans-serif;
  --font-mono: 'Share Tech Mono', 'Consolas', monospace;
}
body { background: var(--bg-deep); color: var(--text); font-family: var(--font-display); padding: 24px;
  min-height: 100vh; }
body::before { content:''; position:fixed; inset:0; z-index:0; pointer-events:none;
  background-image: linear-gradient(rgba(2,132,199,0.02) 1px, transparent 1px),
    linear-gradient(90deg, rgba(2,132,199,0.02) 1px, transparent 1px);
  background-size: 40px 40px; }
.container { position:relative; z-index:1; max-width:900px; margin:0 auto; }
h1 { font-family: var(--font-display); font-weight:700; font-size:22px; letter-spacing:2px;
  text-transform:uppercase; color:var(--accent2); margin-bottom:20px; }
.status-bar { display:flex; gap:24px; margin-bottom:24px; padding:14px 18px;
  background:var(--glass-bg); border:1px solid var(--glass-border); border-radius:var(--radius);
  backdrop-filter:blur(12px); }
.status-item { font-family:var(--font-mono); font-size:12px; color:var(--text3); }
.status-item span { color:var(--accent2); font-weight:600; }
.section { margin-bottom:28px; }
.section-title { font-family:var(--font-display); font-weight:600; font-size:13px; letter-spacing:2px;
  text-transform:uppercase; color:var(--text3); margin-bottom:12px;
  border-bottom:1px solid var(--glass-border); padding-bottom:8px; }
.session-card { background:var(--glass-bg); border:1px solid var(--glass-border);
  border-left:3px solid var(--accent2); border-radius:var(--radius); padding:16px 18px;
  margin-bottom:10px; transition:all 0.2s; backdrop-filter:blur(12px); }
.session-card:hover { border-color:var(--accent-border); background:var(--glass-hover); }
.session-name { font-family:var(--font-display); font-weight:700; font-size:15px; color:var(--text);
  letter-spacing:1px; }
.session-meta { font-family:var(--font-mono); font-size:11px; color:var(--text3); margin-top:8px;
  display:flex; gap:18px; flex-wrap:wrap; }
.session-meta span { color:var(--cyan); }
.session-actions { margin-top:10px; display:flex; gap:8px; }
.btn { background:var(--glass-bg); border:1px solid var(--glass-border); color:var(--text3);
  font-family:var(--font-mono); font-size:11px; padding:5px 14px; cursor:pointer;
  border-radius:8px; letter-spacing:1px; transition:all 0.2s; text-transform:uppercase; }
.btn:hover { border-color:var(--accent-border); color:var(--accent2); background:var(--glass-hover); }
.btn.danger { border-color:rgba(239,68,68,0.2); color:var(--red); }
.btn.danger:hover { border-color:var(--red); background:rgba(239,68,68,0.08); }
.empty { text-align:center; padding:40px; color:var(--text3); font-family:var(--font-mono); font-size:12px; }
.log-area { background:rgba(0,0,0,0.3); border:1px solid var(--glass-border); border-radius:var(--radius);
  padding:14px; height:300px; overflow-y:auto; font-family:var(--font-mono); font-size:11px;
  line-height:1.7; backdrop-filter:blur(8px); }
.log-area::-webkit-scrollbar { width:4px; }
.log-area::-webkit-scrollbar-thumb { background:rgba(56,189,248,0.15); border-radius:2px; }
.log-line { color:var(--text3); white-space:pre-wrap; word-break:break-all; }
.peek-area { background:rgba(0,0,0,0.4); border:1px solid var(--glass-border); border-radius:8px;
  padding:10px; max-height:200px; overflow-y:auto; font-family:var(--font-mono); font-size:10px;
  color:var(--text3); white-space:pre-wrap; word-break:break-all; display:none; margin-top:10px; }
.peek-area.visible { display:block; }
.alive-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--emerald);
  box-shadow:0 0 6px var(--emerald); margin-right:8px; vertical-align:middle; }
</style>
</head>
<body>
<div class="container">
<h1><span class="alive-dot"></span>PTY Daemon</h1>
<div class="status-bar" id="statusBar"></div>
<div class="section">
  <div class="section-title">Active Sessions</div>
  <div id="sessions"></div>
</div>
<div class="section">
  <div class="section-title">Daemon Log</div>
  <div class="log-area" id="logArea"></div>
</div>
</div>
<script>
function fmt(s) { return s < 10 ? '0'+s : s; }
function uptime(sec) {
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  return (h ? h+'h ' : '') + m+'m ' + s+'s';
}
function ago(ts) {
  const s = Math.floor((Date.now()-ts)/1000);
  if (s < 60) return s+'s ago';
  if (s < 3600) return Math.floor(s/60)+'m ago';
  return Math.floor(s/3600)+'h ago';
}

async function refresh() {
  try {
    const r = await fetch('/api/sessions');
    const data = await r.json();
    const el = document.getElementById('sessions');
    const sb = document.getElementById('statusBar');
    sb.innerHTML = '<div class="status-item">PID: <span>' + data.daemonPid + '</span></div>'
      + '<div class="status-item">Sessions: <span>' + data.sessions.length + '</span></div>'
      + '<div class="status-item">Uptime: <span>' + uptime(data.uptime) + '</span></div>';
    if (data.sessions.length === 0) {
      el.innerHTML = '<div class="empty">No active PTY sessions</div>';
    } else {
      el.innerHTML = '';
      for (const s of data.sessions) {
        const card = document.createElement('div');
        card.className = 'session-card';
        var displayName = s.sessionKey.replace(/:claude$/, '').replace(/:shell$/, ' (shell)');
        card.innerHTML = '<div class="session-name">' + displayName + '</div>'
          + '<div class="session-meta">'
          + '<div>PID: <span>' + s.pid + '</span></div>'
          + '<div>Size: <span>' + s.cols + 'x' + s.rows + '</span></div>'
          + '<div>Subscribers: <span>' + s.subscribers + '</span></div>'
          + '<div>Uptime: <span>' + uptime(s.uptime) + '</span></div>'
          + '<div>Last activity: <span>' + ago(s.lastActivity) + '</span></div>'
          + '<div>Scrollback: <span>' + (s.scrollbackSize/1024).toFixed(1) + 'KB</span></div>'
          + '</div>'
          + '<div class="session-actions">'
          + '<button class="btn" onclick="peek(&quot;'+s.sessionKey+'&quot;,this)">Peek</button>'
          + '<button class="btn danger" onclick="kill(&quot;'+s.sessionKey+'&quot;)">Kill</button>'
          + '</div>'
          + '<div class="peek-area" id="peek-'+s.sessionKey.replace(/[^a-z0-9]/gi,'_')+'"></div>';
        el.appendChild(card);
      }
    }
  } catch(e) { console.error(e); }
}

async function loadLog() {
  try {
    const r = await fetch('/api/log');
    const data = await r.json();
    const el = document.getElementById('logArea');
    el.innerHTML = data.log.map(l => '<div class="log-line">' + l + '</div>').join('');
    el.scrollTop = el.scrollHeight;
  } catch(e) {}
}

async function peek(key, btn) {
  const id = 'peek-' + key.replace(/[^a-z0-9]/gi, '_');
  const el = document.getElementById(id);
  if (el.classList.contains('visible')) { el.classList.remove('visible'); return; }
  try {
    const r = await fetch('/api/peek?key=' + encodeURIComponent(key));
    const data = await r.json();
    el.textContent = data.scrollback || '(empty)';
    el.classList.add('visible');
    el.scrollTop = el.scrollHeight;
  } catch(e) {}
}

async function kill(key) {
  if (!confirm('Kill PTY: ' + key + '?')) return;
  await fetch('/api/kill', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ sessionKey: key }) });
  refresh();
}

refresh();
loadLog();
setInterval(refresh, 3000);
setInterval(loadLog, 5000);
</script>
</body>
</html>`;

const daemonStartTime = Date.now();

const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            daemonPid: process.pid,
            uptime: Math.floor((Date.now() - daemonStartTime) / 1000),
            sessions: getSessionsJson()
        }));
    } else if (url.pathname === '/api/log') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ log: logBuffer }));
    } else if (url.pathname === '/api/peek') {
        const key = url.searchParams.get('key') || '';
        const session = sessions.get(key);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Strip ANSI codes for clean peek
        const raw = session ? session.scrollback : '';
        const clean = raw.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07|\r/g, '');
        res.end(JSON.stringify({ scrollback: clean.slice(-4096) }));
    } else if (req.method === 'POST' && url.pathname === '/api/kill') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { sessionKey } = JSON.parse(body);
                const session = sessions.get(sessionKey);
                if (session) {
                    try { session.pty.kill(); } catch(e) {}
                    for (const sub of session.subscribers) {
                        try { send(sub, { type: 'exit', sessionKey, code: -1 }); } catch(e) {}
                    }
                    sessions.delete(sessionKey);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch(e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(dashboardHtml());
    }
});

httpServer.listen(DASH_PORT, HOST, () => {
    log(`Dashboard: http://${HOST}:${DASH_PORT}`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        log(`Port ${PORT} already in use — daemon may already be running`);
        process.exit(1);
    }
    throw err;
});

// Graceful shutdown
process.on('SIGINT', () => {
    log('Shutting down — killing all PTYs...');
    for (const [key, session] of sessions) {
        try { session.pty.kill(); } catch (e) { /* ignore */ }
    }
    server.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('Shutting down — killing all PTYs...');
    for (const [key, session] of sessions) {
        try { session.pty.kill(); } catch (e) { /* ignore */ }
    }
    server.close();
    process.exit(0);
});
