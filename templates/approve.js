function approvePageHTML(token) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>T-TERM — Approve</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body {
    min-height: 100vh;
    background: linear-gradient(135deg, #0a0a0f 0%, #0d1117 50%, #0a0a0f 100%);
    font-family: 'Segoe UI', Arial, sans-serif; color: #e6edf3;
    display: flex; align-items: center; justify-content: center;
    position: relative; overflow: hidden;
}
body::before {
    content: ''; position: fixed; inset: 0;
    background-image: linear-gradient(rgba(56,189,248,0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(56,189,248,0.03) 1px, transparent 1px);
    background-size: 60px 60px; z-index: 0; pointer-events: none;
}
.orb { position: absolute; border-radius: 50%; filter: blur(100px); opacity: 0.08; z-index: 0; }
.orb1 { width: 300px; height: 300px; background: #38bdf8; top: -100px; left: -80px; }
.orb2 { width: 200px; height: 200px; background: #0284c7; bottom: -60px; right: -40px; }
.container {
    text-align: center; padding: 44px 36px;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 24px; max-width: 360px; width: 92%;
    backdrop-filter: blur(20px); position: relative; z-index: 1;
    animation: containerIn 0.6s ease;
}
@keyframes containerIn { from { opacity: 0; transform: translateY(16px); } }
.logo {
    font-family: 'Rajdhani', sans-serif; font-size: 32px; font-weight: 700;
    letter-spacing: 8px; text-transform: uppercase;
    background: linear-gradient(135deg, #38bdf8, #0284c7);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    margin-bottom: 4px;
}
.subtitle {
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    letter-spacing: 4px; color: #475569; text-transform: uppercase; margin-bottom: 28px;
}
.icon {
    font-size: 44px; margin-bottom: 16px;
    animation: fadeIn 0.6s ease 0.2s both;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.message {
    font-size: 14px; color: #94a3b8; margin-bottom: 28px; line-height: 1.6;
    animation: fadeIn 0.6s ease 0.3s both;
}
.btn {
    display: block; width: 100%; padding: 16px; border-radius: 12px; border: none;
    background: linear-gradient(135deg, #0284c7, #38bdf8);
    color: white; font-family: 'Rajdhani', sans-serif; font-size: 16px;
    font-weight: 700; cursor: pointer; letter-spacing: 2px; text-transform: uppercase;
    transition: all 0.3s; animation: fadeIn 0.6s ease 0.4s both;
}
.btn:hover { box-shadow: 0 4px 20px rgba(2,132,199,0.3); }
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.done { background: linear-gradient(135deg, #059669, #22c55e); }
.error {
    color: #ef4444; margin-top: 16px;
    font-family: 'Share Tech Mono', monospace; font-size: 11px; display: none;
}
.status {
    color: #475569; margin-top: 12px;
    font-family: 'Share Tech Mono', monospace; font-size: 11px; letter-spacing: 1px;
}
</style>
</head>
<body>
<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div class="container">
    <div class="logo">T-TERM</div>
    <div class="subtitle">Approve Access</div>
    <div class="icon" id="icon">&#128274;</div>
    <div class="message" id="msg">A device is requesting access to your terminal</div>
    <button class="btn" id="btn" onclick="approve()">Approve Login</button>
    <div class="error" id="error"></div>
    <div class="status" id="status"></div>
</div>
<script src="https://unpkg.com/@simplewebauthn/browser/dist/bundle/index.umd.min.js"></script>
<script>
const TOKEN = '${token}';
const { startAuthentication } = SimpleWebAuthnBrowser;

async function approve() {
    const btn = document.getElementById('btn');
    const msg = document.getElementById('msg');
    const icon = document.getElementById('icon');
    const status = document.getElementById('status');
    btn.disabled = true;
    btn.textContent = 'Verifying identity...';
    status.textContent = '';

    try {
        // Step 1: Get WebAuthn challenge from server
        const optResp = await fetch('/auth/approve-options?token=' + TOKEN, { method: 'POST' });
        const options = await optResp.json();
        if (options.error) {
            showError(options.error);
            btn.disabled = false;
            btn.textContent = 'Approve Login';
            return;
        }

        // Step 2: Trigger Face ID / biometric
        status.textContent = 'Confirm with Face ID...';
        const credential = await startAuthentication({ optionsJSON: options });

        // Step 3: Send signed response to server
        status.textContent = 'Verifying...';
        const resp = await fetch('/do-approve?token=' + TOKEN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credential),
        });
        const data = await resp.json();

        if (data.ok) {
            btn.textContent = 'Approved!';
            btn.classList.add('done');
            icon.innerHTML = '&#9989;';
            msg.textContent = 'Terminal access granted. You can close this page.';
            status.textContent = '';
        } else {
            showError(data.error || 'Verification failed');
            btn.disabled = false;
            btn.textContent = 'Approve Login';
        }
    } catch(e) {
        showError(e.message || 'Authentication cancelled');
        btn.disabled = false;
        btn.textContent = 'Try Again';
    }
}

function showError(msg) {
    const el = document.getElementById('error');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 5000);
}
</script>
</body>
</html>`;
}

module.exports = approvePageHTML;
