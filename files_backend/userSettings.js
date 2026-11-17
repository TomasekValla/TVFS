'use strict';
// Per-user settings kept on the server: the ones the server needs (how long 410 pages live) and an
// opt-in copy of the page/app preferences so they follow the user to other devices.
const dataStore = require('./dataStore');

const store = dataStore.open('user-settings.json', () => ({ users: {} }));
const DEFAULTS = { expiredPageMonths: 3, client: null };
const MAX_CLIENT_BYTES = 8 * 1024;

const VALID = {
    expiredPageMonths: v => [0, 1, 3, 6, 12].includes(v),
    // free-form preferences of the web page / app (theme, chunk mode, voice format, ...), small JSON object
    client: v => v === null || (typeof v === 'object' && !Array.isArray(v) && Buffer.byteLength(JSON.stringify(v)) <= MAX_CLIENT_BYTES),
};

function get(username) {
    const own = Object.prototype.hasOwnProperty.call(store.data.users, username) ? store.data.users[username] : {};
    return { ...DEFAULTS, ...own };
}

// Returns the error text for a bad value, or null when saved
function set(username, patch) {
    if (!patch || typeof patch !== 'object') return 'Expected an object';
    for (const [k, v] of Object.entries(patch)) {
        if (!VALID[k]) return `Unknown setting: ${k}`;
        if (!VALID[k](v)) return `Invalid value for ${k}`;
    }
    const users = store.data.users;
    users[username] = { ...(Object.prototype.hasOwnProperty.call(users, username) ? users[username] : {}), ...patch };
    store.save();
    return null;
}

module.exports = { get, set, DEFAULTS };
