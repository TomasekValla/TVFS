'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

// ─── What this needs installed on the server ───────────────────────────────
//
//   apt install ffmpeg aubio-tools
//
// ffmpeg/ffprobe → codec, bitrate, channels, sample rate, duration.
// aubiotempo (from aubio-tools, or `pip install aubio` also ships a CLI in
// some distros) → beat tracking / BPM estimate. Both are called as plain
// CLI tools via execFileSync, no npm bindings needed, so it's a one-line
// apt-get and nothing else to wire up.
//
// If either binary is missing, everything degrades gracefully — metadata
// falls back to nulls, BPM falls back to null, and the player page just
// hides whatever field it couldn't get instead of crashing the upload.

// ─── What this needs installed on the server ───────────────────────────────
//
//   apt install ffmpeg
//
// That's it. BPM detection no longer shells out to `aubio`/`aubiotempo` —
// that tool turned out to be a pain to get reliably on PATH across distros
// and pip/apt packaging variants, so BPM is now detected with nothing but
// ffmpeg (decode to raw PCM) + a plain-JS energy/autocorrelation pass.
// One less moving part, one less thing that can silently be "installed but
// not actually the binary we're calling".

// bits_per_raw_sample is the real encoded bit depth for lossless formats
// (FLAC, ALAC, WAV, ...). Lossy codecs (MP3, OGG, OPUS, AAC) don't really
// have a "bit depth" in this sense — ffprobe reports 0 or omits it, and we
// correctly surface that as null rather than guessing.
function bitDepthFromStream(stream) {
    if (stream.bits_per_raw_sample && parseInt(stream.bits_per_raw_sample, 10) > 0) {
        return parseInt(stream.bits_per_raw_sample, 10);
    }
    if (stream.bits_per_sample && parseInt(stream.bits_per_sample, 10) > 0) {
        return parseInt(stream.bits_per_sample, 10);
    }
    const fmtBits = { s16: 16, s16p: 16, s32: 32, s32p: 32, u8: 8, u8p: 8, s64: 64, s64p: 64 };
    if (stream.sample_fmt && fmtBits[stream.sample_fmt]) return fmtBits[stream.sample_fmt];
    return null;
}

function ffprobeMeta(filePath) {
    try {
        const out = execFileSync('ffprobe', [
            '-v', 'error',
            '-print_format', 'json',
            '-show_format', '-show_streams',
            filePath
        ], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }).toString('utf8');

        const data = JSON.parse(out);
        const stream = (data.streams || []).find(s => s.codec_type === 'audio') || {};
        const format = data.format || {};

        return {
            codec: stream.codec_name ? stream.codec_name.toUpperCase() : null,
            container: format.format_name || null,
            bitrateKbps: format.bit_rate ? Math.round(parseInt(format.bit_rate, 10) / 1000) : null,
            sampleRateHz: stream.sample_rate ? parseInt(stream.sample_rate, 10) : null,
            channels: stream.channels || null,
            channelLayout: stream.channel_layout || null,
            bitDepth: bitDepthFromStream(stream),
            durationSec: format.duration ? parseFloat(format.duration) : null,
        };
    } catch (err) {
        console.error(`⚠️  [BPM/ffprobe] Failed for ${filePath}:`, err.message);
        return {
            codec: null, container: null, bitrateKbps: null,
            sampleRateHz: null, channels: null, channelLayout: null, bitDepth: null, durationSec: null
        };
    }
}

// ─── Pure ffmpeg + JS tempo detection ───────────────────────────────────────
//
// 1. Decode to mono 16-bit PCM at 11025 Hz (plenty of headroom for beat
//    energy — kicks/snares/bass all live well under 5.5kHz Nyquist here).
// 2. Compute a short-window RMS energy envelope.
// 3. Onset strength = half-wave-rectified derivative of that envelope
//    (i.e. "how much louder did it just get" — the classic spectral-flux-
//    style onset signal, just done on broadband energy instead of a
//    per-bin spectrogram, which is enough for tempo tracking).
// 4. Autocorrelate the onset signal over lags corresponding to 55–190 BPM.
// 5. Autocorrelation of a rhythmic signal peaks just as strongly at 2x/3x
//    the true beat period (a beat every other bar still lines up), which
//    biases a naive "take the strongest lag" pick toward HALF the real
//    tempo. So instead: walk from the shortest lag (fastest tempo) upward
//    and take the first strong local peak — the true beat period, not one
//    of its slower harmonics.
function detectBpm(filePath) {
    try {
        const SR = 11025;
        const raw = execFileSync('ffmpeg', [
            '-v', 'error', '-i', filePath,
            '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'
        ], { maxBuffer: 200 * 1024 * 1024, timeout: 45000 });

        const sampleCount = Math.floor(raw.length / 2);
        if (sampleCount < SR * 3) return null; // too short to trust (<3s of audio)

        const samples = new Int16Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) samples[i] = raw.readInt16LE(i * 2);

        const WIN = 512, HOP = 256;
        const frames = Math.floor((sampleCount - WIN) / HOP);
        if (frames < 100) return null;

        const envelope = new Float64Array(frames);
        for (let f = 0; f < frames; f++) {
            let sum = 0;
            const start = f * HOP;
            for (let i = 0; i < WIN; i++) {
                const s = samples[start + i] / 32768;
                sum += s * s;
            }
            envelope[f] = Math.sqrt(sum / WIN);
        }

        const onset = new Float64Array(frames);
        for (let f = 1; f < frames; f++) {
            const d = envelope[f] - envelope[f - 1];
            onset[f] = d > 0 ? d : 0;
        }
        let mean = 0;
        for (let f = 0; f < frames; f++) mean += onset[f];
        mean /= frames;
        for (let f = 0; f < frames; f++) onset[f] -= mean;

        const hopSec = HOP / SR;
        const minBpm = 55, maxBpm = 190;
        const minLag = Math.round((60 / maxBpm) / hopSec);
        const maxLag = Math.round((60 / minBpm) / hopSec);

        const scores = new Float64Array(maxLag + 1);
        let globalMax = -Infinity;
        for (let lag = minLag; lag <= maxLag; lag++) {
            let score = 0;
            for (let f = 0; f + lag < frames; f++) score += onset[f] * onset[f + lag];
            score /= (frames - lag);
            scores[lag] = score;
            if (score > globalMax) globalMax = score;
        }
        if (!Number.isFinite(globalMax) || globalMax <= 0) return null;

        let bestLag = -1;
        for (let lag = minLag + 1; lag < maxLag; lag++) {
            const isLocalPeak = scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1];
            if (isLocalPeak && scores[lag] >= globalMax * 0.68) { bestLag = lag; break; }
        }
        if (bestLag < 0) {
            for (let lag = minLag; lag <= maxLag; lag++) {
                if (scores[lag] === globalMax) { bestLag = lag; break; }
            }
        }
        if (bestLag <= 0) return null;

        return Math.round(60 / (bestLag * hopSec));
    } catch (err) {
        console.error(`⚠️  [BPM] Failed for ${filePath}:`, err.message);
        return null;
    }
}

// Single entry point: returns everything the player page + styled link need.
function analyzeAudio(filePath) {
    const meta = ffprobeMeta(filePath);
    const bpm = detectBpm(filePath);
    return { ...meta, bpm };
}

module.exports = { analyzeAudio, ffprobeMeta, detectBpm };
