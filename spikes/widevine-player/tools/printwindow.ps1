# Captures one of the spike's own windows by handle: the window renders itself
# (PrintWindow with PW_RENDERFULLCONTENT), so no other app's pixels can end up
# in it. Optionally reads the colors at some points (physical pixels, relative
# to the window) and prints them as JSON.
#   pwsh tools/printwindow.ps1 -Hwnd 123456 -Out host.png [-Points "300,200;40,300"]
param(
  [Parameter(Mandatory)] [long] $Hwnd,
  [Parameter(Mandatory)] [string] $Out,
  [string] $Points = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SpikeCapture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
}
'@
[void][SpikeCapture]::SetProcessDpiAwarenessContext([IntPtr](-4))
$h = [IntPtr]$Hwnd
$r = New-Object SpikeCapture+RECT
[void][SpikeCapture]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [SpikeCapture]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$colors = @()
if ($Points) {
  foreach ($p in $Points.Split(';')) {
    $x, $y = $p.Split(',') | ForEach-Object { [int]$_ }
    if ($x -ge 0 -and $y -ge 0 -and $x -lt $w -and $y -lt $hgt) {
      $c = $bmp.GetPixel($x, $y)
      $colors += [pscustomobject]@{ x = $x; y = $y; r = $c.R; g = $c.G; b = $c.B }
    }
  }
}
$bmp.Dispose()
[pscustomobject]@{ ok = $ok; width = $w; height = $hgt; points = $colors } | ConvertTo-Json -Compress -Depth 4
