# T-Term Patch Notes

## v3.0.0 — Browser Voice Player, Whisper STT, Ink Voice UI & Performance
_Released: 2026-03-26_

### New Features
- **Browser Voice Player** — sentence-by-sentence TTS using Kokoro `/synthesize` endpoint. Plays WAV audio via `<audio>` element (desktop, works in background tabs) or AudioContext (iOS, pre-unlocked on first touch). Sentence highlighting with cumulative offset tracking, controller bar (prev/pause/next/stop/timeline/counter), click-to-jump in bubble text, auto-play on new assistant messages with message queue system.
- **Whisper STT** — replaced browser SpeechRecognition on all devices (desktop, iPad, iPhone) with Whisper via NaturalVoice `/transcribe`. MediaRecorder captures webm, sends through `/api/tts` proxy.
- **Push-to-Talk (desktop)** — hold Ctrl+Shift to record, release to auto-send. Works regardless of which key is pressed first. Locks to the active tab's textarea at record start (survives tab switching while recording).
- **Alt key controls** — Alt while recording cancels (discards audio). Alt while voice playing stops TTS. Alt clears the message queue.
- **Arrow key navigation** — Left/Right skip sentences while voice player is active. Space pauses/resumes. Only when not typing in a textarea.
- **Ink Voice UI** — full-screen canvas-based voice interface for mobile. 4 switchable visual effects (ink, fluid, aurora, membrane). Tap anywhere to start/stop recording. Ambient particles when idle, cyan particles when AI speaks, amber particles when user records. OLED-friendly 0.08 alpha fade. Effect cycle button at bottom, CHAT button to toggle back to messenger.
- **`/api/tts/*` proxy** — T-Term server proxies all TTS/STT requests to NaturalVoice on port 7123. Buffers request body, forwards with Content-Length. Handles both JSON (synthesize) and multipart FormData (transcribe). Eliminates mixed-content and CORS issues.
- **Mobile auto-play TTS** — new assistant messages on iPhone auto-play with highlights via voice player.
- **Mobile send while recording** — tap send during recording: stops, transcribes, auto-sends immediately.
- **Mobile mic cancel** — tap mic button again while recording to discard audio.
- **50-message DOM limit** — desktop and mobile load only last 50 messages, with "Load X older messages" button. All messages stored in memory for search/stars.

### Improvements
- **Browser-side mute** — mute toggle no longer calls server `/api/mute` or NaturalVoice. Pure client-side `sessions[id].muted` flag. Stops voice player on mute.
- **NaturalVoice muted for all projects** — all projects muted for speaker output. Each browser app owns its own audio playback.
- **iPad send button fix** — was referencing deleted `ipadIsRecording` variable, replaced with shared `_sttRecording`.
- **iPad voice input** — replaced browser SpeechRecognition with shared Whisper STT (`_sttToggle`).
- **TTY view re-fit** — stores fitAddon reference, re-fits terminal on view toggle (was blank before).
- **Viewport zoom lock** — `maximum-scale=1, user-scalable=no` for iOS PWA.

### Performance
- **`saveState()` debounced** — 500ms debounce instead of synchronous on every action (was called 7+ times per interaction).
- **`renderTabs()` diff-in-place** — updates existing tab DOM elements instead of clearing and rebuilding. Debounced via `requestAnimationFrame`.
- **`showMessengerTyping()` cached** — skips DOM update if phase/tools/tokens unchanged. Uses cached pane references.
- **DocumentFragment batch append** — history loads use fragment instead of individual appendChild calls.
- **`/api/conversation` tail-read** — reads only last 256KB of JSONL file instead of full file.
- **`renderMarkdown()` optimized** — single-pass HTML escape, combined header regex (4→1), still has 11 br-cleanup passes (lookbehind not Safari-compatible).
- **JSONL watcher 30ms debounce** — batches rapid file change events instead of firing on every line.

