// Self-contained smoke test for the ornament compositor — no external fixtures.
// Builds a synthetic transparent "design cutout", composes the print file in
// both hole modes, and checks canvas size + a clean (decodable) output + a
// drilled hole. Run: npm test
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { composeOrnamentPrint } from '../src/lib/ornament-compose.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '_out');
fs.mkdirSync(OUT, { recursive: true });

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fails++; };

// Synthetic cutout: a filled blue rounded "blob" on transparent, 640×760.
async function syntheticCutout() {
    const W = 640, H = 760;
    const svg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
        `<rect x="60" y="120" width="520" height="560" rx="90" fill="#3b6fd4"/>` +
        `<circle cx="320" cy="190" r="140" fill="#3b6fd4"/>` +
        `</svg>`,
    );
    return await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: svg, left: 0, top: 0 }]).png().toBuffer();
}

// Detect an interior transparent region (the drilled hole) via a border flood fill.
async function hasInteriorHole(file) {
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height, N = W * H;
    const opaque = new Uint8Array(N);
    for (let i = 0; i < N; i++) opaque[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
    const outside = new Uint8Array(N); const st = [];
    const seed = (i) => { if (!opaque[i] && !outside[i]) { outside[i] = 1; st.push(i); } };
    for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
    while (st.length) { const i = st.pop(); const x = i % W, y = (i / W) | 0; if (x > 0) seed(i - 1); if (x < W - 1) seed(i + 1); if (y > 0) seed(i - W); if (y < H - 1) seed(i + W); }
    let interior = 0;
    for (let i = 0; i < N; i++) if (!opaque[i] && !outside[i]) interior++;
    return interior > 50;
}

async function run() {
    const cutout = await syntheticCutout();

    console.log('1-sided, hole mode = inside:');
    const r1 = await composeOrnamentPrint({ frontCutout: cutout, sizeInches: 3, holeMode: 'inside', outputPath: path.join(OUT, 'inside_print.png'), cutOutputPath: path.join(OUT, 'inside_cut.png') });
    check('canvas 3600x7200', r1.canvas[0] === 3600 && r1.canvas[1] === 7200, r1.canvas.join('x'));
    check('mode resolved inside', r1.holeMode === 'inside');
    check('print decodable', await sharp(path.join(OUT, 'inside_print.png')).stats().then(() => true).catch(() => false));
    check('CUT has a drilled hole', await hasInteriorHole(path.join(OUT, 'inside_cut.png')));

    console.log('1-sided, hole mode = loop:');
    const r2 = await composeOrnamentPrint({ frontCutout: cutout, sizeInches: 3, holeMode: 'loop', outputPath: path.join(OUT, 'loop_print.png'), cutOutputPath: path.join(OUT, 'loop_cut.png') });
    check('mode resolved loop', r2.holeMode === 'loop');
    check('CUT has a drilled hole', await hasInteriorHole(path.join(OUT, 'loop_cut.png')));

    console.log('2-sided:');
    const r3 = await composeOrnamentPrint({ frontCutout: cutout, backCutout: cutout, sizeInches: 3, holeMode: 'inside', outputPath: path.join(OUT, 'two_print.png') });
    check('2-sided canvas 3600x10800', r3.canvas[0] === 3600 && r3.canvas[1] === 10800, r3.canvas.join('x'));
    check('sides=2', r3.sides === 2);

    console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
    process.exit(fails === 0 ? 0 : 1);
}
run().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
