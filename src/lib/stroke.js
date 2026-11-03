/**
 * Photoshop "Stroke" layer-style clone (sharp + exact Euclidean distance field).
 *
 * Draws a uniform outline around the OPAQUE content of a transparent PNG, the
 * same way Photoshop's Layer Style → Stroke does:
 *   - size      px — stroke width
 *   - position  'outside' | 'inside' | 'center' (relative to the alpha edge)
 *   - color     '#rrggbb'
 *   - opacity   0..1
 * Edges are anti-aliased from the true distance field (round, even corners —
 * NOT the lumpy blur+threshold approximation).
 *
 * The print files are vertical stacks of square cells ([CUT][FRONT]([BACK])),
 * so strokePrintPanel() can target ONE cell (default: the TOP design) and
 * leave every other panel byte-for-byte untouched.
 */
import sharp from 'sharp';
import { child } from './logger.js';

const log = child('render/stroke');

/**
 * Exact 2D Euclidean distance transform (Felzenszwalb & Huttenlocher).
 * `src[i] = 1` marks a source pixel (distance 0); returns Float32Array of
 * distances in px for every pixel. O(n), ~1-2s for a 3600² panel.
 */
function edt(src, W, H) {
    const INF = 1e20;
    const n = Math.max(W, H);
    const f = new Float32Array(n);
    const d = new Float32Array(n);
    const v = new Int32Array(n);
    const z = new Float32Array(n + 1);
    const dt1d = (len) => {
        let k = 0;
        v[0] = 0; z[0] = -INF; z[1] = INF;
        for (let q = 1; q < len; q++) {
            let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            while (s <= z[k]) {
                k--;
                s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            }
            k++; v[k] = q; z[k] = s; z[k + 1] = INF;
        }
        k = 0;
        for (let q = 0; q < len; q++) {
            while (z[k + 1] < q) k++;
            d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
        }
    };
    const g = new Float32Array(W * H);
    for (let x = 0; x < W; x++) {              // pass 1: columns (squared 1D)
        for (let y = 0; y < H; y++) f[y] = src[y * W + x] ? 0 : INF;
        dt1d(H);
        for (let y = 0; y < H; y++) g[y * W + x] = d[y];
    }
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {              // pass 2: rows
        for (let x = 0; x < W; x++) f[x] = g[y * W + x];
        dt1d(W);
        for (let x = 0; x < W; x++) out[y * W + x] = Math.sqrt(d[x]);
    }
    return out;
}

function parseColor(c) {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(c || '').trim());
    if (!m) return { r: 255, g: 255, b: 255 };
    let h = m[1];
    if (h.length === 3) h = h.replace(/./g, (ch) => ch + ch);
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Apply the stroke to ONE transparent RGBA image buffer. Returns a PNG Buffer
 * of the same dimensions (the stroke clips at the canvas edge, like Photoshop).
 *
 * @param {Buffer|string} input PNG buffer or path
 * @param {object} opts { size=12, position='outside', color='#ffffff', opacity=1, alphaCutoff=128 }
 */
