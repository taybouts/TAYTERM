"""
TAYTERM — Web terminal with persistent PTY and multi-device sync.
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


def start_reader(project_name):
    """Background task: read from PTY, broadcast to all connected browsers."""
    entry = active_terminals[project_name]
    term = entry["terminal"]

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


# ══════════════════════════════════════════
#  HTML
# ══════════════════════════════════════════

HTML = '''<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>TAYTERM</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#000000">
<style>
  :root {
    --green: #00ff41;
    --green-dim: #00cc33;
    --green-dark: #003300;
    --green-glow: rgba(0, 255, 65, 0.3);
    --red: #ff0040;
    --red-glow: rgba(255, 0, 64, 0.3);
    --bg: #000000;
    --surface: rgba(0, 255, 65, 0.02);
    --border: var(--green-dark);
    --text: var(--green-dim);
    --text2: #006620;
    --accent: #88ffaa;
    --cyan: #00ccff;
    --warn: #ffaa00;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; scrollbar-width: thin; scrollbar-color: var(--green-dim) transparent; }
  ::-webkit-scrollbar { width: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(0,204,51,0.5); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(0,255,65,0.6); }
  ::-webkit-scrollbar-button { display: none; }
  html, body {
    height: 100%; background: var(--bg); color: var(--text);
    font-family: 'Share Tech Mono', 'Courier New', monospace; overflow: hidden;
  }

  /* ── CRT Scanlines ── */
  .scanlines {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    pointer-events: none; z-index: 999;
    background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.08) 2px, rgba(0,0,0,0.08) 4px);
  }

  /* ── Project Picker ── */
  #picker { display: flex; flex-direction: column; height: 100%; padding: 20px; position: relative; z-index: 1; }
  #picker-header { display: flex; align-items: center; margin-bottom: 16px; justify-content: space-between; }
  #picker-header h1 {
    font-size: 18px; font-weight: 700; color: var(--green); letter-spacing: 4px;
    text-transform: uppercase; text-shadow: 0 0 20px var(--green-glow), 0 0 40px var(--green-glow);
  }
  #picker-right { display: flex; align-items: center; gap: 4px; }
  #new-project-btn {
    background: none; border: 1px solid var(--border); color: var(--green-dark); font-size: 10px;
    cursor: pointer; padding: 3px 10px; font-family: inherit; letter-spacing: 1px;
    text-transform: uppercase; transition: all 0.2s;
  }
  #new-project-btn:hover { border-color: var(--green); color: var(--green); text-shadow: 0 0 5px var(--green-glow); }
  #gear-btn {
    background: none; border: none; color: var(--green-dark); font-size: 16px;
    cursor: pointer; padding: 4px 8px; transition: all 0.3s; opacity: 0.4;
  }
  #gear-btn:hover { color: var(--green-dim); opacity: 0.8; text-shadow: 0 0 5px var(--green-glow); }
  #project-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px; overflow-y: auto; flex: 1; padding-bottom: 20px;
  }
  .project-card {
    background: var(--surface); border: 1px solid var(--border);
    padding: 12px; cursor: pointer; transition: all 0.15s;
    display: flex; flex-direction: column;
  }
  .project-card:hover { border-color: var(--green-dim); background: rgba(0,255,65,0.05); }
  .project-card.live {
    border-color: var(--green);
    box-shadow: 0 0 8px var(--green-glow);
  }
  .project-name {
    font-size: 12px; font-weight: 600; margin-bottom: 6px; color: var(--accent);
    letter-spacing: 1px;
  }
  .project-badges { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 6px; min-height: 18px; }
  .project-actions { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
  .project-actions button {
    font-size: 10px; padding: 6px 8px; cursor: pointer; font-family: inherit;
    border: 1px solid var(--green-dim); background: transparent; color: var(--green-dim);
    letter-spacing: 1px; text-transform: uppercase; transition: all 0.2s;
  }
  .project-actions button:hover {
    background: rgba(0,255,65,0.1); border-color: var(--green);
    color: var(--green); text-shadow: 0 0 10px var(--green-glow);
  }
  .btn-primary {
    width: 100%; padding: 8px !important; font-size: 11px !important; font-weight: 700;
    border-color: var(--green) !important; color: var(--green) !important;
    text-shadow: 0 0 8px var(--green-glow);
  }
  .btn-primary:hover { background: rgba(0,255,65,0.15) !important; }
  .actions-row { display: flex; gap: 4px; }
  .actions-row button { flex: 1; }
  .actions-row .btn-shell:hover {
    background: rgba(0,204,255,0.15); border-color: var(--cyan); color: var(--cyan);
    text-shadow: 0 0 10px rgba(0,204,255,0.4);
  }
  .actions-row .btn-kill {
    border-color: var(--border); color: var(--text2); flex: 0 0 auto;
  }
  .actions-row .btn-kill:hover {
    background: rgba(255,0,64,0.15); border-color: var(--red); color: var(--red);
    text-shadow: 0 0 10px var(--red-glow);
  }
  .actions-row .btn-dim {
    border-color: var(--border); color: var(--text2);
  }
  .actions-row .btn-dim:hover {
    border-color: var(--green-dim); color: var(--green-dim);
  }
  .project-desc {
    font-size: 9px; color: var(--text2); margin-top: 6px; flex: 1;
    line-height: 1.3; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    font-size: 9px; font-weight: 700; padding: 2px 6px; letter-spacing: 1px;
    text-transform: uppercase;
  }
  .badge-live { background: var(--green); color: #000; text-shadow: none; }
  .badge-git { background: transparent; border: 1px solid var(--text2); color: var(--text2); }
  .badge-claude { background: transparent; border: 1px solid var(--green-dim); color: var(--green-dim); }
  .badge-subs { background: transparent; border: 1px solid var(--text2); color: var(--text2); }

  /* ── Terminal View ── */
  #terminal-view { display: none; height: 100%; flex-direction: column; position: relative; z-index: 1; background: var(--bg); }
  #top-bar {
    display: flex; align-items: center; background: rgba(0,255,65,0.03);
    border-bottom: 1px solid var(--border); padding: 0; flex-shrink: 0; height: 32px;
  }
  #back-btn {
    background: none; border: none; border-right: 1px solid var(--border); color: var(--text2);
    padding: 0 12px; cursor: pointer; font-size: 12px; height: 100%; font-family: inherit;
  }
  #back-btn:hover { background: rgba(0,255,65,0.05); color: var(--green); }
  #tab-strip {
    display: flex; flex: 1; overflow-x: auto; height: 100%;
    scrollbar-width: none; -ms-overflow-style: none;
  }
  #tab-strip::-webkit-scrollbar { display: none; }
  .tab {
    display: flex; align-items: center; gap: 6px; padding: 0 12px; cursor: pointer;
    border-right: 1px solid var(--border); font-size: 11px; color: var(--text2);
    white-space: nowrap; flex-shrink: 0; transition: all 0.1s;
  }
  .tab:hover { background: rgba(0,255,65,0.05); color: var(--green-dim); }
  .tab.active {
    background: rgba(0,255,65,0.05); color: var(--green);
    border-bottom: 2px solid var(--green);
    text-shadow: 0 0 5px var(--green-glow);
  }
  .tab .tab-name { font-weight: 600; }
  .tab .tab-shell {
    font-size: 9px; color: #000; background: var(--cyan); padding: 1px 4px;
    letter-spacing: 1px; font-weight: 700;
  }
  .tab .tab-close {
    font-size: 14px; color: var(--text2); cursor: pointer; margin-left: 4px;
    line-height: 1; padding: 0 2px;
  }
  .tab .tab-close:hover { color: var(--red); text-shadow: 0 0 5px var(--red-glow); }
  #layout-btns {
    display: flex; gap: 2px; padding: 0 8px; align-items: center; height: 100%;
    border-left: 1px solid var(--border);
  }
  .layout-btn {
    background: none; border: 1px solid var(--border); color: var(--text2);
    padding: 2px 6px; cursor: pointer; font-size: 10px; font-family: inherit;
  }
  .layout-btn:hover { border-color: var(--green-dim); color: var(--green-dim); }
  .layout-btn.active { border-color: var(--green); color: var(--green); text-shadow: 0 0 5px var(--green-glow); }
  #fullscreen-btn {
    background: none; border: 1px solid var(--border); color: var(--text2);
    padding: 2px 6px; cursor: pointer; font-size: 10px; font-family: inherit;
    margin-left: 4px;
  }
  #fullscreen-btn:hover { border-color: var(--green-dim); color: var(--green-dim); }

  /* ── Pane layouts ── */
  #pane-area { flex: 1; display: flex; overflow: hidden; }
  #pane-area.layout-single { flex-direction: column; }
  #pane-area.layout-hsplit { flex-direction: row; }
  #pane-area.layout-vsplit { flex-direction: column; }
  #pane-area.layout-quad { flex-direction: row; flex-wrap: wrap; }
  .pane {
    flex: 1; overflow: hidden; position: relative; padding: 4px;
    border: 1px solid transparent; min-width: 0; min-height: 0;
  }
  .pane.focused { border-color: var(--green); border-style: solid; }
  .pane.selected { border-color: var(--green-dim); border-style: dashed; }
  #pane-area.layout-quad .pane { flex: 0 0 50%; max-width: 50%; max-height: 50%; }
  .pane-label {
    position: absolute; top: 4px; right: 20px; font-size: 9px;
    color: var(--green-dim); z-index: 1; letter-spacing: 2px;
    text-transform: uppercase;
  }

  #drop-overlay {
    display: none; position: fixed; inset: 0; background: rgba(0,255,65,0.05);
    border: 2px dashed var(--green); z-index: 100; pointer-events: none;
    justify-content: center; align-items: center; font-size: 20px; color: var(--green);
    text-shadow: 0 0 20px var(--green-glow);
    text-transform: uppercase; letter-spacing: 4px;
  }
  #drop-overlay.active { display: flex; }

  /* ── Loading Overlay ── */
  .loading-overlay {
    position: absolute; inset: 0; z-index: 50;
    background: #000;
  }
  .loading-indicator {
    position: absolute; bottom: 40px; right: 40px;
    display: flex; align-items: center; gap: 12px;
  }
  .loading-indicator .loading-label {
    font-size: 16px; color: var(--green-dim); letter-spacing: 4px;
    text-transform: uppercase;
  }
  .loading-indicator .mini-logos {
    display: flex; gap: 5px; align-items: center;
  }
  .loading-indicator .mini-logo {
    opacity: 0; animation: logo-pop 1.5s ease-in-out infinite;
  }
  .loading-indicator .mini-logo:nth-child(1) { animation-delay: 0s; }
  .loading-indicator .mini-logo:nth-child(2) { animation-delay: 0.3s; }
  .loading-indicator .mini-logo:nth-child(3) { animation-delay: 0.6s; }
  .loading-indicator .mini-logo:nth-child(4) { animation-delay: 0.9s; }
  .loading-indicator .mini-logo canvas { image-rendering: pixelated; }
  @keyframes logo-pop {
    0%, 100% { opacity: 0; transform: scale(0.8); }
    30%, 70% { opacity: 1; transform: scale(1); }
  }

  /* ── Settings Panel ── */
  #settings-panel {
    position: fixed; top: 0; right: -280px; width: 280px; height: 100%;
    background: #000; border-left: 1px solid var(--green-dark); z-index: 500;
    padding: 20px; overflow-y: auto; transition: right 0.3s ease;
  }
  #settings-panel.open { right: 0; }
  #settings-panel h2 {
    font-size: 12px; color: var(--green); letter-spacing: 4px;
    text-transform: uppercase; margin-bottom: 20px;
    text-shadow: 0 0 5px var(--green-glow);
  }
  .setting-group { margin-bottom: 16px; }
  .setting-group label {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 11px; color: var(--green-dim); letter-spacing: 1px;
    text-transform: uppercase; margin-bottom: 6px;
  }
  .setting-group label span { color: var(--green); font-size: 10px; }
  .setting-group input[type="range"] {
    -webkit-appearance: none; width: 100%; height: 4px;
    background: var(--green-dark); outline: none; border-radius: 2px;
  }
  .setting-group input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%;
    background: var(--green); cursor: pointer;
    box-shadow: 0 0 6px var(--green-glow);
  }
  .color-presets { display: flex; gap: 6px; flex-wrap: wrap; }
  .color-preset {
    width: 24px; height: 24px; border: 1px solid var(--green-dark);
    cursor: pointer; transition: all 0.15s;
  }
  .color-preset:hover, .color-preset.active { border-color: var(--green); box-shadow: 0 0 6px var(--green-glow); }
  .setting-toggle {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 11px; color: var(--green-dim); letter-spacing: 1px;
    text-transform: uppercase; margin-bottom: 12px; cursor: pointer;
  }
  .toggle-switch {
    width: 32px; height: 16px; border: 1px solid var(--green-dark);
    background: transparent; position: relative; display: inline-block;
  }
  .toggle-switch::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 10px; height: 10px; background: var(--green-dark); transition: all 0.2s;
  }
  .toggle-switch.on { border-color: var(--green); }
  .toggle-switch.on::after { left: 18px; background: var(--green); box-shadow: 0 0 4px var(--green-glow); }
  #settings-close {
    position: absolute; top: 12px; right: 12px; background: none; border: none;
    color: var(--green-dark); font-size: 18px; cursor: pointer;
  }
  #settings-close:hover { color: var(--red); }

  /* ── Confirm Modal ── */
  #confirm-modal {
    display: none; position: fixed; inset: 0; z-index: 210;
    background: transparent; justify-content: center; align-items: center;
  }
  #confirm-modal.active { display: flex; }
  .confirm-panel {
    background: rgba(0,0,0,0.92); border: 1px solid var(--green-dark);
    padding: 24px 28px; text-align: center; min-width: 300px;
  }
  .confirm-panel p {
    font-size: 14px; color: var(--green-dim); margin-bottom: 20px;
    letter-spacing: 1px;
  }
  .confirm-btns { display: flex; gap: 10px; justify-content: center; }
  .confirm-btns button {
    font-size: 12px; padding: 8px 20px; cursor: pointer; font-family: inherit;
    border: 1px solid var(--border); background: transparent; color: var(--text2);
    letter-spacing: 1px; text-transform: uppercase; transition: all 0.2s;
  }
  .confirm-btns .btn-yes {
    border-color: var(--green); color: var(--green);
  }
  .confirm-btns .btn-yes:hover { background: rgba(0,255,65,0.15); }
  .confirm-btns .btn-no:hover { border-color: var(--red); color: var(--red); }

  /* ── Resume Modal ── */
  #resume-modal {
    display: none; position: fixed; inset: 0; z-index: 200;
    background: transparent; justify-content: center; align-items: center;
  }
  #resume-modal.active { display: flex; }
  .resume-panel {
    background: rgba(0,0,0,0.92); border: 1px solid var(--green-dark);
    width: 650px; max-width: 92vw; max-height: 75vh; display: flex; flex-direction: column;
  }
  .resume-header {
    display: flex; align-items: center; padding: 14px 18px;
    border-bottom: 1px solid var(--border);
  }
  .resume-header h2 {
    font-size: 14px; color: var(--green); letter-spacing: 2px;
    text-transform: uppercase; flex: 1;
  }
  .resume-close {
    background: none; border: none; color: var(--text2); font-size: 20px;
    cursor: pointer; padding: 0 6px;
  }
  .resume-close:hover { color: var(--red); }
  .resume-list {
    flex: 1; overflow-y: auto; padding: 4px 0;
  }
  .resume-list::-webkit-scrollbar { width: 6px; }
  .resume-list::-webkit-scrollbar-track { background: #000; }
  .resume-list::-webkit-scrollbar-thumb { background: var(--green-dark); }
  .resume-item {
    padding: 14px 18px; cursor: pointer; border-bottom: 1px solid rgba(0,51,0,0.3);
    transition: all 0.1s;
  }
  .resume-item:hover { background: rgba(0,255,65,0.05); }
  .resume-item-top { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
  .resume-date { font-size: 15px; color: var(--green); font-weight: 700; }
  .resume-time { font-size: 14px; color: var(--text2); }
  .resume-id { font-size: 11px; color: var(--text2); margin-left: auto; opacity: 0.5; }
  .resume-preview {
    font-size: 14px; color: var(--text2); line-height: 1.4;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* ── Matrix Rain ── */
  #matrix-bg {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    z-index: 0; opacity: 0.12; pointer-events: none;
  }
</style>
</head>
<body>

<canvas id="matrix-bg"></canvas>

<!-- Project Picker -->
<div id="picker">
  <div id="picker-header"><h1>> TAYTERM_</h1><div id="picker-right"><button id="new-project-btn" onclick="newProject()">+ New</button><button id="gear-btn" title="Settings">&#9881;</button></div></div>
  <div id="project-grid"></div>
</div>

<!-- Terminal View -->
<div id="terminal-view">
  <div id="top-bar">
    <button id="back-btn" onclick="showPicker()">&#9664;</button>
    <div id="tab-strip"></div>
    <div id="layout-btns">
      <button class="layout-btn active" data-layout="single" onclick="setLayout('single')">&#9632;</button>
      <button class="layout-btn" data-layout="hsplit" onclick="setLayout('hsplit')">&#9646;&#9646;</button>
      <button class="layout-btn" data-layout="vsplit" onclick="setLayout('vsplit')">&#9620;&#9620;</button>
      <button class="layout-btn" data-layout="quad" onclick="setLayout('quad')">&#9638;</button>
      <button id="fullscreen-btn" onclick="toggleFullscreen()" title="Fullscreen">&#x26F6;</button>
    </div>
  </div>
  <div id="pane-area" class="layout-single"></div>
</div>

<div id="drop-overlay">DROP FILE</div>

<!-- Confirm Modal -->
<div id="confirm-modal" onclick="if(event.target===this)closeConfirm()">
  <div class="confirm-panel">
    <p id="confirm-msg"></p>
    <div class="confirm-btns">
      <button class="btn-no" onclick="closeConfirm()">Cancel</button>
      <button class="btn-yes" id="confirm-yes">Confirm</button>
    </div>
  </div>
</div>

<!-- Resume Modal -->
<div id="resume-modal" onclick="if(event.target===this)closeResumeModal()">
  <div class="resume-panel">
    <div class="resume-header">
      <h2 id="resume-title">Resume Session</h2>
      <button class="resume-close" onclick="closeResumeModal()">&times;</button>
    </div>
    <div class="resume-list" id="resume-list"></div>
  </div>
</div>

<!-- Settings Panel -->
<div id="settings-panel">
  <button id="settings-close" onclick="toggleSettings()">&times;</button>
  <h2>Settings</h2>

  <div class="setting-toggle" onclick="toggleScanlines()">
    <span>Scanlines</span>
    <div class="toggle-switch" id="toggle-scanlines"></div>
  </div>

  <div class="setting-toggle" onclick="toggleRain()">
    <span>Matrix Rain</span>
    <div class="toggle-switch on" id="toggle-rain"></div>
  </div>

  <div class="setting-group">
    <label>Opacity <span id="val-opacity">0.12</span></label>
    <input type="range" id="sl-opacity" min="0" max="30" value="12" oninput="updateSetting('opacity', this.value/100)">
  </div>

  <div class="setting-group">
    <label>Speed <span id="val-speed">50ms</span></label>
    <input type="range" id="sl-speed" min="20" max="150" value="50" oninput="updateSetting('speed', +this.value)">
  </div>

  <div class="setting-group">
    <label>Fade <span id="val-fade">0.05</span></label>
    <input type="range" id="sl-fade" min="1" max="25" value="5" oninput="updateSetting('fade', this.value/100)">
  </div>

  <div class="setting-group">
    <label>Font Size <span id="val-fontSize">14px</span></label>
    <input type="range" id="sl-fontSize" min="8" max="28" value="14" oninput="updateSetting('fontSize', +this.value)">
  </div>

  <div class="setting-group">
    <label>Color</label>
    <div class="color-presets">
      <div class="color-preset active" style="background:#00ff41" onclick="updateSetting('color','#00ff41')" title="Green"></div>
      <div class="color-preset" style="background:#00ccff" onclick="updateSetting('color','#00ccff')" title="Cyan"></div>
      <div class="color-preset" style="background:#ff0040" onclick="updateSetting('color','#ff0040')" title="Red"></div>
      <div class="color-preset" style="background:#ffaa00" onclick="updateSetting('color','#ffaa00')" title="Amber"></div>
      <div class="color-preset" style="background:#cc44ff" onclick="updateSetting('color','#cc44ff')" title="Purple"></div>
      <div class="color-preset" style="background:#ffffff" onclick="updateSetting('color','#ffffff')" title="White"></div>
    </div>
  </div>
</div>

<div class="scanlines" id="scanlines-overlay" style="display:none"></div>

<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-webgl@0.18.0/lib/addon-webgl.min.js"></script>
<script>

// ══════════════════════════════════════════
//  State
// ══════════════════════════════════════════
const sessions = {};  // { id: { name, term, ws, fitAddon, container, isShell } }
let activeSessionId = null;
let layout = 'single';
let paneSlots = [];  // session IDs assigned to panes
let selectedPane = 0;  // which pane is selected for tab assignment

// ══════════════════════════════════════════
//  Session persistence (localStorage)
// ══════════════════════════════════════════
function saveState() {
  const tabs = Object.values(sessions).map(s => ({ name: s.name, isShell: s.isShell }));
  const active = activeSessionId ? sessions[activeSessionId]?.name : null;
  localStorage.setItem('tayterm_tabs', JSON.stringify({ tabs, active, layout }));
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem('tayterm_tabs'));
  } catch(e) { return null; }
}

// ══════════════════════════════════════════
//  Project Picker
// ══════════════════════════════════════════
async function loadProjects() {
  const resp = await fetch('/api/projects');
  const projects = await resp.json();
  const grid = document.getElementById('project-grid');
  grid.innerHTML = '';
  for (const p of projects) {
    const card = document.createElement('div');
    card.className = 'project-card' + (p.live ? ' live' : '');
    let badges = '';
    if (p.live) badges += '<span class="badge badge-live">LIVE</span>';
    if (p.subscribers > 0) badges += '<span class="badge badge-subs">' + p.subscribers + '</span>';
    if (p.claude) badges += '<span class="badge badge-claude">CLAUDE</span>';
    if (p.git) badges += '<span class="badge badge-git">GIT</span>';
    let actionsHtml = '';
    if (p.claude_live) {
      actionsHtml =
        '<button class="btn-primary" onclick="event.stopPropagation(); openSession(\\'' + p.name + '\\', false)">Claude</button>' +
        '<div class="actions-row">' +
          '<button class="btn-shell" onclick="event.stopPropagation(); openSession(\\'' + p.name + '\\', true)">Shell</button>' +
          '<button class="btn-kill" onclick="event.stopPropagation(); killProject(\\'' + p.name + '\\')">Kill</button>' +
        '</div>';
    } else if (p.can_continue) {
      actionsHtml =
        '<button class="btn-primary" onclick="event.stopPropagation(); continueSession(\\'' + p.name + '\\')">Continue</button>' +
        '<div class="actions-row">' +
          '<button class="btn-dim" onclick="event.stopPropagation(); confirmNewSession(\\'' + p.name + '\\')">New</button>' +
          '<button class="btn-dim" onclick="event.stopPropagation(); resumeSession(\\'' + p.name + '\\')">Resume (' + p.conv_count + ')</button>' +
          '<button class="btn-shell" onclick="event.stopPropagation(); openSession(\\'' + p.name + '\\', true)">Shell</button>' +
        '</div>';
    } else {
      actionsHtml =
        '<button class="btn-primary" onclick="event.stopPropagation(); openSession(\\'' + p.name + '\\', false)">Claude</button>' +
        '<div class="actions-row">' +
          '<button class="btn-shell" onclick="event.stopPropagation(); openSession(\\'' + p.name + '\\', true)">Shell</button>' +
        '</div>';
    }
    card.innerHTML =
      '<div class="project-name">' + p.name + '</div>' +
      '<div class="project-badges">' + badges + '</div>' +
      '<div class="project-actions">' + actionsHtml + '</div>' +
      (p.desc ? '<div class="project-desc">' + p.desc + '</div>' : '<div class="project-desc">&nbsp;</div>');
    card.onclick = () => p.can_continue ? continueSession(p.name) : openSession(p.name, false);
    grid.appendChild(card);
  }
}

function showPicker() {
  document.getElementById('picker').style.display = 'flex';
  // Only hide terminal view if no tabs are open
  if (Object.keys(sessions).length === 0) {
    document.getElementById('terminal-view').style.display = 'none';
  }
  loadProjects();
}

// ══════════════════════════════════════════
//  Kill / Fullscreen / New Project
// ══════════════════════════════════════════
async function confirmNewSession(name) {
  showConfirm('Start a fresh Claude session?', () => openSession(name, false));
}

function showConfirm(msg, onYes) {
  document.getElementById('confirm-msg').textContent = msg;
  const yes = document.getElementById('confirm-yes');
  yes.onclick = () => { closeConfirm(); onYes(); };
  document.getElementById('confirm-modal').classList.add('active');
}
function closeConfirm() {
  document.getElementById('confirm-modal').classList.remove('active');
}

async function resumeSession(name) {
  const resp = await fetch('/api/sessions?name=' + encodeURIComponent(name));
  const data = await resp.json();
  const list = document.getElementById('resume-list');
  document.getElementById('resume-title').textContent = name + ' — Sessions';
  list.innerHTML = '';
  for (const s of data.sessions) {
    const item = document.createElement('div');
    item.className = 'resume-item';
    item.innerHTML =
      '<div class="resume-item-top">' +
        '<span class="resume-date">' + s.date + '</span>' +
        '<span class="resume-time">' + s.time + '</span>' +
        '<span class="resume-id">' + s.id.substring(0, 8) + '</span>' +
      '</div>' +
      '<div class="resume-preview">' + (s.preview || '(no preview)') + '</div>';
    item.onclick = () => { closeResumeModal(); pickSession(name, s.id); };
    list.appendChild(item);
  }
  document.getElementById('resume-modal').classList.add('active');
}

function closeResumeModal() {
  document.getElementById('resume-modal').classList.remove('active');
}

function pickSession(name, sessionId) {
  const id = name + ':claude';
  if (sessions[id]) closeTab(id);
  openSession(name, false, false, sessionId);
}

function continueSession(name) {
  const id = sessionId(name, false);
  // Close existing dead tab if any
  if (sessions[id]) closeTab(id);
  // Open with continue flag
  openSession(name, false, true, null);
}

async function killProject(name) {
  await fetch('/api/kill', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name: name})});
  // Close tabs for this project
  for (const id of Object.keys(sessions)) {
    if (id.startsWith(name + ':')) closeTab(id);
  }
  loadProjects();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

function newProject() {
  const name = prompt('Project name:');
  if (!name || !name.trim()) return;
  fetch('/api/new-project', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name: name.trim()})})
    .then(r => r.json()).then(result => {
      if (result.error) { alert(result.error); return; }
      loadProjects();
    });
}

// ══════════════════════════════════════════
//  Pixel Claude Sprite
// ══════════════════════════════════════════
function drawMiniClaude(el) {
  const img = new Image();
  img.onload = function() {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.style.width = Math.round(img.width * 0.2) + 'px';
    c.style.height = Math.round(img.height * 0.2) + 'px';
    c.style.imageRendering = 'pixelated';
    const ctx = c.getContext('2d');

    const tmp = document.createElement('canvas');
    tmp.width = img.width; tmp.height = img.height;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(img, 0, 0);
    const imgData = tctx.getImageData(0, 0, tmp.width, tmp.height);
    const d = imgData.data;

    ctx.fillStyle = '#00ff41';
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        if (d[i+3] > 128 && (d[i] + d[i+1] + d[i+2]) > 80) {
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    el.appendChild(c);
  };
  img.src = '/api/claude-logo';
}

// ══════════════════════════════════════════
//  Session management
// ══════════════════════════════════════════
function sessionId(name, isShell) {
  return name + (isShell ? ':shell' : ':claude');
}

function openSession(name, isShell, continueFlag, resumeId) {
  const id = sessionId(name, isShell);

  // If already open, just switch to it
  if (sessions[id]) {
    switchTab(id);
    document.getElementById('picker').style.display = 'none';
    return;
  }

  // Show terminal view, hide picker
  document.getElementById('picker').style.display = 'none';
  document.getElementById('terminal-view').style.display = 'flex';

  // Create container
  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;display:none;position:relative;';

  // Loading overlay with running pixel Claude logo
  const loader = document.createElement('div');
  loader.className = 'loading-overlay';
  loader.innerHTML =
    '<div class="loading-indicator">' +
      '<span class="loading-label">' + (isShell ? 'SHELL' : 'LOADING') + '</span>' +
      '<div class="mini-logos">' +
        '<div class="mini-logo"></div>' +
        '<div class="mini-logo"></div>' +
        '<div class="mini-logo"></div>' +
        '<div class="mini-logo"></div>' +
      '</div>' +
    '</div>';
  container.appendChild(loader);
  loader.querySelectorAll('.mini-logo').forEach(el => drawMiniClaude(el));

  // Create terminal
  const term = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    fontSize: 17,
    fontFamily: 'courier-new, courier, monospace',
    theme: { background: '#000' },
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  try { term.loadAddon(new WebglAddon.WebglAddon()); } catch(e) {}

  // Connect WebSocket
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = 'project=' + encodeURIComponent(name) + (isShell ? '' : resumeId ? '&resume=' + resumeId : continueFlag ? '&continue=1' : '&claude=1');
  const ws = new WebSocket(proto + '//' + location.host + '/ws?' + params);

  let loaderDismissed = false;
  function dismissLoader() {
    if (!loaderDismissed && loader.parentNode) {
      loaderDismissed = true;
      loader.style.transition = 'opacity 0.3s';
      loader.style.opacity = '0';
      setTimeout(() => loader.remove(), 300);
    }
  }

  const session = { name, term, ws, fitAddon, container, isShell };
  sessions[id] = session;

  ws.onopen = () => {
    fitAddon.fit();
    const dims = fitAddon.proposeDimensions() || { cols: 120, rows: 30 };
    ws.send(JSON.stringify({ type: 'resize', cols: dims.cols - 1, rows: dims.rows }));
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
    }, 50);
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output') {
        term.write(msg.data);
        dismissLoader();
      }
    } catch(err) {}
  };

  ws.onclose = () => {};

  term.onData(data => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  // Clipboard handler
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const key = e.key.toLowerCase();
    if (e.ctrlKey && key === 'c') {
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
        term.clearSelection();
        return false;
      }
      return true;
    }
    if (e.ctrlKey && key === 'v') {
      e.preventDefault();
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
          if (text) {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: 'input', data: text.trim() }));
          }
        }
      }).catch(() => {
        navigator.clipboard.readText().then(text => {
          if (text && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'input', data: text.trim() }));
        }).catch(() => {});
      });
      return false;
    }
    return true;
  });

  renderTabs();
  switchTab(id);
  saveState();
}

function closeSession(id) {
  const session = sessions[id];
  if (!session) return;
  if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.close();
  if (session.term) session.term.dispose();
  if (session.container && session.container.parentNode) session.container.parentNode.removeChild(session.container);
  delete sessions[id];

  // Remove from pane slots
  paneSlots = paneSlots.map(s => s === id ? null : s);

  // Switch to another tab or show picker
  const remaining = Object.keys(sessions);
  if (remaining.length > 0) {
    switchTab(remaining[remaining.length - 1]);
  } else {
    activeSessionId = null;
    showPicker();
  }
  renderTabs();
  saveState();
}

// ══════════════════════════════════════════
//  Tabs
// ══════════════════════════════════════════
function renderTabs() {
  const strip = document.getElementById('tab-strip');
  strip.innerHTML = '';
  for (const [id, s] of Object.entries(sessions)) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (id === activeSessionId ? ' active' : '');
    tab.innerHTML =
      '<span class="tab-name">' + s.name + '</span>' +
      (s.isShell ? '<span class="tab-shell">SHELL</span>' : '') +
      '<span class="tab-close" onclick="event.stopPropagation(); closeSession(\\'' + id + '\\')">&times;</span>';
    tab.onclick = () => switchTab(id);
    strip.appendChild(tab);
  }
}

function switchTab(id) {
  if (!sessions[id]) return;
  activeSessionId = id;

  // Assign to selected pane (or first empty, or selected pane replacing existing)
  if (!paneSlots.includes(id)) {
    const emptyIdx = paneSlots.indexOf(null);
    if (emptyIdx >= 0) {
      paneSlots[emptyIdx] = id;
      selectedPane = emptyIdx;
    } else {
      // Replace the selected pane's content
      paneSlots[selectedPane] = id;
    }
  } else {
    // Already in a slot — just update selected pane to where it is
    selectedPane = paneSlots.indexOf(id);
  }

  renderTabs();
  renderPanes();
  saveState();
}

// ══════════════════════════════════════════
//  Pane layouts
// ══════════════════════════════════════════
function setLayout(newLayout) {
  layout = newLayout;
  document.querySelectorAll('.layout-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.layout === layout);
  });

  const paneCount = { single: 1, hsplit: 2, vsplit: 2, quad: 4 }[layout] || 1;
  // Ensure paneSlots has right length
  while (paneSlots.length < paneCount) paneSlots.push(null);
  paneSlots.length = paneCount;
  // Fill empty slots with open sessions
  const usedIds = new Set(paneSlots.filter(Boolean));
  const available = Object.keys(sessions).filter(id => !usedIds.has(id));
  for (let i = 0; i < paneSlots.length; i++) {
    if (!paneSlots[i] && available.length > 0) paneSlots[i] = available.shift();
  }
  // Make sure active session is in a slot
  if (activeSessionId && !paneSlots.includes(activeSessionId)) {
    paneSlots[0] = activeSessionId;
  }

  renderPanes();
  saveState();
}

function renderPanes() {
  const area = document.getElementById('pane-area');
  area.className = 'layout-' + layout;
  area.innerHTML = '';

  const paneCount = { single: 1, hsplit: 2, vsplit: 2, quad: 4 }[layout] || 1;
  const isMultiPane = paneCount > 1;
  while (paneSlots.length < paneCount) paneSlots.push(null);
  if (selectedPane >= paneCount) selectedPane = 0;

  for (let i = 0; i < paneCount; i++) {
    const pane = document.createElement('div');
    // Only show border highlights in multi-pane mode
    if (isMultiPane) {
      pane.className = 'pane' + (i === selectedPane ? ' selected' : '');
    } else {
      pane.className = 'pane';
    }

    const sid = paneSlots[i];
    if (sid && sessions[sid]) {
      const s = sessions[sid];
      // Only show pane label in multi-pane mode
      if (isMultiPane) {
        const label = document.createElement('div');
        label.className = 'pane-label';
        if (s.isShell) {
          label.innerHTML = s.name.toUpperCase() + ' <span style="color:var(--cyan);font-weight:700">SHELL</span>';
        } else {
          label.textContent = s.name.toUpperCase();
        }
        pane.appendChild(label);
      }

      s.container.style.display = 'block';
      s.container.style.width = '100%';
      s.container.style.height = '100%';
      pane.appendChild(s.container);

      const paneIdx = i;
      pane.onclick = () => {
        selectedPane = paneIdx;
        activeSessionId = sid;
        document.querySelectorAll('.pane').forEach((p, j) => {
          p.classList.remove('selected');
          if (j === selectedPane && isMultiPane) p.classList.add('selected');
        });
        renderTabs();
        sessions[sid].term.focus();
      };

      // Fit after render
      setTimeout(() => {
        s.fitAddon.fit();
        s.term.refresh(0, s.term.rows - 1);
      }, 50);
    } else if (isMultiPane) {
      // Empty pane — clickable to select it
      const paneIdx = i;
      pane.onclick = () => {
        selectedPane = paneIdx;
        document.querySelectorAll('.pane').forEach((p, j) => {
          p.classList.remove('selected');
          if (j === selectedPane) p.classList.add('selected');
        });
      };
    }

    area.appendChild(pane);
  }

  // Refit all visible sessions
  setTimeout(() => {
    for (const sid of paneSlots) {
      if (sid && sessions[sid]) {
        sessions[sid].fitAddon.fit();
      }
    }
  }, 100);
}

// ══════════════════════════════════════════
//  Upload / drag & drop
// ══════════════════════════════════════════
async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const resp = await fetch('/upload', { method: 'POST', body: formData });
    const result = await resp.json();
    if (result.path && activeSessionId && sessions[activeSessionId]) {
      const s = sessions[activeSessionId];
      if (s.ws.readyState === WebSocket.OPEN)
        s.ws.send(JSON.stringify({ type: 'input', data: result.path }));
    }
  } catch(err) { console.error('Upload failed:', err); }
}

let dragCounter = 0;
const dropOverlay = document.getElementById('drop-overlay');
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; dropOverlay.classList.add('active'); });
document.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('active'); } });
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => {
  e.preventDefault(); dragCounter = 0; dropOverlay.classList.remove('active');
  for (const file of e.dataTransfer.files) uploadFile(file);
});

// ══════════════════════════════════════════
//  Window events
// ══════════════════════════════════════════
window.addEventListener('focus', () => {
  for (const s of Object.values(sessions)) {
    if (s.container.style.display !== 'none') {
      s.fitAddon.fit();
      s.term.refresh(0, s.term.rows - 1);
    }
  }
});

// ══════════════════════════════════════════
//  Init — restore or show picker
// ══════════════════════════════════════════
(function init() {
  const saved = loadState();
  if (saved && saved.tabs && saved.tabs.length > 0) {
    layout = saved.layout || 'single';
    document.querySelectorAll('.layout-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.layout === layout);
    });
    for (const tab of saved.tabs) {
      openSession(tab.name, tab.isShell || false);
    }
    if (saved.active) {
      const id = Object.keys(sessions).find(k => sessions[k].name === saved.active);
      if (id) switchTab(id);
    }
  } else {
    showPicker();
  }
})();

// ══════════════════════════════════════════
//  Settings & Matrix Rain
// ══════════════════════════════════════════
const matrixState = {
  chars: 'アカサタナハマヤラワ0123456789TAYTERM',
  canvas: document.getElementById('matrix-bg'),
  interval: null,
  settings: Object.assign(
    { opacity: 0.12, speed: 50, fade: 0.05, fontSize: 14, color: '#00ff41', rain: true, scanlines: false },
    JSON.parse(localStorage.getItem('tayterm_matrix') || '{}')
  ),
  drops: [],
  columns: 0,
};

function saveMatrixSettings() {
  localStorage.setItem('tayterm_matrix', JSON.stringify(matrixState.settings));
}

function initRain() {
  const { canvas, settings } = matrixState;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.opacity = settings.opacity;
  matrixState.columns = Math.floor(canvas.width / settings.fontSize);
  matrixState.drops = Array(matrixState.columns).fill(1);

  if (matrixState.interval) clearInterval(matrixState.interval);

  if (!settings.rain) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  matrixState.interval = setInterval(() => {
    const s = matrixState.settings;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,' + (1 - s.fade) + ')';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = s.fontSize + 'px monospace';
    ctx.fillStyle = s.color;
    for (let i = 0; i < matrixState.drops.length; i++) {
      const char = matrixState.chars[Math.floor(Math.random() * matrixState.chars.length)];
      ctx.fillText(char, i * s.fontSize, matrixState.drops[i] * s.fontSize);
      if (matrixState.drops[i] * s.fontSize > canvas.height && Math.random() > 0.975) matrixState.drops[i] = 0;
      matrixState.drops[i]++;
    }
  }, settings.speed);
}

function toggleSettings() {
  document.getElementById('settings-panel').classList.toggle('open');
}

function toggleScanlines() {
  const s = matrixState.settings;
  s.scanlines = !s.scanlines;
  document.getElementById('scanlines-overlay').style.display = s.scanlines ? 'block' : 'none';
  document.getElementById('toggle-scanlines').classList.toggle('on', s.scanlines);
  saveMatrixSettings();
}

function toggleRain() {
  const s = matrixState.settings;
  s.rain = !s.rain;
  document.getElementById('toggle-rain').classList.toggle('on', s.rain);
  saveMatrixSettings();
  initRain();
}

function updateSetting(key, value) {
  matrixState.settings[key] = value;
  saveMatrixSettings();

  if (key === 'opacity') {
    document.getElementById('val-opacity').textContent = value.toFixed(2);
    matrixState.canvas.style.opacity = value;
  } else if (key === 'speed') {
    document.getElementById('val-speed').textContent = value + 'ms';
    initRain();
  } else if (key === 'fade') {
    document.getElementById('val-fade').textContent = value.toFixed(2);
  } else if (key === 'fontSize') {
    document.getElementById('val-fontSize').textContent = value + 'px';
    initRain();
  } else if (key === 'color') {
    document.querySelectorAll('.color-preset').forEach(el => {
      el.classList.toggle('active', el.style.background === value || el.style.backgroundColor === value);
    });
  }
}

// Apply saved settings to UI
(function applySettings() {
  const s = matrixState.settings;
  document.getElementById('sl-opacity').value = Math.round(s.opacity * 100);
  document.getElementById('val-opacity').textContent = s.opacity.toFixed(2);
  document.getElementById('sl-speed').value = s.speed;
  document.getElementById('val-speed').textContent = s.speed + 'ms';
  document.getElementById('sl-fade').value = Math.round(s.fade * 100);
  document.getElementById('val-fade').textContent = s.fade.toFixed(2);
  document.getElementById('sl-fontSize').value = s.fontSize;
  document.getElementById('val-fontSize').textContent = s.fontSize + 'px';
  document.getElementById('toggle-scanlines').classList.toggle('on', s.scanlines);
  document.getElementById('toggle-rain').classList.toggle('on', s.rain);
  document.getElementById('scanlines-overlay').style.display = s.scanlines ? 'block' : 'none';
  document.querySelectorAll('.color-preset').forEach(el => {
    el.classList.toggle('active', el.style.background === s.color);
  });
  initRain();
})();

window.addEventListener('resize', () => {
  matrixState.canvas.width = window.innerWidth;
  matrixState.canvas.height = window.innerHeight;
  matrixState.columns = Math.floor(matrixState.canvas.width / matrixState.settings.fontSize);
  matrixState.drops = Array(matrixState.columns).fill(1);
  for (const s of Object.values(sessions)) {
    if (s.container.style.display !== 'none') s.fitAddon.fit();
  }
});

</script>
</body>
</html>'''


# ══════════════════════════════════════════
#  API Endpoints
# ══════════════════════════════════════════

async def index(request):
    return web.Response(text=HTML, content_type="text/html",
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
    upload_dir = os.path.join(PROJECTS_DIR, ".tayterm_uploads")
    os.makedirs(upload_dir, exist_ok=True)
    reader = await request.multipart()
    field = await reader.next()
    if not field:
        return web.json_response({"error": "no file"}, status=400)

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


# ══════════════════════════════════════════
#  WebSocket Handler
# ══════════════════════════════════════════

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


# ══════════════════════════════════════════
#  Main
# ══════════════════════════════════════════

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
