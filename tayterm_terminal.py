"""
Vanilla terminal test — PTY persistence + reconnect.
Tests whether resize on reconnect makes Claude redraw.
Port 7777.
"""
import os
import sys
import signal
import asyncio
import json
import ssl
import logging
import time
from aiohttp import web

signal.signal(signal.SIGINT, signal.SIG_IGN)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("vanilla")

TEST_CWD = r"C:\Users\taybo\Dropbox\CODEAI\NaturalVoice"
UPLOAD_DIR = os.path.join(TEST_CWD, ".tayterm_uploads")

# One persistent PTY — survives browser disconnects
pty_state = {"terminal": None, "task": None, "subscribers": set()}


class Terminal:
    def __init__(self, cwd):
        self.cwd = cwd
        self.process = None

    def start(self, cols=120, rows=30):
        from winpty import PtyProcess
        env = os.environ.copy()
        for v in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION",
                   "CLAUDE_CODE_ENTRY_POINT", "CLAUDE_CODE_PARENT"]:
            env.pop(v, None)
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        self.process = PtyProcess.spawn(
            "powershell.exe",
            dimensions=(rows, cols),
            cwd=self.cwd,
            env=env,
        )

    def resize(self, cols, rows):
        if self.process and self.process.isalive():
            self.process.setwinsize(rows, cols)

    def write(self, data):
        if self.process and self.process.isalive():
            self.process.write(data)

    def read(self, size=4096):
        if self.process and self.process.isalive():
            return self.process.read(size)
        return ""

    def is_alive(self):
        return self.process and self.process.isalive()

    def kill(self):
        if self.process:
            try: self.process.close(force=True)
            except: pass


HTML = '''<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>TAYTERM</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
  #terminal { width: 100%; height: 100%; padding: 10px; box-sizing: border-box; }
  #status { position: fixed; top: 8px; right: 12px; font: 12px sans-serif; color: #6a7388; z-index: 10; }
  #drop-overlay {
    display: none; position: fixed; inset: 0; background: rgba(0,184,148,0.15);
    border: 3px dashed #00b894; z-index: 100; pointer-events: none;
    justify-content: center; align-items: center; font: 24px sans-serif; color: #00b894;
  }
  #drop-overlay.active { display: flex; }
</style>
</head>
<body>
<div id="status"></div>
<div id="drop-overlay">Drop file here</div>
<div id="terminal"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-webgl@0.18.0/lib/addon-webgl.min.js"></script>
<script>
const status = document.getElementById('status');
const dropOverlay = document.getElementById('drop-overlay');
const term = new Terminal({
  cursorBlink: true,
  scrollback: 5000,
  fontSize: 17,
  theme: { background: '#000' },
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
try { term.loadAddon(new WebglAddon.WebglAddon()); } catch(e) {}
fitAddon.fit();
function forceRedraw() {
  fitAddon.fit();
  term.refresh(0, term.rows - 1);
}
setTimeout(forceRedraw, 100);
setTimeout(forceRedraw, 500);
window.addEventListener('resize', () => fitAddon.fit());
window.addEventListener('focus', forceRedraw);
document.addEventListener('visibilitychange', () => { if (!document.hidden) forceRedraw(); });

const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(proto + '//' + location.host + '/ws');

function sendInput(text) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data: text }));
  }
}

// Upload a file (image blob or dropped file), insert path into terminal
async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const resp = await fetch('/upload', { method: 'POST', body: formData });
    const result = await resp.json();
    if (result.path) sendInput(result.path);
  } catch(err) {
    console.error('Upload failed:', err);
  }
}

ws.onopen = () => {
  status.textContent = 'connected';
  status.style.color = '#00b894';
  fitAddon.fit();
  const dims = fitAddon.proposeDimensions() || { cols: 120, rows: 30 };
  // Force resize: send cols-1 first, then real size — triggers Claude redraw even if same size
  ws.send(JSON.stringify({ type: 'resize', cols: dims.cols - 1, rows: dims.rows }));
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
  }, 50);
};

ws.onmessage = (e) => {
  try {
    const msg = JSON.parse(e.data);
    if (msg.type === 'output') term.write(msg.data);
    if (msg.type === 'status') status.textContent = msg.data;
  } catch(err) {}
};

ws.onclose = () => {
  status.textContent = 'disconnected — refresh to reconnect';
  status.style.color = '#e17055';
};

term.onData(data => { sendInput(data); });

term.onResize(({ cols, rows }) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
});

// ── Ctrl+C copy / Ctrl+V paste ──
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  if (e.ctrlKey && e.key === 'c') {
    const sel = term.getSelection();
    if (sel) {
      navigator.clipboard.writeText(sel).catch(() => {});
      term.clearSelection();
      return false;
    }
    return true;
  }
  if (e.ctrlKey && e.key === 'v') {
    navigator.clipboard.read().then(async (items) => {
      let handled = false;
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (imageType) {
          handled = true;
          const blob = await item.getType(imageType);
          const ext = imageType.split('/')[1] || 'png';
          uploadFile(new File([blob], 'paste_' + Date.now() + '.' + ext, { type: imageType }));
        }
      }
      if (!handled) {
        const text = await navigator.clipboard.readText();
        if (text) sendInput(text.trim());
      }
    }).catch(() => {
      navigator.clipboard.readText().then(text => { if (text) sendInput(text.trim()); }).catch(() => {});
    });
    return false;
  }
  return true;
});

// ── Drag & drop ──
let dragCounter = 0;
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  dropOverlay.classList.add('active');
});
document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('active'); }
});
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('active');
  for (const file of e.dataTransfer.files) {
    uploadFile(file);
  }
});
</script>
</body>
</html>'''


