'use strict';
// Shared request-safety helpers: the real client address, strict id formats,
// secure random names and a limiter that counts only failed attempts.
const crypto = require('crypto');
const net = require('net');

// Our own proxies (Cloudflare tunnel, Nginx Proxy Manager, nginx) reach the backend
// from loopback or a private Docker network. Only then is CF-Connecting-IP trusted;
// a client talking to the port directly cannot choose its own address.
function isPrivateAddress(ip) {
    if (!ip) return false;
    if (ip === '::1' || ip.startsWith('127.')) return true;
    if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
    const m = /^172\.(\d+)\./.exec(ip);
    if (m && +m[1] >= 16 && +m[1] <= 31) return true;
    return /^f[cd][0-9a-f]{2}:/i.test(ip); // IPv6 unique local
}

function clientIp(req) {
    const peer = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf && net.isIP(cf) && isPrivateAddress(peer)) return cf;
    return peer || 'unknown';
}

// Upload ids: `<ms timestamp>_<lowercase base36/hex>` (older clients still resume theirs)
const UPLOAD_ID_RE = /^\d{10,16}_[a-z0-9]{1,40}$/;
const BATCH_ID_RE = /^batch_\d{10,16}_[a-f0-9]{8}$/;
const FILE_ID_RE = /^f_\d{10,16}_[a-f0-9]{8}$/;
const isUploadId = v => typeof v === 'string' && UPLOAD_ID_RE.test(v);
const isBatchId = v => typeof v === 'string' && BATCH_ID_RE.test(v);
const isFileId = v => typeof v === 'string' && FILE_ID_RE.test(v);

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// Short lowercase suffix for stored names (a-z, 0-9)
const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randomSuffix(length = 6) {
    let out = '';
    for (let i = 0; i < length; i++) out += LOWER[crypto.randomInt(LOWER.length)];
    return out;
}

function randomName(length = 16) {
    let out = '';
    for (let i = 0; i < length; i++) out += ALNUM[crypto.randomInt(ALNUM.length)];
    return out;
}

// Counts failures only; a success clears the key. Bounded so a flood of keys cannot grow memory.
function failureLimiter({ windowMs, max, maxKeys = 50000 }) {
    const entries = new Map();
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [k, e] of entries) if (e.until <= now) entries.delete(k);
    }, 60 * 1000);
    timer.unref();
    return {
        // seconds until the key may try again, 0 when allowed
        retryAfter(key) {
            const e = entries.get(key);
            if (!e || e.until <= Date.now() || e.count < max) return 0;
            return Math.ceil((e.until - Date.now()) / 1000);
        },
        fail(key) {
            const now = Date.now();
            let e = entries.get(key);
            if (!e || e.until <= now) {
                if (entries.size >= maxKeys) entries.delete(entries.keys().next().value);
                e = { count: 0, until: now + windowMs };
            }
            e.count++;
            entries.set(key, e);
        },
        reset(key) { entries.delete(key); },
    };
}

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = { isPrivateAddress, clientIp, isUploadId, isBatchId, isFileId, randomName, randomSuffix, failureLimiter, sha256 };
