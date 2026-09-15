'use strict';
/**
 * encryptedShare.js — TVFS Encrypted Sharing backend router.
 *
 * Zero-knowledge core: the server stores only ciphertext (as an opaque
 * blob containing salt+iv+ciphertext, see encryptedCrypto.js's container
 * format) plus a small verify-blob (same key, known plaintext). It never
 * receives or derives a password/key.
 *
 * Two INDEPENDENT access-control layers sit on top of that zero-knowledge
 * core, matching the design notes:
 *
 *   1. Password (client-side only) — the verify-file trick. The server
 *      cannot check this; it just hands out bytes.
 *   2. "TVFS Users Encrypted Files Access Only" (server-side, per file,
 *      default ON) — before the server will even hand out the verify-blob
 *      or the ciphertext, the requester must either:
 *        a) present valid TVFS credentials (findUser), or
 *        b) go through the Pairing flow, where the file's owner
 *           interactively approves the specific viewer session.
 *
 * This is deliberately NOT a PAKE / zero-knowledge password proof — that
 * was evaluated in the design notes and explicitly deferred. Layer 2 above
 * only protects against people outside the TVFS user network; a legitimate
 * TVFS user (or an approved paired viewer) who guesses/brute-forces the
 * actual encryption password offline is a risk that only strong
 * passwords/passphrases + PBKDF2 iterations mitigate, not this layer.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const { findUser, sha256 } = require('./userIdentity'); // sanitizeUsername unused here
const requestLogger = require('./requestLogger');
const uploadRouter = require('./upload'); // for uploadRouter.authenticateRequest — see below
const opaqueServer = require('./opaqueServer');

const router = express.Router();

// ─── Directories ─────────────────────────────────────────────────────────

const FILES_WEB_DIR = process.env.CLEANUP_FILES_WEB_DIR || path.join(__dirname, '../files_web');
// Raw ciphertext + verify-blob storage lives OUTSIDE files_web on purpose.
// files_web is assumed to be served directly by a static webserver/reverse
// proxy (upload.html is), so anything under it is reachable by anyone who
// guesses the path, regardless of what checks this Express app performs.
// A fileId is public (it's in the shared link/landing page), so storing
// ciphertext under files_web would let someone bypass the TVFS-Users-Only/
// Pairing gate entirely by requesting the static path directly instead of
// going through /api/encrypted/:id/file. Keeping it in files_backend means
// the ONLY way to reach these bytes is through this router's own checks.
const PROTECTED_STORAGE_DIR = process.env.PROTECTED_STORAGE_DIR || path.join(__dirname, 'protected_storage');
const ENC_DIR = path.join(PROTECTED_STORAGE_DIR, 'encrypted');
const ENC_TMP_DIR = path.join(ENC_DIR, 'tmp');
// Generated landing pages DO belong in files_web — they're meant to be
// publicly reachable static HTML; the actual gate happens in the API calls
// that page makes, not in whether the HTML shell itself is reachable.
const ENC_PAGES_DIR = path.join(FILES_WEB_DIR, 'files', 'encrypted', 'pages');
if (!fs.existsSync(ENC_DIR)) fs.mkdirSync(ENC_DIR, { recursive: true });
if (!fs.existsSync(ENC_TMP_DIR)) fs.mkdirSync(ENC_TMP_DIR, { recursive: true });
if (!fs.existsSync(ENC_PAGES_DIR)) fs.mkdirSync(ENC_PAGES_DIR, { recursive: true });

const REGISTRY_PATH = path.join(FILES_WEB_DIR, 'encrypted_registry.json');
const REGISTRY_TMP = REGISTRY_PATH + '.tmp';

// ─── The public known-plaintext, served verbatim ────────────────────────
// MUST match VERIFY_PLAINTEXT in encryptedCrypto.js exactly.

const VERIFY_PLAINTEXT =
    'https://files.tomasekvalla.cz - thanks for using our services - https://youtube.com/watch?v=dQw4w9WgXcQ';

router.get('/dont-trust-verify.txt', (req, res) => {
    res.type('text/plain').send(VERIFY_PLAINTEXT);
});

// ─── Per-file landing page generator ─────────────────────────────────────
// Same pattern as audioPlayer.js / the text & md readers in upload.js: a
// real static .html file is generated and written to disk per upload, so
// it's servable by whatever already serves upload.html/privacy.html — no
// dynamic Express route or query-string parsing needed.
const LANDING_TEMPLATE = "<!DOCTYPE html>\n<html lang=\"cs\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>TVFS \u2014 Encrypted File</title>\n<style>\n    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@600;700&family=JetBrains+Mono:wght@500;600&display=swap');\n    :root{\n        --bg:#03070a; --card:rgba(28,32,42,0.38); --border:rgba(255,255,255,0.14); --text:#ffffff; --muted:#9aa6bd;\n        --accent:#b083ff; --danger:#ff6b6b; --ok:#2fffc4;\n    }\n    *{box-sizing:border-box;}\n    body{\n        margin:0; min-height:100vh; background-color:var(--bg);\n        background-image: radial-gradient(ellipse 80% 60% at 20% -10%, rgba(132, 85, 255, 0.18), transparent), radial-gradient(ellipse 70% 50% at 100% 110%, rgba(0, 230, 189, 0.12), transparent);\n        color:var(--text);\n        font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;\n        display:flex; align-items:center; justify-content:center; padding:24px;\n    }\n    h1{ font-family:'Space Grotesk','Inter',sans-serif; }\n    .code, .pair-code{ font-family:'JetBrains Mono',monospace; }\n    .shell{\n        width:100%; max-width:440px; background:var(--card); border:1px solid var(--border);\n        backdrop-filter:blur(20px) saturate(150%); -webkit-backdrop-filter:blur(20px) saturate(150%);\n        box-shadow:0 30px 70px -15px rgba(0,0,0,0.75);\n        border-radius:16px; padding:32px 28px; text-align:center;\n    }\n    .lock{ font-size:2.4rem; margin-bottom:8px; }\n    h1{ font-size:1.15rem; margin:0 0 4px; }\n    .sub{ color:var(--muted); font-size:0.85rem; margin-bottom:24px; }\n    .field{ text-align:left; margin-bottom:14px; }\n    label{ display:block; font-size:0.8rem; color:var(--muted); margin-bottom:6px; }\n    input{\n        width:100%; padding:11px 12px; border-radius:8px; border:1px solid var(--border);\n        background:#0d0d0d; color:var(--text); font-size:0.95rem;\n    }\n    input:focus{ outline:none; border-color:var(--accent); }\n    button{\n        width:100%; padding:12px; border-radius:8px; border:none; background:var(--accent);\n        color:#04101c; font-weight:600; font-size:0.95rem; cursor:pointer; margin-top:6px;\n    }\n    button:disabled{ opacity:0.5; cursor:default; }\n    button.secondary{ background:transparent; border:1px solid var(--border); color:var(--text); }\n    .msg{ font-size:0.85rem; margin-top:12px; min-height:1.2em; }\n    .msg.error{ color:var(--danger); }\n    .msg.ok{ color:var(--ok); }\n    .divider{ display:flex; align-items:center; gap:10px; margin:18px 0; color:var(--muted); font-size:0.75rem; }\n    .divider::before, .divider::after{ content:''; flex:1; height:1px; background:var(--border); }\n    .pair-code{ font-size:2rem; letter-spacing:0.3em; font-weight:700; margin:14px 0; color:var(--accent); }\n    .hidden{ display:none !important; }\n    .content{ text-align:left; }\n    .content video, .content img{ width:100%; border-radius:10px; display:block; margin-bottom:12px; }\n    .content audio{ width:100%; }\n    audio, video { outline: none; }\n    .text-view{\n        max-height:60vh; overflow:auto; white-space:pre-wrap; word-break:break-word;\n        background:#0d0d0d; border:1px solid var(--border); border-radius:8px; padding:14px; font-size:0.9rem;\n    }\n    .filename{ font-size:0.95rem; margin-bottom:14px; word-break:break-all; }\n    .warn{\n        font-size:0.78rem; color:var(--muted); background:#0d0d0d; border:1px solid var(--border);\n        border-radius:8px; padding:10px 12px; margin-top:14px; text-align:left;\n    }\n    a.dl-btn{\n        display:block; text-align:center; padding:12px; border-radius:8px; background:var(--accent);\n        color:#04101c; font-weight:600; text-decoration:none;\n    }\n    .spinner{\n        width:22px; height:22px; border:3px solid var(--border); border-top-color:var(--accent);\n        border-radius:50%; margin:16px auto; animation:spin 0.8s linear infinite;\n    }\n    @keyframes spin{ to{ transform:rotate(360deg); } }\n</style>\n</head>\n<body>\n<div class=\"shell\" id=\"shell\">\n    <div class=\"lock\">\ud83d\udd12</div>\n    <h1 id=\"titleText\">Encrypted File</h1>\n    <div class=\"sub\" id=\"subText\">Checking link\u2026</div>\n\n    <!-- Step 1: TVFS login gate (only shown if tvfsUsersOnly) -->\n    <div id=\"gateStep\" class=\"hidden\">\n        <div class=\"field\">\n            <label>TVFS username</label>\n            <input type=\"text\" id=\"gateUsername\" autocomplete=\"username\">\n        </div>\n        <div class=\"field\">\n            <label>TVFS password</label>\n            <input type=\"password\" id=\"gatePassword\" autocomplete=\"current-password\">\n        </div>\n        <button id=\"gateLoginBtn\">Log in</button>\n\n        <div class=\"divider hidden\" id=\"pairDivider\">or</div>\n        <button class=\"secondary hidden\" id=\"startPairBtn\">Request pairing from owner</button>\n        <div class=\"msg\" id=\"gateMsg\"></div>\n    </div>\n\n    <!-- Pairing wait state -->\n    <div id=\"pairStep\" class=\"hidden\">\n        <div class=\"field\">\n            <label>Your TVFS username</label>\n            <input type=\"text\" id=\"pairUsername\" autocomplete=\"username\">\n        </div>\n        <div class=\"field\">\n            <label>Your TVFS password</label>\n            <input type=\"password\" id=\"pairPassword\" autocomplete=\"current-password\">\n        </div>\n        <button id=\"pairRequestBtn\">Send pairing request</button>\n        <div id=\"pairWaiting\" class=\"hidden\">\n            <div class=\"sub\">Show this code to the file owner:</div>\n            <div class=\"pair-code\" id=\"pairCode\">------</div>\n            <div class=\"spinner\"></div>\n            <div class=\"sub\">Waiting for approval\u2026</div>\n        </div>\n        <div class=\"msg\" id=\"pairMsg\"></div>\n    </div>\n\n    <!-- Step 2: password / verify -->\n    <div id=\"passwordStep\" class=\"hidden\">\n        <div class=\"field\">\n            <label>File password</label>\n            <input type=\"password\" id=\"filePassword\" autocomplete=\"off\">\n        </div>\n        <button id=\"verifyBtn\">Verify &amp; Unlock</button>\n        <div class=\"msg\" id=\"verifyMsg\"></div>\n    </div>\n\n    <!-- Step 3: decrypted content -->\n    <div id=\"contentStep\" class=\"hidden content\"></div>\n</div>\n\n<script src=\"/opaque-client-bundle.js\"></script>\n<script src=\"/encryptedCrypto.js\"></script>\n<script>\n(function(){\n    const API = '/api/encrypted';\n    const fileId = __FILE_ID_JSON__;\n\n    const el = id => document.getElementById(id);\n    const show = id => el(id).classList.remove('hidden');\n    const hide = id => el(id).classList.add('hidden');\n    const setMsg = (id, text, kind) => { const n = el(id); n.textContent = text || ''; n.className = 'msg' + (kind ? ' ' + kind : ''); };\n\n    let meta = null;\n    let accessToken = null; // only needed/used when meta.tvfsUsersOnly\n    let unlockToken = null; // from a completed OPAQUE login \u2014 required by /file regardless of tvfsUsersOnly\n    let pairPollTimer = null;\n\n    async function boot() {\n        try {\n            const res = await fetch(`${API}/${fileId}/meta`);\n            if (!res.ok) throw new Error((await res.json()).error || 'Not found');\n            meta = await res.json();\n        } catch (e) {\n            el('titleText').textContent = 'Link unavailable';\n            el('subText').textContent = e.message || 'This file does not exist or has expired.';\n            return;\n        }\n\n        if (meta.isPrivate) {\n            el('subText').textContent = 'Private file \u2014 nothing is revealed until you unlock it.';\n        } else {\n            el('subText').textContent = meta.displayName || `Encrypted ${meta.mimeCategory || 'file'}`;\n        }\n\n        if (meta.singleUse && meta.alreadyDownloaded) {\n            el('titleText').textContent = 'Already used';\n            el('subText').textContent = 'This was a single-use link and has already been downloaded once.';\n            return;\n        }\n\n        if (meta.tvfsUsersOnly) {\n            if (meta.allowPairing) {\n                show('pairDivider');\n                show('startPairBtn');\n            }\n            // Already logged in on this browser? Try silently before ever\n            // showing the gate UI \u2014 same tvfs_token cookie upload.html uses.\n            try {\n                const res = await fetch(`${API}/${fileId}/login`, {\n                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})\n                });\n                if (res.ok) {\n                    const data = await res.json();\n                    accessToken = data.accessToken;\n                    show('passwordStep');\n                } else {\n                    show('gateStep');\n                }\n            } catch (e) {\n                show('gateStep');\n            }\n        } else {\n            show('passwordStep');\n        }\n    }\n\n    // \u2500\u2500 TVFS login gate \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    el('gateLoginBtn').onclick = async () => {\n        setMsg('gateMsg', '');\n        const username = el('gateUsername').value.trim();\n        const password = el('gatePassword').value;\n        if (!username || !password) return setMsg('gateMsg', 'Enter both fields', 'error');\n        el('gateLoginBtn').disabled = true;\n        try {\n            const res = await fetch(`${API}/${fileId}/login`, {\n                method: 'POST', headers: { 'Content-Type': 'application/json' },\n                body: JSON.stringify({ username, password })\n            });\n            const data = await res.json();\n            if (!res.ok) return setMsg('gateMsg', data.error || 'Login failed', 'error');\n            accessToken = data.accessToken;\n            hide('gateStep');\n            show('passwordStep');\n        } catch (e) {\n            setMsg('gateMsg', 'Network error', 'error');\n        } finally {\n            el('gateLoginBtn').disabled = false;\n        }\n    };\n\n    // \u2500\u2500 Pairing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    el('startPairBtn').onclick = () => { hide('gateStep'); show('pairStep'); };\n\n    el('pairRequestBtn').onclick = async () => {\n        setMsg('pairMsg', '');\n        const viewerUsername = el('pairUsername').value.trim();\n        const viewerPassword = el('pairPassword').value;\n        if (!viewerUsername || !viewerPassword) return setMsg('pairMsg', 'Enter both fields', 'error');\n        el('pairRequestBtn').disabled = true;\n        try {\n            const res = await fetch(`${API}/${fileId}/pair/request`, {\n                method: 'POST', headers: { 'Content-Type': 'application/json' },\n                body: JSON.stringify({ viewerUsername, viewerPassword })\n            });\n            const data = await res.json();\n            if (!res.ok) { setMsg('pairMsg', data.error || 'Pairing request failed', 'error'); el('pairRequestBtn').disabled = false; return; }\n            el('pairCode').textContent = data.code;\n            show('pairWaiting');\n            pollPairing(data.requestId, data.expiresAt);\n        } catch (e) {\n            setMsg('pairMsg', 'Network error', 'error');\n            el('pairRequestBtn').disabled = false;\n        }\n    };\n\n    function pollPairing(requestId, expiresAt) {\n        pairPollTimer = setInterval(async () => {\n            if (Date.now() > expiresAt) {\n                clearInterval(pairPollTimer);\n                setMsg('pairMsg', 'Pairing request expired \u2014 try again', 'error');\n                hide('pairWaiting');\n                el('pairRequestBtn').disabled = false;\n                return;\n            }\n            try {\n                const res = await fetch(`${API}/${fileId}/pair/status/${requestId}`);\n                const data = await res.json();\n                if (data.status === 'approved') {\n                    clearInterval(pairPollTimer);\n                    accessToken = data.accessToken;\n                    hide('pairStep');\n                    show('passwordStep');\n                } else if (data.status === 'denied') {\n                    clearInterval(pairPollTimer);\n                    setMsg('pairMsg', 'Owner denied this request', 'error');\n                    hide('pairWaiting');\n                    el('pairRequestBtn').disabled = false;\n                }\n            } catch (e) { /* keep polling */ }\n        }, 2500);\n    }\n\n    // \u2500\u2500 Password verify + decrypt + render \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    el('verifyBtn').onclick = async () => {\n        setMsg('verifyMsg', '');\n        const password = el('filePassword').value;\n        if (!password) return setMsg('verifyMsg', 'Enter the password', 'error');\n        el('verifyBtn').disabled = true;\n        setMsg('verifyMsg', 'Verifying\u2026');\n\n        try {\n            const q = meta.tvfsUsersOnly ? `?token=${encodeURIComponent(accessToken)}` : '';\n\n            let opaqueResult;\n            try {\n                opaqueResult = await TVFSCrypto.opaque.login(\n                    password, 'files.tomasekvalla.cz',\n                    async (ke1Serialized) => {\n                        const res = await fetch(`${API}/${fileId}/opaque/login-init`, {\n                            method: 'POST', headers: { 'Content-Type': 'application/json' },\n                            body: JSON.stringify({ ke1: ke1Serialized })\n                        });\n                        const d = await res.json();\n                        if (!res.ok) throw new Error(d.error || 'Login failed');\n                        return { ke2Serialized: d.ke2, sessionId: d.sessionId };\n                    },\n                    async (ke3Serialized, sessionId) => {\n                        const res = await fetch(`${API}/${fileId}/opaque/login-finish`, {\n                            method: 'POST', headers: { 'Content-Type': 'application/json' },\n                            body: JSON.stringify({ ke3: ke3Serialized, sessionId })\n                        });\n                        const d = await res.json();\n                        if (!res.ok) return null;\n                        unlockToken = d.unlockToken;\n                        return d.unlockToken;\n                    }\n                );\n            } catch (e) {\n                setMsg('verifyMsg', 'Wrong password', 'error');\n                el('verifyBtn').disabled = false;\n                return;\n            }\n\n            setMsg('verifyMsg', 'Password correct \u2014 downloading\u2026', 'ok');\n            const exportKeyB64 = opaqueResult.exportKeyB64;\n\n            let displayName = meta.displayName;\n            if (meta.isPrivate && meta.encryptedName) {\n                try { displayName = await TVFSCrypto.decryptFilename(exportKeyB64, meta.encryptedName); }\n                catch (e) { displayName = '(unknown name)'; }\n            }\n\n            const fileQ = meta.tvfsUsersOnly ? `&token=${encodeURIComponent(accessToken)}` : '';\n\n            if (meta.chunked) {\n                const cmRes = await fetch(`${API}/${fileId}/chunk-meta`);\n                if (!cmRes.ok) throw new Error((await cmRes.json()).error || 'Could not fetch chunk info');\n                const chunkMeta = await cmRes.json();\n\n                const aesKey = await TVFSCrypto.chunked.importRawAesKey(exportKeyB64);\n                const baseNonce = new Uint8Array(TVFSCrypto.base64ToBuf(chunkMeta.baseNonceB64));\n\n                const plainChunks = [];\n                for (let i = 0; i < chunkMeta.chunkCount; i++) {\n                    setMsg('verifyMsg', `Downloading chunk ${i + 1}/${chunkMeta.chunkCount}\u2026`, 'ok');\n                    const cRes = await fetch(`${API}/${fileId}/chunk/${i}?unlock=${encodeURIComponent(unlockToken)}${fileQ}`);\n                    if (!cRes.ok) throw new Error((await cRes.json()).error || `Chunk ${i} download failed`);\n                    const cipherBuf = await cRes.arrayBuffer();\n                    // Throws on any tampering (wrong order/file/truncation) \u2014\n                    // see the AAD design note in encryptedCrypto.js.\n                    const plainBuf = await TVFSCrypto.chunked.decryptChunk(aesKey, fileId, i, chunkMeta.chunkCount, baseNonce, cipherBuf);\n                    plainChunks.push(plainBuf);\n                }\n\n                renderContent(plainChunks, displayName, meta.mimeCategory);\n            } else {\n                const fileRes = await fetch(`${API}/${fileId}/file?unlock=${encodeURIComponent(unlockToken)}${fileQ}`);\n                if (!fileRes.ok) throw new Error((await fileRes.json()).error || 'Download failed');\n                const containerBuf = await fileRes.arrayBuffer();\n                const plainBuf = await TVFSCrypto.decryptContainer(exportKeyB64, containerBuf);\n                renderContent(plainBuf, displayName, meta.mimeCategory);\n            }\n\n            hide('passwordStep');\n            show('contentStep');\n        } catch (e) {\n            setMsg('verifyMsg', e.message || 'Something went wrong', 'error');\n            el('verifyBtn').disabled = false;\n        }\n    };\n\n    function guessCategory(bytes, name) {\n        if (meta.mimeCategory) return meta.mimeCategory;\n        const ext = (name || '').split('.').pop().toLowerCase();\n        if (['mp3','flac','wav','ogg','m4a','opus'].includes(ext)) return 'audio';\n        if (['mp4','webm','mov','mkv'].includes(ext)) return 'video';\n        if (['png','jpg','jpeg','gif','webp','avif'].includes(ext)) return 'image';\n        if (['txt','md','json','csv','log'].includes(ext)) return 'text';\n        return 'file';\n    }\n\n    function renderContent(plainBufOrChunks, displayName, category) {\n        const container = el('contentStep');\n        container.innerHTML = '';\n\n        const nameEl = document.createElement('div');\n        nameEl.className = 'filename';\n        nameEl.textContent = displayName || '(unnamed file)';\n        container.appendChild(nameEl);\n\n        const parts = Array.isArray(plainBufOrChunks) ? plainBufOrChunks : [plainBufOrChunks];\n        const cat = guessCategory(new Uint8Array(parts[0]), displayName);\n        const blob = new Blob(parts);\n        const url = URL.createObjectURL(blob);\n\n        if (cat === 'audio') {\n            const a = document.createElement('audio'); a.controls = true; a.src = url; container.appendChild(a);\n        } else if (cat === 'video') {\n            const v = document.createElement('video'); v.controls = true; v.src = url; container.appendChild(v);\n        } else if (cat === 'image') {\n            const img = document.createElement('img'); img.src = url; container.appendChild(img);\n        } else if (cat === 'text') {\n            const pre = document.createElement('div'); pre.className = 'text-view';\n            new Response(blob).text().then(t => { pre.textContent = t; });\n            container.appendChild(pre);\n        }\n\n        const dl = document.createElement('a');\n        dl.className = 'dl-btn';\n        dl.href = url;\n        dl.download = displayName || 'file';\n        dl.textContent = cat === 'file' ? 'Download' : 'Download original';\n        dl.style.marginTop = '10px';\n        container.appendChild(dl);\n\n        if (meta.singleUse) {\n            const warn = document.createElement('div');\n            warn.className = 'warn';\n            warn.textContent = '\u26a0\ufe0f This was a single-use link. The file has now been permanently deleted from the server \u2014 save it now if you need it.';\n            container.appendChild(warn);\n        }\n    }\n\n    boot();\n})();\n</script>\n</body>\n</html>\n";

