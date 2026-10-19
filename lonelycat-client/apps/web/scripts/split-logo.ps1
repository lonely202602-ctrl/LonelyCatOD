# 把整版 logo（猫 + LonelyCatOD 文字）按透明空隙裁开，输出只含图案的上半部分。
# 算法：按 alpha 逐行扫描，从底部向上找出文字带（最底部的内容带），其上方的空隙之后全是图案。
# 用法: powershell -File split-logo.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# 脚本位于 apps/web/scripts，资源在其上一级 src/assets；路径一律相对定位，避免中文路径的编码坑
$root = Split-Path $PSScriptRoot
$pairs = @(
  @{ Src = "$root\src\assets\logo-full-on-dark.png";  MarkOut = "$root\src\assets\logo-mark-on-dark.png" },
  @{ Src = "$root\src\assets\logo-full-on-light.png"; MarkOut = "$root\src\assets\logo-mark-on-light.png" }
)

foreach ($p in $pairs) {
  $bmp = [System.Drawing.Bitmap]::FromFile($p.Src)
  $w = $bmp.Width; $h = $bmp.Height
  Write-Host "[$(Split-Path $p.Src -Leaf)] size=${w}x${h}"

  # 逐行扫 alpha，得到 rowHasContent
  $rect = $bmp.LockBits((New-Object System.Drawing.Rectangle 0, 0, $w, $h), [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $rect.Stride
  $bytes = New-Object byte[] ($stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($rect.Scan0, $bytes, 0, $bytes.Length)
  $bmp.UnlockBits($rect)
  $rowHasContent = New-Object bool[] $h
  for ($y = 0; $y -lt $h; $y++) {
    $found = $false
    $rowBase = $y * $stride
    for ($x = 0; $x -lt $w; $x++) {
      if ($bytes[$rowBase + $x * 4 + 3] -gt 8) { $found = $true; break }
    }
    $rowHasContent[$y] = $found
  }

  # 从底部向上：文字带 = 最底部的内容带
  $y = $h - 1
  while ($y -ge 0 -and -not $rowHasContent[$y]) { $y-- }
  $textBottom = $y
  while ($y -ge 0 -and $rowHasContent[$y]) { $y-- }
  $textTop = $y + 1
  # 跳过文字与图案之间的空隙
  while ($y -ge 0 -and -not $rowHasContent[$y]) { $y-- }
  $artBottom = $y
  $artTop = 0
  while ($artTop -lt $h -and -not $rowHasContent[$artTop]) { $artTop++ }
  if ($artBottom -le $artTop) { throw "图案区域解析失败" }

  # 横向范围：只扫图案区域
  $minX = $w; $maxX = 0
  for ($yy = $artTop; $yy -le $artBottom; $yy++) {
    $rowBase = $yy * $stride
    for ($xx = 0; $xx -lt $w; $xx++) {
      if ($bytes[$rowBase + $xx * 4 + 3] -gt 8) {
        if ($xx -lt $minX) { $minX = $xx }
        if ($xx -gt $maxX) { $maxX = $xx }
      }
    }
  }

  Write-Host "  art: y=$artTop..$artBottom x=$minX..$maxX ; text: y=$textTop..$textBottom"
  $cw = $maxX - $minX + 1
  $ch = $artBottom - $artTop + 1
  $mark = New-Object System.Drawing.Bitmap $cw, $ch
  $g = [System.Drawing.Graphics]::FromImage($mark)
  $g.DrawImage($bmp, (New-Object System.Drawing.Rectangle 0, 0, $cw, $ch), (New-Object System.Drawing.Rectangle $minX, $artTop, $cw, $ch), [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $mark.Save($p.MarkOut, [System.Drawing.Imaging.ImageFormat]::Png)
  $mark.Dispose()
  Write-Host "  -> saved $(Split-Path $p.MarkOut -Leaf) (${cw}x${ch})"
  $bmp.Dispose()
}
Write-Host "done"
