# T-Term Voice Player — Complete Implementation Reference

## Overview

T-Term has a browser-based voice player that provides sentence-by-sentence TTS with live text highlighting, a controller bar, click-to-jump, and auto-play on new messages. It uses the NaturalVoice server (Kokoro TTS + WhisperX STT) on port 7123, proxied through the T-Term server for HTTPS/Cloudflare compatibility.

This works on desktop, iPad, and iPhone — same code path everywhere.

---

## Architecture

```
Browser (any device)
  │
  ├─ TTS: POST /api/tts/synthesize  →  T-Term server proxy  →  NaturalVoice :7123/synthesize
  │        Returns: audio/wav (complete WAV file per sentence)
  │
  └─ STT: POST /api/tts/transcribe  →  T-Term server proxy  →  NaturalVoice :7123/transcribe
           Sends: FormData with audio blob (webm)
           Returns: JSON { "text": "transcribed text" }
```

**Why `/synthesize` instead of `/stream`?**
We initially tried `/stream` (chunked PCM streaming) but it returned HTTP 200 with zero bytes of audio data. The generator `engine.synthesize()` yielded nothing through the streaming endpoint, though `/speak` (queue-based) worked fine. `/synthesize` returns a complete WAV file and works reliably. The tradeoff is slightly higher latency (must wait for full synthesis) but much more reliable.

**Why proxy instead of direct?**
- Mixed content: HTTPS page can't fetch HTTP endpoint (blocked by browser)
- CORS: NaturalVoice doesn't always send CORS headers for HTTPS origins
- Cloudflare: remote devices can't reach port 7123 directly

---

## Server-Side Proxy

In `routes/api.js` — forwards any `/api/tts/*` request to NaturalVoice:

```javascript
// ── TTS Proxy — forwards /api/tts/* to Kokoro on 127.0.0.1:7123 ──
if (pathname.startsWith('/api/tts/')) {
    const kokoroPath = pathname.replace('/api/tts', '');
    const body = await readBody(req);
    const http = require('http');
    const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' };
    if (body.length > 0) headers['Content-Length'] = body.length;
    const kokoroReq = http.request({
        hostname: '127.0.0.1',
        port: 7123,
        path: kokoroPath,
        method: req.method,
        headers,
    }, (kokoroRes) => {
        const resHeaders = { 'Content-Type': kokoroRes.headers['content-type'] || 'application/octet-stream' };
        if (kokoroRes.headers['transfer-encoding']) resHeaders['Transfer-Encoding'] = kokoroRes.headers['transfer-encoding'];
        res.writeHead(kokoroRes.statusCode, resHeaders);
        kokoroRes.pipe(res);
    });
    kokoroReq.on('error', () => {
        sendJson(res, { error: 'TTS server unreachable' }, 502);
    });
    kokoroReq.setTimeout(30000);
    if (body.length > 0) kokoroReq.write(body);
    kokoroReq.end();
    return true;
}
```

Key: `readBody(req)` buffers the full request body first, then forwards it with correct `Content-Length`. This handles both JSON (for `/synthesize`) and multipart FormData (for `/transcribe`).

---

## Client-Side: TTS_BASE

```javascript
// Always proxy through server — avoids mixed-content and CORS issues
const TTS_BASE = window.location.origin + '/api/tts';
```

All TTS/STT requests go through the proxy regardless of connection type (local, Tailscale, Cloudflare).

---

## Voice Player State

```javascript
let _vpAutoPlay = true;        // Auto-play TTS on new assistant messages
let _vpLoadingHistory = false;  // Suppress auto-play during history load
let _vpSharedAudioCtx = null;  // Shared AudioContext — created on first user gesture for iOS

const _vp = {
  sentences: [],      // Array of sentence strings
  currentIndex: -1,   // Which sentence is currently playing
  paused: false,
  active: false,      // Is the player running?
  bubbleEl: null,     // The .msg-bubble DOM element being read
  btnEl: null,        // The speaker button that triggered playback
  generation: 0,      // Incremented on each new playback — kills stale chains
  rawText: '',        // Original markdown text
  abortCtrl: null,    // AbortController for current fetch
  audioCtx: null,     // Reference to shared AudioContext
};
```

---

## iOS AudioContext Trick

iOS Safari blocks `AudioContext` playback unless it's created/resumed during a user gesture. We pre-create and keep alive a shared context:

```javascript
function _vpEnsureAudioCtx() {
  if (!_vpSharedAudioCtx || _vpSharedAudioCtx.state === 'closed') {
    _vpSharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_vpSharedAudioCtx.state === 'suspended') _vpSharedAudioCtx.resume();
  return _vpSharedAudioCtx;
}
// Attach to ALL user interactions — not just once
document.addEventListener('touchstart', _vpEnsureAudioCtx, { once: false, passive: true });
document.addEventListener('click', _vpEnsureAudioCtx, { once: false, passive: true });
```