function buildLandingHtml(fileId) {
    return LANDING_TEMPLATE.replace('__FILE_ID_JSON__', JSON.stringify(fileId));
}

// ─── Vault landing page generator (multi-file Encrypted Sharing) ─────────
const VAULT_LANDING_TEMPLATE = "<!DOCTYPE html>\n<html lang=\"cs\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>TVFS \u2014 Encrypted Vault</title>\n<style>\n    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@600;700&family=JetBrains+Mono:wght@500;600&display=swap');\n    :root{\n        --bg:#03070a; --card:rgba(28,32,42,0.38); --border:rgba(255,255,255,0.14); --text:#ffffff; --muted:#9aa6bd;\n        --accent:#b083ff; --danger:#ff6b6b; --ok:#2fffc4;\n    }\n    *{box-sizing:border-box;}\n    body{\n        margin:0; min-height:100vh; background-color:var(--bg);\n        background-image: radial-gradient(ellipse 80% 60% at 20% -10%, rgba(132, 85, 255, 0.18), transparent), radial-gradient(ellipse 70% 50% at 100% 110%, rgba(0, 230, 189, 0.12), transparent);\n        color:var(--text);\n        font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;\n        display:flex; align-items:flex-start; justify-content:center; padding:40px 24px;\n    }\n    h1{ font-family:'Space Grotesk','Inter',sans-serif; }\n    .shell{ width:100%; max-width:520px; }\n    .card{\n        background:var(--card); border:1px solid var(--border); border-radius:16px;\n        backdrop-filter:blur(20px) saturate(150%); -webkit-backdrop-filter:blur(20px) saturate(150%);\n        box-shadow:0 30px 70px -15px rgba(0,0,0,0.75);\n        padding:28px 26px; margin-bottom:16px;\n    }\n    .lock{ font-size:2rem; text-align:center; margin-bottom:8px; }\n    h1{ font-size:1.1rem; margin:0 0 4px; text-align:center; }\n    .sub{ color:var(--muted); font-size:0.85rem; margin-bottom:20px; text-align:center; }\n    .field{ text-align:left; margin-bottom:14px; }\n    label{ display:block; font-size:0.8rem; color:var(--muted); margin-bottom:6px; }\n    input{ width:100%; padding:11px 12px; border-radius:8px; border:1px solid var(--border); background:#0d0d0d; color:var(--text); font-size:0.95rem; }\n    input:focus{ outline:none; border-color:var(--accent); }\n    button{\n        width:100%; padding:12px; border-radius:8px; border:none; background:var(--accent);\n        color:#04101c; font-weight:600; font-size:0.95rem; cursor:pointer; margin-top:6px;\n    }\n    button:disabled{ opacity:0.5; cursor:default; }\n    button.secondary{ background:transparent; border:1px solid var(--border); color:var(--text); }\n    .msg{ font-size:0.85rem; margin-top:12px; min-height:1.2em; }\n    .msg.error{ color:var(--danger); }\n    .msg.ok{ color:var(--ok); }\n    .hidden{ display:none !important; }\n    .file-row{\n        display:flex; align-items:center; gap:12px; padding:12px; border:1px solid var(--border);\n        border-radius:10px; margin-bottom:8px; background:#0d0d0d;\n    }\n    .file-icon{ font-size:1.4rem; }\n    .file-name{ flex:1; font-size:0.9rem; word-break:break-all; }\n    .file-actions{ display:flex; gap:6px; }\n    .file-actions button{ width:auto; padding:8px 12px; font-size:0.8rem; margin:0; }\n    .warn{\n        font-size:0.78rem; color:var(--muted); background:#0d0d0d; border:1px solid var(--border);\n        border-radius:8px; padding:10px 12px; margin-top:14px; text-align:left;\n    }\n    .preview{ max-width:100%; border-radius:8px; margin-top:10px; display:none; }\n    .preview.shown{ display:block; }\n</style>\n</head>\n<body>\n<div class=\"shell\">\n<div class=\"card\" id=\"shell\">\n    <div class=\"lock\">\ud83d\udd12</div>\n    <h1 id=\"titleText\">Encrypted Vault</h1>\n    <div class=\"sub\" id=\"subText\">Checking link\u2026</div>\n\n    <div id=\"gateStep\" class=\"hidden\">\n        <div class=\"field\"><label>TVFS username</label><input type=\"text\" id=\"gateUsername\" autocomplete=\"username\"></div>\n        <div class=\"field\"><label>TVFS password</label><input type=\"password\" id=\"gatePassword\" autocomplete=\"current-password\"></div>\n        <button id=\"gateLoginBtn\">Log in</button>\n        <div class=\"msg\" id=\"gateMsg\"></div>\n    </div>\n\n    <div id=\"passwordStep\" class=\"hidden\">\n        <div class=\"field\"><label>Vault password</label><input type=\"password\" id=\"filePassword\" autocomplete=\"off\"></div>\n        <button id=\"verifyBtn\">Verify &amp; Unlock</button>\n        <div class=\"msg\" id=\"verifyMsg\"></div>\n    </div>\n</div>\n\n<div id=\"fileListCard\" class=\"card hidden\">\n    <div class=\"sub\" id=\"fileListSub\" style=\"margin-bottom:14px;\"></div>\n    <div id=\"fileList\"></div>\n    <button id=\"downloadAllBtn\" style=\"margin-top:10px;\">Download all</button>\n    <div class=\"warn\" id=\"singleUseWarn\" style=\"display:none;\">\u26a0\ufe0f This was a single-use link \u2014 it's now unlocked for this visit only. Reloading or revisiting will no longer work, so grab everything you need now.</div>\n</div>\n</div>\n\n<script src=\"/opaque-client-bundle.js\"></script>\n<script src=\"/encryptedCrypto.js\"></script>\n<script>\n(function(){\n    const API = '/api/encrypted/vault';\n    const vaultId = __VAULT_ID_JSON__;\n\n    const el = id => document.getElementById(id);\n    const show = id => el(id).classList.remove('hidden');\n    const hide = id => el(id).classList.add('hidden');\n    const setMsg = (id, text, kind) => { const n = el(id); n.textContent = text || ''; n.className = 'msg' + (kind ? ' ' + kind : ''); };\n\n    let meta = null;\n    let accessToken = null;\n    let password = null;\n    let keychain = null; // [{i, name, cat, key}]\n\n    async function boot() {\n        try {\n            const res = await fetch(`${API}/${vaultId}/meta`);\n            if (!res.ok) throw new Error((await res.json()).error || 'Not found');\n            meta = await res.json();\n        } catch (e) {\n            el('titleText').textContent = 'Link unavailable';\n            el('subText').textContent = e.message || 'This vault does not exist or has expired.';\n            return;\n        }\n\n        el('subText').textContent = `${meta.fileCount} encrypted file${meta.fileCount === 1 ? '' : 's'} \u2014 nothing is revealed until you unlock it.`;\n\n        if (meta.singleUse && meta.consumed) {\n            el('titleText').textContent = 'Already used';\n            el('subText').textContent = 'This was a single-use vault and has already been unlocked once.';\n            return;\n        }\n\n        if (meta.tvfsUsersOnly) {\n            try {\n                const res = await fetch(`${API}/${vaultId}/login`, {\n                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})\n                });\n                if (res.ok) {\n                    accessToken = (await res.json()).accessToken;\n                    show('passwordStep');\n                } else {\n                    show('gateStep');\n                }\n            } catch (e) { show('gateStep'); }\n        } else {\n            show('passwordStep');\n        }\n    }\n\n    el('gateLoginBtn').onclick = async () => {\n        setMsg('gateMsg', '');\n        const username = el('gateUsername').value.trim();\n        const pw = el('gatePassword').value;\n        if (!username || !pw) return setMsg('gateMsg', 'Enter both fields', 'error');\n        el('gateLoginBtn').disabled = true;\n        try {\n            const res = await fetch(`${API}/${vaultId}/login`, {\n                method: 'POST', headers: { 'Content-Type': 'application/json' },\n                body: JSON.stringify({ username, password: pw })\n            });\n            const data = await res.json();\n            if (!res.ok) return setMsg('gateMsg', data.error || 'Login failed', 'error');\n            accessToken = data.accessToken;\n            hide('gateStep');\n            show('passwordStep');\n        } catch (e) {\n            setMsg('gateMsg', 'Network error', 'error');\n        } finally {\n            el('gateLoginBtn').disabled = false;\n        }\n    };\n\n    el('verifyBtn').onclick = async () => {\n        setMsg('verifyMsg', '');\n        const pw = el('filePassword').value;\n        if (!pw) return setMsg('verifyMsg', 'Enter the password', 'error');\n        el('verifyBtn').disabled = true;\n        setMsg('verifyMsg', 'Verifying\u2026');\n\n        try {\n            const q = meta.tvfsUsersOnly ? `?token=${encodeURIComponent(accessToken)}` : '';\n            let unlockToken;\n\n            let opaqueResult;\n            try {\n                opaqueResult = await TVFSCrypto.opaque.login(\n                    pw, 'files.tomasekvalla.cz',\n                    async (ke1Serialized) => {\n                        const res = await fetch(`${API}/vault/${vaultId}/opaque/login-init`, {\n                            method: 'POST', headers: { 'Content-Type': 'application/json' },\n                            body: JSON.stringify({ ke1: ke1Serialized })\n                        });\n                        const d = await res.json();\n                        if (!res.ok) throw new Error(d.error || 'Login failed');\n                        return { ke2Serialized: d.ke2, sessionId: d.sessionId };\n                    },\n                    async (ke3Serialized, sessionId) => {\n                        const res = await fetch(`${API}/vault/${vaultId}/opaque/login-finish`, {\n                            method: 'POST', headers: { 'Content-Type': 'application/json' },\n                            body: JSON.stringify({ ke3: ke3Serialized, sessionId })\n                        });\n                        const d = await res.json();\n                        if (!res.ok) return null;\n                        unlockToken = d.unlockToken;\n                        return d.unlockToken;\n                    }\n                );\n            } catch (e) {\n                setMsg('verifyMsg', 'Wrong password', 'error');\n                el('verifyBtn').disabled = false;\n                return;\n            }\n\n            setMsg('verifyMsg', 'Password correct \u2014 unlocking\u2026', 'ok');\n            password = opaqueResult.exportKeyB64; // used below as the \"password\" input to decryptContainer\n\n            // This fetch is the actual \"unlock\" for single-use vaults \u2014\n            // the server marks it consumed the moment this succeeds.\n            const kcRes = await fetch(`${API}/vault/${vaultId}/keychain?unlock=${encodeURIComponent(unlockToken)}${meta.tvfsUsersOnly ? `&token=${encodeURIComponent(accessToken)}` : ''}`);\n            if (!kcRes.ok) throw new Error((await kcRes.json()).error || 'Could not fetch keychain');\n            const kcBuf = await kcRes.arrayBuffer();\n            const kcPlain = await TVFSCrypto.decryptContainer(password, kcBuf);\n            keychain = JSON.parse(new TextDecoder().decode(kcPlain));\n            window.__vaultUnlockToken = unlockToken; // used by file downloads below\n\n            renderFileList();\n            hide('shell');\n            show('fileListCard');\n            if (meta.singleUse) el('singleUseWarn').style.display = 'block';\n        } catch (e) {\n            setMsg('verifyMsg', e.message || 'Something went wrong', 'error');\n            el('verifyBtn').disabled = false;\n        }\n    };\n\n    function categoryIcon(cat) {\n        if (cat === 'audio') return '\ud83c\udfb5';\n        if (cat === 'video') return '\ud83c\udfac';\n        if (cat === 'image') return '\ud83d\uddbc\ufe0f';\n        if (cat === 'text') return '\ud83d\udcc4';\n        return '\ud83d\udce6';\n    }\n\n    async function fetchAndDecryptFile(entry) {\n        const unlockToken = window.__vaultUnlockToken;\n        const params = new URLSearchParams({ unlock: unlockToken });\n        if (meta.tvfsUsersOnly) params.set('token', accessToken);\n        const res = await fetch(`${API}/${vaultId}/file/${entry.i}?${params.toString()}`);\n        if (!res.ok) throw new Error('Download failed for ' + entry.name);\n        const containerBuf = await res.arrayBuffer();\n        // Per-file keys are already high-entropy random strings \u2014 reused\n        // here as the \"password\" input to the same PBKDF2+AES-GCM\n        // primitives everything else uses. No new crypto code needed.\n        const plainBuf = await TVFSCrypto.decryptContainer(entry.key, containerBuf);\n        return new Blob([plainBuf]);\n    }\n\n    function triggerDownload(blob, name) {\n        const url = URL.createObjectURL(blob);\n        const a = document.createElement('a');\n        a.href = url; a.download = name || 'file';\n        document.body.appendChild(a);\n        a.click();\n        a.remove();\n        setTimeout(() => URL.revokeObjectURL(url), 30000);\n    }\n\n    function renderFileList() {\n        el('fileListSub').textContent = `${keychain.length} file${keychain.length === 1 ? '' : 's'} unlocked`;\n        const list = el('fileList');\n        list.innerHTML = '';\n        keychain.forEach((entry) => {\n            const row = document.createElement('div');\n            row.className = 'file-row';\n            row.innerHTML = `\n                <span class=\"file-icon\">${categoryIcon(entry.cat)}</span>\n                <span class=\"file-name\">${escapeHtml(entry.name || '(unnamed)')}</span>\n                <span class=\"file-actions\">\n                    <button data-act=\"view\">View</button>\n                    <button data-act=\"dl\">Download</button>\n                </span>\n            `;\n            const img = document.createElement('img');\n            img.className = 'preview';\n            row.appendChild(img);\n\n            row.querySelector('[data-act=\"view\"]').onclick = async (e) => {\n                e.target.disabled = true;\n                try {\n                    const blob = await fetchAndDecryptFile(entry);\n                    if (entry.cat === 'image') {\n                        img.src = URL.createObjectURL(blob);\n                        img.classList.add('shown');\n                    } else if (entry.cat === 'audio' || entry.cat === 'video') {\n                        const media = document.createElement(entry.cat);\n                        media.controls = true;\n                        media.src = URL.createObjectURL(blob);\n                        media.style.width = '100%';\n                        media.style.marginTop = '10px';\n                        row.appendChild(media);\n                    } else {\n                        triggerDownload(blob, entry.name);\n                    }\n                } catch (err) {\n                    alert(err.message);\n                } finally {\n                    e.target.disabled = false;\n                }\n            };\n            row.querySelector('[data-act=\"dl\"]').onclick = async (e) => {\n                e.target.disabled = true;\n                try {\n                    const blob = await fetchAndDecryptFile(entry);\n                    triggerDownload(blob, entry.name);\n                } catch (err) {\n                    alert(err.message);\n                } finally {\n                    e.target.disabled = false;\n                }\n            };\n            list.appendChild(row);\n        });\n    }\n\n    el('downloadAllBtn').onclick = async () => {\n        el('downloadAllBtn').disabled = true;\n        el('downloadAllBtn').textContent = 'Downloading\u2026';\n        for (let i = 0; i < keychain.length; i++) {\n            try {\n                const blob = await fetchAndDecryptFile(keychain[i]);\n                triggerDownload(blob, keychain[i].name);\n                await new Promise(r => setTimeout(r, 400)); // stagger \u2014 browsers can block rapid-fire downloads\n            } catch (e) { /* keep going with the rest */ }\n        }\n        el('downloadAllBtn').disabled = false;\n        el('downloadAllBtn').textContent = 'Download all';\n    };\n\n    function escapeHtml(s) {\n        return String(s).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\n    }\n\n    boot();\n})();\n</script>\n</body>\n</html>\n";

