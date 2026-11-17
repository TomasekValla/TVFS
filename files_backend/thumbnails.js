'use strict';

const fs = require('fs');
const path = require('path');
const mediaQueue = require('./mediaQueue');
const paths = require('./paths');

const THUMB_DIR = path.join(paths.FILES_DIR, 'thumbnails');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

const PUBLIC_PREFIX = '/files/thumbnails';

// Pictures larger than this are not decoded for a thumbnail (a tiny PNG can claim 16000 x 16000
// and need gigabytes of memory to decode)
const MAX_PIXELS = 50 * 1000 * 1000;
const MAX_SIDE = 16384;

async function runFfmpeg(args) {
    const r = await mediaQueue.run('ffmpeg', ['-threads', '1', ...args], { timeoutMs: 20000, maxBytes: 1024 * 1024 });
    return r.code === 0;
}

// Width and height of the first video stream, or null when ffprobe cannot tell
async function dimensions(filePath) {
    const r = await mediaQueue.run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', filePath],
        { timeoutMs: 10000, maxBytes: 64 * 1024 });
    if (r.code !== 0) return null;
    try {
        const st = (JSON.parse(r.stdout.toString('utf8')).streams || [])[0] || {};
        return st.width && st.height ? { w: st.width, h: st.height } : null;
    } catch (e) { return null; }
}

async function tooLarge(filePath) {
    const d = await dimensions(filePath);
    return !d || d.w > MAX_SIDE || d.h > MAX_SIDE || d.w * d.h > MAX_PIXELS;
}

// One still frame, scaled down, encoded as AVIF (libaom-av1 still-picture).
// Falls back to WebP if the installed ffmpeg build lacks AVIF encoding
// support (older builds without libaom) — WebP is universally supported by
// modern browsers and still ~30-50% smaller than JPEG at similar quality.
async function encodeStill(inputArgs, fileId) {
    const avifPath = path.join(THUMB_DIR, `${fileId}.avif`);
    const avifOk = await runFfmpeg([
        '-y', ...inputArgs,
        '-frames:v', '1',
        '-vf', 'scale=480:-2',
        '-c:v', 'libaom-av1', '-still-picture', '1', '-crf', '32',
        avifPath
    ]);
    if (avifOk && fs.existsSync(avifPath)) {
        return { path: avifPath, url: `${PUBLIC_PREFIX}/${fileId}.avif` };
    }
    try { if (fs.existsSync(avifPath)) fs.unlinkSync(avifPath); } catch (e) {}

    const webpPath = path.join(THUMB_DIR, `${fileId}.webp`);
    const webpOk = await runFfmpeg([
        '-y', ...inputArgs,
        '-frames:v', '1',
        '-vf', 'scale=480:-2',
        '-c:v', 'libwebp', '-quality', '75',
        webpPath
    ]);
    if (webpOk && fs.existsSync(webpPath)) {
        return { path: webpPath, url: `${PUBLIC_PREFIX}/${fileId}.webp` };
    }
    try { if (fs.existsSync(webpPath)) fs.unlinkSync(webpPath); } catch (e) {}
    return null;
}

async function generateVideoThumbnail(filePath, fileId) {
    if (await tooLarge(filePath)) return null;
    // Seek 1s in (avoids black opening frames); ffmpeg clamps to duration if shorter.
    const result = await encodeStill(['-ss', '00:00:01.000', '-i', filePath], fileId);
    return result ? result.url : null;
}

async function generateImageThumbnail(filePath, fileId) {
    if (await tooLarge(filePath)) return null;
    const result = await encodeStill(['-i', filePath], fileId);
    return result ? result.url : null;
}

// category: 'video' | 'image' | anything else → no-op, returns null
async function maybeGenerateThumbnail(filePath, category, fileId) {
    try {
        if (category === 'video') return await generateVideoThumbnail(filePath, fileId);
        if (category === 'image') return await generateImageThumbnail(filePath, fileId);
        return null;
    } catch (e) {
        console.error(`⚠️  [THUMBNAIL] Failed for ${fileId}:`, e.message);
        return null;
    }
}

function deleteThumbnail(fileId) {
    for (const ext of ['avif', 'webp']) {
        const p = path.join(THUMB_DIR, `${fileId}.${ext}`);
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
    }
}

module.exports = { maybeGenerateThumbnail, deleteThumbnail, THUMB_DIR };
