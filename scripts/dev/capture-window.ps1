# Captures a top-level window for design QA on Windows.
#
#   pwsh scripts/dev/capture-window.ps1 -Title Chord -Out shots/chord.png [-Popups]
#
# By default the window renders itself (PrintWindow with PW_RENDERFULLCONTENT),
# so the capture holds only Chord's pixels even when another app covers it.
# -Popups copies the screen instead, to include native menus; that only runs
# while Chord owns the foreground, so it can never capture someone else's window.
param(
  [Parameter(Mandatory)] [string] $Title,
  [Parameter(Mandatory)] [string] $Out,
  [switch] $Popups,
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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);
}
'@

# Per-monitor DPI awareness v2, so coordinates are physical pixels.
[void][ChordCapture]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))

# (FindWindow can't be used here: PowerShell passes `$null` strings as empty strings.)
$proc = Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Select-Object -First 1
if (-not $proc) { Write-Error "No window titled '$Title'"; exit 1 }
$hwnd = $proc.MainWindowHandle

$frame = New-Object ChordCapture+RECT
# DWMWA_EXTENDED_FRAME_BOUNDS = 9: the visible frame, without the invisible resize border.
[void][ChordCapture]::DwmGetWindowAttribute($hwnd, 9, [ref]$frame, [System.Runtime.InteropServices.Marshal]::SizeOf($frame))
$w = $frame.Right - $frame.Left
$h = $frame.Bottom - $frame.Top
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null

if ($Popups) {
  [void][ChordCapture]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds $SettleMs
  $fgPid = [uint32]0
  [void][ChordCapture]::GetWindowThreadProcessId([ChordCapture]::GetForegroundWindow(), [ref]$fgPid)
  # Chord's menus run in the browser process, so they count as Chord's foreground.
  if ($fgPid -ne $proc.Id) { Write-Warning "Chord isn't in the foreground; skipped $Out rather than capture another window"; exit 0 }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($frame.Left, $frame.Top, 0, 0, $bmp.Size)
  $g.Dispose()
} else {
  Start-Sleep -Milliseconds $SettleMs
  # PrintWindow draws the whole window, invisible resize border included; crop to the visible frame.
  $outer = New-Object ChordCapture+RECT
  [void][ChordCapture]::GetWindowRect($hwnd, [ref]$outer)
  $full = New-Object System.Drawing.Bitmap ($outer.Right - $outer.Left), ($outer.Bottom - $outer.Top)
  $g = [System.Drawing.Graphics]::FromImage($full)
  $hdc = $g.GetHdc()
  # PW_RENDERFULLCONTENT = 2: includes DirectComposition content (every WebContentsView).
  $ok = [ChordCapture]::PrintWindow($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc); $g.Dispose()
  if (-not $ok) { Write-Error 'PrintWindow failed'; exit 1 }
  $crop = New-Object System.Drawing.Rectangle ($frame.Left - $outer.Left), ($frame.Top - $outer.Top), $w, $h
  $bmp = $full.Clone($crop, $full.PixelFormat)
  $full.Dispose()
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "captured ${w}x${h} -> $Out"
