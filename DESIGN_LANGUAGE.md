# Matrix Terminal — Design Language

## Font
```
Google Fonts: 'Share Tech Mono'
Fallback: 'Courier New', monospace
Import: @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap');
```

## Color Palette
```css
:root {
  --green: #00ff41;                       /* Primary text, borders, accents */
  --green-dim: #00cc33;                   /* Secondary text, muted elements */
  --green-dark: #003300;                  /* Subtle borders, panel backgrounds */
  --green-glow: rgba(0, 255, 65, 0.3);   /* Glow / text-shadow */
  --red: #ff0040;                         /* Danger, kill, errors */
  --red-glow: rgba(255, 0, 64, 0.3);     /* Danger glow */
  --bg: #0a0a0a;                          /* Page background (near-black) */
}

/* Accent colors */
#88ffaa   — highlighted text (filenames, script names)
#ffaa00   — warning / medium severity
#00ccff   — info / ports / links (cyan accent)
```

## Typography Rules
- Headers/labels: `text-transform: uppercase; letter-spacing: 2-8px`
- Data/content: normal case
- All text uses the monospace font — no sans-serif anywhere

## Glow Effect
Applied via `text-shadow` on primary elements:
```css
text-shadow: 0 0 20px var(--green-glow), 0 0 40px var(--green-glow);
```
Lighter glow for secondary elements:
```css
text-shadow: 0 0 5px var(--green-glow);
```
Danger glow:
```css
text-shadow: 0 0 5px var(--red-glow);
```

## CRT Scanlines Overlay
Full-screen, non-interactive overlay:
```css
.scanlines {
  position: fixed;
  top: 0; left: 0;
  width: 100%; height: 100%;
  pointer-events: none;
  z-index: 999;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0, 0, 0, 0.08) 2px,
    rgba(0, 0, 0, 0.08) 4px
  );
}
```

## Matrix Rain Background
Canvas element behind all content:
```css
#matrix-bg {
  position: fixed;
  top: 0; left: 0;
  width: 100%; height: 100%;
  z-index: 0;
  opacity: 0.12;
}
```
Characters: `アカサタナハマヤラワ0123456789PYTHON`
Color: `#00ff41`, font: 14px monospace, falling columns, 20fps (setInterval 50ms).

JS implementation:
```js
const canvas = document.getElementById('matrix-bg');
const ctx = canvas.getContext('2d');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const chars = 'アカサタナハマヤラワ0123456789PYTHON';
const fontSize = 14;
let columns = Math.floor(canvas.width / fontSize);
let drops = Array(columns).fill(1);

function drawMatrix() {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#00ff41';
  ctx.font = fontSize + 'px monospace';
  for (let i = 0; i < drops.length; i++) {
    const char = chars[Math.floor(Math.random() * chars.length)];
    ctx.fillText(char, i * fontSize, drops[i] * fontSize);
    if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0;
    drops[i]++;
  }
}
setInterval(drawMatrix, 50);
```

## Animations

### Border Pulse (key containers)
```css
@keyframes border-pulse {
  0%, 100% { opacity: 0; }
  50% { opacity: 0.5; }
}
/* Applied via ::before pseudo-element with border: 1px solid var(--green) */
```

### Blinking Cursor (loading states)
```css
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
.loading-dot::after {
  content: '█';
  animation: blink 0.8s step-end infinite;
}
```

## Component Patterns

### Panels / Boxes
```css
border: 1px solid var(--green-dark);
background: rgba(0, 255, 65, 0.02);
```

### Buttons (normal)
```css
.btn {
  padding: 8px 16px;
  border: 1px solid var(--green-dim);
  background: transparent;
  color: var(--green);
  font-family: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  letter-spacing: 1px;
  text-transform: uppercase;
  transition: all 0.2s;
}
.btn:hover {
  background: rgba(0, 255, 65, 0.1);
  border-color: var(--green);
  text-shadow: 0 0 10px var(--green-glow);
}
```

### Buttons (danger)
```css
.btn-danger {
  border-color: #660020;
  color: var(--red);
}
.btn-danger:hover {
  background: var(--red);
  color: #000;
  text-shadow: none;
}
```

### Table Rows
```css
tbody tr {
  border-bottom: 1px solid rgba(0, 255, 65, 0.06);
  transition: background 0.15s;
}
tbody tr:hover {
  background: rgba(0, 255, 65, 0.05);
}
```

### Table Headers
```css
thead th {
  padding: 10px 12px;
  text-align: left;
  background: rgba(0, 255, 65, 0.05);
  border-bottom: 1px solid var(--green-dim);
  color: var(--green);
  letter-spacing: 2px;
  text-transform: uppercase;
  font-size: 0.7rem;
}
```

### Toast Notifications
```css
.toast {
  position: fixed;
  bottom: 30px;
  right: 30px;
  padding: 12px 20px;
  border: 1px solid var(--green);
  background: rgba(0, 10, 0, 0.95);
  color: var(--green);
  font-family: inherit;
}
/* Prefix messages with "> " like a terminal prompt */
```

### Checkboxes
```css
input[type="checkbox"] {
  appearance: none;
  width: 16px; height: 16px;
  border: 1px solid var(--green-dim);
  background: transparent;
}
input[type="checkbox"]:checked {
  background: var(--green-dark);
  border-color: var(--green);
}
input[type="checkbox"]:checked::after {
  content: '✓';
  color: var(--green);
}
```

## Severity Colors
| Level   | Color   | Usage                    |
|---------|---------|--------------------------|
| Normal  | #00ff41 | Default text, active     |
| Muted   | #00cc33 | Secondary, sleeping      |
| Warning | #ffaa00 | Medium mem, unusual state|
| Danger  | #ff0040 | High mem, kill, errors   |
| Info    | #00ccff | Ports, links, metadata   |
| Highlight| #88ffaa | Filenames, script names |

## Mobile / PWA
```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#000000">
```

### Safe Area (notch handling)
```css
padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
```

## Vibe
CRT monitor in a hacker's den. Everything glows faintly green. Scanlines remind you it's a screen. The matrix rain is subtle — atmospheric, not distracting. Danger is red. Data is green. The UI feels like you're operating a mainframe.
