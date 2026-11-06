// Builds build/win/window-owner.cs into out/window-owner/window-owner.exe on
// Windows, with the C# compiler that ships with Windows itself (.NET
// Framework 4.8's csc.exe), so no SDK is needed. Elsewhere it does nothing:
// only Windows glues Chord Player into the tab (ARCHITECTURE.md §9).
//
// AnyCPU: one program runs natively on x64 and arm64 (.NET Framework 4.8.1
// is arm64-native on Windows 11). Packaging copies it beside the app
// (electron-builder.config.ts, extraResources), where it's code-signed with
// Chord.exe. Without csc.exe a development build goes on without it (Chord
// Player then keeps a window of its own); a release build (CI) must have it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

if (process.platform !== 'win32') process.exit(0);

const root = join(import.meta.dirname, '..');
const source = join(root, 'build/win/window-owner.cs');
const target = join(root, 'out/window-owner/window-owner.exe');
const windir = process.env['WINDIR'] ?? 'C:\\Windows';
const csc = ['Framework64', 'FrameworkArm64', 'Framework'].map((dir) => join(windir, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe')).find((path) => existsSync(path));

if (existsSync(target) && statSync(target).mtimeMs >= statSync(source).mtimeMs) process.exit(0);
if (!csc) {
  const message = 'window-owner: no C# compiler (.NET Framework 4.8) found, so Chord Player can’t play in the tab in this build';
  if (process.env['CI']) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}
mkdirSync(dirname(target), { recursive: true });
const result = spawnSync(csc, ['/nologo', '/optimize+', '/platform:anycpu', '/target:exe', `/out:${target}`, source], { stdio: 'inherit' });
process.exit(result.status ?? 1);
