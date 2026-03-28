/**
 * PTY Daemon Client — TCP connection to pty-daemon.js.
 * Factory pattern: call initDaemonClient(onMessage, deps) to get the client API.
 */

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

module.exports = function initDaemonClient(onMessage, deps) {
    const { log, activeTerminals } = deps;

    const DAEMON_PORT = 5041;
    const DAEMON_HOST = '127.0.0.1';
    let daemonSocket = null;
    let daemonBuffer = '';
    let daemonReady = false;
    let daemonSessionList = [];
    let daemonListCallback = null;

    function daemonSend(obj) {
        if (daemonSocket && daemonSocket.writable) {
            daemonSocket.write(JSON.stringify(obj) + '\n');
        }
    }

    function daemonSpawn(sessionKey, cwd, cols, rows) {
        daemonSend({ action: 'spawn', sessionKey, cwd, cols, rows });
    }
    function daemonAttach(sessionKey) {
        daemonSend({ action: 'attach', sessionKey });
    }
    function daemonDetach(sessionKey) {
        daemonSend({ action: 'detach', sessionKey });
    }
    function daemonWrite(sessionKey, data) {
        daemonSend({ action: 'write', sessionKey, data });
    }
    function daemonResize(sessionKey, cols, rows) {
        daemonSend({ action: 'resize', sessionKey, cols, rows });
    }
    function daemonKill(sessionKey) {
        daemonSend({ action: 'kill', sessionKey });
    }
    function daemonList() {
        daemonSend({ action: 'list' });
    }

    function daemonListAsync() {
        return new Promise((resolve) => {
            daemonListCallback = resolve;
            daemonSend({ action: 'list' });
            // Timeout in case daemon doesn't respond
            setTimeout(() => { if (daemonListCallback) { daemonListCallback = null; resolve([]); } }, 2000);
        });
    }

    function connectToDaemon() {
        return new Promise((resolve) => {
            let wasConnected = false;
            const sock = net.createConnection({ port: DAEMON_PORT, host: DAEMON_HOST }, () => {
                // Close previous socket if still alive (prevent duplicates)
                if (daemonSocket && daemonSocket !== sock) {
                    try { daemonSocket.destroy(); } catch (e) {}
                }
                daemonSocket = sock;
                daemonReady = true;
                daemonBuffer = '';
                wasConnected = true;
                log('Connected to PTY daemon');
                resolve(true);
            });

            sock.on('data', (chunk) => {
                // Ignore data from stale sockets
                if (sock !== daemonSocket) return;
                daemonBuffer += chunk.toString();
                let idx;
                while ((idx = daemonBuffer.indexOf('\n')) >= 0) {
                    const line = daemonBuffer.slice(0, idx).trim();
                    daemonBuffer = daemonBuffer.slice(idx + 1);
                    if (!line) continue;
                    try {
                        const msg = JSON.parse(line);
                        // Handle list responses internally
                        if (msg.type === 'list') {
                            daemonSessionList = msg.sessions || [];
                            if (daemonListCallback) {
                                const cb = daemonListCallback;
                                daemonListCallback = null;
                                cb(daemonSessionList);
                            }
                        } else {
                            onMessage(msg);
                        }
                    } catch (e) { log(`Bad daemon message: ${e.message}`); }
                }
            });

            sock.on('close', () => {
                // Only handle close for the active socket
                if (sock !== daemonSocket && !wasConnected) return;
                if (sock === daemonSocket) {
                    log('Daemon connection lost');
                    daemonSocket = null;
                    daemonReady = false;
                    // Mark all sessions as dead
                    for (const key of Object.keys(activeTerminals)) {
                        activeTerminals[key].alive = false;
                    }
                    // Auto-reconnect only if we had a successful connection (not initial failure)
                    if (wasConnected) {
                        setTimeout(() => connectToDaemon().catch(() => {}), 2000);
                    }
                }
            });

            sock.on('error', (err) => {
                if (err.code === 'ECONNREFUSED') {
                    resolve(false);
                } else {
                    log(`Daemon socket error: ${err.message}`);
                    resolve(false);
                }
            });
        });
    }

    async function ensureDaemon() {
        // Try to connect
        let connected = await connectToDaemon();
        if (connected) return;

        // Not running — start it from T-Admin/T-Daemon/
        log('Starting PTY daemon...');
        const daemonDir = path.join(path.dirname(__dirname), '..', 'T-Admin', 'T-Daemon');
        const daemonScript = path.join(daemonDir, 'pty-daemon.js');
        const daemonProc = spawn('node', [daemonScript], {
            detached: true,
            stdio: 'ignore',
            cwd: daemonDir,
        });
        daemonProc.unref();

        // Wait for it to be ready
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 500));
            connected = await connectToDaemon();
            if (connected) return;
        }
        log('WARNING: Could not connect to PTY daemon');
    }

    function getDaemonState() {
        return { connected: daemonReady, sessions: daemonSessionList };
    }

    return {
        connectToDaemon,
        ensureDaemon,
        daemonSpawn,
        daemonAttach,
        daemonDetach,
        daemonWrite,
        daemonResize,
        daemonKill,
        daemonList,
        daemonListAsync,
        daemonSend,
        getDaemonState,
    };
};
