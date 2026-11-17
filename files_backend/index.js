const path = require('path');
const dotenvResult = require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
if (dotenvResult.error) {
    console.warn('⚠️  [ENV] Failed to load .env from', path.join(__dirname, '.env'), dotenvResult.error.message);
} else {
    console.log('🔐 [ENV] Loaded .env from', path.join(__dirname, '.env'), `(TIER1: ${Boolean(process.env.TIER1_USERS)}, TIER2: ${Boolean(process.env.TIER2_USERS)})`);
}

// ─── Global crash safety net ────────────────────────────────────────────
// Registered FIRST, before any other require() below — a synchronous
// throw or an early unhandled rejection while loading one of those modules
// needs a listener that already exists to be caught at all. Logs the full
// error either way; only exits (for a clean PM2 restart) on a genuine
// uncaughtException, not on a rejected promise from a background task.
process.on('unhandledRejection', (reason) => {
    console.error('🔥 Unhandled promise rejection (kept process alive):', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught exception:', err && err.stack ? err.stack : err);
    process.exit(1);
});

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const uploadRoutes = require('./upload');
const spotifyRoutes = require('./spotify');
const probeRoutes = require('./probe');
const speedtestRoutes = require('./speedtest');
const { router: protectedShareRoutes, INIT_BODY_PATH } = require('./protectedShare');
const { router: batteryRoutes } = require('./battery');
// Optional private module (not in this repo); the backend runs fine without it.
let simrailRoutes = null;
try { ({ router: simrailRoutes } = require('./simrail')); }
catch (err) {
    const missing = err.code === 'MODULE_NOT_FOUND' && String(err.message).includes("'./simrail'");
    if (!missing) console.error('[SimRail] module failed to load:', err);
}
const http = require('http');
const { router: moneyGameRoutes, attachSocket } = require('./moneygame/moneyGame');

// TWC chat is switched off unless TWC_ENABLED=1; when off, its modules are not even loaded
const TWC_ENABLED = process.env.TWC_ENABLED === '1';
const twc = TWC_ENABLED ? {
    identity: require('./twc/identity').router,
    social: require('./twc/social').router,
    settings: require('./twc/settings').router,
    attachSocket: require('./twc/socket').attachTwcSocket,
} : null;
console.log(`[TWC] chat ${TWC_ENABLED ? 'enabled' : 'disabled (set TWC_ENABLED=1 to enable)'}`);

const app = express();
app.set('trust proxy', 1);  // <-- taky přidej tady

app.use(cors({
    origin: ['https://tomasekvalla.cz', 'https://www.tomasekvalla.cz', 'https://files.tomasekvalla.cz'],
    credentials: true
}));
app.use(cookieParser());

// TVFS routes that change something accept browser requests only from the TVFS page itself
// (a foreign site could otherwise log a visitor into another account). The app and the CLI
// send no Origin header. The main website's origins stay allowed for the side apps only.
const TVFS_WRITE_PATHS = /^\/api\/(auth|verify-password|logout(-everywhere|-all)?|upload|file|batch|protected|user|settings|expired)(\/|$)/;
app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !TVFS_WRITE_PATHS.test(req.path)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    let host = null;
    try { host = new URL(origin).host; } catch (e) {}
    if (origin === 'https://files.tomasekvalla.cz' || (host && host === req.headers.host)) return next();
    return res.status(403).json({ error: 'Cross-site request refused' });
});
// The Users Only upload init has its own, larger body parsers (see protectedShare.js); all other routes keep the defaults
// (and the battery dataset upload has its own 25 MB parser)
const OWN_PARSERS = new Set([INIT_BODY_PATH, '/api/battery/dataset']);
const skipFor = (mw) => (req, res, next) => (OWN_PARSERS.has(req.path) ? next() : mw(req, res, next));
app.use(skipFor(express.json()));
app.use(skipFor(express.urlencoded({ extended: true })));

app.post('/share-target', (req, res) => res.redirect(303, '/upload.html?share=1'));
app.get('/share-target', (req, res) => res.redirect(302, '/upload.html'));

app.use('/fonts', express.static('/DATA/files_web/fonts'));

app.use('/api', uploadRoutes);
// only the site nginx reaches these (open counts, 410 pages); the public proxy forwards /api/ only
app.use('/internal', uploadRoutes.internal);
app.use('/api/spotify', spotifyRoutes);
app.use('/api', probeRoutes);
app.use('/api', speedtestRoutes);
app.use('/api/protected', protectedShareRoutes);
app.use('/api/battery', batteryRoutes);
app.use('/api/moneygame', moneyGameRoutes);
if (simrailRoutes) app.use('/api/simrail', simrailRoutes);

if (twc) {
    app.use('/api/twc', twc.identity);
    app.use('/api/twc', twc.social);
    app.use('/api/twc/settings', twc.settings);
    app.use('/chat', express.static('/DATA/files_web/chat'));
}

// Last error handler: log it, answer with a short JSON error (never a stack trace)
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : (Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500);
    if (status >= 500) console.error(`[ERROR] ${req.method} ${req.path}:`, err && err.stack ? err.stack : err);
    res.status(status).json({ error: status === 413 ? 'Upload too large' : status >= 500 ? 'Server error' : 'Bad request' });
});

const server = http.createServer(app);
attachSocket(server);

// TWC has its own Socket.IO server on a different path than moneyGame's
if (twc) {
    const { notify: twcNotify } = twc.attachSocket(server);
    app.set('twcNotify', twcNotify);
}

// Expiry cleanup runs in this process on the live registry (the cron copy stays idle meanwhile)
require('./cleanup').startInProcess(uploadRoutes.registryAccess);

const PORT = 14150;
server.listen(PORT, '0.0.0.0', () => console.log(`Backend běží na http://0.0.0.0:${PORT}`));