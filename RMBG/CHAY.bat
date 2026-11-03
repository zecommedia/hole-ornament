@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ===================================================================
rem                      TACH NEN CLIPART  -  CHAY.bat
rem  Bam dup file nay. Moi anh .jpg/.png trong thu muc se duoc xu ly.
rem
rem  Muon chinh chat luong: sua cac dong SET ngay ben duoi roi luu lai.
rem ===================================================================

rem --- BIEN (do rong dai khu rang cua, tinh bang pixel) --------------
rem  Thap  = bien sac, de lo rang cua
rem  Cao   = bien muot, nhung qua cao thi lo mau nen o vien
rem  3.5 = da do khop voi ban Photoroom
set EDGESOFT=3.5

rem --- DANG DOC ALPHA -----------------------------------------------
rem  0 = doc thang (co goc gay o hai dau dai)
rem  1 = smoothstep: vai mem hai dau, doc o giua (giong ban ve that)
set SMOOTHSTEP=1

rem --- VIEN TRANG kieu die-cut sticker -------------------------------
rem  Do rong vien tinh bang mm. Dat 0 de KHONG ve vien.
set VIEN_MM=0.5
set VIEN_MAU=White

rem  Do phan giai in, dung de quy doi mm -> pixel. Chuan POD la 300.
rem  Anh 2048px @300DPI  =>  kho in 17.3 cm
set DPI=300

rem ===================================================================


:MENU
cls
echo.
echo   ============================================
echo      TACH NEN CLIPART
echo   ============================================
echo      EdgeSoft = %EDGESOFT%    Smoothstep = %SMOOTHSTEP%
echo      Vien     = %VIEN_MM% mm (%VIEN_MAU%)  @ %DPI% DPI
echo   --------------------------------------------
echo.
echo      [1]  Tach nen                 -^> output\
echo      [2]  Tach nen + vien trang    -^> output_vien\
echo      [3]  Ca hai
echo.
echo      [4]  Chay thu nhieu muc EdgeSoft de so sanh
echo      [5]  Chay thu ca doc thang lan smoothstep
echo.
echo      [0]  Thoat
echo.
rem  Dung CHOICE thay SET /P: bam 1 phim la chay, va khi dau vao bi chuyen
rem  huong (khong co ban phim) thi CHOICE tra ve loi -> thoat han, khong
rem  bi ket vong lap vo tan.
choice /c 123450 /n /m "   Bam phim chon: "
if errorlevel 255 goto CUOI
if errorlevel 6 goto CUOI
if errorlevel 5 goto THU_SMOOTH
if errorlevel 4 goto THU_SOFT
if errorlevel 3 goto CAHAI
if errorlevel 2 goto VIEN
if errorlevel 1 goto NEN
goto CUOI


:NEN
echo.
echo   --- Tach nen (khong vien) ---
powershell -ExecutionPolicy Bypass -File "%~dp0Remove-WhiteBg.ps1" ^
  -Path "%~dp0." -OutDir "%~dp0output" ^
  -EdgeSoft %EDGESOFT% -Smoothstep %SMOOTHSTEP%
goto XONG


:VIEN
echo.
echo   --- Tach nen + vien trang %VIEN_MM% mm ---
powershell -ExecutionPolicy Bypass -File "%~dp0Remove-WhiteBg.ps1" ^
  -Path "%~dp0." -OutDir "%~dp0output_vien" ^
  -EdgeSoft %EDGESOFT% -Smoothstep %SMOOTHSTEP% ^
  -OutlineMm %VIEN_MM% -OutlineColor %VIEN_MAU% -Dpi %DPI%
goto XONG


:CAHAI
call :NEN_QUIET
call :VIEN_QUIET
goto XONG

:NEN_QUIET
echo.
echo   --- [1/2] Tach nen (khong vien) ---
powershell -ExecutionPolicy Bypass -File "%~dp0Remove-WhiteBg.ps1" ^
  -Path "%~dp0." -OutDir "%~dp0output" ^
  -EdgeSoft %EDGESOFT% -Smoothstep %SMOOTHSTEP%
exit /b

:VIEN_QUIET
echo.
echo   --- [2/2] Tach nen + vien trang %VIEN_MM% mm ---
powershell -ExecutionPolicy Bypass -File "%~dp0Remove-WhiteBg.ps1" ^
  -Path "%~dp0." -OutDir "%~dp0output_vien" ^
  -EdgeSoft %EDGESOFT% -Smoothstep %SMOOTHSTEP% ^
  -OutlineMm %VIEN_MM% -OutlineColor %VIEN_MAU% -Dpi %DPI%
exit /b


:THU_SOFT
echo.
echo   --- Thu nhieu muc EdgeSoft (Smoothstep = %SMOOTHSTEP%) ---
powershell -ExecutionPolicy Bypass -File "%~dp0Test-EdgeSoft.ps1" ^
  -Soft 2.0,3.0,3.5,4.5 -Smooth %SMOOTHSTEP%
goto XONG


:THU_SMOOTH
echo.
echo   --- Thu doc thang (0) vs smoothstep (1), EdgeSoft = %EDGESOFT% ---
powershell -ExecutionPolicy Bypass -File "%~dp0Test-EdgeSoft.ps1" ^
  -Soft %EDGESOFT% -Smooth 0,1
goto XONG


:XONG
echo.
echo   ============================================
echo      XONG
echo   ============================================
echo.
pause
goto MENU

:CUOI
endlocal
