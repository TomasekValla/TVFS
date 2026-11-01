'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { analyzeAudio } = require('./bpmAnalyzer');
const safeFs = require('./safeFs');

const FONTS_CSS_URL = 'https://files.tomasekvalla.cz/fonts/fonts.css';

// ─── BPM → font ladder ──────────────────────────────────────────────────────
// 10 fonts, oldest/most-classical feel → newest/most-futuristic feel.
// (JP fonts and the dyslexia-friendly set are deliberately excluded — this
// is a vibe ladder, not the accessibility list from the text reader.)
// <70 BPM always gets the oldest, >160 BPM always gets the newest, and the
// 70–160 range is split into 10 even steps in between.
const BPM_FONT_LADDER = [
    { id: 'garamond',     label: 'EB Garamond',     stack: "'EB Garamond',serif" },
    { id: 'ptserif',      label: 'PT Serif',        stack: "'PT Serif',serif" },
    { id: 'merriweather', label: 'Merriweather',    stack: "'Merriweather',serif" },
    { id: 'lora',         label: 'Lora',            stack: "'Lora',serif" },
    { id: 'quicksand',    label: 'Quicksand',       stack: "'Quicksand',sans-serif" },
    { id: 'poppins',      label: 'Poppins',         stack: "'Poppins',sans-serif" },
    { id: 'jakarta',      label: 'Plus Jakarta Sans', stack: "'Plus Jakarta Sans',sans-serif" },
    { id: 'manrope',      label: 'Manrope',         stack: "'Manrope',sans-serif" },
    { id: 'sora',         label: 'Sora',            stack: "'Sora',sans-serif" },
    { id: 'spacegrotesk', label: 'Space Grotesk',   stack: "'Space Grotesk',sans-serif" },
];

