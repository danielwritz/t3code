param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
[IO.Directory]::CreateDirectory($Destination) | Out-Null
$image = [Drawing.Image]::FromFile($Source)
try {
  $sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
  $frames = @()
  foreach ($size in $sizes) {
    $bitmap = [Drawing.Bitmap]::new($size, $size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($image, 0, 0, $size, $size)
      $stream = [IO.MemoryStream]::new()
      try {
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        $bytes = $stream.ToArray()
        [IO.File]::WriteAllBytes((Join-Path $Destination "$size.png"), $bytes)
        $frames += ,$bytes
      } finally { $stream.Dispose() }
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
  }
  $ico = [IO.BinaryWriter]::new([IO.File]::Create((Join-Path $Destination 'icon.ico')))
  try {
    $ico.Write([uint16]0); $ico.Write([uint16]1); $ico.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
      $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
      $ico.Write([byte]$dimension); $ico.Write([byte]$dimension)
      $ico.Write([byte]0); $ico.Write([byte]0)
      $ico.Write([uint16]1); $ico.Write([uint16]32)
      $ico.Write([uint32]$frames[$i].Length); $ico.Write([uint32]$offset)
      $offset += $frames[$i].Length
    }
    foreach ($frame in $frames) { $ico.Write([byte[]]$frame) }
  } finally { $ico.Dispose() }
} finally { $image.Dispose() }