function buildVaultLandingHtml(vaultId, fileCount) {
    return VAULT_LANDING_TEMPLATE.replace('__VAULT_ID_JSON__', JSON.stringify(vaultId));
}

// ─── Registry (mirrors upload.js's atomic-write pattern) ────────────────

let registry = { files: {}, pairingRequests: {}, vaults: {} };
let saveTimer = null;

function loadRegistry() {
    try {
        registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
        if (!registry.files || typeof registry.files !== 'object') registry.files = {};
        if (!registry.pairingRequests || typeof registry.pairingRequests !== 'object') registry.pairingRequests = {};
        if (!registry.vaults || typeof registry.vaults !== 'object') registry.vaults = {};
        console.log(`🔐 Encrypted registry loaded: ${Object.keys(registry.files).length} files, ${Object.keys(registry.vaults).length} vaults`);
    } catch {
        registry = { files: {}, pairingRequests: {}, vaults: {} };
        console.log('🔐 Encrypted registry initialized (empty or not found)');
    }
}
loadRegistry();

function writeRegistryAtomic() {
    try {
        fs.writeFileSync(REGISTRY_TMP, JSON.stringify(registry, null, 2));
        fs.renameSync(REGISTRY_TMP, REGISTRY_PATH);
    } catch (err) {
        console.error('❌ [ENCRYPTED SHARE] Failed to save registry:', err.message);
    }
}

