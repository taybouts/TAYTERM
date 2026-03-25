function inviteRegisterHTML(invite) {
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>T-TERM — You're Invited</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body {
    min-height: 100vh;
    background: linear-gradient(135deg, #0a0a0f 0%, #0d1117 30%, #0a0f1a 60%, #0a0a0f 100%);
    font-family: 'Segoe UI', Arial, sans-serif; color: #e6edf3;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    position: relative; overflow: hidden;
}
body::before {
    content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    background-image: linear-gradient(rgba(56, 189, 248, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(56, 189, 248, 0.03) 1px, transparent 1px);
    background-size: 60px 60px; z-index: 0;
}
.container {
    position: relative; z-index: 1; text-align: center;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 24px; padding: 48px 44px; backdrop-filter: blur(20px);
    max-width: 420px; width: 90%;
}
.logo { font-family: 'Rajdhani', sans-serif; font-size: 48px; font-weight: 700; letter-spacing: 12px;
    background: linear-gradient(135deg, #38bdf8 0%, #0284c7 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 4px; }
.subtitle { font-family: 'Share Tech Mono', monospace; font-size: 11px; letter-spacing: 6px; color: #475569; margin-bottom: 32px; text-transform: uppercase; }
.invite-badge { display: inline-block; padding: 8px 16px; border-radius: 8px;
    background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.2);
    color: #38bdf8; font-family: 'Share Tech Mono', monospace; font-size: 12px;
    letter-spacing: 1px; margin-bottom: 28px; }
.form-group { margin-bottom: 16px; text-align: left; }
.form-label { font-family: 'Share Tech Mono', monospace; font-size: 10px; letter-spacing: 2px;
    color: #475569; text-transform: uppercase; margin-bottom: 6px; display: block; }
.form-input { width: 100%; padding: 12px 16px; background: rgba(255,255,255,0.04);
    color: #e6edf3; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
    font-family: 'Segoe UI', sans-serif; font-size: 14px; }
.form-input:focus { outline: none; border-color: rgba(56, 189, 248, 0.4); }
.form-input:read-only { opacity: 0.6; cursor: not-allowed; }
.btn { display: block; width: 100%; padding: 14px; border-radius: 10px; border: none;
    background: linear-gradient(135deg, #0284c7, #38bdf8); color: white;
    font-family: 'Rajdhani', sans-serif; font-size: 16px; font-weight: 700;
    cursor: pointer; letter-spacing: 2px; text-transform: uppercase; transition: all 0.3s; margin-top: 8px; }
.btn:hover { box-shadow: 0 4px 20px rgba(2,132,199,0.3); }
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-success { background: linear-gradient(135deg, #059669, #22c55e); }
.error { color: #ef4444; margin-top: 12px; font-size: 12px; font-family: 'Share Tech Mono', monospace; display: none; }
.status { margin-top: 16px; font-family: 'Share Tech Mono', monospace; font-size: 12px; color: #94a3b8; display: none; }
#step-2 { display: none; }
#step-3 { display: none; }
.backup-codes { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px; padding: 16px; margin: 16px 0; font-family: 'Share Tech Mono', monospace;
    font-size: 14px; letter-spacing: 2px; line-height: 2; color: #38bdf8; }
</style></head><body>
<div class="container">
    <div class="logo">T-TERM</div>
    <div class="subtitle">You're Invited</div>
    <div class="invite-badge">Invited: ${invite.email}</div>

    <div id="step-1">
        <div class="form-group">
            <label class="form-label">Username</label>
            <input class="form-input" id="username" placeholder="Choose a username" autocomplete="off">
        </div>
        <div class="form-group">
            <label class="form-label">Display Name</label>
            <input class="form-input" id="displayName" placeholder="Your name">
        </div>
        <div class="form-group">
            <label class="form-label">Email</label>
            <input class="form-input" id="email" value="${invite.email}" readonly>
        </div>
        <button class="btn" id="btn-continue" onclick="submitProfile()">Continue</button>
    </div>

    <div id="step-2">
        <p style="color:#94a3b8; margin-bottom:20px;">Register a passkey using your device's biometrics</p>
        <button class="btn" id="btn-register" onclick="registerDevice()">Register Passkey</button>
    </div>

    <div id="step-3">
        <p style="color:#22c55e; margin-bottom:16px; font-family:'Share Tech Mono',monospace; letter-spacing:1px;">Registration complete!</p>
        <p style="color:#94a3b8; margin-bottom:12px; font-size:13px;">Save your backup codes. They can be used if you lose access to your device:</p>
        <div class="backup-codes" id="backup-codes"></div>
        <button class="btn btn-success" onclick="window.location.href='/'">Continue to T-TERM</button>
    </div>

    <div class="error" id="error"></div>
    <div class="status" id="status"></div>
</div>
<script src="https://unpkg.com/@simplewebauthn/browser/dist/bundle/index.umd.min.js"></script>
<script>
const INVITE_TOKEN = '${invite.token}';
const headers = { 'Content-Type': 'application/json', 'x-invite-token': INVITE_TOKEN };

function showError(msg) {
    const el = document.getElementById('error');
    el.textContent = msg; el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 5000);
}

async function submitProfile() {
    const username = document.getElementById('username').value.trim();
    const displayName = document.getElementById('displayName').value.trim();
    const email = document.getElementById('email').value.trim();
    if (!username || username.length < 2) { showError('Username is required (min 2 characters)'); return; }
    const btn = document.getElementById('btn-continue');
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
        const resp = await fetch('/register/profile', {
            method: 'POST', headers,
            body: JSON.stringify({ username, displayName, email })
        });
        const data = await resp.json();
        if (data.error) { showError(data.error); btn.disabled = false; btn.textContent = 'Continue'; return; }
        document.getElementById('step-1').style.display = 'none';
        document.getElementById('step-2').style.display = 'block';
    } catch(e) { showError('Network error'); btn.disabled = false; btn.textContent = 'Continue'; }
}

async function registerDevice() {
    const btn = document.getElementById('btn-register');
    btn.disabled = true; btn.textContent = 'Waiting for device...';
    try {
        const optResp = await fetch('/register/start', { method: 'POST', headers });
        const options = await optResp.json();
        if (options.error) { showError(options.error); btn.disabled = false; btn.textContent = 'Register Passkey'; return; }
        const credential = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
        const verResp = await fetch('/register/finish', {
            method: 'POST', headers,
            body: JSON.stringify(credential)
        });
        const result = await verResp.json();
        if (result.verified) {
            document.getElementById('step-2').style.display = 'none';
            document.getElementById('step-3').style.display = 'block';
            if (result.backupCodes) {
                document.getElementById('backup-codes').textContent = result.backupCodes.join('\\n');
            }
        } else { showError(result.error || 'Registration failed'); btn.disabled = false; btn.textContent = 'Register Passkey'; }
    } catch(e) { showError(e.message || 'Registration cancelled'); btn.disabled = false; btn.textContent = 'Register Passkey'; }
}
</script>
</body></html>`;
}

module.exports = inviteRegisterHTML;
