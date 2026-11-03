import React, { useEffect, useRef, useState, useCallback } from 'react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import {
    UploadSimple,  ImageSquare, DownloadSimple, Sparkle, CaretRight,
    Scissors,  Faders,
} from '@phosphor-icons/react';

gsap.registerPlugin(useGSAP);

/**
 * /ornament — hole / die-cut acrylic ornament print-file builder ("Print Atelier" UI).
 *
 * Upload 1 ảnh listing → v98/cheapkeyai tách design (extract → rename → mirror)
 * → mọi ảnh gen xong flip ngang → CUT silhouette + viền đen 50px + lỗ treo
 * (semi-auto) → compose [CUT][FRONT]([BACK]) into the print bed. Không còn RMBG.
 *
 * Backend contract:
 *   POST /api/ornament/upload?ext=png   body: raw image  → { fileId }
 *   POST /api/ornament/run  (JSON)  { frontFileId, sides, v98Key, v98Model, ... }
 *     → { jobId, sides, stages:{front:{extract}, back?, compose:{cutUrl}},
 *         print:{url, canvas} }
 */

const prefersReduced = () =>
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function fmtBytes(n) {
    if (!Number.isFinite(n)) return '-';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
function fmtMs(ms) { return !Number.isFinite(ms) ? '-' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`; }

const NEUTRAL_COLOR = { sat: 100, bright: 100, contrast: 100, temp: 0 };
// Ma trận feColorMatrix cho DELTA giữa slider hiện tại và màu server đã bake vào
// preview — Y HỆT công thức server (sat theo luma → bright → contrast quanh 128 →
// temp R±): preview đổi màu TỨC THÌ khi kéo, server bake ngầm phía sau; ảnh bake
// xong load lên thì delta tự về identity nên không bị "double áp".
function colorDeltaMatrix(cur, applied) {
    const s = (cur.sat || 100) / (applied.sat || 100);
    const b = (cur.bright || 100) / (applied.bright || 100);
    const c = (cur.contrast || 100) / (applied.contrast || 100);
    const t = (cur.temp || 0) - (applied.temp || 0);
    if (Math.abs(s - 1) < 0.005 && Math.abs(b - 1) < 0.005 && Math.abs(c - 1) < 0.005 && Math.abs(t) < 0.5) return null;
    const lr = 0.299, lg = 0.587, lb = 0.114;
    const k = b * c; // scale chung sau saturation
    const row = (dr, dg, db, off) => [dr * k, dg * k, db * k, 0, off];
    // server: v_sat → ×b → (v−128)c+128 → ±t  ⇒  scale = b·c, offset = 128(1−c) (+t cho R, −t cho B)
    const off = 128 * (1 - c) / 255;
    const m = [
        ...row(lr + (1 - lr) * s, lg * (1 - s), lb * (1 - s), off + t / 255),
        ...row(lr * (1 - s), lg + (1 - lg) * s, lb * (1 - s), off),
        ...row(lr * (1 - s), lg * (1 - s), lb + (1 - lb) * s, off - t / 255),
        0, 0, 0, 1, 0,
    ];
    return m.map((v) => +Number(v).toFixed(5)).join(' ');
}
function extOf(file) {
    const e = (file.name.split('.').pop() || '').toLowerCase();
    return ['png', 'jpg', 'jpeg', 'webp'].includes(e) ? (e === 'jpeg' ? 'jpg' : e) : 'png';
}

async function uploadFile(file) {
    const r = await fetch(`/api/ornament/upload?ext=${extOf(file)}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
    });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body?.ok) throw new Error(body?.error || `upload HTTP ${r.status}`);
    return body; // { fileId, width, height, bytes }
}

