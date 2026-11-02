// TVFS audio player client. Inlined into every generated player page together
// with window.TVFS_PLAYER (audioUrl, bpm, eqBands, gated, icons).
(function(){
'use strict';
var CFG = window.TVFS_PLAYER;
var $ = function(id){ return document.getElementById(id); };
var clamp = function(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; };
var audio = $('audio');
var btnPlay = $('btnPlay'), btnRestart = $('btnRestart'), btnStop = $('btnStop');
var btnDownload = $('btnDownload'), btnMute = $('btnMute'), btnVis = $('btnVis');
var seek = $('seek'), tElapsed = $('tElapsed'), tRemaining = $('tRemaining');
var disc = $('disc');
var reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;

// Per-browser conveniences only (volume, visualizer on/off). Never required.
var STORE_KEY = 'tvfs-audio-player';
function loadPrefs(){ try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } }
function savePrefs(patch){
  try { var p = loadPrefs(); for (var k in patch) p[k] = patch[k]; localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch (e) {}
}
var prefs = loadPrefs();

// ─── Title marquee ──────────────────────────────────────────────────────
var MQ_PAD = 12;            // total horizontal padding of .mq-inner while scrolling
var MQ_HOLD_START = 2000;   // ms the title rests at the start (readable before it moves)
var MQ_HOLD_END = 1800;     // ms it rests once the end is reached
var MQ_SPEED = 30;          // px per second while gliding forward
var MQ_FADE = '20px';
var mqAnims = [];
var mqKey = '';
var mqRaf = 0;
var mqReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

function stopTitleMarquee(titleEl){
  mqAnims.forEach(function(a){ try { a.cancel(); } catch (e) {} });
  mqAnims = [];
  mqKey = '';
  titleEl.classList.remove('marquee');
  titleEl.classList.remove('clamped');
}

function setupTitleMarquee(){
  cancelAnimationFrame(mqRaf);
  mqRaf = requestAnimationFrame(function(){
    var titleEl = document.getElementById('title');
    var inner = document.getElementById('titleInner');
    var active = titleEl.classList.contains('marquee');
    var natural = inner.offsetWidth - (active ? MQ_PAD : 0);
    var box = titleEl.clientWidth;
    var key = natural + '|' + box;
    if (active && key === mqKey && mqAnims.length) return; // nothing changed -> don't restart mid-scroll

    stopTitleMarquee(titleEl);
    if (natural - box <= 4) return;                         // fits, stays centred
    if (mqReduce && mqReduce.matches){ titleEl.classList.add('clamped'); return; }

    var dist = natural + MQ_PAD - box;
    var tScroll = Math.min(24000, Math.max(3500, dist / MQ_SPEED * 1000));
    var tBack = Math.min(4500, Math.max(1100, tScroll * 0.4));
    var total = MQ_HOLD_START + tScroll + MQ_HOLD_END + tBack;
    var a = MQ_HOLD_START / total;                          // scroll starts
    var b = (MQ_HOLD_START + tScroll) / total;              // end reached
    var c = (MQ_HOLD_START + tScroll + MQ_HOLD_END) / total; // glide back starts
    var e = Math.min(500, tScroll / 3, tBack / 3) / total;  // fade ramp length

    titleEl.classList.add('marquee');
    mqKey = key;
    var opts = { duration: total, iterations: Infinity };
    try {
      mqAnims.push(inner.animate([
        { transform: 'translateX(0px)', offset: 0 },
        { transform: 'translateX(0px)', offset: a, easing: 'cubic-bezier(.45,.05,.2,1)' },
        { transform: 'translateX(' + (-dist) + 'px)', offset: b },
        { transform: 'translateX(' + (-dist) + 'px)', offset: c, easing: 'cubic-bezier(.5,0,.2,1)' },
        { transform: 'translateX(0px)', offset: 1 }
      ], opts));
      // Left fade only while text is scrolled away from the start,
      // right fade only while there is still text to the right.
      mqAnims.push(titleEl.animate([
        { '--mq-fade-l': '0px', '--mq-fade-r': MQ_FADE, offset: 0 },
        { '--mq-fade-l': '0px', offset: a },
        { '--mq-fade-l': MQ_FADE, offset: a + e },
        { '--mq-fade-r': MQ_FADE, offset: b - e },
        { '--mq-fade-r': '0px', offset: b },
        { '--mq-fade-r': '0px', offset: c },
        { '--mq-fade-r': MQ_FADE, offset: c + e },
        { '--mq-fade-l': MQ_FADE, offset: 1 - e },
        { '--mq-fade-l': '0px', '--mq-fade-r': MQ_FADE, offset: 1 }
      ], opts));
    } catch (err) {
      // No Web Animations support: static title with both edges softened.
      titleEl.style.setProperty('--mq-fade-l', '14px');
      titleEl.style.setProperty('--mq-fade-r', '14px');
    }
  });
}
window.addEventListener('resize', setupTitleMarquee);
window.addEventListener('load', setupTitleMarquee);
// The title font is a web font picked from the BPM ladder. Measuring before it
// has loaded gives the wrong overflow, so re-measure once fonts are in.
if (document.fonts){
  if (document.fonts.ready) document.fonts.ready.then(setupTitleMarquee);
  if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', setupTitleMarquee);
}
setupTitleMarquee();

// ─── Transport ──────────────────────────────────────────────────────────────
function fmt(s){
  if (!isFinite(s) || s < 0) s = 0;
  var m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}
var seeking = false;
function updateSeekUI(){
  if (seeking) return;
  var dur = audio.duration || 0, cur = audio.currentTime || 0;
  seek.value = dur ? cur / dur * 1000 : 0;
  seek.style.setProperty('--pct', (dur ? cur / dur * 100 : 0) + '%');
  tElapsed.textContent = fmt(cur);
  tRemaining.textContent = '-' + fmt(dur - cur);
}
audio.addEventListener('loadedmetadata', updateSeekUI);
audio.addEventListener('timeupdate', updateSeekUI);
audio.addEventListener('play', function(){ btnPlay.innerHTML = CFG.icons.pause; });
audio.addEventListener('pause', function(){ btnPlay.innerHTML = CFG.icons.play; });
audio.addEventListener('ended', function(){ btnPlay.innerHTML = CFG.icons.play; });

function togglePlay(){
  if (!audio.src) return;
  ensureGraph();
  if (audio.paused) audio.play(); else audio.pause();
}
btnPlay.addEventListener('click', togglePlay);
btnRestart.addEventListener('click', function(){ audio.currentTime = 0; updateSeekUI(); });
btnStop.addEventListener('click', function(){ audio.pause(); audio.currentTime = 0; updateSeekUI(); });

var btnLoop = $('btnLoop');
function setLoop(on){
  audio.loop = on;
  btnLoop.classList.toggle('is-on', on);
  btnLoop.setAttribute('aria-pressed', on ? 'true' : 'false');
}
setLoop(prefs.loop === true);
btnLoop.addEventListener('click', function(){ setLoop(!audio.loop); savePrefs({ loop: audio.loop }); });

seek.addEventListener('input', function(){
  seeking = true;
  var dur = audio.duration || 0, t = seek.value / 1000 * dur;
  tElapsed.textContent = fmt(t);
  tRemaining.textContent = '-' + fmt(dur - t);
  seek.style.setProperty('--pct', (dur ? t / dur * 100 : 0) + '%');
});
seek.addEventListener('change', function(){
  audio.currentTime = seek.value / 1000 * (audio.duration || 0);
  seeking = false;
});

function setMuted(m){
  audio.muted = m;
  btnMute.classList.toggle('is-muted', m);
  btnMute.innerHTML = m ? CFG.icons.mute : CFG.icons.volume;
}
btnMute.addEventListener('click', function(){ setMuted(!audio.muted); });

document.addEventListener('keydown', function(e){
  var t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.code === 'Space' && !(t && t.classList && t.classList.contains('knob-dial'))) {
    e.preventDefault(); togglePlay();
  } else if (e.key === 'm' || e.key === 'M') {
    setMuted(!audio.muted);
  } else if (e.key === 'l' || e.key === 'L') {
    btnLoop.click();
  }
});

function setSource(url){
  audio.src = url;
  btnDownload.href = url;
  applyRates();
  maybeStartTour();
}

// ─── Audio engine ───────────────────────────────────────────────────────────
// source -> pitch shifter -> 8 EQ bands -> DJ filter -> stereo (width + 8D above 150 Hz)
//   -> dry + reverb send + echo send (both without bass) -> volume -> limiter -> drive
//   -> soft clip -> analyser -> out
// Gain staging: effects never add much level (the dry signal steps back as an
// effect comes in), because modern masters already sit at 0 dBFS and anything
// extra could only be squashed again. At <=100% the soft clip is a plain identity
// (it only stops overshoots past 0 dBFS); above 100% it is the boost's saturation.
// With neutral settings the output equals the input (measured -69 dB residual).
// createEngine works on any BaseAudioContext, so tests can render the same graph
// offline and measure it.
var values = {};
var ac = null, engine = null;

// Smooth saturation: linear up to `knee`, then bends towards 1 (never a hard edge).
// The curve covers -range..range of input, because a WaveShaper clamps outside -1..1.
function softClipCurve(knee, range){
  var n = 8192, c = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var x = (i / (n - 1) * 2 - 1) * range, a = Math.abs(x);
    var y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
    c[i] = x < 0 ? -y : y;
  }
  return c;
}
var DRIVE_RANGE = 8;
function satKnee(volume){ return volume <= 100 ? 1 : 0.97 - 0.37 * Math.min(1, (volume - 100) / 100); }

function createEngine(ctx, input){
  var N = {}, E = { ctx: ctx, n: N, convActive: 'A', irTimer: 0, state: {} };
  function glide(param, v, tc, instant){
    if (instant) { param.cancelScheduledValues(0); param.value = v; return; }
    var now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(v, now, tc || 0.025);
  }
  function gain(v){ var g = ctx.createGain(); g.gain.value = v === undefined ? 1 : v; return g; }
  function filter(type, f, q){ var b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q || 0.707; return b; }

  // worklet slots: plain pass-through until the module has loaded
  N.pitchIn = gain(); N.pitchOut = gain();
  input.connect(N.pitchIn); N.pitchIn.connect(N.pitchOut);

  var node = N.pitchOut;
  N.eq = EQ_DEFAULTS.map(function(b){ // start as exact identities; the EQ sets real shapes
    var f = filter('peaking', b.freq, 1); f.gain.value = 0;
    node.connect(f); node = f;
    return f;
  });
  // DJ filter with an exact bypass at 0 (even a 10 Hz high-pass shifts the bass
  // phase enough to grow peaks out of a clipped master)
  N.lp = filter('lowpass', ctx.sampleRate / 2); N.hp = filter('highpass', 10);
  N.filtDry = gain(1); N.filtWet = gain(0);
  node.connect(N.filtDry); node.connect(N.lp); N.lp.connect(N.hp); N.hp.connect(N.filtWet);

  N.stereoIn = gain();
  N.stereoIn.channelCount = 2; N.stereoIn.channelCountMode = 'explicit'; N.stereoIn.channelInterpretation = 'speakers';
  N.stereoOut = gain();
  N.filtDry.connect(N.stereoIn); N.filtWet.connect(N.stereoIn); N.stereoIn.connect(N.stereoOut);
  var pre = N.stereoOut;

  N.mix = gain();
  N.dry = gain(); pre.connect(N.dry); N.dry.connect(N.mix);

  N.revHP = filter('highpass', 180); N.revSend = gain(0);
  N.convA = ctx.createConvolver(); N.convB = ctx.createConvolver();
  N.convAGain = gain(1); N.convBGain = gain(0);
  N.revTone = filter('lowpass', 9000);
  pre.connect(N.revHP); N.revHP.connect(N.revSend);
  N.revSend.connect(N.convA); N.revSend.connect(N.convB);
  N.convA.connect(N.convAGain); N.convB.connect(N.convBGain);
  N.convAGain.connect(N.revTone); N.convBGain.connect(N.revTone); N.revTone.connect(N.mix);

  N.echoHP = filter('highpass', 220); N.echoSend = gain(0);
  N.delay = ctx.createDelay(2.5); N.damp = filter('lowpass', 4500); N.fb = gain(0.35);
  pre.connect(N.echoHP); N.echoHP.connect(N.echoSend); N.echoSend.connect(N.delay);
  N.delay.connect(N.damp); N.damp.connect(N.fb); N.fb.connect(N.delay);
  N.damp.connect(N.mix);

  N.norm = gain();   // loudness normalization (see normGain)
  N.volume = gain();
  N.drive = gain(1 / DRIVE_RANGE);
  N.sat = ctx.createWaveShaper(); N.sat.curve = softClipCurve(satKnee(100), DRIVE_RANGE); E.knee = satKnee(100);
  // Look-ahead limiter for the overshoots pitch shifting and EQ boosts create.
  // Threshold at 0 dBFS: a decoded file never exceeds it, so with neutral settings
  // the limiter never acts (loud masters peak right at 0 dB on every kick).
  // The spec adds automatic make-up gain ((1/fullRangeGain)^0.6); limTrim takes it back out.
  N.limiter = ctx.createDynamicsCompressor();
  N.limiter.threshold.value = 0; N.limiter.knee.value = 0; N.limiter.ratio.value = 20;
  N.limiter.attack.value = 0.002; N.limiter.release.value = 0.15;
  var fullRangeDb = 0;
  N.limTrim = gain(Math.pow(Math.pow(10, fullRangeDb / 20), 0.6));
  N.analyser = ctx.createAnalyser(); N.analyser.fftSize = 2048; N.analyser.smoothingTimeConstant = 0.55;
  N.mix.connect(N.norm); N.norm.connect(N.volume); N.volume.connect(N.limiter); N.limiter.connect(N.limTrim);
  N.limTrim.connect(N.drive); N.drive.connect(N.sat);
  N.sat.connect(N.analyser); N.analyser.connect(ctx.destination);
  N.preLimit = N.volume; // measuring tap (before limiter, drive and saturation)

  E.loadWorklet = function(){
    if (!ctx.audioWorklet) return Promise.resolve(false);
    var src = $('workletSrc').textContent;
    var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    return ctx.audioWorklet.addModule(url).then(function(){
      N.pitch = new AudioWorkletNode(ctx, 'tvfs-pitch', { outputChannelCount: [2] });
      N.pitchIn.disconnect(); N.pitchIn.connect(N.pitch); N.pitch.connect(N.pitchOut);
      N.stereo = new AudioWorkletNode(ctx, 'tvfs-stereo', { outputChannelCount: [2] });
      N.stereoIn.disconnect(); N.stereoIn.connect(N.stereo); N.stereo.connect(N.stereoOut);
      ['width', 'rotate'].forEach(function(id){ if (id in E.state) E.set(id, E.state[id], true); });
      return true;
    });
  };
  E.setNorm = function(g, instant){ glide(N.norm.gain, g, 0.05, instant); };
  E.setPitchShift = function(ratio){ if (N.pitch) N.pitch.parameters.get('ratio').setValueAtTime(ratio, ctx.currentTime); };

  function makeImpulse(room){
    var decay = 0.5 * Math.pow(10, room / 100);
    var sr = ctx.sampleRate, len = Math.floor(sr * (decay + 0.05)), pre = Math.floor(sr * 0.015);
    var buf = ctx.createBuffer(2, len, sr);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c), y = 0;
      for (var i = pre; i < len; i++) {
        var t = (i - pre) / sr;
        var a = 0.85 - 0.75 * Math.min(1, t / decay); // tail gets darker over time
        y += a * ((Math.random() * 2 - 1) - y);
        d[i] = y * Math.exp(-6.9 * t / decay);
      }
    }
    return buf;
  }
  function swapImpulse(room, instant){
    var next = E.convActive === 'A' ? 'B' : 'A';
    N['conv' + next].buffer = makeImpulse(room);
    glide(N['conv' + next + 'Gain'].gain, 1, 0.08, instant);
    glide(N['conv' + E.convActive + 'Gain'].gain, 0, 0.08, instant);
    E.convActive = next;
  }
  function wp(name, v, instant){ // worklet AudioParam
    if (!N.stereo) return;
    glide(N.stereo.parameters.get(name), v, 0.03, instant);
  }
  function updateDry(instant){
    var r = Math.pow((E.state.reverb || 0) / 100, 0.8), e = Math.pow((E.state.echo || 0) / 100, 0.8);
    glide(N.dry.gain, (1 - 0.15 * r) * (1 - 0.12 * e), 0, instant);
  }

  // v: the control's value. instant: no glide (initial setup / offline rendering).
  E.set = function(id, v, instant){
    E.state[id] = v;
    switch (id) {
      case 'volume':
        glide(N.volume.gain, v <= 100 ? Math.pow(v / 100, 2) : 1, 0, instant);
        glide(N.drive.gain, (v > 100 ? Math.pow(10, (v - 100) / 100 * 14 / 20) : 1) / DRIVE_RANGE, 0, instant);
        var knee = satKnee(v);
        if (Math.abs(knee - E.knee) > 0.004) { N.sat.curve = softClipCurve(knee, DRIVE_RANGE); E.knee = knee; }
        break;
      case 'filter':
        var f = filterCutoffs(v);
        glide(N.lp.frequency, f.lp || ctx.sampleRate / 2, 0.02, instant);
        glide(N.hp.frequency, f.hp, 0.02, instant);
        glide(N.lp.Q, f.q, 0.02, instant); glide(N.hp.Q, f.q, 0.02, instant);
        glide(N.filtWet.gain, v === 0 ? 0 : 1, 0.012, instant); glide(N.filtDry.gain, v === 0 ? 1 : 0, 0.012, instant);
        break;
      case 'width': wp('width', v / 100, instant); break;
      case 'rotate':
        wp('depth', Math.min(1, v / 30), instant);
        wp('rate', 0.05 + 0.3 * Math.pow(v / 100, 1.5), instant);
        break;
      case 'reverb':
        glide(N.revSend.gain, Math.pow(v / 100, 0.8) * 0.75, 0, instant);
        updateDry(instant);
        break;
      case 'room':
        clearTimeout(E.irTimer);
        if (instant) swapImpulse(v, true); else E.irTimer = setTimeout(function(){ swapImpulse(v); }, 140);
        break;
      case 'echo':
        glide(N.echoSend.gain, Math.pow(v / 100, 0.8) * 0.6, 0, instant);
        updateDry(instant);
        break;
      case 'echoTime': glide(N.delay.delayTime, v / 1000, 0.06, instant); break; // slow glide = tape-style pitch bend
      case 'feedback': glide(N.fb.gain, v / 100, 0, instant); break;
    }
  };
  // bands: [{ type, freq, gain, Q }]. A shape change sets values at once: Q means
  // different things per type (resonance in dB for cuts), so no glide across it.
  E.setEq = function(bands, instant){
    bands.forEach(function(b, i){
      var f = N.eq[i], now = instant || f.type !== b.type;
      if (f.type !== b.type) f.type = b.type;
      glide(f.frequency, b.freq, 0.02, now); glide(f.gain, b.gain, 0.02, now); glide(f.Q, b.Q, 0.02, now);
    });
  };
  return E;
}

