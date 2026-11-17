const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
let archiver = require('archiver');
if (archiver.default) {
    archiver = archiver.default;
}
const router = express.Router();

const { findUser, currentUser, nextPragueMidnight, HOST_USERNAME } = require('./userIdentity');
const userSync = require('./userSync');
const thumbnails = require('./thumbnails');
const requestLogger = require('./requestLogger');
const audioPlayerLib = require('./audioPlayer');
const safeFs = require('./safeFs');
const appOffer = require('./appOffer');
const security = require('./security');
const mediaQueue = require('./mediaQueue');
const limits = require('./limits');
const expiredPages = require('./expiredPages');
const userSettings = require('./userSettings');
const stats = require('./stats');
const paths = require('./paths');
paths.migrateFromWebRoot();

// ─── Session Store ───────────────────────────────────────────────────────────
//
// Sessions are random 32-byte hex tokens mapped to { tier, expiresAt }.
// The cookie contains ONLY the random token — never a password hash.
// This means:
//   • Stolen cookie cannot be used to derive or verify the password.
//   • Sessions can be invalidated server-side (logout, expiry).
//   • No credential material ever touches logs or network after /api/auth.

// Keyed by sha256(token): a copy of sessions.json is not a set of working logins.
const sessions = new Map(); // sha256(token) → { tier, username, expiresAt, remember, fp }
const tokenKey = token => crypto.createHash('sha256').update(String(token)).digest('hex');

// ─── Session persistence ─────────────────────────────────────────────────
//
// Sessions can now live up to a year (see SESSION_REMEMBER_MS below), so
// them living ONLY in memory would defeat the entire point — any server
// restart (deploy, crash, reboot) would silently log everyone out despite
// "stay logged in" having been chosen. Persisted to protected_storage,
// same atomic tmp+rename pattern used everywhere else in this codebase.
//
// Deliberately NOT hooked into SIGTERM/SIGINT here. An earlier version of
// this did that, and registering a SIGTERM/SIGINT listener without calling
// process.exit() inside it overrides Node's default "just terminate"
// behavior — which caused PM2 restarts to hang and get force-SIGKILLed
// instead of exiting cleanly. Not worth that risk for the sub-2-second
// window of session changes it would protect; every create/delete already
// debounce-saves on its own.
const SESSIONS_DIR  = path.join(__dirname, 'protected_storage');
const SESSIONS_PATH = path.join(SESSIONS_DIR, 'sessions.json');
const SESSIONS_TMP  = SESSIONS_PATH + '.tmp';
let sessionsSaveTimer = null;

function loadSessions() {
    try {
        const raw = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
        const now = Date.now();
        let loaded = 0, skippedExpired = 0;
        // v2 = keys are already token hashes; the older file kept raw tokens, which are hashed once here
        const hashed = raw && raw.v === 2;
        for (const [key, session] of Object.entries(hashed ? raw.sessions || {} : raw || {})) {
            if (!session || typeof session.expiresAt !== 'number') continue;
            if (session.expiresAt <= now) { skippedExpired++; continue; }
            sessions.set(hashed ? key : tokenKey(key), session);
            loaded++;
        }
        if (!hashed && loaded) saveSessions();
        console.log(`🔐 Sessions restored: ${loaded} active${skippedExpired ? `, ${skippedExpired} already expired` : ''}`);
    } catch {
        console.log('🔐 Sessions store initialized (empty or not found)');
    }
}

function _writeSessionsAtomic() {
    try {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        fs.writeFileSync(SESSIONS_TMP, JSON.stringify({ v: 2, sessions: Object.fromEntries(sessions) }));
        fs.renameSync(SESSIONS_TMP, SESSIONS_PATH);
    } catch (err) {
        console.error('❌ Failed to save sessions:', err.message);
    }
}
function saveSessions() { clearTimeout(sessionsSaveTimer); sessionsSaveTimer = setTimeout(_writeSessionsAtomic, 2000); }
function saveSessionsSync() { clearTimeout(sessionsSaveTimer); _writeSessionsAtomic(); }

loadSessions();

// Clean expired sessions every 10 minutes
// .unref(): this module is now also require()'d by cleanup.js's short-lived
// cron process (protectedShare.js pulls in authenticateRequest from here)
// — without .unref(), that process would never exit, and cron would pile
// up a new hung process every run.
setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [token, session] of sessions) {
        if (now > session.expiresAt) { sessions.delete(token); removed++; }
    }
    if (removed > 0) saveSessions();
}, 10 * 60 * 1000).unref();

// "Stay logged in" is now a yes/no choice, not a duration picker:
//   remember = true  → persistent cookie, up to a year
//   remember = false → browser-session cookie (no Max-Age at all) PLUS a
//                       24h server-side absolute cap as a safety net, since
//                       "session" cookies can outlive the browser tab in
//                       PWA/installed-app contexts where "closing the
//                       browser" isn't really a well-defined event.
const SESSION_REMEMBER_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const SESSION_SINGLE_MS   = 24 * 60 * 60 * 1000;        // 24 hours

// The shared tier 0 "host" login always ends at the next midnight (Prague), whatever was chosen
function sessionEnd(tier, remember) {
    if (tier === 0) return nextPragueMidnight();
    return Date.now() + (remember ? SESSION_REMEMBER_MS : SESSION_SINGLE_MS);
}

function createSession(tier, username, remember) {
    const token = crypto.randomBytes(32).toString('hex');
    const user = currentUser(username);
    sessions.set(tokenKey(token), { tier, username, expiresAt: sessionEnd(tier, remember), remember: !!remember && tier > 0, fp: user ? user.fingerprint : null });
    saveSessions();
    return token;
}

// Sets tvfs_token (httpOnly) + tvfs_tier (JS-readable) cookies for a login,
// honoring the same `remember` semantics as createSession(). Shared by
// /api/auth (main site login) and protectedShare.js's /:id/login (viewing
// a TVFS Users Only share can ALSO offer to remember you site-wide,
// instead of only granting access to that one share) — one place decides
// what a "remembered" login actually means.
function issueLoginCookie(res, tier, username, remember) {
    const sessionToken = createSession(tier, username, remember);
    const baseOpts = { httpOnly: true, path: '/', sameSite: 'lax', secure: true };
    if (tier === 0) baseOpts.expires = new Date(nextPragueMidnight()); // host: until midnight
    else if (remember) baseOpts.maxAge = SESSION_REMEMBER_MS; // persistent
    // else: no maxAge/expires set at all → true browser-session cookie
    res.cookie('tvfs_token', sessionToken, baseOpts);
    res.cookie('tvfs_tier', String(tier), { ...baseOpts, httpOnly: false });
    return sessionToken;
}

// A session lives only while its user is still in .env with the same credentials; the tier
// always comes from the current list (a demoted user loses rights at once).
function getSession(token) {
    if (!token || typeof token !== 'string') return null;
    const key = tokenKey(token);
    const session = sessions.get(key);
    if (!session) return null;
    const user = currentUser(session.username);
    if (Date.now() > session.expiresAt || !user || (session.fp && session.fp !== user.fingerprint)) {
        sessions.delete(key);
        saveSessions();
        return null;
    }
    if (!session.fp) { session.fp = user.fingerprint; saveSessions(); } // sessions from before fingerprints
    if (session.tier !== user.tier) { session.tier = user.tier; saveSessions(); }
    return session;
}

function deleteSession(token) {
    if (sessions.delete(tokenKey(token))) saveSessions();
}

// Every session of one user (log out on all devices)
function deleteUserSessions(username) {
    let n = 0;
    for (const [key, s] of sessions) if (s.username === username) { sessions.delete(key); n++; }
    if (n) saveSessions();
    return n;
}

// ─── Cookie Auth Helper ──────────────────────────────────────────────────────

// Session cookie only. Credentials in a request body are accepted solely by the
// login routes (/auth, /verify-password and the Users Only login), which are rate limited.
function authenticateRequest(req) {
    const token = req.cookies && req.cookies.tvfs_token;
    if (token) {
        const session = getSession(token);
        if (session) {
            // Strangers share the host login: each host session owns only its own uploads
            const ownerKey = session.tier === 0 ? `host:${tokenKey(token).slice(0, 16)}` : `user:${session.username}`;
            return { valid: true, tier: session.tier, username: session.username, ownerKey, isHost: session.tier === 0 };
        }
    }
    return { valid: false, tier: -1, username: null, ownerKey: null };
}

// Rejects before any body is read (multer would otherwise write the whole upload to disk first)
function requireSession(req, res, next) {
    const auth = authenticateRequest(req);
    if (!auth.valid) {
        res.set('Connection', 'close');
        return res.status(403).json({ error: 'Not logged in' });
    }
    req.auth = auth;
    mediaQueue.enterPriority(limits.MEDIA_PRIORITY[auth.tier] || 0);
    next();
}

// Failed logins per client address and per username; a success clears both.
const loginFailuresByIp = security.failureLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const loginFailuresByUser = security.failureLimiter({ windowMs: 15 * 60 * 1000, max: 20 });

function checkLogin(req, res, username, password) {
    const ipKey = security.clientIp(req);
    const userKey = security.sha256(String(username).trim().toLowerCase());
    const wait = Math.max(loginFailuresByIp.retryAfter(ipKey), loginFailuresByUser.retryAfter(userKey));
    if (wait > 0) {
        res.set('Retry-After', wait);
        res.status(429).json({ valid: false, error: 'Too many failed attempts, try again later' });
        return { blocked: true, user: null };
    }
    const user = findUser(username, password);
    if (user) {
        loginFailuresByIp.reset(ipKey);
        loginFailuresByUser.reset(userKey);
    } else {
        loginFailuresByIp.fail(ipKey);
        loginFailuresByUser.fail(userKey);
    }
    return { blocked: false, user };
}

// ─── Rate Limiting (in-memory, per client address) ───────────────────────────

const rateLimits = new Map();

function rateLimit({ windowMs = 1000, max = 10, keyPrefix = '' } = {}) {
    return (req, res, next) => {
        const ip = security.clientIp(req);
        const key = keyPrefix + ip;
        const now = Date.now();
        const entry = rateLimits.get(key) || { count: 0, resetTime: now + windowMs };

        if (now > entry.resetTime) {
            entry.count = 0;
            entry.resetTime = now + windowMs;
        }
        entry.count++;
        rateLimits.set(key, entry);

        if (entry.count > max) {
            const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
            res.set('Retry-After', retryAfter);
            return res.status(429).json({ error: 'Too many requests, try again in a moment' });
        }
        next();
    };
}

// Clean up old rate limit entries every 30 seconds
setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of rateLimits) {
        if (now > e.resetTime + 60000) rateLimits.delete(ip);
    }
}, 30000).unref();

// Expiry rules per tier: see limits.js

// ─── Directories ─────────────────────────────────────────────────────────────

const baseDir = paths.FILES_DIR;
const dirs = {
    pictures: path.join(baseDir, 'pictures'),
    videos: path.join(baseDir, 'videos'),
    audio: path.join(baseDir, 'audio'),
    download: path.join(baseDir, 'download'),
    batch: path.join(baseDir, 'batch'),
    text: path.join(baseDir, 'text'),
    players: path.join(baseDir, 'players'),
    chunks: path.join(__dirname, 'temp_chunks'),
    // single-request uploads land here (not web-served) until login and type are checked
    incoming: path.join(__dirname, 'temp_chunks', 'incoming')
};

Object.values(dirs).forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── File Registry ───────────────────────────────────────────────────────────
//
// Atomic write: data goes to a temp file first, then renamed into place.
// This prevents corruption if the process crashes mid-write.

// In the data folder, outside the web root (see paths.js)
const REGISTRY_PATH = paths.REGISTRY_PATH;
const REGISTRY_TMP  = REGISTRY_PATH + '.tmp';

let registry = { files: [], batches: [] };
let registrySaveTimer = null;

function loadRegistry() {
    try {
        registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
        if (!Array.isArray(registry.files)) registry.files = [];
        if (!Array.isArray(registry.batches)) registry.batches = [];
        console.log(`📋 Registry loaded: ${registry.files.length} files, ${registry.batches.length} batches`);
    } catch {
        registry = { files: [], batches: [] };
        console.log('📋 Registry initialized (empty or not found)');
    }
}

function _writeRegistryAtomic() {
    try {
        fs.writeFileSync(REGISTRY_TMP, JSON.stringify(registry, null, 2));
        fs.renameSync(REGISTRY_TMP, REGISTRY_PATH);
    } catch (err) {
        console.error('❌ Failed to save registry:', err.message);
    }
}

function saveRegistry() {
    clearTimeout(registrySaveTimer);
    registrySaveTimer = setTimeout(_writeRegistryAtomic, 2000);
}

function saveRegistrySync() {
    clearTimeout(registrySaveTimer);
    _writeRegistryAtomic();
}

// True if any registry entry other than `exceptEntry` still points at filePath.
// Guards every unlink: entries created before the no-clobber fix may share a path.
function isPathReferenced(filePath, exceptEntry = null) {
    return registry.files.some(f => f !== exceptEntry && f.path === filePath);
}

// Load registry on startup
loadRegistry();

// Heartbeat: while it is fresh the cron cleanup stays idle, because this process runs the
// cleanup itself on its in-memory registry (one writer, see cleanup.js startInProcess)
function touchHeartbeat() {
    try { fs.writeFileSync(paths.HEARTBEAT_PATH, String(process.pid)); } catch (e) {}
}

// Read and write access to the live registry for the in-process cleanup
// ─── Expiry, 410 pages and the emergency eviction (called by the in-process cleanup) ───

const ownerUsername = file => (file.ownerKey && file.ownerKey.startsWith('user:') ? file.ownerKey.slice(5) : null);

function tierOf(file) {
    if (typeof file.ownerTier === 'number') return file.ownerTier;
    if (file.ownerKey && file.ownerKey.startsWith('host:')) return 0;
    const u = ownerUsername(file) ? currentUser(ownerUsername(file)) : null;
    return u ? u.tier : 1;
}

// A file is gone (expired or removed early): its link answers 410 for as long as the owner chose,
// and Recently uploaded shows it as expired until they remove it there.
function markGone(file, early) {
    const username = ownerUsername(file);
    const months = username ? userSettings.get(username).expiredPageMonths : 0;
    expiredPages.add(file, early ? Math.max(1, months) : months, early);
    if (!username) return;
    if (months > 0 || early) userSync.patchEntry(username, file.id, { expired: true, expiredAt: Date.now(), ...(early ? { removedEarly: true } : {}) });
    else userSync.recordRemoval(username, file.id);
}

// Only when free space fell below the reserve: tier 0 first, then 1 (oldest, then biggest), then 2; never 3
function evictIfFull() {
    const free = limits.freeBytes();
    if (free === null || free >= limits.RESERVE_BYTES) return 0;
    const target = limits.RESERVE_BYTES + 512 * 1024 * 1024;
    const victims = registry.files
        .filter(f => !f.isTextReader && !f.isMdReader && !f.isAudioPlayer && tierOf(f) < 3)
        .sort((a, b) => tierOf(a) - tierOf(b) || (a.uploadedAt || 0) - (b.uploadedAt || 0) || (b.size || 0) - (a.size || 0));
    let removed = 0;
    for (const f of victims) {
        const now = limits.freeBytes();
        if (now === null || now >= target) break;
        removeFile(f, 'evicted');
        markGone(f, true);
        removed++;
    }
    if (removed) console.warn(`⚠️  [EVICT] Disk below the reserve: removed ${removed} file(s) early`);
    return removed;
}

const registryAccess = {
    get: () => registry,
    saveSync: () => saveRegistrySync(),
    heartbeat: touchHeartbeat,
    hooks: { onExpired: file => markGone(file, false), evict: () => evictIfFull(), prune: () => { expiredPages.prune(); stats.prune(new Set(registry.files.map(f => f.id))); } },
};

// ─── Manifest Mutex (for chunk uploads) ──────────────────────────────────────

const manifestMutexes = new Map();

async function withManifestLock(uploadId, fn) {
    if (!manifestMutexes.has(uploadId)) {
        manifestMutexes.set(uploadId, Promise.resolve());
    }
    const prev = manifestMutexes.get(uploadId);
    let release;
    const next = new Promise(r => { release = r; });
    manifestMutexes.set(uploadId, prev.then(() => next));
    await prev;
    try {
        return await fn();
    } finally {
        release();
    }
}

function writeManifest(uploadId, data) {
    if (!security.isUploadId(uploadId)) throw new Error('invalid upload id');
    const manifestPath = path.join(dirs.chunks, `${uploadId}_manifest.json`);
    const tmpPath = manifestPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data)); // compact: this is rewritten on EVERY chunk, pretty-printing a 10k+ entry receivedChunks array was pure overhead
    fs.renameSync(tmpPath, manifestPath);
}

function readManifest(uploadId) {
    if (!security.isUploadId(uploadId)) return null;
    const manifestPath = path.join(dirs.chunks, `${uploadId}_manifest.json`);
    if (!fs.existsSync(manifestPath)) return null;
    try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!m || !Array.isArray(m.receivedChunks)) return null;
        return m;
    } catch (e) {
        console.error(`⚠️  [MANIFEST] Unreadable manifest for ${uploadId}:`, e.message);
        return null;
    }
}

// Wipes every chunk + the manifest for a given uploadId. Used by the
// explicit "Kill" / "Delete not-finished upload" actions, where a user
// wants the remains gone immediately instead of waiting for the hourly
// >24h sweep to eventually catch it.
function deleteChunksAndManifest(uploadId) {
    let removedChunks = 0;
    if (!security.isUploadId(uploadId)) return 0;
    try {
        for (const file of fs.readdirSync(dirs.chunks)) {
            if (file === `${uploadId}_manifest.json` || file.startsWith(`${uploadId}_chunk_`)) {
                try {
                    fs.unlinkSync(path.join(dirs.chunks, file));
                    if (file.startsWith(`${uploadId}_chunk_`)) removedChunks++;
                } catch (e) {}
            }
        }
    } catch (e) {}
    return removedChunks;
}

// ─── Assembly Guard — prevents double-assembly race ──────────────────────────

const assemblyInProgress = new Set();

// ─── Browser-Friendly Types ─────────────────────────────────────────────────

// SVG is not on the list: it can carry scripts, so it is stored as a download (attachment)
const browserFriendlyTypes = {
    image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/avif'],
    video: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'],
    audio: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/opus', 'audio/webm',
        'audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/flac', 'audio/x-flac']
};

function isBrowserFriendly(mimetype, category) {
    return browserFriendlyTypes[category] && browserFriendlyTypes[category].includes(mimetype);
}

