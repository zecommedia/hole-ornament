/**
 * Gemini-Ultra bridge — hands image-edit jobs to a browser EXTENSION that drives
 * gemini.google.com, via a tiny HTTP job queue (no WebSocket, no page injection).
 *
 * Flow:
 *   UI  ──POST /api/bridge/submit {prompt, imageUrl}──▶  backend (queues job)
 *   EXT ──GET  /api/bridge/next──────────────────────▶  backend (claims 1 job)
 *   EXT  fetches imageUrl, runs Gemini Ultra, then:
 *   EXT ──POST /api/bridge/result/:id  (raw PNG body)─▶  backend (status=done)
 *        (or POST /api/bridge/fail/:id {error} on failure)
 *   UI  ──GET  /api/bridge/status/:id (poll)──────────▶  backend → {status, resultUrl}
 *   UI   shows /api/bridge/file/:id
 *
 * The extension only needs `fetch()` + host permission for this origin (localhost
 * or the tunnel). Extension→backend calls carry `x-bridge-token: <BRIDGE_TOKEN>`
 * when that env is set (optional shared secret). The RESULT must be POSTed as RAW
 * image bytes (Content-Type image/png or application/octet-stream) — NOT base64
 * JSON — so it bypasses the 4 MB express.json limit.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { child as logChild } from './lib/logger.js';

const log = logChild('bridge');

const BRIDGE_DIR = path.resolve(process.env.DATA_DIR || 'data', 'bridge');
const DONE_TTL_MS = 30 * 60 * 1000;        // keep finished jobs (+result files) 30 min
const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;    // claimed but no result in 5 min → error (extension stalled)
const MAX_RESULT_BYTES = 30 * 1024 * 1024;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || ''; // optional shared secret for the extension

/** jobId → { id, prompt, imageUrl, status, createdAt, claimedAt, finishedAt, resultPath, error } */
const jobs = new Map();
const waiters = new Map(); // jobId → { resolve, reject, timer } for backend-initiated jobs
let _lastPollMs = 0; // last time the extension polled /next (liveness signal)

function ensureDir() { fs.mkdirSync(BRIDGE_DIR, { recursive: true }); }
function newId() { return crypto.randomBytes(8).toString('hex'); }

// Resolve/reject a backend-initiated job's promise (no-op for UI-submitted jobs).
function settleWaiter(id, ok, valueOrErr) {
    const w = waiters.get(id);
    if (!w) return;
    waiters.delete(id);
    clearTimeout(w.timer);
    if (ok) w.resolve(valueOrErr);
    else w.reject(valueOrErr instanceof Error ? valueOrErr : new Error(String(valueOrErr)));
}

/**
 * Backend-initiated bridge job: enqueue { prompt, imageUrl } for the extension and
 * resolve with the RESULT FILE PATH once it posts back (reject on fail/timeout).
 * Lets the ornament pipeline run image-gen steps (extract, mirror) through Gemini
 * Ultra instead of v98. imageUrl is a path the extension can fetch (relative to the
 * app origin, e.g. /api/ornament/file/_uploads/<id>.png).
 */
export function bridgeSubmitAndWait({ prompt, imageUrl }, timeoutMs = 5 * 60 * 1000) {
    ensureDir();
    const id = newId();
    jobs.set(id, { id, prompt: String(prompt || ''), imageUrl: String(imageUrl || ''), status: 'queued', createdAt: Date.now() });
    log.info('bridge job queued (internal)', { id, promptLen: (prompt || '').length });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            waiters.delete(id);
            const j = jobs.get(id);
            if (j && j.status !== 'done') { j.status = 'error'; j.error = 'gemini bridge timeout'; j.finishedAt = Date.now(); }
            reject(new Error('gemini bridge timeout — extension không trả kết quả'));
        }, timeoutMs);
        waiters.set(id, { resolve, reject, timer });
    });
}

function gc() {
    const now = Date.now();
    for (const [id, j] of jobs) {
        if ((j.status === 'done' || j.status === 'error') && now - (j.finishedAt || 0) > DONE_TTL_MS) {
            if (j.resultPath) { try { fs.rmSync(j.resultPath, { force: true }); } catch { /* ignore */ } }
            jobs.delete(id);
        } else if (j.status === 'processing' && j.claimedAt && now - j.claimedAt > CLAIM_TIMEOUT_MS) {
            j.status = 'error'; j.error = 'extension timeout (no result in 5 min)'; j.finishedAt = now;
            log.warn('bridge job timed out', { id });
            settleWaiter(id, false, new Error(j.error));
        }
    }
}

function checkToken(req, res) {
    if (!BRIDGE_TOKEN) return true;
    if (req.headers['x-bridge-token'] === BRIDGE_TOKEN) return true;
    res.status(401).json({ ok: false, error: 'bad or missing x-bridge-token' });
    return false;
}

