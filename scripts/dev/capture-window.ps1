# Captures a top-level window for design QA on Windows.
#
#   pwsh scripts/dev/capture-window.ps1 -Title Chord -Out shots/chord.png [-ProcessId <pid>] [-Popups]
#
# Pass -ProcessId (the Chord your script launched) whenever another Chord may be
# open, such as the one you browse with: titles alone can't tell them apart, and
# with two matches and no -ProcessId it captures nothing.
#
# By default the window renders itself (PrintWindow with PW_RENDERFULLCONTENT),
# so the capture holds only Chord's pixels even when another app covers it.
# -Popups copies the screen instead, to include native menus; that only runs
# while Chord owns the foreground, so it can never capture someone else's window.
param(
  [Parameter(Mandatory)] [string] $Title,
  [Parameter(Mandatory)] [string] $Out,
  [int] $ProcessId = 0,
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
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int max);
  // A visible top-level window of this process with exactly this title (off-screen ones too,
  // which Process.MainWindowHandle skips).
  public static IntPtr Find(uint pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, _) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h)) return true;
      var text = new System.Text.StringBuilder(512);
      GetWindowText(h, text, text.Capacity);
      if (text.ToString() != title) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@

# Per-monitor DPI awareness v2, so coordinates are physical pixels.
[void][ChordCapture]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))

# (FindWindow can't be used here: PowerShell passes `$null` strings as empty strings.)
if ($ProcessId) {
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  $hwnd = if ($proc) { [ChordCapture]::Find([uint32]$ProcessId, $Title) } else { [IntPtr]::Zero }
  if ($hwnd -eq [IntPtr]::Zero) { Write-Error "No window titled '$Title' in process $ProcessId"; exit 1 }
} else {
  $procs = @(Get-Process | Where-Object { $_.MainWindowTitle -eq $Title })
  if ($procs.Count -eq 0) { Write-Error "No window titled '$Title'"; exit 1 }
  if ($procs.Count -gt 1) { Write-Error "$($procs.Count) windows are titled '$Title'; pass -ProcessId to say which"; exit 1 }
  $proc = $procs[0]
  $hwnd = $proc.MainWindowHandle
}

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
