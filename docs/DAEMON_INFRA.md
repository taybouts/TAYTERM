# T-Term PTY Daemon — Infrastructure & Admin Reference

> **Purpose:** This document provides the admin/security agent with complete knowledge of the T-Term daemon infrastructure, PM2 process management, and all related systems. Use this to set up monitoring, alerts, auto-start, and security hardening.

---

## Architecture Overview

T-Term uses a **three-process model**:

```
┌─────────────────┐     TCP :5041      ┌──────────────────┐
│  T-Term Server   │◄──────────────────►│   PTY Daemon     │
│  (server.js)     │    NDJSON          │  (pty-daemon.js) │
│  Port 5040       │                    │  Port 5041 TCP   │
│  HTTPS + WS      │                    │  Port 5042 HTTP  │
│  Managed by PM2  │                    │  Standalone       │
└────────┬─────────┘                    └────────┬─────────┘
         │ WebSocket                             │ node-pty
         ▼                                       ▼
┌─────────────────┐                    ┌──────────────────┐
│  Browser Client  │                    │  PTY Processes   │
│  (Chrome/Safari) │                    │  (Claude, bash)  │
└─────────────────┘                    └──────────────────┘
```

## File Locations

| Component | Path | Description |
|---|---|---|
| **PTY Daemon** | `C:\Users\taybo\Dropbox\CODEAI\T-Admin/T-Daemon\pty-daemon.js` | Standalone daemon process |
| **Daemon deps** | `C:\Users\taybo\Dropbox\CODEAI\T-Admin/T-Daemon\node_modules\` | `node-pty` + `node-addon-api` |
| **Daemon package** | `C:\Users\taybo\Dropbox\CODEAI\T-Admin/T-Daemon\package.json` | Standalone package with node-pty |
| **T-Term Server** | `C:\Users\taybo\Dropbox\CODEAI\T-Term\server.js` | Main HTTPS server |
| **Daemon Client** | `C:\Users\taybo\Dropbox\CODEAI\T-Term\lib\daemon-client.js` | TCP client that connects to daemon |
| **TTS Tap** | `C:\Users\taybo\Dropbox\CODEAI\T-Term\lib\tts-tap.js` | Server-side TTS (DISABLED, muted=true) |
| **PM2 dump** | `C:\Users\taybo\.pm2\dump.pm2` | PM2 saved process list |
| **PM2 logs** | `C:\Users\taybo\.pm2\logs\t-term-out.log` | Server stdout |
| **PM2 error logs** | `C:\Users\taybo\.pm2\logs\t-term-error.log` | Server stderr |

## Ports

| Port | Protocol | Service | Binding |
|---|---|---|---|
| **5040** | HTTPS | T-Term web server | `0.0.0.0` (all interfaces) |
| **5041** | TCP | PTY Daemon (NDJSON) | `127.0.0.1` (localhost only) |
| **5042** | HTTP | Daemon dashboard | `127.0.0.1` (localhost only) |
| **7123** | HTTP | T-Voice (Kokoro TTS/STT) | `127.0.0.1` (localhost only) |

## PM2 Process Management

### Current Setup
```bash
# T-Term server is managed by PM2
pm2 start server.js --name t-term --max-restarts 10 --restart-delay 3000 -- --port 5040

