function adminPageHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>T-TERM — Admin</title>
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
.container { position: relative; z-index: 1; max-width: 700px; width: 100%; }
.header { display: flex; align-items: center; gap: 16px; margin-bottom: 32px; }
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

/* Tabs */
.tabs { display: flex; gap: 2px; margin-bottom: 24px; }
.tab {
    font-family: 'Share Tech Mono', monospace; font-size: 11px;
    letter-spacing: 1.5px; color: #475569; text-transform: uppercase;
    padding: 10px 20px; cursor: pointer; transition: all 0.15s;
    background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04);
    border-radius: 8px 8px 0 0; border-bottom: none;
}
.tab:hover { color: #94a3b8; }
.tab.active {
    color: #38bdf8; background: rgba(56,189,248,0.05);
    border-color: rgba(56,189,248,0.15); border-bottom: none;
    position: relative;
}
.tab.active::after {
    content: ''; position: absolute; bottom: -1px; left: 0; right: 0;
    height: 2px; background: linear-gradient(90deg, #38bdf8, #0284c7);
}
.panel { display: none; }
.panel.active { display: block; }

/* Cards */
.card {
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 12px; padding: 14px 18px; margin-bottom: 8px;
    display: flex; align-items: center; gap: 14px;
    transition: all 0.15s; animation: cardIn 0.3s ease both;
}
@keyframes cardIn { from { opacity: 0; transform: translateY(8px); } }
.card:hover { border-color: rgba(255,255,255,0.1); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot-blue { background: #38bdf8; box-shadow: 0 0 6px rgba(56,189,248,0.5); }
.dot-green { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,0.5); }
.dot-red { background: #ef4444; box-shadow: 0 0 6px rgba(239,68,68,0.5); }
.dot-amber { background: #f59e0b; box-shadow: 0 0 6px rgba(245,158,11,0.5); }
.card-info { flex: 1; min-width: 0; }
.card-label {
    font-family: 'Share Tech Mono', monospace; font-size: 12px;
    color: #e6edf3; letter-spacing: 0.5px; margin-bottom: 3px;
}
.card-meta {
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    color: #475569; display: flex; gap: 10px; flex-wrap: wrap;
}
.tag {
    font-family: 'Share Tech Mono', monospace; font-size: 9px;
    padding: 2px 8px; border-radius: 4px; letter-spacing: 0.5px;
}
.tag-blue { background: rgba(56,189,248,0.1); color: #38bdf8; border: 1px solid rgba(56,189,248,0.2); }
.tag-green { background: rgba(34,197,94,0.1); color: #22c55e; border: 1px solid rgba(34,197,94,0.2); }
.tag-red { background: rgba(239,68,68,0.1); color: #ef4444; border: 1px solid rgba(239,68,68,0.2); }
.tag-amber { background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px solid rgba(245,158,11,0.2); }

/* Buttons */
.btn-danger {
    font-family: 'Share Tech Mono', monospace; font-size: 9px;
    padding: 4px 12px; border-radius: 4px; letter-spacing: 1px;
    border: 1px solid rgba(239,68,68,0.3); background: none;
    color: #ef4444; cursor: pointer; text-transform: uppercase;
    transition: all 0.15s; opacity: 0;
}
.card:hover .btn-danger { opacity: 1; }
.btn-danger:hover { background: rgba(239,68,68,0.1); border-color: #ef4444; }
.btn-action {
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    padding: 8px 20px; border-radius: 6px; letter-spacing: 1px;
    border: 1px solid rgba(56,189,248,0.3); background: rgba(56,189,248,0.05);
    color: #38bdf8; cursor: pointer; text-transform: uppercase;
    transition: all 0.15s; white-space: nowrap; flex-shrink: 0;
}
.btn-action:hover { background: rgba(56,189,248,0.15); border-color: #38bdf8; }
.section-title {
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    color: #475569; letter-spacing: 1px; margin-bottom: 12px;
    text-transform: uppercase;
}
.empty {
    text-align: center; padding: 32px;
    font-family: 'Share Tech Mono', monospace; font-size: 11px;
    color: #475569; letter-spacing: 1px;
}
.label-input {
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
    color: #e6edf3; padding: 4px 8px; border-radius: 4px;
    font-family: 'Share Tech Mono', monospace; font-size: 11px;
    width: 140px; outline: none;
}
.label-input:focus { border-color: rgba(56,189,248,0.4); }

</style>
</head>
<body>
<div class="container">
    <div class="header">
        <div>
            <div class="logo">T-TERM</div>
            <div class="subtitle">Administration</div>
        </div>
        <a class="back-btn" href="/">Back to terminal</a>
    </div>

    <div class="tabs">
        <div class="tab active" onclick="switchTab('sessions')">Sessions</div>
        <div class="tab" onclick="switchTab('devices')">Devices</div>
        <div class="tab" onclick="switchTab('audit')">Audit Log</div>
        <div class="tab" onclick="switchTab('invites')">Invites</div>
    </div>

    <!-- Sessions Panel -->
    <div class="panel active" id="panel-sessions">
        <div class="section-title" id="sessions-count"></div>
        <div id="sessions-list"></div>
    </div>

    <!-- Devices Panel -->
    <div class="panel" id="panel-devices">
        <div class="section-title" id="devices-count"></div>
        <div id="devices-list"></div>
    </div>

    <!-- Audit Panel -->
    <div class="panel" id="panel-audit">
        <div class="section-title" id="audit-count"></div>
        <div id="audit-list"></div>
    </div>

    <!-- Invites Panel -->
    <div class="panel" id="panel-invites">
        <div class="wl-form">
            <input class="wl-input" id="invite-email" placeholder="Email address to invite" type="email">
            <button class="btn-action" onclick="createInvite()">Generate Link</button>
        </div>
        <div id="invite-link-box" style="display:none; margin:16px 0; padding:12px 16px; background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.2); border-radius:8px;">
            <div style="font-family:'Share Tech Mono',monospace; font-size:10px; color:#475569; letter-spacing:1px; margin-bottom:8px;">INVITE LINK (copy and send):</div>
            <div id="invite-link-text" style="font-family:'Share Tech Mono',monospace; font-size:11px; color:#38bdf8; word-break:break-all; margin-bottom:8px;"></div>
            <button class="btn-action" onclick="copyInviteLink()" style="font-size:10px; padding:6px 12px;">Copy Link</button>
            <span id="copy-confirm" style="font-family:'Share Tech Mono',monospace; font-size:10px; color:#22c55e; margin-left:8px; display:none;">Copied!</span>
        </div>
        <div class="section-title" id="invites-count"></div>
        <div id="invites-list"></div>
    </div>
</div>

<script>
function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelector('.tab[onclick*="' + name + '"]').classList.add('active');
    document.getElementById('panel-' + name).classList.add('active');
}

// Sessions
async function loadSessions() {
    const resp = await fetch('/auth/sessions-list');
    const sessions = await resp.json();
    const el = document.getElementById('sessions-list');
    document.getElementById('sessions-count').textContent = sessions.length + ' active session' + (sessions.length !== 1 ? 's' : '');
    if (sessions.length === 0) { el.innerHTML = '<div class="empty">No active sessions</div>'; return; }
    el.innerHTML = sessions.map((s, i) => {
        const remaining = Math.max(0, Math.round((s.expires - Date.now()) / 60000));
        const hours = Math.floor(remaining / 60), mins = remaining % 60;
        const timeLeft = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
        const machine = s.machine ? '<strong style="color:#38bdf8">' + s.machine + '</strong> · ' : '';
        return '<div class="card" style="animation-delay:' + (i * 0.04) + 's">' +
            '<div class="dot ' + (s.isCurrent ? 'dot-blue' : 'dot-green') + '"></div>' +
            '<div class="card-info">' +
                '<div class="card-label">' + machine + s.browser + ' on ' + s.os +
                    (s.isCurrent ? ' <span class="tag tag-blue">THIS DEVICE</span>' : '') + '</div>' +
                '<div class="card-meta"><span>' + s.ip + '</span><span>' + s.id + '</span><span>' + timeLeft + ' left</span></div>' +
                (s.screen || s.gpu ? '<div class="card-meta">' + (s.screen ? '<span>' + s.screen + '</span>' : '') + (s.gpu ? '<span>' + s.gpu.substring(0,40) + '</span>' : '') + '</div>' : '') +
            '</div>' +
            (s.isCurrent ? '' : '<button class="btn-danger" onclick="killSession(\\'' + s.fullId + '\\', this)">Revoke</button>') +
        '</div>';
    }).join('');
}

async function killSession(id, btn) {
    btn.textContent = '...';
    await fetch('/auth/kill-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) });
    loadSessions();
}

// Devices
async function loadDevices() {
    const resp = await fetch('/admin/devices');
    const devices = await resp.json();
    const el = document.getElementById('devices-list');
    document.getElementById('devices-count').textContent = devices.length + ' registered device' + (devices.length !== 1 ? 's' : '');
    if (devices.length === 0) { el.innerHTML = '<div class="empty">No devices registered</div>'; return; }
    el.innerHTML = devices.map((d, i) => {
        const name = d.displayName || d.username || 'Unknown';
        const roleTag = d.role === 'admin' ? '<span class="tag tag-amber">ADMIN</span>' : '<span class="tag tag-blue">USER</span>';
        const deviceLabel = [d.device, d.browser, d.os].filter(Boolean).join(' · ') || d.deviceType;
        return '<div class="card" style="animation-delay:' + (i * 0.04) + 's">' +
            '<div class="dot dot-blue"></div>' +
            '<div class="card-info">' +
                '<div class="card-label">' + name + ' ' + roleTag +
                    (d.username ? ' <span style="color:#475569;font-size:10px">@' + d.username + '</span>' : '') + '</div>' +
                '<div class="card-meta">' +
                    '<span>' + deviceLabel + '</span>' +
                    (d.backedUp ? '<span class="tag tag-green">BACKED UP</span>' : '') +
                '</div>' +
                '<div class="card-meta">' +
                    (d.email ? '<span>' + d.email + '</span>' : '') +
                    (d.ip ? '<span>' + d.ip + '</span>' : '') +
                    '<span>' + new Date(d.registeredAt).toLocaleDateString() + '</span>' +
                '</div>' +
            '</div>' +
            '<button class="btn-danger" onclick="removeDevice(' + d.index + ', this)">Remove</button>' +
        '</div>';
    }).join('');
}

async function labelDevice(index, label) {
    await fetch('/admin/label-device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index, label }) });
}

async function removeDevice(index, btn) {
    if (!confirm('Remove this device? It will no longer be able to approve logins.')) return;
    btn.textContent = '...';
    await fetch('/admin/remove-device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index }) });
    loadDevices();
}

// Audit
async function loadAudit() {
    const resp = await fetch('/admin/audit');
    const log = await resp.json();
    const el = document.getElementById('audit-list');
    document.getElementById('audit-count').textContent = log.length + ' event' + (log.length !== 1 ? 's' : '');
    if (log.length === 0) { el.innerHTML = '<div class="empty">No events recorded</div>'; return; }

    const eventColors = {
        login_passkey: 'green', login_backup: 'amber', login_failed: 'red',
        register: 'blue', device_removed: 'red',
        session_new: 'blue', session_reattach: 'green', session_disconnect: 'amber',
        invite_created: 'blue', invite_used: 'green', invite_revoked: 'red',
    };
    const eventLabels = {
        login_passkey: 'Login (Passkey)', login_backup: 'Login (Backup Code)', login_failed: 'Login Failed',
        register: 'Device Registered', device_removed: 'Device Removed',
        session_new: 'New Session', session_reattach: 'Reattached', session_disconnect: 'Disconnected',
        invite_created: 'Invite Sent', invite_used: 'Invite Used', invite_revoked: 'Invite Revoked',
    };

    el.innerHTML = log.map((e, i) => {
        const color = eventColors[e.event] || 'blue';
        const label = eventLabels[e.event] || e.event;
        const dt = new Date(e.time);
        const date = dt.toLocaleDateString();
        const time = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const details = [];
        if (e.user) details.push('<strong style="color:#38bdf8">' + e.user + '</strong>');
        if (e.project) details.push(e.project);
        if (e.device) details.push(e.device);
        if (e.browser) details.push(e.browser);
        if (e.ip) details.push(e.ip);
        if (e.email) details.push(e.email);
        if (e.error) details.push(e.error);
        if (e.deviceType) details.push(e.deviceType);
        if (e.label && !e.user) details.push(e.label);
        return '<div class="card" style="animation-delay:' + (Math.min(i, 20) * 0.03) + 's">' +
            '<div class="dot dot-' + color + '"></div>' +
            '<div class="card-info">' +
                '<div class="card-label">' + label + ' <span class="tag tag-' + color + '">' + e.event.toUpperCase() + '</span></div>' +
                '<div class="card-meta"><span>' + date + ' ' + time + '</span>' + details.map(d => '<span>' + d + '</span>').join('') + '</div>' +
            '</div>' +
        '</div>';
    }).join('');
}

let lastInviteLink = '';

async function loadInvites() {
    try {
        const resp = await fetch('/admin/invites');
        const invites = await resp.json();
        const el = document.getElementById('invites-list');
        const countEl = document.getElementById('invites-count');
        const pending = invites.filter(i => i.status === 'pending');
        countEl.textContent = pending.length + ' pending, ' + invites.length + ' total';
        el.innerHTML = invites.sort((a,b) => b.createdAt - a.createdAt).map(i => {
            const dotColor = i.status === 'pending' ? '#22c55e' : i.status === 'used' ? '#38bdf8' : '#ef4444';
            const statusTag = i.status === 'pending' ? 'PENDING' : i.status === 'used' ? 'USED' : i.status.toUpperCase();
            const date = new Date(i.createdAt).toLocaleString();
            const expires = new Date(i.expiresAt).toLocaleString();
            const usedInfo = i.usedBy ? ' by ' + i.usedBy + ' at ' + new Date(i.usedAt).toLocaleString() : '';
            const revokeBtn = i.status === 'pending' ? '<button class="btn-remove" onclick="revokeInvite(\\'' + i.id + '\\', this)">Revoke</button>' : '';
            return '<div class="card"><div class="dot" style="background:' + dotColor + '"></div>' +
                '<div class="card-info"><div class="card-label">' + i.email + ' <span style="opacity:0.5; font-size:10px;">(' + statusTag + ')</span></div>' +
                '<div class="card-meta">Created: ' + date + ' | Expires: ' + expires + usedInfo + '</div></div>' +
                revokeBtn + '</div>';
        }).join('');
    } catch(e) {}
}

async function createInvite() {
    const email = document.getElementById('invite-email').value.trim();
    if (!email || !email.includes('@')) { alert('Enter a valid email'); return; }
    try {
        const resp = await fetch('/admin/invite-create', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await resp.json();
        if (data.error) { alert(data.error); return; }
        lastInviteLink = data.link;
        document.getElementById('invite-link-text').textContent = data.link;
        document.getElementById('invite-link-box').style.display = 'block';
        document.getElementById('invite-email').value = '';
        loadInvites();
    } catch(e) { alert('Failed to create invite'); }
}

function copyInviteLink() {
    navigator.clipboard.writeText(lastInviteLink).then(() => {
        const c = document.getElementById('copy-confirm');
        c.style.display = 'inline'; setTimeout(() => c.style.display = 'none', 2000);
    });
}

async function revokeInvite(id, btn) {
    btn.disabled = true; btn.textContent = 'Revoking...';
    try {
        await fetch('/admin/invite-revoke', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        loadInvites();
    } catch(e) { btn.disabled = false; btn.textContent = 'Revoke'; }
}

// Init
loadSessions();
loadDevices();
loadAudit();
loadInvites();
setInterval(loadSessions, 10000);
</script>
</body>
</html>`;
}

module.exports = adminPageHTML;