function saveRegistry() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeRegistryAtomic, 1500);
}

function saveRegistrySync() {
    clearTimeout(saveTimer);
    writeRegistryAtomic();
}

// ─── Rate limiting (verify attempts + pairing) ───────────────────────────
//
// 15 verify attempts per 15 minutes per IP, matching the design notes.
// This limits ONLINE credential-stuffing against the TVFS-login gate; it
// does nothing against offline brute-force of the encryption password
// itself once ciphertext is legitimately obtained — see module docblock.

const attemptWindows = new Map(); // key -> { count, resetAt }

function checkRateLimit(key, max, windowMs) {
    const now = Date.now();
    const entry = attemptWindows.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) {
        entry.count = 0;
        entry.resetAt = now + windowMs;
    }
    entry.count++;
    attemptWindows.set(key, entry);
    return entry.count <= max;
}

// ─── Global escalating rate limiters ───────────────────────────────────────
// Per-IP alone doesn't stop a distributed attack across many IPs — these
// ALSO track total volume across every IP combined. Once that global
// volume gets too high, every IP (not just the noisy ones) gets throttled
// to 1 request per window; if the elevated volume continues even under
// that throttle, the whole thing locks for an hour, full stop, until it
// naturally expires (no manual restart needed — see rateLimiter.js).
//
//   authLimiter   — TVFS login attempts. 30/window per IP normally; 100
//                   total (any IP) triggers throttle; 100 MORE while
//                   throttled (200 total) triggers the 1hr lock. A
//                   CORRECT login refunds its own attempt — only wrong
//                   guesses actually burn quota.
//   verifyLimiter — password-verification attempts (today: verify-blob
//                   fetches; once OPAQUE login-init/finish are wired in,
//                   this becomes THE actual per-guess limiter). Tighter:
//                   5/window per IP, 50 global to throttle, 30 more to lock.
const { createRateLimiter } = require('./rateLimiter');
const authLimiter = createRateLimiter({ perIpMax: 30, windowMs: 15 * 60 * 1000, globalMax: 100, globalLockMax: 100, lockDurationMs: 60 * 60 * 1000 });
const verifyLimiter = createRateLimiter({ perIpMax: 5, windowMs: 15 * 60 * 1000, globalMax: 50, globalLockMax: 30, lockDurationMs: 60 * 60 * 1000 });
setInterval(() => { authLimiter.sweep(); verifyLimiter.sweep(); }, 60000).unref();

// .unref() is critical here: this module is require()'d not just by the
// long-running index.js server (which stays alive via app.listen() anyway)
// but also by cleanup.js — a short-lived cron script that just wants to
// call sweepExpired() and exit. Without .unref(), this timer alone would
// keep that process running forever, since Node won't exit while any timer
// is still pending, causing cron to pile up a new hung process every run.
setInterval(() => {
    const now = Date.now();
    for (const [k, e] of attemptWindows) if (now > e.resetAt + 60000) attemptWindows.delete(k);
}, 60000).unref();

function clientIp(req) {
    return req.headers['cf-connecting-ip'] || req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

// ─── Short-lived access tokens ───────────────────────────────────────────
//
// Issued after EITHER a successful TVFS login check OR an approved pairing.
// These gate the verify-blob and ciphertext endpoints when tvfsUsersOnly
// is on. 5-minute TTL, single fileId scope, deleted on first successful
// ciphertext fetch if the file is singleUse.

const accessTokens = new Map(); // token -> { fileId, expiresAt }
const ACCESS_TOKEN_TTL_MS = 5 * 60 * 1000;

function issueAccessToken(fileId) {
    const token = crypto.randomBytes(24).toString('hex');
    accessTokens.set(token, { fileId, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS });
    return token;
}

function checkAccessToken(token, fileId) {
    const entry = accessTokens.get(token);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) { accessTokens.delete(token); return false; }
    return entry.fileId === fileId;
}

