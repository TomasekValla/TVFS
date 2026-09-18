const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
let archiver = require('archiver');
if (archiver.default) {
    archiver = archiver.default;
}
const router = express.Router();

const { findUser } = require('./userIdentity');
const userSync = require('./userSync');
const thumbnails = require('./thumbnails');
const requestLogger = require('./requestLogger');
const audioPlayerLib = require('./audioPlayer');

// ─── Session Store ───────────────────────────────────────────────────────────
//
// Sessions are random 32-byte hex tokens mapped to { tier, expiresAt }.
// The cookie contains ONLY the random token — never a password hash.
// This means:
//   • Stolen cookie cannot be used to derive or verify the password.
//   • Sessions can be invalidated server-side (logout, expiry).
//   • No credential material ever touches logs or network after /api/auth.

const sessions = new Map(); // token → { tier, username, expiresAt, remember }

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
        for (const [token, session] of Object.entries(raw || {})) {
            if (!session || typeof session.expiresAt !== 'number') continue;
            if (session.expiresAt <= now) { skippedExpired++; continue; }
            sessions.set(token, session);
            loaded++;
        }
        console.log(`🔐 Sessions restored: ${loaded} active${skippedExpired ? `, ${skippedExpired} already expired` : ''}`);
    } catch {
        console.log('🔐 Sessions store initialized (empty or not found)');
    }
}

