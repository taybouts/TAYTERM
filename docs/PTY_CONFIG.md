# TAYTERM PTY Configuration — Technical Reference

## Working Configuration (Node.js / node-pty)

```javascript
const ptyProc = pty.spawn('powershell.exe', [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: projectPath,
    env,
    conptyInheritCursor: true,
});
```

Environment variables:
```javascript
env.TERM = 'xterm-256color';
env.COLORTERM = 'truecolor';
// DO NOT set TERM_PROGRAM
```

## What Works and Why

| Setting | Value | Why |
|---------|-------|-----|
| ConPTY | default (no `useConpty` option) | Correct true-color (24-bit RGB) support for Claude Code's grey highlights, orange thinking, red diffs |
| `conptyInheritCursor: true` | Required | Prevents double cursor — ConPTY draws its own cursor on top of xterm.js cursor without this |
| WebGL addon | Always loaded | GPU rendering handles ConPTY's rapid small writes without flickering |
| Double-resize on connect | cols-1, then cols after 50ms | Forces ConPTY to properly initialize terminal buffer |
| No resize debouncing | Immediate resize | Debouncing desynchronizes ConPTY state, causes phantom lines and flickering |
| No `term.refresh()` calls | Never | Conflicts with WebGL's incremental GPU updates, causes stutter |

## What Breaks and Why

| Setting | Problem |
|---------|---------|
| `useConpty: false` (winpty mode) | Breaks grey highlights, orange thinking indicators, color palette wrong |
| `TERM_PROGRAM = 'xterm'` | Claude Code may detect terminal differently, causing output format issues |
| `FORCE_COLOR = '3'` | Was tried with winpty — doesn't fully fix colors |
| `encoding: 'utf8'` on spawn | Unnecessary, can cause issues |
| Resize debouncing (setTimeout 100-150ms) | ConPTY processes resizes out-of-order with data writes, causes flickering |
| `term.refresh(0, rows-1)` | Forces full redraw that fights WebGL's incremental updates |
| Window focus handler calling `fitAddon.fit()` | Triggers reflow during active data streaming, causes scroll thrashing |
| Removing double-resize trick | ConPTY buffer not properly initialized, visual glitches on connect |

## Flickering Root Causes (All Solved)

1. **Canvas rendering** — solved by always loading WebGL addon
2. **Resize debouncing** — solved by removing all setTimeout on resize
3. **Manual refresh()** — solved by removing all term.refresh() calls
4. **Focus handler reflow** — solved by removing window focus handler
5. **Double cursor** — solved by `conptyInheritCursor: true`

## ConPTY vs Winpty

- **ConPTY** (Windows Console Pseudo Terminal) — Microsoft's modern PTY. Supports true-color, but redraws entire screen buffer on output. Needs WebGL to handle rapid redraws.
- **Winpty** — Older PTY backend. Passes escape sequences straight through (no redraw), but doesn't fully support true-color. Claude Code's 24-bit RGB colors break.
- **Python winpty** — What the Python version uses. Works differently from node-pty's winpty mode.

## Claude Code Output Markers (for parsing)

| Marker | Meaning |
|--------|---------|
| `●` or `⦿` | Assistant response or tool call header |
| `●` + `Read(`, `Bash(`, etc. | Tool use |
| `●` + text | Conversation text (speakable) |
| `✢` | Thinking/processing indicator |
| `⎿` | Tool output continuation |
| `▎` | Tool output sidebar |
| `❯` | User input prompt |
| `─━═` (repeated) | Separator lines |
| `Opus 4.6 [...]` | Status bar |
| `bypass permissions` | Footer |

## JSONL Conversation Files

Location: `~/.claude/projects/<project-key>/*.jsonl`

Write behavior:
- Each **content block** written as one JSONL line when the block **completes**
- Text responses written AFTER Claude finishes typing the entire block
- Tool use entries written when tool call is made
- NOT streaming — cannot be used for real-time TTS
- Good for: mobile chat display (complete messages), conversation history

## Real-time Text Extraction (for TTS)

Use xterm-headless with onLineFeed event + state machine:
- Feed raw PTY data into headless terminal
- onLineFeed fires when a line completes on screen
- State machine tracks: IDLE, SPEAKING, TOOL, THINKING, STATUS
- Only emit text in SPEAKING state
- See server.js `startReader()` function
