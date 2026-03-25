function expiredInviteHTML() {
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>T-TERM — Invite Expired</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body {
    min-height: 100vh;
    background: linear-gradient(135deg, #0a0a0f 0%, #0d1117 30%, #0a0f1a 60%, #0a0a0f 100%);
    font-family: 'Segoe UI', Arial, sans-serif; color: #e6edf3;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.container {
    text-align: center; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 24px; padding: 48px 44px; backdrop-filter: blur(20px); max-width: 420px; width: 90%;
}
.logo { font-family: 'Rajdhani', sans-serif; font-size: 48px; font-weight: 700; letter-spacing: 12px;
    background: linear-gradient(135deg, #38bdf8 0%, #0284c7 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 4px; }
.subtitle { font-family: 'Share Tech Mono', monospace; font-size: 11px; letter-spacing: 6px; color: #475569; margin-bottom: 40px; text-transform: uppercase; }
.msg { font-size: 16px; color: #94a3b8; margin-bottom: 24px; line-height: 1.6; }
.btn { display: inline-block; padding: 14px 32px; border-radius: 10px; border: none;
    background: linear-gradient(135deg, #0284c7, #38bdf8); color: white;
    font-family: 'Rajdhani', sans-serif; font-size: 16px; font-weight: 700;
    cursor: pointer; letter-spacing: 2px; text-transform: uppercase; text-decoration: none; }
</style></head><body>
<div class="container">
    <div class="logo">T-TERM</div>
    <div class="subtitle">Invite Link</div>
    <div class="msg">This invite link has expired or has already been used.</div>
    <a class="btn" href="/login">Go to Login</a>
</div>
</body></html>`;
}

module.exports = expiredInviteHTML;
