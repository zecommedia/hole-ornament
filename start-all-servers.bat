@echo off
setlocal
title Start ALL servers (zaa-image + zecom-pod + kemono-pod + project-O)

REM ── Paths are derived from this .bat's folder (%~dp0 = ...\project-O-main\) so
REM    there are no hard-coded Vietnamese paths to break the encoding. ──
set "OH=%~dp0"
if "%OH:~-1%"=="\" set "OH=%OH:~0,-1%"
set "ADS=%OH%\..\project ads"
set "DASH=%OH%\..\Project dashboard"
set "RMBG=%OH%\py-rmbg"
set "TUNNEL_CFG=%USERPROFILE%\.cloudflared\config.yml"
set "TUNNEL_NAME=zaa-image"

echo.
echo === Pre-flight checks ===
if not exist "%ADS%\amazon-ads-mcp-v4.js" echo [WARN] khong thay %ADS%\amazon-ads-mcp-v4.js
if not exist "%DASH%\package.json"        echo [WARN] khong thay %DASH%\package.json
if not exist "%DASH%\.env.kemono"         echo [WARN] khong thay %DASH%\.env.kemono - se bo qua dashboard kemono :3001
if not exist "%OH%\server.js"             echo [WARN] khong thay %OH%\server.js
if not exist "%ADS%\cloudflared.exe"      echo [WARN] khong thay %ADS%\cloudflared.exe
if not exist "%TUNNEL_CFG%"               echo [WARN] khong thay %TUNNEL_CFG%

echo.
echo === Stopping existing instances (ports 3456/3000/3001/4500/5001 + cloudflared) ===
for %%P in (3456 3000 3001 4500 5001) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%%P ^| findstr LISTENING') do taskkill /PID %%a /F >nul 2>&1
)
REM NOTE: kills ALL cloudflared.exe (incl. the auto-restarting Windows service) -
REM matches the existing restart-all.bat behavior.
taskkill /F /IM cloudflared.exe >nul 2>&1
echo Waiting 3s for sockets to release...
timeout /t 3 /nobreak >nul

echo.
echo [1/6] MCP server (zaa-image)  :3456 ...
start "MCP Server (zaa) :3456" /D "%ADS%" cmd /k "node --max-old-space-size=512 amazon-ads-mcp-v4.js"

echo [2/6] Dashboard (zecom-pod)   :3000 ...
start "Dashboard (zecom-pod) :3000" /D "%DASH%" cmd /k "npm run dev"

REM Same codebase as zecom, second Seller Central account: STORE_ID=kemono picks
REM its config, its data\kemono\ directory and its own .next-kemono build output.
REM Skipped (not fatal) when .env.kemono is missing - it has no credentials then.
REM No parentheses in these echo lines: an unescaped ')' would close the if-block
REM early and cmd fails with ":3001 was unexpected at this time".
if exist "%DASH%\.env.kemono" (
  echo [3/6] Dashboard kemono-pod    :3001 ...
  start "Dashboard (kemono-pod) :3001" /D "%DASH%" cmd /k "npm run dev:kemono"
) else (
  echo [3/6] BO QUA dashboard kemono :3001 - thieu .env.kemono
)

echo [4/6] Hole-Ornament API       :4500 ...
start "Hole-Ornament API :4500" /D "%OH%" cmd /k "node server.js"

echo [5/6] RMBG server             :5001 ...
start "RMBG (project-O) :5001" /D "%RMBG%" cmd /k "start-rmbg-server.bat"

echo Waiting 8s for origins to bind before the tunnel connects...
timeout /t 8 /nobreak >nul

echo [6/6] Cloudflared tunnel (zaa-image) ...
start "Cloudflare Tunnel (zaa)" /D "%ADS%" cmd /k ".\cloudflared.exe tunnel --config ""%TUNNEL_CFG%"" run %TUNNEL_NAME%"

echo.
echo === All started in separate windows ===
echo   zaa-image.auto-agents.org            -^> http://localhost:3456
echo   zecom-pod-dashboard.auto-agents.org  -^> http://localhost:3000
echo   kemono-pod-dashboard.auto-agents.org -^> http://localhost:3001
echo   pj-oh.auto-agents.org                -^> http://localhost:4500  (RMBG :5001)
echo.
echo Dong cac cua so do, hoac chay kill-all, de tat.
echo.
pause
endlocal