// ─── Category Helpers ────────────────────────────────────────────────────────

// nginx picks the Content-Type from the extension, so an inline folder only takes
// extensions that are served as that media type. Anything else is a download.
const INLINE_EXTENSIONS = {
    pictures: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'],
    videos: ['.mp4', '.m4v', '.webm', '.ogv', '.ogg', '.mov'],
    audio: ['.mp3', '.wav', '.ogg', '.oga', '.opus', '.webm', '.weba', '.aac', '.m4a', '.mp4', '.flac'],
    text: ['.md', '.markdown', '.txt'],
};

function getDestDir(mimeType, filename) {
    mimeType = typeof mimeType === 'string' ? mimeType : '';
    const ext = path.extname(String(filename || '')).toLowerCase();
    const allowed = (folder) => INLINE_EXTENSIONS[folder].includes(ext);
    const type = mimeType.split('/')[0];
    if (type === 'image' && isBrowserFriendly(mimeType, 'image') && allowed('pictures')) return dirs.pictures;
    if (type === 'video' && isBrowserFriendly(mimeType, 'video') && allowed('videos')) return dirs.videos;
    if (type === 'audio' && isBrowserFriendly(mimeType, 'audio') && allowed('audio')) return dirs.audio;
    if (mimeType === 'text/markdown' && allowed('text')) return dirs.text;
    return dirs.download;
}

// Client-sent MIME type, reduced to a plain `type/subtype` (no parameters, no junk)
function cleanMimeType(raw) {
    const m = /^([a-z0-9][a-z0-9.+-]{0,63})\/([a-z0-9][a-z0-9.+-]{0,127})/i.exec(String(raw || '').trim());
    return m ? `${m[1]}/${m[2]}`.toLowerCase() : 'application/octet-stream';
}

function getDirCategory(destDir) {
    if (destDir === dirs.pictures) return 'pictures';
    if (destDir === dirs.videos) return 'videos';
    if (destDir === dirs.audio) return 'audio';
    if (destDir === dirs.batch) return 'batch';
    if (destDir === dirs.text) return 'text';
    return 'download';
}

function getFileType(mimeType) {
    const type = String(mimeType || '').split('/')[0];
    if (type === 'video') return 'video';
    if (type === 'audio') return 'audio';
    if (type === 'image') return 'image';
    return 'file';
}

// Voice note flag from a request: true / 'true' / '1' / 1, and only for audio
function wantsVoiceNote(raw, mimeType) {
    const on = raw === true || raw === 1 || raw === 'true' || raw === '1';
    return on && getFileType(mimeType || '') === 'audio';
}

// The styled link of an audio upload
function audioStyledLink(result, originalName, link) {
    if (result.voiceNote) return `[Voice note - TVFS Voice Player](${link})`;
    return `[${originalName} - TVFS Audio Player (${audioPlayerLib.formatMetaSummary(result.meta) || 'details n/a'})](${link})`;
}