function ensureGraph(){
  if (engine) { if (ac.state === 'suspended') ac.resume(); return; }
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    ac = new AC();
    engine = createEngine(ac, ac.createMediaElementSource(audio));
    engine.loadWorklet().then(applyRates).catch(function(e){ console.warn('[TVFS Audio Player] Pitch/stereo worklets unavailable:', e); });
    if (ac.state === 'suspended') ac.resume();
    audio.volume = 1; // the engine owns volume from here on
    engine.setNorm(normGain(), true);
    Object.keys(CONTROLS).forEach(function(id){ applyControl(id, true); });
    applyEq();
  } catch (err) {
    // Playback must keep working even if Web Audio fails; only FX/visuals are lost.
    console.error('[TVFS Audio Player] Web Audio setup failed, playing without FX:', err);
    engine = null; ac = null;
  }
}

// Tempo, Nightcore and Pitch combined. Tempo is the speed T. Nightcore says how
// much of that speed change reaches the pitch (0% = speed only, 100% = pitch
// follows speed like a record), Pitch adds semitones on top: P = T^nc * 2^(st/12).
// The media element does T itself: with preservesPitch off it is a clean
// resample (pitch moves with T), with it on the browser time-stretches. 0% and
// 100% (time-stretch, nightcore, slowed) need nothing else. Anything in between
// uses the clean resample plus the worklet for the rest, so at most one
// time-stretching stage is ever in the chain.
function applyRates(){
  var T = values.tempo || 1;
  var P = Math.pow(T, (values.nightcore || 0) / 100) * Math.pow(2, (values.pitch || 0) / 12);
  var shiftCoupled = P / T, shiftKept = P;
  var coupled = Math.abs(Math.log(shiftCoupled)) < 6e-4 || Math.abs(Math.log(shiftKept)) >= 6e-4;
  var keep = !coupled;
  audio.preservesPitch = keep; audio.mozPreservesPitch = keep; audio.webkitPreservesPitch = keep;
  audio.defaultPlaybackRate = T;
  audio.playbackRate = T;
  var shift = coupled ? shiftCoupled : shiftKept;
  if (Math.abs(Math.log(shift)) < 6e-4) shift = 1;
  if (engine) engine.setPitchShift(shift);
  speedFactor = T;
}
var speedFactor = 1;
audio.addEventListener('loadedmetadata', applyRates);

// DJ filter: the first millimetres already do something audible, and the
// resonance grows towards the ends for that classic sweep.
function filterCutoffs(v){
  var u = Math.abs(v) / 100, q = 0.707 + 0.9 * u;
  if (v < 0) return { lp: 12000 * Math.pow(160 / 12000, u), hp: 10, q: q };
  if (v > 0) return { lp: null, hp: 20 * Math.pow(4000 / 20, u), q: q };
  return { lp: null, hp: 10, q: 0.707 };
}

function applyControl(id, initial){
  if (id === 'tempo' || id === 'pitch' || id === 'nightcore') { applyRates(); return; }
  if (!engine) {
    if (id === 'volume') audio.volume = clamp(Math.pow(Math.min(values.volume, 100) / 100, 2) * normGain(), 0, 1);
    return;
  }
  engine.set(id, values[id], initial);
}

// ─── Loudness normalization ─────────────────────────────────────────────────
// Tracks louder than -14 LUFS (the Spotify / YouTube level) are turned down to it
// at 100% volume; quieter ones are left alone (boosting them would only clip).
// The loudness is measured once at upload. A chip under the metadata switches
// back to the file's own loudness.
var TARGET_LUFS = -14;
var normDb = typeof CFG.lufs === 'number' && CFG.lufs > TARGET_LUFS ? TARGET_LUFS - CFG.lufs : 0;
var normOn = prefs.normalize !== false;
function normGain(){ return normOn ? Math.pow(10, normDb / 20) : 1; }
var btnNorm = $('btnNorm');
function syncNorm(){
  var d = Math.abs(normDb).toFixed(1);
  btnNorm.textContent = normOn ? 'Normalization: On' : 'Normalization: Off';
  btnNorm.title = normOn
    ? 'Loudness normalization on: this track is mastered very loud, so it is turned down ' + d + ' dB to the usual streaming level. Click for its original loudness.'
    : 'Loudness normalization off: playing at the original loudness of the file (' + d + ' dB louder). Click to match the usual streaming level again.';
  btnNorm.classList.toggle('is-off', !normOn);
}
if (normDb < -0.1) {
  btnNorm.classList.remove('hidden');
  syncNorm();
  btnNorm.addEventListener('click', function(){
    normOn = !normOn;
    savePrefs({ normalize: normOn });
    syncNorm();
    if (engine) engine.setNorm(normGain()); else applyControl('volume');
  });
}

// ─── Control definitions ────────────────────────────────────────────────────
var BPM = CFG.bpm || 0;
function pct(v){ return Math.round(v) + '%'; }
function fmtHz(f){ return f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + 'k' : Math.round(f) + ' Hz'; }
function num(str){ var m = /-?\d+(?:[.,]\d+)?/.exec(str); return m ? parseFloat(m[0].replace(',', '.')) : NaN; }

// Echo time detents follow the beat when the BPM is known (1/16, 1/8, dotted 1/8, 1/4).
var NOTE_DIVS = [[0.25, '1/16'], [0.5, '1/8'], [0.75, '1/8.'], [1, '1/4']];
var echoDetents = BPM ? NOTE_DIVS.map(function(d){ return 60000 / BPM * d[0]; }).filter(function(ms){ return ms >= 40 && ms <= 1200; }) : [];
function echoNote(ms){
  if (!BPM) return '';
  for (var i = 0; i < NOTE_DIVS.length; i++) if (Math.abs(60000 / BPM * NOTE_DIVS[i][0] - ms) < 1) return ' ' + NOTE_DIVS[i][1];
  return '';
}

// scale: 'lin' | 'log'. bipolar: the arc fills from the default (top) instead of from min.
var CONTROLS = {
  volume:   { name: 'Volume', min: 0, max: 200, def: 100, detents: [100], fmt: pct, warnAbove: 100,
              tip: 'Loudness. At 100% every track plays about as loud as on Spotify or YouTube (very loud masters are turned down). Above 100% (orange) is a warm, dirty boost, not remembered when you reload.' },
  filter:   { name: 'Filter', min: -100, max: 100, def: 0, bipolar: true,
              fmt: function(v){ if (Math.abs(v) < 0.5) return 'Off'; var f = filterCutoffs(v); return v < 0 ? 'LP ' + fmtHz(f.lp) : 'HP ' + fmtHz(f.hp); },
              parse: function(s){
                var n = num(s); if (isNaN(n)) return NaN;
                if (/k|hz/i.test(s)) { // a cutoff frequency: LP/HP from the text, else from the current side
                  var hz = /k/i.test(s) ? n * 1000 : n;
                  var hp = /hp|high/i.test(s) || (!/lp|low/i.test(s) && values.filter > 0);
                  return hp ? 100 * Math.log(hz / 20) / Math.log(4000 / 20) : -100 * Math.log(hz / 12000) / Math.log(160 / 12000); // inverse of filterCutoffs()
                }
                return n;
              },
              tip: 'DJ filter. Left muffles the highs, right thins out the bass.' },
  tempo:    { name: 'Tempo', min: 0.5, max: 2, def: 1, scale: 'log', bipolar: true,
              fmt: function(v){ return v.toFixed(2) + '×'; },
              parse: function(s){ var n = num(s); return /%/.test(s) ? n / 100 : n; },
              tip: 'Playback speed. Whether the pitch moves with it is set by Nightcore.' },
  pitch:    { name: 'Pitch', min: -12, max: 12, def: 0, bipolar: true, detents: [-12, 12],
              fmt: function(v){ var r = Math.round(v * 10) / 10; return (r > 0 ? '+' : '') + r.toFixed(1) + ' st'; },
              tip: 'Pitch in semitones without changing the speed.' },
  nightcore:{ name: 'Nightcore', min: 0, max: 100, def: 0, fmt: pct,
              tip: 'How much the pitch follows Tempo. 0% = only the speed changes, 100% = faster is higher (nightcore), slower is deeper (slowed).' },
  reverb:   { name: 'Reverb', min: 0, max: 100, def: 0, fmt: pct, tip: 'How much room echo you hear.' },
  room:     { name: 'Room', min: 0, max: 100, def: 45, fmt: pct, tip: 'Size of the room: small booth to huge hall.' },
  echo:     { name: 'Echo', min: 0, max: 100, def: 0, fmt: pct, tip: 'How loud the repeats are.' },
  echoTime: { name: 'Time', min: 40, max: 1200, def: echoDetents[1] || 375, scale: 'log', detents: echoDetents,
              fmt: function(v){ return Math.round(v) + ' ms' + echoNote(v); }, tip: 'Gap between repeats. Snaps to the beat when the BPM is known.' },
  feedback: { name: 'Repeats', min: 0, max: 90, def: 35, fmt: pct, tip: 'How many times the echo repeats.' },
  width:    { name: 'Width', min: 0, max: 200, def: 100, detents: [100], fmt: pct, tip: '0% is mono, 200% is extra wide.' },
  rotate:   { name: '8D', min: 0, max: 100, def: 0, fmt: pct, tip: 'Sound circles around your head. Best with headphones.' },
};
var GROUPS = [
  { name: 'Master', color: '#ff8fd0', ids: ['filter', 'volume'], desc: 'Tone and loudness' },
  { name: 'Speed & Pitch', color: '#2fffc4', ids: ['tempo', 'pitch', 'nightcore'], desc: 'How fast, and how high' },
  { name: 'Space', color: '#b083ff', ids: ['reverb', 'room', 'echo', 'echoTime', 'feedback'], desc: 'Room and echoes (the bass stays dry)' },
  { name: 'Stereo', color: '#6ea8ff', ids: ['width', 'rotate'], desc: 'Width and spin (the bass stays centred)' },
];
// Knobs that only matter once another one is turned up: [parent, hint]
var DEPENDS = {
  room: ['reverb', 'Turn up Reverb first. Room sets the size of that reverb.'],
  echoTime: ['echo', 'Turn up Echo first. Time sets the gap between its repeats.'],
  feedback: ['echo', 'Turn up Echo first. Repeats sets how long it keeps echoing.'],
  nightcore: ['tempo', 'Change Tempo first. Nightcore decides how much of that speed change also changes the pitch.'],
};
var PRESETS = [
  { cat: '', name: 'Original', set: {}, tip: 'Everything back to how the track really sounds, EQ included.' },
  { cat: 'Speed', name: 'Nightcore', set: { tempo: 1.25, nightcore: 100, width: 115 }, tip: 'Faster and higher.' },
  { cat: 'Speed', name: 'Sped up', set: { tempo: 1.15, nightcore: 100 }, tip: 'A little faster and higher, the short-video way.' },
  { cat: 'Speed', name: 'Slowed + Reverb', set: { tempo: 0.82, nightcore: 100, reverb: 38, room: 72 }, tip: 'Slower, deeper, in a big room.' },
  { cat: 'Speed', name: 'Daycore', set: { tempo: 0.86, nightcore: 100 }, tip: 'Slower and deeper, no reverb.' },
  { cat: 'Speed', name: 'Vaporwave', set: { tempo: 0.78, nightcore: 100, reverb: 30, room: 70, filter: -18, width: 125 }, tip: 'Slow, dreamy and a bit faded.' },
  { cat: 'Speed', name: 'Half speed', set: { tempo: 0.5 }, tip: 'Half the speed, same pitch.' },
  { cat: 'Space', name: 'Small room', set: { reverb: 28, room: 12 }, tip: 'A tight, close room.' },
  { cat: 'Space', name: 'Concert hall', set: { reverb: 45, room: 85, width: 130 }, tip: 'A big, wide hall.' },
  { cat: 'Space', name: 'Dreamy', set: { reverb: 55, room: 92, echo: 18, feedback: 40, width: 140, filter: -12 }, tip: 'Floating in a soft cloud.' },
  { cat: 'Space', name: 'Echo', set: { echo: 34, feedback: 45 }, tip: 'Repeats in time with the beat.' },
  { cat: 'Space', name: 'Dub', set: { echo: 45, feedback: 62, echoTime: echoDetents[2] || 450, reverb: 12, filter: -10 }, tip: 'Long, dark repeats on the off-beat.' },
  { cat: 'Fun', name: '8D', set: { rotate: 35, width: 130, reverb: 18, room: 55 }, tip: 'The sound circles around your head. Use headphones.' },
  { cat: 'Fun', name: 'Spin', set: { rotate: 85, width: 140 }, tip: 'Fast circling, close to dizzy.' },
  { cat: 'Fun', name: 'Chipmunk', set: { pitch: 7 }, tip: 'Much higher, same speed.' },
  { cat: 'Fun', name: 'Deep voice', set: { pitch: -5 }, tip: 'Deeper, same speed.' },
  { cat: 'Fun', name: 'Lo-fi', set: { filter: -42, tempo: 0.94, nightcore: 100, width: 70, reverb: 12 }, tip: 'Muffled and a bit slower, like an old tape.' },
  { cat: 'Fun', name: 'Radio', set: { filter: 38, width: 0 }, tip: 'Thin and mono, like a small radio.' },
  { cat: 'Fun', name: 'Underwater', set: { filter: -72, reverb: 30, room: 60, width: 60 }, tip: 'Heard from the bottom of a pool.' },
  { cat: 'Fun', name: 'Mono', set: { width: 0 }, tip: 'Both ears hear the same thing.' },
  { cat: 'Fun', name: 'Super wide', set: { width: 190 }, tip: 'Spread far beyond the speakers.' },
];

