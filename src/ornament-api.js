/**
 * Dashboard /ornament — hole / die-cut acrylic ornament print-file builder.
 *
 * A standalone flow (sibling to /tools): drop a listing-mockup image, and the
 * pipeline produces the manufacturing print file:
 *
 *   (1) EXTRACT  — v98/cheapkeyai tách design → rename → mirror-text (2 mặt),
 *                  tất cả trên ảnh CHIỀU GỐC                  (lib/v98-extract.js)
 *   (2)+(3) COMPOSE — black CUT silhouette + stroke đen + drilled hole, xếp
 *                  [CUT][FRONT] (1 mặt) / [CUT][BACK][FRONT] (2 mặt), rồi FLIP
 *                  NGANG NGUYÊN FILE IN ở bước cuối           (lib/ornament-compose.js)
 *
 * Endpoints (mounted under /api/ornament by mountOrnamentRoutes):
 *   GET  /api/ornament/health            — v98 quota
 *   POST /api/ornament/upload?slot&ext   — raw image body → { fileId }
 *   POST /api/ornament/run               — JSON: run pipeline on uploaded file(s)
 *   GET  /api/ornament/file/:jobId/:name — download an artifact
 *
 * Storage: data/ornament/_uploads/<fileId>.<ext> (staged uploads) and
 *          data/ornament/<jobId>/<stage>.png (pipeline artifacts). Both swept
 *          on a 24h TTL (lazy GC), same as the /tools job store.
 *
 * Auth: the parent `app.use('/api', authMiddleware)` gates these too.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { child as logChild } from './lib/logger.js';
import { composeOrnamentPrint, cleanCutoutAlpha } from './lib/ornament-compose.js';
import { makeRateLimit } from './lib/rate-limit.js';
import { matchColorsToReference } from './lib/color-match.js';
import { EXTRACT_PROMPT, EXTRACT_PROMPT_TRANSPARENT, TRANSPARENT_BG_SUFFIX, MIRROR_ALL_TEXT_PROMPT, buildRenamePrompt, extractDesign, getV98Quota } from './lib/v98-extract.js';

const log = logChild('dashboard/ornament');

const ORN_DIR = path.resolve(process.env.DATA_DIR || 'data', 'ornament');
const UPLOADS_DIR = path.join(ORN_DIR, '_uploads');
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Async /run: v98 jobs (extract + rename + mirror) can run minutes, past the
// Cloudflare tunnel's ~100s HTTP timeout (524). So /run returns a jobId at once and
// processes in the background; the UI polls /run-status/:jobId. In-memory (lost on
// restart, which is fine — the client just re-runs). Entries GC'd after RUN_JOB_TTL.
const runJobs = new Map(); // jobId → { status:'running'|'done'|'error', at, result? }
const RUN_JOB_TTL_MS = 60 * 60 * 1000;
function gcRunJobs(now) {
    for (const [id, j] of runJobs) if (now - j.at > RUN_JOB_TTL_MS) runJobs.delete(id);
}


function ensureDirs() {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Sweep stale STAGED UPLOADS by each file's own mtime, leaving the _uploads
// directory itself intact. (We must never rmSync the dir as a unit — see gcStale.)
function gcUploads(now) {
    let names; try { names = fs.readdirSync(UPLOADS_DIR); } catch { return; }
    for (const f of names) {
        const fp = path.join(UPLOADS_DIR, f);
        let st; try { st = fs.statSync(fp); } catch { continue; }
        if (now - st.mtimeMs > JOB_TTL_MS) {
            try { fs.rmSync(fp, { force: true }); } catch { /* ignore */ }
        }
    }
}

let _lastGcMs = 0;
function gcStale() {
    if (Date.now() - _lastGcMs < 60_000) return;
    _lastGcMs = Date.now();
    try {
        ensureDirs();
        const now = Date.now();
        for (const name of fs.readdirSync(ORN_DIR)) {
            // NEVER delete the long-lived _uploads staging dir as a unit. Sweeping
            // it by its own mtime (like a job dir) wipes ALL staged uploads after a
            // 24h idle gap — and because ensureDirs()/mkdirSync is a no-op that does
            // not refresh mtime, the very next /upload writes into the now-missing
            // dir and dies with `ENOENT … _uploads\<id>.jpg`. Sweep its FILES by age
            // instead, keeping the directory itself in place.
            if (name === '_uploads') { gcUploads(now); continue; }
            const p = path.join(ORN_DIR, name);
            let st; try { st = fs.statSync(p); } catch { continue; }
            if (now - st.mtimeMs > JOB_TTL_MS) {
                try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
            }
        }
    } catch (err) { log.warn('gc failed', { err: err.message }); }
}

