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

    function formatCrackTime(entropyBits, guessesPerSecond = 1e10) {
        // 1e10/s ≈ a realistic high-end offline GPU rate against PBKDF2-600k-SHA256.
        const totalGuesses = Math.pow(2, entropyBits);
        const seconds = totalGuesses / guessesPerSecond / 2; // average case = half the space
        const units = [
            ['years', 31536000], ['days', 86400], ['hours', 3600], ['minutes', 60], ['seconds', 1]
        ];
        if (seconds < 1) return '< 1 second';
        for (const [name, unitSec] of units) {
            const val = seconds / unitSec;
            if (val >= 1) {
                if (name === 'years' && val > 1e6) return `${val.toExponential(1)} years`;
                return `${Math.round(val).toLocaleString()} ${name}`;
            }
        }
        return '< 1 second';
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

    global.TVFSCrypto = {
        VERIFY_PLAINTEXT,
        randomPassword,
        randomPassphrase,
        estimateEntropyBits,
        formatCrackTime,
        encryptToContainer,
        decryptContainer,
        buildVerifyContainer,
        verifyPassword,
        encryptFilename,
        decryptFilename,
        bufToBase64,
        base64ToBuf,
        bufToHex,
    };

})(window);
