/**
 * Đo A/B bước EXTRACT: đường CŨ (khung đầy đủ, 1536, JPEG q88) so với đường MỚI
 * (auto-crop, 2048, PNG lossless). Trả lời đúng một câu hỏi: sau khi model vẽ
 * lại, design thu được BAO NHIÊU PIXEL THẬT — vì đó là trần độ nét của file in.
 *
 *   node measure-extract.mjs <mockup.jpg> [--size=3.5]
 *
 * TỐN QUOTA: chạy 2 lệnh gọi v98 cho mỗi mockup. Cần V98_API_KEY trong .env.
 *
 * Cách đo: ảnh model trả về là "design trên nền trắng", nên bbox của vùng KHÔNG
 * trắng chính là số pixel thật của design. Đem chia cho cỡ ornament ra PPI —
 * con số quyết định in nét hay mờ.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import 'dotenv/config';
import { extractDesign } from './src/lib/v98-extract.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const files = args.filter((a) => !a.startsWith('--'));
const sizeInches = Number(flag('size', '3.5')) || 3.5;

if (!files.length) {
    console.error('Cách dùng: node measure-extract.mjs <mockup.jpg> [--size=3.5]');
    process.exit(1);
}
const apiKey = process.env.V98_API_KEY;
if (!apiKey) { console.error('❌ Thiếu V98_API_KEY trong .env'); process.exit(1); }

/** bbox vùng không-trắng = số pixel thật của design trong ảnh model trả về. */
async function designPixels(file) {
    const { data, info } = await sharp(file).flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h, channels: ch } = info;
    let minX = w, maxX = -1, minY = h, maxY = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = (y * w + x) * ch;
            if (data[p] < 240 || data[p + 1] < 240 || data[p + 2] < 240) {
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return { canvas: [w, h], design: [0, 0], longest: 0 };
    return { canvas: [w, h], design: [maxX - minX + 1, maxY - minY + 1], longest: Math.max(maxX - minX + 1, maxY - minY + 1) };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-extract-'));

for (const src of files) {
    const abs = path.resolve(src);
    if (!fs.existsSync(abs)) { console.error(`❌ Không thấy ${abs}`); continue; }
    console.log(`\n${'═'.repeat(64)}\n📄 ${path.basename(abs)}\n${'═'.repeat(64)}`);

    // Đường CŨ: ép 1536 + JPEG q88 TRƯỚC, rồi extract với autoCrop tắt — tái hiện
    // đúng những gì code cũ gửi lên model.
    const oldInput = path.join(tmp, 'old-input.jpg');
    await sharp(abs).resize(1536, 1536, { fit: 'inside' }).jpeg({ quality: 88 }).toFile(oldInput);

    const runs = [
        ['CŨ  (1536 + JPEG q88, không crop)', oldInput, { autoCrop: false }],
        ['MỚI (auto-crop + 2048 + PNG)', abs, {}],
    ];
    const out = [];
    for (const [label, input, extra] of runs) {
        const dst = path.join(tmp, label.startsWith('CŨ') ? 'old.png' : 'new.png');
        process.stdout.write(`   ${label} ... `);
        try {
            await extractDesign(input, dst, { apiKey, attempts: 2, timeoutMs: 120_000, ...extra });
            const m = await designPixels(dst);
            out.push({ label, ...m });
            console.log(`design ${m.design[0]}×${m.design[1]} px (canvas ${m.canvas.join('×')})`);
        } catch (e) {
            console.log(`❌ ${e.code || ''} ${String(e.message).slice(0, 120)}`);
            out.push(null);
        }
    }

    if (out[0] && out[1] && out[0].longest && out[1].longest) {
        const a = out[0].longest, b = out[1].longest;
        console.log(`\n   Design (cạnh dài):   cũ ${a}px   →   mới ${b}px   =  ${(b / a).toFixed(2)}×`);
        console.log(`   PPI khi in ${sizeInches}":   cũ ${Math.round(a / sizeInches)}   →   mới ${Math.round(b / sizeInches)}`);
        console.log(`   Cỡ tối đa in được ở 300 PPI:  cũ ${(a / 300).toFixed(2)}"  →  mới ${(b / 300).toFixed(2)}"`);
    }
}

console.log(`\nẢnh kết quả nằm ở: ${tmp}\n`);
