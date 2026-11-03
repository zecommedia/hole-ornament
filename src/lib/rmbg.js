/**
 * Background removal via the local PowerShell tool  RMBG/Remove-WhiteBg.ps1
 * — a classic WHITE-background remover (edge-estimate → flood-fill from the border
 * → soft alpha → white decontamination), tuned to match Photoroom. This REPLACES
 * the old RMBG-2.0 FastAPI server; there is no server to run.
 *
 * Windows only (the script uses System.Drawing via Windows PowerShell 5.1).
 *
 * Config (env, optional):
 *   RMBG_SCRIPT     path to Remove-WhiteBg.ps1   (default <project>/RMBG/Remove-WhiteBg.ps1)
 *   RMBG_EDGESOFT   edge-softness px             (default 3.5, matches CHAY.bat)
 *   RMBG_SMOOTHSTEP 0|1 alpha ramp style         (default 1)
 *   RMBG_PWSH       powershell executable        (default "powershell")
 *   RMBG_OUTLINE_MM white die-cut outline mm     (default 0.5 — CHAY.bat opt [2]; 0 = off)
 *   RMBG_OUTLINE_COLOR outline colour            (default "White")
 *   RMBG_DPI        mm→px for the outline        (default 300)
 *   RMBG_OUTLINE_QUALITY 1..4 outline smoothness (default 3)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { child } from './logger.js';

const log = child('ai/rmbg');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RMBG_SCRIPT = process.env.RMBG_SCRIPT
    ? path.resolve(process.env.RMBG_SCRIPT)
    : path.join(PROJECT_ROOT, 'RMBG', 'Remove-WhiteBg.ps1');
const EDGE_SOFT = process.env.RMBG_EDGESOFT || '3.5';
const SMOOTHSTEP = process.env.RMBG_SMOOTHSTEP || '1';
const PWSH = process.env.RMBG_PWSH || 'powershell';

// White die-cut outline — matches CHAY.bat option [2] "tach nen + vien trang".
// `?? '0.5'` (not `||`) so an explicit RMBG_OUTLINE_MM=0 disables it.
const OUTLINE_MM = process.env.RMBG_OUTLINE_MM ?? '0.5';
const OUTLINE_COLOR = process.env.RMBG_OUTLINE_COLOR || 'White';
const OUTLINE_DPI = process.env.RMBG_DPI || '300';
const OUTLINE_QUALITY = process.env.RMBG_OUTLINE_QUALITY || '3';
const OUTLINE_ON = Number(OUTLINE_MM) > 0;
const OUTLINE_PX = Math.round((Number(OUTLINE_MM) || 0) / 25.4 * (Number(OUTLINE_DPI) || 300));

/** Parse an outline colour ("White" | "Black" | "#rrggbb") to an {r,g,b} for sharp. */
function parseColor(c) {
    const named = { white: { r: 255, g: 255, b: 255 }, black: { r: 0, g: 0, b: 0 } };
    const k = String(c || 'White').trim().toLowerCase();
    if (named[k]) return named[k];
    const m = /^#?([0-9a-f]{6})$/i.exec(k);
    if (m) { const n = parseInt(m[1], 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
    return named.white;
}

/**
 * Draw a die-cut border of `px` pixels (colour `rgb`) around the opaque region of
 * a transparent PNG. Used for the already-transparent skip path so pre-cleaned art
 * gets the same white outline the PS script draws for white-bg inputs.
 */
async function addWhiteOutline(srcPath, destPath, px, rgb) {
    const pad = Math.ceil(px) + 2;
    const base = await sharp(srcPath).ensureAlpha()
        .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toBuffer();
    const { width: W, height: H } = await sharp(base).metadata();
    // Dilate the alpha by ~px: a Gaussian-blurred hard edge shifts out ≈1.3·sigma,
    // so sigma = px/1.3 then threshold low grows the mask by roughly `px`.
    const sigma = Math.max(0.3, px / 1.3);
    const grown = await sharp(base).extractChannel('alpha').blur(sigma).threshold(24).raw().toBuffer();
    const silhouette = await sharp({ create: { width: W, height: H, channels: 3, background: rgb } })
        .joinChannel(grown, { raw: { width: W, height: H, channels: 1 } })
        .png().toBuffer();
    await sharp(silhouette).composite([{ input: base }]).png().toFile(destPath);
}

export class RmbgError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'RmbgError';
    }
}

