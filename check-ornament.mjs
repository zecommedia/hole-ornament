/**
 * Kiểm tra file in ornament TRƯỚC KHI gửi xưởng — soi xem in ra có bị mờ không.
 *
 *   node check-ornament.mjs <file.png> [file2.png ...] [--size=3.5] [--json]
 *
 *     --size = cỡ ornament vật lý theo inch (mặc định 3.5) — dùng để quy ra PPI in thật
 *     --json = xuất JSON thay vì bảng, để cắm vào pipeline khác
 *
 * Script đo 2 thứ quyết định độ nét khi in:
 *
 *   1) ĐỘ LẤP ĐẦY — design chiếm bao nhiêu % bed 3600×3600. Design đặt nhỏ trong
 *      bed thì lúc xưởng phóng lên đúng cỡ ornament sẽ phải kéo giãn nhiều hơn.
 *   2) MẬT ĐỘ CHI TIẾT — số cạnh sắc trên mỗi megapixel, đo ở PHẦN BÊN TRONG
 *      design (đã loại viền die-cut, vì viền alpha cứng sẽ làm nhiễu kết quả).
 *      Đây mới là thứ phân biệt ảnh render/ảnh chụp có kết cấu thật với tranh
 *      vẽ airbrush mềm — loại thứ hai in ra luôn mờ dù thừa pixel.
 *
 * Ngưỡng được hiệu chuẩn trên 2 mẫu đối chứng: một bản in mờ và một bản in nét.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const flag = (name, def) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
};
const asJson = args.includes('--json');
const files = args.filter((a) => !a.startsWith('--'));
const sizeInches = Number(flag('size', '3.5')) > 0 ? Number(flag('size', '3.5')) : 3.5;

if (!files.length) {
    console.error('Cách dùng: node check-ornament.mjs <file.png> [file2.png ...] [--size=3.5] [--json]');
    process.exit(1);
}

/** Ngưỡng đạt/cảnh báo. Dưới mức warn coi như sẽ in ra mờ. */
const T = {
    meanGrad: { good: 2.2, warn: 1.7 },      // gradient trung bình trong lòng design
    edges40: { good: 5000, warn: 2500 },     // cạnh >40 mức / megapixel
    edges60: { good: 800, warn: 300 },       // cạnh >60 mức / megapixel — chỉ số phân biệt mạnh nhất
    micro: { good: 3.0, warn: 2.2 },         // vi tương phản (std 3×3), đo trên toàn lòng design
    // 300 PPI là chuẩn in tối thiểu. Đặt good=350 để còn dư địa, chứ không phải
    // 500 — hai file đối chứng đều >500 PPI mà một bản vẫn in mờ, chứng tỏ PPI
    // KHÔNG phải thứ quyết định. Việc bắt mờ là của nhóm chỉ số chi tiết bên dưới.
    ppi: { good: 350, warn: 250 },           // PPI ở cỡ --size
    ppiCut: { good: 300, warn: 200 },        // silhouette không có chi tiết → hạ chuẩn
    // Tỉ lệ (cạnh>60 / gradient TB) — bắt ảnh bị sharpen quá tay. Unsharp mask
    // đẩy vọt số cạnh sắc nhưng gradient trung bình gần như đứng yên, nên tỉ lệ
    // này vọt lên. Đo thực tế: ảnh nét tự nhiên 500–900, ảnh sharpen quá 1900+.
    // Càng THẤP càng tốt.
    halo: { good: 1200, warn: 1600 },
};

const ALPHA_SOLID = 250;   // coi là đục hoàn toàn
const ERODE_R = 12;        // co mask vào trong 12px để loại hẳn viền anti-alias
const EXPECTED_DPI = 300;  // ornament-compose.js đặt bed 3600px = 12" @ 300 DPI
const FLAT_GRAD = 0.1;     // dưới ngưỡng này coi là mảng phẳng → panel CUT (silhouette đen đặc)

/**
 * Đọc DPI thẳng từ chunk pHYs. Không dùng sharp.metadata().density vì nó trả
 * undefined khi PNG mang pHYs giá trị lạ — mà đó đúng là ca cần bắt.
 */
function readPhysDpi(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(65536);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        let i = 8;
        while (i + 12 <= n) {
            const len = buf.readUInt32BE(i);
            const type = buf.toString('latin1', i + 4, i + 8);
            if (type === 'pHYs') {
                const unit = buf.readUInt8(i + 16);
                return unit === 1 ? +(buf.readUInt32BE(i + 8) * 0.0254).toFixed(1) : null; // unit 1 = mét
            }
            if (type === 'IDAT' || type === 'IEND') break;
            i += 12 + len;
        }
        return null;
    } finally { fs.closeSync(fd); }
}