function generateFileId() {
    return `f_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function generateBatchId() {
    return `batch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function generateReaderId() {
    return crypto.randomBytes(6).toString('hex');
}

// ─── Font katalog ───────────────────────────────────────────────────────
// Fonty se NEdeklarují @font-face ručně v readeru — místo toho se linkuje
// jeden hostovaný fonts.css (viz fonts_download.py níž), protože japonské
// fonty se dělí do desítek unicode-range kousků a to je potřeba mít
// vygenerované správně na jednom místě, ne kopírovat ručně.
const FONTS_BASE_URL = 'https://files.tomasekvalla.cz/fonts';
const FONTS_CSS_URL = FONTS_BASE_URL + '/fonts.css';

const READER_FONTS = [
    { id: 'default',     label: 'Výchozí',              short: 'Default',   stack: null },
    // moderní sans
    { id: 'inter',       label: 'Inter',                short: 'Inter',     stack: "'Inter',sans-serif" },
    { id: 'manrope',     label: 'Manrope',              short: 'Manrope',   stack: "'Manrope',sans-serif" },
    { id: 'sora',        label: 'Sora',                 short: 'Sora',      stack: "'Sora',sans-serif" },
    { id: 'spacegrotesk',label: 'Space Grotesk',        short: 'SpaceGrot.',stack: "'Space Grotesk',sans-serif" },
    { id: 'outfit',      label: 'Outfit',                short: 'Outfit',    stack: "'Outfit',sans-serif" },
    { id: 'jakarta',     label: 'Plus Jakarta Sans',     short: 'Jakarta',   stack: "'Plus Jakarta Sans',sans-serif" },
    { id: 'poppins',     label: 'Poppins',               short: 'Poppins',   stack: "'Poppins',sans-serif" },
    // klasické / staré serify
    { id: 'lora',        label: 'Lora',                 short: 'Lora',      stack: "'Lora',serif" },
    { id: 'merriweather',label: 'Merriweather',         short: 'Merri.',    stack: "'Merriweather',serif" },
    { id: 'ptserif',     label: 'PT Serif',             short: 'PT Serif',  stack: "'PT Serif',serif" },
    { id: 'garamond',    label: 'EB Garamond',          short: 'Garamond',  stack: "'EB Garamond',serif" },
    // dyslexia-friendly
    { id: 'atkinson',    label: 'Atkinson Hyperlegible', short: 'Atkinson', stack: "'Atkinson Hyperlegible',sans-serif" },
    { id: 'lexend',      label: 'Lexend',               short: 'Lexend',    stack: "'Lexend',sans-serif" },
    { id: 'opendyslexic',label: 'OpenDyslexic',         short: 'OpenDys',   stack: "'OpenDyslexic',sans-serif" },
    // monospace
    { id: 'jetbrains',   label: 'JetBrains Mono',       short: 'JB Mono',   stack: "'JetBrains Mono',monospace" },
    { id: 'spacemono',   label: 'Space Mono',           short: 'SpaceMono', stack: "'Space Mono',monospace" },
    // hravé
    { id: 'quicksand',   label: 'Quicksand',            short: 'Quicksand', stack: "'Quicksand',sans-serif" },
    // japonština (kana + kanji)
    { id: 'notosansjp',  label: 'Noto Sans JP',         short: 'NotoJP',    stack: "'Noto Sans JP',sans-serif" },
    { id: 'notoserifjp', label: 'Noto Serif JP',        short: 'NotoSerJP', stack: "'Noto Serif JP',serif" },
    { id: 'mplusrounded',label: 'M PLUS Rounded 1c',    short: 'MPlusR',    stack: "'M PLUS Rounded 1c',sans-serif" },
];

// ─── Sdílený toolbar chrome ─────────────────────────────────────────────
// defaultFontStack: čím čtečka defaultně vykresluje text (Georgia serif
// pro txt reader, systémový sans pro md reader), použije se pro
// READER_FONTS[0] (id 'default').
function buildReaderChromeCss() {
    return `
.toolbar{position:sticky;top:0;z-index:50;background:rgba(17,17,17,.92);backdrop-filter:blur(12px);border-bottom:1px solid var(--border,rgba(255,255,255,.08));display:flex;flex-direction:column;}
.tb-title-row{overflow:hidden;max-height:32px;opacity:1;padding:10px 20px 0;transition:max-height .35s cubic-bezier(.4,0,.2,1),opacity .25s ease,padding .3s ease;}
.tb-title-full{font-size:.8rem;font-weight:700;color:var(--accent);white-space:nowrap;overflow:hidden;font-family:monospace;}
.tb-title-full .mq-inner{display:inline-block;white-space:nowrap;}
.tb-title-full.marquee{-webkit-mask-image:linear-gradient(to right,transparent,black 3%,black 97%,transparent);mask-image:linear-gradient(to right,transparent,black 3%,black 97%,transparent);}
.tb-title-full.marquee .mq-inner{animation:mq-scroll var(--mq-duration,14s) ease-in-out infinite;}
.tb-controls-row{display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 20px;flex-wrap:wrap;}
.tb-title-mini{display:none;flex:1;min-width:0;overflow:hidden;margin-right:4px;}
.tb-title-mini-inner{white-space:nowrap;font-size:.68rem;font-weight:700;color:var(--accent);font-family:monospace;display:inline-block;}
.tb-title-mini.marquee{-webkit-mask-image:linear-gradient(to right,transparent,black 4%,black 96%,transparent);mask-image:linear-gradient(to right,transparent,black 4%,black 96%,transparent);}
.tb-title-mini.marquee .tb-title-mini-inner{animation:mq-scroll var(--mq-duration,14s) ease-in-out infinite;}
@keyframes mq-scroll{0%,6%{transform:translateX(0);}50%,56%{transform:translateX(calc(-1 * var(--mq-distance,0px)));}94%,100%{transform:translateX(0);}}

.tb-btn{background:rgba(255,255,255,.06);border:1px solid var(--border,rgba(255,255,255,.12));color:var(--fg);font-size:.72rem;font-weight:700;padding:6px 13px;border-radius:8px;cursor:pointer;white-space:nowrap;transition:all .15s;text-decoration:none;display:inline-flex;align-items:center;gap:6px;}
.tb-btn:hover{background:rgba(47,255,196,.12);border-color:var(--accent);color:var(--accent);}
.tb-btn .ico{font-size:.9em;line-height:1;}

body.light .toolbar{background:rgba(250,250,250,.92);}
body.light .tb-btn{background:rgba(0,0,0,.05);border-color:rgba(0,0,0,.12);color:var(--fg);}
body.light .tb-btn:hover{background:rgba(0,168,134,.1);border-color:#00a886;color:#00a886;}

/* Mobile (<=600px): two stacked rows, controls centered, collapses to one
   compact row on scroll-down */
@media (max-width:600px){
    .tb-title-row{padding:9px 14px 0;}
    .tb-controls-row{padding:9px 14px;gap:6px;}
    .tb-btn{padding:6px 9px;font-size:.68rem;}
    .toolbar.compact .tb-title-row{max-height:0;opacity:0;padding-top:0;padding-bottom:0;}
    .toolbar.compact .tb-title-mini{display:block;}
    .toolbar.compact .tb-btn .lbl{display:none;}
    .toolbar.compact .tb-btn{padding:6px 8px;}
    .toolbar.compact .tb-controls-row{justify-content:flex-start;flex-wrap:nowrap;}
}

/* Desktop (>600px): single row, title left, controls right — always,
   scroll-compact never applies here regardless of any stray JS class */
@media (min-width:601px){
    .toolbar{flex-direction:row;align-items:center;justify-content:space-between;flex-wrap:nowrap;padding:0 24px;}
    .tb-title-row{flex:1;min-width:0;max-height:none!important;opacity:1!important;padding:0!important;}
    .tb-controls-row{flex:0 0 auto;justify-content:flex-end;flex-wrap:nowrap;padding:14px 0;}
    .tb-title-mini{display:none!important;}
}
`;
}

function buildReaderChromeHtml(originalName, downloadUrl, downloadName) {
    return `
<div class="toolbar" id="toolbar">
  <div class="tb-title-row" id="titleRow">
    <div class="tb-title-full" id="titleFull"><span class="mq-inner">${escapeHtml(originalName)}</span></div>
  </div>
  <div class="tb-controls-row">
    <div class="tb-title-mini" id="titleMini"><span class="tb-title-mini-inner">${escapeHtml(originalName)}</span></div>
    <button class="tb-btn" id="fontBtn" onclick="cycleFont()"><span class="ico">T</span><span class="lbl" id="fontLbl">Výchozí</span></button>
    <button class="tb-btn" id="sizeBtn" onclick="cycleSize()"><span class="ico">Aa</span><span class="lbl" id="sizeLbl"></span></button>
    <button class="tb-btn" id="themeBtn" onclick="toggleTheme()"><span class="ico">&#9728;&#65039;</span><span class="lbl">Light</span></button>
    <a class="tb-btn" id="dlBtn" href="${escapeHtml(downloadUrl)}" download="${escapeHtml(downloadName)}"><span class="ico">&#11015;</span><span class="lbl">Download</span></a>
  </div>
</div>`;
}

// contentSelector: CSS selektor elementu, na který se aplikuje --font-family
// (u txt readeru "pre", u md readeru ".md-body")
function buildReaderChromeJs(contentSelectorVarTarget) {
    return `
var READER_FONTS = ${JSON.stringify(READER_FONTS)};
var fontIdx = Math.max(0, READER_FONTS.findIndex(function(f){return f.id === (localStorage.getItem('tvfs_reader_font')||'default');}));
var SIZES = ['0.85rem','1rem','1.15rem','1.35rem','1.6rem'];
var sizeIdx = parseInt(localStorage.getItem('tvfs_reader_size')||'1');
var theme = localStorage.getItem('tvfs_reader_theme')||'dark';

function applyTheme(){
  document.body.classList.toggle('light', theme==='light');
  document.getElementById('themeBtn').innerHTML = theme==='light' ? '<span class="ico">&#127769;</span><span class="lbl">Dark</span>' : '<span class="ico">&#9728;&#65039;</span><span class="lbl">Light</span>';
  document.querySelector('meta[name="theme-color"]').setAttribute('content', theme==='light'?'#fafafa':'#111111');
}
function toggleTheme(){ theme = theme==='light'?'dark':'light'; localStorage.setItem('tvfs_reader_theme', theme); applyTheme(); }

function applySize(){
  document.documentElement.style.setProperty('--fs', SIZES[sizeIdx]);
  document.getElementById('sizeLbl').textContent = '('+SIZES[sizeIdx]+')';
}
function cycleSize(){ sizeIdx=(sizeIdx+1)%SIZES.length; localStorage.setItem('tvfs_reader_size', sizeIdx); applySize(); }

function applyFont(){
  var f = READER_FONTS[fontIdx];
  document.documentElement.style.setProperty('${contentSelectorVarTarget}', f.stack || 'initial');
  document.getElementById('fontLbl').textContent = f.short;
}
function cycleFont(){ fontIdx=(fontIdx+1)%READER_FONTS.length; localStorage.setItem('tvfs_reader_font', READER_FONTS[fontIdx].id); applyFont(); }

applyTheme(); applySize(); applyFont();

// ─── Marquee (very slow scroll for long filenames) ─────────────────────
function setupMarquee(containerEl, innerEl){
  function measure(){
    var overflow = innerEl.scrollWidth - containerEl.clientWidth;
    if (overflow > 4) {
      containerEl.classList.add('marquee');
      containerEl.style.setProperty('--mq-distance', overflow + 'px');
      containerEl.style.setProperty('--mq-duration', Math.max(10, overflow / 10) + 's');
    } else {
      containerEl.classList.remove('marquee');
    }
  }
  // Layout/fonts might not be settled on the very first frame, so measure
  // twice: once on next frame, once after a short delay as a safety net.
  requestAnimationFrame(measure);
  setTimeout(measure, 300);
}
var titleFullEl = document.getElementById('titleFull');
var titleMiniEl = document.getElementById('titleMini');
setupMarquee(titleFullEl, titleFullEl.querySelector('.mq-inner'));
setupMarquee(titleMiniEl, titleMiniEl.querySelector('.tb-title-mini-inner'));
window.addEventListener('resize', function(){
  setupMarquee(titleFullEl, titleFullEl.querySelector('.mq-inner'));
  setupMarquee(titleMiniEl, titleMiniEl.querySelector('.tb-title-mini-inner'));
});

// ─── Mobile-only collapsing toolbar on scroll ───────────────────────────
// Hysteresis (different enter/exit thresholds) so it doesn't flicker back
// and forth near the trigger point, especially since collapsing the
// toolbar itself slightly shifts page content and thus scrollY.
var toolbarEl = document.getElementById('toolbar');
var isCompact = false;
var ticking = false;
var ENTER_Y = 56, EXIT_Y = 20;
function onScroll(){
  var y = window.scrollY || document.documentElement.scrollTop;
  var isMobile = window.innerWidth <= 600;
  if (!isMobile) {
    if (isCompact) { toolbarEl.classList.remove('compact'); isCompact = false; }
  } else if (!isCompact && y > ENTER_Y) {
    toolbarEl.classList.add('compact'); isCompact = true;
    // titleMini was display:none until just now, so its earlier
    // measurement was against 0 width — re-measure now that it's visible.
    setupMarquee(titleMiniEl, titleMiniEl.querySelector('.tb-title-mini-inner'));
  } else if (isCompact && y < EXIT_Y) {
    toolbarEl.classList.remove('compact'); isCompact = false;
  }
  ticking = false;
}
window.addEventListener('scroll', function(){
  if (!ticking) { requestAnimationFrame(onScroll); ticking = true; }
}, { passive: true });
window.addEventListener('resize', onScroll);
`;
}

function generateTextReaderHtml(txtUrl, originalName) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#111111">
<title>${escapeHtml(originalName)} — TVFS Text Reader</title>
<link rel="stylesheet" href="${FONTS_CSS_URL}">
<style>
*, *::before, *::after { box-sizing: border-box; }
:root { --bg:#111; --fg:#e8e8e8; --accent:#2fffc4; --fs:1rem; --border:rgba(255,255,255,.08); --content-font:'Georgia','Times New Roman',serif; }
html { max-width: 100%; }
body { background:var(--bg); color:var(--fg); margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; transition:background .2s,color .2s; min-height:100vh; }
.content { max-width:100%; overflow-x:clip; padding:40px 20px; max-width:820px; margin:0 auto; width:100%; }
pre { font-family:var(--content-font); font-size:var(--fs); line-height:1.8; white-space:pre-wrap; word-break:break-word; margin:0; color:var(--fg); }
.loading { text-align:center; padding:80px 20px; color:rgba(255,255,255,.3); font-size:.9rem; }
.error { text-align:center; padding:80px 20px; color:#ff6b6b; font-size:.9rem; }
body.light { --bg:#fafafa; --fg:#1a1a1a; --border:rgba(0,0,0,.1); }
@media (max-width: 600px) { .content { padding:24px 16px; } .loading, .error { padding:60px 16px; } }
${buildReaderChromeCss()}
${appOffer.css()}
</style>
</head>
<body>
${appOffer.html({ audio: false })}
${buildReaderChromeHtml(originalName, txtUrl, originalName)}
<div class="content"><pre id="textContent" class="loading">Loading…</pre></div>
<script>
${buildReaderChromeJs('--content-font')}

fetch(${safeScriptJson(txtUrl)})
.then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.text(); })
.then(function(t){
    var el = document.getElementById('textContent');
    el.className='';
    el.textContent=t;
})
.catch(function(e){
    var el = document.getElementById('textContent');
    el.className='error';
    el.textContent='Failed to load text: '+e.message;
});
</script>
</body>
</html>`;
}

function generateProtectedTextReaderHtml(txtUrl, originalName, shareId, landingUrl) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#111111">
<title>${escapeHtml(originalName)} — TVFS Users Only Reader</title>
<link rel="stylesheet" href="${FONTS_CSS_URL}">
<style>
*, *::before, *::after { box-sizing: border-box; }
:root { --bg:#111; --fg:#e8e8e8; --accent:#2fffc4; --fs:1rem; --border:rgba(255,255,255,.08); --content-font:'Georgia','Times New Roman',serif; }
html { max-width: 100%; }
body { background:var(--bg); color:var(--fg); margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; transition:background .2s,color .2s; min-height:100vh; }
.content { max-width:100%; overflow-x:clip; padding:40px 20px; max-width:820px; margin:0 auto; width:100%; }
pre { font-family:var(--content-font); font-size:var(--fs); line-height:1.8; white-space:pre-wrap; word-break:break-word; margin:0; color:var(--fg); }
.loading { text-align:center; padding:80px 20px; color:rgba(255,255,255,.3); font-size:.9rem; }
.error { text-align:center; padding:80px 20px; color:#ff6b6b; font-size:.9rem; }
body.light { --bg:#fafafa; --fg:#1a1a1a; --border:rgba(0,0,0,.1); }
@media (max-width: 600px) { .content { padding:24px 16px; } .loading, .error { padding:60px 16px; } }
${buildReaderChromeCss()}
.gate-overlay{position:fixed; inset:0; z-index:20; display:flex; align-items:center; justify-content:center; background:rgba(10,10,10,.86); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); padding:20px;}
.gate-overlay.hidden{display:none;}
.gate-card{width:100%; max-width:360px; background:rgba(20,20,24,.7); border:1px solid var(--border); border-radius:22px; padding:30px 24px; text-align:center; box-shadow:0 24px 70px rgba(0,0,0,.6);}
.gate-lock{font-size:2rem; margin-bottom:8px;}
.gate-card h2{margin:0 0 4px; font-size:.95rem; letter-spacing:.1em; text-transform:uppercase; color:var(--fg); font-weight:700;}
.gate-card h2 span{color:var(--accent);}
.gate-sub{color:rgba(255,255,255,.5); font-size:.8rem; margin-bottom:18px;}
.gate-field{text-align:left; margin-bottom:12px;}
.gate-field label{display:block; font-size:.72rem; color:rgba(255,255,255,.5); margin-bottom:5px;}
.gate-field input{width:100%; padding:10px 11px; border-radius:9px; border:1px solid var(--border); background:rgba(0,0,0,.4); color:var(--fg); font-size:.9rem; box-sizing:border-box;}
.gate-field input:focus{outline:none; border-color:var(--accent);}
#gateLoginBtn{width:100%; padding:11px; border-radius:9px; border:none; background:linear-gradient(135deg,var(--accent),#7c4dff); color:#0a0a0a; font-weight:700; font-size:.86rem; cursor:pointer; margin-top:4px;}
#gateLoginBtn:disabled{opacity:.5; cursor:default;}
.gate-msg{font-size:.76rem; margin-top:10px; min-height:1.1em; color:#ff6b6b;}

.stay-overlay{position:fixed; inset:0; background:rgba(10,10,10,.86); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); display:flex; align-items:center; justify-content:center; z-index:25; opacity:0; pointer-events:none; transition:opacity .15s;}
.stay-overlay.visible{opacity:1; pointer-events:auto;}
.stay-card{background:rgba(20,20,24,.7); border:1px solid var(--border); border-radius:22px; padding:28px 24px; max-width:340px; width:90%; text-align:center; box-shadow:0 24px 70px rgba(0,0,0,.6);}
.stay-card h3{margin:0 0 8px; font-size:1rem; color:var(--fg);}
.stay-card p{color:rgba(255,255,255,.5); font-size:.8rem; margin:0 0 16px;}
.stay-yes-btn{width:100%; padding:11px; border-radius:9px; border:none; background:linear-gradient(135deg,var(--accent),#7c4dff); color:#0a0a0a; font-weight:700; font-size:.86rem; cursor:pointer; margin-bottom:8px;}
.stay-no-btn{width:100%; padding:10px; border-radius:9px; border:1px solid var(--border); background:transparent; color:rgba(255,255,255,.5); font-size:.8rem; cursor:pointer;}
</style>
</head>
<body>
<div class="gate-overlay" id="gateOverlay">
  <div class="gate-card">
    <div class="gate-lock">🔒</div>
    <h2>TVFS <span>Users Only</span></h2>
    <div class="gate-sub" id="gateSub">Checking your session…</div>
    <div id="gateForm" class="hidden">
      <div class="gate-field"><label>TVFS username</label><input type="text" id="gateUsername" autocomplete="username"></div>
      <div class="gate-field"><label>TVFS password</label><input type="password" id="gatePassword" autocomplete="current-password"></div>
      <button id="gateLoginBtn">Log in</button>
      <div class="gate-msg" id="gateMsg"></div>
    </div>
  </div>
</div>

<div class="stay-overlay" id="stayOverlay">
  <div class="stay-card">
    <h3>✅ Password Verified</h3>
    <p>Stay logged in on this device? You can log out any time from the main upload page.</p>
    <button class="stay-yes-btn" id="stayYesBtn">Yes, stay logged in</button>
    <button class="stay-no-btn" id="stayNoBtn">No, just this session</button>
  </div>
</div>
${buildReaderChromeHtml(originalName, txtUrl, originalName)}
<div class="content"><pre id="textContent" class="loading">Loading…</pre></div>
<script>
${buildReaderChromeJs('--content-font')}

function startLoad(){
  fetch(${safeScriptJson(txtUrl)}, { credentials: 'include' })
  .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.text(); })
  .then(function(t){
      var el = document.getElementById('textContent');
      el.className='';
      el.textContent=t;
  })
  .catch(function(e){
      var el = document.getElementById('textContent');
      el.className='error';
      el.textContent='Failed to load text: '+e.message;
  });
}// ─── Login gate (2026-08) ───────────────────────────────────────────────
// No content byte is requested until this succeeds. Same tvfs_token
// session cookie as the rest of the site — never a token in this page's
// URL, so a bare link is worthless without an actual TVFS login.
var GATE_API = '/api/protected/' + ${safeScriptJson(shareId)};
var gateOverlay = document.getElementById('gateOverlay');
var gateSub = document.getElementById('gateSub');
var gateForm = document.getElementById('gateForm');
var gateUsername = document.getElementById('gateUsername');
var gatePassword = document.getElementById('gatePassword');
var gateLoginBtn = document.getElementById('gateLoginBtn');
var gateMsg = document.getElementById('gateMsg');
var stayOverlay = document.getElementById('stayOverlay');

function revealContent(){
  gateOverlay.classList.add('hidden');
  startLoad();
}

function showGateForm(msg){
  gateSub.textContent = 'Log in with your TVFS account to read this.';
  gateForm.classList.remove('hidden');
  gateMsg.textContent = msg || '';
}

async function silentCheck(){
  try {
    var res = await fetch(GATE_API + '/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({})
    });
    if (res.ok) { revealContent(); return; }
  } catch (e) { /* fall through to gate */ }
  showGateForm();
}

gateLoginBtn.addEventListener('click', async function(){
  gateMsg.textContent = '';
  var username = gateUsername.value.trim();
  var password = gatePassword.value;
  if (!username || !password) { gateMsg.textContent = 'Enter both fields'; return; }
  gateLoginBtn.disabled = true;
  try {
    var res = await fetch(GATE_API + '/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ username: username, password: password })
    });
    var data = await res.json();
    if (!res.ok) { gateMsg.textContent = data.error || 'Login failed'; gateLoginBtn.disabled = false; return; }
    revealContent();
    showStayLoggedInPopup(username, password);
  } catch (e) {
    gateMsg.textContent = 'Network error';
    gateLoginBtn.disabled = false;
  }
});

function showStayLoggedInPopup(username, password){
  stayOverlay.classList.add('visible');
  document.getElementById('stayYesBtn').onclick = function(){ rememberLogin(username, password, true); };
  document.getElementById('stayNoBtn').onclick = function(){ rememberLogin(username, password, false); };
}

async function rememberLogin(username, password, remember){
  stayOverlay.classList.remove('visible');
  if (!remember) return;
  try {
    await fetch('/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ username: username, password: password, remember: true })
    });
  } catch (e) { /* content access already succeeded regardless — this is best-effort */ }
}

silentCheck();
</script>
</body>
</html>`;
}

// fileUrl: the real public link of the stored file. Readers must not guess the
// directory: it depends on the MIME type the browser sent, not on the extension.
function maybeCreateTextReader(storedFilename, originalName, mimeType, expiresAt, fileUrl, ownerKey = null) {
    // Generate a reader page for .txt files (or text/plain)
    const isTxt = mimeType === 'text/plain' || storedFilename.toLowerCase().endsWith('.txt');
    if (!isTxt) return null;

    const readerSlug = originalName.replace(/\.[^.]+$/, '').replace(/[^\w\-]/g, '_').replace(/_+/g, '_').slice(0, 40) || generateReaderId();
    const txtUrl = fileUrl;

    try {
        const html = generateTextReaderHtml(txtUrl, originalName);
        // Slug comes from the original name only, so same-named uploads collide: never overwrite
        const { filename: readerFilename, filePath: readerPath } =
            safeFs.writeFileUnique(dirs.text, `${readerSlug}_txt_tvfsreader.html`, html);
        const readerUrl = `https://files.tomasekvalla.cz/files/text/${readerFilename}`;
        console.log(`📖 [TEXT READER] Created ${readerFilename} for ${storedFilename}`);

        // Register reader in registry with same expiry
        const readFileId = generateFileId();
        registry.files.push({
            id: readFileId,
            originalName: readerFilename,
            storedName: readerFilename,
            path: readerPath,
            directory: 'text',
            size: Buffer.byteLength(html),
                            mimeType: 'text/html',
                            category: 'file',
                            uploadedAt: Date.now(),
                            expiresAt: expiresAt,
                            isTextReader: true,
                            ownerKey
        });

        return readerUrl;
    } catch (e) {
        console.error('❌ [TEXT READER] Failed to create reader:', e.message);
        return null;
    }
}

// ─── MD Reader ────────────────────────────────────────────────────────────────

// ─── Markdown reader: pinned, integrity-checked libraries and a sanitizing renderer ─────
// Uploaded Markdown is untrusted and the reader runs on the API origin, so the rendered HTML must be inert:
// DOMPurify cleans it; if DOMPurify did not load, raw HTML is shown as text and only safe link schemes survive.
const MD_LIBS_HTML = `<script src="https://cdn.jsdelivr.net/npm/marked@9.1.6/marked.min.js" integrity="sha384-odPBjvtXVM/5hOYIr3A1dB+flh0c3wAT3bSesIOqEGmyUA4JoKf/YTWy0XKOYAY7" crossorigin="anonymous"><\/script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js" integrity="sha384-JEyTNhjM6R1ElGoJns4U2Ln4ofPcqzSsynQkmEc/KGy6336qAZl70tDLufbkla+3" crossorigin="anonymous"><\/script>`;
const MD_RENDER_JS = `function renderMd(el,t){
    var tries=0;
    function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    function okUrl(u){var v=String(u||'').replace(/[\\u0000-\\u0020]/g,'');return !/^[a-z][a-z0-9+.\\-]*:/i.test(v)||/^(https?|mailto):/i.test(v);}
    function go(){
      if(typeof marked==='undefined'){
        if(++tries>100){el.textContent=t;return;}
        setTimeout(go,50);return;
      }
      var clean=typeof DOMPurify!=='undefined';
      if(!renderMd.ready){
        renderMd.ready=true;
        marked.use({breaks:true,gfm:true,renderer:{
          html:function(h){return clean?false:esc(h);},
          link:function(href,title,text){return okUrl(href)?false:text;},
          image:function(href,title,text){return okUrl(href)?false:esc(text);}
        }});
      }
      var out=marked.parse(t);
      el.innerHTML=clean?DOMPurify.sanitize(out):out;
    }
    go();
  }`;

function generateMdReaderHtml(mdUrl, originalName) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#111111">
<title>${escapeHtml(originalName)} — TVFS MD Reader</title>
<link rel="stylesheet" href="${FONTS_CSS_URL}">
<style>
*, *::before, *::after { box-sizing: border-box; }
:root { --bg:#111; --fg:#e8e8e8; --accent:#2fffc4; --accent2:#7c4dff; --fs:1rem; --border:rgba(255,255,255,.1); --content-font:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
html { max-width:100%; }
body { background:var(--bg); color:var(--fg); margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; transition:background .2s,color .2s; min-height:100vh; }
.content { overflow-x:clip; padding:40px 24px; max-width:860px; margin:0 auto; width:100%; }
.loading { text-align:center; padding:80px 20px; color:rgba(255,255,255,.3); font-size:.9rem; }
.error   { text-align:center; padding:80px 20px; color:#ff6b6b; font-size:.9rem; }
.md-body { font-family:var(--content-font); font-size:var(--fs); line-height:1.75; color:var(--fg); word-break:break-word; }
.md-body h1,.md-body h2,.md-body h3,.md-body h4,.md-body h5,.md-body h6 { font-weight:700; line-height:1.25; margin:1.6em 0 .6em; background:linear-gradient(135deg,var(--accent),var(--accent2)); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
.md-body h1 { font-size:2em; border-bottom:1px solid var(--border); padding-bottom:.3em; }
.md-body h2 { font-size:1.5em; border-bottom:1px solid var(--border); padding-bottom:.2em; }
.md-body h3 { font-size:1.25em; }
.md-body h4 { font-size:1.05em; }
.md-body p  { margin:.8em 0; }
.md-body a  { color:var(--accent); text-decoration:none; }
.md-body a:hover { text-decoration:underline; }
.md-body strong { font-weight:700; color:#fff; }
.md-body em     { font-style:italic; opacity:.85; }
.md-body code { font-family:'JetBrains Mono','Courier New',monospace; background:rgba(255,255,255,.08); border:1px solid var(--border); border-radius:5px; padding:2px 6px; font-size:.88em; }
.md-body pre  { background:rgba(0,0,0,.4); border:1px solid var(--border); border-radius:10px; padding:18px 20px; overflow-x:auto; margin:1em 0; }
.md-body pre code { background:none; border:none; padding:0; font-size:.9em; }
.md-body blockquote { border-left:3px solid var(--accent2); margin:1em 0; padding:.4em 1em; background:rgba(124,77,255,.08); border-radius:0 8px 8px 0; color:var(--fg); opacity:.85; }
.md-body ul,.md-body ol { padding-left:1.6em; margin:.6em 0; }
.md-body li { margin:.3em 0; }
.md-body hr { border:none; border-top:1px solid var(--border); margin:1.8em 0; }
.md-body img { max-width:100%; border-radius:8px; margin:.5em 0; }
.md-body table { width:100%; border-collapse:collapse; margin:1em 0; font-size:.92em; overflow-x:auto; display:block; }
.md-body thead tr { background:rgba(47,255,196,.08); }
.md-body th,.md-body td { border:1px solid var(--border); padding:8px 14px; text-align:left; }
.md-body th { font-weight:700; color:var(--accent); }
.md-body tbody tr:nth-child(even) { background:rgba(255,255,255,.03); }
body.light { --bg:#fafafa; --fg:#1a1a1a; --border:rgba(0,0,0,.1); }
body.light .md-body code { background:rgba(0,0,0,.06); }
body.light .md-body pre  { background:rgba(0,0,0,.04); }
body.light .md-body strong { color:#000; }
body.light .md-body blockquote { background:rgba(124,77,255,.06); color:#1a1a1a; opacity:1; }
@media (max-width:600px) { .content { padding:24px 16px; } }
${buildReaderChromeCss()}
${appOffer.css()}
</style>
</head>
<body>
${appOffer.html({ audio: false })}
${buildReaderChromeHtml(originalName, mdUrl, originalName)}
<div class="content"><div id="mdContent" class="md-body loading">Loading&#8230;</div></div>
${MD_LIBS_HTML}
<script>
${buildReaderChromeJs('--content-font')}

fetch(${safeScriptJson(mdUrl)})
.then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text();})
.then(function(t){
  var el=document.getElementById('mdContent');
  el.classList.remove('loading');
  ${MD_RENDER_JS}
  renderMd(el,t);
})
.catch(function(e){var el=document.getElementById('mdContent');el.className='error';el.textContent='Failed to load: '+e.message;});
<\/script>
</body>
</html>`;
}

function generateProtectedMdReaderHtml(mdUrl, originalName, shareId, landingUrl) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#111111">
<title>${escapeHtml(originalName)} — TVFS Users Only Reader</title>
<link rel="stylesheet" href="${FONTS_CSS_URL}">
<style>
*, *::before, *::after { box-sizing: border-box; }
:root { --bg:#111; --fg:#e8e8e8; --accent:#2fffc4; --accent2:#7c4dff; --fs:1rem; --border:rgba(255,255,255,.1); --content-font:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
html { max-width:100%; }
body { background:var(--bg); color:var(--fg); margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; transition:background .2s,color .2s; min-height:100vh; }
.content { overflow-x:clip; padding:40px 24px; max-width:860px; margin:0 auto; width:100%; }
.loading { text-align:center; padding:80px 20px; color:rgba(255,255,255,.3); font-size:.9rem; }
.error   { text-align:center; padding:80px 20px; color:#ff6b6b; font-size:.9rem; }
.md-body { font-family:var(--content-font); font-size:var(--fs); line-height:1.75; color:var(--fg); word-break:break-word; }
.md-body h1,.md-body h2,.md-body h3,.md-body h4,.md-body h5,.md-body h6 { font-weight:700; line-height:1.25; margin:1.6em 0 .6em; background:linear-gradient(135deg,var(--accent),var(--accent2)); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
.md-body h1 { font-size:2em; border-bottom:1px solid var(--border); padding-bottom:.3em; }
.md-body h2 { font-size:1.5em; border-bottom:1px solid var(--border); padding-bottom:.2em; }
.md-body h3 { font-size:1.25em; }
.md-body h4 { font-size:1.05em; }
.md-body p  { margin:.8em 0; }
.md-body a  { color:var(--accent); text-decoration:none; }
.md-body a:hover { text-decoration:underline; }
.md-body strong { font-weight:700; color:#fff; }
.md-body em     { font-style:italic; opacity:.85; }
.md-body code { font-family:'JetBrains Mono','Courier New',monospace; background:rgba(255,255,255,.08); border:1px solid var(--border); border-radius:5px; padding:2px 6px; font-size:.88em; }
.md-body pre  { background:rgba(0,0,0,.4); border:1px solid var(--border); border-radius:10px; padding:18px 20px; overflow-x:auto; margin:1em 0; }
.md-body pre code { background:none; border:none; padding:0; font-size:.9em; }
.md-body blockquote { border-left:3px solid var(--accent2); margin:1em 0; padding:.4em 1em; background:rgba(124,77,255,.08); border-radius:0 8px 8px 0; color:var(--fg); opacity:.85; }
.md-body ul,.md-body ol { padding-left:1.6em; margin:.6em 0; }
.md-body li { margin:.3em 0; }
.md-body hr { border:none; border-top:1px solid var(--border); margin:1.8em 0; }
.md-body img { max-width:100%; border-radius:8px; margin:.5em 0; }
.md-body table { width:100%; border-collapse:collapse; margin:1em 0; font-size:.92em; overflow-x:auto; display:block; }
.md-body thead tr { background:rgba(47,255,196,.08); }
.md-body th,.md-body td { border:1px solid var(--border); padding:8px 14px; text-align:left; }
.md-body th { font-weight:700; color:var(--accent); }
.md-body tbody tr:nth-child(even) { background:rgba(255,255,255,.03); }
body.light { --bg:#fafafa; --fg:#1a1a1a; --border:rgba(0,0,0,.1); }
body.light .md-body code { background:rgba(0,0,0,.06); }
body.light .md-body pre  { background:rgba(0,0,0,.04); }
body.light .md-body strong { color:#000; }
body.light .md-body blockquote { background:rgba(124,77,255,.06); color:#1a1a1a; opacity:1; }
@media (max-width:600px) { .content { padding:24px 16px; } }
${buildReaderChromeCss()}
.gate-overlay{position:fixed; inset:0; z-index:20; display:flex; align-items:center; justify-content:center; background:rgba(10,10,10,.86); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); padding:20px;}
.gate-overlay.hidden{display:none;}
.gate-card{width:100%; max-width:360px; background:rgba(20,20,24,.7); border:1px solid var(--border); border-radius:22px; padding:30px 24px; text-align:center; box-shadow:0 24px 70px rgba(0,0,0,.6);}
.gate-lock{font-size:2rem; margin-bottom:8px;}
.gate-card h2{margin:0 0 4px; font-size:.95rem; letter-spacing:.1em; text-transform:uppercase; color:var(--fg); font-weight:700;}
.gate-card h2 span{color:var(--accent);}
.gate-sub{color:rgba(255,255,255,.5); font-size:.8rem; margin-bottom:18px;}
.gate-field{text-align:left; margin-bottom:12px;}
.gate-field label{display:block; font-size:.72rem; color:rgba(255,255,255,.5); margin-bottom:5px;}
.gate-field input{width:100%; padding:10px 11px; border-radius:9px; border:1px solid var(--border); background:rgba(0,0,0,.4); color:var(--fg); font-size:.9rem; box-sizing:border-box;}
.gate-field input:focus{outline:none; border-color:var(--accent);}
#gateLoginBtn{width:100%; padding:11px; border-radius:9px; border:none; background:linear-gradient(135deg,var(--accent),#7c4dff); color:#0a0a0a; font-weight:700; font-size:.86rem; cursor:pointer; margin-top:4px;}
#gateLoginBtn:disabled{opacity:.5; cursor:default;}
.gate-msg{font-size:.76rem; margin-top:10px; min-height:1.1em; color:#ff6b6b;}

.stay-overlay{position:fixed; inset:0; background:rgba(10,10,10,.86); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); display:flex; align-items:center; justify-content:center; z-index:25; opacity:0; pointer-events:none; transition:opacity .15s;}
.stay-overlay.visible{opacity:1; pointer-events:auto;}
.stay-card{background:rgba(20,20,24,.7); border:1px solid var(--border); border-radius:22px; padding:28px 24px; max-width:340px; width:90%; text-align:center; box-shadow:0 24px 70px rgba(0,0,0,.6);}
.stay-card h3{margin:0 0 8px; font-size:1rem; color:var(--fg);}
.stay-card p{color:rgba(255,255,255,.5); font-size:.8rem; margin:0 0 16px;}
.stay-yes-btn{width:100%; padding:11px; border-radius:9px; border:none; background:linear-gradient(135deg,var(--accent),#7c4dff); color:#0a0a0a; font-weight:700; font-size:.86rem; cursor:pointer; margin-bottom:8px;}
.stay-no-btn{width:100%; padding:10px; border-radius:9px; border:1px solid var(--border); background:transparent; color:rgba(255,255,255,.5); font-size:.8rem; cursor:pointer;}
</style>
</head>
<body>
<div class="gate-overlay" id="gateOverlay">
  <div class="gate-card">
    <div class="gate-lock">🔒</div>
    <h2>TVFS <span>Users Only</span></h2>
    <div class="gate-sub" id="gateSub">Checking your session…</div>
    <div id="gateForm" class="hidden">
      <div class="gate-field"><label>TVFS username</label><input type="text" id="gateUsername" autocomplete="username"></div>
      <div class="gate-field"><label>TVFS password</label><input type="password" id="gatePassword" autocomplete="current-password"></div>
      <button id="gateLoginBtn">Log in</button>
      <div class="gate-msg" id="gateMsg"></div>
    </div>
  </div>
</div>

<div class="stay-overlay" id="stayOverlay">
  <div class="stay-card">
    <h3>✅ Password Verified</h3>
    <p>Stay logged in on this device? You can log out any time from the main upload page.</p>
    <button class="stay-yes-btn" id="stayYesBtn">Yes, stay logged in</button>
    <button class="stay-no-btn" id="stayNoBtn">No, just this session</button>
  </div>
</div>
${buildReaderChromeHtml(originalName, mdUrl, originalName)}
<div class="content"><div id="mdContent" class="md-body loading">Loading&#8230;</div></div>
${MD_LIBS_HTML}
<script>
${buildReaderChromeJs('--content-font')}

function startLoad(){
  fetch(${safeScriptJson(mdUrl)}, { credentials: 'include' })
  .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text();})
  .then(function(t){
    var el=document.getElementById('mdContent');
    el.classList.remove('loading');
    ${MD_RENDER_JS}
    renderMd(el,t);
  })
  .catch(function(e){var el=document.getElementById('mdContent');el.className='error';el.textContent='Failed to load: '+e.message;});
}// ─── Login gate (2026-08) ───────────────────────────────────────────────
// No content byte is requested until this succeeds. Same tvfs_token
// session cookie as the rest of the site — never a token in this page's
// URL, so a bare link is worthless without an actual TVFS login.
var GATE_API = '/api/protected/' + ${safeScriptJson(shareId)};
var gateOverlay = document.getElementById('gateOverlay');
var gateSub = document.getElementById('gateSub');
var gateForm = document.getElementById('gateForm');
var gateUsername = document.getElementById('gateUsername');
var gatePassword = document.getElementById('gatePassword');
var gateLoginBtn = document.getElementById('gateLoginBtn');
var gateMsg = document.getElementById('gateMsg');
var stayOverlay = document.getElementById('stayOverlay');

function revealContent(){
  gateOverlay.classList.add('hidden');
  startLoad();
}

function showGateForm(msg){
  gateSub.textContent = 'Log in with your TVFS account to read this.';
  gateForm.classList.remove('hidden');
  gateMsg.textContent = msg || '';
}

async function silentCheck(){
  try {
    var res = await fetch(GATE_API + '/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({})
    });
    if (res.ok) { revealContent(); return; }
  } catch (e) { /* fall through to gate */ }
  showGateForm();
}

gateLoginBtn.addEventListener('click', async function(){
  gateMsg.textContent = '';
  var username = gateUsername.value.trim();
  var password = gatePassword.value;
  if (!username || !password) { gateMsg.textContent = 'Enter both fields'; return; }
  gateLoginBtn.disabled = true;
  try {
    var res = await fetch(GATE_API + '/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ username: username, password: password })
    });
    var data = await res.json();
    if (!res.ok) { gateMsg.textContent = data.error || 'Login failed'; gateLoginBtn.disabled = false; return; }
    revealContent();
    showStayLoggedInPopup(username, password);
  } catch (e) {
    gateMsg.textContent = 'Network error';
    gateLoginBtn.disabled = false;
  }
});

function showStayLoggedInPopup(username, password){
  stayOverlay.classList.add('visible');
  document.getElementById('stayYesBtn').onclick = function(){ rememberLogin(username, password, true); };
  document.getElementById('stayNoBtn').onclick = function(){ rememberLogin(username, password, false); };
}

async function rememberLogin(username, password, remember){
  stayOverlay.classList.remove('visible');
  if (!remember) return;
  try {
    await fetch('/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ username: username, password: password, remember: true })
    });
  } catch (e) { /* content access already succeeded regardless — this is best-effort */ }
}

silentCheck();
<\/script>
</body>
</html>`;
}

// .md files land in files/text only when the browser sends text/markdown; Windows
// browsers usually send application/octet-stream, which stores them in files/download.
function maybeCreateMdReader(storedFilename, originalName, mimeType, expiresAt, fileUrl, ownerKey = null) {
    const isMd = mimeType === 'text/markdown' || storedFilename.toLowerCase().endsWith('.md');
    if (!isMd) return null;

    const mdUrl = fileUrl;
    try {
        const readerSlug = originalName.replace(/\.[^.]+$/, '').replace(/[^\w\-]/g, '_').replace(/_+/g, '_').slice(0, 40) || generateReaderId();
        const html = generateMdReaderHtml(mdUrl, originalName);
        const { filename: readerFilename, filePath: readerPath } =
            safeFs.writeFileUnique(dirs.text, `${readerSlug}_md_tvfsreader.html`, html);
        const readerUrl = `https://files.tomasekvalla.cz/files/text/${readerFilename}`;
        console.log(`📖 [MD READER] Created ${readerFilename} for ${storedFilename}`);
        const mdReadFileId = generateFileId();
        registry.files.push({
            id: mdReadFileId,
            originalName: readerFilename,
            storedName: readerFilename,
            path: readerPath,
            directory: 'text',
            size: Buffer.byteLength(html),
            mimeType: 'text/html',
            category: 'file',
            uploadedAt: Date.now(),
            expiresAt: expiresAt,
            isMdReader: true,
            ownerKey
        });
        saveRegistry();
        return readerUrl;
    } catch (e) {
        console.error('\u274c [MD READER] Failed to create reader:', e.message);
        return null;
    }
}

// ─── Audio Player ─────────────────────────────────────────────────────────
// storedFilename/originalName/mimeType: as usual. filePath: absolute path
// to the audio file on disk (for ffprobe/aubio). publicAudioUrl: the URL
// the player's <audio> tag will stream from. expiresAt: same expiry as the
// track, so the player HTML dies alongside it in cleanup.js.
async function maybeCreateAudioPlayer(storedFilename, originalName, mimeType, filePath, publicAudioUrl, expiresAt, voiceNote, ownerKey = null) {
    const result = await audioPlayerLib.maybeCreateAudioPlayer(
        storedFilename, originalName, mimeType, filePath, dirs.players, publicAudioUrl, undefined, { voiceNote: !!voiceNote }
    );
    if (!result) return null;

    const playerUrl = `https://files.tomasekvalla.cz/files/players/${result.playerFilename}`;

    const playerFileId = generateFileId();
    registry.files.push({
        id: playerFileId,
        originalName: result.playerFilename,
        storedName: result.playerFilename,
        path: result.playerPath,
        directory: 'players',
        size: Buffer.byteLength(result.html),
        mimeType: 'text/html',
        category: 'file',
        uploadedAt: Date.now(),
        expiresAt: expiresAt,
        isAudioPlayer: true,
        ownerKey,
        ...(result.voiceNote ? { isVoiceNote: true } : {})
    });
    saveRegistry();

    console.log(`🎵 [AUDIO PLAYER] Created ${result.playerFilename} — ${result.voiceNote ? 'voice note' : `BPM: ${result.meta.bpm || 'n/a'}, font: ${result.font.label}`}`);

    return { playerUrl, meta: result.meta, font: result.font, voiceNote: !!result.voiceNote };
}



// File extensions end up in public links: same ASCII-only rule as the base name (".mp3" stays ".mp3")
function safeExt(ext) {
    return ext.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.\-]/g, '_');
}

const storage = multer.diskStorage({
    // Never a public folder: the final folder is chosen after the upload is checked
    destination: function(req, file, cb) {
        fs.mkdir(dirs.incoming, { recursive: true }, err => cb(err, dirs.incoming));
    },
    filename: function(req, file, cb) {
        // Don't decide final name here — req.body isn't reliably populated yet
        // because multer processes multipart fields in stream order, and
        // 'file' is typically appended before anonymize/removeTimestamp.
        cb(null, `tmp_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`);
    }
});

const upload = multer({
    storage: storage,
    // Browsers send file names as UTF-8; multer defaults to latin1, which garbled non-ASCII names
    defParamCharset: 'utf8',
    limits: { fileSize: 5 * 1024 * 1024 * 1024 }
});

const chunkStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(dirs.chunks)) {
            fs.mkdirSync(dirs.chunks, { recursive: true, mode: 0o755 });
        }
        cb(null, dirs.chunks);
    },
    filename: (req, file, cb) => {
        cb(null, `chunk_tmp_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`);
    }
});

