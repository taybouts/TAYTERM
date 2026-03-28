/**
 * REST API route handlers for TAYTERM.
 */

const { sendJson, readBody } = require('../lib/utils');

module.exports = function createApiRouter(deps) {
    const {
        activeTerminals, PROJECTS_DIR, CLAUDE_PROJECTS_DIR, FAVORITES_FILE, BASE_DIR,
        daemonWrite, daemonKill, daemonList, getDaemonState,
        startReader, log, fs, path, WebSocket,
        getRequestIdentity, logAudit,
        releaseProject,
    } = deps;

    // -----------------------------------------------------------------
    //  Helper: get projects list
    // -----------------------------------------------------------------

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
            const claudeLive = !!(activeTerminals[claudeKey]?.alive);
            const shellLive = !!(activeTerminals[shellKey]?.alive);
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

    // -----------------------------------------------------------------
    //  Named handlers
    // -----------------------------------------------------------------

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
                if (entry.alive) {
                    daemonKill(key);
                    killed.push(keyType);
                    if (keyType === 'claude') releaseProject(name);
                }
                if (entry._onPtyExit) entry._onPtyExit();
                for (const ws of entry.subscribers) {
                    try {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'status', data: 'killed' }));
                            ws.close();
                        }
                    } catch (e) { /* ignore */ }
                }
                entry.subscribers.clear();
                entry.alive = false;
                delete activeTerminals[key];
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

            let preview = '';
            let totalTokens = 0;
            try {
                const content = fs.readFileSync(fpath, 'utf-8');
                for (const line of content.split('\n')) {
                    if (!line.trim()) continue;
                    try {
                        const obj = JSON.parse(line);
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

        let latest = null;
        const sessionKey = name + ':claude';
        // Primary: use the JSONL the server is actively watching
        if (activeTerminals[sessionKey] && activeTerminals[sessionKey].jsonlPath) {
            latest = activeTerminals[sessionKey].jsonlPath;
        }
        // Allow explicit ?session= param for browsing old sessions
        const explicitSession = url.searchParams.get('session') || '';
        if (explicitSession) {
            const candidatePath = path.join(convDir, explicitSession + '.jsonl');
            if (fs.existsSync(candidatePath)) latest = candidatePath;
        }

        if (!latest) {
            sendJson(res, []);
            return;
        }

        const messages = [];
        try {
            // Read only last portion of file for performance on large conversations
            let content;
            const stat = fs.statSync(latest);
            const MAX_READ = 2 * 1024 * 1024; // 2MB — enough for most conversations
            if (stat.size > MAX_READ) {
                const fd = fs.openSync(latest, 'r');
                const buf = Buffer.alloc(MAX_READ);
                fs.readSync(fd, buf, 0, MAX_READ, stat.size - MAX_READ);
                fs.closeSync(fd);
                content = buf.toString('utf-8');
                // Skip first partial line
                const firstNewline = content.indexOf('\n');
                if (firstNewline > 0) content = content.slice(firstNewline + 1);
            } else {
                content = fs.readFileSync(latest, 'utf-8');
            }
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

    // -----------------------------------------------------------------
    //  Main router
    // -----------------------------------------------------------------

    return async function handleApiRoute(req, res, pathname) {
        if (req.method === 'GET' && pathname === '/api/projects') {
            handleApiProjects(req, res);
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/connection-info') {
            const cfIp = req.headers['cf-connecting-ip'] || '';
            const cfRay = req.headers['cf-ray'] || '';
            const cfCountry = req.headers['cf-ipcountry'] || '';
            const xForward = req.headers['x-forwarded-for'] || '';
            const realIp = cfIp || xForward.split(',')[0]?.trim() || req.socket.remoteAddress || '';
            const directIp = req.socket.remoteAddress || '';
            const isCF = !!cfRay;
            const isPrivate = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fe80)/.test(realIp);
            const isDirectLocal = /^(127\.|::1|::ffff:127\.)/.test(directIp) || directIp === '::1';
            let route = 'unknown';
            if (!isCF && isDirectLocal) route = 'local';
            else if (!isCF && !isDirectLocal) route = 'tailscale';
            else if (isCF && isPrivate) route = 'cf-lan';
            else if (isCF) route = 'cf-remote';
            sendJson(res, {
                route,
                cloudflare: isCF,
                clientIp: realIp,
                directIp,
                cfRay: cfRay || null,
                cfCountry: cfCountry || null,
                localNetwork: isPrivate,
            });
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/daemon') {
            daemonList();
            await new Promise(r => setTimeout(r, 200));
            sendJson(res, getDaemonState());
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/kill') {
            await handleApiKill(req, res);
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/new-session') {
            const body = await readBody(req);
            let data;
            try { data = JSON.parse(body.toString()); } catch (e) { sendJson(res, { error: 'invalid json' }, 400); return true; }
            const name = data.name || '';
            const sKey = name + ':claude';
            const entry = activeTerminals[sKey];
            if (entry && entry.alive) {
                if (entry._clearSession) entry._clearSession();
                daemonWrite(sKey, '/clear\r');
                log(`New session (mid-PTY): ${name}`);
                sendJson(res, { ok: true });
            } else {
                sendJson(res, { error: 'no active PTY' }, 400);
            }
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/sessions') {
            handleApiSessions(req, res);
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/load-session') {
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
                    if (activeTerminals[sKey]._switchJsonl) {
                        activeTerminals[sKey]._switchJsonl(newPath);
                    }
                    log(`Switched session JSONL for ${sName}: ${sessionFile}`);
                }
            }
            sendJson(res, { ok: true });
            return true;
        }

        if (req.method === 'DELETE' && pathname === '/api/session') {
            const body = await readBody(req);
            const { name, session } = JSON.parse(body.toString('utf-8'));
            const projPath = path.join(PROJECTS_DIR, name);
            const cpk = projPath.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-').replace(/ /g, '-');
            const filePath = path.join(CLAUDE_PROJECTS_DIR, cpk, session + '.jsonl');
            const sKey = name + ':claude';
            if (activeTerminals[sKey] && activeTerminals[sKey].jsonlPath === filePath) {
                sendJson(res, { error: 'Cannot delete active session' }, 400);
                return true;
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
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/session-star') {
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
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/conversation') {
            handleApiConversation(req, res);
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/new-project') {
            const body = await readBody(req);
            let data;
            try { data = JSON.parse(body.toString()); } catch (e) { sendJson(res, { error: 'invalid json' }, 400); return true; }

            const name = (data.name || '').trim();
            if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
                sendJson(res, { error: 'Invalid project name' }, 400);
                return true;
            }

            const projPath = path.join(PROJECTS_DIR, name);
            if (fs.existsSync(projPath)) {
                sendJson(res, { error: 'Project already exists' }, 400);
                return true;
            }

            fs.mkdirSync(projPath, { recursive: true });
            log(`Created project: ${name}`);
            sendJson(res, { created: name });
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/claude-logo') {
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
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/chat-media') {
            const u = new URL(req.url, 'https://localhost');
            const name = u.searchParams.get('name') || '';
            const explicitSession = u.searchParams.get('session') || '';
            const mediaFile = path.join(PROJECTS_DIR, name, '.tterm_media.json');
            try {
                let data = fs.existsSync(mediaFile) ? JSON.parse(fs.readFileSync(mediaFile, 'utf-8')) : [];
                let filterSession = explicitSession;
                if (!filterSession) {
                    const sKey = name + ':claude';
                    if (activeTerminals[sKey] && activeTerminals[sKey].jsonlPath) {
                        filterSession = path.basename(activeTerminals[sKey].jsonlPath, '.jsonl');
                    }
                }
                if (filterSession) {
                    data = data.filter(m => m.sessionId === filterSession);
                } else {
                    data = [];
                }
                sendJson(res, data);
            } catch(e) { sendJson(res, []); }
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/chat-media') {
            const body = await readBody(req);
            const { name, media } = JSON.parse(body.toString('utf-8'));
            const mediaFile = path.join(PROJECTS_DIR, name, '.tterm_media.json');
            try {
                const sKey = name + ':claude';
                if (activeTerminals[sKey] && activeTerminals[sKey].jsonlPath) {
                    media.sessionId = path.basename(activeTerminals[sKey].jsonlPath, '.jsonl');
                }
                const existing = fs.existsSync(mediaFile) ? JSON.parse(fs.readFileSync(mediaFile, 'utf-8')) : [];
                existing.push(media);
                fs.writeFileSync(mediaFile, JSON.stringify(existing, null, 2));
                sendJson(res, { ok: true });
            } catch(e) { sendJson(res, { error: e.message }, 500); }
            return true;
        }

        if (req.method === 'DELETE' && pathname === '/api/chat-media') {
            const body = await readBody(req);
            const { name, ts } = JSON.parse(body.toString('utf-8'));
            const mediaFile = path.join(PROJECTS_DIR, name, '.tterm_media.json');
            try {
                const existing = fs.existsSync(mediaFile) ? JSON.parse(fs.readFileSync(mediaFile, 'utf-8')) : [];
                const filtered = existing.filter(m => m.ts !== ts);
                fs.writeFileSync(mediaFile, JSON.stringify(filtered, null, 2));
                sendJson(res, { ok: true, removed: existing.length - filtered.length });
            } catch(e) { sendJson(res, { error: e.message }, 500); }
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/stars') {
            const name = new URL(req.url, 'https://localhost').searchParams.get('name') || '';
            const starsFile = path.join(PROJECTS_DIR, name, '.tterm_stars.json');
            try {
                const data = fs.existsSync(starsFile) ? JSON.parse(fs.readFileSync(starsFile, 'utf-8')) : [];
                sendJson(res, data);
            } catch(e) { sendJson(res, []); }
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/stars') {
            const body = await readBody(req);
            const { name, star } = JSON.parse(body.toString('utf-8'));
            const starsFile = path.join(PROJECTS_DIR, name, '.tterm_stars.json');
            try {
                const existing = fs.existsSync(starsFile) ? JSON.parse(fs.readFileSync(starsFile, 'utf-8')) : [];
                const idx = existing.findIndex(s => s.text === star.text && s.time === star.time);
                if (idx >= 0) existing.splice(idx, 1);
                else existing.push(star);
                fs.writeFileSync(starsFile, JSON.stringify(existing, null, 2));
                sendJson(res, { ok: true, starred: idx < 0 });
            } catch(e) { sendJson(res, { error: e.message }, 500); }
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/notes') {
            const name = new URL(req.url, 'https://localhost').searchParams.get('name') || '';
            const notesFile = name ? path.join(PROJECTS_DIR, name, '.tterm_notes.json') : path.join(BASE_DIR, '.tterm_notes.json');
            try {
                const data = fs.existsSync(notesFile) ? JSON.parse(fs.readFileSync(notesFile, 'utf-8')) : [];
                sendJson(res, data);
            } catch(e) { sendJson(res, []); }
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/notes') {
            const body = await readBody(req);
            const { name, note } = JSON.parse(body.toString('utf-8'));
            const notesFile = name ? path.join(PROJECTS_DIR, name, '.tterm_notes.json') : path.join(BASE_DIR, '.tterm_notes.json');
            try {
                const existing = fs.existsSync(notesFile) ? JSON.parse(fs.readFileSync(notesFile, 'utf-8')) : [];
                existing.push(note);
                fs.writeFileSync(notesFile, JSON.stringify(existing, null, 2));
                sendJson(res, { ok: true });
            } catch(e) { sendJson(res, { error: e.message }, 500); }
            return true;
        }

        if (req.method === 'DELETE' && pathname === '/api/notes') {
            const body = await readBody(req);
            const { name, ts } = JSON.parse(body.toString('utf-8'));
            const notesFile = name ? path.join(PROJECTS_DIR, name, '.tterm_notes.json') : path.join(BASE_DIR, '.tterm_notes.json');
            try {
                const existing = fs.existsSync(notesFile) ? JSON.parse(fs.readFileSync(notesFile, 'utf-8')) : [];
                const filtered = existing.filter(n => n.ts !== ts);
                fs.writeFileSync(notesFile, JSON.stringify(filtered, null, 2));
                sendJson(res, { ok: true });
            } catch(e) { sendJson(res, { error: e.message }, 500); }
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/stats') {
            const name = new URL(req.url, 'https://localhost').searchParams.get('name') || '';
            const projectPath = path.join(PROJECTS_DIR, name);
            const claudeProjKey = projectPath.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-').replace(/ /g, '-');
            const convDir = path.join(CLAUDE_PROJECTS_DIR, claudeProjKey);
            try {
                if (!fs.existsSync(convDir)) { sendJson(res, {}); return true; }
                const files = fs.readdirSync(convDir).filter(f => f.endsWith('.jsonl'));
                if (files.length === 0) { sendJson(res, {}); return true; }
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
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/mute') {
            const body = await readBody(req);
            const { name, muted } = JSON.parse(body.toString('utf-8'));
            const key = name + ':claude';
            if (activeTerminals[key] && activeTerminals[key].ttsTap) {
                activeTerminals[key].ttsTap.muted = !!muted;
                if (muted) releaseProject(name);
                log(`TTS ${muted ? 'muted' : 'unmuted'}: ${name}`);
            }
            sendJson(res, { ok: true, muted: !!muted });
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/favorites') {
            try {
                const favs = fs.existsSync(FAVORITES_FILE) ? JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf-8')) : [];
                sendJson(res, favs);
            } catch(e) { sendJson(res, []); }
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/favorites') {
            const body = await readBody(req);
            try {
                const favs = JSON.parse(body.toString('utf-8'));
                fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favs, null, 2));
                sendJson(res, { ok: true });
            } catch(e) { sendJson(res, { error: 'invalid data' }, 400); }
            return true;
        }

        // ── Project Settings (icon + color per project) ──
        if (req.method === 'GET' && pathname === '/api/project-settings') {
            const file = path.join(BASE_DIR, '.tterm_project_settings.json');
            try {
                const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
                sendJson(res, data);
            } catch(e) { sendJson(res, {}); }
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/project-settings') {
            const file = path.join(BASE_DIR, '.tterm_project_settings.json');
            const body = await readBody(req);
            try {
                const incoming = JSON.parse(body.toString('utf-8'));
                // Merge with existing
                let existing = {};
                try { existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {}; } catch(e) {}
                const projectName = incoming.project;
                if (!projectName) { sendJson(res, { error: 'missing project' }, 400); return true; }
                existing[projectName] = { icon: incoming.icon || null, color: incoming.color || null };
                fs.writeFileSync(file, JSON.stringify(existing, null, 2));
                sendJson(res, { ok: true });
            } catch(e) { sendJson(res, { error: 'invalid data' }, 400); }
            return true;
        }

        // ── TTS Proxy — forwards /api/tts/* to T-Voice on 127.0.0.1:5011 ──
        if (pathname.startsWith('/api/tts/')) {
            const kokoroPath = pathname.replace('/api/tts', '');
            const body = await readBody(req);
            const http = require('http');
            const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' };
            if (body.length > 0) headers['Content-Length'] = body.length;
            const kokoroReq = http.request({
                hostname: '127.0.0.1',
                port: 5011,
                path: kokoroPath,
                method: req.method,
                headers,
            }, (kokoroRes) => {
                const resHeaders = { 'Content-Type': kokoroRes.headers['content-type'] || 'application/octet-stream' };
                if (kokoroRes.headers['transfer-encoding']) resHeaders['Transfer-Encoding'] = kokoroRes.headers['transfer-encoding'];
                res.writeHead(kokoroRes.statusCode, resHeaders);
                kokoroRes.pipe(res);
            });
            kokoroReq.on('error', () => {
                sendJson(res, { error: 'TTS server unreachable' }, 502);
            });
            kokoroReq.setTimeout(30000);
            if (body.length > 0) kokoroReq.write(body);
            kokoroReq.end();
            return true;
        }

        // Not an API route
        return false;
    };
};
