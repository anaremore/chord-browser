# Spike S7 helper (Windows): finds a process's top-level windows, captures one
# with PrintWindow (the window draws itself, so no other app's pixels can end
# up in the capture), and reads or presses its controls through UI Automation
# (no mouse or keyboard input is sent).
#
#   pwsh -File pipwin.ps1 list    -ProcessId 1234
#   pwsh -File pipwin.ps1 capture -Hwnd 0x1234 -Out shot.png
#   pwsh -File pipwin.ps1 uia     -Hwnd 0x1234
#   pwsh -File pipwin.ps1 invoke  -Hwnd 0x1234 -Name 'Back to tab'
param(
  [Parameter(Mandatory, Position = 0)] [ValidateSet('list', 'capture', 'uia', 'invoke', 'focus')] [string] $Mode,
  [int] $ProcessId,
  [string] $Hwnd,
  [string] $Out,
  [string] $Name
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class S7Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  public static List<IntPtr> Of(uint pid) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) found.Add(h); return true; }, IntPtr.Zero);
    return found;
  }
  public static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
}
'@
[void][S7Win]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))

function HandleOf([string] $text) { [IntPtr]::new([Convert]::ToInt64($text, 16)) }

switch ($Mode) {
  'list' {
    $windows = foreach ($h in [S7Win]::Of([uint32]$ProcessId)) {
      $r = New-Object S7Win+RECT
      [void][S7Win]::GetWindowRect($h, [ref]$r)
      # WS_EX_TOPMOST = 0x8 in GWL_EXSTYLE (-20): PiP windows float above everything.
      $topmost = ([S7Win]::GetWindowLong($h, -20) -band 0x8) -ne 0
      [pscustomobject]@{ hwnd = ('0x{0:X}' -f $h.ToInt64()); title = [S7Win]::Text($h); class = [S7Win]::Class($h); topmost = $topmost; x = $r.Left; y = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top }
    }
    ConvertTo-Json -InputObject @($windows) -Compress
  }
  'capture' {
    $h = HandleOf $Hwnd
    $r = New-Object S7Win+RECT
    [void][S7Win]::GetWindowRect($h, [ref]$r)
    $bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    # PW_RENDERFULLCONTENT = 2: includes GPU-composited content.
    $ok = [S7Win]::PrintWindow($h, $hdc, 2)
    $g.ReleaseHdc($hdc); $g.Dispose()
    # A cheap fingerprint of the pixels, to tell whether two captures differ.
    $sum = 0L; $nonBlack = 0
    for ($y = 0; $y -lt $bmp.Height; $y += 4) { for ($x = 0; $x -lt $bmp.Width; $x += 4) { $p = $bmp.GetPixel($x, $y); $v = [int]$p.R + $p.G + $p.B; $sum += $v * (($x * 7 + $y * 13) % 97 + 1); if ($v -gt 30) { $nonBlack++ } } }
    if ($Out) { $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png) }
    $bmp.Dispose()
    ConvertTo-Json -Compress @{ ok = $ok; fingerprint = $sum; nonBlack = $nonBlack }
  }
  'uia' {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle((HandleOf $Hwnd))
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $items = foreach ($e in $all) {
      $c = $e.Current
      $legacy = $null; $lname = $null; $laction = $null; $lrole = $null
      if ($e.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$legacy)) {
        $lname = $legacy.Current.Name; $laction = $legacy.Current.DefaultAction; $lrole = $legacy.Current.Role
      }
      $r = $c.BoundingRectangle
      [pscustomobject]@{ name = $c.Name; legacyName = $lname; legacyRole = $lrole; defaultAction = $laction; type = $c.ControlType.ProgrammaticName; offscreen = $c.IsOffscreen; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
    }
    ConvertTo-Json -InputObject @($items) -Compress
  }
  'focus' {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle((HandleOf $Hwnd))
    try { $root.SetFocus(); ConvertTo-Json -Compress @{ ok = $true } } catch { ConvertTo-Json -Compress @{ ok = $false; error = $_.Exception.Message } }
  }
  'invoke' {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle((HandleOf $Hwnd))
    $el = $null
    foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      $legacy = $null; $lname = $null
      if ($e.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$legacy)) { $lname = $legacy.Current.Name }
      if ($e.Current.Name -eq $Name -or $lname -eq $Name) { $el = $e; break }
    }
    if (-not $el) { ConvertTo-Json -Compress @{ ok = $false; error = "no element named '$Name'" }; break }
    $pattern = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
      $pattern.Invoke()
      ConvertTo-Json -Compress @{ ok = $true; via = 'InvokePattern' }
    } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$pattern)) {
      $pattern.DoDefaultAction()
      ConvertTo-Json -Compress @{ ok = $true; via = 'LegacyIAccessible' }
    } else {
      ConvertTo-Json -Compress @{ ok = $false; error = 'no invoke pattern' }
    }
  }
}