### Architecture
- `static/ink.js` — new file, 4 canvas-based visual effects with particle system
- `static/messenger.js` — voice player (`_vp*`), STT (`_stt*`), push-to-talk (`_ptt*`), message queue (`_vpQueue`)
- `routes/api.js` — `/api/tts/*` proxy route with body buffering
- `TTS_BASE` — always proxied through server (`window.location.origin + '/api/tts'`), no more direct `:7123` access
- iOS audio: AudioContext pre-unlocked on touch/click events, reused across sentences
- Desktop audio: `<audio>` element (persistent, hidden), plays in background tabs
- Voice player generation counter prevents stale playback chains
- `docs/voice-player-reference.md` — full implementation reference for cross-app sharing

### Known Issues
- **Legal double voice** — Legal tab in T-Term plays audio twice. Muting Legal's T-Term tab doesn't stop it. Only muting Chrome browser tab stops it. Under investigation.
- **Highlight consistency** — cumulative offset approach works well but occasionally skips on complex markdown.
- **Double paste on Ctrl+V** — reported on desktop, not investigated.

---

## v2.0.0 — Code Split, Auth Overhaul, Multi-Device, iPad Support
_Released: 2026-03-25_

### New Features
- **Code split** — server.js 1730→345, auth.js 2976→1389, app.js 3748→1636. New files: messenger.js, views.js, mobile.js, ipad.js, lib/daemon-client.js, lib/jsonl-reader.js, lib/tts-tap.js, lib/utils.js, routes/api.js, routes/static.js, routes/ws.js, templates/*.js
- **Auth overhaul** — removed subnet bypass, removed whitelist auto-trust, passkey-only. Localhost bypass kept.
- **Multi-device auth** — iPhone + iPad registered via invite flow
- **Multi-device reattach** — openSession checks daemon for live PTY, no more killing active sessions
- **Multi-device broadcast** — user input sent to all subscribers, all devices see messages immediately
- **iPad support** — ipad.js with PWA safe areas, photo picker, voice input (mic), visibilitychange reconnect, connection badge
- **JSONL watcher overhaul** — dir watcher for both new files AND modifications, no polling
- **Prompt notification** — "Waiting for your input" badge on > prompt
- **Messenger improvements** — copy button, speaker fix, mute cancels speech, history preserved on tab close, screenshot paste
- **New session options** — "Clear & New" vs "Keep History"
- **Rich audit logging** — who/device/project on connect/reattach/disconnect

### Architecture
- Modular file structure: server.js is thin orchestrator, logic in lib/ and routes/
- Templates in templates/ (admin, login, register, invite pages)
- Device detection: isIOS, isIPad, isMobile, connIsLocal/Tailscale/Cloudflare
- Three client targets: app.js (desktop), mobile.js (iPhone), ipad.js (iPad)

---

## v1.0.0 — PTY Daemon, Session Persistence & Email Invites
_Released: 2026-03-24_

### New Features
- **PTY Daemon** (`pty-daemon.js`) — standalone background process that owns all PTY instances. Terminal sessions survive T-Term server restarts. TCP protocol on port 7779 (NDJSON: spawn, attach, detach, write, resize, kill, list).
- **Daemon Dashboard** — glass-themed web UI at `http://127.0.0.1:7780` showing active PTY sessions, live daemon log, peek into terminal scrollback, kill buttons.
- **PTY Client CLI** (`pty-client.js`) — attach any terminal to a daemon-managed PTY: `node pty-client.js attach TAYTERM:claude`. Also: list, spawn, kill.
- **Server Restart Recovery** — `recoverDaemonSessions()` discovers live PTYs from daemon on server startup, rebuilds `activeTerminals`, reattaches JSONL watchers. Zero downtime.
- **Browser Auto-Reconnect** — `ws.onclose` automatically reconnects with `continue=1`. Named function handlers (`handleWsMessage`, `handleWsClose`) survive WebSocket replacement.
- **Email Invites via Resend** — invite emails sent from `register@taybouts.com` with branded HTML template (glass design, T-TERM logo, blue CTA button). Auto-sends on invite creation.
- **Notes Expand & Copy** — click note text to expand/collapse (was 3-line clamped), copy button on hover (bottom-right).
- **Markdown Headers & Links** — h1-h4 rendering, markdown link support `[text](url)`, bare URL detection, localhost URL rewriting for mobile access.
- **Read-Aloud Button** — hover on assistant bubbles shows speaker icon, click to send text to TTS server.
- **Tab Menu: Close & Kill** — "Close & Kill" (red) terminates PTY via daemon. Close tab (X button) just detaches. "New Session" sends /clear.
- **Empty Enter sends \r** — pressing Enter in messenger with empty text submits whatever is in the terminal input line (for confirming screenshots, plans, etc.)

### Architecture
- **Three-process model**: PTY Daemon (port 7779) → T-Term Server (port 7778) → Browser Client. Server is now a viewer/bridge — no direct `node-pty` usage.
- **`server.js`**: Removed `require('node-pty')`. Added `DaemonClient` (TCP connection, NDJSON parsing, event routing). All `entry.pty.*` calls replaced with `daemonWrite/daemonResize/daemonKill`. `entry.alive` boolean replaces `entry.pty` truthiness. `ensureDaemon()` auto-starts daemon. `recoverDaemonSessions()` rebuilds state on startup.
- **`pty-daemon.js`**: TCP server (`net.createServer`), session map (sessionKey → pty + subscribers + scrollback), HTTP dashboard server. 64KB scrollback ring buffer per session. Graceful shutdown kills all PTYs.
- **JSONL Watcher overhaul**: Replaced 1-second polling interval with `fs.watch` on convDir (directory watcher). Snapshot-based: captures existing files at PTY start, only attaches to files not in snapshot. `attachLatest` for continue/resume. Removed `ignoreJsonlPath` mechanism entirely.
- **Zombie watcher fix**: `handleApiKill` now calls `entry._onPtyExit()` before deleting entry — closes JSONL file watcher and directory watcher. Prevents old watchers from interfering with new sessions.
- **Dir watcher switch**: Removed `if (jsonlPath) return;` guard so watcher switches to new JSONL files even when already attached (handles `--continue` creating new JSONL).
- **`auth.js`**: Resend integration (HTTPS POST to api.resend.com), `sendInviteEmail()`, `inviteEmailHtml()` template. Invite links always use `term.taybouts.com`. `isLocalRequest` expanded to include 192.168.x.x.

### Improvements
- **Image scroll-lock respect** — image load no longer forces scroll to bottom if user scrolled up
- **Typing indicator scroll-lock** — respects scroll position when updating thinking status
- **Invite link always public** — links always use `term.taybouts.com` regardless of where admin accesses from

---

## v0.6.0 — Auth Hardening, Invite System & Media Sessions
_Released: 2026-03-24_

### New Features
- **Invite link system** — admin generates one-time invite tokens from `/admin` Invites tab, sends link to user, user registers passkey via the link, token consumed after use
- **Admin Invites tab** — generate links, copy to clipboard, view pending/used/expired/revoked invites, revoke pending invites
- **Invite registration page** — dedicated onboarding page with email pre-filled, passkey enrollment, backup codes
- **Expired invite page** — clean error page for expired or used invite links
- **Media session tagging** — images tagged with JSONL session ID on save, filtered by current session on load
- **Send screenshots without text** — Enter or Send button works with just a pending screenshot attachment (no text required)

### Security
- **Fail-closed auth** — `!hasPasskeys()` and `!simplewebauthn` now return `false` (block everyone), not `true` (open access)
- **Localhost always trusted** — `isLocalRequest()` added to `isAuthenticated()` so TAYCAST always gets in
- **Registration locked** — `/register` only accessible from localhost, authenticated admin, or valid invite token
- **No open registration** — strangers cannot visit `/register` from the internet
- **Invite tokens** — 256-bit crypto random hex, 24h expiry, single-use, revocable
- **All invite actions audited** — create, use, revoke logged to audit trail

### Improvements
- **Messenger send with attachments** — both split view and messenger-only sendMsg functions handle pending attachments without requiring text
- **`_switchJsonl` interval cleanup** — clears and restarts the polling interval on session switch (was leaking intervals before)

### Architecture
- `auth.js` — invite storage (`loadInvites`, `saveInvites`, `validateInviteToken`, `consumeInvite`, `isInviteAuthorized`), `isLocalRequest()` helper, `canRegister()` guard function, admin invite API endpoints, invite + expired HTML pages
- `server.js` — `/invite` added to `authPaths`, media session tagging on POST/GET `/api/chat-media`
- `static/app.js` — `sendMsg` handles `pendingAttachments` when text is empty
- `.tterm_invites.json` — invite token storage (id, email, token, createdAt, expiresAt, status, usedAt, usedBy)
- `static/preview-auth.html` — auth page design preview (login, invite, expired)

---

## v0.5.0 — Session Browser, Auth System & Mobile PWA
_Released: 2026-03-23_

### New Features
- **Authentication system** — WebAuthn/Passkeys with QR login, Face ID, device whitelist, backup codes
- **Admin panel** (`/admin`) — Sessions, Devices, Trusted, Audit Log tabs
- **Mobile PWA** — edge-to-edge iPhone 17 Pro Max support, photo picker, voice input, real-time sync
- **Side tray** — hover-triggered panel with Flags, Search, Gallery, Sessions, Notes
- **Session browser** — browse all JSONL sessions per project, click to preview, resume/delete/favorite
- **Notes panel** — per-project or general notes, stored server-side
- **Drag and drop tabs** — reorder tabs by dragging, order persisted to localStorage
- **Custom glass modals** — frosted glass confirmation dialogs replacing browser popups
- **Scroll lock-to-bottom** — follows chat when at bottom, preserves position when scrolled up
- **Stats bar** — context usage, tokens, images, model info with pull-up panel
- **Screenshot & image system** — paste, drag & drop, camera roll, inline bubbles with delete
- **Split view** — messenger + terminal side by side
- **Multi-pane layouts** — single, hsplit, vsplit, triple, quad

### Improvements
- **DOM cache invalidation** — stale panes detected by message count, rebuilt fresh (no inline innerHTML hacks)
- **Scroll position** — saved per-session in JS object, restored via requestAnimationFrame
- **JSONL watcher locked** — no more file switching (prevents cross-contamination from other Claude processes in same project dir)
- **Session resume watcher** — `_switchJsonl()` updates live watcher when resuming a different session
- **TTS mute simplified** — mute only in `ttsTap.muted`, no TTS server sync (no stale mute across restarts)
- **TTS claims on demand** — only claims when feedClean fires, not at session creation (prevents over-claiming)
- **feedClean improved** — resets dedup per message, sends whole lines instead of splitting on punctuation
- **Voice selection** — right-click tab menu, project names dash-formatted for TTS server
- **Side tray refreshes on tab switch** — shows data for the active session
- **Sessions panel cached** — first load fetches from server, subsequent opens reattach cached DOM
- **Token count per session** — total tokens displayed on session cards
- **`fromAgent` flag** — post-agent summary messages tagged for optional filtering
- **"No response requested"** — filtered from assistant messages

### Architecture
- `auth.js` — full auth module: QR, passkeys, admin, whitelist, audit log, session persistence
- `/api/load-session` — switch which JSONL the active session reads from (history + watcher)
- `/api/session` DELETE — delete JSONL files (blocked for active session)
- `/api/session-star` POST — favorite/unfavorite sessions
- `/api/notes` GET/POST — per-project or global notes
- `/api/mute` POST — sets `ttsTap.muted` only (removed TTS server sync)
- `entry.jsonlPath` — stored on session entry, used by both history API and live watcher
- `entry._switchJsonl()` — exposed for session resume
- `savedScrollPositions` / `scrollLockedToBottom` — per-session scroll state objects
- `showModal()` — reusable glass confirmation modal
- `tabOrder` — persistent tab ordering with drag and drop
- `window._sessionsCache` — per-project DOM cache for sessions panel
- `.tterm_session_stars.json` — per-project session favorites
- `.tterm_notes.json` — per-project or global notes storage

---

## v0.3.2 — Fira Code, VGA Colors & New Tab Button
_Released: 2026-03-15_

### New Features
- **Fira Code terminal font** — replaced Courier New with Fira Code (loaded from Google Fonts CDN), lighter weight (300) with semi-bold (500) for emphasis
- **VGA color palette** — bright, vivid ANSI colors replacing the dark Tango defaults
- **"+" tab button** — add new sessions directly from the tab strip, opens project picker
- **Smart project sorting** — LIVE projects first, then GIT repos, then projects with conversations, then alphabetical

### Improvements
- **Brighter foreground text** — `#ececec` for better readability on black background
- **Bold text emphasis** — `drawBoldTextInBrightColors` enabled with weight 500 for visible but subtle emphasis
- **Lighter base font weight** — Fira Code at 300 for clean, thin text rendering

### Architecture
- Terminal theme now uses explicit VGA color palette instead of xterm.js Tango defaults
- Project list sorted client-side with priority: live > git > conversations > alphabetical

---

## v0.3.1 — Tab & Button Polish
_Released: 2026-03-14_

### Improvements
- **Tab text no longer bold** — font-weight reduced from 600 to 400 for a cleaner look
- **Thinner active tab indicator** — border-bottom reduced from 2px to 1px
- **Wider tabs** — min-width 140px with increased padding (32px) for more spacious feel
- **Larger tab text** — font size bumped from 11px to 13px
- **Centered tab text** — tab content is now truly centered with close button as an absolute overlay
- **Hover-only close button** — tab close button hidden by default, appears on hover as a 22x22 boxed icon with rounded corners
- **Green close button** — hover turns the close button green (was red) to match Matrix theme
- **Larger scroll-to-bottom button** — increased from 28x28 to 35x35 with larger arrow icon (18px)

---

## v0.3.0 — Session Management & UI Overhaul
_Released: 2026-03-14_

### New Features
- **Continue session** — resume last Claude conversation with `--continue` flag; big primary button on project cards when conversations exist
- **Resume session** — visual modal listing all past sessions with date (DD-MM-YY), time, and first message preview; click to resume any session by ID via `claude --resume <id>`
- **Kill button** — kill all PTYs (Claude + Shell) for a project from the picker; closes associated tabs and WebSocket connections
- **Fullscreen mode** — toggle button in top bar next to layout controls
- **New project creation** — "+ New" button in picker header, creates project folder via API
- **Confirm modal** — styled in-app confirmation dialog for destructive actions (replaces browser `confirm()`)
- **Loading overlay** — mini Claude logos (green-recolored from PNG) with pop animation in bottom-right corner
- **Session count** — Resume button shows number of available past sessions per project

### Improvements
- **Smart card layout** — two-row button design: primary action (Continue/Claude) full-width on top, secondary actions (New, Resume, Shell, Kill) in a row below
- **Card click defaults to Continue** when conversations exist, otherwise opens new Claude session
- **LIVE badge only for Claude** — shell sessions no longer trigger LIVE status on project cards
- **Log window Matrix theme** — tray app log window restyled with Matrix design language (Consolas, green-on-black, green scrollbar)
- **Loading indicator** — bigger text (16px), larger spacing, positioned bottom-right with gap 40px
- **Claude logos 5x smaller** — mini logos rendered at 0.2x scale for subtle loading animation

### Architecture
- `CLAUDE_PROJECTS_DIR` — server checks `~/.claude/projects/` for conversation `.jsonl` files to determine continue/resume availability
- `GET /api/sessions` — new endpoint returns conversation list with date, time, preview text
- `POST /api/kill` — new endpoint kills PTYs and notifies WebSocket subscribers
- `POST /api/new-project` — new endpoint creates project folders with validation
- WebSocket accepts `?continue=1` and `?resume=<session-id>` query params
- `can_continue` and `conv_count` added to project metadata API response

---

## v0.2.0 — Tabs, Split Panes, Matrix Design, Shell Sessions
_Released: 2026-03-13_

### New Features
- Project picker with cards, badges (LIVE, GIT, CLAUDE), descriptions from README.md
- Multi-tab sessions with tab restore on refresh (localStorage)
- Split pane layouts (single/hsplit/vsplit/quad) with pane selection
- Separate shell sessions with own PTY and cyan styling
- Matrix design language: Share Tech Mono, green glow, true black, CRT scanlines
- Configurable matrix rain (opacity, speed, fade, fontSize, color presets)
- Settings gear with slide-out panel
- Image paste and drag & drop file upload
- System tray app with auto-restart and log window

---

## v0.1.0 — Foundation
_Released: 2026-03-12_

### New Features
- Web terminal server with persistent PTY sessions
- Multi-device sync via WebSocket subscriber pattern
- HTTPS with self-signed certificates
- Claude AI auto-launch on session open
- PWA meta tags for mobile devices
