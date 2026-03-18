"""
TAYTERM - Web terminal with persistent PTY and multi-device sync.
Port 7777.
"""
import os
import sys
import signal
import asyncio
import json
import importlib
import ssl as _ssl_mod
# pip 26+ truststore monkey-patches ssl.SSLContext.wrap_socket and breaks self-signed certs
if _ssl_mod.SSLContext.wrap_socket.__module__ != 'ssl':
    importlib.reload(_ssl_mod)
import ssl
import logging
import time
import re
import urllib.request
from aiohttp import web

signal.signal(signal.SIGINT, signal.SIG_IGN)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("tayterm")

PROJECTS_DIR = r"C:\Users\taybo\Dropbox\CODEAI"
CLAUDE_PROJECTS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "projects")
CLAUDE_CMD = "claude --dangerously-skip-permissions"

# Per-session PTY sessions: { "ProjectName:claude" or "ProjectName:shell": { "terminal": Terminal, "task": Task, "subscribers": set() } }
active_terminals = {}


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


TTS_URL = "http://127.0.0.1:7123"

# Regex to strip ANSI escape sequences
ANSI_RE = re.compile(r'\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07|\x1b[()][AB012]|\x1b\[[\?]?[0-9;]*[hl]|\r')


class TTSTap:
    """Accumulates plain text from PTY stream, sends sentences to TTS."""

    def __init__(self, project):
        self.project = project
        self.buffer = ""
        self.in_code_block = False
        self.sentences_sent = set()
        self.speaking = False  # True when Claude is responding
        self.last_large_chunk = 0  # Timestamp of last large chunk
        self.silence_since = 0  # When text stopped flowing

    def _clean_markdown(self, text):
        text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
        text = re.sub(r'\*(.+?)\*', r'\1', text)
        text = re.sub(r'`(.+?)`', r'\1', text)
        text = re.sub(r'\[(.+?)\]\(.+?\)', r'\1', text)
        text = re.sub(r'^\s*[-*]\s+', '', text)
        text = re.sub(r'^\s*\d+\.\s+', '', text)
        return text.strip()

    def _should_skip(self, line):
        stripped = line.strip()
        if not stripped or len(stripped) <= 2:
            return True
        if re.match(r'^\s*```', stripped):
            self.in_code_block = not self.in_code_block
            return True
        if self.in_code_block:
            return True
        if re.match(r'^\s*\|.*\|', stripped):
            return True
        if re.match(r'^\s*[-=]{3,}$', stripped):
            return True
        # Skip file paths, tool output, prompts, shell stuff
        if re.match(r'^\s*(>|\$|#!|C:\\|/[a-z]|PS\s)', stripped):
            return True
        # Skip PowerShell/shell noise
        if re.match(r'^\s*(Windows PowerShell|Copyright|All rights reserved|Install the latest|https?://)', stripped):
            return True
        # Skip command lines (claude, git, python, etc.)
        if re.match(r'^\s*(claude|git|python|pip|npm|node|cd |ls |dir |cat )', stripped):
            return True
        # Skip lines that are mostly non-alpha (code, paths, numbers)
        alpha_chars = sum(1 for c in stripped if c.isalpha())
        if len(stripped) > 0 and alpha_chars / len(stripped) < 0.4:
            return True
        # Minimum word count for natural speech
        if len(stripped.split()) < 5:
            return True
        return False

    def _send_to_tts(self, sentence):
        """Fire-and-forget HTTP call to TTS server. Server checks mute state."""
        try:
            data = json.dumps({"text": sentence, "project": self.project}).encode()
            req = urllib.request.Request(
                f"{TTS_URL}/speak", data=data,
                headers={"Content-Type": "application/json"}, method="POST"
            )
            urllib.request.urlopen(req, timeout=2)
        except Exception:
            pass

    def feed(self, raw_data):
        """Feed raw PTY data, extract and speak sentences."""
        # Strip ANSI codes
        plain = ANSI_RE.sub('', raw_data)
        if not plain.strip():
            return

        now = time.time()

        # Heuristic: user typing = small chunks (1-3 chars), Claude = larger bursts
        # When we see chunks > 10 chars, Claude is likely responding
        stripped_len = len(plain.strip())
        if stripped_len > 10:
            self.speaking = True
            self.last_large_chunk = now
        elif stripped_len <= 3:
            # Small chunk — likely user typing a character
            # If no large chunk in the last 2 seconds, we're in user input mode
            if now - self.last_large_chunk > 2:
                self.speaking = False
                self.buffer = ""
                return

        if not self.speaking:
            return

        self.buffer += plain

        # Process complete lines + detect sentences
        while '\n' in self.buffer:
            line, self.buffer = self.buffer.split('\n', 1)
            if self._should_skip(line):
                continue
            cleaned = self._clean_markdown(line)
            if not cleaned:
                continue
            # Split into sentences
            parts = re.split(r'(?<=[.!?:])(?:\s+|\n)', cleaned)
            for sentence in parts:
                s = sentence.strip()
                if not s or len(s) <= 2:
                    continue
                key = s[:60]
                if key in self.sentences_sent:
                    continue
                self.sentences_sent.add(key)
                self._send_to_tts(s)


