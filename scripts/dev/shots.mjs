#!/usr/bin/env node
// The README's and the website's screenshots, retaken in the Linux E2E container, so no window
// opens on your desktop (it needs what scripts/e2e-linux/run.mjs needs: Docker, in WSL 2 on Windows).
//
//   node scripts/dev/shots.mjs            all of them
//   node scripts/dev/shots.mjs -g dark    one session's (other arguments go to Playwright)
//
// 1. Runs apps/desktop/test/shots (playwright.shots.config.ts) in the container, on an Xvfb
//    screen that holds Chord's 1440 × 900 window at 2×. Each picture is the whole window,
//    2880 × 1800 pixels (Settings, 1720 × 1240), in apps/desktop/test-results/shots.
// 2. Copies them to site/shots, which git ignores: at about 1.3 MB each, every retake would
//    stay in the repo's history.
// 3. Runs site/tools/assets.py: the WebP images the website and the README show, and the link
//    card. It needs Python with Pillow and fontTools (PYTHON names the interpreter; python on
//    Windows, python3 elsewhere).
// If the run fails, site/shots and the site are left as they were.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const made = join(root, 'apps', 'desktop', 'test-results', 'shots');
const images = join(root, 'site', 'shots');
/** Xvfb's screen: the window at 2× (2880 × 1800) with room to spare. */
const SCREEN = '3200x2000x24';

const log = (message) => console.log(`[shots] ${message}`);
const run = (command, args, env = process.env) => spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true }).status ?? 1;

const status = run(process.execPath, [join(root, 'scripts', 'e2e-linux', 'run.mjs'), '--x11', '-c', 'playwright.shots.config.ts', ...process.argv.slice(2)], { ...process.env, CHORD_E2E_SCREEN: SCREEN });
if (status !== 0) {
  log('The run failed: site/shots and the site are unchanged.');
  process.exit(status);
}
const shots = existsSync(made) ? readdirSync(made).filter((f) => f.endsWith('.png')) : [];
if (!shots.length) {
  log(`The run made no screenshots in ${made}.`);
  process.exit(1);
}
mkdirSync(images, { recursive: true });
for (const file of shots) {
  copyFileSync(join(made, file), join(images, file));
  log(`site/shots/${file}  ${Math.round(statSync(join(images, file)).size / 1024)} KB`);
}

const python = process.env['PYTHON'] || (process.platform === 'win32' ? 'python' : 'python3');
process.exit(run(python, ['-I', join('site', 'tools', 'assets.py')]));
