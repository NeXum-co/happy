#!/usr/bin/env node
/**
 * Session Hook Forwarder
 *
 * This script is executed by Claude's hooks (SessionStart, Notification,
 * PostToolUse, UserPromptSubmit, Stop). It reads JSON data from stdin and
 * forwards it to Happy's hook server, routing on hook_event_name:
 * SessionStart keeps its original endpoint (the claudeSessionId capture
 * depends on it), every other event goes to /hook/event.
 *
 * Fire-and-forget: errors are swallowed and the exit code stays 0 so a
 * broken forwarder can never break a Claude session.
 *
 * Usage: echo '{"session_id":"...","hook_event_name":"..."}' | node session_hook_forwarder.cjs <port> <secret>
 */

const http = require('http');

const port = parseInt(process.argv[2], 10);
// Per-session shared secret (SEC-001); the hook server rejects requests
// that don't echo it back in the X-Hook-Secret header.
const secret = process.argv[3] || '';

if (!port || isNaN(port)) {
    process.exit(0);
}

const chunks = [];

process.stdin.on('data', (chunk) => {
    chunks.push(chunk);
});

process.stdin.on('end', () => {
    const body = Buffer.concat(chunks);

    // Route on hook_event_name; unknown/missing falls back to the original
    // session-start endpoint (pre-existing behavior).
    let eventName = '';
    try {
        eventName = JSON.parse(body.toString('utf-8')).hook_event_name || '';
    } catch (e) {
        // Not JSON — treat as session-start, matching old behavior
    }
    const path = (eventName && eventName !== 'SessionStart') ? '/hook/event' : '/hook/session-start';

    const req = http.request({
        host: '127.0.0.1',
        port: port,
        method: 'POST',
        path: path,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
            'X-Hook-Secret': secret
        }
    }, (res) => {
        res.resume(); // Drain response
    });

    req.on('error', () => {
        // Silently ignore errors - don't break Claude
    });

    req.end(body);
});

process.stdin.resume();

