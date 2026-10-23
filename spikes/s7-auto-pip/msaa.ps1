# Spike S7 helper (Windows PowerShell 5.1: it has the Accessibility assembly):
# lists a window's MSAA tree, or performs one control's default action, by
# name. Chromium's views controls (the PiP window's buttons) are named there.
# No mouse or keyboard input is sent.
#
#   powershell -File msaa.ps1 -Hwnd 0x1234
#   powershell -File msaa.ps1 -Hwnd 0x1234 -Invoke 'Back to tab'
param([Parameter(Mandatory)] [string] $Hwnd, [string] $Invoke)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Accessibility
Add-Type -ReferencedAssemblies Accessibility @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Accessibility;
public static class S7Msaa {
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object obj);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible parent, int start, int count, [Out] object[] children, out int obtained);
  public class Node { public string Name; public string Role; public string Action; public bool Invisible; public int Depth; public IAccessible Acc; public object Child; }
  public static List<Node> Walk(IntPtr hwnd) {
    var guid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
    object root;
    AccessibleObjectFromWindow(hwnd, 0xFFFFFFFC /* OBJID_CLIENT */, ref guid, out root);
    var list = new List<Node>();
    Visit((IAccessible)root, 0, list);
    return list;
  }
  static void Visit(IAccessible acc, int depth, List<Node> list) {
    if (depth > 12) return;
    int count = 0; try { count = acc.accChildCount; } catch { }
    if (count == 0) return;
    var kids = new object[count]; int got;
    if (AccessibleChildren(acc, 0, count, kids, out got) != 0) return;
    for (int i = 0; i < got; i++) {
      var child = kids[i] as IAccessible;
      object self = child != null ? (object)0 : kids[i];
      var target = child ?? acc;
      var n = new Node { Depth = depth, Acc = target, Child = self };
      try { n.Name = target.get_accName(self); } catch { }
      try { n.Role = Convert.ToString(target.get_accRole(self)); } catch { }
      try { n.Action = target.get_accDefaultAction(self); } catch { }
      try { n.Invisible = (Convert.ToInt32(target.get_accState(self)) & 0x8000) != 0; } catch { }
      list.Add(n);
      if (child != null) Visit(child, depth + 1, list);
    }
  }
}
'@
$h = [IntPtr]::new([Convert]::ToInt64($Hwnd, 16))
$nodes = [S7Msaa]::Walk($h)
if ($Invoke) {
  $match = $nodes | Where-Object { $_.Name -eq $Invoke } | Select-Object -First 1
  if (-not $match) { ConvertTo-Json -Compress @{ ok = $false; error = "no control named '$Invoke'" }; exit 0 }
  $match.Acc.accDoDefaultAction($match.Child)
  ConvertTo-Json -Compress @{ ok = $true; name = $match.Name; action = $match.Action }
} else {
  ConvertTo-Json -Compress -InputObject @($nodes | ForEach-Object { [pscustomobject]@{ name = $_.Name; role = $_.Role; action = $_.Action; invisible = $_.Invisible; depth = $_.Depth } })
}
