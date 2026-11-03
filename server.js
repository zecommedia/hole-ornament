/**
 * Hole-Ornament print builder — standalone server.
 *
 * Serves the React UI (ui/dist) and mounts the /api/ornament/* routes. Drop a
 * marketplace listing-mockup → extract design+acrylic (v98 nano-banana) → RMBG
 * → build CUT silhouette + drilled hole → compose the print file.
 *
 *   npm start            # http://localhost:4500
 *
 * Env (.env): V98_API_KEY, V98_BASE_URL, V98_IMAGE_MODEL, RMBG_URL, PORT,
 *             DATA_DIR, AUTH_TOKEN (optional).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { mountOrnamentRoutes } from './src/ornament-api.js';
import { mountBridgeRoutes } from './src/bridge-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4500);
const UI_DIST = path.join(__dirname, 'ui', 'dist');

const app = express();

// JSON parser. NOTE: express.json() only consumes bodies with a JSON
// content-type, so the raw image-binary uploads (Content-Type: image/*) used by
// /api/ornament/upload pass straight through to the route's stream reader.
app.use(express.json({ limit: '4mb' }));

// Permissive CORS — this is a local tool; the Vite dev server runs on :5173.
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token, X-Bridge-Token');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

// Optional shared-token auth (set AUTH_TOKEN to require X-Auth-Token on /api).
// Left off by default — this is meant to run on a trusted local machine.
const AUTH_TOKEN = process.env.AUTH_TOKEN;
if (AUTH_TOKEN) {
    app.use('/api', (req, res, next) => {
        if (req.path === '/ornament/health') return next(); // health is unauthenticated
        if (req.headers['x-auth-token'] === AUTH_TOKEN) return next();
        res.status(401).json({ error: 'unauthorized' });
    });
}

mountOrnamentRoutes(app);
mountBridgeRoutes(app);

// Static UI + SPA fallback (everything except /api/* serves index.html).
if (fs.existsSync(UI_DIST)) {
    app.use(express.static(UI_DIST));
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/')) return next();
        res.sendFile(path.join(UI_DIST, 'index.html'));
    });
} else {
    app.get('/', (_req, res) => res.type('text').send(
        'UI not built yet. Run `npm run build` (or `npm run dev` for the Vite dev server).\nAPI is live at /api/ornament/health',
    ));
}

app.use((err, _req, res, _next) => {
    console.error('unhandled', err.message);
    res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
    console.log(`hole-ornament running on http://localhost:${PORT}`);
    if (fs.existsSync(UI_DIST)) console.log(`open  http://localhost:${PORT}/  (UI)`);
    else console.log('UI not built — run `npm run build`, or `npm run dev` for hot-reload on :5173');
});
