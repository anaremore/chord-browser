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
//   window-owner pipe-clients <pipe> <server's process id>
//     Prints the process ids of the clients connected to that pipe's instances, which the
//     server (Chord) holds, on one line, space-separated (S18 M2a, "who's calling").
//     GetNamedPipeClientProcessId needs the server's own handle to an instance, and Node
//     never gives Chord its handle (a pipe socket's fd is -1 on Windows), so this finds it:
//     the server's handles from the system's handle table, only its files, each copied here
//     (DuplicateHandle: the same user's process) and kept if it's the server end of this
//     pipe. A query on a file can block when the file has I/O pending, so each runs on a
//     worker thread that's given up on after QUERY_MS.
//
// Exit codes: 0 done, 2 bad arguments, 3 a window isn't the process's, 4 the call failed,
// 5 the pipe (for pipe-clients, the server's process) couldn't be opened.
// Built with the C# compiler that ships with Windows (.NET Framework 4.8,
// scripts/build-window-owner.mjs), so building it needs no SDK.
using System;
using System.Collections.Generic;
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

    // pipe-clients: the system's handle table, and the queries on each of the server's files.
    [StructLayout(LayoutKind.Sequential)]
    struct HandleEntry
    {
        public IntPtr Object;
        public UIntPtr UniqueProcessId;
        public UIntPtr HandleValue;
        public uint GrantedAccess;
        public ushort CreatorBackTraceIndex;
        public ushort ObjectTypeIndex;
        public uint HandleAttributes;
        public uint Reserved;
    }

    const int SystemExtendedHandleInformation = 64;
    const int STATUS_INFO_LENGTH_MISMATCH = unchecked((int)0xC0000004);
    const uint PROCESS_DUP_HANDLE = 0x40;
    const uint DUPLICATE_SAME_ACCESS = 2;
    const uint FILE_TYPE_PIPE = 3;
    const uint PIPE_SERVER_END = 1;
    const int FileNameInfo = 2;
    const uint GENERIC_READ = 0x80000000;
    const uint FILE_SHARE_READ = 1;
    const int QUERY_MS = 100;

    [DllImport("ntdll.dll")]
    static extern int NtQuerySystemInformation(int infoClass, IntPtr info, int length, out int needed);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    static extern uint GetCurrentProcessId();

    [DllImport("kernel32.dll")]
    static extern uint GetFileType(IntPtr file);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeInfo(IntPtr pipe, out uint flags, IntPtr outSize, IntPtr inSize, IntPtr maxInstances);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(IntPtr file, int infoClass, IntPtr info, uint size);

    /** The pipe's name as a handle to it gives it (\chord-agent-…), or null. */
    static string PipeName(IntPtr pipe)
    {
        IntPtr buffer = Marshal.AllocHGlobal(1024);
        try
        {
            if (!GetFileInformationByHandleEx(pipe, FileNameInfo, buffer, 1024)) return null;
            int bytes = Marshal.ReadInt32(buffer);
            return bytes > 0 && bytes <= 1020 ? Marshal.PtrToStringUni(buffer + 4, bytes / 2) : null;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /** What a query on one of the server's handles found. */
    enum Found { Other, Client, Stuck }

    /**
     * Runs the queries one at a time on a thread of its own. One that doesn't come back in QUERY_MS (a file with
     * I/O pending) is given up on with its thread, a background one that doesn't keep this program running, and the
     * next query gets a new thread.
     */
    sealed class Worker
    {
        readonly object gate = new object();
        Func<uint> job;
        uint result;
        bool done;
        Thread thread;

        void Loop(object mine)
        {
            while (true)
            {
                Func<uint> run;
                lock (gate)
                {
                    while (job == null && thread == mine) Monitor.Wait(gate);
                    if (thread != mine) return;
                    run = job;
                }
                uint answer = 0;
                try { answer = run(); } catch { }
                lock (gate)
                {
                    if (thread != mine) return; // given up on meanwhile: no longer the worker
                    result = answer;
                    done = true;
                    job = null;
                    Monitor.PulseAll(gate);
                }
            }
        }

        /** The query's answer (0 for none), or Stuck. */
        public Found Run(Func<uint> f, out uint answer)
        {
            answer = 0;
            lock (gate)
            {
                if (thread == null)
                {
                    var t = new Thread(Loop) { IsBackground = true };
                    thread = t;
                    t.Start(t);
                }
                job = f;
                done = false;
                Monitor.PulseAll(gate);
                var deadline = DateTime.UtcNow.AddMilliseconds(QUERY_MS);
                while (!done)
                {
                    int left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                    if (left <= 0 || !Monitor.Wait(gate, left)) break;
                }
                if (!done)
                {
                    job = null;
                    thread = null;
                    Monitor.PulseAll(gate);
                    return Found.Stuck;
                }
                answer = result;
                return answer != 0 ? Found.Client : Found.Other;
            }
        }
    }

    /** The handle table: every process's handles, as the system has them now; null if it can't be had. */
    static IntPtr HandleTable(out long count)
    {
        int size = 1 << 20, needed;
        count = 0;
        for (int tries = 0; tries < 8; tries++)
        {
            IntPtr table = Marshal.AllocHGlobal(size);
            int status = NtQuerySystemInformation(SystemExtendedHandleInformation, table, size, out needed);
            if (status == 0)
            {
                count = Marshal.ReadIntPtr(table).ToInt64();
                return table;
            }
            Marshal.FreeHGlobal(table);
            if (status != STATUS_INFO_LENGTH_MISMATCH) return IntPtr.Zero;
            size = Math.Max(size * 2, needed + (1 << 16));
        }
        return IntPtr.Zero;
    }

    static HandleEntry EntryAt(IntPtr table, long i)
    {
        // The table: a count and a reserved word, then the entries.
        return (HandleEntry)Marshal.PtrToStructure(new IntPtr(table.ToInt64() + IntPtr.Size * 2 + i * Marshal.SizeOf(typeof(HandleEntry))), typeof(HandleEntry));
    }

    static int PipeClients(string name, uint server)
    {
        // Files are one object type: this program's own file handle says which, so only the server's files are queried.
        IntPtr own = CreateFileW(System.Reflection.Assembly.GetExecutingAssembly().Location, GENERIC_READ, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (own == new IntPtr(-1)) return 4;
        IntPtr process = OpenProcess(PROCESS_DUP_HANDLE, false, server);
        if (process == IntPtr.Zero)
        {
            CloseHandle(own);
            return 5;
        }
        long count;
        IntPtr table = HandleTable(out count);
        try
        {
            if (table == IntPtr.Zero) return 4;
            ulong self = GetCurrentProcessId();
            int fileType = -1;
            for (long i = 0; i < count && fileType < 0; i++)
            {
                HandleEntry e = EntryAt(table, i);
                if (e.UniqueProcessId.ToUInt64() == self && e.HandleValue.ToUInt64() == (ulong)own.ToInt64()) fileType = e.ObjectTypeIndex;
            }
            if (fileType < 0) return 4;
            string leaf = name.Substring(@"\\.\pipe".Length); // \chord-agent-…, as a handle to it names it
            var clients = new List<uint>();
            var worker = new Worker();
            for (long i = 0; i < count; i++)
            {
                HandleEntry e = EntryAt(table, i);
                if (e.UniqueProcessId.ToUInt64() != server || e.ObjectTypeIndex != fileType) continue;
                IntPtr copy;
                if (!DuplicateHandle(process, new IntPtr(unchecked((long)e.HandleValue.ToUInt64())), GetCurrentProcess(), out copy, 0, false, DUPLICATE_SAME_ACCESS)) continue;
                IntPtr h = copy;
                uint client;
                Found found = worker.Run(() =>
                {
                    uint flags, pid;
                    if (GetFileType(h) != FILE_TYPE_PIPE) return 0;
                    if (!GetNamedPipeInfo(h, out flags, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero) || (flags & PIPE_SERVER_END) == 0) return 0;
                    if (!string.Equals(PipeName(h), leaf, StringComparison.OrdinalIgnoreCase)) return 0;
                    return GetNamedPipeClientProcessId(h, out pid) ? pid : 0;
                }, out client);
                if (found == Found.Client && !clients.Contains(client)) clients.Add(client);
                // A copy a query is still stuck on stays open: closing it under the query could hand its number to another handle.
                if (found != Found.Stuck) CloseHandle(copy);
            }
            Console.WriteLine(string.Join(" ", clients));
            return 0;
        }
        finally
        {
            if (table != IntPtr.Zero) Marshal.FreeHGlobal(table);
            CloseHandle(process);
            CloseHandle(own);
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
        if (args.Length == 3 && args[0] == "pipe-clients")
        {
            uint server;
            if (!AgentPipe.IsMatch(args[1]) || !uint.TryParse(args[2], out server) || server == 0) return 2;
            return PipeClients(args[1], server);
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
