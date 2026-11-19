# Spike S18 M0: a named pipe's DACL, what a read-only opener (what Everyone may do) gets,
# and whether the owner can tighten the DACL after Node's listen().
# Usage: pwsh pipe-acl.ps1 <endpoint file> [-Tighten]
param([string]$EndpointFile, [switch]$Tighten, [switch]$RemoteAfter)
$path = (Get-Content $EndpointFile | ConvertFrom-Json).path
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class S18Pipe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateFileW(string n, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool PeekNamedPipe(IntPtr h, IntPtr b, uint n, IntPtr r, out uint avail, IntPtr left);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool WriteFile(IntPtr h, byte[] b, uint n, out uint w, IntPtr o);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern uint GetSecurityInfo(IntPtr h, int type, int info, IntPtr o, IntPtr g, IntPtr d, IntPtr s, out IntPtr sd);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern uint SetSecurityInfo(IntPtr h, int type, int info, IntPtr o, IntPtr g, IntPtr dacl, IntPtr s);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, int rev, int info, out IntPtr str, out int len);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, int rev, out IntPtr sd, out int len);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool defaulted);
  public static IntPtr Open(string p, uint access) { return CreateFileW(p, access, 0, IntPtr.Zero, 3, 0, IntPtr.Zero); }
  public static string Sddl(IntPtr h) {
    IntPtr sd; uint r = GetSecurityInfo(h, 6, 1|4, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd);
    if (r != 0) return "error " + r;
    IntPtr s; int l; ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, 1|4, out s, out l); return Marshal.PtrToStringUni(s);
  }
  // PROTECTED_DACL_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION
  public static uint SetDacl(IntPtr h, string sddl) {
    IntPtr sd; int l; if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out l)) return 1;
    bool present, def; IntPtr dacl; GetSecurityDescriptorDacl(sd, out present, out dacl, out def);
    return SetSecurityInfo(h, 6, 4 | unchecked((int)0x80000000), IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
  }
}
'@
$GENERIC_READ = [uint32]2147483648; $GENERIC_WRITE = [uint32]1073741824; $FILE_GENERIC_READ = 0x120089; $READ_CONTROL = 0x20000; $WRITE_DAC = 0x40000
function Show-Dacl([string]$label) {
  $h = [S18Pipe]::Open($path, $READ_CONTROL)
  if ($h -eq [IntPtr]-1) { "$label`: open error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; return }
  "$label`: $([S18Pipe]::Sddl($h))"; [void][S18Pipe]::CloseHandle($h)
}
Show-Dacl 'DACL'

# What Everyone's grant allows: FILE_GENERIC_READ only. It connects, but can it read or write anything?
$h = [S18Pipe]::Open($path, $FILE_GENERIC_READ)
if ($h -eq [IntPtr]-1) { "read-only open: error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" } else {
  $w = 0; $bytes = [Text.Encoding]::UTF8.GetBytes("{}`n")
  $ok = [S18Pipe]::WriteFile($h, $bytes, $bytes.Length, [ref]$w, [IntPtr]::Zero)
  "read-only open: connected; write -> $ok (error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
  Start-Sleep -Milliseconds 2500
  $avail = 0; $peek = [S18Pipe]::PeekNamedPipe($h, [IntPtr]::Zero, 0, [IntPtr]::Zero, [ref]$avail, [IntPtr]::Zero)
  "read-only open after 2.5 s: peek -> $peek (error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())), bytes waiting $avail"
  [void][S18Pipe]::CloseHandle($h)
}

# Over the SMB loopback (what a remote client would use).
$remote = $path -replace '^\\\\\.\\', '\\localhost\'
$h = [S18Pipe]::Open($remote, [uint32]($GENERIC_READ + $GENERIC_WRITE))
if ($h -eq [IntPtr]-1) { "remote ($remote): error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" } else { "remote ($remote): CONNECTED"; [void][S18Pipe]::CloseHandle($h) }

if ($Tighten) {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $h = [S18Pipe]::Open($path, $READ_CONTROL -bor $WRITE_DAC)
  "tighten: SetSecurityInfo -> $([S18Pipe]::SetDacl($h, "D:P(D;;FA;;;NU)(A;;FA;;;SY)(A;;FA;;;$sid)"))"
  [void][S18Pipe]::CloseHandle($h)
  Start-Sleep -Milliseconds 300
  Show-Dacl 'DACL after tighten (a later instance)'
  $h = [S18Pipe]::Open($path, $FILE_GENERIC_READ); "after tighten, opening as Everyone could: same user still connects -> $($h -ne [IntPtr]-1)"; if ($h -ne [IntPtr]-1) { [void][S18Pipe]::CloseHandle($h) }
}
if ($RemoteAfter) {
  $h = [S18Pipe]::Open($remote, [uint32]($GENERIC_READ + $GENERIC_WRITE))
  if ($h -eq [IntPtr]-1) { "remote after tighten: error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" } else { "remote after tighten: CONNECTED"; [void][S18Pipe]::CloseHandle($h) }
}