const chunkUpload = multer({
    storage: chunkStorage,
    // The UI lets users configure their own chunk size (up to 99 MB — the
    // frontend blocks 100 MB+ outright since our infra doesn't allow more
    // than 100 MB in flight at once). 105 MB leaves headroom for multipart
    // field overhead around the raw chunk bytes.
    limits: { fileSize: 105 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, true)
});

// ─── Used Space (cached — avoids blocking the event loop on every status poll) ─

let _usedSpaceCache = { bytes: 0, updatedAt: 0 };
const SPACE_CACHE_TTL = 30 * 1000; // 30 seconds

function getUsedSpace() {
    const now = Date.now();
    if (now - _usedSpaceCache.updatedAt < SPACE_CACHE_TTL) {
        return _usedSpaceCache.bytes;
    }
    let total = 0;
    Object.values(dirs).forEach(dir => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(f => {
            try {
                const stats = fs.statSync(path.join(dir, f));
                total += stats.size;
            } catch (e) {}
        });
    });
    _usedSpaceCache = { bytes: total, updatedAt: now };
    return total;
}

// ─── Chunk Cleanup Interval ─────────────────────────────────────────────────

// Files untouched for a day: abandoned chunks/manifests and interrupted single uploads (incoming/)
setInterval(() => {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    for (const dir of [dirs.chunks, dirs.incoming]) {
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
            try {
                const filePath = path.join(dir, file);
                const stats = fs.statSync(filePath);
                if (stats.isFile() && stats.mtimeMs < oneDayAgo) {
                    fs.unlinkSync(filePath);
                    console.log(`🗑️ Deleted old chunk/manifest: ${file}`);
                }
            } catch (e) {}
        }
    }
    console.log(`🧹 Chunk cleanup completed at ${new Date().toISOString()}`);
}, 60 * 60 * 1000).unref();

// ─── Helper: format bytes ────────────────────────────────────────────────────

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ─── Pending (unfinished) uploads — cross-device visibility ─────────────────
//
// A chunked upload writes a manifest to dirs.chunks as soon as init happens.
// If it never completes, that manifest just sits there until the hourly
// sweep above deletes it (>24h old) — that's the full teardown, not a soft
// "expired" state. This just scans for manifests belonging to the requesting
// user so a SECOND device can show "Upload not finished (from other device)"
// for the same 24h window, instead of only the device that started it
// knowing about it via its own localStorage.
//
// Cached briefly since this does a readdir + several small file reads, and
// /api/status (which surfaces this) is polled every ~10s from open tabs.

let _pendingCache = { at: 0, byOwner: new Map() };
const PENDING_CACHE_TTL = 5 * 1000;

function scanPendingManifests() {
    const now = Date.now();
    if (now - _pendingCache.at < PENDING_CACHE_TTL) return _pendingCache.byOwner;

    const byOwner = new Map(); // ownerKey -> [ pending entries ]
    if (fs.existsSync(dirs.chunks)) {
        for (const file of fs.readdirSync(dirs.chunks)) {
            if (!file.endsWith('_manifest.json')) continue;
            try {
                const manifest = JSON.parse(fs.readFileSync(path.join(dirs.chunks, file), 'utf8'));
                if (!manifest.ownerKey) continue;
                if (manifest.status === 'completed') continue;
                const age = now - (manifest.createdAt || 0);
                if (age > 24 * 60 * 60 * 1000) continue; // will be swept away shortly anyway

                const list = byOwner.get(manifest.ownerKey) || [];
                list.push({
                    uploadId: manifest.uploadId,
                    filename: manifest.filename,
                    fileSize: manifest.fileSize,
                    totalChunks: manifest.totalChunks,
                    receivedChunks: (manifest.receivedChunks || []).length,
                    createdAt: manifest.createdAt,
                    expiresAt: (manifest.createdAt || now) + 24 * 60 * 60 * 1000
                });
                byOwner.set(manifest.ownerKey, list);
            } catch (e) { /* corrupt/partial manifest write — ignore */ }
        }
    }

    _pendingCache = { at: now, byOwner };
    return byOwner;
}

function getPendingUploadsForOwner(ownerKey) {
    if (!ownerKey) return [];
    return scanPendingManifests().get(ownerKey) || [];
}

// ─── Media metadata (ffprobe) ────────────────────────────────────────────────
// Best-effort only: if ffprobe is missing or the file can't be parsed, every
// caller falls back gracefully to a plain "Name | Size | TVFS" label.

const CODEC_NAMES = {
    h264: 'H.264', hevc: 'H.265', h265: 'H.265', av1: 'AV1', vp9: 'VP9', vp8: 'VP8',
    mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', mpeg1video: 'MPEG-1', theora: 'Theora', prores: 'ProRes',
    aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', alac: 'ALAC',
    ac3: 'AC3', eac3: 'E-AC3', pcm_s16le: 'PCM', pcm_s24le: 'PCM', pcm_f32le: 'PCM'
};

function friendlyCodec(name) {
    if (!name) return null;
    return CODEC_NAMES[name.toLowerCase()] || name.toUpperCase();
}

function parseFrameRate(fr) {
    if (!fr) return null;
    const parts = String(fr).split('/');
    if (parts.length === 2) {
        const num = parseFloat(parts[0]), den = parseFloat(parts[1]);
        if (den > 0) return num / den;
    }
    return parseFloat(fr) || null;
}

