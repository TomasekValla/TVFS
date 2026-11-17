'use strict';
// Small JSON documents in the data folder (outside the web root), written atomically and a moment
// after the last change. Only the backend process writes them. To be replaced by SQLite once the
// server runs Node 24 (built-in node:sqlite).
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

function open(name, initial) {
    const file = path.join(paths.DATA_DIR, name);
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { data = initial(); }
    let timer = null;
    const writeNow = () => {
        clearTimeout(timer); timer = null;
        try {
            fs.mkdirSync(paths.DATA_DIR, { recursive: true });
            fs.writeFileSync(file + '.tmp', JSON.stringify(data));
            fs.renameSync(file + '.tmp', file);
        } catch (e) {
            console.error(`[DATA] Could not save ${name}:`, e.message);
        }
    };
    return {
        get data() { return data; },
        save() { if (!timer) { timer = setTimeout(writeNow, 2000); timer.unref(); } },
        saveNow: writeNow,
    };
}

module.exports = { open };
