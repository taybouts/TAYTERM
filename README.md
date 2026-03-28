# T-TERM

**The AI terminal, reimagined as a messenger.**

T-Term is a self-hosted web terminal that turns Claude Code into a conversational interface. Terminal power meets messenger simplicity — chat bubbles, inline images, real-time tool tracking, and persistent conversation history. Access from any browser, any device, anywhere.

---

## What makes T-Term different

### Messenger-First Design

The terminal is still there — but the messenger is the primary view. Every Claude interaction becomes a clean conversation: your messages on the right, Claude's responses on the left with full markdown rendering. Tables, code blocks, numbered lists, bold text — all beautifully formatted in glass-styled chat bubbles.

**Switch between messenger and terminal with one click.** The same PTY session powers both views. Type in the messenger, see it execute in the terminal. Switch to terminal for raw power, switch back to messenger for clarity.

### Real-Time Intelligence

Watch Claude think in real time:

- **Dynamic status** — "Thinking..." → "Reading..." → "Editing..." → "Searching..." — the phase updates live
- **Tool chain badges** — `Read` `Grep` `Edit` `Write` — each tool appears as a badge, building up the full chain
- **Agent tracking** — see when sub-agents launch, how many are running
- **Response metrics** — every response shows: timestamp · response time · token count
- **Context awareness** — pull-up info panel shows model, context usage (% of 1M), output tokens

### Mobile PWA

Full native-feeling app on iPhone and iPad:

- **Add to Home Screen** — runs as a standalone PWA, edge-to-edge
- **Real-time sync** — type on desktop, see it on phone instantly (same PTY, same JSONL)
- **Photo picker** — send photos from camera roll or take a photo, compressed and sent to Claude
- **Voice input** — native speech recognition with mic button
- **Thinking + tool badges** — same live indicators as desktop
- **iPhone 17 Pro Max optimized** — Dynamic Island safe area, home indicator, large touch targets

### Side Tray

Hover the right edge to reveal the utility panel:

- **Flags** — bookmarked assistant responses
- **Search** — real-time conversation search with highlighted matches in results and bubbles
- **Gallery** — all images from the session
- **Sessions** — browse all JSONL conversations with token counts, click to preview, resume/delete/favorite
- **Notes** — per-project or general quick notes

### Browser Voice Player

Text-to-speech powered by Kokoro — sentence by sentence with live text highlighting.

- **Sentence highlighting** — current sentence underlined in blue, tracks through the text as it speaks
- **Click-to-jump** — click anywhere in a bubble to jump to that sentence
- **Controller bar** — prev/pause/next/stop, timeline scrub, sentence counter
- **Auto-play** — new assistant messages play automatically with message queue
- **Background playback** — keeps playing when browser tab isn't focused
- **Per-tab mute** — browser-side, per-project voice selection via right-click menu
- **Keyboard controls** — Arrow left/right (sentences), Space (pause), Alt (stop)

### Whisper STT

Voice input powered by WhisperX — accurate transcription for technical terms and code.

- **Push-to-talk** — hold Ctrl+Shift to record, release to auto-send
- **Mic button** — tap to record, tap send to transcribe + send
- **All devices** — desktop, iPhone, iPad all use Whisper (no browser SpeechRecognition)

### Ink Voice UI (Mobile)

Full-screen voice-first interface for hands-free use:

- **4 visual effects** — Ink, Fluid, Aurora, Membrane (tap to cycle)
- **Tap anywhere** — start/stop recording, no mic button needed
- **OLED-optimized** — true black background, particles fade cleanly
- **AI visualization** — cyan particles when Claude speaks, amber when you record

### Screenshots & Images

Paste or capture a screenshot — it appears as an inline image bubble. Click to expand full-screen. Full quality stored locally, compressed version sent to Claude. Delete button on hover.

- Desktop: Ctrl+V paste, snip region, window, or screen capture
- Mobile: photo picker (camera roll or take photo)
- Cross-device: images uploaded on one device show on all others

---

## Authentication & Admin

### Multi-Device Auth

- **QR code login** — scan with phone, approve with Face ID
- **Direct passkey sign-in** — authenticate on the same device without QR
- **WebAuthn/Passkeys** via 1Password or iCloud Keychain
- **Two-step registration** — username/profile form, then passkey enrollment
- **Backup codes** for emergency access (8× XXXX-XXXX format)
- **Fail-closed** — no passkeys or missing module = block everyone (never fail-open)

### Invite System

- **Admin generates invite links** from `/admin` Invites tab
- **One-time tokens** — 256-bit, 24h expiry, single-use, revocable
- **User opens link** → registration page with email pre-filled → passkey enrollment
- **No open registration** — registration locked to localhost or valid invite token
- **All actions audited** — create, use, revoke logged

