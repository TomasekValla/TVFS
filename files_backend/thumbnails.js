'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const THUMB_DIR = path.join(__dirname, '../files_web/files/thumbnails');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

const PUBLIC_PREFIX = '/files/thumbnails';

function runFfmpeg(args) {
    return new Promise((resolve) => {
        execFile('ffmpeg', args, { timeout: 20000 }, (err) => resolve(!err));
    });
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
    // Seek 1s in (avoids black opening frames); ffmpeg clamps to duration if shorter.
    const result = await encodeStill(['-ss', '00:00:01.000', '-i', filePath], fileId);
    return result ? result.url : null;
}

async function generateImageThumbnail(filePath, fileId) {
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