function _writeSessionsAtomic() {
    try {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        fs.writeFileSync(SESSIONS_TMP, JSON.stringify(Object.fromEntries(sessions)));
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

function createSession(tier, username, remember) {
    const token = crypto.randomBytes(32).toString('hex');
    const durationMs = remember ? SESSION_REMEMBER_MS : SESSION_SINGLE_MS;
    sessions.set(token, { tier, username, expiresAt: Date.now() + durationMs, remember: !!remember });
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
    if (remember) baseOpts.maxAge = SESSION_REMEMBER_MS; // persistent
    // else: no maxAge/expires set at all → true browser-session cookie
    res.cookie('tvfs_token', sessionToken, baseOpts);
    res.cookie('tvfs_tier', String(tier), { ...baseOpts, httpOnly: false });
    return sessionToken;
}

function getSession(token) {
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
        sessions.delete(token);
        saveSessions();
        return null;
    }
    return session;
}

function deleteSession(token) {
    if (sessions.delete(token)) saveSessions();
}

// ─── Cookie Auth Helper ──────────────────────────────────────────────────────

function authenticateRequest(req) {
    // 1. Try session cookie (preferred — no credential in request body)
    const token = req.cookies && req.cookies.tvfs_token;
    if (token) {
        const session = getSession(token);
        if (session) return { valid: true, tier: session.tier, username: session.username, ownerKey: `user:${session.username}` };
    }

    // 2. Fall back to username+password in body (for requests that don't yet have a cookie)
    const password = req.body && req.body.password;
    const username = req.body && req.body.username;
    if (password && username) {
        const user = findUser(username, password);
        if (user) return { valid: true, tier: user.tier, username: user.username, ownerKey: `user:${user.username}` };
    }

    return { valid: false, tier: 0, username: null, ownerKey: null };
}

// ─── Rate Limiting (in-memory, per IP) ───────────────────────────────────────

const rateLimits = new Map();

function rateLimit({ windowMs = 1000, max = 10, keyPrefix = '' } = {}) {
    return (req, res, next) => {
        const ip = req.ip || req.connection.remoteAddress;
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

// ─── Expiration Resolution ───────────────────────────────────────────────────
//
// Allowed retention windows, in minutes. Kept as a whitelist (not a min/max
// clamp) because we now support sub-day granularity (5m, 30m, ...) alongside
// multi-day — a simple clamp would let arbitrary in-between values through.
// Anything not in this list falls back to the default (7 days).

const EXPIRATION_OPTIONS_MIN = [
    5, 30, 60, 360, 720,                 // 5m, 30m, 1h, 6h, 12h
    1440, 2880, 4320, 7200, 10080,       // 1d, 2d, 3d, 5d, 7d
    14400, 20160                         // 10d, 14d
];
const DEFAULT_EXPIRATION_MIN = 10080; // 7 days

function resolveExpirationMinutes(rawValue) {
    const parsed = parseInt(rawValue);
    if (EXPIRATION_OPTIONS_MIN.includes(parsed)) return parsed;
    return DEFAULT_EXPIRATION_MIN;
}

function computeExpiresAt(rawValue) {
    return Date.now() + resolveExpirationMinutes(rawValue) * 60 * 1000;
}

// ─── Directories ─────────────────────────────────────────────────────────────

const baseDir = path.join(__dirname, '../files_web/files');
const dirs = {
    pictures: path.join(baseDir, 'pictures'),
    videos: path.join(baseDir, 'videos'),
    audio: path.join(baseDir, 'audio'),
    download: path.join(baseDir, 'download'),
    batch: path.join(baseDir, 'batch'),
    text: path.join(baseDir, 'text'),
    players: path.join(baseDir, 'players'),
    chunks: path.join(__dirname, 'temp_chunks')
};

Object.values(dirs).forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── File Registry ───────────────────────────────────────────────────────────
//
// Atomic write: data goes to a temp file first, then renamed into place.
// This prevents corruption if the process crashes mid-write.

const REGISTRY_PATH = path.join(__dirname, '../files_web/file_registry.json');
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

// Load registry on startup
loadRegistry();

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
    const manifestPath = path.join(dirs.chunks, `${uploadId}_manifest.json`);
    const tmpPath = manifestPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, manifestPath);
}

function readManifest(uploadId) {
    const manifestPath = path.join(dirs.chunks, `${uploadId}_manifest.json`);
    if (!fs.existsSync(manifestPath)) return null;
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

// Wipes every chunk + the manifest for a given uploadId. Used by the
// explicit "Kill" / "Delete not-finished upload" actions, where a user
// wants the remains gone immediately instead of waiting for the hourly
// >24h sweep to eventually catch it.
function deleteChunksAndManifest(uploadId) {
    let removedChunks = 0;
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

const browserFriendlyTypes = {
    image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'],
    video: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'],
    audio: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/aac', 'audio/flac']
};

function isBrowserFriendly(mimetype, category) {
    return browserFriendlyTypes[category] && browserFriendlyTypes[category].includes(mimetype);
}

// ─── Category Helpers ────────────────────────────────────────────────────────

function getDestDir(mimeType) {
    const type = mimeType.split('/')[0];
    if (type === 'image' && isBrowserFriendly(mimeType, 'image')) return dirs.pictures;
    if (type === 'video' && isBrowserFriendly(mimeType, 'video')) return dirs.videos;
    if (type === 'audio' && isBrowserFriendly(mimeType, 'audio')) return dirs.audio;
    if (mimeType === 'text/markdown') return dirs.text;
    return dirs.download;
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
    const type = mimeType.split('/')[0];
    if (type === 'video') return 'video';
    if (type === 'audio') return 'audio';
    if (type === 'image') return 'image';
    return 'file';
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
</style>
</head>
<body>
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

function maybeCreateTextReader(storedFilename, originalName, mimeType, expiresAt) {
    // Generate a reader page for .txt files (or text/plain)
    const isTxt = mimeType === 'text/plain' || storedFilename.toLowerCase().endsWith('.txt');
    if (!isTxt) return null;

    const readerSlug = originalName.replace(/\.[^.]+$/, '').replace(/[^\w\-]/g, '_').replace(/_+/g, '_').slice(0, 40) || generateReaderId();
    const readerFilename = `${readerSlug}_txt_tvfsreader.html`;
    const readerPath = path.join(dirs.text, readerFilename);
    const txtUrl = `https://files.tomasekvalla.cz/files/download/${storedFilename}`;
    const readerUrl = `https://files.tomasekvalla.cz/files/text/${readerFilename}`;

    try {
        const html = generateTextReaderHtml(txtUrl, originalName);
        fs.writeFileSync(readerPath, html);
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
                            isTextReader: true
        });

        return readerUrl;
    } catch (e) {
        console.error('❌ [TEXT READER] Failed to create reader:', e.message);
        return null;
    }
}

// ─── MD Reader ────────────────────────────────────────────────────────────────

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
</style>
</head>
<body>
${buildReaderChromeHtml(originalName, mdUrl, originalName)}
<div class="content"><div id="mdContent" class="md-body loading">Loading&#8230;</div></div>
<script src="https://cdn.jsdelivr.net/npm/marked@9/marked.min.js"><\/script>
<script>
${buildReaderChromeJs('--content-font')}

fetch(${safeScriptJson(mdUrl)})
.then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text();})
.then(function(t){
  var el=document.getElementById('mdContent');
  el.classList.remove('loading');
  function render(){
    if(typeof marked!=='undefined'){marked.setOptions({breaks:true,gfm:true});el.innerHTML=marked.parse(t);}
    else setTimeout(render,50);
  }
  render();
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
<script src="https://cdn.jsdelivr.net/npm/marked@9/marked.min.js"><\/script>
<script>
${buildReaderChromeJs('--content-font')}

function startLoad(){
  fetch(${safeScriptJson(mdUrl)}, { credentials: 'include' })
  .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text();})
  .then(function(t){
    var el=document.getElementById('mdContent');
    el.classList.remove('loading');
    function render(){
      if(typeof marked!=='undefined'){marked.setOptions({breaks:true,gfm:true});el.innerHTML=marked.parse(t);}
      else setTimeout(render,50);
    }
    render();
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

function maybeCreateMdReader(storedFilename, originalName, mimeType, expiresAt) {
    const isMd = mimeType === 'text/markdown' || storedFilename.toLowerCase().endsWith('.md');
    if (!isMd) return null;

    const mdUrl = `https://files.tomasekvalla.cz/files/text/${storedFilename}`;
    try {
        const readerSlug = originalName.replace(/\.[^.]+$/, '').replace(/[^\w\-]/g, '_').replace(/_+/g, '_').slice(0, 40) || generateReaderId();
        const readerFilename = `${readerSlug}_md_tvfsreader.html`;
        const readerPath = path.join(dirs.text, readerFilename);
        const readerUrl = `https://files.tomasekvalla.cz/files/text/${readerFilename}`;
        const html = generateMdReaderHtml(mdUrl, originalName);
        fs.writeFileSync(readerPath, html);
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
            isMdReader: true
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
function maybeCreateAudioPlayer(storedFilename, originalName, mimeType, filePath, publicAudioUrl, expiresAt) {
    const result = audioPlayerLib.maybeCreateAudioPlayer(
        storedFilename, originalName, mimeType, filePath, dirs.players, publicAudioUrl
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
        isAudioPlayer: true
    });
    saveRegistry();

    console.log(`🎵 [AUDIO PLAYER] Created ${result.playerFilename} — BPM: ${result.meta.bpm || 'n/a'}, font: ${result.font.label}`);

    return { playerUrl, meta: result.meta, font: result.font };
}



const storage = multer.diskStorage({
    destination: function(req, file, cb) {
        cb(null, getDestDir(file.mimetype));
    },
    filename: function(req, file, cb) {
        // Don't decide final name here — req.body isn't reliably populated yet
        // because multer processes multipart fields in stream order, and
        // 'file' is typically appended before anonymize/removeTimestamp.
        const tempName = `tmp_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname)}`;
        cb(null, tempName);
    }
});

const upload = multer({
    storage: storage,
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
        cb(null, `chunk_tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`);
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

setInterval(() => {
    if (!fs.existsSync(dirs.chunks)) return;
    const now = Date.now();
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    fs.readdirSync(dirs.chunks).forEach(file => {
        try {
            const filePath = path.join(dirs.chunks, file);
            const stats = fs.statSync(filePath);
            if (stats.mtimeMs < oneDayAgo) {
                fs.unlinkSync(filePath);
                console.log(`🗑️ Deleted old chunk/manifest: ${file}`);
            }
        } catch (e) {}
    });
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

function ffprobeJson(filePath) {
    return new Promise((resolve) => {
        execFile('ffprobe', [
            '-v', 'error',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            filePath
        ], { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
            if (err || !stdout) return resolve(null);
            try { resolve(JSON.parse(stdout)); } catch (e) { resolve(null); }
        });
    });
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

function getTextStats(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return {
            chars: content.length,
            lines: content.split('\n').length
        };
    } catch (e) {
        return null;
    }
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

function schedulePendingStyledLink(fileId, originalName, filePath, sizeBytes, category, link, ownerUsername) {
    styledLinkStore.set(fileId, { ready: false, styledLink: null, thumbnail: null });
    setTimeout(() => styledLinkStore.delete(fileId), STYLED_LINK_TTL);

    (async () => {
        let styledLink;
        try {
            const probe = await probeMedia(filePath, category);
            const textStats = isTextFile(null, originalName) ? getTextStats(filePath) : null;
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
        userVersion: userSync.getVersion(auth.username),
        // Unfinished chunked uploads for this user, across ALL their devices.
        // Small array (realistically 0-2 entries), so no separate diffing —
        // the client filters out its own in-progress upload by uploadId.
        pendingUploads: getPendingUploadsForOwner(auth.ownerKey)
    });
});

// ─── GET /api/user/sync ───────────────────────────────────────────────────
// Multi-device sync of "recently uploaded". Sends a full list only when the
// client has no prior version (first time / new device) or has fallen too
// far behind for the log to cover; otherwise sends just the diff ops.

router.get('/user/sync', (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid) return res.status(403).json({ error: 'Unauthorized' });

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

router.post('/verify-password', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: 'login:' }), (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ valid: false, tier: 0 });
    }

    // Username and password are checked together against each user's own
    // secret pair — a wrong username and a wrong password both just get a
    // generic 403, so a scanner can't tell which one it got wrong.
    const user = findUser(username, password);
    if (!user) {
        return res.status(403).json({ valid: false, tier: 0 });
    }
    res.json({ valid: true, tier: user.tier });
});

// ─── POST /api/auth ──────────────────────────────────────────────────────────
// Verifies password and issues a random session token stored in an httpOnly cookie.
// The password hash is NEVER stored in a cookie — only the opaque session token.

router.post('/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: 'login:' }), (req, res) => {
    const { username, password, remember } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({ valid: false, error: 'Username and password required' });
    }

    const user = findUser(username, password);
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
    const provided = req.headers['x-admin-secret'] || (req.body && req.body.secret);
    if (provided !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const count = sessions.size;
    sessions.clear();
    saveSessionsSync();
    console.log(`🔐 [ADMIN] All ${count} session(s) invalidated via /api/logout-all`);
    res.json({ ok: true, sessionsCleared: count });
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

router.delete('/file/:id', async (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid) return res.status(403).json({ error: 'Invalid password' });

    const fileId = req.params.id;
    const idx = registry.files.findIndex(f => f.id === fileId);
    if (idx === -1) {
        return res.json({ deleted: false, reason: 'already gone' });
    }
    const file = registry.files[idx];

    if (file.ownerKey && file.ownerKey !== auth.ownerKey) {
        return res.status(403).json({ error: 'This file belongs to a different session' });
    }

    let sizeForLog = file.size || 0;
    try {
        if (file.path && fs.existsSync(file.path)) {
            sizeForLog = fs.statSync(file.path).size;
            fs.unlinkSync(file.path);
        }
    } catch (e) {
        console.error(`⚠️  [MANUAL DELETE] Failed to unlink ${file.path}:`, e.message);
    }

    thumbnails.deleteThumbnail(file.id);

    // Best-effort cleanup of generated reader/player pages, if any existed.
    for (const linkField of ['textReaderLink', 'mdReaderLink', 'audioPlayerLink']) {
        if (!file[linkField]) continue;
        try {
            const readerPath = path.join(dirs.players, path.basename(file[linkField]));
            if (fs.existsSync(readerPath)) fs.unlinkSync(readerPath);
        } catch (e) {}
    }

    registry.files.splice(idx, 1);
    if (file.batchId) {
        const batchEntry = registry.batches.find(b => b.id === file.batchId);
        if (batchEntry) batchEntry.files = batchEntry.files.filter(fid => fid !== fileId);
    }
    saveRegistry();

    const owner = file.ownerKey && file.ownerKey.startsWith('user:') ? file.ownerKey.slice(5) : null;
    if (owner) userSync.recordRemoval(owner, fileId);

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

// ─── GET /api/upload/styled-link/:fileId ─────────────────────────────────────
// Polled by the frontend while ffprobe metadata (bitrate/fps/resolution/…) is
// still being computed in the background, right after upload completion.

router.get('/upload/styled-link/:fileId', (req, res) => {
    const entry = styledLinkStore.get(req.params.fileId);
    if (!entry) return res.json({ ready: false });
    res.json(entry);
});

// ─── POST /api/upload/init ───────────────────────────────────────────────────

router.post('/upload/init', rateLimit({ windowMs: 60 * 1000, max: 20, keyPrefix: 'init:' }), (req, res) => {
    const { filename, fileSize, mimeType, totalChunks, uploadMode, expirationMinutes, batchId } = req.body;

    const auth = authenticateRequest(req);
    if (!auth.valid) {
        return res.status(403).json({ error: 'Invalid password' });
    }

    const maxSize = 10 * 1024 * 1024 * 1024; // 10GB
    if (fileSize && parseInt(fileSize) > maxSize) {
        return res.status(413).json({ error: 'File too large. Maximum size is 10GB.' });
    }

    const expMinutes = resolveExpirationMinutes(expirationMinutes);

    const uploadId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const manifest = {
        uploadId,
        filename,
        fileSize: parseInt(fileSize) || 0,
            mimeType,
            totalChunks: parseInt(totalChunks),
            uploadMode: uploadMode || 'fast',
            receivedChunks: [],
            createdAt: Date.now(),
            status: 'initialized',
            expirationMinutes: expMinutes,
            batchId: batchId || null,
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

    console.log(`🚀 [CHUNKED UPLOAD INIT] ${filename} (${totalChunks} chunks, mode: ${uploadMode || 'fast'}, expires: ${expMinutes}min) - ID: ${uploadId}`);

    res.json({
        uploadId,
        message: 'Upload initialized',
        recommendedParallel: 4
    });
});

// ─── POST /api/upload/chunk ──────────────────────────────────────────────────

router.post('/upload/chunk', rateLimit({ windowMs: 60 * 1000, max: 300, keyPrefix: 'chunk:' }), chunkUpload.single('chunk'), async (req, res) => {
    const { uploadId, chunkIndex } = req.body;

    // SECURITY: this endpoint previously accepted chunk data with NO auth check
    // at all — anyone who obtained (or guessed) an uploadId could write arbitrary
    // file data to disk without ever passing a password. Fixed here.
    const auth = authenticateRequest(req);
    if (!auth.valid) {
        if (req.file && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(403).json({ error: 'Invalid password' });
    }

    if (!uploadId) {
        if (req.file && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(400).json({ error: 'Missing upload ID' });
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

    try {
        const numberedChunkPath = path.join(dirs.chunks, `${uploadId}_chunk_${String(index).padStart(4, '0')}`);

        fs.renameSync(req.file.path, numberedChunkPath);

        const result = await withManifestLock(uploadId, async () => {
            const manifest = readManifest(uploadId);

            if (!manifest) {
                return { error: 'Invalid upload ID or upload expired', status: 400 };
            }

            if (index < 0 || index >= manifest.totalChunks) {
                return { error: `Invalid chunk index: ${index}`, status: 400 };
            }

            if (manifest.receivedChunks.includes(index)) {
                console.log(`⚠️  [DUPLICATE CHUNK] ${uploadId} - chunk ${index} already received`);
                try { fs.unlinkSync(numberedChunkPath); } catch (e) {}
                return {
                    success: true,
                    chunkIndex: index,
                    received: manifest.receivedChunks.length,
                    total: manifest.totalChunks,
                    duplicate: true
                };
            }

            manifest.receivedChunks.push(index);
            manifest.receivedChunks.sort((a, b) => a - b);
            manifest.lastChunkTime = Date.now();
            writeManifest(uploadId, manifest);

            console.log(`📦 [CHUNK RECEIVED] ${uploadId} - chunk ${index}/${manifest.totalChunks}`);

            return {
                success: true,
                chunkIndex: index,
                received: manifest.receivedChunks.length,
                total: manifest.totalChunks
            };
        });

        if (result.error) {
            if (fs.existsSync(numberedChunkPath)) try { fs.unlinkSync(numberedChunkPath); } catch (e) {}
            return res.status(result.status || 400).json({ error: result.error });
        }

        res.json(result);

    } catch (error) {
        console.error(`❌ [CHUNK ERROR] ${uploadId} chunk ${index}:`, error);
        if (req.file && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch (e) {}
        }
        res.status(500).json({ error: 'Chunk processing failed', details: error.message });
    }
});

// ─── POST /api/upload/complete ───────────────────────────────────────────────

router.post('/upload/complete', async (req, res) => {
    const { uploadId, anonymize, removeTimestamp, expirationMinutes, batchId } = req.body;

    if (!uploadId) {
        return res.status(400).json({ error: 'Missing upload ID' });
    }

    const manifest = readManifest(uploadId);

    if (!manifest) {
        return res.status(400).json({ error: 'Invalid upload ID or upload expired' });
    }

    const auth = authenticateRequest(req);
    if (!auth.valid) {
        return res.status(403).json({ error: 'Invalid password' });
    }

    if (manifest.ownerKey && manifest.ownerKey !== auth.ownerKey) {
        return res.status(403).json({ error: 'This upload session belongs to a different session' });
    }

    if (manifest.receivedChunks.length !== manifest.totalChunks) {
        const missing = [];
        for (let i = 0; i < manifest.totalChunks; i++) {
            if (!manifest.receivedChunks.includes(i)) missing.push(i);
        }
        return res.status(400).json({
            error: 'Missing chunks',
            received: manifest.receivedChunks.length,
            expected: manifest.totalChunks,
            missing
        });
    }

    // ── Assembly guard: reject duplicate concurrent complete requests ──────
    if (assemblyInProgress.has(uploadId)) {
        return res.status(409).json({ error: 'Assembly already in progress for this upload' });
    }
    assemblyInProgress.add(uploadId);

    // Release mutex — all chunks are in, no more chunk writes expected
    manifestMutexes.delete(uploadId);

    console.log(`🔗 [ASSEMBLING] ${manifest.filename} from ${manifest.totalChunks} chunks`);

    try {
        const destDir = getDestDir(manifest.mimeType);
        const category = getDirCategory(destDir);
        const timestamp = Date.now();
        const ext = path.extname(manifest.filename);
        let name = path.basename(manifest.filename, ext);

        const isAnonymized = anonymize === true || anonymize === 'true';

        if (isAnonymized) {
            const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            name = Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        } else {
            name = name.replace(/\s+/g, '_')
            .replace(/[^\w\-_.]/g, '_')
            .replace(/_+/g, '_');
        }

        // Anonymous files never get a timestamp
        let finalFilename = isAnonymized ? `${name}${ext}` : `${name}_${timestamp}${ext}`;
        let finalPath = path.join(destDir, finalFilename);

        // Streaming assembly: createWriteStream + createReadStream pipe chain
        const writeStream = fs.createWriteStream(finalPath);

        for (let i = 0; i < manifest.totalChunks; i++) {
            const chunkPath = path.join(dirs.chunks, `${uploadId}_chunk_${String(i).padStart(4, '0')}`);

            if (!fs.existsSync(chunkPath)) {
                writeStream.destroy();
                throw new Error(`Missing chunk file: ${i}`);
            }

            await new Promise((resolve, reject) => {
                const readStream = fs.createReadStream(chunkPath);
                readStream.pipe(writeStream, { end: false });
                readStream.on('end', () => {
                    fs.unlinkSync(chunkPath);
                    console.log(`  ✓ Streamed chunk ${i}/${manifest.totalChunks}`);
                    resolve();
                });
                readStream.on('error', reject);
            });
        }

        writeStream.end();
        await new Promise(resolve => writeStream.on('finish', resolve));

        const finalStats = fs.statSync(finalPath);
        console.log(`📊 Assembly complete: ${finalStats.size} bytes`);

        // Remove timestamp for tier 2 if requested (non-anonymous files only)
        if (!isAnonymized && (removeTimestamp === true || removeTimestamp === 'true') && auth.tier === 2) {
            const timestampMatch = finalFilename.match(/^(.+)_(\d{13})(\.\w+)$/);
            if (timestampMatch) {
                const [, baseName, , extension] = timestampMatch;
                const newFilename = `${baseName}${extension}`;
                const newPath = path.join(destDir, newFilename);

                if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
                fs.renameSync(finalPath, newPath);
                finalFilename = newFilename;
                finalPath = newPath;
                console.log(`✂️ Removed timestamp: ${finalFilename}`);
            }
        }

        // Clean up manifest
        const manifestPath = path.join(dirs.chunks, `${uploadId}_manifest.json`);
        if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

        // Build link
        const linkPath = `/files/${category}/${finalFilename}`;
        const link = `https://files.tomasekvalla.cz${linkPath}`;

        // Expiration — prefer the value sent now, fall back to what was set at init time
        const expMinutes = resolveExpirationMinutes(expirationMinutes || manifest.expirationMinutes);
        const expiresAt = Date.now() + (expMinutes * 60 * 1000);

        // Register in file registry
        const fileId = generateFileId();
        const textReaderLink = maybeCreateTextReader(finalFilename, manifest.filename, manifest.mimeType, expiresAt);
        const textReaderStyledLink = textReaderLink
            ? `[${manifest.filename} - TomasekValla Filestream System Reader](${textReaderLink})`
            : null;
        const mdReaderLink = maybeCreateMdReader(finalFilename, manifest.filename, manifest.mimeType, expiresAt);
        const mdReaderStyledLink = mdReaderLink ? `[${manifest.filename} - TVFS MD Reader](${mdReaderLink})` : null;
        const audioPlayerResult = (getFileType(manifest.mimeType) === 'audio')
            ? maybeCreateAudioPlayer(finalFilename, manifest.filename, manifest.mimeType, finalPath, link, expiresAt)
            : null;
        const audioPlayerLink = audioPlayerResult ? audioPlayerResult.playerUrl : null;
        const audioPlayerStyledLink = audioPlayerResult
            ? `[${manifest.filename} - TVFS Audio Player (${audioPlayerLib.formatMetaSummary(audioPlayerResult.meta) || 'details n/a'})](${audioPlayerLink})`
            : null;
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
                            batchId: batchId || manifest.batchId || null,
                            textReaderLink: textReaderLink || null,
                            mdReaderLink: mdReaderLink || null,
                            audioPlayerLink: audioPlayerLink || null,
                            trackBpm: audioPlayerResult ? audioPlayerResult.meta.bpm : null,
                            ownerKey: auth.ownerKey || manifest.ownerKey || null
        });

        // If part of a batch, add fileId to batch entry
        if (batchId || manifest.batchId) {
            const targetBatchId = batchId || manifest.batchId;
            const batchEntry = registry.batches.find(b => b.id === targetBatchId);
            if (batchEntry) {
                batchEntry.files.push(fileId);
            }
        }

        saveRegistry();

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

        schedulePendingStyledLink(fileId, manifest.filename, finalPath, finalStats.size, getFileType(manifest.mimeType), link, auth.username);

        if (auth.username) {
            userSync.recordUpload(auth.username, {
                id: fileId,
                name: manifest.filename,
                link,
                category: getFileType(manifest.mimeType),
                size: finalStats.size,
                uploadedAt: Date.now(),
                expiresAt,
                thumbnail: null
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

        // Try to clean up partial assembled file
        try {
            const destDir = getDestDir(manifest.mimeType);
            fs.readdirSync(destDir).forEach(f => {
                if (f.includes(uploadId.split('_')[0])) {
                    try { fs.unlinkSync(path.join(destDir, f)); } catch (e) {}
                }
            });
        } catch (e) {}

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
    const expiresAt = computeExpiresAt(expirationMinutes);

    const batchId = generateBatchId();

    registry.batches.push({
        id: batchId,
        createdAt: Date.now(),
                          expiresAt: expiresAt,
                          files: [],
                          landingPage: null
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

    const batchEntry = registry.batches.find(b => b.id === batchId);
    if (!batchEntry) {
        return res.status(404).json({ error: 'Batch not found' });
    }

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
        const textStats = isTextFile(f.mimeType, f.originalName) ? getTextStats(f.path) : null;
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

router.post('/batch/:id/zip', async (req, res) => {
    const batchId = req.params.id;

    const batchEntry = registry.batches.find(b => b.id === batchId);
    if (!batchEntry) {
        return res.status(404).json({ error: 'Batch not found' });
    }

    const batchFiles = registry.files.filter(f => batchEntry.files.includes(f.id));
    if (batchFiles.length === 0) {
        return res.status(400).json({ error: 'No files in batch' });
    }

    const zipFilename = `batch_${batchId}.zip`;
    const zipPath = path.join(dirs.download, zipFilename);

    try {
        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 5 } });

            output.on('close', resolve);
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

        const zipStats = fs.statSync(zipPath);

        // Register the ZIP in the registry with the same expiration as the batch
        const zipFileId = generateFileId();
        registry.files.push({
            id: zipFileId,
            originalName: zipFilename,
            storedName: zipFilename,
            path: zipPath,
            directory: 'download',
            size: zipStats.size,
            mimeType: 'application/zip',
            category: 'file',
            uploadedAt: Date.now(),
                            expiresAt: batchEntry.expiresAt,
                            batchId: batchId
        });
        saveRegistry();

        const link = `https://files.tomasekvalla.cz/files/download/${zipFilename}`;
        console.log(`📦 [BATCH ZIP] Created ${zipFilename} (${formatBytes(zipStats.size)})`);

        res.json({ link });

    } catch (error) {
        console.error(`❌ [BATCH ZIP FAILED] ${batchId}:`, error);
        if (fs.existsSync(zipPath)) {
            try { fs.unlinkSync(zipPath); } catch (e) {}
        }
        res.status(500).json({ error: 'ZIP creation failed', details: error.message });
    }
});

// ─── POST /api/upload (standard small-file upload) ──────────────────────────

router.post('/upload', upload.single('file'), async (req, res) => {
    const auth = authenticateRequest(req);
    if (!auth.valid) {
        if (req.file) {
            try { fs.unlinkSync(req.file.path); } catch (e) {}
        }
        return res.status(403).json({ error: 'Invalid password' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    // ─── Rename to final filename now that req.body is fully populated ───
    const timestamp = Date.now();
    const ext = path.extname(req.file.originalname);
    let baseName = path.basename(req.file.originalname, ext);
    const isAnonymized = req.body.anonymize === 'true' || req.body.anonymize === true;

    let finalFilename;
    if (isAnonymized) {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const randomName = Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        finalFilename = `${randomName}${ext}`;
    } else {
        baseName = baseName.replace(/\s+/g, '_')
        .replace(/[^\w\-_.]/g, '_')
        .replace(/_+/g, '_');
        const wantsNoTimestamp = (req.body.removeTimestamp === 'true' || req.body.removeTimestamp === true) && auth.tier === 2;
        finalFilename = wantsNoTimestamp ? `${baseName}${ext}` : `${baseName}_${timestamp}${ext}`;
    }

    const destDir = path.dirname(req.file.path);
    let finalPath = path.join(destDir, finalFilename);

    // Avoid clobbering an existing file with the same final name
    if (fs.existsSync(finalPath)) {
        finalFilename = `${path.basename(finalFilename, ext)}_${crypto.randomBytes(3).toString('hex')}${ext}`;
        finalPath = path.join(destDir, finalFilename);
    }

    fs.renameSync(req.file.path, finalPath);
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

    const expiresAt = computeExpiresAt(req.body.expirationMinutes);

    const fileId = generateFileId();
    const fileStats = fs.statSync(req.file.path);

    const textReaderLink = maybeCreateTextReader(filename, originalName, mimetype, expiresAt);
    const textReaderStyledLink = textReaderLink
        ? `[${originalName} - TomasekValla Filestream System Reader](${textReaderLink})`
        : null;
    const mdReaderLink = maybeCreateMdReader(filename, originalName, mimetype, expiresAt);
    const mdReaderStyledLink = mdReaderLink ? `[${originalName} - TVFS MD Reader](${mdReaderLink})` : null;

    const audioPlayerResult = (fileType === 'audio')
        ? maybeCreateAudioPlayer(filename, originalName, mimetype, req.file.path, link, expiresAt)
        : null;
    const audioPlayerLink = audioPlayerResult ? audioPlayerResult.playerUrl : null;
    const audioPlayerStyledLink = audioPlayerResult
        ? `[${originalName} - TVFS Audio Player (${audioPlayerLib.formatMetaSummary(audioPlayerResult.meta) || 'details n/a'})](${audioPlayerLink})`
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
                        batchId: req.body.batchId || null,
                        textReaderLink: textReaderLink || null,
                        mdReaderLink: mdReaderLink || null,
                        audioPlayerLink: audioPlayerLink || null,
                        trackBpm: audioPlayerResult ? audioPlayerResult.meta.bpm : null,
                        ownerKey: auth.ownerKey || null
    });

    if (req.body.batchId) {
        const batchEntry = registry.batches.find(b => b.id === req.body.batchId);
        if (batchEntry) batchEntry.files.push(fileId);
    }

    saveRegistry();

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

    schedulePendingStyledLink(fileId, originalName, finalPath, fileStats.size, fileType, link, auth.username);

    if (auth.username) {
        userSync.recordUpload(auth.username, {
            id: fileId,
            name: originalName,
            link,
            category: fileType,
            size: fileStats.size,
            uploadedAt: Date.now(),
            expiresAt,
            thumbnail: null
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
        thumbnailPending: true
    });
});

// The router itself is still what index.js mounts with app.use('/api', ...).
// authenticateRequest is additionally attached as a property so other
// routers in the same process (e.g. encryptedShare.js) can reuse the exact
// same tvfs_token cookie check instead of forcing users to log in twice.
router.authenticateRequest = authenticateRequest;
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