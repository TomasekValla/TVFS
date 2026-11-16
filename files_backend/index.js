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
// The Users Only upload init has its own, larger body parsers (see protectedShare.js); all other routes keep the defaults
const skipFor = (path, mw) => (req, res, next) => (req.path === path ? next() : mw(req, res, next));
app.use(skipFor(INIT_BODY_PATH, express.json()));
app.use(skipFor(INIT_BODY_PATH, express.urlencoded({ extended: true })));

app.post('/share-target', (req, res) => res.redirect(303, '/upload.html?share=1'));
app.get('/share-target', (req, res) => res.redirect(302, '/upload.html'));

app.use('/fonts', express.static('/DATA/files_web/fonts'));

app.use('/api', uploadRoutes);
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

const server = http.createServer(app);
attachSocket(server);

// TWC has its own Socket.IO server on a different path than moneyGame's
if (twc) {
    const { notify: twcNotify } = twc.attachSocket(server);
    app.set('twcNotify', twcNotify);
}

const PORT = 14150;
server.listen(PORT, '0.0.0.0', () => console.log(`Backend běží na http://0.0.0.0:${PORT}`));