setInterval(() => {
    const now = Date.now();
    for (const [t, e] of accessTokens) if (now > e.expiresAt) accessTokens.delete(t);
}, 60000).unref();

// Separate from accessToken on purpose: accessToken proves "you're a TVFS
// user" (checked when tvfsUsersOnly is on); unlockToken proves "you just
// completed a successful OPAQUE login" (checked ALWAYS, replacing the old
// verify-blob trick). A file with tvfsUsersOnly on requires BOTH; one
// without it only requires the unlockToken.
const unlockTokens = new Map(); // token -> { id, expiresAt }
const UNLOCK_TOKEN_TTL_MS = 5 * 60 * 1000;

function issueUnlockToken(id) {
    const token = crypto.randomBytes(24).toString('hex');
    unlockTokens.set(token, { id, expiresAt: Date.now() + UNLOCK_TOKEN_TTL_MS });
    return token;
}
function checkUnlockToken(token, id) {
    const entry = unlockTokens.get(token);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) { unlockTokens.delete(token); return false; }
    return entry.id === id;
}
setInterval(() => {
    const now = Date.now();
    for (const [t, e] of unlockTokens) if (now > e.expiresAt) unlockTokens.delete(t);
}, 60000).unref();

// ─── Helpers ──────────────────────────────────────────────────────────────

function generateFileId() {
    return crypto.randomBytes(12).toString('hex');
}

const EXPIRATION_OPTIONS_MIN = [5, 30, 60, 360, 720, 1440, 2880, 4320, 7200, 10080, 14400, 20160];
const DEFAULT_EXPIRATION_MIN = 10080;

function resolveExpirationMinutes(raw) {
    const parsed = parseInt(raw);
    return EXPIRATION_OPTIONS_MIN.includes(parsed) ? parsed : DEFAULT_EXPIRATION_MIN;
}

function getFile(fileId) {
    const entry = registry.files[fileId];
    if (!entry) return null;
    if (entry.chunked && !entry.complete) return null; // still uploading — not servable yet
    if (Date.now() > entry.expiresAt) return null; // expired — cleanup.js sweeps the bytes separately
    return entry;
}

// Reuses upload.js's authenticateRequest verbatim: tries the tvfs_token
// cookie first (so someone already logged in on files.tomasekvalla.cz
// never has to type their password again just to use Encrypted Sharing),
// and only falls back to username+password in the request body when
// there's no active session — e.g. a fresh pairing viewer, or an API
// caller with no cookie jar at all.
function resolveOwner(req) {
    const auth = uploadRouter.authenticateRequest(req);
    return auth.valid ? { tier: auth.tier, username: auth.username } : null;
}

// ─── Multer for the ciphertext blob ──────────────────────────────────────

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, ENC_TMP_DIR),
        filename: (req, file, cb) => cb(null, `${crypto.randomBytes(8).toString('hex')}_${file.fieldname}`)
    }),
    limits: { fileSize: 5 * 1024 * 1024 * 1024 } // 5GB ceiling; adjust to taste
});