# Save process list for resurrect
pm2 save
```

### Common Commands
```bash
pm2 list                  # Show all processes
pm2 logs t-term           # Tail live logs
pm2 logs t-term --lines 50 --nostream  # Last 50 lines
pm2 restart t-term        # Restart server
pm2 stop t-term           # Stop server
pm2 delete t-term         # Remove from PM2
pm2 monit                 # Real-time monitoring dashboard
pm2 resurrect             # Restore saved process list
```

### Auto-Restart Behavior
- PM2 automatically restarts the server on crash
- Max 10 restarts with 3-second delay between attempts
- After 10 consecutive crashes, PM2 stops retrying

### Auto-Start on Windows Login (NOT YET CONFIGURED)
Needs admin elevation. Run in an **admin PowerShell**:
```powershell
Register-ScheduledTask -TaskName 'T-Term PM2' `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn) `
  -Action (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c C:\Users\taybo\AppData\Roaming\npm\pm2.cmd resurrect') `
  -RunLevel Highest -Force
```

## PTY Daemon Details

### How It Starts
1. `server.js` calls `ensureDaemon()` in `lib/daemon-client.js`
2. `ensureDaemon()` tries TCP connect to `127.0.0.1:5041`
3. If connection refused → spawns `node pty-daemon.js` from `T-Admin/T-Daemon/` folder as a **detached background process**
4. Retries connection up to 10 times (500ms intervals)
5. Once connected, server can spawn/attach/write/resize/kill PTYs

### Daemon Protocol (NDJSON over TCP)

**Commands (server → daemon):**
```json
{"action": "spawn", "sessionKey": "ProjectName:claude", "cwd": "/path/to/project", "cols": 120, "rows": 30}
{"action": "attach", "sessionKey": "ProjectName:claude"}
{"action": "detach", "sessionKey": "ProjectName:claude"}
{"action": "write", "sessionKey": "ProjectName:claude", "data": "ls -la\r"}
{"action": "resize", "sessionKey": "ProjectName:claude", "cols": 100, "rows": 40}
{"action": "kill", "sessionKey": "ProjectName:claude"}
{"action": "list"}
```

**Events (daemon → server):**
```json
{"type": "spawned", "sessionKey": "ProjectName:claude", "pid": 12345}
{"type": "attached", "sessionKey": "ProjectName:claude", "pid": 12345}
{"type": "output", "sessionKey": "ProjectName:claude", "data": "terminal output..."}
{"type": "scrollback", "sessionKey": "ProjectName:claude", "data": "buffered output..."}
{"type": "exit", "sessionKey": "ProjectName:claude", "code": 0}
{"type": "killed", "sessionKey": "ProjectName:claude"}
{"type": "list", "sessions": [...]}
{"type": "error", "message": "..."}
```

### Daemon Dashboard
- HTTP server on `http://127.0.0.1:5042`
- Glass-design UI showing active sessions, PIDs, subscriber count, scrollback size
- Actions: peek (view scrollback), kill session
- Useful for debugging — check if PTYs are alive when the web UI shows problems

### Session Lifecycle
```
Browser clicks project → Server sends "spawn" → Daemon creates PTY
                       → Server sends "attach" → Daemon adds subscriber
                       → PTY output flows: PTY → Daemon → Server → Browser (WebSocket)

Browser closes tab → Server sends "detach" → Daemon removes subscriber
                  → PTY keeps running (survives!)

Browser reconnects → Server sends "attach" → Daemon sends scrollback + adds subscriber

Server restarts → recoverDaemonSessions() → finds live PTYs → reattaches
```

### What Survives What

| Event | PTYs | Conversations | Browser State |
|---|---|---|---|
| Browser refresh | ✅ Survive | ✅ JSONL intact | Reconnects via `continue=1` |
| Server restart | ✅ Survive | ✅ JSONL intact | Auto-reconnect, sessions recovered |
| Daemon crash | ❌ All die | ✅ JSONL intact | `--continue` picks up from JSONL |
| Machine reboot | ❌ All die | ✅ JSONL intact | PM2 resurrect → fresh start |

## Known Issues

### 1. "Daemon error: Invalid JSON" (OPEN)
- **Symptom:** 2x "Invalid JSON" errors in server log on every spawn/attach
- **Impact:** Cosmetic — doesn't affect functionality
- **Debug:** Added `log()` in daemon's catch block to show actual invalid data
- **Location:** `pty-daemon.js` line ~250
- **Next step:** Restart daemon, reproduce, check daemon logs for the actual invalid content

### 2. Duplicate Daemon Connection (FIXED)
- **Was:** On startup, failed connection attempt fired both `error` and `close` events. The `close` handler scheduled a reconnect, AND `ensureDaemon()` retried — creating two live TCP connections to the daemon
- **Fix:** `connectToDaemon()` now tracks `wasConnected` flag. Close handler only auto-reconnects if previously connected. New connections destroy stale sockets. Data handler ignores data from non-current sockets.
- **Location:** `lib/daemon-client.js`

### 3. TTSTap Double Voice (FIXED)
- **Was:** Server-side `TTSTap` in `lib/tts-tap.js` called T-Voice `/speak` endpoint directly, while the browser ALSO played TTS via `/synthesize`. Two audio streams for every message.
- **Fix:** Changed `this.muted = false` to `this.muted = true` in TTSTap constructor
- **CRITICAL:** Do NOT re-enable TTSTap. All TTS is browser-based now.
- **Location:** `lib/tts-tap.js` line 58

## Security Considerations

### Network Exposure
- **Daemon TCP (5041):** Localhost only — not accessible from network. No auth.
- **Daemon Dashboard (5042):** Localhost only — no auth. Shows PTY metadata, can kill sessions.
- **T-Term Server (5040):** Bound to `0.0.0.0` — accessible from network. Protected by auth (passkeys + gateway).
- **T-Voice (7123):** Localhost only — no auth.

### Recommendations for Admin Agent
1. **Monitoring:** Set up alerts if PM2 process dies and doesn't restart (10 crash limit)
2. **Daemon health:** Periodic TCP connect to 5041 to verify daemon is alive
3. **Disk space:** JSONL files in `~/.claude/projects/` grow unbounded — consider rotation
4. **Log rotation:** PM2 logs at `~/.pm2/logs/` — use `pm2 install pm2-logrotate` or manual rotation
5. **Firewall:** Ensure ports 5041, 5042, 7123 are NOT exposed to external network
6. **Auto-start:** Task Scheduler entry needs admin elevation — see PM2 section above
7. **Process cleanup:** Orphaned node processes can accumulate — check with `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` and match against expected PIDs
