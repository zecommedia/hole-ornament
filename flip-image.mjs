/**
 * Lật ảnh — như soi gương (ngang) hoặc lộn ngược (dọc).
 *
 *   node flip-image.mjs <input> [output] [h|v]
 *     h (mặc định) = lật NGANG trái↔phải, đúng kiểu soi gương   (sharp .flop)
 *     v            = lật DỌC trên↔dưới, lộn ngược                (sharp .flip)
 *
 * Ví dụ:
 *   node flip-image.mjs forklift.jpg
 *   node flip-image.mjs forklift.jpg forklift-mirror.png
 *   node flip-image.mjs forklift.jpg out.png v
 */
import sharp from 'sharp';
import path from 'node:path';

const [input, outputArg, dirArg] = process.argv.slice(2);
if (!input) {
    console.error('Cách dùng: node flip-image.mjs <input> [output] [h|v]');
    process.exit(1);
}
const dir = (dirArg || 'h').toLowerCase();
const ext = path.extname(input) || '.png';
const output = outputArg || input.slice(0, input.length - path.extname(input).length) + `-mirror${ext}`;

let img = sharp(input);
img = dir === 'v' ? img.flip() : img.flop(); // flop = gương ngang, flip = lộn dọc
const info = await img.toFile(output);
console.log(`Xong → ${output}  (${info.width}×${info.height})`);
