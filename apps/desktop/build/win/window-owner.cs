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
//
// Exit codes: 0 done, 2 bad arguments, 3 a window isn't the process's, 4 the call failed.
// Built with the C# compiler that ships with Windows (.NET Framework 4.8,
// scripts/build-window-owner.mjs), so building it needs no SDK.
using System;
using System.Runtime.InteropServices;

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
