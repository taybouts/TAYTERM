/**
 * TTS Tap — Intercepts terminal output, extracts natural language, sends to TTS.
 * Also manages TTS project claims (tells stream watcher which projects T-Term owns).
 */

const http = require('http');

const TTS_URL = 'http://127.0.0.1:7123';
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07|\x1b[()][AB012]|\x1b\[\??[0-9;]*[hl]|\r/g;

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

module.exports = { TTSTap, claimProject, releaseProject };
