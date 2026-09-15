'use strict';
/**
 * opaqueServer.js — server-side half of OPAQUE (asymmetric PAKE), used to
 * replace the old "verify-blob" trick for Encrypted Sharing password
 * checks. Uses @cloudflare/opaque-ts (real, published implementation —
 * not hand-rolled elliptic curve math).
 *
 * What this buys us over the old design:
 *   - The server CAN now genuinely rate-limit password guesses (each
 *     guess requires a network round trip it controls), unlike the old
 *     verify-blob trick where rate-limiting only throttled how often you
 *     could DOWNLOAD the blob, not how many guesses you could try against
 *     an already-downloaded copy.
 *   - What the server stores per file (a RegistrationRecord, ~130 bytes)
 *     is NOT offline-crackable even if it leaks — that's OPAQUE's core
 *     security property (an "asymmetric PAKE"), unlike a plain password
 *     hash or the old verifier-style tricks.
 *   - The file's actual AES key is now OPAQUE's `export_key` output
 *     (32 bytes, derived from the password, NEVER transmitted over the
 *     network in either direction) instead of a separate PBKDF2 step —
 *     one mechanism does both jobs.
 *
 * Server key material (oprf_seed + AKE keypair) is generated ONCE and
 * persisted to disk. If it's ever lost or rotated, every previously
 * registered file becomes permanently unrecoverable — treat this file
 * with the same care as any other server secret (it lives outside
 * files_web, alongside everything else in protected_storage).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    OpaqueServer, getOpaqueConfig, OpaqueID,
    RegistrationRequest, RegistrationRecord, KE1, KE3
} = require('@cloudflare/opaque-ts');

const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
const SERVER_IDENTITY = 'files.tomasekvalla.cz';

const KEY_FILE = path.join(__dirname, 'protected_storage', 'opaque_server_keys.json');

function randBytes(n) { return Array.from(crypto.randomBytes(n)); }

function loadOrCreateServerKeys() {
    try {
        const raw = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
        return raw;
    } catch (e) {
        const keys = {
            oprf_seed: randBytes(cfg.constants.Nseed),
            // generateAuthKeyPair() is async in the library, but we only
            // need this once ever — do it synchronously-ish at startup
            // via a blocking pattern below instead of top-level await
            // (this file is required with plain require(), not import).
            ake_keypair: null
        };
        return keys; // ake_keypair filled in by ensureServerKeys() below
    }
}

let _serverKeysPromise = null;
async function ensureServerKeys() {
    if (_serverKeysPromise) return _serverKeysPromise;
    _serverKeysPromise = (async () => {
        let keys = loadOrCreateServerKeys();
        if (!keys.ake_keypair) {
            keys.ake_keypair = await cfg.ake.generateAuthKeyPair();
            fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
            fs.writeFileSync(KEY_FILE, JSON.stringify(keys));
            console.log('🔑 [OPAQUE] Generated new server key material at', KEY_FILE);
        }
        return keys;
    })();
    return _serverKeysPromise;
}

let _server = null;
async function getServer() {
    if (_server) return _server;
    const keys = await ensureServerKeys();
    _server = new OpaqueServer(cfg, keys.oprf_seed, keys.ake_keypair, SERVER_IDENTITY);
    return _server;
}

// ─── Registration (upload time) ───────────────────────────────────────────
// credential_identifier: our own fileId/vaultId — ties the OPAQUE record
// to a specific share so two different files never share OPRF output.

async function registerInit(requestJson, credentialIdentifier) {
    const server = await getServer();
    const request = RegistrationRequest.deserialize(cfg, requestJson);
    const response = await server.registerInit(request, credentialIdentifier);
    if (response instanceof Error) throw response;
    return response.serialize();
}

// ─── Login (unlock time) ───────────────────────────────────────────────────
//
// Two steps, matching the protocol: authInit (server produces KE2 + an
// `expected` value it must remember until authFinish), then authFinish
// (server confirms the client really knew the password). `expected`
// cannot be handed to the client — it's cached here, server-side, keyed
// by a random session id with a short TTL.

const pendingLogins = new Map(); // sessionId -> { expected, expiresAt }
const LOGIN_SESSION_TTL_MS = 2 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [id, e] of pendingLogins) if (now > e.expiresAt) pendingLogins.delete(id);
}, 60000).unref();

async function authInit(ke1Json, recordJson, credentialIdentifier) {
    const server = await getServer();
    const ke1 = KE1.deserialize(cfg, ke1Json);
    const record = RegistrationRecord.deserialize(cfg, recordJson);
    const result = await server.authInit(ke1, record, credentialIdentifier);
    if (result instanceof Error) throw result;

    const sessionId = crypto.randomBytes(16).toString('hex');
    pendingLogins.set(sessionId, { expected: result.expected, expiresAt: Date.now() + LOGIN_SESSION_TTL_MS });
    return { ke2: result.ke2.serialize(), sessionId };
}

// Returns { ok: true } on genuine success, { ok: false } otherwise —
// never throws for a wrong password (that's an expected outcome, not an
// error condition), only for protocol-level problems (bad/expired session).
async function authFinish(ke3Json, sessionId) {
    const server = await getServer();
    const pending = pendingLogins.get(sessionId);
    if (!pending) return { ok: false, reason: 'expired_or_unknown_session' };
    pendingLogins.delete(sessionId); // one-shot — a session id is never reused

    const ke3 = KE3.deserialize(cfg, ke3Json);
    const result = server.authFinish(ke3, pending.expected);
    if (result instanceof Error) return { ok: false, reason: 'auth_failed' };
    return { ok: true };
}

module.exports = { registerInit, authInit, authFinish, ensureServerKeys, cfg, SERVER_IDENTITY };
