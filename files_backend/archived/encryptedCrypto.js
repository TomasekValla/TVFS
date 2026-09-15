'use strict';
/**
 * encryptedCrypto.js — TVFS Encrypted Sharing client-side crypto module.
 *
 * Zero-knowledge: everything in this file runs in the browser. The server
 * NEVER sees a password, a key, or plaintext. It only ever sees ciphertext
 * + (optionally, if not "Private file") the MIME/category metadata needed
 * to pick a UI element.
 *
 * Crypto choices:
 *   - AES-256-GCM (Web Crypto native, authenticated — integrity check is
 *     built in, no extra HMAC needed for the whole-file path).
 *   - PBKDF2-SHA256, 600,000 iterations as the password → key KDF.
 *     NOTE: Argon2id would be preferable against GPU brute-force (see the
 *     TVFS Encrypted Sharing design notes), but it needs a WASM dependency
 *     (argon2-browser / hash-wasm) that isn't vendored here. PBKDF2 at
 *     600k iterations via native Web Crypto is the pragmatic zero-dependency
 *     baseline; swap deriveKeyFromPassword's internals for Argon2id later
 *     without touching anything else in this file.
 *   - The "verify-file" trick: a small, fixed, publicly-known plaintext is
 *     encrypted with the same key/password and uploaded alongside the real
 *     file. Decrypting THAT first and comparing against the public
 *     /dont-trust-verify.txt confirms the password is right before the
 *     (potentially large) real file is fetched/decrypted at all.
 *
 * Exposed as `window.TVFSCrypto`.
 */
