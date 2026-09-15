/**
 * tvfs-gate.js — shared by every generated landing/pair/dashboard page.
 *
 * The single most important thing this fixes: earlier generated pages had
 * their own little "type a username+password, check it per-request" login
 * forms that never actually logged you into TVFS — nothing was persisted,
 * so every single page you visited made you type your password again.
 *
 * This calls the REAL /api/auth endpoint (same one upload.html uses),
 * which sets the actual httpOnly tvfs_token cookie for the whole
 * files.tomasekvalla.cz domain. Once that's set, every page on the site —
 * including a completely different pairing link tomorrow — recognizes you
 * automatically via the cookie, no re-typing anything.
 */
(function (global) {
    const USERNAME_KEY = 'tvfs_username';

    function prefillUsername(inputEl) {
        if (!inputEl) return;
        const saved = localStorage.getItem(USERNAME_KEY);
        if (saved) inputEl.value = saved;
    }

    // Real, persistent TVFS login. Returns { ok, tier, username, error }.
    // days: how long to stay logged in (1-30) — same range/meaning as the
    // "stay logged in" picker on the main Upload page.
    async function login(username, password, days) {
        try {
            const res = await fetch('/api/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ username, password, cookieDays: days || 7 })
            });
            const data = await res.json();
            if (!res.ok || data.valid === false) {
                return { ok: false, error: 'Invalid TVFS username or password.' };
            }
            localStorage.setItem(USERNAME_KEY, username);
            return { ok: true, tier: data.tier, username };
        } catch (e) {
            return { ok: false, error: 'Network error — check your connection.' };
        }
    }

    // Are we already logged in on this browser? (reads the non-httpOnly
    // tvfs_tier cookie the same way upload.html does — doesn't prove
    // WHICH user, just that a session likely exists; server always
    // re-checks the real cookie regardless).
    function getCookie(name) {
        const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return match ? decodeURIComponent(match[1]) : null;
    }
    function isLikelyLoggedIn() {
        return !!getCookie('tvfs_tier');
    }

    // Copy text to clipboard with a brief visual "Copied!" state on the
    // button, matching the site's copy-pill feel instead of just silently
    // succeeding with no feedback.
    function copyWithFeedback(text, btnEl, labelWhenCopied) {
        navigator.clipboard.writeText(text).then(function () {
            if (!btnEl) return;
            const original = btnEl.innerHTML;
            btnEl.innerHTML = '<span>✅ ' + (labelWhenCopied || 'Copied!') + '</span>';
            btnEl.classList.add('copied');
            setTimeout(function () {
                btnEl.innerHTML = original;
                btnEl.classList.remove('copied');
            }, 1600);
        });
    }

    // Builds the "stay logged in for how long" duration picker UI inline
    // into a container element — small, reusable, matches the main
    // upload page's concept (session / 1d / 7d / 30d) without needing a
    // full modal overlay on these smaller generated pages.
    function buildDurationPicker(containerEl, onPick) {
        containerEl.innerHTML = '';
        containerEl.className = 'tvfs-tri-switch';
        [[1, '1 day'], [7, '7 days'], [30, '30 days']].forEach(function (pair, i) {
            const btn = document.createElement('button');
            btn.className = 'tvfs-tri-btn' + (i === 1 ? ' active' : '');
            btn.type = 'button';
            btn.textContent = pair[1];
            btn.dataset.days = pair[0];
            btn.onclick = function () {
                containerEl.querySelectorAll('.tvfs-tri-btn').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                if (onPick) onPick(pair[0]);
            };
            containerEl.appendChild(btn);
        });
        return { getDays: function () {
            const active = containerEl.querySelector('.tvfs-tri-btn.active');
            return active ? parseInt(active.dataset.days, 10) : 7;
        } };
    }

    global.TVFSGate = { prefillUsername, login, isLikelyLoggedIn, copyWithFeedback, buildDurationPicker, USERNAME_KEY };
})(window);
