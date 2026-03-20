"""
TAYTERM Node Tray — System tray launcher for TAYTERM Node.js server.
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
#  Matrix-style tray icon (Node variant)
# ==========================================

def create_icon_image():
    """Draw a Matrix rain style icon with N overlay."""
    size = 64
    scale = 4
    big = size * scale
    img = Image.new('RGBA', (big, big), (0, 0, 0, 255))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([4, 4, big-4, big-4], radius=28, fill=(5, 15, 5, 255))

    try:
        font = ImageFont.truetype("consola.ttf", int(12 * scale))
        font_sm = ImageFont.truetype("consola.ttf", int(9 * scale))
        font_lg = ImageFont.truetype("consola.ttf", int(18 * scale))
    except Exception:
        try:
            font = ImageFont.truetype("cour.ttf", int(12 * scale))
            font_sm = ImageFont.truetype("cour.ttf", int(9 * scale))
            font_lg = ImageFont.truetype("cour.ttf", int(18 * scale))
        except Exception:
            font = ImageFont.load_default()
            font_sm = font
            font_lg = font

    random.seed(43)
    chars = "01>_|/\\{}[]<>:;=+-*"

    cols = 5
    col_width = big // cols
    for c in range(cols):
        x = c * col_width + col_width // 2
        num_chars = random.randint(2, 4)
        start_y = random.randint(0, big // 3)
        for i in range(num_chars):
            y = start_y + i * int(13 * scale)
            if y > big - 10:
                break
            ch = random.choice(chars)
            brightness = int(255 * (i + 1) / num_chars)
            green = max(60, brightness)
            alpha = max(40, brightness)
            color = (0, green, 0, alpha)
            draw.text((x, y), ch, fill=color, font=font_sm, anchor="mm")

    # Draw "N" for Node in center
    draw.text((big // 2, big // 2), "N", fill=(0, 255, 70, 255), font=font_lg, anchor="mm")

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
  .log-area { flex: 1; padding: 8px 12px; overflow-y: auto; font-size: 11px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; color: var(--green-dim); user-select: text; -webkit-user-select: text; cursor: text; }
  .log-area::-webkit-scrollbar { width: 6px; }
  .log-area::-webkit-scrollbar-track { background: #000; }
  .log-area::-webkit-scrollbar-thumb { background: var(--green-dark); }
  .log-area::-webkit-scrollbar-thumb:hover { background: var(--green-dim); }
</style>
</head>
<body>
<div class="top-bar">
  <span class="title">TAYTERM NODE LOG</span>
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
    msg.style.cssText = 'position:fixed;bottom:10px;right:10px;background:#00ff41;color:#000;padding:4px 12px;font-size:10px;border-radius:3px;z-index:999;opacity:0;transition:opacity 0.2s';
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
        Item("Open TAYTERM (Node)", on_open, default=True),
        Item("View Log", on_log),
        pystray.Menu.SEPARATOR,
        Item("Restart Server", on_restart),
        pystray.Menu.SEPARATOR,
        Item("Quit", on_quit),
    )

    icon_img = create_icon_image()
    icon = pystray.Icon("TAYTERM-Node", icon_img, "TAYTERM (Node)", menu)
    icon.run()


# ==========================================
#  Main
# ==========================================

def main():
    global log_window

    log("=" * 36)
    log("  TAYTERM Node — Web Terminal Server")
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
    win_title = "TAYTERM Node Log"
    log_window = webview.create_window(
        win_title, html=LOG_HTML,
        width=640, height=400,
        js_api=LogApi(),
        background_color='#000000',
        hidden=False,
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
