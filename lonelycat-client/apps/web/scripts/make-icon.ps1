# 生成 Electron 窗口图标：白色猫标志放在深色圆角方块上，浅色/深色标题栏和任务栏都清晰。
# 用法: powershell -File make-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot
$markPath = "$root\src\assets\logo-mark-on-dark.png"
$outPath = "$root\public\icon.png"

$size = 256
$radius = 56
$bg = [System.Drawing.Color]::FromArgb(255, 24, 24, 27)   # #18181b

$icon = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($icon)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

# 圆角矩形路径
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d - 1, 0, $d, $d, 270, 90)
$path.AddArc($size - $d - 1, $size - $d - 1, $d, $d, 0, 90)
$path.AddArc(0, $size - $d - 1, $d, $d, 90, 90)
$path.CloseFigure()
$brush = New-Object System.Drawing.SolidBrush $bg
$g.FillPath($brush, $path)
$brush.Dispose()
$path.Dispose()

# 白色标志居中，占约 76%
$mark = [System.Drawing.Bitmap]::FromFile($markPath)
$target = [int]($size * 0.76)
$ratio = $mark.Height / $mark.Width
$mw = $target
$mh = [int]($target * $ratio)
$mx = [int](($size - $mw) / 2)
$my = [int](($size - $mh) / 2)
$g.DrawImage($mark, $mx, $my, $mw, $mh)
$g.Dispose()
$mark.Dispose()

$icon.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$icon.Dispose()
Write-Host "saved $outPath"