function grade(v, t, higherIsBetter = true) {
    if (higherIsBetter) return v >= t.good ? 'OK' : v >= t.warn ? 'WARN' : 'FAIL';
    return v <= t.good ? 'OK' : v <= t.warn ? 'WARN' : 'FAIL';
}

/**
 * Co mask nhị phân vào trong bán kính r (erosion), bằng 2 lượt tổng trượt
 * tách trục — O(n), không phụ thuộc r.
 */
function erode(mask, w, h, r) {
    const win = 2 * r + 1;
    const tmp = new Int32Array(w * h);
    // lượt ngang
    for (let y = 0; y < h; y++) {
        const row = y * w;
        let sum = 0;
        for (let x = 0; x < Math.min(r, w); x++) sum += mask[row + x];
        for (let x = 0; x < w; x++) {
            const add = x + r, rem = x - r - 1;
            if (add < w) sum += mask[row + add];
            if (rem >= 0) sum -= mask[row + rem];
            const lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r);
            tmp[row + x] = sum === hi - lo + 1 ? 1 : 0; // toàn 1 trong cửa sổ (đã bù mép)
        }
    }
    // lượt dọc
    const out = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let y = 0; y < Math.min(r, h); y++) sum += tmp[y * w + x];
        for (let y = 0; y < h; y++) {
            const add = y + r, rem = y - r - 1;
            if (add < h) sum += tmp[add * w + x];
            if (rem >= 0) sum -= tmp[rem * w + x];
            const lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r);
            out[y * w + x] = sum === hi - lo + 1 ? 1 : 0;
        }
    }
    // ép mép ảnh về 0 để không tính vùng cửa sổ bị cắt cụt
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
        if (x < r || y < r || x >= w - r || y >= h - r) out[y * w + x] = 0;
    return out;
}

/** Đo 1 panel: bbox design + mật độ chi tiết trong lòng design. */
function analysePanel(raw, w, h, channels) {
    const lum = new Float32Array(w * h);
    const solid = new Uint8Array(w * h);
    let minX = w, maxX = -1, minY = h, maxY = -1, covered = 0;

    for (let i = 0, p = 0; i < w * h; i++, p += channels) {
        const a = channels === 4 ? raw[p + 3] : 255;
        lum[i] = (raw[p] * 299 + raw[p + 1] * 587 + raw[p + 2] * 114) / 1000; // luma ITU-R 601
        if (a > 10) {
            covered++;
            const x = i % w, y = (i / w) | 0;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        solid[i] = a >= ALPHA_SOLID ? 1 : 0;
    }
    if (maxX < 0) return null;

    const inner = erode(solid, w, h, ERODE_R);

    let n = 0, sum = 0, e40 = 0, e60 = 0, microSum = 0, microN = 0;
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 2; x++) {
            const i = y * w + x;
            if (!inner[i] || !inner[i + 1]) continue;
            const d = Math.abs(lum[i + 1] - lum[i]);
            sum += d; n++;
            if (d > 40) e40++;
            if (d > 60) e60++;
            // vi tương phản: độ lệch chuẩn cửa sổ 3×3
            let m = 0, m2 = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const v = lum[i + dy * w + dx]; m += v; m2 += v * v;
            }
            m /= 9;
            microSum += Math.sqrt(Math.max(0, m2 / 9 - m * m)); microN++;
        }
    }
    const mp = n / 1e6;
    const meanGrad = n ? sum / n : 0;
    return {
        bbox: { w: maxX - minX + 1, h: maxY - minY + 1 },
        coveragePct: (covered / (w * h)) * 100,
        interiorMP: mp,
        meanGrad,
        edges40perMP: mp ? e40 / mp : 0,
        edges60perMP: mp ? e60 / mp : 0,
        micro: microN ? microSum / microN : 0,
        // Mảng đặc một màu = silhouette die-cut. Không có chi tiết là ĐÚNG,
        // nên panel này phải được miễn chấm điểm độ nét.
        isFlat: meanGrad < FLAT_GRAD,
    };
}

