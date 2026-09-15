'use strict';

const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────
//
// One JSONL file per month, under files_web/logs. Splitting by month means
// pruning old data is just "delete whole files older than retention" — no
// need to parse/rewrite anything, and it plays nice with `grep`/`less` if
// you ever need to look something up by hand.

const FILES_WEB_DIR = process.env.CLEANUP_FILES_WEB_DIR || path.join(__dirname, '../files_web');
const LOG_DIR = path.join(FILES_WEB_DIR, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Retention window: 4 months.
const LOG_RETENTION_MS = 4 * 30 * 24 * 60 * 60 * 1000;

// ─── Header helpers ─────────────────────────────────────────────────────────

// CF-Connecting-IP is set by Cloudflare itself and can't be spoofed by the
// client (Cloudflare overwrites it even if the client sends its own), so it
// is preferred over X-Forwarded-For, which req.ip/Express derives from and
// which a direct-to-origin request could forge if it ever bypassed CF.
function getClientIp(req) {
    return req.headers['cf-connecting-ip']
        || req.ip
        || (req.connection && req.connection.remoteAddress)
        || null;
}

function getClientCountry(req) {
    return req.headers['cf-ipcountry'] || null;
}

function getCfRay(req) {
    return req.headers['cf-ray'] || null;
}

function getReferer(req) {
    return req.headers['referer'] || req.headers['referrer'] || null;
}

// ─── Log file I/O ───────────────────────────────────────────────────────────

function logFilePathFor(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    return path.join(LOG_DIR, `uploads-${y}-${m}.jsonl`);
}

// event: 'init' | 'chunk_error' | 'complete' | 'failed' | 'deleted_manual' | 'auth_fail' ...
// data: whatever's relevant for that event (filename, size, mimeType, expiresAt, fileId, ownerUsername, ...)
function logEvent(req, event, data = {}) {
    const entry = {
        time: new Date().toISOString(),
        event,
        ip: getClientIp(req),
        country: getClientCountry(req),
        cfRay: getCfRay(req),
        referer: getReferer(req),
        ...data
    };
    try {
        fs.appendFileSync(logFilePathFor(new Date()), JSON.stringify(entry) + '\n');
    } catch (err) {
        console.error('⚠️  [REQUEST LOG] Failed to write log entry:', err.message);
    }
}

// Called from cleanup.js's periodic run. Deletes whole monthly log files
// once they're older than the retention window (4 months). A monthly file
// is treated as "closed" at the start of the following month, so e.g. the
// March 2026 file gets deleted once we're more than 4 months past April 1st.
function pruneOldLogs() {
    if (!fs.existsSync(LOG_DIR)) return { deleted: 0 };
    const now = Date.now();
    let deleted = 0;
    for (const file of fs.readdirSync(LOG_DIR)) {
        const m = file.match(/^uploads-(\d{4})-(\d{2})\.jsonl$/);
        if (!m) continue;
        const year = parseInt(m[1], 10);
        const month = parseInt(m[2], 10); // 1-indexed
        const closedAt = Date.UTC(year, month, 1); // first day of the *next* month
        if (now - closedAt > LOG_RETENTION_MS) {
            try {
                fs.unlinkSync(path.join(LOG_DIR, file));
                deleted++;
                console.log(`  🗑️  Deleted expired request log: ${file}`);
            } catch (e) {
                console.error(`  ⚠️  Failed to delete log ${file}:`, e.message);
            }
        }
    }
    return { deleted };
}

module.exports = { logEvent, getClientIp, getClientCountry, getCfRay, getReferer, pruneOldLogs };
