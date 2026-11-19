// Spike S18 M0: start-up time and memory of `chord mcp`, run N times by the fake client.
// Usage: node measure.mjs <runs> <command> [args…]
// Reports time to the initialize reply, and the bridge's process tree (count, working set)
// once it has answered, from tasklist/ps. Chord needn't be running: initialize is local.
import { execFileSync } from 'node:child_process';
import { mcpClient } from './fake-client.mjs';

function tree(rootPid) {
  if (process.platform === 'win32') {
    const rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress'], { windowsHide: true, maxBuffer: 1 << 26 }).toString());
    const kids = (pid) => rows.filter((r) => r.ParentProcessId === pid).flatMap((r) => [r, ...kids(r.ProcessId)]);
    const all = [rows.find((r) => r.ProcessId === rootPid), ...kids(rootPid)].filter(Boolean);
    return all.map((r) => ({ name: r.Name, mb: Math.round(r.WorkingSetSize / 1048576) }));
  }
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,comm=']).toString().trim().split('\n').map((l) => l.trim().split(/\s+/));
  const kids = (pid) => out.filter((r) => Number(r[1]) === pid).flatMap((r) => [r, ...kids(Number(r[0]))]);
  return [out.find((r) => Number(r[0]) === rootPid), ...kids(rootPid)].filter(Boolean).map((r) => ({ name: r[3], mb: Math.round(Number(r[2]) / 1024) }));
}

const [runs, command, ...args] = process.argv.slice(2);
const times = [];
let procs;
for (let i = 0; i < Number(runs); i++) {
  const c = mcpClient(command, args);
  await c.initialize();
  times.push(performance.now() - c.t0);
  if (i === 0) {
    await new Promise((r) => setTimeout(r, 1500)); // let anything lazy (a GPU process) start
    procs = tree(c.child.pid);
  }
  c.close();
  await new Promise((r) => c.child.once('exit', r));
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({ command: [command, ...args].join(' ').slice(-80), runs: times.length, medianMs: Math.round(times[times.length >> 1]), minMs: Math.round(times[0]), maxMs: Math.round(times.at(-1)), processes: procs, totalMb: procs.reduce((s, p) => s + p.mb, 0) }));