async function checkFile(file) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`Không thấy file: ${abs}`);

    const img = sharp(abs, { limitInputPixels: false });
    const meta = await img.metadata();
    const { width: W, height: H } = meta;
    const panels = Math.max(1, Math.round(H / W));
    const panelH = Math.floor(H / panels);
    // [CUT][FRONT][BACK] theo ornament-compose.js
    const names = panels === 3 ? ['CUT', 'FRONT', 'BACK'] : panels === 2 ? ['CUT', 'FRONT'] : ['FRONT'];

    const out = {
        file: path.basename(abs),
        canvas: `${W}×${H}`,
        canvasW: W,
        dpi: meta.density ?? null,
        format: `${meta.format} ${meta.depth} ${meta.channels}ch`,
        hasAlpha: meta.hasAlpha,
        // File in đã ghép bed thì cao gấp 2–3 lần rộng. Ảnh 1 panel là ảnh nguồn
        // (cutout chưa ghép) — với nó thì "% lấp bed" vô nghĩa, đừng chấm điểm.
        isBed: panels >= 2,
        panels: [],
    };

    for (let i = 0; i < panels; i++) {
        const { data, info } = await sharp(abs, { limitInputPixels: false })
            .extract({ left: 0, top: i * panelH, width: W, height: panelH })
            .raw()
            .toBuffer({ resolveWithObject: true });
        const r = analysePanel(data, info.width, info.height, info.channels);
        if (r) out.panels.push({ name: names[i] ?? `P${i}`, ...r });
    }

    out.dpi = readPhysDpi(abs);
    // File chỉ gồm silhouette (cut.png xuất riêng) — không có gì để chấm độ nét
    out.isCutFile = out.panels.length > 0 && out.panels.every((p) => p.isFlat);
    if (out.isCutFile && out.panels.length === 1) out.panels[0].name = 'CUT';

    // Chấm điểm trên panel FRONT — đó là mặt người mua nhìn
    const front = out.panels.find((p) => p.name === 'FRONT' && !p.isFlat)
        ?? out.panels.find((p) => !p.isFlat) ?? out.panels[0];
    if (front) {
        const longest = Math.max(front.bbox.w, front.bbox.h);
        out.gradedPanel = front.name;
        out.verdict = {
            designPx: longest,
            fillPct: (longest / W) * 100,
            sizeAt300: longest / EXPECTED_DPI,   // cỡ vật lý file tự khai ở 300 DPI
            printPPI: longest / sizeInches,
            sizeInches,
        };
    }
    return out;
}

function bar(status) {
    return status === 'OK' ? '✅ OK  ' : status === 'WARN' ? '⚠️  WARN' : '❌ FAIL';
}