// ─── POST /api/encrypted/:id/opaque/register-init ────────────────────────
// First of two round trips OPAQUE registration needs (the protocol
// requires the server's OPRF response before the client can finish).
// `:id` is a fileId the CLIENT generates locally (crypto.getRandomValues,
// same 24-hex-char shape as generateFileId()) — no registry entry exists
// yet at this point; this step only touches the server's OPRF seed, not
// storage. If the upload never completes, this registration attempt is
// simply orphaned and harmless (no file, no registry entry, nothing to
// clean up).
router.post('/:id/opaque/register-init', express.json(), async (req, res) => {
    try {
        const responseSerialized = await opaqueServer.registerInit(req.body.request, req.params.id);
        res.json({ response: responseSerialized });
    } catch (e) {
        console.error('❌ [OPAQUE register-init]', e.message);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// ─── POST /api/encrypted/upload ──────────────────────────────────────────
//
// Fields (multipart/form-data):
//   fileId          -> client-generated (see register-init above) — this
//                      IS the OPAQUE credential_identifier, so it must be
//                      the exact same value used there
//   file            -> the AES-GCM container (salt+iv+ciphertext) of the
//                      real file, encrypted client-side with OPAQUE's
//                      export_key (as the "password" input to the
//                      existing container format — see encryptedCrypto.js)
//   opaqueRecord    -> JSON-stringified RegistrationRecord.serialize()
//                      from registerFinish() — this is what replaces the
//                      old verify-blob. Not offline-crackable if leaked.
//   isPrivate       -> forced true, kept for API-shape compatibility
//   encryptedName   -> base64 AES-GCM container of the filename
//   mimeCategory    -> unused now (always Private), kept for compatibility
//   expirationMinutes
//   singleUse       -> 'true'/'false'
//   tvfsUsersOnly   -> 'true'/'false', default true
//   ownerUsername   -> set from authenticated session if logged in, else null
router.post(
    '/upload',
    upload.fields([{ name: 'file', maxCount: 1 }]),
    async (req, res) => {
        const fileBlob = req.files && req.files.file && req.files.file[0];
        const cleanupTmp = () => { if (fileBlob) { try { fs.unlinkSync(fileBlob.path); } catch (e) {} } };

        const fileId = req.body.fileId;
        if (!fileBlob || !fileId || !req.body.opaqueRecord) {
            cleanupTmp();
            return res.status(400).json({ error: 'Missing file, fileId, or opaqueRecord' });
        }
        if (!/^[0-9a-f]{24,64}$/.test(fileId)) {
            cleanupTmp();
            return res.status(400).json({ error: 'Invalid fileId format' });
        }
        if (registry.files[fileId]) {
            cleanupTmp();
            return res.status(409).json({ error: 'fileId already used — this should never happen with a fresh random id, try again' });
        }

        let opaqueRecord;
        try { opaqueRecord = JSON.parse(req.body.opaqueRecord); }
        catch (e) { cleanupTmp(); return res.status(400).json({ error: 'Invalid opaqueRecord' }); }

        const isPrivate = true; // forced — Encrypted Sharing always shares Private now (matches the vault's inherent no-metadata design)
        const singleUse = req.body.singleUse === 'true';
        const tvfsUsersOnly = req.body.tvfsUsersOnly === 'true'; // opt-in, default OFF
        const allowPairing = req.body.allowPairing === 'true'; // opt-in, default OFF — only meaningful when tvfsUsersOnly is on

        let ownerUsername = null;
        const cookieOwner = resolveOwner(req);
        if (cookieOwner) {
            ownerUsername = cookieOwner.username;
        } else if (req.body.ownerUsername && req.body.ownerPassword) {
            const user = findUser(req.body.ownerUsername, req.body.ownerPassword);
            if (user) ownerUsername = user.username;
        }

        // TVFS Users Only requires a known owner — otherwise there's no one
        // for pairing requests to go to, and no session to "always allow".
        if (tvfsUsersOnly && !ownerUsername) {
            cleanupTmp();
            return res.status(400).json({ error: 'TVFS Users Only requires you to be logged in as a TVFS user' });
        }

        const finalPath = path.join(ENC_DIR, `${fileId}.bin`);

        try {
            fs.renameSync(fileBlob.path, finalPath);
        } catch (err) {
            cleanupTmp();
            return res.status(500).json({ error: 'Failed to store encrypted file', details: err.message });
        }

        const expiresAt = Date.now() + resolveExpirationMinutes(req.body.expirationMinutes) * 60 * 1000;
        const stats = fs.statSync(finalPath);

        // Generate this file's own landing/decipher page, same pattern as
        // maybeCreateAudioPlayer / maybeCreateTextReader in upload.js.
        const pageFilename = `${fileId}.html`;
        const pagePath = path.join(ENC_PAGES_DIR, pageFilename);
        try {
            fs.writeFileSync(pagePath, buildLandingHtml(fileId));
        } catch (err) {
            cleanupTmp();
            return res.status(500).json({ error: 'Failed to generate landing page', details: err.message });
        }

        registry.files[fileId] = {
            id: fileId,
            ciphertextPath: finalPath,
            opaqueRecord,
            pagePath,
            size: stats.size,
            uploadedAt: Date.now(),
            expiresAt,
            isPrivate,
            displayName: isPrivate ? null : (req.body.displayName || null),
            encryptedName: isPrivate ? (req.body.encryptedName || null) : null,
            mimeCategory: isPrivate ? null : (req.body.mimeCategory || 'file'),
            singleUse,
            downloaded: false,
            tvfsUsersOnly,
            allowPairing,
            ownerUsername
        };
        saveRegistry();

        requestLogger.logEvent(req, 'encrypted_upload_complete', {
            fileId, size: stats.size, expiresAt, isPrivate, singleUse, tvfsUsersOnly, allowPairing, ownerUsername
        });

        const link = `https://files.tomasekvalla.cz/files/encrypted/pages/${pageFilename}`;
        console.log(`🔐 [ENCRYPTED UPLOAD] ${fileId} (${stats.size} bytes, private=${isPrivate}, singleUse=${singleUse}, tvfsUsersOnly=${tvfsUsersOnly})`);
        res.json({ message: 'Encrypted upload successful', fileId, link, expiresAt });
    }
);

// ─── Chunked upload (large files) ─────────────────────────────────────────
//
// The normal /upload endpoint needs the whole ciphertext built in memory
// client-side first — fine for small/medium files, painful for anything
// large. This is the streaming alternative: the client encrypts and
// uploads the file in fixed-size chunks, never holding more than one
// chunk's worth of plaintext+ciphertext in memory at once.
//
// AES-GCM authenticates a whole message with one tag, so chunks can't
// just be independently GCM-encrypted with the same nonce (catastrophic
// nonce reuse) or naively concatenated afterward. Instead:
//   - Every chunk shares the same key (OPAQUE's export_key, imported
//     directly as a raw AES-256-GCM key — no PBKDF2 needed, it's already
//     high-entropy).
//   - Every chunk gets a UNIQUE 96-bit IV: an 8-byte random base nonce
//     (generated once per file) concatenated with a 4-byte big-endian
//     chunk index. Same base nonce, different index -> different IV,
//     guaranteed, without needing to store a nonce per chunk.
//   - Each chunk's AES-GCM call includes the chunk index AND total chunk
//     count as Additional Authenticated Data (AAD) — so an attacker who
//     drops, reorders, duplicates, or truncates chunks gets caught by
//     the auth tag failing, not silently accepted as valid-looking
//     garbage.
//
// Registry entries stay in registry.files exactly like a normal upload,
// just with `chunked: true` and `complete: false` until chunk-finalize
// runs — getFile() below treats an incomplete entry as not found, so a
// half-uploaded file is never accidentally servable.

const CHUNK_TMP_TTL_MS = 24 * 60 * 60 * 1000; // abandon (and let cleanup sweep) pending uploads after this long

router.post('/:id/chunk-init', express.json({ limit: '1mb' }), async (req, res) => {
    const fileId = req.params.id;
    if (!/^[0-9a-f]{24,64}$/.test(fileId)) return res.status(400).json({ error: 'Invalid fileId format' });
    if (registry.files[fileId]) return res.status(409).json({ error: 'fileId already used — this should never happen with a fresh random id, try again' });

    const { opaqueRecord, chunkCount, totalPlainSize, baseNonceB64, encryptedName } = req.body || {};
    if (!opaqueRecord || !Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 10000 || !Number.isInteger(totalPlainSize) || !baseNonceB64) {
        return res.status(400).json({ error: 'Missing or invalid chunk-init fields' });
    }

    const tvfsUsersOnly = req.body.tvfsUsersOnly === true;
    const singleUse = req.body.singleUse === true;

    let ownerUsername = null;
    const cookieOwner = resolveOwner(req);
    if (cookieOwner) ownerUsername = cookieOwner.username;
    else if (req.body.ownerUsername && req.body.ownerPassword) {
        const user = findUser(req.body.ownerUsername, req.body.ownerPassword);
        if (user) ownerUsername = user.username;
    }
    if (tvfsUsersOnly && !ownerUsername) {
        return res.status(400).json({ error: 'TVFS Users Only requires you to be logged in as a TVFS user' });
    }

    const chunkDir = path.join(ENC_DIR, `chunked_${fileId}`);
    try { fs.mkdirSync(chunkDir, { recursive: true }); } catch (err) {
        return res.status(500).json({ error: 'Failed to create chunk storage', details: err.message });
    }

    registry.files[fileId] = {
        id: fileId,
        chunked: true,
        complete: false,
        chunkDir,
        chunkCount,
        chunksReceived: 0,
        totalPlainSize,
        baseNonceB64,
        opaqueRecord,
        isPrivate: true,
        displayName: null,
        encryptedName: encryptedName || null,
        mimeCategory: null,
        singleUse,
        downloaded: false,
        tvfsUsersOnly,
        ownerUsername,
        // Real expiresAt is set at finalize time (once we know the actual
        // requested expiration); this placeholder just lets cleanup.js
        // reclaim an abandoned upload that never finishes.
        expiresAt: Date.now() + CHUNK_TMP_TTL_MS,
        pendingExpirationMinutes: req.body.expirationMinutes
    };
    saveRegistry();
    res.json({ ok: true });
});

router.put('/:id/chunk/:index', express.raw({ limit: '35mb', type: '*/*' }), (req, res) => {
    const entry = registry.files[req.params.id];
    if (!entry || !entry.chunked || entry.complete) return res.status(404).json({ error: 'No pending chunked upload with this id' });

    const idx = parseInt(req.params.index, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= entry.chunkCount) return res.status(400).json({ error: 'Invalid chunk index' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty chunk body' });

    const chunkPath = path.join(entry.chunkDir, `chunk_${idx}.bin`);
    const alreadyHad = fs.existsSync(chunkPath);
    try {
        fs.writeFileSync(chunkPath, req.body);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to store chunk', details: err.message });
    }
    if (!alreadyHad) entry.chunksReceived++;
    saveRegistry();
    res.json({ ok: true, chunksReceived: entry.chunksReceived, chunkCount: entry.chunkCount });
});

router.post('/:id/chunk-finalize', express.json(), (req, res) => {
    const entry = registry.files[req.params.id];
    if (!entry || !entry.chunked || entry.complete) return res.status(404).json({ error: 'No pending chunked upload with this id' });

    for (let i = 0; i < entry.chunkCount; i++) {
        if (!fs.existsSync(path.join(entry.chunkDir, `chunk_${i}.bin`))) {
            return res.status(400).json({ error: `Missing chunk ${i} of ${entry.chunkCount} — resume by re-uploading it` });
        }
    }

    const expiresAt = Date.now() + resolveExpirationMinutes(entry.pendingExpirationMinutes) * 60 * 1000;
    const pageFilename = `${entry.id}.html`;
    const pagePath = path.join(ENC_PAGES_DIR, pageFilename);
    try {
        fs.writeFileSync(pagePath, buildLandingHtml(entry.id));
    } catch (err) {
        return res.status(500).json({ error: 'Failed to generate landing page', details: err.message });
    }

    entry.complete = true;
    entry.expiresAt = expiresAt;
    entry.pagePath = pagePath;
    delete entry.pendingExpirationMinutes;
    saveRegistry();

    requestLogger.logEvent(req, 'encrypted_chunked_upload_complete', {
        fileId: entry.id, chunkCount: entry.chunkCount, totalPlainSize: entry.totalPlainSize,
        expiresAt, singleUse: entry.singleUse, tvfsUsersOnly: entry.tvfsUsersOnly, ownerUsername: entry.ownerUsername
    });

    const link = `https://files.tomasekvalla.cz/files/encrypted/pages/${pageFilename}`;
    console.log(`🔐 [CHUNKED UPLOAD COMPLETE] ${entry.id} (${entry.chunkCount} chunks, ${entry.totalPlainSize} bytes plaintext)`);
    res.json({ message: 'Encrypted upload successful', fileId: entry.id, link, expiresAt });
});

// GET /api/encrypted/:id/chunk-meta — landing page needs this (chunk
// count, base nonce) to know how to fetch+decrypt, distinct from the
// regular /:id/meta which stays shape-compatible with non-chunked files.
router.get('/:id/chunk-meta', (req, res) => {
    const entry = getFile(req.params.id);
    if (!entry || !entry.chunked) return res.status(404).json({ error: 'Not found, expired, or not a chunked upload' });
    res.json({ chunkCount: entry.chunkCount, totalPlainSize: entry.totalPlainSize, baseNonceB64: entry.baseNonceB64 });
});

router.get('/:id/chunk/:index', (req, res) => {
    const entry = getFile(req.params.id);
    if (!entry || !entry.chunked) return res.status(404).json({ error: 'Not found or expired' });
    if (entry.singleUse && entry.downloaded) return res.status(410).json({ error: 'This file was already downloaded once (single-use)' });

    if (!checkUnlockToken(req.query.unlock, entry.id)) {
        return res.status(403).json({ error: 'Missing or invalid unlock token — verify the password first' });
    }
    if (entry.tvfsUsersOnly && !checkAccessToken(req.query.token, entry.id)) {
        return res.status(403).json({ error: 'Missing or invalid access token — log in or pair first' });
    }

    const idx = parseInt(req.params.index, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= entry.chunkCount) return res.status(400).json({ error: 'Invalid chunk index' });

    res.sendFile(path.join(entry.chunkDir, `chunk_${idx}.bin`), (err) => {
        if (err) return;
        requestLogger.logEvent(req, 'encrypted_chunk_download', { fileId: entry.id, chunkIndex: idx });
        // Single-use consumption happens once the LAST chunk is fetched —
        // mirrors "the whole file was retrieved", not just the first byte.
        if (entry.singleUse && idx === entry.chunkCount - 1) {
            entry.downloaded = true;
            saveRegistrySync();
            try { fs.rmSync(entry.chunkDir, { recursive: true, force: true }); } catch (e) {}
            console.log(`🔥 [ENCRYPTED SHARE] Single-use chunked file consumed and shredded: ${entry.id}`);
            requestLogger.logEvent(req, 'encrypted_single_use_shredded', { fileId: entry.id });
        }
    });
});


//
// Design (per Tomasek): each file gets its OWN random 64-char key, encrypted
// independently. A "keychain" — JSON list of {blobIndex, displayName,
// mimeCategory, key} — is itself encrypted with the user's one master
// password, same container format as everything else. The server stores N
// opaque ciphertext blobs (random storage names, unlinked from any
// metadata), 1 verify-blob (confirms the master password, same trick as
// single-file mode), and 1 encrypted keychain blob.
//
// Server-visible metadata: nothing except blob COUNT and SIZES (which the
// filesystem can't hide) — no names, no types, no per-file keys. This is
// why single-file Private mode became "always on": a vault is inherently
// at least this private, so there's no reason a single shared file
// shouldn't be too.
//
// Single Use for a vault means "the whole landing page unlocks exactly
// once" — consumption happens the moment the KEYCHAIN is first
// successfully fetched (that's the actual "unlock"), not per individual
// file download. After that, the vault's expiry is pulled forward to a
// short grace window so cleanup.js sweeps it soon, but individual files
// stay fetchable during that window — a reload after the unlock fails
// because the keychain itself refuses to be fetched again.
const VAULT_CONSUMED_GRACE_MS = 20 * 60 * 1000; // 20 min to actually finish downloading after unlock

const uploadVault = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, ENC_TMP_DIR),
        filename: (req, file, cb) => cb(null, `${crypto.randomBytes(8).toString('hex')}_${file.fieldname}_${file.originalname || ''}`)
    }),
    limits: { fileSize: 5 * 1024 * 1024 * 1024, files: 60 }
});

function generateVaultId() {
    return crypto.randomBytes(12).toString('hex');
}

function getVault(vaultId) {
    const entry = registry.vaults[vaultId];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry;
}

