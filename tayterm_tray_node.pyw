"""
TAYTERM Tray — System tray launcher for TAYTERM web terminal.
Matrix-style icon, launches tayterm_terminal.py, opens browser, live log window.
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
ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("tayterm.app")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PYTHON = sys.executable.replace("pythonw.exe", "python.exe")
PORT = 7777
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


# ══════════════════════════════════════════
#  Matrix-style tray icon
# ══════════════════════════════════════════

def create_icon_image():
    """Draw a Matrix rain style icon — green code on black."""
    size = 64
    scale = 4
    big = size * scale
    img = Image.new('RGBA', (big, big), (0, 0, 0, 255))
    draw = ImageDraw.Draw(img)

    # Draw a subtle rounded rect background
    draw.rounded_rectangle([4, 4, big-4, big-4], radius=28, fill=(5, 15, 5, 255))

    # Matrix rain columns
    try:
        font = ImageFont.truetype("consola.ttf", int(12 * scale))
        font_sm = ImageFont.truetype("consola.ttf", int(9 * scale))
    except Exception:
        try:
            font = ImageFont.truetype("cour.ttf", int(12 * scale))
            font_sm = ImageFont.truetype("cour.ttf", int(9 * scale))
        except Exception:
            font = ImageFont.load_default()
            font_sm = font

    random.seed(42)  # deterministic so icon is consistent
    chars = "01>_|/\\{}[]<>:;=+-*"

    # Draw columns of falling characters
    cols = 5
    col_width = big // cols
    for c in range(cols):
        x = c * col_width + col_width // 2
        num_chars = random.randint(3, 6)
        start_y = random.randint(0, big // 3)
        for i in range(num_chars):
            y = start_y + i * int(13 * scale)
            if y > big - 10:
                break
            ch = random.choice(chars)
            # Brightest at bottom (leading edge), fading up
            brightness = int(255 * (i + 1) / num_chars)
            green = max(80, brightness)
            alpha = max(60, brightness)
            color = (0, green, 0, alpha)
            if i == num_chars - 1:
                # Leading character is bright white-green
                color = (180, 255, 180, 255)
            f = font_sm if random.random() > 0.3 else font
            draw.text((x, y), ch, fill=color, font=f, anchor="mm")

    # Draw ">_" prompt at bottom center
    prompt_y = big - int(18 * scale)
    draw.text((big // 2, prompt_y), ">_", fill=(0, 255, 70, 255), font=font, anchor="mm")

    return img.resize((size, size), Image.LANCZOS)


def save_ico():
    """Save icon as .ico file."""
    ico_path = os.path.join(BASE_DIR, "tayterm.ico")
    img = create_icon_image()
    # Create multiple sizes for ICO
    sizes = [(16, 16), (32, 32), (48, 48), (64, 64)]
    imgs = [img.resize(s, Image.LANCZOS) for s in sizes]
    imgs[0].save(ico_path, format='ICO', sizes=sizes, append_images=imgs[1:])
    return ico_path


# ══════════════════════════════════════════
#  Server management
# ══════════════════════════════════════════

def start_server():
    global server_proc
    if server_proc and server_proc.poll() is None:
        return  # already running
    script = os.path.join(BASE_DIR, "server.js")
    server_proc = subprocess.Popen(
        ["node", script, "--port", str(PORT)],
        cwd=BASE_DIR,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    log(f"Server started (PID {server_proc.pid})")

    # Read server stdout in background and feed into log
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
    """Auto-restart if server dies."""
    while app_running:
        time.sleep(10)
        if server_proc and server_proc.poll() is not None:
            log("Server died — restarting...")
            start_server()


# ══════════════════════════════════════════
#  Log API (exposed to pywebview)
# ══════════════════════════════════════════

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


# ══════════════════════════════════════════
#  Log window HTML
# ══════════════════════════════════════════

LOG_HTML = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  :root { --bg: #000; --surface: #050505; --border: #003300; --green: #00ff41; --green-dim: #00cc33; --green-dark: #003300; --red: #ff0040; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; }
  body { font-family: 'Consolas', 'Courier New', monospace; background: var(--bg); color: var(--green-dim); display: flex; flex-direction: column; }
  .top-bar { display: flex; align-items: center; background: var(--surface); border-bottom: 1px solid var(--border); padding: 6px 12px; flex-shrink: 0; }
  .title { font-size: 12px; font-weight: 700; color: var(--green); letter-spacing: 2px; text-transform: uppercase; }
  .top-right { margin-left: auto; display: flex; gap: 6px; }
  .btn { padding: 3px 10px; font-size: 10px; font-weight: 600; border: 1px solid var(--border); cursor: pointer; background: transparent; color: var(--green-dark); font-family: inherit; letter-spacing: 1px; }
  .btn:hover { border-color: var(--green); color: var(--green); }
  .btn-red { border-color: #330010; color: var(--red); }
  .btn-red:hover { background: var(--red); color: #000; }
  .btn-green { border-color: var(--green-dark); color: var(--green); }
  .btn-green:hover { background: var(--green); color: #000; }
  .log-area { flex: 1; padding: 8px 12px; overflow-y: auto; font-size: 11px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; color: var(--green-dim); }
  .log-area::-webkit-scrollbar { width: 6px; }
  .log-area::-webkit-scrollbar-track { background: #000; }
  .log-area::-webkit-scrollbar-thumb { background: var(--green-dark); }
  .log-area::-webkit-scrollbar-thumb:hover { background: var(--green-dim); }
</style>
</head>
<body>
<div class="top-bar">
  <span class="title">TAYTERM LOG</span>
  <div class="top-right">
    <button class="btn" onclick="clearLog()">Clear</button>
    <button class="btn" id="btnStart" onclick="pyApi.start_server().then(updateBtns)">Start</button>
    <button class="btn" id="btnRestart" onclick="pyApi.restart_server().then(()=>setTimeout(updateBtns,1500))">Restart</button>
    <button class="btn" id="btnStop" onclick="pyApi.stop_server().then(updateBtns)">Stop</button>
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
    if (running) {
      start.className = 'btn'; start.style.opacity = '0.35'; start.style.pointerEvents = 'none';
      stop.className = 'btn btn-red'; stop.style.opacity = ''; stop.style.pointerEvents = '';
      restart.style.opacity = ''; restart.style.pointerEvents = '';
    } else {
      start.className = 'btn btn-green'; start.style.opacity = ''; start.style.pointerEvents = '';
      stop.className = 'btn'; stop.style.opacity = '0.35'; stop.style.pointerEvents = 'none';
      restart.style.opacity = '0.35'; restart.style.pointerEvents = 'none';
    }
  } catch(e) {}
}
async function pollLogs() {
  if (!pyApi) return;
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
</script>
</body></html>'''


# ══════════════════════════════════════════
#  Window icon helper
# ══════════════════════════════════════════

def set_window_icon(title):
    """Set the window icon for a pywebview window by title."""
    try:
        ico_path = os.path.join(BASE_DIR, "tayterm.ico")
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


# ══════════════════════════════════════════
#  System tray
# ══════════════════════════════════════════

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
        Item("Open TAYTERM", on_open, default=True),
        Item("View Log", on_log),
        pystray.Menu.SEPARATOR,
        Item("Restart Server", on_restart),
        pystray.Menu.SEPARATOR,
        Item("Quit", on_quit),
    )

    icon_img = create_icon_image()
    icon = pystray.Icon("TAYTERM", icon_img, "TAYTERM", menu)
    icon.run()


# ══════════════════════════════════════════
#  Main
# ══════════════════════════════════════════

def main():
    global log_window

    log("=" * 36)
    log("  TAYTERM — Web Terminal Server")
    log("=" * 36)

    # Save ICO for window icon
    save_ico()

    # Start server
    start_server()

    # Start health check
    threading.Thread(target=health_check, daemon=True).start()

    # Start tray
    threading.Thread(target=run_tray, daemon=True).start()

    # Wait for server to be ready, then open browser
    def open_when_ready():
        import urllib.request
        import ssl as _ssl
        ctx = _ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = _ssl.CERT_NONE
        for _ in range(20):
            time.sleep(1)
            try:
                urllib.request.urlopen(URL, timeout=2, context=ctx)
                webbrowser.open(URL)
                return
            except Exception:
                pass

    threading.Thread(target=open_when_ready, daemon=True).start()

    # Create log window
    log_window = webview.create_window(
        "TAYTERM Log", html=LOG_HTML, js_api=LogApi(),
        width=700, height=400, min_size=(400, 200),
        background_color="#0a0a14", text_select=True,
    )

    # Hide on close instead of destroy
    def hide_log():
        log_window.hide()
        return False

    log_window.events.closing += hide_log

    # Set icon after window appears
    def set_icons():
        for _ in range(5):
            time.sleep(1)
            set_window_icon("TAYTERM Log")

    threading.Thread(target=set_icons, daemon=True).start()

    # Start hidden — open from tray
    def on_loaded():
        log_window.hide()

    log_window.events.loaded += on_loaded

    webview.start(debug=False)

    # Cleanup on exit
    app_running = False
    stop_server()


if __name__ == "__main__":
    main()
