'use strict';

const fs = require('fs');
const path = require('path');
const { sanitizeUsername } = require('./userIdentity');

// ─── Config ───────────────────────────────────────────────────────────────

// Per-user history lives in the data folder, outside the web root (see paths.js)
const paths = require('./paths');
paths.migrateFromWebRoot();
const USERS_DIR = paths.USERS_DIR;
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });

const MAX_LOG_ENTRIES = 300;           // how far back a device can "catch up" via diff
const ENTRY_MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000; // the longest retention (tier 3: 30 days) plus a day

function userFilePath(username) {
    return path.join(USERS_DIR, `${sanitizeUsername(username)}.json`);
}

// ─── I/O (synchronous, atomic — this file is small and touched by both the
// long-running upload.js process AND the separate cleanup.js cron script,
// so we can't rely on in-memory debouncing shared between them) ───────────

// Parsed states cached by file mtime: the status poll of every open tab asks for the version
const stateCache = new Map(); // path -> { mtimeMs, json }

function loadUserState(username) {
    const p = userFilePath(username);
    let stat;
    try { stat = fs.statSync(p); } catch { return { version: 0, files: [], log: [] }; } // no history yet
    const cached = stateCache.get(p);
    if (cached && cached.mtimeMs === stat.mtimeMs) return JSON.parse(cached.json);
    try {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.files)) parsed.files = [];
        if (!Array.isArray(parsed.log)) parsed.log = [];
        if (typeof parsed.version !== 'number') parsed.version = 0;
        stateCache.set(p, { mtimeMs: stat.mtimeMs, json: JSON.stringify(parsed) });
        return parsed;
    } catch (err) {
        // Keep the unreadable file for a look instead of silently starting over on the next write
        const kept = `${p}.corrupt-${Date.now()}`;
        try { fs.renameSync(p, kept); } catch (e) {}
        console.error(`❌ [USER SYNC] Unreadable history for ${username} (${err.message}), kept as ${path.basename(kept)}`);
        return { version: 0, files: [], log: [] };
    }
}

function saveUserStateSync(username, state) {
    const p = userFilePath(username);
    const tmp = p + '.tmp';
    try {
        const json = JSON.stringify(state, null, 2);
        fs.writeFileSync(tmp, json);
        fs.renameSync(tmp, p);
        stateCache.set(p, { mtimeMs: fs.statSync(p).mtimeMs, json });
    } catch (err) {
        console.error(`❌ [USER SYNC] Failed to save state for ${username}:`, err.message);
    }
}

// ─── Mutations ────────────────────────────────────────────────────────────

// entry: { id, name, link, category, size, uploadedAt, expiresAt, thumbnail }
function recordUpload(username, entry) {
    if (!username) return;
    const state = loadUserState(username);
    state.version += 1;
    state.files.unshift(entry);
    state.log.push({ v: state.version, type: 'add', entry });
    if (state.log.length > MAX_LOG_ENTRIES) state.log = state.log.slice(-MAX_LOG_ENTRIES);
    saveUserStateSync(username, state);
}

// Called by cleanup.js when a file expires/is deleted, so every synced
// device eventually finds out a card should disappear.
function recordRemoval(username, fileId) {
    if (!username) return;
    const state = loadUserState(username);
    const hadFile = state.files.some(f => f.id === fileId);
    state.files = state.files.filter(f => f.id !== fileId);
    if (hadFile) {
        state.version += 1;
        state.log.push({ v: state.version, type: 'remove', fileId });
        if (state.log.length > MAX_LOG_ENTRIES) state.log = state.log.slice(-MAX_LOG_ENTRIES);
    }
    saveUserStateSync(username, state);
}

// Attach/patch a thumbnail URL once server-side generation finishes
// (thumbnail generation happens async, after the upload response already
// went out — see thumbnails.js).
function patchThumbnail(username, fileId, thumbnailUrl) {
    if (!username) return;
    const state = loadUserState(username);
    const file = state.files.find(f => f.id === fileId);
    if (!file) return;
    file.thumbnail = thumbnailUrl;
    // Bump version so other devices' next diff picks up the thumbnail too.
    state.version += 1;
    state.log.push({ v: state.version, type: 'add', entry: file }); // 'add' = upsert semantics client-side
    if (state.log.length > MAX_LOG_ENTRIES) state.log = state.log.slice(-MAX_LOG_ENTRIES);
    saveUserStateSync(username, state);
}

// Changes fields of one entry (e.g. a new expiry) and lets the other devices pick it up
function patchEntry(username, fileId, fields) {
    if (!username) return;
    const state = loadUserState(username);
    const file = state.files.find(f => f.id === fileId);
    if (!file) return;
    Object.assign(file, fields);
    state.version += 1;
    state.log.push({ v: state.version, type: 'add', entry: file }); // 'add' = upsert client-side
    if (state.log.length > MAX_LOG_ENTRIES) state.log = state.log.slice(-MAX_LOG_ENTRIES);
    saveUserStateSync(username, state);
}

// Prune entries older than the retention window so the per-user file (and the
// log) doesn't grow forever. Call this from cleanup.js's periodic run.
function pruneOldEntries(username) {
    const state = loadUserState(username);
    const cutoff = Date.now() - ENTRY_MAX_AGE_MS;
    const before = state.files.length;
    state.files = state.files.filter(f => f.uploadedAt && f.uploadedAt > cutoff);
    if (state.files.length !== before) {
        saveUserStateSync(username, state);
    }
}

function pruneAllUsers() {
    if (!fs.existsSync(USERS_DIR)) return;
    for (const file of fs.readdirSync(USERS_DIR)) {
        if (!file.endsWith('.json')) continue;
        const username = file.replace(/\.json$/, '');
        try { pruneOldEntries(username); } catch (e) {}
    }
}

// ─── Reads ────────────────────────────────────────────────────────────────

function getVersion(username) {
    if (!username) return 0;
    return loadUserState(username).version;
}

function getFullList(username) {
    if (!username) return { version: 0, files: [] };
    const state = loadUserState(username);
    return { version: state.version, files: state.files };
}

// Returns { resync: true } if the client is too far behind (log doesn't go
// back far enough) — caller should then fall back to getFullList().
function getDiffSince(username, sinceVersion) {
    const state = loadUserState(username);
    if (!Number.isFinite(sinceVersion) || sinceVersion <= 0) {
        return { resync: true, version: state.version };
    }
    if (sinceVersion >= state.version) {
        return { resync: false, version: state.version, ops: [] };
    }
    const earliestLogged = state.log.length ? state.log[0].v - 1 : state.version;
    if (sinceVersion < earliestLogged) {
        return { resync: true, version: state.version };
    }
    const ops = state.log.filter(e => e.v > sinceVersion);
    return { resync: false, version: state.version, ops };
}

module.exports = {
    patchEntry,
    recordUpload,
    recordRemoval,
    patchThumbnail,
    pruneOldEntries,
    pruneAllUsers,
    getVersion,
    getFullList,
    getDiffSince
};