function toNorm(c, v){
  if (c.scale === 'log') return Math.log(v / c.min) / Math.log(c.max / c.min);
  return (v - c.min) / (c.max - c.min);
}
function fromNorm(c, n){
  n = clamp(n, 0, 1);
  if (c.scale === 'log') return c.min * Math.pow(c.max / c.min, n);
  return c.min + n * (c.max - c.min);
}

// ─── Knob ───────────────────────────────────────────────────────────────────
// 270° FL-style dial. Any drag direction works: up/right raises, down/left
// lowers. Shift (or Ctrl/Alt) = fine. Double-click = default. Wheel and arrow
// keys work too. The dial is drawn by a spring so it feels physical, but the
// value itself never lags behind the hand.
var SVGNS = 'http://www.w3.org/2000/svg';
var A0 = -135, A1 = 135, RING = 44;
function polar(r, deg){ var a = deg * Math.PI / 180; return [r * Math.sin(a), -r * Math.cos(a)]; }
function arcPath(r, d0, d1){
  if (Math.abs(d1 - d0) < 0.01) return '';
  var p0 = polar(r, d0), p1 = polar(r, d1);
  return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) + 'A' + r + ' ' + r + ' 0 ' + (Math.abs(d1 - d0) > 180 ? 1 : 0) + ' ' + (d1 > d0 ? 1 : 0) + ' ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
}
function svgEl(tag, attrs, parent){
  var el = document.createElementNS(SVGNS, tag);
  for (var k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
}
// Vibration only on touch devices (desktop Chrome logs an error for it without a tap).
var canVibrate = !!navigator.vibrate && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
function haptic(ms){ if (canVibrate) { try { navigator.vibrate(ms); } catch (e) {} } }

var knobs = {};
var springing = [];
var knobUid = 0;

// ext (optional): { c: definition like CONTROLS[id], get(), set(v) } for knobs
// that drive something other than a rack control (the EQ band knobs).
function Knob(id, color, ext){
  var c = ext ? ext.c : CONTROLS[id], self = this;
  this.id = id; this.c = c; this.ext = ext || null; this.color = color;
  this.get = ext ? ext.get : function(){ return values[id]; };
  this.set = ext ? ext.set : function(v){ values[id] = v; applyControl(id); };
  this.n = toNorm(c, this.get());       // value position 0..1
  this.disp = this.n; this.vel = 0;     // drawn position (spring)
  this.squish = 1; this.squishVel = 0;  // body scale (spring)
  this.glow = 0;
  this.pressed = false; this.over = 0;
  this.detentNorms = (c.detents || []).concat(c.bipolar || c.def !== c.min ? [c.def] : []).map(function(v){ return toNorm(c, v); });

  var el = this.el = document.createElement('div');
  el.className = 'knob';
  el.style.setProperty('--k-color', color);
  var dial = this.dial = document.createElement('div');
  dial.className = 'knob-dial';
  dial.tabIndex = 0;
  dial.setAttribute('role', 'slider');
  dial.setAttribute('aria-label', c.name);
  dial.title = c.tip;
  var uid = 'kg' + (++knobUid);
  var svg = svgEl('svg', { viewBox: '-50 -50 100 100' }, dial);
  var defs = svgEl('defs', {}, svg);
  defs.innerHTML =
    '<radialGradient id="' + uid + 'b" cx="35%" cy="28%" r="80%"><stop offset="0" stop-color="#3a4152"/><stop offset=".55" stop-color="#1b1f2a"/><stop offset="1" stop-color="#0c0e14"/></radialGradient>' +
    '<radialGradient id="' + uid + 'g"><stop offset=".55" stop-color="' + color + '" stop-opacity=".35"/><stop offset="1" stop-color="' + color + '" stop-opacity="0"/></radialGradient>';
  this.glowEl = svgEl('circle', { r: 50, fill: 'url(#' + uid + 'g)', opacity: 0 }, svg);
  svgEl('path', { d: arcPath(RING, A0, A1), fill: 'none', stroke: 'rgba(255,255,255,.1)', 'stroke-width': 5, 'stroke-linecap': 'round' }, svg);
  this.arcEl = svgEl('path', { fill: 'none', stroke: color, 'stroke-width': 5, 'stroke-linecap': 'round' }, svg);
  var dp = polar(RING, A0 + 270 * toNorm(c, c.def));
  svgEl('circle', { cx: dp[0].toFixed(2), cy: dp[1].toFixed(2), r: 1.6, fill: 'rgba(255,255,255,.45)' }, svg);
  this.bodyEl = svgEl('g', {}, svg);
  svgEl('circle', { r: 34, fill: 'rgba(0,0,0,.45)', cy: 3 }, this.bodyEl);
  svgEl('circle', { r: 33, fill: 'url(#' + uid + 'b)', stroke: 'rgba(255,255,255,.13)', 'stroke-width': 1 }, this.bodyEl);
  svgEl('circle', { r: 26, fill: 'none', stroke: 'rgba(255,255,255,.05)', 'stroke-width': 1 }, this.bodyEl);
  this.ptrEl = svgEl('g', {}, this.bodyEl);
  svgEl('line', { x1: 0, y1: -13, x2: 0, y2: -28, stroke: '#fff', 'stroke-width': 4, 'stroke-linecap': 'round' }, this.ptrEl);
  this.capEl = svgEl('circle', { cx: 0, cy: -28, r: 2.6, fill: color }, this.ptrEl);

  var label = this.label = document.createElement('div');
  label.className = 'knob-label';
  label.innerHTML = '<span class="knob-name"></span><span class="knob-value"></span>';
  label.firstChild.textContent = c.name;
  this.valueEl = label.lastChild;
  el.appendChild(dial); el.appendChild(label);

  this.bindPointer();
  this.bindLabel();
  dial.addEventListener('wheel', function(e){
    e.preventDefault();
    ensureGraph();
    var fine = e.shiftKey || e.ctrlKey || e.altKey;
    var d = e.deltaMode === 0 ? -e.deltaY * 0.0011 : -Math.sign(e.deltaY) * 0.02;
    if (e.deltaX && Math.abs(e.deltaX) > Math.abs(e.deltaY)) d = e.deltaMode === 0 ? e.deltaX * 0.0011 : Math.sign(e.deltaX) * 0.02;
    self.setNorm(self.n + d * (fine ? 0.2 : 1), true);
    self.peek(900);
  }, { passive: false });
  dial.addEventListener('keydown', function(e){
    var step = e.shiftKey ? 0.002 : 0.01, n = self.n;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') n += step;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') n -= step;
    else if (e.key === 'PageUp') n += 0.1;
    else if (e.key === 'PageDown') n -= 0.1;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = 1;
    else if (e.key === 'Delete' || e.key === 'Backspace') { self.reset(); e.preventDefault(); return; }
    else if (e.key === 'Enter') { self.edit(); e.preventDefault(); return; }
    else return;
    e.preventDefault();
    ensureGraph();
    self.setNorm(n, true);
  });
  dial.addEventListener('focus', function(){ el.classList.add('show-value'); });
  dial.addEventListener('blur', function(){ if (!self.pressed && !self.hovering) el.classList.remove('show-value'); });
  el.addEventListener('pointerenter', function(e){
    if (e.pointerType !== 'mouse') return;
    self.hovering = true; el.classList.add('show-value'); self.wake();
    clearTimeout(tipTimer);
    tipTimer = setTimeout(function(){ if (self.hovering && !self.pressed) showTip(self); }, 550);
  });
  el.addEventListener('pointerleave', function(e){
    if (e.pointerType !== 'mouse') return;
    self.hovering = false;
    clearTimeout(tipTimer);
    if (tipFor === self) hideTip();
    if (!self.pressed && document.activeElement !== dial) el.classList.remove('show-value');
    self.wake();
  });
  this.sync();
  this.draw();
}

Knob.prototype.bindPointer = function(){
  var self = this, dial = this.dial;
  var startX, startY, anchorN, anchorRaw, fineMode, moved, lastUp = 0, raw;
  dial.addEventListener('pointerdown', function(e){
    if (e.button !== 0) return;
    e.preventDefault();
    ensureGraph();
    dial.focus({ preventScroll: true });
    try { dial.setPointerCapture(e.pointerId); } catch (err) {}
    self.pressed = true; moved = false;
    self.el.classList.add('dragging', 'show-value');
    startX = e.clientX; startY = e.clientY;
    anchorN = raw = self.n; anchorRaw = 0;
    fineMode = e.shiftKey || e.ctrlKey || e.altKey;
    self.squishVel -= 1.6; // the press "gives" a little
    self.wake();
    clearTimeout(tipTimer);
    if (self.el.classList.contains('idle')) { if (DEPENDS[self.id]) knobs[DEPENDS[self.id][0]].nudge(); showTip(self); }
    else if (tipFor) hideTip();
    if (e.pointerType !== 'mouse') tipTimer = setTimeout(function(){ if (self.pressed && !moved) { showTip(self); haptic(8); } }, 450);
  });
  dial.addEventListener('pointermove', function(e){
    if (!self.pressed) return;
    var travel = (e.clientX - startX) - (e.clientY - startY);
    if (!moved && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 3) { moved = true; clearTimeout(tipTimer); }
    var fine = e.shiftKey || e.ctrlKey || e.altKey;
    var range = e.pointerType === 'touch' ? 260 : 230;
    if (fine !== fineMode) { anchorN = raw; anchorRaw = travel; fineMode = fine; }
    raw = anchorN + (travel - anchorRaw) / range * (fine ? 0.15 : 1);
    self.setNorm(raw, true, true);
  });
  function up(e){
    if (!self.pressed) return;
    self.pressed = false;
    self.el.classList.remove('dragging');
    self.over = 0;
    var now = performance.now();
    if (!moved) {
      if (now - lastUp < 320) { self.reset(); lastUp = 0; }
      else lastUp = now;
    }
    if (!(e.pointerType === 'mouse' && self.hovering)) self.peek(1200);
    self.squishVel += 0.6;
    self.wake();
  }
  dial.addEventListener('pointerup', up);
  dial.addEventListener('pointercancel', up);
  dial.addEventListener('dblclick', function(e){ e.preventDefault(); });
};

Knob.prototype.bindLabel = function(){
  var self = this, lastTap = 0;
  this.label.addEventListener('dblclick', function(e){ e.preventDefault(); self.edit(); });
  this.label.addEventListener('pointerup', function(e){
    if (e.pointerType === 'mouse') return;
    var now = performance.now();
    if (now - lastTap < 320) { self.edit(); lastTap = 0; return; }
    lastTap = now;
    self.peek(2000);
  });
};

// Show the number for a moment (touch has no hover).
Knob.prototype.peek = function(ms){
  var self = this;
  this.el.classList.add('show-value');
  clearTimeout(this.peekTimer);
  this.peekTimer = setTimeout(function(){
    if (!self.pressed && !self.hovering && document.activeElement !== self.dial) self.el.classList.remove('show-value');
  }, ms);
};

// fromUser: a hand moved it (detents + edge rubber band apply).
Knob.prototype.setNorm = function(n, fromUser, dragging){
  var over = 0;
  if (n < 0) { over = n; n = 0; } else if (n > 1) { over = n - 1; n = 1; }
  if (dragging) {
    // magnetic detents: a small dead zone around default/centre/beat values
    var snapped = null;
    for (var i = 0; i < this.detentNorms.length; i++) if (Math.abs(n - this.detentNorms[i]) < 0.018) snapped = this.detentNorms[i];
    if (snapped !== null) {
      if (this.snappedTo !== snapped) { this.squishVel -= 0.9; haptic(6); }
      n = snapped;
    }
    this.snappedTo = snapped;
    if (over && !this.over) { this.squishVel -= 1.2; haptic(10); }
    this.over = clamp(over, -0.25, 0.25);
  }
  var v = fromNorm(this.c, n);
  if (this.c.scale !== 'log') v = Math.round(v * 100) / 100;
  if (v === this.get() && n === this.n) { this.wake(); return; }
  this.n = n;
  this.set(v, fromUser);
  this.sync();
  if (!this.ext) { if (fromUser) onUserChange(); updateIdle(); }
  this.wake();
};
Knob.prototype.nudge = function(){
  var el = this.el;
  this.squishVel -= 2.4; this.glow = 1; this.wake();
  el.classList.remove('nudge'); void el.offsetWidth; el.classList.add('nudge');
  haptic(12);
};
Knob.prototype.setValue = function(v, fromUser){ this.setNorm(toNorm(this.c, clamp(v, this.c.min, this.c.max)), fromUser); };
Knob.prototype.reset = function(){
  this.setValue(this.c.def, true);
  this.squishVel -= 1.4;
  this.peek(1000);
};
Knob.prototype.sync = function(){
  var v = this.get();
  this.valueEl.textContent = this.c.fmt(v);
  this.dial.setAttribute('aria-valuetext', this.c.fmt(v));
  this.el.classList.toggle('changed', Math.abs(v - this.c.def) > 1e-6);
};

