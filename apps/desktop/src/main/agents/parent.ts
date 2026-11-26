/**
 * Who started `chord mcp` (docs/decisions/S18-agent-mcp.md §3): the bridge's parent
 * and two more ancestors (shims: codex.cmd → node → codex.exe). Everything here is
 * what the OS says about a process of the same user, so it's a hint for the connect
 * card, never an identity. Looked up while the card shows, never inside a call. On
 * Windows, window-owner.exe's `chain` reads it from one process snapshot (a few ms);
 * without the helper, one PowerShell queries each process (about 1 s, and more than
 * its 10 s on a busy CI runner: #107). Never a process's command line, which can hold
 * tokens.
 */
import { execFile } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  name: string | null;
  path: string | null;
  /** Its folder, where the OS tells (Linux, macOS); Windows needs native code for another process's. */
  cwd: string | null;
  ppid: number | null;
}

const attempt = <T>(f: () => T): T | null => {
  try {
    return f();
  } catch {
    return null;
  }
};

async function processInfo(pid: number): Promise<ProcessInfo> {
  if (process.platform === 'linux') {
    const stat = attempt(() => readFileSync(`/proc/${pid}/stat`, 'utf8'));
    const ppid = stat ? Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) : null;
    const exe = attempt(() => readlinkSync(`/proc/${pid}/exe`));
    // The executable's name, not comm: Node's is "MainThread".
    return { pid, name: exe ? basename(exe) : null, path: exe, cwd: attempt(() => readlinkSync(`/proc/${pid}/cwd`)), ppid };
  }
  const { stdout } = await run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]).catch(() => ({ stdout: '' }));
  const match = /^\s*(\d+)\s+(.*)$/.exec(stdout.trim());
  // One lsof for its folder and its executable (the first `txt` file): ps's comm is whatever the process says.
  const files = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd,txt', '-Fn'])
    .then(({ stdout: o }) => o.split('\n'))
    .catch(() => [] as string[]);
  const file = (fd: string) => {
    const at = files.indexOf(`f${fd}`);
    return at >= 0 ? (files.slice(at + 1).find((l) => l.startsWith('n'))?.slice(1) ?? null) : null;
  };
  // The executable as the OS has it, its links resolved: never a path the process made up.
  const exe = file('txt');
  // No executable from lsof: no path at all (ps's name is the process's own word), and the lookup stops there.
  const path = exe ? (attempt(() => realpathSync(exe)) ?? exe) : null;
  return { pid, name: path ? basename(path) : null, path, cwd: file('cwd'), ppid: match ? Number(match[1]) : null };
}

/** Whether two executables' paths name the same program (links resolved; Windows' and macOS' case ignored). */
export function sameProgram(a: string | null, b: string): boolean {
  if (!a) return false;
  const real = (p: string) => attempt(() => realpathSync(p)) ?? p;
  const fold = (p: string) => (process.platform === 'linux' ? p : p.toLowerCase());
  return fold(real(a)) === fold(real(b));
}

/** A process id as the helpers give one: a whole number above 0. */
export const isPid = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
/** A name or path as the helpers give one: a string with something in it. */
export const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * window-owner.exe's `chain` answer: its processes as given (each `ProcessInfo`'s fields, read as pipe-clients' chains
 * are, peer.ts), up to the first that isn't one; or nothing.
 */
export function parseChain(stdout: string): ProcessInfo[] {
  const parsed = attempt(() => JSON.parse(stdout.trim() || '[]') as unknown);
  if (!Array.isArray(parsed)) return [];
  const chain: ProcessInfo[] = [];
  for (const p of parsed as Record<string, unknown>[]) {
    if (!p || !isPid(p['pid'])) break;
    chain.push({ pid: p['pid'], name: text(p['name']), path: text(p['path']), cwd: null, ppid: isPid(p['ppid']) ? p['ppid'] : null });
  }
  return chain;
}

/**
 * The process and up to `depth - 1` of its ancestors. On Windows, `helper` (window-owner.exe) reads them from one
 * process snapshot; PowerShell only where there's none.
 */
export async function ancestry(pid: number, depth = 3, helper: string | null = null): Promise<ProcessInfo[]> {
  if (!Number.isInteger(pid) || pid <= 1 || depth < 1) return [];
  // Windows' own processes (System Idle, System) are no one's parent to name.
  if (process.platform === 'win32' && pid <= 4) return [];
  if (process.platform === 'win32' && helper) {
    const { stdout } = await run(helper, ['chain', String(pid), String(Math.min(depth, 4))], { windowsHide: true, timeout: 10_000 }).catch(() => ({ stdout: '[]' }));
    const chain = parseChain(stdout);
    // The helper's chain starts with the process asked about, or it's no answer.
    return chain[0]?.pid === pid ? chain : [];
  }
  if (process.platform === 'win32') {
    // Windows never reparents: a parent that exited leaves its PID in ParentProcessId, free for another process. One
    // created after its child isn't its parent (the PID was reused), and the chain stops there. Linux and macOS give an
    // orphan to init (or launchd), so their parent PID is never stale.
    const ps = `$p=${pid}; $out=@(); $born=$null; for ($i=0; $i -lt ${depth} -and $p -gt 4; $i++) { $o = Get-CimInstance Win32_Process -Filter "ProcessId=$p" | Select-Object ProcessId,Name,ExecutablePath,ParentProcessId,CreationDate; if (-not $o -or ($born -and $o.CreationDate -gt $born)) { break }; $born = $o.CreationDate; $out += ($o | Select-Object ProcessId,Name,ExecutablePath,ParentProcessId); $p = $o.ParentProcessId }; ConvertTo-Json -Compress -InputObject $out`;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 10_000 }).catch(() => ({ stdout: '[]' }));
    const parsed = attempt(() => JSON.parse(stdout.trim() || '[]') as unknown) ?? [];
    return ([] as { ProcessId: number; Name: string; ExecutablePath: string | null; ParentProcessId: number }[])
      .concat(parsed as never)
      .map((o) => ({ pid: o.ProcessId, name: o.Name ?? null, path: o.ExecutablePath ?? null, cwd: null, ppid: o.ParentProcessId ?? null }));
  }
  const chain: ProcessInfo[] = [];
  for (let i = 0, p: number | null = pid; i < depth && p && p > 1; i++) {
    const info = await processInfo(p);
    if (!info.name) break;
    chain.push(info);
    p = info.ppid;
  }
  return chain;
}