function formatDuration(sec) {
    if (!sec || sec <= 0) return null;
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

async function ffprobeJson(filePath) {
    const r = await mediaQueue.run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
        { timeoutMs: 15000, maxBytes: 5 * 1024 * 1024 });
    if (r.code !== 0 || !r.stdout.length) return null;
    try { return JSON.parse(r.stdout.toString('utf8')); } catch (e) { return null; }
}

// category: 'video' | 'audio' — anything else returns null immediately
async function probeMedia(filePath, category) {
    if (category !== 'video' && category !== 'audio') return null;
    try {
        const data = await ffprobeJson(filePath);
        if (!data) return null;

        const streams = data.streams || [];
        const videoStream = streams.find(s => s.codec_type === 'video');
        const audioStream = streams.find(s => s.codec_type === 'audio');
        const format = data.format || {};
        const durationSec = parseFloat(format.duration) || null;
        const overallBitrate = parseInt(format.bit_rate) || null;

        const result = { durationSec };

        if (videoStream) {
            const fps = parseFrameRate(videoStream.avg_frame_rate) || parseFrameRate(videoStream.r_frame_rate);
            result.video = {
                codec: friendlyCodec(videoStream.codec_name),
                width: videoStream.width || null,
                height: videoStream.height || null,
                fps: fps ? Math.round(fps * 100) / 100 : null,
                bitrate: parseInt(videoStream.bit_rate) || overallBitrate || null
            };
        }
        if (audioStream) {
            result.audio = {
                codec: friendlyCodec(audioStream.codec_name),
                channels: audioStream.channels || null,
                bitrate: parseInt(audioStream.bit_rate) || (!videoStream ? overallBitrate : null) || null,
                sampleRate: parseInt(audioStream.sample_rate) || null
            };
        }
        return (result.video || result.audio) ? result : null;
    } catch (e) {
        return null;
    }
}

function isTextFile(mimeType, filename) {
    return mimeType === 'text/plain' || mimeType === 'text/markdown'
        || /\.(txt|md)$/i.test(filename || '');
}

// Streams the file instead of reading it whole: a big text upload must not block the server
function getTextStats(filePath) {
    return new Promise(resolve => {
        let chars = 0, lines = 1;
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        stream.on('data', chunk => {
            chars += chunk.length;
            for (let i = chunk.indexOf('\n'); i !== -1; i = chunk.indexOf('\n', i + 1)) lines++;
        });
        stream.on('end', () => resolve({ chars, lines }));
        stream.on('error', () => resolve(null));
    });
}

// Builds the "Name | metadata | TomasekValla Filestream System" label.
// category: 'video' | 'audio' | 'image' | 'file' (download/other)
function buildStyledLabel(originalName, sizeBytes, category, probe, textStats) {
    const sizeStr = formatBytes(sizeBytes);
    const parts = [originalName];

    if (category === 'video' && probe && probe.video) {
        const v = probe.video, a = probe.audio;
        const bits = [sizeStr];
        if (v.codec) bits.push(v.codec);
        if (v.bitrate) bits.push((v.bitrate / 1000000).toFixed(1).replace(/\.0$/, '') + ' Mbps');
        if (v.fps) bits.push(Math.round(v.fps) + ' Fps');
        if (v.width && v.height) bits.push(`${v.width}x${v.height}`);
        const durationStr = formatDuration(probe.durationSec);
        if (durationStr) bits.push(durationStr);
        if (a) {
            const audioBits = [];
            if (a.codec) audioBits.push(a.codec);
            if (a.bitrate) audioBits.push(Math.round(a.bitrate / 1000) + ' Kbps');
            if (a.channels) audioBits.push(a.channels + ' Ch');
            if (audioBits.length) bits.push(audioBits.join(' '));
        }
        parts.push(bits.join(' · '));
    } else if (category === 'audio' && probe && probe.audio) {
        const a = probe.audio;
        const bits = [sizeStr];
        if (a.codec) bits.push(a.codec);
        if (a.bitrate) bits.push(Math.round(a.bitrate / 1000) + ' Kbps');
        if (a.channels) bits.push(a.channels + ' Ch');
        const durationStr = formatDuration(probe.durationSec);
        if (durationStr) bits.push(durationStr);
        parts.push(bits.join(' · '));
    } else if (textStats) {
        const bits = [sizeStr, textStats.chars.toLocaleString('en-US') + ' chars', textStats.lines.toLocaleString('en-US') + ' lines'];
        parts.push(bits.join(' · '));
    } else {
        parts.push(sizeStr);
    }

    parts.push('TomasekValla Filestream System');
    return parts.join(' | ');
}

// In-memory store for async-computed styled labels (ffprobe can take a beat
// for large videos). Frontend polls /api/upload/styled-link/:fileId while
// showing a "Processing" placeholder, then swaps in the real button.
// Thumbnail generation (ffmpeg) piggybacks on the same store/poll, since
// both are "compute a bit after upload, patch the card once ready".
const styledLinkStore = new Map(); // fileId -> { ready, styledLink, thumbnail }
const STYLED_LINK_TTL = 10 * 60 * 1000; // 10 min, then forget it

// fileId -> owner key: only the uploader may poll the styled link (name, metadata, thumbnail)
const styledLinkOwners = new Map();

// Tier 0 (host) gets no media work: the plain link is ready at once
function plainStyledLink(fileId, originalName, sizeBytes, link, ownerKey) {
    styledLinkStore.set(fileId, { ready: true, styledLink: `[${originalName} | ${formatBytes(sizeBytes)} | TomasekValla Filestream System](${link})`, thumbnail: null });
    styledLinkOwners.set(fileId, ownerKey);
    setTimeout(() => { styledLinkStore.delete(fileId); styledLinkOwners.delete(fileId); }, STYLED_LINK_TTL);
}

function schedulePendingStyledLink(fileId, originalName, filePath, sizeBytes, category, link, ownerUsername) {
    styledLinkStore.set(fileId, { ready: false, styledLink: null, thumbnail: null });
    styledLinkOwners.set(fileId, ownerUsername ? `user:${ownerUsername}` : null);
    setTimeout(() => { styledLinkStore.delete(fileId); styledLinkOwners.delete(fileId); }, STYLED_LINK_TTL);

    (async () => {
        let styledLink;
        try {
            const probe = await probeMedia(filePath, category);
            const textStats = isTextFile(null, originalName) ? await getTextStats(filePath) : null;
            const label = buildStyledLabel(originalName, sizeBytes, category, probe, textStats);
            styledLink = `[${label}](${link})`;
        } catch (e) {
            // Fall back to the plain label rather than leaving the frontend hanging forever
            styledLink = `[${originalName} | ${formatBytes(sizeBytes)} | TomasekValla Filestream System](${link})`;
        }

        // Thumbnail: only video/image get one; anything else resolves to null fast.
        //
        // BUGFIX (2026-08): this used to be a bare `await` with no try/catch.
        // When thumbnail generation threw (bad codec, corrupt upload, ffmpeg
        // hiccup — anything), it became an unhandled promise rejection on
        // this top-level async IIFE, which Node treats as fatal by default
        // and kills the whole process. A thumbnail is a nice-to-have, never
        // worth crashing the server over — this now degrades to "no
        // thumbnail" instead.
        let thumbnail = null;
        try {
            thumbnail = await thumbnails.maybeGenerateThumbnail(filePath, category, fileId);
            if (thumbnail && ownerUsername) {
                userSync.patchThumbnail(ownerUsername, fileId, thumbnail);
            }
        } catch (e) {
            console.error(`⚠️  Thumbnail generation failed for ${fileId} (${originalName}) — continuing without one:`, e.message);
        }

        styledLinkStore.set(fileId, { ready: true, styledLink, thumbnail });
    })().catch(e => {
        // Final safety net — this IIFE must never reject unhandled.
        console.error(`⚠️  schedulePendingStyledLink failed for ${fileId} (${originalName}):`, e && e.message);
        styledLinkStore.set(fileId, { ready: true, styledLink: `[${originalName} | ${formatBytes(sizeBytes)} | TomasekValla Filestream System](${link})`, thumbnail: null });
    });
}

// ─── HTML escape helper (for server-side rendered landing pages) ──────────────

function escapeHtml(str) {
    return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Safely embed a value as a JS string literal inside a <script> block.
// JSON.stringify produces valid JS string/array/object literals and
// escapes </script> sequences via unicode escape so they can't break out.
function safeScriptJson(value) {
    return JSON.stringify(value).replace(/<\//g, '<\\/');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/status ─────────────────────────────────────────────────────────
// Requires authentication — exposes internal storage info.

router.get('/status', (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid) return res.status(403).json({ error: 'Unauthorized' });

    const usedBytes = getUsedSpace();
    const usedGB = (usedBytes / (1024 * 1024 * 1024)).toFixed(2);
    res.json({
        backend: 'UP',
        usedBytes,
        usedGB: `${usedGB} GB`,
        totalGB: 32,
        tier: auth.tier,
        // Cheap piggyback for multi-device "recently uploaded" sync — just an
        // integer. Client compares against its last-known version (already
        // polling this endpoint every 10s) and only calls /api/user/sync
        // when it actually changed, so no payload is wasted on every tick.
        // the host login is shared by strangers: no server-side history for it
        userVersion: auth.isHost ? 0 : userSync.getVersion(auth.username),
        // Unfinished chunked uploads for this user, across ALL their devices.
        // Small array (realistically 0-2 entries), so no separate diffing —
        // the client filters out its own in-progress upload by uploadId.
        pendingUploads: getPendingUploadsForOwner(auth.ownerKey)
    });
});

// ─── GET /api/config ─────────────────────────────────────────────────────────
// The upload rules of the caller's tier (expiry options, caps per size and free space, limits),
// so the web page and the app grey out what the server would not allow.
router.get('/config', (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid) return res.status(403).json({ error: 'Unauthorized' });
    res.set('Cache-Control', 'no-store');
    res.json(limits.clientConfig(auth.tier));
});

// ─── GET /api/space ──────────────────────────────────────────────────────────
// What uploads can still use: free space minus the 2 GB reserve (0 when only the reserve is left)
router.get('/space', (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid) return res.status(403).json({ error: 'Unauthorized' });
    res.set('Cache-Control', 'no-store');
    res.json({ availableBytes: limits.availableBytes() });
});

// ─── GET /api/user/sync ───────────────────────────────────────────────────
// Multi-device sync of "recently uploaded". Sends a full list only when the
// client has no prior version (first time / new device) or has fallen too
// far behind for the log to cover; otherwise sends just the diff ops.

router.get('/user/sync', (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid) return res.status(403).json({ error: 'Unauthorized' });

    if (auth.isHost) return res.json({ mode: 'full', version: 0, files: [] });
    const since = req.query.since !== undefined ? parseInt(req.query.since, 10) : NaN;

    if (!Number.isFinite(since) || since <= 0) {
        const full = userSync.getFullList(auth.username);
        return res.json({ mode: 'full', version: full.version, files: full.files });
    }

    const diff = userSync.getDiffSince(auth.username, since);
    if (diff.resync) {
        const full = userSync.getFullList(auth.username);
        return res.json({ mode: 'full', version: full.version, files: full.files });
    }

    res.json({ mode: 'diff', version: diff.version, ops: diff.ops });
});

// ─── POST /api/verify-password ───────────────────────────────────────────────

router.post('/verify-password', (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        return res.status(400).json({ valid: false, tier: 0 });
    }

    // Username and password are checked together against each user's own
    // secret pair — a wrong username and a wrong password both just get a
    // generic 403, so a scanner can't tell which one it got wrong.
    const { blocked, user } = checkLogin(req, res, username, password);
    if (blocked) return;
    if (!user) {
        return res.status(403).json({ valid: false, tier: 0 });
    }
    res.json({ valid: true, tier: user.tier });
});

// ─── POST /api/auth ──────────────────────────────────────────────────────────
// Verifies password and issues a random session token stored in an httpOnly cookie.
// The password hash is NEVER stored in a cookie — only the opaque session token.

router.post('/auth', (req, res) => {
    const { username, password, remember } = req.body || {};

    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        return res.status(400).json({ valid: false, error: 'Username and password required' });
    }

    const { blocked, user } = checkLogin(req, res, username, password);
    if (blocked) return;
    if (!user) {
        return res.status(403).json({ valid: false, tier: 0 });
    }
    const tier = user.tier;

    // "Stay logged in?" — yes/no, not a duration. See issueLoginCookie().
    issueLoginCookie(res, tier, user.username, remember === true || remember === 'true');

    res.json({ valid: true, tier });
});

// ─── POST /api/logout ────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
    const token = req.cookies && req.cookies.tvfs_token;
    if (token) deleteSession(token);

    // sameSite must match what /auth and issueLoginCookie() actually set
    // ('lax') for clearCookie to reliably match the cookie in every browser.
    res.clearCookie('tvfs_token', { path: '/', sameSite: 'lax', secure: true });
    res.clearCookie('tvfs_tier',  { path: '/', sameSite: 'lax', secure: true });
    res.json({ ok: true });
});

// ─── POST /api/logout-everywhere ─────────────────────────────────────────
// The logged-in user ends every one of their own sessions (all devices).
router.post('/logout-everywhere', (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid) return res.status(403).json({ error: 'Unauthorized' });
    const count = auth.isHost ? (deleteSession(req.cookies.tvfs_token), 1) : deleteUserSessions(auth.username);
    res.clearCookie('tvfs_token', { path: '/', sameSite: 'lax', secure: true });
    res.clearCookie('tvfs_tier',  { path: '/', sameSite: 'lax', secure: true });
    res.json({ ok: true, sessionsEnded: count });
});

// ─── POST /api/logout-all ─────────────────────────────────────────────────
// Invalidates EVERY currently logged-in session, everywhere, instantly —
// no restart, no manual file editing. Gated behind ADMIN_SECRET (set it in
// .env; the route is a hard 403 for everyone if that's not configured, so
// it can never be accidentally live). Meant for "I think a token leaked,
// kill everything now" — not a routine action, hence rate-limited hard.
router.post('/logout-all', rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyPrefix: 'logout-all:' }), (req, res) => {
    if (!process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'ADMIN_SECRET not configured on the server' });
    }
    const provided = String(req.headers['x-admin-secret'] || (req.body && req.body.secret) || '');
    const expected = process.env.ADMIN_SECRET;
    const a = Buffer.from(provided), b = Buffer.from(expected);
    const same = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!same) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const count = sessions.size;
    sessions.clear();
    saveSessionsSync();
    console.log(`🔐 [ADMIN] All ${count} session(s) invalidated via /api/logout-all`);
    res.json({ ok: true, sessionsCleared: count });
});

// Ids taken from the URL go into file paths and registry lookups: strict format or 400
router.param('uploadId', (req, res, next, value) => {
    if (!security.isUploadId(value)) return res.status(400).json({ error: 'Invalid upload ID' });
    next();
});

// ─── GET /api/upload/status/:uploadId ────────────────────────────────────────
// Used by frontend to check if a previous chunked upload is still resumable

router.get('/upload/status/:uploadId', (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid) return res.status(403).json({ error: 'Invalid password' });

    const { uploadId } = req.params;
    const manifest = readManifest(uploadId);

    if (!manifest) {
        return res.json({ active: false });
    }

    // Don't leak another session's filename/progress just because both are
    // "authenticated" — resume status is only meaningful to whoever started it.
    if (manifest.ownerKey && manifest.ownerKey !== auth.ownerKey) {
        return res.json({ active: false });
    }

    // Consider uploads stale after 24h
    const age = Date.now() - (manifest.createdAt || 0);
    if (age > 24 * 60 * 60 * 1000 || manifest.status === 'completed') {
        return res.json({ active: false });
    }

    res.json({
        active: true,
        uploadId: manifest.uploadId,
        receivedChunks: manifest.receivedChunks || [],
        totalChunks: manifest.totalChunks,
        filename: manifest.filename,
        fileSize: manifest.fileSize
    });
});

// ─── DELETE /api/upload/chunks/:uploadId ─────────────────────────────────────
// "Delete from Recently Not Finished" — wipes whatever chunks already landed
// on the server for an unfinished upload, right now, instead of waiting for
// the 24h sweep. This is DIFFERENT from the client just clearing its own
// localStorage resume record (that only forgets about it locally/across the
// user's other devices — the chunks themselves stay until this is called,
// or until they naturally age out).

router.delete('/upload/chunks/:uploadId', async (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid) return res.status(403).json({ error: 'Invalid password' });

    const { uploadId } = req.params;
    const manifest = readManifest(uploadId);
    if (!manifest) {
        return res.json({ deleted: false, reason: 'already gone' });
    }
    if (manifest.ownerKey && manifest.ownerKey !== auth.ownerKey) {
        return res.status(403).json({ error: 'This upload session belongs to a different session' });
    }
    if (assemblyInProgress.has(uploadId)) {
        return res.status(409).json({ error: 'This upload is being assembled right now' });
    }

    const removedChunks = await withManifestLock(uploadId, async () => deleteChunksAndManifest(uploadId));

    requestLogger.logEvent(req, 'deleted_unfinished', {
        uploadId,
        filename: manifest.filename || null,
        ownerUsername: auth.username || null,
        ownerTier: auth.tier,
        chunksRemoved: removedChunks
    });

    console.log(`🗑️  [KILL/DELETE UNFINISHED] ${uploadId} (${manifest.filename || 'unknown'}) — ${removedChunks} chunks wiped`);

    res.json({ deleted: true, chunksRemoved: removedChunks });
});

// ─── DELETE /api/file/:id ─────────────────────────────────────────────────────
// "Delete from Recently Uploaded" — immediately removes a completed upload
// from disk (plus its thumbnail/registry entry), rather than leaving it to
// sit until its expiresAt is hit by the cleanup cron. The request-log entry
// is what "remembers" this was a manual deletion for future reference —
// CRON doesn't need to care, since the registry entry (and the file it
// pointed to) is simply gone.

