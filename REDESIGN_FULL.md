# TayTerm — Full Redesign Specification

**Read `AGENT_INSTRUCTIONS.md` FIRST — it has the rules, the design system, and what to delete/keep.**

**Read the prototype:** `static/index-redesign.html` — this is the VISUAL TARGET for every page.

**Read the design system:** `C:/Users/taybo/Dropbox/CODEAI/Command Center/design-system.html`

**Load `/frontend-design` plugin before starting.**

---

## PAGE 1: Hero (Home) + Page Navigation

The landing page. Full viewport, centered content, no header clutter.

### Clock (fixed top-right)
```
Position: fixed, top:20px, right:28px
Time: HH:MM:SS — Share Tech Mono, 24px, text color, opacity 0.6, letter-spacing 3px
Date: "Fri 20 Mar 2026" — Share Tech Mono, 9px, text2 color, letter-spacing 3px, uppercase
Updates every 1 second.
```

### Title
```
"TAYTERM" — Rajdhani 56px bold, uppercase, letter-spacing 12px
Gradient: linear-gradient(135deg, var(--cyan) 0%, var(--indigo) 50%, var(--purple) 100%)
Background-clip text (transparent fill)
Animation: fade in + letter-spacing 20px → 12px over 1s
```

### Subtitle
```
"TERMINAL" — Share Tech Mono 11px, letter-spacing 6px, uppercase, text2 color
Margin-bottom: 50px
Animation: fade in 1s, 0.2s delay
```

### Favorites Grid
```
Layout: CSS grid, auto-fit columns 120-140px, centered, gap 18px, max-width 720px
Animation: fade + translateY 12px → 0, 0.8s ease, 0.4s delay
Empty state: "Right-click any app below to add favorites" (mono 11px, text2, opacity 0.4)
```

Each favorite card:
```
Background: var(--glass-bg)
Border: 1px solid var(--glass-border), radius 12px
Padding: 18px 12px 14px
Backdrop-filter: blur(10px)
Hover: translateY(-4px), accent-border, box-shadow with per-app --glow color

Icon: 48px × 48px, border-radius 12px, gradient background using app color
  Status dot: 9px circle, absolute bottom-right, border 2px solid bg-deep
    Online (live): emerald + glow
    Offline: text3 color

Label: Rajdhani 12px bold, letter-spacing 1px, centered

Action buttons at bottom:
  Two buttons: "New" and "Shell"
  Style: mono 8px, uppercase, letter-spacing 0.5px
  Glass border, 4px radius, flex:1
  Shell button: cyan tint
```

### Status Line
```
Below favorites, flex row, gap 28px
Each item: dot (5px) + label (mono 10px, text2, letter-spacing 1.5px, uppercase)
Show: "X Live" (emerald dot) · "X Projects" (accent dot) · "X Favorites" (amber dot)
Animation: fade in 1s, 0.6s delay
```

### "All Projects" Button
```
Below status line, margin-top 30px
Mono 10px, letter-spacing 1px
Glass border, 8px radius, padding 8px 18px
Icon: list SVG (12px) + text
Hover: accent-border, text2 color
```

### HUD Corners
```
4 fixed corner elements (top-left, top-right, bottom-left, bottom-right)
Each: 28px × 28px, z-index 2, opacity 0.15
Two lines: 18px × 1px and 1px × 18px, color var(--cyan)
```

### Grid Overlay (body::before)
```
Fixed, inset 0
Grid lines: rgba(56,189,248,0.03) 1px, background-size 60px
Pointer-events: none, z-index 0
```

### Scan Line (body::after)
```
Fixed, 2px height, left 0, right 0
Gradient: transparent → rgba(56,189,248,0.06) → transparent
Animation: scan 8s linear infinite (top -2px → 100%)
```

### Page Navigation (fixed bottom center)
```
Position: fixed, bottom 18px, centered
Background: rgba(10,10,15,0.6), backdrop-filter blur(12px)
Border: 1px glass-border, radius 20px, padding 8px 16px
Contains: prev arrow, 2 dots, label, next arrow

Dots: 8px circles, text2 color, opacity 0.3
Active dot: var(--cyan), opacity 1, width 24px, radius 4px, glow
Label: mono 9px, text2, letter-spacing 1px, uppercase, min-width 80px

Arrows: SVG chevrons, text2 color, hover → text color
Disabled: opacity 0.2

Keyboard: left/right arrow keys switch pages
Touch: swipe left/right on mobile/iPad (60px threshold)
```

