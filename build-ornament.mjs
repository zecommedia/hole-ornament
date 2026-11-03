/**
 * Ghép file in ornament từ 3 ảnh ĐÃ TÁCH NỀN sẵn (PNG trong suốt).
 *
 * Chỉ ghép — KHÔNG chạy extract, KHÔNG chạy RMBG (bạn đã tách nền cả 3 rồi).
 * Không cần RMBG server. Xếp [CUT][FRONT][BACK] thành file in. Mặc định 2 mặt, 3.5 inch.
 *
 *   node build-ornament.mjs <front> <back> <cut> [--size=3.5] [--out=ornament-out] [--notrim]
 *
 *     front  = ảnh mặt trước, đã tách nền (PNG trong suốt)
 *     back   = ảnh mặt sau,  đã tách nền
 *     cut    = ảnh CUT có lỗ treo, đã tách nền — LỖ phải trong suốt để hiện thành lỗ
 *     --size = cạnh dài thiết kế theo inch (mặc định 3.5)
 *     --out  = thư mục xuất (mặc định ./ornament-out)
 *     --trim = BẬT tự cắt vòng/tab treo thừa ở đỉnh front/back. MẶC ĐỊNH TẮT —
 *              ảnh đã sạch sẵn nên giữ nguyên, tránh cắt nhầm phần đỉnh hẹp
 *              (cột/càng/mũ… nhô lên) của thiết kế.
 *
 * Chạy từ thư mục gốc project.
 */
import fs from 'node:fs';
import path from 'node:path';
import { composeOrnamentPrint } from './src/lib/ornament-compose.js';

const args = process.argv.slice(2);
const flag = (name, def) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
};
const doTrim = args.includes('--trim'); // mặc định KHÔNG cắt — giữ nguyên đỉnh thiết kế
const pos = args.filter((a) => !a.startsWith('--'));
const [front, back, cut] = pos;

if (!front || !back || !cut) {
    console.error('Cách dùng: node build-ornament.mjs <front> <back> <cut> [--size=3.5] [--out=ornament-out] [--trim]');
    console.error('  Cả 3 ảnh phải ĐÃ TÁCH NỀN (PNG trong suốt). Ảnh cut phải có LỖ trong suốt.');
    process.exit(1);
}

const frontAbs = path.resolve(front);
const backAbs = path.resolve(back);
const cutAbs = path.resolve(cut);
for (const [label, p] of [['front', frontAbs], ['back', backAbs], ['cut', cutAbs]]) {
    if (!fs.existsSync(p)) { console.error(`❌ Không thấy file ${label}: ${p}`); process.exit(1); }
}

const sizeInches = Number(flag('size', '3.5')) > 0 ? Number(flag('size', '3.5')) : 3.5;
const outDir = path.resolve(flag('out', 'ornament-out'));
fs.mkdirSync(outDir, { recursive: true });

const printPath = path.join(outDir, 'print.png');
const cutPath = path.join(outDir, 'cut.png');

async function main() {
    console.log(`Ghép file in — 2 mặt · ${sizeInches} inch`);
    const r = await composeOrnamentPrint({
        frontCutout: frontAbs,
        backCutout: backAbs,   // có back → tự thành 2 mặt [CUT][FRONT][BACK]
        cutCutout: cutAbs,     // có cut → dùng lỗ thật từ ảnh, không khoan hình học
        sizeInches,
        outputPath: printPath,
        cutOutputPath: cutPath,
        trimLoop: doTrim,      // mặc định false → giữ nguyên đỉnh; bật bằng --trim
    });

    console.log('\n✅ Xong.');
    console.log(`  File in : ${printPath}`);
    console.log(`            canvas ${r.canvas[0]}×${r.canvas[1]} · ${r.sides} mặt · ${r.sizeInches}"`);
    console.log(`  CUT     : ${cutPath}`);
}

main().catch((e) => { console.error('❌ Lỗi:', e.message); process.exit(1); });
