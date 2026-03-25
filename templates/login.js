function loginPageHTML(token, qrDataUrl) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>T-TERM — Sign In</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body {
    min-height: 100vh;
    background: linear-gradient(135deg, #0a0a0f 0%, #0d1117 30%, #0a0f1a 60%, #0a0a0f 100%);
    font-family: 'Segoe UI', Arial, sans-serif;
    color: #e6edf3;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    position: relative; overflow: hidden;
}
body::before {
    content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    background-image:
        linear-gradient(rgba(56, 189, 248, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(56, 189, 248, 0.03) 1px, transparent 1px);
    background-size: 60px 60px; z-index: 0;
}
body::after {
    content: ''; position: fixed; width: 100%; height: 2px; left: 0;
    background: linear-gradient(90deg, transparent, rgba(56,189,248,0.06), transparent);
    animation: scan 8s linear infinite; z-index: 0; pointer-events: none;
}
@keyframes scan { from { top: -2px; } to { top: 100%; } }
.container {
    position: relative; z-index: 1; text-align: center;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 24px; padding: 48px 44px; backdrop-filter: blur(20px);
    max-width: 420px; width: 90%;
    animation: containerIn 0.8s ease;
}
@keyframes containerIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
.logo {
    font-family: 'Rajdhani', sans-serif; font-size: 48px; font-weight: 700;
    letter-spacing: 12px; text-transform: uppercase;
    background: linear-gradient(135deg, #38bdf8 0%, #0284c7 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 4px;
    animation: titleIn 1s ease; animation-fill-mode: both;
}
@keyframes titleIn { from { opacity: 0; letter-spacing: 20px; } to { opacity: 1; letter-spacing: 12px; } }
.subtitle {
    font-family: 'Share Tech Mono', monospace; font-size: 11px;
    letter-spacing: 6px; color: #475569; margin-bottom: 40px; text-transform: uppercase;
    animation: fadeIn 1s ease 0.2s; animation-fill-mode: both;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.qr-container {
    background: white; border-radius: 16px; padding: 16px; display: inline-block;
    margin-bottom: 24px;
    box-shadow: 0 0 40px rgba(56, 189, 248, 0.1);
    animation: pulse 3s ease-in-out infinite, fadeIn 0.8s ease 0.4s both;
}
.qr-container img { display: block; border-radius: 8px; width: 220px; height: 220px; }
.scan-text {
    font-family: 'Segoe UI', sans-serif; font-size: 14px; color: #94a3b8; margin-bottom: 6px;
    animation: fadeIn 1s ease 0.5s both;
}
.scan-hint {
    font-family: 'Share Tech Mono', monospace; font-size: 10px; color: #475569;
    letter-spacing: 1px;
    animation: fadeIn 1s ease 0.6s both;
}
.status {
    margin-top: 24px; padding: 12px 20px; border-radius: 8px;
    font-family: 'Share Tech Mono', monospace; font-size: 12px; letter-spacing: 1px;
    animation: fadeIn 1s ease 0.7s both;
}
.waiting { background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.2); color: #38bdf8; }
.approved { background: rgba(34, 197, 94, 0.08); border: 1px solid rgba(34, 197, 94, 0.2); color: #22c55e; }
@keyframes pulse {
    0%, 100% { box-shadow: 0 0 20px rgba(56, 189, 248, 0.1); }
    50% { box-shadow: 0 0 50px rgba(56, 189, 248, 0.2); }
}
.orb { position: absolute; border-radius: 50%; filter: blur(100px); opacity: 0.08; z-index: 0; }
.orb1 { width: 400px; height: 400px; background: #38bdf8; top: -150px; left: -150px; }
.orb2 { width: 300px; height: 300px; background: #0284c7; bottom: -100px; right: -100px; }
.orb3 { width: 200px; height: 200px; background: #38bdf8; top: 50%; left: 60%; }
.hud { position: fixed; width: 28px; height: 28px; z-index: 2; pointer-events: none; opacity: 0.15; }
.hud::before, .hud::after { content: ''; position: absolute; background: #38bdf8; }
.hud-tl { top: 10px; left: 10px; } .hud-tl::before { width: 18px; height: 1px; } .hud-tl::after { width: 1px; height: 18px; }
.hud-tr { top: 10px; right: 10px; } .hud-tr::before { width: 18px; height: 1px; right: 0; } .hud-tr::after { width: 1px; height: 18px; right: 0; }
.hud-bl { bottom: 10px; left: 10px; } .hud-bl::before { width: 18px; height: 1px; bottom: 0; } .hud-bl::after { width: 1px; height: 18px; bottom: 0; }
.hud-br { bottom: 10px; right: 10px; } .hud-br::before { width: 18px; height: 1px; right: 0; bottom: 0; } .hud-br::after { width: 1px; height: 18px; right: 0; bottom: 0; }
.divider { border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 24px 0; }
.btn-passkey {
    display: block; width: 100%; padding: 14px; border-radius: 10px; border: none;
    background: linear-gradient(135deg, #0284c7, #38bdf8);
    color: white; font-family: 'Rajdhani', sans-serif; font-size: 16px;
    font-weight: 700; cursor: pointer; letter-spacing: 2px; text-transform: uppercase;
    transition: all 0.3s; margin-bottom: 16px;
}
.btn-passkey:hover { box-shadow: 0 4px 20px rgba(2,132,199,0.3); }
.btn-passkey:active { transform: scale(0.97); }
.btn-passkey:disabled { opacity: 0.5; cursor: not-allowed; }
.backup-link {
    font-family: 'Share Tech Mono', monospace; font-size: 10px; letter-spacing: 1px;
    color: #475569; cursor: pointer; text-decoration: none; text-transform: uppercase;
    transition: color 0.2s;
}
.backup-link:hover { color: #38bdf8; }
#backup-section { display: none; margin-top: 16px; }
.backup-input {
    width: 100%; padding: 12px; background: rgba(255,255,255,0.04);
    color: #e6edf3; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
    font-family: 'Share Tech Mono', monospace; font-size: 16px; text-align: center;
    letter-spacing: 4px; text-transform: uppercase; margin-bottom: 12px;
}
.backup-input:focus { outline: none; border-color: rgba(56, 189, 248, 0.4); }
.btn-backup {
    display: inline-block; padding: 10px 32px; border-radius: 8px; border: none;
    background: linear-gradient(135deg, #0284c7, #38bdf8);
    color: white; font-family: 'Share Tech Mono', monospace; font-size: 11px;
    font-weight: 600; cursor: pointer; letter-spacing: 2px; text-transform: uppercase;
    transition: all 0.3s;
}
.btn-backup:hover { box-shadow: 0 4px 16px rgba(2, 132, 199, 0.3); }
.btn-backup:active { transform: scale(0.97); }
.error { color: #ef4444; margin-top: 12px; font-size: 12px; font-family: 'Share Tech Mono', monospace; display: none; }
</style>
</head>
<body>
<div class="hud hud-tl"></div><div class="hud hud-tr"></div>
<div class="hud hud-bl"></div><div class="hud hud-br"></div>
<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div class="orb orb3"></div>
<div class="container">
    <div class="logo">T-TERM</div>
    <div class="subtitle">Secure Access</div>
    <div id="qr-section">
        <div class="qr-container">
            <img src="${qrDataUrl}" alt="Scan to login">
        </div>
        <div class="scan-text">Scan with your phone to sign in</div>
        <div class="scan-hint">Point your camera at the QR code</div>
        <div class="status waiting" id="status">Waiting for approval...</div>
    </div>
    <hr class="divider">
    <button class="btn-passkey" onclick="signInWithPasskey()">Sign in with Passkey</button>
    <a class="backup-link" id="backup-toggle" onclick="toggleBackup()">Use backup code instead</a>
    <div id="backup-section">
        <input class="backup-input" id="backup-code" placeholder="XXXX-XXXX" maxlength="9">
        <button class="btn-backup" onclick="submitBackup()">Submit</button>
    </div>
    <div class="error" id="error"></div>
</div>
<script>
const TOKEN = '${token}';
let polling = true;

// Collect device fingerprint automatically
function getDeviceInfo() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    let gpu = '';
    if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    }
    return {
        screen: screen.width + 'x' + screen.height,
        pixelRatio: window.devicePixelRatio || 1,
        cores: navigator.hardwareConcurrency || 0,
        memory: navigator.deviceMemory || 0,
        gpu: gpu,
        platform: navigator.platform || '',
        language: navigator.language || '',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        touch: navigator.maxTouchPoints > 0,
        darkMode: window.matchMedia('(prefers-color-scheme: dark)').matches,
    };
}
const deviceInfo = getDeviceInfo();

const poll = setInterval(async () => {
    if (!polling) return;
    try {
        const resp = await fetch('/check?token=' + TOKEN + '&info=' + encodeURIComponent(JSON.stringify(deviceInfo)));
        const data = await resp.json();
        if (data.approved) {
            clearInterval(poll);
            const s = document.getElementById('status');
            s.textContent = 'Approved! Loading terminal...';
            s.className = 'status approved';
            setTimeout(() => { window.location.href = '/'; }, 800);
        }
    } catch(e) {}
}, 1500);

function toggleBackup() {
    const sec = document.getElementById('backup-section');
    sec.style.display = sec.style.display === 'none' ? 'block' : 'none';
    if (sec.style.display === 'block') document.getElementById('backup-code').focus();
}

function showError(msg) {
    const el = document.getElementById('error');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 5000);
}

async function submitBackup() {
    const code = document.getElementById('backup-code').value.trim();
    if (!code) { showError('Enter a backup code'); return; }
    try {
        const resp = await fetch('/do-approve?token=' + TOKEN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backupCode: code }),
        });
        const data = await resp.json();
        if (data.ok) {
            const s = document.getElementById('status');
            s.textContent = 'Approved! Loading terminal...';
            s.className = 'status approved';
            setTimeout(() => { window.location.href = '/'; }, 800);
        } else {
            showError(data.error || 'Invalid backup code');
        }
    } catch(e) {
        showError('Network error');
    }
}

document.getElementById('backup-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitBackup();
});

async function signInWithPasskey() {
    const btn = document.querySelector('.btn-passkey');
    btn.disabled = true;
    btn.textContent = 'Authenticating...';
    polling = false;

    try {
        const optResp = await fetch('/auth/passkey-options', { method: 'POST' });
        const options = await optResp.json();
        if (options.error) { showError(options.error); btn.disabled = false; btn.textContent = 'Sign in with Passkey'; polling = true; return; }

        const credential = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });

        const verResp = await fetch('/auth/passkey-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credential),
        });
        const result = await verResp.json();

        if (result.ok) {
            btn.textContent = 'Success!';
            btn.style.background = 'linear-gradient(135deg, #059669, #22c55e)';
            setTimeout(() => { window.location.href = '/'; }, 500);
        } else {
            showError(result.error || 'Authentication failed');
            btn.disabled = false;
            btn.textContent = 'Sign in with Passkey';
            polling = true;
        }
    } catch (e) {
        showError(e.message || 'Authentication cancelled');
        btn.disabled = false;
        btn.textContent = 'Sign in with Passkey';
        polling = true;
    }
}
</script>
<script src="https://unpkg.com/@simplewebauthn/browser/dist/bundle/index.umd.min.js"></script>
</body>
</html>`;
}

module.exports = loginPageHTML;