Knob.prototype.edit = function(){
  var self = this;
  if (this.label.querySelector('input')) return;
  var input = document.createElement('input');
  input.className = 'knob-input';
  input.value = this.c.fmt(this.get()).replace('×', '');
  input.setAttribute('inputmode', 'decimal');
  input.setAttribute('aria-label', this.c.name + ' value');
  this.label.appendChild(input);
  input.focus(); input.select();
  var done = false;
  function finish(commit){
    if (done) return; done = true;
    if (commit) {
      var v = (self.c.parse || num)(input.value);
      if (!isNaN(v)) { ensureGraph(); self.setValue(v, true); self.squishVel -= 1; }
    }
    input.remove();
    self.peek(1200);
  }
  input.addEventListener('keydown', function(e){
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', function(){ finish(true); });
};

Knob.prototype.wake = function(){ if (springing.indexOf(this) < 0) springing.push(this); };

// One shared spring loop for every knob that is still moving.
var lastSpring = 0;
function springLoop(now){
  requestAnimationFrame(springLoop);
  var dt = Math.min(0.034, (now - (lastSpring || now)) / 1000); lastSpring = now;
  if (!dt) return;
  for (var i = springing.length - 1; i >= 0; i--) {
    var k = springing[i];
    // rubber band: past the end stop the pointer stretches a little, then springs back
    var target = k.n + (k.pressed ? Math.tanh(k.over * 4) * 0.035 : 0);
    var acc = 520 * (target - k.disp) - 2 * Math.sqrt(520) * 0.68 * k.vel;
    k.vel += acc * dt; k.disp += k.vel * dt;
    var sTarget = k.pressed ? 0.93 : 1;
    var sAcc = 700 * (sTarget - k.squish) - 2 * Math.sqrt(700) * 0.32 * k.squishVel;
    k.squishVel += sAcc * dt; k.squish += k.squishVel * dt;
    var gTarget = k.pressed ? 1 : k.hovering ? 0.45 : 0;
    k.glow += (gTarget - k.glow) * Math.min(1, dt * 14);
    if (reduceMotion) { k.disp = target; k.vel = 0; k.squish = sTarget; k.squishVel = 0; }
    k.draw();
    if (!k.pressed && Math.abs(target - k.disp) < 1e-4 && Math.abs(k.vel) < 1e-3 &&
        Math.abs(1 - k.squish) < 1e-3 && Math.abs(k.squishVel) < 1e-3 && Math.abs(gTarget - k.glow) < 0.01) {
      k.disp = target; k.squish = 1; k.draw();
      springing.splice(i, 1);
    }
  }
}
requestAnimationFrame(springLoop);

Knob.prototype.draw = function(){
  var c = this.c;
  var ang = A0 + 270 * this.disp;
  var startN = c.bipolar ? toNorm(c, c.def) : 0;
  var a0 = A0 + 270 * startN;
  var lo = Math.max(A0 - 12, Math.min(a0, ang)), hi = Math.min(A1 + 12, Math.max(a0, ang));
  this.arcEl.setAttribute('d', arcPath(RING, lo, hi));
  if (c.warnAbove !== undefined) { // e.g. Volume: the boost zone turns warm
    var hot = this.get() > c.warnAbove;
    if (hot !== this.hot) { this.hot = hot; this.arcEl.setAttribute('stroke', hot ? '#ffb36b' : this.color); this.el.classList.toggle('hot', hot); }
  }
  this.ptrEl.setAttribute('transform', 'rotate(' + ang.toFixed(2) + ')');
  this.bodyEl.setAttribute('transform', 'scale(' + this.squish.toFixed(4) + ')');
  this.glowEl.setAttribute('opacity', this.glow.toFixed(3));
};

// ─── Rack, presets ──────────────────────────────────────────────────────────
Object.keys(CONTROLS).forEach(function(id){ values[id] = CONTROLS[id].def; });
// The boost above 100% is never remembered: a page should not open already distorted.
if (typeof prefs.volume === 'number') values.volume = clamp(prefs.volume, 0, 100);

var rackGroups = $('rackGroups');
GROUPS.forEach(function(g){
  var box = document.createElement('div');
  box.className = 'group';
  box.style.setProperty('--k-color', g.color);
  box.innerHTML = '<h3></h3><div class="group-desc"></div><div class="knobs"></div>';
  box.firstChild.textContent = g.name;
  box.children[1].textContent = g.desc;
  g.ids.forEach(function(id){
    var k = new Knob(id, g.color);
    knobs[id] = k;
    box.lastChild.appendChild(k.el);
  });
  rackGroups.appendChild(box);
});

var presetsEl = $('presets'), activePreset = null, presetAnim = 0;
var markPresetChips = buildPresetRows(presetsEl, PRESETS, applyPreset,
  ['Original', 'Nightcore', 'Slowed + Reverb', '8D', 'Lo-fi'], 'presetsOpen');
function markPreset(i){
  activePreset = i;
  markPresetChips(i);
}
// Knobs glide to the preset (and the sound sweeps with them).
function applyPreset(i){
  var p = PRESETS[i], from = {}, to = {};
  Object.keys(CONTROLS).forEach(function(id){
    if (id === 'volume') return;
    from[id] = knobs[id].n;
    to[id] = toNorm(CONTROLS[id], id in p.set ? p.set[id] : CONTROLS[id].def);
  });
  cancelAnimationFrame(presetAnim);
  var t0 = performance.now(), dur = reduceMotion || document.hidden ? 0 : 520;
  if (!dur) { Object.keys(to).forEach(function(id){ knobs[id].setNorm(to[id], false); }); markPreset(i); if (i === 0) { setEqBypass(false); applyEqPreset(0); } return; }
  (function step(now){
    var t = clamp((now - t0) / dur, 0, 1), e = 1 - Math.pow(1 - t, 3);
    Object.keys(to).forEach(function(id){ knobs[id].setNorm(from[id] + (to[id] - from[id]) * e, false); });
    if (t < 1) presetAnim = requestAnimationFrame(step);
  })(t0);
  markPreset(i);
  if (i === 0 && typeof applyEqPreset === 'function') { setEqBypass(false); applyEqPreset(0); } // Original = really original, EQ included
  savePrefs({ volume: Math.min(values.volume, 100) });
}
var saveTimer = 0;
function onUserChange(){
  if (activePreset !== null) markPreset(null);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function(){ savePrefs({ volume: Math.min(values.volume, 100) }); }, 400);
}
markPreset(0);
$('btnResetAll').addEventListener('click', function(){ ensureGraph(); applyPreset(0); });

// ─── Explanations: knob tooltips and "idle" knobs ───────────────────────────
var tipEl = document.createElement('div');
tipEl.className = 'tip';
tipEl.setAttribute('role', 'tooltip');
tipEl.innerHTML = '<b></b><p></p><small></small>';
document.body.appendChild(tipEl);
var tipFor = null, tipTimer = 0, tipHideTimer = 0;
var noHover = window.matchMedia ? window.matchMedia('(hover: none)').matches : false;
var HOW_MOUSE = 'Drag up or right = more, down or left = less. Shift = fine. Double-click = reset.';
var HOW_TOUCH = 'Drag up or right = more, down or left = less. Double-tap = reset. Double-tap the name to type a value.';

function showTip(k){
  var idle = k.el.classList.contains('idle');
  tipEl.children[0].textContent = k.c.name;
  tipEl.children[1].textContent = idle ? (k.idleTip || DEPENDS[k.id][1]) : k.c.tip;
  tipEl.children[2].textContent = idle ? '' : (noHover ? HOW_TOUCH : HOW_MOUSE);
  tipEl.classList.toggle('is-idle', idle);
  tipEl.style.setProperty('--k-color', k.el.style.getPropertyValue('--k-color'));
  tipFor = k;
  tipEl.classList.add('show');
  var r = k.dial.getBoundingClientRect(), tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  var x = clamp(r.left + r.width / 2 - tw / 2, 8, window.innerWidth - tw - 8);
  var y = r.top - th - 10;
  if (y < 8) y = r.bottom + 34;
  tipEl.style.left = Math.round(x) + 'px';
  tipEl.style.top = Math.round(y) + 'px';
  clearTimeout(tipHideTimer);
  if (noHover || idle) tipHideTimer = setTimeout(hideTip, 4000);
}
function hideTip(){ tipEl.classList.remove('show'); tipFor = null; }
window.addEventListener('scroll', function(){ if (tipFor) hideTip(); }, { passive: true });

function parentActive(id){ return id === 'tempo' ? Math.abs(values.tempo - 1) > 0.004 : values[id] > 0; }
function updateIdle(){
  for (var id in DEPENDS) if (knobs[id]) knobs[id].el.classList.toggle('idle', !parentActive(DEPENDS[id][0]));
}
updateIdle();

// ─── First-run tour ─────────────────────────────────────────────────────────
// Spotlights the real controls one by one; the knob step waits until the
// visitor has actually turned one. Shown once per browser, the ? button replays it.
var tour = null;
var TOUR_STEPS = [
  { title: 'New sound controls', text: 'A quick tour, about 30 seconds. Skip it any time, the ? button in the top right brings it back.', next: 'Start' },
  { target: function(){ return btnPlay; }, title: 'Press play', text: 'Start the music first, so you can hear what everything does.' },
  { target: function(){ return knobs.tempo.el; }, title: 'Turn a knob', wait: 'tempo',
    text: 'Grab Tempo and drag up or right for more, down or left for less. Anywhere on the knob works. Try it now!',
    done: 'Nice! That is how every knob works.' },
  { target: function(){ return knobs.tempo.el; }, title: 'Exact values',
    text: noHover
      ? 'Tap the name under a knob to see its value, double-tap it to type a number. Double-tap the knob itself to reset it. Hold a knob to see what it does.'
      : 'Hold Shift while dragging for fine steps. Hover a knob to see its value and what it does, double-click the number to type one. Double-click the knob to reset it.' },
  { target: function(){ return knobs.nightcore.el; }, title: 'Nightcore',
    text: 'Decides how much the pitch follows Tempo. 0% = only the speed changes. 100% = faster is also higher (nightcore), slower is deeper (slowed). Pitch next to it moves the pitch on its own.' },
  { target: function(){ return $('presets'); }, title: 'Presets', text: 'Ready-made recipes. One tap and the knobs glide there. Original resets everything.' },
  { target: function(){ return $('rackGroups'); }, title: 'What is what', html:
      '<ul><li><b>Master</b>: DJ filter and volume. Above 100% is a warm, dirty boost.</li>' +
      '<li><b>Speed &amp; Pitch</b>: tempo, pitch and nightcore.</li>' +
      '<li><b>Space</b>: reverb and echo. Room, Time and Repeats wake up once Reverb or Echo is turned up.</li>' +
      '<li><b>Stereo</b>: width and 8D (best with headphones).</li></ul>' },
  { target: function(){ return $('btnEq'); }, title: 'EQ', text: noHover
      ? 'Opens a 7-band EQ over the live spectrum. Drag the coloured points to shape the sound, hold a point to change its shape. The dot on the button means the EQ is doing something.'
      : 'Opens a 7-band EQ over the live spectrum. Drag the coloured points, scroll on one for its width, right-click it for its shape. The dot on the button means the EQ is doing something.' },
  { target: function(){ return $('btnVis'); }, title: 'Visualizer', text: 'The particles react to the music. This button turns them on and off.', next: 'Done' },
];

function startTour(){
  if (tour) endTour(false);
  hideTip();
  var el = document.createElement('div');
  el.className = 'tour';
  el.innerHTML = '<div class="tour-hole"></div><div class="tour-card glass" role="dialog" aria-live="polite">' +
    '<div class="tour-count"></div><h4></h4><div class="tour-text"></div>' +
    '<div class="tour-actions"><button class="tour-skip">Skip</button><span class="tour-dots"></span>' +
    '<button class="tour-back">Back</button><button class="tour-next">Next</button></div></div>';
  document.body.appendChild(el);
  tour = { el: el, hole: el.firstChild, card: el.lastChild, i: 0, poll: 0 };
  tour.card.querySelector('.tour-skip').onclick = function(){ endTour(true); };
  tour.card.querySelector('.tour-back').onclick = function(){ if (tour) showStep(tour.i - 1); };
  tour.card.querySelector('.tour-next').onclick = function(){
    if (!tour) return; // a double click on Done lands here after the tour has ended
    if (tour.i >= TOUR_STEPS.length - 1) endTour(true); else showStep(tour.i + 1);
  };
  void el.offsetWidth; // commit the hidden state so the fade-in transition runs
  el.classList.add('on');
  showStep(0);
}
function endTour(remember){
  if (!tour) return;
  clearInterval(tour.poll);
  var el = tour.el;
  el.classList.remove('on');
  setTimeout(function(){ el.remove(); }, 250);
  tour = null;
  if (remember) savePrefs({ tourDone: true });
}
function showStep(i){
  var st = TOUR_STEPS[i];
  if (!st) return;
  tour.i = i;
  clearInterval(tour.poll);
  var card = tour.card, next = card.querySelector('.tour-next');
  card.querySelector('.tour-count').textContent = (i + 1) + ' / ' + TOUR_STEPS.length;
  card.querySelector('h4').textContent = st.title;
  var text = card.querySelector('.tour-text');
  if (st.html) text.innerHTML = st.html; else text.textContent = st.text;
  card.querySelector('.tour-back').style.visibility = i ? 'visible' : 'hidden';
  next.textContent = st.next || 'Next';
  card.classList.remove('success');
  next.disabled = false;
  if (st.wait) {
    var start = values[st.wait];
    next.disabled = true;
    tour.poll = setInterval(function(){
      if (Math.abs(values[st.wait] - start) > 1e-6) {
        clearInterval(tour.poll);
        var p = document.createElement('p'); p.className = 'tour-done'; p.textContent = st.done;
        text.appendChild(p);
        card.classList.add('success');
        next.disabled = false;
      }
    }, 150);
  }
  var target = st.target && st.target();
  if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  placeTour();
  setTimeout(placeTour, 380); // after the smooth scroll settles
}
function placeTour(){
  if (!tour) return;
  var st = TOUR_STEPS[tour.i], target = st.target && st.target(), hole = tour.hole, card = tour.card;
  var vw = window.innerWidth, vh = window.innerHeight, cw = card.offsetWidth, ch = card.offsetHeight;
  if (!target) {
    hole.style.cssText = 'left:' + (vw / 2) + 'px;top:' + (vh / 2) + 'px;width:0;height:0;';
    card.style.left = Math.round((vw - cw) / 2) + 'px';
    card.style.top = Math.round((vh - ch) / 2) + 'px';
    return;
  }
  var r = target.getBoundingClientRect(), pad = 8;
  hole.style.cssText = 'left:' + (r.left - pad) + 'px;top:' + (r.top - pad) + 'px;width:' + (r.width + pad * 2) + 'px;height:' + (r.height + pad * 2) + 'px;';
  var x, y;
  if (vw < 600) { // phones: card pinned to the side of the screen away from the target
    x = (vw - cw) / 2;
    y = r.top + r.height / 2 > vh / 2 ? 12 : vh - ch - 12;
  } else {
    x = clamp(r.left + r.width / 2 - cw / 2, 12, vw - cw - 12);
    y = r.bottom + pad + 14;
    if (y + ch > vh - 12) y = r.top - pad - 14 - ch;
    if (y < 12) { // no room above or below: beside the target, else bottom of the screen
      y = clamp(r.top + r.height / 2 - ch / 2, 12, vh - ch - 12);
      if (r.left - pad - 14 - cw >= 12) x = r.left - pad - 14 - cw;
      else if (r.right + pad + 14 + cw <= vw - 12) x = r.right + pad + 14;
      else y = vh - ch - 12;
    }
  }
  card.style.left = Math.round(x) + 'px';
  card.style.top = Math.round(y) + 'px';
}
window.addEventListener('resize', placeTour);
window.addEventListener('scroll', function(){ if (tour) placeTour(); }, { passive: true });
document.addEventListener('keydown', function(e){ if (tour && e.key === 'Escape') endTour(true); });
$('btnHelp').addEventListener('click', startTour);
var tourPending = !prefs.tourDone;
function maybeStartTour(){
  if (!tourPending) return;
  tourPending = false;
  (function tryStart(){ // the TVFS Users Only player may still be asking "stay logged in?"
    var stay = $('stayOverlay');
    if (stay && stay.classList.contains('visible')) setTimeout(tryStart, 400); else startTour();
  })();
}

applyControl('volume');

// ─── EQ (in the spirit of Fruity Parametric EQ 2) ───────────────────────────
// 7 bands on a live spectrum. The curve is the filters' real response, taken
// from the same BiquadFilterNode maths the audio uses (a silent offline context
// computes it, so it also works before playback has started).
// Graph point: drag = frequency + gain (cut filters: resonance), Shift = fine,
// wheel = width (Q), double-click = reset band, right-click / long-press = shape.
// Next to the graph sits a channel strip per band: shape button, gain fader,
// FREQ and BW mini knobs, so every band is in reach at once.
var EQ_COLORS = ['#ff6fb1', '#ff9d5c', '#ffd36b', '#7dffa8', '#2fffc4', '#4fb2ff', '#a77bff'];
var EQ_TYPES = [
  { id: 'peaking', name: 'Peak', icon: 'M2 13h5c2 0 2.5-8 5-8s3 8 5 8h5' },
  { id: 'lowshelf', name: 'Low shelf', icon: 'M2 6h5c3 0 4 7 7 7h8' },
  { id: 'highshelf', name: 'High shelf', icon: 'M2 13h8c3 0 4-7 7-7h5' },
  { id: 'highpass', name: 'Low cut', icon: 'M3 20c2-9 4-11 7-11h12' },
  { id: 'lowpass', name: 'High cut', icon: 'M2 9h12c3 0 5 2 7 11' },
  { id: 'notch', name: 'Notch', icon: 'M2 7h7.5c1 0 1.5 12 2.5 12s1.5-12 2.5-12H22' },
];
var EQ_DEFAULTS = [
  { type: 'lowshelf', freq: 60 }, { type: 'peaking', freq: 150 }, { type: 'peaking', freq: 400 },
  { type: 'peaking', freq: 1000 }, { type: 'peaking', freq: 2500 }, { type: 'peaking', freq: 6000 },
  { type: 'highshelf', freq: 12000 },
].map(function(b){ b.gain = 0; b.q = 1; b.on = true; return b; });
// bands: { index: changes from the default }
var EQ_PRESETS = [
  { cat: '', name: 'Flat', tip: 'No EQ at all.', bands: {} },
  { cat: 'Tone', name: 'Bass boost', tip: 'More low end.', bands: { 0: { freq: 90, gain: 6 } } },
  { cat: 'Tone', name: 'Sub boost', tip: 'Only the deepest rumble, below the kick.', bands: { 0: { type: 'peaking', freq: 45, gain: 7, q: 1.2 } } },
  { cat: 'Tone', name: 'Phonk bass', tip: 'A fat, tight 808 hump.', bands: { 0: { type: 'peaking', freq: 55, gain: 6, q: 1.4 }, 2: { freq: 300, gain: -2, q: 1 } } },
  { cat: 'Tone', name: 'Warm', tip: 'Fuller lows, softer highs.', bands: { 0: { freq: 180, gain: 3 }, 6: { freq: 7000, gain: -3.5 } } },
  { cat: 'Tone', name: 'Bright', tip: 'More shine in the highs.', bands: { 5: { freq: 4500, gain: 2.5 }, 6: { freq: 7500, gain: 6 } } },
  { cat: 'Tone', name: 'Air', tip: 'A light lift at the very top.', bands: { 6: { freq: 12000, gain: 5 } } },
  { cat: 'Tone', name: 'V-shape', tip: 'More bass and treble, fewer mids.', bands: { 0: { freq: 90, gain: 5 }, 3: { gain: -3.5, q: 0.7 }, 6: { freq: 9000, gain: 5 } } },
  { cat: 'Tone', name: 'Loudness', tip: 'Fuller sound at low listening volume.', bands: { 0: { freq: 80, gain: 6 }, 3: { gain: -1.5, q: 0.6 }, 6: { freq: 10000, gain: 4 } } },
  { cat: 'Fix', name: 'De-mud', tip: 'Clears up a boomy, muddy low-mid.', bands: { 2: { freq: 300, gain: -4.5, q: 1.2 } } },
  { cat: 'Fix', name: 'Scoop', tip: 'Pulls the mids back.', bands: { 3: { freq: 600, gain: -5, q: 0.6 } } },
  { cat: 'Fix', name: 'Presence', tip: 'Vocals and leads step forward.', bands: { 4: { freq: 3500, gain: 4, q: 0.9 } } },
  { cat: 'Fix', name: 'Vocal', tip: 'Less rumble, clearer voice.', bands: { 0: { type: 'highpass', freq: 90, q: 0.71 }, 2: { freq: 300, gain: -2.5 }, 4: { freq: 2800, gain: 4, q: 0.9 } } },
  { cat: 'Fix', name: 'Bass cut', tip: 'Removes the low end (small speakers).', bands: { 0: { type: 'highpass', freq: 120, q: 0.71 } } },
  { cat: 'Fix', name: 'Treble cut', tip: 'Tames harsh highs.', bands: { 6: { type: 'lowpass', freq: 6000, q: 0.71 } } },
  { cat: 'Fun', name: 'Telephone', tip: 'A narrow phone line.', bands: { 0: { type: 'highpass', freq: 450, q: 1 }, 3: { freq: 1500, gain: 5, q: 0.8 }, 6: { type: 'lowpass', freq: 3200, q: 1.3 } } },
  { cat: 'Fun', name: 'Radio', tip: 'An old AM radio.', bands: { 0: { type: 'highpass', freq: 250, q: 0.9 }, 3: { freq: 1800, gain: 3, q: 0.7 }, 6: { type: 'lowpass', freq: 5000, q: 1.1 } } },
  { cat: 'Fun', name: 'Next room', tip: 'The party is behind the wall.', bands: { 0: { freq: 100, gain: 4 }, 6: { type: 'lowpass', freq: 700, q: 0.9 } } },
];
var EQ_F0 = 20, EQ_F1 = 20000, EQ_DB = 18, EQ_POINTS = 320;
var eqBands = EQ_DEFAULTS.map(function(b){ return Object.assign({}, b); });
var eqBypass = false, eqSel = 0, eqHover = -1;

function isCut(t){ return t === 'highpass' || t === 'lowpass'; }
// What the audio engine actually gets. Off/bypassed bands become an exact
// identity (peaking at 0 dB), so they cost nothing and colour nothing.
function eqEffective(b){
  if (eqBypass || !b.on) return { type: 'peaking', freq: b.freq, gain: 0, Q: 1 };
  // Web Audio reads Q of low/high-pass filters as resonance in dB
  return { type: b.type, freq: b.freq, gain: b.gain, Q: isCut(b.type) ? 20 * Math.log10(b.q) : b.q };
}
function applyEq(){ if (engine) engine.setEq(eqBands.map(eqEffective)); updateEqButton(); }

// response maths on silent offline filters
var eqFreqs = new Float32Array(EQ_POINTS), eqMag = new Float32Array(EQ_POINTS), eqPhase = new Float32Array(EQ_POINTS);
for (var fi = 0; fi < EQ_POINTS; fi++) eqFreqs[fi] = EQ_F0 * Math.pow(EQ_F1 / EQ_F0, fi / (EQ_POINTS - 1));
var eqCalc = null, eqBandDb = eqBands.map(function(){ return new Float32Array(EQ_POINTS); }), eqTotalDb = new Float32Array(EQ_POINTS);
function eqCompute(){
  var rate = ac ? ac.sampleRate : 48000;
  if (!eqCalc || eqCalc.rate !== rate) {
    var oc = new OfflineAudioContext(1, 128, rate);
    eqCalc = { rate: rate, f: eqBands.map(function(){ return oc.createBiquadFilter(); }) };
  }
  eqTotalDb.fill(0);
  eqBands.forEach(function(b, i){
    var e = eqEffective(b), f = eqCalc.f[i], out = eqBandDb[i];
    f.type = e.type; f.frequency.value = e.freq; f.gain.value = e.gain; f.Q.value = e.Q;
    f.getFrequencyResponse(eqFreqs, eqMag, eqPhase);
    for (var k = 0; k < EQ_POINTS; k++) { out[k] = 20 * Math.log10(Math.max(1e-6, eqMag[k])); eqTotalDb[k] += out[k]; }
  });
}
function eqBandHeight(i){ // where the point sits: its gain, or the curve height for cuts/notch
  var b = eqBands[i];
  if (isCut(b.type)) return 20 * Math.log10(b.q);
  if (b.type === 'notch') return 0;
  return b.gain;
}
var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(f){
  var midi = 69 + 12 * Math.log2(f / 440), n = Math.round(midi), cents = Math.round((midi - n) * 100);
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1) + (cents ? (cents > 0 ? '+' : '') + cents + '¢' : '');
}

