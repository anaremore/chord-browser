/**
 * "Sign in" for the assistant (detect.ts, security review): the terminal it
 * opens on each OS. On Linux the first terminal that's on PATH, not just the
 * first in the list; on Windows the path quoted for cmd.exe's `start`, and one
 * cmd.exe would misread refused.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));
const { signInSpawn } = await import('../../src/main/assistant/detect');

describe('the terminal Sign in opens', () => {
  const args = ['auth', 'login'];
  // [platform, the binary's path, terminals on PATH, the program run and its arguments, or null]
  const table: [NodeJS.Platform, string, string[], [string, string[]] | null][] = [
    ['linux', '/usr/bin/claude', ['x-terminal-emulator', 'xterm'], ['x-terminal-emulator', ['-e', '/usr/bin/claude', 'auth', 'login']]],
    ['linux', '/usr/bin/claude', ['gnome-terminal', 'xterm'], ['gnome-terminal', ['--', '/usr/bin/claude', 'auth', 'login']]],
    ['linux', '/usr/bin/claude', ['konsole'], ['konsole', ['-e', '/usr/bin/claude', 'auth', 'login']]],
    ['linux', '/usr/bin/claude', ['xterm'], ['xterm', ['-e', '/usr/bin/claude', 'auth', 'login']]],
    ['linux', '/usr/bin/claude', [], null],
    ['win32', 'C:\\Users\\Ada\\.local\\bin\\claude.exe', [], ['cmd.exe', ['/d', '/s', '/c', 'start "Sign in" "C:\\Users\\Ada\\.local\\bin\\claude.exe" auth login']]],
    ['win32', 'C:\\Tools & Co\\claude.exe', [], ['cmd.exe', ['/d', '/s', '/c', 'start "Sign in" "C:\\Tools & Co\\claude.exe" auth login']]],
    ['win32', 'C:\\x" & calc & "\\claude.exe', [], null],
    ['win32', 'C:\\%PATH%\\claude.exe', [], null],
    ['win32', 'C:\\a\r\nb\\claude.exe', [], null],
    ['darwin', "/Users/ada/it's/claude", [], ['osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify("'/Users/ada/it'\\''s/claude' 'auth' 'login'")}`, '-e', 'tell application "Terminal" to activate']]],
  ];
  it.each(table)('%s, %j with %j on PATH', (platform, path, terminals, expected) => {
    const how = signInSpawn(platform, path, args, (name) => terminals.includes(name));
    expect(how && [how.command, how.args]).toEqual(expected);
    if (how) expect(how.verbatim).toBe(platform === 'win32');
  });
});
