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
const { router: protectedShareRoutes } = require('./protectedShare');
const { router: batteryRoutes } = require('./battery');
const http = require('http');
const { router: moneyGameRoutes, attachSocket } = require('./moneygame/moneyGame');

// near the other route requires
const { router: twcIdentityRoutes } = require('./twc/identity');
const { router: twcSocialRoutes } = require('./twc/social');
const { router: twcSettingsRoutes } = require('./twc/settings');
const { attachTwcSocket } = require('./twc/socket');

const app = express();
app.set('trust proxy', 1);  // <-- taky přidej tady

app.use(cors({
    origin: ['https://tomasekvalla.cz', 'https://www.tomasekvalla.cz', 'https://files.tomasekvalla.cz'],
    credentials: true
}));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// alongside the other app.use('/api/...', ...) lines
app.use('/api/twc', twcIdentityRoutes);
app.use('/api/twc', twcSocialRoutes);
app.use('/api/twc/settings', twcSettingsRoutes);

// same pattern as the existing /fonts static mount
app.use('/chat', express.static('/DATA/files_web/chat'));

const server = http.createServer(app);
attachSocket(server);

// after `const server = http.createServer(app);` and after
// `attachSocket(server)` (moneyGame's) — order between the two doesn't
// matter, they're independent Socket.IO servers on different paths
const { notify: twcNotify } = attachTwcSocket(server);
app.set('twcNotify', twcNotify);

const PORT = 14150;
server.listen(PORT, '0.0.0.0', () => console.log(`Backend běží na http://0.0.0.0:${PORT}`));