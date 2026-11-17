'use strict';
// Upload limits and retention per tier (owner's decisions 2026-11-16). One place for the rules,
// used by the server to enforce them and sent to the clients (/api/config) so the expiry picker
// can grey out what is not allowed.
const fs = require('fs');
const paths = require('./paths');
const { nextPragueMidnight } = require('./userIdentity');

const MB = 1024 * 1024, GB = 1024 * MB;
const DAY_MIN = 24 * 60;

const RESERVE_BYTES = (parseFloat(process.env.TVFS_RESERVE_GB) || 2) * GB; // never handed out
const MAX_FILE_BYTES = 5 * GB;          // one file, and one batch together
const HOST_MAX_FILE_BYTES = 400 * MB;   // tier 0
const HOST_TOTAL_BYTES = (parseFloat(process.env.TVFS_HOST_TOTAL_MB) || 1024) * MB; // tier 0, all host uploads together (oldest go first)

// Expiry choices in minutes (5 m ... 30 d); the default is 7 days, capped by the rules below
const EXPIRY_OPTIONS = [5, 30, 60, 360, 720, 1440, 2880, 4320, 7200, 10080, 14400, 20160, 43200];
const DEFAULT_EXPIRY_MIN = 10080;

const TIER_MAX_MIN = { 1: 7 * DAY_MIN, 2: 14 * DAY_MIN, 3: 30 * DAY_MIN };

// Tiers 1 and 2: the bigger the file, the shorter it may stay
const SIZE_STEPS = [
    { upTo: 100 * MB, max: { 1: 7 * DAY_MIN, 2: 14 * DAY_MIN } },
    { upTo: 1 * GB,   max: { 1: 5 * DAY_MIN, 2: 10 * DAY_MIN } },
    { upTo: 3 * GB,   max: { 1: 3 * DAY_MIN, 2: 7 * DAY_MIN } },
    { upTo: 5 * GB,   max: { 1: 1 * DAY_MIN, 2: 3 * DAY_MIN } },
];
// Tiers 1 and 2: the bigger the share of the available space, the shorter it may stay
const SPACE_STEPS = [
    { upTo: 0.05, factor: 1 },
    { upTo: 0.15, factor: 0.5 },
    { upTo: 0.30, factor: 0.25 },
];

// Random suffix length added to stored names (tier 3: none when the name is free)
const SUFFIX_LENGTH = { 0: 10, 1: 6, 2: 4, 3: 3 };
// Media work (thumbnails, BPM, loudness) runs first for higher tiers
const MEDIA_PRIORITY = { 0: 0, 1: 1, 2: 2, 3: 3 };

function freeBytes() {
    try { const s = fs.statfsSync(paths.FILES_DIR); return s.bavail * s.bsize; } catch (e) { return null; }
}

// What uploads may still use (free space minus the reserve); null when the platform cannot tell
function availableBytes() {
    const free = freeBytes();
    return free === null ? null : Math.max(0, free - RESERVE_BYTES);
}

function maxFileBytes(tier) {
    return tier === 0 ? HOST_MAX_FILE_BYTES : MAX_FILE_BYTES;
}

// Longest retention in minutes for this upload, or 0 when it must be refused
function maxExpiryMinutes(tier, sizeBytes, available = availableBytes(), now = Date.now()) {
    const size = Math.max(0, Number(sizeBytes) || 0);
    if (size > maxFileBytes(tier)) return 0;
    if (available !== null && size > available) return 0;
    if (tier === 0) return Math.max(1, Math.floor((nextPragueMidnight(now) - now) / 60000));
    if (tier === 3) return TIER_MAX_MIN[3];
    if (tier !== 1 && tier !== 2) return 0;
    const step = SIZE_STEPS.find(s => size <= s.upTo);
    let max = step ? step.max[tier] : 0;
    if (available !== null && available > 0) {
        const share = size / available;
        const space = SPACE_STEPS.find(s => share <= s.upTo);
        const byShare = space ? Math.max(DAY_MIN, Math.floor(TIER_MAX_MIN[tier] * space.factor)) : DAY_MIN;
        max = Math.min(max, byShare);
    }
    return max;
}

// The expiry actually used: the requested option, lowered to the longest allowed one
function effectiveExpiryMinutes(tier, sizeBytes, requested, available) {
    const allowed = maxExpiryMinutes(tier, sizeBytes, available);
    if (allowed <= 0) return 0;
    const req = EXPIRY_OPTIONS.includes(parseInt(requested, 10)) ? parseInt(requested, 10) : DEFAULT_EXPIRY_MIN;
    if (req <= allowed) return req;
    if (tier === 0) return allowed; // until midnight
    const fit = EXPIRY_OPTIONS.filter(o => o <= allowed);
    return fit.length ? fit[fit.length - 1] : allowed;
}

// Rules for the clients (the expiry picker computes the same caps from these)
function clientConfig(tier) {
    return {
        tier,
        expiryOptions: EXPIRY_OPTIONS,
        defaultExpiryMinutes: DEFAULT_EXPIRY_MIN,
        tierMaxMinutes: tier === 0 ? null : (TIER_MAX_MIN[tier] || 0),
        untilMidnight: tier === 0 ? nextPragueMidnight() : null,
        sizeSteps: tier === 1 || tier === 2 ? SIZE_STEPS.map(s => ({ upTo: s.upTo, maxMinutes: s.max[tier] })) : [],
        spaceSteps: tier === 1 || tier === 2 ? SPACE_STEPS : [],
        maxFileBytes: maxFileBytes(tier),
        maxBatchBytes: MAX_FILE_BYTES,
        hostTotalBytes: tier === 0 ? HOST_TOTAL_BYTES : null,
        availableBytes: availableBytes(),
    };
}

module.exports = {
    MB, GB, RESERVE_BYTES, MAX_FILE_BYTES, HOST_MAX_FILE_BYTES, HOST_TOTAL_BYTES, EXPIRY_OPTIONS, DEFAULT_EXPIRY_MIN,
    SUFFIX_LENGTH, MEDIA_PRIORITY, freeBytes, availableBytes, maxFileBytes, maxExpiryMinutes, effectiveExpiryMinutes, clientConfig,
};
