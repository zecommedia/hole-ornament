/**
 * V98Store nano-banana (Gemini image) extraction client.
 *
 * V98Store is an OpenAI-compatible `new-api` proxy that resells cheap access to
 * Gemini 2.5 Flash Image ("nano-banana"). We use it to extract the printed
 * design + acrylic die-cut shape out of a marketplace listing-mockup photo,
 * stripping the hanging hole / ribbon / background scene, onto a white canvas.
 *
 * Endpoints (chosen per model — see endpointModeFor):
 *   chat          POST {V98_BASE_URL}/chat/completions   (OpenAI chat shape,
 *                   image-in / image-out — the gemini image family path)
 *   openai-image  POST {V98_BASE_URL}/images/generations (OpenAI images shape,
 *                   gpt-image-2; we pass `image` for an edit-from-mockup)
 * Auth:      Authorization: Bearer {V98_API_KEY}
 * Output:    image carried in choices[0].message.content as a markdown data-URI
 *            (chat) or data[].b64_json / data[].url (images API). All handled.
 *
 * Config (process.env, set in .env):
 *   V98_API_KEY, V98_BASE_URL (default https://cheapkeyai.shop/v1 — v98store migrated),
 *   V98_IMAGE_MODEL (default gemini-3-pro-image)
 *
 * NOTE: distinct from dist/ai/gemini-upscale.js, which talks to Google's own
 * Gemini SDK with GEMINI_API_KEY. This module is the V98 reseller path only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetch, FormData } from 'undici';
import sharp from 'sharp';
import { child } from './logger.js';

const log = child('ai/v98-extract');

// v98store has FULLY MIGRATED to cheapkeyai.shop — all models (gemini image family +
// gpt-image-2) now live there, one provider + one new key. Old v98store keys are dead.
const V98_BASE_URL = process.env.V98_BASE_URL || 'https://cheapkeyai.shop/v1';
const V98_MODEL = process.env.V98_IMAGE_MODEL || 'gemini-3-pro-image';

/**
 * Map a model id → the v98 endpoint family it must be called on. Only gpt-image-2
 * uses the OpenAI /v1/images/generations route; every other model (the gemini
 * image family) goes through /chat/completions image-in / image-out — the proven
 * path. NOTE: v98store has no /images/google/* route — POSTing there 200s the
 * website's HTML instead of JSON, so that mode was removed.
 */
// Route the gemini image models to the CONFIRMED-WORKING Gemini-native endpoint
//   POST {host}/v1beta/models/{model}:generateContent
// (the /images/google/generations route 404s on this key; chat/completions caps at
// ~1K). generateContent honours generationConfig.imageConfig.imageSize (0.5K|1K|2K|4K).
const MODEL_ENDPOINT = {
    'gpt-image-2': 'images-edit',      // /v1/images/edits (multipart) — chat/completions 400s for this model
    'gpt-image-2-c': 'images-edit',    // kênh dự phòng của gpt-image-2 (cùng API shape)
    'gemini-3-pro-image': 'gemini-native',
    'gemini-3.1-flash-image': 'gemini-native',
};
function endpointModeFor(model) {
    return MODEL_ENDPOINT[model] || 'chat';
}

// Gemini-native lives at the base host WITHOUT the /v1 suffix.
const V98_HOST = V98_BASE_URL.replace(/\/v\d+\/?$/, '');
const V98_IMAGE_SIZE = process.env.V98_IMAGE_SIZE || '2K';     // 0.5K|1K|2K|4K

// Output aspect ratios the API supports; pick the closest to the input.
const V98_RATIOS = [
    ['1:1', 1], ['4:5', 0.8], ['5:4', 1.25], ['3:4', 0.75], ['4:3', 1.3333],
    ['2:3', 0.6667], ['3:2', 1.5], ['9:16', 0.5625], ['16:9', 1.7778], ['21:9', 2.3333],
];
function pickAspect(w, h) {
    if (!w || !h) return '1:1';
    const target = w / h;
    let best = '1:1', bestErr = Infinity;
    for (const [label, r] of V98_RATIOS) {
        const err = Math.abs(Math.log(r / target));
        if (err < bestErr) { bestErr = err; best = label; }
    }
    return best;
}
// Trần cạnh dài của ảnh gửi lên. Cũ là 1536 + JPEG q88 — nhưng mockup listing
// thường đã sẵn 2048, nên bước đó vứt đi ~44% pixel VÀ nén mất chi tiết ngay
// trước khi model nhìn thấy ảnh. Model không thể tái tạo thứ nó chưa từng nhận.
const MAX_UPLOAD_DIM = Number(process.env.V98_MAX_UPLOAD_DIM) || 2048;
// PNG (lossless) thay cho JPEG q88. Ảnh quá to thì mới hạ xuống JPEG chất lượng
// cao — data URI phình lên làm request dễ bị từ chối.
const MAX_UPLOAD_BYTES = Number(process.env.V98_MAX_UPLOAD_BYTES) || 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024; // cap on a model-returned image (data URI or URL)
const CARRIER_FETCH_TIMEOUT_MS = 30_000;
// Auto-crop: bỏ viền nền đồng màu quanh sản phẩm trước khi upload, để design
// chiếm trọn khung 2048 thay vì ~53%. Xem cropToContent().
const CROP_BG_TOL = 18;        // lệch màu so với nền dưới mức này coi là nền
const CROP_PAD_FRAC = 0.03;    // chừa lại 3% cạnh dài, tránh cắt sát mép sản phẩm
const CROP_MIN_GAIN = 0.9;     // chỉ crop khi bbox nhỏ hơn 90% cạnh — không thì thôi

