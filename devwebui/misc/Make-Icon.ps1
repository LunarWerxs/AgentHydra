# Generates misc\DevWebUI.ico — the DevWebUI brand icon (stacked-servers mark). Emits a proper
# MULTI-SIZE icon: 16/24/32/48 (true 32bpp DIB) + 256 (PNG). The Windows system tray needs
# small frames; a 256-only icon renders BLANK or fuzzy in the tray.
#
# Source art is misc\DevWebUI-icon.png (a committed 1024x1024 render of the brand icon) so this
# script needs NO SVG renderer at runtime — it just loads the PNG and downscales. To change the
# logo: re-render the PNG from the web favicon, then re-run this script, e.g.
#     magick -background none web\public\icon.svg -resize 1024x1024 misc\DevWebUI-icon.png
# The brand vectors live in misc\brand\ (icon-dark / icon-light). After regenerating, re-run
# Create-Shortcut.ps1 (Windows caches icons; refreshing the shortcut picks up the new one).
Add-Type -AssemblyName System.Drawing

# Load the source PNG into a detached 32bpp ARGB bitmap (frees the file handle, keeps alpha).
function Get-SourceArt([string]$PngPath){
  if(-not (Test-Path $PngPath)){
    throw "Source art not found: $PngPath`nRe-render it, e.g.:  magick -background none web\public\icon.svg -resize 1024x1024 $PngPath"
  }
  $img = [System.Drawing.Image]::FromFile($PngPath)
  try {
    $bmp = New-Object System.Drawing.Bitmap($img.Width,$img.Height,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($img,0,0,$img.Width,$img.Height)
    $g.Dispose()
  } finally { $img.Dispose() }
  return $bmp
}

# High-quality downscale to NxN (32bpp ARGB).
function Resize-Art([System.Drawing.Bitmap]$src,[int]$n){
  $bmp = New-Object System.Drawing.Bitmap($n,$n,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src,0,0,$n,$n)
  $g.Dispose()
  return $bmp
}

# Small (<256) frame = a true 32bpp DIB with full alpha (GDI+ REJECTS PNG-encoded small
# frames). Height is DOUBLED for the XOR colour rows + AND mask; colour pixels bottom-up
# BGRA; AND mask all-zero (transparency rides the alpha channel). Returns @{entry;data}.
function Get-DibFrame([System.Drawing.Bitmap]$bmp){
  $w=$bmp.Width; $h=$bmp.Height
  $bd=$bmp.LockBits([System.Drawing.Rectangle]::new(0,0,$w,$h),[System.Drawing.Imaging.ImageLockMode]::ReadOnly,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $buf=New-Object byte[] ($bd.Stride*$h); [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0,$buf,0,$buf.Length); $stride=$bd.Stride; $bmp.UnlockBits($bd)
  $ms=New-Object System.IO.MemoryStream; $bw=New-Object System.IO.BinaryWriter($ms)
  $bw.Write([uint32]40); $bw.Write([int32]$w); $bw.Write([int32]($h*2))
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]0)
  $bw.Write([uint32]0); $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)
  for($yy=$h-1;$yy -ge 0;$yy--){ $bw.Write($buf,$yy*$stride,$w*4) }              # XOR, bottom-up
  $andRow=[math]::Floor(($w+31)/32)*4; $zero=New-Object byte[] $andRow
  for($yy=0;$yy -lt $h;$yy++){ $bw.Write($zero,0,$andRow) }                      # AND mask, all zero
  $bw.Flush(); $data=$ms.ToArray()
  $entry=New-Object byte[] 16; $entry[0]=[byte]$w; $entry[1]=[byte]$h; $entry[4]=1; $entry[6]=32  # planes=1, bpp=32
  [Array]::Copy([BitConverter]::GetBytes([uint32]$data.Length),0,$entry,8,4)
  return @{ entry=$entry; data=$data }
}

# 256 jumbo frame = PNG-compressed (smaller; GDI+ decodes PNG at this size). w=h=0 => 256.
function Get-PngFrame([System.Drawing.Bitmap]$bmp){
  $ms=New-Object System.IO.MemoryStream; $bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); $data=$ms.ToArray()
  $entry=New-Object byte[] 16; $entry[4]=1; $entry[6]=32
  [Array]::Copy([BitConverter]::GetBytes([uint32]$data.Length),0,$entry,8,4)
  return @{ entry=$entry; data=$data }
}

# Assemble a multi-frame .ico. Explicit (buffer,offset,count) writes avoid a PowerShell
# array-append quirk that can silently truncate byte payloads.
function Save-MultiIcon([string]$Path,[System.Drawing.Bitmap]$art){
  $sizes = 16,24,32,48,256
  $frames = New-Object System.Collections.Generic.List[object]
  foreach($s in $sizes){
    $f = Resize-Art $art $s
    if($s -ge 256){ $frames.Add((Get-PngFrame $f)) } else { $frames.Add((Get-DibFrame $f)) }
    $f.Dispose()
  }
  $ms=New-Object System.IO.MemoryStream; $bw=New-Object System.IO.BinaryWriter($ms)
  $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$frames.Count)   # ICONDIR
  $offset = 6 + 16*$frames.Count
  foreach($fr in $frames){ [Array]::Copy([BitConverter]::GetBytes([uint32]$offset),0,$fr.entry,12,4); $bw.Write($fr.entry,0,16); $offset += $fr.data.Length }
  foreach($fr in $frames){ $bw.Write($fr.data,0,$fr.data.Length) }
  $bw.Flush(); [System.IO.File]::WriteAllBytes($Path,$ms.ToArray())
}

$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$art = Get-SourceArt (Join-Path $dir "DevWebUI-icon.png")
Save-MultiIcon (Join-Path $dir "DevWebUI.ico") $art
$art.Dispose()
Write-Host "Wrote $dir\DevWebUI.ico (16/24/32/48 + 256) from DevWebUI-icon.png"
