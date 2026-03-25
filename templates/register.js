const REGISTER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>T-TERM — Register Device</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body {
    min-height: 100vh; max-width: 100vw;
    background: linear-gradient(135deg, #0a0a0f 0%, #0d1117 30%, #0a0f1a 60%, #0a0a0f 100%);
    font-family: 'Segoe UI', Arial, sans-serif; color: #e6edf3;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    position: relative; overflow-x: hidden; overflow-y: auto;
    padding: 40px 20px;
}
html { max-width: 100vw; }
@media (max-width: 500px) {
    body { justify-content: flex-start; padding-top: 60px; }
}
body::before {
    content: ''; position: fixed; inset: 0;
    background-image: linear-gradient(rgba(56,189,248,0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(56,189,248,0.03) 1px, transparent 1px);
    background-size: 60px 60px; z-index: 0; pointer-events: none;
}
body::after {
    content: ''; position: fixed; width: 100%; height: 2px; left: 0;
    background: linear-gradient(90deg, transparent, rgba(56,189,248,0.06), transparent);
    animation: scan 8s linear infinite; z-index: 0; pointer-events: none;
}
@keyframes scan { from { top: -2px; } to { top: 100%; } }
.orb { position: absolute; border-radius: 50%; filter: blur(100px); opacity: 0.08; z-index: 0; }
.orb1 { width: 400px; height: 400px; background: #0284c7; top: -150px; left: -150px; }
.orb2 { width: 300px; height: 300px; background: #38bdf8; bottom: -100px; right: -100px; }
.hud { position: fixed; width: 28px; height: 28px; z-index: 2; pointer-events: none; opacity: 0.15; }
.hud::before, .hud::after { content: ''; position: absolute; background: #38bdf8; }
.hud-tl { top: 10px; left: 10px; } .hud-tl::before { width: 18px; height: 1px; } .hud-tl::after { width: 1px; height: 18px; }
.hud-tr { top: 10px; right: 10px; } .hud-tr::before { width: 18px; height: 1px; right: 0; } .hud-tr::after { width: 1px; height: 18px; right: 0; }
.hud-bl { bottom: 10px; left: 10px; } .hud-bl::before { width: 18px; height: 1px; bottom: 0; } .hud-bl::after { width: 1px; height: 18px; bottom: 0; }
.hud-br { bottom: 10px; right: 10px; } .hud-br::before { width: 18px; height: 1px; right: 0; bottom: 0; } .hud-br::after { width: 1px; height: 18px; right: 0; bottom: 0; }
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
    background-clip: text; margin-bottom: 4px;
}
.subtitle {
    font-family: 'Share Tech Mono', monospace; font-size: 11px;
    letter-spacing: 6px; color: #475569; margin-bottom: 36px; text-transform: uppercase;
}
.icon-shield {
    width: 56px; height: 56px; margin: 0 auto 20px;
    border: 2px solid rgba(56,189,248,0.3); border-radius: 14px;
    display: flex; align-items: center; justify-content: center;
    background: rgba(56,189,248,0.06);
    animation: fadeIn 0.6s ease 0.3s both;
}
.icon-shield svg { width: 28px; height: 28px; color: #38bdf8; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.description {
    font-size: 13px; color: #64748b; line-height: 1.6; margin-bottom: 24px;
    animation: fadeIn 0.6s ease 0.4s both;
}
.form-group { margin-bottom: 16px; text-align: left; animation: fadeIn 0.6s ease 0.5s both; }
.form-label {
    font-family: 'Share Tech Mono', monospace; font-size: 9px;
    letter-spacing: 2px; color: #475569; text-transform: uppercase;
    margin-bottom: 6px; display: block;
}
.form-input {
    width: 100%; padding: 12px 14px; background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08); border-radius: 10px;
    font-family: 'Segoe UI', sans-serif; font-size: 15px; color: #e6edf3;
    outline: none; transition: border-color 0.2s;
}
.form-input:focus { border-color: rgba(56,189,248,0.4); }
.form-input::placeholder { color: #475569; }
.btn {
    display: block; width: 100%; padding: 14px; border-radius: 10px; border: none;
    background: linear-gradient(135deg, #0284c7, #38bdf8);
    color: white; font-family: 'Rajdhani', sans-serif; font-size: 16px;
    font-weight: 700; cursor: pointer; letter-spacing: 2px; text-transform: uppercase;
    transition: all 0.3s; animation: fadeIn 0.6s ease 0.6s both;
}
.btn:hover { box-shadow: 0 4px 20px rgba(2,132,199,0.3); }
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.done { background: linear-gradient(135deg, #059669, #22c55e); }
.error { color: #ef4444; margin-top: 16px; font-family: 'Share Tech Mono', monospace; font-size: 11px; display: none; }
.status { color: #475569; margin-top: 12px; font-family: 'Share Tech Mono', monospace; font-size: 11px; letter-spacing: 1px; }
.backup-codes {
    display: none; margin-top: 24px; text-align: left;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 12px; padding: 20px;
}
.backup-codes h3 {
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    color: #f59e0b; margin-bottom: 8px; letter-spacing: 2px; text-transform: uppercase;
}
.backup-codes p { color: #64748b; font-size: 12px; margin-bottom: 12px; line-height: 1.5; }
.code-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
    font-family: 'Share Tech Mono', monospace; font-size: 14px;
    letter-spacing: 3px; color: #22c55e;
}
.code-grid span {
    background: rgba(0,0,0,0.3); padding: 8px; border-radius: 6px; text-align: center;
    border: 1px solid rgba(34,197,94,0.15);
}
.btn-continue {
    display: block; width: 100%; padding: 14px; border-radius: 10px; border: none;
    background: linear-gradient(135deg, #059669, #22c55e);
    color: white; font-family: 'Rajdhani', sans-serif; font-size: 16px;
    font-weight: 700; cursor: pointer; letter-spacing: 2px; text-transform: uppercase;
    transition: all 0.3s; margin-top: 16px;
}
.btn-continue:hover { box-shadow: 0 4px 20px rgba(34,197,94,0.3); }
.btn-continue:active { transform: scale(0.97); }
.success-icon {
    width: 64px; height: 64px; margin: 0 auto 16px;
    border: 2px solid rgba(34,197,94,0.4); border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: rgba(34,197,94,0.08);
    animation: pop 0.4s ease;
}
@keyframes pop { from { transform: scale(0); } to { transform: scale(1); } }
.success-icon svg { width: 32px; height: 32px; color: #22c55e; }
.step-user {
    font-family: 'Share Tech Mono', monospace; font-size: 11px;
    color: #38bdf8; letter-spacing: 1px; margin-bottom: 20px;
    padding: 8px 16px; background: rgba(56,189,248,0.06);
    border: 1px solid rgba(56,189,248,0.15); border-radius: 8px;
    display: inline-block;
}
</style>
</head>
<body>
<div class="hud hud-tl"></div><div class="hud hud-tr"></div>
<div class="hud hud-bl"></div><div class="hud hud-br"></div>
<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div class="container">
    <div class="logo">T-TERM</div>
    <div class="subtitle">Create Account</div>

    <!-- Step 1: Profile -->
    <div id="step-profile">
        <div class="icon-shield">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
            </svg>
        </div>
        <div class="description">
            Set up your account to access T-Term. You'll register a passkey in the next step.
        </div>
        <div class="form-group">
            <label class="form-label">Username *</label>
            <input class="form-input" id="reg-username" placeholder="Choose a username" autocomplete="off" autofocus>
        </div>
        <div class="form-group">
            <label class="form-label">Display Name</label>
            <input class="form-input" id="reg-displayname" placeholder="Your name (optional)">
        </div>
        <div class="form-group">
            <label class="form-label">Email</label>
            <input class="form-input" id="reg-email" type="email" placeholder="Email (optional)">
        </div>
        <button class="btn" id="btn-profile" onclick="submitProfile()">Continue</button>
    </div>

    <!-- Step 2: Passkey -->
    <div id="step-passkey" style="display:none">
        <div class="icon-shield">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
        </div>
        <div class="description">
            Now register a passkey using your device's biometrics
            (Face ID, fingerprint, or PIN). This will be used to approve future logins.
        </div>
        <div class="step-user" id="step-user"></div>
        <button class="btn" id="btn-register" onclick="registerDevice()">Register Passkey</button>
    </div>

    <!-- Step 3: Backup codes -->
    <div class="backup-codes" id="backup-codes">
        <div class="success-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
            </svg>
        </div>
        <h3>Backup Codes</h3>
        <p>Save these codes somewhere safe. Each can be used once if you lose your device.</p>
        <div class="code-grid" id="code-grid"></div>
        <button class="btn-continue" onclick="window.location='/'">Continue to T-TERM</button>
    </div>

    <div class="error" id="error"></div>
    <div class="status" id="status"></div>
</div>

<script src="https://unpkg.com/@simplewebauthn/browser/dist/bundle/index.umd.min.js"></script>
<script>
const { startRegistration } = SimpleWebAuthnBrowser;

// Step 1: Submit profile
async function submitProfile() {
    const username = document.getElementById('reg-username').value.trim();
    const displayName = document.getElementById('reg-displayname').value.trim();
    const email = document.getElementById('reg-email').value.trim();

    if (!username || username.length < 2) {
        showError('Username is required (min 2 characters)');
        return;
    }

    const btn = document.getElementById('btn-profile');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        const resp = await fetch('/register/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, displayName, email }),
        });
        const result = await resp.json();
        if (result.error) {
            showError(result.error);
            btn.disabled = false;
            btn.textContent = 'Continue';
            return;
        }
        // Move to step 2
        document.getElementById('step-profile').style.display = 'none';
        document.getElementById('step-passkey').style.display = 'block';
        document.getElementById('step-user').textContent = 'Account: ' + username;
    } catch (e) {
        showError(e.message);
        btn.disabled = false;
        btn.textContent = 'Continue';
    }
}

// Step 2: Register passkey
async function registerDevice() {
    const btn = document.getElementById('btn-register');
    btn.disabled = true;
    showStatus('Generating options...');

    try {
        const optResp = await fetch('/register/start', { method: 'POST' });
        const options = await optResp.json();
        if (options.error) { showError(options.error); btn.disabled = false; return; }

        showStatus('Confirm with biometrics...');
        const credential = await startRegistration({ optionsJSON: options });

        showStatus('Verifying...');
        const verResp = await fetch('/register/finish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credential),
        });
        const result = await verResp.json();

        if (result.verified) {
            showStatus('');
            document.getElementById('step-passkey').style.display = 'none';
            const codeGrid = document.getElementById('code-grid');
            for (const code of result.backupCodes) {
                const span = document.createElement('span');
                span.textContent = code;
                codeGrid.appendChild(span);
            }
            document.getElementById('backup-codes').style.display = 'block';
        } else {
            showError(result.error || 'Registration failed');
            btn.disabled = false;
        }
    } catch (e) {
        showError(e.message || 'Registration cancelled or failed');
        btn.disabled = false;
    }
}

// Enter key on profile form
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.getElementById('step-profile').style.display !== 'none') {
        submitProfile();
    }
});

function showError(msg) {
    const el = document.getElementById('error');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 5000);
}

function showStatus(msg) {
    document.getElementById('status').textContent = msg;
}
</script>
</body>
</html>`;

module.exports = REGISTER_HTML;
