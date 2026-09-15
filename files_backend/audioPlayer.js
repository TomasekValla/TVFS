'use strict';

const fs = require('fs');
const path = require('path');
const { analyzeAudio } = require('./bpmAnalyzer');

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
    disc: `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>`,
};

// 8 bands for the Fruity-EQ-2-style peaking EQ, roughly log-spaced.
const EQ_BANDS_HZ = [60, 150, 400, 1000, 2500, 6000, 10000, 16000];

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

function generateAudioPlayerHtml(audioUrl, originalName, meta, backUrl) {
    const font = fontForBpm(meta.bpm);
    const durationLabel = formatDuration(meta.durationSec);
    const metaBits = formatMetaSummary(meta);
    const resolvedBackUrl = backUrl || '/upload.html';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#0a0a0a">
<title>${escapeHtml(originalName)} — TVFS Audio Player</title>
<link rel="stylesheet" href="${FONTS_CSS_URL}">
<style>
*,*::before,*::after{box-sizing:border-box;}
:root{
  --bg:#0a0a0a; --fg:#eee; --muted:#9a9a9a; --border:rgba(255,255,255,.14);
  --accent:#2fffc4; --accent2:#7c4dff;
  --glass:rgba(255,255,255,.06); --glass-strong:rgba(20,20,24,.55);
  --track-font:${font.stack};
}
html,body{height:100%;}
body{
  margin:0; background:var(--bg); color:var(--fg); overflow-x:hidden;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  min-height:100vh; display:flex; flex-direction:column; align-items:center;
  position:relative;
}
#waveCanvas{position:fixed; inset:0; width:100%; height:100%; z-index:0; pointer-events:none;}

.topbar{position:relative; z-index:2; width:100%; text-align:center; padding:28px 20px 6px;}
.topbar a.back{position:absolute; left:20px; top:30px; color:var(--muted); display:inline-flex; width:20px; height:20px;}
.topbar a.back svg{width:100%;height:100%;}
.topbar h1{margin:0; font-size:1rem; letter-spacing:.14em; text-transform:uppercase; font-weight:700; color:var(--muted);}
.topbar h1 span{color:var(--accent);}

.stage{position:relative; z-index:2; flex:1; width:100%; display:flex; align-items:center; justify-content:center; padding:24px 16px 60px;}

.card{
  width:100%; max-width:460px;
  background:var(--glass);
  border:1px solid var(--border);
  border-radius:26px;
  backdrop-filter:blur(22px) saturate(140%);
  -webkit-backdrop-filter:blur(22px) saturate(140%);
  box-shadow:0 20px 60px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.08);
  padding:30px 26px 26px;
  display:flex; flex-direction:column; align-items:center; gap:20px;
}

