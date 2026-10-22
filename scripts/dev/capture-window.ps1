# Captures a top-level window exactly as composited on screen (Mica, caption
# buttons, every WebContentsView), for design QA on Windows.
#
#   pwsh scripts/dev/capture-window.ps1 -Title Chord -Out shots/chord.png
#
# Brings the window to the front, then copies its DWM frame bounds from the screen.
param(
  [Parameter(Mandatory)] [string] $Title,
  [Parameter(Mandatory)] [string] $Out,
  [int] $SettleMs = 400
)

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ChordCapture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);
}
'@

# Per-monitor DPI awareness v2, so coordinates are physical pixels.
[void][ChordCapture]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))

# (FindWindow can't be used here: PowerShell passes `$null` strings as empty strings.)
$proc = Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Select-Object -First 1
if (-not $proc) { Write-Error "No window titled '$Title'"; exit 1 }
$hwnd = $proc.MainWindowHandle

[void][ChordCapture]::ShowWindow($hwnd, 9)   # SW_RESTORE
[void][ChordCapture]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds $SettleMs

$rect = New-Object ChordCapture+RECT
# DWMWA_EXTENDED_FRAME_BOUNDS = 9: the visible frame, without the invisible resize border.
[void][ChordCapture]::DwmGetWindowAttribute($hwnd, 9, [ref]$rect, [System.Runtime.InteropServices.Marshal]::SizeOf($rect))
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "captured ${w}x${h} -> $Out"