(function (global) {

    // Must byte-for-byte match /dont-trust-verify.txt served by the backend.
    const VERIFY_PLAINTEXT =
        'https://files.tomasekvalla.cz - thanks for using our services - https://youtube.com/watch?v=dQw4w9WgXcQ';

    const PBKDF2_ITERATIONS = 600000;
    const SALT_BYTES = 16;
    const IV_BYTES = 12; // 96-bit, standard/recommended for AES-GCM

    const enc = new TextEncoder();
    const dec = new TextDecoder();

    // ─── Encoding helpers ───────────────────────────────────────────────

    function bufToBase64(buf) {
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    function base64ToBuf(b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    function bufToHex(buf) {
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // ─── Password / key generation ──────────────────────────────────────

    const RANDOM_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    function randomPassword(length) {
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes);
        let out = '';
        for (let i = 0; i < length; i++) out += RANDOM_CHARS[bytes[i] % RANDOM_CHARS.length];
        return out;
    }

    // BIP39 English wordlist is large (2048 words); rather than vendor the
    // full list in this module, callers that want diceware passphrases
    // should load /bip39-wordlist.json separately and pass words into
    // randomPassphrase(). This keeps this module dependency-free.
    function randomPassphrase(wordlist, wordCount) {
        const words = [];
        const idx = new Uint32Array(wordCount);
        crypto.getRandomValues(idx);
        for (let i = 0; i < wordCount; i++) words.push(wordlist[idx[i] % wordlist.length]);
        return words.join('-');
    }

    // Rough entropy estimate for the "crack time" UI hint.
    function estimateEntropyBits(kind, param) {
        if (kind === 'random') return Math.log2(RANDOM_CHARS.length) * param; // param = length
        if (kind === 'diceware') return Math.log2(2048) * param; // param = wordCount, BIP39 = 2048 words
        return 0;
    }

    const SUPERSCRIPT_DIGITS = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','-':'⁻' };
    function toSuperscript(n) {
        return String(n).split('').map(ch => SUPERSCRIPT_DIGITS[ch] || ch).join('');
    }

    // ── Effective guess ceilings, post-OPAQUE ───────────────────────────
    //
    // Before OPAQUE, a file's password could be brute-forced OFFLINE at
    // GPU speed (~1e10 guesses/sec) once the verify-blob was downloaded —
    // that's what the old estimate here reflected. OPAQUE removes that
    // path entirely: the RegistrationRecord stored server-side is not
    // offline-crackable by design (that's the whole point of an
    // asymmetric PAKE), so the ONLY remaining way to guess a password is
    // through the server's own login protocol — which the global rate
    // limiter (rateLimiter.js) bounds hard.
    //
    // These constants mirror the EXACT thresholds encryptedShare.js /
    // protectedShare.js configure their limiters with — if those ever
    // change, update these too (there's no live coupling across the
    // client/server boundary for a UI estimate, so this is a
    // by-convention sync, not an automatic one):
    //
    //   verifyLimiter (file password attempts): 50 requests trigger the
    //     throttle, 30 more while throttled trigger a 1-hour lock.
    //   authLimiter (TVFS login attempts): 100 requests trigger the
    //     throttle, 100 more while throttled trigger a 1-hour lock.
    //
    // Worst case for an attacker (unlimited distributed IPs to dodge the
    // per-IP cap): they get (normal + lockAdd) guesses, then face a full
    // hour of zero guesses, repeating forever. That cycle length and
    // count is what bounds the effective long-run guesses/year below.
    function guessesPerYearFromLimiter(normalMax, lockAddMax, lockHours, windowMinutes) {
        const guessesPerCycle = normalMax + lockAddMax;
        const cycleMinutes = windowMinutes * 2 + lockHours * 60; // normal window + throttled window + lock
        const cyclesPerYear = 525600 / cycleMinutes; // 525,600 minutes/year
        return guessesPerCycle * cyclesPerYear;
    }

    const VERIFY_GUESSES_PER_YEAR = guessesPerYearFromLimiter(50, 30, 1, 15);
    const AUTH_GUESSES_PER_YEAR = guessesPerYearFromLimiter(100, 100, 1, 15);
    const SECONDS_PER_YEAR = 31536000;

    // Default guessesPerSecond now reflects the ONLINE rate limiter
    // ceiling (file password, via OPAQUE) rather than an offline GPU rate
    // — there is no offline attack surface left to estimate against.
    function formatCrackTime(entropyBits, guessesPerSecond = VERIFY_GUESSES_PER_YEAR / SECONDS_PER_YEAR) {
        // Worked entirely in log10-space: for long random passwords/passphrases
        // (e.g. 192 random chars ≈ 1143 bits), 2^entropyBits overflows a JS
        // double to Infinity long before we'd ever format it — logs never do.
        const log10Guesses = entropyBits * Math.log10(2);
        const log10Seconds = log10Guesses - Math.log10(guessesPerSecond) - Math.log10(2); // /2 = average case

        if (log10Seconds < 0) return '< 1 second';

        const unitsByLog10Seconds = [
            ['years', Math.log10(31536000)], ['days', Math.log10(86400)],
            ['hours', Math.log10(3600)], ['minutes', Math.log10(60)], ['seconds', 0]
        ];
        for (const [name, unitLog10] of unitsByLog10Seconds) {
            const log10Val = log10Seconds - unitLog10;
            if (log10Val >= 0) {
                if (name === 'years' && log10Val > 6) {
                    // e.g. "8.2 × 10⁹⁶ years" — real superscript, not "8.2e+96"
                    const exponent = Math.floor(log10Val);
                    const mantissa = Math.pow(10, log10Val - exponent);
                    return `${mantissa.toFixed(1)} × 10${toSuperscript(exponent)} years`;
                }
                const val = Math.pow(10, log10Val);
                return `${Math.round(val).toLocaleString()} ${name}`;
            }
        }
        return '< 1 second';
    }

    // ── TVFS login crack-time estimate ──────────────────────────────────
    // Shown alongside the file's own crack-time whenever "TVFS Users
    // Only" is enabled, since that adds a SECOND thing an attacker would
    // have to guess (the secret TVFS username+password) before the
    // server even releases anything. This is necessarily illustrative —
    // it assumes a representative credential shape (7-letter username,
    // an 8-character password mixing letters with 2 digits), NOT the
    // actual secret values, which this code has no access to and never
    // will (they're sha256-hashed server-side per userIdentity.js).
    function estimateTvfsLoginEntropyBits() {
        const USERNAME_LEN = 7;
        const PASSWORD_LEN = 8;
        const PASSWORD_DIGIT_COUNT = 2;
        const usernameBits = USERNAME_LEN * Math.log2(26); // lowercase letters only
        // Password: choose which 2 of 8 positions are digits (combinatorial
        // placement), the rest are letters, digits are 0-9.
        const passwordLetterCount = PASSWORD_LEN - PASSWORD_DIGIT_COUNT;
        const placements = combinations(PASSWORD_LEN, PASSWORD_DIGIT_COUNT);
        const passwordBits = Math.log2(placements) + passwordLetterCount * Math.log2(26) + PASSWORD_DIGIT_COUNT * Math.log2(10);
        return usernameBits + passwordBits;
    }
    function combinations(n, k) {
        let result = 1;
        for (let i = 0; i < k; i++) result = result * (n - i) / (i + 1);
        return result;
    }
    function formatTvfsLoginCrackTime() {
        return formatCrackTime(estimateTvfsLoginEntropyBits(), AUTH_GUESSES_PER_YEAR / SECONDS_PER_YEAR);
    }

    // ─── Key derivation ──────────────────────────────────────────────────

    async function deriveKeyFromPassword(password, saltBytes) {
        const baseKey = await crypto.subtle.importKey(
            'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
            baseKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    // ─── Encrypt / decrypt ────────────────────────────────────────────────

    // Returns { salt: Uint8Array, iv: Uint8Array, ciphertext: ArrayBuffer }
    async function encryptBuffer(password, plainBuf) {
        const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
        const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        const key = await deriveKeyFromPassword(password, salt);
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBuf);
        return { salt, iv, ciphertext };
    }

    // salt/iv may be Uint8Array or base64 string.
    async function decryptBuffer(password, salt, iv, ciphertextBuf) {
        const saltBytes = typeof salt === 'string' ? new Uint8Array(base64ToBuf(salt)) : salt;
        const ivBytes = typeof iv === 'string' ? new Uint8Array(base64ToBuf(iv)) : iv;
        const key = await deriveKeyFromPassword(password, saltBytes);
        // Throws (DOMException OperationError) if the password/key is wrong —
        // GCM's auth tag check fails. Callers should catch this and treat it
        // as "wrong password", not crash the UI.
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, ciphertextBuf);
    }

    // Container format we actually ship to the server for both the real
    // file and the verify-blob: [salt(16)][iv(12)][ciphertext...]
    // Keeping salt+iv attached to the blob itself means the server never
    // needs a separate DB column for them and the client only needs one
    // fetch to get everything required to attempt a decrypt.
    function packContainer(salt, iv, ciphertextBuf) {
        const out = new Uint8Array(SALT_BYTES + IV_BYTES + ciphertextBuf.byteLength);
        out.set(salt, 0);
        out.set(iv, SALT_BYTES);
        out.set(new Uint8Array(ciphertextBuf), SALT_BYTES + IV_BYTES);
        return out.buffer;
    }

    function unpackContainer(containerBuf) {
        const bytes = new Uint8Array(containerBuf);
        const salt = bytes.slice(0, SALT_BYTES);
        const iv = bytes.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
        const ciphertext = bytes.slice(SALT_BYTES + IV_BYTES).buffer;
        return { salt, iv, ciphertext };
    }

    async function encryptToContainer(password, plainBuf) {
        const { salt, iv, ciphertext } = await encryptBuffer(password, plainBuf);
        return packContainer(salt, iv, ciphertext);
    }

    async function decryptContainer(password, containerBuf) {
        const { salt, iv, ciphertext } = unpackContainer(containerBuf);
        return decryptBuffer(password, salt, iv, ciphertext);
    }

    // ─── Verify-file trick ────────────────────────────────────────────────

    async function buildVerifyContainer(password) {
        return encryptToContainer(password, enc.encode(VERIFY_PLAINTEXT).buffer);
    }

    // Returns true/false — never throws (wraps the GCM auth failure).
    async function verifyPassword(password, verifyContainerBuf) {
        try {
            const plainBuf = await decryptContainer(password, verifyContainerBuf);
            return dec.decode(plainBuf) === VERIFY_PLAINTEXT;
        } catch (e) {
            return false;
        }
    }

    // ─── Filename encryption (for "encrypt filename" / Private file) ─────

    async function encryptFilename(password, filename) {
        const containerBuf = await encryptToContainer(password, enc.encode(filename).buffer);
        return bufToBase64(containerBuf);
    }

    async function decryptFilename(password, b64Container) {
        const plainBuf = await decryptContainer(password, base64ToBuf(b64Container));
        return dec.decode(plainBuf);
    }

function buildOpaqueHelpers() {
    function requireLib() {
        if (typeof OpaqueTS === 'undefined') throw new Error('opaque-client-bundle.js not loaded');
        return OpaqueTS;
    }
    function getConfig() {
        const L = requireLib();
        return L.getOpaqueConfig(L.OpaqueID.OPAQUE_P256);
    }

    // ── Registration (upload time) ──────────────────────────────────────
    // Two round trips to the server are unavoidable (OPAQUE's design):
    // registerInit() needs the server's OPRF response before
    // registerFinish() can run. Returns { record, exportKeyB64 } — upload
    // `record` to the server, use exportKeyB64 as the file's AES key.
    async function register(password, credentialIdentifier, serverIdentity, postRegisterInit) {
        const L = requireLib();
        const cfg = getConfig();
        const client = new L.OpaqueClient(cfg);

        const request = await client.registerInit(password);
        if (request instanceof Error) throw request;

        // postRegisterInit(requestSerialized) -> responseSerialized, a
        // caller-supplied function that POSTs to
        // /api/encrypted/:id/opaque/register-init and returns the
        // server's response bytes — kept generic here so this file has
        // no direct fetch()/endpoint-path dependency.
        const responseSerialized = await postRegisterInit(request.serialize());
        const response = L.RegistrationResponse.deserialize(cfg, responseSerialized);

        const finish = await client.registerFinish(response, serverIdentity);
        if (finish instanceof Error) throw finish;

        return {
            recordSerialized: finish.record.serialize(),
            exportKeyB64: bufToBase64(new Uint8Array(finish.export_key).buffer)
        };
    }

    // ── Login (unlock time) ─────────────────────────────────────────────
    // Returns { exportKeyB64 } on success, or throws on wrong password /
    // protocol failure. postLoginInit/postLoginFinish are caller-supplied
    // fetch wrappers, same reasoning as above.
    async function login(password, serverIdentity, postLoginInit, postLoginFinish) {
        const L = requireLib();
        const cfg = getConfig();
        const client = new L.OpaqueClient(cfg);

        const ke1 = await client.authInit(password);
        if (ke1 instanceof Error) throw ke1;

        const { ke2Serialized, sessionId } = await postLoginInit(ke1.serialize());
        const ke2 = L.KE2.deserialize(cfg, ke2Serialized);

        const finish = await client.authFinish(ke2, serverIdentity);
        if (finish instanceof Error) {
            // Wrong password — client-side rejection, server never even
            // sees a KE3 for this attempt. The server-side rate limiter
            // still counted the login-init call, which is exactly the
            // point: a guess costs quota whether or not it was right.
            throw new Error('wrong_password');
        }

        const serverOk = await postLoginFinish(finish.ke3.serialize(), sessionId);
        if (!serverOk) throw new Error('server_rejected');

        return { exportKeyB64: bufToBase64(new Uint8Array(finish.export_key).buffer) };
    }

    return { register, login };
}

// ─── Streaming per-chunk AES-GCM (large-file chunked upload) ─────────────
//
// AES-GCM authenticates a whole message with one tag — you can't just
// slice ciphertext into pieces afterward. This encrypts/decrypts each
// chunk as its OWN independent AES-GCM operation, sharing one raw key
// (OPAQUE's export_key, imported directly — it's already high-entropy,
// no PBKDF2 needed) but with a UNIQUE IV per chunk (an 8-byte random
// base nonce + a 4-byte big-endian chunk index) so nonce reuse — which
// is catastrophic for GCM — is structurally impossible. Chunk index and
// total count are folded in as Additional Authenticated Data, so
// reordering, dropping, or truncating chunks fails the auth tag instead
// of silently producing corrupted-looking plaintext.
function buildChunkedCryptoHelpers() {
    const enc = new TextEncoder();

    async function importRawAesKey(exportKeyB64) {
        const keyBytes = base64ToBuf(exportKeyB64);
        return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    }

    function randomBaseNonce() {
        return crypto.getRandomValues(new Uint8Array(8));
    }

    function chunkIv(baseNonceBytes, index) {
        const iv = new Uint8Array(12);
        iv.set(baseNonceBytes, 0);
        new DataView(iv.buffer).setUint32(8, index, false); // big-endian
        return iv;
    }

    function chunkAad(fileId, index, totalChunks) {
        const fileIdBytes = enc.encode(fileId);
        const out = new Uint8Array(fileIdBytes.length + 8);
        out.set(fileIdBytes, 0);
        new DataView(out.buffer, fileIdBytes.length).setUint32(0, index, false);
        new DataView(out.buffer, fileIdBytes.length).setUint32(4, totalChunks, false);
        return out;
    }

    async function encryptChunk(cryptoKey, fileId, index, totalChunks, baseNonceBytes, plainBuf) {
        const iv = chunkIv(baseNonceBytes, index);
        const aad = chunkAad(fileId, index, totalChunks);
        return crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, cryptoKey, plainBuf);
    }

    async function decryptChunk(cryptoKey, fileId, index, totalChunks, baseNonceBytes, cipherBuf) {
        const iv = chunkIv(baseNonceBytes, index);
        const aad = chunkAad(fileId, index, totalChunks);
        // Throws on any tampering (reorder/drop/truncate/corruption) — the
        // AAD binds this exact file/index/total, and GCM's tag covers it.
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, cryptoKey, cipherBuf);
    }

    return { importRawAesKey, randomBaseNonce, encryptChunk, decryptChunk };
}


    global.TVFSCrypto = {
        VERIFY_PLAINTEXT,
        randomPassword,
        randomPassphrase,
        estimateEntropyBits,
        formatCrackTime,
        estimateTvfsLoginEntropyBits,
        formatTvfsLoginCrackTime,
        encryptToContainer,
        decryptContainer,
        buildVerifyContainer,
        verifyPassword,
        encryptFilename,
        decryptFilename,
        bufToBase64,
        base64ToBuf,
        bufToHex,
        opaque: buildOpaqueHelpers(),
        chunked: buildChunkedCryptoHelpers(),
    };

})(window);