function report(r) {
    console.log(`\n${'═'.repeat(66)}`);
    console.log(`📄 ${r.file}`);
    console.log(`${'═'.repeat(66)}`);
    const dpiTxt = r.dpi === null ? 'KHÔNG có pHYs' : `${r.dpi} DPI`;
    console.log(`   Canvas ${r.canvas} · ${dpiTxt} · ${r.format}${r.hasAlpha ? ' · có alpha' : ' · KHÔNG có alpha'}`);
    const kind = r.isCutFile ? 'FILE CUT (silhouette die-cut)'
        : r.isBed ? `FILE IN đã ghép ${r.panels.length} panel`
        : 'ẢNH NGUỒN (chưa ghép bed)';
    console.log(`   Loại: ${kind}`);

    console.log(`\n   Panel      bbox design        % canvas   chi tiết/MP (>40)  (>60)`);
    for (const p of r.panels) {
        // Panel phẳng = silhouette đen đặc: không có chi tiết là ĐÚNG, không chấm
        const detail = p.isFlat
            ? `${'—'.padStart(10)}  ${'—'.padStart(6)}`
            : `${Math.round(p.edges40perMP).toString().padStart(10)}  ${Math.round(p.edges60perMP).toString().padStart(6)}`;
        console.log(
            `   ${p.name.padEnd(9)} ${String(p.bbox.w + '×' + p.bbox.h).padEnd(17)} ` +
            `${p.coveragePct.toFixed(1).padStart(6)}%   ${detail}`
        );
    }

    const v = r.verdict;
    const front = r.panels.find((p) => p.name === r.gradedPanel);
    if (!v || !front) return;

    // DPI: bed 3600px chỉ ra đúng 12" khi pHYs = 300. Sai tag thì RIP đặt sai cỡ.
    const dpiStatus = r.dpi === null ? 'WARN' : Math.abs(r.dpi - EXPECTED_DPI) < 1 ? 'OK' : 'FAIL';
    const haloRatio = front.meanGrad > 0.01 ? front.edges60perMP / front.meanGrad : 0;
    const rows = [
        ['Tag DPI (pHYs)', r.dpi === null ? 'thiếu' : `${r.dpi}`, dpiStatus],
        [`PPI @ ${v.sizeInches}"`, `${Math.round(v.printPPI)} PPI`, grade(v.printPPI, r.isCutFile ? T.ppiCut : T.ppi)],
        // Silhouette thì dừng ở đây — các chỉ số chi tiết không áp dụng
        ...(r.isCutFile ? [] : [
            ['Gradient trung bình', front.meanGrad.toFixed(2), grade(front.meanGrad, T.meanGrad)],
            ['Cạnh sắc >40 /MP', Math.round(front.edges40perMP), grade(front.edges40perMP, T.edges40)],
            ['Cạnh sắc >60 /MP', Math.round(front.edges60perMP), grade(front.edges60perMP, T.edges60)],
            ['Vi tương phản 3×3', front.micro.toFixed(2), grade(front.micro, T.micro)],
            ['Halo (sharpen quá tay)', Math.round(haloRatio), grade(haloRatio, T.halo, false)],
        ]),
    ];
    console.log(`\n   Design ${v.designPx}px → ${v.sizeAt300.toFixed(2)}" nếu in đúng 300 DPI` +
        `${r.isBed ? ` · chiếm ${v.fillPct.toFixed(0)}% bề ngang bed` : ''}`);
    console.log('');
    for (const [label, val, st] of rows) {
        console.log(`   ${bar(st)}  ${label.padEnd(24)} ${String(val).padStart(9)}`);
    }

    const fails = rows.filter((x) => x[2] === 'FAIL').length;
    const warns = rows.filter((x) => x[2] === 'WARN').length;
    console.log('');
    if (fails >= 2) {
        console.log(`   ❌ KẾT LUẬN: chưa gửi in được (${fails} chỉ số fail).`);
    } else if (fails || warns >= 3) {
        console.log(`   ⚠️  KẾT LUẬN: có rủi ro — nên kiểm tra lại (${fails} fail, ${warns} warn).`);
    } else {
        console.log(`   ✅ KẾT LUẬN: ${r.isCutFile ? 'file cut hợp lệ.' : 'đủ nét để gửi in.'}`);
    }

    // Gợi ý sửa đúng theo chỉ số nào hỏng
    const tips = [];
    if (dpiStatus !== 'OK')
        tips.push(`Tag DPI ${r.dpi === null ? 'bị thiếu' : `= ${r.dpi}, phải là ${EXPECTED_DPI}`} — sharp không ghi density trừ khi gọi .withMetadata({ density: 300 }). RIP đọc pHYs sẽ đặt sai cỡ in.`);
    const ppiT = r.isCutFile ? T.ppiCut : T.ppi;
    if (grade(v.printPPI, ppiT) !== 'OK')
        tips.push(`Design ${v.designPx}px in ở ${v.sizeInches}" chỉ được ${Math.round(v.printPPI)} PPI — cần ≥${Math.round(ppiT.good * v.sizeInches)}px, tức tăng --size khi build hoặc dùng ảnh nguồn lớn hơn.`);
    if (!r.isCutFile && grade(front.edges60perMP, T.edges60) !== 'OK')
        tips.push('Ảnh gốc quá mềm (tranh vẽ/airbrush). Đổi sang ảnh render 3D hoặc ảnh chụp có kết cấu bề mặt — scale to lên không cứu được.');
    if (!r.isCutFile && grade(haloRatio, T.halo, false) !== 'OK')
        tips.push(`Ảnh có dấu hiệu bị sharpen quá tay (tỉ lệ ${Math.round(haloRatio)}, ảnh nét tự nhiên chỉ 500–900) — sẽ in ra viền sáng quanh mép. Giảm --amount khi chạy enhance-ornament.mjs, hoặc quay lại ảnh nguồn.`);
    if (!r.isCutFile && grade(front.micro, T.micro) !== 'OK')
        tips.push('Thiếu vi kết cấu — cân nhắc unsharp mask nhẹ, và đặt chữ bằng text vector thay vì để chữ nằm sẵn trong ảnh.');
    if (tips.length) {
        console.log('\n   💡 Gợi ý:');
        for (const t of tips) console.log(`      • ${t}`);
    }
}

const results = [];
for (const f of files) {
    try {
        results.push(await checkFile(f));
    } catch (e) {
        console.error(`❌ ${f}: ${e.message}`);
        process.exitCode = 1;
    }
}

if (asJson) {
    console.log(JSON.stringify(results, null, 2));
} else {
    for (const r of results) report(r);
    console.log('');
}
