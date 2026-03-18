# TTS Tap Changes — WebSocket Input Tracking

## What changed

The TTSTap class in `tayterm_terminal.py` was updated to use WebSocket input tracking instead of chunk-size heuristics to distinguish user input from Claude's response.

## Previous approach (broken)

Used chunk size: large chunks (>10 chars) = Claude, small chunks (<=3 chars) = user typing. Failed because voice input (push-to-talk) pastes large text blocks that look identical to Claude's output.

## New approach

The WebSocket handler knows when the user sends input (Enter key). It signals the TTSTap:

1. User presses Enter → `ws_handler` detects `\r` in input → calls `tts_tap.user_submitted()`
2. TTSTap enters cooldown (2 seconds) — ignores all PTY output (echoed input)
3. After cooldown, any PTY output = Claude responding → speak it
4. Next user Enter → back to step 1

## Key changes

### TTSTap class
- Removed: `speaking`, `last_large_chunk`, `silence_since` (chunk heuristic)
- Added: `listening`, `submit_time`, `output_after_cooldown` (input tracking)
- Added: `user_submitted()` method — called by ws_handler
- Added: `COOLDOWN = 2.0` seconds

### start_reader()
- TTSTap stored on entry dict: `entry["tts_tap"] = tts_tap`

### ws_handler()
- Detects Enter in user input: `if '\r' in payload["data"]`
- Signals tap: `entry["tts_tap"].user_submitted()`

## Line-level filters (unchanged)
Still skips: code blocks, tables, horizontal rules, file paths, shell prompts, PowerShell noise, command lines, non-alpha lines (<40%), short fragments (<5 words)

## Settings
- NaturalVoice in `ignored_projects` — stream watcher disabled for this project
- NaturalVoice `muted: false` in `project_voices` — PTY tap can send to `/speak`
- LEGAL `muted: true` — excluded from both (browser handles its own TTS via `/stream`)