// ── drawing ──
var eqOverlay = $('eqOverlay'), eqGraph = $('eqGraph'), eqCanvas = $('eqCanvas'), ectx = eqCanvas.getContext('2d');
var EW = 0, EH = 0, EDPR = 1, PL = 34, PR = 10, PT = 34, PB = 22;
var EQ_RANGES = [[20, 60, 'SUB'], [60, 250, 'BASS'], [250, 500, 'LOW MID'], [500, 2000, 'MID'], [2000, 5000, 'HIGH MID'], [5000, 10000, 'PRESENCE'], [10000, 20000, 'AIR']];
var eqOpen = false, eqSpec = new Float32Array(EQ_POINTS), eqSpecBuf = null, eqNodeScale = eqBands.map(function(){ return 1; }), eqT = 0;
function eqX(f){ return PL + Math.log(f / EQ_F0) / Math.log(EQ_F1 / EQ_F0) * (EW - PL - PR); }
function eqF(x){ return EQ_F0 * Math.pow(EQ_F1 / EQ_F0, clamp((x - PL) / (EW - PL - PR), 0, 1)); }
function eqY(db){ return PT + (EQ_DB - db) / (2 * EQ_DB) * (EH - PT - PB); }
function eqDb(y){ return EQ_DB - (y - PT) / (EH - PT - PB) * 2 * EQ_DB; }
// Layout size, not getBoundingClientRect: the panel opens with a scale animation,
// and measuring mid-animation made the drawing and the hit-testing disagree.
function eqResize(){
  EDPR = Math.min(window.devicePixelRatio || 1, 2);
  EW = eqGraph.offsetWidth; EH = eqGraph.offsetHeight;
  eqCanvas.width = Math.round(EW * EDPR); eqCanvas.height = Math.round(EH * EDPR);
}
if (window.ResizeObserver) new ResizeObserver(function(){ if (eqOpen) { eqResize(); eqDraw(); } }).observe(eqGraph);
function fmtGainDb(g){ var r = Math.round(g * 10) / 10; return (r > 0 ? '+' : '') + r.toFixed(1) + ' dB'; }
var MONO = "'JetBrains Mono', monospace";

