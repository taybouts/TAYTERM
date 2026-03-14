# TAYTERM Patch Notes

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
