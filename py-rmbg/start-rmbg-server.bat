@echo off
REM Start the RMBG-2.0 FastAPI server on localhost:5001.
REM First run downloads the model (~1.5GB) to %USERPROFILE%\.cache\huggingface\.
setlocal

REM Load HF_TOKEN / HF_HOME from ../.env if not already set in the environment.
if exist "%~dp0..\.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0..\.env") do (
    if /i "%%A"=="HF_TOKEN" if "%HF_TOKEN%"=="" set "HF_TOKEN=%%B"
    if /i "%%A"=="HF_HOME"  if "%HF_HOME%"==""  set "HF_HOME=%%B"
  )
)

REM Keep the model cache off C: (it is full) unless HF_HOME was provided.
if "%HF_HOME%"=="" set "HF_HOME=%~dp0..\.hf-cache"

if "%HF_TOKEN%"=="" (
  echo [start] WARNING: HF_TOKEN not set - the gated RMBG-2.0 model may fail to download.
)
echo [start] HF_HOME=%HF_HOME%

cd /d "%~dp0"

REM Use the venv's Python (has torch+cu128 / transformers / RMBG deps). Falling
REM back to system `python` runs the WRONG interpreter (CPU torch, no HF_TOKEN) and
REM fails with a 401 gated-repo error.
if exist "%~dp0.venv\Scripts\python.exe" (
  "%~dp0.venv\Scripts\python.exe" rmbg_server.py
) else (
  echo [start] ERROR: venv not found at %~dp0.venv - create it first:
  echo         py -3.14 -m venv .venv ^&^& .venv\Scripts\python -m pip install -r requirements.txt
  echo         ^(plus torch: pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128^)
  pause
)
