'use strict';

// "Open in the naTiVeFS app?" bar for generated pages (audio players, readers).
// The native app handles tvfs://open?url=<percent-encoded https link>; shared links stay plain https.
// Everything is inlined into the page: css() goes into a <style>, html() right after <body>
// (it already contains its own <script>), so the bar is decided before the first paint
// and the page content below it never jumps.

const APP_URL = 'https://files.tomasekvalla.cz/nativefs';

function css() {
    return `
.tvfs-offer{--o-bg:rgba(20,24,34,.92);--o-fg:#e9edf7;--o-mute:#9aa6bd;--o-bd:rgba(255,255,255,.12);--o-btn:rgba(255,255,255,.08);--o-acc:#2fffc4;--o-accfg:#04101c;
  position:relative;z-index:70;display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px 12px;padding:7px 14px;
  background:var(--o-bg);color:var(--o-fg);border-bottom:1px solid var(--o-bd);font:500 .78rem/1.3 'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
.tvfs-offer[data-theme="light"]{--o-bg:rgba(255,255,255,.94);--o-fg:#1a1f33;--o-mute:#5b6580;--o-bd:rgba(0,0,0,.12);--o-btn:rgba(0,0,0,.06);--o-acc:#0a8a78;--o-accfg:#fff;}
.tvfs-offer[hidden]{display:none;}
/* naTiVeFS is a desktop app: never on phones, tablets or narrow windows, whatever the browser claims to be */
@media (max-width: 760px), (hover: none) and (pointer: coarse) { .tvfs-offer{display:none !important;} }
.tvfs-offer-text{font-weight:600;}
.tvfs-offer-text a{color:var(--o-acc);cursor:pointer;text-decoration:underline;}
.tvfs-offer-actions{display:inline-flex;align-items:center;gap:6px;}
.tvfs-offer-actions[hidden]{display:none;}
.tvfs-offer-btn{font:inherit;font-weight:700;font-size:.72rem;line-height:1;padding:6px 11px;border-radius:8px;border:1px solid var(--o-bd);background:var(--o-btn);color:var(--o-fg);cursor:pointer;text-decoration:none;white-space:nowrap;}
.tvfs-offer-btn:hover{border-color:var(--o-acc);color:var(--o-acc);}
.tvfs-offer-btn.primary{background:var(--o-acc);border-color:var(--o-acc);color:var(--o-accfg);}
.tvfs-offer-btn.primary:hover{filter:brightness(1.1);color:var(--o-accfg);}
.tvfs-offer-check{display:inline-flex;align-items:center;gap:5px;font-size:.72rem;color:var(--o-mute);cursor:pointer;white-space:nowrap;}
.tvfs-offer-check input{accent-color:var(--o-acc);margin:0;cursor:pointer;}
.tvfs-offer-x{font:inherit;font-size:1.05rem;line-height:1;width:26px;height:26px;border-radius:50%;border:none;background:transparent;color:var(--o-mute);cursor:pointer;padding:0;}
.tvfs-offer-x:hover{color:var(--o-fg);background:var(--o-btn);}
.tvfs-offer-btn:focus-visible,.tvfs-offer-x:focus-visible,.tvfs-offer-text a:focus-visible{outline:2px solid var(--o-acc);outline-offset:2px;}
`;
}