function sanitizeExt(raw) {
    if (typeof raw !== 'string') return 'png';
    const m = raw.toLowerCase().match(/^(?:\.)?(png|jpg|jpeg|webp)$/);
    return m ? (m[1] === 'jpeg' ? 'jpg' : m[1]) : 'png';
}

function newId() { return crypto.randomBytes(8).toString('hex'); }

/** Stream the raw POST body to disk, capped at MAX_UPLOAD_BYTES. */
function streamBodyToFile(req, destPath) {
    return new Promise((resolve, reject) => {
        let total = 0;
        let aborted = false;
        const ws = fs.createWriteStream(destPath);
        // A WriteStream with no 'error' listener throws uncaught on disk errors
        // (ENOSPC/EROFS/EMFILE/EPERM) and crashes the process — guard it.
        ws.on('error', (err) => {
            if (aborted) return;
            aborted = true;
            try { fs.rmSync(destPath, { force: true }); } catch { /* ignore */ }
            reject(err);
        });
        req.on('data', (chunk) => {
            if (aborted) return;
            total += chunk.length;
            if (total > MAX_UPLOAD_BYTES) {
                aborted = true;
                ws.destroy();
                try { fs.rmSync(destPath, { force: true }); } catch { /* ignore */ }
                reject(Object.assign(new Error('upload too large'), { code: 'too-large' }));
                return;
            }
            ws.write(chunk);
        });
        req.on('end', () => { if (!aborted) ws.end(() => resolve({ bytes: total })); });
        req.on('error', (err) => {
            aborted = true;
            ws.destroy();
            try { fs.rmSync(destPath, { force: true }); } catch { /* ignore */ }
            reject(err);
        });
    });
}

function fileSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }
function jobFileUrl(jobId, name) { return `/api/ornament/file/${jobId}/${encodeURIComponent(name)}`; }

// Model whitelist (a tunnel visitor can't request an arbitrary/pricier model).
// gpt-image-2 là chính, gpt-image-2-c là kênh DỰ PHÒNG (cùng model, khác channel
// phía cheapkeyai). 2 model Gemini đã bỏ — không còn RMBG nên nền trắng vô dụng.
const V98_MODELS = ['gpt-image-2', 'gpt-image-2-c'];
const V98_MODEL_DEFAULT = 'gpt-image-2';
// Upscale disabled: gemini-native returns native 2K, so keep it as-is (no interpolation).
// Set V98_UPSCALE_LONG_EDGE>0 to force a Lanczos floor if ever needed.
const V98_UPSCALE_LONG_EDGE = Number(process.env.V98_UPSCALE_LONG_EDGE) || 0;

/**
 * Run one image-gen step through the DIRECT v98store API: call extractDesign with
 * the operator's per-request key + chosen model, writing the result into jobDir as
 * outName. Returns the written path. Throws V98Error on failure/timeout. The key is
 * required per-request (no .env fallback) so a public/tunnel deploy never spends
 * the server's key. `upscale` lifts the output to ~4K — pass false for intermediate
 * steps (e.g. rename) that get re-uploaded (capped) anyway.
 */
async function v98Gen(prompt, inputPath, jobDir, outName, apiKey, model, upscale = true) {
    const dest = path.join(jobDir, outName);
    // 240s/call: cheapkeyai lúc chậm hay vượt 120s mặc định → job chết vặt vì timeout.
    await extractDesign(inputPath, dest, { prompt, apiKey, model, timeoutMs: 240_000, upscaleLongEdge: upscale ? V98_UPSCALE_LONG_EDGE : 0 });
    // Nắn màu về khớp ảnh NGUỒN của bước này — gpt-image-2 hay ám vàng + đẩy bão
    // hoà khi regen (extract ← mockup; rename/mirror ← design bước trước).
    // Tắt bằng ORNAMENT_COLOR_MATCH=0. Lỗi nắn màu không được giết job.
    if (process.env.ORNAMENT_COLOR_MATCH !== '0') {
        await matchColorsToReference(dest, inputPath).catch((e) => log.warn('color-match bỏ qua', { outName, err: e.message }));
    }
    return dest;
}