### Device Whitelist

- Trusted devices skip authentication entirely
- Localhost (TAYCAST) always trusted — no cookie needed
- Persistent cookie survives server restarts
- Manage from Admin panel

### Admin Panel (`/admin`)

- **Sessions** — all active sessions with device info, kill any remotely
- **Devices** — registered passkeys with user profile (name, role, device, browser, OS, IP)
- **Trusted** — whitelist management
- **Audit Log** — all auth events: logins, failures, registrations, whitelist changes
- **Invites** — generate, copy, revoke invite links; view pending/used/expired status
- Sessions persist to disk — survive server restarts

---

## Architecture

### Three-Process Model (v4.0.0)

```
pty-daemon.js          PTY Daemon — owns all terminal processes (port 5041)
                       Dashboard at port 5042
server.js              T-Term Server — WebSocket bridge, JSONL watcher, TTS/STT proxy (port 5044)
auth.js                Auth system — QR, passkeys, admin, whitelist, audit, email invites
lib/gateway-auth.js    Gateway auth — Cloudflare-proxied authentication via taybouts.com
routes/api.js          REST API + /api/tts/* proxy to T-Voice + /api/project-settings + /api/connection-info
routes/ws.js           WebSocket handler
routes/static.js       Static file serving
lib/jsonl-reader.js    JSONL file watcher (30ms debounced)
lib/tts-tap.js         TTSTap (server-side TTS, now muted — browser owns audio)
lib/daemon-client.js   TCP client for PTY daemon
pty-client.js          CLI tool — attach any terminal to a daemon PTY
static/app.js          Frontend — tabs, sessions, connection detection
static/messenger.js    Messenger UI, voice player, Whisper STT, push-to-talk
static/mobile.js       iPhone chat interface
static/ipad.js         iPad overrides (photo picker, mic, connection badge)
static/ink.js          Ink Voice UI — 4 canvas effects for mobile voice-first mode
static/views.js        Layout management (split panes)
static/style.css       Design system (blue flavor)
tterm_tray.pyw         System tray launcher
```

### Data Flow

```
PTY Daemon (port 5041)
    ├── owns PTY processes (survives server restarts)
    ├── 64KB scrollback buffer per session
    └── TCP protocol (NDJSON: spawn/attach/write/resize/kill)

T-Term Server (port 5044, managed by PM2)
    ├── connects to daemon as TCP client
    ├── bridges WebSocket ↔ daemon PTY I/O
    ├── watches JSONL files (fs.watch, 30ms debounce)
    │       ├── WebSocket → all subscribers (desktop, mobile, iPad)
    │       └── jsonl-ready/jsonl-cleared protocol → messenger sync
    ├── /api/tts/* proxy → T-Voice :5011
    └── recoverDaemonSessions() on startup

Browser ← WebSocket ← PTY raw output (terminal view)
Browser ← WebSocket ← JSONL parsed (messenger view)
Browser ← WebSocket ← jsonl-ready (messenger knows which JSONL to load)
Browser → WebSocket → daemon PTY (user input)
Browser → /api/tts/synthesize → T-Voice → WAV audio
Browser → /api/tts/transcribe → T-Voice → Whisper STT
```

### Routing

```
Phone/Browser → Cloudflare (taybouts.com / term.taybouts.com)
             → Gateway (:5000) → T-Term (:5044)
             → Tailscale → Dev machine (100.64.0.2:5044)
```

### Design System

Part of the **T-Server** ecosystem. Shares the design language with T-Legal, T-Voice, T-Mesh, and Command Center:

| Token | Value |
|---|---|
| Accent | `#0284c7` → `#38bdf8` (blue gradient) |
| Display Font | Rajdhani |
| Mono Font | Share Tech Mono |
| Body Font | Segoe UI |
| Background | `#0a0a0f` → `#0d1117` |
| Glass | `rgba(255,255,255,0.03)` border `0.06` |

---

## Features

### Terminal
- Persistent PTY sessions — survive browser disconnect AND server restarts (via PTY daemon)
- Multi-device sync — multiple browsers on the same PTY
- Split panes — single, horizontal, vertical, triple, quad
- Tab management with color bars, mute, close
- Shell sessions (separate from Claude)
- WebGL rendering, scrollback, clipboard support

### Messenger
- JSONL-powered conversation history
- Markdown rendering (bold, italic, lists, code, tables)
- Inline image bubbles with size tracking and delete
- Dynamic typing indicator with tool badges
- Response time and token count per message
- Right-click paste, image paste (Ctrl+V)
- Flag/bookmark responses (right-click → blue triangle)
- Multi-pane layouts with labels and selection

