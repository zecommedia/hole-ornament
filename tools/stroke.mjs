/**
 * CLI cho stroke kiểu Photoshop — áp lên 1 cell (mặc định cell TRÊN CÙNG) của
 * file in dạng cột dọc, các cell khác giữ nguyên.
 *
 *   node tools/stroke.mjs <in.png> <out.png> [--size 30] [--position outside|inside|center]
 *                         [--color "#ffffff"] [--opacity 1] [--panel 0|1|2|all]
 *   --size-inch 0.1   → quy đổi theo DPI của file (mặc định 300) thay cho --size px
 */
import sharp from 'sharp';
import { strokePrintPanel } from '../src/lib/stroke.js';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const flag = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] != null ? args[i + 1] : def;
};
if (files.length < 2) {
    console.error('usage: node tools/stroke.mjs <in.png> <out.png> [--size px] [--size-inch in] [--position outside|inside|center] [--color #hex] [--opacity 0..1] [--panel 0|all]');
    process.exit(1);
}
const [input, output] = files;
let size = Number(flag('size', 12));
const sizeInch = flag('size-inch', null);
if (sizeInch != null) {
    const dpi = (await sharp(input).metadata()).density || 300;
    size = Number(sizeInch) * dpi;
}
const r = await strokePrintPanel(input, output, {
    size,
    position: flag('position', 'outside'),
    color: flag('color', '#ffffff'),
    opacity: Number(flag('opacity', 1)),
    panel: flag('panel', 0),
    hard: args.includes('--hard'), // alpha 0/255 — viền đặc, không mép mờ
});
console.log(JSON.stringify({ ...r, sizePx: +size.toFixed(1) }));
