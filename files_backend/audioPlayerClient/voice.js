/* TVFS voice note player. Plain ES5-style script, inlined into the generated page.
   Controls: play / pause, seek on the waveform, speed (pitch kept), volume.
   Loudness is normalized to TARGET_LUFS (gain capped), followed by a compressor and a soft clipper so it never clips.
   iOS gets plain <audio> playback only: routing through Web Audio would put it under the AudioContext, which iOS
   suspends on lock/background. */
(function(){
'use strict';

var CFG = window.TVFS_PLAYER || {};
var TARGET_LUFS = -16, MIN_GAIN_DB = -12, MAX_GAIN_DB = 12, TOTAL_MAX_DB = 15, SILENCE_LUFS = -58;
var SPEEDS = [1, 1.25, 1.5, 2];
var STORE_KEY = 'tvfs_voice_prefs';
var MAX_DECODE_BYTES = 30 * 1024 * 1024;

function $(id){ return document.getElementById(id); }
function clamp(v, a, b){ return Math.min(b, Math.max(a, v)); }
function fmt(sec){
  sec = Math.max(0, Math.floor(sec || 0));
  var m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}
function loadPrefs(){ try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } }
function savePrefs(patch){
  try { var p = loadPrefs(); for (var k in patch) p[k] = patch[k]; localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch (e) {}
}
var prefs = loadPrefs();

var audio = $('audio'), btnPlay = $('vnPlay'), wave = $('vnWave'), tTime = $('vnTime'), tDate = $('vnDate'),
    btnSpeed = $('vnSpeed'), range = $('vnVol'), volPct = $('vnVolPct'), btnMute = $('vnMute'), errEl = $('vnError');
var ICONS = CFG.icons || {};

// ─── Date ───────────────────────────────────────────────────────────────────
if (CFG.uploadedAt) {
  try {
    tDate.textContent = new Date(CFG.uploadedAt).toLocaleString(undefined,
      { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { tDate.textContent = ''; }
}

// ─── Duration ───────────────────────────────────────────────────────────────
// Recordings from MediaRecorder often report no duration (Infinity); the server and the decoder know it.
var knownDur = typeof CFG.durationSec === 'number' && CFG.durationSec > 0 ? CFG.durationSec : 0;
function duration(){
  var d = audio.duration;
  return isFinite(d) && d > 0 ? d : knownDur;
}

// ─── Waveform ───────────────────────────────────────────────────────────────
var peaks = null; // 0..1 values
if (Array.isArray(CFG.peaks) && CFG.peaks.length) peaks = CFG.peaks.map(function(v){ return clamp(v / 100, 0, 1); });
var bars = [], barCount = 0, litCount = 0;

function placeholderPeaks(){
  var out = [];
  for (var i = 0; i < 64; i++) out.push(0.22 + 0.12 * Math.sin(i * 0.9) * Math.sin(i * 0.31 + 1));
  return out;
}

function buildBars(){
  var w = wave.clientWidth || 280;
  var n = clamp(Math.floor(w / 5), 24, 72);
  if (n === barCount && bars.length) return;
  var src = peaks || placeholderPeaks();
  wave.classList.toggle('pending', !peaks);
  wave.textContent = '';
  bars = [];
  for (var i = 0; i < n; i++) {
    var from = Math.floor(i * src.length / n), to = Math.max(from + 1, Math.floor((i + 1) * src.length / n)), v = 0;
    for (var j = from; j < to && j < src.length; j++) if (src[j] > v) v = src[j];
    var b = document.createElement('i');
    b.style.height = Math.round(12 + clamp(v, 0, 1) * 88) + '%';
    wave.appendChild(b);
    bars.push(b);
  }
  barCount = n;
  litCount = 0;
  paintProgress();
}

function progress(){
  var d = duration();
  return d > 0 ? clamp(audio.currentTime / d, 0, 1) : 0;
}

function paintProgress(){
  var lit = Math.round(progress() * barCount);
  if (lit === litCount) return;
  var lo = Math.min(lit, litCount), hi = Math.max(lit, litCount);
  for (var i = lo; i < hi; i++) bars[i].classList.toggle('on', i < lit);
  litCount = lit;
  wave.setAttribute('aria-valuenow', String(Math.round(progress() * 100)));
}

function paintTime(){
  var d = duration();
  tTime.textContent = fmt(audio.currentTime) + ' / ' + (d > 0 ? fmt(d) : '--:--');
  wave.setAttribute('aria-valuetext', fmt(audio.currentTime) + ' of ' + (d > 0 ? fmt(d) : 'unknown length'));
}

function paint(){ paintProgress(); paintTime(); }

// Peaks computed in the browser, only when the server could not provide them
function decodePeaks(){
  if (peaks || !window.fetch) return;
  if (navigator.connection && navigator.connection.saveData) return;
  var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return;
  fetch(CFG.audioUrl).then(function(r){
    var len = parseInt(r.headers.get('content-length'), 10);
    if (!r.ok || !len || len > MAX_DECODE_BYTES) throw new Error('skip'); // unknown size: do not risk a huge download
    return r.arrayBuffer();
  }).then(function(buf){
    var ctx = new OAC(1, 1, 44100);
    return new Promise(function(res, rej){
      var p = ctx.decodeAudioData(buf, res, rej);
      if (p && p.catch) p.catch(rej);
    });
  }).then(function(decoded){
    var ch = decoded.getChannelData(0), n = 64, out = [], max = 0;
    for (var i = 0; i < n; i++) {
      var from = Math.floor(i * ch.length / n), to = Math.floor((i + 1) * ch.length / n), peak = 0, sum = 0, cnt = 0;
      var step = Math.max(1, Math.floor((to - from) / 400));
      for (var j = from; j < to; j += step) { var a = Math.abs(ch[j]); if (a > peak) peak = a; sum += a * a; cnt++; }
      var v = 0.65 * Math.sqrt(sum / Math.max(1, cnt)) + 0.35 * peak;
      out.push(v); if (v > max) max = v;
    }
    peaks = out.map(function(v){ return max > 1e-4 ? Math.pow(v / max, 0.7) : 0; });
    if (decoded.duration > 0 && !knownDur) knownDur = decoded.duration;
    barCount = 0;
    buildBars();
    paintTime();
  }).catch(function(){ /* placeholder bars stay */ });
}

// ─── Audio graph: normalization gain -> volume -> limiter ──────────────────
var ua = navigator.userAgent || '';
var isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
// near-silent recordings are not boosted (it would only raise the noise floor)
var normDb = typeof CFG.lufs === 'number' && isFinite(CFG.lufs) && CFG.lufs > SILENCE_LUFS ? clamp(TARGET_LUFS - CFG.lufs, MIN_GAIN_DB, MAX_GAIN_DB) : 0;
var ac = null, volNode = null, normNode = null, hasGraph = false;
var level = typeof prefs.volume === 'number' ? clamp(prefs.volume, 0.1, 1) : 1; // 0..2; the boost above 100 % is never remembered
if (isIOS) { range.max = '100'; } // audio.volume is read-only there and the boost needs Web Audio
var muted = false;

// Soft clipper: linear up to 0.8, then rounds off smoothly towards 0.95, so what the compressor lets through never hard-clips
function clipCurve(){
  var n = 2049, c = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var x = i / (n - 1) * 2 - 1, a = Math.abs(x);
    c[i] = (a <= 0.8 ? a : 0.8 + 0.15 * Math.tanh((a - 0.8) / 0.15)) * (x < 0 ? -1 : 1);
  }
  return c;
}

function ensureGraph(){
  if (ac || isIOS) return;
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    var ctx = new AC();
    var src = ctx.createMediaElementSource(audio);
    normNode = ctx.createGain();
    volNode = ctx.createGain();
    var lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -8; lim.knee.value = 4; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.12;
    var clip = ctx.createWaveShaper();
    clip.curve = clipCurve(); clip.oversample = '2x';
    src.connect(normNode); normNode.connect(volNode); volNode.connect(lim); lim.connect(clip); clip.connect(ctx.destination);
    ctx.onstatechange = function(){ if (ctx.state === 'suspended' && !audio.paused && ctx.resume) ctx.resume(); };
    ac = ctx; hasGraph = true;
    applyVolume();
  } catch (e) { ac = null; hasGraph = false; volNode = null; normNode = null; }
}

function applyVolume(){
  // perceptual curve up to 100 %, then a straight boost up to 2x (+6 dB) at 200 %; the limiter keeps it from clipping
  var v = muted ? 0 : (level <= 1 ? level * level : level);
  if (hasGraph) {
    // total boost (loudness gain + volume above 100 %) never goes past TOTAL_MAX_DB
    var volDb = v > 0 ? 20 * Math.log(v) / Math.LN10 : 0;
    normNode.gain.value = Math.pow(10, Math.min(normDb, TOTAL_MAX_DB - volDb) / 20);
    volNode.gain.value = v; audio.volume = 1;
  }
  else audio.volume = clamp(v * Math.min(1, Math.pow(10, normDb / 20)), 0, 1); // no Web Audio: can only turn down
  range.style.setProperty('--pct', Math.round(level * 50) + '%');
  volPct.textContent = (muted ? 0 : Math.round(level * 100)) + ' %';
  volPct.classList.toggle('boost', !muted && level > 1);
  btnMute.classList.toggle('muted', muted || level === 0);
  btnMute.innerHTML = muted || level === 0 ? ICONS.mute : ICONS.volume;
  btnMute.setAttribute('aria-label', muted || level === 0 ? 'Unmute' : 'Mute');
}

range.value = String(Math.round(level * 100));
range.addEventListener('input', function(){
  level = clamp(parseInt(range.value, 10) / 100, 0, 2);
  muted = false;
  if (level >= 0.1) savePrefs({ volume: Math.min(level, 1) }); // 0 is never remembered: the next note must not open silent
  applyVolume();
});
btnMute.addEventListener('click', function(){ muted = !muted; applyVolume(); });
applyVolume();

// ─── Speed (pitch preserved) ────────────────────────────────────────────────
var speedIdx = Math.max(0, SPEEDS.indexOf(prefs.speed));
function applySpeed(){
  var s = SPEEDS[speedIdx];
  audio.defaultPlaybackRate = s;
  audio.playbackRate = s;
  audio.preservesPitch = true; audio.mozPreservesPitch = true; audio.webkitPreservesPitch = true;
  btnSpeed.textContent = s + 'x';
  btnSpeed.setAttribute('aria-label', 'Playback speed ' + s + 'x');
}
btnSpeed.addEventListener('click', function(){
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  savePrefs({ speed: SPEEDS[speedIdx] });
  applySpeed();
});
applySpeed();

// ─── Playback ───────────────────────────────────────────────────────────────
var raf = 0;
function showError(msg){ errEl.textContent = msg || ''; }

function toggle(){
  if (!audio.paused) { audio.pause(); return; }
  showError('');
  ensureGraph();
  if (ac && ac.state === 'suspended' && ac.resume) ac.resume();
  var p = audio.play();
  if (p && p.catch) p.catch(function(){ showError('This browser cannot play this recording.'); });
}

document.addEventListener('visibilitychange', function(){
  if (document.visibilityState === 'visible' && ac && ac.state === 'suspended' && !audio.paused && ac.resume) ac.resume();
});

function syncButton(){
  var playing = !audio.paused;
  btnPlay.innerHTML = playing ? ICONS.pause : ICONS.play;
  btnPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function tick(){
  paint();
  raf = audio.paused ? 0 : requestAnimationFrame(tick);
}

btnPlay.addEventListener('click', toggle);
audio.addEventListener('play', function(){ syncButton(); if (!raf) raf = requestAnimationFrame(tick); });
audio.addEventListener('pause', function(){ syncButton(); paint(); });
audio.addEventListener('timeupdate', paint);
audio.addEventListener('durationchange', paint);
audio.addEventListener('ended', function(){ audio.currentTime = 0; syncButton(); paint(); });
audio.addEventListener('error', function(){ showError('This browser cannot play this recording.'); });
audio.addEventListener('loadedmetadata', function(){
  applySpeed();
  // MediaRecorder files without a duration: jumping far ahead makes the browser find the real length
  if (audio.duration === Infinity && !knownDur) {
    audio.currentTime = 1e101;
    audio.addEventListener('timeupdate', function fix(){ audio.removeEventListener('timeupdate', fix); audio.currentTime = 0; });
  }
  paint();
});

// ─── Seeking (click, drag, keyboard) ────────────────────────────────────────
function seekFromEvent(e){
  var d = duration();
  if (!d) return;
  var r = wave.getBoundingClientRect();
  audio.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * d;
  paint();
}
var dragging = false;
wave.addEventListener('pointerdown', function(e){
  dragging = true;
  try { wave.setPointerCapture(e.pointerId); } catch (err) {}
  seekFromEvent(e);
});
wave.addEventListener('pointermove', function(e){ if (dragging) seekFromEvent(e); });
function endDrag(){ dragging = false; }
wave.addEventListener('pointerup', endDrag);
wave.addEventListener('pointercancel', endDrag);
wave.addEventListener('keydown', function(e){
  var d = duration();
  if (!d) return;
  var t = null;
  if (e.key === 'ArrowRight') t = audio.currentTime + 5;
  else if (e.key === 'ArrowLeft') t = audio.currentTime - 5;
  else if (e.key === 'Home') t = 0;
  else if (e.key === 'End') t = d;
  if (t === null) return;
  e.preventDefault();
  audio.currentTime = clamp(t, 0, d);
  paint();
});

// ─── Start ──────────────────────────────────────────────────────────────────
buildBars();
var lastW = wave.clientWidth;
window.addEventListener('resize', function(){
  if (wave.clientWidth !== lastW) { lastW = wave.clientWidth; buildBars(); }
});
syncButton();
paintTime();
audio.src = CFG.audioUrl; // no autoplay: playback only starts from the button
// the fallback decode is a second download: wait until the page is idle
if (!peaks) setTimeout(decodePeaks, 2500);
window.TVFSPlayer = { audio: audio, voiceNote: true, normDb: normDb, graphState: function(){ return ac ? ac.state : 'none'; }, ios: isIOS };
})();