// Removes one upload with its thumbnail, reader/player pages, batch link and the owner's history
// entry. Returns the size it had. reason: 'manual' | 'host-space' | 'evicted' (the cleanup uses its own pass)
function removeFile(file, reason) {
    let size = file.size || 0;
    try {
        if (file.path && fs.existsSync(file.path)) {
            size = fs.statSync(file.path).size;
            if (isPathReferenced(file.path, file)) {
                console.warn(`⚠️  [DELETE] Skipping unlink of ${file.path}: still referenced by another registry entry`);
            } else {
                fs.unlinkSync(file.path);
            }
        }
    } catch (e) {
        console.error(`⚠️  [DELETE] Failed to unlink ${file.path}:`, e.message);
    }
    thumbnails.deleteThumbnail(file.id);
    // Generated reader/player pages; older uploads may share one page, keep it while another file links to it
    const pageDirs = { textReaderLink: dirs.text, mdReaderLink: dirs.text, audioPlayerLink: dirs.players };
    for (const [linkField, pageDir] of Object.entries(pageDirs)) {
        if (!file[linkField]) continue;
        if (registry.files.some(f => f !== file && f[linkField] === file[linkField])) continue;
        try {
            const pagePath = path.join(pageDir, path.basename(file[linkField]));
            if (fs.existsSync(pagePath)) fs.unlinkSync(pagePath);
        } catch (e) {}
    }
    const idx = registry.files.indexOf(file);
    if (idx !== -1) registry.files.splice(idx, 1);
    if (file.batchId) {
        const batchEntry = registry.batches.find(b => b.id === file.batchId);
        if (batchEntry) batchEntry.files = batchEntry.files.filter(fid => fid !== file.id);
    }
    saveRegistry();
    // an evicted file stays in Recently uploaded, marked "removed early" (markGone)
    const owner = file.ownerKey && file.ownerKey.startsWith('user:') ? file.ownerKey.slice(5) : null;
    if (owner && reason !== 'evicted') userSync.recordRemoval(owner, file.id);
    if (reason !== 'manual') console.log(`🗑️  [${reason.toUpperCase()}] ${file.originalName || file.storedName} (${formatBytes(size)})`);
    return size;
}

router.delete('/file/:id', async (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid) return res.status(403).json({ error: 'Invalid password' });

    const fileId = req.params.id;
    const idx = registry.files.findIndex(f => f.id === fileId);
    if (idx === -1) {
        return res.json({ deleted: false, reason: 'already gone' });
    }
    const file = registry.files[idx];

    // Owner only. Entries without an owner (from before owners were recorded) only the top tier may delete.
    const mayDelete = file.ownerKey ? file.ownerKey === auth.ownerKey : auth.tier >= 2;
    if (!mayDelete) {
        return res.status(403).json({ error: 'This file belongs to a different session' });
    }

    const sizeForLog = removeFile(file, 'manual');

    requestLogger.logEvent(req, 'deleted_manual', {
        fileId,
        filename: file.originalName || file.storedName,
        size: sizeForLog,
        deletedAt: Date.now(),
        ownerUsername: auth.username || null,
        ownerTier: auth.tier
    });

    console.log(`🗑️  [MANUAL DELETE] ${file.originalName || file.storedName} (${formatBytes(sizeForLog)})`);

    res.json({ deleted: true });
});

// ─── POST /api/file/:id/keep-max ─────────────────────────────────────────────
// "Keep for the maximum length": the file stays as long as the rules allow for the owner's tier
// and its size, counted from the upload (never shorter than now).
router.post('/file/:id/keep-max', (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid) return res.status(403).json({ error: 'Unauthorized' });
    const file = registry.files.find(f => f.id === req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found' });
    if (!file.ownerKey || file.ownerKey !== auth.ownerKey) return res.status(403).json({ error: 'Only the uploader can change this' });
    // the file is already on disk, so the free-space rules count without it
    const available = limits.availableBytes();
    const maxMin = limits.maxExpiryMinutes(auth.tier, file.size || 0, available === null ? null : available + (file.size || 0));
    const target = auth.tier === 0 ? limits.maxExpiryMinutes(0, 0) * 60000 + Date.now() : (file.uploadedAt || Date.now()) + maxMin * 60000;
    if (target > file.expiresAt) {
        file.expiresAt = target;
        for (const f of registry.files) {
            // its reader / player pages live as long as the file
            if (f !== file && (f.path && [file.textReaderLink, file.mdReaderLink, file.audioPlayerLink].some(l => l && l.endsWith('/' + f.storedName)))) f.expiresAt = target;
        }
        saveRegistry();
        if (auth.username && !auth.isHost) userSync.patchEntry(auth.username, file.id, { expiresAt: target });
    }
    res.json({ expiresAt: file.expiresAt, maxReached: true });
});

// ─── Settings, expired pages, statistics ─────────────────────────────────────

router.get('/settings', (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid || auth.isHost) return res.status(403).json({ error: 'Unauthorized' });
    res.set('Cache-Control', 'no-store');
    res.json(userSettings.get(auth.username));
});

router.put('/settings', (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid || auth.isHost) return res.status(403).json({ error: 'Unauthorized' });
    const err = userSettings.set(auth.username, req.body);
    if (err) return res.status(400).json({ error: err });
    res.json(userSettings.get(auth.username));
});

// The owner removes an "expired" (410) record from Recently uploaded: the link then answers 404
router.delete('/expired/:fileId', (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid || auth.isHost) return res.status(403).json({ error: 'Unauthorized' });
    const removed = expiredPages.removeForOwner(req.params.fileId, auth.ownerKey);
    userSync.recordRemoval(auth.username, req.params.fileId);
    res.json({ removed });
});

// Opens and plays of the caller's files, plus the numbers of the whole TVFS history
router.get('/stats', (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid || auth.isHost) return res.status(403).json({ error: 'Unauthorized' });
    const ids = registry.files.filter(f => f.ownerKey === auth.ownerKey).map(f => f.id);
    const syncIds = (userSync.getFullList(auth.username).files || []).map(f => f.id);
    res.set('Cache-Control', 'no-store');
    res.json({ global: stats.global(), files: stats.forFiles(new Set([...ids, ...syncIds])) });
});

// The registry entry behind a public link path; a reader/player page counts for its file
function fileForLinkPath(linkPath) {
    const m = /^\/files\/([a-z]+)\/([^/]+)$/.exec(linkPath);
    if (!m) return null;
    const entry = registry.files.find(f => f.directory === m[1] && f.storedName === m[2]);
    if (!entry) return null;
    if (entry.isTextReader || entry.isMdReader || entry.isAudioPlayer) {
        const tail = '/' + entry.storedName;
        return registry.files.find(f => [f.textReaderLink, f.mdReaderLink, f.audioPlayerLink].some(l => l && l.endsWith(tail))) || entry;
    }
    return entry;
}

// The player pages report the first play
router.post('/play', rateLimit({ windowMs: 60 * 1000, max: 30, keyPrefix: 'play:' }), (req, res) => {
    let page = String((req.body && req.body.page) || '');
    try { page = decodeURIComponent(new URL(page, 'https://x').pathname); } catch (e) { page = ''; }
    const file = fileForLinkPath(page);
    if (file) stats.countPlay(file.id, security.clientIp(req));
    res.status(204).end();
});

// ─── Internal routes, only for the site nginx (not reachable through the public proxy) ───
const internal = express.Router();

