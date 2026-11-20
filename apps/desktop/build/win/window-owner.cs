// Chord's window-owner helper (Windows only; ARCHITECTURE.md §9, Chord Player
// in the tab). Chord Player plays in a tab by gluing its own window over the
// tab's content area (spike S14 §2 (b)). Only an *owned* window stays above
// Chord's when you click Chord, and stays out of Alt+Tab and the taskbar, and
// Windows can only make a window owned through SetWindowLongPtr. Electron
// doesn't expose that, and Chord loads no native code of its own (no FFI), so
// this tiny program does the one call, run once each time the player's window
// gets a new owner.
//
//   window-owner set <window> <its process id> <owner> <owner's process id>
//     Makes <window> owned by <owner>. Both must still belong to the
//     processes named (Chord checks the player's handle came from the player
//     it started, and passes its own), so a handle reused by another window
//     since is left alone. Owner 0 makes it unowned again.
//   window-owner get <window>
//     Prints <window>'s owner (tests).
//   window-owner restrict-pipe \\.\pipe\chord-agent-<16 hex>
//     It does more than its name says (S18, docs/decisions/S18-agent-mcp.md §1): it
//     tightens the DACL of the pipe Chord serves outside agents on, which Node can't
//     set. libuv leaves Everyone and Anonymous a read grant; this leaves SYSTEM and
//     the user, and denies network logons. Chord runs it once, on the first connection.
//   window-owner pipe-dacl <pipe>
//     Prints that pipe's DACL as SDDL (tests).
//
// Exit codes: 0 done, 2 bad arguments, 3 a window isn't the process's, 4 the call failed,
// 5 the pipe couldn't be opened.
// Built with the C# compiler that ships with Windows (.NET Framework 4.8,
// scripts/build-window-owner.mjs), so building it needs no SDK.
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.RegularExpressions;
using System.Threading;

static class WindowOwner
{
    const int GWLP_HWNDPARENT = -8;
    const uint GW_OWNER = 4;

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowLongPtrW(IntPtr window, int index, IntPtr value);

    [DllImport("user32.dll")]
    static extern IntPtr GetWindow(IntPtr window, uint command);

    [DllImport("kernel32.dll")]
    static extern void SetLastError(uint code);

    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    // The agent pipe (S18): a pipe is a kernel object, opened as its client would be.
    const int SE_KERNEL_OBJECT = 6;
    const uint DACL_SECURITY_INFORMATION = 4;
    const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
    const uint READ_CONTROL = 0x20000;
    const uint WRITE_DAC = 0x40000;
    const uint OPEN_EXISTING = 3;
    const int ERROR_PIPE_BUSY = 231;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool WaitNamedPipeW(string name, uint timeout);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("advapi32.dll")]
    static extern uint SetSecurityInfo(IntPtr handle, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(IntPtr handle, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, int revision, out IntPtr descriptor, IntPtr size);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, int revision, uint info, out IntPtr sddl, IntPtr size);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);

    /** Only Chord's own agent pipes: the name Chord makes, nothing else. */
    static readonly Regex AgentPipe = new Regex(@"^\\\\\.\\pipe\\chord-agent-[0-9a-f]{16}$");

    static IntPtr OpenPipe(string name, uint access)
    {
        for (int i = 0; i < 3; i++)
        {
            IntPtr handle = CreateFileW(name, access, 0, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
            if (handle != new IntPtr(-1)) return handle;
            if (Marshal.GetLastWin32Error() != ERROR_PIPE_BUSY) break;
            WaitNamedPipeW(name, 2000);
        }
        return IntPtr.Zero;
    }

    static int RestrictPipe(string name)
    {
        IntPtr pipe = OpenPipe(name, READ_CONTROL | WRITE_DAC);
        if (pipe == IntPtr.Zero) return 5;
        IntPtr descriptor = IntPtr.Zero;
        try
        {
            string user = WindowsIdentity.GetCurrent().User.Value;
            // Protected (nothing inherited): network logons denied; SYSTEM and the user, full control; no one else.
            string sddl = "D:P(D;;FA;;;NU)(A;;FA;;;SY)(A;;FA;;;" + user + ")";
            bool present, defaulted;
            IntPtr dacl;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, IntPtr.Zero)) return 4;
            if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted)) return 4;
            return SetSecurityInfo(pipe, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero) == 0 ? 0 : 4;
        }
        finally
        {
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            CloseHandle(pipe);
        }
    }

    static int PipeDacl(string name)
    {
        IntPtr pipe = OpenPipe(name, READ_CONTROL);
        if (pipe == IntPtr.Zero) return 5;
        try
        {
            IntPtr descriptor, text;
            if (GetSecurityInfo(pipe, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out descriptor) != 0) return 4;
            bool ok = ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, DACL_SECURITY_INFORMATION, out text, IntPtr.Zero);
            LocalFree(descriptor);
            if (!ok) return 4;
            Console.WriteLine(Marshal.PtrToStringUni(text));
            LocalFree(text);
            return 0;
        }
        finally
        {
            CloseHandle(pipe);
        }
    }

    static bool Handle(string text, out IntPtr value)
    {
        ulong number;
        value = IntPtr.Zero;
        if (!ulong.TryParse(text, out number)) return false;
        value = new IntPtr(unchecked((long)number));
        return true;
    }

    static bool Belongs(IntPtr window, string pidText)
    {
        uint expected, actual;
        if (!uint.TryParse(pidText, out expected) || !IsWindow(window)) return false;
        GetWindowThreadProcessId(window, out actual);
        return actual == expected;
    }

    static int Main(string[] args)
    {
        IntPtr window, owner;
        if (args.Length == 2 && (args[0] == "restrict-pipe" || args[0] == "pipe-dacl"))
        {
            if (!AgentPipe.IsMatch(args[1])) return 2;
            return args[0] == "restrict-pipe" ? RestrictPipe(args[1]) : PipeDacl(args[1]);
        }
        if (args.Length == 2 && args[0] == "get" && Handle(args[1], out window))
        {
            Console.WriteLine(unchecked((ulong)GetWindow(window, GW_OWNER).ToInt64()));
            return 0;
        }
        if (args.Length != 5 || args[0] != "set" || !Handle(args[1], out window) || !Handle(args[3], out owner)) return 2;
        if (!Belongs(window, args[2])) return 3;
        if (owner != IntPtr.Zero && !Belongs(owner, args[4])) return 3;
        SetLastError(0);
        IntPtr before = SetWindowLongPtrW(window, GWLP_HWNDPARENT, owner);
        return before == IntPtr.Zero && Marshal.GetLastWin32Error() != 0 ? 4 : 0;
    }
}
