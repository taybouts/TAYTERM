function inviteEmailHtml(email, link) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<style>
  :root { color-scheme: dark; supported-color-schemes: dark; }
  body, html { background-color: #06060a !important; }
  @media (prefers-color-scheme: light) {
    body, html, .outer-wrap, .main-card, .bottom-bar { background-color: #06060a !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#06060a;color:#e2e8f0;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;-webkit-text-size-adjust:100%;">
<!-- Force dark on Gmail -->
<div style="display:none;font-size:1px;color:#06060a;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
  You've been invited to T-Term &mdash; Secure AI Terminal
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#06060a;" class="outer-wrap">
<tr><td align="center" style="padding:48px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:#0c0c14;border:1px solid #1a2332;border-radius:16px;overflow:hidden;" class="main-card">

  <!-- Top accent bar -->
  <tr><td style="height:3px;background:linear-gradient(90deg,#06060a,#0284c7,#38bdf8,#0284c7,#06060a);font-size:0;line-height:0;">&nbsp;</td></tr>

  <!-- Logo section -->
  <tr><td style="padding:40px 36px 0;text-align:center;background-color:#0c0c14;">
    <div style="font-size:34px;font-weight:800;color:#38bdf8;letter-spacing:6px;font-family:'Courier New',Courier,monospace;">T-TERM</div>
    <div style="width:120px;height:1px;background-color:#1a2332;margin:10px auto;"></div>
    <div style="font-size:10px;color:#475569;letter-spacing:3px;text-transform:uppercase;">Secure Terminal Access</div>
  </td></tr>

  <!-- Separator -->
  <tr><td style="padding:28px 36px 0;background-color:#0c0c14;">
    <div style="height:1px;background-color:#111827;"></div>
  </td></tr>

  <!-- Content -->
  <tr><td style="padding:28px 36px 0;background-color:#0c0c14;">
    <div style="font-size:22px;font-weight:600;color:#f1f5f9;margin-bottom:12px;">You're invited</div>
    <div style="font-size:14px;color:#94a3b8;line-height:1.7;">
      You've been granted access to <strong style="color:#38bdf8;">T-Term</strong>. Register your device with biometric authentication to get started.
    </div>
  </td></tr>

  <!-- Button -->
  <tr><td style="padding:32px 36px;text-align:center;background-color:#0c0c14;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
    <tr><td style="background-color:#0284c7;border-radius:12px;">
      <a href="${link}" target="_blank" style="display:inline-block;color:#ffffff;text-decoration:none;padding:16px 52px;font-size:15px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;font-family:'Segoe UI',system-ui,sans-serif;">
        Register Device
      </a>
    </td></tr>
    </table>
  </td></tr>

  <!-- Invite badge -->
  <tr><td style="padding:0 36px 12px;text-align:center;background-color:#0c0c14;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
    <tr><td style="background-color:#0a1628;border:1px solid #1a2332;border-radius:8px;padding:10px 20px;">
      <span style="font-size:12px;color:#64748b;">Invited: </span>
      <span style="font-size:12px;color:#38bdf8;font-weight:600;">${email}</span>
    </td></tr>
    </table>
  </td></tr>

  <!-- Expiry -->
  <tr><td style="padding:8px 36px 28px;text-align:center;background-color:#0c0c14;">
    <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background-color:#f59e0b;vertical-align:middle;margin-right:6px;"></span>
    <span style="font-size:11px;color:#64748b;vertical-align:middle;">Link expires in 24 hours &middot; Single use only</span>
  </td></tr>

  <!-- Bottom bar -->
  <tr><td style="padding:20px 36px;background-color:#080810;border-top:1px solid #111827;" class="bottom-bar">
    <div style="font-size:11px;color:#334155;text-align:center;line-height:1.6;">
      If you didn't expect this invitation, you can safely ignore this email.
    </div>
    <div style="text-align:center;font-size:9px;color:#1e293b;word-break:break-all;margin-top:12px;">
      ${link}
    </div>
  </td></tr>

  <!-- Bottom accent -->
  <tr><td style="height:2px;background:linear-gradient(90deg,#0c0c14,#1a2332,#0c0c14);font-size:0;line-height:0;">&nbsp;</td></tr>

</table>

<!-- Footer -->
<div style="text-align:center;padding:24px 0 0;font-size:10px;color:#1e293b;letter-spacing:1px;">
  T-TERM &mdash; SECURE AI TERMINAL
</div>

</td></tr>
</table>
</body>
</html>`;
}

module.exports = inviteEmailHtml;