**Critical**: Never close this AudioContext. `_vpKillAudio()` only aborts the fetch, it does NOT close the context:

```javascript
function _vpKillAudio() {
  if (_vp.abortCtrl) { _vp.abortCtrl.abort(); _vp.abortCtrl = null; }
  // Don't close the shared AudioContext — just abort the fetch
}
```

---

## Sentence Splitting

```javascript
function _vpSplitSentences(text) {
  const raw = text.replace(/\n{2,}/g, '\n').trim();
  const parts = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sents = trimmed.match(/[^.!?]+[.!?]+[\s]?|[^.!?]+$/g);
    if (sents) {
      for (const s of sents) {
        const clean = s.trim();
        if (clean.length > 2) parts.push(clean);
      }
    } else if (trimmed.length > 2) {
      parts.push(trimmed);
    }
  }
  return parts;
}
```

Splits by newlines first (paragraph boundaries), then by `.` `!` `?` sentence endings. Filters out fragments under 3 chars.

---

## Playback Chain: _vpSpeakIndex

This is the core loop — plays one sentence, waits, advances:

```javascript
async function _vpSpeakIndex(index) {
  if (!_vp.active || index >= _vp.sentences.length) {
    _vpStop();
    return;
  }
  const gen = _vp.generation;
  _vp.currentIndex = index;
  _vpHighlight(index);      // Highlight current sentence
  _vpUpdateUI();             // Update controller bar

  if (_vp.abortCtrl) { _vp.abortCtrl.abort(); _vp.abortCtrl = null; }
  _vp.abortCtrl = new AbortController();
  _vp.audioCtx = _vpEnsureAudioCtx();

  try {
    // Fetch WAV for this sentence
    const resp = await fetch(TTS_BASE + '/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: _vp.sentences[index], voice: 'am_onyx', speed: 1.25 }),
      signal: _vp.abortCtrl.signal,
    });
    if (!resp.ok) throw new Error('TTS ' + resp.status);

    const wavBuf = await resp.arrayBuffer();
    if (gen !== _vp.generation) return;  // Stale — another playback started

    // Decode and play
    const ctx = _vp.audioCtx;
    const audioBuf = await ctx.decodeAudioData(wavBuf);
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    src.start(0);

    // Wait for playback to finish, then advance
    await new Promise(resolve => setTimeout(resolve, audioBuf.duration * 1000 + 50));
    if (gen !== _vp.generation || _vp.paused) return;
    _vpSpeakIndex(index + 1);  // Next sentence
  } catch(e) {
    if (e.name === 'AbortError') return;  // User cancelled
    if (gen !== _vp.generation) return;
    _vpSpeakIndex(index + 1);  // Skip failed sentence
  }
}
```

**Generation system**: `_vp.generation` is incremented every time a new playback starts or stop is called. Each `_vpSpeakIndex` call captures the generation at start (`const gen = _vp.generation`). Before advancing to the next sentence, it checks if the generation still matches. If not, it means a new playback was started (or stop was called), so this chain dies silently.

---

## Highlighting

### Apply highlight

```javascript
function _vpHighlight(index) {
  _vpClearHighlight();
  if (!_vp.bubbleEl || index < 0 || index >= _vp.sentences.length) return;
  const sentence = _vp.sentences[index];
  const bubble = _vp.bubbleEl;

  // 1. Collect all text nodes in the bubble
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  // 2. Build concatenated full text
  let fullText = '';
  for (const tn of textNodes) fullText += tn.textContent;

  // 3. Find sentence position (exact match first)
  let sentPos = fullText.indexOf(sentence);
  if (sentPos === -1) {
    // Fallback: normalize whitespace and try again
    const normFull = fullText.replace(/\s+/g, ' ');
    const normSent = sentence.replace(/\s+/g, ' ');
    const normPos = normFull.indexOf(normSent);
    if (normPos === -1) return;
    // Map normalized position back to original text
    let origIdx = 0, nIdx = 0;
    while (nIdx < normPos && origIdx < fullText.length) {
      if (/\s/.test(fullText[origIdx])) {
        origIdx++;
        if (nIdx < normPos && normFull[nIdx] === ' ') nIdx++;
        while (origIdx < fullText.length && /\s/.test(fullText[origIdx])) origIdx++;
      } else { origIdx++; nIdx++; }
    }
    sentPos = origIdx;
  }

  // 4. Find the text node containing this position and wrap in highlight span
  let offset = 0;
  for (const node of textNodes) {
    const nodeEnd = offset + node.textContent.length;
    const sentEnd = sentPos + sentence.length;
    if (nodeEnd > sentPos && offset < sentEnd) {
      const startInNode = Math.max(0, sentPos - offset);
      const endInNode = Math.min(node.textContent.length, sentEnd - offset);
      try {
        const range = document.createRange();
        range.setStart(node, startInNode);
        range.setEnd(node, endInNode);
        const span = document.createElement('span');
        span.className = 'voice-highlight';
        range.surroundContents(span);
        // Auto-scroll if highlight is off-screen
        const chatContainer = span.closest('.chat-messages');
        if (chatContainer) {
          const spanRect = span.getBoundingClientRect();
          const containerRect = chatContainer.getBoundingClientRect();
          if (spanRect.bottom > containerRect.bottom - 80 || spanRect.top < containerRect.top) {
            span.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      } catch(e) { /* surroundContents can fail if range crosses element boundaries */ }
      break;
    }
    offset = nodeEnd;
  }
}
```

