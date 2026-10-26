# 吃饭记图标生成：豆沙绿底 + 白碗 + 热气
Add-Type -AssemblyName System.Drawing
$outDir = Join-Path $PSScriptRoot "..\icons"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$bgHex = '#5C8663'
foreach ($size in 180, 192, 512) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $bg = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($bgHex))
  $white = [System.Drawing.Brushes]::White
  $g.FillRectangle($bg, 0, 0, $size, $size)
  $s = [double]$size

  # 热气（两缕白色圆头弧线）
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [single]($s * 0.045))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawArc($pen, [single]($s*0.355), [single]($s*0.12), [single]($s*0.09), [single]($s*0.18), 190, 160)
  $g.DrawArc($pen, [single]($s*0.555), [single]($s*0.12), [single]($s*0.09), [single]($s*0.18), 190, 160)

  # 碗身（下半椭圆）
  $g.FillPie($white, [single]($s*0.22), [single]($s*0.42), [single]($s*0.56), [single]($s*0.46), 0, 180)
  # 碗沿
  $g.FillEllipse($white, [single]($s*0.18), [single]($s*0.60), [single]($s*0.64), [single]($s*0.10))
  # 碗口（背景色内凹，做出开口感）
  $g.FillEllipse($bg, [single]($s*0.215), [single]($s*0.625), [single]($s*0.57), [single]($s*0.05))

  $g.Dispose()
  $bmp.Save((Join-Path $outDir "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
Write-Output "icons generated in $outDir"
