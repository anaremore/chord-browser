#!/usr/bin/env node
// Runs the sign-in sweep (README.md) in the Linux E2E container, so no window opens on your
// desktop, then writes the report. It needs what scripts/e2e-linux/run.mjs needs (Docker, in WSL 2
// on Windows).
//
//   node scripts/dev/signin-sweep/sweep.mjs --dir <dir> [--workers 3] [other Playwright arguments]
//
// <dir> holds sites.txt (list.mjs makes one; any file of URLs, one a line, will do). The sweep
// writes results/<host>.json and shots/<host>.jpg there, then report.md and report.json. A site
// with a result already is skipped, so a run that stopped carries on: delete results/ to start over.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const args = process.argv.slice(2);
const take = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const [, value] = args.splice(i, 2);
  return value;
};
const dir = take('--dir');
const workers = take('--workers', '3');
if (!dir || !existsSync(join(dir, 'sites.txt'))) {
  console.error('Usage: sweep.mjs --dir <dir with sites.txt> [--workers 3] [Playwright arguments]');
  process.exit(2);
}
const run = (script, argv) => spawnSync(process.execPath, [join(root, script), ...argv], { cwd: root, stdio: 'inherit', windowsHide: true }).status ?? 1;
const status = run('scripts/e2e-linux/run.mjs', ['--x11', '--share', resolve(dir), '-c', 'playwright.sweep.config.ts', '--workers', workers, ...args]);
const report = run('scripts/dev/signin-sweep/report.mjs', ['--dir', resolve(dir)]);
process.exit(status || report);