def start_reader(term):
    """Background task: read from PTY, broadcast to all connected browsers."""
    async def reader():
        loop = asyncio.get_event_loop()
        try:
            while term.is_alive():
                try:
                    data = await loop.run_in_executor(None, term.read, 16384)
                    if data:
                        dead = set()
                        for ws in pty_state["subscribers"]:
                            try:
                                await ws.send_json({"type": "output", "data": data})
                            except:
                                dead.add(ws)
                        pty_state["subscribers"] -= dead
                        await asyncio.sleep(0.01)
                except EOFError:
                    break
                except:
                    await asyncio.sleep(0.05)
        except:
            pass
        log.info("PTY exited")
        pty_state["terminal"] = None

    pty_state["task"] = asyncio.create_task(reader())


async def index(request):
    return web.Response(text=HTML, content_type="text/html",
                        headers={"Cache-Control": "no-store"})


async def upload_handler(request):
    """Save uploaded file (pasted image or dropped file), return its path."""
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    reader = await request.multipart()
    field = await reader.next()
    if not field:
        return web.json_response({"error": "no file"}, status=400)

    filename = field.filename or f"paste_{int(time.time() * 1000)}.png"
    # Sanitize filename
    filename = os.path.basename(filename)
    save_path = os.path.join(UPLOAD_DIR, filename)

    # Avoid overwriting — add timestamp if exists
    if os.path.exists(save_path):
        name, ext = os.path.splitext(filename)
        filename = f"{name}_{int(time.time() * 1000)}{ext}"
        save_path = os.path.join(UPLOAD_DIR, filename)

    with open(save_path, "wb") as f:
        while True:
            chunk = await field.read_chunk()
            if not chunk:
                break
            f.write(chunk)

    log.info(f"Upload: {save_path} ({os.path.getsize(save_path)} bytes)")
    return web.json_response({"path": save_path})


async def ws_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    term = pty_state["terminal"]

    if term and term.is_alive():
        # Reattach to existing PTY
        log.info(f"Reattach — {request.remote}")
        await ws.send_json({"type": "status", "data": "reattached to live PTY"})
    else:
        # New PTY
        term = Terminal(cwd=TEST_CWD)
        term.start(cols=120, rows=30)
        pty_state["terminal"] = term
        start_reader(term)
        log.info(f"New PTY — {request.remote}")
        await ws.send_json({"type": "status", "data": "new PTY started"})

        # Auto-launch Claude
        await asyncio.sleep(0.5)
        term.write("claude --dangerously-skip-permissions\r")

    # Subscribe
    pty_state["subscribers"].add(ws)

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    payload = json.loads(msg.data)
                    if payload.get("type") == "input":
                        term.write(payload["data"])
                    elif payload.get("type") == "resize":
                        log.info(f"Resize: {payload['cols']}x{payload['rows']}")
                        term.resize(payload["cols"], payload["rows"])
                except:
                    pass
            elif msg.type == web.WSMsgType.ERROR:
                break
    except:
        pass
    finally:
        pty_state["subscribers"].discard(ws)
        log.info(f"Browser detached — {request.remote} ({len(pty_state['subscribers'])} still connected)")

    return ws


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7777)
    args = parser.parse_args()

    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_post("/upload", upload_handler)

    base_dir = os.path.dirname(os.path.abspath(__file__))
    cert = os.path.join(base_dir, ".tayterm_cert.pem")
    key = os.path.join(base_dir, ".tayterm_key.pem")
    ssl_ctx = None
    if os.path.exists(cert) and os.path.exists(key):
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(cert, key)

    log.info(f"TAYTERM on https://0.0.0.0:{args.port}")
    web.run_app(app, host="0.0.0.0", port=args.port, ssl_context=ssl_ctx, print=None)


if __name__ == "__main__":
    main()
