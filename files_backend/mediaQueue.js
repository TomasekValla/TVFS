'use strict';
// One queue for every ffmpeg / ffprobe run of the backend: async (never blocks the server),
// at most TVFS_MEDIA_JOBS at a time (default 2), each with a timeout and an output cap,
// and only local files (protocol whitelist). Higher `priority` runs first (tiers can use it).
const { spawn } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');

// The priority of the request that started a job (set once per request, see enterPriority)
const context = new AsyncLocalStorage();
function enterPriority(priority) { context.enterWith(Number(priority) || 0); }

const MAX_JOBS = Math.max(1, parseInt(process.env.TVFS_MEDIA_JOBS, 10) || 2);
const waiting = []; // { priority, seq, start }
let running = 0, seq = 0;

function pump() {
    while (running < MAX_JOBS && waiting.length) {
        waiting.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
        const job = waiting.shift();
        running++;
        job.start().finally(() => { running--; pump(); });
    }
}

function spawnTool(cmd, args, timeoutMs, maxBytes) {
    return new Promise(resolve => {
        let proc;
        try { proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
        catch (e) { return resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }); }
        const out = [], err = [];
        let outLen = 0, errLen = 0, done = false;
        const finish = code => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
        };
        const kill = () => { try { proc.kill('SIGKILL'); } catch (e) {} };
        const timer = setTimeout(() => { kill(); finish(-1); }, timeoutMs);
        proc.stdout.on('data', d => { outLen += d.length; if (outLen > maxBytes) { kill(); finish(-1); } else out.push(d); });
        proc.stderr.on('data', d => { errLen += d.length; if (errLen <= maxBytes) err.push(d); });
        proc.on('error', () => finish(-1));
        proc.on('close', code => finish(code));
    });
}

// Resolves { code, stdout, stderr }; code -1 = could not start, timed out or output too big
function run(cmd, args, { timeoutMs = 60000, maxBytes = 16 * 1024 * 1024, priority } = {}) {
    if (priority === undefined) priority = context.getStore() || 0;
    if (cmd !== 'ffmpeg' && cmd !== 'ffprobe') throw new Error('mediaQueue runs ffmpeg/ffprobe only');
    // options before the first input apply to it: local files only, never network or concat tricks
    const safeArgs = ['-protocol_whitelist', 'file', ...args];
    if (cmd === 'ffmpeg' && !safeArgs.includes('-nostdin')) safeArgs.unshift('-nostdin');
    return new Promise(resolve => {
        waiting.push({ priority, seq: seq++, start: () => spawnTool(cmd, safeArgs, timeoutMs, maxBytes).then(resolve) });
        pump();
    });
}

module.exports = { run, enterPriority, stats: () => ({ running, waiting: waiting.length, maxJobs: MAX_JOBS }) };