function eqDraw(){
  var c = ectx;
  c.setTransform(EDPR, 0, 0, EDPR, 0, 0);
  c.clearRect(0, 0, EW, EH);
  // ruler: note C1..C9 on top, named ranges below (the hovered point's range lights up)
  var focus = eqDrag ? eqDrag.i : eqHover, focusF = focus >= 0 ? eqBands[focus].freq : -1;
  c.font = '600 8.5px ' + MONO; c.textAlign = 'center';
  for (var o = 1; o <= 9; o++) {
    var nf = 32.703 * Math.pow(2, o - 1), nx = eqX(nf);
    if (nx < PL || nx > EW - PR) continue;
    c.fillStyle = 'rgba(255,255,255,.28)'; c.fillText('C' + o, nx, 10);
  }
  EQ_RANGES.forEach(function(rg, ri){
    var x0 = eqX(rg[0]), x1 = eqX(rg[1]), on = focusF >= rg[0] && focusF < rg[1];
    c.fillStyle = on ? 'rgba(47,255,196,.16)' : ri % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.06)';
    c.fillRect(x0 + 1, 14, x1 - x0 - 2, 13);
    c.fillStyle = on ? '#2fffc4' : 'rgba(255,255,255,.42)';
    c.font = '700 8px ' + MONO;
    if (x1 - x0 > 24) c.fillText(rg[2], (x0 + x1) / 2, 23.5);
  });
  // grid
  c.font = '600 9px ' + MONO;
  c.lineWidth = 1;
  [-12, -6, 6, 12].forEach(function(d){
    c.strokeStyle = 'rgba(255,255,255,.06)'; c.beginPath(); c.moveTo(PL, eqY(d)); c.lineTo(EW - PR, eqY(d)); c.stroke();
    c.fillStyle = 'rgba(255,255,255,.32)'; c.textAlign = 'right'; c.fillText((d > 0 ? '+' : '') + d, PL - 6, eqY(d) + 3);
  });
  c.strokeStyle = 'rgba(47,255,196,.28)'; c.beginPath(); c.moveTo(PL, eqY(0)); c.lineTo(EW - PR, eqY(0)); c.stroke();
  c.fillStyle = 'rgba(255,255,255,.32)'; c.textAlign = 'right'; c.fillText('0', PL - 6, eqY(0) + 3);
  c.textAlign = 'center';
  [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach(function(f){
    var x = eqX(f);
    c.strokeStyle = 'rgba(255,255,255,.05)'; c.beginPath(); c.moveTo(x, PT); c.lineTo(x, EH - PB); c.stroke();
    c.fillStyle = 'rgba(255,255,255,.32)'; c.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), clamp(x, PL + 8, EW - PR - 10), EH - 7);
  });

  // live spectrum (post-EQ), its own scale: -90..-10 dBFS over the full height
  if (eqSpecBuf) {
    var g = c.createLinearGradient(0, PT, 0, EH - PB);
    g.addColorStop(0, 'rgba(47,255,196,.30)'); g.addColorStop(1, 'rgba(132,85,255,.04)');
    c.beginPath(); c.moveTo(PL, EH - PB);
    for (var k = 0; k < EQ_POINTS; k++) c.lineTo(eqX(eqFreqs[k]), PT + (1 - clamp((eqSpec[k] + 90) / 80, 0, 1)) * (EH - PT - PB));
    c.lineTo(EW - PR, EH - PB); c.closePath();
    c.fillStyle = g; c.fill();
  }

  // individual bands: the selected / hovered one filled and outlined in its colour, the rest faint
  eqBands.forEach(function(b, i){
    if (!b.on || eqBypass) return;
    var d = eqBandDb[i], strong = i === eqSel || i === focus;
    c.beginPath();
    for (var k = 0; k < EQ_POINTS; k++) { var x = eqX(eqFreqs[k]), y = eqY(clamp(d[k], -EQ_DB - 6, EQ_DB + 6)); if (k) c.lineTo(x, y); else c.moveTo(x, y); }
    c.strokeStyle = EQ_COLORS[i];
    if (strong) {
      c.globalAlpha = 0.9; c.lineWidth = 1.6; c.stroke();
      c.lineTo(EW - PR, eqY(0)); c.lineTo(PL, eqY(0)); c.closePath();
      c.globalAlpha = 0.16; c.fillStyle = EQ_COLORS[i]; c.fill(); c.globalAlpha = 1;
    } else {
      c.globalAlpha = 0.3; c.lineWidth = 1; c.stroke(); c.globalAlpha = 1;
    }
  });

  // total response
  c.beginPath();
  for (k = 0; k < EQ_POINTS; k++) { var tx = eqX(eqFreqs[k]), ty = eqY(clamp(eqTotalDb[k], -EQ_DB - 6, EQ_DB + 6)); if (k) c.lineTo(tx, ty); else c.moveTo(tx, ty); }
  c.lineWidth = 2.4; c.strokeStyle = eqBypass ? 'rgba(255,255,255,.35)' : '#fff';
  c.shadowColor = 'rgba(47,255,196,.55)'; c.shadowBlur = eqBypass ? 0 : 10;
  c.stroke(); c.shadowBlur = 0;

  // points: translucent rings, the selected one with a breathing halo
  eqBands.forEach(function(b, i){
    var x = eqX(b.freq), y = eqY(clamp(eqBandHeight(i), -EQ_DB, EQ_DB)), r = 10 * eqNodeScale[i], col = EQ_COLORS[i];
    var live = b.on && !eqBypass;
    if (i === eqSel) {
      c.beginPath(); c.arc(x, y, r + 5 + Math.sin(eqT * 3) * 1.5, 0, Math.PI * 2);
      c.strokeStyle = col; c.globalAlpha = 0.35; c.lineWidth = 2; c.stroke();
      c.beginPath(); c.arc(x, y, r + 11, 0, Math.PI * 2);
      c.fillStyle = col; c.globalAlpha = 0.08; c.fill(); c.globalAlpha = 1;
    }
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = 'rgba(8,10,16,.75)'; c.fill();
    c.fillStyle = col; c.globalAlpha = live ? (i === eqSel ? 0.45 : 0.25) : 0.06; c.fill(); c.globalAlpha = 1;
    c.strokeStyle = col; c.lineWidth = live ? 2 : 1.4; c.setLineDash(live ? [] : [3, 3]); c.stroke(); c.setLineDash([]);
    c.fillStyle = live ? '#fff' : col; c.textAlign = 'center';
    c.font = '700 10px ' + MONO;
    c.fillText(String(i + 1), x, y + 3.5);
  });

  // value readout for the point being dragged / hovered
  if (focus >= 0) {
    var bb = eqBands[focus], parts = [fmtHz(bb.freq) + ' ' + noteName(bb.freq)];
    if (isCut(bb.type)) parts.push('res ' + fmtGainDb(20 * Math.log10(bb.q)));
    else if (bb.type !== 'notch') parts.push(fmtGainDb(bb.gain));
    if (bb.type === 'peaking' || bb.type === 'notch') parts.push('Q ' + bb.q.toFixed(2));
    var txt = parts.join('  ');
    c.font = '700 10px ' + MONO;
    var tw = c.measureText(txt).width + 14, bx = clamp(eqX(bb.freq) - tw / 2, PL, EW - PR - tw), by = eqY(clamp(eqBandHeight(focus), -EQ_DB, EQ_DB)) - 38;
    if (by < PT) by += 66;
    c.fillStyle = 'rgba(8,10,16,.92)'; c.strokeStyle = EQ_COLORS[focus]; c.lineWidth = 1;
    roundRect(c, bx, by, tw, 20, 6); c.fill(); c.stroke();
    c.fillStyle = '#fff'; c.textAlign = 'left'; c.fillText(txt, bx + 7, by + 13.5);
  }
}
function roundRect(c, x, y, w, h, r){
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

var eqLast = 0;
function eqLoop(now){
  if (!eqOpen) return;
  requestAnimationFrame(eqLoop);
  var dt = Math.min(0.05, (now - (eqLast || now)) / 1000); eqLast = now;
  eqT += dt;
  // spectrum: map analyser bins onto the log axis, fast attack, slower fall
  if (engine && !audio.paused) {
    var an = engine.n.analyser;
    if (!eqSpecBuf) { eqSpecBuf = new Float32Array(an.frequencyBinCount); eqSpec.fill(-100); }
    an.getFloatFrequencyData(eqSpecBuf);
    var hz = ac.sampleRate / an.fftSize;
    for (var k = 0; k < EQ_POINTS; k++) {
      var lo = Math.max(1, Math.floor(eqFreqs[k] / hz)), hi = Math.max(lo, Math.floor((k + 1 < EQ_POINTS ? eqFreqs[k + 1] : eqFreqs[k]) / hz)), m = -140;
      for (var j = lo; j <= hi && j < eqSpecBuf.length; j++) if (eqSpecBuf[j] > m) m = eqSpecBuf[j];
      var tilt = 3 * Math.log2(eqFreqs[k] / 1000); // +3 dB/oct so the spectrum reads flat-ish like PEQ2
      var v = m + tilt;
      eqSpec[k] += (v - eqSpec[k]) * (v > eqSpec[k] ? 0.6 : Math.min(1, dt * 6));
    }
  } else if (eqSpecBuf) {
    for (k = 0; k < EQ_POINTS; k++) eqSpec[k] -= dt * 40;
  }
  // point springs (hover / press pop)
  var focus = eqDrag ? eqDrag.i : eqHover;
  eqBands.forEach(function(b, i){
    var t = eqDrag && eqDrag.i === i ? 1.3 : i === focus ? 1.18 : 1;
    eqNodeScale[i] += (t - eqNodeScale[i]) * Math.min(1, dt * 16);
  });
  eqDraw();
}

// ── interaction on the graph ──
var eqDrag = null, eqLastDown = { i: -1, t: 0 }, eqPressTimer = 0;
function eqLocal(e){ // pointer -> graph coordinates, correct even while the panel is still scaling in
  var r = eqCanvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (EW / (r.width || EW)), y: (e.clientY - r.top) * (EH / (r.height || EH)) };
}
function eqHit(p, touch){
  var best = -1, bd = touch ? 34 : 24;
  eqBands.forEach(function(b, i){
    var d = Math.hypot(eqX(b.freq) - p.x, eqY(clamp(eqBandHeight(i), -EQ_DB, EQ_DB)) - p.y);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}
function eqChanged(i){ eqCompute(); applyEq(); syncStrip(i); markEqPreset(null); }
eqCanvas.addEventListener('pointerdown', function(e){
  if (e.button === 2) return;
  var p = eqLocal(e), i = eqHit(p, e.pointerType !== 'mouse');
  if (i < 0) return;
  e.preventDefault();
  ensureGraph();
  try { eqCanvas.setPointerCapture(e.pointerId); } catch (err) {}
  selectEqBand(i);
  var now = performance.now();
  if (eqLastDown.i === i && now - eqLastDown.t < 320) { resetEqBand(i); eqLastDown.i = -1; return; }
  eqLastDown = { i: i, t: now };
  var b = eqBands[i];
  eqDrag = { i: i, x0: p.x, y0: p.y, f0: b.freq, h0: eqBandHeight(i), moved: false, fine: e.shiftKey, snapped: Math.abs(b.gain) < 0.01 };
  eqNodeScale[i] = 0.85; // press "gives", then springs up to the drag size
  clearTimeout(eqPressTimer);
  if (e.pointerType !== 'mouse') eqPressTimer = setTimeout(function(){ if (eqDrag && !eqDrag.moved) { var d = eqDrag; eqDrag = null; haptic(10); openEqMenu(d.i, e.clientX, e.clientY); } }, 480);
});
eqCanvas.addEventListener('pointermove', function(e){
  var p = eqLocal(e);
  if (!eqDrag) {
    var h = eqHit(p, false);
    if (h !== eqHover) { eqHover = h; eqCanvas.style.cursor = h >= 0 ? 'grab' : 'default'; }
    return;
  }
  var d = eqDrag, b = eqBands[d.i];
  if (!d.moved && Math.hypot(p.x - d.x0, p.y - d.y0) > 3) { d.moved = true; clearTimeout(eqPressTimer); }
  if (e.shiftKey !== d.fine) { d.x0 = p.x; d.y0 = p.y; d.f0 = b.freq; d.h0 = eqBandHeight(d.i); d.fine = e.shiftKey; }
  var k = d.fine ? 0.2 : 1;
  b.freq = clamp(eqF(eqX(d.f0) + (p.x - d.x0) * k), EQ_F0, EQ_F1);
  var h = d.h0 + (eqDb(p.y) - eqDb(d.y0)) * k;
  if (isCut(b.type)) b.q = clamp(Math.pow(10, h / 20), 0.5, 8);
  else if (b.type !== 'notch') {
    b.gain = clamp(h, -EQ_DB, EQ_DB);
    var snap = Math.abs(b.gain) < 0.35 && !d.fine; // magnet at 0 dB
    if (snap) b.gain = 0;
    if (snap && !d.snapped) { haptic(6); eqNodeScale[d.i] = 1.05; }
    d.snapped = snap;
  }
  if (!b.on) b.on = true;
  eqChanged(d.i);
});
function eqUp(){ clearTimeout(eqPressTimer); if (eqDrag) { haptic(4); eqNodeScale[eqDrag.i] = 1.35; } eqDrag = null; }
eqCanvas.addEventListener('pointerup', eqUp);
eqCanvas.addEventListener('pointercancel', eqUp);
eqCanvas.addEventListener('pointerleave', function(){ if (!eqDrag) eqHover = -1; });
function eqWheelQ(i, dy, fine){
  var b = eqBands[i];
  if (b.type === 'lowshelf' || b.type === 'highshelf') return false; // shelves have a fixed slope in Web Audio
  b.q = clamp(b.q * Math.exp(-dy * (fine ? 0.0003 : 0.0015)), isCut(b.type) ? 0.5 : 0.2, isCut(b.type) ? 8 : 12);
  eqChanged(i);
  return true;
}
eqCanvas.addEventListener('wheel', function(e){
  var i = eqHover >= 0 ? eqHover : eqSel;
  if (eqWheelQ(i, e.deltaY, e.shiftKey)) { e.preventDefault(); if (i !== eqSel) selectEqBand(i); }
}, { passive: false });
eqCanvas.addEventListener('contextmenu', function(e){
  var i = eqHit(eqLocal(e), false);
  e.preventDefault();
  if (i >= 0) { selectEqBand(i); openEqMenu(i, e.clientX, e.clientY); }
});

// ── shape menu ──
var eqMenu = $('eqMenu');
function shapeIcon(t){ return '<svg viewBox="0 0 24 24"><path d="' + t.icon + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
var POWER_ICON = '<svg viewBox="0 0 24 24"><path d="M12 3.5v8M7 6.6a7 7 0 1 0 10 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
function openEqMenu(i, x, y){
  eqMenu.innerHTML = '';
  EQ_TYPES.forEach(function(t){
    var btn = document.createElement('button');
    btn.className = 'eq-menu-item' + (eqBands[i].type === t.id ? ' active' : '');
    btn.innerHTML = shapeIcon(t) + '<span></span>';
    btn.lastChild.textContent = t.name;
    btn.addEventListener('click', function(){ ensureGraph(); setEqType(i, t.id); closeEqMenu(); });
    eqMenu.appendChild(btn);
  });
  var off = document.createElement('button');
  off.className = 'eq-menu-item eq-menu-off';
  off.innerHTML = POWER_ICON + '<span></span>';
  off.lastChild.textContent = eqBands[i].on ? 'Turn band off' : 'Turn band on';
  off.addEventListener('click', function(){ ensureGraph(); eqBands[i].on = !eqBands[i].on; eqChanged(i); closeEqMenu(); });
  eqMenu.appendChild(off);
  eqMenu.style.setProperty('--k-color', EQ_COLORS[i]);
  eqMenu.classList.add('open');
  var mw = eqMenu.offsetWidth, mh = eqMenu.offsetHeight;
  eqMenu.style.left = clamp(x, 8, window.innerWidth - mw - 8) + 'px';
  eqMenu.style.top = clamp(y, 8, window.innerHeight - mh - 8) + 'px';
}
function closeEqMenu(){ eqMenu.classList.remove('open'); }
document.addEventListener('pointerdown', function(e){ if (eqMenu.classList.contains('open') && !eqMenu.contains(e.target)) closeEqMenu(); }, true);

function setEqType(i, type){
  var b = eqBands[i];
  if (b.type === type) return;
  b.type = type; b.on = true;
  if (isCut(type)) b.q = 0.71; else if (type === 'notch') b.q = 2; else if (b.q < 0.3) b.q = 1;
  eqChanged(i);
}
function resetEqBand(i){
  eqBands[i] = Object.assign({}, EQ_DEFAULTS[i]);
  eqNodeScale[i] = 0.7; haptic(8);
  eqChanged(i);
}

// ── channel strip: per band a shape button, a gain fader, FREQ and BW knobs ──
// The fader works like the knobs: drag anywhere on it (up = more), Shift = fine,
// magnet at 0 dB, double-click = 0 dB, wheel works too.
var eqStrip = $('eqStrip'), strips = [];
var eqLabels = document.createElement('div');
eqLabels.className = 'eq-col-labels';
eqLabels.innerHTML = '<span class="l-type">TYPE</span><span class="l-gain">GAIN</span><span class="l-k">FREQ</span><span class="l-k">BW</span><span class="l-num"></span>';
eqStrip.appendChild(eqLabels);
function Fader(i, el){
  var self = this;
  this.i = i; this.el = el;
  this.fill = el.querySelector('.fader-fill'); this.thumb = el.querySelector('.fader-thumb');
  var y0, g0, fine, moved, lastUp = 0, snapped;
  el.addEventListener('pointerdown', function(e){
    if (e.button !== 0) return;
    e.preventDefault(); ensureGraph(); selectEqBand(i);
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    el.classList.add('dragging');
    y0 = e.clientY; g0 = self.value(); fine = e.shiftKey; moved = false; snapped = Math.abs(g0) < 0.01;
    eqHover = i;
  });
  el.addEventListener('pointermove', function(e){
    if (!el.classList.contains('dragging')) return;
    if (Math.abs(e.clientY - y0) > 3) moved = true;
    if (e.shiftKey !== fine) { y0 = e.clientY; g0 = self.value(); fine = e.shiftKey; }
    var span = el.querySelector('.fader-track').getBoundingClientRect().height || 120;
    var g = clamp(g0 - (e.clientY - y0) / span * 2 * EQ_DB * (fine ? 0.2 : 1), -EQ_DB, EQ_DB);
    var snap = Math.abs(g) < 0.4 && !fine;
    if (snap) g = 0;
    if (snap && !snapped) haptic(6);
    snapped = snap;
    self.setValue(g);
  });
  function up(){
    if (!el.classList.contains('dragging')) return;
    el.classList.remove('dragging');
    var now = performance.now();
    if (!moved) { if (now - lastUp < 320) { self.setValue(0); haptic(8); lastUp = 0; } else lastUp = now; }
    eqHover = -1;
  }
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', function(e){
    e.preventDefault(); ensureGraph(); selectEqBand(i);
    self.setValue(clamp(self.value() - Math.sign(e.deltaY) * (e.shiftKey ? 0.1 : 0.5), -EQ_DB, EQ_DB));
  }, { passive: false });
}
// The fader shows what the point's height means for this shape: gain, or resonance for cuts.
Fader.prototype.value = function(){ return eqBandHeight(this.i); };
Fader.prototype.setValue = function(v){
  var b = eqBands[this.i];
  if (isCut(b.type)) b.q = clamp(Math.pow(10, v / 20), 0.5, 8);
  else if (b.type !== 'notch') b.gain = v;
  b.on = true;
  eqChanged(this.i);
};
Fader.prototype.sync = function(){
  var b = eqBands[this.i], v = clamp(eqBandHeight(this.i), -EQ_DB, EQ_DB), pctY = (EQ_DB - v) / (2 * EQ_DB) * 100;
  this.thumb.style.top = pctY + '%';
  this.fill.style.top = Math.min(pctY, 50) + '%';
  this.fill.style.bottom = (100 - Math.max(pctY, 50)) + '%';
  this.el.classList.toggle('idle', b.type === 'notch');
};

eqBands.forEach(function(b, i){
  var col = document.createElement('div');
  col.className = 'eq-col';
  col.style.setProperty('--k-color', EQ_COLORS[i]);
  col.innerHTML =
    '<button class="eq-type" title="Band ' + (i + 1) + ': shape (click), on/off in the menu"></button>' +
    '<div class="fader" role="slider" aria-label="Band ' + (i + 1) + ' gain"><div class="fader-track"><div class="fader-zero"></div><div class="fader-fill"></div><div class="fader-thumb"></div></div></div>' +
    '<div class="eq-col-knobs"></div><div class="eq-col-num">' + (i + 1) + '</div>';
  var typeBtn = col.firstChild;
  typeBtn.addEventListener('click', function(e){
    ensureGraph(); selectEqBand(i);
    var r = typeBtn.getBoundingClientRect();
    openEqMenu(i, r.left, r.bottom + 6);
  });
  col.addEventListener('pointerenter', function(e){ if (e.pointerType === 'mouse') eqHover = i; });
  col.addEventListener('pointerleave', function(e){ if (e.pointerType === 'mouse' && !col.querySelector('.dragging')) eqHover = -1; });
  var fader = new Fader(i, col.querySelector('.fader'));
  var fk = new Knob('eqFreq' + i, EQ_COLORS[i], { c: { name: 'Freq', min: 20, max: 20000, def: EQ_DEFAULTS[i].freq, scale: 'log', fmt: fmtHz,
      parse: function(s){ var n = num(s); return /k/i.test(s) ? n * 1000 : n; }, tip: 'Band ' + (i + 1) + ' frequency: where in the spectrum it works.' },
      get: function(){ return eqBands[i].freq; }, set: function(v){ eqBands[i].freq = v; eqBands[i].on = true; selectEqBand(i); eqChanged(i); } });
  var qk = new Knob('eqQ' + i, EQ_COLORS[i], { c: { name: 'BW', min: 0.2, max: 12, def: 1, scale: 'log', fmt: function(v){ return 'Q ' + v.toFixed(2); },
      tip: 'Band ' + (i + 1) + ' width. Low = broad and gentle, high = narrow and surgical. Same as the wheel on its point.' },
      get: function(){ return eqBands[i].q; }, set: function(v){ var bb = eqBands[i]; bb.q = isCut(bb.type) ? clamp(v, 0.5, 8) : v; bb.on = true; selectEqBand(i); eqChanged(i); } });
  [fk, qk].forEach(function(k){
    k.el.classList.add('mini');
    k.dial.addEventListener('pointerdown', function(){ eqHover = i; });
    k.dial.addEventListener('pointerup', function(){ eqHover = -1; });
    col.querySelector('.eq-col-knobs').appendChild(k.el);
  });
  strips.push({ col: col, type: typeBtn, fader: fader, freq: fk, q: qk });
  eqStrip.appendChild(col);
});
function syncStrip(i){
  var s = strips[i], b = eqBands[i];
  s.type.innerHTML = shapeIcon(EQ_TYPES.filter(function(t){ return t.id === b.type; })[0]);
  s.col.classList.toggle('off', !b.on || eqBypass);
  s.col.classList.toggle('active', i === eqSel);
  s.fader.sync();
  [s.freq, s.q].forEach(function(k){ k.n = toNorm(k.c, clamp(k.get(), k.c.min, k.c.max)); k.sync(); k.wake(); });
  var shelf = b.type === 'lowshelf' || b.type === 'highshelf';
  s.q.el.classList.toggle('idle', shelf);
  s.q.idleTip = 'Shelves have a fixed slope in the browser, so BW does nothing here.';
}
function syncAllStrips(){ for (var i = 0; i < strips.length; i++) syncStrip(i); }
function selectEqBand(i){
  if (eqSel === i) return;
  var prev = eqSel; eqSel = i;
  syncStrip(prev); syncStrip(i);
}

// ── presets (by category), bypass, reset ──
// Collapsed: one quick row of favourites + "More". Expanded: everything by
// category. A chosen preset that is not in the quick row shows on the More button.
function buildPresetRows(container, list, onPick, featured, prefKey){
  var quick = document.createElement('div'), all = document.createElement('div'), inner = document.createElement('div');
  quick.className = 'preset-chips preset-quick';
  all.className = 'preset-all'; inner.className = 'preset-all-inner';
  all.appendChild(inner);
  container.appendChild(quick); container.appendChild(all);
  function chip(p, i){
    var b = document.createElement('button');
    b.className = 'chip'; b.textContent = p.name; b.title = p.tip || '';
    b.addEventListener('click', function(){ ensureGraph(); onPick(i); });
    return b;
  }
  var rows = {};
  list.forEach(function(p, i){
    p.btns = [];
    if (featured.indexOf(p.name) >= 0) { var q = chip(p, i); p.btns.push(q); quick.appendChild(q); }
    var key = p.cat || '';
    if (!rows[key]) {
      var row = document.createElement('div');
      row.className = 'preset-row';
      if (key) { var lab = document.createElement('span'); lab.className = 'preset-cat'; lab.textContent = key; row.appendChild(lab); }
      var chips = document.createElement('div');
      chips.className = 'preset-chips';
      row.appendChild(chips);
      inner.appendChild(row);
      rows[key] = chips;
    }
    var b = chip(p, i); p.btns.push(b); rows[key].appendChild(b);
  });
  var more = document.createElement('button'), less = document.createElement('button');
  more.className = 'chip preset-toggle'; less.className = 'chip preset-toggle';
  less.innerHTML = 'Less <i>&#9652;</i>';
  quick.appendChild(more);
  var lessRow = document.createElement('div'); lessRow.className = 'preset-less'; lessRow.appendChild(less); inner.appendChild(lessRow);
  function setOpen(open){
    container.classList.toggle('expanded', open);
    more.setAttribute('aria-expanded', open ? 'true' : 'false');
    var o = {}; o[prefKey] = open; savePrefs(o);
  }
  more.addEventListener('click', function(){ setOpen(true); });
  less.addEventListener('click', function(){ setOpen(false); });
  container.classList.toggle('expanded', prefs[prefKey] === true);
  // mark(i): highlight preset i everywhere (null = none)
  return function mark(i){
    list.forEach(function(p, j){ p.btns.forEach(function(b){ b.classList.toggle('active', j === i); }); });
    var hidden = i !== null && i !== undefined && featured.indexOf(list[i].name) < 0;
    more.innerHTML = (hidden ? 'More · ' + list[i].name.replace(/[&<>]/g, '') : 'More') + ' <i>&#9662;</i>';
    more.classList.toggle('active', hidden);
  };
}
var eqAnim = 0;
var markEqPreset = buildPresetRows($('eqPresets'), EQ_PRESETS, function(i){ applyEqPreset(i); },
  ['Flat', 'Bass boost', 'V-shape', 'Vocal', 'Bright'], 'eqPresetsOpen');
function applyEqPreset(i){
  var from = eqBands.map(function(b){ return Object.assign({}, b); });
  var to = EQ_DEFAULTS.map(function(d, j){ return Object.assign({}, d, EQ_PRESETS[i].bands[j] || {}); });
  eqBands.forEach(function(b, j){ b.type = to[j].type; b.on = true; });
  cancelAnimationFrame(eqAnim);
  var t0 = performance.now(), dur = reduceMotion || document.hidden ? 0 : 420;
  (function step(now){
    var t = dur ? clamp((now - t0) / dur, 0, 1) : 1, e = 1 - Math.pow(1 - t, 3);
    eqBands.forEach(function(b, j){
      b.freq = Math.exp(Math.log(from[j].freq) + (Math.log(to[j].freq) - Math.log(from[j].freq)) * e);
      b.gain = from[j].gain + (to[j].gain - from[j].gain) * e;
      b.q = Math.exp(Math.log(from[j].q) + (Math.log(to[j].q) - Math.log(from[j].q)) * e);
    });
    eqCompute(); applyEq(); syncAllStrips();
    if (t < 1) eqAnim = requestAnimationFrame(step);
  })(t0);
  markEqPreset(i);
}
var eqBypassBtn = $('eqBypass');
function setEqBypass(on){
  eqBypass = on;
  eqBypassBtn.classList.toggle('active', on);
  eqBypassBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  eqCompute(); applyEq(); syncAllStrips();
}
eqBypassBtn.addEventListener('click', function(){ ensureGraph(); setEqBypass(!eqBypass); });
$('eqReset').addEventListener('click', function(){ ensureGraph(); setEqBypass(false); applyEqPreset(0); });

function updateEqButton(){
  var active = !eqBypass && eqBands.some(function(b, i){
    var d = EQ_DEFAULTS[i];
    return b.on && (b.type !== d.type || Math.abs(b.gain) > 0.05 || (isCut(b.type) || b.type === 'notch'));
  });
  $('btnEq').classList.toggle('is-active', active);
}

$('eqHint').textContent = noHover
  ? 'Drag a point or a fader. Hold a point (or tap the shape icon) to change its shape. Double-tap = reset.'
  : 'Drag a point: frequency + gain (Shift = fine). Wheel on a point: width. Right-click: shape. Double-click: reset. The faders and knobs on the right do the same per band.';

function openEq(){
  ensureGraph();
  eqOverlay.classList.add('open');
  eqOpen = true;
  eqResize(); eqCompute(); syncAllStrips();
  eqLast = 0; requestAnimationFrame(eqLoop);
  eqDraw();
}
function closeEq(){ eqOverlay.classList.remove('open'); eqOpen = false; closeEqMenu(); }
$('btnEq').addEventListener('click', openEq);
$('eqClose').addEventListener('click', closeEq);
eqOverlay.addEventListener('click', function(e){ if (e.target === eqOverlay) closeEq(); });
document.addEventListener('keydown', function(e){ if (eqOpen && e.key === 'Escape') { if (eqMenu.classList.contains('open')) closeEqMenu(); else closeEq(); } });
window.addEventListener('resize', function(){ if (eqOpen) { eqResize(); eqDraw(); } });
markEqPreset(0);
syncAllStrips();

// ─── Particle visualizer ────────────────────────────────────────────────────
// A field of small capsules on loose rings around the centre, coloured by angle
// and tinted by the key the music is in right now. Bass hits travel outward
// through the field as a pressure wave (a drop fires a big one and spins the
// field for a moment, quiet passages calm it down), every direction listens to
// its own slice of the spectrum (bottom = bass, top = highs), and the pointer
// pushes particles aside. Drawn in a few batched fills per frame (no
// shadowBlur), which keeps Firefox smooth too.
var canvas = $('vis'), ctx = canvas.getContext('2d');
var visOn = prefs.vis !== false;
btnVis.classList.toggle('is-off', !visOn);
btnVis.addEventListener('click', function(){
  visOn = !visOn;
  btnVis.classList.toggle('is-off', !visOn);
  savePrefs({ vis: visOn });
  if (!visOn) ctx.clearRect(0, 0, canvas.width, canvas.height);
});

var PALETTE = ['#2fffc4', '#36d6ff', '#4f8dff', '#7a63ff', '#a95cff', '#e05cf0', '#ff6fb1', '#ffa07a', '#ffd27a', '#7dffa8'];
var HUES = 40, TIERS = 3, BANDS = 48;
var paletteRGB = PALETTE.map(function(h){ return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)]; });
function paletteAt(u){
  u = ((u % 1) + 1) % 1;
  var x = u * paletteRGB.length, i = Math.floor(x), f = x - i;
  var a = paletteRGB[i], b = paletteRGB[(i + 1) % paletteRGB.length];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

var W = 0, H = 0, DPR = 1, CX = 0, CY = 0, RMAX = 0, quality = 0;
var P = null, order = null, bucketStart = null, count = 0;

function buildField(){
  var cssW = window.innerWidth, cssH = window.innerHeight;
  DPR = Math.min(window.devicePixelRatio || 1, quality > 0 ? 1 : 2);
  canvas.width = Math.round(cssW * DPR); canvas.height = Math.round(cssH * DPR);
  W = cssW; H = cssH;
  var card = $('playerCard').getBoundingClientRect();
  CX = cssW < 900 ? cssW / 2 : card.left + card.width / 2;
  CY = cssW < 900 ? Math.min(cssH * 0.32, card.top + 120) : cssH * 0.45;
  RMAX = Math.hypot(Math.max(CX, cssW - CX), Math.max(CY, cssH - CY)) + 30;
  var target = (quality > 0 ? 1100 : 2200) * Math.min(1.4, Math.max(0.5, cssW * cssH / (1600 * 900)));
  var spread = 1;
  var rings;
  for (var attempt = 0; attempt < 8; attempt++) {
    rings = [];
    var total = 0;
    for (var r = 22; r < RMAX; ) {
      var dr = (10 + r * 0.045) * spread;
      var n = Math.max(6, Math.floor(2 * Math.PI * r / (dr * 1.45)));
      rings.push([r, n, dr]); total += n;
      r += dr;
    }
    if (total <= target * 1.1) break;
    spread *= Math.sqrt(total / target);
  }
  var list = [];
  rings.forEach(function(ring){
    var off = Math.random() * Math.PI * 2;
    for (var i = 0; i < ring[1]; i++) {
      var th = off + (i + (Math.random() - 0.5) * 0.7) * Math.PI * 2 / ring[1];
      var rr = ring[0] + (Math.random() - 0.5) * ring[2] * 0.6;
      list.push([rr, th]);
    }
  });
  count = list.length;
  P = {
    r0: new Float32Array(count), th0: new Float32Array(count), sz: new Float32Array(count),
    band: new Uint8Array(count), seed: new Float32Array(count), push: new Float32Array(count), dpush: new Float32Array(count)
  };
  var bucket = new Uint16Array(count);
  for (var k = 0; k < count; k++) {
    var rr2 = list[k][0], th2 = list[k][1];
    P.r0[k] = rr2; P.th0[k] = th2;
    var s = clamp((rr2 - RMAX * 0.06) / (RMAX * 0.5), 0, 1);
    P.sz[k] = s * s * (3 - 2 * s);
    var fromBottom = Math.abs(Math.atan2(Math.cos(th2), Math.sin(th2))) / Math.PI; // 0 = straight down, 1 = straight up
    P.band[k] = Math.min(BANDS - 1, Math.floor(fromBottom * BANDS));
    P.seed[k] = Math.random() * Math.PI * 2;
    var hueIdx = Math.floor((((th2 / (Math.PI * 2)) % 1) + 1) % 1 * HUES) % HUES;
    var tier = Math.min(TIERS - 1, Math.floor(P.sz[k] * TIERS));
    bucket[k] = tier * HUES + hueIdx;
  }
  // sort particle indices by colour bucket so each bucket is one fill() call
  var nb = HUES * TIERS;
  bucketStart = new Uint32Array(nb + 1);
  for (k = 0; k < count; k++) bucketStart[bucket[k] + 1]++;
  for (var b = 0; b < nb; b++) bucketStart[b + 1] += bucketStart[b];
  var fill = bucketStart.slice(0, nb);
  order = new Uint32Array(count);
  for (k = 0; k < count; k++) order[fill[bucket[k]]++] = k;
}
var resizeTimer = 0;
window.addEventListener('resize', function(){ clearTimeout(resizeTimer); resizeTimer = setTimeout(buildField, 120); });
buildField();

var mouseX = -9999, mouseY = -9999, mouseT = 0;
window.addEventListener('pointermove', function(e){ mouseX = e.clientX; mouseY = e.clientY; mouseT = performance.now(); }, { passive: true });
window.addEventListener('pointerleave', function(){ mouseX = mouseY = -9999; });

// Audio analysis
var freqBuf = null, bandVal = new Float32Array(BANDS), bandMax = new Float32Array(BANDS).fill(0.2), bandEdges = null;
var HIST = 240, hist = new Float32Array(HIST), histHead = 0, histAcc = 0;
var bassSmooth = 0, prevBass = 0, fluxAvg = 0.01, onset = 0, lastOnset = 0, level = 0;
var WAVE_SPEED = 620; // px/s the bass wave travels outward
// Drops: the short-term level jumping well above the long-term one.
var lvlShort = 0, lvlLong = 0, playTime = 0, lastDrop = -1e9, drop = 0, calm = 1, spin = 0;

// Key colour: a chromagram (energy of each of the 12 pitch classes) from a
// fine-grained FFT, placed on the circle of fifths, so related keys get related
// colours (C red, G orange, D yellow ... F pink). `keyClarity` says how clearly
// the music sits in one place on that circle right now.
var chromaAn = null, chromaBuf = null, chromaBin = null, chromaFrame = 0;
var keyX = 0, keyY = 0, keyHue = 0, keyClarity = 0;
var chroma = new Float32Array(12);
function analyseChroma(dt){
  if (!chromaAn) {
    chromaAn = ac.createAnalyser();
    chromaAn.fftSize = 16384; chromaAn.smoothingTimeConstant = 0.3;
    engine.n.analyser.connect(chromaAn);
    chromaBuf = new Float32Array(chromaAn.frequencyBinCount);
    var hz = ac.sampleRate / chromaAn.fftSize;
    chromaBin = new Int8Array(chromaAn.frequencyBinCount).fill(-1);
    for (var i = Math.ceil(90 / hz); i < Math.min(chromaBin.length, 4200 / hz); i++) {
      var midi = 69 + 12 * Math.log2(i * hz / 440);
      if (Math.abs(midi - Math.round(midi)) < 0.35) chromaBin[i] = ((Math.round(midi) % 12) + 12) % 12;
    }
  }
  chromaAn.getFloatFrequencyData(chromaBuf);
  chroma.fill(0);
  for (var i = 2; i < chromaBuf.length - 2; i++) {
    var pc = chromaBin[i];
    if (pc < 0) continue;
    var v = chromaBuf[i];
    // only spectral peaks count (tones), not the broadband wash of drums
    if (v < chromaBuf[i - 1] || v < chromaBuf[i + 1] || v < -90) continue;
    var floor = (chromaBuf[i - 2] + chromaBuf[i + 2]) / 2;
    if (v - floor < 6) continue;
    chroma[pc] += Math.pow(10, v / 20);
  }
  var sx = 0, sy = 0, tot = 0;
  for (var c = 0; c < 12; c++) {
    var a = (c * 7 % 12) * Math.PI / 6; // position on the circle of fifths
    sx += chroma[c] * Math.cos(a); sy += chroma[c] * Math.sin(a); tot += chroma[c];
  }
  if (tot <= 0) return;
  var k = 1 - Math.exp(-dt / 0.6);
  keyX += (sx / tot - keyX) * k; keyY += (sy / tot - keyY) * k;
  keyHue = (Math.atan2(keyY, keyX) * 180 / Math.PI + 360) % 360;
  keyClarity = Math.hypot(keyX, keyY);
}
function hsl(h, s, l){ // -> [r, g, b]
  h = ((h % 360) + 360) % 360 / 360;
  var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  function ch(t){ t = (t + 1) % 1; return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p); }
  return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
}

