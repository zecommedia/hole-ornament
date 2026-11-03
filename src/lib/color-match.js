/**
 * Bounded Reinhard colour transfer — kéo màu ảnh AI trả về KHỚP LẠI ảnh NGUỒN
 * của chính bước đó. gpt-image-2 hay ám vàng + đẩy bão hoà khi regen (user phải
 * tự hạ saturation trong PTS). Mỗi bước gen giờ được nắn màu deterministic:
 *
 *   extract  ← mockup listing  (bbox cropToContent, bỏ pixel gần trắng — nền/acrylic)
 *   rename   ← design bước trước (mask alpha)
 *   mirror   ← design bước trước (mask alpha)
 *
 * Per-channel: v' = v·k + b với k = σ_ref/σ_out kẹp [0.75, 1.25], b đưa mean về
 * ref; kết quả clamp 0..255. Ảnh vốn đúng màu → k≈1, b≈0, gần như không đổi;
 * ảnh ám vàng → kênh B được kéo lên / R-G hạ xuống về trung tính như nguồn.
 */
import sharp from 'sharp';
import { child } from './logger.js';

const log = child('render/color-match');

const MIN_PIXELS = 500;   // dưới mức này thống kê nhiễu → bỏ qua cho an toàn

function accum(data, pick) {
    const sum = [0, 0, 0]; const sq = [0, 0, 0]; let n = 0;
    const px = data.length / 4;
    for (let i = 0; i < px; i++) {
        const o = i * 4;
        if (!pick(data, o)) continue;
        n++;
        for (let c = 0; c < 3; c++) { const v = data[o + c]; sum[c] += v; sq[c] += v * v; }
    }
    if (!n) return null;
    const mean = sum.map((s) => s / n);
    const std = sq.map((s, c) => Math.sqrt(Math.max(1, s / n - mean[c] * mean[c])));
    return { mean, std, n };
}

const pickOpaque = (d, o) => d[o + 3] >= 200;

const rawOf = (input) => sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

async function writeCorrected(data, info, targetPath, apply) {
    const px = info.width * info.height;
    for (let i = 0; i < px; i++) {
        const o = i * 4;
        if (data[o + 3] === 0) continue; // vùng trong suốt giữ nguyên
        apply(data, o);
    }
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(targetPath);
}

/**
 * Stats-transfer đầy đủ — CHỈ khi ref là design có alpha (rename/mirror: so 1:1
 * cùng nội dung, đã test kéo về đúng từng đơn vị màu; ảnh vốn đúng → gain 1/shift 0).
 */