/**
 * Chống bóp méo / cắt cụt design — nối vào MỌI prompt gen (extract / rename /
 * mirror): giữ đúng tỉ lệ gốc, không kéo giãn, và toàn bộ design phải nằm trọn
 * trong khung (không phần nào chạm mép hay bị crop mất).
 */
/**
 * Chống ám vàng / tăng bão hoà — gpt-image-2 hay phủ tone ấm khi regen. Nối vào
 * mọi prompt gen; tầng 2 là color-match deterministic trong pipeline.
 */
export const COLOR_FIDELITY_SUFFIX =
    '\n\nCOLOR FIDELITY: reproduce the original colours EXACTLY — identical hue, saturation, brightness, contrast and white balance. Do NOT add any warm / yellow / sepia / vintage tint or any colour grading, and do NOT boost saturation or vibrance. Neutral and white areas must stay perfectly neutral — pure white stays pure white, NOT cream or ivory. Every element\'s colour must be indistinguishable from the source image.';

export const PRESERVE_SHAPE_SUFFIX =
    '\n\nDO NOT DISTORT OR CROP THE DESIGN: keep the artwork\'s EXACT original proportions and aspect ratio — never stretch, squash, widen, narrow, slant, or reshape it in any way. The ENTIRE design must fit COMPLETELY inside the output frame: cropping close is fine, but NO part of the artwork (outer edges, corners, thin details, decorations, text) may be cut off, trimmed away, or touch the image border — leave a small sliver of empty space on every side. Every element of the source design must appear whole and complete in the output.';

/**
 * Canonical FRONT extraction prompt — isolate ONLY the printed design/artwork
 * (no acrylic substrate, no hole/tab/ribbon, no background/watermarks) as a tight
 * cutout on white. (Supplied verbatim by the operator; the CUT layer + hole are
 * produced separately — see CUT_HOLE_PROMPT + the compositor.)
 */
export const EXTRACT_PROMPT =
    'Extract ONLY the central printed design/artwork from this product listing image. Isolate the main graphic that the customer is actually buying — including all artwork elements, illustrations, characters, objects, and any text that is part of the design itself (names, slogans, personalization text printed on the product).\n\n' +
    'CRITICAL — NO ACRYLIC, NO STICKER OUTLINE: Do NOT include the clear/transparent acrylic die-cut backing, rim, or substrate in ANY form, AND do NOT include any white/light-coloured sticker outline, contour stroke, or printed border that traces around the artwork. The cutout silhouette MUST follow the EXACT painted outer edges of the artwork itself (e.g. the car\'s real body paint), NOT a surrounding rounded/offset acrylic shape and NOT a white outline around it. There must be NO glossy transparent acrylic border, NO white halo or sticker rim, NO clear margin, and NO die-cut outline around the artwork — the white background must begin immediately at the artwork\'s own painted edges. If the product is a clear acrylic ornament, return ONLY the printed graphic and discard the entire clear acrylic shape and any white edge around it.\n\n' +
    'EXCLUDE everything that is packaging, presentation, or platform decoration, specifically:\n\n' +
    '- the physical product material/substrate edges (acrylic die-cut border, glossy clear rim, mug surface, shirt fabric, frame, mockup blank)\n' +
    '- hanging hardware (ribbons, strings, hooks, keyrings, mounting holes, hanging loops/tabs)\n' +
    '- the background scene or environment (lifestyle props, tables, trees, bokeh, gradients, studio backdrop)\n' +
    '- brand logos, shop watermarks, and label badges (e.g. material tags, size tags, "Acrylic"/"Ceramic" labels)\n' +
    '- shadows, reflections, and any UI/overlay text\n\n' +
    'Output the design as a clean cutout on a fully white background, cropped tight to the artwork itself. Preserve the original art style, colors, and composition exactly — do not redraw, restyle, or alter the design.'
    + COLOR_FIDELITY_SUFFIX
    + PRESERVE_SHAPE_SUFFIX;

/**
 * Transparent-background variant of EXTRACT_PROMPT — for gpt-image-2, which can
 * emit a real alpha channel. Same rules, but the cutout sits on TRANSPARENT so RMBG
 * is skipped downstream. Only the BACKGROUND wording changes; the "no white sticker
 * outline / halo" rules stay intact (those must NOT become transparent).
 */
