#!/usr/bin/env node
'use strict';
// Moves existing accounts between tiers and/or adds new ones, directly in .env (a backup is kept).
//
//   node scripts/set-tiers.js <Codename>=<tier> ... [--new <Codename>=<tier> ...]
//
// <Codename>=<tier>        move an existing account (same username and password) to tier 1, 2 or 3
// --new <Codename>=<tier>  add an account: asks for its secret username and password (typed without echo)
// Afterwards: pm2 restart files-backend
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword } = require(path.join(__dirname, '..', 'userIdentity'));

const ENV = process.env.TVFS_ENV_FILE || path.join(__dirname, '..', '.env');
const KEYS = { 1: 'TIER1_USERS', 2: 'TIER2_USERS', 3: 'TIER3_USERS' };

const moves = [], adds = [];
let addMode = false;
for (const arg of process.argv.slice(2)) {
    if (arg === '--new') { addMode = true; continue; }
    const m = /^([A-Za-z0-9_-]{2,32})=([123])$/.exec(arg);
    if (!m) { console.error(`Not understood: ${arg}\nUsage: node scripts/set-tiers.js Name=3 Other=2 --new NewName=1`); process.exit(1); }
    (addMode ? adds : moves).push({ codename: m[1], tier: Number(m[2]) });
}
if (!moves.length && !adds.length) { console.error('Usage: node scripts/set-tiers.js Name=3 Other=2 --new NewName=1'); process.exit(1); }

// Reads one line from the terminal without showing it (text after the line is kept for the next question)
let leftover = '';
function ask(question) {
    process.stdout.write(question);
    return new Promise(resolve => {
        const stdin = process.stdin;
        const take = () => {
            const i = leftover.search(/[\r\n]/);
            if (i === -1) return false;
            const line = leftover.slice(0, i);
            leftover = leftover.slice(i + 1).replace(/^\n/, '');
            stdin.removeListener('data', onData);
            if (stdin.setRawMode) stdin.setRawMode(false);
            stdin.pause();
            process.stdout.write('\n');
            resolve(line);
            return true;
        };
        const onData = buf => {
            for (const ch of buf.toString('utf8')) {
                if (ch === '\u0003') process.exit(130); // Ctrl+C
                if (ch === '\u007f' || ch === '\b') leftover = leftover.slice(0, -1);
                else leftover += ch;
            }
            take();
        };
        if (take()) return;
        if (stdin.setRawMode) stdin.setRawMode(true);
        stdin.on('data', onData);
        stdin.resume();
    });
}

(async () => {
    const original = fs.readFileSync(ENV, 'utf8');
    const lines = original.split(/\r?\n/);
    // current entries per tier, keeping their order
    const lists = { 1: [], 2: [], 3: [] };
    const lineOf = {};
    lines.forEach((line, i) => {
        for (const [tier, key] of Object.entries(KEYS)) {
            const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`).exec(line);
            if (m) {
                lineOf[tier] = i;
                const value = m[1].trim().replace(/^(["'])(.*)\1$/, '$2');
                lists[tier] = value ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
            }
        }
    });
    const codenameOf = entry => entry.split(':')[0].trim();
    const findTier = codename => Object.keys(lists).find(t => lists[t].some(e => codenameOf(e) === codename));

    for (const { codename, tier } of moves) {
        const from = findTier(codename);
        if (!from) { console.error(`No account "${codename}" in .env; nothing changed.`); process.exit(1); }
        const entry = lists[from].find(e => codenameOf(e) === codename);
        lists[from] = lists[from].filter(e => e !== entry);
        lists[tier].push(entry);
        console.log(`${codename}: tier ${from} -> ${tier}`);
    }
    for (const { codename, tier } of adds) {
        if (findTier(codename)) { console.error(`"${codename}" already exists; nothing changed.`); process.exit(1); }
        console.log(`New account ${codename} (tier ${tier}):`);
        const username = (await ask('  secret login username: ')).trim();
        const password = await ask('  password: ');
        const again = await ask('  password again: ');
        if (!username || username.toLowerCase() === 'host') { console.error('Choose another username; nothing changed.'); process.exit(1); }
        if (password.length < 10) { console.error('Use at least 10 characters; nothing changed.'); process.exit(1); }
        if (password !== again) { console.error('The passwords differ; nothing changed.'); process.exit(1); }
        const userHash = crypto.createHash('sha256').update(username).digest('hex');
        const taken = Object.values(lists).flat().some(e => (e.split(':')[1] || '').toLowerCase() === userHash);
        if (taken) { console.error('This login username is already used by another account; nothing changed.'); process.exit(1); }
        lists[tier].push(`${codename}:${userHash}:${hashPassword(password)}`);
        console.log(`${codename}: added to tier ${tier}`);
    }

    // write: replace existing TIERn lines, append missing ones
    const out = lines.slice();
    for (const [tier, key] of Object.entries(KEYS)) {
        const line = `${key}=${lists[tier].join(',')}`;
        if (lineOf[tier] !== undefined) out[lineOf[tier]] = line;
        else if (lists[tier].length) out.push(line);
    }
    const backup = `${ENV}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(ENV, backup);
    fs.writeFileSync(ENV + '.tmp', out.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
    fs.renameSync(ENV + '.tmp', ENV);
    console.log(`\n.env updated (backup: ${path.basename(backup)}). Now: pm2 restart files-backend`);
    console.log(`Tier 1: ${lists[1].map(codenameOf).join(', ') || '-'} | Tier 2: ${lists[2].map(codenameOf).join(', ') || '-'} | Tier 3: ${lists[3].map(codenameOf).join(', ') || '-'}`);
    process.exit(0);
})();
