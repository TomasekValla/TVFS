'use strict';

const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────
//
// One JSONL file per month in the data folder (outside the web root, see paths.js).
// Splitting by month means pruning old data is just "delete whole files older than
// retention" — no need to parse/rewrite anything.

const paths = require('./paths');
const security = require('./security');
paths.migrateFromWebRoot();
const LOG_DIR = paths.LOG_DIR;
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Hard limits so anonymous traffic cannot grow the log without bound
const MAX_FIELD_CHARS = 200;
const MAX_LINE_BYTES = 4096;
const MAX_MONTH_FILE_BYTES = 50 * 1024 * 1024;

// Retention window: 4 months.
const LOG_RETENTION_MS = 4 * 30 * 24 * 60 * 60 * 1000;

// ─── Header helpers ─────────────────────────────────────────────────────────

// CF-Connecting-IP only when the request came through our own proxy (see security.js)
function getClientIp(req) {
    return req && req.socket ? security.clientIp(req) : null;
}

function getClientCountry(req) {
    return req.headers['cf-ipcountry'] || null;
}

function getCfRay(req) {
    return req.headers['cf-ray'] || null;
}

function getReferer(req) {
    const r = req.headers['referer'] || req.headers['referrer'] || null;
    return r ? String(r).slice(0, MAX_FIELD_CHARS) : null;
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
    for (const [k, v] of Object.entries(entry)) {
        if (typeof v === 'string' && v.length > MAX_FIELD_CHARS) entry[k] = v.slice(0, MAX_FIELD_CHARS);
    }
    let line = JSON.stringify(entry);
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) line = JSON.stringify({ time: entry.time, event: entry.event, ip: entry.ip, truncated: true });
    writeLine(logFilePathFor(new Date()), line + '\n');
}

// Appends asynchronously and in order (never blocks a request). A month file that
// reached the size cap gets one marker line, then further events are dropped.
let writeChain = Promise.resolve();
const fullFiles = new Set();
function writeLine(file, text) {
    writeChain = writeChain.then(async () => {
        if (fullFiles.has(file)) return;
        let size = 0;
        try { size = (await fs.promises.stat(file)).size; } catch (e) {}
        if (size + Buffer.byteLength(text) > MAX_MONTH_FILE_BYTES) {
            fullFiles.add(file);
            text = JSON.stringify({ time: new Date().toISOString(), event: 'log_full', note: 'size cap reached, further events of this month are dropped' }) + '\n';
        }
        await fs.promises.appendFile(file, text);
    }).catch(err => console.error('⚠️  [REQUEST LOG] Failed to write log entry:', err.message));
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
