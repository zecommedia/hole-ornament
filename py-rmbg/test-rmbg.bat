@echo off
REM Test the running RMBG server using the venv's Python.
REM   test-rmbg.bat                  -> chi kiem tra /health
REM   test-rmbg.bat anh.png          -> tach nen, luu anh_nobg.png
REM   test-rmbg.bat anh.png out.png
setlocal
cd /d "%~dp0"
if exist "%~dp0.venv\Scripts\python.exe" (
  "%~dp0.venv\Scripts\python.exe" test-rmbg.py %*
) else (
  echo [test] WARNING: venv khong tim thay, dung python he thong.
  python test-rmbg.py %*
)
