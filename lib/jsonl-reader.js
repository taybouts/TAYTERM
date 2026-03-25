/**
 * JSONL Reader — Watches Claude conversation JSONL files for live updates.
 * Factory pattern: call createReader(deps) to get a startReader function.
 */

const fs = require('fs');
const path = require('path');

module.exports = function createReader(deps) {
    const { activeTerminals, PROJECTS_DIR, CLAUDE_PROJECTS_DIR, TTSTap, claimProject, WebSocket, log } = deps;

    return function startReader(sessionKey, opts) {
        opts = opts || {};
        const entry = activeTerminals[sessionKey];
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

            // JSONL tracking — dir watcher drives everything
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

            // Attach to a JSONL file — just sets path and resets position
            function attachToJsonl(filePath) {
                jsonlPath = filePath;
                entry.jsonlPath = filePath;
                jsonlPos = fs.statSync(filePath).size; // Start at end
                if (ttsTap) ttsTap.sentencesSent = new Set();
                log(`Attached JSONL: ${filePath}`);
            }

            // Expose switch function for session resume / load-session
            entry._switchJsonl = (newPath) => {
                attachToJsonl(newPath);
            };

            // Expose clear-and-wait function for new session mid-PTY
            entry._clearSession = () => {
                jsonlPath = null;
                entry.jsonlPath = null;
                // Re-snapshot so dir watcher only reacts to truly new files
                existingFiles.clear();
                try {
                    for (const f of fs.readdirSync(convDir)) {
                        if (f.endsWith('.jsonl')) existingFiles.add(f);
                    }
                } catch (e) {}
                log(`Session cleared, waiting for new JSONL in ${convDir}`);
            };

            // Snapshot existing JSONL files at PTY start
            const existingFiles = new Set();
            try {
                if (fs.existsSync(convDir)) {
                    for (const f of fs.readdirSync(convDir)) {
                        if (f.endsWith('.jsonl')) existingFiles.add(f);
                    }
                }
            } catch (e) {}

            // Single directory watcher handles EVERYTHING:
            // - New JSONL file appears → attach to it
            // - Current JSONL file modified → read new lines
            // fs.watch on a directory is reliable on Windows (unlike file watches)
            let dirWatcher = null;
            if (!fs.existsSync(convDir)) fs.mkdirSync(convDir, { recursive: true });
            dirWatcher = fs.watch(convDir, (eventType, filename) => {
                if (!filename || !filename.endsWith('.jsonl')) return;
                const fullPath = path.join(convDir, filename);
                if (!existingFiles.has(filename)) {
                    // New file — attach to it
                    existingFiles.add(filename);
                    attachToJsonl(fullPath);
                    log(`Dir watcher: new JSONL → ${fullPath}`);
                } else if (jsonlPath && path.basename(jsonlPath) === filename) {
                    // Current file modified — read new lines
                    readNewLines();
                }
            });

            // For continue/resume: attach to latest existing JSONL immediately
            if (opts.attachLatest) {
                const latest = findLatestJsonl();
                if (latest) {
                    attachToJsonl(latest);
                }
            }

            // Store cleanup callback for daemon exit handler
            entry._onPtyExit = () => {
                if (dirWatcher) dirWatcher.close();
            };
        }
        // PTY output and exit are now handled by the daemon event listener (handleDaemonMessage)
    };
};
