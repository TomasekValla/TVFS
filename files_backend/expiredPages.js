'use strict';
// "This file has expired" (410) records: the link of an expired upload keeps answering 410 instead
// of 404 for as long as its owner chose (Settings, default 3 months). No file name is kept.
const dataStore = require('./dataStore');

const MONTH_MS = 30 * 24 * 3600 * 1000;
const store = dataStore.open('expired-pages.json', () => ({ pages: {} }));
const pages = () => store.data.pages;

const linkPathOf = file => `/files/${file.directory}/${file.storedName}`;

// early: removed before its time because the server was full
function add(file, months, early = false) {
    if (!months || !file || !file.storedName || !file.directory) return;
    const now = Date.now();
    pages()[linkPathOf(file)] = { fileId: file.id, ownerKey: file.ownerKey || null, expiredAt: now, until: now + months * MONTH_MS, early: !!early };
    store.save();
}

function lookup(linkPath) {
    const e = Object.prototype.hasOwnProperty.call(pages(), linkPath) ? pages()[linkPath] : null;
    if (!e) return null;
    if (e.until <= Date.now()) { delete pages()[linkPath]; store.save(); return null; }
    return e;
}

// The owner deletes the record from Recently uploaded
function removeForOwner(fileId, ownerKey) {
    let n = 0;
    for (const [k, e] of Object.entries(pages())) if (e.fileId === fileId && e.ownerKey === ownerKey) { delete pages()[k]; n++; }
    if (n) store.save();
    return n;
}

function prune() {
    const now = Date.now();
    let n = 0;
    for (const [k, e] of Object.entries(pages())) if (e.until <= now) { delete pages()[k]; n++; }
    if (n) store.save();
    return n;
}

module.exports = { add, lookup, removeForOwner, prune, linkPathOf, saveNow: store.saveNow };