/** Stream a raw request body to disk, capped at maxBytes. Mirrors the ornament upload guard. */
function streamBodyToFile(req, destPath, maxBytes) {
    return new Promise((resolve, reject) => {
        let total = 0; let aborted = false;
        const ws = fs.createWriteStream(destPath);
        ws.on('error', (err) => { if (aborted) return; aborted = true; try { fs.rmSync(destPath, { force: true }); } catch { /* ignore */ } reject(err); });
        req.on('data', (chunk) => {
            if (aborted) return;
            total += chunk.length;
            if (total > maxBytes) {
                aborted = true; ws.destroy();
                try { fs.rmSync(destPath, { force: true }); } catch { /* ignore */ }
                reject(Object.assign(new Error('result too large'), { code: 'too-large' }));
                return;
            }
            ws.write(chunk);
        });
        req.on('end', () => { if (!aborted) ws.end(() => resolve({ bytes: total })); });
        req.on('error', (err) => { aborted = true; ws.destroy(); try { fs.rmSync(destPath, { force: true }); } catch { /* ignore */ } reject(err); });
    });
}

export function mountBridgeRoutes(app) {
    ensureDir();

    // ── UI: submit a job ──────────────────────────────────────────────────
    app.post('/api/bridge/submit', (req, res) => {
        gc();
        const b = req.body || {};
        const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
        const imageUrl = typeof b.imageUrl === 'string' ? b.imageUrl.trim() : '';
        if (!prompt) return res.status(400).json({ ok: false, error: 'prompt required' });
        if (!imageUrl) return res.status(400).json({ ok: false, error: 'imageUrl required' });
        const id = newId();
        jobs.set(id, { id, prompt, imageUrl, status: 'queued', createdAt: Date.now() });
        log.info('bridge job queued', { id, promptLen: prompt.length });
        res.json({ ok: true, jobId: id });
    });

    // ── Extension: claim the next queued job (FIFO) ───────────────────────
    app.get('/api/bridge/next', (req, res) => {
        if (!checkToken(req, res)) return;
        _lastPollMs = Date.now();
        gc();
        for (const j of jobs.values()) {
            if (j.status === 'queued') {
                j.status = 'processing'; j.claimedAt = Date.now();
                log.info('bridge job claimed', { id: j.id });
                return res.json({ ok: true, job: { id: j.id, prompt: j.prompt, imageUrl: j.imageUrl } });
            }
        }
        res.json({ ok: true, job: null });
    });

    // ── Extension: post the RESULT image (raw binary body) ────────────────
    app.post('/api/bridge/result/:id', async (req, res) => {
        if (!checkToken(req, res)) return;
        const j = jobs.get(req.params.id);
        if (!j) return res.status(404).json({ ok: false, error: 'unknown job (expired?)' });
        const dest = path.join(BRIDGE_DIR, `${j.id}-result.png`);
        try {
            const { bytes } = await streamBodyToFile(req, dest, MAX_RESULT_BYTES);
            if (bytes === 0) return res.status(400).json({ ok: false, error: 'empty result body' });
            j.status = 'done'; j.resultPath = dest; j.finishedAt = Date.now();
            log.info('bridge job done', { id: j.id, bytes });
            settleWaiter(j.id, true, dest); // wake any backend pipeline awaiting this job
            res.json({ ok: true });
        } catch (err) {
            res.status(err.code === 'too-large' ? 413 : 500).json({ ok: false, error: err.message });
        }
    });

    // ── Extension: report failure ─────────────────────────────────────────
    app.post('/api/bridge/fail/:id', (req, res) => {
        if (!checkToken(req, res)) return;
        const j = jobs.get(req.params.id);
        if (!j) return res.status(404).json({ ok: false, error: 'unknown job (expired?)' });
        j.status = 'error'; j.finishedAt = Date.now();
        j.error = (req.body && typeof req.body.error === 'string' && req.body.error) || 'extension reported failure';
        log.warn('bridge job failed', { id: j.id, error: j.error });
        settleWaiter(j.id, false, new Error(j.error));
        res.json({ ok: true });
    });

    // ── UI: poll job status ───────────────────────────────────────────────
    app.get('/api/bridge/status/:id', (req, res) => {
        const j = jobs.get(req.params.id);
        if (!j) return res.status(404).json({ ok: false, error: 'unknown job (expired?)' });
        res.json({
            ok: true,
            status: j.status, // queued | processing | done | error
            error: j.error || null,
            resultUrl: j.status === 'done' ? `/api/bridge/file/${j.id}` : null,
        });
    });

    // ── UI: fetch the result image ────────────────────────────────────────
    app.get('/api/bridge/file/:id', (req, res) => {
        const j = jobs.get(req.params.id);
        if (!j || !j.resultPath || !fs.existsSync(j.resultPath)) return res.status(404).json({ ok: false, error: 'no result' });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=300');
        const rs = fs.createReadStream(j.resultPath);
        rs.on('error', () => { if (!res.headersSent) res.status(500).json({ ok: false, error: 'read error' }); else res.destroy(); });
        rs.pipe(res);
    });

    // ── Liveness: is the extension polling? + queue snapshot ──────────────
    app.get('/api/bridge/health', (_req, res) => {
        gc();
        let queued = 0; let processing = 0;
        for (const j of jobs.values()) { if (j.status === 'queued') queued++; else if (j.status === 'processing') processing++; }
        res.json({
            ok: true,
            extensionOnline: _lastPollMs > 0 && (Date.now() - _lastPollMs) < 10_000,
            lastPollMsAgo: _lastPollMs ? Date.now() - _lastPollMs : null,
            queued, processing,
            tokenRequired: Boolean(BRIDGE_TOKEN),
        });
    });
}
