"""
T-Term Tray — System tray launcher for T-Term web terminal.
Matrix-style icon, launches server.js, opens browser, live log window.
"""
import os
import sys
import subprocess
import threading
import time
import signal
import webbrowser
from collections import deque
from PIL import Image, ImageDraw, ImageFont
import random
import webview

signal.signal(signal.SIGINT, signal.SIG_IGN)

import ctypes
ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("tayterm.node")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
NODE = "node"
PORT = 7778
URL = f"https://localhost:{PORT}"

server_proc = None
app_running = True
log_window = None

log_lines = deque(maxlen=500)
log_lock = threading.Lock()
log_counter = 0


def log(msg):
    global log_counter
    timestamp = time.strftime("%H:%M:%S")
    line = f"[{timestamp}] {msg}"
    with log_lock:
        log_lines.append(line)
        log_counter += 1


# ==========================================
#  T-Term tray icon (design system style)
# ==========================================

def create_icon_image():
    """Draw T-Term app icon — blue gradient bg + white terminal prompt (matches design system)."""
    size = 64
    scale = 4
    big = size * scale
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Blue gradient background (simulate with vertical color blend)
    # #0284c7 (top-left) → #38bdf8 (bottom-right)
    for y in range(big):
        t = y / big
        r = int(2 + (56 - 2) * t)
        g = int(132 + (189 - 132) * t)
        b = int(199 + (248 - 199) * t)
        draw.line([(0, y), (big, y)], fill=(r, g, b, 255))

    # Apply rounded corners by masking
    mask = Image.new('L', (big, big), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle([0, 0, big, big], radius=48, fill=255)
    img.putalpha(mask)

    # Draw terminal prompt as thick geometric shapes (visible at 16px)
    draw = ImageDraw.Draw(img)
    cx, cy = big // 2, big // 2
    w = 4 * scale  # line thickness

    # ">" chevron — two thick lines forming an arrow
    pts_top = [(cx - 10*scale, cy - 10*scale), (cx + 2*scale, cy), (cx - 10*scale, cy - 10*scale + w)]
    pts_bot = [(cx - 10*scale, cy + 10*scale), (cx + 2*scale, cy), (cx - 10*scale, cy + 10*scale - w)]
    # Draw as thick polygon
    draw.polygon([
        (cx - 10*scale, cy - 10*scale - w//2),
        (cx + 4*scale, cy),
        (cx - 10*scale, cy + 10*scale + w//2),
        (cx - 10*scale, cy + 10*scale - w*2),
        (cx - 2*scale, cy),
        (cx - 10*scale, cy - 10*scale + w*2),
    ], fill=(255, 255, 255, 255))

    # "_" underscore — thick horizontal line
    draw.rectangle([
        cx + 2*scale, cy + 8*scale,
        cx + 12*scale, cy + 8*scale + w
    ], fill=(255, 255, 255, 255))

    return img.resize((size, size), Image.LANCZOS)


def save_ico():
    ico_path = os.path.join(BASE_DIR, "tayterm_node.ico")
    img = create_icon_image()
    sizes = [(16, 16), (32, 32), (48, 48), (64, 64)]
    imgs = [img.resize(s, Image.LANCZOS) for s in sizes]
    imgs[0].save(ico_path, format='ICO', sizes=sizes, append_images=imgs[1:])
    return ico_path


# ==========================================
#  Server management
# ==========================================

def kill_port():
    """Kill any process holding our port."""
    try:
        result = subprocess.run(
            f'netstat -ano | findstr ":{PORT}.*LISTEN"',
            shell=True, capture_output=True, text=True
        )
        for line in result.stdout.strip().split('\n'):
            parts = line.split()
            if parts:
                pid = parts[-1]
                try:
                    subprocess.run(f'taskkill /PID {pid} /F', shell=True,
                                   capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
                    log(f"Killed old process on port {PORT} (PID {pid})")
                except Exception:
                    pass
    except Exception:
        pass

def start_server():
    global server_proc
    if server_proc and server_proc.poll() is None:
        return
    kill_port()
    time.sleep(0.5)
    script = os.path.join(BASE_DIR, "server.js")
    server_proc = subprocess.Popen(
        [NODE, script, "--port", str(PORT)],
        cwd=BASE_DIR,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    log(f"Node server started (PID {server_proc.pid})")

    def reader():
        try:
            for line in server_proc.stdout:
                line = line.rstrip()
                if line:
                    log(f"[server] {line}")
        except Exception:
            pass
        log(f"Server exited (code {server_proc.returncode})")

    threading.Thread(target=reader, daemon=True).start()


def stop_server():
    global server_proc
    if server_proc and server_proc.poll() is None:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_proc.kill()
        log("Server stopped")
    server_proc = None


def health_check():
    while app_running:
        time.sleep(10)
        if server_proc and server_proc.poll() is not None:
            log("Server died — restarting...")
            start_server()


# ==========================================
#  Log API (exposed to pywebview)
# ==========================================

class LogApi:
    def get_logs(self):
        with log_lock:
            return "\n".join(log_lines)

    def get_log_counter(self):
        with log_lock:
            return log_counter

    def restart_server(self):
        def _restart():
            stop_server()
            time.sleep(1)
            start_server()
        threading.Thread(target=_restart, daemon=True).start()

    def stop_server(self):
        threading.Thread(target=stop_server, daemon=True).start()

    def start_server(self):
        threading.Thread(target=start_server, daemon=True).start()

    def is_running(self):
        return server_proc is not None and server_proc.poll() is None


# ==========================================
#  Log window HTML
# ==========================================

LOG_HTML = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0a0a0f; --surface: #0d1117; --border: rgba(255,255,255,0.06);
    --text: #e6edf3; --text2: #475569; --text3: #64748b;
    --accent: #0284c7; --accent2: #38bdf8; --accent-border: rgba(56,189,248,0.3);
    --red: #ef4444; --emerald: #22c55e;
    --glass-bg: rgba(255,255,255,0.03);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; }
  body { font-family: 'Share Tech Mono', 'Consolas', monospace; background: var(--bg); color: var(--text); display: flex; flex-direction: column; }
  .top-bar { display: flex; align-items: center; background: var(--surface); border-bottom: 1px solid var(--border); padding: 8px 14px; flex-shrink: 0; gap: 10px; }
  .title { font-family: 'Rajdhani', sans-serif; font-size: 14px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase;
    background: linear-gradient(135deg, var(--accent2), #818cf8);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .status-dot.online { background: var(--emerald); box-shadow: 0 0 6px rgba(34,197,94,0.5); }
  .status-dot.offline { background: var(--text3); }
  .top-right { margin-left: auto; display: flex; gap: 6px; }
  .btn { padding: 4px 12px; font-family: 'Share Tech Mono', monospace; font-size: 9px; font-weight: 600;
    border: 1px solid var(--border); border-radius: 4px; cursor: pointer;
    background: var(--glass-bg); color: var(--text3); letter-spacing: 1px; text-transform: uppercase;
    transition: all 0.15s; }
  .btn:hover { border-color: var(--accent-border); color: var(--accent2); }
  .btn-red { border-color: rgba(239,68,68,0.3); color: var(--red); }
  .btn-red:hover { background: rgba(239,68,68,0.1); border-color: var(--red); }
  .btn-green { border-color: rgba(34,197,94,0.3); color: var(--emerald); }
  .btn-green:hover { background: rgba(34,197,94,0.1); border-color: var(--emerald); }
  .log-area { flex: 1; padding: 10px 14px; overflow-y: auto; font-size: 11px; line-height: 1.7;
    white-space: pre-wrap; word-break: break-all; color: var(--text3);
    user-select: text; -webkit-user-select: text; cursor: text; }
  .log-area::-webkit-scrollbar { width: 6px; }
  .log-area::-webkit-scrollbar-track { background: transparent; }
  .log-area::-webkit-scrollbar-thumb { background: rgba(56,189,248,0.15); border-radius: 3px; }
  .log-area::-webkit-scrollbar-thumb:hover { background: rgba(56,189,248,0.3); }
  .copied-toast { position: fixed; bottom: 10px; right: 10px;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    color: #fff; padding: 4px 14px; font-size: 10px; border-radius: 4px;
    z-index: 999; opacity: 0; transition: opacity 0.2s; letter-spacing: 1px; }
</style>
</head>
<body>
<div class="top-bar">
  <div class="status-dot" id="statusDot"></div>
  <span class="title">T-TERM</span>
  <div class="top-right">
    <button class="btn" onclick="clearLog()">Clear</button>
    <button class="btn" id="btnStart" onclick="pyApi.start_server().then(updateBtns)">Start</button>
    <button class="btn" id="btnRestart" onclick="pyApi.restart_server().then(()=>setTimeout(updateBtns,1500))">Restart</button>
    <button class="btn btn-red" id="btnStop" onclick="pyApi.stop_server().then(updateBtns)">Stop</button>
  </div>
</div>
<div class="log-area" id="logArea"></div>
<script>
let pyApi;
let lastCounter = 0;
let cleared = false;
function clearLog() { document.getElementById('logArea').textContent = ''; cleared = true; }
async function updateBtns() {
  if (!pyApi) return;
  try {
    const running = await pyApi.is_running();
    const start = document.getElementById('btnStart');
    const stop = document.getElementById('btnStop');
    const restart = document.getElementById('btnRestart');
    const dot = document.getElementById('statusDot');
    if (running) {
      dot.className = 'status-dot online';
      start.className = 'btn'; start.style.opacity = '0.35'; start.style.pointerEvents = 'none';
      stop.className = 'btn btn-red'; stop.style.opacity = ''; stop.style.pointerEvents = '';
      restart.style.opacity = ''; restart.style.pointerEvents = '';
    } else {
      dot.className = 'status-dot offline';
      start.className = 'btn btn-green'; start.style.opacity = ''; start.style.pointerEvents = '';
      stop.className = 'btn'; stop.style.opacity = '0.35'; stop.style.pointerEvents = 'none';
      restart.style.opacity = '0.35'; restart.style.pointerEvents = 'none';
    }
  } catch(e) {}
}
async function pollLogs() {
  if (!pyApi) return;
  // Don't update log while user has text selected (would destroy selection)
  const sel = window.getSelection();
  if (sel && sel.toString().length > 0) return;
  try {
    const c = await pyApi.get_log_counter();
    if (c !== lastCounter) {
      lastCounter = c;
      if (cleared) { cleared = false; }
      const text = await pyApi.get_logs();
      const el = document.getElementById('logArea');
      el.textContent = text;
      el.scrollTop = el.scrollHeight;
    }
  } catch(e) {
    document.getElementById('logArea').textContent = 'Log poll error: ' + e;
  }
  updateBtns();
}
setInterval(pollLogs, 500);
function init() { pyApi = window.pywebview.api; pollLogs(); updateBtns(); }
if (window.pywebview) init(); else window.addEventListener('pywebviewready', init);

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const sel = window.getSelection().toString();
  if (sel) {
    const ta = document.createElement('textarea');
    ta.value = sel;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    window.getSelection().removeAllRanges();
    const msg = document.createElement('div');
    msg.textContent = 'Copied';
    msg.className = 'copied-toast';
    document.body.appendChild(msg);
    requestAnimationFrame(() => msg.style.opacity = '1');
    setTimeout(() => { msg.style.opacity = '0'; setTimeout(() => msg.remove(), 200); }, 800);
  }
});
</script>
</body></html>'''


# ==========================================
#  Window icon helper
# ==========================================

def set_window_icon(title):
    try:
        ico_path = os.path.join(BASE_DIR, "tayterm_node.ico")
        if not os.path.exists(ico_path):
            return
        import ctypes
        from ctypes import wintypes
        FindWindow = ctypes.windll.user32.FindWindowW
        SendMessage = ctypes.windll.user32.SendMessageW
        LoadImage = ctypes.windll.user32.LoadImageW
        IMAGE_ICON = 1
        LR_LOADFROMFILE = 0x0010
        WM_SETICON = 0x0080
        ICON_SMALL = 0
        ICON_BIG = 1
        hwnd = FindWindow(None, title)
        if hwnd:
            for size_type, px in [(ICON_SMALL, 16), (ICON_BIG, 32)]:
                hicon = LoadImage(None, ico_path, IMAGE_ICON, px, px, LR_LOADFROMFILE)
                if hicon:
                    SendMessage(hwnd, WM_SETICON, size_type, hicon)
    except Exception:
        pass


# ==========================================
#  System tray
# ==========================================

def run_tray():
    import pystray
    from pystray import MenuItem as Item

    def on_open(icon, item):
        webbrowser.open(URL)

    def on_log(icon, item):
        if log_window:
            log_window.show()

    def on_restart(icon, item):
        stop_server()
        time.sleep(1)
        start_server()

    def on_quit(icon, item):
        global app_running
        app_running = False
        stop_server()
        icon.stop()
        os._exit(0)

    menu = pystray.Menu(
        Item("Open T-TERM", on_open, default=True),
        Item("View Log", on_log),
        pystray.Menu.SEPARATOR,
        Item("Restart Server", on_restart),
        pystray.Menu.SEPARATOR,
        Item("Quit", on_quit),
    )

    icon_img = create_icon_image()
    icon = pystray.Icon("TAYTERM-Node", icon_img, "T-TERM", menu)
    icon.run()


# ==========================================
#  Main
# ==========================================

def main():
    global log_window

    log("=" * 36)
    log("  T-TERM — Web Terminal Server")
    log("=" * 36)

    save_ico()
    start_server()
    threading.Thread(target=health_check, daemon=True).start()
    threading.Thread(target=run_tray, daemon=True).start()

    # Wait for server to be ready, then open browser
    def open_when_ready():
        import urllib.request
        import ssl as _ssl
        ctx = _ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = _ssl.CERT_NONE
        for _ in range(20):
            try:
                urllib.request.urlopen(URL, context=ctx, timeout=2)
                webbrowser.open(URL)
                break
            except Exception:
                time.sleep(0.5)

    threading.Thread(target=open_when_ready, daemon=True).start()

    # Create log window — hidden=True so closing hides instead of quits
    win_title = "T-Term Log"
    log_window = webview.create_window(
        win_title, html=LOG_HTML,
        width=640, height=400,
        js_api=LogApi(),
        background_color='#0a0a0f',
        hidden=True,
        on_top=False,
    )

    # Set icon after window is shown
    def on_shown():
        time.sleep(0.3)
        set_window_icon(win_title)

    def on_closing():
        # Hide instead of close — keep server running
        if log_window:
            log_window.hide()
        return False  # Prevent actual close

    log_window.events.closing += on_closing

    webview.start(on_shown, gui='edgechromium', debug=False)


if __name__ == "__main__":
    main()