### Clear highlight

```javascript
function _vpClearHighlight() {
  if (!_vp.bubbleEl) return;
  _vp.bubbleEl.querySelectorAll('.voice-highlight').forEach(el => {
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize();  // Merge adjacent text nodes back together
  });
}
```

**Important**: `parent.normalize()` is critical. Without it, the DOM accumulates fragmented text nodes after each highlight/clear cycle, which breaks future `indexOf` lookups.

---

## Click-to-Jump in Bubble Text

When the voice player is active on a bubble, clicking anywhere in the text jumps to that sentence:

```javascript
function _vpJumpToClick(e, bubble) {
  const selection = window.getSelection();
  if (!selection.anchorNode || !bubble.contains(selection.anchorNode)) return;

  const clone = bubble.cloneNode(true);
  clone.querySelectorAll('.bubble-read-btn, .bubble-copy-btn').forEach(el => el.remove());
  const fullText = clone.innerText || clone.textContent || '';

  try {
    // Get character position of click
    const range = document.createRange();
    range.selectNodeContents(bubble);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    const charPos = range.toString().length;

    // Find which sentence contains this position
    let bestIndex = 0, pos = 0;
    for (let i = 0; i < _vp.sentences.length; i++) {
      const sentPos = fullText.indexOf(_vp.sentences[i], pos);
      if (sentPos === -1) continue;
      if (charPos >= sentPos && charPos <= sentPos + _vp.sentences[i].length) { bestIndex = i; break; }
      if (sentPos > charPos) { bestIndex = Math.max(0, i - 1); break; }
      pos = sentPos + _vp.sentences[i].length;
      bestIndex = i;
    }

    _vpKillAudio();
    _vp.paused = false;
    _vpSpeakIndex(bestIndex);
  } catch(ex) {}
}
```

The click handler is attached in `_vpStart` and removed in `_vpStop`:

```javascript
// In _vpStart:
bubble._vpClickHandler = (e) => {
  if (e.target.closest('.bubble-read-btn, .bubble-copy-btn')) return;
  if (!_vp.active || _vp.bubbleEl !== bubble) return;
  _vpJumpToClick(e, bubble);
};
bubble.addEventListener('click', bubble._vpClickHandler);

// In _vpStop:
if (_vp.bubbleEl && _vp.bubbleEl._vpClickHandler) {
  _vp.bubbleEl.removeEventListener('click', _vp.bubbleEl._vpClickHandler);
  delete _vp.bubbleEl._vpClickHandler;
}
```

---

## Controller Bar

### HTML

```html
<div id="voiceBar" class="voice-bar">
  <button class="vb-btn" onclick="_vpPrev()" title="Previous">⏮</button>
  <button class="vb-btn" id="vpPlayPause" onclick="_vpTogglePause()" title="Pause / Resume">⏸</button>
  <button class="vb-btn" onclick="_vpNext()" title="Next">⏭</button>
  <button class="vb-btn vb-stop" onclick="_vpStop()" title="Stop">×</button>
  <div class="vb-timeline" id="vpTimeline" onclick="_vpTimelineClick(event)" title="Click to jump">
    <div class="vb-fill" id="vpProgress"></div>
  </div>
  <span class="vb-counter" id="vpCounter">0 / 0</span>
</div>
```

### CSS

