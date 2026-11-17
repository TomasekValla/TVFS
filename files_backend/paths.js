'use strict';
// Where TVFS keeps things. Public files live in the nginx web root (files_web/files);
// the backend's own data (registry, per-user history, request logs) lives in DATA_DIR,
// outside the web root and outside the public repository (files_backend/storage is ignored).
const fs = require('fs');
const path = require('path');

const FILES_WEB_DIR = process.env.CLEANUP_FILES_WEB_DIR || path.join(__dirname, '..', 'files_web');
const DATA_DIR = process.env.TVFS_DATA_DIR || path.join(__dirname, 'storage', 'tvfs-data');

const P = {
    FILES_WEB_DIR,
    FILES_DIR: path.join(FILES_WEB_DIR, 'files'),
    DATA_DIR,
    REGISTRY_PATH: path.join(DATA_DIR, 'file_registry.json'),
    USERS_DIR: path.join(DATA_DIR, 'users'),
    LOG_DIR: path.join(DATA_DIR, 'logs'),
    // touched by the running backend; the cron cleanup stays idle while it is fresh
    HEARTBEAT_PATH: path.join(DATA_DIR, 'backend.alive'),
};

function move(from, to) {
    try { fs.renameSync(from, to); return true; } catch (e) {
        if (e.code === 'ENOENT') return false; // another process moved it first
        if (e.code !== 'EXDEV') throw e;
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        fs.unlinkSync(from);
        return true;
    }
}

// One-time move of the data files that used to sit in the web root. Safe to call from
// every module and process: it never overwrites a file that is already in DATA_DIR.
let migrated = false;
function migrateFromWebRoot() {
    if (migrated) return;
    migrated = true;
    fs.mkdirSync(P.USERS_DIR, { recursive: true });
    fs.mkdirSync(P.LOG_DIR, { recursive: true });
    const moved = [];
    const oldRegistry = path.join(FILES_WEB_DIR, 'file_registry.json');
    if (fs.existsSync(oldRegistry) && !fs.existsSync(P.REGISTRY_PATH) && move(oldRegistry, P.REGISTRY_PATH)) moved.push('file_registry.json');
    for (const leftover of ['file_registry.json.tmp', 'file_registry.json.lock']) {
        try { fs.unlinkSync(path.join(FILES_WEB_DIR, leftover)); } catch (e) {}
    }
    for (const [sub, target] of [['users', P.USERS_DIR], ['logs', P.LOG_DIR]]) {
        const dir = path.join(FILES_WEB_DIR, sub);
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            const from = path.join(dir, name), to = path.join(target, name);
            try {
                if (!fs.statSync(from).isFile()) continue;
                if (name.endsWith('.tmp')) { fs.unlinkSync(from); continue; }
                if (!fs.existsSync(to) && move(from, to)) moved.push(`${sub}/${name}`);
            } catch (e) {
                console.error(`[PATHS] Could not move ${sub}/${name} out of the web root:`, e.message);
            }
        }
        try { fs.rmdirSync(dir); } catch (e) {} // only when empty
    }
    if (moved.length) console.log(`[PATHS] Moved ${moved.length} data file(s) out of the web root into ${DATA_DIR}`);
}

module.exports = { ...P, migrateFromWebRoot };