/**
 * v98Gen + transparency guard for gpt-image-2: the model occasionally BAKES a
 * fake grey-and-white checkerboard into opaque pixels instead of returning a
 * real alpha channel. Every gpt-image-2 stage needs true transparency (RMBG is
 * skipped), so verify hasAlpha and re-run the generation once before failing.
 */
async function v98GenAlpha(prompt, inputPath, jobDir, outName, apiKey, model, upscale = true) {
    let dest = await v98Gen(prompt, inputPath, jobDir, outName, apiKey, model, upscale);
    let meta = await sharp(dest).metadata().catch(() => ({}));
    if (meta.hasAlpha) return dest;
    log.warn('gpt-image-2 trả ảnh ĐỤC (checkerboard giả?) — chạy lại 1 lần', { outName });
    dest = await v98Gen(prompt, inputPath, jobDir, outName, apiKey, model, upscale);
    meta = await sharp(dest).metadata().catch(() => ({}));
    if (!meta.hasAlpha) {
        throw Object.assign(new Error('gpt-image-2 không trả nền trong suốt (vẽ checkerboard giả) sau 2 lần thử — chạy lại job'), { code: 'no-alpha' });
    }
    return dest;
}

/**
 * Model mirror-text đôi lúc lật NGUYÊN artwork thay vì chỉ lật chữ (xác suất —
 * prompt cấm rồi vẫn dính). Phát hiện bằng cách so bản gen với front gốc và
 * front đã flop (trim → grayscale 64×64): gần bản flop hơn ⇒ artwork bị lật
 * → caller chạy lại. Vùng chữ khác nhau ở cả 2 phép so nên không nhiễu kết quả.
 */
async function backLooksMirrored(backPath, frontPath) {
    const norm = async (p, doFlop) => {
        let buf;
        try { buf = await sharp(p).trim({ threshold: 6 }).toBuffer(); } catch { buf = await sharp(p).png().toBuffer(); }
        let img = sharp(buf);
        if (doFlop) img = img.flop();
        return img.flatten({ background: { r: 255, g: 255, b: 255 } }).grayscale().resize(64, 64, { fit: 'fill' }).raw().toBuffer();
    };
    const [b, f, ff] = await Promise.all([norm(backPath, false), norm(frontPath, false), norm(frontPath, true)]);
    let dSame = 0; let dFlip = 0;
    for (let i = 0; i < b.length; i++) { dSame += (b[i] - f[i]) * (b[i] - f[i]); dFlip += (b[i] - ff[i]) * (b[i] - ff[i]); }
    return dFlip < dSame;
}

/**
 * Chỉnh màu THỦ CÔNG từ slider của operator (sat/bright/contrast theo %, temp ±).
 * Luôn áp từ BẢN GỐC (front/back-cutout.png) → kéo đi kéo lại không cộng dồn.
 * Alpha giữ nguyên nên silhouette CUT không đổi. Trung tính → dùng thẳng bản gốc.
 */
