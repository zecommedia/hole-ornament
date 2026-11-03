/**
 * Hole-ornament print compositor — pure sharp, no Photoshop.
 *
 * Builds the manufacturing print file for a die-cut acrylic ornament from a
 * transparent design cutout (the post-RMBG output of the v98 extraction).
 *
 * Output layout = square cells (a print bed) stacked top→bottom:
 *   1-sided: [ CUT ][ FRONT ]            → bed × 2 tall
 *   2-sided: [ CUT ][ FRONT ][ BACK ]    → bed × 3 tall
 *
 *   CUT   — solid-black die-cut silhouette of the acrylic shape, with a small
 *           hanging tab + drilled hole re-added at top-center (the listing photo
 *           had its own hole/ribbon, which the extraction prompt strips; the
 *           factory needs a clean, precisely-placed hole instead).
 *   FRONT — the full-colour design cutout (and BACK for 2-sided).
 *
 * Geometry is the source of truth from `ORNAMENT.psd` (900×1800 @300 DPI,
 * smart objects FRONT + CUTt, TEMP-HOLE guide Ø0.12–0.2″, 0.12–0.2″ from edge)
 * cross-checked against the golden output files in hole_ornament/:
 *   - bed cell  = 3600×3600 px = 12″ @ 300 DPI (both golden files are 3600 wide)
 *   - design    = scaled so its longest side = size_inches × 300 px, centered
 *                 (2x2 FRONT 620×600 ≈ 2.0″; 3x3 FRONT 881×900 ≈ 3.0″ — exact 300 DPI)
 *   - CUT shape ≈ design + small border, ~0.4″ taller from the tab, centered
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { child } from './logger.js';
import { photoshopStroke } from './stroke.js';

const log = child('render/ornament-compose');

/**
 * Default ornament geometry. All *Inch values are physical and scaled by DPI.
 * Tunable knobs (tab/hole/dilate) were calibrated against the golden samples;
 * see the per-stage test harness in hole_ornament/_test/.
 */
export const ORNAMENT_GEOMETRY = {
    dpi: 300,
    bedPx: 3600,           // square print-bed cell (12" @ 300 DPI)
    cut: {
        color: { r: 0, g: 0, b: 0 }, // solid black silhouette (matches golden CUT)
        // Binarize the cutout alpha. LOW (40) so faint thin design parts (e.g. threads
        // RMBG left semi-transparent) stay in the die-cut instead of being dropped —
        // the 14px dilation absorbs the extra edge fringe. Tune via ORNAMENT_CUT_ALPHA_CUTOFF.
        alphaCutoff: Number(process.env.ORNAMENT_CUT_ALPHA_CUTOFF) || 40,
        dilatePx: 14,                // grow the die-cut ~0.045" beyond the print (golden border ≈4.5%)
        // Viền cắt (stroke đen ngoài design) tính bằng INCH trên file in. Khách
        // feedback viền cũ (~0.1") quá rộng → mặc định 0.04" (~1mm), chỉnh qua UI
        // (opts.cutOffsetInch) hoặc ORNAMENT_CUT_OFFSET_INCH.
        offsetInch: process.env.ORNAMENT_CUT_OFFSET_INCH != null ? Number(process.env.ORNAMENT_CUT_OFFSET_INCH) : 0.04,
        holeMode: 'auto',            // 'auto' = decide per mockup from the top-loop band height;
                                     // 'inside' = drill THROUGH the top of the shape; 'loop' = ring tab above.
        loopBandThreshold: 0.045,    // (auto) top-band height fraction above which the shape is judged to
                                     // carry a hanging loop → loop mode. car/shield ≈0.07–0.10 (loop),
                                     // dog ≈0.02–0.04 (inside). mixer (~0.04–0.05) is borderline — use the
                                     // manual toggle when auto guesses wrong (overridable per env below).
        tab: {
            enabled: true,
            ringThicknessInch: 0.16, // (loop mode) acrylic wall around the hole → loop outer R = holeR + this
            neckInch: 0.1,           // (loop mode) how far the loop dips into the shape to stay connected
            loopOverlapFrac: 0.5,    // (loop mode) fraction of the hole's diameter that dips INTO the shape
                                     // (0 = hole fully above; 0.5 = bottom half overlaps; 0.25 = bottom quarter).
        },
        hole: {
            diaInch: 0.25,           // drilled hole Ø mặc định — khách chê 0.4" quá to; chỉnh 0.1–1.0" qua UI
            insideInsetInch: 0.24,   // (inside mode) hole-centre distance below the shape's top edge
            posX: null,              // horizontal position along the TOP edge (0 = left .. 1 = right).
                                     // null = AUTO-detect per mockup from the shape's top-edge centroid.
        },
    },
};

function inToPx(inch, dpi) { return Math.round(inch * dpi); }

/** Trim a transparent image to its content bbox. Returns { data, info }. */
async function trimToContent(input) {
    try {
        return await sharp(input).trim({ threshold: 6 }).toBuffer({ resolveWithObject: true });
    } catch {
        // Fully empty/edge-uniform image — return as-is.
        const data = await sharp(input).png().toBuffer();
        const info = await sharp(data).metadata();
        return { data, info };
    }
}

/**
 * Turn a transparent design cutout into a clean solid-colour silhouette.
 * The alpha is BINARIZED at `cutoff` first, so antialiasing fringe / faint
 * shadow pixels don't leave drips on the die-cut edge (RGB → fill colour,
 * A → 0 or 255).
 */
