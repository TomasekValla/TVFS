'use strict';

const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

function sha256(str) {
    return crypto.createHash('sha256').update(str).digest('hex');
}

function timingSafeEqualStr(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// ─── Accounts ──────────────────────────────────────────────────────────────
//
// Each user has a secret login username and a password. ENV format, one entry per user:
//
//   TIER1_USERS=Codename:usernameSha256:passwordHash,Codename2:...
//   TIER2_USERS=...      TIER3_USERS=...      (3 = admin)
//
// passwordHash is either the old plain sha256 hex, or `scrypt$<N>$<r>$<p>$<salt>$<hash>`
// (salt and hash base64url), made by `node scripts/add-user.js`. "Codename" is the display and
// storage name (sync file, owner of uploads); it never appears in the public code.
//
// Tier 0 is the shared "host" account for strangers: username "host", a password that changes
// every day (HOST_PASSWORD_TEMPLATE, default: today's date like 16.11.2026, Prague time) and a
// session that ends at the next midnight.

const TIERS = [3, 2, 1];
const HOST_USERNAME = 'host';
const TIME_ZONE = 'Europe/Prague';

function parseUserList(envVal) {
    if (!envVal) return [];
    return envVal.split(',').map(entry => {
        const parts = entry.split(':');
        if (parts.length !== 3) {
            console.warn('⚠️  [USER IDENTITY] Malformed entry (expected Codename:usernameHash:passwordHash), skipping one entry');
            return null;
        }
        const username = parts[0].trim();
        const userHash = parts[1].trim().toLowerCase();
        const passHash = parts[2].trim();
        if (!username || !userHash || !passHash) return null;
        if (!/^[0-9a-f]{64}$/.test(userHash)) {
            console.warn(`⚠️  [USER IDENTITY] "${username}" usernameHash is not 64 hex characters — check .env. This user will NOT be able to log in.`);
        }
        if (!/^[0-9a-f]{64}$/i.test(passHash) && !passHash.startsWith('scrypt$')) {
            console.warn(`⚠️  [USER IDENTITY] "${username}" passwordHash has an unknown format — check .env. This user will NOT be able to log in.`);
        }
        return { username, userHash, passHash };
    }).filter(Boolean);
}

function getActiveUsers() {
    if (!process.env.TIER1_USERS && !process.env.TIER2_USERS && !process.env.TIER3_USERS) {
        require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
    }
    return {
        3: parseUserList(process.env.TIER3_USERS),
        2: parseUserList(process.env.TIER2_USERS),
        1: parseUserList(process.env.TIER1_USERS),
    };
}

// scrypt$N$r$p$salt$hash, or legacy sha256 hex
function verifyPassword(password, stored) {
    if (stored.startsWith('scrypt$')) {
        const [, n, r, p, salt, hash] = stored.split('$');
        try {
            const expected = Buffer.from(hash, 'base64url');
            const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length,
                { N: +n, r: +r, p: +p, maxmem: 256 * 1024 * 1024 });
            return expected.length > 0 && crypto.timingSafeEqual(got, expected);
        } catch (e) {
            return false;
        }
    }
    return timingSafeEqualStr(stored.toLowerCase(), sha256(String(password)));
}

function hashPassword(password) {
    const N = 32768, r = 8, p = 1;
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 });
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

// ─── Prague calendar helpers (tier 0) ─────────────────────────────────────

function pragueParts(ts = Date.now()) {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
    const [y, m, d] = f.format(new Date(ts)).split('-').map(Number);
    return { y, m, d };
}

// The first moment of the next Prague day (handles summer time)
function nextPragueMidnight(ts = Date.now()) {
    const today = pragueParts(ts);
    let t = Date.UTC(today.y, today.m - 1, today.d + 1) - 3 * 3600 * 1000; // a bit before
    for (let i = 0; i < 400; i++, t += 60 * 1000) {
        const p = pragueParts(t);
        if (p.y !== today.y || p.m !== today.m || p.d !== today.d) return t;
    }
    return ts + 24 * 3600 * 1000;
}

// Placeholders: {d} {m} {dd} {mm} {yyyy} {m*d}. Default: "{d}.{m}.{yyyy}" -> 16.11.2026
function hostPasswordFor(ts = Date.now()) {
    const { y, m, d } = pragueParts(ts);
    const template = process.env.HOST_PASSWORD_TEMPLATE || '{d}.{m}.{yyyy}';
    return template
        .replace(/\{m\*d\}/g, String(m * d))
        .replace(/\{dd\}/g, String(d).padStart(2, '0'))
        .replace(/\{mm\}/g, String(m).padStart(2, '0'))
        .replace(/\{yyyy\}/g, String(y))
        .replace(/\{d\}/g, String(d))
        .replace(/\{m\}/g, String(m));
}

const hostEnabled = () => process.env.HOST_DISABLED !== '1';

// ─── Lookups ───────────────────────────────────────────────────────────────

// The user with this codename in the current .env lists, or null when removed. `fingerprint`
// changes when their username or password hash changes (for host: every day), so older
// sessions end.
function currentUser(codename) {
    if (!codename) return null;
    if (codename === HOST_USERNAME) {
        if (!hostEnabled()) return null;
        const { y, m, d } = pragueParts();
        return { tier: 0, username: HOST_USERNAME, fingerprint: sha256(`session-fp:host:${y}-${m}-${d}`).slice(0, 32) };
    }
    const users = getActiveUsers();
    for (const tier of TIERS) {
        const u = users[tier].find(x => x.username === codename);
        if (u) return { tier, username: u.username, fingerprint: sha256('session-fp:' + u.userHash + ':' + u.passHash).slice(0, 32) };
    }
    return null;
}

// Checks the secret username and the password together; a wrong username and a wrong
// password look the same to the caller. The password hash is only computed for the user
// whose username matched (scrypt is deliberately slow).
function findUser(username, password) {
    if (!username || !password) return null;
    const name = String(username).trim();
    if (name.toLowerCase() === HOST_USERNAME) {
        return hostEnabled() && timingSafeEqualStr(String(password), hostPasswordFor()) ? { tier: 0, username: HOST_USERNAME } : null;
    }
    const uHash = sha256(name);
    const users = getActiveUsers();
    for (const tier of TIERS) {
        for (const u of users[tier]) {
            if (timingSafeEqualStr(u.userHash, uHash)) {
                return verifyPassword(password, u.passHash) ? { tier, username: u.username } : null;
            }
        }
    }
    // same work as a real check, so a wrong username takes as long as a wrong password
    verifyPassword(password, DUMMY_HASH);
    return null;
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

// Safe for filenames / storage keys
function sanitizeUsername(username) {
    return String(username).replace(/[^\w\-]/g, '_');
}

module.exports = { findUser, currentUser, sanitizeUsername, sha256, hashPassword, verifyPassword, hostPasswordFor, nextPragueMidnight, pragueParts, HOST_USERNAME };