export default function HoleOrnament() {
    const [health, setHealth] = useState(null);
    const [sides, setSides] = useState(1);
    const [sizeInches, setSizeInches] = useState(3);
    const [holePlace, setHolePlace] = useState('auto'); // 'auto' | 'inside' | 'loop'
    const [holeMode, setHoleMode] = useState('auto');    // 'auto' | 'manual'
    const [holePos, setHolePos] = useState(0.5);
    const [advanced, setAdvanced] = useState(false);
    // Mặc định TẮT: heuristic cắt đỉnh hay cắt nhầm cuống/ngọn design.
    const [trimLoop, setTrimLoop] = useState(false);
    const loopOverlap = 0.5; // fixed default (UI control removed); compositor uses it only in loop mode
    const [front, setFront] = useState(null); // { file, previewUrl }
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);

    // ── semi-auto: upload front+back → tự đặt vị trí + cỡ lỗ treo (kéo-thả) ──
    const [semiAuto, setSemiAuto] = useState(false);
    const [holeStyle, setHoleStyle] = useState('loop'); // 'inside' (khoan trong) | 'loop' (vòng treo nhô ngoài)
    // Ø lỗ 0.1–1.0" (mặc định 0.25" — khách chê 0.4" quá to); dùng cho MỌI chế độ lỗ.
    const [hole2D, setHole2D] = useState({ posX: 0.5, posY: 0.12, diaInch: 0.25 });
    // Viền cắt (inch) quanh design trên lớp CUT — 0 = cắt sát mép design.
    const [cutOffset, setCutOffset] = useState(0.04);
    // Slider chỉnh màu design (áp từ bản gốc phía server — không cộng dồn).
    const [colorAdj, setColorAdj] = useState(NEUTRAL_COLOR);
    // Màu server ĐÃ bake vào preview đang hiển thị → filter CSS chỉ áp phần delta.
    const [appliedColor, setAppliedColor] = useState(NEUTRAL_COLOR);
    const bakedColorRef = useRef(NEUTRAL_COLOR); // màu của lần recompose thành công gần nhất
    const [recomposing, setRecomposing] = useState(false);
    const [printBust, setPrintBust] = useState(0); // cache-bust print.png sau recompose
    const recomposeTimer = useRef(null);

    // ── Tách design: v98/cheapkeyai là đường DUY NHẤT (mặc định luôn bật) ──
    const [customName, setCustomName] = useState(''); // tên cá nhân hóa thay vào design
    const [v98Key, setV98Key] = useState(() => { try { return localStorage.getItem('orn.v98Key') || ''; } catch { return ''; } }); // cheapkeyai.shop key (v98store đã migrate sang đây)
    // gpt-image-2 (chính) + gpt-image-2-c (kênh dự phòng, cùng model) — đều nền trong suốt.
    const [v98Model, setV98Model] = useState(() => {
        const valid = ['gpt-image-2', 'gpt-image-2-c'];
        try { const v = localStorage.getItem('orn.v98Model'); return valid.includes(v) ? v : 'gpt-image-2'; } catch { return 'gpt-image-2'; }
    });

    const root = useRef(null);
    const outRef = useRef(null);

    useEffect(() => {
        let cancelled = false;
        async function poll() {
            try {
                const r = await fetch('/api/ornament/health');
                const b = await r.json();
                if (!cancelled) setHealth(b);
            } catch { /* keep last */ }
        }
        poll();
        const id = setInterval(poll, 12_000);
        return () => { cancelled = true; clearInterval(id); };
    }, []);

    // Remember the v98 key + model locally (key still sent per-request).
    useEffect(() => { try { localStorage.setItem('orn.v98Key', v98Key); } catch { /* ignore */ } }, [v98Key]);
    useEffect(() => { try { localStorage.setItem('orn.v98Model', v98Model); } catch { /* ignore */ } }, [v98Model]);

    const v98 = health?.services?.v98;

    // ── entrance choreography: stagger panels in (feedback that the console is ready) ──
    useGSAP(() => {
        if (prefersReduced()) return;
        gsap.from('.js-enter', {
            opacity: 0, y: 18, duration: 0.6, ease: 'power3.out',
            stagger: 0.07, clearProps: 'transform,opacity',
        });
    }, { scope: root });

    // ── result reveal: print scales in, stage cards stagger (state transition) ──
    useGSAP(() => {
        if (prefersReduced() || !result?.print) return;
        const tl = gsap.timeline();
        tl.from('.js-result', { opacity: 0, scale: 0.97, y: 12, duration: 0.55, ease: 'power3.out' })
          .from('.stage-card', { opacity: 0, y: 16, duration: 0.4, ease: 'power2.out', stagger: 0.06 }, '-=0.25');
    }, { scope: outRef, dependencies: [result?.print?.url] });

    const pickFront = useCallback((fileList) => {
        const f = Array.from(fileList || []).find((x) => /^image\//.test(x.type) || /\.(png|jpe?g|webp)$/i.test(x.name));
        if (!f) return;
        setFront((prev) => { if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl); return { file: f, previewUrl: URL.createObjectURL(f) }; });
    }, []);

    // Poll the async /run job until it finishes (v98 can take minutes, past the
    // tunnel's ~100s HTTP limit). Returns the result (ok:true|false); throws if the
    // job vanishes (server restart) or exceeds the cap.
    const pollRun = async (jobId) => {
        const startedAt = Date.now();
        const MAX_MS = 10 * 60 * 1000;
        while (Date.now() - startedAt < MAX_MS) {
            await new Promise((res) => setTimeout(res, 2500));
            let s;
            try { s = await (await fetch(`/api/ornament/run-status/${jobId}`)).json(); }
            catch { continue; } // transient network blip → keep polling
            if (!s?.ok) throw new Error(s?.error || 'mất job (server restart?)');
            if (s.status === 'done' || s.status === 'error') return s.result;
        }
        throw new Error('job chạy quá lâu (>10 phút)');
    };

    const generate = async () => {
        if (!front || running) return;
        if (!v98Key.trim()) {
            setError('Cần nhập cheapkeyai API key.');
            return;
        }
        setRunning(true); setError(null); setResult(null); setPrintBust(0);
        try {
            const fUp = await uploadFile(front.file);
            const r = await fetch('/api/ornament/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    frontFileId: fUp.fileId,
                    sides,
                    v98Key: v98Key.trim(),
                    v98Model,
                    customName: customName.trim() || undefined,
                    sizeInches: Number(sizeInches) || 3,
                    // Semi-auto: drill a geometric hole at the operator start position.
                    manualHole: semiAuto,
                    holePosX: semiAuto ? hole2D.posX : (holeMode === 'manual' ? holePos : 'auto'),
                    holePosY: semiAuto ? hole2D.posY : undefined,
                    holeDiaInch: hole2D.diaInch,
                    cutOffsetInch: cutOffset,
                    holeMode: semiAuto ? holeStyle : holePlace,
                    loopOverlap,
                    trimLoop,
                }),
            });
            const start = await r.json().catch(() => null);
            if (!r.ok || !start?.ok || !start.jobId) {
                throw new Error(start?.error || `HTTP ${r.status}`);
            }
            // /run is async now (jobs run past the 100s tunnel limit → 524): poll the
            // job status until the print is ready.
            const body = await pollRun(start.jobId);
            if (!body?.ok) {
                setResult(body && body.stages ? body : null);
                throw new Error(body?.error || 'job lỗi');
            }
            setResult(body);
            setColorAdj(NEUTRAL_COLOR); // job mới → màu về trung tính
            setAppliedColor(NEUTRAL_COLOR);
            bakedColorRef.current = NEUTRAL_COLOR;
            // Seed the drag placer from the position the server actually used.
            if (semiAuto && body?.stages?.compose?.holePosX != null) {
                setHole2D((h) => ({ ...h, posX: body.stages.compose.holePosX }));
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setRunning(false);
        }
    };

    // Cheap re-compose (no AI) khi kéo lỗ HOẶC kéo slider màu. Job semi-auto gửi
    // toạ độ lỗ đang kéo; job thường gửi lại đúng lựa chọn lỗ của /run (kể cả
    // 'auto') để chỉnh màu không làm lỗ nhảy chỗ.
    const doRecompose = async (h, style, col = colorAdj, off = cutOffset) => {
        if (!result?.jobId) return;
        setRecomposing(true);
        try {
            const r = await fetch('/api/ornament/recompose', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jobId: result.jobId, sides, sizeInches: Number(sizeInches) || 3,
                    ...(semiAuto
                        ? { holeMode: style, holePosX: h.posX, holePosY: h.posY, holeDiaInch: h.diaInch }
                        : { holeMode: holePlace, holePosX: holeMode === 'manual' ? holePos : undefined, holeDiaInch: h.diaInch, trimLoop }),
                    cutOffsetInch: off,
                    color: col,
                }),
            }).then((res) => res.json());
            if (!r.ok) throw new Error(r.error || 'recompose lỗi');
            bakedColorRef.current = col; // preview sắp load đã bake màu này
            setPrintBust((b) => b + 1); // same URL → bump a cache-bust token to force reload
        } catch (e) { setError(e.message); } finally { setRecomposing(false); }
    };
    const onHoleChange = (h) => {
        setHole2D(h);
        clearTimeout(recomposeTimer.current);
        recomposeTimer.current = setTimeout(() => doRecompose(h, holeStyle), 450); // debounce while dragging
    };
    const onHoleStyleChange = (style) => {
        setHoleStyle(style);
        clearTimeout(recomposeTimer.current);
        recomposeTimer.current = setTimeout(() => doRecompose(hole2D, style), 120); // switch → recompose quickly
    };
    // Cỡ lỗ / viền cắt chỉnh được cả trước khi tạo (gửi theo /run) lẫn sau khi
    // tạo (ghép lại nhanh, không gọi AI).
    const onHoleDiaChange = (dia) => {
        const h = { ...hole2D, diaInch: dia };
        setHole2D(h);
        if (!result?.jobId) return;
        clearTimeout(recomposeTimer.current);
        recomposeTimer.current = setTimeout(() => doRecompose(h, holeStyle), 450);
    };
    const onCutOffsetChange = (off) => {
        setCutOffset(off);
        if (!result?.jobId) return;
        clearTimeout(recomposeTimer.current);
        recomposeTimer.current = setTimeout(() => doRecompose(hole2D, holeStyle, colorAdj, off), 450);
    };
    const onColorChange = (c) => {
        setColorAdj(c);
        clearTimeout(recomposeTimer.current);
        recomposeTimer.current = setTimeout(() => doRecompose(hole2D, holeStyle, c), 450); // debounce while dragging
    };

    const stageList = buildStages(result, sides);
    const done = !!result?.print;
    // Delta màu giữa slider và bản preview server đã bake → filter tức thì khi kéo.
    const deltaMatrix = colorDeltaMatrix(colorAdj, appliedColor);

    return (
        <div ref={root}>
            {/* ── topbar ── */}
            <header className="topbar js-enter">
                <div className="brand">
                    <span className="brand-mark" aria-hidden="true" />
                    <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
                        <span className="brand-title">Hole Ornament</span>
                        <span className="brand-sub">print builder</span>
                    </span>
                </div>
                <HealthRow v98={v98} />
            </header>

            <div className="console">
                {/* ════════ LEFT: inputs + settings ════════ */}
                <div className="col">
                    {/* inputs */}
                    <section className="panel js-enter">
                        <div className="panel-head">
                            <h2>Ảnh đầu vào</h2>
                            <span className="index">01 · input</span>
                        </div>
                        <div className="panel-pad">
                            <div className="drops">
                                <DropZone label="Ảnh listing (bắt buộc)" slot={front} onPick={pickFront}
                                    onClear={() => setFront((p) => { if (p?.previewUrl) URL.revokeObjectURL(p.previewUrl); return null; })} />
                            </div>
                        </div>
                    </section>

                    {/* settings */}
                    <section className="panel js-enter">
                        <div className="panel-head">
                            <h2>Thiết lập</h2>
                            <span className="index">02 · setup</span>
                        </div>
                        <div className="panel-pad">
                            <div className="control-grid">
                                <Field label="Số mặt">
                                    <div className="seg">
                                        {[1, 2].map((s) => (
                                            <button key={s} aria-pressed={sides === s} onClick={() => setSides(s)}>
                                                {s === 1 ? '1 mặt' : '2 mặt'}
                                            </button>
                                        ))}
                                    </div>
                                </Field>
                                <Field label="Kích thước (inch)">
                                    <input className="input mono" type="number" min={1} max={12} step={0.5}
                                        value={sizeInches} onChange={(e) => setSizeInches(e.target.value)} />
                                </Field>

                                <Field label="Chế độ lỗ treo" className="span2">
                                    <div className="seg">
                                        <button aria-pressed={!semiAuto} onClick={() => setSemiAuto(false)}
                                            title="Tự dò lỗ từ mockup (AI cut)">Auto</button>
                                        <button aria-pressed={semiAuto} onClick={() => setSemiAuto(true)}
                                            title="Tự kéo-thả đặt vị trí + cỡ lỗ sau khi tạo">Semi-auto (kéo-thả)</button>
                                    </div>
                                </Field>
                                <Field label={`Cỡ lỗ treo · Ø ${hole2D.diaInch.toFixed(2)}" (${(hole2D.diaInch * 25.4).toFixed(1)}mm)`} className="span2">
                                    <input className="range" type="range" min={0.1} max={1} step={0.01}
                                        value={hole2D.diaInch} onChange={(e) => onHoleDiaChange(Number(e.target.value))} />
                                </Field>
                                <Field label={`Viền cắt quanh design · ${cutOffset.toFixed(3)}" (${(cutOffset * 25.4).toFixed(1)}mm)`} className="span2">
                                    <input className="range" type="range" min={0} max={0.2} step={0.005}
                                        value={cutOffset} onChange={(e) => onCutOffsetChange(Number(e.target.value))} />
                                </Field>
                                {semiAuto && (
                                    <div className="dz-hint span2" style={{ marginTop: -4 }}>
                                        Sau khi tạo, <b>kéo chấm cam</b> trên preview để đặt lỗ + chỉnh cỡ — chỉ ghép lại nên rất nhanh.
                                    </div>
                                )}

                                <Field label="Model" className="span2">
                                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                                        <div className="seg">
                                            <button aria-pressed={v98Model === 'gpt-image-2'} onClick={() => setV98Model('gpt-image-2')} title="gpt-image-2 (cheapkeyai.shop) — kênh chính, nền TRONG SUỐT thật">gpt-image-2</button>
                                            <button aria-pressed={v98Model === 'gpt-image-2-c'} onClick={() => setV98Model('gpt-image-2-c')} title="gpt-image-2-c — kênh DỰ PHÒNG (cùng model), dùng khi kênh chính lỗi/quá tải">gpt-image-2-c · dự phòng</button>
                                        </div>
                                        {v98 && (
                                            <span className="run-stat" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                <span style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', background: (v98.reachable && v98.overLimit !== true) ? '#3fbf6f' : '#c0392b' }} />
                                                {v98.reachable ? (v98.overLimit ? 'v98 hết quota' : `v98 sẵn sàng${v98.usageUsd != null && v98.hardLimitUsd != null ? ` ($${v98.usageUsd.toFixed(2)}/$${v98.hardLimitUsd})` : ''}`) : 'v98 offline'}
                                            </span>
                                        )}
                                    </div>
                                </Field>
                                <Field label="cheapkeyai API key" className="span2">
                                    <input className="input" type="password" value={v98Key}
                                        onChange={(e) => setV98Key(e.target.value)}
                                        placeholder="Bearer key cheapkeyai.shop — lưu ở trình duyệt, gửi theo từng request" autoComplete="off" />
                                </Field>
                                <Field label="Tên thay vào design · tùy chọn" className="span2">
                                    <input className="input" value={customName}
                                        onChange={(e) => setCustomName(e.target.value)}
                                        placeholder="VD: JACKSON → tên bạn muốn (để trống = giữ nguyên)" />
                                </Field>
                                {!semiAuto && (<>
                                <Field label="Kiểu lỗ treo" className="span2">
                                    <div className="seg">
                                        <button aria-pressed={holePlace === 'auto'} onClick={() => setHolePlace('auto')}
                                            title="Tự quyết trong/ngoài theo hình dạng">Auto</button>
                                        <button aria-pressed={holePlace === 'inside'} onClick={() => setHolePlace('inside')}
                                            title="Khoan lỗ xuyên qua đỉnh thiết kế">Trong thiết kế</button>
                                        <button aria-pressed={holePlace === 'loop'} onClick={() => setHolePlace('loop')}
                                            title="Vòng treo nhô lên trên thiết kế">Vòng treo ngoài</button>
                                    </div>
                                </Field>

                                <Field label="Vị trí lỗ" className="span2">
                                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                                        <div className="seg">
                                            <button aria-pressed={holeMode === 'auto'} onClick={() => setHoleMode('auto')}
                                                title="Tự dò vị trí lỗ từ ảnh mockup">Auto</button>
                                            <button aria-pressed={holeMode === 'manual'} onClick={() => setHoleMode('manual')}>Chỉnh tay</button>
                                        </div>
                                        {holeMode === 'manual' && (
                                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                                <div className="seg">
                                                    {[['Trái', 0.18], ['Giữa', 0.5], ['Phải', 0.82]].map(([lbl, v]) => (
                                                        <button key={lbl} aria-pressed={Math.abs(holePos - v) < 0.02} onClick={() => setHolePos(v)}>{lbl}</button>
                                                    ))}
                                                </div>
                                                <input className="range" type="range" min={0} max={1} step={0.01}
                                                    value={holePos} onChange={(e) => setHolePos(Number(e.target.value))}
                                                    style={{ width: 96 }} title="Vị trí lỗ dọc cạnh trên" />
                                                <span className="run-stat">{Math.round(holePos * 100)}%</span>
                                            </div>
                                        )}
                                    </div>
                                </Field>
                                </>)}
                            </div>

                            <hr className="divider" style={{ margin: '16px 0' }} />

                            <button className="advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
                                <Faders size={15} weight="bold" />
                                Advanced
                                <CaretRight className="chev" size={12} weight="bold" />
                            </button>

                            {advanced && (
                                <div className="advanced-body">
                                    <label className="check span2" title="Tự cắt bỏ vòng/tab treo thừa ở đỉnh"><input type="checkbox" checked={trimLoop} onChange={(e) => setTrimLoop(e.target.checked)} /> Cắt vòng treo thừa (auto)</label>
                                </div>
                            )}

                            <hr className="divider" style={{ margin: '16px 0' }} />

                            <div className="run-row">
                                <button className="btn btn-primary btn-lg" onClick={generate} disabled={!front || running}>
                                    {running ? <span className="spinner" /> : <Sparkle size={17} weight="fill" />}
                                    {running ? 'Đang xử lý…' : 'Tạo file in'}
                                </button>
                                {done && (
                                    <span className="run-stat">
                                        canvas <b>{result.print.canvas?.[0]}×{result.print.canvas?.[1]}</b> · {fmtBytes(result.print.bytes)} · {fmtMs(result.durationMs)}
                                        {result.stages?.compose && ` · lỗ ${result.stages.compose.holeMode === 'loop' ? 'vòng ngoài' : 'trong TK'} @${Math.round((result.stages.compose.holePosX ?? 0.5) * 100)}%`}
                                    </span>
                                )}
                            </div>
                            {error && <div className="banner err" style={{ marginTop: 12 }}><span>{error}</span></div>}
                        </div>
                    </section>
                </div>

                {/* ════════ RIGHT: pipeline + output ════════ */}
                <div className="col" ref={outRef}>
                    <section className="panel js-enter">
                        <div className="panel-head">
                            <h2>Pipeline</h2>
                            <span className="index">03 · process</span>
                        </div>
                        <div className="panel-pad">
                            <PipelineStepper running={running} done={done} error={!!error} sides={sides} />
                        </div>
                    </section>

                    {semiAuto && result?.jobId && (result?.stages?.front?.trimUrl || result?.stages?.front?.extract?.url) && (
                        <section className="panel">
                            <div className="panel-head">
                                <h2>Đặt lỗ treo <span style={{ opacity: 0.6, fontWeight: 400 }}>· kéo-thả</span></h2>
                                <span className="index">{recomposing ? 'đang ghép…' : `X ${Math.round(hole2D.posX * 100)}% · Y ${Math.round(hole2D.posY * 100)}% · ⌀ ${hole2D.diaInch.toFixed(2)}"`}</span>
                            </div>
                            <div className="panel-pad">
                                <HolePlacer imageUrl={result.stages.front.trimUrl || result.stages.front.extract.url} sizeInches={Number(sizeInches) || 3}
                                    hole={hole2D} onChange={onHoleChange} style={holeStyle} onStyleChange={onHoleStyleChange} />
                            </div>
                        </section>
                    )}

                    {result?.jobId && (
                        <section className="panel">
                            <div className="panel-head">
                                <h2>Chỉnh màu <span style={{ opacity: 0.6, fontWeight: 400 }}>· kéo-thả</span></h2>
                                <span className="index">{recomposing ? 'đang ghép…' : `${colorAdj.sat}% · ${colorAdj.bright}% · ${colorAdj.contrast}% · ${colorAdj.temp > 0 ? '+' : ''}${colorAdj.temp}`}</span>
                            </div>
                            <div className="panel-pad">
                                {[
                                    ['Bão hoà', 'sat', 50, 150, '%'],
                                    ['Sáng', 'bright', 50, 150, '%'],
                                    ['Tương phản', 'contrast', 50, 150, '%'],
                                    ['Nhiệt màu − lạnh / + ấm', 'temp', -50, 50, ''],
                                ].map(([lbl, k, min, max, unit]) => (
                                    <div className="run-row" style={{ gap: 10, marginTop: 8 }} key={k}>
                                        <span className="dz-label" style={{ minWidth: 150 }}>{lbl}</span>
                                        <input className="range" type="range" min={min} max={max} step={1} style={{ flex: 1 }}
                                            value={colorAdj[k]} onChange={(e) => onColorChange({ ...colorAdj, [k]: Number(e.target.value) })} />
                                        <span className="run-stat" style={{ minWidth: 44 }}>{colorAdj[k]}{unit}</span>
                                    </div>
                                ))}
                                <div className="run-row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
                                    <span className="dz-hint">Áp lên cả FRONT + BACK, tính từ bản gốc (không cộng dồn). File in tự cập nhật.</span>
                                    <button className="btn btn-ghost btn-md" onClick={() => onColorChange(NEUTRAL_COLOR)}>Reset</button>
                                </div>
                            </div>
                        </section>
                    )}

                    <section className="panel">
                        <div className="panel-head">
                            <h2>File in</h2>
                            {done && (
                                <div style={{ display: 'flex', gap: 8 }}>
                                    {result.stages?.compose?.cutUrl && (
                                        <a className="btn btn-ghost btn-md" href={result.stages.compose.cutUrl} download="cut.png">
                                            <Scissors size={14} weight="bold" /> CUT
                                        </a>
                                    )}
                                    <a className="btn btn-primary btn-md" href={result.print.url} download="print.png">
                                        <DownloadSimple size={15} weight="bold" /> Tải file in
                                    </a>
                                </div>
                            )}
                        </div>
                        <div className="panel-pad">
                            {done ? (<>
                                {deltaMatrix && (
                                    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
                                        <filter id="colorPrev" colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values={deltaMatrix} /></filter>
                                    </svg>
                                )}
                                <img className="result-hero js-result"
                                    src={(result.print.previewUrl || result.print.url) + (printBust ? `?v=${printBust}` : '')}
                                    style={deltaMatrix ? { filter: 'url(#colorPrev)' } : undefined}
                                    onLoad={() => setAppliedColor(bakedColorRef.current)}
                                    alt="print" />
                            </>) : running ? (
                                <div className="skeleton" style={{ width: '100%', height: 360 }} />
                            ) : (
                                <div className="empty">
                                    <ImageSquare size={40} weight="thin" />
                                    <div className="e-title">Chưa có file in</div>
                                    <div className="e-sub">Thả ảnh mockup, chọn thiết lập rồi bấm <b>Tạo file in</b>. File in 300-DPI sẽ hiện ở đây cùng các bước pipeline.</div>
                                </div>
                            )}
                        </div>
                    </section>

                    {stageList.length > 0 && (
                        <section className="panel">
                            <div className="panel-head">
                                <h2>Các bước</h2>
                                <span className="index">stages</span>
                            </div>
                            <div className="panel-pad">
                                <div className="stage-grid">
                                    {stageList.map((s) => <StageCard key={s.key} stage={s} />)}
                                </div>
                            </div>
                        </section>
                    )}

                </div>
            </div>
        </div>
    );
}