// Reusable instruction: force a real transparent alpha channel. Appended to EVERY
// gpt-image-2 call (extract / rename / mirror) so each stage keeps the cut-out
// transparent instead of re-flattening onto white.
export const TRANSPARENT_BG_SUFFIX =
    '\n\nThe output MUST be a PNG with a genuine alpha channel: every pixel outside the artwork is fully transparent (alpha = 0), NOT white and NOT any solid colour. The transparency MUST be a REAL empty alpha channel — do NOT paint, draw, render or bake a grey-and-white checkerboard, chequered grid, or any "transparency indicator" pattern into the pixels; there must be zero checkerboard pixels. Do not add, change or flatten the background.';

export const EXTRACT_PROMPT_TRANSPARENT = EXTRACT_PROMPT
    .replace('the white background must begin', 'the transparent background must begin')
    .replace('on a fully white background', 'on a fully transparent background')
    + TRANSPARENT_BG_SUFFIX;

/**
 * CUT extraction prompt — keep the printed design/artwork PLUS the real hanging
 * hole punched into the product (rendered as a clean empty circular cutout on
 * white). Unlike EXTRACT_PROMPT (which strips the hole and keeps the acrylic
 * substrate for the FRONT colour layer), this is used to build the CUT layer:
 * extract design+hole → RMBG (background removed, hole kept transparent) →
 * black overlay → die-cut silhouette with the hole already in place. (Supplied
 * verbatim by the operator.)
 */
export const CUT_HOLE_PROMPT =
    'Extract the central printed design/artwork from this product listing image TOGETHER WITH the product\'s real hanging/mounting hole, and output them on a fully white background.\n\n' +
    'FIND THE HANGING HOLE wherever it is on the product and reproduce it as a clean, FULLY EMPTY round opening (pure white, the same as the background, cut all the way through, with a thin crisp edge) at its EXACT original position, size and proportion. The hole is in ONE of these two places — detect which and handle BOTH correctly:\n' +
    '1) INSIDE the design: the hole is punched directly THROUGH the artwork itself (e.g. through the top of a hat, a head, a banner, a name plate). Keep the artwork around it and show the hole as an empty round opening straight through the design.\n' +
    '2) OUTSIDE the design: the hole sits in a small clear tab or loop ABOVE or beside the artwork. Keep ONLY that minimal tab/loop (the little piece of material that physically holds the hole) plus the hole, and discard the rest of the clear material.\n\n' +
    'Isolate the main graphic the customer is buying — all artwork elements, illustrations, characters, objects, and any text that is part of the design (names, slogans, personalization text printed on the product).\n\n' +
    'EXCLUDE everything else, specifically:\n' +
    '- the clear acrylic die-cut border/substrate around the artwork (mug surface, shirt fabric, frame, mockup blank) — EXCEPT the minimal tab that holds an OUTSIDE hole\n' +
    '- hanging hardware threaded through the hole (ribbons, strings, cords, hooks, keyrings)\n' +
    '- the background scene or environment (lifestyle props, tables, trees, bokeh, gradients, studio backdrop)\n' +
    '- brand logos, shop watermarks, and label badges (e.g. material tags, size tags, "Acrylic"/"Ceramic" labels, "2D not 3D" badges)\n' +
    '- shadows, reflections, and any UI/overlay text\n\n' +
    'Output a clean cutout on a fully white background, cropped tight to the artwork plus the hole. The hole MUST be a true empty opening — pure white, clearly readable as a hole, NOT filled with any colour or artwork. Preserve the original art style, colors, and composition exactly — do not redraw, restyle, or alter the design.';

/**
 * Build the name-replacement prompt (Step 0, before extraction). The model finds
 * the existing personalization name printed on the product and swaps ONLY that
 * text for `name`, keeping font/style/position and everything else identical.
 */
