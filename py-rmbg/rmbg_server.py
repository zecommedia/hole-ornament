"""
RMBG-2.0 background removal FastAPI server.

Runs briaai/RMBG-2.0 locally on GPU (CUDA) if available, else CPU.
Model loads ONCE at startup (~5-10s). Each request: ~0.5s on GPU, ~5s on CPU.

Usage:
  POST /rmbg  {"input_path": "...", "output_path": "..."}
  -> writes transparent-background PNG to output_path
  -> returns {"ok": true, "size": [w, h], "output": "..."}

Env:
  HF_TOKEN       HuggingFace access token (required for gated briaai model)
  RMBG_PORT      listen port (default 5001)
  RMBG_DEVICE    force device ("cuda"|"cpu", default auto)
  RMBG_SIZE      inference size px (default 1024)
"""
import os
from pathlib import Path
from typing import Tuple
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import numpy as np
import torch
from PIL import Image
from torchvision import transforms
from transformers import AutoModelForImageSegmentation

HF_TOKEN = os.environ.get("HF_TOKEN")
RMBG_PORT = int(os.environ.get("RMBG_PORT", "5001"))
RMBG_DEVICE = os.environ.get("RMBG_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
RMBG_SIZE = int(os.environ.get("RMBG_SIZE", "1024"))

print(f"[rmbg] torch={torch.__version__} device={RMBG_DEVICE}")
print(f"[rmbg] loading briaai/RMBG-2.0 (first run downloads ~1.5GB)...")
model = AutoModelForImageSegmentation.from_pretrained(
    "briaai/RMBG-2.0",
    trust_remote_code=True,
    token=HF_TOKEN,
)
model.to(RMBG_DEVICE)
model.eval()
print(f"[rmbg] model ready on {RMBG_DEVICE}")

_transform = transforms.Compose([
    transforms.Resize((RMBG_SIZE, RMBG_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])


def _clean_mask(
    mask_bool: np.ndarray,
    fill_holes: bool = True,
    erode: int = 3,
    dilate: int = 2,
    keep_largest: bool = True,
) -> Tuple[np.ndarray, int, int]:
    """Optionally keep only the largest connected component, fill holes, then
    erode-then-dilate to clean edges.

    Returns (cleaned_mask, total_components, dropped_components).

    Net effect with erode=3, dilate=2 is ~1px erosion that removes thin
    fragments and shadows that touch the main subject through narrow bridges.
    """
    from scipy import ndimage
    labels, n = ndimage.label(mask_bool)
    if n == 0:
        return mask_bool, 0, 0
    if n == 1 or not keep_largest:
        cleaned = mask_bool
    else:
        sizes = ndimage.sum(mask_bool, labels, range(1, n + 1))
        largest = int(sizes.argmax()) + 1
        cleaned = (labels == largest)
    if fill_holes:
        cleaned = ndimage.binary_fill_holes(cleaned)
    if erode > 0:
        cleaned = ndimage.binary_erosion(cleaned, iterations=erode)
    if dilate > 0:
        cleaned = ndimage.binary_dilation(cleaned, iterations=dilate)
    dropped = (n - 1) if (keep_largest and n > 1) else 0
    return cleaned, int(n), int(max(0, dropped))


class RmbgRequest(BaseModel):
    input_path: str
    output_path: str
    # Fill regions enclosed by the subject (default True → solid cutout). Set
    # False to PRESERVE interior holes — e.g. the CUT layer must keep the
    # die-cut hanging hole transparent instead of filling it solid.
    fill_holes: bool = True
    # Mask binarize cutoff 0..255 (default 127 ≈ 0.5). Lower → keep more / looser
    # silhouette; higher → tighter, more aggressive cut.
    threshold: int = 127
    # Edge cleanup: erode eats the boundary (drop fringe/shadow), dilate grows it.
    # Net erode=3/dilate=2 ≈ 1px erosion. Increase erode to trim edges harder.
    erode: int = 3
    dilate: int = 2
    # Keep only the largest blob (drop floating fragments). False → keep all blobs.
    keep_largest: bool = True
    # Grow the FINAL cutout OUTWARD by this many px (binary dilation) AFTER edge
    # cleanup. Pushes the silhouette a few px OUTSIDE the model's detected edge so
    # the cut never bites into the printed design — the die-cut keeps a small
    # safety margin around the artwork. 0 = no growth (legacy behavior).
    grow: int = 5


app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True, "device": RMBG_DEVICE, "size": RMBG_SIZE}


@app.post("/rmbg")
def rmbg(req: RmbgRequest):
    in_path = Path(req.input_path)
    out_path = Path(req.output_path)
    if not in_path.exists():
        raise HTTPException(404, f"input not found: {in_path}")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    img = Image.open(in_path).convert("RGB")
    w, h = img.size
    inp = _transform(img).unsqueeze(0).to(RMBG_DEVICE)
    with torch.no_grad():
        preds = model(inp)[-1].sigmoid().cpu()
    mask_pil = transforms.ToPILImage()(preds[0].squeeze()).resize((w, h))

    # Universal mask cleanup: drop floating fragments (couch/bedding/shadows
    # that the model glues to the subject), fill internal holes, and apply a
    # net 1px erosion via erode=3/dilate=2 to break thin bridges.
    mask_arr = np.array(mask_pil, dtype=np.uint8)
    thr = max(0, min(255, int(req.threshold)))
    mask_bool = mask_arr > thr  # binarize at the requested cutoff (default ~0.5)
    cleaned_bool, n_total, n_dropped = _clean_mask(
        mask_bool,
        fill_holes=req.fill_holes,
        erode=max(0, int(req.erode)),
        dilate=max(0, int(req.dilate)),
        keep_largest=req.keep_largest,
    )

    # Expand the cutout OUTWARD by `grow` px so the silhouette sits a few px
    # OUTSIDE the model's detected edge — stops the cut from biting into the
    # printed design (keeps a safety margin around the artwork). Done AFTER
    # edge-cleanup so thin shadow bridges are already severed before we grow.
    # Reassigns cleaned_bool so the alpha AND the RGB decontam below stay
    # consistent with the grown boundary.
    grow = max(0, int(req.grow))
    if grow > 0 and cleaned_bool.any():
        from scipy import ndimage
        cleaned_bool = ndimage.binary_dilation(cleaned_bool, iterations=grow)

    print(
        f"[rmbg] mask-clean components={n_total} dropped={n_dropped} "
        f"thr={thr} erode={req.erode} dilate={req.dilate} grow={grow} "
        f"keep_largest={req.keep_largest} fill_holes={req.fill_holes}",
        flush=True,
    )
    alpha = (cleaned_bool.astype(np.uint8) * 255)

    # Gaussian-blur the alpha channel for anti-aliased edges.
    # Without this the alpha is binary 0/255 and the mask boundary prints as
    # zigzag stair-stepped pixels at high resolution (visible as jagged red/
    # brown sawteeth at extreme zoom — reported on order 112-9907002). After
    # blur, alpha smoothly ramps 0→255 across ~3-5px making edges look natural
    # printed. Sigma scales with image size, clamped 1.0-2.0px (matches the
    # tuning already proven on /face-parse endpoint in smartcrop_server.py).
    try:
        from scipy.ndimage import gaussian_filter
        min_dim = min(w, h)
        sigma = max(1.0, min(2.0, min_dim * 0.0012))
        alpha = np.clip(
            gaussian_filter(alpha.astype(np.float32), sigma=sigma),
            0, 255,
        ).astype(np.uint8)
        print(f"[rmbg] alpha-blur sigma={sigma:.2f}", flush=True)
    except Exception as e:
        print(f"[rmbg] alpha-blur failed: {e!r}", flush=True)

    alpha_img = Image.fromarray(alpha, mode="L")

    # RGB color decontamination: extend inner-subject colors OUTWARD across
    # the alpha boundary using nearest-neighbor distance transform. Without
    # this, the AA-blurred edge has partial-alpha pixels whose UNDERLYING RGB
    # is the original photo's BACKGROUND (often white/light). When composited
    # against any other color, those partial-alpha pixels show as a HALO
    # (the "wings" / "white cloud" around full-body subjects on light bg —
    # reported by user on a pillow full-body order, May 2026).
    # After extension, RGB beyond the binary mask is filled with the closest
    # opaque skin/fur/clothing color, so the blurred alpha edge transitions
    # over CONTINUOUS subject color — no halo. Same fix already proven in
    # smartcrop_server.py /face-parse for the face-cutout banner.
    rgb_arr = np.array(img.convert("RGB"))
    try:
        from scipy.ndimage import distance_transform_edt
        if cleaned_bool.any():
            _, idx = distance_transform_edt(~cleaned_bool, return_indices=True)
            rgb_arr = rgb_arr[idx[0], idx[1]]
            print("[rmbg] rgb-decontam: nearest-FG color extended into bg (no halo)", flush=True)
    except Exception as e:
        print(f"[rmbg] rgb-decontam failed (non-fatal): {e!r}", flush=True)

    rgba = Image.fromarray(rgb_arr, mode="RGB").convert("RGBA")
    rgba.putalpha(alpha_img)

    # Alpha-trim: crop to the subject's alpha bbox + a small padding so the
    # subject fills the canvas tightly. Without this, downstream `fit:contain`
    # exports (e.g. 4000×4000 print-front) and PSD smart-object replacement
    # render the subject tiny in a sea of transparent padding because the
    # untrimmed RGBA still has the SOURCE photo's full canvas dimensions.
    bbox = alpha_img.getbbox()
    trim_pct = 0.0
    if bbox is not None:
        bx1, by1, bx2, by2 = bbox
        bw = bx2 - bx1
        bh = by2 - by1
        # 2% padding on each side keeps anti-aliased edges and drop-shadow
        # halo from being shaved by the bbox-tight crop.
        pad_x = int(bw * 0.02)
        pad_y = int(bh * 0.02)
        cx1 = max(0, bx1 - pad_x)
        cy1 = max(0, by1 - pad_y)
        cx2 = min(w, bx2 + pad_x)
        cy2 = min(h, by2 + pad_y)
        rgba = rgba.crop((cx1, cy1, cx2, cy2))
        trim_pct = 100.0 * (1.0 - (rgba.size[0] * rgba.size[1]) / float(max(1, w * h)))
        print(
            f"[rmbg] alpha-trim from={w}x{h} to={rgba.size[0]}x{rgba.size[1]} "
            f"saved={trim_pct:.1f}%",
            flush=True,
        )

    # Canvas-fit upscale: ensure max dimension is at least TARGET_MAX_DIM (2048).
    # `placedLayerReplaceContents` in Photoshop pastes the new file at NATIVE
    # pixel size, not scaled to the SO's original bounds. A 230×407 trimmed
    # kitten plopped into a 2000×2000 PSD shows as a postage stamp because
    # PS does not auto-scale to fill the SO. Pre-scaling here guarantees the
    # mockup fills the canvas regardless of how aggressive the alpha-trim was.
    # We use BICUBIC (PIL Image.LANCZOS) which is sharp but doesn't introduce
    # AI hallucinations — the actual upscale step (Real-ESRGAN, optional) runs
    # later if the buyer opted into "+Image Beautification".
    TARGET_MAX_DIM = 2048
    cur_w, cur_h = rgba.size
    cur_max = max(cur_w, cur_h)
    if cur_max < TARGET_MAX_DIM:
        scale = TARGET_MAX_DIM / float(cur_max)
        new_w = int(round(cur_w * scale))
        new_h = int(round(cur_h * scale))
        rgba = rgba.resize((new_w, new_h), Image.LANCZOS)
        print(
            f"[rmbg] canvas-fit upscale from={cur_w}x{cur_h} to={new_w}x{new_h} "
            f"scale={scale:.2f}x",
            flush=True,
        )

    out_w, out_h = rgba.size
    rgba.save(out_path, "PNG")
    return {
        "ok": True,
        "output": str(out_path),
        "size": [out_w, out_h],
        "source_size": [w, h],
        "components": n_total,
        "dropped": n_dropped,
        "alpha_trim_pct": round(trim_pct, 2),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=RMBG_PORT)
