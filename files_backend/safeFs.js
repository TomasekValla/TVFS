'use strict';

// No-clobber file helpers. Every write into a public files_web directory
// goes through these, so an existing file is never silently overwritten.
// Collision handling is atomic (O_EXCL / link), not check-then-act, so two
// concurrent requests asking for the same name always end up with two files.
// On collision a random `_<6 hex>` suffix is inserted before the extension.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ATTEMPTS = 10;

function withSuffix(filename) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    return `${base}_${crypto.randomBytes(3).toString('hex')}${ext}`;
}

// Creates the file exclusively ('wx'). Returns { filename, filePath, fd };
// the caller owns the fd (e.g. hands it to fs.createWriteStream).
function openUnique(dir, filename) {
    let candidate = filename;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const p = path.join(dir, candidate);
        try {
            const fd = fs.openSync(p, 'wx');
            return { filename: candidate, filePath: p, fd };
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            candidate = withSuffix(filename);
        }
    }
    throw new Error(`Could not find free filename for ${filename}`);
}

// No-clobber move. link() fails with EEXIST instead of replacing the target
// the way rename() would. Falls back to an exclusive copy where hard links
// are not possible (different filesystem / unsupported mount).
function moveUnique(srcPath, dir, filename) {
    let candidate = filename;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const p = path.join(dir, candidate);
        try {
            try {
                fs.linkSync(srcPath, p);
            } catch (e) {
                if (!['EXDEV', 'EPERM', 'ENOTSUP', 'ENOSYS'].includes(e.code)) throw e;
                fs.copyFileSync(srcPath, p, fs.constants.COPYFILE_EXCL);
            }
            fs.unlinkSync(srcPath);
            return { filename: candidate, filePath: p };
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            candidate = withSuffix(filename);
        }
    }
    throw new Error(`Could not find free filename for ${filename}`);
}

function writeFileUnique(dir, filename, data) {
    const { filename: f, filePath, fd } = openUnique(dir, filename);
    try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
    return { filename: f, filePath };
}

module.exports = { withSuffix, openUnique, moveUnique, writeFileUnique };
