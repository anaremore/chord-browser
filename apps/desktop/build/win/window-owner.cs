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
//     Prints, as one line of JSON, the process ids of the clients connected to that pipe's
//     instances, which the server (Chord) holds, and each one's chain: itself, its parent and
//     theirs, from one process snapshot (S18 M2a, "who's calling"), with how long each step took.
//     GetNamedPipeClientProcessId needs the server's own handle to an instance, and Node
//     never gives Chord its handle (a pipe socket's fd is -1 on Windows), so this finds it:
//     the server's handles from the system's handle table (read in place: it can hold
//     hundreds of thousands of entries), only its files, each copied here (DuplicateHandle:
//     the same user's process) and kept if it's the server end of this pipe. A query on a
//     file can block when the file has I/O pending, so they all run at once, each on a
//     thread of its own, and those not done within QUERIES_MS are left behind ("stuck"); the
//     server's files past FILES_MAX aren't looked at ("truncated"); one that can't be copied, or
//     whose query fails before it can say whether it's one of the pipe's, is "skipped". Any of
//     them means a client may be missing from the list.
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

    // pipe-clients: the system's handle table, the queries on each of the server's files, and the clients' chains.
    const int SystemExtendedHandleInformation = 64;
    const int STATUS_INFO_LENGTH_MISMATCH = unchecked((int)0xC0000004);
    const uint PROCESS_DUP_HANDLE = 0x40;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint DUPLICATE_SAME_ACCESS = 2;
    const uint FILE_TYPE_PIPE = 3;
    const uint FILE_TYPE_UNKNOWN = 0;
    const int NO_ERROR = 0;
    /**
     * A server end of the pipe with no client: waiting for the next connection. libuv keeps four such instances, and
     * GetNamedPipeClientProcessId answers ERROR_NOT_FOUND on them (seen, Windows 11, 2026-11-22); not connected and
     * listening mean the same. Any other error is a client Chord can't see: skipped.
     */
    static readonly HashSet<int> NO_CLIENT = new HashSet<int> { 233 /* ERROR_PIPE_NOT_CONNECTED */, 536 /* ERROR_PIPE_LISTENING */, 1168 /* ERROR_NOT_FOUND */ };
    const uint PIPE_SERVER_END = 1;
    const int FileNameInfo = 2;
    const uint GENERIC_READ = 0x80000000;
    const uint FILE_SHARE_READ = 1;
    const uint TH32CS_SNAPPROCESS = 2;
    /** How long all the queries on the server's files may take, together: they run at once. */
    const int QUERIES_MS = 250;
    /** At most this many of the server's files are looked at. */
    const int FILES_MAX = 8192;
    /** A chain: the client and this many ancestors at most (the bridge, who started it, and two above). */
    const int CHAIN_MAX = 4;

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

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint GetFileType(IntPtr file);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeInfo(IntPtr pipe, out uint flags, IntPtr outSize, IntPtr inSize, IntPtr maxInstances);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(IntPtr file, int infoClass, IntPtr info, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public UIntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, System.Text.StringBuilder name, ref uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    static void Skip(Query q, string call, int error)
    {
        q.Skipped = true;
        q.Why = call + ":" + error;
    }

    /** The pipe's name as a handle to it gives it (\chord-agent-…), or null. */
    static string PipeName(IntPtr pipe)
    {
        IntPtr buffer = Marshal.AllocHGlobal(1024);
        try
        {
            if (!GetFileInformationByHandleEx(pipe, FileNameInfo, buffer, 1024)) return null;
            int bytes = Marshal.ReadInt32(buffer);
            return bytes > 0 && bytes <= 1020 ? Marshal.PtrToStringUni(new IntPtr(buffer.ToInt64() + 4), bytes / 2) : null;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /** The handle table: every process's handles, as the system has them now; IntPtr.Zero if it can't be had. */
    static IntPtr HandleTable(out long count)
    {
        int size = 4 << 20, needed;
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
            size = Math.Max(size * 2, needed + (1 << 20));
        }
        return IntPtr.Zero;
    }

    /** One of the server's file handles, its query, and what it found (0: nothing, or not done). */
    sealed class Query
    {
        public IntPtr Copy;
        public volatile bool Done;
        public uint Client;
        /** It couldn't say whether it's one of the pipe's server ends (a call failed): its client may be missing. */
        public bool Skipped;
        /** Why (the call, and its error), for the output's `skips`. */
        public string Why;
    }

    static string Json(string text)
    {
        if (text == null) return "null";
        var b = new System.Text.StringBuilder("\"");
        foreach (char c in text)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    /** A process's executable (null without access) and when it started (0 without access). */
    static string ImagePath(uint pid, out long created)
    {
        created = 0;
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) return null;
        try
        {
            long exit, kernel, user;
            if (GetProcessTimes(process, out created, out exit, out kernel, out user) == false) created = 0;
            var name = new System.Text.StringBuilder(32768);
            uint size = (uint)name.Capacity;
            return QueryFullProcessImageNameW(process, 0, name, ref size) ? name.ToString(0, (int)size) : null;
        }
        finally
        {
            CloseHandle(process);
        }
    }

    /**
     * The client and its ancestors as JSON ({pid, name, path, ppid}, as parent.ts's ProcessInfo), from one process
     * snapshot. Windows never reparents, so an exited parent's PID can be another process's: an ancestor that started
     * after its child (a reused PID) ends the chain, as does one Chord can't see when it started.
     */
    static string Chain(uint pid, Dictionary<uint, ProcessEntry> processes)
    {
        var items = new List<string>();
        long childCreated = long.MaxValue;
        for (int i = 0; i < CHAIN_MAX && pid > 4; i++)
        {
            ProcessEntry entry;
            if (!processes.TryGetValue(pid, out entry)) break;
            long created;
            string path = ImagePath(pid, out created);
            if (i > 0 && (created == 0 || created > childCreated)) break;
            childCreated = created == 0 ? long.MaxValue : created;
            items.Add("{\"pid\":" + pid + ",\"name\":" + Json(entry.szExeFile) + ",\"path\":" + Json(path) + ",\"cwd\":null,\"ppid\":" + entry.th32ParentProcessID + "}");
            pid = entry.th32ParentProcessID;
        }
        return "[" + string.Join(",", items) + "]";
    }

    static Dictionary<uint, ProcessEntry> Processes()
    {
        var processes = new Dictionary<uint, ProcessEntry>();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1)) return processes;
        try
        {
            var entry = new ProcessEntry { dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) processes[entry.th32ProcessID] = entry;
        }
        finally
        {
            CloseHandle(snapshot);
        }
        return processes;
    }

    /**
     * Prints, as one line of JSON: the clients' PIDs, each one's chain (itself first), how many of the server's files
     * were looked at and how many queries didn't answer in time, and how long each step took (ms).
     */
    static int PipeClients(string name, uint server)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        long tTable, tScan, tQueries, tChains;
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
        tTable = clock.ElapsedMilliseconds;
        var queries = new List<Query>();
        int stuck = 0, truncated = 0, skipped = 0;
        try
        {
            if (table == IntPtr.Zero) return 4;
            // The entries, read in place (no marshalling of each): Object, UniqueProcessId, HandleValue (pointers), then
            // GrantedAccess (4 bytes), CreatorBackTraceIndex and ObjectTypeIndex (2 each), HandleAttributes, Reserved.
            int p = IntPtr.Size;
            int entrySize = 3 * p + 16;
            long first = table.ToInt64() + 2 * p;
            ulong self = GetCurrentProcessId();
            ulong ownValue = (ulong)own.ToInt64();
            int fileType = -1;
            var candidates = new List<KeyValuePair<long, int>>();
            for (long i = 0; i < count; i++)
            {
                IntPtr at = new IntPtr(first + i * entrySize);
                ulong pid = (ulong)Marshal.ReadIntPtr(at, p).ToInt64();
                if (pid != server && pid != self) continue;
                long handle = Marshal.ReadIntPtr(at, 2 * p).ToInt64();
                int type = (ushort)Marshal.ReadInt16(at, 3 * p + 6);
                if (pid == self && (ulong)handle == ownValue) fileType = type;
                else if (pid == server) candidates.Add(new KeyValuePair<long, int>(handle, type));
            }
            tScan = clock.ElapsedMilliseconds;
            if (fileType < 0) return 4;
            // Only the server's files, then the cap: one past it is counted as truncated, never dropped silently.
            candidates = candidates.FindAll(c => c.Value == fileType);
            if (candidates.Count > FILES_MAX)
            {
                truncated = candidates.Count - FILES_MAX;
                candidates.RemoveRange(FILES_MAX, truncated);
            }
            string leaf = name.Substring(@"\\.\pipe".Length); // \chord-agent-…, as a handle to it names it
            // Each of the server's files is queried on a thread of its own, all at once: one with I/O pending can block
            // (GetFileType on a synchronous handle), and is left behind when time's up, with its copy still open
            // (closing it under the query could hand its number to another handle).
            foreach (var c in candidates)
            {
                if (c.Value != fileType) continue;
                IntPtr copy;
                // A file that can't be copied can't be looked at: its client, if it's one of the pipe's, would be missing.
                if (!DuplicateHandle(process, new IntPtr(c.Key), GetCurrentProcess(), out copy, 0, false, DUPLICATE_SAME_ACCESS))
                {
                    skipped++;
                    continue;
                }
                var q = new Query { Copy = copy };
                queries.Add(q);
                var t = new Thread(() =>
                {
                    // Not one of the pipe's: another kind of file, a client end, or another pipe by its name. Can't tell (a
                    // file whose type, or a pipe whose info, name or client can't be read, or an exception): skipped. A
                    // server end of this pipe with no client (one waiting for the next connection) is neither.
                    try
                    {
                        uint flags, pid;
                        uint type = GetFileType(q.Copy);
                        int error;
                        if (type == FILE_TYPE_UNKNOWN && (error = Marshal.GetLastWin32Error()) != NO_ERROR) Skip(q, "type", error);
                        else if (type == FILE_TYPE_PIPE)
                        {
                            if (!GetNamedPipeInfo(q.Copy, out flags, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero)) Skip(q, "info", Marshal.GetLastWin32Error());
                            else if ((flags & PIPE_SERVER_END) != 0)
                            {
                                string pipeName = PipeName(q.Copy);
                                if (pipeName == null) Skip(q, "name", Marshal.GetLastWin32Error());
                                else if (string.Equals(pipeName, leaf, StringComparison.OrdinalIgnoreCase))
                                {
                                    if (GetNamedPipeClientProcessId(q.Copy, out pid)) q.Client = pid;
                                    else if (!NO_CLIENT.Contains(error = Marshal.GetLastWin32Error())) Skip(q, "client", error);
                                }
                            }
                        }
                    }
                    catch
                    {
                        Skip(q, "exception", 0);
                    }
                    q.Done = true;
                }, 64 * 1024) { IsBackground = true };
                t.Start();
            }
            var deadline = clock.ElapsedMilliseconds + QUERIES_MS;
            foreach (var q in queries)
                while (!q.Done && clock.ElapsedMilliseconds < deadline) Thread.Sleep(1);
            tQueries = clock.ElapsedMilliseconds;
            var clients = new List<uint>();
            var skips = new Dictionary<string, int>();
            foreach (var q in queries)
            {
                if (!q.Done) stuck++;
                else if (q.Skipped)
                {
                    skipped++;
                    int n;
                    skips.TryGetValue(q.Why ?? "?", out n);
                    skips[q.Why ?? "?"] = n + 1;
                }
                else if (q.Client != 0 && !clients.Contains(q.Client)) clients.Add(q.Client);
            }
            var processes = clients.Count > 0 ? Processes() : new Dictionary<uint, ProcessEntry>();
            var chains = new List<string>();
            foreach (uint c in clients) chains.Add(Json(c.ToString()) + ":" + Chain(c, processes));
            tChains = clock.ElapsedMilliseconds;
            // stuck, truncated and skipped say the list may miss a client: then Chord names a peer only by its own claim.
            Console.WriteLine("{\"clients\":[" + string.Join(",", clients) + "],\"chains\":{" + string.Join(",", chains) + "},\"files\":" + queries.Count + ",\"stuck\":" + stuck + ",\"truncated\":" + truncated + ",\"skipped\":" + skipped
                + ",\"skips\":{" + string.Join(",", new List<KeyValuePair<string, int>>(skips).ConvertAll(k => Json(k.Key) + ":" + k.Value)) + "}"
                + ",\"handles\":" + count + ",\"ms\":{\"table\":" + tTable + ",\"scan\":" + (tScan - tTable) + ",\"queries\":" + (tQueries - tScan) + ",\"chains\":" + (tChains - tQueries) + ",\"total\":" + tChains + "}}");
            return 0;
        }
        finally
        {
            if (table != IntPtr.Zero) Marshal.FreeHGlobal(table);
            foreach (var q in queries) if (q.Done) CloseHandle(q.Copy);
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
