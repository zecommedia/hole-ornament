# RMBG-2.0 server

Local background-removal HTTP service (FastAPI) used by the hole-ornament
pipeline's step 2 (`tách nền` → transparent cutout). Runs `briaai/RMBG-2.0` on
GPU (CUDA) if available, else CPU.

## Setup

```bash
cd py-rmbg
python -m venv .venv && .venv\Scripts\activate        # Windows (or: source .venv/bin/activate)
# install torch matching your CUDA (or CPU build):
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt
```

## Run

```bash
start-rmbg-server.bat          # Windows — loads HF_TOKEN from ../.env
# or
python rmbg_server.py
```

Listens on `http://127.0.0.1:5001` by default (override with `RMBG_PORT`). Point
the Node app at it via `RMBG_URL` in `../.env`. First run downloads the model
(~1.5GB) to your HuggingFace cache — set `HF_TOKEN` (the model is gated).

## API

- `GET  /health` → `{ ok, device, size }`
- `POST /rmbg`  `{ input_path, output_path }` → writes a transparent PNG, returns `{ ok, size }`

Env: `RMBG_PORT` (5001), `RMBG_DEVICE` (cuda|cpu, auto), `RMBG_SIZE` (1024), `HF_TOKEN`.