// Same two-step OPAQUE registration as the single-file flow, just scoped
// to a client-generated vaultId instead of a fileId.
router.post('/vault/:id/opaque/register-init', express.json(), async (req, res) => {
    try {
        const responseSerialized = await opaqueServer.registerInit(req.body.request, req.params.id);
        res.json({ response: responseSerialized });
    } catch (e) {
        console.error('❌ [OPAQUE vault register-init]', e.message);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// POST /api/encrypted/vault/upload
// Fields: vaultId (client-generated), files[] (N ciphertext containers,
// each independently keyed — unrelated to OPAQUE), keychainBlob (the
// per-file key list, encrypted with OPAQUE's export_key), opaqueRecord,
// tvfsUsersOnly, singleUse, expirationMinutes. ownerUsername resolved
// from the session cookie exactly like single-file upload.
router.post(
    '/vault/upload',
    uploadVault.fields([
        { name: 'files', maxCount: 60 },
        { name: 'keychainBlob', maxCount: 1 }
    ]),
    async (req, res) => {
        const fileBlobs = (req.files && req.files.files) || [];
        const keychainBlobFile = req.files && req.files.keychainBlob && req.files.keychainBlob[0];

        const cleanupTmp = () => {
            for (const f of [...fileBlobs, keychainBlobFile]) {
                if (f) { try { fs.unlinkSync(f.path); } catch (e) {} }
            }
        };

        const vaultId = req.body.vaultId;
        if (fileBlobs.length === 0 || !keychainBlobFile || !vaultId || !req.body.opaqueRecord) {
            cleanupTmp();
            return res.status(400).json({ error: 'Missing files, keychainBlob, vaultId, or opaqueRecord' });
        }
        if (!/^[0-9a-f]{24,64}$/.test(vaultId)) {
            cleanupTmp();
            return res.status(400).json({ error: 'Invalid vaultId format' });
        }
        if (registry.vaults[vaultId]) {
            cleanupTmp();
            return res.status(409).json({ error: 'vaultId already used — this should never happen with a fresh random id, try again' });
        }

        let opaqueRecord;
        try { opaqueRecord = JSON.parse(req.body.opaqueRecord); }
        catch (e) { cleanupTmp(); return res.status(400).json({ error: 'Invalid opaqueRecord' }); }

        const tvfsUsersOnly = req.body.tvfsUsersOnly !== 'false'; // default ON for vaults
        const singleUse = req.body.singleUse === 'true';

        let ownerUsername = null;
        const cookieOwner = resolveOwner(req);
        if (cookieOwner) ownerUsername = cookieOwner.username;

        if (tvfsUsersOnly && !ownerUsername) {
            cleanupTmp();
            return res.status(400).json({ error: 'TVFS Users Only requires you to be logged in' });
        }

        const vaultDir = path.join(ENC_DIR, `vault_${vaultId}`);
        try { fs.mkdirSync(vaultDir, { recursive: true }); } catch (err) {
            cleanupTmp();
            return res.status(500).json({ error: 'Failed to create vault storage', details: err.message });
        }

        let totalSize = 0;
        const blobPaths = [];
        try {
            for (let i = 0; i < fileBlobs.length; i++) {
                const dest = path.join(vaultDir, `blob_${i}.bin`);
                fs.renameSync(fileBlobs[i].path, dest);
                blobPaths.push(dest);
                totalSize += fs.statSync(dest).size;
            }
            const keychainPath = path.join(vaultDir, 'keychain.bin');
            fs.renameSync(keychainBlobFile.path, keychainPath);

            const expiresAt = Date.now() + resolveExpirationMinutes(req.body.expirationMinutes) * 60 * 1000;
            const pageFilename = `vault_${vaultId}.html`;
            const pagePath = path.join(ENC_PAGES_DIR, pageFilename);
            fs.writeFileSync(pagePath, buildVaultLandingHtml(vaultId, fileBlobs.length));

            registry.vaults[vaultId] = {
                id: vaultId,
                dir: vaultDir,
                blobPaths,
                opaqueRecord,
                keychainPath,
                pagePath,
                fileCount: fileBlobs.length,
                totalSize,
                uploadedAt: Date.now(),
                expiresAt,
                singleUse,
                consumed: false,
                tvfsUsersOnly,
                ownerUsername
            };
            saveRegistry();

            requestLogger.logEvent(req, 'encrypted_vault_upload_complete', {
                vaultId, fileCount: fileBlobs.length, totalSize, expiresAt, singleUse, tvfsUsersOnly, ownerUsername
            });

            const link = `https://files.tomasekvalla.cz/files/encrypted/pages/${pageFilename}`;
            console.log(`🔐 [VAULT UPLOAD] ${vaultId} (${fileBlobs.length} files, ${totalSize} bytes, singleUse=${singleUse}, tvfsUsersOnly=${tvfsUsersOnly})`);
            res.json({ message: 'Vault upload successful', vaultId, link, expiresAt });
        } catch (err) {
            cleanupTmp();
            try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (e) {}
            return res.status(500).json({ error: 'Failed to store vault', details: err.message });
        }
    }
);

router.get('/vault/:id/meta', (req, res) => {
    const entry = getVault(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });
    res.json({
        id: entry.id,
        fileCount: entry.fileCount,
        singleUse: entry.singleUse,
        consumed: entry.consumed,
        tvfsUsersOnly: entry.tvfsUsersOnly,
        expiresAt: entry.expiresAt
    });
});

router.post('/vault/:id/login', (req, res) => {
    const entry = getVault(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });

    const ip = clientIp(req);
    const rl = authLimiter.check(ip);
    if (!rl.allowed) {
        requestLogger.logEvent(req, 'encrypted_vault_login_rate_limited', { vaultId: entry.id, limiterState: rl.state });
        return res.status(429).json({ error: rl.state === 'locked' ? 'Too many failed attempts — locked for 1 hour' : 'Too many attempts, try again later' });
    }

    if (!entry.tvfsUsersOnly) {
        authLimiter.refund(ip);
        return res.json({ accessToken: issueAccessToken(entry.id) });
    }

    const cookieOwner = resolveOwner(req);
    if (cookieOwner) {
        authLimiter.refund(ip);
        requestLogger.logEvent(req, 'encrypted_vault_login_ok', { vaultId: entry.id, username: cookieOwner.username, viaCookie: true });
        return res.json({ accessToken: issueAccessToken(entry.id), username: cookieOwner.username, isOwner: cookieOwner.username === entry.ownerUsername });
    }

    const { username, password } = req.body || {};
    const user = findUser(username, password);
    if (!user) {
        requestLogger.logEvent(req, 'encrypted_vault_login_fail', { vaultId: entry.id, attemptedUsernameHash: username ? sha256(String(username).trim()) : null });
        return res.status(403).json({ error: 'Invalid TVFS credentials' });
    }
    authLimiter.refund(ip);
    requestLogger.logEvent(req, 'encrypted_vault_login_ok', { vaultId: entry.id, username: user.username, viaCookie: false });
    res.json({ accessToken: issueAccessToken(entry.id), username: user.username, isOwner: user.username === entry.ownerUsername });
});

// The actual "unlock" moment for singleUse vaults — first successful fetch
// consumes it. Individual file blobs remain fetchable for a grace window
// afterward so the person can actually finish downloading.
router.get('/vault/:id/keychain', (req, res) => {
    const entry = getVault(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });
    if (entry.consumed) return res.status(410).json({ error: 'This vault has already been unlocked once (single use)' });
    if (!checkUnlockToken(req.query.unlock, entry.id)) {
        return res.status(403).json({ error: 'Missing or invalid unlock token — verify the password first' });
    }
    if (entry.tvfsUsersOnly && !checkAccessToken(req.query.token, entry.id)) {
        return res.status(403).json({ error: 'Missing or invalid access token' });
    }
    res.sendFile(entry.keychainPath, (err) => {
        if (err) return;
        requestLogger.logEvent(req, 'encrypted_vault_keychain_fetched', { vaultId: entry.id, singleUse: entry.singleUse });
        if (entry.singleUse) {
            entry.consumed = true;
            entry.expiresAt = Math.min(entry.expiresAt, Date.now() + VAULT_CONSUMED_GRACE_MS);
            saveRegistrySync();
            requestLogger.logEvent(req, 'encrypted_vault_unlocked', { vaultId: entry.id });
        }
    });
});

router.get('/vault/:id/file/:blobIndex', (req, res) => {
    const entry = getVault(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });
    const idx = parseInt(req.params.blobIndex, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= entry.blobPaths.length) {
        return res.status(400).json({ error: 'Invalid file index' });
    }
    if (!checkUnlockToken(req.query.unlock, entry.id)) {
        return res.status(403).json({ error: 'Missing or invalid unlock token — verify the password first' });
    }
    if (entry.tvfsUsersOnly && !checkAccessToken(req.query.token, entry.id)) {
        return res.status(403).json({ error: 'Missing or invalid access token' });
    }
    res.sendFile(entry.blobPaths[idx], (err) => {
        if (err) return;
        requestLogger.logEvent(req, 'encrypted_vault_file_download', { vaultId: entry.id, blobIndex: idx });
    });
});


// ─── OPAQUE login (replaces the old verify-blob trick entirely) ──────────
//
// Two round trips, matching the protocol: login-init (rate-limited — this
// IS the actual per-guess limiter now, unlike the old "rate-limit the
// blob download" approach) then login-finish (server independently
// confirms success via its own authFinish check — never trusts the
// client's word for it).

router.post('/:id/opaque/login-init', express.json(), async (req, res) => {
    const entry = getFile(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });

    const ip = clientIp(req);
    const rl = verifyLimiter.check(ip);
    if (!rl.allowed) {
        requestLogger.logEvent(req, 'encrypted_verify_rate_limited', { fileId: entry.id, limiterState: rl.state });
        return res.status(429).json({ error: rl.state === 'locked' ? 'Too many attempts — locked for 1 hour' : 'Too many attempts, try again later' });
    }

    try {
        const { ke2, sessionId } = await opaqueServer.authInit(req.body.ke1, entry.opaqueRecord, entry.id);
        res.json({ ke2, sessionId });
    } catch (e) {
        console.error('❌ [OPAQUE login-init]', e.message);
        res.status(500).json({ error: 'Login failed' });
    }
});

router.post('/:id/opaque/login-finish', express.json(), async (req, res) => {
    const entry = getFile(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });

    const result = await opaqueServer.authFinish(req.body.ke3, req.body.sessionId);
    if (!result.ok) {
        requestLogger.logEvent(req, 'encrypted_verify_fail', { fileId: entry.id });
        return res.status(403).json({ error: 'Wrong password' });
    }

    verifyLimiter.refund(clientIp(req)); // genuine success — doesn't burn quota
    requestLogger.logEvent(req, 'encrypted_verify_ok', { fileId: entry.id });
    res.json({ unlockToken: issueUnlockToken(entry.id) });
});

router.post('/vault/:id/opaque/login-init', express.json(), async (req, res) => {
    const entry = getVault(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });
    if (entry.consumed) return res.status(410).json({ error: 'This vault has already been unlocked once (single use)' });

    const ip = clientIp(req);
    const rl = verifyLimiter.check(ip);
    if (!rl.allowed) {
        requestLogger.logEvent(req, 'encrypted_vault_verify_rate_limited', { vaultId: entry.id, limiterState: rl.state });
        return res.status(429).json({ error: rl.state === 'locked' ? 'Too many attempts — locked for 1 hour' : 'Too many attempts, try again later' });
    }

    try {
        const { ke2, sessionId } = await opaqueServer.authInit(req.body.ke1, entry.opaqueRecord, entry.id);
        res.json({ ke2, sessionId });
    } catch (e) {
        console.error('❌ [OPAQUE vault login-init]', e.message);
        res.status(500).json({ error: 'Login failed' });
    }
});

router.post('/vault/:id/opaque/login-finish', express.json(), async (req, res) => {
    const entry = getVault(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });

    const result = await opaqueServer.authFinish(req.body.ke3, req.body.sessionId);
    if (!result.ok) {
        requestLogger.logEvent(req, 'encrypted_vault_verify_fail', { vaultId: entry.id });
        return res.status(403).json({ error: 'Wrong password' });
    }

    verifyLimiter.refund(clientIp(req));
    requestLogger.logEvent(req, 'encrypted_vault_verify_ok', { vaultId: entry.id });
    res.json({ unlockToken: issueUnlockToken(entry.id) });
});


router.get('/:id/meta', (req, res) => {
    const entry = getFile(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });

    res.json({
        id: entry.id,
        isPrivate: entry.isPrivate,
        displayName: entry.isPrivate ? null : entry.displayName,
        encryptedName: entry.isPrivate ? entry.encryptedName : null,
        mimeCategory: entry.isPrivate ? null : entry.mimeCategory,
        size: entry.isPrivate ? null : entry.size, // size itself can hint at content; hide it too in Private mode
        singleUse: entry.singleUse,
        alreadyDownloaded: entry.singleUse ? entry.downloaded : undefined,
        tvfsUsersOnly: entry.tvfsUsersOnly,
        allowPairing: entry.tvfsUsersOnly && !!entry.allowPairing,
        chunked: !!entry.chunked,
        expiresAt: entry.expiresAt
    });
});

// ─── POST /api/encrypted/:id/login ───────────────────────────────────────
// TVFS-credential path for the tvfsUsersOnly gate. Rate limited.