// nginx mirrors every request for /files/ here; one open per client address and file per hour
internal.get('/count', (req, res) => {
    let p = String(req.query.u || '').split('?')[0];
    try { p = decodeURIComponent(p); } catch (e) { return res.status(204).end(); }
    // previews in the upload page's own lists are not opens
    const referer = String(req.headers.referer || '');
    if (/\/upload(\.html)?(\?|#|$)/.test(referer.replace(/^https?:\/\/[^/]+/, ''))) return res.status(204).end();
    const file = fileForLinkPath(p);
    if (file) stats.countOpen(file.id, security.clientIp(req));
    res.status(204).end();
});

// A missing /files/ link: 410 "expired" when it has an expired-page record, otherwise 404
internal.get(/^\/gone(\/files\/.+)$/, (req, res) => {
    let p = req.params[0];
    try { p = decodeURIComponent(p); } catch (e) {}
    const rec = expiredPages.lookup(p);
    res.set('Cache-Control', 'no-store');
    res.status(rec ? 410 : 404).type('html').send(gonePage(rec));
});

function gonePage(rec) {
    const title = rec ? (rec.early ? 'This file was removed early' : 'This file has expired') : 'Not found';
    const text = rec
        ? (rec.early ? 'The server ran out of space, so this file was removed before its time.' : 'Files on TVFS are kept only for a limited time. This one is no longer available.')
        : 'There is no file at this address. The link may be wrong or the file may have expired.';
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - TVFS</title><style>
:root{color-scheme:light dark;--bg:#0f1115;--fg:#e8eaf0;--muted:#9aa3b2;--card:#171a21;--accent:#7c9cff}
@media (prefers-color-scheme:light){:root{--bg:#f4f6fb;--fg:#151821;--muted:#5b6474;--card:#fff;--accent:#3a5bd9}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
main{max-width:440px;background:var(--card);border-radius:16px;padding:28px 26px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.25)}
h1{font-size:1.35rem;margin:0 0 10px}p{color:var(--muted);margin:0 0 20px}a{color:var(--accent);font-weight:600;text-decoration:none}
</style></head><body><main><h1>${title}</h1><p>${text}</p><a href="/upload.html">Go to TVFS</a></main></body></html>`;
}

// ─── GET /api/upload/styled-link/:fileId ─────────────────────────────────────
// Polled by the frontend while ffprobe metadata (bitrate/fps/resolution/…) is
// still being computed in the background, right after upload completion.

router.get('/upload/styled-link/:fileId', (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid) return res.status(403).json({ error: 'Unauthorized' });
    const entry = styledLinkStore.get(req.params.fileId);
    if (!entry || styledLinkOwners.get(req.params.fileId) !== auth.ownerKey) return res.json({ ready: false });
    res.json(entry);
});

// ─── POST /api/upload/init ───────────────────────────────────────────────────

// Upload limits. A chunk is at most 105 MB (see chunkUpload), the smallest the web sends is 96 KB.
const MAX_CHUNKS = 200000;

function hasRoomFor(bytes) {
    const available = limits.availableBytes();
    return available === null || bytes <= available;
}

function batchBytes(batch) {
    return registry.files.filter(f => batch.files.includes(f.id)).reduce((sum, f) => sum + (f.size || 0), 0);
}

// Tier 0 shares one 1 GB budget: the oldest host uploads go first to make room
function makeHostRoom(needed) {
    const hostFiles = () => registry.files.filter(f => f.ownerKey && f.ownerKey.startsWith('host:'));
    let used = hostFiles().reduce((sum, f) => sum + (f.size || 0), 0);
    for (const f of hostFiles().sort((a, b) => (a.uploadedAt || 0) - (b.uploadedAt || 0))) {
        if (used + needed <= limits.HOST_TOTAL_BYTES) break;
        used -= removeFile(f, 'host-space');
    }
}

// Size, batch, tier and free-space rules for a new upload; gives the expiry in minutes it gets
function admitUpload(auth, size, batch, requestedExpiry) {
    const maxFile = limits.maxFileBytes(auth.tier);
    if (size > maxFile) return { ok: false, status: 413, error: `Too large: at most ${formatBytes(maxFile)} per file` };
    if (batch && batchBytes(batch) + size > limits.MAX_FILE_BYTES) return { ok: false, status: 413, error: 'A batch can hold at most 5 GB' };
    if (auth.tier === 0) makeHostRoom(size);
    const expMinutes = limits.effectiveExpiryMinutes(auth.tier, size, requestedExpiry);
    if (expMinutes <= 0) return { ok: false, status: 507, error: 'Not enough free space on the server for this file right now' };
    return { ok: true, expMinutes };
}

// Stored name: the original base name plus a short random suffix (shorter for higher tiers;
// tier 3, and tier 2 asking for it, get no suffix while the name is free)
function storedName(base, ext, tier, noSuffix) {
    if (noSuffix) return `${base}${ext}`;
    return `${base}_${security.randomSuffix(limits.SUFFIX_LENGTH[tier] || 6)}${ext}`;
}

// A display name from the client: no path, no control characters, bounded length
function cleanFilename(raw) {
    const s = String(raw == null ? '' : raw).replace(/[\x00-\x1f\x7f]/g, '').split(/[\\/]/).pop().trim();
    return s.slice(0, 255) || 'file';
}

// The batch a new file may join: it must belong to the uploader. A batch that is gone
// (expired meanwhile) only means the file is stored without a batch.
function ownBatch(batchId, auth) {
    if (!batchId) return { ok: true, batch: null };
    if (!security.isBatchId(batchId)) return { ok: false, status: 400, error: 'Invalid batchId' };
    const batch = registry.batches.find(b => b.id === batchId);
    if (!batch) return { ok: true, batch: null, missing: true };
    if (batch.ownerKey !== auth.ownerKey) return { ok: false, status: 403, error: 'This batch belongs to someone else' };
    return { ok: true, batch };
}

router.post('/upload/init', rateLimit({ windowMs: 60 * 1000, max: 20, keyPrefix: 'init:' }), (req, res) => {
    const { fileSize, totalChunks, uploadMode, expirationMinutes, batchId, voiceNote } = req.body || {};

    const auth = authenticateRequest(req);
    if (!auth.valid) {
        return res.status(403).json({ error: 'Invalid password' });
    }

    const filename = cleanFilename(req.body && req.body.filename);
    const mimeType = cleanMimeType(req.body && req.body.mimeType);
    const size = Number(fileSize);
    if (!Number.isSafeInteger(size) || size < 0) {
        return res.status(400).json({ error: 'Missing or invalid fileSize' });
    }
    let chunks = null;
    if (totalChunks !== undefined && totalChunks !== null && totalChunks !== '') {
        chunks = Number(totalChunks);
        if (!Number.isSafeInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS) {
            return res.status(400).json({ error: `totalChunks must be 1-${MAX_CHUNKS}` });
        }
    }
    const batchCheck = ownBatch(batchId, auth);
    if (!batchCheck.ok) return res.status(batchCheck.status).json({ error: batchCheck.error });
    const admit = admitUpload(auth, size, batchCheck.batch, expirationMinutes);
    if (!admit.ok) return res.status(admit.status).json({ error: admit.error });
    const expMinutes = admit.expMinutes;

    const uploadId = `${Date.now()}_${crypto.randomBytes(12).toString('hex')}`;

    const manifest = {
        uploadId,
        filename,
        fileSize: size,
            mimeType,
            // Fixed-size uploads know their chunk count upfront. Auto/dynamic
            // uploads pick each chunk's size live as they go, so the total
            // isn't known until the chunk flagged isLastChunk actually lands
            // (see /upload/chunk below) — totalChunks stays null until then,
            // and /upload/complete refuses to assemble before it's set.
            totalChunks: chunks,
            uploadMode: ['fast', 'safe', 'weak'].includes(uploadMode) ? uploadMode : 'fast',
            receivedChunks: [],
            receivedBytes: 0,
            createdAt: Date.now(),
            status: 'initialized',
            expirationMinutes: expMinutes,
            batchId: batchCheck.batch ? batchCheck.batch.id : null,
            ...(wantsVoiceNote(voiceNote, mimeType) ? { voiceNote: true } : {}),
            ownerKey: auth.ownerKey,
            ownerTier: auth.tier
    };

    writeManifest(uploadId, manifest);

    requestLogger.logEvent(req, 'init', {
        uploadId,
        filename,
        fileSize: parseInt(fileSize) || 0,
        mimeType,
        expirationMinutes: expMinutes,
        ownerUsername: auth.username || null,
        ownerTier: auth.tier
    });

    console.log(`🚀 [CHUNKED UPLOAD INIT] ${filename} (${totalChunks || 'dynamic'} chunks, mode: ${uploadMode || 'fast'}, expires: ${expMinutes}min) - ID: ${uploadId}`);

    res.json({
        uploadId,
        message: 'Upload initialized',
        recommendedParallel: 4
    });
});

// ─── POST /api/upload/chunk ──────────────────────────────────────────────────

// 96 KB chunks x 8 connections on a flaky link easily means 10-30 req/s (and the
// limiter is keyed on req.ip, which behind nginx + the Cloudflare tunnel can be
// ONE shared address for every visitor). The old 300/min ceiling turned the
// weak-connection mode into a 429 storm. Override with TVFS_CHUNK_RATE_MAX.
const CHUNK_RATE_MAX_PER_MIN = parseInt(process.env.TVFS_CHUNK_RATE_MAX, 10) || 2400;

router.post('/upload/chunk', rateLimit({ windowMs: 60 * 1000, max: CHUNK_RATE_MAX_PER_MIN, keyPrefix: 'chunk:' }), requireSession, chunkUpload.single('chunk'), async (req, res) => {
    const { uploadId, chunkIndex, isLastChunk } = req.body || {};
    const auth = req.auth; // checked by requireSession before the body was read

    if (!security.isUploadId(uploadId)) {
        if (req.file && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(400).json({ error: 'Missing or invalid upload ID' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'No chunk uploaded' });
    }

    // Ownership check: don't let a different authenticated party (e.g. a
    // lower-tier password holder) write into an upload session they didn't
    // start, even though they're both "valid" auth.
    const ownerCheckManifest = readManifest(uploadId);
    if (ownerCheckManifest && ownerCheckManifest.ownerKey && ownerCheckManifest.ownerKey !== auth.ownerKey) {
        if (fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(403).json({ error: 'This upload session belongs to a different session' });
    }

    const index = parseInt(chunkIndex);

    if (isNaN(index)) {
        console.error(`❌ [CHUNK ERROR] chunkIndex is NaN — uploadId: ${uploadId}`);
        if (fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(400).json({ error: 'Missing or invalid chunkIndex', received: chunkIndex });
    }

    // Integrity: a connection that drops mid-body must never be stored as a
    // "received" chunk. The client sends the exact byte length it intended to
    // send; anything else (truncated multipart that still parsed) is rejected
    // and simply gets retried. Optional field -> older cached clients still work.
    const declaredSize = parseInt(req.body.chunkSize, 10);
    if (!isNaN(declaredSize) && declaredSize !== req.file.size) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(400).json({ error: `Chunk size mismatch (got ${req.file.size}, expected ${declaredSize})` });
    }

    const tmpPath = req.file.path;
    const dropTmp = () => { try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {} };

    try {
        const numberedChunkPath = path.join(dirs.chunks, `${uploadId}_chunk_${String(index).padStart(4, '0')}`);

        // IMPORTANT: the temp file is only moved to its final numbered name
        // INSIDE the lock, AFTER the duplicate check. It used to be renamed first,
        // so a retry of an already-stored chunk (client timed out / dropped
        // before seeing our 200) overwrote the good file and then the duplicate
        // branch unlinked it - manifest said "received", file was gone, and
        // /complete died with "Missing chunk file" and wiped the whole upload.
        const result = await withManifestLock(uploadId, async () => {
            const manifest = readManifest(uploadId);

            if (!manifest) {
                return { error: 'Invalid upload ID or upload expired', status: 400 };
            }

            if (index < 0 || index >= MAX_CHUNKS || (manifest.totalChunks !== null && index >= manifest.totalChunks)) {
                return { error: `Invalid chunk index: ${index}`, status: 400 };
            }
            if (assemblyInProgress.has(uploadId)) {
                return { error: 'Upload is already being assembled', status: 409 };
            }

            if (manifest.receivedChunks.includes(index)) {
                console.log(`⚠️  [DUPLICATE CHUNK] ${uploadId} - chunk ${index} already received`);
                if (fs.existsSync(numberedChunkPath)) {
                    dropTmp(); // keep the stored chunk, discard only the retry's copy
                } else {
                    // Self-heal: manifest claims it, disk doesn't have it (left over
                    // from the old bug, or a partial cleanup). Adopt the fresh copy.
                    fs.renameSync(tmpPath, numberedChunkPath);
                    console.log(`🩹 [CHUNK HEALED] ${uploadId} - chunk ${index} was missing on disk, restored from retry`);
                }
                return {
                    success: true,
                    chunkIndex: index,
                    received: manifest.receivedChunks.length,
                    total: manifest.totalChunks,
                    duplicate: true
                };
            }

            // Never more bytes than the file was declared with (manifests from before this check have no counter)
            const receivedBytes = typeof manifest.receivedBytes === 'number' ? manifest.receivedBytes : null;
            if (receivedBytes !== null && receivedBytes + req.file.size > manifest.fileSize) {
                return { error: 'Chunk exceeds the declared file size', status: 400 };
            }

            fs.renameSync(tmpPath, numberedChunkPath);

            if (receivedBytes !== null) manifest.receivedBytes = receivedBytes + req.file.size;
            manifest.receivedChunks.push(index);
            manifest.receivedChunks.sort((a, b) => a - b);
            manifest.lastChunkTime = Date.now();

            // Dynamic/auto uploads don't know their total chunk count at
            // /init time - each chunk's size is picked live as it's sent, so
            // the client flags whichever chunk actually reaches the end of
            // the file. That's the only point the total becomes knowable.
            if (isLastChunk === true || isLastChunk === 'true') {
                manifest.totalChunks = index + 1;
            }

            try {
                writeManifest(uploadId, manifest);
            } catch (e) {
                // Don't leave an orphan the manifest doesn't know about.
                try { fs.unlinkSync(numberedChunkPath); } catch (e2) {}
                throw e;
            }

            console.log(`📦 [CHUNK RECEIVED] ${uploadId} - chunk ${index}/${manifest.totalChunks}`);

            return {
                success: true,
                chunkIndex: index,
                received: manifest.receivedChunks.length,
                total: manifest.totalChunks
            };
        });

        if (result.error) {
            dropTmp(); // never touch the numbered file here - it may be a valid stored chunk
            return res.status(result.status || 400).json({ error: result.error });
        }

        res.json(result);

    } catch (error) {
        console.error(`❌ [CHUNK ERROR] ${uploadId} chunk ${index}:`, error);
        dropTmp();
        res.status(500).json({ error: 'Chunk processing failed', details: error.message });
    }
});

// ─── POST /api/upload/complete ───────────────────────────────────────────────

router.post('/upload/complete', async (req, res) => {
    const { uploadId, anonymize, removeTimestamp, expirationMinutes, batchId } = req.body || {};

    const auth = authenticateRequest(req);
    if (!auth.valid) {
        return res.status(403).json({ error: 'Invalid password' });
    }
    mediaQueue.enterPriority(limits.MEDIA_PRIORITY[auth.tier] || 0);

    if (!security.isUploadId(uploadId)) {
        return res.status(400).json({ error: 'Missing or invalid upload ID' });
    }

    const manifest = readManifest(uploadId);

    if (!manifest) {
        return res.status(400).json({ error: 'Invalid upload ID or upload expired' });
    }

    if (manifest.ownerKey && manifest.ownerKey !== auth.ownerKey) {
        return res.status(403).json({ error: 'This upload session belongs to a different session' });
    }

    if (manifest.totalChunks === null) {
        return res.status(400).json({ error: 'Upload not finished — final chunk not yet confirmed by the server' });
    }

    if (manifest.receivedChunks.length !== manifest.totalChunks) {
        // Reports at most 100 missing indexes: the total comes from the client and must not size an array
        const have = new Set(manifest.receivedChunks);
        const missing = [];
        for (let i = 0; i < manifest.totalChunks && missing.length < 100; i++) {
            if (!have.has(i)) missing.push(i);
        }
        return res.status(400).json({
            error: 'Missing chunks',
            received: manifest.receivedChunks.length,
            expected: manifest.totalChunks,
            missing,
            missingCount: manifest.totalChunks - have.size
        });
    }
    if (typeof manifest.receivedBytes === 'number' && manifest.receivedBytes !== manifest.fileSize) {
        return res.status(400).json({ error: `Received ${manifest.receivedBytes} bytes, the file was declared with ${manifest.fileSize}` });
    }

    // A batch named now (instead of at init) must belong to the uploader too
    const batchCheck = ownBatch(batchId || manifest.batchId, auth);
    if (!batchCheck.ok) return res.status(batchCheck.status).json({ error: batchCheck.error });

    // ── Assembly guard: reject duplicate concurrent complete requests ──────
    if (assemblyInProgress.has(uploadId)) {
        return res.status(409).json({ error: 'Assembly already in progress for this upload' });
    }
    assemblyInProgress.add(uploadId);

    // Release mutex — all chunks are in, no more chunk writes expected
    manifestMutexes.delete(uploadId);

    console.log(`🔗 [ASSEMBLING] ${manifest.filename} from ${manifest.totalChunks} chunks`);

    // Exact path of the file being assembled, so a failure removes only it
    let assembledPath = null;

    try {
        const destDir = getDestDir(manifest.mimeType, manifest.filename);
        const category = getDirCategory(destDir);
        const rawExt = path.extname(manifest.filename);
        let name = path.basename(manifest.filename, rawExt);
        const ext = safeExt(rawExt);

        const isAnonymized = anonymize === true || anonymize === 'true';

        if (isAnonymized) {
            name = security.randomName(16);
        } else {
            name = name.normalize('NFD').replace(/[̀-ͯ]/g, '') // "Země" -> "Zeme" instead of "Zem_"
            .replace(/\s+/g, '_')
            .replace(/[^\w\-_.]/g, '_')
            .replace(/_+/g, '_');
        }

        // Anonymous files never get a timestamp; tier 2 may opt out of it.
        // The final name is decided up front and created exclusively, so the
        // assembled file never replaces an existing one and needs no rename.
        const dropTimestamp = !isAnonymized && name.length > 0 && /^(\.\w+)?$/.test(ext)
            && (auth.tier === 3 || ((removeTimestamp === true || removeTimestamp === 'true') && auth.tier >= 2));
        const wantedFilename = isAnonymized ? `${name}${ext}` : storedName(name, ext, auth.tier, dropTimestamp);
        const { filename: finalFilename, filePath: finalPath, fd } = safeFs.openUnique(destDir, wantedFilename);
        assembledPath = finalPath;
        if (dropTimestamp) console.log(`✂️ Removed timestamp: ${finalFilename}`);

        // Streaming assembly. A write error (full disk, I/O) must reject this request,
        // never become an uncaught 'error' event that takes the whole process down.
        const writeStream = fs.createWriteStream(finalPath, { fd });
        const writeFailed = new Promise((_, reject) => writeStream.once('error', reject));
        writeFailed.catch(() => {});

        for (let i = 0; i < manifest.totalChunks; i++) {
            const chunkPath = path.join(dirs.chunks, `${uploadId}_chunk_${String(i).padStart(4, '0')}`);

            if (!fs.existsSync(chunkPath)) {
                writeStream.destroy();
                throw new Error(`Missing chunk file: ${i}`);
            }

            await Promise.race([writeFailed, new Promise((resolve, reject) => {
                const readStream = fs.createReadStream(chunkPath);
                readStream.on('error', reject);
                readStream.on('end', resolve);
                readStream.pipe(writeStream, { end: false });
            })]);
            await fs.promises.unlink(chunkPath).catch(() => {});
        }

        writeStream.end();
        await Promise.race([writeFailed, new Promise(resolve => writeStream.once('finish', resolve))]);

        const finalStats = fs.statSync(finalPath);
        console.log(`📊 Assembly complete: ${finalStats.size} bytes`);
        assembledPath = null; // fully written — from here on it is a real upload

        // Clean up manifest
        const manifestPath = path.join(dirs.chunks, `${uploadId}_manifest.json`);
        if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

        // Build link
        const linkPath = `/files/${category}/${finalFilename}`;
        const link = `https://files.tomasekvalla.cz${linkPath}`;

        // Expiration — prefer the value sent now, fall back to what was set at init time
        const expMinutes = (expirationMinutes && limits.effectiveExpiryMinutes(auth.tier, manifest.fileSize, expirationMinutes)) || manifest.expirationMinutes || limits.effectiveExpiryMinutes(auth.tier, manifest.fileSize, null);
        const expiresAt = Date.now() + (expMinutes * 60 * 1000);

        // Register in file registry
        const fileId = generateFileId();
        const textReaderLink = maybeCreateTextReader(finalFilename, manifest.filename, manifest.mimeType, expiresAt, link, auth.ownerKey);
        const textReaderStyledLink = textReaderLink
            ? `[${manifest.filename} - TomasekValla Filestream System Reader](${textReaderLink})`
            : null;
        const mdReaderLink = maybeCreateMdReader(finalFilename, manifest.filename, manifest.mimeType, expiresAt, link, auth.ownerKey);
        const mdReaderStyledLink = mdReaderLink ? `[${manifest.filename} - TVFS MD Reader](${mdReaderLink})` : null;
        const audioPlayerResult = (getFileType(manifest.mimeType) === 'audio' && !auth.isHost)
            ? await maybeCreateAudioPlayer(finalFilename, manifest.filename, manifest.mimeType, finalPath, link, expiresAt, manifest.voiceNote === true, auth.ownerKey)
            : null;
        const audioPlayerLink = audioPlayerResult ? audioPlayerResult.playerUrl : null;
        const audioPlayerStyledLink = audioPlayerResult
            ? audioStyledLink(audioPlayerResult, manifest.filename, audioPlayerLink)
            : null;
        // the flag counts only if the server accepted it (real audio, short enough)
        const isVoiceNote = manifest.voiceNote === true && (!audioPlayerResult || audioPlayerResult.voiceNote);
        registry.files.push({
            id: fileId,
            originalName: manifest.filename,
            storedName: finalFilename,
            path: finalPath,
            directory: category,
            size: finalStats.size,
            mimeType: manifest.mimeType,
            category: getFileType(manifest.mimeType),
                            uploadedAt: Date.now(),
                            expiresAt: expiresAt,
                            batchId: batchCheck.batch ? batchCheck.batch.id : null,
                            textReaderLink: textReaderLink || null,
                            mdReaderLink: mdReaderLink || null,
                            audioPlayerLink: audioPlayerLink || null,
                            trackBpm: audioPlayerResult ? audioPlayerResult.meta.bpm : null,
                            ...(isVoiceNote ? { voiceNote: true } : {}),
                            ownerKey: auth.ownerKey || manifest.ownerKey || null,
                            ownerTier: auth.tier
        });

        // If part of a batch (checked above: it exists and is the uploader's), add the file to it
        if (batchCheck.batch) batchCheck.batch.files.push(fileId);

        saveRegistry();

        stats.countUpload(registry.files[registry.files.length - 1] ? registry.files[registry.files.length - 1].size : 0);

        requestLogger.logEvent(req, 'complete', {
            uploadId,
            fileId,
            filename: manifest.filename,
            storedName: finalFilename,
            size: finalStats.size,
            mimeType: manifest.mimeType,
            expiresAt,
            ownerUsername: auth.username || null,
            ownerTier: auth.tier
        });

        console.log(`✅ [CHUNKED UPLOAD COMPLETE] ${finalFilename} (${(finalStats.size / 1024 / 1024).toFixed(2)} MB, expires: ${new Date(expiresAt).toISOString()})`);

        if (auth.isHost) plainStyledLink(fileId, manifest.filename, finalStats.size, link, auth.ownerKey);
        else schedulePendingStyledLink(fileId, manifest.filename, finalPath, finalStats.size, getFileType(manifest.mimeType), link, auth.username);

        if (auth.username && !auth.isHost) {
            userSync.recordUpload(auth.username, {
                id: fileId,
                name: manifest.filename,
                link,
                category: getFileType(manifest.mimeType),
                size: finalStats.size,
                uploadedAt: Date.now(),
                expiresAt,
                thumbnail: null,
                ...(isVoiceNote ? { voiceNote: true } : {})
            });
        }

        res.json({
            message: 'Upload successful',
            link,
            styledLinkPending: true,
                 type: getFileType(manifest.mimeType),
                 filename: finalFilename,
                 size: finalStats.size,
                 fileId,
                 textReaderLink: textReaderLink || null,
                 textReaderStyledLink: textReaderStyledLink || null,
                 mdReaderLink: mdReaderLink || null,
                 mdReaderStyledLink: mdReaderStyledLink || null,
                 audioPlayerLink: audioPlayerLink || null,
                 audioPlayerStyledLink: audioPlayerStyledLink || null,
                 trackBpm: audioPlayerResult ? audioPlayerResult.meta.bpm : null,
                 ...(isVoiceNote ? { voiceNote: true } : {}),
                 thumbnailPending: true
        });

    } catch (error) {
        requestLogger.logEvent(req, 'failed', {
            uploadId,
            filename: manifest.filename,
            mimeType: manifest.mimeType,
            error: error.message,
            ownerUsername: auth.username || null,
            ownerTier: auth.tier
        });
        console.error(`❌ [CHUNKED UPLOAD FAILED] ${manifest.filename}:`, error);

        // Clean up chunks
        for (let i = 0; i < manifest.totalChunks; i++) {
            const chunkPath = path.join(dirs.chunks, `${uploadId}_chunk_${String(i).padStart(4, '0')}`);
            if (fs.existsSync(chunkPath)) {
                try { fs.unlinkSync(chunkPath); } catch (e) {}
            }
        }

        // Clean up manifest
        const manifestPath = path.join(dirs.chunks, `${uploadId}_manifest.json`);
        if (fs.existsSync(manifestPath)) {
            try { fs.unlinkSync(manifestPath); } catch (e) {}
        }

        // Clean up the partially assembled file (exact path, never a pattern)
        if (assembledPath) {
            try { fs.unlinkSync(assembledPath); } catch (e) {}
        }

        res.status(500).json({ error: 'Upload assembly failed', details: error.message });
    } finally {
        assemblyInProgress.delete(uploadId);
    }
});

// ─── POST /api/upload/batch/init ─────────────────────────────────────────────

router.post('/upload/batch/init', rateLimit({ windowMs: 60 * 1000, max: 20, keyPrefix: 'batchinit:' }), (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid) {
        return res.status(403).json({ error: 'Invalid password' });
    }

    const { expirationMinutes } = req.body;
    const expiresAt = Date.now() + (limits.effectiveExpiryMinutes(auth.tier, 0, expirationMinutes) || 60) * 60 * 1000;

    const batchId = generateBatchId();

    registry.batches.push({
        id: batchId,
        createdAt: Date.now(),
                          expiresAt: expiresAt,
                          files: [],
                          landingPage: null,
                          ownerKey: auth.ownerKey
    });

    saveRegistry();

    console.log(`📦 [BATCH INIT] ${batchId} (expires: ${new Date(expiresAt).toISOString()})`);

    res.json({ batchId });
});

// ─── POST /api/upload/batch/complete ─────────────────────────────────────────

router.post('/upload/batch/complete', async (req, res) => {
    const { batchId } = req.body;

    const auth = authenticateRequest(req);
    if (!auth.valid) {
        return res.status(403).json({ error: 'Invalid password' });
    }

    if (!batchId) {
        return res.status(400).json({ error: 'Missing batchId' });
    }

    const batchCheck = ownBatch(batchId, auth);
    if (!batchCheck.ok) return res.status(batchCheck.status).json({ error: batchCheck.error });
    const batchEntry = batchCheck.batch;
    if (!batchEntry) return res.status(404).json({ error: 'Batch not found' });

    // Get all files belonging to this batch
    const batchFiles = registry.files.filter(f => batchEntry.files.includes(f.id));

    if (batchFiles.length === 0) {
        return res.status(400).json({ error: 'No files in batch' });
    }

    // Build file rows for landing page using proper HTML escaping
    const fileRows = batchFiles.map((f, idx) => {
        const url = `https://files.tomasekvalla.cz/files/${f.directory}/${f.storedName}`;
        const size = formatBytes(f.size);
        const safeName = escapeHtml(f.originalName);
        return `        <div class="file-row">
        <a href="${escapeHtml(url)}" target="_blank" class="file-name" title="${safeName}">${safeName}</a>
        <span class="file-size">${escapeHtml(size)}</span>
        <button class="file-copy" data-idx="${idx}" data-kind="link" title="Copy link">📄</button>
        <button class="file-copy" data-idx="${idx}" data-kind="styled" title="Copy styled">✨</button>
        </div>`;
    }).join('\n');

    const totalSize = formatBytes(batchFiles.reduce((sum, f) => sum + f.size, 0));
    const expiryDate = new Date(batchEntry.expiresAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // Build files array for JS — use safeScriptJson to prevent </script> injection
    const filesData = await Promise.all(batchFiles.map(async (f) => {
        const url = `https://files.tomasekvalla.cz/files/${f.directory}/${f.storedName}`;
        const probe = await probeMedia(f.path, f.category);
        const textStats = isTextFile(f.mimeType, f.originalName) ? await getTextStats(f.path) : null;
        const label = buildStyledLabel(f.originalName, f.size, f.category, probe, textStats);
        return {
            url,
            name: f.originalName,
            styled: `[${label}](${url})`
        };
    }));

    const landingPageUrl = `https://files.tomasekvalla.cz/files/batch/${batchId}.html`;
    const batchStyledLink = `[${batchFiles.length} Files (${totalSize}) - TomasekValla Filestream System](${landingPageUrl})`;

    const html = `<!DOCTYPE html>
    <html lang="en">
    <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TVFS Shared Files</title>
    <link rel="icon" type="image/x-icon" href="/icon.png">
    <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; font-family:'Inter',sans-serif; }
    body { background:#0f0c19; color:#fff; min-height:100vh; display:flex; justify-content:center; padding:40px 20px; }
    .container { max-width:600px; width:100%; }
    h1 { font-size:1.4rem; font-weight:800; margin-bottom:8px; }
    h1 span { background:linear-gradient(135deg,#6c5ce7,#00b894); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
    .subtitle { color:#8b8b9e; font-size:0.8rem; margin-bottom:24px; }
    .file-list { display:flex; flex-direction:column; gap:8px; margin-bottom:24px; }
    .file-row { display:flex; align-items:center; gap:8px; padding:12px 16px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); border-radius:12px; }
    .file-name { flex:1; min-width:0; color:#55efc4; text-decoration:none; font-weight:600; font-size:0.9rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .file-name:hover { text-decoration:underline; }
    .file-size { color:#8b8b9e; font-size:0.8rem; white-space:nowrap; }
    .file-copy { background:none; border:none; cursor:pointer; font-size:0.95rem; padding:4px 6px; border-radius:6px; flex-shrink:0; }
    .file-copy:hover { background:rgba(255,255,255,0.08); }
    .actions { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
    .btn { padding:14px 24px; border-radius:12px; border:none; font-weight:700; font-size:0.9rem; cursor:pointer; }
    .btn-primary { background:linear-gradient(135deg,#6c5ce7,#00b894); color:#fff; }
    .btn-secondary { background:rgba(255,255,255,0.06); color:#a29bfe; border:1px solid rgba(255,255,255,0.1); }
    .btn:hover { transform:translateY(-1px); }
    .expire-note { color:#8b8b9e; font-size:0.7rem; margin-top:20px; text-align:center; }
    </style>
    </head>
    <body>
    <div class="container">
    <h1><span>TomasekValla</span> Shared Files</h1>
    <p class="subtitle">${escapeHtml(String(batchFiles.length))} files \u2022 ${escapeHtml(totalSize)}</p>
    <div class="actions">
    <button class="btn btn-secondary" id="copyPageLink">📄 Copy Link</button>
    <button class="btn btn-secondary" id="copyPageStyled">✨ Copy Styled</button>
    </div>
    <div class="file-list">
    ${fileRows}
    </div>
    <div class="actions">
    <button class="btn btn-primary" onclick="downloadAll()">\u2B07\uFE0F Download All</button>
    <button class="btn btn-secondary" onclick="requestZip(this)">📦 Download ZIP</button>
    </div>
    <p class="expire-note">These files expire on ${escapeHtml(expiryDate)}</p>
    </div>
    <script>
    const files = ${safeScriptJson(filesData)};
    const pageLink = ${safeScriptJson(landingPageUrl)};
    const pageStyled = ${safeScriptJson(batchStyledLink)};
    const batchId = ${safeScriptJson(batchId)};

    function truncateFilename(name, maxLen) {
        maxLen = maxLen || 32;
        if (name.length <= maxLen) return name;
        const dot = name.lastIndexOf('.');
        const ext = (dot > 0 && name.length - dot <= 6) ? name.slice(dot) : '';
        const base = ext ? name.slice(0, dot) : name;
        const keep = Math.max(maxLen - ext.length - 3, 3);
        return base.slice(0, keep) + '...' + ext;
    }

    function copyText(btn, text) {
        navigator.clipboard.writeText(text).then(() => {
            const orig = btn.textContent;
            btn.textContent = '\u2705';
            setTimeout(() => { btn.textContent = orig; }, 1200);
        });
    }

    document.querySelectorAll('.file-name').forEach((el, idx) => {
        el.textContent = truncateFilename(files[idx].name, 32);
    });

    document.querySelectorAll('.file-copy').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            const f = files[idx];
            copyText(btn, btn.dataset.kind === 'styled' ? f.styled : f.url);
        });
    });

    document.getElementById('copyPageLink').addEventListener('click', function() { copyText(this, pageLink); });
    document.getElementById('copyPageStyled').addEventListener('click', function() { copyText(this, pageStyled); });

    function downloadAll() {
        files.forEach((f, i) => {
            setTimeout(() => {
                const a = document.createElement('a');
                a.href = f.url;
                a.download = f.name;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }, i * 800);
        });
    }

    function requestZip(btn) {
        btn.textContent = '\u23F3 Creating ZIP...';
        btn.disabled = true;
        fetch('/api/batch/' + batchId + '/zip', { method: 'POST' })
        .then(r => r.json())
        .then(d => {
            if (d.link) { window.location.href = d.link; btn.textContent = '\u2705 ZIP Ready'; }
            else { btn.textContent = '\u274C Failed'; }
            setTimeout(() => { btn.textContent = '\uD83D\uDCE6 Download ZIP'; btn.disabled = false; }, 3000);
        })
        .catch(() => { btn.textContent = '\u274C Failed'; setTimeout(() => { btn.textContent = '\uD83D\uDCE6 Download ZIP'; btn.disabled = false; }, 3000); });
    }
    </script>
    </body>
    </html>`;

    // Write the landing page
    const landingPagePath = path.join(dirs.batch, `${batchId}.html`);
    fs.writeFileSync(landingPagePath, html);

    // Update batch entry with landing page
    batchEntry.landingPage = landingPageUrl;
    saveRegistry();

    console.log(`📄 [BATCH COMPLETE] ${batchId} — ${batchFiles.length} files, landing page generated`);

    res.json({
        batchId,
        landingPage: landingPageUrl,
        link: landingPageUrl,
        styledLink: batchStyledLink,
        files: batchFiles.map((f, idx) => {
            const link = `https://files.tomasekvalla.cz/files/${f.directory}/${f.storedName}`;
            return {
                id: f.id,
                originalName: f.originalName,
                storedName: f.storedName,
                link,
                styledLink: filesData[idx].styled,
                              size: f.size,
                              textReaderLink: f.textReaderLink || null,
                              audioPlayerLink: f.audioPlayerLink || null,
                              trackBpm: f.trackBpm || null
            };
        })
    });
});

// ─── POST /api/batch/:id/zip ─────────────────────────────────────────────────

// Public on purpose: the batch landing page's "Download all" button is used by recipients
// who are not logged in. Rate limited, and at most two different ZIPs are built at a time.
const MAX_PARALLEL_ZIP_BUILDS = 2;

router.post('/batch/:id/zip', rateLimit({ windowMs: 10 * 60 * 1000, max: 10, keyPrefix: 'zip:' }), async (req, res) => {
    const batchId = req.params.id;
    if (!security.isBatchId(batchId)) return res.status(400).json({ error: 'Invalid batch id' });

    const batchEntry = registry.batches.find(b => b.id === batchId);
    if (!batchEntry) {
        return res.status(404).json({ error: 'Batch not found' });
    }

    const batchFiles = registry.files.filter(f => batchEntry.files.includes(f.id));
    if (batchFiles.length === 0) {
        return res.status(400).json({ error: 'No files in batch' });
    }

    // Reuse the existing ZIP when it was built from exactly the current file set
    const fileIds = batchFiles.map(f => f.id).sort().join(',');
    const existing = registry.files.find(f => isBatchZipOf(f, batchId) && f.zipOfFiles === fileIds && fs.existsSync(f.path));
    if (existing) {
        return res.json({ link: `https://files.tomasekvalla.cz/files/download/${existing.storedName}` });
    }

    // Concurrent clicks share one build instead of racing on the same file
    let build = batchZipBuilds.get(batchId);
    if (!build && batchZipBuilds.size >= MAX_PARALLEL_ZIP_BUILDS) {
        res.set('Retry-After', 30);
        return res.status(503).json({ error: 'The server is busy building other ZIPs, try again in a moment' });
    }
    if (!build) {
        build = buildBatchZip(batchId, batchEntry, batchFiles, fileIds).finally(() => batchZipBuilds.delete(batchId));
        batchZipBuilds.set(batchId, build);
    }

    try {
        res.json({ link: await build });
    } catch (error) {
        console.error(`❌ [BATCH ZIP FAILED] ${batchId}:`, error);
        res.status(500).json({ error: 'ZIP creation failed', details: error.message });
    }
});

const batchZipBuilds = new Map();

// Older code pushed a new registry entry (same path) on every click and had no isBatchZip flag
function isBatchZipOf(f, batchId) {
    return f.batchId === batchId
        && (f.isBatchZip === true || (f.mimeType === 'application/zip' && f.storedName === `batch_${batchId}.zip`));
}

async function buildBatchZip(batchId, batchEntry, batchFiles, fileIds) {
    // Drop stale ZIPs of this batch first, so the registry ends up with exactly one
    const stale = registry.files.filter(f => isBatchZipOf(f, batchId));
    for (const f of stale) registry.files.splice(registry.files.indexOf(f), 1);
    for (const p of new Set(stale.map(f => f.path))) {
        if (p && !isPathReferenced(p)) try { fs.unlinkSync(p); } catch (e) {}
    }
    if (stale.length) saveRegistry();

    const { filename: zipFilename, filePath: zipPath, fd } = safeFs.openUnique(dirs.download, `batch_${batchId}.zip`);

    try {
        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipPath, { fd });
            const archive = archiver('zip', { zlib: { level: 5 } });

            output.on('close', resolve);
            output.on('error', reject);
            archive.on('error', reject);

            archive.pipe(output);

            for (const file of batchFiles) {
                if (fs.existsSync(file.path)) {
                    archive.file(file.path, { name: file.originalName });
                } else {
                    console.warn(`⚠️ [BATCH ZIP] File not found on disk: ${file.path}`);
                }
            }

            archive.finalize();
        });
    } catch (error) {
        try { fs.unlinkSync(zipPath); } catch (e) {}
        throw error;
    }

    const zipStats = fs.statSync(zipPath);

    // Register the ZIP in the registry with the same expiration as the batch
    const zipFileId = generateFileId();
    registry.files.push({
        id: zipFileId,
        originalName: `batch_${batchId}.zip`,
        storedName: zipFilename,
        path: zipPath,
        directory: 'download',
        size: zipStats.size,
        mimeType: 'application/zip',
        category: 'file',
        uploadedAt: Date.now(),
        expiresAt: batchEntry.expiresAt,
        batchId: batchId,
        isBatchZip: true,
        zipOfFiles: fileIds,
        ownerKey: batchEntry.ownerKey || null
    });
    saveRegistry();

    console.log(`📦 [BATCH ZIP] Created ${zipFilename} (${formatBytes(zipStats.size)})`);

    return `https://files.tomasekvalla.cz/files/download/${zipFilename}`;
}

