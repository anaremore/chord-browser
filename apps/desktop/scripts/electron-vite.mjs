// Runs electron-vite with ELECTRON_RUN_AS_NODE removed. Electron-based hosts
// (some editors and agent tools) export it, and it makes Electron start as
// plain Node, so `import { app } from 'electron'` fails. Packaged builds are
// unaffected: the RunAsNode fuse is off there (ARCHITECTURE.md §14.1).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('electron-vite/package.json');
const { bin } = require(pkgPath);
const cli = join(dirname(pkgPath), typeof bin === 'string' ? bin : bin['electron-vite']);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
