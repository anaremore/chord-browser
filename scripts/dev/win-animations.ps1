# Windows' own animations (Settings → Accessibility → Visual effects → Animation effects),
# for testing. Chord follows the system's reduced-motion setting (DESIGN.md §6.6), and
# Electron reads it from the client-area animation flag below, so motion tests and
# captures sometimes need animations on. Turn them back off afterwards: the maintainer
# keeps them off.
#
#   pwsh scripts/dev/win-animations.ps1 query
#   pwsh scripts/dev/win-animations.ps1 on
#   pwsh scripts/dev/win-animations.ps1 off
param([Parameter(Mandatory)] [ValidateSet('query', 'on', 'off')] [string] $State)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WinAnim {
  [StructLayout(LayoutKind.Sequential)] public struct ANIMATIONINFO { public uint cbSize; public int iMinAnimate; }
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfo(uint action, uint param, ref bool value, uint flags);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint flags);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfo(uint action, uint param, ref ANIMATIONINFO value, uint flags);
}
'@

# Write the setting to the user profile and tell every window (SPIF_UPDATEINIFILE | SPIF_SENDCHANGE).
$persist = 3
# Each flag the Animation effects switch covers: get, set.
$flags = [ordered]@{
  'Controls and elements inside windows' = @(0x1042, 0x1043)
  'Menus'                                = @(0x1002, 0x1003)
  'Combo boxes'                          = @(0x1004, 0x1005)
  'List box smooth scrolling'            = @(0x1006, 0x1007)
  'Tooltips'                             = @(0x1016, 0x1017)
  'Selection fade'                       = @(0x1014, 0x1015)
}

function Get-Flag([int] $code) {
  $value = $false
  [void][WinAnim]::SystemParametersInfo($code, 0, [ref]$value, 0)
  $value
}
function Get-MinMax {
  $info = New-Object WinAnim+ANIMATIONINFO
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
  [void][WinAnim]::SystemParametersInfo(0x0048, $info.cbSize, [ref]$info, 0)
  $info.iMinAnimate -ne 0
}

if ($State -ne 'query') {
  $on = $State -eq 'on'
  foreach ($pair in $flags.Values) {
    if (-not [WinAnim]::SystemParametersInfo($pair[1], 0, [IntPtr][int]$on, $persist)) { Write-Error "SystemParametersInfo($($pair[1])) failed"; exit 1 }
  }
  $info = New-Object WinAnim+ANIMATIONINFO
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
  $info.iMinAnimate = [int]$on
  if (-not [WinAnim]::SystemParametersInfo(0x0049, $info.cbSize, [ref]$info, $persist)) { Write-Error 'SystemParametersInfo(SPI_SETANIMATION) failed'; exit 1 }
}

foreach ($name in $flags.Keys) { '{0,-38} {1}' -f $name, $(if (Get-Flag $flags[$name][0]) { 'on' } else { 'off' }) }
'{0,-38} {1}' -f 'Windows minimizing and maximizing', $(if (Get-MinMax) { 'on' } else { 'off' })
