/**
 * `chord mcp` in Chord's own executable (docs/decisions/S18-agent-mcp.md §2): the
 * stdio relay (bridge.ts), with nothing of the browser. No window, no `ready`
 * handler, never the single-instance lock, one process (GPU and network service
 * in-process), and a userData folder of its own, so Electron's `Local State` never
 * lands in the running Chord's profile. It finds that profile as Chord does
 * (identity.ts): `--user-data-dir=<path>`, CHORD_USER_DATA in development, else
 * the default.
 */
import { createReadStream } from 'node:fs';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { app } from 'electron';
import { userDataOverride } from '../user-data';
import { runBridge } from './bridge';
import { relayFolder, relayUserData, userCache } from './relay-folder';

const name = app.isPackaged ? 'Chord' : 'Chord Dev';

/** The profile folder of the Chord this bridge talks to. */
function profileFolder(): string {
  const override = userDataOverride(app.commandLine.getSwitchValue('user-data-dir'), app.isPackaged ? undefined : process.env['CHORD_USER_DATA'], process.cwd());
  if (override) return override;
  if (process.platform === 'win32') return join(process.env['LOCALAPPDATA'] ?? join(app.getPath('appData'), '..', 'Local'), name, 'User Data');
  return join(app.getPath('appData'), name);
}

const profile = profileFolder();
// Measured in M0: one process and about 69 MB instead of three and 169 MB, and 9 KB on disk instead of 1.1 MB of GPU caches.
app.disableHardwareAcceleration();
for (const s of ['disable-gpu', 'disable-software-rasterizer', 'in-process-gpu', 'disable-gpu-shader-disk-cache']) app.commandLine.appendSwitch(s);
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');
// Chromium's own files: whatever --user-data-dir said (that's the profile to find), they go in a folder of the user's own
// (relay-folder.ts), never a shared path in /tmp.
const scratch = relayUserData(relayFolder(process.platform, process.env, userCache(process.platform, process.env, app.getPath('home')), app.isPackaged));
app.setPath('userData', scratch.path);
app.dock?.hide();

// Electron's main has no working process.stdin on Windows (a stub that ends at once), but fd 0 is the client's pipe.
let input: NodeJS.ReadableStream;
try {
  input = new Socket({ fd: 0, readable: true, writable: false });
} catch {
  input = createReadStream('', { fd: 0 });
}
runBridge({
  userData: profile,
  input,
  // stdout is a SyncWriteStream in Electron's main: each line goes out whole, at once.
  output: process.stdout,
  version: app.getVersion(),
  onEnd: () => {
    scratch.dispose();
    app.exit(0);
  },
});