---

## PAGE 2: Dashboard

Full viewport, scrollable. Header + categorized project grid.

### Header
```
Position: sticky top or fixed
Flex row, align-items center
Padding: 12px 28px
Border-bottom: 1px glass-border
Background: rgba(10,10,15,0.5), backdrop-filter blur(12px)
```

**Left — Logo:**
```
Terminal SVG icon (accent color) + "TayTerm" (Rajdhani 16px bold) + "Terminal" (mono 9px, text3)
```

**Center — Search:**
```
Glass input, mono 12px, search icon (14px, text3, absolute left 10px)
Ctrl+K shortcut badge (mono 9px, glass border, absolute right 10px)
Placeholder: "Search projects..."
Focus: accent-border
Max-width: 360px, flex: 0 1 360px
```

**Right — Controls:**
```
Theme swatches: 5 dots (14px, border-radius 50%, 1px border)
  Active: ring with accent-border
"New Project" button: mono 10px, glass border, accent color, + icon
Settings gear: glass button, gear SVG
Back-to-hero button: grid SVG icon, glass button
```

### Category Filter Pills
```
Below header, padding 12px 28px
Flex row, gap 6px
Each pill: mono 10px, padding 5px 14px, radius 14px
  Glass border, text3 color
  Active: accent background (8%), accent border, accent color
  Hover: text2 color
Options: All, Active, Development, Other
```

### Project Cards Grid
```
Responsive grid: auto-fill, min 220px columns, gap 14px
Padding: 0 28px 80px
```

**Category Labels:**
```
Mono 10px, letter-spacing 4px, uppercase, text2 color
Margin-bottom 12px
::after pseudo — flex:1, 1px line, gradient to transparent
```

**Each Project Card:**
```
Glass card: glass-bg, glass-border, radius 12px, padding 16px
Min-height: 160px
Position: relative (for star)
Hover: translateY(-2px), accent-border, box-shadow
Live cards: emerald border (0.3 opacity), emerald glow (0.08)

Structure:
  ┌─────────────────────────────────────────┐
  │ [★ star top-right if favorited]          │
  │ [48px icon] Name                         │
  │             GIT · CLAUDE · 2 connected   │
  │                                          │
  │ Description text (11px, 2-line clamp)    │
  │                                          │
  │ ──────────────────────────────────────── │
  │ [New]     [Shell]     [Kill if live]     │
  └─────────────────────────────────────────┘

Star: absolute top:8px right:10px, 12px, amber, opacity 0.7
Icon: 32px × 32px, radius 10px, gradient with app color
  Conversation dot: 8px, accent color, absolute bottom-right
Name: Rajdhani 14px bold
Badges: mono 9px, glass pills
Description: body font 11px, text2, 2-line clamp
Action row: border-top 1px glass-border, padding-top 8px
  Buttons: flex:1, mono 10px, glass border, centered text
  Shell: cyan tint
  Kill: red tint (only for live)

Right-click: toggle favorite
Animation: staggered cardIn (translateY 10px → 0, 0.3s, delay per card)
```

---

## PAGE 3: Terminal View — Top Bar

### Top Bar
```
Height: 40px
Background: var(--glass-bg)
Border-bottom: 1px solid var(--glass-border)
Display: flex, align-items stretch
```

**Back Button:**
```
Width: 40px, centered arrow-left SVG (14px)
Glass background, hover accent-border
Onclick: return to picker, show page-nav
```

**Tab Strip:**
```
Flex: 1, overflow-x auto, scrollbar hidden
Display: flex, align-items stretch
```

**Each Tab:**
```
Width: 200px, min-width: 200px (FIXED, not dynamic)
Height: 40px
Border-bottom: 2px solid transparent
Active: accent bottom border, subtle tinted background

Inner layout:
  Color bar: 3px wide, full height, left edge, app color
  Tab name: mono 11px, text2 (active: text), centered (text-align center, flex:1)
  Mute button: 18px, absolute right:28px, opacity 0 → 1 on hover
  Close button: 18px, absolute right:8px, opacity 0 → 1 on hover, red on hover

Shell tabs: cyan color bar, "SH" badge (mono 8px, cyan glass pill)
"+" button at end: 32px, text3, hover accent
```

