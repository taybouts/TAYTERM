# T-TERM

**The AI terminal, reimagined as a messenger.**

T-Term is a self-hosted web terminal that turns Claude Code into a conversational interface. Terminal power meets messenger simplicity — chat bubbles, inline screenshots, real-time tool tracking, and persistent conversation history. Access from any browser, any device, anywhere.

---

## What makes T-Term different

### Messenger-First Design

The terminal is still there — but the messenger is the primary view. Every Claude interaction becomes a clean conversation: your messages on the right, Claude's responses on the left with full markdown rendering. Tables, code blocks, numbered lists, bold text — all beautifully formatted in glass-styled chat bubbles.

**Switch between messenger and terminal with one click.** The same PTY session powers both views. Type in the messenger, see it execute in the terminal. Switch to terminal for raw power, switch back to messenger for clarity.

### Real-Time Intelligence

Watch Claude think in real time:

- **Dynamic status** — "Thinking..." → "Reading..." → "Editing..." → "Searching..." — the phase updates live as Claude works
- **Tool chain badges** — `Read` `Grep` `Edit` `Write` — each tool appears as a badge, building up the full action chain
- **Agent tracking** — see when sub-agents launch, how many are running
- **Response metrics** — every response shows: timestamp · response time · token count
- **Context awareness** — pull-up info panel shows model, context usage (% of 1M), output tokens

### Zero-Noise TTS

Text-to-speech powered by structured JSONL data — not screen scraping. The old approach (headless xterm parsing) had 21,000+ false positives. The new approach: **zero**. Claude's actual words, nothing else. No code, no diff output, no terminal artifacts.

- Block-by-block delivery — hear each response as Claude finishes writing it
- Claim system prevents double-speech across multiple TTS consumers
- Per-tab mute, per-project voice selection via right-click menu

### Screenshots as Conversation

Paste or capture a screenshot — it appears as an inline image bubble, just like iMessage. Click to expand full-screen. Full quality stored locally, compressed version sent to Claude. Each image shows: file size · image count · total MB / 20 MB limit.

---

## Architecture

```
server.js              Node.js backend — PTY, WebSocket, JSONL watcher, TTS
auth.js                QR + Face ID authentication (WebAuthn/Passkeys)
static/index.html      Single-page app shell
static/app.js          Frontend — messenger, terminal, pane management
static/style.css       T-Server design system (blue flavor)
tayterm_node_tray.pyw   System tray launcher with log window
```

### Data Flow

```
Claude Code CLI → writes JSONL → server.js watches file
                                    ├── WebSocket → Messenger (chat bubbles)
                                    └── TTSTap → NaturalVoice TTS (speech)

Browser ← WebSocket ← PTY raw output (terminal view)
Browser ← WebSocket ← JSONL parsed (messenger view)
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

Each T-Server app has its own color flavor and SVG icon from the shared icon library.

---

## Features

### Terminal
- Persistent PTY sessions — survive browser disconnect
- Multi-device sync — multiple browsers on the same PTY
- Split panes — single, horizontal, vertical, triple, quad
- Tab management with color bars, mute, close
- Shell sessions (separate from Claude)
- WebGL rendering, scrollback, clipboard support
- Auto-fit on view switch

### Messenger
- JSONL-powered conversation history
- Markdown rendering (bold, italic, lists, code, tables)
- Inline image bubbles with size tracking
- Dynamic typing indicator with tool badges
- Response time and token count per message
- Right-click paste, image paste (Ctrl+V)
- Pull-up info panel (context, model, tokens)
- Multi-pane layouts with labels and selection

### Authentication
- QR code login — scan with phone, approve with Face ID
- WebAuthn/Passkeys via 1Password or iCloud Keychain
- Auto-approve on Tailscale (no biometrics needed on trusted network)
- Session management page — view all active sessions, revoke remotely
- Device fingerprinting — browser, OS, GPU, screen, timezone, machine name
- Backup codes for emergency access
- 24-hour session cookies

### Project Management
- Auto-discover projects with LIVE/GIT/CLAUDE badges
- Favorites system (server-side, syncs across devices)
- Per-project SVG icons and color gradients from design system
- Hero page with animated title, favorites grid, status line
- Dashboard with search, category filters, project cards

### System Tray
- Blue gradient icon matching design system
- Log window with Rajdhani/Share Tech Mono styling
- Start/Stop/Restart controls with status dot
- Starts hidden, auto-restarts server on crash

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
pythonw tayterm_node_tray.pyw

# Or direct
node server.js
```

Open `https://localhost:7778`

---

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/projects` | GET | List projects with metadata |
| `/api/sessions` | GET | List active PTY sessions |
| `/api/conversation?name=X` | GET | Chat history from JSONL (last 200) |
| `/api/favorites` | GET/POST | Server-side favorites |
| `/api/kill` | POST | Kill PTY for a project |
| `/api/new-project` | POST | Create project folder |
| `/upload` | POST | File/screenshot upload |
| `/screenshots/*` | GET | Serve uploaded screenshots |
| `/auth/sessions` | GET | Session management page |
| `/auth/sessions-list` | GET | Active sessions JSON |
| `/auth/kill-session` | POST | Revoke a session |
| `/ws` | WebSocket | PTY + JSONL stream |

---

## Roadmap

- [ ] Voice input (Web Speech API) in messenger
- [ ] Terminal input mirroring to messenger
- [ ] One-click machine provisioning (Tailscale + dependencies)
- [ ] Mobile-optimized views
- [ ] Modal redesign (confirm, resume picker, new project)

---

Built with the **T-Server Design System** · Powered by **Claude Code**
