/**
 * Who started `chord mcp`, on macOS (S18, review 3 of #98): a process's
 * executable is the one `lsof` reports (links resolved), never `ps`'s name,
 * which the process sets itself; with none from lsof there's no path, and the
 * lookup stops (fail closed). The OS commands are stood in for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/** What `ps` and `lsof` answer, by pid. */
const answers = new Map<number, { ps: string; lsof: string }>();

vi.mock('node:child_process', () => ({
  execFile: (command: string, args: string[], callback: (error: Error | null, out?: { stdout: string; stderr: string }) => void) => {
    const pid = Number(args[args.indexOf('-p') + 1]);
    const answer = answers.get(pid);
    if (!answer) return callback(new Error('no such process'));
    callback(null, { stdout: command === 'ps' ? answer.ps : answer.lsof, stderr: '' });
  },
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  answers.clear();
});

describe('The parent lookup on macOS', () => {
  it('takes the executable from lsof, and stops where lsof has none', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { ancestry } = await import('../../src/main/agents/parent');
    // 30: says it's Antigravity's language server (ps), but lsof has its real executable.
    answers.set(30, { ps: '20 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm', lsof: 'p30\nfcwd\nn/Users/me/code\nftxt\nn/tmp/x/evil\nftxt\nn/usr/lib/dyld\n' });
    // 20: lsof gives no executable at all.
    answers.set(20, { ps: '1 /Applications/Antigravity.app/Contents/MacOS/Antigravity', lsof: 'p20\nfcwd\nn/\n' });
    const chain = await ancestry(30);
    expect(chain).toEqual([{ pid: 30, name: 'evil', path: '/tmp/x/evil', cwd: '/Users/me/code', ppid: 20 }]);
  });
});

describe('window-owner.exe’s chain (Windows, #107): its answer read as given, or nothing', () => {
  it('reads each process’s fields, in order, and stops at one without a pid', async () => {
    const { parseChain } = await import('../../src/main/agents/parent');
    const given = JSON.stringify([
      { pid: 40, name: 'chord.exe', path: 'C:/Chord/chord.exe', cwd: null, ppid: 30 },
      { pid: 30, name: 'claude.exe', path: null, cwd: null, ppid: 20 },
      { name: 'no pid' },
      { pid: 20, name: 'explorer.exe', path: null, cwd: null, ppid: 4 },
    ]);
    expect(parseChain(given)).toEqual([
      { pid: 40, name: 'chord.exe', path: 'C:/Chord/chord.exe', cwd: null, ppid: 30 },
      { pid: 30, name: 'claude.exe', path: null, cwd: null, ppid: 20 },
    ]);
  });

  it.each([['nothing', ''], ['not JSON', 'Access is denied.'], ['not a list', '{"pid":1}'], ['a list of nothing', '[]']])('%s: no chain', async (_name, stdout) => {
    const { parseChain } = await import('../../src/main/agents/parent');
    expect(parseChain(stdout)).toEqual([]);
  });
});