export function buildRenamePrompt(name) {
    const n = String(name).replace(/"/g, '\\"');
    return `Replace the personalization name text on the product with "${n}". Automatically find the existing personalized name text and change ONLY those characters to spell "${n}".\n\n` +
        `THE TYPOGRAPHY MUST MATCH THE ORIGINAL EXACTLY. Render "${n}" in the IDENTICAL typeface and lettering style as the current name: the same font family and script style (cursive stays that exact cursive, bold block stays that exact bold block), the same stroke thickness and weight, the same slant/italic angle, the same letter spacing, the same capitalization pattern, the same fill colour/gradient, the same outline/stroke and drop shadow, the same 3D/texture/foil effects, the same size scale, and the same position, perspective and curve/arc path that the original name follows. It must look like the SAME artist lettered the new name with the SAME font and brush — comparing before and after, a viewer should see different LETTERS only, never a different STYLE.\n\n` +
        `Keep everything else in the image exactly the same — same artwork, same background, same product, same layout, same colours, same lighting. Do not redraw or restyle anything other than the name characters themselves.`
        + COLOR_FIDELITY_SUFFIX
        + PRESERVE_SHAPE_SUFFIX;
}


/**
 * BACK of a 2-sided acrylic — chạy trên FRONT CHƯA FLIP (chữ còn đọc xuôi nên
 * model đọc ĐÚNG nội dung), yêu cầu lật gương RIÊNG PHẦN CHỮ; artwork giữ
 * nguyên. Kết quả được flip ngang bằng code ngay sau đó → trên file in: artwork
 * CÙNG CHIỀU front, chữ đọc xuôi, nội dung không đổi. (Đã thử chạy trên bản
 * flip sẵn: model phải OCR chữ ngược nên bịa chữ mới — "Mean"→"Neon".)
 */
export const MIRROR_ALL_TEXT_PROMPT =
    'Horizontally mirror-flip ONLY THE TEXT in this image — every name, word, letter and number, including any personalization text — so each one reads as a mirror image (reversed left-to-right). Do NOT change WHAT any text says: keep the exact same letters, words, spelling, font, size, colour, style, position and perspective — only reverse each text element\'s reading direction IN PLACE, as if that text alone were seen in a mirror.\n\n' +
    'ABSOLUTELY DO NOT MIRROR THE WHOLE IMAGE OR THE ARTWORK. This is NOT a mirrored copy of the design: the illustration, objects, characters, decorations, layout and composition must stay in EXACTLY their current orientation and position — an element on the left stays on the left, an element facing right keeps facing right. The ONLY difference between input and output is that each piece of text is reversed in place. Keep the background exactly as it is — transparent stays transparent.'
    + COLOR_FIDELITY_SUFFIX
    + PRESERVE_SHAPE_SUFFIX;

export class V98Error extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'V98Error';
    }
}

function getKey(override) {
    // No .env fallback: the v98 key MUST be supplied per-request by the user so a
    // public deploy never spends the server's key.
    if (!override) throw new V98Error('V98 API key required (no .env fallback)', 'no-key');
    return override;
}

/**
 * Liveness/quota check. The billing endpoints answer 200 even when the account
 * is over its spend limit (chat/completions then 429s), so we surface both:
 *   { reachable, overLimit, usageUsd, hardLimitUsd }
 * `reachable && !overLimit` ⇒ extraction can actually run.
 */
export async function getV98Quota(timeoutMs = 4000, apiKey) {
    const key = apiKey || process.env.V98_API_KEY;
    if (!key) return { reachable: false, overLimit: null, usageUsd: null, hardLimitUsd: null, error: 'no-key' };
    const headers = { authorization: `Bearer ${key}` };
    async function get(pathname) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await fetch(`${V98_BASE_URL}${pathname}`, { headers, signal: ctrl.signal });
            if (!r.ok) return null;
            return await r.json();
        } catch { return null; }
        finally { clearTimeout(t); }
    }
    const sub = await get('/dashboard/billing/subscription');
    if (!sub) return { reachable: false, overLimit: null, usageUsd: null, hardLimitUsd: null };
    const usage = await get('/dashboard/billing/usage');
    // new-api returns usage.total_usage in CENTS (OpenAI billing convention).
    const usageUsd = usage && Number.isFinite(usage.total_usage) ? usage.total_usage / 100 : null;
    const hardLimitUsd = Number.isFinite(sub.hard_limit_usd) ? sub.hard_limit_usd : null;
    const overLimit = usageUsd != null && hardLimitUsd != null ? usageUsd >= hardLimitUsd : null;
    return { reachable: true, overLimit, usageUsd, hardLimitUsd };
}



/** Pull the first image out of an OpenAI-style chat-completions response body. */
function extractImageCarrier(json) {
    const msg = json?.choices?.[0]?.message;
    if (!msg) return null;
    // a) message.images[] (OpenRouter / new-api style)
    if (Array.isArray(msg.images)) {
        for (const im of msg.images) {
            const u = im?.image_url?.url || im?.url || (typeof im === 'string' ? im : null);
            if (typeof u === 'string') return u;
        }
    }
    // b) content as a string with an embedded data URI or image URL / markdown
    if (typeof msg.content === 'string') {
        const dm = msg.content.match(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/);
        if (dm) return dm[0];
        const md = msg.content.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
        if (md) return md[1];
        const um = msg.content.match(/https?:\/\/\S+\.(?:png|jpg|jpeg|webp)(?:\?\S+)?/i);
        if (um) return um[0];
    }
    // c) content as multimodal parts
    if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
            const u = p?.image_url?.url || (p?.type === 'image' && p?.source?.data);
            if (typeof u === 'string') return u;
        }
    }
    return null;
}

/**
 * Pull the first image out of an images-API response body (OpenAI
 * /images/generations or the Google /images/google/generations shape). Handles
 * data[].b64_json, data[].url, and a top-level images[] of strings/objects.
 */
function extractImageCarrierFromImageApi(json) {
    const toCarrier = (b64) => `data:image/png;base64,${b64}`;
    const fromEntry = (d) => {
        if (typeof d === 'string') return /^(data:|https?:)/i.test(d) ? d : toCarrier(d);
        if (!d || typeof d !== 'object') return null;
        if (typeof d.b64_json === 'string') return toCarrier(d.b64_json);
        if (typeof d.bytesBase64Encoded === 'string') return toCarrier(d.bytesBase64Encoded); // Google imagen shape
        const u = d.url || d.image_url?.url || (typeof d.image_url === 'string' ? d.image_url : null);
        if (typeof u === 'string') return u;
        return null;
    };
    const lists = [json?.data, json?.images, json?.data?.images, json?.output, json?.artifacts];
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) { const c = fromEntry(entry); if (c) return c; }
    }
    return null;
}