// ─── POST /api/upload (standard small-file upload) ──────────────────────────

function requireRoomForBody(req, res, next) {
    const declared = parseInt(req.headers['content-length'], 10);
    // a little room for the multipart framing around the file
    if (Number.isFinite(declared) && req.auth && declared > limits.maxFileBytes(req.auth.tier) + 2 * 1024 * 1024) {
        res.set('Connection', 'close');
        return res.status(413).json({ error: `Too large: at most ${formatBytes(limits.maxFileBytes(req.auth.tier))} per file` });
    }
    if (!hasRoomFor(Number.isFinite(declared) ? declared : 0)) {
        res.set('Connection', 'close');
        return res.status(507).json({ error: 'The server is out of space right now, try again later' });
    }
    next();
}

router.post('/upload', rateLimit({ windowMs: 60 * 1000, max: 60, keyPrefix: 'upload:' }), requireSession, requireRoomForBody, upload.single('file'), async (req, res) => {
    const auth = req.auth; // checked by requireSession before the body was read

    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const batchCheck = ownBatch(req.body.batchId, auth);
    if (!batchCheck.ok) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(batchCheck.status).json({ error: batchCheck.error });
    }
    const admit = admitUpload(auth, req.file.size, batchCheck.batch, req.body.expirationMinutes);
    if (!admit.ok) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(admit.status).json({ error: admit.error });
    }

    // ─── Rename to final filename now that req.body is fully populated ───
    req.file.originalname = cleanFilename(req.file.originalname);
    req.file.mimetype = cleanMimeType(req.file.mimetype);
    const rawExt = path.extname(req.file.originalname);
    let baseName = path.basename(req.file.originalname, rawExt);
    const ext = safeExt(rawExt);
    const isAnonymized = req.body.anonymize === 'true' || req.body.anonymize === true;

    let finalFilename;
    if (isAnonymized) {
        finalFilename = `${security.randomName(16)}${ext}`;
    } else {
        baseName = baseName.normalize('NFD').replace(/[̀-ͯ]/g, '') // "Země" -> "Zeme" instead of "Zem_"
        .replace(/\s+/g, '_')
        .replace(/[^\w\-_.]/g, '_')
        .replace(/_+/g, '_');
        const wantsNoSuffix = auth.tier === 3 || ((req.body.removeTimestamp === 'true' || req.body.removeTimestamp === true) && auth.tier >= 2);
        finalFilename = storedName(baseName, ext, auth.tier, wantsNoSuffix);
    }

    const destDir = getDestDir(req.file.mimetype, req.file.originalname);

    // Atomic no-clobber move: an existing file with the same name gets a suffix, never replaced
    let finalPath;
    try {
        ({ filename: finalFilename, filePath: finalPath } = safeFs.moveUnique(req.file.path, destDir, finalFilename));
    } catch (e) {
        console.error(`❌ [UPLOAD] Could not store ${req.file.originalname}:`, e.message);
        try { fs.unlinkSync(req.file.path); } catch (e2) {}
        return res.status(500).json({ error: 'Upload failed', details: e.message });
    }
    req.file.filename = finalFilename;
    req.file.path = finalPath;

    const type = req.file.mimetype.split('/')[0];
    const mimetype = req.file.mimetype;
    const filename = req.file.filename;
    const originalName = req.file.originalname;
    const category = getDirCategory(destDir);

    const linkPath = `/files/${category}/${filename}`;
    const link = `https://files.tomasekvalla.cz${linkPath}`;
    const fileType = getFileType(mimetype);

    const expiresAt = Date.now() + admit.expMinutes * 60 * 1000;

    const fileId = generateFileId();
    const fileStats = fs.statSync(req.file.path);

    const textReaderLink = maybeCreateTextReader(filename, originalName, mimetype, expiresAt, link, auth.ownerKey);
    const textReaderStyledLink = textReaderLink
        ? `[${originalName} - TomasekValla Filestream System Reader](${textReaderLink})`
        : null;
    const mdReaderLink = maybeCreateMdReader(filename, originalName, mimetype, expiresAt, link, auth.ownerKey);
    const mdReaderStyledLink = mdReaderLink ? `[${originalName} - TVFS MD Reader](${mdReaderLink})` : null;

    const wantedVoiceNote = wantsVoiceNote(req.body.voiceNote, mimetype);
    const audioPlayerResult = (fileType === 'audio' && !auth.isHost)
        ? await maybeCreateAudioPlayer(filename, originalName, mimetype, req.file.path, link, expiresAt, wantedVoiceNote, auth.ownerKey)
        : null;
    // the flag counts only if the server accepted it (real audio, short enough)
    const isVoiceNote = wantedVoiceNote && (!audioPlayerResult || audioPlayerResult.voiceNote);
    const audioPlayerLink = audioPlayerResult ? audioPlayerResult.playerUrl : null;
    const audioPlayerStyledLink = audioPlayerResult
        ? audioStyledLink(audioPlayerResult, originalName, audioPlayerLink)
        : null;

    registry.files.push({
        id: fileId,
        originalName: originalName,
        storedName: filename,
        path: req.file.path,
        directory: category,
        size: fileStats.size,
        mimeType: mimetype,
        category: fileType,
        uploadedAt: Date.now(),
                        expiresAt: expiresAt,
                        batchId: batchCheck.batch ? batchCheck.batch.id : null,
                        textReaderLink: textReaderLink || null,
                        mdReaderLink: mdReaderLink || null,
                        audioPlayerLink: audioPlayerLink || null,
                        trackBpm: audioPlayerResult ? audioPlayerResult.meta.bpm : null,
                        ...(isVoiceNote ? { voiceNote: true } : {}),
                        ownerKey: auth.ownerKey || null,
                        ownerTier: auth.tier
    });

    if (batchCheck.batch) batchCheck.batch.files.push(fileId);

    saveRegistry();

    stats.countUpload(registry.files[registry.files.length - 1] ? registry.files[registry.files.length - 1].size : 0);

    requestLogger.logEvent(req, 'complete', {
        fileId,
        filename: originalName,
        storedName: filename,
        size: fileStats.size,
        mimeType: mimetype,
        expiresAt,
        ownerUsername: auth.username || null,
        ownerTier: auth.tier
    });

    console.log(`📤 Upload complete: ${filename} (type: ${fileType}, expires: ${new Date(expiresAt).toISOString()})`);

    if (auth.isHost) plainStyledLink(fileId, originalName, fileStats.size, link, auth.ownerKey);
    else schedulePendingStyledLink(fileId, originalName, finalPath, fileStats.size, fileType, link, auth.username);

    if (auth.username && !auth.isHost) {
        userSync.recordUpload(auth.username, {
            id: fileId,
            name: originalName,
            link,
            category: fileType,
            size: fileStats.size,
            uploadedAt: Date.now(),
            expiresAt,
            thumbnail: null,
            ...(isVoiceNote ? { voiceNote: true } : {})
        });
    }

    res.json({
        message: 'Upload successful',
        link,
        styledLinkPending: true,
        type: fileType,
        filename,
        size: fileStats.size,
        fileId,
        textReaderLink: textReaderLink || null,
        textReaderStyledLink: textReaderStyledLink || null,
        mdReaderLink: mdReaderLink || null,
        mdReaderStyledLink: mdReaderStyledLink || null,
        audioPlayerLink: audioPlayerLink || null,
        audioPlayerStyledLink: audioPlayerStyledLink || null,
        trackBpm: audioPlayerResult ? audioPlayerResult.meta.bpm : null,
        ...(isVoiceNote ? { voiceNote: true } : {}),
        thumbnailPending: true
    });
});

// The router itself is still what index.js mounts with app.use('/api', ...).
// authenticateRequest is additionally attached as a property so other
// routers in the same process (e.g. encryptedShare.js) can reuse the exact
// same tvfs_token cookie check instead of forcing users to log in twice.
router.authenticateRequest = authenticateRequest;
router.internal = internal;
router.registryAccess = registryAccess;
// Exposed for protectedShare.js — logging into a TVFS Users Only share can
// also offer to remember you site-wide, reusing the exact same cookie
// logic as the main site login rather than a second copy of it.
router.issueLoginCookie = issueLoginCookie;
// Exposed for protectedShare.js — TVFS Users Only text/markdown files get
// the exact same reader chrome as normal uploads, just pointed at the
// share's cookie-gated /file/:index endpoint instead of a public files_web
// URL. No token/query-string plumbing needed here — the browser sends the
// same tvfs_token session cookie automatically on same-origin requests, so
// this is pure reuse, not a fork.
router.generateTextReaderHtml = generateTextReaderHtml;
router.generateMdReaderHtml = generateMdReaderHtml;
router.generateProtectedTextReaderHtml = generateProtectedTextReaderHtml;
router.generateProtectedMdReaderHtml = generateProtectedMdReaderHtml;
module.exports = router;