const PIPE_STEPS = [
    { k: 'extract', n: 'Extract' },
    { k: 'cut', n: 'Cut + viền' },
    { k: 'compose', n: 'Compose' },
    { k: 'flip', n: 'Flip ↔' },
];

function PipelineStepper({ running, done }) {
    const cls = running ? 'is-running' : done ? 'is-done' : '';
    return (
        <div className={`pipeline ${cls}`}>
            {PIPE_STEPS.map((s, i) => (
                <div key={s.k} className={`pl-node ${done ? 'done' : ''}`} style={{ '--i': i }}>
                    <div className="pl-disc">{done ? '✓' : i + 1}</div>
                    {i < PIPE_STEPS.length - 1 && <span className="pl-fill" />}
                    <span className="pl-name">{s.n}</span>
                </div>
            ))}
        </div>
    );
}

function buildStages(result, sides) {
    if (!result?.stages) return [];
    const out = [];
    if (result.stages.rename) out.push({ key: 'rename', title: `0 · Thay tên${result.stages.rename.name ? ` → ${result.stages.rename.name}` : ''}`, url: result.stages.rename.url, meta: fmtMs(result.stages.rename.durationMs) });
    const f = result.stages.front || {};
    if (f.extract) out.push({ key: 'f-extract', title: '1 · FRONT', url: f.extract.url, transparent: true, meta: '' });
    if (sides === 2 && result.stages.back) {
        const b = result.stages.back;
        if (b.extract) out.push({ key: 'b-extract', title: '2 · BACK', url: b.extract.url, transparent: true, meta: '' });
    }
    const cut = result.stages.cut || {};
    if (cut.extract) out.push({ key: 'cut-extract', title: 'Extract CUT · prompt 2 (design + lỗ)', url: cut.extract.url, meta: cut.extract.skipped ? 'skipped' : fmtMs(cut.extract.durationMs) });
    if (cut.rmbg) out.push({ key: 'cut-rmbg', title: 'RMBG CUT · tách nền', url: cut.rmbg.url, transparent: true, meta: cut.rmbg.skipped ? 'skipped' : fmtMs(cut.rmbg.durationMs) });
    if (result.stages.compose?.cutUrl) out.push({ key: 'cut', title: '3 · CUT + hole', url: result.stages.compose.cutUrl, transparent: true, meta: fmtMs(result.stages.compose.durationMs) });
    return out;
}