async function matchToAlphaRef(targetPath, refRaw) {
    const refStats = accum(refRaw.data, pickOpaque);
    const { data, info } = await rawOf(targetPath);
    const tgtStats = accum(data, pickOpaque);
    if (!refStats || !tgtStats || refStats.n < MIN_PIXELS || tgtStats.n < MIN_PIXELS) {
        log.warn('color-match bỏ qua (không đủ pixel)', { refN: refStats?.n, tgtN: tgtStats?.n });
        return { ok: false };
    }
    const gain = []; const shift = [];
    for (let c = 0; c < 3; c++) {
        const k = Math.max(0.75, Math.min(1.25, refStats.std[c] / tgtStats.std[c]));
        gain.push(k);
        shift.push(refStats.mean[c] - tgtStats.mean[c] * k);
    }
    await writeCorrected(data, info, targetPath, (d, o) => {
        for (let c = 0; c < 3; c++) {
            const v = d[o + c] * gain[c] + shift[c];
            d[o + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
        }
    });
    log.info('color-match (stats) applied', { target: targetPath, gain: gain.map((g) => +g.toFixed(3)), shift: shift.map((v) => +v.toFixed(1)) });
    return { ok: true, mode: 'stats', gain, shift };
}

/**
 * Neutralize highlights — cho bước EXTRACT (ref là mockup đục, thống kê bbox
 * không đáng tin: đo thử ảnh chuẩn vẫn bị kéo gain chạm sàn). Thay vào đó chỉ
 * cân bằng trắng theo vùng SÁNG NHẤT của chính output: nhóm pixel sáng (p92,
 * lum>180) mà ám ấm nhẹ → scale kênh cho về trung tính (kẹp [0.9,1.1]); nhóm
 * sáng lệch màu mạnh (design không có trắng thật) → bỏ qua, không phá màu.
 */
async function neutralizeHighlights(targetPath) {
    const { data, info } = await rawOf(targetPath);
    const px = info.width * info.height;
    const lums = [];
    for (let i = 0; i < px; i++) {
        const o = i * 4;
        if (data[o + 3] < 200) continue;
        lums.push((data[o] + data[o + 1] + data[o + 2]) / 3);
    }
    if (lums.length < MIN_PIXELS) return { ok: false };
    lums.sort((a, b) => a - b);
    const thr = Math.max(180, lums[Math.floor(lums.length * 0.92)]);
    const sum = [0, 0, 0]; let n = 0;
    for (let i = 0; i < px; i++) {
        const o = i * 4;
        if (data[o + 3] < 200) continue;
        if ((data[o] + data[o + 1] + data[o + 2]) / 3 < thr) continue;
        n++;
        for (let c = 0; c < 3; c++) sum[c] += data[o + c];
    }
    if (n < MIN_PIXELS) { log.info('neutralize bỏ qua (không đủ vùng sáng)', { n }); return { ok: false }; }
    const mean = sum.map((s) => s / n);
    const avg = (mean[0] + mean[1] + mean[2]) / 3;
    const spread = (Math.max(...mean) - Math.min(...mean)) / avg;
    if (spread > 0.12) { log.info('neutralize bỏ qua (vùng sáng là màu thật, không phải trắng ám)', { mean: mean.map((v) => +v.toFixed(0)) }); return { ok: false }; }
    const gain = mean.map((m) => Math.max(0.9, Math.min(1.1, avg / m)));
    if (gain.every((g) => Math.abs(g - 1) < 0.005)) return { ok: true, mode: 'neutral', gain }; // đã trung tính
    await writeCorrected(data, info, targetPath, (d, o) => {
        for (let c = 0; c < 3; c++) {
            const v = d[o + c] * gain[c];
            d[o + c] = v > 255 ? 255 : Math.round(v);
        }
    });
    log.info('neutralize highlights applied', { target: targetPath, gain: gain.map((g) => +g.toFixed(3)) });
    return { ok: true, mode: 'neutral', gain };
}

const NEAR_WHITE = 240;

/**
 * Tìm vùng design bên trong mockup bằng masked-NCC ở scale thô (grayscale ~96px,
 * quét 6 mức tỉ lệ). Trả { box:{left,top,width,height} theo toạ độ mockup gốc,
 * score } — score thấp nghĩa là không khớp tin được (mockup quá khác design).
 */
async function findDesignInMockup(designPath, mockupPath) {
    const D = 96;
    const trimmed = await sharp(designPath).trim({ threshold: 6 }).toBuffer();
    const dRaw = await sharp(trimmed).resize(D, D, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const dw = dRaw.info.width; const dh = dRaw.info.height;
    // danh sách điểm mask (subsample 2×2) + thống kê design tính 1 lần
    const pts = [];
    for (let j = 0; j < dh; j += 2) for (let i = 0; i < dw; i += 2) {
        const o = (j * dw + i) * 4;
        if (dRaw.data[o + 3] < 200) continue;
        pts.push({ i, j, g: (dRaw.data[o] + dRaw.data[o + 1] + dRaw.data[o + 2]) / 3 });
    }
    if (pts.length < 200) return null;
    const dMean = pts.reduce((s, p) => s + p.g, 0) / pts.length;
    let dv = 0;
    for (const p of pts) dv += (p.g - dMean) ** 2;
    if (dv < 1) return null; // design phẳng màu — NCC vô nghĩa

    const mMeta = await sharp(mockupPath).metadata();
    let best = null;
    // design chiếm r phần cạnh dài mockup — quét các mức r hay gặp của listing
    for (const r of [0.45, 0.55, 0.65, 0.75, 0.85, 0.95]) {
        const scale = D / (Math.max(mMeta.width, mMeta.height) * r);
        const mw = Math.max(dw, Math.round(mMeta.width * scale));
        const mh = Math.max(dh, Math.round(mMeta.height * scale));
        const mRaw = await sharp(mockupPath).resize(mw, mh, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const mg = new Float32Array(mw * mh);
        for (let i = 0; i < mw * mh; i++) { const o = i * 4; mg[i] = (mRaw.data[o] + mRaw.data[o + 1] + mRaw.data[o + 2]) / 3; }
        const STRIDE = 2;
        for (let y = 0; y + dh <= mh; y += STRIDE) {
            for (let x = 0; x + dw <= mw; x += STRIDE) {
                let sm = 0;
                for (const p of pts) sm += mg[(y + p.j) * mw + (x + p.i)];
                const mMean = sm / pts.length;
                let cov = 0; let mv = 0;
                for (const p of pts) {
                    const b = mg[(y + p.j) * mw + (x + p.i)] - mMean;
                    cov += (p.g - dMean) * b;
                    mv += b * b;
                }
                const score = cov / (Math.sqrt(dv * mv) || 1); // hệ số tương quan chuẩn [-1..1]
                if (!best || score > best.score) {
                    best = { score, box: { left: x / scale, top: y / scale, width: dw / scale, height: dh / scale } };
                }
            }
        }
    }
    if (!best) return null;
    // kẹp box vào khung mockup gốc
    const b = best.box;
    b.left = Math.max(0, Math.round(b.left)); b.top = Math.max(0, Math.round(b.top));
    b.width = Math.min(mMeta.width - b.left, Math.round(b.width));
    b.height = Math.min(mMeta.height - b.top, Math.round(b.height));
    return best;
}

const pickNonWhite = (d, o) =>
    d[o + 3] >= 200 && !(d[o] >= NEAR_WHITE && d[o + 1] >= NEAR_WHITE && d[o + 2] >= NEAR_WHITE);

/**
 * EXTRACT: nắn màu output về ĐÚNG VÙNG DESIGN trong mockup (tìm bằng NCC) —
 * gpt-image-2 hay đẩy saturation/contrast + phủ tone ấm so với listing. So
 * thống kê per-channel trên 2 vùng tương ứng (bỏ pixel gần trắng cả 2 phía),
 * gain kẹp [0.75,1.25], shift kẹp ±40. NCC không khớp (score thấp) → chỉ cân
 * trắng highlights như cũ cho an toàn.
 */
async function matchToMockup(targetPath, mockupInput) {
    const found = await findDesignInMockup(targetPath, mockupInput).catch(() => null);
    if (!found || found.score < 0.25) {
        log.info('mockup-match yếu → chỉ neutralize highlights', { score: found ? +found.score.toFixed(3) : null });
        return neutralizeHighlights(targetPath);
    }
    const region = await sharp(mockupInput).extract(found.box).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const refStats = accum(region.data, pickNonWhite);
    const { data, info } = await rawOf(targetPath);
    const tgtStats = accum(data, pickNonWhite);
    if (!refStats || !tgtStats || refStats.n < MIN_PIXELS || tgtStats.n < MIN_PIXELS) return neutralizeHighlights(targetPath);

    const gain = []; const shift = [];
    for (let c = 0; c < 3; c++) {
        const k = Math.max(0.75, Math.min(1.25, refStats.std[c] / tgtStats.std[c]));
        gain.push(k);
        shift.push(Math.max(-40, Math.min(40, refStats.mean[c] - tgtStats.mean[c] * k)));
    }
    await writeCorrected(data, info, targetPath, (d, o) => {
        for (let c = 0; c < 3; c++) {
            const v = d[o + c] * gain[c] + shift[c];
            d[o + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
        }
    });
    log.info('color-match (mockup region) applied', {
        target: targetPath, score: +found.score.toFixed(3), box: found.box,
        gain: gain.map((g) => +g.toFixed(3)), shift: shift.map((v) => +v.toFixed(1)),
    });
    return { ok: true, mode: 'mockup', gain, shift, score: found.score };
}

/**
 * Cửa duy nhất cho pipeline: chọn phép nắn màu theo loại ref.
 *   ref có alpha (design bước trước)  → stats-transfer đầy đủ (rename/mirror)
 *   ref đục (mockup listing, extract) → khớp vùng design bằng NCC rồi transfer;
 *                                       không khớp được → cân trắng highlights
 */
export async function matchColorsToReference(targetPath, refInput) {
    const refRaw = await rawOf(refInput);
    let transparent = 0;
    for (let i = 3; i < refRaw.data.length; i += 4) if (refRaw.data[i] < 250) transparent++;
    const refHasAlpha = transparent > (refRaw.data.length / 4) * 0.005;
    return refHasAlpha ? matchToAlphaRef(targetPath, refRaw) : matchToMockup(targetPath, refInput);
}
