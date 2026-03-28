/**
 * WebSocket handler for TAYTERM terminal sessions.
 */

module.exports = function createWsHandler(deps) {
    const {
        activeTerminals, daemonSpawn, daemonAttach, daemonWrite, daemonResize,
        startReader, PROJECTS_DIR, CLAUDE_CMD, WebSocket, log,
        getRequestIdentity, logAudit, fs, path,
    } = deps;

    return function handleWebSocket(ws, req) {
        const url = new URL(req.url, 'https://localhost');
        const projectName = url.searchParams.get('project') || '';
        const autoClaude = url.searchParams.get('claude') === '1';
        const continueClaude = url.searchParams.get('continue') === '1';
        const resumeId = url.searchParams.get('resume') || '';
        const projectPath = path.join(PROJECTS_DIR, projectName);
        const sessionType = (autoClaude || continueClaude || resumeId) ? 'claude' : 'shell';
        const sessionKey = `${projectName}:${sessionType}`;
        const remoteAddr = req.socket.remoteAddress || 'unknown';
        const who = getRequestIdentity(req);
        const whoTag = `${who.label} (${who.device}, ${who.browser}, ${who.ip})`;

        if (!projectName || !fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
            ws.send(JSON.stringify({ type: 'error', data: `Project not found: ${projectName}` }));
            ws.close();
            return;
        }

        // Check for existing live PTY (in daemon)
        let isReattach = false;
        if (activeTerminals[sessionKey]?.alive) {
            isReattach = true;
        }

        const auditInfo = { project: projectName, user: who.label, device: who.device, browser: who.browser, ip: who.ip };

        let entry;
        if (isReattach) {
            log(`Reattach: ${sessionKey} — ${whoTag}`);
            logAudit('session_reattach', auditInfo);
            ws.send(JSON.stringify({ type: 'status', data: `reattached to live ${sessionType} PTY` }));
            entry = activeTerminals[sessionKey];
            // Re-attach to daemon to get scrollback
            daemonAttach(sessionKey);
        } else {
            entry = { alive: true, subscribers: new Set(), ttsTap: null };
            activeTerminals[sessionKey] = entry;

            // Ask daemon to spawn PTY
            daemonSpawn(sessionKey, projectPath, 120, 30);
            daemonAttach(sessionKey);

            startReader(sessionKey, { attachLatest: !!(continueClaude || resumeId) });
            log(`New PTY: ${sessionKey} — ${whoTag}`);
            logAudit('session_new', auditInfo);
            ws.send(JSON.stringify({ type: 'status', data: `new ${sessionType} PTY started` }));

            // Launch claude if requested (after delay for PowerShell to fully init)
            if (autoClaude || continueClaude || resumeId) {
                let cmd = CLAUDE_CMD;
                if (continueClaude) cmd += ' --continue';
                else if (resumeId) cmd += ' --resume ' + resumeId;
                log(`Will launch: ${cmd}`);
                setTimeout(() => {
                    if (entry.alive) {
                        log(`Sending to PTY: ${cmd}`);
                        daemonWrite(sessionKey, cmd + '\r');
                    }
                }, 1500);
            }
        }

        // Subscribe
        entry.subscribers.add(ws);

        // If JSONL already attached, tell this client immediately
        if (entry.jsonlPath) {
            const sid = path.basename(entry.jsonlPath, '.jsonl');
            ws.send(JSON.stringify({ type: 'jsonl-ready', sessionId: sid }));
        }

        ws.on('message', (raw) => {
            try {
                const payload = JSON.parse(raw.toString());
                if (payload.type === 'input') {
                    if (entry.alive) {
                        daemonWrite(sessionKey, payload.data);
                        if (entry.ttsTap) {
                            entry.ttsTap.userInput(payload.data);
                        }
                        // Broadcast user input to all OTHER subscribers (multi-device sync)
                        for (const sub of entry.subscribers) {
                            if (sub !== ws && sub.readyState === WebSocket.OPEN) {
                                try { sub.send(JSON.stringify({ type: 'user-input', data: payload.data })); } catch(e) {}
                            }
                        }
                    }
                } else if (payload.type === 'resize') {
                    if (entry.alive) {
                        daemonResize(sessionKey, payload.cols, payload.rows);
                    }
                }
            } catch (e) { /* ignore */ }
        });

        ws.on('close', () => {
            entry.subscribers.delete(ws);
            log(`Browser detached: ${sessionKey} — ${whoTag} (${entry.subscribers.size} still connected)`);
            logAudit('session_disconnect', auditInfo);
        });

        ws.on('error', () => {
            entry.subscribers.delete(ws);
        });
    };
};
