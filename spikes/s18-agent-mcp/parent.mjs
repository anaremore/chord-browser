// Spike S18 M0: who started `chord mcp`? The bridge's parent process (name, path, folder), per OS.
// Everything here is what the OS says about a process running as the same user: any
// program the user runs can start the bridge, name itself anything and sit in any folder.
// So it's a hint for the connect card, never an identity.
import { execFile } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** One process: its image name, executable path, parent pid, and (where the OS tells) its folder. */
export async function processInfo(pid) {
  if (process.platform === 'linux') {
    const read = (f) => {
      try {
        return f();
      } catch {
        return null;
      }
    };
    const stat = read(() => readFileSync(`/proc/${pid}/stat`, 'utf8'));
    const ppid = stat ? Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) : null;
    const exe = read(() => readlinkSync(`/proc/${pid}/exe`));
    return { pid, name: read(() => readFileSync(`/proc/${pid}/comm`, 'utf8').trim()), path: exe, cwd: read(() => readlinkSync(`/proc/${pid}/cwd`)), ppid };
  }
  if (process.platform === 'darwin') {
    const { stdout } = await run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]).catch(() => ({ stdout: '' }));
    const m = /^\s*(\d+)\s+(.*)$/.exec(stdout.trim());
    const cwd = await run('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'])
      .then(({ stdout: o }) => o.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? null)
      .catch(() => null);
    return { pid, name: m ? basename(m[2]) : null, path: m?.[2] ?? null, cwd, ppid: m ? Number(m[1]) : null };
  }
  // Windows: CIM has the path and parent; another process's folder needs its PEB (native code), so none.
  // Never CommandLine: it can hold tokens the user passed to their agent.
  const ps = `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object Name,ExecutablePath,ParentProcessId | ConvertTo-Json -Compress`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }).catch(() => ({ stdout: '' }));
  const o = stdout.trim() ? JSON.parse(stdout) : {};
  return { pid, name: o.Name ?? null, path: o.ExecutablePath ?? null, cwd: null, ppid: o.ParentProcessId ?? null };
}

/** The bridge's parent and up to two more ancestors (shims: codex.cmd → node → codex.exe). */
export async function ancestry(pid = process.ppid, depth = 3) {
  if (process.platform === 'win32') {
    // One PowerShell for the whole chain (each start costs ~0.5 s).
    const ps = `$p=${Number(pid)}; $out=@(); for ($i=0; $i -lt ${depth} -and $p -gt 4; $i++) { $o = Get-CimInstance Win32_Process -Filter "ProcessId=$p" | Select-Object ProcessId,Name,ExecutablePath,ParentProcessId; if (-not $o) { break }; $out += $o; $p = $o.ParentProcessId }; ConvertTo-Json -Compress -InputObject $out`;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }).catch(() => ({ stdout: '[]' }));
    return [].concat(JSON.parse(stdout.trim() || '[]')).map((o) => ({ pid: o.ProcessId, name: o.Name, path: o.ExecutablePath, cwd: null, ppid: o.ParentProcessId }));
  }
  const chain = [];
  for (let i = 0; i < depth && pid > 1; i++) {
    const info = await processInfo(pid);
    if (!info.name) break;
    chain.push(info);
    pid = info.ppid;
  }
  return chain;
}

/** The fast Windows lookup (name only), for comparison with CIM. */
export async function windowsImageName(pid) {
  const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
  return stdout.split(',')[0]?.replace(/"/g, '') ?? null;
}