async function silhouetteFromAlpha(cutoutBuf, color, cutoff = 96) {
    const { data, info } = await sharp(cutoutBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = info.width * info.height;
    const out = Buffer.alloc(px * 4);
    for (let i = 0; i < px; i++) {
        out[i * 4] = color.r;
        out[i * 4 + 1] = color.g;
        out[i * 4 + 2] = color.b;
        out[i * 4 + 3] = data[i * 4 + 3] >= cutoff ? 255 : 0;
    }
    return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/**
 * Làm sạch alpha của cutout AI trước khi dựng CUT/in. gpt-image-2 hay để lại
 * một lớp "sương" alpha thấp (bóng chữ / nền mockup cũ, alpha 1–30) phủ khắp
 * ảnh, cộng các đốm rời. Không dọn thì: (a) BLACK-CLIP (cutoff 8) ôm cả lớp
 * sương → CUT phình sai hình, (b) trim lấy bbox của sương → design bị thu nhỏ
 * và lệch tâm, (c) bóng mờ in lên mặt acrylic. Cách dọn:
 *   1. alpha < hazeCutoff → 0 (sương).
 *   2. Bỏ mọi mảnh liền (8-connected) nhỏ hơn minFrac × mảnh lớn nhất (đốm rời).
 * Mảnh thật như chữ rời / ngôi sao trang trí đều lớn hơn ngưỡng nên vẫn giữ.
 * Kết quả cache theo path+mtime như SIL_CACHE (recompose gọi lại liên tục).
 */
const CLEAN_HAZE_CUTOFF = Number(process.env.ORNAMENT_HAZE_CUTOFF) || 32;
const CLEAN_MIN_FRAC = 0.004;
const CLEAN_CACHE = new Map();
export async function cleanCutoutAlpha(input, { hazeCutoff = CLEAN_HAZE_CUTOFF, minFrac = CLEAN_MIN_FRAC } = {}) {
    let key = null;
    if (typeof input === 'string') {
        try { const st = fs.statSync(input); key = `${path.resolve(input)}:${st.mtimeMs}:${st.size}:${hazeCutoff}:${minFrac}`; } catch { key = null; }
        if (key && CLEAN_CACHE.has(key)) return CLEAN_CACHE.get(key);
    }
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width; const H = info.height; const N = W * H;
    const label = new Int32Array(N); // 0 = nền / chưa gán
    const sizes = [0];
    const stack = new Int32Array(N);
    for (let i = 0; i < N; i++) if (data[i * 4 + 3] < hazeCutoff) data[i * 4 + 3] = 0;
    for (let s = 0; s < N; s++) {
        if (label[s] || !data[s * 4 + 3]) continue;
        const id = sizes.length; let size = 0; let sp = 0;
        label[s] = id; stack[sp++] = s;
        while (sp) {
            const i = stack[--sp]; size++;
            const x = i % W; const y = (i / W) | 0;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy; if (yy < 0 || yy >= H) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx; if (xx < 0 || xx >= W) continue;
                    const j = yy * W + xx;
                    if (!label[j] && data[j * 4 + 3]) { label[j] = id; stack[sp++] = j; }
                }
            }
        }
        sizes.push(size);
    }
    const largest = Math.max(0, ...sizes);
    const keepMin = Math.max(1, largest * minFrac);
    let dropped = 0;
    for (let i = 0; i < N; i++) {
        const l = label[i];
        if (l && sizes[l] < keepMin) { data[i * 4 + 3] = 0; dropped++; }
    }
    const out = await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
    log.info('cutout alpha cleaned', { components: sizes.length - 1, droppedPx: dropped });
    if (key) {
        CLEAN_CACHE.set(key, out);
        if (CLEAN_CACHE.size > SIL_CACHE_MAX * 2) CLEAN_CACHE.delete(CLEAN_CACHE.keys().next().value);
    }
    return out;
}

/**
 * Black "clipping mask" (inspired by black_clipped.py) — but SOLID/opaque: every
 * pixel that is part of the design (alpha ≥ BLACKCLIP_CUTOFF, low so faint thin
 * parts like threads still count) becomes fully-opaque black (255); everything else
 * is transparent. So the cut keeps the design SHAPE pixel-for-pixel yet is 100%
 * opaque — no see-through. (Copying the exact soft alpha made the cut translucent.)
 */