```css
.voice-highlight {
  background: rgba(56, 189, 248, 0.2);
  border-bottom: 2px solid var(--accent2);
  border-radius: 2px;
  padding: 1px 0;
  transition: background 0.2s;
}

.voice-bar {
  position: fixed; bottom: -50px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  padding: 6px 14px; border-radius: 20px;
  background: rgba(10, 10, 20, 0.92);
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--glass-border);
  box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  z-index: 9999;
  transition: bottom 0.3s ease;
  max-width: 90vw;
}
.voice-bar.visible { bottom: 20px; }

/* Safe area for iOS PWA */
@supports (padding-bottom: env(safe-area-inset-bottom)) {
  .voice-bar.visible { bottom: calc(20px + env(safe-area-inset-bottom)); }
}

.vb-btn {
  background: none; border: none; color: var(--text2);
  font-size: 16px; cursor: pointer; padding: 2px 6px;
  border-radius: 6px; transition: color 0.15s, background 0.15s;
  line-height: 1;
}
.vb-btn:hover { color: var(--accent2); background: rgba(255,255,255,0.06); }
.vb-stop { font-size: 20px; font-weight: 300; }

.vb-timeline {
  width: 120px; height: 4px;
  background: rgba(255,255,255,0.1);
  border-radius: 2px; cursor: pointer;
  position: relative; overflow: hidden;
}
.vb-fill {
  height: 100%; width: 0%;
  background: var(--accent2);
  border-radius: 2px;
  transition: width 0.25s ease;
}
.vb-counter {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text3); white-space: nowrap; min-width: 40px;
}
```

### UI Update

```javascript
function _vpUpdateUI() {
  const counter = document.getElementById('vpCounter');
  if (counter) {
    const cur = _vp.currentIndex >= 0 ? _vp.currentIndex + 1 : 0;
    counter.textContent = cur + ' / ' + _vp.sentences.length;
  }
  const ppBtn = document.getElementById('vpPlayPause');
  if (ppBtn) ppBtn.textContent = _vp.paused ? '\u25B6' : '\u23F8';
  const total = _vp.sentences.length || 1;
  const cur = _vp.currentIndex >= 0 ? _vp.currentIndex : 0;
  const pct = total <= 1 ? 0 : Math.min(100, (cur / (total - 1)) * 100);
  const fill = document.getElementById('vpProgress');
  if (fill) fill.style.width = pct + '%';
}
```

### Timeline Click (scrub)

```javascript
function _vpTimelineClick(e) {
  if (!_vp.active || _vp.sentences.length === 0) return;
  const bar = document.getElementById('vpTimeline');
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const index = Math.round(pct * (_vp.sentences.length - 1));
  _vpKillAudio();
  _vp.paused = false;
  _vpSpeakIndex(index);
}
```

---

## Auto-Play on New Messages

In `addMessengerMessage`, after inserting an assistant bubble:

```javascript
if (role === 'assistant') {
  // ... insert bubble into DOM ...

  // Auto-play TTS for new live assistant messages (not history loads)
  if (_vpAutoPlay && !_vpLoadingHistory) {
    const readBtn = bubble.querySelector('.bubble-read-btn');
    const msgBubble = bubble.querySelector('.msg-bubble') || bubble;
    if (readBtn) {
      setTimeout(() => _vpStart(msgBubble, trimmed, readBtn, 0), 100);
    }
  }
}
```

History loads are wrapped with `_vpLoadingHistory = true/false` to prevent auto-play on old messages.

---

## Entry Point: readBubbleAloud

Called by the speaker icon on each assistant bubble:

```javascript
function readBubbleAloud(text, btn) {
  if (_vp.active && _vp.btnEl === btn) {
    // Toggle — stop if same bubble
    _vpStop();
    return;
  }
  const bubble = btn.closest('.msg-bubble');
  if (!bubble) return;
  _vpStart(bubble, text, btn, 0);
}
```

---

## Controls Summary

| Action | Function |
|--------|----------|
| Start/Stop | `readBubbleAloud(text, btn)` or `_vpStart`/`_vpStop` |
| Pause/Resume | `_vpTogglePause()` |
| Next sentence | `_vpNext()` |
| Previous sentence | `_vpPrev()` |
| Jump to sentence | Click in bubble text → `_vpJumpToClick` |
| Scrub timeline | Click timeline bar → `_vpTimelineClick` |
| Kill audio | `_vpKillAudio()` — aborts fetch only, keeps AudioContext |
| Full stop | `_vpStop()` — kills audio, clears highlight, hides bar, resets state |

---

## Known Issues & Design Decisions

1. **`/synthesize` vs `/stream`**: We use `/synthesize` (complete WAV) because `/stream` (chunked PCM) returned empty data. Higher latency per sentence but 100% reliable.

2. **iOS AudioContext**: Must be created on user gesture. We pre-create on any touch/click and never close it. Auto-play works because the context was already unlocked by a prior interaction.

3. **Generation counter**: Prevents race conditions. Each playback chain checks its generation before advancing. If a new playback starts (or stop is called), the old chain dies.

4. **`surroundContents` limitations**: Can fail if the sentence spans across HTML element boundaries (e.g., part in `<strong>`, part outside). The `try/catch` handles this gracefully — highlight just doesn't appear for that sentence.

5. **`normalize()` after clear**: Critical for maintaining correct text node structure. Without it, `indexOf` fails on subsequent highlights because text nodes are fragmented.
