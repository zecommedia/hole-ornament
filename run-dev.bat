@echo off
REM ============================================================
REM  Hole Ornament - full dev pipeline launcher
REM  Starts 3 servers, each in its own window:
REM    - rmbg  : Python RMBG-2.0 background remover   (:5001)
REM    - api   : Express backend                       (:4500)
REM    - ui    : Vite + React dev server (hot-reload)  (:5173)
REM  Open http://localhost:5173 once all three are up.
REM ============================================================
setlocal
cd /d "%~dp0"

echo.
echo === Hole Ornament dev pipeline ===
echo.

REM --- Install Node deps if missing ---
if not exist "node_modules" (
    echo [setup] node_modules not found - running npm install...
    call npm install
    if errorlevel 1 (
        echo [error] npm install failed. Aborting.
        pause
        exit /b 1
    )
)

REM --- Warn if .env is missing ---
if not exist ".env" (
    echo [warn] .env not found - copy .env.example to .env and fill V98_API_KEY / HF_TOKEN.
)

echo [start] rmbg  (Python RMBG-2.0)  -^> http://127.0.0.1:5001
start "rmbg"  cmd /k "cd /d "%~dp0py-rmbg" && python rmbg_server.py"

echo [start] api   (Express backend)  -^> http://localhost:4500
start "api"   cmd /k "cd /d "%~dp0" && node server.js"

echo [start] ui    (Vite dev server)  -^> http://localhost:5173
start "ui"    cmd /k "cd /d "%~dp0" && npx vite"

echo.
echo All three servers launched in separate windows.
echo Open  http://localhost:5173  in your browser.
echo (Close each window to stop that server.)
echo.
endlocal