def start_reader(project_name):
    """Background task: read from PTY, broadcast to all connected browsers."""
    entry = active_terminals[project_name]
    term = entry["terminal"]
    # Set up TTS tap for Claude sessions
    tts_tap = None
    if project_name.endswith(":claude"):
        proj = project_name.split(":")[0]
        tts_tap = TTSTap(proj)

    async def reader():
        loop = asyncio.get_event_loop()
        try:
            while term.is_alive():
                try:
                    data = await loop.run_in_executor(None, term.read, 16384)
                    if data:
                        dead = set()
                        for ws in entry["subscribers"]:
                            try:
                                await ws.send_json({"type": "output", "data": data})
                            except:
                                dead.add(ws)
                        entry["subscribers"] -= dead
                        # Feed to TTS tap (fire-and-forget in executor)
                        if tts_tap:
                            loop.run_in_executor(None, tts_tap.feed, data)
                        await asyncio.sleep(0.01)
                except EOFError:
                    break
                except:
                    await asyncio.sleep(0.05)
        except:
            pass
        log.info(f"PTY exited: {project_name}")
        if project_name in active_terminals:
            active_terminals[project_name]["terminal"] = None

    entry["task"] = asyncio.create_task(reader())


def get_projects():
    """List project folders with metadata."""
    projects = []
    for name in sorted(os.listdir(PROJECTS_DIR)):
        path = os.path.join(PROJECTS_DIR, name)
        if not os.path.isdir(path) or name.startswith("."):
            continue
        has_git = os.path.isdir(os.path.join(path, ".git"))
        has_claude = os.path.isfile(os.path.join(path, "CLAUDE.md"))
        # Get description from README.md
        desc = ""
        readme_path = os.path.join(path, "README.md")
        if os.path.isfile(readme_path):
            try:
                with open(readme_path, "r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#") or line.startswith("!") or line.startswith("["):
                            continue
                        desc = line[:80]
                        break
            except:
                pass
        claude_key = f"{name}:claude"
        shell_key = f"{name}:shell"
        claude_live = (claude_key in active_terminals and
                       active_terminals[claude_key].get("terminal") and
                       active_terminals[claude_key]["terminal"].is_alive())
        shell_live = (shell_key in active_terminals and
                      active_terminals[shell_key].get("terminal") and
                      active_terminals[shell_key]["terminal"].is_alive())
        is_live = claude_live
        # Check Claude conversation files
        claude_proj_key = path.replace("\\", "-").replace("/", "-").replace(":", "-")
        claude_conv_dir = os.path.join(CLAUDE_PROJECTS_DIR, claude_proj_key)
        conv_count = 0
        if os.path.isdir(claude_conv_dir):
            conv_count = sum(1 for f in os.listdir(claude_conv_dir) if f.endswith(".jsonl"))
        has_conversations = conv_count > 0
        sub_count = 0
        if claude_live: sub_count += len(active_terminals[claude_key]["subscribers"])
        if shell_live: sub_count += len(active_terminals[shell_key]["subscribers"])
        projects.append({
            "name": name,
            "path": path,
            "git": has_git,
            "claude": has_claude,
            "live": is_live,
            "claude_live": claude_live,
            "shell_live": shell_live,
            "can_continue": has_conversations and not claude_live,
            "conv_count": conv_count,
            "subscribers": sub_count,
            "desc": desc,
        })
    return projects


# ==========================================
#  Static files (served from disk for hot-reload)
# ==========================================

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


# ==========================================
#  API Endpoints
# ==========================================

async def index(request):
    index_path = os.path.join(STATIC_DIR, "index.html")
    with open(index_path, "r", encoding="utf-8") as f:
        html = f.read()
    return web.Response(text=html, content_type="text/html",
                        headers={"Cache-Control": "no-store"})