**Right Toolbar:**
```
Display: flex, align-items center, gap 2px, padding-right 8px
```

**View Toggle (Terminal | Messenger):**
```
Two buttons side by side
Mono 10px, padding 4px 10px, radius 6px
Glass border, text3 color
Active: accent tinted background, accent border, accent color
```

**Separator:** 1px vertical line, glass-border color, height 18px, margin 0 6px

**Layout Buttons (5 individual icons):**
```
Each: 28px × 28px, radius 6px
Glass border, text3 color
Active: accent-border, accent color, tinted background
SVG icons showing the layout pattern (14px)

Layouts:
  1. Single: one rectangle
  2. Hsplit: two rectangles side by side
  3. Vsplit: two rectangles stacked
  4. Triple: one left + two right stacked
  5. Quad: 2×2 grid

These are INDIVIDUAL BUTTONS, not a dropdown. Direct access, one click.
```

**Separator**

**Screenshot Button:**
```
28px × 28px, camera SVG, glass border
```

**Fullscreen Button:**
```
28px × 28px, expand SVG, glass border
```

---

## PAGE 4: Terminal View — Pane Area

### Terminal Panes
```
Background: rgba(0,0,0,0.4)
Border: 1px solid transparent
Active pane: border rgba(56,189,248,0.15)
Split gap: 2px between panes

Content: xterm.js renders here — DO NOT STYLE the terminal content
The terminal JS handles font (Fira Code), colors (VGA palette), size, cursor, etc.
```

### Split Layouts
```
Single: 1 pane, flex:1
Hsplit: 2 panes, flex-direction row, each flex:1
Vsplit: 2 panes, flex-direction column, each flex:1
Triple: flex-direction row, left pane flex:1, right column (flex:1, column, 2 panes)
Quad: flex-direction column, 2 rows, each row has 2 panes
```

---

## PAGE 5: Messenger View

Replaces terminal panes when "Messenger" is toggled. Same split layouts apply.

### Chat Messages Area
```
Flex: 1, overflow-y auto, padding 16px
Display: flex, flex-direction column, gap 12px
```

**User Message:**
```
Align-self: flex-end, max-width 78%
Bubble: linear-gradient(135deg, var(--accent), var(--accent2))
  Color: white, radius 14px, bottom-right radius 4px
  Padding: 12px 16px, font-family body, font-size 13px, line-height 1.7
Metadata below: timestamp (mono 9px, text3, right-aligned)
```

**Assistant Message:**
```
Align-self: flex-start, max-width 78%
Bubble: var(--glass-bg), 1px glass-border
  Color: text, radius 14px, bottom-left radius 4px
  Same padding/font as user
Metadata below: "14:23 · 3.2s · 1.2K tokens" (mono 9px, text3)
Action buttons: Copy, Read (mono 9px, glass border, radius 4px)
  Read playing state: emerald border + color, text "Reading..."
```

**Severity Badges (inline in assistant messages):**
```
Mono 9px bold, radius 4px, padding 2px 7px
RED FLAG: red bg (0.12), red text (#f87171), red border
HIGH RISK: amber
MEDIUM: amber/yellow
LOW: green
RECOMMENDATION: accent blue
NOTE: grey
```

**Typing Indicator:**
```
Glass bubble, radius 14px, bottom-left radius 4px
3 dots: 7px circles, text3 color
Animation: tdot 1.2s infinite
  Scale 0.7 → 1, opacity 0.3 → 1
  Staggered: 0s, 0.2s, 0.4s delay
```

### Voice Player Bar
```
Display: none by default, flex when active
Padding: 6px 16px, border-top 1px glass-border
Background: rgba(10,10,15,0.4)

Buttons: 26px × 26px, radius 5px, glass border, SVG 12px
  Pause/Play, Stop (red hover)
Separator: 1px × 16px, glass-border
Time: mono 10px, text3, min-width 36px, centered
Timeline: flex:1, 4px height, glass background, radius 2px
  Fill: accent color
  Dot: 10px circle, accent, border 2px bg-mid, absolute, glow
Speed: mono 9px, accent, bold
```