.disc{
  width:120px; height:120px; border-radius:50%;
  background:conic-gradient(from 180deg, var(--accent), var(--accent2), var(--accent));
  display:flex; align-items:center; justify-content:center;
  box-shadow:0 8px 30px rgba(124,77,255,.35), inset 0 0 0 6px rgba(10,10,10,.85);
  position:relative;
}
.disc::after{content:'';position:absolute;width:16px;height:16px;border-radius:50%;background:#0a0a0a;box-shadow:inset 0 0 0 2px rgba(255,255,255,.15);}
.disc.spinning{animation:spin 6s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}

.title{width:100%; overflow:hidden; font-family:var(--track-font); font-weight:700; font-size:1.15rem; text-align:center;}
.title .mq-inner{display:inline-block; white-space:nowrap;}
.title.marquee{-webkit-mask-image:linear-gradient(to right,transparent,black 4%,black 96%,transparent); mask-image:linear-gradient(to right,transparent,black 4%,black 96%,transparent); text-align:left;}
.title.marquee .mq-inner{animation:mq-scroll var(--mq-duration,14s) ease-in-out infinite;}
@keyframes mq-scroll{0%,6%{transform:translateX(0);}50%,56%{transform:translateX(calc(-1 * var(--mq-distance,0px)));}94%,100%{transform:translateX(0);}}

.seekwrap{width:100%; display:flex; flex-direction:column; gap:6px;}
.seek{
  -webkit-appearance:none; appearance:none; width:100%; height:6px; border-radius:99px;
  background:linear-gradient(90deg, var(--accent) 0%, var(--accent) var(--pct,0%), rgba(255,255,255,.12) var(--pct,0%));
  cursor:pointer; outline:none;
}
.seek::-webkit-slider-thumb{-webkit-appearance:none; width:15px; height:15px; border-radius:50%; background:#fff; box-shadow:0 0 0 4px rgba(47,255,196,.25); cursor:grab;}
.seek::-moz-range-thumb{width:15px; height:15px; border-radius:50%; background:#fff; border:none; box-shadow:0 0 0 4px rgba(47,255,196,.25); cursor:grab;}
.times{display:flex; justify-content:space-between; font-size:.72rem; color:var(--muted); font-family:'JetBrains Mono',monospace;}

.controls{display:flex; align-items:center; justify-content:center; gap:18px;}
.ctrl-btn{
  background:var(--glass); border:1px solid var(--border); color:var(--fg);
  width:44px; height:44px; border-radius:50%; display:flex; align-items:center; justify-content:center;
  cursor:pointer; transition:all .15s;
}
.ctrl-btn svg{width:18px; height:18px;}
.ctrl-btn:hover{border-color:var(--accent); color:var(--accent); background:rgba(47,255,196,.1);}
.ctrl-btn.primary{width:58px; height:58px; background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#0a0a0a; border:none;}
.ctrl-btn.primary svg{width:22px; height:22px;}
.ctrl-btn.primary:hover{filter:brightness(1.12); color:#0a0a0a;}

.rowbtns{display:flex; gap:10px; width:100%;}
.pill{
  flex:1; display:flex; align-items:center; justify-content:center; gap:7px;
  padding:11px 14px; border-radius:14px; background:var(--glass); border:1px solid var(--border);
  color:var(--fg); font-size:.78rem; font-weight:700; cursor:pointer; text-decoration:none; transition:all .15s;
}
.pill svg{width:15px; height:15px;}
.pill:hover{border-color:var(--accent); color:var(--accent); background:rgba(47,255,196,.08);}

.volwrap{width:100%; display:flex; align-items:center; gap:10px;}
.vol-mute{
  flex:0 0 auto; width:30px; height:30px; border-radius:50%; background:var(--glass); border:1px solid var(--border);
  color:var(--muted); display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all .15s;
}
.vol-mute svg{width:15px; height:15px;}
.vol-mute:hover{color:var(--accent); border-color:var(--accent);}
.vol-mute.is-muted{color:var(--accent2); border-color:var(--accent2);}
.vol-slider{
  -webkit-appearance:none; appearance:none; flex:1; height:6px; border-radius:99px;
  background:linear-gradient(90deg, var(--accent2) 0%, var(--accent2) var(--vpct,50%), rgba(255,255,255,.12) var(--vpct,50%));
  cursor:pointer; outline:none;
}
.vol-slider::-webkit-slider-thumb{-webkit-appearance:none; width:14px; height:14px; border-radius:50%; background:#fff; box-shadow:0 0 0 4px rgba(124,77,255,.28); cursor:grab;}
.vol-slider::-moz-range-thumb{width:14px; height:14px; border-radius:50%; background:#fff; border:none; box-shadow:0 0 0 4px rgba(124,77,255,.28); cursor:grab;}
.vol-pct{flex:0 0 auto; width:36px; text-align:right; font-size:.68rem; color:var(--muted); font-family:'JetBrains Mono',monospace;}
.vis-toggle{
  flex:0 0 auto; width:30px; height:30px; border-radius:50%; background:var(--glass); border:1px solid var(--border);
  color:var(--muted); display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all .15s;
}
.vis-toggle svg{width:15px; height:15px;}
.vis-toggle:hover{color:var(--accent); border-color:var(--accent);}
.vis-toggle.is-off{color:var(--muted); border-color:var(--border); opacity:.45;}

.meta{margin-top:2px; font-size:.66rem; color:var(--muted); font-family:'JetBrains Mono',monospace; text-align:center; letter-spacing:.01em; word-break:break-word;}

/* ─── EQ popup ─── */
.eq-overlay{position:fixed; inset:0; z-index:10; display:none; align-items:center; justify-content:center; background:rgba(0,0,0,.45); backdrop-filter:blur(3px); padding:16px;}
.eq-overlay.open{display:flex;}
.eq-panel{
  width:100%; max-width:440px; background:var(--glass-strong); border:1px solid var(--border);
  border-radius:22px; backdrop-filter:blur(30px) saturate(160%); -webkit-backdrop-filter:blur(30px) saturate(160%);
  box-shadow:0 24px 70px rgba(0,0,0,.6); padding:20px 18px 24px; position:relative;
}
.eq-head{display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;}
.eq-head h2{margin:0; font-size:.85rem; letter-spacing:.06em; text-transform:uppercase; color:var(--muted);}
.eq-close{width:30px; height:30px; border-radius:50%; background:var(--glass); border:1px solid var(--border); color:var(--fg); display:flex; align-items:center; justify-content:center; cursor:pointer;}
.eq-close svg{width:13px; height:13px;}
.eq-close:hover{color:var(--accent); border-color:var(--accent);}
.eq-canvas-wrap{position:relative; width:100%; aspect-ratio:16/12.5; background:rgba(0,0,0,.35); border:1px solid var(--border); border-radius:14px; overflow:hidden; touch-action:none;}
#eqSvg{width:100%; height:100%; display:block;}
.eq-node{cursor:grab;}
.eq-node:active{cursor:grabbing;}
.eq-tooltip{
  position:absolute; pointer-events:none; transform:translate(-50%,-130%);
  background:rgba(10,10,12,.92); border:1px solid var(--border); border-radius:8px;
  padding:4px 8px; font-size:.68rem; font-family:'JetBrains Mono',monospace; font-weight:700;
  color:#fff; white-space:nowrap; opacity:0; transition:opacity .1s; z-index:5;
}
.eq-tooltip.show{opacity:1;}
.eq-reset{margin-top:14px; width:100%; padding:10px; border-radius:12px; background:var(--glass); border:1px solid var(--border); color:var(--muted); font-size:.72rem; font-weight:700; cursor:pointer;}
.eq-reset:hover{color:var(--accent); border-color:var(--accent);}

@media (max-width:520px){
  .card{padding:24px 18px 20px; border-radius:22px;}
  .disc{width:96px; height:96px;}
  .ctrl-btn{width:40px; height:40px;}
  .ctrl-btn.primary{width:52px; height:52px;}
}
</style>
</head>
<body>
<canvas id="waveCanvas"></canvas>

<div class="topbar">
  <a class="back" href="${escapeHtml(resolvedBackUrl)}" title="Back"></a>
  <h1>TVFS <span>Audio Player</span></h1>
</div>

<div class="stage">
  <div class="card">
    <div class="disc" id="disc"></div>
    <div class="title" id="title"><span class="mq-inner" id="titleInner">${escapeHtml(originalName.replace(/\.[^./]+$/, ''))}</span></div>

    <div class="seekwrap">
      <input type="range" class="seek" id="seek" min="0" max="1000" value="0">
      <div class="times">
        <span id="tElapsed">0:00</span>
        <span id="tRemaining">${durationLabel ? '-' + durationLabel : '-0:00'}</span>
      </div>
    </div>

    <div class="controls">
      <button class="vol-mute" id="btnMute" title="Mute">${ICONS.volume}</button>
      <button class="ctrl-btn" id="btnRestart" title="Back to start">${ICONS.restart}</button>
      <button class="ctrl-btn primary" id="btnPlay" title="Play / Pause">${ICONS.play}</button>
      <button class="ctrl-btn" id="btnStop" title="Stop">${ICONS.stop}</button>
      <button class="vis-toggle" id="btnVis" title="Toggle visualizer">${ICONS.disc}</button>
    </div>

    <div class="rowbtns">
      <a class="pill" id="btnDownload" download title="Download original file">${ICONS.download}<span>Download</span></a>
      <button class="pill" id="btnEq" title="Open EQ">${ICONS.eq}<span>EQ</span></button>
    </div>

    <div class="volwrap">
      <input type="range" class="vol-slider" id="vol" min="0" max="200" value="100">
      <span class="vol-pct" id="volPct">100%</span>
    </div>

    <div class="meta">${escapeHtml(metaBits)}</div>
  </div>
</div>

<div class="eq-overlay" id="eqOverlay">
  <div class="eq-panel">
    <div class="eq-head">
      <h2>8-Band EQ</h2>
      <button class="eq-close" id="eqClose">${ICONS.close}</button>
    </div>
    <div class="eq-canvas-wrap">
      <svg id="eqSvg" viewBox="0 0 400 290" preserveAspectRatio="none"></svg>
      <div class="eq-tooltip" id="eqTooltip"></div>
    </div>
    <button class="eq-reset" id="eqReset">Reset all bands</button>
  </div>
</div>

<audio id="audio" src="${audioUrl}" preload="metadata"></audio>

<script>
(function(){
'use strict';
var audio = document.getElementById('audio');
var btnPlay = document.getElementById('btnPlay');
var btnRestart = document.getElementById('btnRestart');
var btnStop = document.getElementById('btnStop');
var btnDownload = document.getElementById('btnDownload');
var seek = document.getElementById('seek');
var tElapsed = document.getElementById('tElapsed');
var tRemaining = document.getElementById('tRemaining');
var disc = document.getElementById('disc');
var canvas = document.getElementById('waveCanvas');
var ctx = canvas.getContext('2d');

var AUDIO_URL = ${safeScriptJson(audioUrl)};
var TRACK_BPM = ${safeScriptJson(meta.bpm)};
btnDownload.href = AUDIO_URL;

var ICON_PLAY = ${safeScriptJson(ICONS.play)};
var ICON_PAUSE = ${safeScriptJson(ICONS.pause)};

function setupTitleMarquee(){
  var titleEl = document.getElementById('title');
  var inner = document.getElementById('titleInner');
  requestAnimationFrame(function(){
    var overflow = inner.scrollWidth - titleEl.clientWidth;
    if (overflow > 4){
      titleEl.classList.add('marquee');
      titleEl.style.setProperty('--mq-distance', overflow + 'px');
      titleEl.style.setProperty('--mq-duration', Math.max(6, overflow / 22) + 's');
    } else {
      titleEl.classList.remove('marquee');
    }
  });
}
setupTitleMarquee();
window.addEventListener('resize', setupTitleMarquee);


function fmt(s){
  if(!isFinite(s) || s<0) s=0;
  var m=Math.floor(s/60), sec=Math.floor(s%60);
  return m+':'+String(sec).padStart(2,'0');
}

function updateSeekUI(){
  var dur = audio.duration || 0;
  var cur = audio.currentTime || 0;
  var pct = dur ? (cur/dur*1000) : 0;
  seek.value = pct;
  seek.style.setProperty('--pct', (dur ? cur/dur*100 : 0)+'%');
  tElapsed.textContent = fmt(cur);
  tRemaining.textContent = '-' + fmt(dur - cur);
}

audio.addEventListener('loadedmetadata', updateSeekUI);
audio.addEventListener('timeupdate', updateSeekUI);
audio.addEventListener('play', function(){ btnPlay.innerHTML = ICON_PAUSE; disc.classList.add('spinning'); });
audio.addEventListener('pause', function(){ btnPlay.innerHTML = ICON_PLAY; disc.classList.remove('spinning'); });
audio.addEventListener('ended', function(){ btnPlay.innerHTML = ICON_PLAY; disc.classList.remove('spinning'); });

btnPlay.addEventListener('click', function(){
  ensureAudioGraph();
  if (audio.paused) audio.play(); else audio.pause();
});
btnRestart.addEventListener('click', function(){ audio.currentTime = 0; updateSeekUI(); });
btnStop.addEventListener('click', function(){ audio.pause(); audio.currentTime = 0; updateSeekUI(); });

var seeking = false;
seek.addEventListener('input', function(){
  seeking = true;
  var dur = audio.duration || 0;
  var t = (seek.value/1000)*dur;
  tElapsed.textContent = fmt(t);
  tRemaining.textContent = '-' + fmt(dur - t);
  seek.style.setProperty('--pct', (dur ? t/dur*100 : 0)+'%');
});
seek.addEventListener('change', function(){
  var dur = audio.duration || 0;
  audio.currentTime = (seek.value/1000)*dur;
  seeking = false;
});

// ─── Web Audio graph: source -> 8-band EQ -> analyser -> destination ──────
var audioCtx, srcNode, analyser, gainNode, eqFilters = [], graphReady = false;
var EQ_BANDS = ${safeScriptJson(EQ_BANDS_HZ)};

function ensureAudioGraph(){
  if (graphReady) { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); return; }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    srcNode = audioCtx.createMediaElementSource(audio);

    eqFilters = EQ_BANDS.map(function(freq, i){
      var f = audioCtx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1.1;
      f.gain.value = 0;
      return f;
    });

    // Gain node sits after the EQ so the volume slider can go past 100%
    // (native audio.volume caps at 1.0 — this is the only way to boost).
    gainNode = audioCtx.createGain();
    gainNode.gain.value = currentVolume;

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;

    var node = srcNode;
    eqFilters.forEach(function(f){ node.connect(f); node = f; });
    node.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(audioCtx.destination);

    // Some browsers still hand back a 'suspended' context even inside a
    // user-gesture click handler — explicitly kick it awake.
    if (audioCtx.state === 'suspended') audioCtx.resume();

    graphReady = true;
  } catch (err) {
    // If this fails (blocked autoplay policy, odd browser, etc.) playback
    // itself must still work — just without visualizer/EQ/volume-boost.
    // Below-100% volume still works via audio.volume in applyVolume().
    console.error('[TVFS Audio Player] Web Audio graph setup failed — playback will continue, but the visualizer/EQ/volume-boost won\\'t react:', err);
    analyser = null;
    graphReady = false;
  }
}

// ─── Volume / mute ──────────────────────────────────────────────────────
// currentVolume is 0..2 (0%..200%). Native <audio>.volume only covers
// 0..1, so above 1.0 we lean on the gain node above; below/at 1.0 we set
// both, so volume still works even if the Web Audio graph never spins up.
var vol = document.getElementById('vol');
var volPct = document.getElementById('volPct');
var btnMute = document.getElementById('btnMute');
var ICON_VOLUME = ${safeScriptJson(ICONS.volume)};
var ICON_MUTE = ${safeScriptJson(ICONS.mute)};
var currentVolume = 1;
var volumeBeforeMute = 1;

function applyVolume(v){
  currentVolume = Math.max(0, Math.min(2, v));
  audio.volume = Math.min(currentVolume, 1);
  if (gainNode) gainNode.gain.value = currentVolume;
  vol.value = Math.round(currentVolume * 100);
  vol.style.setProperty('--vpct', (currentVolume / 2 * 100) + '%');
  volPct.textContent = Math.round(currentVolume * 100) + '%';
  var muted = currentVolume === 0;
  btnMute.classList.toggle('is-muted', muted);
  btnMute.innerHTML = muted ? ICON_MUTE : ICON_VOLUME;
}
applyVolume(1);

vol.addEventListener('input', function(){
  applyVolume(vol.value / 100);
});

btnMute.addEventListener('click', function(){
  if (currentVolume > 0) {
    volumeBeforeMute = currentVolume;
    applyVolume(0);
  } else {
    applyVolume(volumeBeforeMute || 1);
  }
});

// ─── Visualizer on/off toggle ──────────────────────────────────────────
var btnVis = document.getElementById('btnVis');
var visualizerOn = true;
btnVis.addEventListener('click', function(){
  visualizerOn = !visualizerOn;
  btnVis.classList.toggle('is-off', !visualizerOn);
  if (!visualizerOn) {
    waves = []; // clean slate so it doesn't jump back mid-animation on re-enable
    ctx.clearRect(0, 0, W, H);
  }
});

// ─── EQ popup: 8 draggable nodes, Fruity-EQ-2 style ────────────────────────
var eqOverlay = document.getElementById('eqOverlay');
var eqSvg = document.getElementById('eqSvg');
var eqTooltip = document.getElementById('eqTooltip');
var eqWrap = document.querySelector('.eq-canvas-wrap');
var VBW = 400, VBH = 290, PAD = 20, PAD_TOP = 16, PAD_BOTTOM = 34;
var nodes = [];

function freqToX(freq){
  var minF = 20, maxF = 20000;
  var lx = (Math.log(freq)-Math.log(minF))/(Math.log(maxF)-Math.log(minF));
  return PAD + lx*(VBW-PAD*2);
}
function xToFreq(x){
  var minF = 20, maxF = 20000;
  var lx = (x-PAD)/(VBW-PAD*2);
  lx = Math.max(0, Math.min(1, lx));
  return Math.exp(Math.log(minF) + lx*(Math.log(maxF)-Math.log(minF)));
}
function gainToY(gain){ // gain range -15..15
  var t = (gain+15)/30;
  return (VBH-PAD_BOTTOM) - t*((VBH-PAD_BOTTOM)-PAD_TOP);
}
function yToGain(y){
  var t = ((VBH-PAD_BOTTOM)-y)/((VBH-PAD_BOTTOM)-PAD_TOP);
  t = Math.max(0, Math.min(1, t));
  return t*30-15;
}
function fmtFreq(f){
  return f>=1000 ? (Math.round(f/100)/10)+'k' : Math.round(f)+'Hz';
}
function fmtGain(g){
  var r = Math.round(g*10)/10;
  return (r>0?'+':'')+r+'dB';
}

// Catmull-Rom -> cubic bezier, so the response curve reads like a taut
// string between the pegs instead of a stiff polyline.
function splinePath(pts){
  if (pts.length < 2) return '';
  var d = 'M'+pts[0].x+','+pts[0].y;
  for (var i=0; i<pts.length-1; i++){
    var p0 = pts[i-1] || pts[i];
    var p1 = pts[i];
    var p2 = pts[i+1];
    var p3 = pts[i+2] || p2;
    var c1x = p1.x + (p2.x - p0.x)/6;
    var c1y = p1.y + (p2.y - p0.y)/6;
    var c2x = p2.x - (p3.x - p1.x)/6;
    var c2y = p2.y - (p3.y - p1.y)/6;
    d += ' C'+c1x+','+c1y+' '+c2x+','+c2y+' '+p2.x+','+p2.y;
  }
  return d;
}

function buildEqSvg(){
  eqSvg.setAttribute('viewBox','0 0 '+VBW+' '+VBH);
  eqSvg.innerHTML = '';
  var ns = 'http://www.w3.org/2000/svg';

  // gridlines (gain)
  var grid = document.createElementNS(ns,'g');
  [0.25,0.5,0.75].forEach(function(t){
    var y = PAD_TOP + t*((VBH-PAD_BOTTOM)-PAD_TOP);
    var line = document.createElementNS(ns,'line');
    line.setAttribute('x1',PAD); line.setAttribute('x2',VBW-PAD);
    line.setAttribute('y1',y); line.setAttribute('y2',y);
    line.setAttribute('stroke','rgba(255,255,255,.08)'); line.setAttribute('stroke-width','1');
    grid.appendChild(line);
  });
  var zero = document.createElementNS(ns,'line');
  zero.setAttribute('x1',PAD); zero.setAttribute('x2',VBW-PAD);
  zero.setAttribute('y1',gainToY(0)); zero.setAttribute('y2',gainToY(0));
  zero.setAttribute('stroke','rgba(47,255,196,.35)'); zero.setAttribute('stroke-width','1.2');
  grid.appendChild(zero);
  eqSvg.appendChild(grid);

  // static frequency axis labels along the bottom
  var axis = document.createElementNS(ns,'g');
  EQ_BANDS.forEach(function(freq){
    var t = document.createElementNS(ns,'text');
    t.textContent = fmtFreq(freq);
    t.setAttribute('x', freqToX(freq));
    t.setAttribute('y', VBH-14);
    t.setAttribute('text-anchor','middle');
    t.setAttribute('fill','rgba(255,255,255,.4)');
    t.setAttribute('font-size','10');
    t.setAttribute('font-family','JetBrains Mono, monospace');
    axis.appendChild(t);
  });
  eqSvg.appendChild(axis);

  // response curve — smooth spline "string" through the nodes
  var defs = document.createElementNS(ns,'defs');
  defs.innerHTML = '<linearGradient id="eqGrad" x1="0" y1="0" x2="1" y2="0">'+
    '<stop offset="0%" stop-color="#2fffc4"/><stop offset="100%" stop-color="#7c4dff"/></linearGradient>';
  eqSvg.appendChild(defs);

  var curveGlow = document.createElementNS(ns,'path');
  curveGlow.setAttribute('fill','none');
  curveGlow.setAttribute('stroke','url(#eqGrad)');
  curveGlow.setAttribute('stroke-width','7');
  curveGlow.setAttribute('opacity','0.18');
  curveGlow.setAttribute('id','eqCurveGlow');
  eqSvg.appendChild(curveGlow);

  var curve = document.createElementNS(ns,'path');
  curve.setAttribute('fill','none');
  curve.setAttribute('stroke','url(#eqGrad)');
  curve.setAttribute('stroke-width','2.4');
  curve.setAttribute('id','eqCurve');
  eqSvg.appendChild(curve);

  nodes = EQ_BANDS.map(function(freq, i){
    var g = document.createElementNS(ns,'g');
    g.setAttribute('class','eq-node');
    var circ = document.createElementNS(ns,'circle');
    circ.setAttribute('r','9');
    circ.setAttribute('fill', i%2 ? '#7c4dff' : '#2fffc4');
    circ.setAttribute('stroke','#0a0a0a');
    circ.setAttribute('stroke-width','2');
    var label = document.createElementNS(ns,'text');
    label.textContent = String(i+1);
    label.setAttribute('text-anchor','middle');
    label.setAttribute('dy','4');
    label.setAttribute('fill','#0a0a0a');
    label.setAttribute('font-size','9');
    label.setAttribute('font-weight','700');
    label.setAttribute('font-family','JetBrains Mono, monospace');
    label.setAttribute('pointer-events','none');
    g.appendChild(circ);
    g.appendChild(label);
    eqSvg.appendChild(g);
    return { freq: freq, gain: 0, el: g, circ: circ, label: label, baseFreq: freq, vy: 0 };
  });

  updateEqVisual();
  attachDrag();
}

function curvePoints(){
  return nodes.map(function(n){ return { x: freqToX(n.freq), y: gainToY(n.gain) }; });
}

function updateEqVisual(){
  nodes.forEach(function(n){
    var x = freqToX(n.freq), y = gainToY(n.gain);
    n.el.setAttribute('transform','translate('+x+','+y+')');
  });
  var d = splinePath(curvePoints());
  var curve = document.getElementById('eqCurve');
  var glow = document.getElementById('eqCurveGlow');
  if (curve) curve.setAttribute('d', d);
  if (glow) glow.setAttribute('d', d);
  nodes.forEach(function(n, i){
    var f = eqFilters[i];
    if (!f || !audioCtx) return;
    // Scheduled ramps instead of raw ".value =" — plain value assignment on
    // an AudioParam of a node that's actively processing audio can get
    // coalesced/dropped by some browsers during fast successive updates
    // (exactly what a drag gesture produces). A short ramp guarantees each
    // change actually lands, and dodges any audible clicking too.
    var now = audioCtx.currentTime;
    try {
      f.frequency.cancelScheduledValues(now);
      f.frequency.setValueAtTime(f.frequency.value, now);
      f.frequency.linearRampToValueAtTime(n.freq, now + 0.045);
      f.gain.cancelScheduledValues(now);
      f.gain.setValueAtTime(f.gain.value, now);
      f.gain.linearRampToValueAtTime(n.gain, now + 0.045);
    } catch (e) {
      // Fallback for older engines without full AudioParam automation support
      f.frequency.value = n.freq;
      f.gain.value = n.gain;
    }
  });
}

function showTooltip(node){
  var x = freqToX(node.freq), y = gainToY(node.gain);
  var rect = eqWrap.getBoundingClientRect();
  eqTooltip.textContent = fmtFreq(node.freq) + '  ' + fmtGain(node.gain);
  eqTooltip.style.left = (x/VBW*rect.width) + 'px';
  eqTooltip.style.top = (y/VBH*rect.height) + 'px';
  eqTooltip.classList.add('show');
}
function hideTooltip(){ eqTooltip.classList.remove('show'); }

// Little spring "pluck" settle when a node is released — slight overshoot
// past the resting gain, like letting go of a stretched EQ string.
function springSettle(node){
  var target = node.gain;
  var v = node.vy || (node._lastDelta || 0) * 0.6;
  var pos = target - v;
  var stiffness = 0.35, damping = 0.62;
  var frames = 0;
  function step(){
    frames++;
    var force = (target - pos) * stiffness;
    v = v * damping + force;
    pos += v;
    node.gain = pos;
    updateEqVisual();
    if (Math.abs(v) > 0.02 && frames < 60){
      requestAnimationFrame(step);
    } else {
      node.gain = target;
      updateEqVisual();
    }
  }
  requestAnimationFrame(step);
}

function attachDrag(){
  var active = null, lastGain = 0;
  function ptFromEvent(evt){
    var rect = eqSvg.getBoundingClientRect();
    var cx = (evt.touches ? evt.touches[0].clientX : evt.clientX) - rect.left;
    var cy = (evt.touches ? evt.touches[0].clientY : evt.clientY) - rect.top;
    return { x: cx/rect.width*VBW, y: cy/rect.height*VBH };
  }
  nodes.forEach(function(n){
    var start = function(evt){
      evt.preventDefault();
      ensureAudioGraph();
      active = n;
      lastGain = n.gain;
      showTooltip(n);
    };
    n.el.addEventListener('mousedown', start);
    n.el.addEventListener('touchstart', start, { passive:false });
  });
  function move(evt){
    if (!active) return;
    evt.preventDefault();
    var p = ptFromEvent(evt);
    var i = nodes.indexOf(active);
    var lo = i===0 ? 20 : nodes[i-1].baseFreq*1.15;
    var hi = i===nodes.length-1 ? 20000 : nodes[i+1].baseFreq*0.87;
    var freq = Math.max(lo, Math.min(hi, xToFreq(p.x)));
    var newGain = yToGain(p.y);
    active._lastDelta = newGain - active.gain;
    active.freq = freq;
    active.gain = newGain;
    updateEqVisual();
    showTooltip(active);
  }
  function end(){
    if (active) springSettle(active);
    active = null;
    hideTooltip();
  }
  window.addEventListener('mousemove', move);
  window.addEventListener('touchmove', move, { passive:false });
  window.addEventListener('mouseup', end);
  window.addEventListener('touchend', end);
}

document.getElementById('btnEq').addEventListener('click', function(){
  ensureAudioGraph();
  if (!nodes.length) buildEqSvg();
  eqOverlay.classList.add('open');
});
document.getElementById('eqClose').addEventListener('click', function(){ eqOverlay.classList.remove('open'); });
eqOverlay.addEventListener('click', function(e){ if (e.target === eqOverlay) eqOverlay.classList.remove('open'); });
document.getElementById('eqReset').addEventListener('click', function(){
  nodes.forEach(function(n){ n.freq = n.baseFreq; n.gain = 0; });
  updateEqVisual();
});

// ─── Wave visualizer ────────────────────────────────────────────────────────
// Turquoise <-> purple (and everything between) rings that spawn on
// detected beats/transients and expand outward from the card's center at a
// speed proportional to how strong the hit was. Faster rings naturally
// overtake slower older ones — that IS the "collision" the physical
// propagation gives you for free. Runs continuously, playing or paused,
// so the page never goes visually dead.
var waves = [];
var W, H, cx, cy, maxReach, screenScale;
function resize(){
  W = canvas.width = window.innerWidth * devicePixelRatio;
  H = canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = window.innerWidth+'px';
  canvas.style.height = window.innerHeight+'px';
  cx = W/2; cy = H*0.4;
  maxReach = Math.sqrt(W*W + H*H) * 0.62; // reaches well past the edges, esp. on wide desktop screens
  screenScale = Math.max(1, Math.min(window.innerWidth, window.innerHeight) / 700);
}
window.addEventListener('resize', resize);
resize();

var prevLowEnergy = 0;
var fluxAvg = 0.015;
var bpmHint = TRACK_BPM || 110;
// Faster BPM tracks => quicker beat cadence => rings must be allowed to
// spawn more often, and travel a bit faster to match the felt tempo.
var spawnCooldownMs = Math.max(140, 60000 / bpmHint * 0.65);
var lastSpawn = 0;
var huePhase = Math.random()*360;

function spawnWave(strength, opts){
  opts = opts || {};
  huePhase = (huePhase + 18 + Math.random()*40) % 360;
  // Wide, lively palette: sweeps across turquoise -> violet -> magenta and
  // back, instead of sitting in one narrow band.
  var hue = 150 + (Math.sin(huePhase*Math.PI/180)*0.5+0.5) * 160; // ~150..310
  waves.push({
    r: 4 * devicePixelRatio,
    speed: (2.6 + strength*13) * devicePixelRatio * screenScale,
    alpha: Math.min(0.75, 0.24 + strength*0.62),
    width: (1.6 + strength*5.5) * devicePixelRatio,
    hue: hue,
    sat: 90 + Math.random()*10,
    light: 58 + Math.random()*14
  });
  if (waves.length > 70) waves.shift();

  // Strong hits get a fast inner echo ring chasing the first one — the
  // "collision" reads much more clearly with two rings of different speed.
  if (strength > 0.35 && !opts.isEcho){
    setTimeout(function(){ spawnWave(strength*0.6, { isEcho:true }); }, 70);
  }
}

var freqData = new Uint8Array(256);

function tick(){
  requestAnimationFrame(tick);
  ctx.clearRect(0,0,W,H);
  if (!visualizerOn) return;

  var now = performance.now();
  var playing = analyser && !audio.paused;

  if (playing){
    analyser.getByteFrequencyData(freqData);
    // low-band energy = kick/bass-driven signal
    var lowSum = 0, n = Math.floor(freqData.length*0.18);
    for (var i=0;i<n;i++) lowSum += freqData[i];
    var lowEnergy = lowSum / (n*255);

    // Spectral-flux onset detection: react to how much LOUDER things just
    // got (positive-only delta), not to absolute loudness. A plain
    // "current vs. running average of loudness itself" comparison self-
    // defeats on sustained bass — the average catches up to match the
    // beat's own level within a couple of hits and then nothing ever
    // clears the threshold again (which was exactly the "one wave and then
    // silence" bug). Flux stays near zero between hits regardless of how
    // loud the track is, so every new transient still stands out cleanly.
    var flux = Math.max(0, lowEnergy - prevLowEnergy);
    prevLowEnergy = lowEnergy;
    fluxAvg = fluxAvg*0.94 + flux*0.06;

    if (flux > fluxAvg*2.1 + 0.012 && now - lastSpawn > spawnCooldownMs){
      spawnWave(Math.min(1, flux*9));
      lastSpawn = now;
    }
  } else {
    prevLowEnergy = 0;
  }
  // No sound -> no waves. Paused/silent means the canvas just lets whatever
  // rings are already in flight finish fading out, nothing new spawns.

  for (var w=waves.length-1; w>=0; w--){
    var wv = waves[w];
    wv.r += wv.speed;
    wv.alpha *= 0.982;
    if (wv.alpha < 0.008 || wv.r > maxReach){ waves.splice(w,1); continue; }

    ctx.beginPath();
    ctx.arc(cx, cy, wv.r, 0, Math.PI*2);
    ctx.strokeStyle = 'hsla('+wv.hue+','+wv.sat+'%,'+wv.light+'%,'+wv.alpha+')';
    ctx.lineWidth = wv.width;
    ctx.shadowColor = 'hsla('+wv.hue+',95%,62%,0.75)';
    ctx.shadowBlur = 18*devicePixelRatio;
    ctx.stroke();

    // faint inner glow fill for richness on the freshest, strongest rings
    if (wv.alpha > 0.3){
      ctx.beginPath();
      ctx.arc(cx, cy, wv.r, 0, Math.PI*2);
      ctx.strokeStyle = 'hsla('+wv.hue+',100%,80%,'+(wv.alpha*0.35)+')';
      ctx.lineWidth = wv.width*2.4;
      ctx.shadowBlur = 0;
      ctx.stroke();
    }
  }
}
requestAnimationFrame(tick);

})();
</script>
</body>

</html>`;
}

function generateProtectedAudioPlayerHtml(audioUrl, originalName, meta, shareId, landingUrl) {
    const font = fontForBpm(meta.bpm);
    const durationLabel = formatDuration(meta.durationSec);
    const metaBits = formatMetaSummary(meta);
    const resolvedLandingUrl = landingUrl; // always present — every protected player belongs to a share

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#0a0a0a">
<title>${escapeHtml(originalName)} — TVFS Users Only Audio Player</title>
<link rel="stylesheet" href="${FONTS_CSS_URL}">
<style>
*,*::before,*::after{box-sizing:border-box;}
:root{
  --bg:#0a0a0a; --fg:#eee; --muted:#9a9a9a; --border:rgba(255,255,255,.14);
  --accent:#2fffc4; --accent2:#7c4dff;
  --glass:rgba(255,255,255,.06); --glass-strong:rgba(20,20,24,.55);
  --track-font:${font.stack};
}
html,body{height:100%;}
body{
  margin:0; background:var(--bg); color:var(--fg); overflow-x:hidden;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  min-height:100vh; display:flex; flex-direction:column; align-items:center;
  position:relative;
}
#waveCanvas{position:fixed; inset:0; width:100%; height:100%; z-index:0; pointer-events:none;}

.topbar{position:relative; z-index:2; width:100%; text-align:center; padding:28px 20px 6px;}
.topbar a.back{position:absolute; left:20px; top:30px; color:var(--muted); display:inline-flex; width:20px; height:20px;}
.topbar a.back svg{width:100%;height:100%;}
.topbar h1{margin:0; font-size:1rem; letter-spacing:.14em; text-transform:uppercase; font-weight:700; color:var(--muted);}
.topbar h1 span{color:var(--accent);}

.stage{position:relative; z-index:2; flex:1; width:100%; display:flex; align-items:center; justify-content:center; padding:24px 16px 60px;}

.card{
  width:100%; max-width:460px;
  background:var(--glass);
  border:1px solid var(--border);
  border-radius:26px;
  backdrop-filter:blur(22px) saturate(140%);
  -webkit-backdrop-filter:blur(22px) saturate(140%);
  box-shadow:0 20px 60px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.08);
  padding:30px 26px 26px;
  display:flex; flex-direction:column; align-items:center; gap:20px;
}

.disc{
  width:120px; height:120px; border-radius:50%;
  background:conic-gradient(from 180deg, var(--accent), var(--accent2), var(--accent));
  display:flex; align-items:center; justify-content:center;
  box-shadow:0 8px 30px rgba(124,77,255,.35), inset 0 0 0 6px rgba(10,10,10,.85);
  position:relative;
}
.disc::after{content:'';position:absolute;width:16px;height:16px;border-radius:50%;background:#0a0a0a;box-shadow:inset 0 0 0 2px rgba(255,255,255,.15);}
.disc.spinning{animation:spin 6s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}

.title{width:100%; overflow:hidden; font-family:var(--track-font); font-weight:700; font-size:1.15rem; text-align:center;}
.title .mq-inner{display:inline-block; white-space:nowrap;}
.title.marquee{-webkit-mask-image:linear-gradient(to right,transparent,black 4%,black 96%,transparent); mask-image:linear-gradient(to right,transparent,black 4%,black 96%,transparent); text-align:left;}
.title.marquee .mq-inner{animation:mq-scroll var(--mq-duration,14s) ease-in-out infinite;}
@keyframes mq-scroll{0%,6%{transform:translateX(0);}50%,56%{transform:translateX(calc(-1 * var(--mq-distance,0px)));}94%,100%{transform:translateX(0);}}

.seekwrap{width:100%; display:flex; flex-direction:column; gap:6px;}
.seek{
  -webkit-appearance:none; appearance:none; width:100%; height:6px; border-radius:99px;
  background:linear-gradient(90deg, var(--accent) 0%, var(--accent) var(--pct,0%), rgba(255,255,255,.12) var(--pct,0%));
  cursor:pointer; outline:none;
}
.seek::-webkit-slider-thumb{-webkit-appearance:none; width:15px; height:15px; border-radius:50%; background:#fff; box-shadow:0 0 0 4px rgba(47,255,196,.25); cursor:grab;}
.seek::-moz-range-thumb{width:15px; height:15px; border-radius:50%; background:#fff; border:none; box-shadow:0 0 0 4px rgba(47,255,196,.25); cursor:grab;}
.times{display:flex; justify-content:space-between; font-size:.72rem; color:var(--muted); font-family:'JetBrains Mono',monospace;}

.controls{display:flex; align-items:center; justify-content:center; gap:18px;}
.ctrl-btn{
  background:var(--glass); border:1px solid var(--border); color:var(--fg);
  width:44px; height:44px; border-radius:50%; display:flex; align-items:center; justify-content:center;
  cursor:pointer; transition:all .15s;
}
.ctrl-btn svg{width:18px; height:18px;}
.ctrl-btn:hover{border-color:var(--accent); color:var(--accent); background:rgba(47,255,196,.1);}
.ctrl-btn.primary{width:58px; height:58px; background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#0a0a0a; border:none;}
.ctrl-btn.primary svg{width:22px; height:22px;}
.ctrl-btn.primary:hover{filter:brightness(1.12); color:#0a0a0a;}

.rowbtns{display:flex; gap:10px; width:100%;}
.pill{
  flex:1; display:flex; align-items:center; justify-content:center; gap:7px;
  padding:11px 14px; border-radius:14px; background:var(--glass); border:1px solid var(--border);
  color:var(--fg); font-size:.78rem; font-weight:700; cursor:pointer; text-decoration:none; transition:all .15s;
}
.pill svg{width:15px; height:15px;}
.pill:hover{border-color:var(--accent); color:var(--accent); background:rgba(47,255,196,.08);}

.volwrap{width:100%; display:flex; align-items:center; gap:10px;}
.vol-mute{
  flex:0 0 auto; width:30px; height:30px; border-radius:50%; background:var(--glass); border:1px solid var(--border);
  color:var(--muted); display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all .15s;
}
.vol-mute svg{width:15px; height:15px;}
.vol-mute:hover{color:var(--accent); border-color:var(--accent);}
.vol-mute.is-muted{color:var(--accent2); border-color:var(--accent2);}
.vol-slider{
  -webkit-appearance:none; appearance:none; flex:1; height:6px; border-radius:99px;
  background:linear-gradient(90deg, var(--accent2) 0%, var(--accent2) var(--vpct,50%), rgba(255,255,255,.12) var(--vpct,50%));
  cursor:pointer; outline:none;
}
.vol-slider::-webkit-slider-thumb{-webkit-appearance:none; width:14px; height:14px; border-radius:50%; background:#fff; box-shadow:0 0 0 4px rgba(124,77,255,.28); cursor:grab;}
.vol-slider::-moz-range-thumb{width:14px; height:14px; border-radius:50%; background:#fff; border:none; box-shadow:0 0 0 4px rgba(124,77,255,.28); cursor:grab;}
.vol-pct{flex:0 0 auto; width:36px; text-align:right; font-size:.68rem; color:var(--muted); font-family:'JetBrains Mono',monospace;}
.vis-toggle{
  flex:0 0 auto; width:30px; height:30px; border-radius:50%; background:var(--glass); border:1px solid var(--border);
  color:var(--muted); display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all .15s;
}
.vis-toggle svg{width:15px; height:15px;}
.vis-toggle:hover{color:var(--accent); border-color:var(--accent);}
.vis-toggle.is-off{color:var(--muted); border-color:var(--border); opacity:.45;}

.meta{margin-top:2px; font-size:.66rem; color:var(--muted); font-family:'JetBrains Mono',monospace; text-align:center; letter-spacing:.01em; word-break:break-word;}

/* ─── EQ popup ─── */
.eq-overlay{position:fixed; inset:0; z-index:10; display:none; align-items:center; justify-content:center; background:rgba(0,0,0,.45); backdrop-filter:blur(3px); padding:16px;}
.eq-overlay.open{display:flex;}
.eq-panel{
  width:100%; max-width:440px; background:var(--glass-strong); border:1px solid var(--border);
  border-radius:22px; backdrop-filter:blur(30px) saturate(160%); -webkit-backdrop-filter:blur(30px) saturate(160%);
  box-shadow:0 24px 70px rgba(0,0,0,.6); padding:20px 18px 24px; position:relative;
}
.eq-head{display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;}
.eq-head h2{margin:0; font-size:.85rem; letter-spacing:.06em; text-transform:uppercase; color:var(--muted);}
.eq-close{width:30px; height:30px; border-radius:50%; background:var(--glass); border:1px solid var(--border); color:var(--fg); display:flex; align-items:center; justify-content:center; cursor:pointer;}
.eq-close svg{width:13px; height:13px;}
.eq-close:hover{color:var(--accent); border-color:var(--accent);}
.eq-canvas-wrap{position:relative; width:100%; aspect-ratio:16/12.5; background:rgba(0,0,0,.35); border:1px solid var(--border); border-radius:14px; overflow:hidden; touch-action:none;}
#eqSvg{width:100%; height:100%; display:block;}
.eq-node{cursor:grab;}
.eq-node:active{cursor:grabbing;}
.eq-tooltip{
  position:absolute; pointer-events:none; transform:translate(-50%,-130%);
  background:rgba(10,10,12,.92); border:1px solid var(--border); border-radius:8px;
  padding:4px 8px; font-size:.68rem; font-family:'JetBrains Mono',monospace; font-weight:700;
  color:#fff; white-space:nowrap; opacity:0; transition:opacity .1s; z-index:5;
}
.eq-tooltip.show{opacity:1;}
.eq-reset{margin-top:14px; width:100%; padding:10px; border-radius:12px; background:var(--glass); border:1px solid var(--border); color:var(--muted); font-size:.72rem; font-weight:700; cursor:pointer;}
.eq-reset:hover{color:var(--accent); border-color:var(--accent);}

/* ─── Login gate (TVFS Users Only) ─── */
.gate-overlay{position:fixed; inset:0; z-index:20; display:flex; align-items:center; justify-content:center; background:rgba(10,10,10,.86); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); padding:20px;}
.gate-overlay.hidden{display:none;}
.gate-card{width:100%; max-width:360px; background:var(--glass-strong); border:1px solid var(--border); border-radius:22px; padding:30px 24px; text-align:center; box-shadow:0 24px 70px rgba(0,0,0,.6);}
.gate-lock{font-size:2rem; margin-bottom:8px;}
.gate-card h2{margin:0 0 4px; font-size:.95rem; letter-spacing:.1em; text-transform:uppercase; color:var(--fg); font-weight:700;}
.gate-card h2 span{color:var(--accent);}
.gate-sub{color:var(--muted); font-size:.8rem; margin-bottom:18px;}
.gate-field{text-align:left; margin-bottom:12px;}
.gate-field label{display:block; font-size:.72rem; color:var(--muted); margin-bottom:5px;}
.gate-field input{width:100%; padding:10px 11px; border-radius:9px; border:1px solid var(--border); background:rgba(0,0,0,.4); color:var(--fg); font-size:.9rem; box-sizing:border-box;}
.gate-field input:focus{outline:none; border-color:var(--accent);}
#gateLoginBtn{width:100%; padding:11px; border-radius:9px; border:none; background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#0a0a0a; font-weight:700; font-size:.86rem; cursor:pointer; margin-top:4px;}
#gateLoginBtn:disabled{opacity:.5; cursor:default;}
.gate-msg{font-size:.76rem; margin-top:10px; min-height:1.1em; color:#ff6b6b;}
.hidden{display:none !important;}

.stay-overlay{position:fixed; inset:0; background:rgba(10,10,10,.86); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); display:flex; align-items:center; justify-content:center; z-index:25; opacity:0; pointer-events:none; transition:opacity .15s;}
.stay-overlay.visible{opacity:1; pointer-events:auto;}
.stay-card{background:var(--glass-strong); border:1px solid var(--border); border-radius:22px; padding:28px 24px; max-width:340px; width:90%; text-align:center; box-shadow:0 24px 70px rgba(0,0,0,.6);}
.stay-card h3{margin:0 0 8px; font-size:1rem;}
.stay-card p{color:var(--muted); font-size:.8rem; margin:0 0 16px;}
.stay-yes-btn{width:100%; padding:11px; border-radius:9px; border:none; background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#0a0a0a; font-weight:700; font-size:.86rem; cursor:pointer; margin-bottom:8px;}
.stay-no-btn{width:100%; padding:10px; border-radius:9px; border:1px solid var(--border); background:transparent; color:var(--muted); font-size:.8rem; cursor:pointer;}
@media (max-width:520px){
  .card{padding:24px 18px 20px; border-radius:22px;}
  .disc{width:96px; height:96px;}
  .ctrl-btn{width:40px; height:40px;}
  .ctrl-btn.primary{width:52px; height:52px;}
}
</style>
</head>
<body>
<canvas id="waveCanvas"></canvas>

<div class="topbar">
  <a class="back" href="${escapeHtml(resolvedLandingUrl)}" title="Back"></a>
  <h1>TVFS Users Only <span>Audio Player</span></h1>
</div>

<div class="stage">
  <div class="card">
    <div class="disc" id="disc"></div>
    <div class="title" id="title"><span class="mq-inner" id="titleInner">${escapeHtml(originalName.replace(/\.[^./]+$/, ''))}</span></div>

    <div class="seekwrap">
      <input type="range" class="seek" id="seek" min="0" max="1000" value="0">
      <div class="times">
        <span id="tElapsed">0:00</span>
        <span id="tRemaining">${durationLabel ? '-' + durationLabel : '-0:00'}</span>
      </div>
    </div>

    <div class="controls">
      <button class="vol-mute" id="btnMute" title="Mute">${ICONS.volume}</button>
      <button class="ctrl-btn" id="btnRestart" title="Back to start">${ICONS.restart}</button>
      <button class="ctrl-btn primary" id="btnPlay" title="Play / Pause">${ICONS.play}</button>
      <button class="ctrl-btn" id="btnStop" title="Stop">${ICONS.stop}</button>
      <button class="vis-toggle" id="btnVis" title="Toggle visualizer">${ICONS.disc}</button>
    </div>

    <div class="rowbtns">
      <a class="pill" id="btnDownload" download title="Download original file">${ICONS.download}<span>Download</span></a>
      <button class="pill" id="btnEq" title="Open EQ">${ICONS.eq}<span>EQ</span></button>
    </div>

    <div class="volwrap">
      <input type="range" class="vol-slider" id="vol" min="0" max="200" value="100">
      <span class="vol-pct" id="volPct">100%</span>
    </div>

    <div class="meta">${escapeHtml(metaBits)}</div>
  </div>
</div>

<div class="eq-overlay" id="eqOverlay">
  <div class="eq-panel">
    <div class="eq-head">
      <h2>8-Band EQ</h2>
      <button class="eq-close" id="eqClose">${ICONS.close}</button>
    </div>
    <div class="eq-canvas-wrap">
      <svg id="eqSvg" viewBox="0 0 400 290" preserveAspectRatio="none"></svg>
      <div class="eq-tooltip" id="eqTooltip"></div>
    </div>
    <button class="eq-reset" id="eqReset">Reset all bands</button>
  </div>
</div>

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

<audio id="audio" preload="metadata"></audio>

<script>
(function(){
'use strict';
var audio = document.getElementById('audio');
var btnPlay = document.getElementById('btnPlay');
var btnRestart = document.getElementById('btnRestart');
var btnStop = document.getElementById('btnStop');
var btnDownload = document.getElementById('btnDownload');
var seek = document.getElementById('seek');
var tElapsed = document.getElementById('tElapsed');
var tRemaining = document.getElementById('tRemaining');
var disc = document.getElementById('disc');
var canvas = document.getElementById('waveCanvas');
var ctx = canvas.getContext('2d');

var AUDIO_URL = ${safeScriptJson(audioUrl)};
var TRACK_BPM = ${safeScriptJson(meta.bpm)};

// ─── Login gate (2026-08) ───────────────────────────────────────────────
// No audio byte is requested until this succeeds. Auth is the exact same
// tvfs_token session cookie the rest of the site uses (checked via
// /api/protected/{shareId}/login), never a token in this page's URL — a
// bare link to this player is worthless without an actual TVFS login.
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
  audio.src = AUDIO_URL;
  btnDownload.href = AUDIO_URL;
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


var ICON_PLAY = ${safeScriptJson(ICONS.play)};
var ICON_PAUSE = ${safeScriptJson(ICONS.pause)};

function setupTitleMarquee(){
  var titleEl = document.getElementById('title');
  var inner = document.getElementById('titleInner');
  requestAnimationFrame(function(){
    var overflow = inner.scrollWidth - titleEl.clientWidth;
    if (overflow > 4){
      titleEl.classList.add('marquee');
      titleEl.style.setProperty('--mq-distance', overflow + 'px');
      titleEl.style.setProperty('--mq-duration', Math.max(6, overflow / 22) + 's');
    } else {
      titleEl.classList.remove('marquee');
    }
  });
}
setupTitleMarquee();
window.addEventListener('resize', setupTitleMarquee);


function fmt(s){
  if(!isFinite(s) || s<0) s=0;
  var m=Math.floor(s/60), sec=Math.floor(s%60);
  return m+':'+String(sec).padStart(2,'0');
}

function updateSeekUI(){
  var dur = audio.duration || 0;
  var cur = audio.currentTime || 0;
  var pct = dur ? (cur/dur*1000) : 0;
  seek.value = pct;
  seek.style.setProperty('--pct', (dur ? cur/dur*100 : 0)+'%');
  tElapsed.textContent = fmt(cur);
  tRemaining.textContent = '-' + fmt(dur - cur);
}

audio.addEventListener('loadedmetadata', updateSeekUI);
audio.addEventListener('timeupdate', updateSeekUI);
audio.addEventListener('play', function(){ btnPlay.innerHTML = ICON_PAUSE; disc.classList.add('spinning'); });
audio.addEventListener('pause', function(){ btnPlay.innerHTML = ICON_PLAY; disc.classList.remove('spinning'); });
audio.addEventListener('ended', function(){ btnPlay.innerHTML = ICON_PLAY; disc.classList.remove('spinning'); });

btnPlay.addEventListener('click', function(){
  ensureAudioGraph();
  if (audio.paused) audio.play(); else audio.pause();
});
btnRestart.addEventListener('click', function(){ audio.currentTime = 0; updateSeekUI(); });
btnStop.addEventListener('click', function(){ audio.pause(); audio.currentTime = 0; updateSeekUI(); });

var seeking = false;
seek.addEventListener('input', function(){
  seeking = true;
  var dur = audio.duration || 0;
  var t = (seek.value/1000)*dur;
  tElapsed.textContent = fmt(t);
  tRemaining.textContent = '-' + fmt(dur - t);
  seek.style.setProperty('--pct', (dur ? t/dur*100 : 0)+'%');
});
seek.addEventListener('change', function(){
  var dur = audio.duration || 0;
  audio.currentTime = (seek.value/1000)*dur;
  seeking = false;
});

// ─── Web Audio graph: source -> 8-band EQ -> analyser -> destination ──────
var audioCtx, srcNode, analyser, gainNode, eqFilters = [], graphReady = false;
var EQ_BANDS = ${safeScriptJson(EQ_BANDS_HZ)};

function ensureAudioGraph(){
  if (graphReady) { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); return; }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    srcNode = audioCtx.createMediaElementSource(audio);

    eqFilters = EQ_BANDS.map(function(freq, i){
      var f = audioCtx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1.1;
      f.gain.value = 0;
      return f;
    });

    // Gain node sits after the EQ so the volume slider can go past 100%
    // (native audio.volume caps at 1.0 — this is the only way to boost).
    gainNode = audioCtx.createGain();
    gainNode.gain.value = currentVolume;

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;

    var node = srcNode;
    eqFilters.forEach(function(f){ node.connect(f); node = f; });
    node.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(audioCtx.destination);

    // Some browsers still hand back a 'suspended' context even inside a
    // user-gesture click handler — explicitly kick it awake.
    if (audioCtx.state === 'suspended') audioCtx.resume();

    graphReady = true;
  } catch (err) {
    // If this fails (blocked autoplay policy, odd browser, etc.) playback
    // itself must still work — just without visualizer/EQ/volume-boost.
    // Below-100% volume still works via audio.volume in applyVolume().
    console.error('[TVFS Audio Player] Web Audio graph setup failed — playback will continue, but the visualizer/EQ/volume-boost won\\'t react:', err);
    analyser = null;
    graphReady = false;
  }
}

// ─── Volume / mute ──────────────────────────────────────────────────────
// currentVolume is 0..2 (0%..200%). Native <audio>.volume only covers
// 0..1, so above 1.0 we lean on the gain node above; below/at 1.0 we set
// both, so volume still works even if the Web Audio graph never spins up.
var vol = document.getElementById('vol');
var volPct = document.getElementById('volPct');
var btnMute = document.getElementById('btnMute');
var ICON_VOLUME = ${safeScriptJson(ICONS.volume)};
var ICON_MUTE = ${safeScriptJson(ICONS.mute)};
var currentVolume = 1;
var volumeBeforeMute = 1;

function applyVolume(v){
  currentVolume = Math.max(0, Math.min(2, v));
  audio.volume = Math.min(currentVolume, 1);
  if (gainNode) gainNode.gain.value = currentVolume;
  vol.value = Math.round(currentVolume * 100);
  vol.style.setProperty('--vpct', (currentVolume / 2 * 100) + '%');
  volPct.textContent = Math.round(currentVolume * 100) + '%';
  var muted = currentVolume === 0;
  btnMute.classList.toggle('is-muted', muted);
  btnMute.innerHTML = muted ? ICON_MUTE : ICON_VOLUME;
}
applyVolume(1);

vol.addEventListener('input', function(){
  applyVolume(vol.value / 100);
});

btnMute.addEventListener('click', function(){
  if (currentVolume > 0) {
    volumeBeforeMute = currentVolume;
    applyVolume(0);
  } else {
    applyVolume(volumeBeforeMute || 1);
  }
});

// ─── Visualizer on/off toggle ──────────────────────────────────────────
var btnVis = document.getElementById('btnVis');
var visualizerOn = true;
btnVis.addEventListener('click', function(){
  visualizerOn = !visualizerOn;
  btnVis.classList.toggle('is-off', !visualizerOn);
  if (!visualizerOn) {
    waves = []; // clean slate so it doesn't jump back mid-animation on re-enable
    ctx.clearRect(0, 0, W, H);
  }
});

// ─── EQ popup: 8 draggable nodes, Fruity-EQ-2 style ────────────────────────
var eqOverlay = document.getElementById('eqOverlay');
var eqSvg = document.getElementById('eqSvg');
var eqTooltip = document.getElementById('eqTooltip');
var eqWrap = document.querySelector('.eq-canvas-wrap');
var VBW = 400, VBH = 290, PAD = 20, PAD_TOP = 16, PAD_BOTTOM = 34;
var nodes = [];

function freqToX(freq){
  var minF = 20, maxF = 20000;
  var lx = (Math.log(freq)-Math.log(minF))/(Math.log(maxF)-Math.log(minF));
  return PAD + lx*(VBW-PAD*2);
}
function xToFreq(x){
  var minF = 20, maxF = 20000;
  var lx = (x-PAD)/(VBW-PAD*2);
  lx = Math.max(0, Math.min(1, lx));
  return Math.exp(Math.log(minF) + lx*(Math.log(maxF)-Math.log(minF)));
}
function gainToY(gain){ // gain range -15..15
  var t = (gain+15)/30;
  return (VBH-PAD_BOTTOM) - t*((VBH-PAD_BOTTOM)-PAD_TOP);
}
function yToGain(y){
  var t = ((VBH-PAD_BOTTOM)-y)/((VBH-PAD_BOTTOM)-PAD_TOP);
  t = Math.max(0, Math.min(1, t));
  return t*30-15;
}
function fmtFreq(f){
  return f>=1000 ? (Math.round(f/100)/10)+'k' : Math.round(f)+'Hz';
}
function fmtGain(g){
  var r = Math.round(g*10)/10;
  return (r>0?'+':'')+r+'dB';
}

// Catmull-Rom -> cubic bezier, so the response curve reads like a taut
// string between the pegs instead of a stiff polyline.
function splinePath(pts){
  if (pts.length < 2) return '';
  var d = 'M'+pts[0].x+','+pts[0].y;
  for (var i=0; i<pts.length-1; i++){
    var p0 = pts[i-1] || pts[i];
    var p1 = pts[i];
    var p2 = pts[i+1];
    var p3 = pts[i+2] || p2;
    var c1x = p1.x + (p2.x - p0.x)/6;
    var c1y = p1.y + (p2.y - p0.y)/6;
    var c2x = p2.x - (p3.x - p1.x)/6;
    var c2y = p2.y - (p3.y - p1.y)/6;
    d += ' C'+c1x+','+c1y+' '+c2x+','+c2y+' '+p2.x+','+p2.y;
  }
  return d;
}

function buildEqSvg(){
  eqSvg.setAttribute('viewBox','0 0 '+VBW+' '+VBH);
  eqSvg.innerHTML = '';
  var ns = 'http://www.w3.org/2000/svg';

  // gridlines (gain)
  var grid = document.createElementNS(ns,'g');
  [0.25,0.5,0.75].forEach(function(t){
    var y = PAD_TOP + t*((VBH-PAD_BOTTOM)-PAD_TOP);
    var line = document.createElementNS(ns,'line');
    line.setAttribute('x1',PAD); line.setAttribute('x2',VBW-PAD);
    line.setAttribute('y1',y); line.setAttribute('y2',y);
    line.setAttribute('stroke','rgba(255,255,255,.08)'); line.setAttribute('stroke-width','1');
    grid.appendChild(line);
  });
  var zero = document.createElementNS(ns,'line');
  zero.setAttribute('x1',PAD); zero.setAttribute('x2',VBW-PAD);
  zero.setAttribute('y1',gainToY(0)); zero.setAttribute('y2',gainToY(0));
  zero.setAttribute('stroke','rgba(47,255,196,.35)'); zero.setAttribute('stroke-width','1.2');
  grid.appendChild(zero);
  eqSvg.appendChild(grid);

  // static frequency axis labels along the bottom
  var axis = document.createElementNS(ns,'g');
  EQ_BANDS.forEach(function(freq){
    var t = document.createElementNS(ns,'text');
    t.textContent = fmtFreq(freq);
    t.setAttribute('x', freqToX(freq));
    t.setAttribute('y', VBH-14);
    t.setAttribute('text-anchor','middle');
    t.setAttribute('fill','rgba(255,255,255,.4)');
    t.setAttribute('font-size','10');
    t.setAttribute('font-family','JetBrains Mono, monospace');
    axis.appendChild(t);
  });
  eqSvg.appendChild(axis);

  // response curve — smooth spline "string" through the nodes
  var defs = document.createElementNS(ns,'defs');
  defs.innerHTML = '<linearGradient id="eqGrad" x1="0" y1="0" x2="1" y2="0">'+
    '<stop offset="0%" stop-color="#2fffc4"/><stop offset="100%" stop-color="#7c4dff"/></linearGradient>';
  eqSvg.appendChild(defs);

  var curveGlow = document.createElementNS(ns,'path');
  curveGlow.setAttribute('fill','none');
  curveGlow.setAttribute('stroke','url(#eqGrad)');
  curveGlow.setAttribute('stroke-width','7');
  curveGlow.setAttribute('opacity','0.18');
  curveGlow.setAttribute('id','eqCurveGlow');
  eqSvg.appendChild(curveGlow);

  var curve = document.createElementNS(ns,'path');
  curve.setAttribute('fill','none');
  curve.setAttribute('stroke','url(#eqGrad)');
  curve.setAttribute('stroke-width','2.4');
  curve.setAttribute('id','eqCurve');
  eqSvg.appendChild(curve);

  nodes = EQ_BANDS.map(function(freq, i){
    var g = document.createElementNS(ns,'g');
    g.setAttribute('class','eq-node');
    var circ = document.createElementNS(ns,'circle');
    circ.setAttribute('r','9');
    circ.setAttribute('fill', i%2 ? '#7c4dff' : '#2fffc4');
    circ.setAttribute('stroke','#0a0a0a');
    circ.setAttribute('stroke-width','2');
    var label = document.createElementNS(ns,'text');
    label.textContent = String(i+1);
    label.setAttribute('text-anchor','middle');
    label.setAttribute('dy','4');
    label.setAttribute('fill','#0a0a0a');
    label.setAttribute('font-size','9');
    label.setAttribute('font-weight','700');
    label.setAttribute('font-family','JetBrains Mono, monospace');
    label.setAttribute('pointer-events','none');
    g.appendChild(circ);
    g.appendChild(label);
    eqSvg.appendChild(g);
    return { freq: freq, gain: 0, el: g, circ: circ, label: label, baseFreq: freq, vy: 0 };
  });

  updateEqVisual();
  attachDrag();
}

function curvePoints(){
  return nodes.map(function(n){ return { x: freqToX(n.freq), y: gainToY(n.gain) }; });
}

function updateEqVisual(){
  nodes.forEach(function(n){
    var x = freqToX(n.freq), y = gainToY(n.gain);
    n.el.setAttribute('transform','translate('+x+','+y+')');
  });
  var d = splinePath(curvePoints());
  var curve = document.getElementById('eqCurve');
  var glow = document.getElementById('eqCurveGlow');
  if (curve) curve.setAttribute('d', d);
  if (glow) glow.setAttribute('d', d);
  nodes.forEach(function(n, i){
    var f = eqFilters[i];
    if (!f || !audioCtx) return;
    // Scheduled ramps instead of raw ".value =" — plain value assignment on
    // an AudioParam of a node that's actively processing audio can get
    // coalesced/dropped by some browsers during fast successive updates
    // (exactly what a drag gesture produces). A short ramp guarantees each
    // change actually lands, and dodges any audible clicking too.
    var now = audioCtx.currentTime;
    try {
      f.frequency.cancelScheduledValues(now);
      f.frequency.setValueAtTime(f.frequency.value, now);
      f.frequency.linearRampToValueAtTime(n.freq, now + 0.045);
      f.gain.cancelScheduledValues(now);
      f.gain.setValueAtTime(f.gain.value, now);
      f.gain.linearRampToValueAtTime(n.gain, now + 0.045);
    } catch (e) {
      // Fallback for older engines without full AudioParam automation support
      f.frequency.value = n.freq;
      f.gain.value = n.gain;
    }
  });
}

function showTooltip(node){
  var x = freqToX(node.freq), y = gainToY(node.gain);
  var rect = eqWrap.getBoundingClientRect();
  eqTooltip.textContent = fmtFreq(node.freq) + '  ' + fmtGain(node.gain);
  eqTooltip.style.left = (x/VBW*rect.width) + 'px';
  eqTooltip.style.top = (y/VBH*rect.height) + 'px';
  eqTooltip.classList.add('show');
}
function hideTooltip(){ eqTooltip.classList.remove('show'); }

// Little spring "pluck" settle when a node is released — slight overshoot
// past the resting gain, like letting go of a stretched EQ string.
function springSettle(node){
  var target = node.gain;
  var v = node.vy || (node._lastDelta || 0) * 0.6;
  var pos = target - v;
  var stiffness = 0.35, damping = 0.62;
  var frames = 0;
  function step(){
    frames++;
    var force = (target - pos) * stiffness;
    v = v * damping + force;
    pos += v;
    node.gain = pos;
    updateEqVisual();
    if (Math.abs(v) > 0.02 && frames < 60){
      requestAnimationFrame(step);
    } else {
      node.gain = target;
      updateEqVisual();
    }
  }
  requestAnimationFrame(step);
}

function attachDrag(){
  var active = null, lastGain = 0;
  function ptFromEvent(evt){
    var rect = eqSvg.getBoundingClientRect();
    var cx = (evt.touches ? evt.touches[0].clientX : evt.clientX) - rect.left;
    var cy = (evt.touches ? evt.touches[0].clientY : evt.clientY) - rect.top;
    return { x: cx/rect.width*VBW, y: cy/rect.height*VBH };
  }
  nodes.forEach(function(n){
    var start = function(evt){
      evt.preventDefault();
      ensureAudioGraph();
      active = n;
      lastGain = n.gain;
      showTooltip(n);
    };
    n.el.addEventListener('mousedown', start);
    n.el.addEventListener('touchstart', start, { passive:false });
  });
  function move(evt){
    if (!active) return;
    evt.preventDefault();
    var p = ptFromEvent(evt);
    var i = nodes.indexOf(active);
    var lo = i===0 ? 20 : nodes[i-1].baseFreq*1.15;
    var hi = i===nodes.length-1 ? 20000 : nodes[i+1].baseFreq*0.87;
    var freq = Math.max(lo, Math.min(hi, xToFreq(p.x)));
    var newGain = yToGain(p.y);
    active._lastDelta = newGain - active.gain;
    active.freq = freq;
    active.gain = newGain;
    updateEqVisual();
    showTooltip(active);
  }
  function end(){
    if (active) springSettle(active);
    active = null;
    hideTooltip();
  }
  window.addEventListener('mousemove', move);
  window.addEventListener('touchmove', move, { passive:false });
  window.addEventListener('mouseup', end);
  window.addEventListener('touchend', end);
}

document.getElementById('btnEq').addEventListener('click', function(){
  ensureAudioGraph();
  if (!nodes.length) buildEqSvg();
  eqOverlay.classList.add('open');
});
document.getElementById('eqClose').addEventListener('click', function(){ eqOverlay.classList.remove('open'); });
eqOverlay.addEventListener('click', function(e){ if (e.target === eqOverlay) eqOverlay.classList.remove('open'); });
document.getElementById('eqReset').addEventListener('click', function(){
  nodes.forEach(function(n){ n.freq = n.baseFreq; n.gain = 0; });
  updateEqVisual();
});

// ─── Wave visualizer ────────────────────────────────────────────────────────
// Turquoise <-> purple (and everything between) rings that spawn on
// detected beats/transients and expand outward from the card's center at a
// speed proportional to how strong the hit was. Faster rings naturally
// overtake slower older ones — that IS the "collision" the physical
// propagation gives you for free. Runs continuously, playing or paused,
// so the page never goes visually dead.
var waves = [];
var W, H, cx, cy, maxReach, screenScale;
function resize(){
  W = canvas.width = window.innerWidth * devicePixelRatio;
  H = canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = window.innerWidth+'px';
  canvas.style.height = window.innerHeight+'px';
  cx = W/2; cy = H*0.4;
  maxReach = Math.sqrt(W*W + H*H) * 0.62; // reaches well past the edges, esp. on wide desktop screens
  screenScale = Math.max(1, Math.min(window.innerWidth, window.innerHeight) / 700);
}
window.addEventListener('resize', resize);
resize();

var prevLowEnergy = 0;
var fluxAvg = 0.015;
var bpmHint = TRACK_BPM || 110;
// Faster BPM tracks => quicker beat cadence => rings must be allowed to
// spawn more often, and travel a bit faster to match the felt tempo.
var spawnCooldownMs = Math.max(140, 60000 / bpmHint * 0.65);
var lastSpawn = 0;
var huePhase = Math.random()*360;

function spawnWave(strength, opts){
  opts = opts || {};
  huePhase = (huePhase + 18 + Math.random()*40) % 360;
  // Wide, lively palette: sweeps across turquoise -> violet -> magenta and
  // back, instead of sitting in one narrow band.
  var hue = 150 + (Math.sin(huePhase*Math.PI/180)*0.5+0.5) * 160; // ~150..310
  waves.push({
    r: 4 * devicePixelRatio,
    speed: (2.6 + strength*13) * devicePixelRatio * screenScale,
    alpha: Math.min(0.75, 0.24 + strength*0.62),
    width: (1.6 + strength*5.5) * devicePixelRatio,
    hue: hue,
    sat: 90 + Math.random()*10,
    light: 58 + Math.random()*14
  });
  if (waves.length > 70) waves.shift();

  // Strong hits get a fast inner echo ring chasing the first one — the
  // "collision" reads much more clearly with two rings of different speed.
  if (strength > 0.35 && !opts.isEcho){
    setTimeout(function(){ spawnWave(strength*0.6, { isEcho:true }); }, 70);
  }
}

var freqData = new Uint8Array(256);

function tick(){
  requestAnimationFrame(tick);
  ctx.clearRect(0,0,W,H);
  if (!visualizerOn) return;

  var now = performance.now();
  var playing = analyser && !audio.paused;

  if (playing){
    analyser.getByteFrequencyData(freqData);
    // low-band energy = kick/bass-driven signal
    var lowSum = 0, n = Math.floor(freqData.length*0.18);
    for (var i=0;i<n;i++) lowSum += freqData[i];
    var lowEnergy = lowSum / (n*255);

    // Spectral-flux onset detection: react to how much LOUDER things just
    // got (positive-only delta), not to absolute loudness. A plain
    // "current vs. running average of loudness itself" comparison self-
    // defeats on sustained bass — the average catches up to match the
    // beat's own level within a couple of hits and then nothing ever
    // clears the threshold again (which was exactly the "one wave and then
    // silence" bug). Flux stays near zero between hits regardless of how
    // loud the track is, so every new transient still stands out cleanly.
    var flux = Math.max(0, lowEnergy - prevLowEnergy);
    prevLowEnergy = lowEnergy;
    fluxAvg = fluxAvg*0.94 + flux*0.06;

    if (flux > fluxAvg*2.1 + 0.012 && now - lastSpawn > spawnCooldownMs){
      spawnWave(Math.min(1, flux*9));
      lastSpawn = now;
    }
  } else {
    prevLowEnergy = 0;
  }
  // No sound -> no waves. Paused/silent means the canvas just lets whatever
  // rings are already in flight finish fading out, nothing new spawns.

  for (var w=waves.length-1; w>=0; w--){
    var wv = waves[w];
    wv.r += wv.speed;
    wv.alpha *= 0.982;
    if (wv.alpha < 0.008 || wv.r > maxReach){ waves.splice(w,1); continue; }

    ctx.beginPath();
    ctx.arc(cx, cy, wv.r, 0, Math.PI*2);
    ctx.strokeStyle = 'hsla('+wv.hue+','+wv.sat+'%,'+wv.light+'%,'+wv.alpha+')';
    ctx.lineWidth = wv.width;
    ctx.shadowColor = 'hsla('+wv.hue+',95%,62%,0.75)';
    ctx.shadowBlur = 18*devicePixelRatio;
    ctx.stroke();

    // faint inner glow fill for richness on the freshest, strongest rings
    if (wv.alpha > 0.3){
      ctx.beginPath();
      ctx.arc(cx, cy, wv.r, 0, Math.PI*2);
      ctx.strokeStyle = 'hsla('+wv.hue+',100%,80%,'+(wv.alpha*0.35)+')';
      ctx.lineWidth = wv.width*2.4;
      ctx.shadowBlur = 0;
      ctx.stroke();
    }
  }
}
requestAnimationFrame(tick);

})();
</script>
</body>

</html>`;
}

// storedFilename: filename as saved on disk (in files/audio/)
// filePath: absolute path to that file (for ffprobe/aubio)
// playersDir: absolute dir to write the generated player HTML into
function maybeCreateAudioPlayer(storedFilename, originalName, mimeType, filePath, playersDir, publicAudioUrl, backUrl) {
    const isAudio = mimeType && mimeType.split('/')[0] === 'audio';
    if (!isAudio) return null;

    if (!fs.existsSync(playersDir)) fs.mkdirSync(playersDir, { recursive: true });

    const slug = originalName.replace(/\.[^.]+$/, '').replace(/[^\w\-]/g, '_').replace(/_+/g, '_').slice(0, 40) || 'track';
    const playerFilename = `${slug}_${Date.now()}_player.html`;
    const playerPath = path.join(playersDir, playerFilename);

    let meta;
    try {
        meta = analyzeAudio(filePath);
    } catch (e) {
        console.error('⚠️  [AUDIO PLAYER] Metadata/BPM analysis failed:', e.message);
        meta = { codec: null, bitrateKbps: null, sampleRateHz: null, channels: null, durationSec: null, bpm: null };
    }

    const html = generateAudioPlayerHtml(publicAudioUrl, originalName, meta, backUrl);
    fs.writeFileSync(playerPath, html);

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
    const playerFilename = `${slug}_${shareId}_player.html`;
    const playerPath = path.join(playersDir, playerFilename);

    let meta;
    try {
        meta = analyzeAudio(filePath);
    } catch (e) {
        console.error('⚠️  [PROTECTED AUDIO PLAYER] Metadata/BPM analysis failed:', e.message);
        meta = { codec: null, bitrateKbps: null, sampleRateHz: null, channels: null, durationSec: null, bpm: null };
    }

    const html = generateProtectedAudioPlayerHtml(contentUrl, originalName, meta, shareId, landingUrl);
    fs.writeFileSync(playerPath, html);

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