// Derive a sensible download filename from a stage artifact URL
// (/api/ornament/file/<jobId>/<name>) → e.g. "front-cutout.png". Falls back to
// "<stage-key>.png" if the URL has no recognizable image name.
function stageDownloadName(stage) {
    try {
        const seg = String(stage.url).split('?')[0].split('/').pop();
        const name = decodeURIComponent(seg);
        if (/\.(png|jpe?g|webp)$/i.test(name)) return name;
    } catch { /* fall through */ }
    return `${stage.key}.png`;
}

function StageCard({ stage }) {
    const filename = stageDownloadName(stage);
    return (
        <div className="stage-card">
            <div className="sc-head">
                <span className="sc-title">{stage.title}</span>
                <span className="sc-meta">{stage.meta}</span>
            </div>
            <div className="sc-imgwrap">
                <img className={stage.transparent ? 'checker' : 'bg-canvas'} src={stage.url} alt={stage.title} />
                <a className="sc-dl" href={stage.url} download={filename}
                    title={`Tải ${filename}`} aria-label={`Tải ${filename}`}>
                    <DownloadSimple size={14} weight="bold" />
                </a>
            </div>
        </div>
    );
}

// Interactive hanging-hole placer. Two styles:
//   inside — drill a hole through the design body: drag 2D WITHIN the design.
//   loop   — a ring tab placed FREELY, incl. fully OUTSIDE the design (2D drag).
// The design sits inset in a padded square canvas so the tab can be dragged past
// the edges (posX/posY may go < 0 or > 1). Parent debounces a cheap /recompose.
const RING_WALL_INCH = 0.16; // acrylic wall around the loop hole (matches compositor)
function HolePlacer({ imageUrl, sizeInches, hole, onChange, style, onStyleChange }) {
    const stageRef = useRef(null);
    const imgRef = useRef(null);
    const dragging = useRef(false);
    const [box, setBox] = useState({ left: 0, top: 0, width: 1, height: 1 }); // design img box, relative to stage
    const loop = style === 'loop';

    const measure = () => {
        const stage = stageRef.current; const img = imgRef.current;
        if (!stage || !img) return;
        const sr = stage.getBoundingClientRect(); const ir = img.getBoundingClientRect();
        setBox({ left: ir.left - sr.left, top: ir.top - sr.top, width: ir.width || 1, height: ir.height || 1 });
    };
    useEffect(() => {
        measure();
        const ro = new ResizeObserver(measure);
        if (stageRef.current) ro.observe(stageRef.current);
        return () => ro.disconnect();
    }, [imageUrl]);

    // Map pointer → design-bbox fractions (measured off the actual image rect, so
    // it stays accurate through the padding). loop = free (bounded); inside = clamped.
    const moveTo = (clientX, clientY) => {
        const img = imgRef.current; if (!img) return;
        const ir = img.getBoundingClientRect();
        let posX = (clientX - ir.left) / (ir.width || 1);
        let posY = (clientY - ir.top) / (ir.height || 1);
        if (loop) { posX = Math.max(-1.4, Math.min(2.4, posX)); posY = Math.max(-1.4, Math.min(2.4, posY)); }
        else { posX = Math.max(0, Math.min(1, posX)); posY = Math.max(0, Math.min(1, posY)); }
        onChange({ ...hole, posX, posY });
    };
    const down = (e) => { dragging.current = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ } moveTo(e.clientX, e.clientY); };
    const mv = (e) => { if (dragging.current) moveTo(e.clientX, e.clientY); };
    const up = (e) => { dragging.current = false; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* */ } };

    const longSide = Math.max(box.width, box.height) || 1;
    const sz = Number(sizeInches) || 3;
    const markerInch = loop ? hole.diaInch + 2 * RING_WALL_INCH : hole.diaInch; // loop marker = ring OUTER Ø
    const diaPx = Math.max(10, (markerInch / sz) * longSide);
    const markerLeft = box.left + hole.posX * box.width;   // px inside the stage (design-relative)
    const markerTop = box.top + hole.posY * box.height;

    return (
        <div>
            <div className="seg" style={{ marginBottom: 10 }}>
                <button aria-pressed={!loop} onClick={() => onStyleChange('inside')} title="Khoan lỗ xuyên qua thân thiết kế">Khoan trong</button>
                <button aria-pressed={loop} onClick={() => onStyleChange('loop')} title="Vòng treo — đặt tự do, kể cả ra ngoài thiết kế">Vòng treo ngoài</button>
            </div>
            <div ref={stageRef} className="hole-stage" onPointerDown={down} onPointerMove={mv} onPointerUp={up} onPointerCancel={up}>
                <img ref={imgRef} className="hole-design-img" src={imageUrl} alt="thiết kế" draggable={false} onLoad={measure} />
                <div className={loop ? 'hole-loop' : 'hole-marker'}
                    style={{ left: markerLeft, top: markerTop, width: diaPx, height: diaPx }} />
            </div>
            <div className="run-row" style={{ marginTop: 12, gap: 10 }}>
                <span className="dz-label" style={{ minWidth: 56 }} title="Ø lỗ 0.1–1.0 inch">Cỡ lỗ</span>
                <input className="range" type="range" min={0.1} max={1} step={0.01} style={{ flex: 1 }}
                    value={hole.diaInch} onChange={(e) => onChange({ ...hole, diaInch: Number(e.target.value) })} />
                <span className="run-stat" style={{ minWidth: 44 }}>{hole.diaInch.toFixed(2)}"</span>
            </div>
            <div className="dz-hint" style={{ marginTop: 6 }}>
                {loop
                    ? <>Kéo <b style={{ color: 'var(--accent)' }}>vòng cam</b> tới bất kỳ đâu — kể cả <b>ra ngoài</b> khung nét đứt; cổ nối tự thêm. File in tự cập nhật.</>
                    : <>Kéo <b style={{ color: 'var(--accent)' }}>chấm cam</b> để đặt lỗ trong thiết kế; file in tự cập nhật.</>}
            </div>
        </div>
    );
}