async def static_handler(request):
    """Serve static files from disk (re-read each time for hot-reload)."""
    filename = request.match_info["filename"]
    filepath = os.path.join(STATIC_DIR, filename)
    if not os.path.isfile(filepath):
        return web.Response(status=404)
    content_types = {
        ".css": "text/css",
        ".js": "application/javascript",
        ".html": "text/html",
    }
    ext = os.path.splitext(filename)[1].lower()
    ct = content_types.get(ext, "application/octet-stream")
    with open(filepath, "r", encoding="utf-8") as f:
        body = f.read()
    return web.Response(text=body, content_type=ct,
                        headers={"Cache-Control": "no-store"})

async def claude_logo(request):
    """Serve the Claude pixel logo."""
    logo_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "claude_logo.png")
    if os.path.exists(logo_path):
        return web.FileResponse(logo_path, headers={"Cache-Control": "public, max-age=86400"})
    return web.Response(status=404)


async def api_projects(request):
    """List all projects with metadata."""
    loop = asyncio.get_event_loop()
    projects = await loop.run_in_executor(None, get_projects)
    return web.json_response(projects)


async def api_kill(request):
    """Kill all PTYs for a project."""
    data = await request.json()
    name = data.get("name", "")
    killed = []
    for key_type in ["claude", "shell"]:
        key = f"{name}:{key_type}"
        if key in active_terminals:
            entry = active_terminals[key]
            term = entry.get("terminal")
            if term and term.is_alive():
                term.kill()
                killed.append(key_type)
            # Notify subscribers
            for ws in list(entry["subscribers"]):
                try:
                    await ws.send_json({"type": "status", "data": "killed"})
                    await ws.close()
                except:
                    pass
            entry["subscribers"].clear()
            entry["terminal"] = None
    log.info(f"Killed: {name} ({', '.join(killed) if killed else 'nothing running'})")
    return web.json_response({"killed": killed})


async def api_sessions(request):
    """List Claude conversation sessions for a project."""
    name = request.query.get("name", "")
    project_path = os.path.join(PROJECTS_DIR, name)
    if not os.path.isdir(project_path):
        return web.json_response({"sessions": []})
    claude_proj_key = project_path.replace("\\", "-").replace("/", "-").replace(":", "-")
    conv_dir = os.path.join(CLAUDE_PROJECTS_DIR, claude_proj_key)
    if not os.path.isdir(conv_dir):
        return web.json_response({"sessions": []})

    import datetime
    sessions_list = []
    for fname in os.listdir(conv_dir):
        if not fname.endswith(".jsonl"):
            continue
        fpath = os.path.join(conv_dir, fname)
        sid = fname.replace(".jsonl", "")
        mtime = os.path.getmtime(fpath)
        dt = datetime.datetime.fromtimestamp(mtime)
        # Get first user message as preview
        preview = ""
        try:
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    try:
                        obj = json.loads(line)
                        if obj.get("type") == "user":
                            content = obj.get("message", {}).get("content", "")
                            if isinstance(content, list):
                                for c in content:
                                    if isinstance(c, dict) and c.get("type") == "text":
                                        preview = c["text"][:100].replace("\n", " ")
                                        break
                            elif isinstance(content, str):
                                preview = content[:100].replace("\n", " ")
                            if preview:
                                break
                    except:
                        pass
        except:
            pass
        sessions_list.append({
            "id": sid,
            "date": dt.strftime("%d-%m-%y"),
            "time": dt.strftime("%H:%M"),
            "timestamp": mtime,
            "preview": preview,
        })
    sessions_list.sort(key=lambda s: s["timestamp"], reverse=True)
    return web.json_response({"sessions": sessions_list})


async def api_new_project(request):
    """Create a new project folder."""
    data = await request.json()
    name = data.get("name", "").strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        return web.json_response({"error": "Invalid project name"}, status=400)
    path = os.path.join(PROJECTS_DIR, name)
    if os.path.exists(path):
        return web.json_response({"error": "Project already exists"}, status=400)
    os.makedirs(path)
    log.info(f"Created project: {name}")
    return web.json_response({"created": name})


