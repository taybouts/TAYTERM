# TAYTERM

Self-hosted web terminal with persistent PTY sessions, multi-device sync, and Claude AI integration. Access your terminal from any browser — iPad, phone, work PC — over Tailscale.

## Features

- **Persistent PTY sessions** — terminals survive browser disconnect, reconnect from any device
- **Multi-device sync** — multiple browsers attach to the same PTY simultaneously
- **Claude AI integration** — one-click Claude sessions with `--continue` and `--resume` support
- **Session management** — continue last conversation, resume any past session from a visual picker
- **Project picker** — auto-discovers projects with LIVE/GIT/CLAUDE badges and README descriptions
- **Multi-tab & split panes** — single, horizontal split, vertical split, or quad layout
- **Shell sessions** — separate PTY from Claude, cyan-styled tabs
- **Kill/restart** — kill live PTYs from the picker, tray app auto-restarts server
- **Matrix design language** — Share Tech Mono, green glow, true black, CRT scanlines, configurable matrix rain
- **File operations** — paste images, drag & drop files, auto-uploads to server
- **Fullscreen mode** — toggle from the top bar
- **New project creation** — create project folders from the picker UI
- **System tray app** — launches server, auto-restarts on crash, Matrix-themed log window
- **HTTPS** — self-signed certs for clipboard API on remote devices
- **PWA ready** — mobile/iPad meta tags for home screen install

## Architecture

```
tayterm_terminal.py    — Main server (Python aiohttp + embedded HTML/JS/CSS)
tayterm_tray.pyw       — System tray launcher (pystray + pywebview log window)
TAYTERM.bat            — One-click launcher
claude_logo.png        — Claude pixel logo for loading overlay
tayterm.ico            — Generated Matrix-style tray icon
```

Single-file server — all HTML, CSS, and JS is embedded in `tayterm_terminal.py`. No build step, no node_modules.

### How it works

1. Python aiohttp serves the UI and handles WebSocket connections
2. Each session gets a `winpty` PTY process
3. Browser connects via WebSocket, PTY output streams to all subscribers
4. PTY stays alive when browser disconnects — reconnect shows full terminal state
5. Sessions keyed as `ProjectName:claude` or `ProjectName:shell`

## Requirements

- Python 3.10+
- Windows (uses `winpty` for PTY)
- Dependencies: `aiohttp`, `winpty`, `pystray`, `pywebview`, `Pillow`

## Setup

```bash
pip install aiohttp winpty pystray pywebview Pillow
```

Generate self-signed SSL certs (required for clipboard API on remote devices):
```bash
openssl req -x509 -newkey rsa:2048 -keyout .tayterm_key.pem -out .tayterm_cert.pem -days 365 -nodes -subj "/CN=localhost"
```

## Usage

**Quick start:**
```bash
TAYTERM.bat
```

**Or manually:**
```bash
python tayterm_terminal.py --port 7777
```

Open `https://localhost:7777` in your browser.

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/projects` | GET | List projects with metadata |
| `/api/sessions?name=X` | GET | List conversation sessions for resume |
| `/api/kill` | POST | Kill all PTYs for a project |
| `/api/new-project` | POST | Create new project folder |
| `/api/claude-logo` | GET | Claude pixel logo PNG |
| `/upload` | POST | File upload (paste/drop) |
| `/ws` | GET | WebSocket (`?project=X&claude=1` or `&continue=1` or `&resume=<id>`) |

## License

MIT
