'use strict';
/**
 * rateLimiter.js — per-IP AND global rate limiting with escalation.
 *
 * Three states, shared across ALL callers of a given named limiter
 * instance (e.g. every /login route across encryptedShare.js AND
 * protectedShare.js can share one "auth" limiter):
 *
 *   normal    — each IP gets up to `perIpMax` requests per `windowMs`.
 *               If the GLOBAL request count (all IPs combined) exceeds
 *               `globalMax` within the same window, escalate to throttled.
 *
 *   throttled — EVERY IP is cut down to just 1 request per `windowMs`,
 *               regardless of its own individual history. This is what
 *               actually defeats a distributed attack across many IPs:
 *               the global counter doesn't care how many source IPs are
 *               involved, only the total request volume. If the global
 *               volume WHILE throttled exceeds `globalLockMax`, escalate
 *               to locked. Throttled mode itself expires back to normal
 *               after `windowMs` of no further escalation.
 *
 *   locked    — nobody gets through, at all, for `lockDurationMs`. Then
 *               back to normal.
 *
 * All state is in-memory (Maps/counters) — a backend restart resets
 * everything to normal, by design (matches every other rate-limit map
 * already in this codebase).
 *
 * `check(ip)` returns { allowed, state }. Callers that CAN determine
 * success/failure server-side (e.g. a TVFS login checked with findUser)
 * should call `refund(ip)` after a SUCCESSFUL attempt — a correct
 * password shouldn't burn your quota, only wrong guesses (and blocked
 * attempts, which never got a chance to submit anything) should.
 * Callers that CANNOT determine success (e.g. serving a verify-blob in
 * the zero-knowledge Encrypted Sharing flow — the server never learns if
 * the password was right) must never call refund(); every request counts.
 */

function createRateLimiter({ perIpMax, windowMs, globalMax, globalLockMax, lockDurationMs }) {
    let state = 'normal';
    let stateChangedAt = Date.now();

    const ipWindow = new Map(); // ip -> { count, windowStart }
    let globalWindow = { count: 0, windowStart: Date.now() };       // normal-mode global counter
    let throttledIpWindow = new Map();                              // ip -> { count, windowStart } — 1/window each, while throttled
    let throttledGlobalWindow = { count: 0, windowStart: Date.now() }; // counts volume DURING throttled mode, to detect the lock escalation

    function rollWindow(win, now) {
        if (now - win.windowStart > windowMs) { win.count = 0; win.windowStart = now; }
        return win;
    }

    function transition(newState, now) {
        state = newState;
        stateChangedAt = now;
        if (newState === 'normal') {
            ipWindow.clear();
            globalWindow = { count: 0, windowStart: now };
            throttledIpWindow.clear();
            throttledGlobalWindow = { count: 0, windowStart: now };
        } else if (newState === 'throttled') {
            throttledIpWindow.clear();
            throttledGlobalWindow = { count: 0, windowStart: now };
        }
    }

    function check(ip) {
        const now = Date.now();

        if (state === 'locked') {
            if (now - stateChangedAt > lockDurationMs) { transition('normal', now); }
            else return { allowed: false, state: 'locked' };
        }

        if (state === 'throttled') {
            if (now - stateChangedAt > windowMs) {
                transition('normal', now); // throttled period passed without re-escalating
            } else {
                let ipEntry = throttledIpWindow.get(ip);
                if (!ipEntry || now - ipEntry.windowStart > windowMs) {
                    ipEntry = { count: 0, windowStart: now };
                    throttledIpWindow.set(ip, ipEntry);
                }
                if (ipEntry.count >= 1) return { allowed: false, state: 'throttled' };
                ipEntry.count++;

                throttledGlobalWindow = rollWindow(throttledGlobalWindow, now);
                throttledGlobalWindow.count++;
                if (throttledGlobalWindow.count >= globalLockMax) {
                    transition('locked', now);
                    return { allowed: false, state: 'locked' };
                }
                return { allowed: true, state: 'throttled' };
            }
        }

        // state === 'normal' at this point (possibly just transitioned into it above)
        let ipEntry = ipWindow.get(ip);
        if (!ipEntry || now - ipEntry.windowStart > windowMs) {
            ipEntry = { count: 0, windowStart: now };
            ipWindow.set(ip, ipEntry);
        }
        if (ipEntry.count >= perIpMax) return { allowed: false, state: 'normal' };
        ipEntry.count++;

        globalWindow = rollWindow(globalWindow, now);
        globalWindow.count++;
        if (globalWindow.count >= globalMax) {
            transition('throttled', now);
        }
        return { allowed: true, state: state === 'throttled' ? 'throttled' : 'normal' };
    }

    // Undo one request's worth of quota — only for limiters whose callers
    // can confirm success server-side. Decrements whichever counter(s)
    // the request was actually counted against.
    function refund(ip) {
        const now = Date.now();
        if (state === 'throttled') {
            const e = throttledIpWindow.get(ip);
            if (e && e.count > 0) e.count--;
            if (throttledGlobalWindow.count > 0) throttledGlobalWindow.count--;
            return;
        }
        const e = ipWindow.get(ip);
        if (e && e.count > 0) e.count--;
        if (globalWindow.count > 0) globalWindow.count--;
    }

    // Cleanup so this Map-based state doesn't grow forever. Safe to call
    // periodically; also the reason every setInterval that does this kind
    // of sweep elsewhere in this codebase needed .unref() — same rule
    // applies here, done by the caller that creates this limiter.
    function sweep() {
        const now = Date.now();
        for (const [ip, e] of ipWindow) if (now - e.windowStart > windowMs * 2) ipWindow.delete(ip);
        for (const [ip, e] of throttledIpWindow) if (now - e.windowStart > windowMs * 2) throttledIpWindow.delete(ip);
    }

    return { check, refund, sweep, _debugState: () => state };
}

module.exports = { createRateLimiter };
