<#
.SYNOPSIS
    Sinh anh kiem dinh chat luong tach nen: moi vung bien hiem ra 1 dai
    [GOC | tren NEN HONG | tren NEN TOI], phong to de soi loi.
    Nen toi lo ra vien trang sot; nen hong lo ra cho bi lem / thung.
#>
[CmdletBinding()]
param(
    # Thu muc chua PNG da tach nen
    [Parameter(Mandatory)] [string] $OutDir,
    # Thu muc goc chua anh nguon (jpeg/png); mac dinh = thu muc chua script
    [string] $SrcDir = $PSScriptRoot,
    # Thu muc xuat anh QA
    [Parameter(Mandatory)] [string] $QaDir
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# vung soi: basename -> @(x, y, w, h, ten)
$REGIONS = @{
  'Rotate_text_mirror_effect_2K_202607282115' = @(
    @(750,565,90,90,'ngoc-trai-trai'),
    @(1150,470,200,250,'ong-chi-phai'),
    @(920,545,200,150,'vuong-mien-vang'),
    @(690,545,260,120,'soi-chi-ngang'),
    @(790,860,420,270,'lo-chu-C'),
    @(425,1370,200,170,'vien-hat-ngoc'),
    @(1345,665,200,210,'banh-da-phai'),
    @(470,1120,180,180,'mep-chan-trai')
  )
  'Rotate_text_Greece_2026_2K_202607282115' = @(
    @(615,955,180,235,'khe-mu'),
    @(495,1035,185,185,'qua-bong'),
    @(660,655,430,270,'long-mu-chu'),
    @(415,1430,240,200,'vay-trai'),
    @(1255,1120,240,240,'vay-phai'),
    @(1080,780,260,180,'mep-mu-phai')
  )
}

if (-not (Test-Path $QaDir)) { New-Item -ItemType Directory -Path $QaDir -Force | Out-Null }
$font  = New-Object System.Drawing.Font('Segoe UI', 20, [System.Drawing.FontStyle]::Bold)
$MAGENTA = [System.Drawing.Color]::FromArgb(255,0,170)
$DARK    = [System.Drawing.Color]::FromArgb(16,24,40)

function New-Composite([System.Drawing.Bitmap]$png, [System.Drawing.Color]$bg) {
    $c = New-Object System.Drawing.Bitmap($png.Width, $png.Height)
    $g = [System.Drawing.Graphics]::FromImage($c)
    $g.Clear($bg); $g.DrawImage($png, 0, 0, $png.Width, $png.Height); $g.Dispose()
    return $c
}

foreach ($base in $REGIONS.Keys) {
    $pngPath = Join-Path $OutDir "$base.png"
    if (-not (Test-Path $pngPath)) { Write-Warning "Bo qua (chua co): $pngPath"; continue }
    $srcPath = Get-ChildItem $SrcDir -File | Where-Object { $_.BaseName -eq $base -and $_.Extension -match '^\.(jpe?g|png)$' } | Select-Object -First 1
    $png  = New-Object System.Drawing.Bitmap($pngPath)
    $orig = New-Object System.Drawing.Bitmap($srcPath.FullName)
    $onMag  = New-Composite $png $MAGENTA
    $onDark = New-Composite $png $DARK
    $png.Dispose()

    # anh toan canh tren nen toi (cho critic soi tong the)
    $full = New-Object System.Drawing.Bitmap(1024,1024)
    $gf = [System.Drawing.Graphics]::FromImage($full)
    $gf.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gf.DrawImage($onDark, 0, 0, 1024, 1024); $gf.Dispose()
    $full.Save((Join-Path $QaDir "$($base)__FULL-dark.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $full.Dispose()

    foreach ($r in $REGIONS[$base]) {
        $rx=$r[0]; $ry=$r[1]; $rw=$r[2]; $rh=$r[3]; $name=$r[4]
        $z = [Math]::Max(3, [Math]::Min(8, [Math]::Floor(560 / [Math]::Max($rw,$rh))))
        $cw = $rw*$z; $ch = $rh*$z
        $pad=10; $bar=36
        $strip = New-Object System.Drawing.Bitmap(($cw*3+$pad*4), ($ch+$bar+$pad*2))
        $g = [System.Drawing.Graphics]::FromImage($strip)
        $g.Clear([System.Drawing.Color]::FromArgb(24,24,28))
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $panels = @(@($orig,'GOC'), @($onMag,'NEN HONG'), @($onDark,'NEN TOI'))
        for ($i=0; $i -lt 3; $i++) {
            $x = $pad + $i*($cw+$pad)
            $g.DrawString($panels[$i][1], $font, [System.Drawing.Brushes]::White, [single]$x, [single]6)
            $g.DrawImage($panels[$i][0], (New-Object System.Drawing.Rectangle($x, ($bar+$pad), $cw, $ch)), `
                         $rx, $ry, $rw, $rh, [System.Drawing.GraphicsUnit]::Pixel)
        }
        $g.Dispose()
        $strip.Save((Join-Path $QaDir "$($base)__$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $strip.Dispose()
        Write-Host "QA: $base / $name (zoom x$z)"
    }
    $orig.Dispose(); $onMag.Dispose(); $onDark.Dispose()
}
Write-Host "Xong -> $QaDir" -ForegroundColor Cyan