function analyse(dt, now){
  var playing = engine && !audio.paused && !audio.muted;
  if (playing) {
    var an = engine.n.analyser;
    if (!freqBuf) {
      freqBuf = new Uint8Array(an.frequencyBinCount);
      var hzPerBin = ac.sampleRate / an.fftSize;
      bandEdges = new Uint16Array(BANDS + 1);
      for (var b = 0; b <= BANDS; b++) bandEdges[b] = Math.max(1, Math.round(35 * Math.pow(15000 / 35, b / BANDS) / hzPerBin));
    }
    an.getByteFrequencyData(freqBuf);
    var lvl = 0;
    for (b = 0; b < BANDS; b++) {
      var lo = bandEdges[b], hi = Math.max(lo + 1, bandEdges[b + 1]), s = 0;
      for (var i = lo; i < hi; i++) s += freqBuf[i];
      var v = s / ((hi - lo) * 255);
      bandMax[b] = Math.max(v, bandMax[b] * (1 - dt * 0.25), 0.12);
      var nv = Math.pow(v / bandMax[b], 1.6);
      bandVal[b] += (nv - bandVal[b]) * (nv > bandVal[b] ? 0.55 : 0.12);
      lvl += v;
    }
    lvl /= BANDS;
    level += (lvl - level) * 0.1;
    playTime += dt;
    lvlShort += (lvl - lvlShort) * (1 - Math.exp(-dt / 0.3));
    lvlLong += (lvl - lvlLong) * (1 - Math.exp(-dt / (playTime < 4 ? 0.8 : 7)));
    var ratio = lvlShort / Math.max(0.02, lvlLong);
    // quiet passages calm the field down, loud ones open it up
    calm += (clamp((ratio - 0.5) / 0.6, 0.35, 1.2) - calm) * (1 - Math.exp(-dt / 0.5));
    if (++chromaFrame % 3 === 0) analyseChroma(dt * 3);
    var bass = 0;
    for (b = 0; b < 7; b++) bass += bandVal[b];
    bass /= 7;
    bassSmooth += (bass - bassSmooth) * 0.25;
    var flux = Math.max(0, bass - prevBass);
    prevBass = bass;
    fluxAvg = fluxAvg * 0.94 + flux * 0.06;
    var cooldown = BPM ? Math.max(130, 60000 / BPM * 0.45 / speedFactor) : 160;
    if (flux > fluxAvg * 2 + 0.03 && now - lastOnset > cooldown) {
      onset = Math.max(onset, Math.min(1, 0.35 + flux * 3));
      lastOnset = now;
      if (playTime > 3 && ratio > 1.3 && now - lastDrop > 4000) { // the drop
        onset = 1.9; drop = 1; spin = 1; calm = 1.2; lastDrop = now; haptic(20);
      }
    }
  } else {
    for (var j = 0; j < BANDS; j++) bandVal[j] *= 0.92;
    bassSmooth *= 0.95; level *= 0.96; prevBass = 0;
    calm += (0.6 - calm) * 0.02;
    keyClarity *= 0.99;
  }
  onset *= Math.pow(0.02, dt); // fast decay, ~0.25 s
  drop *= Math.pow(0.08, dt);  // ~0.6 s
  spin *= Math.pow(0.15, dt);  // ~1 s
  // fixed 60 Hz history of the "pressure" signal; radius r reads it r/WAVE_SPEED seconds late
  histAcc += dt;
  while (histAcc >= 1 / 60) {
    histAcc -= 1 / 60;
    histHead = (histHead + 1) % HIST;
    hist[histHead] = (bassSmooth * 0.45 + onset) * calm;
  }
}