### Mobile
- Full PWA (Add to Home Screen)
- 2-column favorites grid with large icons
- Real-time chat sync with desktop
- Photo upload (camera roll or camera)
- Voice input via Whisper STT
- Thinking indicator + tool badges
- TTY toggle for terminal view
- Safe area support (Dynamic Island, home indicator)

### Project Management
- Auto-discover projects with LIVE/GIT/CLAUDE badges
- Favorites system (server-side, syncs across devices)
- Per-project SVG icons and color gradients
- Hero page with favorites grid and status line
- Dashboard with search, category filters, project cards

---

## Server-Side Storage

| File | Purpose |
|---|---|
| `favorites.json` | Project favorites |
| `.tterm_media.json` | Per-project image references |
| `.tterm_stars.json` | Flagged/bookmarked messages |
| `.tterm_notes.json` | Per-project or global notes |
| `.tterm_session_stars.json` | Favorited JSONL sessions |
| `.tterm_users.json` | Registered users with roles |
| `.tterm_passkeys.json` | WebAuthn credentials |
| `.tterm_whitelist.json` | Trusted device tokens |
| `.tterm_sessions.json` | Persistent active sessions |
| `.tterm_audit.json` | Auth event log |
| `.tterm_invites.json` | Invite tokens (pending/used/revoked/expired) |
| `.tterm_project_settings.json` | Per-project icon + color settings |

---

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/projects` | GET | List projects with metadata |
| `/api/sessions` | GET | List JSONL conversation sessions |
| `/api/conversation` | GET | Chat history from JSONL (last 200) |
| `/api/favorites` | GET/POST | Server-side favorites |
| `/api/chat-media` | GET/POST/DELETE | Image persistence |
| `/api/stars` | GET/POST | Star/flag messages |
| `/api/kill` | POST | Kill PTY for a project |
| `/api/new-project` | POST | Create project folder |
| `/api/load-session` | GET | Switch active JSONL for a session |
| `/api/session` | DELETE | Delete a JSONL session file |
| `/api/session-star` | POST | Favorite/unfavorite sessions |
| `/api/notes` | GET/POST | Per-project or global notes |
| `/api/project-settings` | GET/POST | Per-project icon + color customization |
| `/api/connection-info` | GET | Server-side route detection (CF/LAN/Tailscale) |
| `/api/mute` | POST | (Legacy) Mute TTS — now browser-side only |
| `/api/stats` | GET | Token/context stats for a session |
| `/api/tts/*` | * | Proxy to T-Voice :5011 (synthesize, transcribe, etc.) |
| `/upload` | POST | File/screenshot/photo upload |
| `/admin` | GET | Admin panel |
| `/admin/devices` | GET | Registered passkeys + user info |
| `/admin/users` | GET | Registered users |
| `/admin/whitelist` | GET | Trusted devices |
| `/admin/audit` | GET | Auth event log |
| `/auth/sessions-list` | GET | Active sessions JSON |
| `/auth/kill-session` | POST | Revoke a session |
| `/auth/passkey-options` | POST | Direct passkey auth challenge |
| `/auth/passkey-verify` | POST | Direct passkey auth verify |
| `/invite` | GET | Invite registration page (token required) |
| `/admin/invite-create` | POST | Generate invite link |
| `/admin/invites` | GET | List all invites |
| `/admin/invite-revoke` | POST | Revoke a pending invite |
| `/api/daemon` | GET | Daemon status + active PTY sessions |
| `/api/new-session` | POST | Send /clear to PTY, reset JSONL watcher |
| `/ws` | WebSocket | PTY + JSONL stream (via daemon) |

---

## Setup

### Requirements
- Node.js 18+
- Windows (ConPTY)
- Claude Code CLI

### Install
```bash
npm install
```

### SSL Certificates
```bash
openssl req -x509 -newkey rsa:2048 -keyout .tayterm_key.pem -out .tayterm_cert.pem -days 365 -nodes -subj "/CN=localhost"
```

### Run
```bash
# Quick start (tray app)
pythonw tterm_tray.pyw

# Or direct — server auto-starts the PTY daemon
node server.js --port 5044

# Via PM2 (recommended — auto-restart on crash)
pm2 start server.js --name t-term -- --port 5044

# Daemon only (runs independently from T-Admin/T-Daemon/)
node T-Admin/T-Daemon/pty-daemon.js

# Attach any terminal to a daemon PTY
node pty-client.js list
node pty-client.js attach T-Term:claude
```

Open `https://localhost:5044`

---

Built with the **T-Server Design System** · Powered by **Claude Code**
