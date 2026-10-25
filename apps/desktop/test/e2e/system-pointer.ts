/**
 * The system's own pointer, for tests where it matters which of Chord's views
 * gets the mouse. Playwright's mouse hands its events straight to one page,
 * past the window's routing between its views; a hand's pointer goes to
 * whichever view main has on top as it moves (dragging a tab over the pages,
 * say).
 *
 * - Linux, X11: xdotool (the E2E container and CI install it).
 * - Windows: user32's SetCursorPos and mouse_event, through one PowerShell
 *   kept open for the test.
 * - Elsewhere (macOS needs an accessibility grant; Wayland lets no client move
 *   the pointer): none, and the test skips.
 *
 * Positions are in the window's content area, in its own pixels (DIPs): the
 * shell's CSS pixels times the interface size.
 */
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ElectronApplication } from '@playwright/test';

export interface SystemPointer {
  move(x: number, y: number): Promise<void>;
  down(): Promise<void>;
  up(): Promise<void>;
  close(): void;
}

const onX11 = process.platform === 'linux' && Boolean(process.env['DISPLAY']) && !process.env['WAYLAND_DISPLAY'];

/** Whether this machine has a system pointer a test can move. */
export const systemPointerAvailable = (onX11 && spawnSync('xdotool', ['version']).status === 0) || process.platform === 'win32';

const WINDOWS_DRIVER = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ChordPointer {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
[void][ChordPointer]::SetProcessDPIAware()
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $p = $line.Split(' ')
  switch ($p[0]) {
    'move' { [void][ChordPointer]::SetCursorPos([int]$p[1], [int]$p[2]) }
    'down' { [ChordPointer]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero) }
    'up' { [ChordPointer]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
  }
  [Console]::Out.WriteLine('ok')
}
`;

/** One PowerShell taking a command a line, answering each once it's done. */
function windowsDriver(): Promise<{ send(line: string): Promise<void>; close(): void }> {
  const child: ChildProcessWithoutNullStreams = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { stdio: 'pipe' });
  const waiting: (() => void)[] = [];
  let ready: () => void;
  const started = new Promise<void>((done) => (ready = done));
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line === 'ready') ready();
      else if (line === 'ok') waiting.shift()?.();
    }
  });
  child.stdin.write(`${WINDOWS_DRIVER}\n`);
  return started.then(() => ({
    send: (line: string) =>
      new Promise<void>((done) => {
        waiting.push(done);
        child.stdin.write(`${line}\n`);
      }),
    close: () => {
      child.stdin.end();
      child.kill();
    },
  }));
}

/** The pointer, placed in `app`'s first window. */
export async function systemPointer(app: ElectronApplication): Promise<SystemPointer> {
  const origin = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getContentBounds());
  if (process.platform === 'win32') {
    const driver = await windowsDriver();
    // SetCursorPos takes physical pixels: main converts from the window's DIPs on the display it's on.
    const physical = (x: number, y: number) => app.evaluate(({ screen }, p) => screen.dipToScreenPoint(p), { x: origin.x + x, y: origin.y + y });
    return {
      move: async (x, y) => {
        const p = await physical(x, y);
        await driver.send(`move ${Math.round(p.x)} ${Math.round(p.y)}`);
      },
      down: () => driver.send('down'),
      up: () => driver.send('up'),
      close: () => driver.close(),
    };
  }
  const xdo = (...args: (string | number)[]) => execFileSync('xdotool', args.map(String));
  return {
    move: async (x, y) => void xdo('mousemove', Math.round(origin.x + x), Math.round(origin.y + y)),
    down: async () => void xdo('mousedown', 1),
    up: async () => void xdo('mouseup', 1),
    close: () => {},
  };
}