function fontForBpm(bpm) {
    if (!bpm || !Number.isFinite(bpm)) return BPM_FONT_LADDER[4]; // neutral-ish default
    const lo = 70, hi = 160;
    if (bpm <= lo) return BPM_FONT_LADDER[0];
    if (bpm >= hi) return BPM_FONT_LADDER[BPM_FONT_LADDER.length - 1];
    const frac = (bpm - lo) / (hi - lo);
    const idx = Math.min(BPM_FONT_LADDER.length - 1, Math.floor(frac * BPM_FONT_LADDER.length));
    return BPM_FONT_LADDER[idx];
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function safeScriptJson(v) {
    return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function formatDuration(sec) {
    if (!sec || !Number.isFinite(sec)) return null;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── SVG icons (all self-made, single-color, currentColor) ─────────────────
const ICONS = {
    play: `<svg viewBox="0 0 24 24" fill="none"><path d="M7 5.5c0-1.2 1.3-1.9 2.3-1.3l10 6.5c1 .6 1 2 0 2.6l-10 6.5c-1 .6-2.3-.1-2.3-1.3v-13Z" fill="currentColor"/></svg>`,
    pause: `<svg viewBox="0 0 24 24" fill="none"><rect x="6" y="4.5" width="4.5" height="15" rx="1.4" fill="currentColor"/><rect x="13.5" y="4.5" width="4.5" height="15" rx="1.4" fill="currentColor"/></svg>`,
    restart: `<svg viewBox="0 0 24 24" fill="none"><rect x="4.5" y="4.5" width="2.6" height="15" rx="1" fill="currentColor"/><path d="M18.8 6.2c-1-1.2-2.7-2.1-4.6-2.1-3.6 0-6.5 3-6.5 6.7 0 3.7 2.9 6.7 6.5 6.7 2.9 0 5.3-1.9 6.1-4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M19.5 4.8v3.6h-3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
    stop: `<svg viewBox="0 0 24 24" fill="none"><rect x="5.5" y="5.5" width="13" height="13" rx="2.5" fill="currentColor"/></svg>`,
    download: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5v11.3" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M7.2 10.5 12 15.3l4.8-4.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M5 17.5v1.8c0 .9.8 1.7 1.7 1.7h10.6c.9 0 1.7-.8 1.7-1.7v-1.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none"/></svg>`,
    eq: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 18V13M4 10V6M9 18V11M9 8V6M14 18V15M14 12V6M19 18V9M19 6V6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="4" cy="11.5" r="1.7" fill="currentColor"/><circle cx="9" cy="9.5" r="1.7" fill="currentColor"/><circle cx="14" cy="13.5" r="1.7" fill="currentColor"/><circle cx="19" cy="7.5" r="1.7" fill="currentColor"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    back: `<svg viewBox="0 0 24 24" fill="none"><path d="M15 4.5 7.5 12l7.5 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
    volume: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 9.5v5h3.6l5 4V5.5l-5 4H4Z" fill="currentColor"/><path d="M16.2 8.8a5 5 0 0 1 0 6.4M19 6.3a9 9 0 0 1 0 11.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>`,
    mute: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 9.5v5h3.6l5 4V5.5l-5 4H4Z" fill="currentColor"/><path d="M15.5 10 19.5 14M19.5 10 15.5 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    speed: `<svg viewBox="0 0 24 24" fill="none"><path d="M4.2 17a8.5 8.5 0 1 1 15.6 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 13.6 15.8 9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="13.6" r="1.6" fill="currentColor"/></svg>`,
    disc: `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>`,
    help: `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.6" stroke="currentColor" stroke-width="1.8"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.9.7c0 1.7-2.5 2.1-2.5 3.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><circle cx="12" cy="16.9" r="1.1" fill="currentColor"/></svg>`,
    loop: `<svg viewBox="0 0 24 24" fill="none"><path d="M4.5 11.5V10a3.5 3.5 0 0 1 3.5-3.5h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M16 3.6 19 6.5l-3 2.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M19.5 12.5V14a3.5 3.5 0 0 1-3.5 3.5H5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M8 20.4 5 17.5l3-2.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
    reset: `<svg viewBox="0 0 24 24" fill="none"><path d="M5.2 12a6.8 6.8 0 1 0 2-4.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none"/><path d="M6.6 3.8v3.9h3.9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
};

// ─── Client code ────────────────────────────────────────────────────────────
// The player UI lives in audioPlayerClient/ as plain CSS/JS files and is inlined
// into every generated page, so a player keeps working on its own even after this
// module changes (already generated players are never rewritten).
const CLIENT_DIR = path.join(__dirname, 'audioPlayerClient');
function readClient(name) {
    return fs.readFileSync(path.join(CLIENT_DIR, name), 'utf8');
}
// Inline <script>/<style> content must never contain its own closing tag.
function inlineSafe(src) {
    return src.replace(/<\/(script|style)/gi, '<\\/$1');
}
// Read on first use (not at require time), so a missing client folder can only
// break player generation, never the whole backend.
let clientCache = null;
function client() {
    if (!clientCache) {
        clientCache = {
            css: inlineSafe(readClient('player.css')),
            js: inlineSafe(readClient('player.js')),
            worklets: inlineSafe(readClient('worklets.js')),
        };
    }
    return clientCache;
}

// Integrated loudness of the whole track (EBU R128, LUFS), or null if ffmpeg is
// missing or fails. The player turns tracks louder than the target down to it.
function measureLoudness(filePath) {
    try {
        const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', filePath, '-vn', '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'],
            { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
        const m = /Integrated loudness:\s*I:\s*(-?\d+(?:\.\d+)?) LUFS/.exec(r.stderr || '');
        return m ? parseFloat(m[1]) : null;
    } catch (e) {
        return null;
    }
}

// Shared "one-line" summary of the ffprobe/BPM metadata — used both on the
// player page itself and to build the copy-able styled link, so the two
// never drift out of sync with each other.
function formatMetaSummary(meta) {
    const channelLabel = meta.channels
        ? (meta.channels === 1 ? 'Mono' : meta.channels === 2 ? 'Stereo' : `${meta.channels}ch`)
        : null;
    return [
        meta.codec,
        channelLabel,
        meta.bitrateKbps ? `${meta.bitrateKbps}kbps` : null,
        meta.bitDepth ? `${meta.bitDepth}bit` : null,
        meta.sampleRateHz ? `${(meta.sampleRateHz / 1000).toFixed(1)}kHz` : null,
        meta.bpm ? `${meta.bpm} BPM` : null,
    ].filter(Boolean).join(' · ');
}

// ─── TVFS Users Only login gate ─────────────────────────────────────────────
const GATE_CSS = `
.gate-overlay{position:fixed; inset:0; z-index:40; display:flex; align-items:center; justify-content:center; background:rgba(3,7,10,.86); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); padding:20px;}
.gate-overlay.hidden{display:none;}
.gate-card{width:100%; max-width:360px; background:var(--glass-strong); border:1px solid var(--glass-border); border-radius:20px; padding:30px 24px; text-align:center; box-shadow:var(--shadow-xl);}
.gate-lock{font-size:2rem; margin-bottom:8px;}
.gate-card h2{margin:0 0 4px; font-family:'Space Grotesk','Inter',sans-serif; font-size:1rem; letter-spacing:.08em; text-transform:uppercase; color:var(--text-main);}
.gate-card h2 span{color:var(--accent-secondary);}
.gate-sub{color:var(--text-secondary); font-size:.82rem; margin-bottom:18px;}
.gate-field{text-align:left; margin-bottom:12px;}
.gate-field label{display:block; font-size:.7rem; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text-secondary); margin-bottom:6px;}
.gate-field input{width:100%; padding:12px 13px; border-radius:12px; border:1px solid var(--glass-border); background:var(--input-bg); color:var(--text-main); font:inherit; font-size:.9rem;}
.gate-field input:focus{outline:none; border-color:var(--accent-primary); box-shadow:0 0 0 3px rgba(176,131,255,.15);}
#gateLoginBtn{width:100%; padding:12px; border-radius:12px; border:none; background:var(--accent-gradient); color:#04101c; font:inherit; font-weight:700; font-size:.9rem; cursor:pointer; margin-top:4px;}
#gateLoginBtn:disabled{opacity:.5; cursor:default;}
.gate-msg{font-size:.78rem; margin-top:10px; min-height:1.1em; color:var(--status-bad);}
.stay-overlay{position:fixed; inset:0; background:rgba(3,7,10,.86); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); display:flex; align-items:center; justify-content:center; z-index:45; opacity:0; pointer-events:none; transition:opacity .15s;}
.stay-overlay.visible{opacity:1; pointer-events:auto;}
.stay-card{background:var(--glass-strong); border:1px solid var(--glass-border); border-radius:20px; padding:28px 24px; max-width:340px; width:90%; text-align:center; box-shadow:var(--shadow-xl);}
.stay-card h3{margin:0 0 8px; font-size:1rem;}
.stay-card p{color:var(--text-secondary); font-size:.82rem; margin:0 0 16px;}
.stay-yes-btn{width:100%; padding:12px; border-radius:12px; border:none; background:var(--accent-gradient); color:#04101c; font:inherit; font-weight:700; font-size:.88rem; cursor:pointer; margin-bottom:8px;}
.stay-no-btn{width:100%; padding:11px; border-radius:12px; border:1px solid var(--glass-border); background:transparent; color:var(--text-secondary); font:inherit; font-size:.82rem; cursor:pointer;}`;

const GATE_HTML = `
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
</div>`;

// No audio byte is requested until this succeeds. Auth is the exact same
// tvfs_token session cookie the rest of the site uses (checked via
// /api/protected/{shareId}/login), never a token in this page's URL.
function gateJs(shareId) {
    return `
(function(){
'use strict';
var GATE_API = '/api/protected/' + ${safeScriptJson(shareId)};
var gateOverlay = document.getElementById('gateOverlay');
var gateSub = document.getElementById('gateSub');
var gateForm = document.getElementById('gateForm');
var gateUsername = document.getElementById('gateUsername');
var gatePassword = document.getElementById('gatePassword');
var gateLoginBtn = document.getElementById('gateLoginBtn');
var gateMsg = document.getElementById('gateMsg');
var stayOverlay = document.getElementById('stayOverlay');

function revealPlayer(){
  gateOverlay.classList.add('hidden');
  window.TVFSPlayer.setSource(window.TVFS_PLAYER.audioUrl);
}

function showGateForm(msg){
  gateSub.textContent = 'Log in with your TVFS account to listen.';
  gateForm.classList.remove('hidden');
  gateMsg.textContent = msg || '';
}

async function silentCheck(){
  try {
    var res = await fetch(GATE_API + '/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({})
    });
    if (res.ok) { revealPlayer(); return; }
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
    revealPlayer();
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

// Upgrades the session /login already set (24h) to the persistent 1-year
// one, via the exact same endpoint the main upload page uses.
async function rememberLogin(username, password, remember){
  stayOverlay.classList.remove('visible');
  if (!remember) return;
  try {
    await fetch('/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ username: username, password: password, remember: true })
    });
  } catch (e) { /* playback already works regardless — this is best-effort */ }
}

silentCheck();
})();`;
}

// ─── Page template (shared by the public and the TVFS Users Only player) ────
// opts.share: { shareId } for the gated variant, null for the public one.
function buildPlayerHtml({ audioUrl, originalName, meta, backUrl, share }) {
    const font = fontForBpm(meta.bpm);
    const durationLabel = formatDuration(meta.durationSec);
    const metaBits = formatMetaSummary(meta);
    const title = originalName.replace(/\.[^./]+$/, '');
    const brand = share ? 'TVFS Users Only' : 'TVFS';
    const CLIENT = client();
    const cfg = {
        audioUrl,
        bpm: meta.bpm || null,
        lufs: Number.isFinite(meta.lufs) ? meta.lufs : null,
        gated: !!share,
        icons: { play: ICONS.play, pause: ICONS.pause, volume: ICONS.volume, mute: ICONS.mute },
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#03070a">
<title>${escapeHtml(originalName)} — ${brand} Audio Player</title>
<link rel="stylesheet" href="${FONTS_CSS_URL}">
<style>
:root{ --track-font:${font.stack}; }
${CLIENT.css}
${share ? GATE_CSS : ''}
</style>
</head>
<body>
<canvas id="vis"></canvas>

<header class="topbar">
  <a class="icon-btn back" href="${escapeHtml(backUrl)}" title="Back">${ICONS.back}</a>
  <h1>${share ? 'TVFS Users Only' : 'TVFS'} <span>Audio Player</span></h1>
  <button class="icon-btn" id="btnHelp" title="How to use the player">${ICONS.help}</button>
</header>

<main class="shell">
  <section class="glass player" id="playerCard">
    <div class="disc" id="disc"></div>
    <div class="title" id="title"><span class="mq-inner" id="titleInner">${escapeHtml(title)}</span></div>

    <div class="seekwrap">
      <input type="range" class="seek" id="seek" min="0" max="1000" value="0" aria-label="Seek">
      <div class="times">
        <span id="tElapsed">0:00</span>
        <span id="tRemaining">${durationLabel ? '-' + durationLabel : '-0:00'}</span>
      </div>
    </div>

    <div class="controls">
      <button class="icon-btn" id="btnMute" title="Mute">${ICONS.volume}</button>
      <button class="ctrl-btn" id="btnRestart" title="Back to start">${ICONS.restart}</button>
      <button class="ctrl-btn primary" id="btnPlay" title="Play / Pause">${ICONS.play}</button>
      <button class="ctrl-btn" id="btnStop" title="Stop">${ICONS.stop}</button>
      <button class="icon-btn" id="btnLoop" title="Loop: play the track again and again" aria-pressed="false">${ICONS.loop}</button>
      <button class="icon-btn" id="btnVis" title="Visualizer on/off">${ICONS.disc}</button>
    </div>

    <div class="rowbtns">
      <a class="pill" id="btnDownload" download title="Download original file">${ICONS.download}<span>Download</span></a>
      <button class="pill" id="btnEq" title="Open the EQ">${ICONS.eq}<span>EQ</span></button>
    </div>

    <div class="meta">${escapeHtml(metaBits)}</div>
    <button class="norm-chip hidden" id="btnNorm"></button>
  </section>

  <section class="glass rack" id="rack" aria-label="Sound controls">
    <div class="rack-head">
      <h2>Sound</h2>
      <button class="icon-btn small" id="btnResetAll" title="Reset all sound controls">${ICONS.reset}</button>
    </div>
    <div class="presets" id="presets"></div>
    <div class="rack-groups" id="rackGroups"></div>
  </section>
</main>

<div class="eq-overlay" id="eqOverlay">
  <div class="eq-panel glass" role="dialog" aria-label="Parametric EQ">
    <div class="eq-head">
      <h2>Parametric EQ</h2>
      <div class="eq-head-actions">
        <button class="chip eq-bypass" id="eqBypass" title="Compare with the original sound (A/B)" aria-pressed="false">Bypass</button>
        <button class="icon-btn small" id="eqReset" title="Reset all bands">${ICONS.reset}</button>
        <button class="icon-btn small" id="eqClose" title="Close">${ICONS.close}</button>
      </div>
    </div>
    <div class="eq-body">
      <div class="eq-graph" id="eqGraph"><canvas id="eqCanvas"></canvas></div>
      <div class="eq-strip" id="eqStrip" aria-label="Bands"></div>
    </div>
    <div class="eq-hint" id="eqHint"></div>
    <div class="presets eq-presets" id="eqPresets"></div>
  </div>
</div>
<div class="eq-menu" id="eqMenu" role="menu"></div>
${share ? GATE_HTML : ''}

<audio id="audio" preload="metadata"></audio>

<script type="text/plain" id="workletSrc">${CLIENT.worklets}</script>
<script>window.TVFS_PLAYER = ${safeScriptJson(cfg)};</script>
<script>
${CLIENT.js}
</script>
${share ? `<script>${gateJs(share.shareId)}</script>` : ''}
</body>
</html>`;
}

function generateAudioPlayerHtml(audioUrl, originalName, meta, backUrl) {
    return buildPlayerHtml({ audioUrl, originalName, meta, backUrl: backUrl || '/upload.html', share: null });
}

function generateProtectedAudioPlayerHtml(audioUrl, originalName, meta, shareId, landingUrl) {
    // landingUrl is always present — every protected player belongs to a share
    return buildPlayerHtml({ audioUrl, originalName, meta, backUrl: landingUrl, share: { shareId } });
}

// storedFilename: filename as saved on disk (in files/audio/)
// filePath: absolute path to that file (for ffprobe/aubio)
// playersDir: absolute dir to write the generated player HTML into
function maybeCreateAudioPlayer(storedFilename, originalName, mimeType, filePath, playersDir, publicAudioUrl, backUrl) {
    const isAudio = mimeType && mimeType.split('/')[0] === 'audio';
    if (!isAudio) return null;

    if (!fs.existsSync(playersDir)) fs.mkdirSync(playersDir, { recursive: true });

    const slug = originalName.replace(/\.[^.]+$/, '').replace(/[^\w\-]/g, '_').replace(/_+/g, '_').slice(0, 40) || 'track';
    let meta;
    try {
        meta = analyzeAudio(filePath);
    } catch (e) {
        console.error('⚠️  [AUDIO PLAYER] Metadata/BPM analysis failed:', e.message);
        meta = { codec: null, bitrateKbps: null, sampleRateHz: null, channels: null, durationSec: null, bpm: null };
    }
    meta.lufs = measureLoudness(filePath);

    let html;
    try {
        html = generateAudioPlayerHtml(publicAudioUrl, originalName, meta, backUrl);
    } catch (e) {
        // The upload itself must still succeed, it just gets no player page.
        console.error('⚠️  [AUDIO PLAYER] Player page could not be generated:', e.message);
        return null;
    }
    const { filename: playerFilename, filePath: playerPath } =
        safeFs.writeFileUnique(playersDir, `${slug}_${Date.now()}_player.html`, html);

    return {
        playerFilename,
        playerPath,
        html,
        meta,
        font: fontForBpm(meta.bpm),
    };
}

// TVFS Users Only variant — same BPM/waveform engine, distinct branding,
// and gated: no audio byte, no metadata request, nothing loads until the
// visitor is actually logged in as a TVFS user (checked via the share's
// /login endpoint using the real tvfs_token session cookie).
// contentUrl: the share's /api/protected/{shareId}/file/{index} endpoint.
// landingUrl: the share's landing page, used for the back link.
function maybeCreateProtectedAudioPlayer(originalName, mimeType, filePath, playersDir, contentUrl, shareId, landingUrl) {
    const isAudio = mimeType && mimeType.split('/')[0] === 'audio';
    if (!isAudio) return null;

    if (!fs.existsSync(playersDir)) fs.mkdirSync(playersDir, { recursive: true });

    const slug = originalName.replace(/\.[^.]+$/, '').replace(/[^\w\-]/g, '_').replace(/_+/g, '_').slice(0, 40) || 'track';
    let meta;
    try {
        meta = analyzeAudio(filePath);
    } catch (e) {
        console.error('⚠️  [PROTECTED AUDIO PLAYER] Metadata/BPM analysis failed:', e.message);
        meta = { codec: null, bitrateKbps: null, sampleRateHz: null, channels: null, durationSec: null, bpm: null };
    }
    meta.lufs = measureLoudness(filePath);

    let html;
    try {
        html = generateProtectedAudioPlayerHtml(contentUrl, originalName, meta, shareId, landingUrl);
    } catch (e) {
        console.error('⚠️  [PROTECTED AUDIO PLAYER] Player page could not be generated:', e.message);
        return null;
    }
    // Same-named tracks in one share (different folders) share slug + shareId: never overwrite
    const { filename: playerFilename, filePath: playerPath } =
        safeFs.writeFileUnique(playersDir, `${slug}_${shareId}_player.html`, html);

    return { playerFilename, playerPath, html, meta, font: fontForBpm(meta.bpm) };
}

module.exports = {
    maybeCreateAudioPlayer,
    generateAudioPlayerHtml,
    maybeCreateProtectedAudioPlayer,
    generateProtectedAudioPlayerHtml,
    fontForBpm,
    formatMetaSummary,
    BPM_FONT_LADDER
};
