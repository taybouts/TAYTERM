#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  PTY Client — Connect any terminal to a daemon-managed PTY
//
//  Usage:
//    node pty-client.js list                          — list active PTYs
//    node pty-client.js attach TAYTERM:claude          — attach to existing PTY
//    node pty-client.js spawn TAYTERM:claude C:\path   — spawn new PTY in folder
//    node pty-client.js kill TAYTERM:claude             — kill a PTY
// ═══════════════════════════════════════════════════════════════════════════

const net = require('net');
const readline = require('readline');

const DAEMON_PORT = 7779;
const DAEMON_HOST = '127.0.0.1';

const args = process.argv.slice(2);
const action = args[0];
const sessionKey = args[1];
const cwd = args[2];

if (!action || (action !== 'list' && !sessionKey)) {
    console.log('PTY Client — connect to the PTY daemon\n');
    console.log('Usage:');
    console.log('  node pty-client.js list                        — list active PTYs');
    console.log('  node pty-client.js attach <key>                — attach to existing PTY');
    console.log('  node pty-client.js spawn <key> <folder>        — spawn new PTY');
    console.log('  node pty-client.js kill <key>                  — kill a PTY');
    console.log('\nExample:');
    console.log('  node pty-client.js attach TAYTERM:claude');
    process.exit(0);
}

const socket = net.createConnection({ port: DAEMON_PORT, host: DAEMON_HOST }, () => {
    if (action === 'list') {
        send({ action: 'list' });
    } else if (action === 'attach') {
        send({ action: 'attach', sessionKey });
        goInteractive();
    } else if (action === 'spawn') {
        if (!cwd) { console.error('Error: folder path required for spawn'); process.exit(1); }
        send({ action: 'spawn', sessionKey, cwd, cols: process.stdout.columns || 120, rows: process.stdout.rows || 30 });
        // After spawn, attach
        setTimeout(() => {
            send({ action: 'attach', sessionKey });
            goInteractive();
        }, 500);
    } else if (action === 'kill') {
        send({ action: 'kill', sessionKey });
    }
});

socket.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
        console.error('Cannot connect to daemon on port ' + DAEMON_PORT + ' — is it running?');
    } else {
        console.error('Error:', err.message);
    }
    process.exit(1);
});

let buffer = '';
socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
            handleMessage(JSON.parse(line));
        } catch (e) {}
    }
});

function send(obj) {
    socket.write(JSON.stringify(obj) + '\n');
}

function handleMessage(msg) {
    switch (msg.type) {
        case 'output':
            process.stdout.write(msg.data);
            break;
        case 'scrollback':
            process.stdout.write(msg.data);
            break;
        case 'exit':
            console.log('\n[PTY exited]');
            process.exit(0);
            break;
        case 'list':
            if (msg.sessions.length === 0) {
                console.log('No active PTY sessions');
            } else {
                console.log('\nActive PTY sessions:\n');
                for (const s of msg.sessions) {
                    const uptime = Math.floor((Date.now() - s.createdAt) / 1000);
                    const m = Math.floor(uptime / 60), sec = uptime % 60;
                    console.log(`  ${s.sessionKey}`);
                    console.log(`    PID: ${s.pid}  |  ${s.cols}x${s.rows}  |  ${s.subscribers} connected  |  ${m}m${sec}s`);
                    console.log(`    ${s.cwd}\n`);
                }
            }
            process.exit(0);
            break;
        case 'spawned':
            // Silent — will attach next
            break;
        case 'attached':
            // Silent — now in interactive mode
            break;
        case 'killed':
            console.log('Killed: ' + msg.sessionKey);
            process.exit(0);
            break;
        case 'error':
            console.error('Daemon error:', msg.message);
            if (action === 'list' || action === 'kill') process.exit(1);
            break;
    }
}

function goInteractive() {
    // Raw mode — pass every keystroke to the PTY
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('data', (data) => {
        send({ action: 'write', sessionKey, data: data.toString() });
    });

    // Handle terminal resize
    process.stdout.on('resize', () => {
        send({ action: 'resize', sessionKey,
            cols: process.stdout.columns || 120,
            rows: process.stdout.rows || 30 });
    });

    // Send initial size
    send({ action: 'resize', sessionKey,
        cols: process.stdout.columns || 120,
        rows: process.stdout.rows || 30 });

    // Clean exit on Ctrl+D or socket close
    socket.on('close', () => {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.exit(0);
    });
}
