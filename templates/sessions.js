function sessionsPageHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
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
    background: linear-gradient(135deg, #38bdf8, #0284c7);
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
.tag-cloudflare { background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px solid rgba(245,158,11,0.2); }
.tag-tailscale { background: rgba(34,197,94,0.1); color: #22c55e; border: 1px solid rgba(34,197,94,0.2); }
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
        const remaining = Math.max(0, Math.round((s.expires - Date.now()) / 60000));
        const hours = Math.floor(remaining / 60);
        const mins = remaining % 60;
        const timeLeft = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
        const deviceLabel = s.device ? s.device + ' · ' : '';
        const machineLabel = s.machine ? '<strong style="color:var(--accent2)">' + s.machine + '</strong> · ' : '';
        const viaTag = s.via !== 'Direct' ? ' <span class="session-tag tag-' + s.via.toLowerCase() + '">' + s.via.toUpperCase() + '</span>' : '';
        return '<div class="session-card' + (s.isCurrent ? ' current' : '') + '" style="animation-delay:' + (i * 0.05) + 's">' +
            '<div class="session-dot"></div>' +
            '<div class="session-info">' +
                '<div class="session-label">' + machineLabel + deviceLabel + s.browser + ' on ' + s.os + (s.isCurrent ? ' <span class="session-tag tag-current">THIS DEVICE</span>' : '') + viaTag + '</div>' +
                '<div class="session-meta"><span>' + s.ip + '</span><span>' + s.id + '</span><span>' + timeLeft + ' left</span><span>' + created + '</span></div>' +
                (s.screen || s.gpu ? '<div class="session-meta"><span>' + (s.screen ? s.screen : '') + '</span>' + (s.cores ? '<span>' + s.cores + ' cores</span>' : '') + (s.memory ? '<span>' + s.memory + 'GB RAM</span>' : '') + (s.gpu ? '<span>' + s.gpu.substring(0,40) + '</span>' : '') + (s.timezone ? '<span>' + s.timezone + '</span>' : '') + '</div>' : '') +
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

module.exports = sessionsPageHTML;