/**
 * Pull the image out of a Gemini-native generateContent response:
 *   { candidates: [ { content: { parts: [ {inlineData|fileData|text} ] } } ] }
 * Prefers inline base64; with response_format:url the image comes back as a URL.
 */
function extractImageCarrierFromGemini(json) {
    const cands = Array.isArray(json?.candidates) ? json.candidates : [];
    for (const c of cands) {
        const parts = c?.content?.parts;
        if (!Array.isArray(parts)) continue;
        for (const p of parts) {
            const inl = p?.inlineData || p?.inline_data;
            if (inl && typeof inl.data === 'string') return `data:${inl.mimeType || inl.mime_type || 'image/png'};base64,${inl.data}`;
            const uri = p?.fileData?.fileUri || p?.file_data?.file_uri;
            if (typeof uri === 'string') return uri;
            if (typeof p?.text === 'string') {
                const um = p.text.match(/https?:\/\/\S+?\.(?:png|jpg|jpeg|webp)(?:\?\S*)?/i);
                if (um) return um[0];
            }
        }
    }
    // Fallback: response_format:url may place the URL elsewhere. Scan the body, but
    // strip the huge base64 blobs (thoughtSignature / inline data) first so it's cheap.
    try {
        const s = JSON.stringify(json, (k, v) =>
            (k === 'thoughtSignature' || k === 'data') && typeof v === 'string' && v.length > 4096 ? '' : v);
        const um = s.match(/https?:\/\/[^"\\]+\.(?:png|jpg|jpeg|webp)[^"\\]*/i);
        if (um) return um[0];
    } catch { /* ignore */ }
    return null;
}

/**
 * SSRF guard for a model-returned image URL: block loopback / private / link-local
 * (cloud-metadata) targets. The model output is only semi-trusted (a jailbroken
 * model or a MITM'd proxy could return an internal URL we'd otherwise fetch).
 */
function isBlockedHost(hostname) {
    const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1' || h === '::') return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const a = Number(m[1]); const b = Number(m[2]);
        if (a === 0 || a === 127 || a === 10) return true;
        if (a === 169 && b === 254) return true;        // link-local / cloud metadata (169.254.169.254)
        if (a === 192 && b === 168) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    }
    return false;
}

async function carrierToBuffer(carrier) {
    if (carrier.startsWith('data:')) {
        const comma = carrier.indexOf(',');
        const b64 = carrier.slice(comma + 1);
        // ~4/3 base64 expansion → guard before allocating.
        if (b64.length > MAX_IMAGE_BYTES * 1.4) throw new V98Error('data URI image too large', 'too-large');
        return Buffer.from(b64, 'base64');
    }
    if (/^https?:/i.test(carrier)) {
        let url;
        try { url = new URL(carrier); } catch { throw new V98Error('bad image url', 'no-image'); }
        if (isBlockedHost(url.hostname)) throw new V98Error(`image url targets a blocked host: ${url.hostname}`, 'untrusted-host');
        // Dedicated timeout — the outer request timer is already cleared by now.
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), CARRIER_FETCH_TIMEOUT_MS);
        try {
            const r = await fetch(carrier, { signal: ctrl.signal, redirect: 'error' });
            if (!r.ok) throw new V98Error(`image url fetch HTTP ${r.status}`, 'http');
            const cl = Number(r.headers.get('content-length'));
            if (Number.isFinite(cl) && cl > MAX_IMAGE_BYTES) throw new V98Error('image too large', 'too-large');
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length > MAX_IMAGE_BYTES) throw new V98Error('image too large', 'too-large');
            return buf;
        } catch (err) {
            if (err.name === 'AbortError') throw new V98Error('timeout fetching image url', 'timeout');
            throw err;
        } finally {
            clearTimeout(t);
        }
    }
    throw new V98Error('unrecognized image carrier', 'no-image');
}

/**
 * Build the { url, body } for a given endpoint mode. All three carry the input
 * mockup as `dataUri`: chat as an image message part, the image APIs as an
 * `image` field (edit-from-source) so the model crops the design off the mockup
 * rather than inventing one from the prompt alone.
 */