const BLACKCLIP_CUTOFF = Number(process.env.ORNAMENT_CUT_ALPHA_CUTOFF) || 8;
async function blackClipFromAlpha(cutoutBuf, color) {
    const { data, info } = await sharp(cutoutBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = info.width * info.height;
    const out = Buffer.alloc(px * 4);
    for (let i = 0; i < px; i++) {
        out[i * 4] = color.r;
        out[i * 4 + 1] = color.g;
        out[i * 4 + 2] = color.b;
        out[i * 4 + 3] = data[i * 4 + 3] >= BLACKCLIP_CUTOFF ? 255 : 0; // SOLID, no translucency
    }
    return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}


/**
 * Auto-detect the hanging-hole horizontal position from a transparent cutout:
 * the centroid X of the opaque pixels in the TOP band of the shape (where the
 * loop/hole sat before the extraction prompt cut it off). Returns 0..1 — so the
 * hole follows the actual mockup instead of being fixed at center. Falls back
 * to 0.5 on a blank image.
 */
async function detectHolePosX(cutout, bandFrac = 0.08) {
    const { data, info } = await sharp(cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width; const H = info.height;
    const cutoff = 64;
    let topY = -1;
    for (let y = 0; y < H && topY < 0; y++) {
        for (let x = 0; x < W; x++) { if (data[(y * W + x) * 4 + 3] >= cutoff) { topY = y; break; } }
    }
    if (topY < 0) return 0.5;
    const band = Math.max(1, Math.round(H * bandFrac));
    let sumX = 0; let count = 0;
    for (let y = topY; y < Math.min(H, topY + band); y++) {
        for (let x = 0; x < W; x++) { if (data[(y * W + x) * 4 + 3] >= cutoff) { sumX += x; count++; } }
    }
    if (count === 0) return 0.5;
    return Math.max(0, Math.min(1, (sumX / count) / W));
}

/**
 * Force a CRISP die-cut edge: binarize alpha to 0/255 at `cutoff` and paint every
 * opaque pixel the fill colour. The SVG tab/hole and the final resize introduce a
 * soft anti-aliased fringe, but the cutter needs a hard boundary — this removes it.
 */
async function hardenAlpha(buf, color, cutoff = 128) {
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = info.width * info.height;
    const out = Buffer.alloc(px * 4);
    for (let i = 0; i < px; i++) {
        const opaque = data[i * 4 + 3] >= cutoff;
        out[i * 4] = color.r;
        out[i * 4 + 1] = color.g;
        out[i * 4 + 2] = color.b;
        out[i * 4 + 3] = opaque ? 255 : 0;
    }
    return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/**
 * Remove a residual hanging loop/tab spike at the TOP of an extracted cutout.
 * The v98 prompt asks the model to cut the acrylic off below the loop, but it
 * often leaves a thin loop+hole — which would (a) print a hole in the FRONT art
 * and (b) push our auto hole-position and tab upward. We detect the narrow top
 * band (everything above the first row that reaches `bodyFrac` of the shape's
 * max width) and crop it off, but only when it looks like a loop (tall enough to
 * matter, not so tall it's a legitimately narrow design).
 */
/**
 * Measure the narrow top "loop band": the rows above the first row that reaches
 * `bodyFrac` of the shape's max width. A tall band ⇒ the extracted shape carries
 * a hanging loop/tab at top (car-style); a short band ⇒ just a rounded top
 * (dog/collar). Returns { trimmedData, W, H, bodyTop, frac }.
 */
async function topBand(input, bodyFrac = 0.25) {
    const trimmed = await trimToContent(input);
    const { data, info } = await sharp(trimmed.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width; const H = info.height;
    let maxW = 0;
    const rw = new Array(H).fill(0);
    for (let y = 0; y < H; y++) {
        let c = 0;
        for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3] >= 64) c++;
        rw[y] = c;
        if (c > maxW) maxW = c;
    }
    let bodyTop = 0;
    if (maxW > 0) while (bodyTop < H && rw[bodyTop] < bodyFrac * maxW) bodyTop++;
    return { trimmedData: trimmed.data, W, H, bodyTop, frac: H ? bodyTop / H : 0 };
}

async function trimTopLoop(input, { minBandFracH = 0.05, maxBandFracH = 0.22 } = {}) {
    const b = await topBand(input);
    if (b.frac > minBandFracH && b.frac <= maxBandFracH) {
        return await sharp(b.trimmedData)
            .extract({ left: 0, top: b.bodyTop, width: b.W, height: b.H - b.bodyTop })
            .png().toBuffer();
    }
    return b.trimmedData;
}


/**
 * Turn a hanging-tab ASSET (operator-supplied, e.g. a black washer/ring on white
 * with a hole) into two masks sized sizePx²: `body` = the asset's OUTER filled
 * silhouette in the die-cut fill colour, and `hole` = its enclosed opening as a
 * white dest-out mask. Dark, opaque asset pixels are the material; the enclosed
 * light/transparent region is the hole. Lets the operator use their EXACT tab
 * shape instead of a code-drawn ring. Returns { body, hole } PNG buffers.
 */
async function processLoopAsset(assetPath, sizePx, color, darkCutoff = 130) {
    const S = Math.max(8, Math.round(sizePx));
    const { data, info } = await sharp(assetPath)
        .resize(S, S, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width; const H = info.height; const N = W * H;
    // material = a dark, non-transparent pixel (the black ring).
    const opaque = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
        const a = data[i * 4 + 3];
        const lum = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
        opaque[i] = (a >= 128 && lum < darkCutoff) ? 1 : 0;
    }
    // Flood-fill "outside" from the border across non-material pixels; whatever is
    // un-reached and non-material is the ENCLOSED hole. outerFilled = material ∪ hole.
    const outside = new Uint8Array(N); const stack = [];
    const seed = (i) => { if (!opaque[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
    for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
    while (stack.length) {
        const i = stack.pop(); const x = i % W; const y = (i / W) | 0;
        if (x > 0) seed(i - 1); if (x < W - 1) seed(i + 1); if (y > 0) seed(i - W); if (y < H - 1) seed(i + W);
    }
    const body = Buffer.alloc(N * 4); const hole = Buffer.alloc(N * 4);
    for (let i = 0; i < N; i++) {
        const isBody = opaque[i] || !outside[i];   // material or enclosed hole → filled disc
        const isHole = !opaque[i] && !outside[i];  // enclosed opening only
        body[i * 4] = color.r; body[i * 4 + 1] = color.g; body[i * 4 + 2] = color.b; body[i * 4 + 3] = isBody ? 255 : 0;
        hole[i * 4] = 255; hole[i * 4 + 1] = 255; hole[i * 4 + 2] = 255; hole[i * 4 + 3] = isHole ? 255 : 0;
    }
    const raw = { width: W, height: H, channels: 4 };
    return {
        body: await sharp(body, { raw }).png().toBuffer(),
        hole: await sharp(hole, { raw }).png().toBuffer(),
        size: S,
    };
}

/**
 * Scale NGUYÊN CẢ asset sao cho LỖ bên trong nó = holePx (Ø operator chọn, sàn
 * 0.4") — kéo lỗ to lên là cả PNG to theo, giữ đúng tỉ lệ asset. Probe pass đo
 * tỉ lệ lỗ/canvas của asset trước, rồi scale thật. Trả thêm tâm lỗ (holeCx/Cy)
 * trong buffer đã scale để compositor đặt TÂM LỖ trúng điểm kéo. Asset không có
 * lỗ kín → null (caller rơi về vòng ring vẽ).
 */
async function processLoopAssetScaledToHole(assetPath, holePx, color) {
    const measureHole = async (holeMaskPng) => {
        const { data, info } = await sharp(holeMaskPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let minx = info.width, miny = info.height, maxx = -1, maxy = -1;
        for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
            if (data[(y * info.width + x) * 4 + 3] >= 128) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
        }
        if (maxx < 0) return null;
        return { w: maxx - minx + 1, h: maxy - miny + 1, cx: (minx + maxx + 1) / 2, cy: (miny + maxy + 1) / 2 };
    };
    const PROBE = 256;
    const probe = await processLoopAsset(assetPath, PROBE, color);
    const ph = await measureHole(probe.hole);
    if (!ph) return null;
    let size = Math.max(16, Math.round(PROBE * holePx / Math.max(ph.w, ph.h)));
    let scaled = await processLoopAsset(assetPath, size, color);
    let sh = await measureHole(scaled.hole);
    // Hiệu chỉnh 1 lần: rounding khi resize có thể làm lỗ hụt vài px dưới sàn
    // (0.4" là TỐI THIỂU cứng của xưởng) → scale bù chính xác theo số đo thật.
    if (sh && Math.max(sh.w, sh.h) < holePx) {
        size = Math.ceil(size * holePx / Math.max(sh.w, sh.h)) + 1;
        scaled = await processLoopAsset(assetPath, size, color);
        sh = await measureHole(scaled.hole);
    }
    if (!sh) sh = { cx: scaled.size / 2, cy: scaled.size / 2 };
    return { body: scaled.body, hole: scaled.hole, size: scaled.size, holeCx: sh.cx, holeCy: sh.cy };
}

/**
 * Build the CUT silhouette (black shape + hanging tab + drilled hole) from a
 * transparent design cutout. Returns a tight PNG buffer + its metadata.
 *
 * @param {Buffer|string} cutout transparent design cutout (post-RMBG)
 * @param {object} geom ORNAMENT_GEOMETRY
 */
/**
 * Silhouette ĐÃ STROKE — phần nặng nhất của compose (black-clip + EDT stroke
 * ~1-2s) — cache theo (path + mtime + size + strokePx). Kéo lỗ / chỉnh màu chỉ
 * đổi tab/màu in chứ KHÔNG đổi silhouette → /recompose dùng lại, còn vài trăm ms.
 *
 * Stroke đặt TRƯỚC khi khoan (yêu cầu operator): viền đen kiểu Photoshop nguyên
 * bản — ăn cả khe kín; khe hẹp hơn 2×stroke bị nối liền. Lỗ khoan SAU nên không
 * bao giờ bị viền bịt. Sau stroke, design bbox nằm tại offset strokePad — mọi
 * toạ độ posX/posY (fraction theo design) cộng strokePad khi vẽ.
 * Đổi độ dày qua ORNAMENT_CUT_STROKE_PX (px @300DPI, 0 = tắt).
 */
const SIL_CACHE = new Map(); // key → { trimmedPng, sil, W, H, strokePad }
const SIL_CACHE_MAX = 8;
async function strokedSilhouetteFor(cutout, color, { offsetPx300 = 0, targetPx = 900 } = {}) {
    let key = null;
    if (typeof cutout === 'string') {
        try {
            const st = fs.statSync(cutout);
            key = `${path.resolve(cutout)}:${st.mtimeMs}:${st.size}:${offsetPx300}:${targetPx}`;
        } catch { key = null; }
        if (key && SIL_CACHE.has(key)) return SIL_CACHE.get(key);
    }
    const trimmed = await trimToContent(await cleanCutoutAlpha(cutout));
    const trimmedPng = await sharp(trimmed.data).png().toBuffer();
    // BLACK-CLIP: black filled with the design's EXACT alpha — giữ cả chi tiết mảnh.
    let sil = await blackClipFromAlpha(trimmedPng, color);
    const silTrim = await trimToContent(sil);
    sil = silTrim.data;
    const W = silTrim.info.width;
    const H = silTrim.info.height;
    // Viền cắt tính theo INCH THẬT: offsetPx300 là px @300DPI trên file in, quy
    // ngược về px của ảnh nguồn (design sẽ bị scale cạnh dài → targetPx). Trước
    // đây cố định 50px ảnh nguồn nên dày/mỏng thất thường theo độ phân giải AI.
    const strokePx = offsetPx300 > 0 ? offsetPx300 * Math.max(W, H) / targetPx : 0;
    let strokePad = 0;
    if (strokePx > 0) {
        strokePad = Math.ceil(strokePx) + 2;
        const padded = await sharp(sil)
            .extend({ top: strokePad, bottom: strokePad, left: strokePad, right: strokePad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png().toBuffer();
        sil = await photoshopStroke(padded, { size: strokePx, color: '#000000', position: 'outside', hard: true });
    }
    const entry = { trimmedPng, sil, W, H, strokePad };
    if (key) {
        SIL_CACHE.set(key, entry);
        if (SIL_CACHE.size > SIL_CACHE_MAX) SIL_CACHE.delete(SIL_CACHE.keys().next().value);
    }
    return entry;
}

export async function buildCutSilhouette(cutout, geom = ORNAMENT_GEOMETRY) {
    const { dpi } = geom;
    const c = geom.cut;
    const targetPx = inToPx(geom.sizeInches ?? 3, dpi);
    const { trimmedPng, sil, W, H, strokePad } = await strokedSilhouetteFor(cutout, c.color, {
        offsetPx300: (c.offsetInch ?? 0) * dpi,
        targetPx,
    });
    // Silhouette đang ở px ẢNH NGUỒN; compose scale cạnh dài design → targetPx.
    // Mọi kích thước vật lý (lỗ, vành vòng treo, inset) phải quy về px nguồn,
    // nếu không Ø lỗ trên file in lệch theo độ phân giải ảnh AI.
    const srcPx = (inch) => Math.round(inch * dpi * Math.max(W, H) / targetPx);
    const WS = W + 2 * strokePad; // kích thước buffer sil sau stroke
    const HS = H + 2 * strokePad;

    if (!c.tab?.enabled) {
        return { buf: sil, width: WS, height: HS, shapeOffsetY: strokePad, holePosX: 0.5, design: { cx: strokePad + W / 2, cy: strokePad + H / 2, w: W, h: H } };
    }

    // Where the hole sits horizontally (auto from the mockup, or manual).
    const holeR = Math.max(2, Math.round(srcPx(c.hole.diaInch) / 2));
    const posX = (c.hole?.posX == null)
        ? await detectHolePosX(trimmedPng)
        : Math.max(0, Math.min(1, c.hole.posX));
    const mode = c.holeMode || 'inside';

    // --- INSIDE mode: drill the hole THROUGH the top of the shape, so the hole is
    //     part of the die-cut design (no protruding tab). Most acrylic ornaments.
    if (mode === 'inside') {
        const { data: sdi, info: sii } = await sharp(sil).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        // Toạ độ placer là fraction theo DESIGN bbox → +strokePad để về buffer đã stroke.
        const col = Math.max(0, Math.min(sii.width - 1, Math.round(strokePad + posX * W)));
        let topEdge = sii.height;
        for (let y = 0; y < sii.height; y++) { if (sdi[(y * sii.width + col) * 4 + 3] >= 128) { topEdge = y; break; } }
        if (topEdge === sii.height) topEdge = 0;
        // Vertical: use the AI-detected posY (fraction of shape height) when given,
        // otherwise a fixed inset below the shape's top edge (= mép viền stroke).
        const posY = c.hole?.posY;
        const holeCy = (typeof posY === 'number')
            ? Math.round(Math.max(topEdge + holeR + 4, Math.min(HS - holeR - 4, strokePad + posY * H)))
            : Math.max(topEdge + holeR + 4, topEdge + srcPx(c.hole.insideInsetInch ?? 0.24));
        const holeCx = Math.max(holeR, Math.min(WS - holeR, Math.round(strokePad + posX * W)));
        const holeSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WS}" height="${HS}"><circle cx="${holeCx}" cy="${holeCy}" r="${holeR}" fill="#fff"/></svg>`);
        const drilled = await sharp(sil).composite([{ input: holeSvg, blend: 'dest-out' }]).png().toBuffer();
        return { buf: drilled, width: WS, height: HS, shapeOffsetY: strokePad, holePosX: posX, design: { cx: strokePad + W / 2, cy: strokePad + H / 2, w: W, h: H } };
    }

    // --- LOOP mode: place the hanging ring loop EXACTLY where the operator drags it.
    //     No auto neck/bridge is drawn — the loop simply merges with the design where
    //     it overlaps it; placed outside, it stays a standalone ring (operator's call).
    const ring = srcPx(c.tab.ringThicknessInch ?? 0.16);
    const loopR = holeR + ring;                    // tab outer radius
    const { r, g, b } = c.color;
    const fill = `rgb(${r},${g},${b})`;

    // Vị trí kéo của operator = TÂM LỖ (fraction theo design bbox, UNCLAMPED —
    // có thể nằm hẳn ngoài design). +strokePad: quy về buffer đã stroke.
    const posXFrac = (typeof c.hole?.posX === 'number') ? c.hole.posX : posX;
    const tabCx = strokePad + posXFrac * W;
    let tabCy;
    if (typeof c.hole?.posY === 'number') {
        tabCy = strokePad + c.hole.posY * H;
    } else {
        // Auto: đặt lỗ NGAY TRÊN mép design (không khoét vào art — cũ posY 0.02
        // làm lỗ đè lên cuống/ngọn design). Với mỗi cột trong bề rộng lỗ, tâm lỗ
        // phải cao hơn mép trên ≥ nửa dây cung + khe hở nhỏ; vành vòng treo (dày
        // hơn khe) chắc chắn chồng lên design nên vẫn dính liền.
        const { data: sd, info: si } = await sharp(sil).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const gap = srcPx(0.02);
        let cy = Infinity;
        for (let dx = -holeR; dx <= holeR; dx++) {
            const x = Math.round(tabCx + dx);
            if (x < 0 || x >= si.width) continue;
            let top = -1;
            for (let y = 0; y < si.height; y++) { if (sd[(y * si.width + x) * 4 + 3] >= 128) { top = y; break; } }
            if (top < 0) continue;
            cy = Math.min(cy, top - Math.sqrt(holeR * holeR - dx * dx) - gap);
        }
        tabCy = Number.isFinite(cy) ? cy : strokePad - holeR - gap;
    }

    // Tab từ ASSET (operator tự vẽ): scale NGUYÊN CẢ PNG sao cho LỖ bên trong nó
    // = Ø chọn trên slider (kéo lỗ to → cả tab to theo, giữ đúng tỉ lệ asset),
    // rồi khoan bằng CHÍNH lỗ của asset, đặt TÂM LỖ trúng điểm kéo. Asset không
    // có lỗ kín (hoặc thiếu file) → fallback vòng ring vẽ + khoan tròn holeR.
    const assetPath = c.tab?.assetPath;
    let tabBody = null; let tabHole = null;
    let tabW = loopR * 2; let tabH = loopR * 2;   // kích thước buffer tab
    let holeCxIn = loopR; let holeCyIn = loopR;   // tâm lỗ BÊN TRONG buffer tab
    if (assetPath && fs.existsSync(assetPath)) {
        const a = await processLoopAssetScaledToHole(assetPath, holeR * 2, c.color);
        if (a) {
            tabBody = a.body; tabHole = a.hole;
            tabW = a.size; tabH = a.size;
            holeCxIn = a.holeCx; holeCyIn = a.holeCy;
        }
    }
    if (!tabBody) {
        tabBody = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${loopR * 2}" height="${loopR * 2}"><circle cx="${loopR}" cy="${loopR}" r="${loopR}" fill="${fill}"/></svg>`);
        tabHole = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${loopR * 2}" height="${loopR * 2}"><circle cx="${loopR}" cy="${loopR}" r="${holeR}" fill="#fff"/></svg>`);
    }

    // Grow the canvas so it holds BOTH the (stroked) design and the whole tab
    // (tab đặt sao cho tâm lỗ = điểm kéo).
    const PAD = 4;
    const minX = Math.min(0, Math.floor(tabCx - holeCxIn)) - PAD;
    const minY = Math.min(0, Math.floor(tabCy - holeCyIn)) - PAD;
    const maxX = Math.max(WS, Math.ceil(tabCx - holeCxIn + tabW)) + PAD;
    const maxY = Math.max(HS, Math.ceil(tabCy - holeCyIn + tabH)) + PAD;
    const W2 = maxX - minX; const H2 = maxY - minY;
    const dX = -minX; const dY = -minY;                                   // design offset in canvas
    const cx = Math.round(tabCx + dX); const cy = Math.round(tabCy + dY); // tâm lỗ in canvas
    const tabLeft = Math.round(cx - holeCxIn); const tabTop = Math.round(cy - holeCyIn);

    let merged = await sharp({ create: { width: W2, height: H2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([
            { input: sil, left: dX, top: dY },
            { input: tabBody, left: tabLeft, top: tabTop },
        ])
        .png().toBuffer();
    // Drill the tab's hole — dest-out punches through the tab AND any design under
    // it, so the opening is always a real through-hole.
    merged = await sharp(merged)
        .composite([{ input: tabHole, blend: 'dest-out', left: tabLeft, top: tabTop }])
        .png().toBuffer();

    return { buf: merged, width: W2, height: H2, shapeOffsetY: dY + strokePad, holePosX: posXFrac, design: { cx: dX + strokePad + W / 2, cy: dY + strokePad + H / 2, w: W, h: H } };
}

/**
 * Build a solid-colour CUT silhouette DIRECTLY from a transparent cutout that
 * already contains the hanging hole — the AI-extracted (CUT_HOLE_PROMPT) layer
 * after RMBG with fill_holes=false. This is the "black overlay" step: every
 * opaque pixel → fill colour, every transparent pixel (incl. the die-cut hole)
 * stays transparent. No geometric drill/tab and NO internal-hole fill, so the
 * hole the model produced is preserved exactly. Returns { buf, width, height }.
 */
async function silhouetteFromCutout(cutout, color, cutoff = 96) {
    const trimmed = await trimToContent(cutout);
    let sil = await silhouetteFromAlpha(trimmed.data, color, cutoff);
    sil = await hardenAlpha(sil, color, 128);
    const meta = await sharp(sil).metadata();
    return { buf: sil, width: meta.width, height: meta.height, shapeOffsetY: 0, holePosX: null, design: { cx: meta.width / 2, cy: meta.height / 2, w: meta.width, h: meta.height } };
}

/**
 * Scale a region image so its longest side = targetMaxPx, then center it in a
 * bedPx × bedPx transparent cell. Returns { buf (cell), bbox, center }.
 */
async function placeInCell(regionBuf, targetMaxPx, bedPx) {
    const trimmed = await trimToContent(regionBuf);
    const w = trimmed.info.width;
    const h = trimmed.info.height;
    // Never let a region exceed the bed: sharp silently clips the overflow (e.g.
    // an oversized CUT tab at large sizes) AND the reported centre would drift
    // from where the image actually lands. Clamp so left/top stay >= 0.
    const target = Math.min(targetMaxPx, bedPx);
    const scale = target / Math.max(w, h);
    const sw = Math.max(1, Math.min(bedPx, Math.round(w * scale)));
    const sh = Math.max(1, Math.min(bedPx, Math.round(h * scale)));
    const resized = await sharp(trimmed.data).resize(sw, sh, { fit: 'fill' }).png().toBuffer();
    const left = Math.round((bedPx - sw) / 2);
    const top = Math.round((bedPx - sh) / 2);
    const cell = await sharp({ create: { width: bedPx, height: bedPx, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: resized, left, top }])
        .png().toBuffer();
    return {
        buf: cell,
        bbox: { w: sw, h: sh },
        center: { x: left + sw / 2, y: top + sh / 2 },
    };
}

/**
 * Place the CUT (design + hanging tab) into a bedPx² cell with the DESIGN centred
 * (not the design+tab bbox). The design's longest side is scaled to targetPx; the
 * tab extends off-centre into the surrounding margin — mirroring the on-screen
 * hole-placer, which centres the design and floats the tab in the margin.
 */
async function placeCutDesignCentered(cutBuf, design, targetPx, bedPx) {
    const meta = await sharp(cutBuf).metadata();
    const scale = targetPx / Math.max(design.w, design.h);
    const sw = Math.max(1, Math.round(meta.width * scale));
    const sh = Math.max(1, Math.round(meta.height * scale));
    const resized = await sharp(cutBuf).resize(sw, sh, { fit: 'fill' }).png().toBuffer();
    const dcx = design.cx * scale;
    const dcy = design.cy * scale;
    // Land the DESIGN centre on the cell centre (clamped so the buffer still fits).
    const left = Math.max(0, Math.min(bedPx - sw, Math.round(bedPx / 2 - dcx)));
    const top = Math.max(0, Math.min(bedPx - sh, Math.round(bedPx / 2 - dcy)));
    const cell = await sharp({ create: { width: bedPx, height: bedPx, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: resized, left, top }])
        .png().toBuffer();
    return { buf: cell, bbox: { w: sw, h: sh }, center: { x: left + dcx, y: top + dcy } };
}

/**
 * Compose the full ornament print file.
 *
 * @param {object} opts
 *   frontCutout   path|Buffer — transparent FRONT design cutout (required)
 *   backCutout    path|Buffer — transparent BACK cutout (optional → 2-sided)
 *   cutCutout     path|Buffer — transparent CUT cutout that ALREADY contains the
 *                 hanging hole (AI-extracted via CUT_HOLE_PROMPT, RMBG'd with
 *                 fill_holes=false). When provided, the CUT layer is just a black
 *                 overlay of this (hole preserved) — the geometric drill/loop is
 *                 skipped. When absent, the CUT is built geometrically from FRONT.
 *   sizeInches    number — physical longest side of the design (default 3)
 *   geometry      ORNAMENT_GEOMETRY override (optional)
 *   outputPath    where to write the final print PNG (required)
 *   cutOutputPath where to write the standalone CUT silhouette PNG (optional)
 * @returns { ok, outputPath, sides, sizeInches, bedPx, canvas:[w,h], regions, cutPath, durationMs }
 */
export async function composeOrnamentPrint(opts) {
    // Apply a per-call hole horizontal position (varies per mockup) without
    // mutating the shared default geometry.
    const baseGeom = opts.geometry || ORNAMENT_GEOMETRY;
    // Allow the hole/tab to sit OUTSIDE the design (free placement) — clamp to a
    // generous [-1.5, 2.5] so it can be dragged ~1.5× the design past any edge.
    const overridePosX = (opts.holePosX != null && Number.isFinite(Number(opts.holePosX)))
        ? Math.max(-1.5, Math.min(2.5, Number(opts.holePosX))) : undefined;
    const overrideMode = (opts.holeMode === 'inside' || opts.holeMode === 'loop' || opts.holeMode === 'auto') ? opts.holeMode : undefined;
    const overridePosY = (opts.holePosY != null && Number.isFinite(Number(opts.holePosY))) ? Math.max(-1.5, Math.min(2.5, Number(opts.holePosY))) : undefined;
    const overrideOverlap = (opts.loopOverlap != null && Number.isFinite(Number(opts.loopOverlap))) ? Math.max(0, Math.min(0.5, Number(opts.loopOverlap))) : undefined;
    // Hole diameter (inches) — chỉnh được ở mọi chế độ lỗ (auto lẫn semi-auto).
    // Khoảng 0.1–1.0" (khách cần lỗ nhỏ hơn sàn 0.4" cũ).
    const overrideDiaInch = (opts.holeDiaInch != null && Number.isFinite(Number(opts.holeDiaInch)))
        ? Math.max(0.1, Math.min(1.0, Number(opts.holeDiaInch))) : undefined;
    // Độ rộng viền cắt quanh design (inch), 0 = cắt sát mép design.
    const overrideOffset = (opts.cutOffsetInch != null && opts.cutOffsetInch !== '' && Number.isFinite(Number(opts.cutOffsetInch)))
        ? Math.max(0, Math.min(0.25, Number(opts.cutOffsetInch))) : undefined;
    const geom = (overridePosX !== undefined || overrideMode || overridePosY !== undefined || overrideOverlap !== undefined || overrideDiaInch !== undefined || overrideOffset !== undefined)
        ? { ...baseGeom, cut: { ...baseGeom.cut,
            holeMode: overrideMode || baseGeom.cut.holeMode,
            ...(overrideOffset !== undefined ? { offsetInch: overrideOffset } : {}),
            tab: overrideOverlap !== undefined ? { ...baseGeom.cut.tab, loopOverlapFrac: overrideOverlap } : baseGeom.cut.tab,
            hole: { ...baseGeom.cut.hole,
                ...(overridePosX !== undefined ? { posX: overridePosX } : {}),
                ...(overridePosY !== undefined ? { posY: overridePosY } : {}),
                ...(overrideDiaInch !== undefined ? { diaInch: overrideDiaInch } : {}) } } }
        : baseGeom;
    const dpi = geom.dpi;
    const sizeInches = Number(opts.sizeInches) > 0 ? Number(opts.sizeInches) : 3;
    const sides = opts.backCutout ? 2 : 1;
    if (!opts.frontCutout) throw new Error('frontCutout required');
    if (!opts.outputPath) throw new Error('outputPath required');
    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
    const started = Date.now();

    // Design is placed at its physical size; the print bed is sized TIGHT to the
    // die-cut content (computed below, after the CUT is built) plus a small bleed —
    // so the file isn't a tiny shape in a huge 12" canvas and matches the on-screen
    // hole-placer framing.
    const effTarget = inToPx(sizeInches, dpi);

    // Resolve 'auto' hole mode from the extracted shape's top-loop band: a tall
    // narrow band ⇒ the product carries a hanging loop (car-style) ⇒ loop mode;
    // otherwise drill the hole inside (dog-style). The same signal decides whether
    // to strip the loop off the FRONT.
    // When the caller supplies an AI-extracted CUT layer (with the real hole),
    // the geometric drill/loop pipeline is bypassed entirely.
    const useAiCut = !!opts.cutCutout;
    // Dọn lớp sương alpha / đốm rời TRƯỚC mọi bước đo (topBand, trim, CUT) —
    // xem cleanCutoutAlpha. Ảnh in và CUT cùng dựng từ bản đã dọn nên khớp nhau.
    const frontIn = await cleanCutoutAlpha(opts.frontCutout);
    const backIn = opts.backCutout ? await cleanCutoutAlpha(opts.backCutout) : null;
    let effectiveMode = useAiCut ? 'ai' : (geom.cut.holeMode || 'inside');
    // Cắt "vòng treo thừa" ở đỉnh là OPT-IN: heuristic topBand coi cuống bí, ngọn
    // cần cẩu… là vòng treo và cắt phẳng mất đỉnh design (khách báo "sai design").
    // Prompt tách đã bỏ vòng treo gốc nên mặc định giữ nguyên design.
    let doTrim = opts.trimLoop === true;
    let autoBand = null;
    if (!useAiCut && effectiveMode === 'auto') {
        autoBand = (await topBand(frontIn)).frac;
        const threshold = Number(process.env.ORNAMENT_LOOP_BAND_THRESHOLD) || geom.cut.loopBandThreshold || 0.045;
        const hasLoop = autoBand > threshold;
        effectiveMode = hasLoop ? 'loop' : 'inside';
        doTrim = doTrim && hasLoop; // only strip the FRONT's top when there is a genuine loop
        log.info('auto hole mode', { band: +autoBand.toFixed(3), hasLoop, mode: effectiveMode });
    }
    // Optional hanging-tab ASSET for loop mode (operator's EXACT ring shape).
    // Default assets/hole.png; overridable via opts.loopAssetPath or $LOOP_ASSET.
    const loopAssetPath = opts.loopAssetPath !== undefined
        ? opts.loopAssetPath
        : path.resolve(process.env.LOOP_ASSET || 'assets/hole.png');
    const cutGeomBase = (!useAiCut && effectiveMode !== geom.cut.holeMode)
        ? { ...geom, sizeInches, cut: { ...geom.cut, holeMode: effectiveMode } }
        : { ...geom, sizeInches };
    const cutGeom = (loopAssetPath && fs.existsSync(loopAssetPath))
        ? { ...cutGeomBase, cut: { ...cutGeomBase.cut, tab: { ...cutGeomBase.cut.tab, assetPath: loopAssetPath } } }
        : cutGeomBase;

    // Remove any residual hanging loop/tab at the top so the FRONT art is clean
    // and (inside mode) the hole isn't pushed up by it.
    const frontClean = doTrim ? await trimTopLoop(frontIn) : frontIn;
    const backClean = backIn ? (doTrim ? await trimTopLoop(backIn) : backIn) : null;

    // CUT silhouette: black overlay of the AI-extracted cut layer (real hole kept
    // transparent) when provided; otherwise the geometric die-cut from FRONT.
    // cutSourceCutout: nguồn dựng CUT tách riêng khỏi ảnh in (dùng khi /recompose
    // chỉnh màu — alpha y hệt bản gốc nên silhouette không đổi → cache stroke ăn).
    const cut = useAiCut
        ? await silhouetteFromCutout(opts.cutCutout, geom.cut.color, geom.cut.alphaCutoff)
        : await buildCutSilhouette(opts.cutSourceCutout || frontClean, cutGeom);

    // Stroke đen giờ chạy BÊN TRONG buildCutSilhouette — TRƯỚC khi khoan lỗ/đặt
    // vòng treo (viền PS nguyên bản ăn cả khe kín; lỗ khoan sau nên luôn sống).
    // AI-cut path still hardens; the geometric BLACK-CLIP keeps the design's EXACT
    // alpha (no hardening) so faint thin detail (threads) survives into cut.png.
    // Harden to a crisp 1-bit die-cut edge (low cutoff keeps thin threads); this also
    // guarantees the standalone cut.png is 100% opaque (no translucent pixels).
    cut.buf = await hardenAlpha(cut.buf, geom.cut.color, 40);
    if (opts.cutOutputPath) {
        fs.mkdirSync(path.dirname(opts.cutOutputPath), { recursive: true });
        // withMetadata bắt buộc: không có nó sharp ghi pHYs mặc định (25.4 DPI),
        // RIP đọc pHYs sẽ đặt file ra sai cỡ in. flop() để cut.png khớp với panel
        // CUT trong file in (file in bị flip ngang nguyên ảnh ở bước cuối).
        await sharp(cut.buf).flop().withMetadata({ density: geom.dpi }).png().toFile(opts.cutOutputPath);
    }

    // Scale the CUT. AI cut → its own longest side = the design size (effTarget).
    // Geometric cut → matched to the front-shape scale so the die-cut outline
    // lines up with the printed FRONT (the tab simply extends past it).
    const frontTrim = await trimToContent(frontClean);

    // The DESIGN (not the design+tab) is centered in every cell — front, back AND
    // cut — and fills a FIXED fraction of the cell, exactly like the on-screen
    // hole-placer (design centered in the dashed box, tab floating in the margin).
    // The tab extends into that margin; the bed only grows if the tab is dragged
    // past it. This keeps the placer and the File-in preview in lock-step.
    const bleedPx = Math.round((geom.bleedInch ?? 0.35) * dpi);
    const cutScale = effTarget / Math.max(cut.design.w, cut.design.h);
    const cutMeta = await sharp(cut.buf).metadata();
    const sDcx = cut.design.cx * cutScale;
    const sDcy = cut.design.cy * cutScale;
    // Farthest the scaled CUT (design + tab) reaches from the DESIGN centre.
    const reach = Math.max(sDcx, cutMeta.width * cutScale - sDcx, sDcy, cutMeta.height * cutScale - sDcy);
    // Bed CỐ ĐỊNH 3600px = 12" @ 300 DPI — đúng như chú thích đầu file và như cả
    // hai file mẫu (3600 rộng). Trước đây bed tính động bằng effTarget/0.56 nên
    // ornament 3.5" ra bed 1875, lệch khổ so với thứ xưởng vẫn nhận. Bed chỉ nở
    // ra khi bản thân design hoặc tab treo vượt quá 3600.
    const bed = Math.max(geom.bedPx ?? 3600, effTarget, Math.ceil(2 * reach) + 2 * bleedPx);

    const cells = [];
    const cutCell = await placeCutDesignCentered(cut.buf, cut.design, effTarget, bed);
    // AI-cut re-hardens after the resize fringe; the black-clip keeps its exact alpha.
    // Re-harden after the resize's anti-aliased fringe so the print CUT stays opaque.
    cutCell.buf = await hardenAlpha(cutCell.buf, geom.cut.color, 40);
    cutCell.name = 'cut';
    cells.push(cutCell);

    // Thứ tự panel: [CUT][FRONT]([BACK]) — FRONT giữa, BACK dưới cùng.
    const frontCell = await placeInCell(frontTrim.data, effTarget, bed);
    frontCell.name = 'front';
    cells.push(frontCell);

    if (sides === 2) {
        const backCell = await placeInCell(backClean, effTarget, bed);
        backCell.name = 'back';
        cells.push(backCell);
    }

    // Stack cells, rồi FLIP NGANG NGUYÊN FILE IN ở bước cuối (in ngược trên
    // acrylic trong). Flip đặt Ở ĐÂY nên mọi ảnh nguồn/stage/hole-placer đều
    // giữ chiều gốc; /recompose đi qua cùng hàm nên cũng tự được flip.
    const canvasH = bed * cells.length;
    const composites = cells.map((cell, i) => ({ input: cell.buf, left: 0, top: i * bed }));
    const stacked = await sharp({ create: { width: bed, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite(composites)
        .png({ compressionLevel: 6 })
        .toBuffer();
    await sharp(stacked)
        .flop()
        // Xem chú thích ở cut.png — thiếu density thì file in ra sai cỡ vật lý.
        .withMetadata({ density: geom.dpi })
        .png({ compressionLevel: 6 })
        .toFile(opts.outputPath);
    if (opts.previewPath) {
        // Preview NHẸ cho UI (webp ~100-200KB thay vì PNG ~4MB) — cùng nội dung
        // file in, để kéo lỗ/kéo màu thấy kết quả nhanh hơn hẳn.
        await sharp(stacked).flop().resize({ width: 900 }).webp({ quality: 82 }).toFile(opts.previewPath);
    }

    const durationMs = Date.now() - started;
    const regions = cells.map((cell, i) => ({
        name: cell.name,
        cell: i,
        bbox: cell.bbox,
        center: { x: Math.round(cell.center.x), y: Math.round(i * bed + cell.center.y) },
        widthPct: +(100 * cell.bbox.w / bed).toFixed(1),
    }));
    log.info('ornament print composed', { outputPath: opts.outputPath, sides, sizeInches, holePosX: cut.holePosX, canvas: [bed, canvasH], ms: durationMs });
    return {
        ok: true,
        outputPath: opts.outputPath,
        cutPath: opts.cutOutputPath || null,
        sides,
        sizeInches,
        holeMode: effectiveMode,
        holeBand: autoBand != null ? +autoBand.toFixed(3) : null,
        holePosX: cut.holePosX,
        holePosAuto: !(opts.holePosX != null && Number.isFinite(Number(opts.holePosX))),
        bedPx: bed,
        canvas: [bed, canvasH],
        regions,
        durationMs,
    };
}
