/**
 * tvfs-gate.js — small helpers shared by TVFS pages.
 * The old login / duration-picker helpers of the removed pairing pages are gone; logging in is
 * done by upload.html and the generated pages themselves through /api/auth.
 */
(function (global) {
    // Copies text and briefly shows a "Copied!" label on the button
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

    global.TVFSGate = { copyWithFeedback };
})(window);
