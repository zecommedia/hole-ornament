/**
 * Làm nét file in ornament đã ghép — vớt vát bản bị mờ.
 *
 *   node enhance-ornament.mjs <print.png> [--out=...] [--sigma=1.4] [--amount=1.0]
 *
 * ĐỌC KỸ TRƯỚC KHI DÙNG: unsharp mask chỉ TĂNG TƯƠNG PHẢN ở những cạnh ĐÃ CÓ.
 * Nó không tạo ra chi tiết mới. Ảnh gốc là tranh airbrush mềm thì sau khi lọc
 * vẫn không mọc thêm kết cấu — chỉ đỡ "mờ đục" hơn, và đẩy quá tay sẽ ra viền
 * sáng (halo) nhìn còn tệ hơn bản gốc. Sửa từ ảnh nguồn vẫn là cách đúng.
 *
 * Script xử lý đúng 2 việc mà sharpen thẳng bằng sharp sẽ làm sai:
 *   - Chỉ lọc kênh MÀU, giữ nguyên alpha. Sharpen cả alpha sẽ tạo viền răng cưa
 *     quanh mép die-cut.
 *   - BỎ QUA panel CUT (silhouette đen đặc) — lọc vào đó chỉ làm hỏng mép cắt.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const flag = (name, def) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
};
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
    console.error('Cách dùng: node enhance-ornament.mjs <print.png> [--out=...] [--sigma=1.4] [--amount=1.0]');
    process.exit(1);
}

const src = path.resolve(files[0]);
const sigma = Math.max(0.3, Number(flag('sigma', '1.4')) || 1.4);
const amount = Math.max(0, Number(flag('amount', '1.0')) || 1.0);
const outPath = path.resolve(flag('out', src.replace(/\.png$/i, '') + '-sharp.png'));
const FLAT_GRAD = 0.1;

if (!fs.existsSync(src)) { console.error(`❌ Không thấy file: ${src}`); process.exit(1); }

/** Gradient trung bình trong lòng design — để nhận ra panel CUT phẳng. */
function meanInteriorGrad(raw, w, h) {
    let n = 0, sum = 0;
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 2; x++) {
            const i = y * w + x, p = i * 4;
            if (raw[p + 3] < 250 || raw[p + 7] < 250) continue;
            const a = (raw[p] * 299 + raw[p + 1] * 587 + raw[p + 2] * 114) / 1000;
            const b = (raw[p + 4] * 299 + raw[p + 5] * 587 + raw[p + 6] * 114) / 1000;
            sum += Math.abs(b - a); n++;
        }
    }
    return n ? sum / n : 0;
}

const meta = await sharp(src, { limitInputPixels: false }).metadata();
const { width: W, height: H } = meta;
const panels = Math.max(1, Math.round(H / W));
const panelH = Math.floor(H / panels);
const names = panels === 3 ? ['CUT', 'FRONT', 'BACK'] : panels === 2 ? ['CUT', 'FRONT'] : ['FRONT'];

console.log(`Làm nét ${path.basename(src)} — ${panels} panel · sigma=${sigma} · amount=${amount}`);

const composites = [];
for (let i = 0; i < panels; i++) {
    const { data, info } = await sharp(src, { limitInputPixels: false })
        .extract({ left: 0, top: i * panelH, width: W, height: panelH })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const { width: pw, height: ph } = info;

    if (meanInteriorGrad(data, pw, ph) < FLAT_GRAD) {
        console.log(`  ${names[i] ?? i}: silhouette phẳng → giữ nguyên`);
        composites.push({ input: await sharp(data, { raw: { width: pw, height: ph, channels: 4 } }).png().toBuffer(), left: 0, top: i * panelH });
        continue;
    }

    // Tách RGB ra lọc riêng, alpha giữ nguyên 100%
    const rgb = Buffer.alloc(pw * ph * 3);
    const alpha = Buffer.alloc(pw * ph);
    for (let k = 0, p = 0, q = 0; k < pw * ph; k++, p += 4, q += 3) {
        rgb[q] = data[p]; rgb[q + 1] = data[p + 1]; rgb[q + 2] = data[p + 2];
        alpha[k] = data[p + 3];
    }
    const sharpened = await sharp(rgb, { raw: { width: pw, height: ph, channels: 3 } })
        .sharpen({ sigma, m1: 0, m2: amount * 3, x1: 2, y2: 10, y3: 20 })
        .raw()
        .toBuffer();
    const merged = Buffer.alloc(pw * ph * 4);
    for (let k = 0, p = 0, q = 0; k < pw * ph; k++, p += 4, q += 3) {
        merged[p] = sharpened[q]; merged[p + 1] = sharpened[q + 1]; merged[p + 2] = sharpened[q + 2];
        merged[p + 3] = alpha[k];
    }
    console.log(`  ${names[i] ?? i}: đã làm nét`);
    composites.push({ input: await sharp(merged, { raw: { width: pw, height: ph, channels: 4 } }).png().toBuffer(), left: 0, top: i * panelH });
}

await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .withMetadata({ density: meta.density && meta.density > 50 ? meta.density : 300 })
    .png({ compressionLevel: 6 })
    .toFile(outPath);

console.log(`\n✅ Xong: ${outPath}`);
console.log('   Kiểm lại bằng: node check-ornament.mjs "' + outPath + '"');
