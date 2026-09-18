'use strict';

const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

function sha256(str) {
    return crypto.createHash('sha256').update(str).digest('hex');
}

function timingSafeHexEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false; // lengths always match for sha256 hex, but be safe
    return crypto.timingSafeEqual(bufA, bufB);
}

// ─── Per-user secret login username + password ─────────────────────────────
//
// Each user gets their OWN secret username, not a single shared one. Both
// the username and the password are checked, and both are stored only as
// sha256 hashes in env — so leaking the env var doesn't leak either value
// directly.
//
// ENV format, one entry per user:
//
//   TIER1_USERS=Codename:usernameHash:passwordHash,Codename2:usernameHash2:passwordHash2
//   TIER2_USERS=Codename3:usernameHash3:passwordHash3
//
// "Codename" is just the display/storage name (used for the per-user sync
// file, ownerKey, "Authenticated as ..." label, etc.) — it's fine for it to
// be plaintext in env, it's not a secret by itself. The secret username and
// password are the two hashed fields.

function parseUserList(envVal) {
    if (!envVal) return [];
    return envVal.split(',').map(entry => {
        const parts = entry.split(':');
        if (parts.length !== 3) {
            console.warn(`⚠️  [USER IDENTITY] Malformed entry (expected Codename:usernameHash:passwordHash), skipping: "${entry}"`);
            return null;
        }
        const [rawCodename, rawUserHash, rawPassHash] = parts;
        const username = rawCodename.trim();
        const userHash = rawUserHash.trim().toLowerCase();
        const passHash = rawPassHash.trim().toLowerCase();
        if (!username || !userHash || !passHash) return null;

        // A sha256 hex digest is ALWAYS exactly 64 characters. If it isn't,
        // the entry was almost certainly copy-pasted wrong (truncated,
        // extra char, missing char) — and without this check that user
        // would just silently never be able to log in with no clue why.
        if (!/^[0-9a-f]{64}$/.test(userHash)) {
            const reason = userHash.length !== 64 ? `is ${userHash.length} chars, expected 64` : 'contains non-hex characters';
            console.warn(`⚠️  [USER IDENTITY] "${username}" usernameHash ${reason} — check for a copy-paste mistake in .env. This user will NOT be able to log in.`);
        }
        if (!/^[0-9a-f]{64}$/.test(passHash)) {
            const reason = passHash.length !== 64 ? `is ${passHash.length} chars, expected 64` : 'contains non-hex characters';
            console.warn(`⚠️  [USER IDENTITY] "${username}" passwordHash ${reason} — check for a copy-paste mistake in .env. This user will NOT be able to log in.`);
        }

        return { username, userHash, passHash };
    }).filter(Boolean);
}

function getActiveUsers() {
    // If neither tier is configured in process.env, ensure .env from this dir is loaded
    if (!process.env.TIER1_USERS && !process.env.TIER2_USERS) {
        require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
    }
    const tier1 = parseUserList(process.env.TIER1_USERS);
    const tier2 = parseUserList(process.env.TIER2_USERS);
    return { tier1, tier2 };
}

// Checks BOTH the secret username and the password together — a scanner
// that gets one right and one wrong still just sees a generic 403, same as
// getting both wrong.
function findUser(username, password) {
    if (!username || !password) return null;
    const uHash = sha256(String(username).trim());
    const pHash = sha256(String(password));

    const { tier1, tier2 } = getActiveUsers();

    const t2 = tier2.find(u => timingSafeHexEqual(u.userHash, uHash) && timingSafeHexEqual(u.passHash, pHash));
    if (t2) return { tier: 2, username: t2.username };

    const t1 = tier1.find(u => timingSafeHexEqual(u.userHash, uHash) && timingSafeHexEqual(u.passHash, pHash));
    if (t1) return { tier: 1, username: t1.username };

    return null;
}

// Safe for filenames / storage keys
function sanitizeUsername(username) {
    return String(username).replace(/[^\w\-]/g, '_');
}

module.exports = { findUser, sanitizeUsername, sha256 };

