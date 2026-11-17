'use strict';
/**
 * protectedShare.js — TVFS Users Only, standalone sharing mode.
 *
 * Files here are NOT encrypted — this mode's entire security model is "no
 * network request for the file bytes succeeds unless you're a logged-in
 * TVFS user". No password, no client-side crypto, no verify-blob trick.
 *
 *  - Raw file bytes live OUTSIDE files_web (protected_storage), so a
 *    static webserver serving files_web directly can never leak them —
 *    the ONLY path to the bytes is through this router's own auth checks.
 *  - A real per-share landing page is generated to disk and servable
 *    statically, so no dynamic Express route or query-string parsing is
 *    needed for it.
 *  - Owner identity is resolved from upload.js's tvfs_token cookie via
 *    the same authenticateRequest() reuse — never a re-typed login.
 *
 * Multi-file / folder support: files are uploaded as a flat list, each
 * with a `relativePath` (e.g. "photos/trip/img1.jpg") so folder structure
 * can be reconstructed and shown on the landing page, even though the
 * upload itself isn't chunked (large files aren't this mode's target use
 * case in this pass).
 *
 * REMOVED (2026-08): Pairing mode used to live in this same file (owner
 * approves each viewer interactively via a dashboard + code, instead of a
 * direct TVFS login). It's been scrapped entirely per a deliberate product
 * decision — see PAIRING_ENCRYPTED_REMOVAL.txt for exactly what existed,
 * where, and how to bring it back if it's ever wanted again. Any share
 * that was previously created with pairingEnabled:true in the old
 * registry will simply no longer be reachable via pairing — its direct
 * TVFS-login access (if it has any) is unaffected, since that gate never
 * depended on pairing code.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const requestLogger = require('./requestLogger');
const uploadRouter = require('./upload'); // for uploadRouter.authenticateRequest, .issueLoginCookie, .generateTextReaderHtml, .generateMdReaderHtml
const audioPlayerLib = require('./audioPlayer'); // for the full BPM/waveform player, same one normal uploads get
const { findUser, sha256 } = require('./userIdentity');

const router = express.Router();
const INIT_BODY_LIMIT = '2mb';
const INIT_BODY_PATH = '/api/protected/upload/init';

// ─── Directories ─────────────────────────────────────────────────────────

const FILES_WEB_DIR = process.env.CLEANUP_FILES_WEB_DIR || path.join(__dirname, '../files_web');
const PROTECTED_STORAGE_DIR = process.env.PROTECTED_STORAGE_DIR || path.join(__dirname, 'protected_storage');
const SHARE_DIR = path.join(PROTECTED_STORAGE_DIR, 'shares');
const SHARE_TMP_DIR = path.join(SHARE_DIR, 'tmp');
const SHARE_PAGES_DIR = path.join(FILES_WEB_DIR, 'files', 'protected', 'pages');
// Generated reader/player pages (2026-08). These are static HTML, same as
// SHARE_PAGES_DIR — but they carry no secret of any kind, at generation
// time or ever. Every content fetch/audio-src inside them hits this
// share's /file/:index endpoint, which is gated purely by the visitor's
// own tvfs_token session cookie (the same one used everywhere else on the
// site) — the browser sends it automatically, no query string involved.
// A bare reader/player link is therefore worthless to anyone not actually
// logged in as a TVFS user.
const SHARE_TOOLS_DIR = path.join(FILES_WEB_DIR, 'files', 'protected', 'tools');
for (const d of [SHARE_DIR, SHARE_TMP_DIR, SHARE_PAGES_DIR, SHARE_TOOLS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const REGISTRY_PATH = path.join(PROTECTED_STORAGE_DIR, 'protected_registry.json');
const REGISTRY_TMP = REGISTRY_PATH + '.tmp';

// NOTE: the on-disk registry may still contain old `pairingRequests` and
// `bans` keys (and individual shares with `pairingEnabled: true` /
// `dashboardPagePath` set) from before pairing was removed. We read the
// file tolerantly (extra keys are simply ignored) rather than failing to
// load it — no need to hand-edit or wipe the existing registry on deploy.
let registry = { shares: {} };
let saveTimer = null;

function loadRegistry() {
    try {
        const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
        registry = { shares: (raw && typeof raw.shares === 'object' && raw.shares) || {} };
        console.log(`🗝️  Protected-share registry loaded: ${Object.keys(registry.shares).length} shares`);
    } catch {
        registry = { shares: {} };
        console.log('🗝️  Protected-share registry initialized (empty or not found)');
    }
}
loadRegistry();

function writeRegistryAtomic() {
    try {
        fs.writeFileSync(REGISTRY_TMP, JSON.stringify(registry, null, 2));
        fs.renameSync(REGISTRY_TMP, REGISTRY_PATH);
    } catch (err) {
        console.error('❌ [PROTECTED SHARE] Failed to save registry:', err.message);
    }
}
function saveRegistry() { clearTimeout(saveTimer); saveTimer = setTimeout(writeRegistryAtomic, 1500); }
function saveRegistrySync() { clearTimeout(saveTimer); writeRegistryAtomic(); }

// Stand-in `req` for cron-context logging (cleanup.js), same pattern as
// encryptedShare.js's CRON_PSEUDO_REQ used to.
const CRON_PSEUDO_REQ = { headers: {} };

// ─── Rate limiting + access tokens ─────────────────────────────────────

const attemptWindows = new Map();
function checkRateLimit(key, max, windowMs) {
    const now = Date.now();
    const entry = attemptWindows.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
    entry.count++;
    attemptWindows.set(key, entry);
    return entry.count <= max;
}

const security = require('./security');
const limits = require('./limits');
// Failed Users Only logins per client address and per username. No global lock: a valid
// session is never blocked, and the silent "am I logged in?" check is not an attempt.
const loginFailuresByIp = security.failureLimiter({ windowMs: 15 * 60 * 1000, max: 15 });
const loginFailuresByUser = security.failureLimiter({ windowMs: 15 * 60 * 1000, max: 20 });

// .unref() — this module is also require()'d by cleanup.js's short-lived
// cron process. Without this, that process would never exit, and cron
// would pile up a new hung process every minute.
setInterval(() => {
    const now = Date.now();
    for (const [k, e] of attemptWindows) if (now > e.resetAt + 60000) attemptWindows.delete(k);
}, 60000).unref();

const clientIp = security.clientIp;

// Users Only means real TVFS accounts: the shared tier 0 "host" login (given to strangers)
// can neither create nor open these shares
function resolveOwner(req) {
    const auth = uploadRouter.authenticateRequest(req);
    return auth.valid && auth.tier >= 1 ? { tier: auth.tier, username: auth.username } : null;
}

// Login checked before multer stores anything
function requireOwner(req, res, next) {
    const owner = resolveOwner(req);
    if (!owner) {
        res.set('Connection', 'close');
        return res.status(401).json({ error: 'You must be logged in to TVFS to use this mode' });
    }
    req.owner = owner;
    next();
}

// Share ids are 24 hex characters; chunked upload ids `<ms>_<12 hex>`
const isShareId = v => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v);
const isChunkUploadId = v => typeof v === 'string' && /^\d{10,16}_[0-9a-f]{12}$/.test(v);
const MAX_SHARE_TOTAL = 5 * 1024 * 1024 * 1024; // all files of one share together (owner: never over 5 GB)


function generateShareId() { return crypto.randomBytes(12).toString('hex'); }

// ─── Reader/player tools for text/markdown/audio files (2026-08) ─────────
// This mode never stored a mimeType per file before — the direct /upload
// route gets a real one from multer, but the chunked /upload/init payload
// only ever carried {relativePath, size}. Falls back to extension when
// nothing was provided, same spirit as upload.js's own isTextFile() etc.
const EXT_MIME_FALLBACK = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.webm': 'audio/webm'
};
function guessMimeType(relativePath, providedMimeType) {
    if (providedMimeType) return providedMimeType;
    const ext = path.extname(relativePath).toLowerCase();
    return EXT_MIME_FALLBACK[ext] || null;
}
function detectToolCategory(relativePath, mimeType) {
    const lower = relativePath.toLowerCase();
    if (mimeType === 'text/markdown' || lower.endsWith('.md')) return 'md';
    if (mimeType === 'text/plain' || lower.endsWith('.txt')) return 'text';
    if (mimeType && mimeType.split('/')[0] === 'audio') return 'audio';
    return null;
}

function getShare(shareId) {
    if (!isShareId(shareId) || !Object.prototype.hasOwnProperty.call(registry.shares, shareId)) return null;
    const entry = registry.shares[shareId];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry;
}

// ─── Landing page generator ────────────────────────────────────────────
// Loaded from disk at require-time and cached.
const PROTECTED_LANDING_TEMPLATE_PATH = path.join(__dirname, 'protected-landing.html');
let PROTECTED_LANDING_TEMPLATE = null;
try {
    PROTECTED_LANDING_TEMPLATE = fs.readFileSync(PROTECTED_LANDING_TEMPLATE_PATH, 'utf8');
} catch (e) {
    console.error('❌ [PROTECTED SHARE] Could not load protected-landing.html template:', e.message);
}
function buildProtectedLandingHtml(shareId) {
    if (!PROTECTED_LANDING_TEMPLATE) throw new Error('protected-landing.html template not loaded');
    return PROTECTED_LANDING_TEMPLATE.replace('__SHARE_ID_JSON__', JSON.stringify(shareId));
}

// ─── Multer ──────────────────────────────────────────────────────────────

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, SHARE_TMP_DIR),
        filename: (req, file, cb) => cb(null, `${crypto.randomBytes(8).toString('hex')}_${file.fieldname}`)
    }),
    defParamCharset: 'utf8', // file names arrive as UTF-8 (multer defaults to latin1)
    limits: { fileSize: 5 * 1024 * 1024 * 1024, files: 200 }
});

// ─── Shared "create the share" tail ────────────────────────────────────
// Used by both the direct /upload route (small shares, single request)
// and /upload/complete (chunked, for anything too big to comfortably fit
// in one request). Takes fileEntries that already have their final bytes
// sitting at `path`, on shareDir.
async function finalizeShare(shareId, shareDir, fileEntries, totalSize, owner, expirationMinutesRaw) {
    // the same retention rules per tier, size and free space as normal uploads (files are already here: at least a day)
    const expMinutes = limits.effectiveExpiryMinutes(owner.tier, totalSize, expirationMinutesRaw) || 24 * 60;
    const expiresAt = Date.now() + expMinutes * 60 * 1000;

    const pageFilename = `${shareId}.html`;
    const pagePath = path.join(SHARE_PAGES_DIR, pageFilename);
    fs.writeFileSync(pagePath, buildProtectedLandingHtml(shareId));
    const link = `https://files.tomasekvalla.cz/files/protected/pages/${pageFilename}`;

    // Give text/markdown/audio files their own dedicated, gated reader/
    // player — distinct branding ("TVFS Users Only Reader"/"...Audio
    // Player") and each with its own login gate built in, exactly like
    // the landing page (silent session check → username/password form →
    // "stay logged in?" popup). Nothing is fetched — no text, no audio
    // byte, not even file metadata — until that gate passes. These are
    // NOT the same generators normal public uploads get; those never
    // require a login at all, which is the entire problem this avoids.
    for (const entry of fileEntries) {
        const mimeType = guessMimeType(entry.relativePath, entry.mimeType);
        const category = detectToolCategory(entry.relativePath, mimeType);
        entry.category = category;
        entry.toolLink = null;
        entry.toolPagePath = null;
        if (!category) continue;

        const baseName = path.basename(entry.relativePath);
        const contentUrl = `https://files.tomasekvalla.cz/api/protected/${shareId}/file/${entry.index}`;

        try {
            if (category === 'text' || category === 'md') {
                const html = category === 'md'
                    ? uploadRouter.generateProtectedMdReaderHtml(contentUrl, baseName, shareId, link)
                    : uploadRouter.generateProtectedTextReaderHtml(contentUrl, baseName, shareId, link);
                const toolFilename = `${shareId}_${entry.index}_reader.html`;
                const toolPagePath = path.join(SHARE_TOOLS_DIR, toolFilename);
                fs.writeFileSync(toolPagePath, html);
                entry.toolLink = `https://files.tomasekvalla.cz/files/protected/tools/${toolFilename}`;
                entry.toolPagePath = toolPagePath;
            } else if (category === 'audio') {
                const result = await audioPlayerLib.maybeCreateProtectedAudioPlayer(
                    baseName, mimeType, entry.path, SHARE_TOOLS_DIR, contentUrl, shareId, link
                );
                if (result) {
                    entry.toolLink = `https://files.tomasekvalla.cz/files/protected/tools/${result.playerFilename}`;
                    entry.toolPagePath = result.playerPath;
                }
            }
        } catch (e) {
            console.error(`⚠️  [PROTECTED SHARE] Failed to build tool page for ${entry.relativePath}:`, e.message);
        }
    }

    registry.shares[shareId] = {
        id: shareId,
        dir: shareDir,
        pagePath,
        files: fileEntries,
        totalSize,
        uploadedAt: Date.now(),
        expiresAt,
        ownerUsername: owner.username,
        // file names only after login (shares from before this flag keep the old landing page)
        metaGated: true
    };
    saveRegistry();

    // Exposed to the upload response too — lets upload.html offer a direct
    // reader/player link instead of only the landing page, same as the
    // "Default tool" preference already does for normal (non-protected)
    // uploads.
    const files = fileEntries.map(f => ({
        index: f.index,
        relativePath: f.relativePath,
        size: f.size,
        category: f.category || null,
        toolLink: f.toolLink || null
    }));

    return { link, expiresAt, files };
}

// ─── POST /api/protected/upload ──────────────────────────────────────────
// Fields: files[] (raw file bytes, NOT encrypted), relativePaths (JSON
// array, same order as files[], e.g. ["a.txt","photos/b.jpg"]),
// expirationMinutes.
//
// Good for smaller shares that comfortably fit in one request. For large
// files, the frontend uses the chunked /upload/init → /upload/chunk →
// /upload/complete flow below instead — same destination, same
// finalizeShare() tail, just assembled from chunks first.
router.post(
    '/upload',
    requireOwner,
    upload.fields([{ name: 'files', maxCount: 200 }]),
    async (req, res) => {
        const fileBlobs = (req.files && req.files.files) || [];
        const cleanupTmp = () => { for (const f of fileBlobs) { try { fs.unlinkSync(f.path); } catch (e) {} } };

        if (fileBlobs.length === 0) {
            cleanupTmp();
            return res.status(400).json({ error: 'No files provided' });
        }

        const owner = resolveOwner(req);
        if (!owner) {
            cleanupTmp();
            return res.status(401).json({ error: 'You must be logged in to TVFS to use this mode' });
        }

        let relativePaths;
        try {
            relativePaths = JSON.parse(req.body.relativePaths || '[]');
        } catch (e) {
            cleanupTmp();
            return res.status(400).json({ error: 'Invalid relativePaths' });
        }
        if (relativePaths.length !== fileBlobs.length) {
            cleanupTmp();
            return res.status(400).json({ error: 'relativePaths length must match files length' });
        }

        if (fileBlobs.reduce((sum, f) => sum + (f.size || 0), 0) > MAX_SHARE_TOTAL) {
            cleanupTmp();
            return res.status(413).json({ error: 'A share can hold at most 5GB in total' });
        }

        const shareId = generateShareId();
        const shareDir = path.join(SHARE_DIR, shareId);
        try { fs.mkdirSync(shareDir, { recursive: true }); } catch (err) {
            cleanupTmp();
            return res.status(500).json({ error: 'Failed to create share storage', details: err.message });
        }

        let totalSize = 0;
        const fileEntries = [];
        try {
            for (let i = 0; i < fileBlobs.length; i++) {
                const dest = path.join(shareDir, `file_${i}`);
                fs.renameSync(fileBlobs[i].path, dest);
                const stats = fs.statSync(dest);
                totalSize += stats.size;
                fileEntries.push({
                    index: i,
                    path: dest,
                    relativePath: String(relativePaths[i] || fileBlobs[i].originalname || `file_${i}`),
                    size: stats.size,
                    mimeType: fileBlobs[i].mimetype || null
                });
            }

            const { link, expiresAt, files } = await finalizeShare(shareId, shareDir, fileEntries, totalSize, owner, req.body.expirationMinutes);

            requestLogger.logEvent(req, 'protected_share_upload_complete', {
                shareId, fileCount: fileEntries.length, totalSize, expiresAt, ownerUsername: owner.username
            });

            console.log(`🗝️  [PROTECTED UPLOAD] ${shareId} (${fileEntries.length} files, ${totalSize} bytes, owner=${owner.username})`);
            res.json({ message: 'Protected share created', shareId, link, expiresAt, files });
        } catch (err) {
            cleanupTmp();
            try { fs.rmSync(shareDir, { recursive: true, force: true }); } catch (e) {}
            return res.status(500).json({ error: 'Failed to store share', details: err.message });
        }
    }
);

// ─── Chunked upload (large files) ─────────────────────────────────────
//
// Mirrors upload.js's /api/upload/init → /chunk → /complete pattern (same
// chunk-manifest-with-lock approach), extended to a whole BATCH of files
// per share instead of just one. A manifest tracks, per file in the
// batch, how many chunks it needs and which have arrived; /complete only
// runs once every file's chunks are all in, then streams each file's
// chunks together in order — same streaming assembly upload.js uses, so
// memory use stays flat regardless of file size.

const CHUNK_TMP_DIR = path.join(PROTECTED_STORAGE_DIR, 'upload_chunks');
if (!fs.existsSync(CHUNK_TMP_DIR)) fs.mkdirSync(CHUNK_TMP_DIR, { recursive: true });

const CHUNK_SIZE = 25 * 1024 * 1024; // 25MB — matches the size class the frontend already treats as "big" elsewhere in this app
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB per file (owner: never over 5 GB)

const chunkUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, CHUNK_TMP_DIR),
        filename: (req, file, cb) => cb(null, `${crypto.randomBytes(8).toString('hex')}_chunk`)
    }),
    limits: { fileSize: CHUNK_SIZE + (5 * 1024 * 1024) } // a little headroom over the nominal chunk size
});

function chunkManifestPath(uploadId) {
    if (!isChunkUploadId(uploadId)) throw new Error('invalid upload id');
    return path.join(CHUNK_TMP_DIR, `${uploadId}_manifest.json`);
}
function readChunkManifest(uploadId) {
    if (!isChunkUploadId(uploadId)) return null;
    try { return JSON.parse(fs.readFileSync(chunkManifestPath(uploadId), 'utf8')); } catch { return null; }
}
function writeChunkManifest(uploadId, manifest) {
    fs.writeFileSync(chunkManifestPath(uploadId), JSON.stringify(manifest));
}
function chunkFilePath(uploadId, fileIndex, chunkIndex) {
    if (!isChunkUploadId(uploadId)) throw new Error('invalid upload id');
    return path.join(CHUNK_TMP_DIR, `${uploadId}_f${Number(fileIndex)}_c${String(Number(chunkIndex)).padStart(5, '0')}`);
}

// Simple per-uploadId mutex so two chunk requests for the SAME upload
// can't race each other's read-modify-write of the manifest. Different
// uploadIds never contend with each other.
const chunkMutexes = new Map();
function withChunkLock(uploadId, fn) {
    const prev = chunkMutexes.get(uploadId) || Promise.resolve();
    const run = prev.then(fn, fn);
    chunkMutexes.set(uploadId, run.catch(() => {}));
    return run;
}

// ─── POST /api/protected/upload/init ─────────────────────────────────────
// Body: { files: [{relativePath, size}, ...], expirationMinutes }
// A long file list (200 files with deep paths) outgrows the default 100 KB body limit, so this route has its own
// 2 MB parsers; index.js leaves exactly this path to them (INIT_BODY_PATH) and every other route keeps the default.
router.post('/upload/init', express.urlencoded({ extended: true, limit: INIT_BODY_LIMIT }), express.json({ limit: INIT_BODY_LIMIT }), (req, res) => {
    const owner = resolveOwner(req);
    if (!owner) return res.status(401).json({ error: 'You must be logged in to TVFS to use this mode' });

    let files;
    try { files = JSON.parse(req.body.files || '[]'); } catch (e) { return res.status(400).json({ error: 'Invalid files list' }); }
    if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'No files provided' });
    if (files.length > 200) return res.status(400).json({ error: 'Too many files (max 200)' });
    if (!checkRateLimit('pinit:' + owner.username, 20, 60 * 1000)) return res.status(429).json({ error: 'Too many uploads started, try again in a minute' });
    const declaredTotal = files.reduce((sum, f) => sum + (parseInt(f && f.size) || 0), 0);
    if (declaredTotal > MAX_SHARE_TOTAL) return res.status(413).json({ error: 'A share can hold at most 5GB in total' });

    for (const f of files) {
        if (!f || typeof f.relativePath !== 'string' || !f.relativePath) return res.status(400).json({ error: 'Every file needs a relativePath' });
        const size = parseInt(f.size);
        if (!Number.isFinite(size) || size < 0) return res.status(400).json({ error: `Invalid size for ${f.relativePath}` });
        if (size > MAX_FILE_SIZE) return res.status(413).json({ error: `${f.relativePath} is too large (max 5GB per file)` });
    }

    const uploadId = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const manifest = {
        uploadId,
        ownerUsername: owner.username,
        expirationMinutes: req.body.expirationMinutes,
        createdAt: Date.now(),
        files: files.map(f => ({
            relativePath: String(f.relativePath),
            size: parseInt(f.size) || 0,
            mimeType: f.mimeType ? String(f.mimeType) : null,
            totalChunks: Math.max(1, Math.ceil((parseInt(f.size) || 0) / CHUNK_SIZE)),
            receivedChunks: []
        }))
    };
    writeChunkManifest(uploadId, manifest);

    console.log(`🚀 [PROTECTED CHUNK INIT] ${uploadId} (${files.length} files, owner=${owner.username})`);
    res.json({ uploadId, chunkSize: CHUNK_SIZE, recommendedParallel: 4 });
});

// ─── POST /api/protected/upload/chunk ─────────────────────────────────────
// multipart form: chunk (blob), uploadId, fileIndex, chunkIndex
router.post('/upload/chunk', requireOwner, chunkUpload.single('chunk'), async (req, res) => {
    const cleanup = () => { if (req.file && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch (e) {} };

    const owner = resolveOwner(req);
    if (!owner) { cleanup(); return res.status(401).json({ error: 'You must be logged in to TVFS to use this mode' }); }
    if (!req.file) return res.status(400).json({ error: 'No chunk uploaded' });

    const { uploadId } = req.body;
    const fileIndex = parseInt(req.body.fileIndex);
    const chunkIndex = parseInt(req.body.chunkIndex);
    if (!uploadId || isNaN(fileIndex) || isNaN(chunkIndex)) { cleanup(); return res.status(400).json({ error: 'Missing uploadId/fileIndex/chunkIndex' }); }

    const ownerCheck = readChunkManifest(uploadId);
    if (!ownerCheck) { cleanup(); return res.status(400).json({ error: 'Invalid or expired upload session' }); }
    if (ownerCheck.ownerUsername !== owner.username) { cleanup(); return res.status(403).json({ error: 'This upload session belongs to a different user' }); }

    const result = await withChunkLock(uploadId, () => {
        const manifest = readChunkManifest(uploadId);
        if (!manifest) return { error: 'Invalid or expired upload session', status: 400 };

        const file = manifest.files[fileIndex];
        if (!file) return { error: `Invalid fileIndex: ${fileIndex}`, status: 400 };
        if (chunkIndex < 0 || chunkIndex >= file.totalChunks) return { error: `Invalid chunkIndex: ${chunkIndex}`, status: 400 };

        const dest = chunkFilePath(uploadId, fileIndex, chunkIndex);
        if (file.receivedChunks.includes(chunkIndex)) {
            try { fs.unlinkSync(req.file.path); } catch (e) {}
            return { success: true, duplicate: true, fileIndex, chunkIndex };
        }
        fs.renameSync(req.file.path, dest);
        file.receivedChunks.push(chunkIndex);
        file.receivedChunks.sort((a, b) => a - b);
        writeChunkManifest(uploadId, manifest);

        const totalReceived = manifest.files.reduce((sum, f) => sum + f.receivedChunks.length, 0);
        const totalChunks = manifest.files.reduce((sum, f) => sum + f.totalChunks, 0);
        return { success: true, fileIndex, chunkIndex, received: totalReceived, total: totalChunks };
    });

    if (result.error) { cleanup(); return res.status(result.status || 400).json({ error: result.error }); }
    res.json(result);
});

// ─── POST /api/protected/upload/complete ──────────────────────────────────
router.post('/upload/complete', async (req, res) => {
    const owner = resolveOwner(req);
    if (!owner) return res.status(401).json({ error: 'You must be logged in to TVFS to use this mode' });

    const { uploadId } = req.body;
    if (!uploadId) return res.status(400).json({ error: 'Missing uploadId' });

    const manifest = readChunkManifest(uploadId);
    if (!manifest) return res.status(400).json({ error: 'Invalid or expired upload session' });
    if (manifest.ownerUsername !== owner.username) return res.status(403).json({ error: 'This upload session belongs to a different user' });

    for (const f of manifest.files) {
        if (f.receivedChunks.length !== f.totalChunks) {
            return res.status(400).json({ error: `Missing chunks for ${f.relativePath}`, received: f.receivedChunks.length, expected: f.totalChunks });
        }
    }

    const shareId = generateShareId();
    const shareDir = path.join(SHARE_DIR, shareId);
    try { fs.mkdirSync(shareDir, { recursive: true }); } catch (err) {
        return res.status(500).json({ error: 'Failed to create share storage', details: err.message });
    }

    const cleanupChunks = () => {
        for (let fi = 0; fi < manifest.files.length; fi++) {
            for (let ci = 0; ci < manifest.files[fi].totalChunks; ci++) {
                const p = chunkFilePath(uploadId, fi, ci);
                if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (e) {}
            }
        }
        try { fs.unlinkSync(chunkManifestPath(uploadId)); } catch (e) {}
    };

    let totalSize = 0;
    const fileEntries = [];
    try {
        for (let fi = 0; fi < manifest.files.length; fi++) {
            const f = manifest.files[fi];
            const dest = path.join(shareDir, `file_${fi}`);
            const writeStream = fs.createWriteStream(dest);

            for (let ci = 0; ci < f.totalChunks; ci++) {
                const chunkPath = chunkFilePath(uploadId, fi, ci);
                if (!fs.existsSync(chunkPath)) { writeStream.destroy(); throw new Error(`Missing chunk file: ${f.relativePath} #${ci}`); }
                await new Promise((resolve, reject) => {
                    const readStream = fs.createReadStream(chunkPath);
                    readStream.pipe(writeStream, { end: false });
                    readStream.on('end', () => { fs.unlinkSync(chunkPath); resolve(); });
                    readStream.on('error', reject);
                });
            }
            writeStream.end();
            await new Promise(resolve => writeStream.on('finish', resolve));

            const stats = fs.statSync(dest);
            totalSize += stats.size;
            fileEntries.push({ index: fi, path: dest, relativePath: f.relativePath, size: stats.size, mimeType: f.mimeType || null });
        }

        const { link, expiresAt, files } = await finalizeShare(shareId, shareDir, fileEntries, totalSize, owner, manifest.expirationMinutes);
        cleanupChunks();

        requestLogger.logEvent(req, 'protected_share_upload_complete', {
            shareId, fileCount: fileEntries.length, totalSize, expiresAt, ownerUsername: owner.username, chunked: true
        });
        console.log(`🗝️  [PROTECTED UPLOAD, CHUNKED] ${shareId} (${fileEntries.length} files, ${totalSize} bytes, owner=${owner.username})`);
        res.json({ message: 'Protected share created', shareId, link, expiresAt, files });
    } catch (err) {
        cleanupChunks();
        try { fs.rmSync(shareDir, { recursive: true, force: true }); } catch (e) {}
        return res.status(500).json({ error: 'Failed to store share', details: err.message });
    }
});

// ─── GET /api/protected/:id/meta ─────────────────────────────────────────
router.get('/:id/meta', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const entry = getShare(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });
    // Names, folders and sizes only for a logged-in TVFS user (shares from before metaGated
    // keep the old behaviour until they expire: their landing page reads the list before login)
    if (entry.metaGated && !resolveOwner(req)) {
        return res.json({ id: entry.id, fileCount: entry.files.length, expiresAt: entry.expiresAt, loginRequired: true });
    }
    res.json({
        id: entry.id,
        fileCount: entry.files.length,
        files: entry.files.map(f => ({
            index: f.index,
            relativePath: f.relativePath,
            size: f.size,
            category: f.category || null,
            toolLink: f.toolLink || null
        })),
        totalSize: entry.totalSize,
        expiresAt: entry.expiresAt
    });
});

// ─── POST /api/protected/:id/login ───────────────────────────────────────
// Body: { username, password }. Verifies credentials and, on success,
// issues the SAME sitewide tvfs_token session cookie the main upload page
// uses (via issueLoginCookie) — no separate share-scoped bearer token.
//
// This used to hand back a short-lived accessToken that the frontend
// appended to every URL as ?token=... — anyone who got hold of a link
// (forwarded, screenshotted, logged, cached) could use it directly, no
// login required. That's gone: every protected route below now checks
// the same httpOnly session cookie as the rest of the site, so a bare
// link is worthless without actually being logged in as a TVFS user.
// One side effect that's actually a feature: since it's the real sitewide
// session, a reader/player/file link works directly (no landing-page
// click-through) for anyone already logged in anywhere on the site.
//
// Starts as a 24h session-only cookie (remember:false); the landing page's
// "stay logged in?" popup can upgrade it to the 1-year one via /api/auth
// afterward, same as it already did — that part is unchanged.
router.post('/:id/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const entry = getShare(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });

    // A valid session cookie is checked first and is never rate limited
    const cookieOwner = resolveOwner(req);
    if (cookieOwner) {
        return res.json({ ok: true, username: cookieOwner.username, isOwner: cookieOwner.username === entry.ownerUsername });
    }

    // The pages' silent "am I logged in?" check sends no credentials: not a login attempt
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        return res.status(403).json({ error: 'Invalid TVFS credentials' });
    }

    const ipKey = clientIp(req);
    const userKey = sha256(username.trim().toLowerCase());
    const wait = Math.max(loginFailuresByIp.retryAfter(ipKey), loginFailuresByUser.retryAfter(userKey));
    if (wait > 0) {
        res.set('Retry-After', wait);
        return res.status(429).json({ error: 'Too many failed attempts, try again later' });
    }

    const found = findUser(username, password);
    const user = found && found.tier >= 1 ? found : null; // the host login does not open Users Only shares
    if (!user) {
        loginFailuresByIp.fail(ipKey);
        loginFailuresByUser.fail(userKey);
        requestLogger.logEvent(req, 'protected_login_fail', { shareId: entry.id });
        return res.status(403).json({ error: 'Invalid TVFS credentials' });
    }
    loginFailuresByIp.reset(ipKey);
    loginFailuresByUser.reset(userKey);
    requestLogger.logEvent(req, 'protected_login_ok', { shareId: entry.id, username: user.username, viaCookie: false });
    uploadRouter.issueLoginCookie(res, user.tier, user.username, false);
    res.json({ ok: true, username: user.username, isOwner: user.username === entry.ownerUsername });
});

// ─── GET /api/protected/:id/file/:index — the actual gate ────────────────
// No network request for file bytes succeeds without a valid, currently
// logged-in TVFS session (the same tvfs_token cookie checked everywhere
// else on the site) — this is the entire security model for this mode,
// so there is deliberately no other way in. No token, no query string.
router.get('/:id/file/:index', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const entry = getShare(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });

    const auth = uploadRouter.authenticateRequest(req);
    if (!auth.valid || auth.tier < 1) {
        console.log(`🔒 [PROTECTED FILE] 403 — cookie ${req.cookies && req.cookies.tvfs_token ? 'present but invalid/expired' : 'missing'} (share=${entry.id}, index=${req.params.index}, ip=${clientIp(req)})`);
        return res.status(403).json({ error: 'Not logged in — log in as a TVFS user first' });
    }

    const idx = parseInt(req.params.index, 10);
    const file = entry.files[idx];
    if (!file) return res.status(400).json({ error: 'Invalid file index' });

    // res.attachment() encodes the name (ASCII fallback + RFC 5987 filename*); a raw non-ASCII name in the header made Node throw and crash the process
    res.attachment(path.basename(file.relativePath));
    res.sendFile(file.path, (err) => {
        if (err) return;
        requestLogger.logEvent(req, 'protected_file_download', { shareId: entry.id, fileIndex: idx, relativePath: file.relativePath });
    });
});

// Files, landing page and per-file reader/player pages of one share
function removeShareFiles(entry) {
    try { if (entry.dir && fs.existsSync(entry.dir)) fs.rmSync(entry.dir, { recursive: true, force: true }); } catch (e) {}
    try { if (entry.pagePath && fs.existsSync(entry.pagePath)) fs.unlinkSync(entry.pagePath); } catch (e) {}
    // entries from before the pairing removal may still have a dashboard page
    try { if (entry.dashboardPagePath && fs.existsSync(entry.dashboardPagePath)) fs.unlinkSync(entry.dashboardPagePath); } catch (e) {}
    if (Array.isArray(entry.files)) {
        for (const f of entry.files) {
            try { if (f.toolPagePath && fs.existsSync(f.toolPagePath)) fs.unlinkSync(f.toolPagePath); } catch (e) {}
        }
    }
}

// ─── DELETE /api/protected/:id — the owner removes a share before it expires ─
router.delete('/:id', (req, res) => {
    const entry = getShare(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });
    const owner = resolveOwner(req);
    if (!owner) return res.status(401).json({ error: 'Not logged in' });
    if (owner.username !== entry.ownerUsername) return res.status(403).json({ error: 'Only the owner can delete this share' });
    removeShareFiles(entry);
    delete registry.shares[entry.id];
    saveRegistrySync();
    requestLogger.logEvent(req, 'protected_share_deleted', { shareId: entry.id, username: owner.username });
    res.json({ deleted: true });
});

function sweepExpired() {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of Object.entries(registry.shares)) {
        if (entry.expiresAt <= now) {
            removeShareFiles(entry);
            delete registry.shares[id];
            removed++;
            requestLogger.logEvent(CRON_PSEUDO_REQ, 'protected_share_expired_deleted', { shareId: id });
        }
    }
    if (removed > 0) saveRegistrySync();

    // Abandoned chunked uploads: someone started a chunked upload and
    // never finished it (closed the tab, lost connection, gave up). Their
    // manifest + any partial chunk files just sit in CHUNK_TMP_DIR forever
    // otherwise. Anything older than 24h with no /upload/complete gets
    // swept here.
    let chunkUploadsSwept = 0;
    try {
        const CHUNK_ABANDON_MS = 24 * 60 * 60 * 1000;
        for (const entry of fs.readdirSync(CHUNK_TMP_DIR)) {
            if (!entry.endsWith('_manifest.json')) continue;
            const manifestFilePath = path.join(CHUNK_TMP_DIR, entry);
            let manifest;
            try { manifest = JSON.parse(fs.readFileSync(manifestFilePath, 'utf8')); } catch { manifest = null; }
            if (!manifest || !manifest.createdAt || now - manifest.createdAt < CHUNK_ABANDON_MS) continue;
            if (!isChunkUploadId(manifest.uploadId)) { try { fs.unlinkSync(manifestFilePath); } catch (e) {} continue; }

            for (let fi = 0; fi < (manifest.files || []).length; fi++) {
                for (let ci = 0; ci < manifest.files[fi].totalChunks; ci++) {
                    const p = chunkFilePath(manifest.uploadId, fi, ci);
                    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (e) {}
                }
            }
            try { fs.unlinkSync(manifestFilePath); } catch (e) {}
            chunkUploadsSwept++;
        }
        if (chunkUploadsSwept > 0) console.log(`  🧩 Abandoned chunked protected uploads swept: ${chunkUploadsSwept}`);
    } catch (e) {
        console.error('  ⚠️  Failed to sweep abandoned protected chunk uploads:', e.message);
    }

    return { removed, chunkUploadsSwept };
}

module.exports = {
    router,
    INIT_BODY_PATH,
    sweepExpired,
    registry,
    saveRegistry,
    saveRegistrySync,
    getShare,
    resolveOwner,
    checkRateLimit,
    clientIp,
    findUser,
    sha256
};