function buildExtractRequest(mode, { model, prompt, dataUri, imageSize, size }) {
    if (mode === 'gemini-native') {
        // Gemini-native generateContent: the mockup rides as an inlineData part
        // (edit-from-source); imageConfig.imageSize sets the output resolution (2K).
        const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUri);
        const mimeType = m ? m[1] : 'image/png';
        const data = m ? m[2] : dataUri;
        return {
            url: `${V98_HOST}/v1beta/models/${model}:generateContent`,
            body: {
                response_format: 'url',
                contents: [
                    { role: 'user', parts: [
                        { inlineData: { mimeType, data } },
                        { text: prompt },
                    ] },
                ],
                generationConfig: {
                    responseModalities: ['IMAGE'],
                    imageConfig: {
                        imageSize: imageSize || V98_IMAGE_SIZE,
                        // "auto"-match the input aspect: gemini rejects a literal "auto" and
                        // omitting drifts, so send the closest supported ratio (pickAspect).
                        // A square mockup → 1:1; a 3:2 mockup → 3:2. Override via V98_ASPECT.
                        aspectRatio: process.env.V98_ASPECT || size || '1:1',
                    },
                },
            },
        };
    }
    if (mode === 'images-edit') {
        // gpt-image-2 — OpenAI /v1/images/edits (multipart): the mockup is the image to
        // edit, the prompt drives the extraction. Returns { url, form } (not JSON body).
        const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUri);
        const mimeType = m ? m[1] : 'image/png';
        const raw = Buffer.from(m ? m[2] : dataUri, 'base64');
        const form = new FormData();
        form.append('model', model);
        form.append('prompt', prompt);
        form.append('image', new Blob([raw], { type: mimeType }), mimeType === 'image/jpeg' ? 'mockup.jpg' : 'mockup.png');
        form.append('n', '1');
        form.append('size', 'auto');
        return { url: `${V98_BASE_URL}/images/edits`, form };
    }
    if (mode === 'openai-image') {
        return {
            url: `${V98_BASE_URL}/images/generations`,
            body: { model, prompt, image: dataUri, size: '1024x1024', n: 1 },
        };
    }
    return {
        url: `${V98_BASE_URL}/chat/completions`,
        body: {
            model,
            modalities: ['text', 'image'],
            messages: [
                { role: 'user', content: [
                    { type: 'image_url', image_url: { url: dataUri } },
                    { type: 'text', text: prompt },
                ]},
            ],
        },
    };
}

/**
 * Cắt bỏ viền nền đồng màu quanh sản phẩm trong ảnh mockup.
 *
 * Lý do: mockup listing thường để sản phẩm giữa khung với lề rộng, design chỉ
 * chiếm ~53% cạnh. Nghĩa là hơn nửa ngân sách pixel gửi lên model bị tiêu vào
 * nền trắng, và design nhận chưa tới một nửa số pixel đáng ra được nhận.
 *
 * AN TOÀN LÀ ƯU TIÊN — thà không cắt còn hơn cắt cụt sản phẩm:
 *   - Màu nền lấy theo TRUNG VỊ viền ảnh, không phải trung bình (watermark hay
 *     góc ảnh lệch màu không kéo được kết quả đi).
 *   - Nền không đồng màu (ảnh lifestyle) → bbox bung ra cả khung → tự động bỏ qua.
 *   - Luôn chừa lề CROP_PAD_FRAC, và chỉ cắt khi ăn được ít nhất 10% cạnh.
 * Lỗi bất kỳ → trả về ảnh gốc, không chặn pipeline.
 *
 * @returns {Promise<{buf: Buffer, cropped: boolean, before?: number[], after?: number[]}>}
 */
export async function cropToContent(input, opts = {}) {
    const tol = opts.tol ?? CROP_BG_TOL;
    const srcBuf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
    try {
        const srcMeta = await sharp(srcBuf).metadata();
        const { data, info } = await (srcMeta.hasAlpha ? sharp(srcBuf).ensureAlpha() : sharp(srcBuf))
            .raw().toBuffer({ resolveWithObject: true });
        const { width: w, height: h, channels: ch } = info;
        if (w < 32 || h < 32) return { buf: srcBuf, cropped: false };

        // Chỉ tin kênh alpha khi nó THỰC SỰ có vùng trong suốt. Rất nhiều PNG là
        // RGBA nhưng đục 100% (export giữ alpha, nền vẫn trắng đặc) — lúc đó alpha
        // phủ kín khung, bbox bung ra cả ảnh và không bao giờ crop được. Ca đó
        // phải rơi về dò theo màu nền.
        let transparent = 0;
        if (srcMeta.hasAlpha) {
            for (let i = 3; i < data.length; i += ch) if (data[i] < 250) transparent++;
        }
        const useAlpha = srcMeta.hasAlpha && transparent > w * h * 0.005;

        let minX = w, maxX = -1, minY = h, maxY = -1;
        const hit = (x, y) => {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        };

        if (useAlpha) {
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
                if (data[(y * w + x) * ch + 3] > 10) hit(x, y);
        } else {
            // Màu nền = trung vị các pixel trên dải viền 2px (trung vị chứ không
            // phải trung bình — watermark hay góc lệch màu không kéo được kết quả)
            const edge = [];
            const push = (x, y) => { const p = (y * w + x) * ch; edge.push([data[p], data[p + 1], data[p + 2]]); };
            for (let x = 0; x < w; x++) { push(x, 0); push(x, 1); push(x, h - 1); push(x, h - 2); }
            for (let y = 0; y < h; y++) { push(0, y); push(1, y); push(w - 1, y); push(w - 2, y); }
            const med = (i) => { const a = edge.map((e) => e[i]).sort((p, q) => p - q); return a[a.length >> 1]; };
            const bg = [med(0), med(1), med(2)];
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const p = (y * w + x) * ch;
                    const d = Math.max(Math.abs(data[p] - bg[0]), Math.abs(data[p + 1] - bg[1]), Math.abs(data[p + 2] - bg[2]));
                    if (d > tol) hit(x, y);
                }
            }
        }
        if (maxX < 0) return { buf: srcBuf, cropped: false }; // ảnh trơn một màu

        // Chừa lề rồi kẹp vào trong khung
        const pad = Math.round(Math.max(w, h) * (opts.padFrac ?? CROP_PAD_FRAC));
        const left = Math.max(0, minX - pad), top = Math.max(0, minY - pad);
        const right = Math.min(w - 1, maxX + pad), bottom = Math.min(h - 1, maxY + pad);
        const cw = right - left + 1, cwh = bottom - top + 1;

        // Nền không đồng màu, hoặc sản phẩm vốn đã chiếm trọn khung → khỏi cắt
        const gain = Math.max(cw / w, cwh / h);
        if (gain > (opts.minGain ?? CROP_MIN_GAIN)) return { buf: srcBuf, cropped: false };

        const buf = await sharp(srcBuf).extract({ left, top, width: cw, height: cwh }).png().toBuffer();
        return { buf, cropped: true, before: [w, h], after: [cw, cwh] };
    } catch (err) {
        log.warn('auto-crop bỏ qua, dùng ảnh gốc', { err: err.message });
        return { buf: srcBuf, cropped: false };
    }
}

