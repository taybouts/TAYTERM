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

### Zero-Noise TTS

Text-to-speech powered by structured JSONL data — not screen scraping. Claude's actual words, nothing else.

- Block-by-block delivery — hear each response as Claude writes it
- Claim system prevents double-speech across multiple consumers
- Per-tab mute, per-project voice selection via right-click menu

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

### Device Whitelist

- Trusted devices skip authentication entirely
- Persistent cookie survives server restarts
- Manage from Admin panel

### Admin Panel (`/admin`)

- **Sessions** — all active sessions with device info, kill any remotely
- **Devices** — registered passkeys with user profile (name, role, device, browser, OS, IP)
- **Trusted** — whitelist management
- **Audit Log** — all auth events: logins, failures, registrations, whitelist changes
- Sessions persist to disk — survive server restarts

---

## Architecture

```
server.js              Node.js backend — PTY, WebSocket, JSONL watcher, TTS
auth.js                Auth system — QR, passkeys, admin, whitelist, audit
static/index.html      Single-page app shell
static/app.js          Frontend — messenger, terminal, mobile, pane management
static/style.css       Design system (blue flavor)
tterm_tray.pyw         System tray launcher
```

### Data Flow

```
Claude Code CLI → writes JSONL → server.js watches file
                                    ├── WebSocket → Desktop messenger
                                    ├── WebSocket → Mobile PWA
                                    └── TTSTap → NaturalVoice TTS

Browser ← WebSocket ← PTY raw output (terminal view)
Browser ← WebSocket ← JSONL parsed (messenger view)
```

### Routing

```
Phone/Browser → Cloudflare (taybouts.com / term.taybouts.com)
             → Windows 10 server (192.168.1.102)
             → Tailscale → Dev machine (100.64.0.2:7778)
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
- Persistent PTY sessions — survive browser disconnect
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
- Voice input via native speech recognition
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
| `/api/mute` | POST | Mute/unmute TTS for a session |
| `/api/stats` | GET | Token/context stats for a session |
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
| `/ws` | WebSocket | PTY + JSONL stream |

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

# Or direct
node server.js
```

Open `https://localhost:7778`

---

Built with the **T-Server Design System** · Powered by **Claude Code**