function script(opts) {
    // opts.launchBase replaces the tvfs:// prefix (tests only: an http URL they can observe)
    const cfg = JSON.stringify({ audio: !!(opts && opts.audio), appUrl: APP_URL, launch: (opts && opts.launchBase) || 'tvfs://open?url=' });
    return `
(function(){
'use strict';
var CFG = ${cfg};
// Remembered choices (this browser): ok = counted successful launches, always = "Always open in the app",
// never = "Don't show again", autooff = "stay in browser", hide = closed with x (14 days), last = loop guard
var K = { ok: 'tvfs_app_oks', always: 'tvfs_app_always', never: 'tvfs_app_never', autooff: 'tvfs_app_auto_off', hide: 'tvfs_app_offer_hide', last: 'tvfs_app_auto_last' };
var bar = document.getElementById('tvfsOffer');
if (!bar) return;
function get(k){ try { return localStorage.getItem(k); } catch (e) { return null; } }
function set(k, v){ try { localStorage.setItem(k, v); } catch (e) {} }

// The app is a desktop app: never on phones, tablets or narrow windows. One media query (same as the CSS),
// re-checked when the window changes, no user agent sniffing.
var mq = window.matchMedia ? matchMedia('(max-width: 760px), (hover: none) and (pointer: coarse)') : null;
function tooSmall(){ return !!(mq && mq.matches); }
if (tooSmall() && !mq.addEventListener && !mq.addListener) return;

// Pages that the app or the link router just handed to the browser must stay in the browser
var inBrowser = /(?:^|[?&])inbrowser=1(?:&|$|#)/.test(location.search + location.hash);
var ref = '';
try { ref = (document.referrer || '').split('#')[0]; } catch (e) {}
var samePage = ref !== '' && ref === location.href.split('#')[0];

var target = CFG.launch + encodeURIComponent(location.href);
var text = document.getElementById('tvfsOfferText');
var actions = document.getElementById('tvfsOfferActions');
var always = document.getElementById('tvfsOfferAlways');

function theme(){
  var c = getComputedStyle(document.body).backgroundColor || '', m = c.match(/[\\d.]+/g);
  var light = false;
  if (m && m.length >= 3 && !(m.length > 3 && parseFloat(m[3]) === 0)) {
    light = (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) > 150;
  } else if (window.matchMedia) {
    light = matchMedia('(prefers-color-scheme: light)').matches;
  }
  bar.setAttribute('data-theme', light ? 'light' : 'dark');
}
theme();
try {
  new MutationObserver(theme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  if (window.matchMedia) matchMedia('(prefers-color-scheme: light)').addEventListener('change', theme);
} catch (e) {}

// A launch counts as successful only when the page really goes to the background (tab/window hidden)
// within 1.5 s of the click. Losing focus alone proves nothing: the browser's own "open this app?" dialog
// and alt-tabbing do that too.
function watchOpen(){
  var t0 = Date.now(), done = false;
  function stop(){ done = true; document.removeEventListener('visibilitychange', vis); }
  function vis(){
    if (done || document.visibilityState !== 'hidden') return;
    if (Date.now() - t0 <= 1500) set(K.ok, String((parseInt(get(K.ok), 10) || 0) + 1));
    stop();
  }
  document.addEventListener('visibilitychange', vis);
  setTimeout(function(){ if (!done) stop(); }, 1600);
}

function openApp(){ watchOpen(); location.href = target; }

// Auto-open: only when asked for ("Always open in the app", or two counted launches), never for a page
// that was sent to the browser on purpose, and never the same page twice within 15 s (shared by all tabs).
var autoOn = !inBrowser && !samePage && !tooSmall() && get(K.never) !== '1' && get(K.autooff) !== '1'
  && (get(K.always) === '1' || (parseInt(get(K.ok), 10) || 0) >= 2) && !(CFG.audio && /Macintosh|Mac OS X/.test(navigator.userAgent || ''));
if (autoOn) {
  var last = null;
  try { last = JSON.parse(get(K.last)); } catch (e) {}
  if (last && last.u === location.href && Date.now() - last.t < 15000) autoOn = false;
}

function layout(){
  // shows or hides the bar for the current window size and the saved choices
  var hidden = inBrowser || tooSmall() || get(K.never) === '1' || Date.now() < (parseInt(get(K.hide), 10) || 0);
  if (!started) bar.hidden = hidden;
  else if (hidden) bar.hidden = true;
  else if (!autoNote) bar.hidden = false;
}
var started = false, autoNote = false;

if (autoOn) {
  autoNote = true;
  set(K.last, JSON.stringify({ u: location.href, t: Date.now() }));
  text.innerHTML = 'Opened in naTiVeFS - <a id="tvfsOfferStay" role="button" tabindex="0">stay in browser</a>';
  actions.hidden = true;
  bar.hidden = false;
  var stay = document.getElementById('tvfsOfferStay');
  function stayHere(){ set(K.autooff, '1'); set(K.always, '0'); bar.hidden = true; }
  stay.addEventListener('click', stayHere);
  stay.addEventListener('keydown', function(e){ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stayHere(); } });
  location.href = target;
  return;
}

started = true;
always.checked = get(K.always) === '1';
always.addEventListener('change', function(){
  set(K.always, always.checked ? '1' : '0');
  if (always.checked) set(K.autooff, '0');
});
document.getElementById('tvfsOfferOpen').addEventListener('click', openApp);
document.getElementById('tvfsOfferClose').addEventListener('click', function(){
  set(K.hide, String(Date.now() + 14 * 24 * 60 * 60 * 1000));
  bar.hidden = true;
});
document.getElementById('tvfsOfferNever').addEventListener('click', function(){
  set(K.never, '1');
  bar.hidden = true;
});
layout();
if (mq) { if (mq.addEventListener) mq.addEventListener('change', layout); else if (mq.addListener) mq.addListener(layout); }
})();
`;
}

// opts.audio: true on audio pages (never auto-opened on macOS, where the app sends audio back to the browser)
function html(opts) {
    return `<div class="tvfs-offer" id="tvfsOffer" role="region" aria-label="naTiVeFS app" data-theme="dark" hidden>
  <span class="tvfs-offer-text" id="tvfsOfferText">Open in the naTiVeFS app?</span>
  <span class="tvfs-offer-actions" id="tvfsOfferActions">
    <button type="button" class="tvfs-offer-btn primary" id="tvfsOfferOpen">Open in app</button>
    <a class="tvfs-offer-btn" id="tvfsOfferGet" href="${APP_URL}" target="_blank" rel="noopener">Get the app</a>
    <label class="tvfs-offer-check"><input type="checkbox" id="tvfsOfferAlways"> Always open in the app</label>
    <button type="button" class="tvfs-offer-btn" id="tvfsOfferNever">Don't show again</button>
    <button type="button" class="tvfs-offer-x" id="tvfsOfferClose" aria-label="Hide for 14 days" title="Hide for 14 days">&times;</button>
  </span>
</div>
<script>${script(opts)}</script>`;
}

module.exports = { css, html, APP_URL };
