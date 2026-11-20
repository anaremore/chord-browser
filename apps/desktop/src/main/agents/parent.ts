/**
 * Who started `chord mcp` (docs/decisions/S18-agent-mcp.md §3): the bridge's parent
 * and two more ancestors (shims: codex.cmd → node → codex.exe). Everything here is
 * what the OS says about a process of the same user, so it's a hint for the connect
 * card, never an identity. Looked up while the card shows, never inside a call:
 * Windows needs one PowerShell for the chain (about 1 s). Never a process's command
 * line, which can hold tokens.
 */
import { execFile } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
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
  const cwd = await run('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'])
    .then(({ stdout: o }) => o.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? null)
    .catch(() => null);
  return { pid, name: match ? basename(match[2]!) : null, path: match?.[2] ?? null, cwd, ppid: match ? Number(match[1]) : null };
}

/** The process and up to `depth - 1` of its ancestors. */
export async function ancestry(pid: number, depth = 3): Promise<ProcessInfo[]> {
  if (!Number.isInteger(pid) || pid <= 1) return [];
  if (process.platform === 'win32') {
    const ps = `$p=${pid}; $out=@(); for ($i=0; $i -lt ${depth} -and $p -gt 4; $i++) { $o = Get-CimInstance Win32_Process -Filter "ProcessId=$p" | Select-Object ProcessId,Name,ExecutablePath,ParentProcessId; if (-not $o) { break }; $out += $o; $p = $o.ParentProcessId }; ConvertTo-Json -Compress -InputObject $out`;
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