### Chat Input Area
```
Padding: 10px 16px 12px
Border-top: 1px glass-border
Background: rgba(10,10,15,0.3)
```

**Input Row:** flex, align-items flex-end, gap 8px

**Mic Button:**
```
40px × 40px, radius 10px
Glass border, glass-bg, text3 color
Hover: accent-border, accent color
Recording: red background (#dc2626), white, pulse animation
SVG: microphone icon, 16px
```

**Textarea:**
```
Flex: 1, glass-bg, glass-border, radius 10px
Padding: 10px 14px, body font 13px, text color
Min-height: 40px, max-height: 120px, resize none
Focus: accent-border
```

**Send Button:**
```
40px × 40px, radius 10px
Gradient: accent → accent2, white color
Hover: scale 1.05, glow shadow
SVG: paper plane, 16px
```

---

## PAGE 6: Modals

### Confirm Modal (Kill session, etc.)
```
Fixed overlay: inset 0, rgba(0,0,0,0.65), backdrop-filter blur(6px)
Centered box: glass-bg mid, glass-border, radius 16px, max-width 400px
Header: Rajdhani 16px bold
Body: body font 13px, text2
Footer: flex, gap 8px, justify-content flex-end
  Cancel: glass button (mono, text2)
  Confirm: gradient button (accent) or danger button (red) depending on action
Animation: scale 0.96 → 1, translateY 8px → 0, opacity 0 → 1
```

### Resume Session Modal
```
Same overlay styling
List of past sessions, each as a glass card:
  Session ID, date, time, preview text
  Click to resume
Close button: top-right, glass, X icon
```

### New Project Modal
```
Glass input for project name
Validation feedback
Create + Cancel buttons
```

---

## PAGE 7: Mobile Chat View (iOS/iPad)

### Header
```
Back button + project name + CHAT/TTY toggle + MUTE button
Same glass styling, safe-area-inset-top padding
```

### Messages
Same as desktop messenger but:
- Full width (no max-width constraint)
- Tappable code blocks (expand/collapse)
- Tool use indicators

### Input Bar
```
Safe-area-inset-bottom padding
Mic button (Web Speech API) + auto-grow textarea + send button
Same glass styling as desktop
```

### Mobile Terminal (TTY mode)
```
xterm.js without WebGL
Touch scroll with momentum
Pinch-to-zoom (font size 6-24px)
```

---

## WHAT TO DELETE (comprehensive list)

1. All CSS referencing: `--green`, `#00ff41`, `--green-dim`, `--green-dark`, `--green-glow`
2. `<canvas id="matrix-bg">` and ALL matrix rain JS
3. `#settings-panel` — the entire panel HTML + CSS + JS
4. Matrix color preset buttons
5. Scanline CSS (repeating-linear-gradient 2px dark overlay)
6. Text-shadow glow effects (`text-shadow: 0 0 20px rgba(0,255,65,...)`)
7. `matrix-bg` CSS and positioning
8. Any `var(--green*)` references in hover states, borders, etc.
9. The settings gear that opens the Matrix panel (replace with design system settings if needed)
10. Canvas animation interval/requestAnimationFrame for rain

## REFERENCE: Key IDs the JS Uses

These IDs MUST exist in the new HTML (the JS references them):

**Picker:**
- `picker` or equivalent container for project grid
- Project card elements with click handlers

**Terminal:**
- `terminal-view` — main terminal container
- `top-bar` — top bar
- `pane-area` — pane container
- Tab elements with session management

**Mobile:**
- `mobile-chat` — mobile chat container
- Message elements, input elements

**Modals:**
- `confirm-modal`
- `resume-modal`
- `snip-overlay`

**Search for all `getElementById` and `querySelector` calls in app.js to find every ID/selector the JS expects.** If any are missing from the prototype, add them.

---

## ORDER OF OPERATIONS

1. Replace `style.css` with the prototype's CSS (delete ALL old Matrix CSS)
2. Replace `index.html` structure with the prototype layout
3. Wire JS hooks (IDs, onclick handlers)
4. Test each page works
5. Test theme switching
6. Test tab management
7. Test split panes
8. Test mobile view
9. Clean up any remaining old references

**One commit per page. Test after each commit. If anything breaks, fix before moving on.**
