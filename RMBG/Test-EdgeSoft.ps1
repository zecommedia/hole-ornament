<#
.SYNOPSIS
    Chay thu nhieu muc EdgeSoft / Smoothstep tren MOT anh, roi ghep thanh
    anh so sanh de chon bang mat + bang so lieu.

.DESCRIPTION
    Voi moi cau hinh:
      - xuat PNG rieng vao  test-edgesoft\<nhan>\
      - do "% pixel bien mem" va (neu co anh chuan) RMS alpha so voi anh chuan
    Cuoi cung ghep 1 dai so sanh tren NEN HONG va 1 tren NEN TOI, phong to
    vung bien de nhin ro rang cua / do muot.

    Anh chuan: dat 1 file ten *-Photoroom.png (hoac *-ref.png) canh anh nguon.

.EXAMPLE
    .\Test-EdgeSoft.ps1
    .\Test-EdgeSoft.ps1 -Soft 2,3,4 -Smooth 0,1
    .\Test-EdgeSoft.ps1 -Region 1428,668,52,52 -Zoom 15
#>
[CmdletBinding()]
param(
    # Anh nguon de thu (mac dinh: anh dau tien trong thu muc script, bo qua
    # cac file co duoi -Photoroom / -ref)
    [string] $Image,

    # Cac muc EdgeSoft can thu (do rong dai khu rang cua, tinh bang pixel)
    [double[]] $Soft = @(2.0, 3.0, 3.5, 4.5),

    # Cac muc Smoothstep can thu (0 = doc thang, 1 = smoothstep)
    [double[]] $Smooth = @(1),

    # Anh chuan de doi chieu (mac dinh tu tim *-Photoroom.png / *-ref.png)
    [string] $Ref,

    # Vung phong to: x,y,rong,cao. Bo trong = tu do tim cho nhieu bien nhat.
    [int[]] $Region,

    # Muc phong to
    [int] $Zoom = 14,

    # Thu muc xuat
    [string] $OutRoot
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$here = $PSScriptRoot
if (-not $OutRoot) { $OutRoot = Join-Path $here 'test-edgesoft' }
$tool = Join-Path $here 'Remove-WhiteBg.ps1'
if (-not (Test-Path -LiteralPath $tool)) { throw "Khong thay Remove-WhiteBg.ps1 canh script nay" }

# ---------- chon anh nguon + anh chuan ----------
if (-not $Image) {
    $cand = Get-ChildItem -LiteralPath $here -File |
            Where-Object { $_.Extension -match '^\.(jpe?g|png)$' -and $_.BaseName -notmatch '(?i)(-photoroom|-ref|_ref)$' } |
            Select-Object -First 1
    if (-not $cand) { throw "Khong thay anh nguon nao trong $here" }
    $Image = $cand.FullName
}
if (-not $Ref) {
    $r = Get-ChildItem -LiteralPath $here -File |
         Where-Object { $_.Extension -eq '.png' -and $_.BaseName -match '(?i)(-photoroom|-ref|_ref)$' } |
         Select-Object -First 1
    if ($r) { $Ref = $r.FullName }
}
Write-Host ""
Write-Host "Anh nguon : $Image" -ForegroundColor Cyan
if ($Ref) { Write-Host "Anh chuan : $Ref" -ForegroundColor Cyan }
else      { Write-Host "Anh chuan : (khong co - bo qua cot RMS)" -ForegroundColor DarkGray }
Write-Host ""

function Read-Argb([string]$path) {
    $bm = New-Object System.Drawing.Bitmap($path)
    $lock = $bm.LockBits((New-Object System.Drawing.Rectangle(0,0,$bm.Width,$bm.Height)),
            [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $arr = New-Object 'byte[]' ($bm.Width * $bm.Height * 4)
    [System.Runtime.InteropServices.Marshal]::Copy($lock.Scan0, [byte[]]$arr, 0, $arr.Length)
    $bm.UnlockBits($lock)
    $res = @{ w = $bm.Width; h = $bm.Height; a = $arr }
    $bm.Dispose()
    return $res
}

$refBuf = $null
if ($Ref -and (Test-Path -LiteralPath $Ref)) { $refBuf = Read-Argb $Ref }

# ---------- chay tung cau hinh ----------
$runs = @()
foreach ($sm in $Smooth) {
    foreach ($es in $Soft) {
        $label = "Soft{0}_Sm{1}" -f $es.ToString('0.0').Replace('.',''), $sm.ToString('0.0').Replace('.','')
        $od = Join-Path $OutRoot $label
        & $tool -Path $Image -OutDir $od -EdgeSoft $es -Smoothstep $sm -NoPreview | Out-Null
        $png = Join-Path $od ([System.IO.Path]::GetFileNameWithoutExtension($Image) + '.png')
        $d = Read-Argb $png
        $mid = 0
        for ($k = 3; $k -lt $d.a.Length; $k += 4) { $v = $d.a[$k]; if ($v -gt 0 -and $v -lt 255) { $mid++ } }
        $rms = $null
        if ($refBuf -and $refBuf.w -eq $d.w -and $refBuf.h -eq $d.h) {
            [double]$sse = 0
            for ($k = 3; $k -lt $d.a.Length; $k += 4) {
                $dv = [int]$d.a[$k] - [int]$refBuf.a[$k]
                if ($dv -ne 0) { $sse += [double]($dv * $dv) }
            }
            $rms = [math]::Round([Math]::Sqrt($sse / ($d.w * $d.h)), 3)
        }
        $runs += [pscustomobject]@{
            Nhan = "Soft=$es Sm=$sm"; File = $png
            BienMem = [math]::Round(100.0 * $mid / ($d.w * $d.h), 3)
            RMS = $rms
        }
        $msg = "  {0,-16} bien mem = {1,6}%" -f "Soft=$es Sm=$sm", ([math]::Round(100.0*$mid/($d.w*$d.h),3))
        if ($null -ne $rms) { $msg += "   RMS vs chuan = $rms" }
        Write-Host $msg
    }
}

# ---------- tu tim vung nhieu bien nhat neu chua chi dinh ----------
if (-not $Region -or $Region.Count -ne 4) {
    $d0 = Read-Argb $runs[0].File
    $w = $d0.w; $h = $d0.h; $win = 60; $step = 40
    $bestN = -1; $bx = 0; $by = 0
    for ($y = 0; $y -lt $h - $win; $y += $step) {
        for ($x = 0; $x -lt $w - $win; $x += $step) {
            $n = 0
            for ($yy = $y; $yy -lt $y + $win; $yy += 4) {
                for ($xx = $x; $xx -lt $x + $win; $xx += 4) {
                    $v = $d0.a[(($yy * $w) + $xx) * 4 + 3]
                    if ($v -gt 10 -and $v -lt 245) { $n++ }
                }
            }
            if ($n -gt $bestN) { $bestN = $n; $bx = $x; $by = $y }
        }
    }
    $Region = @($bx, $by, $win, $win)
    Write-Host ""
    Write-Host ("Vung phong to tu chon: {0},{1} ({2}x{3})" -f $Region[0],$Region[1],$Region[2],$Region[3]) -ForegroundColor DarkGray
}

# ---------- ghep anh so sanh ----------
$panels = @()
if ($refBuf) { $panels += ,@($Ref, 'CHUAN (Photoroom)') }
foreach ($r in $runs) { $panels += ,@($r.File, $r.Nhan) }

$rx = $Region[0]; $ry = $Region[1]; $rw = $Region[2]; $rh = $Region[3]
$cw = $rw * $Zoom; $ch = $rh * $Zoom; $pad = 8; $bar = 30
$fnt = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold)
$cols = [int][Math]::Min(4, $panels.Count)
$rows = [int][Math]::Ceiling($panels.Count / [double]$cols)
# Tinh san kich thuoc: neu de bieu thuc truc tiep trong New-Object thi
# PowerShell tach "+ $pad" thanh doi so rieng -> loi PixelFormat.
$totW = [int]($cw * $cols + $pad * ($cols + 1))
$totH = [int](($ch + $bar + $pad) * $rows + $pad)

foreach ($bgSet in @(@([System.Drawing.Color]::FromArgb(255,0,170), 'nen-hong'),
                     @([System.Drawing.Color]::FromArgb(20,24,34), 'nen-toi'))) {
    $out = New-Object System.Drawing.Bitmap($totW, $totH)
    $g = [System.Drawing.Graphics]::FromImage($out)
    $g.Clear([System.Drawing.Color]::FromArgb(24,24,28))
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    for ($i = 0; $i -lt $panels.Count; $i++) {
        $src = New-Object System.Drawing.Bitmap($panels[$i][0])
        $draw = New-Object System.Drawing.Bitmap($src.Width, $src.Height)
        $gc = [System.Drawing.Graphics]::FromImage($draw)
        $gc.Clear($bgSet[0]); $gc.DrawImage($src, 0, 0, $src.Width, $src.Height); $gc.Dispose(); $src.Dispose()
        $col = $i % $cols; $row = [Math]::Floor($i / $cols)
        $x = $pad + $col*($cw+$pad); $y = $pad + $bar + $row*($ch+$bar+$pad)
        $br = if ($panels[$i][1] -like 'CHUAN*') { [System.Drawing.Brushes]::Gold } else { [System.Drawing.Brushes]::White }
        $g.DrawString($panels[$i][1], $fnt, $br, [single]$x, [single]($y-$bar+3))
        $g.DrawImage($draw, (New-Object System.Drawing.Rectangle($x, $y, $cw, $ch)),
                     $rx, $ry, $rw, $rh, [System.Drawing.GraphicsUnit]::Pixel)
        $draw.Dispose()
    }
    $g.Dispose()
    $dst = Join-Path $OutRoot ("_SO-SANH_" + $bgSet[1] + ".png")
    $out.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png); $out.Dispose()
    Write-Host "  -> $dst" -ForegroundColor Green
}

Write-Host ""
$runs | Format-Table Nhan, BienMem, RMS -AutoSize
Write-Host "Mo 2 file _SO-SANH_*.png trong $OutRoot de chon." -ForegroundColor Cyan