router.post('/:id/login', (req, res) => {
    const entry = getFile(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });

    const ip = clientIp(req);
    const rl = authLimiter.check(ip);
    if (!rl.allowed) {
        requestLogger.logEvent(req, 'encrypted_login_rate_limited', { fileId: entry.id, limiterState: rl.state });
        return res.status(429).json({ error: rl.state === 'locked' ? 'Too many failed attempts — locked for 1 hour' : 'Too many attempts, try again later' });
    }

    if (!entry.tvfsUsersOnly) {
        authLimiter.refund(ip); // not a real login attempt — this path doesn't check credentials at all
        return res.json({ accessToken: issueAccessToken(entry.id) });
    }

    // Already logged in on this browser (tvfs_token cookie)? Don't make
    // them type anything — this is the same session upload.html trusts.
    const cookieOwner = resolveOwner(req);
    if (cookieOwner) {
        authLimiter.refund(ip); // genuine success — doesn't burn quota
        requestLogger.logEvent(req, 'encrypted_login_ok', { fileId: entry.id, username: cookieOwner.username, viaCookie: true });
        return res.json({ accessToken: issueAccessToken(entry.id), username: cookieOwner.username, isOwner: cookieOwner.username === entry.ownerUsername });
    }

    const { username, password } = req.body || {};
    const user = findUser(username, password);
    if (!user) {
        requestLogger.logEvent(req, 'encrypted_login_fail', { fileId: entry.id, attemptedUsernameHash: username ? sha256(String(username).trim()) : null });
        return res.status(403).json({ error: 'Invalid TVFS credentials' });
    }

    authLimiter.refund(ip); // genuine success — doesn't burn quota
    requestLogger.logEvent(req, 'encrypted_login_ok', { fileId: entry.id, username: user.username });
    res.json({ accessToken: issueAccessToken(entry.id), username: user.username, isOwner: user.username === entry.ownerUsername });
});

// ─── Pairing flow ─────────────────────────────────────────────────────────
//
// For a viewer who IS a TVFS user but isn't the owner and doesn't want to
// (or the owner doesn't want them to) use the owner's own credentials:
// the viewer requests pairing, gets a 6-digit code, the owner sees the
// pending request (with the same code, so both sides can eyeball-confirm
// it's the right session) in their pairing dashboard, and approves it.

const PAIR_CODE_TTL_MS = 5 * 60 * 1000;

function generatePairCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// POST /:id/pair/request  { viewerUsername, viewerPassword }
// Viewer must still be a valid TVFS user — pairing is an alternative to
// "use the owner's password", not a way for anonymous internet users in.
router.post('/:id/pair/request', (req, res) => {
    const entry = getFile(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });
    if (!entry.ownerUsername) return res.status(400).json({ error: 'This file has no owner to pair with' });
    if (!entry.allowPairing) return res.status(403).json({ error: 'Pairing is not enabled for this file' });

    const rlKey = `enc-pair-req:${clientIp(req)}`;
    if (!checkRateLimit(rlKey, 30, 15 * 60 * 1000)) {
        requestLogger.logEvent(req, 'encrypted_pair_request_rate_limited', { fileId: entry.id });
        return res.status(429).json({ error: 'Too many attempts, try again later' });
    }

    const { viewerUsername, viewerPassword } = req.body || {};
    const viewer = resolveOwner(req) || findUser(viewerUsername, viewerPassword);
    if (!viewer) {
        requestLogger.logEvent(req, 'encrypted_pair_request_fail', { fileId: entry.id, attemptedUsernameHash: viewerUsername ? sha256(String(viewerUsername).trim()) : null });
        return res.status(403).json({ error: 'Invalid TVFS credentials' });
    }

    const requestId = crypto.randomBytes(16).toString('hex');
    const code = generatePairCode();
    registry.pairingRequests[requestId] = {
        requestId,
        fileId: entry.id,
        ownerUsername: entry.ownerUsername,
        viewerUsername: viewer.username,
        code,
        status: 'pending', // pending | approved | denied | expired
        createdAt: Date.now(),
        expiresAt: Date.now() + PAIR_CODE_TTL_MS,
        accessToken: null
    };
    saveRegistry();

    requestLogger.logEvent(req, 'encrypted_pair_request_created', { fileId: entry.id, requestId, viewerUsername: viewer.username, code });
    res.json({ requestId, code, expiresAt: registry.pairingRequests[requestId].expiresAt });
});

// GET /:id/pair/status/:requestId — viewer polls this.
router.get('/:id/pair/status/:requestId', (req, res) => {
    const pr = registry.pairingRequests[req.params.requestId];
    if (!pr || pr.fileId !== req.params.id) return res.status(404).json({ error: 'Not found' });

    if (pr.status === 'pending' && Date.now() > pr.expiresAt) {
        pr.status = 'expired';
        saveRegistry();
    }

    res.json({ status: pr.status, accessToken: pr.status === 'approved' ? pr.accessToken : null });
});

// GET /pairing/inbox — owner dashboard: POST TVFS credentials, get pending
// requests for files they own. (POST, not GET, so credentials aren't in a
// URL / server access log.)
router.post('/pairing/inbox', (req, res) => {
    const rlKey = `enc-pair-inbox:${clientIp(req)}`;
    if (!checkRateLimit(rlKey, 30, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many attempts, try again later' });
    }

    let user = resolveOwner(req);
    if (!user) {
        const { username, password } = req.body || {};
        user = findUser(username, password);
    }
    if (!user) return res.status(403).json({ error: 'Invalid TVFS credentials' });

    const now = Date.now();
    const pending = Object.values(registry.pairingRequests).filter(pr =>
        pr.ownerUsername === user.username &&
        pr.status === 'pending' &&
        pr.expiresAt > now
    );

    res.json({
        username: user.username,
        pending: pending.map(pr => ({
            requestId: pr.requestId,
            fileId: pr.fileId,
            viewerUsername: pr.viewerUsername,
            code: pr.code,
            expiresAt: pr.expiresAt,
            fileDisplayName: (registry.files[pr.fileId] && registry.files[pr.fileId].displayName) || '(private file)'
        }))
    });
});

// POST /pairing/:requestId/decide  { username, password, code, approve: true|false }
// Owner must re-confirm the code they see matches what's on their screen
// AND their own password again — this is the "you're really the owner,
// really looking at this exact request" check.
router.post('/pairing/:requestId/decide', (req, res) => {
    const pr = registry.pairingRequests[req.params.requestId];
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (Date.now() > pr.expiresAt || pr.status !== 'pending') {
        return res.status(410).json({ error: 'Request no longer pending' });
    }

    const { username, password, code, approve } = req.body || {};
    let user = resolveOwner(req);
    if (!user) user = findUser(username, password);
    if (!user || user.username !== pr.ownerUsername) {
        requestLogger.logEvent(req, 'encrypted_pair_decide_fail', { fileId: pr.fileId, requestId: pr.requestId, reason: 'auth' });
        return res.status(403).json({ error: 'Invalid TVFS credentials or not the owner of this file' });
    }
    if (String(code) !== pr.code) {
        requestLogger.logEvent(req, 'encrypted_pair_decide_fail', { fileId: pr.fileId, requestId: pr.requestId, reason: 'code_mismatch', owner: user.username });
        return res.status(400).json({ error: 'Code mismatch' });
    }

    if (approve) {
        pr.status = 'approved';
        pr.accessToken = issueAccessToken(pr.fileId);
    } else {
        pr.status = 'denied';
    }
    saveRegistry();
    requestLogger.logEvent(req, 'encrypted_pair_decide', { fileId: pr.fileId, requestId: pr.requestId, owner: user.username, viewerUsername: pr.viewerUsername, approved: !!approve });
    res.json({ status: pr.status });
});

// ─── GET /api/encrypted/:id/file ─────────────────────────────────────────
// Serves the main ciphertext container. Requires proof of password
// knowledge (unlockToken, from a completed OPAQUE login) ALWAYS, plus a
// TVFS accessToken if tvfsUsersOnly is on. Enforces singleUse.

router.get('/:id/file', (req, res) => {
    const entry = getFile(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found or expired' });

    if (entry.singleUse && entry.downloaded) {
        return res.status(410).json({ error: 'This file was already downloaded once (single-use)' });
    }

    if (!checkUnlockToken(req.query.unlock, entry.id)) {
        return res.status(403).json({ error: 'Missing or invalid unlock token — verify the password first' });
    }

    if (entry.tvfsUsersOnly) {
        const token = req.query.token;
        if (!checkAccessToken(token, entry.id)) {
            return res.status(403).json({ error: 'Missing or invalid access token — log in or pair first' });
        }
    }

    res.sendFile(entry.ciphertextPath, (err) => {
        if (err) return;
        requestLogger.logEvent(req, 'encrypted_download', { fileId: entry.id, singleUse: entry.singleUse });
        if (entry.singleUse) {
            entry.downloaded = true;
            saveRegistrySync();
            // Immediately shred the bytes — "single use" should mean single use.
            try { fs.unlinkSync(entry.ciphertextPath); } catch (e) {}
            console.log(`🔥 [ENCRYPTED SHARE] Single-use file consumed and shredded: ${entry.id}`);
            requestLogger.logEvent(req, 'encrypted_single_use_shredded', { fileId: entry.id });
        }
    });
});

// Exposed so cleanup.js can sweep expired ciphertext the same way it
// sweeps everything else, without duplicating the expiry-scan logic.
// Stand-in for `req` when logging from cleanup.js's cron context, where
// there's no real HTTP request/IP to attribute — every getter in
// requestLogger safely falls through to null on this.
const CRON_PSEUDO_REQ = { headers: {} };

function sweepExpired() {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of Object.entries(registry.files)) {
        if (entry.expiresAt <= now) {
            if (entry.chunked) {
                try { if (entry.chunkDir && fs.existsSync(entry.chunkDir)) fs.rmSync(entry.chunkDir, { recursive: true, force: true }); } catch (e) {}
            } else {
                try { if (fs.existsSync(entry.ciphertextPath)) fs.unlinkSync(entry.ciphertextPath); } catch (e) {}
            }
            try { if (entry.pagePath && fs.existsSync(entry.pagePath)) fs.unlinkSync(entry.pagePath); } catch (e) {}
            delete registry.files[id];
            removed++;
            requestLogger.logEvent(CRON_PSEUDO_REQ, 'encrypted_expired_deleted', { fileId: id });
        }
    }
    let vaultsRemoved = 0;
    for (const [id, entry] of Object.entries(registry.vaults)) {
        if (entry.expiresAt <= now) {
            try { if (entry.dir && fs.existsSync(entry.dir)) fs.rmSync(entry.dir, { recursive: true, force: true }); } catch (e) {}
            try { if (entry.pagePath && fs.existsSync(entry.pagePath)) fs.unlinkSync(entry.pagePath); } catch (e) {}
            delete registry.vaults[id];
            vaultsRemoved++;
            requestLogger.logEvent(CRON_PSEUDO_REQ, 'encrypted_vault_expired_deleted', { vaultId: id });
        }
    }
    for (const [rid, pr] of Object.entries(registry.pairingRequests)) {
        if (now > pr.expiresAt + 24 * 60 * 60 * 1000) delete registry.pairingRequests[rid]; // keep a day for audit, then drop
    }
    if (removed > 0 || vaultsRemoved > 0) saveRegistrySync();
    return { removed: removed + vaultsRemoved, files: removed, vaults: vaultsRemoved };
}

module.exports = { router, sweepExpired, VERIFY_PLAINTEXT };
