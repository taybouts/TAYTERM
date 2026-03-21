# TayTerm Redesign — Agent Instructions

## FIRST: Load the Frontend Design Plugin

Before you do ANYTHING, invoke the `frontend-design` skill:

```
/frontend-design
```

This plugin is enabled globally. USE IT for every HTML/CSS decision.

## Your Job

You have THREE reference files:

1. **The design system** → `C:/Users/taybo/Dropbox/CODEAI/Command Center/design-system.html` — the master component library for ALL T-Server apps
2. **The prototype** → `static/index-redesign.html` — the FINISHED DESIGN for TayTerm. Every pixel is correct.
3. **The working app** → `static/index.html` + `static/app.js` + `static/style.css` — the current Matrix-themed app with all JS wired up

Your job is to make the working app LOOK like the prototype while keeping all JS functionality working.

## How To Do It

**COPY PASTE the prototype's HTML/CSS into the working app.** Don't redesign. Don't "improve". Don't write your own CSS. Copy paste.

For each section:
1. Open the prototype, find the section
2. Copy the HTML exactly
3. Paste it into the working app, replacing the old HTML
4. Add the JS hooks (IDs, onclick handlers) that the existing JS needs
5. Copy the CSS from the prototype into style.css

## Rules

- **DO NOT write your own CSS.** Copy from the prototype.
- **DO NOT use inline `style=""` attributes.** The prototype uses CSS classes. You use CSS classes.
- **DO NOT use `!important`.** If styles conflict, find and fix the conflict.
- **DO NOT modify server.js or auth.js.** Backend stays untouched.
- **DO NOT modify the xterm.js terminal rendering.** The actual terminal stays as-is.
- **KILL the Matrix theme entirely.** No green (#00ff41), no scanlines, no rain, no CRT effects. Delete ALL of it.
- **Delete the Matrix settings panel** (rain config, scanline toggle, opacity/speed/fade sliders, color presets). Gone.

## If Something Doesn't Work

**STOP AND ASK.** Tell us:
- "The prototype has element X but the JS expects ID Y — where should I put it?"
- "The JS function Z references a class that doesn't exist in the prototype — should I add it?"
- "There's a conflict between old CSS and new CSS — can I delete the old one?"

Do NOT try to solve it yourself by adding hacks. Ask first.

## Design System Overview

### Color Flavor
TayTerm uses the **blue** flavor:
- `--accent: #0284c7`
- `--accent2: #38bdf8`
- Hero title gradient: `linear-gradient(135deg, var(--cyan) 0%, var(--indigo) 50%, var(--purple) 100%)`

### Core Tokens (from prototype :root)
```
--bg-deep: #0a0a0f
--bg-mid: #0d1117
--bg-warm: #0a0f1a
--text: #e6edf3
--text2: #475569
--text3: #64748b
--glass-bg: rgba(255,255,255,0.03)
--glass-border: rgba(255,255,255,0.06)
--accent-border: rgba(56,189,248,0.3)
--emerald: #22c55e
--amber: #f59e0b
--red: #ef4444
```

### Fonts
- `--font-display: 'Rajdhani'` — headings, titles
- `--font-mono: 'Share Tech Mono'` — labels, badges, metadata, terminal mock
- `--font-body: 'Segoe UI'` — body text, chat bubbles

### 5 Themes
Midnight (default), Slate, Ivory, Warm, Ocean — all defined in the prototype CSS.

## Architecture

### Pages
1. **Hero (Home)** — full-screen landing with "TAYTERM" title, favorites grid, clock, status line
2. **Dashboard** — search, category filters, full project card grid
3. **Terminal View** — tab bar + split panes + toolbar

Pages 1 & 2 use horizontal sliding (`transform:translateX`) with bottom nav dots.
Page 3 (terminal) replaces the picker entirely.

### Hero Page (prototype lines ~895-920)
- Clock in top-right (time HH:MM:SS + date "Fri 20 Mar 2026")
- "TAYTERM" gradient title (56px Rajdhani)
- "TERMINAL" subtitle (11px mono, letter-spacing 6px)
- Favorites grid: glass cards with 48px gradient icons, status dots, labels, New/Shell buttons
- Each favorite has `--glow` CSS variable for per-app color hover glow
- "All Projects" button → switches to Dashboard
- Status line: "X Live · X Projects · X Favorites"

### Dashboard Page (prototype lines ~920-960)
- Header: logo, search bar, theme swatches, "New Project" button, settings gear, back-to-hero button
- Category filter pills: All, Active, Development, Other
- Project cards grouped by category with headers
- Each card: gradient icon, name, description, badges (GIT/CLAUDE/subs), star in top-right corner (favorites), action buttons (New/Shell/Kill for live)
- Live cards have green border glow
- Right-click card → toggle favorite

### Terminal View (prototype lines ~960-1070)
- **Top bar (40px):**
  - Back button (returns to picker)
  - Tab strip (scrollable): 200px fixed-width tabs, color bar left edge, centered name, mute/close on hover (opacity toggle, not display toggle — no layout shift)
  - View toggle: Terminal | Messenger
  - Separator
  - Layout buttons: single, hsplit, vsplit, triple, quad (individual icon buttons, NOT a dropdown)
  - Separator
  - Screenshot button
  - Fullscreen button

- **Pane area:**
  - Terminal panes: dark background, xterm.js renders here
  - Messenger panes: chat bubbles (gradient user, glass assistant), metadata, voice bar, chat input

### Messenger View (prototype lines ~1070-1120)
Same chat components as T-Legal:
- User bubble: `linear-gradient(135deg, var(--accent), var(--accent2))`, white text, bottom-right radius 4px
- Assistant bubble: `var(--glass-bg)`, glass border, bottom-left radius 4px
- Metadata: timestamp · response time · tokens (mono 9px)
- Copy + Read buttons (mono 9px, glass border)
- Read playing state: green border + "Reading..." text
- Typing indicator: 3 animated dots in glass bubble
- Voice bar: pause/stop SVG buttons, timeline with dot, speed indicator
- Chat input: mic (40px glass) + textarea (glass, flex) + send (40px gradient)

### Split Panes
Works for BOTH terminal and messenger views:
- Single: 1 full pane
- Hsplit: 2 side-by-side
- Vsplit: 2 stacked
- Triple: 1 left + 2 right stacked
- Quad: 2×2 grid

## What to DELETE from the current app

1. **ALL Matrix CSS** — every reference to `--green`, `#00ff41`, `--green-dim`, `--green-dark`, `--green-glow`, `matrix-bg`, `scanline`, `crt`
2. **Matrix canvas** — the `<canvas id="matrix-bg">` element and its JS
3. **Matrix settings panel** — the entire `#settings-panel` with scanline toggle, rain toggle, opacity/speed/fade sliders, color presets
4. **Matrix rain JS** — all functions related to the rain animation
5. **Old color scheme** — replace ALL green-based colors with design system tokens
6. **CRT effects** — scanline overlay, text-shadow glow effects

## What to KEEP (do not modify)

1. `server.js` — all backend logic
2. `auth.js` — authentication
3. xterm.js initialization and config (WebGL addon, font, colors)
4. WebSocket connection logic
5. PTY input/output handling
6. File upload / screenshot functionality
7. Tab management JS (session creation, switching, closing)
8. Split pane JS logic
9. Mobile chat view and Web Speech API
10. Voice/TTS integration (mute toggle, voice picker data)
11. Keyboard shortcuts

## Page-by-Page Approach

The redesign will be done PAGE BY PAGE. You will receive separate prompts for each page:

1. **REDESIGN_1.md** — Hero page + Dashboard page (picker views)
2. **REDESIGN_2.md** — Terminal view (top bar, tabs, toolbar)
3. **REDESIGN_3.md** — Messenger view (chat components)
4. **REDESIGN_4.md** — Modals (confirm, resume session picker, new project)
5. **REDESIGN_5.md** — Mobile views (if applicable)

**Wait for each prompt. Do NOT redesign ahead.**

## Commit Strategy

- One commit per page/section
- Test that the app loads and functions after each commit
- If something breaks, fix it before moving to the next page
- Never commit half-done work

## Port

TayTerm runs on **port 7778** (HTTPS). The prototype can be viewed at:
`https://localhost:7778/static/index-redesign.html`