/**
 * Extract the design + acrylic die-cut from a listing mockup. Writes a PNG to
 * outputPath (the model output, normalized to PNG; typically a tight cutout on
 * white). Throws V98Error on any failure.
 *
 * @param {string} inputPath  listing-mockup image (png/jpg/webp)
 * @param {string} outputPath destination PNG
 * @param {object} [opts] { prompt, model, apiKey, timeoutMs, maxDim, autoCrop }
 */
export async function extractDesign(inputPath, outputPath, opts = {}) {
    if (!fs.existsSync(inputPath)) throw new V98Error(`input not found: ${inputPath}`, 'input-missing');
    const key = getKey(opts.apiKey);
    const model = opts.model || V98_MODEL;
    const prompt = opts.prompt || EXTRACT_PROMPT;
    const timeoutMs = opts.timeoutMs || 120_000;
    const maxDim = opts.maxDim || MAX_UPLOAD_DIM;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Dồn hết ngân sách pixel vào SẢN PHẨM trước khi upload: cắt viền nền thừa,
    // rồi mới hạ kích thước. Model chỉ nét được tới mức chi tiết nó nhận vào.
    // opts.autoCrop = false → giữ nguyên khung gốc. Dùng để đo A/B, và làm lối
    // thoát nếu gặp mockup mà auto-crop cắt hỏng.
    const crop = opts.autoCrop === false
        ? { buf: fs.readFileSync(inputPath), cropped: false }
        : await cropToContent(inputPath);
    if (crop.cropped) log.info('auto-crop mockup', { from: crop.before, to: crop.after });

    const meta = await sharp(crop.buf).metadata();
    const needResize = (meta.width || 0) > maxDim || (meta.height || 0) > maxDim;
    const mkPipe = () => {
        const p = sharp(crop.buf);
        return needResize ? p.resize(maxDim, maxDim, { fit: 'inside' }) : p;
    };
    // PNG lossless. Chỉ hạ xuống JPEG khi data URI phình quá ngưỡng.
    let uploadBuf = await mkPipe().png({ compressionLevel: 9 }).toBuffer();
    let uploadMime = 'image/png';
    if (uploadBuf.length > MAX_UPLOAD_BYTES) {
        uploadBuf = await mkPipe().jpeg({ quality: 95 }).toBuffer();
        uploadMime = 'image/jpeg';
    }
    log.info('mockup chuẩn bị xong', {
        upload: [meta.width, meta.height], resized: needResize ? maxDim : null,
        mime: uploadMime, kb: Math.round(uploadBuf.length / 1024),
    });
    const dataUri = `data:${uploadMime};base64,${uploadBuf.toString('base64')}`;

    const mode = endpointModeFor(model);
    // Match the output aspect to the mockup so the design isn't forced square.
    const size = opts.size || pickAspect(meta.width, meta.height);
    const { url: endpointUrl, body, form } = buildExtractRequest(mode, {
        model, prompt, dataUri, imageSize: opts.imageSize, size,
    });

    // The proxy occasionally returns a TRUNCATED/corrupt image (the header parses
    // but the pixel data is broken → "libspng read error" downstream). So we
    // fully decode + re-encode every result and RETRY transient failures
    // (network, 5xx, no-image, undecodable image) before giving up.
    const maxAttempts = Math.max(1, opts.attempts || 3);
    const started = Date.now();
    let pngBuf = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        let res; let text;
        try {
            res = await fetch(endpointUrl, {
                method: 'POST',
                // multipart (images/edits): let fetch set the content-type + boundary.
                headers: form ? { authorization: `Bearer ${key}` } : { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: form || JSON.stringify(body),
                signal: ctrl.signal,
            });
            text = await res.text(); // read under the same signal so the timer can abort a stalled body
        } catch (err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') {
                // Provider lúc quá tải hay treo 1 request quá timeoutMs — thử lại như
                // các lỗi tạm khác thay vì giết cả job vì 1 call chậm.
                lastErr = new V98Error(`timeout after ${timeoutMs}ms`, 'timeout');
                if (attempt < maxAttempts) { log.warn('v98 retry (timeout)', { attempt }); continue; }
                throw lastErr;
            }
            const code = err.cause?.code === 'ECONNREFUSED' ? 'server-offline' : 'network';
            lastErr = new V98Error(`${code}: ${err.message}`, code);
            if (code === 'network' && attempt < maxAttempts) { log.warn('v98 retry (network)', { attempt }); continue; }
            throw lastErr;
        }
        clearTimeout(timer);
        if (!res.ok) {
            const snippet = text.slice(0, 300);
            if (res.status === 429) throw new V98Error(`v98 over quota or rate-limited (HTTP 429): ${snippet} — top up the V98Store account`, 'quota');
            lastErr = new V98Error(`v98 HTTP ${res.status}: ${snippet}`, 'http');
            if (res.status >= 500 && attempt < maxAttempts) { log.warn('v98 retry (5xx)', { attempt, status: res.status }); continue; }
            throw lastErr;
        }

        let json;
        try { json = JSON.parse(text); } catch { lastErr = new V98Error(`non-JSON response: ${text.slice(0, 120)}`, 'bad-response'); if (attempt < maxAttempts) continue; throw lastErr; }
        const carrier = mode === 'gemini-native'
            ? extractImageCarrierFromGemini(json)
            : mode === 'chat'
                ? (extractImageCarrier(json) || extractImageCarrierFromImageApi(json))
                : (extractImageCarrierFromImageApi(json) || extractImageCarrier(json));
        if (!carrier) {
            const txt = json?.choices?.[0]?.message?.content ?? json?.error?.message ?? json?.message;
            const hint = typeof txt === 'string' ? txt.slice(0, 160) : JSON.stringify(json).slice(0, 160);
            lastErr = new V98Error(`no image in v98 response; text="${hint}"`, 'no-image');
            if (attempt < maxAttempts) { log.warn('v98 retry (no-image)', { attempt }); continue; }
            throw lastErr;
        }
        let raw;
        try { raw = await carrierToBuffer(carrier); } catch (err) {
            lastErr = err instanceof V98Error ? err : new V98Error(`carrier: ${err.message}`, 'no-image');
            if (attempt < maxAttempts) { log.warn('v98 retry (carrier)', { attempt, err: err.message.slice(0, 60) }); continue; }
            throw lastErr;
        }
        // Force a FULL decode + re-encode — a truncated image fails here, and the
        // resulting buffer is guaranteed readable by RMBG and the compositor.
        try {
            pngBuf = await sharp(raw).png({ compressionLevel: 6 }).toBuffer();
        } catch (err) {
            lastErr = new V98Error(`v98 returned an undecodable image (${err.message.slice(0, 60)})`, 'bad-image');
            if (attempt < maxAttempts) { log.warn('v98 retry (bad-image)', { attempt, err: err.message.slice(0, 60) }); continue; }
            throw lastErr;
        }
        break; // valid image in hand
    }
    if (!pngBuf) throw lastErr || new V98Error('v98 extraction failed', 'unknown');

    // Optional Lanczos floor (default OFF): gemini-native returns native 2K, so no
    // interpolation is applied unless upscaleLongEdge (or V98_UPSCALE_LONG_EDGE) is set.
    const upTarget = opts.upscaleLongEdge != null ? Number(opts.upscaleLongEdge) : (Number(process.env.V98_UPSCALE_LONG_EDGE) || 0);
    if (upTarget > 0) {
        const m = await sharp(pngBuf).metadata();
        const longEdge = Math.max(m.width || 0, m.height || 0);
        if (longEdge > 0 && longEdge < upTarget) {
            pngBuf = await sharp(pngBuf)
                .resize(upTarget, upTarget, { fit: 'inside', kernel: 'lanczos3' })
                .png({ compressionLevel: 6 })
                .toBuffer();
            log.info('v98 upscale', { from: longEdge, to: upTarget });
        }
    }

    fs.writeFileSync(outputPath, pngBuf);
    const outMeta = await sharp(outputPath).metadata().catch(() => ({}));
    const durationMs = Date.now() - started;
    log.info('v98 extract done', { inputPath, outputPath, model, mode, ms: durationMs, size: [outMeta.width, outMeta.height] });
    return { ok: true, outputPath, durationMs, model, size: [outMeta.width || 0, outMeta.height || 0] };
}
