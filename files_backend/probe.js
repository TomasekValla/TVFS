// File Check: an ffprobe summary of a file stored on this server.
// The link is mapped to the file on disk and probed locally (no network access by ffprobe),
// only for logged-in users, at most two at a time.
const express = require('express');
const path = require('path');
const fs = require('fs');
const mediaQueue = require('./mediaQueue');
const paths = require('./paths');
const uploadRouter = require('./upload');
const router = express.Router();

const PUBLIC_HOSTS = new Set(['files.tomasekvalla.cz', 'tvfs.tomasekvalla.cz', 'usercontent.tvfs.tomasekvalla.cz']);
const MAX_PARALLEL = 2;
const PER_USER_PER_MIN = 30;
let running = 0;
const perUser = new Map(); // username -> { count, resetAt }

// The public link of a stored file -> its path on disk, or null
function localFileFor(url) {
    let parsed;
    try { parsed = new URL(String(url)); } catch { return null; }
    if (parsed.protocol !== 'https:' || !PUBLIC_HOSTS.has(parsed.hostname) || parsed.port) return null;
    let rel;
    try { rel = decodeURIComponent(parsed.pathname); } catch { return null; }
    if (!rel.startsWith('/files/') || rel.includes('\0')) return null;
    const full = path.resolve(paths.FILES_DIR, '.' + rel.slice('/files'.length));
    const inside = path.relative(paths.FILES_DIR, full);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
    try { if (!fs.statSync(full).isFile()) return null; } catch { return null; }
    return full;
}

function allowUser(username) {
    const now = Date.now();
    const e = perUser.get(username);
    if (!e || e.resetAt <= now) { perUser.set(username, { count: 1, resetAt: now + 60000 }); return true; }
    e.count++;
    return e.count <= PER_USER_PER_MIN;
}
setInterval(() => { const now = Date.now(); for (const [k, e] of perUser) if (e.resetAt <= now) perUser.delete(k); }, 60000).unref();

router.post('/probe', (req, res) => {
    const auth = uploadRouter.authenticateRequest(req);
    if (!auth.valid || auth.tier < 1) return res.status(403).json({ error: 'Log in to use File Check' });
    if (!allowUser(auth.username)) return res.status(429).json({ error: 'Too many checks, try again in a minute' });

    const url = req.body && req.body.url;
    const file = localFileFor(url);
    if (!file) return res.status(400).json({ error: 'Only links to files stored on TVFS can be checked.' });
    if (running >= MAX_PARALLEL) {
        res.set('Retry-After', 5);
        return res.status(503).json({ error: 'Busy with other checks, try again in a moment' });
    }

    running++;
    // the shared queue adds -protocol_whitelist file (local files only)
    mediaQueue.run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file],
        { timeoutMs: 30000, maxBytes: 8 * 1024 * 1024, priority: 1 }).then(result => {
        running--;
        if (result.code !== 0) return res.status(500).json({ error: 'ffprobe failed' });
        const stdout = result.stdout.toString('utf8');

        try {
            const raw = JSON.parse(stdout);
            // never show the server's own path
            const shownName = path.basename(file);
            if (raw.format) raw.format.filename = shownName;
            // Build a clean structured summary
            const streams = (raw.streams || []).map(s => {
                const base = {
                    index: s.index,
                    codec_type: s.codec_type,
                    codec_name: s.codec_name,
                    codec_long_name: s.codec_long_name,
                };
                if (s.codec_type === 'video') {
                    return {
                        ...base,
                        width: s.width,
                        height: s.height,
                        r_frame_rate: s.r_frame_rate,
                        avg_frame_rate: s.avg_frame_rate,
                        pix_fmt: s.pix_fmt,
                        bit_rate: s.bit_rate,
                        nb_frames: s.nb_frames,
                        duration: s.duration,
                        profile: s.profile,
                        level: s.level,
                        color_space: s.color_space,
                        color_range: s.color_range,
                    };
                } else if (s.codec_type === 'audio') {
                    return {
                        ...base,
                        sample_rate: s.sample_rate,
                        channels: s.channels,
                        channel_layout: s.channel_layout,
                        bit_rate: s.bit_rate,
                        duration: s.duration,
                    };
                }
                return base;
            });

            const format = raw.format ? {
                filename: shownName,
                format_name: raw.format.format_name,
                format_long_name: raw.format.format_long_name,
                duration: raw.format.duration,
                size: raw.format.size,
                bit_rate: raw.format.bit_rate,
                nb_streams: raw.format.nb_streams,
            } : null;

            res.json({ streams, format, raw });
        } catch (e) {
            res.status(500).json({ error: 'Failed to parse ffprobe output' });
        }
    });
});

module.exports = router;
module.exports.localFileFor = localFileFor;