var visT = 0, lastFrame = 0, slowFrames = 0, frameCount = 0, discAngle = 0, swirlAngle = 0;
var colorCache = new Array(HUES * TIERS);
function frame(now){
  requestAnimationFrame(frame);
  var dt = Math.min(0.05, (now - (lastFrame || now)) / 1000); lastFrame = now;
  analyse(dt, now);

  // disc spins with the music and pulses on hits
  if (!audio.paused) discAngle += dt * 60 * speedFactor;
  disc.style.transform = 'rotate(' + (discAngle % 360).toFixed(2) + 'deg) scale(' + (1 + onset * 0.05 + bassSmooth * 0.03 + drop * 0.05).toFixed(4) + ')';

  if (!visOn || !P) return;
  // adaptive quality: drop to a lighter field if the device cannot keep up
  if (dt > 0.026) slowFrames++;
  if (++frameCount % 120 === 0) {
    if (slowFrames > 70 && quality === 0) { quality = 1; document.body.classList.add('vis-lite'); buildField(); }
    slowFrames = 0;
  }
  visT += dt * (reduceMotion ? 0.2 : 1);

  var palShift = visT * 0.006;
  var activity = Math.min(1, level * 2.5);
  // the field takes on the colour of the current key (a +-45 deg hue fan around it);
  // with no clear key (silence, pure drums) it falls back to the TVFS palette
  var keyMix = clamp((keyClarity - 0.08) / 0.27, 0, 1) * 0.9 * Math.min(1, activity * 2);
  for (var tier = 0; tier < TIERS; tier++) {
    var mix = [0.18, 0.62, 1][tier];
    for (var h = 0; h < HUES; h++) {
      var c = paletteAt(h / HUES + palShift);
      if (keyMix > 0.01) {
        var kc = hsl(keyHue + Math.sin(h / HUES * Math.PI * 2 + visT * 0.15) * 45, 0.9, 0.62);
        c = [c[0] + (kc[0] - c[0]) * keyMix, c[1] + (kc[1] - c[1]) * keyMix, c[2] + (kc[2] - c[2]) * keyMix];
      }
      var g = 150;
      colorCache[tier * HUES + h] = 'rgb(' + Math.round(g + (c[0] - g) * mix) + ',' + Math.round(g + (c[1] - g) * mix) + ',' + Math.round(g + (c[2] - g) * mix) + ')';
    }
  }

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  swirlAngle += dt * (0.018 + spin * 0.9);
  var swirl = swirlAngle;
  var mouseActive = now - mouseT < 4000;
  var amp = 30 * Math.max(1, Math.min(W, H) / 800);
  var R0 = P.r0, TH = P.th0, SZ = P.sz, BD = P.band, SD = P.seed, PU = P.push, DP = P.dpush;
  var nb = HUES * TIERS;
  for (var bk = 0; bk < nb; bk++) {
    var s0 = bucketStart[bk], s1 = bucketStart[bk + 1];
    if (s0 === s1) continue;
    var t = Math.floor(bk / HUES);
    ctx.fillStyle = colorCache[bk];
    ctx.globalAlpha = [0.32, 0.55, 0.8][t] * (0.7 + 0.3 * activity);
    ctx.beginPath();
    for (var oi = s0; oi < s1; oi++) {
      var k = order[oi];
      var r0 = R0[k], sz = SZ[k];
      var hi2 = (histHead - Math.floor(r0 / WAVE_SPEED * 60) + HIST) % HIST;
      var wave = hist[hi2];
      var be = bandVal[BD[k]] * calm;
      var push = wave * amp * (0.35 + 0.65 * sz) + Math.sin(visT * 0.9 + SD[k]) * 1.6;
      DP[k] += ((push - PU[k]) - DP[k]) * 0.3;
      PU[k] = push;
      var th = TH[k] + swirl * (0.5 + 0.8 * (1 - r0 / RMAX));
      var cs = Math.cos(th), sn = Math.sin(th);
      var r = r0 + push;
      var x = CX + cs * r, y = CY + sn * r;
      if (mouseActive) {
        var mx = x - mouseX, my = y - mouseY, md = mx * mx + my * my;
        if (md < 19600 && md > 0.01) { // 140px
          var dd = Math.sqrt(md), f = (1 - dd / 140); f = f * f * 34;
          x += mx / dd * f; y += my / dd * f;
        }
      }
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      // capsule oriented along the ring, tipping outward while the wave pushes it
      var bend = clamp(DP[k] * 0.5, -1.5, 1.5);
      var dx = -sn + cs * bend, dy = cs + sn * bend, dl = Math.sqrt(dx * dx + dy * dy);
      dx /= dl; dy /= dl;
      var hl = (0.6 + 4.6 * sz) * (1 + 1.6 * be + 0.9 * wave + drop * 0.9);
      var hw = (0.55 + 1.05 * sz) * (1 + 0.35 * be);
      var ex = dx * hl, ey = dy * hl, nx = -dy * hw, ny = dx * hw;
      ctx.moveTo(x - ex + nx, y - ey + ny);
      ctx.lineTo(x + ex + nx, y + ey + ny);
      ctx.lineTo(x + ex - nx, y + ey - ny);
      ctx.lineTo(x - ex - nx, y - ey - ny);
      ctx.closePath();
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
requestAnimationFrame(frame);

// ─── Public hooks ───────────────────────────────────────────────────────────
window.TVFSPlayer = { setSource: setSource, audio: audio };
if (!CFG.gated) setSource(CFG.audioUrl);
})();