async def upload_handler(request):
    """Save uploaded file (pasted image or dropped file), return its path."""
    reader = await request.multipart()
    # Check for project/subfolder fields first
    project = None
    subfolder = None
    field = await reader.next()
    while field:
        if field.name == 'project':
            project = (await field.read()).decode('utf-8').strip()
            field = await reader.next()
            continue
        if field.name == 'subfolder':
            subfolder = (await field.read()).decode('utf-8').strip()
            field = await reader.next()
            continue
        if field.name == 'file':
            break
        field = await reader.next()

    if not field:
        return web.json_response({"error": "no file"}, status=400)

    # Save to project's .screenshots/ folder if project specified
    if project:
        upload_dir = os.path.join(PROJECTS_DIR, project, ".screenshots")
    else:
        upload_dir = os.path.join(PROJECTS_DIR, ".tayterm_uploads")
    if subfolder:
        upload_dir = os.path.join(upload_dir, subfolder)
    os.makedirs(upload_dir, exist_ok=True)

    filename = field.filename or f"paste_{int(time.time() * 1000)}.png"
    filename = os.path.basename(filename)
    save_path = os.path.join(upload_dir, filename)

    if os.path.exists(save_path):
        name, ext = os.path.splitext(filename)
        filename = f"{name}_{int(time.time() * 1000)}{ext}"
        save_path = os.path.join(upload_dir, filename)

    with open(save_path, "wb") as f:
        while True:
            chunk = await field.read_chunk()
            if not chunk:
                break
            f.write(chunk)

    log.info(f"Upload: {save_path} ({os.path.getsize(save_path)} bytes)")
    return web.json_response({"path": save_path})


# ==========================================
#  WebSocket Handler
# ==========================================

async def ws_handler(request):
    ws_resp = web.WebSocketResponse()
    await ws_resp.prepare(request)

    project_name = request.query.get("project", "")
    auto_claude = request.query.get("claude", "0") == "1"
    continue_claude = request.query.get("continue", "0") == "1"
    resume_id = request.query.get("resume", "")
    project_path = os.path.join(PROJECTS_DIR, project_name)
    session_type = "claude" if (auto_claude or continue_claude or resume_id) else "shell"
    session_key = f"{project_name}:{session_type}"

    if not project_name or not os.path.isdir(project_path):
        await ws_resp.send_json({"type": "error", "data": f"Project not found: {project_name}"})
        await ws_resp.close()
        return ws_resp

    # Check for existing live PTY for this session type
    is_reattach = False
    if session_key in active_terminals:
        entry = active_terminals[session_key]
        term = entry["terminal"]
        if term and term.is_alive():
            is_reattach = True
        else:
            term = None

    if is_reattach:
        log.info(f"Reattach: {session_key} — {request.remote}")
        await ws_resp.send_json({"type": "status", "data": f"reattached to live {session_type} PTY"})
        entry = active_terminals[session_key]
    else:
        # New PTY
        term = Terminal(cwd=project_path)
        term.start(cols=120, rows=30)
        entry = {"terminal": term, "task": None, "subscribers": set()}
        active_terminals[session_key] = entry
        start_reader(session_key)
        log.info(f"New PTY: {session_key} — {request.remote}")
        await ws_resp.send_json({"type": "status", "data": f"new {session_type} PTY started"})

        if auto_claude or continue_claude or resume_id:
            cmd = CLAUDE_CMD
            if continue_claude:
                cmd += " --continue"
            elif resume_id:
                cmd += " --resume " + resume_id
            await asyncio.sleep(0.5)
            term.write(cmd + "\r")

    # Subscribe
    entry["subscribers"].add(ws_resp)
    term = entry["terminal"]

    try:
        async for msg in ws_resp:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    payload = json.loads(msg.data)
                    if payload.get("type") == "input":
                        if term and term.is_alive():
                            term.write(payload["data"])
                    elif payload.get("type") == "resize":
                        if term and term.is_alive():
                            term.resize(payload["cols"], payload["rows"])
                except:
                    pass
            elif msg.type == web.WSMsgType.ERROR:
                break
    except:
        pass
    finally:
        entry["subscribers"].discard(ws_resp)
        log.info(f"Browser detached: {session_key} — {request.remote} ({len(entry['subscribers'])} still connected)")

    return ws_resp


# ==========================================
#  Main
# ==========================================

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7777)
    args = parser.parse_args()

    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/api/projects", api_projects)
    app.router.add_post("/api/kill", api_kill)
    app.router.add_get("/api/sessions", api_sessions)
    app.router.add_post("/api/new-project", api_new_project)
    app.router.add_get("/api/claude-logo", claude_logo)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/static/{filename}", static_handler)
    app.router.add_post("/upload", upload_handler)

    base_dir = os.path.dirname(os.path.abspath(__file__))
    cert = os.path.join(base_dir, ".tayterm_cert.pem")
    key = os.path.join(base_dir, ".tayterm_key.pem")
    ssl_ctx = None
    if os.path.exists(cert) and os.path.exists(key):
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(cert, key)

    log.info(f"TAYTERM on https://0.0.0.0:{args.port}")
    log.info(f"Projects: {PROJECTS_DIR}")
    web.run_app(app, host="0.0.0.0", port=args.port, ssl_context=ssl_ctx, print=None)


if __name__ == "__main__":
    main()
