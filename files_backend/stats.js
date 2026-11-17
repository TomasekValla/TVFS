'use strict';
// Statistics: opens of a file's link or page (counted from nginx through a mirror request) and plays
// (a signal from the player pages), once per client address and file per hour; plus global numbers
// over the whole history of TVFS.
const dataStore = require('./dataStore');

const HOUR_MS = 3600 * 1000;
const store = dataStore.open('stats.json', () => ({ global: { since: Date.now(), uploads: 0, uploadedBytes: 0, opens: 0, plays: 0 }, files: {} }));
const seen = new Map(); // "kind|ip|fileId" -> until

setInterval(() => {
    const now = Date.now();
    for (const [k, until] of seen) if (until <= now) seen.delete(k);
}, 10 * 60 * 1000).unref();

function once(kind, ip, fileId) {
    const key = `${kind}|${ip}|${fileId}`;
    const now = Date.now();
    if ((seen.get(key) || 0) > now) return false;
    if (seen.size > 200000) seen.clear(); // a flood must not grow memory
    seen.set(key, now + HOUR_MS);
    return true;
}

function fileEntry(fileId) {
    const files = store.data.files;
    if (!Object.prototype.hasOwnProperty.call(files, fileId)) files[fileId] = { opens: 0, plays: 0 };
    return files[fileId];
}

function countOpen(fileId, ip) {
    if (!fileId || !once('open', ip, fileId)) return false;
    const e = fileEntry(fileId); e.opens++; e.lastAt = Date.now();
    store.data.global.opens++;
    store.save();
    return true;
}

function countPlay(fileId, ip) {
    if (!fileId || !once('play', ip, fileId)) return false;
    const e = fileEntry(fileId); e.plays++; e.lastAt = Date.now();
    store.data.global.plays++;
    store.save();
    return true;
}

function countUpload(bytes) {
    store.data.global.uploads++;
    store.data.global.uploadedBytes += Math.max(0, Number(bytes) || 0);
    store.save();
}

function forFiles(ids) {
    const out = {};
    for (const id of ids) if (Object.prototype.hasOwnProperty.call(store.data.files, id)) out[id] = { opens: store.data.files[id].opens, plays: store.data.files[id].plays };
    return out;
}

function global() { return { ...store.data.global }; }

// Per-file numbers of files that are gone are kept for 13 months (as long as a 410 page can live)
function prune(aliveIds) {
    const cutoff = Date.now() - 13 * 30 * 24 * HOUR_MS;
    let n = 0;
    for (const [id, e] of Object.entries(store.data.files)) if (!aliveIds.has(id) && (e.lastAt || 0) < cutoff) { delete store.data.files[id]; n++; }
    if (n) store.save();
}

module.exports = { countOpen, countPlay, countUpload, forFiles, global, prune, saveNow: store.saveNow };