function DropZone({ label, slot, onPick, onClear }) {
    const ref = useRef(null);
    const [drag, setDrag] = useState(false);
    return (
        <div>
            <div className="dz-label" style={{ marginBottom: 7 }}>{label}</div>
            <div
                className={`drop ${slot ? 'has-file' : ''} ${drag ? 'is-drag' : ''}`}
                onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer?.files?.length) onPick(e.dataTransfer.files); }}
                onDragOver={(e) => e.preventDefault()}
                onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
                onClick={() => { if (!slot) ref.current?.click(); }}
            >
                <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                    style={{ display: 'none' }} onChange={(e) => { onPick(e.target.files); e.target.value = ''; }} />
                {slot ? (
                    <>
                        <img className="drop-preview" src={slot.previewUrl} alt="preview" />
                        <div className="drop-meta">
                            {slot.file.name} · <span className="rm" onClick={(e) => { e.stopPropagation(); onClear(); }}>xóa</span>
                        </div>
                    </>
                ) : (
                    <>
                        <UploadSimple className="dz-icon" size={26} weight="light" />
                        <div className="dz-title"><strong>Thả ảnh mockup</strong> hoặc click</div>
                        <div className="dz-hint">PNG / JPG / WEBP · tối đa 25 MB</div>
                    </>
                )}
            </div>
        </div>
    );
}

function HealthRow({ v98 }) {
    if (!v98) return <span className="run-stat">checking…</span>;
    return (
        <div className="health">
            <span className="health-item" title={v98.reachable ? (v98.overLimit ? 'v98 hết quota' : 'v98 sẵn sàng') : 'v98 offline'}>
                <span className={`dot ${v98.reachable && v98.overLimit !== true ? 'is-ok' : 'is-err'}`} /> v98
            </span>
        </div>
    );
}

function Field({ label, children, className = '' }) {
    return (
        <label className={`field ${className}`}>
            <span className="label">{label}</span>
            {children}
        </label>
    );
}
