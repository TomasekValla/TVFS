#!/usr/bin/env node
'use strict';
// Prints the .env entry for a TVFS account (secret username hashed with sha256, password with scrypt).
//   node scripts/add-user.js <Codename> <tier 1|2|3>
// The username and password are typed without echo; nothing is written anywhere. Append the printed
// entry to TIER<n>_USERS in .env (comma-separated), then `pm2 restart files-backend`.
const crypto = require('crypto');
const path = require('path');
const { hashPassword } = require(path.join(__dirname, '..', 'userIdentity'));

const [codename, tierArg] = process.argv.slice(2);
const tier = Number(tierArg);
if (!codename || !/^[A-Za-z0-9_-]{2,32}$/.test(codename) || ![1, 2, 3].includes(tier)) {
    console.error('Usage: node scripts/add-user.js <Codename (letters, digits, _ -)> <tier 1|2|3>');
    process.exit(1);
}

// Reads one line from the terminal without showing it
function ask(question) {
    return new Promise(resolve => {
        const stdin = process.stdin;
        process.stdout.write(question);
        let value = '';
        const onData = buf => {
            for (const ch of buf.toString('utf8')) {
                if (ch === '\r' || ch === '\n') {
                    stdin.setRawMode && stdin.setRawMode(false);
                    stdin.pause();
                    stdin.removeListener('data', onData);
                    process.stdout.write('\n');
                    return resolve(value);
                }
                if (ch === '\u0003') process.exit(130); // Ctrl+C
                if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
                else value += ch;
            }
        };
        stdin.setRawMode && stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', onData);
    });
}

(async () => {
    const username = (await ask('Secret login username: ')).trim();
    const password = await ask('Password: ');
    const again = await ask('Password again: ');
    if (!username || username.toLowerCase() === 'host') { console.error('Choose another username.'); process.exit(1); }
    if (password.length < 10) { console.error('Use at least 10 characters.'); process.exit(1); }
    if (password !== again) { console.error('The passwords differ.'); process.exit(1); }
    const userHash = crypto.createHash('sha256').update(username).digest('hex');
    console.log(`\nAdd this entry to TIER${tier}_USERS in .env (separate entries with a comma):\n`);
    console.log(`${codename}:${userHash}:${hashPassword(password)}\n`);
})();
