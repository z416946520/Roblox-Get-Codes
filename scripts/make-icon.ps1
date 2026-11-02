Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root "build"
$assetDir = Join-Path $root "src\renderer\assets"
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null

function New-RoundedRectPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    $pad = $size * 0.035
    $rect = New-Object System.Drawing.RectangleF -ArgumentList @($pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad))
    $radius = $size * 0.22
    $path = New-RoundedRectPath $rect.X $rect.Y $rect.Width $rect.Height $radius

    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList @(
        (New-Object System.Drawing.PointF -ArgumentList @(0, 0)),
        (New-Object System.Drawing.PointF -ArgumentList @($size, $size)),
        [System.Drawing.Color]::FromArgb(255, 27, 35, 68),
        [System.Drawing.Color]::FromArgb(255, 8, 11, 22)
    )
    $g.FillPath($bg, $path)

    # Warm glow in the upper-left corner.
    $glow = New-Object System.Drawing.Drawing2D.GraphicsPath
    $glow.AddEllipse(-$size * 0.35, -$size * 0.45, $size * 1.05, $size * 1.05)
    $glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush -ArgumentList $glow
    $glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(70, 255, 70, 100)
    $glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 70, 100))
    $g.SetClip($path)
    $g.FillPath($glowBrush, $glow)
    $g.ResetClip()

    # Thin border and inner highlight.
    $borderPen = New-Object System.Drawing.Pen -ArgumentList @([System.Drawing.Color]::FromArgb(90, 255, 110, 120), [single][Math]::Max(1.0, $size * 0.012))
    $g.DrawPath($borderPen, $path)
    $innerPath = New-RoundedRectPath ($rect.X + $size * 0.018) ($rect.Y + $size * 0.018) ($rect.Width - $size * 0.036) ($rect.Height - $size * 0.036) ($radius * 0.92)
    $innerPen = New-Object System.Drawing.Pen -ArgumentList @([System.Drawing.Color]::FromArgb(28, 255, 255, 255), [single][Math]::Max(1.0, $size * 0.006))
    $g.DrawPath($innerPen, $innerPath)

    # Letter R.
    $fontName = "Segoe UI Black"
    try {
        $testFont = New-Object System.Drawing.Font -ArgumentList @($fontName, 12)
        $testFont.Dispose()
    } catch {
        $fontName = "Arial Black"
    }
    $fontSize = [single]($size * 0.66)
    $font = New-Object System.Drawing.Font -ArgumentList @($fontName, $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textRect = New-Object System.Drawing.RectangleF -ArgumentList @(0, (-$size * 0.035), $size, $size)

    $shadowBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(120, 0, 0, 0))
    $shadowRect = New-Object System.Drawing.RectangleF -ArgumentList @(0, (-$size * 0.035 + $size * 0.018), $size, $size)
    $g.DrawString("R", $font, $shadowBrush, $shadowRect, $format)

    $textBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList @(
        (New-Object System.Drawing.PointF -ArgumentList @(0, ($size * 0.08))),
        (New-Object System.Drawing.PointF -ArgumentList @($size, ($size * 0.9))),
        [System.Drawing.Color]::FromArgb(255, 255, 214, 184),
        [System.Drawing.Color]::FromArgb(255, 255, 55, 88)
    )
    $g.DrawString("R", $font, $textBrush, $textRect, $format)

    # Small code cursor accent.
    if ($size -ge 32) {
        $barW = $size * 0.18
        $barH = [single][Math]::Max(2.0, $size * 0.035)
        $barX = $size * 0.66
        $barY = $size * 0.71
        $barBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 61, 220, 151))
        $g.FillRectangle($barBrush, $barX, $barY, $barW, $barH)
    }

    $g.Dispose()
    return $bmp
}

# Master PNG used by the window and the in-app header.
$master = New-IconBitmap 512
$master.Save((Join-Path $buildDir "icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$master.Save((Join-Path $assetDir "icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$master.Dispose()

# Multi-size ICO with PNG-compressed entries (Windows Vista+).
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
foreach ($size in $sizes) {
    $bmp = New-IconBitmap $size
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $images += ,@($size, $ms.ToArray())
    $bmp.Dispose()
    $ms.Dispose()
}

$icoPath = Join-Path $buildDir "icon.ico"
$fs = [System.IO.File]::Create($icoPath)
$writer = New-Object System.IO.BinaryWriter($fs)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$images.Count)

$offset = 6 + (16 * $images.Count)
foreach ($image in $images) {
    $size = $image[0]
    $bytes = $image[1]
    $dim = if ($size -ge 256) { 0 } else { $size }
    $writer.Write([byte]$dim)
    $writer.Write([byte]$dim)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$bytes.Length)
    $writer.Write([UInt32]$offset)
    $offset += $bytes.Length
}
foreach ($image in $images) {
    $writer.Write([byte[]]$image[1])
}
$writer.Flush()
$writer.Close()
$fs.Close()

Write-Host "Generated build/icon.png, build/icon.ico and src/renderer/assets/icon.png"