function isNeutralColor(c) {
    return !c
        || (Math.round(Number(c.sat) || 100) === 100
            && Math.round(Number(c.bright) || 100) === 100
            && Math.round(Number(c.contrast) || 100) === 100
            && Math.round(Number(c.temp) || 0) === 0);
}
async function applyColorAdjust(srcPath, destPath, c) {
    const sat = Math.max(0, Math.min(2, (Number(c.sat) || 100) / 100));
    const bright = Math.max(0.4, Math.min(1.6, (Number(c.bright) || 100) / 100));
    const contrast = Math.max(0.4, Math.min(1.6, (Number(c.contrast) || 100) / 100));
    const temp = Math.max(-60, Math.min(60, Number(c.temp) || 0));
    const { data, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = info.width * info.height;
    for (let i = 0; i < px; i++) {
        const o = i * 4;
        if (data[o + 3] === 0) continue;
        let r = data[o]; let g = data[o + 1]; let b = data[o + 2];
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray + (r - gray) * sat; g = gray + (g - gray) * sat; b = gray + (b - gray) * sat;
        r *= bright; g *= bright; b *= bright;
        r = (r - 128) * contrast + 128; g = (g - 128) * contrast + 128; b = (b - 128) * contrast + 128;
        r += temp; b -= temp; // temp dương = ấm hơn (R↑ B↓), âm = lạnh hơn
        data[o] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
        data[o + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
        data[o + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
    }
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(destPath);
    return destPath;
}

/** Resolve a staged upload fileId → absolute path (validates the id + existence). */
function resolveUpload(fileId) {
    if (typeof fileId !== 'string' || !/^[a-f0-9]{8,32}\.(png|jpg|jpeg|webp)$/i.test(fileId)) return null;
    const p = path.join(UPLOADS_DIR, fileId);
    return fs.existsSync(p) ? p : null;
}

// Normalize any image to PNG at destPath (used for the skip paths).
async function copyAsPng(srcPath, destPath) {
    await sharp(srcPath).png().toFile(destPath);
}

/**
 * Finalize one side (front/back): normalize the AI output to PNG, writing stage
 * artifacts into jobDir with the given prefix. KHÔNG flip ở đây — file in được
 * FLIP NGANG NGUYÊN ẢNH ở bước compose cuối, nên mọi artifact trung gian giữ
 * chiều gốc (AI đọc chữ chuẩn, hole-placer thao tác trên design xuôi).
 */
async function processSide(srcPath, jobDir, prefix, opts) {
    const stages = {};
    try {
        const extractedPath = path.join(jobDir, `${prefix}-extracted.png`);
        await copyAsPng(srcPath, extractedPath);
        stages.extract = { url: jobFileUrl(opts.jobId, `${prefix}-extracted.png`) };

        // cutout = extracted đã dọn lớp sương alpha / đốm rời (giữ tên file cũ để
        // /recompose và các đường dẫn downstream không đổi). front-trim.png của
        // hole-placer cắt từ file này nên khung kéo lỗ khớp đúng design thật.
        const cutoutPath = path.join(jobDir, `${prefix}-cutout.png`);
        await sharp(await cleanCutoutAlpha(extractedPath)).png().toFile(cutoutPath);
        return { extracted: extractedPath, cutout: cutoutPath, stages };
    } catch (err) {
        // Surface whatever completed so the /run error response can show partial
        // artifacts and pinpoint the failed step.
        err.partialStages = stages;
        throw err;
    }
}

export function mountOrnamentRoutes(app) {
    ensureDirs();

    // Per-IP fixed-window limits — /run drives a paid v98 call + GPU RMBG + a
    // large sharp composite; /upload writes up to 25 MB to disk. Mirrors the
    // render/submit throttles in server.js so leaked creds can't burn the v98
    // quota, peg the GPU, or fill the disk.
    const runLimit = makeRateLimit({ windowMs: 60_000, max: 5 });
    const uploadLimit = makeRateLimit({ windowMs: 60_000, max: 30 });

    // ---- health ----------------------------------------------------------
    app.get('/api/ornament/health', async (_req, res) => {
        // v98 quota is read-only (never spends) and uses the server .env key just to
        // DISPLAY reachability/quota; actual extraction still needs a per-request key.
        const v98 = await getV98Quota(4000).catch(() => ({ reachable: false }));
        res.json({ ok: true, services: { v98 } });
    });

    // Serve the hanging-tab asset (assets/hole.png) so the hole-placer marker
    // can render the operator's EXACT tab shape instead of a code-drawn ring.
    app.get('/api/ornament/loop-asset', (_req, res) => {
        const p = process.env.LOOP_ASSET ? path.resolve(process.env.LOOP_ASSET) : path.resolve('assets', 'hole.png');
        if (!fs.existsSync(p)) return res.status(404).json({ error: 'no loop asset' });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=300');
        fs.createReadStream(p).on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); }).pipe(res);
    });

    // ---- staged upload ---------------------------------------------------
    app.post('/api/ornament/upload', uploadLimit, async (req, res) => {
        gcStale();
        ensureDirs(); // belt-and-suspenders: guarantee _uploads exists before we write into it
        const ext = sanitizeExt(req.query.ext);
        const fileId = `${newId()}.${ext}`;
        const dest = path.join(UPLOADS_DIR, fileId);
        try {
            const { bytes } = await streamBodyToFile(req, dest);
            if (bytes === 0) return res.status(400).json({ ok: false, error: 'empty upload', code: 'empty-body' });
            let dim = {};
            try { const m = await sharp(dest).metadata(); dim = { width: m.width, height: m.height }; } catch { /* best-effort */ }
            res.json({ ok: true, fileId, bytes, ...dim, url: `/api/ornament/file/_uploads/${encodeURIComponent(fileId)}` });
        } catch (err) {
            const status = err.code === 'too-large' ? 413 : 500;
            res.status(status).json({ ok: false, error: err.message, code: err.code || 'unknown' });
        }
    });

    // ---- run pipeline ----------------------------------------------------
    // Body: { frontFileId, backFileId?, sizeInches?, sides?, model?, prompt?,
    //         manualHole?, holePosX/Y?, holeDiaInch?, cutOffsetInch? }
    app.post('/api/ornament/run', runLimit, async (req, res) => {
        gcStale();
        const b = req.body || {};
        const frontPath = resolveUpload(b.frontFileId);
        if (!frontPath) return res.status(400).json({ ok: false, error: 'frontFileId missing or expired', code: 'no-front' });
        // v98 (cheapkeyai) là đường tách design DUY NHẤT — key bắt buộc theo từng
        // request (không fallback .env). 2 mặt tự mirror từ front, khỏi upload back.
        const v98Key = typeof b.v98Key === 'string' ? b.v98Key.trim() : '';
        const v98Model = V98_MODELS.includes(b.v98Model) ? b.v98Model : V98_MODEL_DEFAULT;
        if (!v98Key) return res.status(400).json({ ok: false, error: 'Cần nhập cheapkeyai API key', code: 'no-v98-key' });
        const wantSides = Number(b.sides) === 2 ? 2 : 1;
        const sizeInches = Number(b.sizeInches) > 0 ? Number(b.sizeInches) : 3;
        const holeModeReq = (b.holeMode === 'inside' || b.holeMode === 'loop' || b.holeMode === 'auto') ? b.holeMode : 'auto';
        // Manual (semi-auto) hole placement: drill a geometric hole at the chosen
        // position/size, adjustable afterwards via /recompose.
        const manualHole = b.manualHole === true;
        // Free placement: allow OUTSIDE the design ([-1.5, 2.5], not just [0,1]).
        const holePosXReq = (b.holePosX != null && Number.isFinite(Number(b.holePosX))) ? Math.max(-1.5, Math.min(2.5, Number(b.holePosX))) : undefined;
        const holePosYReq = (b.holePosY != null && Number.isFinite(Number(b.holePosY))) ? Math.max(-1.5, Math.min(2.5, Number(b.holePosY))) : undefined;
        const holeDiaInchReq = (b.holeDiaInch != null && Number.isFinite(Number(b.holeDiaInch))) ? Number(b.holeDiaInch) : undefined;
        const cutOffsetInchReq = (b.cutOffsetInch != null && Number.isFinite(Number(b.cutOffsetInch))) ? Number(b.cutOffsetInch) : undefined;

        const jobId = newId();
        const jobDir = path.join(ORN_DIR, jobId);
        fs.mkdirSync(jobDir, { recursive: true });
        // KHÔNG còn RMBG trong pipeline: model phải tự trả nền trong suốt.
        // gpt-image-2 / gpt-image-2-c → alpha thật (có guard chống checkerboard).
        const gpt2Transparent = v98Model.startsWith('gpt-image-2');
        // gpt-image-2 must return REAL transparency at every stage → alpha-guarded gen.
        const v98GenFn = gpt2Transparent ? v98GenAlpha : v98Gen;
        const opts = { jobId };

        const resolvedMode = holeModeReq; // 'auto' | 'inside' | 'loop' (geometric)

        const started = Date.now();
        const stages = {};
        const customName = typeof b.customName === 'string' ? b.customName.trim() : '';

        // Respond with the jobId immediately, then keep processing in the background
        // (Express lets the async handler run past res.json). A long v98 job would
        // otherwise blow the Cloudflare ~100s tunnel timeout → 524. UI polls /run-status.
        runJobs.set(jobId, { status: 'running', at: started });
        res.json({ ok: true, jobId, async: true, sides: wantSides });

        try {
            // v98/cheapkeyai là đường duy nhất: EXTRACT trước, rồi rename TRÊN design
            // đã tách (nếu nhập tên). Không tách lỗ — lỗ luôn đặt semi-auto/geometric.
            let frontSrc = frontPath;
            try {
                const extractPrompt = gpt2Transparent ? EXTRACT_PROMPT_TRANSPARENT : EXTRACT_PROMPT;
                frontSrc = await v98GenFn(extractPrompt, frontPath, jobDir, 'front-v98.png', v98Key, v98Model);
                stages.v98Front = { ok: true, model: v98Model, url: jobFileUrl(jobId, 'front-v98.png') };
                if (customName) {
                    // gpt-image-2: keep the rename output transparent too (not just extract).
                    const renamePrompt = buildRenamePrompt(customName) + (gpt2Transparent ? TRANSPARENT_BG_SUFFIX : '');
                    frontSrc = await v98GenFn(renamePrompt, frontSrc, jobDir, 'renamed-v98.png', v98Key, v98Model);
                    stages.v98Rename = { ok: true, name: customName, url: jobFileUrl(jobId, 'renamed-v98.png') };
                }
            } catch (err) { if (!err.failedStageOverride) err.failedStageOverride = 'v98-extract-or-rename'; throw err; }

            let front;
            try {
                front = await processSide(frontSrc, jobDir, 'front', opts);
                stages.front = front.stages;
                // Trimmed-to-content copy of the FRONT cutout for the semi-auto hole
                // placer: the compositor centres the trimmed design, so the placer
                // must show that same tight design (fills the frame; loop scales right).
                try {
                    await sharp(front.cutout).trim({ threshold: 6 }).png().toFile(path.join(jobDir, 'front-trim.png'));
                    stages.front.trimUrl = jobFileUrl(jobId, 'front-trim.png');
                } catch { /* near-empty → UI falls back to the untrimmed cutout */ }
            } catch (err) {
                stages.front = err.partialStages || {};
                if (!err.sideLabel) err.sideLabel = 'front';
                throw err;
            }
            let backCutout = null;
            if (wantSides === 2) {
                try {
                    // 2-sided BACK: mirror-text chạy trên front CHƯA FLIP (chữ còn đọc
                    // xuôi → model đọc ĐÚNG nội dung, không bịa chữ). Không flip ở đâu
                    // trong chuỗi AI — file in flip NGUYÊN ẢNH ở bước compose cuối.
                    // GUARD hướng artwork: model thi thoảng lật nguyên hình thay vì chỉ
                    // lật chữ (con dê quay ngược chiều front) → tự phát hiện + gen lại,
                    // tối đa 3 lượt; vẫn lật cả 3 lượt thì đành dùng và gắn cờ cảnh báo.
                    let backSrc = null; let backArtMirrored = false;
                    for (let bAttempt = 1; bAttempt <= 3; bAttempt++) {
                        backSrc = await v98GenFn(MIRROR_ALL_TEXT_PROMPT + (gpt2Transparent ? TRANSPARENT_BG_SUFFIX : ''), frontSrc, jobDir, 'back-v98.png', v98Key, v98Model);
                        backArtMirrored = await backLooksMirrored(backSrc, frontSrc).catch(() => false);
                        if (!backArtMirrored) break;
                        log.warn('back bị lật NGUYÊN artwork (không chỉ chữ) — gen lại mirror-text', { jobId, attempt: bAttempt });
                    }
                    stages.v98Back = { ok: true, url: jobFileUrl(jobId, 'back-v98.png'), ...(backArtMirrored ? { artworkMirrored: true } : {}) };
                    const back = await processSide(backSrc, jobDir, 'back', opts);
                    stages.back = back.stages;
                    backCutout = back.cutout;
                } catch (err) {
                    stages.back = err.partialStages || {};
                    if (!err.sideLabel) err.sideLabel = 'back';
                    throw err;
                }
            }

            // CUT is always geometric now (no AI cut). The compositor builds the
            // die-cut from FRONT and places the hole (manual coords, or auto).
            const cutCutout = null;

            // (3)+(4) compose
            const printPath = path.join(jobDir, 'print.png');
            const cutPath = path.join(jobDir, 'cut.png');
            const composed = await composeOrnamentPrint({
                frontCutout: front.cutout,
                backCutout,
                cutCutout,
                sizeInches,
                holeMode: manualHole ? (holeModeReq === 'loop' ? 'loop' : 'inside') : resolvedMode,
                holePosX: manualHole ? holePosXReq : undefined,   // undefined → auto-detect
                holePosY: manualHole ? holePosYReq : undefined,
                holeDiaInch: holeDiaInchReq,      // cỡ lỗ chỉnh được ở cả chế độ auto
                cutOffsetInch: cutOffsetInchReq,
                loopOverlap: (b.loopOverlap != null && Number.isFinite(Number(b.loopOverlap))) ? Number(b.loopOverlap) : undefined,
                trimLoop: manualHole ? false : b.trimLoop, // semi-auto keeps the design top intact
                outputPath: printPath,
                cutOutputPath: cutPath,
                previewPath: path.join(jobDir, 'preview.webp'),
            });
            stages.compose = {
                ok: true, durationMs: composed.durationMs, canvas: composed.canvas,
                regions: composed.regions,
                requestedMode: holeModeReq,
                holeMode: composed.holeMode,
                holeBand: composed.holeBand,
                holePosX: composed.holePosX,
                holePosAuto: composed.holePosAuto,
                cutUrl: jobFileUrl(jobId, 'cut.png'),
            };

            runJobs.set(jobId, { status: 'done', at: Date.now(), result: {
                ok: true,
                jobId,
                sides: wantSides,
                sizeInches,
                stages,
                print: { url: jobFileUrl(jobId, 'print.png'), previewUrl: jobFileUrl(jobId, 'preview.webp'), bytes: fileSize(printPath), canvas: composed.canvas },
                durationMs: Date.now() - started,
            } });
        } catch (err) {
            // Identify which stage blew up for an actionable message + partials.
            // err.sideLabel + err.partialStages (set by the per-side wrappers)
            // pinpoint the failing side; absence means the compose step failed.
            const failedStage = err.sideLabel
                ? `${err.sideLabel}-extract`
                : 'compose';
            const code = err.code || 'unknown';
            log.warn('ornament run failed', { jobId, failedStage, code, err: err.message });
            runJobs.set(jobId, { status: 'error', at: Date.now(), httpStatus: 500, result: { ok: false, error: err.message, code, failedStage, stages, jobId } });
        }
    });

    // ---- run status: poll for the async /run result ---------------------
    // { status:'running' } → keep polling; 'done'/'error' → result is ready.
    app.get('/api/ornament/run-status/:jobId', (req, res) => {
        gcRunJobs(Date.now());
        const j = runJobs.get(req.params.jobId);
        if (!j) return res.status(404).json({ ok: false, status: 'unknown', error: 'job không tồn tại hoặc đã hết hạn', code: 'no-job' });
        res.json({ ok: true, status: j.status, result: j.result || null });
    });

    // ---- recompose (semi-auto hole adjust) -------------------------------
    // Cheap re-compose from the ALREADY-EXTRACTED cutouts stored by /run — NO
    // v98, NO RMBG. Rebuilds the geometric die-cut and drills the hole at the
    // operator's chosen position/size. Called repeatedly while the user drags.
    app.post('/api/ornament/recompose', async (req, res) => {
        gcStale();
        const b = req.body || {};
        const jobId = typeof b.jobId === 'string' ? b.jobId : '';
        if (!/^[a-f0-9]{8,32}$/i.test(jobId)) return res.status(400).json({ ok: false, error: 'bad jobId', code: 'bad-job' });
        const jobDir = path.join(ORN_DIR, jobId);
        const frontCutout = path.join(jobDir, 'front-cutout.png');
        if (!fs.existsSync(frontCutout)) return res.status(404).json({ ok: false, error: 'job đã hết hạn — chạy lại từ đầu', code: 'expired' });
        const backCutout = path.join(jobDir, 'back-cutout.png');
        const wantSides = (Number(b.sides) === 2 && fs.existsSync(backCutout)) ? 2 : 1;
        const sizeInches = Number(b.sizeInches) > 0 ? Number(b.sizeInches) : 3;
        // 'auto' cho phép job không-semi-auto chỉnh màu mà giữ nguyên cách đặt lỗ tự động.
        const holeMode = (b.holeMode === 'loop' || b.holeMode === 'inside' || b.holeMode === 'auto') ? b.holeMode : 'inside';
        const holePosX = (b.holePosX != null && Number.isFinite(Number(b.holePosX))) ? Math.max(-1.5, Math.min(2.5, Number(b.holePosX))) : undefined;
        const holePosY = (b.holePosY != null && Number.isFinite(Number(b.holePosY))) ? Math.max(-1.5, Math.min(2.5, Number(b.holePosY))) : undefined;
        const holeDiaInch = (b.holeDiaInch != null && Number.isFinite(Number(b.holeDiaInch))) ? Number(b.holeDiaInch) : undefined;
        const loopOverlap = (b.loopOverlap != null && Number.isFinite(Number(b.loopOverlap))) ? Number(b.loopOverlap) : undefined;
        const cutOffsetInch = (b.cutOffsetInch != null && Number.isFinite(Number(b.cutOffsetInch))) ? Number(b.cutOffsetInch) : undefined;
        try {
            const printPath = path.join(jobDir, 'print.png');
            const cutPath = path.join(jobDir, 'cut.png');
            // Slider chỉnh màu: áp từ BẢN GỐC → file -color rồi compose bằng file đó.
            const colorAdj = (b.color && typeof b.color === 'object') ? b.color : null;
            let frontIn = frontCutout;
            let backIn = wantSides === 2 ? backCutout : null;
            if (colorAdj && !isNeutralColor(colorAdj)) {
                frontIn = await applyColorAdjust(frontCutout, path.join(jobDir, 'front-color.png'), colorAdj);
                if (backIn) backIn = await applyColorAdjust(backCutout, path.join(jobDir, 'back-color.png'), colorAdj);
            }
            const composed = await composeOrnamentPrint({
                frontCutout: frontIn,
                backCutout: backIn,
                cutCutout: null,          // geometric die-cut
                cutSourceCutout: frontCutout, // CUT luôn dựng từ BẢN GỐC (alpha không đổi khi chỉnh màu) → cache stroke ăn
                sizeInches,
                holeMode,                 // 'inside' | 'loop' | 'auto' (giữ auto cho job thường)
                holePosX, holePosY, holeDiaInch, loopOverlap, cutOffsetInch,
                trimLoop: b.trimLoop === true, // job auto giữ đúng lựa chọn trim của /run
                outputPath: printPath,
                cutOutputPath: cutPath,
                previewPath: path.join(jobDir, 'preview.webp'),
            });
            res.json({
                ok: true, jobId, sides: wantSides, sizeInches,
                print: { url: jobFileUrl(jobId, 'print.png'), previewUrl: jobFileUrl(jobId, 'preview.webp'), bytes: fileSize(printPath), canvas: composed.canvas },
                cutUrl: jobFileUrl(jobId, 'cut.png'),
                holePosX: composed.holePosX,
                durationMs: composed.durationMs,
            });
        } catch (err) {
            log.warn('recompose failed', { jobId, err: err.message });
            res.status(500).json({ ok: false, error: err.message, code: 'compose' });
        }
    });

    // ---- file download ---------------------------------------------------
    app.get('/api/ornament/file/:jobId/:name', (req, res) => {
        const { jobId, name } = req.params;
        if (!/^[a-f0-9]{8,32}$|^_uploads$/i.test(jobId)) return res.status(400).json({ error: 'bad jobId' });
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return res.status(400).json({ error: 'bad name' });
        const filePath = path.join(ORN_DIR, jobId, name);
        const root = path.resolve(ORN_DIR);
        if (!path.resolve(filePath).startsWith(root)) return res.status(400).json({ error: 'path escape' });
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found (job may have expired)' });
        const ext = path.extname(name).toLowerCase();
        const ct = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'private, max-age=300');
        const rs = fs.createReadStream(filePath);
        // Guard against a mid-stream read error / GC race deleting the file after
        // the existsSync check — an unhandled ReadStream 'error' crashes the process.
        rs.on('error', (err) => {
            log.warn('ornament file read error', { filePath, err: err.message });
            if (!res.headersSent) res.status(500).json({ error: 'read error' });
            else res.destroy();
        });
        rs.pipe(res);
    });
}