/** Ready when the PowerShell remover script is present (there is no server to ping). */
export async function isRmbgReady(_timeoutMs = 1500) {
    try { return fs.existsSync(RMBG_SCRIPT); } catch { return false; }
}

/** True when the image already has REAL transparency (a cut-out, not a tiny speck). */
async function alreadyTransparent(p) {
    try {
        const st = await sharp(p).stats();
        if (st.isOpaque) return false;
        const alpha = st.channels && st.channels[3];
        return alpha ? alpha.mean < 250 : false; // meaningfully transparent overall
    } catch { return false; }
}

/**
 * Remove the (white) background from inputPath → transparent PNG at outputPath.
 * Already-transparent inputs (e.g. Photoroom cut-outs) pass straight through, so
 * this is safe to run on both white-bg photos and pre-cleaned art. Throws RmbgError.
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {number} [timeoutMs=90000]
 * @param {object} [opts] reserved (the old fill_holes flag is no longer used — the
 *                 script keeps genuine interior holes and fills solid regions itself).
 */
export async function removeBackground(inputPath, outputPath, timeoutMs = 90000, _opts = {}) {
    if (!fs.existsSync(inputPath)) throw new RmbgError(`input not found: ${inputPath}`, 'input-missing');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const started = Date.now();

    // Already cut out → nothing to strip; normalize to PNG (+ the same white outline
    // the script would draw, so pre-cleaned art matches white-bg inputs).
    if (await alreadyTransparent(inputPath)) {
        if (OUTLINE_ON && OUTLINE_PX > 0) {
            await addWhiteOutline(inputPath, outputPath, OUTLINE_PX, parseColor(OUTLINE_COLOR));
        } else {
            await sharp(inputPath).png().toFile(outputPath);
        }
        log.info('rmbg skip (already transparent)', { inputPath, outline: OUTLINE_ON, ms: Date.now() - started });
        return { ok: true, outputPath, durationMs: Date.now() - started, skipped: 'transparent' };
    }

    if (!fs.existsSync(RMBG_SCRIPT)) {
        throw new RmbgError(`Remove-WhiteBg.ps1 not found at ${RMBG_SCRIPT}`, 'server-offline');
    }

    // Run into a fresh temp OutDir so the script's "<basename>.png" can't collide
    // with (or overwrite) the input; then move the result to outputPath.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmbg-'));
    const produced = path.join(outDir, `${path.parse(inputPath).name}.png`);
    try {
        const args = [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', RMBG_SCRIPT,
            '-Path', inputPath,
            '-OutDir', outDir,
            '-EdgeSoft', String(EDGE_SOFT),
            '-Smoothstep', String(SMOOTHSTEP),
            '-NoPreview',
        ];
        // White die-cut outline (CHAY.bat opt [2]) — let the script draw it natively.
        if (OUTLINE_ON) {
            args.push(
                '-OutlineMm', String(OUTLINE_MM),
                '-OutlineColor', String(OUTLINE_COLOR),
                '-Dpi', String(OUTLINE_DPI),
                '-OutlineQuality', String(OUTLINE_QUALITY),
            );
        }
        await new Promise((resolve, reject) => {
            execFile(PWSH, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
                if (err) {
                    if (err.killed) return reject(new RmbgError(`timeout after ${timeoutMs}ms`, 'timeout'));
                    const msg = (stderr || err.message || '').toString().replace(/\s+/g, ' ').slice(0, 300);
                    return reject(new RmbgError(`Remove-WhiteBg.ps1 failed: ${msg}`, 'script'));
                }
                resolve();
            });
        });
        if (!fs.existsSync(produced)) throw new RmbgError('Remove-WhiteBg.ps1 produced no output', 'no-output');
        await fs.promises.copyFile(produced, outputPath);
        const durationMs = Date.now() - started;
        log.info('rmbg done', { inputPath, outputPath, ms: durationMs });
        return { ok: true, outputPath, durationMs };
    } finally {
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}