export async function photoshopStroke(input, opts = {}) {
    const size = Math.max(0.5, Number(opts.size) || 12);
    const position = ['outside', 'inside', 'center'].includes(opts.position) ? opts.position : 'outside';
    const color = parseColor(opts.color ?? '#ffffff');
    const opacity = clamp01(opts.opacity == null ? 1 : Number(opts.opacity));
    const alphaCutoff = Number(opts.alphaCutoff) || 128;

    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width; const H = info.height; const N = W * H;

    // Binary shape mask from alpha.
    const shape = new Uint8Array(N);
    let any = 0;
    for (let i = 0; i < N; i++) { const s = data[i * 4 + 3] >= alphaCutoff ? 1 : 0; shape[i] = s; any |= s; }
    if (!any) return sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer(); // blank → no-op

    // Distance fields: dOut = distance of a background px to the shape;
    // dIn = distance of a shape px to the background. Each computed only if needed.
    const wantOut = position === 'outside' || position === 'center';
    const wantIn = position === 'inside' || position === 'center';
    const dOut = wantOut ? edt(shape, W, H) : null;
    let dIn = null;
    if (wantIn) {
        const inv = new Uint8Array(N);
        for (let i = 0; i < N; i++) inv[i] = shape[i] ? 0 : 1;
        dIn = edt(inv, W, H);
    }
    const wOut = position === 'outside' ? size : position === 'center' ? size / 2 : 0;
    const wIn = position === 'inside' ? size : position === 'center' ? size / 2 : 0;

    // opts.outerOnly: only stroke the region CONNECTED to the canvas border —
    // enclosed openings (drilled hanging holes, sealed gaps) stay untouched.
    // Without this, a stroke wider than a hole's radius would fill the hole
    // solid (Photoshop's stroke does exactly that) and erase the drill mark.
    let reach = null;
    if (wOut > 0 && opts.outerOnly) {
        reach = new Uint8Array(N);
        const st = [];
        const seed = (i) => { if (!reach[i] && !shape[i]) { reach[i] = 1; st.push(i); } };
        for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
        for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
        while (st.length) {
            const i = st.pop(); const x = i % W; const y = (i / W) | 0;
            if (x > 0) seed(i - 1);
            if (x < W - 1) seed(i + 1);
            if (y > 0) seed(i - W);
            if (y < H - 1) seed(i + W);
        }
    }

    // Composite per pixel (premultiplied "over" math), Photoshop layering:
    //   outside part sits UNDER the design; inside part paints OVER the design,
    //   clipped to the design's own alpha.
    const out = Buffer.alloc(N * 4);
    for (let i = 0; i < N; i++) {
        let aD = data[i * 4 + 3] / 255;
        let r = data[i * 4] * aD;
        let g = data[i * 4 + 1] * aD;
        let b = data[i * 4 + 2] * aD;

        if (wIn > 0 && shape[i]) {
            // stroke OVER design, clipped inside: coverage fades at wIn from the edge
            const cov = clamp01(wIn + 0.5 - dIn[i]) * opacity * aD;
            if (cov > 0) {
                r = color.r * cov + r * (1 - cov);
                g = color.g * cov + g * (1 - cov);
                b = color.b * cov + b * (1 - cov);
            }
        }
        if (wOut > 0 && !shape[i] && (!reach || reach[i])) {
            // stroke UNDER design (design over stroke) on the outside band
            const cov = clamp01(wOut + 0.5 - dOut[i]) * opacity;
            if (cov > 0) {
                r += color.r * cov * (1 - aD);
                g += color.g * cov * (1 - aD);
                b += color.b * cov * (1 - aD);
                aD = aD + cov * (1 - aD);
            }
        }
        const a255 = Math.round(aD * 255);
        out[i * 4 + 3] = a255;
        if (a255 > 0) {
            out[i * 4] = Math.min(255, Math.round(r / aD));
            out[i * 4 + 1] = Math.min(255, Math.round(g / aD));
            out[i * 4 + 2] = Math.min(255, Math.round(b / aD));
        }
    }
    // opts.hard: crush the anti-aliased fringe to a crisp 0/255 alpha (die-cut
    // style — "không nhìn xuyên thấu"), like the compositor's hardenAlpha.
    if (opts.hard) {
        for (let i = 0; i < N; i++) out[i * 4 + 3] = out[i * 4 + 3] >= 128 ? 255 : 0;
    }
    return sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

/**
 * Stroke ONE cell of a stacked print file (vertical strip of square cells) and
 * write the result. Every other panel is copied through untouched; DPI metadata
 * is preserved. `panel` = 0-based cell index from the top (default 0 = the top
 * design), or 'all' for every cell.
 *
 * @returns { ok, panels, strokedPanel, width, height }
 */
export async function strokePrintPanel(inputPath, outputPath, opts = {}) {
    const meta = await sharp(inputPath).metadata();
    const W = meta.width; const H = meta.height;
    const cells = W > 0 && H % W === 0 ? H / W : 1; // not a clean stack → treat as 1 panel
    const panel = opts.panel === 'all' ? 'all' : Math.min(cells - 1, Math.max(0, Number(opts.panel) || 0));
    const started = Date.now();

    // Work on the full-image RAW buffer and overwrite only the stroked cell's
    // rows — untouched panels stay BYTE-identical (a recomposite would nudge
    // their anti-aliased edge pixels via premultiply rounding).
    const { data: full } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let c = 0; c < cells; c++) {
        if (panel !== 'all' && panel !== c) continue;
        const top = c * W;
        const cellH = c === cells - 1 ? H - top : W;
        const cellBuf = await sharp(inputPath).extract({ left: 0, top, width: W, height: cellH }).png().toBuffer();
        const stroked = await photoshopStroke(cellBuf, opts);
        const { data: cellRaw } = await sharp(stroked).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        cellRaw.copy(full, top * W * 4);
    }
    await sharp(full, { raw: { width: W, height: H, channels: 4 } })
        .withMetadata({ density: meta.density || 300 })
        .png({ compressionLevel: 6 })
        .toFile(outputPath);
    log.info('stroke applied', { inputPath, outputPath, cells, panel, size: opts.size, position: opts.position, ms: Date.now() - started });
    return { ok: true, panels: cells, strokedPanel: panel, width: W, height: H };
}
