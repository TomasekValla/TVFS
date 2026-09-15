const express = require('express');
const { exec } = require('child_process');
const router = express.Router();

const ALLOWED_ORIGIN = 'https://files.tomasekvalla.cz';

function validateUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== 'files.tomasekvalla.cz') return false;
        if (!['https:'].includes(parsed.protocol)) return false;
        // Prevent path traversal or weird stuff
        if (parsed.pathname.includes('..')) return false;
        return true;
    } catch {
        return false;
    }
}

router.post('/probe', (req, res) => {
    const { url } = req.body;

    if (!url || !validateUrl(url)) {
        return res.status(400).json({ error: 'Only files.tomasekvalla.cz URLs are allowed.' });
    }

    // Escape the URL for shell — wrap in single quotes and escape any single quotes within
    const safeUrl = url.replace(/'/g, "'\\''");

    const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams '${safeUrl}'`;

    exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({
                error: 'ffprobe failed',
                details: error.message
            });
        }

        try {
            const raw = JSON.parse(stdout);
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
                filename: raw.format.filename,
                format_name: raw.format.format_name,
                format_long_name: raw.format.format_long_name,
                duration: raw.format.duration,
                size: raw.format.size,
                bit_rate: raw.format.bit_rate,
                nb_streams: raw.format.nb_streams,
            } : null;

            res.json({ streams, format, raw });
        } catch (e) {
            res.status(500).json({ error: 'Failed to parse ffprobe output', raw: stdout });
        }
    });
});

module.exports = router;